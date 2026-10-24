/**
 * Log hygiene for the session-scheduling-engine events (AC-VERIFY-6). Every event named by the AC is triggered for real
 * and its logged FIELDS are asserted (not only that it fired; `logging-redaction-global` learned rule):
 *
 *   - API path (the real `buildApp`, a `traceparent` header on every request): session.created / updated / published /
 *     publish_refused / cancelled / stale_refused, session.series.created / updated / ended / publish_drafts_requested,
 *     session.lock_retry and session.lock_retry_exhausted.
 *   - Job path (the production `registerJobs` wiring on a real worker; every job is queued inside a known trace, so its
 *     `_meta.traceparent` is restored as the parent of the job's CONSUMER span): session.recurrence.* and
 *     session.auto_enrol.*, which must all carry that trace's traceId.
 *
 * Shared rules for every line: ids only (teamId plus sessionId or ruleId, actorId on admin actions), error codes as
 * `errorCode` (never `code`), no email, name, address or bank value anywhere, no redacted value (so no new field name
 * collides with a redaction key), and no `session.notify.*` event exists (P-2: nobody is emailed about a session).
 *
 * Tracing decision (recorded for the build review): the existing job wrapper already opens a `"{queue} process"` CONSUMER
 * span from `_meta.traceparent` around the sweep and every rule or auto-enrol job, and the API routes are traced by the
 * request instrumentation, so the sweep and rule runs need no extra `session.recurrence.*` span. The finer child spans of
 * the architecture's Distributed Tracing list are not required by any AC and are not added here.
 */
import { randomUUID } from 'node:crypto';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SeriesResponse, SessionResponse } from '@sgm/shared';
import { registerJobs } from '../../src/jobs/bootstrap.ts';
import { QUEUES, QUEUE_NAMES } from '../../src/jobs/registry.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import {
  createJobRunner,
  parseTraceparent,
  runWithTrace,
  type JobRunner,
} from '../../src/lib/jobs/jobs.ts';
import { createInMemoryNotifier } from '../../src/lib/notifications/adapters/in-memory.ts';
import { startTelemetry, type Telemetry } from '../../src/lib/telemetry/telemetry.ts';
import {
  SessionAutoEnrolPayload,
  sessionAutoEnrolKey,
} from '../../src/modules/sessions/auto-enrol.ts';
import { materialiseRule, type MaterialiseDeps } from '../../src/modules/sessions/materialise.ts';
import { enqueueRuleMaterialisation } from '../../src/modules/sessions/rule-jobs.ts';
import { HTTP_POLICY, runSessionTransaction } from '../../src/modules/sessions/tx.ts';
import { testCrypto } from '../helpers/app-deps.ts';
import { START_TIME, bearer, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  insertAuthSession,
  insertRule,
  insertTeamMember,
  insertUser,
  type RuleOptions,
} from '../helpers/factories.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import { createRecordingAllocator, createSessionsScene } from '../helpers/sessions-scene.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';
import { waitFor } from '../helpers/wait-for.ts';

const hex = (length: number): string => randomUUID().replaceAll('-', '').slice(0, length);
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const TRACEPARENT = `00-${TRACE_ID}-b7ad6b7169203331-01`;
const REQUEST_TRACE = { traceparent: TRACEPARENT };

/** 10:00 on Tuesday 2026-10-20 in NZ: a Tuesday rule that starts on 2026-10-06 has five dates in the window. */
const JOB_NOW = new Date('2026-10-19T21:00:00Z');

let database: TestDatabase;
let h: AuthTestApp;
let producer: JobRunner;
let telemetry: Telemetry;
const allocator = createRecordingAllocator();
const apiLogs = (): Record<string, unknown>[] => h.logs.lines();

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
  database = await createTestDatabase({ poolMax: 16 });
  const setup = createJobRunner({
    databaseUrl: database.url,
    logger: captureLogs().logger,
    role: 'worker',
  });
  await setup.start();
  for (const queue of QUEUES) await setup.defineQueue(queue);
  producer = createJobRunner({
    databaseUrl: database.url,
    logger: captureLogs().logger,
    role: 'producer',
  });
  await producer.start();
  await setup.stop();
  h = await buildAuthTestApp(database.pool, {
    sessionAllocator: allocator,
    jobs: { enqueue: (queue, data, options) => producer.enqueue(queue, data, options) },
  });
});
afterAll(async () => {
  await h.close();
  await producer.stop();
  await database.close();
  await telemetry.shutdown();
});
beforeEach(() => {
  h.clock.set(START_TIME);
  allocator.reset();
  allocator.promoted = [];
});

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

