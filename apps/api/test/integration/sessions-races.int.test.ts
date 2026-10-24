/**
 * The race matrix of session-scheduling-engine (AC-VERIFY-3, AC-ASYNC-5, AC-INTEGRATION-2; ARCH "Race matrix", binding T-17,
 * T-18, T-19) on a real PostgreSQL 17 with real connections. Nothing sleeps: a holder is parked on the statement that took its
 * locks (`statement-gate.ts`) or is a raw open transaction, the contender is started, `waitForLockWaiters` asks
 * `pg_stat_activity` until Postgres itself reports the contender blocked, and only then is the holder released.
 *
 * Every row R1-R14 runs in BOTH orders (order A: the table's holder opens first; order B: the contender opens first). After each
 * test three global checks run: no `session.lock_retry` / `session.lock_retry_exhausted` was logged and no SQLSTATE 40P01
 * appeared (a retry would hide a deadlock), and the recorded statements of every transaction respect the lock order
 * `teams -> recurring_session_rules -> team_members -> game_sessions` with `teams` never stronger than KEY SHARE in a sessions
 * transaction (T-1, ADR 0016 lock rules).
 *
 * Clock: the harness clock is set to Sunday 2026-10-04 13:00 NZDT (`SERIES_NOW`). A Wednesday 19:00 series therefore has
 * 10-07, 10-14, 10-21 and 10-28 inside the 28-day window; 11-04 is the next date, still missing, which the tests materialise by hand.
 */
import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  parseLocalDate,
  type EndSeriesResponse,
  type SeriesResponse,
  type SessionResponse,
} from '@sgm/shared';
import { createRecurrenceRuleHandler } from '../../src/jobs/recurrence-rule.ts';
import { createSessionAutoEnrolHandler } from '../../src/jobs/session-auto-enrol.ts';
import { QUEUES, QUEUE_NAMES } from '../../src/jobs/registry.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import {
  createJobRunner,
  type JobContext,
  type JobHandler,
  type JobRunner,
} from '../../src/lib/jobs/jobs.ts';
import type {
  AutoEnrolEntryOutcome,
  SessionAllocatorPort,
} from '../../src/modules/sessions/allocator-port.ts';
import { runSessionAutoEnrol } from '../../src/modules/sessions/auto-enrol.ts';
import { lockSession } from '../../src/modules/sessions/locks.ts';
import {
  listRetryableDrafts,
  materialiseDate,
  retryDraft,
  type InstanceDeps,
} from '../../src/modules/sessions/materialise-instance.ts';
import { claimPayoutNotice } from '../../src/modules/sessions/materialise-notice.ts';
import { materialiseRule, type MaterialiseDeps } from '../../src/modules/sessions/materialise.ts';
import { selectAutoEnrollees } from '../../src/modules/skill-levels/auto-enrol.ts';
import { bearer, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import { createBankingScene } from '../helpers/banking-scene.ts';
import {
  insertAuthSession,
  insertRegistration,
  insertRule,
  insertSession,
  insertTeamMember,
  insertUser,
  payoutBlockFor,
  type RuleOptions,
} from '../helpers/factories.ts';
import { waitForLockWaiters } from '../helpers/lock-waiters.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import { createRecordingAllocator, createSessionsScene } from '../helpers/sessions-scene.ts';
import {
  createGatedDatabase,
  lockOrderViolations,
  transactionsOf,
  type GatedDatabase,
  type StatementHold,
} from '../helpers/statement-gate.ts';
import { createTestDatabase, pgError, type TestDatabase } from '../helpers/test-db.ts';
import { waitFor } from '../helpers/wait-for.ts';

// ---------------------------------------------------------------------------------------------
// Statement patterns (Kysely compiles lower case, one line)
// ---------------------------------------------------------------------------------------------

/** `lockRule`: the rule row `FOR NO KEY UPDATE`. */
const RULE_LOCK = /from "recurring_session_rules".* for no key update$/;
/** `lockSession` and `lockRuleInstances`: a session row `FOR UPDATE`. */
const SESSION_LOCK = /from "game_sessions".* for update$/;
/** The publish gate's read: `is_payout_configured` under `teams FOR KEY SHARE`. */
const GATE = /select "is_payout_configured", "payout_blocked_at" from "teams".* for key share$/;
/** `assertSessionAdmin`: the acting admin's membership `FOR SHARE`. */
const ACTOR_SHARE = /from "team_members".* for share$/;
/** The banking removal takes `teams FOR UPDATE` first. */
const TEAM_UPDATE = /from "teams" where "id" = \$1 for update$/;
/** The skill-levels save locks the member row `FOR NO KEY UPDATE`. */
const MEMBER_NKU = /from "team_members".* for no key update$/;

const CLEAR_BANKING = `UPDATE teams SET bank_account_name = NULL, bank_account_number = NULL, bank_account_last4 = NULL WHERE id = $1`;

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

let database: TestDatabase;
let gate: GatedDatabase;
let h: AuthTestApp;
let producer: JobRunner;
let worker: JobRunner;
const logs = captureLogs();
const allocator = createRecordingAllocator();
const emails: { to: string; idempotencyKey: string }[] = [];
let logMark = 0;
let statementMark = 0;

/**
 * Sunday 2026-10-04, 13:00 NZDT. A Wednesday series then has 10-07 (cancellation deadline still ahead, so a series edit
 * propagates to it), 10-14, 10-21 and 10-28 in the 28-day window; 11-04 is the next date, still missing.
 */
const SERIES_NOW = new Date('2026-10-04T00:00:00Z');

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 30 });
  gate = createGatedDatabase(database.pool);
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
  h = await buildAuthTestApp(database.pool, {
    db: gate.db,
    logger: logs.logger,
    sessionAllocator: allocator,
    jobs: { enqueue: (queue, data, options) => producer.enqueue(queue, data, options) },
  });
});
afterAll(async () => {
  await h.close();
  await producer.stop();
  await worker.stop();
  await database.close();
});
beforeEach(() => {
  h.clock.set(SERIES_NOW);
  allocator.reset();
  allocator.promoted = [];
  emails.length = 0;
  logMark = logs.lines().length;
  statementMark = gate.statements.length;
});
afterEach(() => {
  const lines = logs.lines().slice(logMark);
  // A retried transaction would hide a deadlock or a lock timeout, so neither the retry nor the SQLSTATE may appear.
  expect(
    lines.filter(
      (line) =>
        line.event === 'session.lock_retry' || line.event === 'session.lock_retry_exhausted',
    ),
  ).toEqual([]);
  expect(lines.filter((line) => line.sqlState === '40P01')).toEqual([]);
  expect(lockOrderViolations(gate.statements.slice(statementMark))).toEqual([]);
});

interface Scene {
  readonly teamId: string;
  readonly adminId: string;
  readonly memberId: string;
  readonly admin: string;
}

