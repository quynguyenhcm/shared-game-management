/**
 * The registrations adapter filling session-scheduling-engine's allocator port (registration-and-waitlist Phase 2,
 * AC-INTEGRATION-6 domain half; R19, R21, R22; ADR 0018, ADR 0019 §6 and §8). Nothing here changes `createSessionAllocator`
 * (Phase 3 does): the adapter is INJECTED into SSE's own code paths, over a real cloned PostgreSQL and a real pg-boss producer:
 *
 * - the auto-enrol follow-up (`runSessionAutoEnrol`, SSE's advisory lock, JOB_POLICY, the D-80 marker),
 * - the capacity edit (`PUT /teams/:teamId/sessions/:sessionId`, HTTP_POLICY),
 * - series propagation (`PUT /teams/:teamId/session-series/:ruleId`, the rule lock and the instances' session locks).
 *
 * A spy wraps the adapter so each case can see the statements SSE's transaction ran INSIDE a port call: none may set a lock
 * timeout, open a savepoint or otherwise manage the transaction (R22).
 */
import { randomUUID } from 'node:crypto';
import { PostgresDialect } from 'kysely';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionResponse } from '@sgm/shared';
import { QUEUES } from '../../src/jobs/registry.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import { createJobRunner, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import { createAllocator } from '../../src/modules/registrations/allocator.ts';
import { createRegistrationsSessionAllocator } from '../../src/modules/registrations/session-allocator-adapter.ts';
import type {
  PromotedSeat,
  SessionAllocatorPort,
} from '../../src/modules/sessions/allocator-port.ts';
import { runSessionAutoEnrol } from '../../src/modules/sessions/auto-enrol.ts';
import { START_TIME, bearer, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  insertAuthSession,
  insertPublishedSession,
  insertRegistration,
  insertRule,
  insertSession,
  setAutoEnroll,
} from '../helpers/factories.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import { createQueryRecorder, createRecordingDatabase } from '../helpers/query-recorder.ts';
import {
  createRecordingJobs,
  insertMember,
  readRegistration,
  readRegistrations,
} from '../helpers/registration-scene.ts';
import { createSessionsScene } from '../helpers/sessions-scene.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

const WEB = 'https://games.example.nz';
const BASE = new Date('2026-10-20T00:00:00.000Z');

let database: TestDatabase;
let producer: JobRunner;
let worker: JobRunner;
let h: AuthTestApp;
let jobs: ReturnType<typeof createRecordingJobs>;
const logs = captureLogs();
const recorder = createQueryRecorder();
const clock = createManualClock(BASE);

/** One recorded port call: what SSE handed in, and the SQL that ran between entering and leaving the adapter. */
interface PortCall {
  readonly method: 'promoteWaitlist' | 'autoEnrolInSession';
  readonly sessionId: string;
  readonly inTransaction: boolean;
  readonly now: Date;
  readonly inside: string[];
  /** Seats returned by `promoteWaitlist`. */
  readonly promoted?: readonly PromotedSeat[];
}
const calls: PortCall[] = [];
/** Test hooks run by the spy around the real adapter. */
const hooks: {
  beforeAutoEnrol?: () => Promise<void>;
  afterPromote?: () => void;
  afterAutoEnrol?: () => void;
} = {};

let adapter: SessionAllocatorPort;

