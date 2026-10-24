/**
 * Observability of the registration routes (AC-VERIFY-6, carry-forward from Phase 2). The allocator already emits
 * `registration.created`, `.withdrawn`, `.promoted` and `.refused` through the `log` it is handed; the HTTP service passes
 * `request.log` and must NOT log them again. Every event is triggered for real through HTTP and its logged FIELDS are asserted
 * (learned rule: logging-redaction-global), including that each action emits each event exactly once, that every line carries
 * the request's traceId, and that no line contains an email, a full name, a guest display name, a team name, a `ban_reason`
 * or the session token.
 */
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTelemetry, type Telemetry } from '../../src/lib/telemetry/telemetry.ts';
import { START_TIME, bearer, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  insertPayment,
  insertPublishedSession,
  insertRegistration,
  insertTeam,
} from '../helpers/factories.ts';
import { waitForLockWaiters } from '../helpers/lock-waiters.ts';
import { httpMember, sessionUrl, type HttpMember } from '../helpers/registrations-http.ts';
import { createRecordingJobs, readRegistration } from '../helpers/registration-scene.ts';
import { createTestDatabase, inTransaction, type TestDatabase } from '../helpers/test-db.ts';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const TRACEPARENT = `00-${TRACE_ID}-b7ad6b7169203331-01`;

const TEAM_NAME = 'Zorblax Secretname Badminton Club';
const FULL_NAME = 'Gwendolyn Logsworth';
const GUEST_NAME = 'Hemi Guestsecret';
const BAN_REASON = 'harassed the umpire, hush hush';
const EMAIL_PART = 'logs-person';

let database: TestDatabase;
let h: AuthTestApp;
let telemetry: Telemetry;
const jobs = createRecordingJobs();
const tokens: string[] = [];

beforeAll(async () => {
  telemetry = startTelemetry(
    {
      serviceName: 'sgm-test',
      serviceVersion: 'test',
      disabled: false,
      tracesExporter: 'none',
      otlpEndpoint: undefined,
      sampler: 'parentbased_traceidratio',
      samplerArg: 1,
    },
    { spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())] },
  );
  database = await createTestDatabase({ poolMax: 12 });
  h = await buildAuthTestApp(database.pool, { jobs });
});
afterAll(async () => {
  await h.close();
  await database.close();
  await telemetry.shutdown();
});
beforeEach(() => {
  h.clock.set(START_TIME);
  jobs.reset();
});

const ENVELOPE = new Set([
  'level',
  'time',
  'timestamp',
  'msg',
  'message',
  'service',
  'version',
  'environment',
  'pid',
  'hostname',
  'traceId',
  'spanId',
  'requestId',
  'reqId',
  'event',
]);
const ownFields = (line: Record<string, unknown> | undefined): string[] =>
  Object.keys(line ?? {})
    .filter((key) => !ENVELOPE.has(key))
    .sort();

interface Scene {
  teamId: string;
  sessionId: string;
  deadline: Date;
}

async function scene(maxPlayers = 10): Promise<Scene> {
  const teamId = await insertTeam(database.pool, { name: TEAM_NAME, payoutConfigured: true });
  const { sessionId } = await insertPublishedSession(database.pool, teamId, {
    now: h.clock.now(),
    maxPlayers,
  });
  const { rows } = await database.pool.query<{ cancellation_deadline: Date }>(
    `SELECT cancellation_deadline FROM game_sessions WHERE id = $1`,
    [sessionId],
  );
  return { teamId, sessionId, deadline: rows[0]?.cancellation_deadline as Date };
}

async function named(s: Scene, status: 'APPROVED' | 'BANNED' = 'APPROVED'): Promise<HttpMember> {
  const who = await httpMember(h, s.teamId, {
    status,
    email: `${EMAIL_PART}-${tokens.length}@example.test`,
  });
  await database.pool.query(`UPDATE users SET full_name = $2 WHERE id = $1`, [
    who.userId,
    FULL_NAME,
  ]);
  if (status === 'BANNED') {
    await database.pool.query(
      `UPDATE team_members SET ban_reason = $3 WHERE team_id = $1 AND user_id = $2`,
      [s.teamId, who.userId, BAN_REASON],
    );
  }
  tokens.push(who.token);
  return who;
}

