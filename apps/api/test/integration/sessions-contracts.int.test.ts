/**
 * THE CONTRACT THIS FEATURE (session-scheduling-engine, ADR 0019) HANDS TO registration-and-waitlist (AC-INTEGRATION-1).
 * Registration's build gate re-checks every item below against this file and against a real published session. Everything is
 * proven on sessions made through the real API and service (not inserted by fixtures), over a cloned PostgreSQL.
 *
 * 1. The five "Assumed session-scheduling-engine outputs" (registration-and-waitlist task file):
 *    1) A session reaches `status = 'PUBLISHED'` only with at least one `session_courts` row (so `starts_at` and `ends_at` are
 *       set), `cancellation_deadline <= starts_at`, its final `max_players` and `reserved_seats`, and a fee column for every
 *       party type of its `pricing_structure`: `fee_flat` for FLAT, `fee_male` + `fee_female` + `fee_other` for BY_SEX, all
 *       three skill fees for BY_SKILL_LEVEL. For a FLAT session `fee_flat` IS the final per-player rate (the admin-edited
 *       value, also after a rate decrease on a published session), never `calculated_rate_per_player`.
 *    2) The lifecycle is DRAFT -> PUBLISHED -> COMPLETED | CANCELLED. Registration is open only while
 *       `status = 'PUBLISHED' AND now < starts_at`. Cancelling a session leaves its registrations exactly as they are.
 *    3) This feature ships NO player-facing session page (the page at `/teams/[teamId]/sessions/[sessionId]` and its
 *       RegistrationPanel belong to registration-and-waitlist); admin pages live under `/teams/[teamId]/manage/sessions`.
 *    4) A capacity edit on a PUBLISHED session that RAISES public capacity (`max_players - reserved_seats`) calls the
 *       allocator's `promoteWaitlist` exactly once, in the edit's own transaction, after the session `FOR UPDATE` lock.
 *       A cut never demotes anyone and calls nothing.
 *    5) The auto-enrol step registers members through the allocator's `autoEnrolInSession` with `{ userId, assignedAt }`
 *       entries in selection order, once per published session, after the session is PUBLISHED and committed; a port with
 *       `enrols: false` leaves the session pending (`auto_enrolled_at` NULL) until a real allocator is injected and a sweep
 *       runs (the marker proof below).
 *
 * 2. C-SSE-1..5 (registration-and-waitlist allocator architecture):
 *    C-SSE-1  `fee_flat` = the final FLAT rate at every save; BY_SKILL fees NOT NULL when PUBLISHED (CHECKs
 *             `game_sessions_flat_fee_when_live`, `game_sessions_skill_fees_when_live`).
 *    C-SSE-2  PUBLISHED implies at least one court and `cancellation_deadline <= starts_at`; the lifecycle matrix.
 *    C-SSE-3  capacity edit = teams FOR KEY SHARE, the actor FOR SHARE, `game_sessions ... FOR UPDATE`, the UPDATE, then
 *             `promoteWaitlist`, all in one transaction; a cut never demotes; a started session is refused.
 *    C-SSE-4  cancel leaves every registration untouched and calls no allocator method and sends no email to players.
 *    C-SSE-5  the session lock is `FOR UPDATE` and is held only for the edit's own statements.
 *
 * 3. The port registration implements (`apps/api/src/modules/sessions/allocator-port.ts`; registration may import only that
 *    file from the sessions module):
 *      interface SessionAllocatorPort {
 *        readonly name: string;
 *        readonly enrols: boolean;
 *        promoteWaitlist(ctx: SessionAllocatorContext, input: { teamId: string; sessionId: string }):
 *          Promise<readonly PromotedSeat[]>;
 *        autoEnrolInSession(ctx: SessionAllocatorContext, input: { teamId: string; sessionId: string;
 *          entries: readonly { userId: string; assignedAt: Date; membershipId?: string }[] }):
 *          Promise<readonly { userId: string; outcome: AutoEnrolEntryOutcome }[]>;
 *      }
 *      // SessionAllocatorContext = { trx: Transaction<DB>; now: Date; log }. The composition function is
 *      // `createSessionAllocator()` in `apps/api/src/session-allocator.ts`; `buildApp` and `registerJobs` require the port.
 *
 * 4. The D-85 predicate, which registration's build gate re-checks and widens (see `sessions-parity.int.test.ts` for the
 *    TS/SQL parity of today's definition):
 *      `game_session_has_active_registrations(p_session_id uuid)` today counts `registrations.status IN ('CONFIRMED',
 *      'WAITLISTED')`, and `game_sessions_fee_raise_locked` raises 23514 on a fee raise while it is true. Registration
 *      re-checks and must provide, in its own migration and code:
 *        a) `CREATE OR REPLACE` of `game_session_has_active_registrations` to ALSO count WITHDRAWN rows that have
 *           `withdrawal_fee_due` (ALG R-a, binding T-17), and the same widening of `countActiveRegistrations`
 *           (`apps/api/src/modules/sessions/repo.ts`), which backs "N players are registered" and the 409 `session_fee_locked`;
 *        b) an existing registration row in ANY status is treated as `already_registered` by the auto-enrol path (ALG R-b);
 *        c) the composition function (`createSessionAllocator`) superseding `promoteWaitlist(trx, sessionId, now)` (ARCH H10).
 *
 * The "marker proof" (AC-INTEGRATION-1, AC-INTEGRATION-2): a published session whose allocator has `enrols: false` stays
 * pending; once an `enrols: true` double is injected and the sweep runs, it is enrolled exactly once and stamped.
 *
 * What registration-and-waitlist now provides (Phase 3, R19, R26): `createSessionAllocator` returns its adapter
 * (`name: 'registrations'`, `enrols: true`), the D-85 widening (a) and `already_registered` for any existing row (b) were built
 * in Phases 1-2, and the marker proof is repeated with the REAL adapter in `registrations-sse-integration.int.test.ts`
 * (AC-INTEGRATION-6). This file keeps its recording double and stays green.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PostgresDialect } from 'kysely';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SeriesResponse, SessionResponse } from '@sgm/shared';
import { registerJobs } from '../../src/jobs/bootstrap.ts';
import { QUEUES, QUEUE_NAMES } from '../../src/jobs/registry.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import { createJobRunner, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import { createInMemoryNotifier } from '../../src/lib/notifications/adapters/in-memory.ts';
import { materialiseRule, type MaterialiseDeps } from '../../src/modules/sessions/materialise.ts';
import { testCrypto } from '../helpers/app-deps.ts';
import { START_TIME, bearer, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  insertAuthSession,
  insertRegistration,
  insertTeamMember,
  insertUser,
} from '../helpers/factories.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import { createQueryRecorder, createRecordingDatabase } from '../helpers/query-recorder.ts';
import { createRecordingAllocator, createSessionsScene } from '../helpers/sessions-scene.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';
import { waitFor } from '../helpers/wait-for.ts';

let database: TestDatabase;
let h: AuthTestApp;
let producer: JobRunner;
const allocator = createRecordingAllocator();
const recorder = createQueryRecorder();

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 16 });
  const setup = createJobRunner({
    databaseUrl: database.url,
    logger: captureLogs().logger,
    role: 'worker',
  });
  await setup.start();
  for (const queue of QUEUES) await setup.defineQueue(queue);
  await setup.stop();
  producer = createJobRunner({
    databaseUrl: database.url,
    logger: captureLogs().logger,
    role: 'producer',
  });
  await producer.start();
  h = await buildAuthTestApp(database.pool, {
    db: createRecordingDatabase(new PostgresDialect({ pool: database.pool }), recorder),
    sessionAllocator: allocator,
    jobs: { enqueue: (queue, data, options) => producer.enqueue(queue, data, options) },
  });
});
afterAll(async () => {
  await h.close();
  await producer.stop();
  await database.close();
});
beforeEach(() => {
  h.clock.set(START_TIME);
  allocator.reset();
  allocator.enrols = true;
  allocator.promoted = [];
  recorder.reset();
});

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

interface Scene {
  readonly teamId: string;
  readonly adminId: string;
  readonly memberId: string;
  readonly admin: string;
}

async function scene(): Promise<Scene> {
  const base = await createSessionsScene(database.pool, { payoutConfigured: true });
  const { token } = await insertAuthSession(database.pool, base.adminId, {
    createdAt: h.clock.now(),
    idleDays: 90,
    absoluteDays: 180,
  });
  return { ...base, admin: token };
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
    headers: bearer(token),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

type Body = Record<string, unknown>;
const sessionOf = (res: LightMyRequestResponse): SessionResponse =>
  res.json<{ session: SessionResponse }>().session;

function createBody(over: Body = {}): Body {
  return {
    createKey: randomUUID(),
    date: '2026-11-04',
    location: 'Rosedale Badminton Centre',
    address: '12B John Glenn Avenue, Rosedale, Auckland 0632',
    maxPlayers: 20,
    reservedSeats: 2,
    // $200.00 over 20 players: a $10.00 suggested rate (paid).
    courtCost: '200.00',
    extraExpenses: '0.00',
    pricingStructure: 'FLAT',
    courts: [
      { identifier: 'Court 1', startTime: '19:00', endTime: '21:00' },
      { identifier: 'Court 2', startTime: '19:30', endTime: '21:30' },
    ],
    ...over,
  };
}
function editBody(body: Body, expectedVersion: number, over: Body = {}): Body {
  const rest: Body = { ...body };
  delete rest.createKey;
  return { ...rest, expectedVersion, ...over };
}

const base = (c: Scene): string => `/teams/${c.teamId}/sessions`;

async function publishedSession(
  c: Scene,
  over: Body = {},
): Promise<{ id: string; body: Body; version: number }> {
  const body = createBody(over);
  const created = await call('POST', base(c), c.admin, body);
  expect(created.statusCode, created.body).toBe(201);
  const id = sessionOf(created).id;
  const published = await call('POST', `${base(c)}/${id}/publish`, c.admin, {
    expectedVersion: 1,
  });
  expect(published.statusCode, published.body).toBe(200);
  return { id, body, version: sessionOf(published).version };
}

interface Row {
  id: string;
  status: string;
  pricing_structure: string;
  max_players: number;
  reserved_seats: number;
  starts_at: Date | null;
  ends_at: Date | null;
  cancellation_deadline: Date;
  calculated_rate_per_player: string | null;
  custom_player_rate: string | null;
  fee_flat: string | null;
  fee_male: string | null;
  fee_female: string | null;
  fee_other: string | null;
  fee_beginner: string | null;
  fee_intermediate: string | null;
  fee_advanced: string | null;
  courts: string;
  auto_enrolled_at: Date | null;
}

async function rowOf(id: string): Promise<Row> {
  const { rows } = await database.pool.query<Row>(
    `SELECT s.*, (SELECT count(*) FROM session_courts c WHERE c.session_id = s.id)::text AS courts
       FROM game_sessions s WHERE s.id = $1`,
    [id],
  );
  const found = rows[0];
  if (found === undefined) throw new Error('no such session');
  return found;
}

/** The part of a registration row a cancel must not touch. */
async function registrationsOf(sessionId: string): Promise<unknown[]> {
  const { rows } = await database.pool.query<Record<string, unknown>>(
    `SELECT id, user_id, status, queue_position, guest_count, registered_at, updated_at
       FROM registrations WHERE session_id = $1 ORDER BY id`,
    [sessionId],
  );
  return rows;
}