const spy: SessionAllocatorPort = {
  name: 'registrations',
  enrols: true,
  async promoteWaitlist(ctx, input) {
    const mark = recorder.statements.length;
    const promoted = await adapter.promoteWaitlist(ctx, input);
    calls.push({
      method: 'promoteWaitlist',
      sessionId: input.sessionId,
      inTransaction: ctx.trx.isTransaction,
      now: ctx.now,
      inside: recorder.statements.slice(mark),
      promoted,
    });
    hooks.afterPromote?.();
    return promoted;
  },
  async autoEnrolInSession(ctx, input) {
    await hooks.beforeAutoEnrol?.();
    const mark = recorder.statements.length;
    const results = await adapter.autoEnrolInSession(ctx, input);
    calls.push({
      method: 'autoEnrolInSession',
      sessionId: input.sessionId,
      inTransaction: ctx.trx.isTransaction,
      now: ctx.now,
      inside: recorder.statements.slice(mark),
    });
    hooks.afterAutoEnrol?.();
    return results;
  },
};

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 16 });
  worker = createJobRunner({
    databaseUrl: database.url,
    logger: captureLogs().logger,
    role: 'worker',
  });
  producer = createJobRunner({
    databaseUrl: database.url,
    logger: captureLogs().logger,
    role: 'producer',
  });
  await worker.start();
  await producer.start();
  for (const queue of QUEUES) await worker.defineQueue(queue);
  jobs = createRecordingJobs(producer);
  adapter = createRegistrationsSessionAllocator(createAllocator({ jobs, webBaseUrl: WEB }));
  h = await buildAuthTestApp(database.pool, {
    db: createRecordingDatabase(new PostgresDialect({ pool: database.pool }), recorder),
    sessionAllocator: spy,
    jobs,
  });
});
afterAll(async () => {
  await h.close();
  await producer.stop();
  await worker.stop();
  await database.close();
});
beforeEach(() => {
  h.clock.set(START_TIME);
  clock.set(BASE);
  calls.length = 0;
  recorder.reset();
  jobs.reset();
  hooks.beforeAutoEnrol = undefined;
  hooks.afterPromote = undefined;
  hooks.afterAutoEnrol = undefined;
});

/** The transaction-management statements no port call may issue (R22): SSE owns the timeout, the retry and the savepoints. */
const MANAGES_TRANSACTION = /lock_timeout|savepoint|\bbegin\b|\bcommit\b|\brollback\b/i;
const expectNoTransactionManagement = (): void => {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.inTransaction).toBe(true);
    expect(
      call.inside.filter((sql) => MANAGES_TRANSACTION.test(sql)),
      `${call.method} statements`,
    ).toEqual([]);
  }
};

/** `[userId, status]` for the given members, in the order given (every row of one scene shares the manual clock's registered_at). */
async function statusesOf(
  sessionId: string,
  userIds: readonly string[],
): Promise<[string, string | undefined][]> {
  const rows = await readRegistrations(database.pool, sessionId);
  return userIds.map((userId) => [userId, rows.find((row) => row.userId === userId)?.status]);
}

const pendingEmailsTo = async (addresses: readonly string[]): Promise<string[]> => {
  const { rows } = await database.pool.query<{ to: string }>(
    `SELECT data->>'to' AS "to" FROM pgboss.job WHERE name = 'send-email' AND data->>'to' = ANY($1)`,
    [addresses],
  );
  return rows.map((row) => row.to).sort();
};

// ---------------------------------------------------------------------------------------------
// Auto-enrol through SSE's follow-up transaction
// ---------------------------------------------------------------------------------------------