async function scene(options: { payout?: boolean } = {}): Promise<Scene> {
  const base = await createSessionsScene(database.pool, {
    payoutConfigured: options.payout ?? true,
  });
  const { token } = await insertAuthSession(database.pool, base.adminId, {
    createdAt: h.clock.now(),
    idleDays: 90,
    absoluteDays: 180,
  });
  return { ...base, admin: token };
}

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  token: string,
  payload?: object,
): Promise<LightMyRequestResponse> =>
  h.app.inject({
    method,
    url,
    headers: bearer(token),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

interface ApiError {
  error: { code: string; message: string; raisedFields?: string[] };
}
const errorOf = (res: LightMyRequestResponse): ApiError['error'] => res.json<ApiError>().error;
const seriesOf = (res: LightMyRequestResponse): SeriesResponse =>
  res.json<{ series: SeriesResponse }>().series;
const sessionOf = (res: LightMyRequestResponse): SessionResponse =>
  res.json<{ session: SessionResponse }>().session;

type Body = Record<string, unknown>;

const WED_COURT = { identifier: 'Court 1', startTime: '19:00', endTime: '21:00' };
const seriesBase = (c: Scene) => `/teams/${c.teamId}/session-series`;
const sessionsBase = (c: Scene) => `/teams/${c.teamId}/sessions`;

/** A free Wednesday series (first date 2026-10-07, 24 players, one court 19:00-21:00). */
function seriesBody(over: Body = {}): Body {
  return {
    createKey: randomUUID(),
    frequency: 'WEEKLY',
    dayOfWeek: 3,
    startsOn: '2026-10-07',
    monthlyWeek: null,
    recurUntil: null,
    location: 'Rosedale Badminton Centre',
    address: '12B John Glenn Avenue, Rosedale, Auckland 0632',
    maxPlayers: 24,
    reservedSeats: 0,
    courtCost: '0.00',
    extraExpenses: '0.00',
    pricingStructure: 'FLAT',
    courts: [WED_COURT],
    ...over,
  };
}
/** $240.00 over 24 players: a $10.00 rate, so the sessions are paid. */
const PAID_SERIES = { courtCost: '240.00' };

/** A one-off session body (free, 12 players, one court). */
function oneOffBody(over: Body = {}): Body {
  return {
    createKey: randomUUID(),
    date: '2026-11-04',
    location: 'Rosedale Badminton Centre',
    address: '12B John Glenn Avenue, Rosedale, Auckland 0632',
    maxPlayers: 12,
    reservedSeats: 0,
    courtCost: '0.00',
    extraExpenses: '0.00',
    pricingStructure: 'FLAT',
    courts: [WED_COURT],
    ...over,
  };
}

/** The PUT body that re-sends `body` (plus `over`) with the version the editor saw. */
function editBody(body: Body, expectedVersion: number, over: Body = {}): Body {
  const rest: Body = { ...body };
  delete rest.createKey;
  return { ...rest, expectedVersion, ...over };
}

async function createOneOff(
  c: Scene,
  over: Body = {},
): Promise<{ id: string; body: Body; version: number }> {
  const body = oneOffBody(over);
  const res = await call('POST', sessionsBase(c), c.admin, body);
  expect(res.statusCode, res.body).toBe(201);
  return { id: sessionOf(res).id, body, version: sessionOf(res).version };
}

async function publishedOneOff(
  c: Scene,
  over: Body = {},
): Promise<{ id: string; body: Body; version: number }> {
  const created = await createOneOff(c, over);
  const res = await call('POST', `${sessionsBase(c)}/${created.id}/publish`, c.admin, {
    expectedVersion: created.version,
  });
  expect(res.statusCode, res.body).toBe(200);
  return { ...created, version: sessionOf(res).version };
}

interface DbRule {
  version: number;
  is_active: boolean;
  recur_until: string | null;
  materialised_version: number | null;
  default_location: string;
}

async function rule(id: string): Promise<DbRule> {
  const { rows } = await database.pool.query<DbRule>(
    `SELECT version, is_active, recur_until::text AS recur_until, materialised_version, default_location
       FROM recurring_session_rules WHERE id = $1`,
    [id],
  );
  const found = rows[0];
  if (found === undefined) throw new Error('no such rule');
  return found;
}

interface DbSession {
  id: string;
  date: string;
  status: string;
  version: number;
  location: string;
  max_players: number;
  fee_flat: string | null;
  is_instance_overridden: boolean;
  auto_enrolled_at: Date | null;
}

async function sessionsOf(ruleId: string): Promise<DbSession[]> {
  const { rows } = await database.pool.query<DbSession>(
    `SELECT id, date::text AS date, status, version, location, max_players, fee_flat, is_instance_overridden,
            auto_enrolled_at
       FROM game_sessions WHERE recurring_rule_id = $1 ORDER BY date, id`,
    [ruleId],
  );
  return rows;
}

async function sessionRow(id: string): Promise<DbSession> {
  const { rows } = await database.pool.query<DbSession>(
    `SELECT id, date::text AS date, status, version, location, max_players, fee_flat, is_instance_overridden,
            auto_enrolled_at
       FROM game_sessions WHERE id = $1`,
    [id],
  );
  const found = rows[0];
  if (found === undefined) throw new Error('no such session');
  return found;
}

async function registrationCount(sessionId: string): Promise<number> {
  const { rows } = await database.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM registrations WHERE session_id = $1`,
    [sessionId],
  );
  return rows[0]?.n ?? 0;
}

async function configureBanking(teamId: string): Promise<void> {
  const block = payoutBlockFor(teamId);
  await database.pool.query(
    `UPDATE teams SET bank_account_name = $2, bank_account_number = $3, bank_account_last4 = $4 WHERE id = $1`,
    [teamId, block.name, block.number, block.last4],
  );
}

function instanceDeps(): InstanceDeps {
  return {
    db: gate.db,
    clock: h.clock,
    jobs: { enqueue: (queue, data, options) => producer.enqueue(queue, data, options) },
    notice: {
      webBaseUrl: 'https://app.example.test',
      sendEmail: (message) => {
        emails.push({ to: message.to, idempotencyKey: message.idempotencyKey });
        return Promise.resolve();
      },
    },
    log: logs.logger,
  };
}

function materialiseDeps(over: Partial<MaterialiseDeps> = {}): MaterialiseDeps {
  const base = instanceDeps();
  return {
    db: gate.db,
    clock: h.clock,
    allocator,
    jobs: base.jobs,
    notice: base.notice,
    log: logs.logger,
    horizonDays: 28,
    ...over,
  };
}

/** Creates a series through the API and runs the materialiser once, as the queued job would. */
async function seriesWithInstances(
  c: Scene,
  over: Body = {},
): Promise<{ ruleId: string; body: Body; version: number }> {
  const body = seriesBody(over);
  const res = await call('POST', seriesBase(c), c.admin, body);
  expect(res.statusCode, res.body).toBe(201);
  const ruleId = seriesOf(res).id;
  await materialiseRule(materialiseDeps(), { ruleId, teamId: c.teamId, trigger: 'rule_created' });
  return { ruleId, body, version: (await rule(ruleId)).version };
}

/** The window start (Monday of the NZ week of 2026-10-04) the notice claim is keyed on. */
const WINDOW_START = parseLocalDate('2026-09-28');
const NEXT_DATE = parseLocalDate('2026-11-04');

/** An approved member with Auto Enroll on (assigned at `assignedAt`, optionally ending `until`). */
async function autoEnrollMember(
  teamId: string,
  assignedAt: string,
  until: string | null,
  enabled = true,
): Promise<{ userId: string; membershipId: string }> {
  const userId = await insertUser(database.pool, 'MALE');
  const membershipId = await insertTeamMember(database.pool, { teamId, userId });
  if (enabled) {
    await database.pool.query(
      `UPDATE team_members SET is_auto_enroll = true, auto_enroll_assigned_at = $2, auto_enroll_until = $3 WHERE id = $1`,
      [membershipId, assignedAt, until],
    );
  }
  return { userId, membershipId };
}

// ---------------------------------------------------------------------------------------------
// Race framework: a holder keeps its locks until released; a contender must be seen blocked
// ---------------------------------------------------------------------------------------------

interface Running<T> {
  /** Resolves once the actor's locks are held (immediately for a contender). */
  readonly locked: Promise<void>;
  release(): void;
  readonly done: Promise<T>;
}
interface Actor<T> {
  readonly label: string;
  start(hold: boolean): Running<T>;
}

/** An actor whose real code runs through the gated database, parked after the first statement that matches `pattern`. */
function gated<T>(label: string, pattern: RegExp, run: () => Promise<T>): Actor<T> {
  return {
    label,
    start(hold) {
      if (!hold) return { locked: Promise.resolve(), release: () => undefined, done: run() };
      const parked: StatementHold = gate.arm(pattern);
      const done = run();
      const locked = Promise.race([
        parked.reached,
        done.then(() => {
          throw new Error(`${label} finished without reaching its hold point (${String(pattern)})`);
        }),
      ]);
      return { locked, release: parked.release, done };
    },
  };
}

/** An actor that is a raw open transaction on its own connection: `work` takes its locks, then it holds until released. */
function raw<T>(label: string, work: (client: pg.PoolClient) => Promise<T>): Actor<T> {
  return {
    label,
    start(hold) {
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markLocked: () => void = () => undefined;
      const lockedOnce = new Promise<void>((resolve) => {
        markLocked = resolve;
      });
      const done = (async (): Promise<T> => {
        const client = await database.pool.connect();
        try {
          await client.query('BEGIN');
          const value = await work(client);
          markLocked();
          if (hold) await released;
          await client.query('COMMIT');
          return value;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      })();
      const locked = hold
        ? Promise.race([lockedOnce, done.then(() => undefined)])
        : Promise.resolve();
      return { locked, release, done };
    },
  };
}

/**
 * Opens `first` and keeps its locks, starts `second`, waits until Postgres reports a backend blocked on a lock, releases `first`
 * and returns both outcomes. A contender that never blocks fails the test: the matrix row would not be a race.
 */
async function race<A, B>(
  first: Actor<A>,
  second: Actor<B>,
): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  const a = first.start(true);
  let b: Running<B> | undefined;
  try {
    await a.locked;
    b = second.start(false);
    await Promise.race([
      waitForLockWaiters(database.pool, 1, `${second.label} blocked behind ${first.label}`),
      b.done.then(() => {
        throw new Error(`${second.label} finished instead of waiting for ${first.label}`);
      }),
    ]);
  } finally {
    a.release();
  }
  const [ra, rb] = await Promise.allSettled([
    a.done,
    b === undefined ? Promise.reject(new Error('no contender')) : b.done,
  ]);
  return [ra, rb];
}

function fulfilled<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') {
    throw result.reason instanceof Error ? result.reason : new Error(String(result.reason));
  }
  return result.value;
}

function rejectedWith(result: PromiseSettledResult<unknown>): {
  code?: string;
  constraint?: string;
} {
  if (result.status === 'fulfilled') throw new Error('expected a rejection');
  return result.reason as { code?: string; constraint?: string };
}

// ---------------------------------------------------------------------------------------------
// Actors shared by several rows
// ---------------------------------------------------------------------------------------------

/** A registration stand-in that follows the session-lock protocol: `game_sessions FOR UPDATE`, then the registration insert. */
function registrationStandIn(
  c: Scene,
  sessionId: string,
  userId: string,
  label = 'registration stand-in',
): Actor<{ maxPlayers: number; feeFlat: string | null }> {
  return raw(label, async (client) => {
    const { rows } = await client.query<{ max_players: number; fee_flat: string | null }>(
      `SELECT max_players, fee_flat FROM game_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId],
    );
    await insertRegistration(client, { sessionId, teamId: c.teamId, userId });
    return { maxPlayers: rows[0]?.max_players ?? -1, feeFlat: rows[0]?.fee_flat ?? null };
  });
}

/** A member registered by the stand-in: an approved member other than the scene's default one. */
async function extraMember(c: Scene): Promise<string> {
  const userId = await insertUser(database.pool, 'FEMALE');
  await insertTeamMember(database.pool, { teamId: c.teamId, userId });
  return userId;
}

/**
 * The allocator double of R10/R11/T-19: like registration's real allocator it gates every member under `team_members FOR SHARE`
 * (re-checking the opt-out), then takes the session `FOR UPDATE`, and can park itself holding both. It records every call.
 */
function lockingAllocator(): SessionAllocatorPort & {
  readonly calls: { sessionId: string; userIds: string[] }[];
  arm(): StatementHold;
} {
  const calls: { sessionId: string; userIds: string[] }[] = [];
  let parked: { readonly reached: () => void; readonly released: Promise<void> } | undefined;
  return {
    name: 'locking',
    enrols: true,
    calls,
    arm() {
      let reached!: () => void;
      let release!: () => void;
      const reachedPromise = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      parked = { reached, released };
      return { reached: reachedPromise, release };
    },
    promoteWaitlist: () => Promise.resolve([]),
    async autoEnrolInSession(ctx, input) {
      calls.push({
        sessionId: input.sessionId,
        userIds: input.entries.map((entry) => entry.userId),
      });
      const outcomes = new Map<string, AutoEnrolEntryOutcome>();
      for (const entry of input.entries) {
        const member = await ctx.trx
          .selectFrom('team_members')
          .select(['is_auto_enroll'])
          .where('id', '=', entry.membershipId ?? '')
          .forShare()
          .executeTakeFirst();
        outcomes.set(
          entry.userId,
          member?.is_auto_enroll === true
            ? { ok: true, status: 'CONFIRMED' }
            : { ok: false, reason: 'auto_enroll_changed' },
        );
      }
      const session = await lockSession(ctx.trx, {
        sessionId: input.sessionId,
        teamId: input.teamId,
      });
      if (session?.status !== 'PUBLISHED') {
        for (const entry of input.entries) {
          outcomes.set(entry.userId, { ok: false, reason: 'session_not_open' });
        }
      }
      if (parked !== undefined) {
        const waiting = parked;
        parked = undefined;
        waiting.reached();
        await waiting.released;
      }
      return input.entries.map((entry) => ({
        userId: entry.userId,
        outcome: outcomes.get(entry.userId) ?? { ok: false, reason: 'not_found' },
      }));
    },
  };
}