async function withRegistration(
  c: Scene,
  sessionId: string,
  status: 'CONFIRMED' | 'WAITLISTED' | 'WITHDRAWN',
  queuePosition: number | null = null,
  withdrawalFeeDue = false,
): Promise<string> {
  const userId = await insertUser(database.pool, 'FEMALE');
  await insertTeamMember(database.pool, { teamId: c.teamId, userId });
  return insertRegistration(database.pool, {
    sessionId,
    teamId: c.teamId,
    userId,
    status,
    queuePosition,
    withdrawalFeeDue,
  });
}

/** `FOR UPDATE NOWAIT` from ANOTHER connection: true when the session row is currently locked by an open transaction. */
async function sessionRowIsLocked(sessionId: string): Promise<boolean> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM game_sessions WHERE id = $1 FOR UPDATE NOWAIT', [sessionId]);
    return false;
  } catch (error) {
    if ((error as { code?: string }).code === '55P03') return true;
    throw error;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

// ---------------------------------------------------------------------------------------------
// Output 1 and C-SSE-1, C-SSE-2: every published session is complete
// ---------------------------------------------------------------------------------------------

describe('every PUBLISHED session has what registration needs (assumed output 1, C-SSE-1, C-SSE-2)', () => {
  it('holds for each pricing structure, a free session, many courts and series instances published through the service', async () => {
    const c = await scene();
    const made: { id: string; body: Body }[] = [];
    for (const over of [
      {},
      { courtCost: '0.00' },
      { pricingStructure: 'BY_SEX', feeMale: '12.00', feeFemale: '10.00', courtCost: '0.00' },
      {
        pricingStructure: 'BY_SKILL_LEVEL',
        feeBeginner: '8.00',
        feeIntermediate: '10.00',
        feeAdvanced: '12.00',
        courtCost: '0.00',
      },
      {
        maxPlayers: 36,
        reservedSeats: 4,
        courts: Array.from({ length: 9 }, (_, index) => ({
          identifier: `Court ${index + 1}`,
          startTime: '08:00',
          endTime: '10:00',
        })),
      },
    ] as Body[]) {
      const { id, body } = await publishedSession(c, over);
      made.push({ id, body });
    }

    // Series instances come from the real materialiser, through a real series created over the API.
    const seriesRes = await call('POST', `/teams/${c.teamId}/session-series`, c.admin, {
      createKey: randomUUID(),
      frequency: 'WEEKLY',
      dayOfWeek: 3,
      startsOn: '2026-10-14',
      monthlyWeek: null,
      recurUntil: null,
      location: 'Series Hall',
      address: '1 Series Street, Auckland',
      maxPlayers: 24,
      reservedSeats: 0,
      courtCost: '240.00',
      extraExpenses: '0.00',
      pricingStructure: 'FLAT',
      courts: [{ identifier: 'Court 1', startTime: '19:00', endTime: '21:00' }],
    });
    expect(seriesRes.statusCode, seriesRes.body).toBe(201);
    const ruleId = seriesRes.json<{ series: SeriesResponse }>().series.id;
    const deps: MaterialiseDeps = {
      db: h.db,
      clock: h.clock,
      allocator,
      jobs: { enqueue: (queue, data, options) => producer.enqueue(queue, data, options) },
      notice: { webBaseUrl: 'https://app.example.test', sendEmail: () => Promise.resolve() },
      log: captureLogs().logger,
      horizonDays: 28,
    };
    const run = await materialiseRule(deps, { ruleId, teamId: c.teamId, trigger: 'rule_created' });
    expect(run.failed).toBe(0);
    expect(run.published).toBeGreaterThanOrEqual(3);

    const { rows: published } = await database.pool.query<{ id: string }>(
      `SELECT id FROM game_sessions WHERE team_id = $1 AND status = 'PUBLISHED'`,
      [c.teamId],
    );
    expect(published).toHaveLength(made.length + run.published);
    for (const { id } of published) {
      const row = await rowOf(id);
      const label = `${row.pricing_structure} ${id}`;
      expect(Number(row.courts), label).toBeGreaterThanOrEqual(1);
      expect(row.starts_at, label).toBeInstanceOf(Date);
      expect(row.ends_at, label).toBeInstanceOf(Date);
      expect((row.ends_at as Date).getTime(), label).toBeGreaterThan(
        (row.starts_at as Date).getTime(),
      );
      expect(row.cancellation_deadline.getTime(), label).toBeLessThanOrEqual(
        (row.starts_at as Date).getTime(),
      );
      if (row.pricing_structure === 'FLAT') expect(row.fee_flat, label).not.toBeNull();
      if (row.pricing_structure === 'BY_SEX') {
        expect([row.fee_male, row.fee_female, row.fee_other], label).not.toContain(null);
      }
      if (row.pricing_structure === 'BY_SKILL_LEVEL') {
        expect([row.fee_beginner, row.fee_intermediate, row.fee_advanced], label).not.toContain(
          null,
        );
      }
    }

    // The final capacity and reserved seats are the saved ones.
    const [flat, free, sex, skill, big] = made;
    expect(await rowOf(flat?.id ?? '')).toMatchObject({ max_players: 20, reserved_seats: 2 });
    expect(await rowOf(big?.id ?? '')).toMatchObject({ max_players: 36, reserved_seats: 4 });
    expect(await rowOf(free?.id ?? '')).toMatchObject({ fee_flat: '0.00' });
    // BY_SEX: the unset "other" fee defaults (platform-foundation) to the lower of the two.
    expect(await rowOf(sex?.id ?? '')).toMatchObject({
      fee_male: '12.00',
      fee_female: '10.00',
      fee_other: '10.00',
    });
    expect(await rowOf(skill?.id ?? '')).toMatchObject({
      fee_beginner: '8.00',
      fee_intermediate: '10.00',
      fee_advanced: '12.00',
    });
  });

  it('keeps fee_flat equal to the edited FLAT rate, also after a rate decrease on a published session that has a registered player', async () => {
    const c = await scene();
    const s = await publishedSession(c);
    expect(await rowOf(s.id)).toMatchObject({ fee_flat: '10.00', custom_player_rate: null });

    await withRegistration(c, s.id, 'CONFIRMED');
    const pinned = await call(
      'PUT',
      `${base(c)}/${s.id}`,
      c.admin,
      editBody(s.body, s.version, { customPlayerRate: '8.00' }),
    );
    expect(pinned.statusCode, pinned.body).toBe(200);
    // The rate the admin typed, not the suggestion ($10.00) that is still stored beside it.
    expect(await rowOf(s.id)).toMatchObject({
      fee_flat: '8.00',
      custom_player_rate: '8.00',
      calculated_rate_per_player: '10.00',
    });

    // A raise is refused while a player is registered, and fee_flat is untouched.
    const raised = await call(
      'PUT',
      `${base(c)}/${s.id}`,
      c.admin,
      editBody(s.body, sessionOf(pinned).version, { customPlayerRate: '9.00' }),
    );
    expect(raised.statusCode).toBe(409);
    expect((await rowOf(s.id)).fee_flat).toBe('8.00');
  });

  it('is held by the database: a PUBLISHED session cannot lose its flat fee or its last court, and a closed one never reopens', async () => {
    const c = await scene();
    const s = await publishedSession(c);
    await expect(
      database.pool.query(`UPDATE game_sessions SET fee_flat = NULL WHERE id = $1`, [s.id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'game_sessions_flat_fee_when_live' });

    const cancelled = await call('POST', `${base(c)}/${s.id}/cancel`, c.admin, {
      expectedVersion: s.version,
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    await expect(
      database.pool.query(`UPDATE game_sessions SET status = 'PUBLISHED' WHERE id = $1`, [s.id]),
    ).rejects.toMatchObject({ code: '23000', constraint: 'game_sessions_status_transition' });
  });
});

// ---------------------------------------------------------------------------------------------
// Output 3: the player page is registration's; the admin pages stay under /manage/sessions
// ---------------------------------------------------------------------------------------------

describe("the player session page is registration-and-waitlist's (assumed output 3, R23)", () => {
  // Phase 5 of registration-and-waitlist flips this from "no page exists" to "the page exists and is registration's".
  const teamRoot = fileURLToPath(new URL('../../../web/src/app/teams/[teamId]', import.meta.url));
  const playerRoot = `${teamRoot}/sessions`;

  it("ships the player page at /teams/[teamId]/sessions/[sessionId], and it is registration's panel over the registration read model", () => {
    const pagePath = `${playerRoot}/[sessionId]/page.tsx`;
    expect(existsSync(pagePath)).toBe(true);
    const source = readFileSync(pagePath, 'utf8');
    // registration's slot: the panel, fed by GET .../registration (a MEMBER route), never SSE's TEAM_ADMIN GET .../sessions/:id
    expect(source).toContain('RegistrationPanel');
    expect(source).toContain('PlayerSessionSummary');
    expect(source).toContain('sessionRegistration(');
    expect(source).not.toContain('getSession(');
    expect(source).not.toContain('/manage/sessions');
  });

  it('keeps the admin pages under /manage/sessions: the player tree holds only the [sessionId] page, SSE owns the rest', () => {
    // nothing else lives at /teams/[teamId]/sessions (no list, no /new, no series): those are SSE's, under /manage
    expect(readdirSync(playerRoot).sort()).toEqual(['[sessionId]']);
    for (const adminPage of [
      'manage/sessions/page.tsx',
      'manage/sessions/new/page.tsx',
      'manage/sessions/[sessionId]/page.tsx',
      'manage/sessions/series/new/page.tsx',
      'manage/sessions/series/[ruleId]/page.tsx',
    ]) {
      expect(existsSync(`${teamRoot}/${adminPage}`), adminPage).toBe(true);
    }
    // and the admin session component is not what the player page renders
    const playerPage = readFileSync(`${playerRoot}/[sessionId]/page.tsx`, 'utf8');
    expect(playerPage).not.toMatch(/components\/teams\/session-summary/);
  });
});

// ---------------------------------------------------------------------------------------------
// C-SSE-3, C-SSE-5: capacity edits
// ---------------------------------------------------------------------------------------------

describe('a capacity raise calls promoteWaitlist once, in the edit transaction, after the session lock (C-SSE-3, C-SSE-5)', () => {
  /** The double's own view of the world at the moment `promoteWaitlist` is called. */
  interface Probe {
    lockedByCaller: boolean | undefined;
    lockStatementSeen: boolean | undefined;
    teamGateSeen: boolean | undefined;
  }
  function probeAt(sessionId: string): Probe {
    const probe: Probe = {
      lockedByCaller: undefined,
      lockStatementSeen: undefined,
      teamGateSeen: undefined,
    };
    const record = allocator.promoteWaitlist.bind(allocator);
    allocator.promoteWaitlist = async (ctx, input) => {
      if (input.sessionId === sessionId) {
        probe.lockedByCaller = await sessionRowIsLocked(sessionId);
        const lockAt = recorder.indexOf(/from "game_sessions" where "id" = \$1.*for update/);
        const keyShareAt = recorder.indexOf(/from "teams".*for key share/);
        probe.lockStatementSeen = lockAt !== -1;
        probe.teamGateSeen = keyShareAt !== -1 && keyShareAt < lockAt;
      }
      return record(ctx, input);
    };
    return probe;
  }
  const restore = allocator.promoteWaitlist.bind(allocator);
  beforeEach(() => {
    allocator.promoteWaitlist = restore;
  });

  it('raising max_players, or lowering reserved seats, calls it exactly once with the transaction; the session row is locked by that transaction and released after', async () => {
    const c = await scene();
    const s = await publishedSession(c);
    const probe = probeAt(s.id);
    recorder.reset();

    const bigger = await call(
      'PUT',
      `${base(c)}/${s.id}`,
      c.admin,
      editBody(s.body, s.version, { maxPlayers: 24, courtCost: '240.00' }),
    );
    expect(bigger.statusCode, bigger.body).toBe(200);
    expect(allocator.promoteCalls).toHaveLength(1);
    expect(allocator.promoteCalls[0]).toMatchObject({
      teamId: c.teamId,
      sessionId: s.id,
      inTransaction: true,
    });
    expect(allocator.promoteCalls[0]?.now).toEqual(h.clock.now());
    // At the call, the lock was already held by the caller's still-open transaction, and the gate came first.
    expect(probe).toEqual({ lockedByCaller: true, lockStatementSeen: true, teamGateSeen: true });
    // C-SSE-5: the lock does not outlive the edit.
    expect(await sessionRowIsLocked(s.id)).toBe(false);

    allocator.reset();
    const fewerReserved = await call(
      'PUT',
      `${base(c)}/${s.id}`,
      c.admin,
      editBody(s.body, sessionOf(bigger).version, {
        maxPlayers: 24,
        courtCost: '240.00',
        reservedSeats: 0,
      }),
    );
    expect(fewerReserved.statusCode, fewerReserved.body).toBe(200);
    expect(allocator.promoteCalls).toHaveLength(1);
  });

  it('a cut, an unrelated edit, a raise on a draft and a raise after the start call nothing and demote nobody', async () => {
    const c = await scene();
    const s = await publishedSession(c);
    await withRegistration(c, s.id, 'CONFIRMED');
    const before = await registrationsOf(s.id);

    const cut = await call(
      'PUT',
      `${base(c)}/${s.id}`,
      c.admin,
      editBody(s.body, s.version, { maxPlayers: 10, courtCost: '100.00' }),
    );
    expect(cut.statusCode, cut.body).toBe(200);
    const place = await call(
      'PUT',
      `${base(c)}/${s.id}`,
      c.admin,
      editBody(s.body, sessionOf(cut).version, {
        maxPlayers: 10,
        courtCost: '100.00',
        location: 'Elsewhere',
      }),
    );
    expect(place.statusCode, place.body).toBe(200);

    const draftBody = createBody();
    const draft = sessionOf(await call('POST', base(c), c.admin, draftBody));
    const raisedDraft = await call(
      'PUT',
      `${base(c)}/${draft.id}`,
      c.admin,
      editBody(draftBody, draft.version, { maxPlayers: 30, courtCost: '300.00' }),
    );
    expect(raisedDraft.statusCode, raisedDraft.body).toBe(200);

    h.clock.set(new Date('2026-11-04T07:30:00Z')); // 20:30 NZDT on the day: the session has started
    const started = await call(
      'PUT',
      `${base(c)}/${s.id}`,
      c.admin,
      editBody(s.body, sessionOf(place).version, {
        maxPlayers: 30,
        courtCost: '300.00',
        location: 'Elsewhere',
      }),
    );
    expect(started.statusCode).toBe(409);
    expect(started.json<{ error: { code: string } }>().error.code).toBe('session_started');

    expect(allocator.promoteCalls).toHaveLength(0);
    expect(await registrationsOf(s.id)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------
// C-SSE-4: cancel
// ---------------------------------------------------------------------------------------------

describe('cancelling changes no registration and calls no allocator (assumed output 2, C-SSE-4)', () => {
  it('leaves confirmed, waitlisted and withdrawn rows byte for byte, calls neither port method and queues no email', async () => {
    const c = await scene();
    const s = await publishedSession(c);
    await withRegistration(c, s.id, 'CONFIRMED');
    await withRegistration(c, s.id, 'WAITLISTED', 1);
    await withRegistration(c, s.id, 'WITHDRAWN');
    const before = await registrationsOf(s.id);
    allocator.reset();
    const emailsBefore = await database.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pgboss.job WHERE name = 'send-email'`,
    );

    const cancelled = await call('POST', `${base(c)}/${s.id}/cancel`, c.admin, {
      expectedVersion: s.version,
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    // The admin is told how many players are registered (the waitlisted and the confirmed one), nothing else happens.
    expect(cancelled.json<{ activeRegistrationCount: number }>().activeRegistrationCount).toBe(2);
    expect((await rowOf(s.id)).status).toBe('CANCELLED');
    expect(await registrationsOf(s.id)).toEqual(before);
    expect(allocator.promoteCalls).toHaveLength(0);
    expect(allocator.autoEnrolCalls).toHaveLength(0);
    const emailsAfter = await database.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pgboss.job WHERE name = 'send-email'`,
    );
    expect(emailsAfter.rows[0]?.n).toBe(emailsBefore.rows[0]?.n);
  });

  it('a session lock is taken FOR UPDATE for the cancel and is gone when the request ends (C-SSE-5)', async () => {
    const c = await scene();
    const s = await publishedSession(c);
    recorder.reset();
    const cancelled = await call('POST', `${base(c)}/${s.id}/cancel`, c.admin, {
      expectedVersion: s.version,
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(recorder.indexOf(/from "game_sessions" where "id" = \$1.*for update/)).toBeGreaterThan(
      -1,
    );
    expect(await sessionRowIsLocked(s.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// D-85: the predicate registration re-checks
// ---------------------------------------------------------------------------------------------

describe('the D-85 predicate is the contract registration re-checks', () => {
  it('is the function and trigger named in the header, counting CONFIRMED, WAITLISTED and a fee-due WITHDRAWN (R20)', async () => {
    const { rows } = await database.pool.query<{ def: string }>(
      `SELECT pg_get_functiondef('game_session_has_active_registrations(uuid)'::regprocedure) AS def`,
    );
    const def = rows[0]?.def ?? '';
    expect(def).toMatch(/STABLE/);
    expect(def.replaceAll(/\s+/g, ' ')).toContain(
      "r.session_id = p_session_id AND (r.status IN ('CONFIRMED', 'WAITLISTED') OR (r.status = 'WITHDRAWN' AND r.withdrawal_fee_due))",
    );
    const trigger = await database.pool.query(
      `SELECT 1 FROM pg_trigger WHERE tgname = 'game_sessions_fee_raise_locked' AND NOT tgisinternal`,
    );
    expect(trigger.rowCount).toBe(1);
  });
});

describe('a late withdrawal whose fee is still owed locks the fees but is not a registered player (AC-VERIFY-12)', () => {
  it('shows activeRegistrationCount 0 with feesLocked raise_only_blocked, refuses a raise 409, answers the cancel with 0, and unlocks on release', async () => {
    const c = await scene();
    const s = await publishedSession(c);
    const registrationId = await withRegistration(c, s.id, 'WITHDRAWN', null, true);

    const read = await call('GET', `${base(c)}/${s.id}`, c.admin);
    expect(read.statusCode, read.body).toBe(200);
    expect(sessionOf(read)).toMatchObject({
      activeRegistrationCount: 0,
      feesLocked: 'raise_only_blocked',
    });
    const listed = await call('GET', `${base(c)}?view=upcoming`, c.admin);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(
      listed.json<{ sessions: SessionResponse[] }>().sessions.find((x) => x.id === s.id),
    ).toMatchObject({ activeRegistrationCount: 0, feesLocked: 'raise_only_blocked' });

    const raise = await call(
      'PUT',
      `${base(c)}/${s.id}`,
      c.admin,
      editBody(s.body, s.version, { courtCost: '720.00' }),
    );
    expect(raise.statusCode, raise.body).toBe(409);
    expect(raise.json<{ error: { code: string } }>().error.code).toBe('session_fee_locked');

    // The fee is released (R2): nothing is locked any more, and the raise goes through.
    await database.pool.query(`UPDATE registrations SET withdrawal_fee_due = false WHERE id = $1`, [
      registrationId,
    ]);
    const released = await call('GET', `${base(c)}/${s.id}`, c.admin);
    expect(sessionOf(released)).toMatchObject({ activeRegistrationCount: 0, feesLocked: null });
    const raised = await call(
      'PUT',
      `${base(c)}/${s.id}`,
      c.admin,
      editBody(s.body, s.version, { courtCost: '720.00' }),
    );
    expect(raised.statusCode, raised.body).toBe(200);
  });

  it('cancelling such a session reports the display count: only a confirmed or waitlisted player is let known', async () => {
    const c = await scene();
    const s = await publishedSession(c);
    await withRegistration(c, s.id, 'WITHDRAWN', null, true);
    const cancelled = await call('POST', `${base(c)}/${s.id}/cancel`, c.admin, {
      expectedVersion: s.version,
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json<{ activeRegistrationCount: number }>().activeRegistrationCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// The header is itself part of the contract
// ---------------------------------------------------------------------------------------------

describe('this file header lists the contract (AC-INTEGRATION-1)', () => {
  it('names the five assumed outputs, C-SSE-1..5, the port signature, the D-85 predicate and what registration re-checks', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const header = source.slice(0, source.indexOf('import { randomUUID }'));
    for (const needle of [
      'Assumed session-scheduling-engine outputs',
      '1) A session reaches',
      '2) The lifecycle is',
      '3) This feature ships NO player-facing session page',
      '4) A capacity edit',
      '5) The auto-enrol step',
      'C-SSE-1',
      'C-SSE-2',
      'C-SSE-3',
      'C-SSE-4',
      'C-SSE-5',
      'interface SessionAllocatorPort',
      'promoteWaitlist(ctx: SessionAllocatorContext',
      'autoEnrolInSession(ctx: SessionAllocatorContext',
      'createSessionAllocator()',
      'game_session_has_active_registrations',
      "IN ('CONFIRMED',",
      'withdrawal_fee_due',
      'already_registered',
      'promoteWaitlist(trx, sessionId, now)',
      'marker proof',
    ]) {
      expect(header, needle).toContain(needle);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Output 5 and the marker proof: a pending session is enrolled once a real allocator arrives
// ---------------------------------------------------------------------------------------------

describe('the marker proof: pending until an enrols:true allocator and a sweep (assumed output 5, AC-INTEGRATION-1)', () => {
  let worker: JobRunner;
  const workerLogs = captureLogs();

  beforeAll(async () => {
    // Earlier tests published sessions and series: take them out of the sweep so only this block's session counts.
    await database.pool.query(`UPDATE recurring_session_rules SET is_active = false`);
    await database.pool.query(
      `UPDATE game_sessions SET auto_enrol_required = false, auto_enrolled_at = NULL
        WHERE status IN ('DRAFT', 'PUBLISHED')`,
    );
    await database.pool.query(
      `DELETE FROM pgboss.job WHERE name IN ('session-auto-enrol', 'recurrence-rule')`,
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
      clock: h.clock,
      sessionAllocator: allocator,
      recurrenceHorizonDays: 28,
      webBaseUrl: 'https://app.example.test',
    });
  });
  afterAll(async () => {
    await worker?.stop();
  });

  it('an admin-published session stays pending under enrols:false, then is enrolled exactly once, in order, and stamped', async () => {
    allocator.enrols = false;
    const c = await scene();
    const first = await insertUser(database.pool, 'MALE');
    const second = await insertUser(database.pool, 'FEMALE');
    for (const [userId, assignedAt] of [
      [first, '2026-10-01T00:00:00Z'],
      [second, '2026-10-02T00:00:00Z'],
    ] as const) {
      const membershipId = await insertTeamMember(database.pool, { teamId: c.teamId, userId });
      await database.pool.query(
        `UPDATE team_members SET is_auto_enroll = true, auto_enroll_assigned_at = $2 WHERE id = $1`,
        [membershipId, assignedAt],
      );
    }

    const s = await publishedSession(c);
    await waitFor(
      () =>
        workerLogs
          .lines()
          .find((line) => line.event === 'session.auto_enrol.port_noop' && line.sessionId === s.id),
      { timeoutMs: 20_000, label: 'the publish job to find the no-op port' },
    );
    const pending = await rowOf(s.id);
    expect(pending.auto_enrolled_at).toBeNull();
    expect(allocator.autoEnrolCalls.filter((call) => call.sessionId === s.id)).toHaveLength(0);

    // The deploy that wires registration: a real allocator, then the sweep that offers every pending session.
    allocator.enrols = true;
    await waitFor(
      async () =>
        (await worker.trigger(QUEUE_NAMES.recurrenceMaterialisation)) === null ? undefined : true,
      { timeoutMs: 10_000, label: 'a sweep to queue' },
    );
    await waitFor(async () => ((await rowOf(s.id)).auto_enrolled_at !== null ? true : undefined), {
      timeoutMs: 20_000,
      label: 'the pending session to be stamped',
    });

    const calls = allocator.autoEnrolCalls.filter((call) => call.sessionId === s.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ teamId: c.teamId, inTransaction: true });
    expect(calls[0]?.entries.map((entry) => entry.userId)).toEqual([first, second]);
    expect(calls[0]?.entries.map((entry) => entry.assignedAt.toISOString())).toEqual([
      '2026-10-01T00:00:00.000Z',
      '2026-10-02T00:00:00.000Z',
    ]);

    // A further sweep offers nothing: the marker makes the run a no-op.
    const sweeps = workerLogs
      .lines()
      .filter((l) => l.event === 'session.recurrence.sweep_completed');
    await waitFor(
      async () =>
        (await worker.trigger(QUEUE_NAMES.recurrenceMaterialisation)) === null ? undefined : true,
      { timeoutMs: 10_000, label: 'a second sweep to queue' },
    );
    await waitFor(
      () =>
        workerLogs.lines().filter((l) => l.event === 'session.recurrence.sweep_completed').length >
        sweeps.length
          ? true
          : undefined,
      { timeoutMs: 20_000, label: 'the second sweep' },
    );
    expect(allocator.autoEnrolCalls.filter((call) => call.sessionId === s.id)).toHaveLength(1);
  });
});