describe('auto-enrol through runSessionAutoEnrol (SSE SA-3, ADR 0019 §6)', () => {
  const autoEnrolDeps = (allocator: SessionAllocatorPort) => ({
    db: h.db,
    clock,
    allocator,
    log: logs.logger,
  });

  async function pendingSession(maxPlayers = 12) {
    const { sessionId, teamId } = await insertPublishedSession(database.pool, undefined, {
      now: BASE,
      maxPlayers,
    });
    return { sessionId, teamId };
  }

  async function enrollee(
    teamId: string,
    offset: number,
    email = `adapter-${randomUUID()}@example.test`,
  ) {
    const userId = await insertMember(database.pool, teamId, { email });
    const assignedAt = new Date(BASE.getTime() - 86_400_000 + offset * 1000);
    await setAutoEnroll(database.pool, { teamId, userId, enabled: true, assignedAt });
    return { userId, email };
  }

  const markerOf = async (sessionId: string): Promise<Date | null> =>
    (
      await database.pool.query<{ auto_enrolled_at: Date | null }>(
        `SELECT auto_enrolled_at FROM game_sessions WHERE id = $1`,
        [sessionId],
      )
    ).rows[0]?.auto_enrolled_at ?? null;

  it('places members in selection order inside SSE’s transaction, queues the emails on it, stamps the marker once, and a second run enrols nobody', async () => {
    const { sessionId, teamId } = await pendingSession(2);
    const first = await enrollee(teamId, 1);
    const second = await enrollee(teamId, 2);
    const third = await enrollee(teamId, 3);

    const outcome = await runSessionAutoEnrol(autoEnrolDeps(spy), { teamId, sessionId });

    expect(outcome).toMatchObject({
      kind: 'done',
      candidates: 3,
      confirmed: 2,
      waitlisted: 1,
      skipped: 0,
    });
    const rows = await readRegistrations(database.pool, sessionId);
    expect(await statusesOf(sessionId, [first.userId, second.userId, third.userId])).toEqual([
      [first.userId, 'CONFIRMED'],
      [second.userId, 'CONFIRMED'],
      [third.userId, 'WAITLISTED'],
    ]);
    expect(rows.every((row) => row.source === 'AUTO_ENROL')).toBe(true);
    // Placed in selection order: the waitlist position and the email order follow the entries.
    expect(rows.find((row) => row.userId === third.userId)?.queuePosition).toBe(1);
    // D-80: the marker is stamped in the same transaction as the placements.
    expect(await markerOf(sessionId)).toEqual(clock.now());
    expect(calls.map((call) => call.method)).toEqual(['autoEnrolInSession']);
    expectNoTransactionManagement();
    // The emails were handed the caller's transaction (P5), one per placed member.
    expect(jobs.recorded.filter((job) => job.queue === 'send-email')).toHaveLength(3);
    expect(
      jobs.recorded.filter((job) => job.queue === 'send-email').every((job) => job.inTransaction),
    ).toBe(true);
    expect(await pendingEmailsTo([first.email, second.email, third.email])).toEqual(
      [first.email, second.email, third.email].sort(),
    );
    expect(
      logs
        .lines()
        .filter(
          (line) => line.event === 'session.auto_enrol.completed' && line.sessionId === sessionId,
        ),
    ).toMatchObject([{ allocator: 'registrations', confirmed: 2, waitlisted: 1 }]);

    calls.length = 0;
    expect(await runSessionAutoEnrol(autoEnrolDeps(spy), { teamId, sessionId })).toMatchObject({
      kind: 'not_due',
    });
    expect(calls).toEqual([]);
    expect(await readRegistrations(database.pool, sessionId)).toHaveLength(3);
  });

  it('R21: a member with a row in ANY status is skipped as already_registered, the row is untouched and no email is sent; the marker is still stamped', async () => {
    // Capacity 1: the CONFIRMED row holds the seat, so the seeded waitlist and owed fee are consistent states.
    const { sessionId, teamId } = await pendingSession(1);
    const kinds = [
      { status: 'CONFIRMED' },
      { status: 'WAITLISTED', queuePosition: 1 },
      { status: 'WITHDRAWN', withdrawalKind: 'EARLY' },
      { status: 'WITHDRAWN', withdrawalKind: 'LATE', withdrawalFeeDue: true },
      { status: 'WITHDRAWN', withdrawalKind: 'BANNED' },
    ] as const;
    const emails: string[] = [];
    for (const [index, kind] of kinds.entries()) {
      const member = await enrollee(teamId, index + 1);
      emails.push(member.email);
      await insertRegistration(database.pool, {
        sessionId,
        teamId,
        userId: member.userId,
        source: 'MEMBER',
        ...kind,
      });
    }
    const fresh = await enrollee(teamId, 10);
    const before = await readRegistrations(database.pool, sessionId);

    const outcome = await runSessionAutoEnrol(autoEnrolDeps(spy), { teamId, sessionId });

    expect(outcome).toMatchObject({
      kind: 'done',
      candidates: 6,
      confirmed: 0,
      waitlisted: 1,
      skipped: 5,
    });
    const after = await readRegistrations(database.pool, sessionId);
    expect(after.filter((row) => row.userId !== fresh.userId)).toEqual(before);
    expect(after.find((row) => row.userId === fresh.userId)).toMatchObject({
      status: 'WAITLISTED',
      queuePosition: 2,
      source: 'AUTO_ENROL',
    });
    expect(await pendingEmailsTo([...emails, fresh.email])).toEqual([fresh.email]);
    expect(await markerOf(sessionId)).not.toBeNull();
    expect(
      logs
        .lines()
        .filter(
          (line) => line.event === 'session.auto_enrol.completed' && line.sessionId === sessionId,
        ),
    ).toMatchObject([{ skipped: { already_registered: 5 } }]);
  });

  it('R16: a member who turns Auto Enroll off between SSE’s selection and the allocator is skipped as auto_enroll_changed; the rest are placed', async () => {
    const { sessionId, teamId } = await pendingSession();
    const stays = await enrollee(teamId, 1);
    const leaves = await enrollee(teamId, 2);
    const alsoStays = await enrollee(teamId, 3);
    hooks.beforeAutoEnrol = async () => {
      await setAutoEnroll(database.pool, { teamId, userId: leaves.userId, enabled: false });
    };

    const outcome = await runSessionAutoEnrol(autoEnrolDeps(spy), { teamId, sessionId });

    expect(outcome).toMatchObject({ kind: 'done', candidates: 3, confirmed: 2, skipped: 1 });
    expect(await readRegistration(database.pool, sessionId, leaves.userId)).toBeUndefined();
    expect(
      (await readRegistrations(database.pool, sessionId)).map((row) => row.userId).sort(),
    ).toEqual([stays.userId, alsoStays.userId].sort());
    expect(
      logs
        .lines()
        .filter(
          (line) => line.event === 'session.auto_enrol.completed' && line.sessionId === sessionId,
        ),
    ).toMatchObject([{ skipped: { auto_enroll_changed: 1 } }]);
  });

  it('D-80: the marker is stamped only when the port enrols; a port with enrols false leaves the session pending until the real adapter runs', async () => {
    const { sessionId, teamId } = await pendingSession();
    const member = await enrollee(teamId, 1);

    const inert: SessionAllocatorPort = { ...spy, enrols: false };
    expect(await runSessionAutoEnrol(autoEnrolDeps(inert), { teamId, sessionId })).toMatchObject({
      kind: 'noop_port',
      candidates: 1,
    });
    expect(await markerOf(sessionId)).toBeNull();
    expect(await readRegistrations(database.pool, sessionId)).toEqual([]);
    expect(calls).toEqual([]);

    expect(await runSessionAutoEnrol(autoEnrolDeps(spy), { teamId, sessionId })).toMatchObject({
      kind: 'done',
      confirmed: 1,
    });
    expect(await markerOf(sessionId)).not.toBeNull();
    expect((await readRegistration(database.pool, sessionId, member.userId))?.status).toBe(
      'CONFIRMED',
    );
  });

  it('R22: when SSE retries the whole transaction after a deadlock, the first attempt leaves nothing behind: one row and one email per member', async () => {
    const { sessionId, teamId } = await pendingSession();
    const one = await enrollee(teamId, 1);
    const two = await enrollee(teamId, 2);
    let failures = 0;
    hooks.afterAutoEnrol = () => {
      // The adapter has placed both members and queued both emails; now the transaction dies as a deadlock victim.
      if (failures === 0) {
        failures += 1;
        throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      }
    };

    const outcome = await runSessionAutoEnrol(autoEnrolDeps(spy), { teamId, sessionId });

    expect(failures).toBe(1);
    expect(calls.map((call) => call.method)).toEqual(['autoEnrolInSession', 'autoEnrolInSession']);
    expect(outcome).toMatchObject({ kind: 'done', confirmed: 2, skipped: 0 });
    expect(await readRegistrations(database.pool, sessionId)).toHaveLength(2);
    expect(await statusesOf(sessionId, [one.userId, two.userId])).toEqual([
      [one.userId, 'CONFIRMED'],
      [two.userId, 'CONFIRMED'],
    ]);
    expect(await pendingEmailsTo([one.email, two.email])).toEqual([one.email, two.email].sort());
    expect(await markerOf(sessionId)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The capacity edit and series propagation (C-SSE-3, ADR 0019 §2)
// ---------------------------------------------------------------------------------------------

type Body = Record<string, unknown>;

interface Scene {
  readonly teamId: string;
  readonly admin: string;
}

async function scene(): Promise<Scene> {
  const base = await createSessionsScene(database.pool, { payoutConfigured: true });
  const { token } = await insertAuthSession(database.pool, base.adminId, {
    createdAt: h.clock.now(),
    idleDays: 90,
    absoluteDays: 180,
  });
  return { teamId: base.teamId, admin: token };
}

const call = (
  method: 'POST' | 'PUT',
  url: string,
  token: string,
  payload: object,
): Promise<LightMyRequestResponse> =>
  h.app.inject({
    method,
    url,
    headers: bearer(token),
    payload: payload as Record<string, unknown>,
  });

/** A small session: public capacity 2 (4 seats, 2 reserved), $10.00 a player. */
function sessionBody(over: Body = {}): Body {
  return {
    createKey: randomUUID(),
    date: '2026-11-04',
    location: 'Rosedale Badminton Centre',
    address: '12B John Glenn Avenue, Rosedale, Auckland 0632',
    maxPlayers: 4,
    reservedSeats: 2,
    courtCost: '40.00',
    extraExpenses: '0.00',
    pricingStructure: 'FLAT',
    courts: [{ identifier: 'Court 1', startTime: '19:00', endTime: '21:00' }],
    ...over,
  };
}
const editBody = (body: Body, expectedVersion: number, over: Body = {}): Body => {
  const rest: Body = { ...body };
  delete rest.createKey;
  return { ...rest, expectedVersion, ...over };
};

async function publishedSession(c: Scene) {
  const body = sessionBody();
  const created = await call('POST', `/teams/${c.teamId}/sessions`, c.admin, body);
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<{ session: SessionResponse }>().session.id;
  const published = await call('POST', `/teams/${c.teamId}/sessions/${id}/publish`, c.admin, {
    expectedVersion: 1,
  });
  expect(published.statusCode, published.body).toBe(200);
  return { id, body, version: published.json<{ session: SessionResponse }>().session.version };
}

/** Registers through the real allocator in a transaction of its own, as the member routes will (Phase 3). */
async function registerAll(teamId: string, sessionId: string, userIds: readonly string[]) {
  const allocator = createAllocator({ jobs, webBaseUrl: WEB });
  for (const userId of userIds) {
    await h.db
      .transaction()
      .execute((trx) =>
        allocator.registerInSession(
          { trx, now: h.clock.now(), log: logs.logger },
          { teamId, sessionId, userId, guests: [] },
        ),
      );
  }
}

describe('capacity edit through PUT /teams/:teamId/sessions/:sessionId (C-SSE-3)', () => {
  async function fullSession() {
    const c = await scene();
    const s = await publishedSession(c);
    const members = [
      await insertMember(database.pool, c.teamId, { email: `cap-1-${s.id}@example.test` }),
      await insertMember(database.pool, c.teamId, { email: `cap-2-${s.id}@example.test` }),
      await insertMember(database.pool, c.teamId, { email: `cap-3-${s.id}@example.test` }),
      await insertMember(database.pool, c.teamId, { email: `cap-4-${s.id}@example.test` }),
    ];
    await registerAll(c.teamId, s.id, members);
    jobs.reset();
    recorder.reset();
    return { c, s, members, emails: members.map((_, i) => `cap-${i + 1}-${s.id}@example.test`) };
  }

  it('promotes first-fit inside the edit transaction, emails on that transaction, and SSE reports exactly the seats the adapter returned', async () => {
    const { c, s, members, emails } = await fullSession();
    expect((await statusesOf(s.id, members)).map(([, status]) => status)).toEqual([
      'CONFIRMED',
      'CONFIRMED',
      'WAITLISTED',
      'WAITLISTED',
    ]);

    const res = await call(
      'PUT',
      `/teams/${c.teamId}/sessions/${s.id}`,
      c.admin,
      editBody(s.body, s.version, { maxPlayers: 5, courtCost: '50.00' }),
    );

    expect(res.statusCode, res.body).toBe(200);
    expect(calls.map((entry) => entry.method)).toEqual(['promoteWaitlist']);
    const [seats] = [calls[0]?.promoted ?? []];
    expect(seats.map((seat) => seat.userId)).toEqual([members[2]]);
    expect(res.json<{ promoted: number }>().promoted).toBe(seats.length);
    expect(calls[0]?.now).toEqual(h.clock.now());
    expectNoTransactionManagement();
    expect(await statusesOf(s.id, members)).toEqual([
      [members[0], 'CONFIRMED'],
      [members[1], 'CONFIRMED'],
      [members[2], 'CONFIRMED'],
      [members[3], 'WAITLISTED'],
    ]);
    const promotionEmail = jobs.recorded.filter((job) => job.queue === 'send-email');
    expect(promotionEmail).toHaveLength(1);
    expect(promotionEmail[0]?.inTransaction).toBe(true);
    expect(await pendingEmailsTo(emails)).toEqual([emails[2]]);
  });

  it('a rolled-back edit leaves no promotion, no change of capacity and no email', async () => {
    const { c, s, members, emails } = await fullSession();
    hooks.afterPromote = () => {
      throw new Error('the edit fails after the promotion');
    };

    const res = await call(
      'PUT',
      `/teams/${c.teamId}/sessions/${s.id}`,
      c.admin,
      editBody(s.body, s.version, { maxPlayers: 5, courtCost: '50.00' }),
    );

    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(calls.map((entry) => entry.method)).toEqual(['promoteWaitlist']);
    expect(await statusesOf(s.id, members)).toEqual([
      [members[0], 'CONFIRMED'],
      [members[1], 'CONFIRMED'],
      [members[2], 'WAITLISTED'],
      [members[3], 'WAITLISTED'],
    ]);
    const { rows } = await database.pool.query<{ max_players: number }>(
      `SELECT max_players FROM game_sessions WHERE id = $1`,
      [s.id],
    );
    expect(rows[0]?.max_players).toBe(4);
    expect(await pendingEmailsTo(emails)).toEqual([]);
  });
});

describe('series propagation (ADR 0019 §2: the rule lock and the instances’ session locks are already held)', () => {
  it('promotes first-fit on each raised instance inside the propagation transaction, with no lock timeout or retry of its own', async () => {
    const c = await scene();
    const ruleId = await insertRule(database.pool, c.teamId);
    const sessionId = await insertSession(
      database.pool,
      c.teamId,
      {},
      {
        date: '2026-10-21',
        status: 'PUBLISHED',
        recurringRuleId: ruleId,
        maxPlayers: 4,
        reservedSeats: 2,
      },
    );
    const members = [
      await insertMember(database.pool, c.teamId, { email: `series-1-${ruleId}@example.test` }),
      await insertMember(database.pool, c.teamId, { email: `series-2-${ruleId}@example.test` }),
      await insertMember(database.pool, c.teamId, { email: `series-3-${ruleId}@example.test` }),
    ];
    await registerAll(c.teamId, sessionId, members);
    expect((await statusesOf(sessionId, members)).map(([, status]) => status)).toEqual([
      'CONFIRMED',
      'CONFIRMED',
      'WAITLISTED',
    ]);
    jobs.reset();
    recorder.reset();
    const { rows } = await database.pool.query<{ version: number }>(
      `SELECT version FROM recurring_session_rules WHERE id = $1`,
      [ruleId],
    );
    const version = rows[0]?.version ?? 0;

    const res = await call('PUT', `/teams/${c.teamId}/session-series/${ruleId}`, c.admin, {
      frequency: 'WEEKLY',
      dayOfWeek: 3,
      startsOn: '2026-10-07',
      monthlyWeek: null,
      recurUntil: null,
      location: 'Test Hall',
      address: '1 Test Street, Auckland',
      maxPlayers: 8,
      reservedSeats: 2,
      courtCost: '80.00',
      extraExpenses: '0.00',
      pricingStructure: 'FLAT',
      courts: [{ identifier: 'Court 1', startTime: '19:00', endTime: '21:00' }],
      expectedVersion: version,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(calls.filter((entry) => entry.sessionId === sessionId).map((e) => e.method)).toEqual([
      'promoteWaitlist',
    ]);
    expect(calls[0]?.promoted?.map((seat) => seat.userId)).toEqual([members[2]]);
    expectNoTransactionManagement();
    expect((await readRegistration(database.pool, sessionId, members[2] ?? ''))?.status).toBe(
      'CONFIRMED',
    );
    const emails = members.map((_, i) => `series-${i + 1}-${ruleId}@example.test`);
    expect(await pendingEmailsTo(emails)).toEqual([emails[2]]);
    expect(
      jobs.recorded.filter((job) => job.queue === 'send-email').every((job) => job.inTransaction),
    ).toBe(true);
  });
});