/** `runSessionAutoEnrol` as an actor; when it holds, it is parked inside the allocator after its member and session locks. */
function followUp(
  label: string,
  sessionId: string,
  teamId: string,
  double: ReturnType<typeof lockingAllocator>,
): Actor<Awaited<ReturnType<typeof runSessionAutoEnrol>>> {
  const run = () =>
    runSessionAutoEnrol(
      { db: gate.db, clock: h.clock, allocator: double, log: logs.logger },
      { teamId, sessionId },
    );
  return {
    label,
    start(hold) {
      if (!hold) return { locked: Promise.resolve(), release: () => undefined, done: run() };
      const parked = double.arm();
      const done = run();
      const locked = Promise.race([
        parked.reached,
        done.then(() => {
          throw new Error(`${label} finished without reaching the allocator`);
        }),
      ]);
      return { locked, release: parked.release, done };
    },
  };
}

/** A published one-off session that owes its Auto Enroll members one follow-up run. */
async function pendingAutoEnrolSession(c: Scene): Promise<{
  id: string;
  body: Body;
  version: number;
  member: { userId: string; membershipId: string };
}> {
  const created = await publishedOneOff(c);
  await database.pool.query(
    `UPDATE game_sessions SET auto_enrol_required = true, auto_enrolled_at = NULL WHERE id = $1`,
    [created.id],
  );
  const member = await autoEnrollMember(c.teamId, '2026-10-01T00:00:00Z', null);
  // The raw update may bump the version: hand back the one the editor would now see.
  return { ...created, version: (await sessionRow(created.id)).version, member };
}

// ---------------------------------------------------------------------------------------------
// R1 - R3: the materialiser against series edits, instance edits and itself
// ---------------------------------------------------------------------------------------------

describe('R1: materialiser instance transaction vs series edit on the same rule', () => {
  it('order A: the edit waits on the rule, then propagates to the instance the materialiser created', async () => {
    const c = await scene();
    const { ruleId, body, version } = await seriesWithInstances(c);
    const materialiser = gated('materialiser', RULE_LOCK, () =>
      materialiseDate(instanceDeps(), { ruleId, teamId: c.teamId }, NEXT_DATE, WINDOW_START),
    );
    const edit = {
      label: 'series edit',
      start: () => {
        const done = call(
          'PUT',
          `${seriesBase(c)}/${ruleId}`,
          c.admin,
          editBody(body, version, { location: 'Edited Centre' }),
        );
        return { locked: Promise.resolve(), release: () => undefined, done };
      },
    } satisfies Actor<LightMyRequestResponse>;

    const [made, edited] = await race(materialiser, edit);

    expect(fulfilled(made)).toMatchObject({ kind: 'published' });
    const res = fulfilled(edited);
    expect(res.statusCode, res.body).toBe(200);
    // Four dates from the first run plus the one the materialiser just committed: all five follow the edit.
    expect(res.json<{ outcome: { updated: number } }>().outcome.updated).toBe(5);
    const rows = await sessionsOf(ruleId);
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.location === 'Edited Centre')).toBe(true);
  });

  it('order B: the materialiser waits on the rule, re-reads it and creates the date with the new defaults', async () => {
    const c = await scene();
    const { ruleId, body, version } = await seriesWithInstances(c);
    const edit = gated('series edit', RULE_LOCK, () =>
      call(
        'PUT',
        `${seriesBase(c)}/${ruleId}`,
        c.admin,
        editBody(body, version, { location: 'Edited Centre' }),
      ),
    );
    const materialiser: Actor<Awaited<ReturnType<typeof materialiseDate>>> = {
      label: 'materialiser',
      start: () => ({
        locked: Promise.resolve(),
        release: () => undefined,
        done: materialiseDate(
          instanceDeps(),
          { ruleId, teamId: c.teamId },
          NEXT_DATE,
          WINDOW_START,
        ),
      }),
    };

    const [edited, made] = await race(edit, materialiser);

    expect(fulfilled(edited).statusCode).toBe(200);
    expect(fulfilled(made)).toMatchObject({ kind: 'published' });
    const created = (await sessionsOf(ruleId)).find((row) => row.date === NEXT_DATE);
    expect(created?.location).toBe('Edited Centre');
  });
});

describe('R2: materialiser draft retry vs instance edit of that draft', () => {
  /** A paid series whose team had no banking (drafts) and has set it up since. */
  async function draftScene() {
    const c = await scene({ payout: false });
    const { ruleId } = await seriesWithInstances(c, PAID_SERIES);
    await configureBanking(c.teamId);
    const draft = (await sessionsOf(ruleId))[0];
    if (draft === undefined || draft.status !== 'DRAFT') throw new Error('expected a draft');
    const seen = (
      await listRetryableDrafts(
        gate.db,
        { ruleId, teamId: c.teamId },
        { now: h.clock.now(), windowEnd: parseLocalDate('2026-12-31') },
      )
    ).find((row) => row.id === draft.id);
    if (seen === undefined) throw new Error('the draft should be retryable');
    const edit = () =>
      call('PUT', `${sessionsBase(c)}/${draft.id}`, c.admin, {
        date: draft.date,
        location: 'Edited Hall',
        address: '12B John Glenn Avenue, Rosedale, Auckland 0632',
        maxPlayers: 24,
        reservedSeats: 0,
        courtCost: '240.00',
        extraExpenses: '0.00',
        pricingStructure: 'FLAT',
        courts: [WED_COURT],
        expectedVersion: draft.version,
      });
    const retry = () =>
      retryDraft(instanceDeps(), { ruleId, teamId: c.teamId }, seen, WINDOW_START);
    return { c, ruleId, draft, edit, retry };
  }

  it('order A: the edit waits for the retry, then answers 409 session_stale (the publish bumped the version)', async () => {
    const { draft, edit, retry } = await draftScene();
    const retrying = gated('draft retry', SESSION_LOCK, retry);
    const editing: Actor<LightMyRequestResponse> = {
      label: 'instance edit',
      start: () => ({ locked: Promise.resolve(), release: () => undefined, done: edit() }),
    };

    const [retried, edited] = await race(retrying, editing);

    expect(fulfilled(retried)).toEqual({ kind: 'published' });
    const res = fulfilled(edited);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('session_stale');
    const row = await sessionRow(draft.id);
    expect(row).toMatchObject({ status: 'PUBLISHED', is_instance_overridden: false });
  });

  it('order B: the retry waits for the edit, sees the draft is now edited and leaves it alone', async () => {
    const { draft, edit, retry } = await draftScene();
    const editing = gated('instance edit', SESSION_LOCK, edit);
    const retrying: Actor<Awaited<ReturnType<typeof retry>>> = {
      label: 'draft retry',
      start: () => ({ locked: Promise.resolve(), release: () => undefined, done: retry() }),
    };

    const [edited, retried] = await race(editing, retrying);

    expect(fulfilled(edited).statusCode).toBe(200);
    expect(fulfilled(retried)).toEqual({ kind: 'skipped', reason: 'changed' });
    expect(await sessionRow(draft.id)).toMatchObject({
      status: 'DRAFT',
      is_instance_overridden: true,
      location: 'Edited Hall',
    });
  });
});