/** The keys the logger and the job runner add to a line; what remains is the event's own field set. */
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
  'jobId',
  'queue',
]);
const ownFields = (line: Record<string, unknown> | undefined): string[] =>
  Object.keys(line ?? {})
    .filter((key) => !ENVELOPE.has(key))
    .sort();

const only = (
  lines: Record<string, unknown>[],
  event: string,
  match: Record<string, unknown> = {},
): Record<string, unknown>[] =>
  lines.filter(
    (line) => line.event === event && Object.entries(match).every(([k, v]) => line[k] === v),
  );
const one = (
  lines: Record<string, unknown>[],
  event: string,
  match: Record<string, unknown> = {},
): Record<string, unknown> => {
  const found = only(lines, event, match);
  expect(found, `${event} ${JSON.stringify(match)}`).toHaveLength(1);
  return found[0] ?? {};
};

interface Scene {
  readonly teamId: string;
  readonly adminId: string;
  readonly memberId: string;
  readonly admin: string;
  readonly adminEmail: string;
}

async function scene(options: { payout: boolean }): Promise<Scene> {
  const base = await createSessionsScene(database.pool, { payoutConfigured: options.payout });
  const { token } = await insertAuthSession(database.pool, base.adminId, {
    createdAt: h.clock.now(),
    idleDays: 90,
    absoluteDays: 180,
  });
  const { rows } = await database.pool.query<{ email: string }>(
    `SELECT email FROM users WHERE id = $1`,
    [base.adminId],
  );
  await database.pool.query(`UPDATE users SET full_name = $2 WHERE id = $1`, [
    base.adminId,
    'Gwendolyn Logsworth',
  ]);
  return { ...base, admin: token, adminEmail: rows[0]?.email ?? '' };
}