async function seed(
  s: Scene,
  userId: string,
  status: 'CONFIRMED' | 'WAITLISTED',
  queuePosition?: number,
): Promise<string> {
  return inTransaction(database.pool, (client) =>
    insertRegistration(client, {
      sessionId: s.sessionId,
      teamId: s.teamId,
      userId,
      status,
      queuePosition,
    }),
  );
}

/** One HTTP action inside the known trace; returns the response and exactly the log lines it produced. */
async function act(
  method: 'GET' | 'POST',
  url: string,
  who: HttpMember,
  payload?: object,
): Promise<{ status: number; lines: Record<string, unknown>[] }> {
  const mark = h.logs.lines().length;
  const res = await h.app.inject({
    method,
    url,
    headers: { ...bearer(who.token), traceparent: TRACEPARENT },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, lines: h.logs.lines().slice(mark) };
}

const events = (
  lines: Record<string, unknown>[],
  prefix = 'registration.',
): Record<string, unknown>[] =>
  lines.filter((line) => typeof line.event === 'string' && line.event.startsWith(prefix));
const one = (lines: Record<string, unknown>[], event: string): Record<string, unknown> => {
  const found = lines.filter((line) => line.event === event);
  expect(found, event).toHaveLength(1);
  return found[0] ?? {};
};

const registerUrl = (s: Scene): string => `${sessionUrl(s.teamId, s.sessionId)}/registrations`;
const withdrawUrl = (s: Scene): string => `${registerUrl(s)}/me/withdraw`;

describe('registration events through HTTP (AC-VERIFY-6)', () => {
  it('register emits registration.created exactly once, with its fields and the request traceId', async () => {
    const s = await scene();
    const me = await named(s);
    const { status, lines } = await act('POST', registerUrl(s), me, {
      guests: [
        { sex: 'MALE', skillLevel: 'BEGINNER', displayName: GUEST_NAME },
        { sex: 'FEMALE', skillLevel: 'ADVANCED' },
      ],
    });
    expect(status).toBe(201);
    expect(events(lines).map((line) => line.event)).toEqual(['registration.created']);
    const created = one(lines, 'registration.created');
    const row = await readRegistration(database.pool, s.sessionId, me.userId);
    expect(created).toMatchObject({
      teamId: s.teamId,
      sessionId: s.sessionId,
      userId: me.userId,
      registrationId: row?.id,
      status: 'CONFIRMED',
      partySize: 3,
      reRegistration: false,
      source: 'MEMBER',
      promotedCount: 0,
      liabilitiesReleased: 0,
      traceId: TRACE_ID,
    });
    expect(ownFields(created)).toEqual(
      [
        'liabilitiesReleased',
        'partySize',
        'promotedCount',
        'reRegistration',
        'registrationId',
        'sessionId',
        'source',
        'status',
        'teamId',
        'userId',
      ].sort(),
    );
  });

  it('a waitlisted register logs status WAITLISTED; a withdrawal logs registration.withdrawn once and the promotion registration.promoted once', async () => {
    const s = await scene(1);
    const holder = await named(s);
    const next = await named(s);
    await seed(s, holder.userId, 'CONFIRMED');
    const waiting = await act('POST', registerUrl(s), next, { guests: [] });
    expect(waiting.status).toBe(201);
    expect(one(waiting.lines, 'registration.created')).toMatchObject({
      status: 'WAITLISTED',
      partySize: 1,
      traceId: TRACE_ID,
    });

    const out = await act('POST', withdrawUrl(s), holder, { expectLate: false });
    expect(out.status).toBe(200);
    expect(
      events(out.lines)
        .map((line) => line.event)
        .sort(),
    ).toEqual(['registration.promoted', 'registration.withdrawn']);
    const holderRow = await readRegistration(database.pool, s.sessionId, holder.userId);
    const nextRow = await readRegistration(database.pool, s.sessionId, next.userId);
    const withdrawn = one(out.lines, 'registration.withdrawn');
    expect(withdrawn).toMatchObject({
      teamId: s.teamId,
      sessionId: s.sessionId,
      userId: holder.userId,
      registrationId: holderRow?.id,
      withdrawalKind: 'EARLY',
      feeDue: false,
      wasConfirmed: true,
      promotedCount: 1,
      liabilitiesReleased: 0,
      traceId: TRACE_ID,
    });
    expect(ownFields(withdrawn)).toEqual(
      [
        'feeDue',
        'liabilitiesReleased',
        'promotedCount',
        'registrationId',
        'sessionId',
        'teamId',
        'userId',
        'wasConfirmed',
        'withdrawalKind',
      ].sort(),
    );
    const promoted = one(out.lines, 'registration.promoted');
    expect(promoted).toMatchObject({
      teamId: s.teamId,
      sessionId: s.sessionId,
      registrationId: nextRow?.id,
      userId: next.userId,
      cause: 'withdrawal',
      liabilitiesReleased: 0,
      traceId: TRACE_ID,
    });
    expect(ownFields(promoted)).toEqual(
      ['cause', 'liabilitiesReleased', 'registrationId', 'sessionId', 'teamId', 'userId'].sort(),
    );
  });

  it('every refusal logs registration.refused exactly once with its reason and ids, and the forbidden one at warn', async () => {
    const s = await scene(2);
    const base = { teamId: s.teamId, sessionId: s.sessionId };
    const refused = async (
      call: () => ReturnType<typeof act>,
      reason: string,
      who: HttpMember,
      status: number,
    ): Promise<Record<string, unknown>> => {
      const { status: code, lines } = await call();
      expect(code, reason).toBe(status);
      expect(
        events(lines).map((line) => line.event),
        reason,
      ).toEqual(['registration.refused']);
      const line = one(lines, 'registration.refused');
      expect(line, reason).toMatchObject({
        ...base,
        userId: who.userId,
        reason,
        traceId: TRACE_ID,
      });
      expect(ownFields(line), reason).toEqual(['reason', 'sessionId', 'teamId', 'userId']);
      return line;
    };

    // overdue_payments
    const debtor = await named(s);
    for (let i = 0; i < 3; i += 1) {
      const elsewhere = await scene();
      const registrationId = await seed(elsewhere, debtor.userId, 'CONFIRMED');
      const paymentId = await insertPayment(database.pool, {
        userId: debtor.userId,
        teamId: elsewhere.teamId,
        registrationId,
        amount: '17.00',
      });
      await database.pool.query(`UPDATE payments SET status = 'OVERDUE' WHERE id = $1`, [
        paymentId,
      ]);
    }
    await refused(
      () => act('POST', registerUrl(s), debtor, { guests: [] }),
      'overdue_payments',
      debtor,
      403,
    );

    // already_registered and not_registered
    const me = await named(s);
    await act('POST', registerUrl(s), me, { guests: [] });
    await refused(
      () => act('POST', registerUrl(s), me, { guests: [] }),
      'already_registered',
      me,
      409,
    );
    const stranger = await named(s);
    await refused(
      () => act('POST', withdrawUrl(s), stranger, { expectLate: false }),
      'not_registered',
      stranger,
      409,
    );

    // party_exceeds_capacity
    const big = await named(s);
    const three = { sex: 'MALE', skillLevel: 'BEGINNER' };
    await refused(
      () => act('POST', registerUrl(s), big, { guests: [three, three] }),
      'party_exceeds_capacity',
      big,
      422,
    );

    // session_not_open
    const closed = await scene();
    const late = await named(closed);
    await database.pool.query(`UPDATE game_sessions SET status = 'CANCELLED' WHERE id = $1`, [
      closed.sessionId,
    ]);
    const closedLine = await act('POST', registerUrl(closed), late, { guests: [] });
    expect(closedLine.status).toBe(409);
    expect(one(closedLine.lines, 'registration.refused')).toMatchObject({
      reason: 'session_not_open',
      sessionId: closed.sessionId,
      traceId: TRACE_ID,
    });

    // forbidden: the gate inside the transaction refuses a member banned after the guard passed.
    const victim = await named(s);
    const mark = h.logs.lines().length;
    const client = await database.pool.connect();
    await client.query('BEGIN');
    try {
      await client.query(
        'SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2 FOR NO KEY UPDATE',
        [s.teamId, victim.userId],
      );
      const pending = h.app.inject({
        method: 'POST',
        url: registerUrl(s),
        headers: { ...bearer(victim.token), traceparent: TRACEPARENT },
        payload: { guests: [] },
      });
      await waitForLockWaiters(database.pool, 1, 'register blocked on the member row');
      await client.query(
        `UPDATE team_members SET status = 'BANNED', banned_at = now(), banned_by = user_id, ban_reason = $3 WHERE team_id = $1 AND user_id = $2`,
        [s.teamId, victim.userId, BAN_REASON],
      );
      await client.query('COMMIT');
      expect((await pending).statusCode).toBe(403);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    const forbiddenLines = h.logs.lines().slice(mark);
    const forbidden = one(forbiddenLines, 'registration.refused');
    expect(forbidden).toMatchObject({ reason: 'forbidden', userId: victim.userId, level: 'warn' });
    expect(events(forbiddenLines)).toHaveLength(1);
  });

  it('a late withdrawal that nobody replaces logs feeDue true; a refusal for a stale deadline logs cancellation_terms_changed', async () => {
    const s = await scene();
    const me = await named(s);
    await seed(s, me.userId, 'CONFIRMED');
    h.clock.set(new Date(s.deadline.getTime() + 1));
    const stale = await act('POST', withdrawUrl(s), me, { expectLate: false });
    expect(stale.status).toBe(409);
    expect(one(stale.lines, 'registration.refused')).toMatchObject({
      reason: 'cancellation_terms_changed',
      userId: me.userId,
    });
    const out = await act('POST', withdrawUrl(s), me, { expectLate: true });
    expect(out.status).toBe(200);
    expect(one(out.lines, 'registration.withdrawn')).toMatchObject({
      withdrawalKind: 'LATE',
      feeDue: true,
      promotedCount: 0,
    });
  });

  it('reads and upcoming lists log no registration event, and no line of any action carries PII or the session token', async () => {
    const s = await scene();
    const me = await named(s);
    const guest = { sex: 'MALE', skillLevel: 'BEGINNER', displayName: GUEST_NAME };
    const before = h.logs.lines().length;
    expect((await act('POST', registerUrl(s), me, { guests: [guest] })).status).toBe(201);
    const read = await act('GET', `${sessionUrl(s.teamId, s.sessionId)}/registration`, me);
    expect(read.status).toBe(200);
    expect(events(read.lines)).toEqual([]);
    const upcoming = await act('GET', `/teams/${s.teamId}/sessions/upcoming`, me);
    expect(upcoming.status).toBe(200);
    expect(events(upcoming.lines)).toEqual([]);
    const banned = await named(s, 'BANNED');
    await act('POST', registerUrl(s), banned, { guests: [] });

    const text = JSON.stringify(h.logs.lines().slice(before));
    for (const secret of [EMAIL_PART, FULL_NAME, GUEST_NAME, TEAM_NAME, BAN_REASON, ...tokens]) {
      expect(text, secret).not.toContain(secret);
    }
    // Every request line of these actions carries the trace.
    for (const line of h.logs.lines().slice(before)) {
      if (typeof line.event === 'string' && line.event.startsWith('registration.')) {
        expect(line.traceId, String(line.event)).toBe(TRACE_ID);
      }
    }
  });
});