describe('R3: two materialiser runs on one (rule, date)', () => {
  /** A series whose only missing date, once the clock has moved a week on, is 2026-11-04. */
  async function nextDateScene() {
    const c = await scene();
    const { ruleId } = await seriesWithInstances(c);
    h.clock.set(new Date(SERIES_NOW.getTime() + 7 * 24 * 3_600_000));
    return { c, ruleId };
  }
  const direct = (c: Scene, ruleId: string) => () =>
    materialiseDate(instanceDeps(), { ruleId, teamId: c.teamId }, NEXT_DATE, WINDOW_START);
  const wholeRun = (c: Scene, ruleId: string) => () =>
    materialiseRule(materialiseDeps(), { ruleId, teamId: c.teamId, trigger: 'sweep' });

  it('order A: the run holding the rule inserts, the whole-rule run waits, then finds the date taken and creates nothing', async () => {
    const { c, ruleId } = await nextDateScene();
    const holder = gated('instance run', RULE_LOCK, direct(c, ruleId));
    const contender: Actor<Awaited<ReturnType<typeof materialiseRule>>> = {
      label: 'rule run',
      start: () => ({
        locked: Promise.resolve(),
        release: () => undefined,
        done: wholeRun(c, ruleId)(),
      }),
    };

    const [inserted, repeated] = await race(holder, contender);

    expect(fulfilled(inserted)).toMatchObject({ kind: 'published' });
    expect(fulfilled(repeated)).toMatchObject({ created: 0, failed: 0 });
    expect((await sessionsOf(ruleId)).filter((row) => row.date === NEXT_DATE)).toHaveLength(1);
  });

  it('order B: the whole-rule run holding the rule inserts, the instance run waits and skips as already existing', async () => {
    const { c, ruleId } = await nextDateScene();
    const holder = gated('rule run', RULE_LOCK, wholeRun(c, ruleId));
    const contender: Actor<Awaited<ReturnType<typeof materialiseDate>>> = {
      label: 'instance run',
      start: () => ({
        locked: Promise.resolve(),
        release: () => undefined,
        done: direct(c, ruleId)(),
      }),
    };

    const [inserted, repeated] = await race(holder, contender);

    expect(fulfilled(inserted)).toMatchObject({ created: 1, published: 1, failed: 0 });
    expect(fulfilled(repeated)).toEqual({ kind: 'skipped', reason: 'exists' });
    expect((await sessionsOf(ruleId)).filter((row) => row.date === NEXT_DATE)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// R4 - R5: the publish gate against banking removal
// ---------------------------------------------------------------------------------------------

describe('R4: manual publish (gate KEY SHARE held) vs banking removal through the API', () => {
  async function paidDraftScene() {
    const c = await scene({ payout: true });
    const draft = await createOneOff(c, { courtCost: '120.00' });
    const banking = createBankingScene(h, database);
    const person = {
      id: c.adminId,
      token: c.admin,
      fullName: 'Admin',
      email: 'admin@example.test',
    };
    const publish = () =>
      call('POST', `${sessionsBase(c)}/${draft.id}/publish`, c.admin, {
        expectedVersion: draft.version,
      });
    const removal = () => banking.deleteBanking(c.teamId, person);
    return { draft, publish, removal };
  }

  it('order A: the publish commits first, the removal waits and is then refused 409 banking_in_use', async () => {
    const { draft, publish, removal } = await paidDraftScene();
    const publishing = gated('publish', GATE, publish);
    const removing: Actor<LightMyRequestResponse> = {
      label: 'banking removal',
      start: () => ({ locked: Promise.resolve(), release: () => undefined, done: removal() }),
    };

    const [published, removed] = await race(publishing, removing);

    expect(fulfilled(published).statusCode).toBe(200);
    const res = fulfilled(removed);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('banking_in_use');
    expect((await sessionRow(draft.id)).status).toBe('PUBLISHED');
  });

  it('order B: the removal commits first, the publish waits at the gate and is refused 409 payout_not_configured, draft unchanged', async () => {
    const { draft, publish, removal } = await paidDraftScene();
    const removing = gated('banking removal', TEAM_UPDATE, removal);
    const publishing: Actor<LightMyRequestResponse> = {
      label: 'publish',
      start: () => ({ locked: Promise.resolve(), release: () => undefined, done: publish() }),
    };

    const [removed, published] = await race(removing, publishing);

    expect(fulfilled(removed).statusCode).toBe(200);
    const res = fulfilled(published);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('payout_not_configured');
    expect((await sessionRow(draft.id)).status).toBe('DRAFT');
  });
});

describe('R5: materialiser publish (gate held) vs raw-SQL banking removal', () => {
  async function paidRuleOf(teamId: string): Promise<string> {
    const options: RuleOptions = { dayOfWeek: 3, startsOn: '2026-10-07' };
    const ruleId = await insertRule(database.pool, teamId, options);
    await database.pool.query(
      `UPDATE recurring_session_rules SET default_custom_player_rate = '17.00' WHERE id = $1`,
      [ruleId],
    );
    return ruleId;
  }
  const removal = (teamId: string) =>
    raw('raw banking removal', async (client) => {
      await client.query(CLEAR_BANKING, [teamId]);
    });

  it('order A: the removal waits for the publisher, then fails 23514 teams_banking_in_use', async () => {
    const c = await scene({ payout: true });
    const ruleId = await paidRuleOf(c.teamId);
    const publishing = gated('materialiser publish', GATE, () =>
      materialiseDate(
        instanceDeps(),
        { ruleId, teamId: c.teamId },
        parseLocalDate('2026-10-14'),
        WINDOW_START,
      ),
    );
    // The removal is the contender, so it must not hold: a raw actor started with hold=false commits by itself.
    const [published, removed] = await race(publishing, removal(c.teamId));

    expect(fulfilled(published)).toMatchObject({ kind: 'published' });
    expect(rejectedWith(removed)).toMatchObject({
      code: '23514',
      constraint: 'teams_banking_in_use',
    });
    expect((await sessionsOf(ruleId))[0]?.status).toBe('PUBLISHED');
  });

  it('order B: the materialiser waits for the removal, then saves a DRAFT and claims the notice, with no trigger error', async () => {
    const c = await scene({ payout: true });
    const ruleId = await paidRuleOf(c.teamId);
    const materialiser: Actor<Awaited<ReturnType<typeof materialiseDate>>> = {
      label: 'materialiser publish',
      start: () => ({
        locked: Promise.resolve(),
        release: () => undefined,
        done: materialiseDate(
          instanceDeps(),
          { ruleId, teamId: c.teamId },
          parseLocalDate('2026-10-14'),
          WINDOW_START,
        ),
      }),
    };

    const [removed, made] = await race(removal(c.teamId), materialiser);

    expect(removed.status).toBe('fulfilled');
    expect(fulfilled(made)).toMatchObject({ kind: 'draft', reason: 'not_configured' });
    expect(emails).toHaveLength(1);
    expect((await sessionsOf(ruleId))[0]?.status).toBe('DRAFT');
  });
});

// ---------------------------------------------------------------------------------------------
// R6 - R9: capacity and series edits against registrations and each other
// ---------------------------------------------------------------------------------------------

describe('R6: registration stand-in (session FOR UPDATE) vs capacity edit', () => {
  it('order A: the edit waits for the registration, then commits and calls promoteWaitlist exactly once', async () => {
    const c = await scene();
    const session = await publishedOneOff(c);
    const userId = await extraMember(c);
    const edit: Actor<LightMyRequestResponse> = {
      label: 'capacity edit',
      start: () => ({
        locked: Promise.resolve(),
        release: () => undefined,
        done: call(
          'PUT',
          `${sessionsBase(c)}/${session.id}`,
          c.admin,
          editBody(session.body, session.version, { maxPlayers: 14 }),
        ),
      }),
    };

    const [registered, edited] = await race(registrationStandIn(c, session.id, userId), edit);

    expect(fulfilled(registered)).toMatchObject({ maxPlayers: 12 });
    const res = fulfilled(edited);
    expect(res.statusCode, res.body).toBe(200);
    expect(allocator.promoteCalls).toHaveLength(1);
    expect(allocator.promoteCalls[0]).toMatchObject({ sessionId: session.id, inTransaction: true });
    expect(await registrationCount(session.id)).toBe(1);
  });

  it('order B: the registration waits for the edit and reads the raised capacity', async () => {
    const c = await scene();
    const session = await publishedOneOff(c);
    const userId = await extraMember(c);
    const editing = gated('capacity edit', SESSION_LOCK, () =>
      call(
        'PUT',
        `${sessionsBase(c)}/${session.id}`,
        c.admin,
        editBody(session.body, session.version, { maxPlayers: 14 }),
      ),
    );

    const [edited, registered] = await race(editing, registrationStandIn(c, session.id, userId));

    expect(fulfilled(edited).statusCode).toBe(200);
    expect(fulfilled(registered)).toMatchObject({ maxPlayers: 14 });
    expect(allocator.promoteCalls).toHaveLength(1);
    expect(await registrationCount(session.id)).toBe(1);
  });
});

describe('R7: series edit (rule and instance locks) vs registration stand-in on one instance', () => {
  it('order A: the stand-in waits for the edit, then registers; both commit', async () => {
    const c = await scene();
    const { ruleId, body, version } = await seriesWithInstances(c);
    const target = (await sessionsOf(ruleId))[0];
    if (target === undefined) throw new Error('no instance');
    const userId = await extraMember(c);
    const editing = gated('series edit', SESSION_LOCK, () =>
      call(
        'PUT',
        `${seriesBase(c)}/${ruleId}`,
        c.admin,
        editBody(body, version, { location: 'Edited Centre' }),
      ),
    );

    const [edited, registered] = await race(editing, registrationStandIn(c, target.id, userId));

    const res = fulfilled(edited);
    expect(res.statusCode, res.body).toBe(200);
    expect(fulfilled(registered)).toMatchObject({ maxPlayers: 24 });
    expect(await registrationCount(target.id)).toBe(1);
    expect((await sessionRow(target.id)).location).toBe('Edited Centre');
  });

  it('order B: the edit waits on the registered instance, then continues and commits', async () => {
    const c = await scene();
    const { ruleId, body, version } = await seriesWithInstances(c);
    const target = (await sessionsOf(ruleId))[0];
    if (target === undefined) throw new Error('no instance');
    const userId = await extraMember(c);
    const edit: Actor<LightMyRequestResponse> = {
      label: 'series edit',
      start: () => ({
        locked: Promise.resolve(),
        release: () => undefined,
        done: call(
          'PUT',
          `${seriesBase(c)}/${ruleId}`,
          c.admin,
          editBody(body, version, { location: 'Edited Centre' }),
        ),
      }),
    };

    const [registered, edited] = await race(registrationStandIn(c, target.id, userId), edit);

    expect(registered.status).toBe('fulfilled');
    const res = fulfilled(edited);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ outcome: { updated: number } }>().outcome.updated).toBe(4);
    expect(await registrationCount(target.id)).toBe(1);
  });
});

describe('R8: instance edit (session held) vs series edit touching it', () => {
  async function seriesScene() {
    const c = await scene();
    const { ruleId, body, version } = await seriesWithInstances(c);
    const target = (await sessionsOf(ruleId))[0];
    if (target === undefined) throw new Error('no instance');
    const instanceEdit = () =>
      call('PUT', `${sessionsBase(c)}/${target.id}`, c.admin, {
        date: target.date,
        location: 'Hand Edited Hall',
        address: '12B John Glenn Avenue, Rosedale, Auckland 0632',
        maxPlayers: 24,
        reservedSeats: 0,
        courtCost: '0.00',
        extraExpenses: '0.00',
        pricingStructure: 'FLAT',
        courts: [WED_COURT],
        expectedVersion: target.version,
      });
    const seriesEdit = () =>
      call(
        'PUT',
        `${seriesBase(c)}/${ruleId}`,
        c.admin,
        editBody(body, version, { location: 'Series Centre' }),
      );
    return { target, instanceEdit, seriesEdit, ruleId };
  }

  it('order A: the series edit waits, then skips the now-edited instance and counts it skipped.edited', async () => {
    const { target, instanceEdit, seriesEdit, ruleId } = await seriesScene();
    const instance = gated('instance edit', SESSION_LOCK, instanceEdit);
    const series: Actor<LightMyRequestResponse> = {
      label: 'series edit',
      start: () => ({ locked: Promise.resolve(), release: () => undefined, done: seriesEdit() }),
    };

    const [edited, seriesRes] = await race(instance, series);

    expect(fulfilled(edited).statusCode).toBe(200);
    const res = fulfilled(seriesRes);
    expect(res.statusCode, res.body).toBe(200);
    expect(
      res.json<{ outcome: { updated: number; skipped: { edited: number } } }>().outcome,
    ).toMatchObject({
      updated: 3,
      skipped: { edited: 1 },
    });
    expect((await sessionRow(target.id)).location).toBe('Hand Edited Hall');
    expect(
      (await sessionsOf(ruleId)).filter((row) => row.location === 'Series Centre'),
    ).toHaveLength(3);
  });

  it('order B: the instance edit waits for the series edit, then answers 409 session_stale', async () => {
    const { target, instanceEdit, seriesEdit } = await seriesScene();
    const series = gated('series edit', SESSION_LOCK, seriesEdit);
    const instance: Actor<LightMyRequestResponse> = {
      label: 'instance edit',
      start: () => ({ locked: Promise.resolve(), release: () => undefined, done: instanceEdit() }),
    };

    const [seriesRes, edited] = await race(series, instance);

    expect(fulfilled(seriesRes).statusCode).toBe(200);
    const res = fulfilled(edited);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('session_stale');
    expect((await sessionRow(target.id)).location).toBe('Series Centre');
  });
});

describe('R9: two series edits on the same rule', () => {
  async function twoEdits() {
    const c = await scene();
    const { ruleId, body, version } = await seriesWithInstances(c);
    const edit = (location: string) => () =>
      call('PUT', `${seriesBase(c)}/${ruleId}`, c.admin, editBody(body, version, { location }));
    const later = (location: string): Actor<LightMyRequestResponse> => ({
      label: `series edit "${location}"`,
      start: () => ({
        locked: Promise.resolve(),
        release: () => undefined,
        done: edit(location)(),
      }),
    });
    return { ruleId, edit, later };
  }

  it('order A: the first edit commits, the second waits and is refused 409 series_stale', async () => {
    const { ruleId, edit, later } = await twoEdits();
    const [first, second] = await race(
      gated('series edit "X"', RULE_LOCK, edit('Centre X')),
      later('Centre Y'),
    );

    expect(fulfilled(first).statusCode).toBe(200);
    const res = fulfilled(second);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('series_stale');
    expect((await rule(ruleId)).default_location).toBe('Centre X');
  });

  it('order B: symmetric, the other edit wins and the first is refused', async () => {
    const { ruleId, edit, later } = await twoEdits();
    const [first, second] = await race(
      gated('series edit "Y"', RULE_LOCK, edit('Centre Y')),
      later('Centre X'),
    );

    expect(fulfilled(first).statusCode).toBe(200);
    expect(errorOf(fulfilled(second)).code).toBe('series_stale');
    expect((await rule(ruleId)).default_location).toBe('Centre Y');
  });
});

// ---------------------------------------------------------------------------------------------
// R10 - R11: the auto-enrol follow-up against cancel and the Auto Enroll save
// ---------------------------------------------------------------------------------------------

describe('R10: auto-enrol follow-up (member SHARE and session held) vs cancel', () => {
  it('order A: the cancel waits for the follow-up, then commits; registrations are untouched', async () => {
    const c = await scene();
    const session = await pendingAutoEnrolSession(c);
    const double = lockingAllocator();
    const cancel: Actor<LightMyRequestResponse> = {
      label: 'cancel',
      start: () => ({
        locked: Promise.resolve(),
        release: () => undefined,
        done: call('POST', `${sessionsBase(c)}/${session.id}/cancel`, c.admin, {
          expectedVersion: session.version,
        }),
      }),
    };

    const [enrolled, cancelled] = await race(
      followUp('follow-up', session.id, c.teamId, double),
      cancel,
    );

    expect(fulfilled(enrolled)).toMatchObject({ kind: 'done', confirmed: 1 });
    const res = fulfilled(cancelled);
    expect(res.statusCode, res.body).toBe(200);
    expect(await sessionRow(session.id)).toMatchObject({ status: 'CANCELLED' });
    expect(await registrationCount(session.id)).toBe(0);
  });

  it('order B: the follow-up waits for the cancel, gets session_not_open for every member and does not stamp the marker', async () => {
    const c = await scene();
    const session = await pendingAutoEnrolSession(c);
    const double = lockingAllocator();
    const cancel = gated('cancel', SESSION_LOCK, () =>
      call('POST', `${sessionsBase(c)}/${session.id}/cancel`, c.admin, {
        expectedVersion: session.version,
      }),
    );
    const enrol: Actor<Awaited<ReturnType<typeof runSessionAutoEnrol>>> = followUp(
      'follow-up',
      session.id,
      c.teamId,
      double,
    );

    const [cancelled, enrolled] = await race(cancel, {
      label: enrol.label,
      start: () => enrol.start(false),
    });

    expect(fulfilled(cancelled).statusCode).toBe(200);
    expect(fulfilled(enrolled)).toMatchObject({ kind: 'done', confirmed: 0, skipped: 1 });
    const row = await sessionRow(session.id);
    expect(row.status).toBe('CANCELLED');
    expect(row.auto_enrolled_at).toBeNull();
    expect(await registrationCount(session.id)).toBe(0);
  });
});

describe('R11: admin Auto Enroll save (member row NO KEY UPDATE) vs auto-enrol follow-up', () => {
  const saveOff = (c: Scene, member: { userId: string }) => () =>
    call('PUT', `/teams/${c.teamId}/members/${member.userId}/auto-enroll`, c.admin, {
      enabled: false,
      until: null,
      expectedEnabled: true,
      expectedUntil: null,
      expectedAssignedAt: new Date('2026-10-01T00:00:00Z').toISOString(),
    });

  it('order A: the follow-up waits on the member row, then its re-check refuses with auto_enroll_changed', async () => {
    const c = await scene();
    const session = await pendingAutoEnrolSession(c);
    const double = lockingAllocator();
    const save = gated('Auto Enroll save', MEMBER_NKU, saveOff(c, session.member));
    const enrol = followUp('follow-up', session.id, c.teamId, double);

    const [saved, enrolled] = await race(save, {
      label: enrol.label,
      start: () => enrol.start(false),
    });

    const res = fulfilled(saved);
    expect(res.statusCode, res.body).toBe(200);
    expect(fulfilled(enrolled)).toMatchObject({ kind: 'done', confirmed: 0, skipped: 1 });
    // The run completed (a refusal is a skip, not a failure), so the marker is stamped and nobody is registered.
    expect((await sessionRow(session.id)).auto_enrolled_at).not.toBeNull();
    expect(await registrationCount(session.id)).toBe(0);
  });

  it('order B: the save waits for the follow-up, which still enrols the member under the old setting', async () => {
    const c = await scene();
    const session = await pendingAutoEnrolSession(c);
    const double = lockingAllocator();
    const save: Actor<LightMyRequestResponse> = {
      label: 'Auto Enroll save',
      start: () => ({
        locked: Promise.resolve(),
        release: () => undefined,
        done: saveOff(c, session.member)(),
      }),
    };

    const [enrolled, saved] = await race(followUp('follow-up', session.id, c.teamId, double), save);

    expect(fulfilled(enrolled)).toMatchObject({ kind: 'done', confirmed: 1, skipped: 0 });
    expect(fulfilled(saved).statusCode).toBe(200);
    expect((await sessionRow(session.id)).auto_enrolled_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// R12 - R14: demotion, the billing completion and the series end
// ---------------------------------------------------------------------------------------------

describe('R12: demotion of the acting admin vs instance edit by that admin', () => {
  async function demotionScene() {
    const c = await scene();
    // A second admin, so the team keeps one and no membership invariant gets in the way of the demotion.
    const other = await insertUser(database.pool, 'FEMALE');
    await insertTeamMember(database.pool, { teamId: c.teamId, userId: other, role: 'TEAM_ADMIN' });
    const draft = await createOneOff(c);
    const edit = () =>
      call(
        'PUT',
        `${sessionsBase(c)}/${draft.id}`,
        c.admin,
        editBody(draft.body, draft.version, { location: 'Edited Hall' }),
      );
    const demote = raw('demotion', async (client) => {
      await client.query(
        `UPDATE team_members SET role = 'MEMBER' WHERE team_id = $1 AND user_id = $2`,
        [c.teamId, c.adminId],
      );
    });
    return { c, draft, edit, demote };
  }

  it('order A: the edit waits for the demotion, then answers 403 forbidden and changes nothing', async () => {
    const { draft, edit, demote } = await demotionScene();
    const editing: Actor<LightMyRequestResponse> = {
      label: 'instance edit',
      start: () => ({ locked: Promise.resolve(), release: () => undefined, done: edit() }),
    };

    const [demoted, edited] = await race(demote, editing);

    expect(demoted.status).toBe('fulfilled');
    const res = fulfilled(edited);
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('forbidden');
    expect((await sessionRow(draft.id)).location).toBe('Rosedale Badminton Centre');
  });

  it('order B: the demotion waits for the edit, which commits as the admin it still was', async () => {
    const { c, draft, edit, demote } = await demotionScene();
    const editing = gated('instance edit', ACTOR_SHARE, edit);
    const demoting: Actor<void> = {
      label: 'demotion',
      start: () => ({
        locked: Promise.resolve(),
        release: () => undefined,
        done: demote.start(false).done,
      }),
    };

    const [edited, demoted] = await race(editing, demoting);

    expect(fulfilled(edited).statusCode).toBe(200);
    expect(demoted.status).toBe('fulfilled');
    expect((await sessionRow(draft.id)).location).toBe('Edited Hall');
    const { rows } = await database.pool.query<{ role: string }>(
      `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [c.teamId, c.adminId],
    );
    expect(rows[0]?.role).toBe('MEMBER');
  });
});

describe('R13: billing stand-in (session FOR UPDATE, COMPLETED) vs raw court write', () => {
  const complete = (sessionId: string) =>
    raw('billing completion', async (client) => {
      await client.query(`SELECT id FROM game_sessions WHERE id = $1 FOR UPDATE`, [sessionId]);
      await client.query(`UPDATE game_sessions SET status = 'COMPLETED' WHERE id = $1`, [
        sessionId,
      ]);
    });
  const courtWrite = (sessionId: string) =>
    raw('court write', async (client) => {
      await client.query(`UPDATE session_courts SET end_time = '22:00' WHERE session_id = $1`, [
        sessionId,
      ]);
    });
  const courtEnd = async (sessionId: string): Promise<string> => {
    const { rows } = await database.pool.query<{ t: string }>(
      `SELECT to_char(end_time, 'HH24:MI') AS t FROM session_courts WHERE session_id = $1`,
      [sessionId],
    );
    return rows[0]?.t ?? '';
  };

  it('order A: the court write waits for the completion, then fails 23000 session_courts_closed_immutable', async () => {
    const c = await scene();
    const session = await publishedOneOff(c);

    const [completed, written] = await race(complete(session.id), {
      label: 'court write',
      start: () => courtWrite(session.id).start(false),
    });

    expect(completed.status).toBe('fulfilled');
    expect(rejectedWith(written)).toMatchObject({
      code: '23000',
      constraint: 'session_courts_closed_immutable',
    });
    expect((await sessionRow(session.id)).status).toBe('COMPLETED');
    expect(await courtEnd(session.id)).toBe('21:00');
  });

  it('order B: the completion waits for the court write, which therefore committed before COMPLETED', async () => {
    const c = await scene();
    const session = await publishedOneOff(c);

    const [written, completed] = await race(courtWrite(session.id), {
      label: 'billing completion',
      start: () => complete(session.id).start(false),
    });

    expect(written.status).toBe('fulfilled');
    expect(completed.status).toBe('fulfilled');
    expect((await sessionRow(session.id)).status).toBe('COMPLETED');
    expect(await courtEnd(session.id)).toBe('22:00');
  });
});

describe('R13 (adjacent): session_courts_guard_closed takes the session locks in id order', () => {
  it('a court moved from the higher session id to the lower one waits for the lower lock without holding the higher one', async () => {
    const c = await scene();
    const first = await insertSession(database.pool, c.teamId, {}, { date: '2026-11-04' });
    const second = await insertSession(
      database.pool,
      c.teamId,
      {},
      { date: '2026-11-11', withCourt: false },
    );
    const [low, high] = first < second ? [first, second] : [second, first];
    // The only court sits on whichever session has the higher id, and moves to the lower one: the trigger's OLD,NEW order is high, low.
    if (high === second) {
      await database.pool.query(`UPDATE session_courts SET session_id = $2 WHERE session_id = $1`, [
        first,
        second,
      ]);
    }
    const { rows: courts } = await database.pool.query<{ id: string }>(
      `SELECT id FROM session_courts WHERE session_id = $1`,
      [high],
    );
    const courtId = courts[0]?.id;
    if (courtId === undefined) throw new Error('expected a court on the higher session');

    const lowHolder = await database.pool.connect();
    const mover = await database.pool.connect();
    let moving: Promise<unknown> | undefined;
    try {
      await lowHolder.query('BEGIN');
      await lowHolder.query(`SELECT id FROM game_sessions WHERE id = $1 FOR UPDATE`, [low]);
      await mover.query('BEGIN');
      moving = mover.query(`UPDATE session_courts SET session_id = $2 WHERE id = $1`, [
        courtId,
        low,
      ]);
      await waitForLockWaiters(database.pool, 1, 'the court move blocked on the lower session');

      // If the trigger had taken the higher session first, it would hold it now and this probe would fail with 55P03.
      const probe = await database.pool.connect();
      try {
        await probe.query('BEGIN');
        await probe.query(`SELECT id FROM game_sessions WHERE id = $1 FOR NO KEY UPDATE NOWAIT`, [
          high,
        ]);
      } finally {
        await probe.query('ROLLBACK').catch(() => undefined);
        probe.release();
      }
    } finally {
      await lowHolder.query('COMMIT').catch(() => undefined);
      await moving?.catch(() => undefined);
      await mover.query('ROLLBACK').catch(() => undefined);
      lowHolder.release();
      mover.release();
    }
  });
});

describe('R14: series end (rule held) vs materialiser instance for a date after the new recur_until', () => {
  async function endScene() {
    const c = await scene();
    const { ruleId, version } = await seriesWithInstances(c);
    const end = () =>
      call('POST', `${seriesBase(c)}/${ruleId}/end`, c.admin, {
        expectedVersion: version,
        lastDate: '2026-10-21',
        alsoCancelPublished: false,
      });
    const materialise = () =>
      materialiseDate(instanceDeps(), { ruleId, teamId: c.teamId }, NEXT_DATE, WINDOW_START);
    return { ruleId, end, materialise };
  }

  it('order A: the materialiser waits for the end, then skips the date (the rule no longer generates it)', async () => {
    const { ruleId, end, materialise } = await endScene();
    const ending = gated('series end', RULE_LOCK, end);
    const materialising: Actor<Awaited<ReturnType<typeof materialiseDate>>> = {
      label: 'materialiser',
      start: () => ({ locked: Promise.resolve(), release: () => undefined, done: materialise() }),
    };

    const [ended, made] = await race(ending, materialising);

    const res = fulfilled(ended);
    expect(res.statusCode, res.body).toBe(200);
    expect(fulfilled(made)).toEqual({ kind: 'skipped', reason: 'rule_changed' });
    expect((await sessionsOf(ruleId)).find((row) => row.date === NEXT_DATE)).toBeUndefined();
  });

  it('order B: the end waits for the materialiser, then keeps the new off-pattern instance (it is told, not cancelled)', async () => {
    const { ruleId, end, materialise } = await endScene();
    const materialising = gated('materialiser', RULE_LOCK, materialise);
    const ending: Actor<LightMyRequestResponse> = {
      label: 'series end',
      start: () => ({ locked: Promise.resolve(), release: () => undefined, done: end() }),
    };

    const [made, ended] = await race(materialising, ending);

    expect(fulfilled(made)).toMatchObject({ kind: 'published' });
    const res = fulfilled(ended);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<EndSeriesResponse>().keptOffPattern.map((row) => row.date)).toContain(
      NEXT_DATE,
    );
    expect((await sessionsOf(ruleId)).find((row) => row.date === NEXT_DATE)?.status).toBe(
      'PUBLISHED',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// T-17: a registration insert against a fee edit under the session lock
// ---------------------------------------------------------------------------------------------

describe('T-17: registration insert vs fee edit under the session lock', () => {
  async function paidPublished() {
    const c = await scene({ payout: true });
    const session = await publishedOneOff(c, { courtCost: '120.00' });
    const userId = await extraMember(c);
    const raise = () =>
      call(
        'PUT',
        `${sessionsBase(c)}/${session.id}`,
        c.admin,
        editBody(session.body, session.version, { courtCost: '240.00' }),
      );
    return { c, session, userId, raise };
  }

  it('the registration first: the fee raise waits for it, then answers 409 session_fee_locked and the fee is unchanged', async () => {
    const { c, session, userId, raise } = await paidPublished();
    const raising: Actor<LightMyRequestResponse> = {
      label: 'fee edit',
      start: () => ({ locked: Promise.resolve(), release: () => undefined, done: raise() }),
    };

    const [registered, edited] = await race(registrationStandIn(c, session.id, userId), raising);

    expect(fulfilled(registered)).toMatchObject({ feeFlat: '10.00' });
    const res = fulfilled(edited);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('session_fee_locked');
    expect(errorOf(res).raisedFields?.length).toBeGreaterThan(0);
    expect((await sessionRow(session.id)).fee_flat).toBe('10.00');
    expect(await registrationCount(session.id)).toBe(1);
  });

  it('the fee raise first: the registration waits, reads the raised fee under the lock and then registers', async () => {
    const { c, session, userId, raise } = await paidPublished();

    const [edited, registered] = await race(
      gated('fee edit', SESSION_LOCK, raise),
      registrationStandIn(c, session.id, userId),
    );

    expect(fulfilled(edited).statusCode).toBe(200);
    expect(fulfilled(registered)).toMatchObject({ feeFlat: '20.00' });
    expect((await sessionRow(session.id)).fee_flat).toBe('20.00');
    expect(await registrationCount(session.id)).toBe(1);
  });

  it('the database backstop: with an active registration committed, a raw fee raise fails 23514 game_sessions_fee_raise_locked and an API decrease succeeds', async () => {
    const { c, session, userId } = await paidPublished();
    await insertRegistration(database.pool, { sessionId: session.id, teamId: c.teamId, userId });

    const raise = await pgError(
      database.pool.query(`UPDATE game_sessions SET fee_flat = '99.00' WHERE id = $1`, [
        session.id,
      ]),
    );
    expect(raise).toMatchObject({ code: '23514', constraint: 'game_sessions_fee_raise_locked' });
    // A decrease is still allowed: through the API (the rate falls to $5.00), registration or not.
    const lowered = await call(
      'PUT',
      `${sessionsBase(c)}/${session.id}`,
      c.admin,
      editBody(session.body, session.version, { courtCost: '60.00' }),
    );
    expect(lowered.statusCode, lowered.body).toBe(200);
    expect((await sessionRow(session.id)).fee_flat).toBe('5.00');
  });
});

// ---------------------------------------------------------------------------------------------
// T-18: exactly one banking email per rule and NZ week
// ---------------------------------------------------------------------------------------------

describe('T-18: two concurrent instance transactions for one rule and window enqueue exactly one email', () => {
  it('the claim row: a second transaction waits on the first claim, loses it and sends nothing', async () => {
    const c = await scene({ payout: false });
    const ruleId = await insertRule(database.pool, c.teamId);
    const input = { teamId: c.teamId, ruleId, windowStart: WINDOW_START };
    const notice = instanceDeps().notice;
    const claim = (hold: boolean): Actor<boolean> => ({
      label: hold ? 'first claim' : 'second claim',
      start: () => {
        let release: () => void = () => undefined;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let claimed: () => void = () => undefined;
        const claimedPromise = new Promise<void>((resolve) => {
          claimed = resolve;
        });
        const done = gate.db.transaction().execute(async (trx) => {
          const emailed = await claimPayoutNotice(trx, notice, input);
          claimed();
          if (hold) await released;
          return emailed;
        });
        return { locked: hold ? claimedPromise : Promise.resolve(), release, done };
      },
    });

    const [first, second] = await race(claim(true), claim(false));

    expect(fulfilled(first)).toBe(true);
    expect(fulfilled(second)).toBe(false);
    // One admin on the team: exactly one email, keyed by rule, week and recipient.
    expect(emails).toHaveLength(1);
    expect(emails[0]?.idempotencyKey).toBe(`payout-missing:${ruleId}:${WINDOW_START}:${c.adminId}`);
  });

  it('two instance transactions of one run window: the second waits on the rule, finds the week claimed and sends nothing', async () => {
    const c = await scene({ payout: false });
    const ruleId = await insertRule(database.pool, c.teamId);
    await database.pool.query(
      `UPDATE recurring_session_rules SET default_custom_player_rate = '17.00' WHERE id = $1`,
      [ruleId],
    );
    const run = (date: string) => () =>
      materialiseDate(
        instanceDeps(),
        { ruleId, teamId: c.teamId },
        parseLocalDate(date),
        WINDOW_START,
      );
    const second: Actor<Awaited<ReturnType<typeof materialiseDate>>> = {
      label: 'second instance transaction',
      start: () => ({
        locked: Promise.resolve(),
        release: () => undefined,
        done: run('2026-10-21')(),
      }),
    };

    const [first, other] = await race(
      gated('first instance transaction', RULE_LOCK, run('2026-10-14')),
      second,
    );

    expect(fulfilled(first)).toMatchObject({ kind: 'draft' });
    expect(fulfilled(other)).toMatchObject({ kind: 'draft' });
    expect(emails).toHaveLength(1);
    const { rows } = await database.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payout_notice_claims WHERE rule_id = $1`,
      [ruleId],
    );
    expect(rows[0]?.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// T-19 / AC-ASYNC-5: inline follow-up vs sweep job vs replayed job
// ---------------------------------------------------------------------------------------------

function jobContext(): JobContext {
  return {
    logger: logs.logger,
    jobId: randomUUID(),
    queue: 'session-auto-enrol',
    retryCount: 0,
    retryLimit: 3,
    signal: new AbortController().signal,
  } as unknown as JobContext;
}

describe('T-19: the inline follow-up, the sweep job and a replayed job serialise on the advisory lock', () => {
  it('give one autoEnrolInSession call and one stamp, and the two waiters find the session no longer due', async () => {
    const c = await scene();
    const session = await pendingAutoEnrolSession(c);
    const double = lockingAllocator();
    const handler = createSessionAutoEnrolHandler({
      db: gate.db,
      clock: h.clock,
      allocator: double,
    });

    const inline = followUp('inline follow-up', session.id, c.teamId, double).start(true);
    await inline.locked;
    const payload = (trigger: 'sweep' | 'publish') => ({
      sessionId: session.id,
      teamId: c.teamId,
      trigger,
    });
    const sweepJob = handler(payload('sweep'), jobContext());
    const replayedJob = handler(payload('publish'), jobContext());
    // Both jobs are blocked on `pg_advisory_xact_lock`, which Postgres reports as a lock wait.
    await waitForLockWaiters(
      database.pool,
      2,
      'the sweep and replayed jobs blocked on the advisory lock',
    );
    expect((await sessionRow(session.id)).auto_enrolled_at).toBeNull();
    inline.release();
    h.clock.advance(60_000);
    await Promise.all([inline.done, sweepJob, replayedJob]);

    expect(double.calls).toEqual([{ sessionId: session.id, userIds: [session.member.userId] }]);
    const stamped = (await sessionRow(session.id)).auto_enrolled_at;
    expect(stamped).not.toBeNull();
    // Re-running changes nothing: still one call, and the stamp is the first run's.
    await handler(payload('sweep'), jobContext());
    expect(double.calls).toHaveLength(1);
    expect((await sessionRow(session.id)).auto_enrolled_at).toEqual(stamped);
  });
});

// ---------------------------------------------------------------------------------------------
// The GateRequired rerun path of the series edit
// ---------------------------------------------------------------------------------------------

describe('series edit: a free draft published by hand between the unlocked read and the locks reruns the edit gated', () => {
  async function gateRequiredScene(options: { payout: boolean }) {
    const c = await scene({ payout: options.payout });
    const create = await call('POST', seriesBase(c), c.admin, seriesBody());
    expect(create.statusCode, create.body).toBe(201);
    const ruleId = seriesOf(create).id;
    // A free DRAFT instance: the edit's unlocked read finds no PUBLISHED free instance, so it does not gate up front.
    const draftId = await insertSession(
      database.pool,
      c.teamId,
      { flat: '0.00' },
      { date: '2026-10-14', recurringRuleId: ruleId },
    );
    const body = seriesBody(PAID_SERIES);
    const version = (await rule(ruleId)).version;
    const makePaid = () =>
      call(
        'PUT',
        `${seriesBase(c)}/${ruleId}`,
        c.admin,
        editBody({ ...body, location: 'Rosedale Badminton Centre' }, version),
      );
    const publishByHand = async (): Promise<LightMyRequestResponse> =>
      call('POST', `${sessionsBase(c)}/${draftId}/publish`, c.admin, {
        expectedVersion: (await sessionRow(draftId)).version,
      });
    return { c, ruleId, draftId, makePaid, publishByHand };
  }

  /** Parks the edit right after its unlocked read of the PUBLISHED targets, publishes the draft, then lets the edit go on. */
  async function editWhilePublishing(
    makePaid: () => Promise<LightMyRequestResponse>,
    publishByHand: () => Promise<LightMyRequestResponse>,
  ): Promise<LightMyRequestResponse> {
    const parked = gate.arm(
      /from "game_sessions".* "is_instance_overridden" = \$\d.*"starts_at" > \$\d$/,
    );
    const editing = makePaid();
    await Promise.race([
      parked.reached,
      editing.then(() => Promise.reject(new Error('edit finished early'))),
    ]);
    try {
      const published = await publishByHand();
      expect(published.statusCode, published.body).toBe(200);
    } finally {
      parked.release();
    }
    return editing;
  }

  it('with banking set up the rerun gates, passes and the draft ends up PUBLISHED and paid', async () => {
    const { draftId, ruleId, makePaid, publishByHand } = await gateRequiredScene({ payout: true });
    const mark = gate.statements.length;

    const res = await editWhilePublishing(makePaid, publishByHand);

    expect(res.statusCode, res.body).toBe(200);
    expect(await sessionRow(draftId)).toMatchObject({ status: 'PUBLISHED', fee_flat: '10.00' });
    expect((await rule(ruleId)).version).toBeGreaterThan(1);
    // The rerun is the one that gated: the edit's own transaction took the gate before its first game_sessions lock.
    const editTransactions = transactionsOf(gate.statements.slice(mark)).filter((statements) =>
      statements.some((sql) => RULE_LOCK.test(sql)),
    );
    // Two attempts: the first ran ungated and was rolled back by GateRequired; the rerun gated before its first session lock.
    expect(editTransactions).toHaveLength(2);
    const [ungated, gatedRerun] = editTransactions;
    expect(ungated?.some((sql) => GATE.test(sql))).toBe(false);
    const gateAt = gatedRerun?.findIndex((sql) => GATE.test(sql)) ?? -1;
    const lockAt = gatedRerun?.findIndex((sql) => SESSION_LOCK.test(sql)) ?? -1;
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeLessThan(lockAt);
  });

  it('without banking the rerun is refused 409 payout_not_configured and nothing of the edit is saved', async () => {
    const { draftId, ruleId, makePaid, publishByHand } = await gateRequiredScene({ payout: false });

    const res = await editWhilePublishing(makePaid, publishByHand);

    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('payout_not_configured');
    expect(await rule(ruleId)).toMatchObject({ version: 1 });
    expect(await sessionRow(draftId)).toMatchObject({ status: 'PUBLISHED', fee_flat: '0.00' });
  });
});

// ---------------------------------------------------------------------------------------------
// AC-INTEGRATION-2: an admin publishes a gate-refused series draft by hand
// ---------------------------------------------------------------------------------------------

describe('AC-INTEGRATION-2: an admin publishes a gate-refused series draft by hand', () => {
  it('the double gets one call, after PUBLISHED committed, in a transaction that took the advisory lock first, with the selection in order', async () => {
    const c = await scene({ payout: false });
    const early = await autoEnrollMember(c.teamId, '2026-09-01T00:00:00Z', null);
    const late = await autoEnrollMember(c.teamId, '2026-10-01T00:00:00Z', '2026-12-31');
    await autoEnrollMember(c.teamId, '2026-09-15T00:00:00Z', '2026-10-07'); // ended before the instance date
    await autoEnrollMember(c.teamId, '2026-09-20T00:00:00Z', null, false); // Auto Enroll off
    const { ruleId } = await seriesWithInstances(c, PAID_SERIES);
    const drafts = await sessionsOf(ruleId);
    const draft = drafts.find((row) => row.date === '2026-10-14');
    if (draft === undefined || draft.status !== 'DRAFT')
      throw new Error('expected a gate-refused draft');
    // The refused instances were never offered to the allocator.
    expect(allocator.autoEnrolCalls).toHaveLength(0);

    await configureBanking(c.teamId);
    const published = await call('POST', `${sessionsBase(c)}/${draft.id}/publish`, c.admin, {
      expectedVersion: draft.version,
    });
    expect(published.statusCode, published.body).toBe(200);
    // The follow-up is a job queued in the publish transaction; nothing ran inline.
    expect(allocator.autoEnrolCalls).toHaveLength(0);
    const { rows: queued } = await database.pool.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM pgboss.job WHERE name = 'session-auto-enrol' AND singleton_key = $1`,
      [`session-auto-enrol:${draft.id}`],
    );
    expect(queued).toHaveLength(1);

    const handler = createSessionAutoEnrolHandler({ db: gate.db, clock: h.clock, allocator });
    const mark = gate.statements.length;
    // The worker's wrapper strips the trace envelope before the handler sees the payload.
    const payload: Record<string, unknown> = { ...queued[0]?.data };
    delete payload._meta;
    await handler(payload, jobContext());

    expect(allocator.autoEnrolCalls).toHaveLength(1);
    const call0 = allocator.autoEnrolCalls[0];
    expect(call0).toMatchObject({ teamId: c.teamId, sessionId: draft.id, inTransaction: true });
    const selection = await selectAutoEnrollees(gate.db, {
      teamId: c.teamId,
      sessionDate: parseLocalDate('2026-10-14'),
    });
    expect(call0?.entries.map(({ userId, assignedAt }) => ({ userId, assignedAt }))).toEqual(
      selection.map(({ userId, assignedAt }) => ({ userId, assignedAt })),
    );
    expect(call0?.entries.map((entry) => entry.userId)).toEqual([early.userId, late.userId]);
    // The advisory lock is the first statement of the run's transaction after the lock timeout, before any row lock.
    const transaction = transactionsOf(gate.statements.slice(mark))[0] ?? [];
    expect(transaction[0]).toMatch(/set local lock_timeout/i);
    expect(transaction[1]).toMatch(/pg_advisory_xact_lock/);
    expect((await sessionRow(draft.id)).auto_enrolled_at).not.toBeNull();

    // A replay of the same job, and a sweep, call it no more.
    await handler(payload, jobContext());
    expect(allocator.autoEnrolCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Hardening (reviewer suggestions deferred from Phase 3)
// ---------------------------------------------------------------------------------------------

describe('hardening: ended series', () => {
  it('"Publish drafts now" on an ended series answers 409 series_ended and queues nothing', async () => {
    const c = await scene();
    const { ruleId, version } = await seriesWithInstances(c);
    const ended = await call('POST', `${seriesBase(c)}/${ruleId}/end`, c.admin, {
      expectedVersion: version,
      lastDate: '2026-10-07',
      alsoCancelPublished: false,
    });
    expect(ended.statusCode, ended.body).toBe(200);
    // The series is over once its last date has passed: the rule goes inactive.
    await database.pool.query(
      `UPDATE recurring_session_rules SET is_active = false WHERE id = $1`,
      [ruleId],
    );
    await database.pool.query(`DELETE FROM pgboss.job WHERE name = 'recurrence-rule'`);

    const res = await call('POST', `${seriesBase(c)}/${ruleId}/publish-drafts`, c.admin, {});

    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).code).toBe('series_ended');
    const { rows } = await database.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'recurrence-rule' AND data->>'trigger' = 'manual'`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('a draft retry skips a draft whose rule is no longer active and leaves it a DRAFT', async () => {
    const c = await scene({ payout: false });
    const { ruleId } = await seriesWithInstances(c, PAID_SERIES);
    await configureBanking(c.teamId);
    const draft = (await sessionsOf(ruleId))[0];
    if (draft === undefined) throw new Error('expected a draft');
    const seen = (
      await listRetryableDrafts(
        gate.db,
        { ruleId, teamId: c.teamId },
        { now: h.clock.now(), windowEnd: parseLocalDate('2026-12-31') },
      )
    ).find((row) => row.id === draft.id);
    if (seen === undefined) throw new Error('the draft should be retryable');
    await database.pool.query(
      `UPDATE recurring_session_rules SET is_active = false WHERE id = $1`,
      [ruleId],
    );

    const outcome = await retryDraft(
      instanceDeps(),
      { ruleId, teamId: c.teamId },
      seen,
      WINDOW_START,
    );

    expect(outcome).toEqual({ kind: 'skipped', reason: 'rule_changed' });
    expect((await sessionRow(draft.id)).status).toBe('DRAFT');
  });
});

// ---------------------------------------------------------------------------------------------
// The stately trailing run and the failure-into-retry case (their own database and worker)
// ---------------------------------------------------------------------------------------------

describe('recurrence-rule is stately: one active run and at most one trailing run that reads the latest rule', () => {
  let db2: TestDatabase;
  let app2: AuthTestApp;
  let producer2: JobRunner;
  let worker2: JobRunner;
  const enqueuedRuns: { trigger: string; queued: boolean }[] = [];
  const executions: string[] = [];
  let firstRun: { reached: () => void; released: Promise<void>; fail: boolean } | undefined;
  const allocator2 = createRecordingAllocator();

  beforeAll(async () => {
    db2 = await createTestDatabase({ poolMax: 12 });
    const logger = captureLogs().logger;
    worker2 = createJobRunner({
      databaseUrl: db2.url,
      logger,
      role: 'worker',
      pollingIntervalSeconds: 0.5,
    });
    producer2 = createJobRunner({ databaseUrl: db2.url, logger, role: 'producer' });
    await worker2.start();
    await producer2.start();
    for (const queue of QUEUES) await worker2.defineQueue(queue);
    app2 = await buildAuthTestApp(db2.pool, {
      jobs: {
        enqueue: async (queue, data, options) => {
          const id = await producer2.enqueue(queue, data, options);
          if (queue === QUEUE_NAMES.recurrenceRule) {
            enqueuedRuns.push({
              trigger: (data as { trigger: string }).trigger,
              queued: id !== null,
            });
          }
          return id;
        },
      },
      sessionAllocator: allocator2,
    });
    const handler: JobHandler = createRecurrenceRuleHandler({
      db: createKysely(db2.pool),
      clock: app2.clock,
      allocator: allocator2,
      jobs: worker2,
      horizonDays: 28,
      webBaseUrl: 'https://app.example.test',
      run: async (deps, payload) => {
        executions.push(payload.trigger);
        // The first run does its work, then stays ACTIVE (parked) so the edits arrive during it.
        const result = await materialiseRule(deps, payload);
        const parked = firstRun;
        if (parked !== undefined) {
          firstRun = undefined;
          parked.reached();
          await parked.released;
          if (parked.fail) throw new Error('simulated transient failure');
        }
        return result;
      },
    });
    await worker2.work(QUEUE_NAMES.recurrenceRule, handler);
  });
  afterAll(async () => {
    await app2.close();
    await producer2.stop();
    await worker2.stop();
    await db2.close();
  });
  beforeEach(() => {
    enqueuedRuns.length = 0;
    executions.length = 0;
    app2.clock.set(SERIES_NOW);
  });

  async function seriesScene() {
    const base = await createSessionsScene(db2.pool, { payoutConfigured: true });
    const { token } = await insertAuthSession(db2.pool, base.adminId, {
      createdAt: app2.clock.now(),
      idleDays: 90,
      absoluteDays: 180,
    });
    const put = (url: string, payload: object, method: 'POST' | 'PUT' = 'PUT') =>
      app2.app.inject({
        method,
        url,
        headers: bearer(token),
        payload: payload as Record<string, unknown>,
      });
    return { teamId: base.teamId, put };
  }

  async function ruleState(ruleId: string) {
    const { rows } = await db2.pool.query<{ version: number; materialised_version: number | null }>(
      `SELECT version, materialised_version FROM recurring_session_rules WHERE id = $1`,
      [ruleId],
    );
    return rows[0];
  }
  async function jobStates(ruleId: string): Promise<Record<string, number>> {
    const { rows } = await db2.pool.query<{ state: string; n: number }>(
      `SELECT state::text AS state, count(*)::int AS n FROM pgboss.job
        WHERE name = 'recurrence-rule' AND singleton_key = $1 GROUP BY state`,
      [`recurrence-rule:${ruleId}`],
    );
    return Object.fromEntries(rows.map((row) => [row.state, row.n]));
  }
  async function locationsOf(ruleId: string): Promise<string[]> {
    const { rows } = await db2.pool.query<{ location: string }>(
      `SELECT DISTINCT location FROM game_sessions WHERE recurring_rule_id = $1`,
      [ruleId],
    );
    return rows.map((row) => row.location);
  }

  it('edits during an active run queue exactly one trailing run, which applies the latest rule', async () => {
    const { teamId, put } = await seriesScene();
    let released!: () => void;
    let reached!: () => void;
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve;
    });
    firstRun = {
      reached,
      released: new Promise<void>((resolve) => {
        released = resolve;
      }),
      fail: false,
    };
    const body = seriesBody();
    const created = await put(`/teams/${teamId}/session-series`, body, 'POST');
    expect(created.statusCode, created.body).toBe(201);
    const ruleId = created.json<{ series: SeriesResponse }>().series.id;
    // The run for the creation is active and parked before it reads anything.
    await reachedPromise;

    const first = await put(
      `/teams/${teamId}/session-series/${ruleId}`,
      editBody(body, 1, { location: 'Edit One' }),
    );
    expect(first.statusCode, first.body).toBe(200);
    const second = await put(
      `/teams/${teamId}/session-series/${ruleId}`,
      editBody(body, 2, { location: 'Edit Two' }),
    );
    expect(second.statusCode, second.body).toBe(200);
    // One run is active; the first edit queued the trailing run, the second found one already queued and queued nothing.
    expect(enqueuedRuns).toEqual([
      { trigger: 'rule_created', queued: true },
      { trigger: 'rule_updated', queued: true },
      { trigger: 'rule_updated', queued: false },
    ]);
    expect(await jobStates(ruleId)).toEqual({ active: 1, created: 1 });

    // The run that was active stamped the version it started from, so the series still looks "pending" to the admin.
    expect((await ruleState(ruleId))?.materialised_version).toBe(1);

    released();
    await waitFor(
      async () => {
        const state = await ruleState(ruleId);
        return state?.materialised_version === 3 ? true : undefined;
      },
      { timeoutMs: 30_000, label: 'the trailing run to stamp the latest rule version' },
    );
    await waitFor(async () => ((await jobStates(ruleId)).completed === 2 ? true : undefined), {
      timeoutMs: 30_000,
      label: 'both runs to complete',
    });
    // Exactly one trailing run, and it is the one that read the latest rule (version 3 = create, edit one, edit two).
    expect(executions).toEqual(['rule_created', 'rule_updated']);
    expect(await jobStates(ruleId)).toEqual({ completed: 2 });
    expect(await locationsOf(ruleId)).toEqual(['Edit Two']);
  });

  it('a run that fails while a sibling is queued does not lose the series: the instances still converge on the latest rule', async () => {
    const { teamId, put } = await seriesScene();
    let released!: () => void;
    let reached!: () => void;
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve;
    });
    firstRun = {
      reached,
      released: new Promise<void>((resolve) => {
        released = resolve;
      }),
      fail: true,
    };
    const body = seriesBody();
    const created = await put(`/teams/${teamId}/session-series`, body, 'POST');
    const ruleId = created.json<{ series: SeriesResponse }>().series.id;
    await reachedPromise;
    const edit = await put(
      `/teams/${teamId}/session-series/${ruleId}`,
      editBody(body, 1, { location: 'After Failure' }),
    );
    expect(edit.statusCode, edit.body).toBe(200);

    released();

    await waitFor(
      async () => {
        const state = await ruleState(ruleId);
        return state?.materialised_version === 2 ? true : undefined;
      },
      { timeoutMs: 45_000, label: 'the queued sibling to converge the series' },
    );
    expect(await locationsOf(ruleId)).toEqual(['After Failure']);
    expect(executions[0]).toBe('rule_created');
    expect(executions.length).toBeGreaterThanOrEqual(2);
  });
});