const call = (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  token: string,
  payload?: object,
): Promise<LightMyRequestResponse> =>
  h.app.inject({
    method,
    url,
    headers: { ...bearer(token), ...REQUEST_TRACE },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

type Body = Record<string, unknown>;
const LOCATION = 'Rosedale Badminton Centre';
const ADDRESS = '12B John Glenn Avenue, Rosedale, Auckland 0632';

function sessionBody(over: Body = {}): Body {
  return {
    createKey: randomUUID(),
    date: '2026-11-04',
    location: LOCATION,
    address: ADDRESS,
    maxPlayers: 20,
    reservedSeats: 0,
    // $200.00 over 20 players: a $10.00 rate, so the session is paid.
    courtCost: '200.00',
    extraExpenses: '0.00',
    pricingStructure: 'FLAT',
    courts: [{ identifier: 'Court 1', startTime: '19:00', endTime: '21:00' }],
    ...over,
  };
}
function edit(body: Body, expectedVersion: number, over: Body = {}): Body {
  const rest: Body = { ...body };
  delete rest.createKey;
  return { ...rest, expectedVersion, ...over };
}
const sessionOf = (res: LightMyRequestResponse): SessionResponse =>
  res.json<{ session: SessionResponse }>().session;
const seriesOf = (res: LightMyRequestResponse): SeriesResponse =>
  res.json<{ series: SeriesResponse }>().series;

/** No email, name, address, bank value or redacted value anywhere in these lines, and never a field named `code`. */
function expectHygiene(lines: Record<string, unknown>[], secrets: readonly string[]): void {
  const serialised = JSON.stringify(lines);
  for (const secret of [
    LOCATION,
    ADDRESS,
    'Gwendolyn Logsworth',
    'Test Club Account',
    '01-0902-0068389-000',
    ...secrets,
  ]) {
    expect(serialised, secret.slice(0, 16)).not.toContain(secret);
  }
  // A redacted value would mean an event field collides with a redaction key.
  expect(serialised).not.toContain('[REDACTED]');
  for (const line of lines) {
    // The logger's base `version` is the service version: no event field may shadow it (a `version` field would).
    expect(line.version, String(line.event)).toBe('test');
    expect(Object.keys(line)).not.toContain('code');
    expect(Object.keys(line).filter((key) => /email|name$|token|address|bank/i.test(key))).toEqual(
      [],
    );
  }
}

// ---------------------------------------------------------------------------------------------
// API events
// ---------------------------------------------------------------------------------------------

describe('session and series events from the API (AC-VERIFY-6)', () => {
  it('logs created, updated, published, stale_refused and cancelled with the documented fields and the request trace', async () => {
    const c = await scene({ payout: true });
    const base = `/teams/${c.teamId}/sessions`;
    const body = sessionBody();

    const created = await call('POST', base, c.admin, body);
    expect(created.statusCode, created.body).toBe(201);
    const id = sessionOf(created).id;
    const updated = await call(
      'PUT',
      `${base}/${id}`,
      c.admin,
      edit(body, 1, { location: 'Another Hall' }),
    );
    expect(updated.statusCode, updated.body).toBe(200);
    const published = await call('POST', `${base}/${id}/publish`, c.admin, {
      expectedVersion: sessionOf(updated).version,
    });
    expect(published.statusCode, published.body).toBe(200);
    // Public capacity rises on the PUBLISHED session: the allocator is called and reports one promoted player.
    allocator.promoted = [
      { registrationId: randomUUID(), userId: c.memberId, promotedAt: START_TIME },
    ];
    const raised = await call(
      'PUT',
      `${base}/${id}`,
      c.admin,
      edit(body, sessionOf(published).version, {
        location: 'Another Hall',
        maxPlayers: 24,
        courtCost: '240.00',
      }),
    );
    expect(raised.statusCode, raised.body).toBe(200);
    // Stale: the version the editor last saw.
    const stale = await call('PUT', `${base}/${id}`, c.admin, edit(body, 1));
    expect(stale.statusCode).toBe(409);
    const cancelled = await call('POST', `${base}/${id}/cancel`, c.admin, {
      expectedVersion: sessionOf(raised).version,
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const mine = apiLogs().filter((line) => line.teamId === c.teamId);
    const createdLine = one(mine, 'session.created', { sessionId: id });
    expect(ownFields(createdLine)).toEqual([
      'actorId',
      'changed',
      'promoted',
      'sessionId',
      'sessionVersion',
      'teamId',
    ]);
    expect(createdLine).toMatchObject({
      actorId: c.adminId,
      changed: [],
      promoted: 0,
      sessionVersion: 1,
    });

    const updatedLines = only(mine, 'session.updated', { sessionId: id });
    expect(updatedLines).toHaveLength(2);
    const [updatedLine = {}, raisedLine = {}] = updatedLines;
    expect(ownFields(updatedLine)).toEqual(ownFields(createdLine));
    expect(updatedLine).toMatchObject({ actorId: c.adminId, promoted: 0, changed: ['location'] });
    expect(ownFields(raisedLine)).toEqual(ownFields(createdLine));
    expect(raisedLine).toMatchObject({ actorId: c.adminId, promoted: 1 });
    expect(raisedLine.changed).toEqual(expect.arrayContaining(['maxPlayers']));

    const publishedLine = one(mine, 'session.published', { sessionId: id });
    expect(ownFields(publishedLine)).toEqual([
      'actorId',
      'autoEnrolQueued',
      'paid',
      'sessionId',
      'teamId',
    ]);
    expect(publishedLine).toMatchObject({
      actorId: c.adminId,
      paid: true,
      autoEnrolQueued: true,
    });

    const staleLine = one(mine, 'session.stale_refused', { sessionId: id });
    expect(ownFields(staleLine)).toEqual([
      'actorId',
      'currentVersion',
      'expectedVersion',
      'sessionId',
      'teamId',
    ]);
    expect(staleLine).toMatchObject({ actorId: c.adminId, expectedVersion: 1 });
    expect(staleLine.currentVersion).toBeGreaterThan(1);

    const cancelledLine = one(mine, 'session.cancelled', { sessionId: id });
    expect(ownFields(cancelledLine)).toEqual(['actorId', 'fromStatus', 'sessionId', 'teamId']);
    expect(cancelledLine).toMatchObject({ actorId: c.adminId, fromStatus: 'PUBLISHED' });

    for (const line of [
      createdLine,
      updatedLine,
      raisedLine,
      publishedLine,
      staleLine,
      cancelledLine,
    ]) {
      expect(line.traceId, String(line.event)).toBe(TRACE_ID);
    }
    expectHygiene(mine, [c.adminEmail]);
  });

  it('logs publish_refused with the reason, path and errorCode when the team has no payout details', async () => {
    const c = await scene({ payout: false });
    const base = `/teams/${c.teamId}/sessions`;
    const created = await call('POST', base, c.admin, sessionBody());
    const id = sessionOf(created).id;

    const refused = await call('POST', `${base}/${id}/publish`, c.admin, { expectedVersion: 1 });
    expect(refused.statusCode, refused.body).toBe(409);

    const line = one(
      apiLogs().filter((entry) => entry.teamId === c.teamId),
      'session.publish_refused',
      { sessionId: id },
    );
    expect(ownFields(line)).toEqual([
      'actorId',
      'errorCode',
      'path',
      'reason',
      'sessionId',
      'teamId',
    ]);
    expect(line).toMatchObject({
      actorId: c.adminId,
      errorCode: 'payout_not_configured',
      traceId: TRACE_ID,
    });
    expect(typeof line.reason).toBe('string');
    expect(typeof line.path).toBe('string');
  });

  it('logs the series lifecycle as session.series.* with ruleId, actorId, version and the skip counts, and a stale series save as session.stale_refused', async () => {
    const c = await scene({ payout: true });
    const base = `/teams/${c.teamId}/session-series`;
    const body: Body = {
      createKey: randomUUID(),
      frequency: 'WEEKLY',
      dayOfWeek: 3,
      startsOn: '2026-10-07',
      monthlyWeek: null,
      recurUntil: null,
      location: LOCATION,
      address: ADDRESS,
      maxPlayers: 24,
      reservedSeats: 0,
      courtCost: '0.00',
      extraExpenses: '0.00',
      pricingStructure: 'FLAT',
      courts: [{ identifier: 'Court 1', startTime: '19:00', endTime: '21:00' }],
    };
    const created = await call('POST', base, c.admin, body);
    expect(created.statusCode, created.body).toBe(201);
    const ruleId = seriesOf(created).id;
    // Four dates (10-07 .. 10-28) exist as published sessions once the run has happened.
    const deps: MaterialiseDeps = {
      db: h.db,
      clock: h.clock,
      allocator,
      jobs: { enqueue: (queue, data, options) => producer.enqueue(queue, data, options) },
      notice: { webBaseUrl: 'https://app.example.test', sendEmail: () => Promise.resolve() },
      log: captureLogs().logger,
      horizonDays: 28,
    };
    await materialiseRule(deps, { ruleId, teamId: c.teamId, trigger: 'rule_created' });

    const updated = await call(
      'PUT',
      `${base}/${ruleId}`,
      c.admin,
      edit(body, 1, { location: 'Another Hall' }),
    );
    expect(updated.statusCode, updated.body).toBe(200);
    const updatedVersion = seriesOf(updated).version;
    const stale = await call('PUT', `${base}/${ruleId}`, c.admin, edit(body, 1));
    expect(stale.statusCode).toBe(409);
    const drafts = await call('POST', `${base}/${ruleId}/publish-drafts`, c.admin, {});
    expect(drafts.statusCode, drafts.body).toBe(202);
    const ended = await call('POST', `${base}/${ruleId}/end`, c.admin, {
      expectedVersion: updatedVersion,
      lastDate: '2026-10-14',
      alsoCancelPublished: true,
    });
    expect(ended.statusCode, ended.body).toBe(200);

    const mine = apiLogs().filter((line) => line.teamId === c.teamId);
    const createdLine = one(mine, 'session.series.created', { ruleId });
    expect(ownFields(createdLine)).toEqual([
      'actorId',
      'frequency',
      'ruleId',
      'ruleVersion',
      'teamId',
    ]);
    expect(createdLine).toMatchObject({ actorId: c.adminId, frequency: 'WEEKLY', ruleVersion: 1 });

    const updatedLine = one(mine, 'session.series.updated', { ruleId });
    expect(ownFields(updatedLine)).toEqual([
      'actorId',
      'promoted',
      'ruleId',
      'ruleVersion',
      'skippedClosed',
      'skippedDeadlinePassed',
      'skippedEdited',
      'skippedFeeLocked',
      'skippedStarted',
      'teamId',
      'unchanged',
      'updated',
    ]);
    expect(updatedLine).toMatchObject({
      actorId: c.adminId,
      ruleVersion: updatedVersion,
      // 10-07's cancellation deadline (48 h before) has already passed at the harness clock.
      updated: 3,
      unchanged: 0,
      promoted: 0,
      skippedEdited: 0,
      skippedStarted: 0,
      skippedClosed: 0,
      skippedDeadlinePassed: 1,
      skippedFeeLocked: 0,
    });

    const staleLine = one(mine, 'session.stale_refused', { ruleId });
    expect(ownFields(staleLine)).toEqual([
      'actorId',
      'currentVersion',
      'expectedVersion',
      'ruleId',
      'teamId',
    ]);
    expect(staleLine).toMatchObject({
      actorId: c.adminId,
      expectedVersion: 1,
      currentVersion: updatedVersion,
    });

    const draftsLine = one(mine, 'session.series.publish_drafts_requested', { ruleId });
    expect(ownFields(draftsLine)).toEqual(['actorId', 'queued', 'ruleId', 'teamId']);
    expect(draftsLine).toMatchObject({ actorId: c.adminId });

    const endedLine = one(mine, 'session.series.ended', { ruleId });
    expect(ownFields(endedLine)).toEqual([
      'actorId',
      'cancelledPublished',
      'keptOffPattern',
      'recurUntil',
      'removedDrafts',
      'ruleId',
      'ruleVersion',
      'teamId',
    ]);
    expect(endedLine).toMatchObject({
      actorId: c.adminId,
      recurUntil: '2026-10-14',
      cancelledPublished: 2,
      removedDrafts: 0,
      keptOffPattern: 0,
    });
    expect(endedLine.ruleVersion).toBeGreaterThan(updatedVersion);

    for (const line of [createdLine, updatedLine, staleLine, draftsLine, endedLine]) {
      expect(line.traceId, String(line.event)).toBe(TRACE_ID);
    }
    // The old names are gone, so the AC's `session.series.*` names are the only series events.
    expect(
      apiLogs().filter((line) => /^series\./.test(String(line.event))),
      'un-namespaced series events',
    ).toEqual([]);
    expectHygiene(mine, [c.adminEmail]);
  });

  it('logs session.lock_retry from a real request that waits on a locked session row, and lock_retry_exhausted when the retries run out', async () => {
    const c = await scene({ payout: true });
    const base = `/teams/${c.teamId}/sessions`;
    const body = sessionBody();
    const id = sessionOf(await call('POST', base, c.admin, body)).id;

    // Another connection holds the session row, so the edit's `FOR UPDATE` times out (2 s) and the whole tx retries.
    const holder = await database.pool.connect();
    let held = true;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM game_sessions WHERE id = $1 FOR UPDATE', [id]);
      const pending = call(
        'PUT',
        `${base}/${id}`,
        c.admin,
        edit(body, 1, { location: 'Lock Hall' }),
      );
      const retry = await waitFor(
        () => only(apiLogs(), 'session.lock_retry', { traceId: TRACE_ID }).at(-1),
        { timeoutMs: 15_000, label: 'a session.lock_retry line' },
      );
      await holder.query('COMMIT');
      held = false;
      expect((await pending).statusCode).toBe(200);
      expect(ownFields(retry)).toEqual(['attempt', 'path', 'sqlState', 'teamId']);
      expect(retry).toMatchObject({
        path: 'edit',
        attempt: 1,
        sqlState: '55P03',
        teamId: c.teamId,
        level: 'warn',
      });
    } finally {
      if (held) await holder.query('ROLLBACK');
      holder.release();
    }

    // Exhaustion: a short policy against a held row, logged through the same logger inside a known trace.
    const blocker = await database.pool.connect();
    const trace = parseTraceparent(`00-${hex(32)}-${hex(16)}-01`);
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM game_sessions WHERE id = $1 FOR UPDATE', [id]);
      await expect(
        runWithTrace(
          trace ??
            (() => {
              throw new Error('bad trace');
            })(),
          () =>
            runSessionTransaction(
              h.db,
              { ...HTTP_POLICY, lockTimeoutMs: 100, attempts: 2, backoffMs: [5] },
              (trx) =>
                trx
                  .selectFrom('game_sessions')
                  .select('id')
                  .where('id', '=', id)
                  .forUpdate()
                  .execute(),
              { path: 'logs_probe', teamId: c.teamId, log: h.logs.logger },
            ),
        ),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    const exhausted = one(apiLogs(), 'session.lock_retry_exhausted', { path: 'logs_probe' });
    expect(ownFields(exhausted)).toEqual(['attempt', 'path', 'sqlState', 'teamId']);
    expect(exhausted).toMatchObject({
      attempt: 2,
      sqlState: '55P03',
      teamId: c.teamId,
      traceId: trace?.traceId,
    });
    expect(only(apiLogs(), 'session.lock_retry', { path: 'logs_probe' })).toHaveLength(1);
  });

  it('never emits a session.notify.* event or an email job for players (P-2)', async () => {
    const all = JSON.stringify(apiLogs());
    expect(all).not.toContain('session.notify');
    const { rows } = await database.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pgboss.job WHERE name = 'send-email'`,
    );
    expect(rows[0]?.n).toBe('0');
  });
});

// ---------------------------------------------------------------------------------------------
// Job events: the production wiring on a real worker, each job queued inside a known trace
// ---------------------------------------------------------------------------------------------

describe('recurrence and auto-enrol events from the jobs carry the job trace (AC-VERIFY-6)', () => {
  let worker: JobRunner;
  const clock = createManualClock(JOB_NOW);
  const workerLogs = captureLogs();
  const jobAllocator = createRecordingAllocator();
  const workerLines = (): Record<string, unknown>[] => workerLogs.lines();

  beforeAll(async () => {
    // Earlier tests left series and pending sessions: retire them so only this block's rules run.
    await database.pool.query(`UPDATE recurring_session_rules SET is_active = false`);
    await database.pool.query(
      `UPDATE game_sessions SET auto_enrol_required = false, auto_enrolled_at = NULL
        WHERE status IN ('DRAFT', 'PUBLISHED')`,
    );
    worker = createJobRunner({
      databaseUrl: database.url,
      logger: workerLogs.logger,
      role: 'worker',
      pollingIntervalSeconds: 0.5,
    });
    await worker.start();
    await registerJobs({
      runner: worker,
      notifier: createInMemoryNotifier(),
      crypto: testCrypto(),
      db: createKysely(database.pool),
      clock,
      sessionAllocator: jobAllocator,
      recurrenceHorizonDays: 28,
      webBaseUrl: 'https://app.example.test',
    });
  });
  afterAll(async () => {
    await worker?.stop();
  });
  beforeEach(() => {
    jobAllocator.reset();
    jobAllocator.enrols = true;
    jobAllocator.outcome = { ok: true, status: 'CONFIRMED' };
  });

  const newTrace = (): { traceId: string; traceparent: string } => {
    const traceId = hex(32);
    return { traceId, traceparent: `00-${traceId}-${hex(16)}-01` };
  };

  async function queueRule(
    teamId: string,
    ruleId: string,
    traceparent: string,
    trigger: 'sweep' | 'manual' = 'manual',
  ): Promise<void> {
    const parsed = parseTraceparent(traceparent);
    if (parsed === undefined) throw new Error('bad traceparent');
    await runWithTrace(parsed, () =>
      enqueueRuleMaterialisation(producer, { ruleId, teamId, trigger }),
    );
  }

  const runCompleted = (ruleId: string) => (): Record<string, unknown> | undefined =>
    only(workerLines(), 'session.recurrence.run_completed', { ruleId })[0];

  async function paidRule(teamId: string, options: RuleOptions = {}): Promise<string> {
    const ruleId = await insertRule(database.pool, teamId, {
      dayOfWeek: 2,
      startsOn: '2026-10-06',
      ...options,
    });
    await database.pool.query(
      `UPDATE recurring_session_rules SET default_custom_player_rate = '17.00' WHERE id = $1`,
      [ruleId],
    );
    return ruleId;
  }

  async function autoEnrollMember(teamId: string): Promise<void> {
    const userId = await insertUser(database.pool, 'MALE');
    const membershipId = await insertTeamMember(database.pool, { teamId, userId });
    await database.pool.query(
      `UPDATE team_members SET is_auto_enroll = true, auto_enroll_assigned_at = '2026-10-01T00:00:00Z'
        WHERE id = $1`,
      [membershipId],
    );
  }

  it('logs instance_created, run_completed and auto_enrol.completed for a published series, all on the queued trace', async () => {
    const c = await createSessionsScene(database.pool, { payoutConfigured: true });
    await autoEnrollMember(c.teamId);
    const ruleId = await paidRule(c.teamId);
    const { traceId, traceparent } = newTrace();

    await queueRule(c.teamId, ruleId, traceparent);
    const run = await waitFor(runCompleted(ruleId), { timeoutMs: 20_000, label: 'the rule run' });

    const mine = workerLines().filter((line) => line.ruleId === ruleId || line.teamId === c.teamId);
    expect(ownFields(run)).toEqual([
      'autoEnrolled',
      'created',
      'draftsRetried',
      'durationMs',
      'failed',
      'published',
      'ruleId',
      'savedAsDraft',
      'teamId',
      'trigger',
      'windowStart',
    ]);
    expect(run).toMatchObject({
      teamId: c.teamId,
      trigger: 'manual',
      windowStart: '2026-10-20',
      created: 5,
      published: 5,
      savedAsDraft: 0,
      draftsRetried: 0,
      autoEnrolled: 5,
      failed: 0,
      traceId,
    });
    expect(typeof run.durationMs).toBe('number');

    const created = only(mine, 'session.recurrence.instance_created');
    expect(created).toHaveLength(5);
    for (const line of created) {
      expect(ownFields(line)).toEqual(['date', 'ruleId', 'sessionId', 'status', 'teamId']);
      expect(line).toMatchObject({ teamId: c.teamId, ruleId, status: 'PUBLISHED', traceId });
    }

    const enrolled = only(mine, 'session.auto_enrol.completed');
    expect(enrolled).toHaveLength(5);
    for (const line of enrolled) {
      expect(ownFields(line)).toEqual([
        'allocator',
        'candidates',
        'confirmed',
        'sessionId',
        'skipped',
        'teamId',
        'waitlisted',
      ]);
      expect(line).toMatchObject({
        teamId: c.teamId,
        allocator: 'recording',
        candidates: 1,
        confirmed: 1,
        waitlisted: 0,
        skipped: {},
        traceId,
      });
    }
    expectHygiene(mine, []);
  });

  it('logs port_noop with the candidate count while the allocator does not enrol, then auto_enrol.completed from the session-auto-enrol job on its own trace', async () => {
    jobAllocator.enrols = false;
    const c = await createSessionsScene(database.pool, { payoutConfigured: true });
    await autoEnrollMember(c.teamId);
    await autoEnrollMember(c.teamId);
    const ruleId = await paidRule(c.teamId);
    const first = newTrace();

    await queueRule(c.teamId, ruleId, first.traceparent);
    await waitFor(runCompleted(ruleId), { timeoutMs: 20_000, label: 'the rule run' });
    const noop = only(workerLines(), 'session.auto_enrol.port_noop', { teamId: c.teamId });
    expect(noop).toHaveLength(5);
    for (const line of noop) {
      expect(ownFields(line)).toEqual(['candidates', 'sessionId', 'teamId']);
      expect(line).toMatchObject({ candidates: 2, traceId: first.traceId });
    }

    // A real allocator arrives; the next job for one pending session enrols it and logs on ITS trace.
    jobAllocator.enrols = true;
    const sessionId = String(noop[0]?.sessionId);
    const second = newTrace();
    const parsed = parseTraceparent(second.traceparent);
    if (parsed === undefined) throw new Error('bad traceparent');
    await runWithTrace(parsed, () =>
      producer.enqueue(
        QUEUE_NAMES.sessionAutoEnrol,
        SessionAutoEnrolPayload.parse({ teamId: c.teamId, sessionId, trigger: 'manual' }),
        { singletonKey: sessionAutoEnrolKey(sessionId) },
      ),
    );
    const done = await waitFor(
      () => only(workerLines(), 'session.auto_enrol.completed', { sessionId })[0],
      { timeoutMs: 20_000, label: 'the session-auto-enrol job' },
    );
    expect(ownFields(done)).toEqual([
      'allocator',
      'candidates',
      'confirmed',
      'sessionId',
      'skipped',
      'teamId',
      'waitlisted',
    ]);
    expect(done).toMatchObject({
      teamId: c.teamId,
      candidates: 2,
      confirmed: 2,
      traceId: second.traceId,
    });
  });

  it('logs publish_refused and a DRAFT instance_created when the team has no payout details', async () => {
    const c = await createSessionsScene(database.pool, { payoutConfigured: false });
    const ruleId = await paidRule(c.teamId);
    const { traceId, traceparent } = newTrace();

    await queueRule(c.teamId, ruleId, traceparent);
    const run = await waitFor(runCompleted(ruleId), { timeoutMs: 20_000, label: 'the rule run' });
    expect(run).toMatchObject({ created: 5, published: 0, savedAsDraft: 5, traceId });

    const refused = only(workerLines(), 'session.recurrence.publish_refused', { ruleId });
    expect(refused).toHaveLength(5);
    for (const line of refused) {
      expect(ownFields(line)).toEqual(['date', 'reason', 'ruleId', 'sessionId', 'teamId']);
      expect(line).toMatchObject({ teamId: c.teamId, traceId });
      expect(typeof line.reason).toBe('string');
    }
    const drafts = only(workerLines(), 'session.recurrence.instance_created', { ruleId });
    expect(drafts.map((line) => line.status)).toEqual(Array(5).fill('DRAFT'));
  });

  it('logs rule_skipped with the reason for an inactive series', async () => {
    const c = await createSessionsScene(database.pool, { payoutConfigured: true });
    const ruleId = await paidRule(c.teamId, { isActive: false });
    const { traceId, traceparent } = newTrace();

    await queueRule(c.teamId, ruleId, traceparent);
    const line = await waitFor(
      () => only(workerLines(), 'session.recurrence.rule_skipped', { ruleId })[0],
      { timeoutMs: 20_000, label: 'the skip line' },
    );
    expect(ownFields(line)).toEqual(['reason', 'ruleId', 'teamId']);
    expect(line).toMatchObject({ teamId: c.teamId, reason: 'inactive', traceId });
  });

  it('logs instance_failed with sqlState and errorCode (never code) and no message when one date fails', async () => {
    const c = await createSessionsScene(database.pool, { payoutConfigured: true });
    const ruleId = await paidRule(c.teamId);
    const name = `it_logs_${hex(12)}`;
    await database.pool.query(`
      CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.recurring_rule_id = '${ruleId}' AND NEW.date = DATE '2026-11-03' THEN
          RAISE EXCEPTION 'injected failure for Gwendolyn Logsworth' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$`);
    await database.pool.query(
      `CREATE TRIGGER ${name} BEFORE INSERT ON game_sessions FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    const { traceId, traceparent } = newTrace();
    try {
      await queueRule(c.teamId, ruleId, traceparent);
      await waitFor(runCompleted(ruleId), { timeoutMs: 20_000, label: 'the rule run' });
    } finally {
      await database.pool.query(`DROP TRIGGER ${name} ON game_sessions`);
      await database.pool.query(`DROP FUNCTION ${name}()`);
    }
    const failed = one(workerLines(), 'session.recurrence.instance_failed', { ruleId });
    expect(ownFields(failed)).toEqual([
      'date',
      'errorCode',
      'ruleId',
      'sqlState',
      'teamId',
      'transient',
    ]);
    expect(failed).toMatchObject({
      teamId: c.teamId,
      date: '2026-11-03',
      sqlState: '23514',
      errorCode: '23514',
      transient: false,
      level: 'error',
      traceId,
    });
    expectHygiene(
      workerLines().filter((line) => line.ruleId === ruleId),
      [],
    );
  });

  it('logs auto_enrol.failed with allocator, sqlState and errorCode when the allocator throws, leaving the run to finish', async () => {
    const c = await createSessionsScene(database.pool, { payoutConfigured: true });
    await autoEnrollMember(c.teamId);
    const ruleId = await paidRule(c.teamId);
    const { traceId, traceparent } = newTrace();
    const real = jobAllocator.autoEnrolInSession.bind(jobAllocator);
    jobAllocator.autoEnrolInSession = () =>
      Promise.reject(
        Object.assign(new Error('allocator exploded for a@b.test'), { code: 'XX000' }),
      );
    try {
      await queueRule(c.teamId, ruleId, traceparent);
      await waitFor(runCompleted(ruleId), { timeoutMs: 20_000, label: 'the rule run' });
    } finally {
      jobAllocator.autoEnrolInSession = real;
    }
    const failed = only(workerLines(), 'session.auto_enrol.failed', { teamId: c.teamId });
    expect(failed).toHaveLength(5);
    for (const line of failed) {
      expect(ownFields(line)).toEqual([
        'allocator',
        'errorCode',
        'sessionId',
        'sqlState',
        'teamId',
      ]);
      expect(line).toMatchObject({
        allocator: 'recording',
        sqlState: 'XX000',
        level: 'warn',
        traceId,
      });
    }
    expect(JSON.stringify(workerLines().filter((line) => line.ruleId === ruleId))).not.toContain(
      'a@b.test',
    );
  });

  it('logs sweep_completed with counts only and the sweep job trace, and a rule job queued by the sweep keeps that trace', async () => {
    const c = await createSessionsScene(database.pool, { payoutConfigured: true });
    const ruleId = await paidRule(c.teamId);
    const before = only(workerLines(), 'session.recurrence.sweep_completed').length;

    await waitFor(
      async () =>
        (await worker.trigger(QUEUE_NAMES.recurrenceMaterialisation)) === null ? undefined : true,
      { timeoutMs: 10_000, label: 'a sweep to queue' },
    );
    const sweep = await waitFor(
      () => only(workerLines(), 'session.recurrence.sweep_completed')[before],
      { timeoutMs: 20_000, label: 'the sweep' },
    );
    expect(ownFields(sweep)).toEqual([
      'durationMs',
      'pendingAutoEnrolEnqueued',
      'rulesEnqueued',
      'rulesScanned',
    ]);
    expect(sweep.rulesScanned).toBeGreaterThanOrEqual(1);
    expect(sweep.traceId).toMatch(/^[0-9a-f]{32}$/);

    // The per-rule job the sweep queued carries the sweep's trace (`_meta.traceparent`).
    const run = await waitFor(runCompleted(ruleId), {
      timeoutMs: 20_000,
      label: 'the swept rule run',
    });
    expect(run).toMatchObject({ trigger: 'sweep', traceId: sweep.traceId });
  });

  it('never emits a session.notify.* event', () => {
    expect(JSON.stringify(workerLines())).not.toContain('session.notify');
  });
});
