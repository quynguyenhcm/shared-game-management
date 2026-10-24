/**
 * One-off sessions API, allocator seam and auto-enrol follow-up (session-scheduling-engine Phase 2) through the real
 * `buildApp` over a cloned PostgreSQL and a real pg-boss producer. ACs: AC-HAPPY-1..4, 8, 9, 11, 13; AC-HAPPY-12
 * (manual paths); AC-ASYNC-2 (the handler); AC-ERROR-1 (API), 3, 5, 7, 8, 10, 11 (labels); AC-VERIFY-2 (manual paths).
 *
 * Gate-before-lock is proven from the statements PostgreSQL actually received (`query-recorder.ts`), the demotion
 * race with a real row lock and `pg_stat_activity` (no sleeps).
 */
import { randomUUID } from 'node:crypto';
import { PostgresDialect } from 'kysely';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionResponse } from '@sgm/shared';
import { createKysely } from '../../src/lib/db/kysely.ts';
import { QUEUES } from '../../src/jobs/registry.ts';
import { createSessionAutoEnrolHandler } from '../../src/jobs/session-auto-enrol.ts';
import { createJobRunner, type JobContext, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import { runSessionAutoEnrol } from '../../src/modules/sessions/auto-enrol.ts';
import { START_TIME, bearer, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  insertAuthSession,
  insertRegistration,
  insertRule,
  insertSession,
  insertTeamMember,
  insertUser,
} from '../helpers/factories.ts';
import { waitForLockWaiters } from '../helpers/lock-waiters.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import { createQueryRecorder, createRecordingDatabase } from '../helpers/query-recorder.ts';
import { createRecordingAllocator, createSessionsScene } from '../helpers/sessions-scene.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

let database: TestDatabase;
let h: AuthTestApp;
let worker: JobRunner;
let producer: JobRunner;
const allocator = createRecordingAllocator();
const recorder = createQueryRecorder();
const enqueued: { queue: string; data: object; singletonKey: string | undefined }[] = [];
const workerLogs = captureLogs();

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 14 });
  // Queues must exist for a producer to send; nothing works them here (the handler is called directly).
  worker = createJobRunner({
    databaseUrl: database.url,
    logger: workerLogs.logger,
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
    db: createRecordingDatabase(new PostgresDialect({ pool: database.pool }), recorder),
    sessionAllocator: allocator,
    jobs: {
      enqueue: async (queue, data, options) => {
        enqueued.push({ queue, data, singletonKey: options?.singletonKey });
        return producer.enqueue(queue, data, options);
      },
    },
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
  allocator.reset();
  allocator.enrols = true;
  allocator.promoted = [];
  allocator.outcome = { ok: true, status: 'CONFIRMED' };
  recorder.reset();
  enqueued.length = 0;
});

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

interface Scene {
  readonly teamId: string;
  readonly adminId: string;
  readonly memberId: string;
  readonly otherTeamId: string;
  readonly admin: string;
  readonly member: string;
  readonly otherAdmin: string;
}

async function scene(options: { payout?: boolean } = {}): Promise<Scene> {
  const base = await createSessionsScene(database.pool, {
    payoutConfigured: options.payout ?? false,
  });
  const token = async (userId: string): Promise<string> =>
    (
      await insertAuthSession(database.pool, userId, {
        createdAt: h.clock.now(),
        idleDays: 90,
        absoluteDays: 180,
      })
    ).token;
  return {
    ...base,
    admin: await token(base.adminId),
    member: await token(base.memberId),
    otherAdmin: await token(base.otherAdminId),
  };
}

const call = (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  token: string | null,
  payload?: object,
): Promise<LightMyRequestResponse> =>
  h.app.inject({
    method,
    url,
    ...(token === null ? {} : { headers: bearer(token) }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

interface ApiError {
  error: {
    code: string;
    message: string;
    fieldErrors?: Record<string, string[]>;
    dstOptions?: {
      field: string;
      kind: string;
      options: { choice: string; localTime: string; instant: string }[];
    }[];
    raisedFields?: string[];
    current?: SessionResponse;
  };
}
const errorOf = (res: LightMyRequestResponse): ApiError['error'] => res.json<ApiError>().error;
const sessionOf = (res: LightMyRequestResponse): SessionResponse =>
  res.json<{ session: SessionResponse }>().session;

const nineCourts = (): { identifier: string; startTime: string; endTime: string }[] =>
  Array.from({ length: 9 }, (_, index) => {
    const identifier = `Court ${index + 1}`;
    if (identifier === 'Court 7') return { identifier, startTime: '08:00', endTime: '09:00' };
    if (identifier === 'Court 9') return { identifier, startTime: '09:00', endTime: '10:00' };
    return { identifier, startTime: '08:00', endTime: '10:00' };
  });

type Body = Record<string, unknown>;

function createBody(over: Body = {}): Body {
  return {
    createKey: randomUUID(),
    date: '2026-11-04',
    location: 'Rosedale Badminton Centre',
    address: '12B John Glenn Avenue, Rosedale, Auckland 0632',
    maxPlayers: 36,
    reservedSeats: 2,
    courtCost: '0.00',
    extraExpenses: '0.00',
    pricingStructure: 'FLAT',
    courts: nineCourts(),
    ...over,
  };
}
/** $360.00 over 36 players: a $10.00 rate, so the session is paid. */
const PAID = { courtCost: '360.00' };

/** The edit that re-sends `body` as it was created (no change), plus `over`. */
function editBody(body: Body, expectedVersion: number, over: Body = {}): Body {
  const rest: Body = { ...body };
  delete rest.createKey;
  return { ...rest, expectedVersion, ...over };
}

const base = (c: Scene) => `/teams/${c.teamId}/sessions`;

async function createSession(c: Scene, over: Body = {}): Promise<{ id: string; body: Body }> {
  const body = createBody(over);
  const res = await call('POST', base(c), c.admin, body);
  expect(res.statusCode, res.body).toBe(201);
  return { id: sessionOf(res).id, body };
}

async function publish(c: Scene, id: string, version: number): Promise<LightMyRequestResponse> {
  return call('POST', `${base(c)}/${id}/publish`, c.admin, { expectedVersion: version });
}

/** A PUBLISHED session made through the API (so its cost columns are coherent). */
async function publishedSession(
  c: Scene,
  over: Body = {},
): Promise<{ id: string; body: Body; version: number }> {
  const { id, body } = await createSession(c, over);
  const res = await publish(c, id, 1);
  expect(res.statusCode, res.body).toBe(200);
  return { id, body, version: sessionOf(res).version };
}

interface DbSession {
  status: string;
  version: number;
  recurring_rule_id: string | null;
  is_instance_overridden: boolean;
  deadline_is_default: boolean;
  auto_enrol_required: boolean;
  auto_enrolled_at: Date | null;
  create_key: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  cancellation_deadline: Date;
  updated_at: Date;
  date: string;
  max_players: number;
  reserved_seats: number;
  location: string;
  pricing_structure: string;
  calculated_rate_per_player: string | null;
  custom_player_rate: string | null;
  fee_flat: string | null;
  fee_male: string | null;
  fee_female: string | null;
  fee_other: string | null;
  fee_beginner: string | null;
  fee_intermediate: string | null;
  fee_advanced: string | null;
}

async function row(id: string): Promise<DbSession> {
  const { rows } = await database.pool.query<DbSession>(
    `SELECT *, date::text AS date FROM game_sessions WHERE id = $1`,
    [id],
  );
  const found = rows[0];
  if (found === undefined) throw new Error('no such session');
  return found;
}

async function courtsOf(id: string): Promise<[string, string, string][]> {
  const { rows } = await database.pool.query<{ i: string; s: string; e: string }>(
    `SELECT court_identifier AS i, to_char(start_time, 'HH24:MI') AS s, to_char(end_time, 'HH24:MI') AS e
       FROM session_courts WHERE session_id = $1 ORDER BY court_identifier`,
    [id],
  );
  return rows.map((r) => [r.i, r.s, r.e]);
}

async function autoEnrolJobs(sessionId: string): Promise<{ data: Record<string, unknown> }[]> {
  const { rows } = await database.pool.query<{ data: Record<string, unknown> }>(
    `SELECT data FROM pgboss.job WHERE name = 'session-auto-enrol' AND singleton_key = $1`,
    [`session-auto-enrol:${sessionId}`],
  );
  return rows;
}

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

// ---------------------------------------------------------------------------------------------
// AC-ERROR-8: every route refuses anyone who is not an admin of that team
// ---------------------------------------------------------------------------------------------

describe('access control (AC-ERROR-8)', () => {
  it('answers 401 anonymously and 403 to a member, another team admin and a stranger, on every route, changing nothing', async () => {
    const c = await scene({ payout: true });
    const sessionId = await insertSession(database.pool, c.teamId);
    const before = await row(sessionId);
    const routes: ['GET' | 'POST' | 'PUT', string, object | undefined][] = [
      ['GET', `${base(c)}?view=upcoming`, undefined],
      ['POST', base(c), createBody()],
      ['GET', `${base(c)}/${sessionId}`, undefined],
      ['PUT', `${base(c)}/${sessionId}`, editBody(createBody(), 1)],
      ['POST', `${base(c)}/${sessionId}/publish`, { expectedVersion: 1 }],
      ['POST', `${base(c)}/${sessionId}/cancel`, { expectedVersion: 1 }],
    ];
    for (const [method, url, payload] of routes) {
      expect((await call(method, url, null, payload)).statusCode, `anon ${method} ${url}`).toBe(
        401,
      );
      for (const [who, token] of [
        ['member', c.member],
        ['other admin', c.otherAdmin],
      ] as const) {
        const res = await call(method, url, token, payload);
        expect(res.statusCode, `${who} ${method} ${url}`).toBe(403);
        expect(errorOf(res).code).toBe('forbidden');
      }
    }
    // An unknown team gives the same 403 as a team the caller does not administer.
    const unknown = await call('GET', `/teams/${randomUUID()}/sessions?view=upcoming`, c.admin);
    expect(unknown.statusCode).toBe(403);
    expect(await row(sessionId)).toEqual(before);
  });

  it("answers 403 for another team's session id on a team the caller does administer (ruled 2026-10-24), 404 for an id that does not exist, and changes nothing", async () => {
    const c = await scene({ payout: true });
    const foreign = await insertSession(database.pool, c.otherTeamId);
    const before = await row(foreign);
    const routes = [
      ['GET', '', undefined],
      ['PUT', '', editBody(createBody(), 1)],
      ['POST', '/publish', { expectedVersion: 1 }],
      ['POST', '/cancel', { expectedVersion: 1 }],
    ] as const;
    for (const [method, suffix, payload] of routes) {
      const res = await call(method, `${base(c)}/${foreign}${suffix}`, c.admin, payload);
      expect(res.statusCode, `${method} ${suffix}`).toBe(403);
      // The same body as any other refusal: it names no team, session or detail of the other team's row.
      expect(res.json<ApiError>()).toEqual({
        error: { code: 'forbidden', message: 'You do not have permission to do that.' },
      });
      const missing = await call(method, `${base(c)}/${randomUUID()}${suffix}`, c.admin, payload);
      expect(missing.statusCode, `missing ${method} ${suffix}`).toBe(404);
      expect(errorOf(missing).code).toBe('not_found');
    }
    expect(await row(foreign)).toEqual(before);
    expect(enqueued).toHaveLength(0);
  });

  it('re-checks the actor inside the write transaction: an admin demoted while the request waits gets 403', async () => {
    const c = await scene();
    const { id, body } = await createSession(c);
    // A second admin first (a team must keep one), then demote the actor in an open transaction.
    await database.pool.query(
      `UPDATE team_members SET role = 'TEAM_ADMIN' WHERE team_id = $1 AND user_id = $2`,
      [c.teamId, c.memberId],
    );
    const demoter = await database.pool.connect();
    try {
      await demoter.query('BEGIN');
      await demoter.query(
        `UPDATE team_members SET role = 'MEMBER' WHERE team_id = $1 AND user_id = $2`,
        [c.teamId, c.adminId],
      );
      // The guard reads the committed (admin) row and lets the request in; the in-transaction re-check waits.
      const pending = call(
        'PUT',
        `${base(c)}/${id}`,
        c.admin,
        editBody(body, 1, { maxPlayers: 40 }),
      );
      await waitForLockWaiters(database.pool, 1, 'blocked actor re-check');
      await demoter.query('COMMIT');
      const res = await pending;
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).code).toBe('forbidden');
    } finally {
      demoter.release();
    }
    expect((await row(id)).max_players).toBe(36);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-HAPPY-1, AC-HAPPY-11: create, replay, default and explicit deadline
// ---------------------------------------------------------------------------------------------

describe('create a one-off draft (AC-HAPPY-1, AC-HAPPY-11)', () => {
  it('stores the 9-court draft with trigger-derived instants and the 48 hour default deadline, and replays a createKey', async () => {
    const c = await scene();
    const body = createBody();
    const res = await call('POST', base(c), c.admin, body);
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const created = sessionOf(res);
    expect(created).toMatchObject({
      status: 'DRAFT',
      phase: 'upcoming',
      draftReason: 'admin',
      recurringRuleId: null,
      version: 1,
      date: '2026-11-04',
      maxPlayers: 36,
      reservedSeats: 2,
      deadlineIsDefault: true,
      isInstanceOverridden: false,
      activeRegistrationCount: 0,
      feesLocked: null,
      startsAt: '2026-11-03T19:00:00.000Z',
      endsAt: '2026-11-03T21:00:00.000Z',
      cancellationDeadline: '2026-11-01T19:00:00.000Z',
    });
    expect(
      created.courts.map((court) => [court.identifier, court.startTime, court.endTime]),
    ).toEqual([...nineCourts()].map((court) => [court.identifier, court.startTime, court.endTime]));
    expect(res.json<{ promoted: number; material: boolean }>()).toMatchObject({
      promoted: 0,
      material: false,
    });

    const stored = await row(created.id);
    expect(stored).toMatchObject({
      status: 'DRAFT',
      version: 1,
      recurring_rule_id: null,
      auto_enrol_required: true,
      auto_enrolled_at: null,
      deadline_is_default: true,
      create_key: body.createKey,
      is_instance_overridden: false,
    });
    expect(iso(stored.starts_at)).toBe('2026-11-03T19:00:00.000Z');
    expect(iso(stored.cancellation_deadline)).toBe('2026-11-01T19:00:00.000Z');
    expect(await courtsOf(created.id)).toHaveLength(9);

    const replay = await call('POST', base(c), c.admin, body);
    expect(replay.statusCode).toBe(200);
    expect(sessionOf(replay).id).toBe(created.id);
    const { rows } = await database.pool.query(`SELECT 1 FROM game_sessions WHERE team_id = $1`, [
      c.teamId,
    ]);
    expect(rows).toHaveLength(1);
    expect(enqueued).toHaveLength(0);
  });

  it('keeps an explicit deadline as entered and refuses a later start move that would break it', async () => {
    const c = await scene();
    const explicit = { date: '2026-11-02', time: '18:00' };
    const { id, body } = await createSession(c, { cancellationDeadline: explicit });
    // 18:00 NZDT on 2 Nov is 05:00Z.
    expect(iso((await row(id)).cancellation_deadline)).toBe('2026-11-02T05:00:00.000Z');
    expect(await row(id)).toMatchObject({ deadline_is_default: false });

    // Courts moving a little earlier keep the deadline as entered.
    const moved = await call(
      'PUT',
      `${base(c)}/${id}`,
      c.admin,
      editBody(body, 1, {
        courts: [{ identifier: 'Court 1', startTime: '07:00', endTime: '10:00' }],
      }),
    );
    expect(moved.statusCode, moved.body).toBe(200);
    expect(await row(id)).toMatchObject({ deadline_is_default: false });
    expect(iso((await row(id)).cancellation_deadline)).toBe('2026-11-02T05:00:00.000Z');

    // Moving the date so the deadline would fall after the start is refused, nothing saved.
    const version = sessionOf(moved).version;
    const refused = await call(
      'PUT',
      `${base(c)}/${id}`,
      c.admin,
      editBody(body, version, {
        date: '2026-11-02',
        courts: [{ identifier: 'Court 1', startTime: '07:00', endTime: '10:00' }],
      }),
    );
    expect(refused.statusCode).toBe(422);
    expect(errorOf(refused).fieldErrors).toEqual({
      cancellationDeadline: ['The deadline must be before the first court starts.'],
    });
    expect((await row(id)).date).toBe('2026-11-04');
  });

  it('refuses invalid input field by field and saves nothing', async () => {
    const c = await scene();
    const cases: [Body, string][] = [
      [{ date: '2026-10-05' }, 'date'],
      [{ date: 'not a date' }, 'date'],
      [{ courts: [] }, 'courts'],
      [
        {
          courts: [
            { identifier: 'Court 1', startTime: '08:00', endTime: '09:00' },
            { identifier: 'Court 1', startTime: '08:00', endTime: '09:00' },
          ],
        },
        'courts.1.identifier',
      ],
      [
        { courts: [{ identifier: 'Court 1', startTime: '09:00', endTime: '08:00' }] },
        'courts.0.endTime',
      ],
      [{ maxPlayers: 0 }, 'maxPlayers'],
      [{ reservedSeats: 40 }, 'reservedSeats'],
      [{ courtCost: '-1.00' }, 'courtCost'],
      [{ extraExpenses: '1.234' }, 'extraExpenses'],
      [{ location: '   ' }, 'location'],
      [{ status: 'PUBLISHED' }, '_form'],
      [{ cancellationDeadline: { date: '2026-11-04', time: '09:00' } }, 'cancellationDeadline'],
    ];
    for (const [over, field] of cases) {
      const res = await call('POST', base(c), c.admin, createBody(over));
      expect(res.statusCode, field).toBe(422);
      expect(errorOf(res).code).toBe('validation_failed');
      expect(Object.keys(errorOf(res).fieldErrors ?? {}), field).toContain(field);
    }
    const past = await call('POST', base(c), c.admin, createBody({ date: '2026-10-05' }));
    expect(errorOf(past).fieldErrors?.date).toEqual(["Choose today's date or a later one."]);
    const { rows } = await database.pool.query(`SELECT 1 FROM game_sessions WHERE team_id = $1`, [
      c.teamId,
    ]);
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-ERROR-3: DST (T6-T8)
// ---------------------------------------------------------------------------------------------

describe('DST times through the API (AC-ERROR-3, T6-T8)', () => {
  it('T6: a court start in the spring-forward gap is refused with both real times, and the chosen one is stored', async () => {
    const c = await scene();
    const gap = {
      date: '2027-09-26',
      courts: [{ identifier: 'Court 1', startTime: '02:30', endTime: '04:00' }],
    };
    const refused = await call('POST', base(c), c.admin, createBody(gap));
    expect(refused.statusCode).toBe(422);
    expect(errorOf(refused).fieldErrors).toEqual({
      'courts.0.startTime': ['local_time_nonexistent'],
    });
    expect(errorOf(refused).dstOptions?.[0]).toMatchObject({
      field: 'courts.0.startTime',
      kind: 'nonexistent',
      options: [
        { choice: 'shiftedForward', localTime: '03:30', instant: '2027-09-25T14:30:00.000Z' },
        { choice: 'shiftedBackward', localTime: '01:30', instant: '2027-09-25T13:30:00.000Z' },
      ],
    });
    const { rows } = await database.pool.query(`SELECT 1 FROM game_sessions WHERE team_id = $1`, [
      c.teamId,
    ]);
    expect(rows).toHaveLength(0);

    const chosen = await call(
      'POST',
      base(c),
      c.admin,
      createBody({
        date: '2027-09-26',
        courts: [{ identifier: 'Court 1', startTime: '03:30', endTime: '04:30' }],
      }),
    );
    expect(chosen.statusCode).toBe(201);
  });

  it('T7: an overlap start offers the first 2:30 only; resubmitting with earlier stores 02:30', async () => {
    const c = await scene();
    const overlap = { date: '2027-04-04' };
    const refused = await call(
      'POST',
      base(c),
      c.admin,
      createBody({
        ...overlap,
        courts: [{ identifier: 'Court 1', startTime: '02:30', endTime: '04:00' }],
      }),
    );
    expect(refused.statusCode).toBe(422);
    expect(errorOf(refused).fieldErrors).toEqual({
      'courts.0.startTime': ['local_time_ambiguous'],
    });
    expect(errorOf(refused).dstOptions?.[0]?.options).toEqual([
      { choice: 'earlier', localTime: '02:30', instant: '2027-04-03T13:30:00.000Z' },
    ]);
    const accepted = await call(
      'POST',
      base(c),
      c.admin,
      createBody({
        ...overlap,
        courts: [
          {
            identifier: 'Court 1',
            startTime: '02:30',
            endTime: '04:00',
            startDisambiguation: 'earlier',
          },
        ],
      }),
    );
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(await courtsOf(sessionOf(accepted).id)).toEqual([['Court 1', '02:30', '04:00']]);
    expect(sessionOf(accepted).startsAt).toBe('2027-04-03T13:30:00.000Z');
  });

  it('T8: an overlap deadline offers earlier and later; both are stored as given', async () => {
    const c = await scene();
    const deadline = { date: '2027-04-04', time: '02:30' };
    const body = (over: object) =>
      createBody({
        date: '2027-04-10',
        courts: [{ identifier: 'Court 1', startTime: '18:00', endTime: '20:00' }],
        ...over,
      });
    const refused = await call('POST', base(c), c.admin, body({ cancellationDeadline: deadline }));
    expect(refused.statusCode).toBe(422);
    expect(errorOf(refused).dstOptions?.[0]).toMatchObject({
      field: 'cancellationDeadline',
      kind: 'ambiguous',
    });
    expect(errorOf(refused).dstOptions?.[0]?.options.map((option) => option.choice)).toEqual([
      'earlier',
      'later',
    ]);
    for (const [disambiguation, instant] of [
      ['earlier', '2027-04-03T13:30:00.000Z'],
      ['later', '2027-04-03T14:30:00.000Z'],
    ] as const) {
      const res = await call(
        'POST',
        base(c),
        c.admin,
        body({ cancellationDeadline: { ...deadline, disambiguation } }),
      );
      expect(res.statusCode, res.body).toBe(201);
      expect(sessionOf(res)).toMatchObject({
        cancellationDeadline: instant,
        deadlineIsDefault: false,
      });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// AC-HAPPY-2, AC-HAPPY-3: costing and pricing through the API
// ---------------------------------------------------------------------------------------------

describe('costing and pricing (AC-HAPPY-2, AC-HAPPY-3)', () => {
  it('FLAT follows the suggestion until a rate is typed, then pins it; use-suggested clears the pin', async () => {
    const c = await scene();
    const costs = { courtCost: '120.00', extraExpenses: '12.00', maxPlayers: 12, reservedSeats: 0 };
    const { id, body } = await createSession(c, costs);
    expect(await row(id)).toMatchObject({
      calculated_rate_per_player: '11.00',
      custom_player_rate: null,
      fee_flat: '11.00',
    });

    // Following: more court hire moves the rate.
    const more = await call(
      'PUT',
      `${base(c)}/${id}`,
      c.admin,
      editBody(body, 1, { courtCost: '150.00' }),
    );
    expect(more.statusCode).toBe(200);
    expect(await row(id)).toMatchObject({ calculated_rate_per_player: '14.00', fee_flat: '14.00' });

    // Pinned: a typed rate sticks when costs change again.
    const pinned = await call(
      'PUT',
      `${base(c)}/${id}`,
      c.admin,
      editBody(body, sessionOf(more).version, { courtCost: '150.00', customPlayerRate: '9.50' }),
    );
    expect(sessionOf(pinned)).toMatchObject({ customPlayerRate: '9.50', feeFlat: '9.50' });
    const again = await call(
      'PUT',
      `${base(c)}/${id}`,
      c.admin,
      editBody(body, sessionOf(pinned).version, { courtCost: '300.00', customPlayerRate: '9.50' }),
    );
    expect(await row(id)).toMatchObject({
      calculated_rate_per_player: '26.00',
      custom_player_rate: '9.50',
      fee_flat: '9.50',
    });

    // "Use suggested rate" sends null: the pin is gone and fee_flat follows the suggestion.
    await call(
      'PUT',
      `${base(c)}/${id}`,
      c.admin,
      editBody(body, sessionOf(again).version, { courtCost: '300.00', customPlayerRate: null }),
    );
    expect(await row(id)).toMatchObject({ custom_player_rate: null, fee_flat: '26.00' });
  });

  it('BY_SEX stores the rates entered and defaults other to the lower, never overwriting a saved one; other models are cleared', async () => {
    const c = await scene();
    const sex = { pricingStructure: 'BY_SEX', feeMale: '12.00', feeFemale: '10.00' };
    const { id, body } = await createSession(c, sex);
    expect(await row(id)).toMatchObject({
      pricing_structure: 'BY_SEX',
      fee_male: '12.00',
      fee_female: '10.00',
      fee_other: '10.00',
      fee_flat: null,
      fee_beginner: null,
    });
    // Another save without feeOther: the saved value stays, even after the rates move.
    await database.pool.query(`UPDATE game_sessions SET fee_other = '9.00' WHERE id = $1`, [id]);
    const res = await call(
      'PUT',
      `${base(c)}/${id}`,
      c.admin,
      editBody(body, 2, { feeMale: '13.00' }),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(await row(id)).toMatchObject({ fee_male: '13.00', fee_other: '9.00' });

    const missing = await call(
      'POST',
      base(c),
      c.admin,
      createBody({ pricingStructure: 'BY_SEX', feeMale: '12.00' }),
    );
    expect(missing.statusCode).toBe(422);
    expect(errorOf(missing).fieldErrors).toEqual({ feeFemale: ['Enter an amount like 12.00.'] });
  });

  it('BY_SKILL_LEVEL stores the three rates (a draft may still be missing one)', async () => {
    const c = await scene();
    const { id } = await createSession(c, {
      pricingStructure: 'BY_SKILL_LEVEL',
      feeBeginner: '8.00',
      feeIntermediate: '10.00',
    });
    expect(await row(id)).toMatchObject({
      pricing_structure: 'BY_SKILL_LEVEL',
      fee_beginner: '8.00',
      fee_intermediate: '10.00',
      fee_advanced: null,
      fee_flat: null,
      custom_player_rate: null,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Edit: AC-ERROR-7 (stale, no-op), the version bump, instance overrides
// ---------------------------------------------------------------------------------------------

describe('edit a draft (AC-ERROR-7)', () => {
  it('replaces the courts, bumps the version once, and reports a material change', async () => {
    const c = await scene();
    const { id, body } = await createSession(c);
    const res = await call(
      'PUT',
      `${base(c)}/${id}`,
      c.admin,
      editBody(body, 1, {
        location: 'Rosedale Annexe',
        courts: [
          { identifier: 'Court 1', startTime: '08:00', endTime: '10:00' },
          { identifier: 'Court 3', startTime: '08:30', endTime: '10:00' },
        ],
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ material: boolean; promoted: number; changed: boolean }>()).toMatchObject({
      material: true,
      promoted: 0,
      changed: true,
    });
    expect(sessionOf(res)).toMatchObject({ version: 2, location: 'Rosedale Annexe' });
    expect(await courtsOf(id)).toEqual([
      ['Court 1', '08:00', '10:00'],
      ['Court 3', '08:30', '10:00'],
    ]);
    // The default deadline followed the start (08:00 on the 4th, still).
    expect(iso((await row(id)).cancellation_deadline)).toBe('2026-11-01T19:00:00.000Z');
  });

  it('answers 409 session_stale with the current row when expectedVersion is old, writing nothing', async () => {
    const c = await scene();
    const { id, body } = await createSession(c);
    const first = await call(
      'PUT',
      `${base(c)}/${id}`,
      c.admin,
      editBody(body, 1, { maxPlayers: 40 }),
    );
    expect(first.statusCode).toBe(200);
    const stale = await call(
      'PUT',
      `${base(c)}/${id}`,
      c.admin,
      editBody(body, 1, { maxPlayers: 50 }),
    );
    expect(stale.statusCode).toBe(409);
    expect(errorOf(stale).code).toBe('session_stale');
    expect(errorOf(stale).message).toContain('This session changed since you opened it.');
    expect(errorOf(stale).current).toMatchObject({ id, version: 2, maxPlayers: 40 });
    expect((await row(id)).max_players).toBe(40);

    // Stale publish and cancel carry the current row too.
    for (const suffix of ['publish', 'cancel']) {
      const res = await call('POST', `${base(c)}/${id}/${suffix}`, c.admin, { expectedVersion: 1 });
      expect(res.statusCode, suffix).toBe(409);
      expect(errorOf(res).code).toBe('session_stale');
      expect(errorOf(res).current?.version).toBe(2);
    }
    expect(await row(id)).toMatchObject({ status: 'DRAFT' });
  });

  it('a save that changes nothing answers 200 and writes nothing, whatever the version', async () => {
    const c = await scene();
    const { id, body } = await createSession(c);
    const before = await row(id);
    const same = await call('PUT', `${base(c)}/${id}`, c.admin, editBody(body, 1));
    expect(same.statusCode).toBe(200);
    expect(same.json<{ material: boolean; promoted: number; changed: boolean }>()).toMatchObject({
      material: false,
      promoted: 0,
      changed: false,
    });
    expect(sessionOf(same).version).toBe(1);
    // A stale expectedVersion with the same content is still a no-op, not a conflict.
    const real = await call(
      'PUT',
      `${base(c)}/${id}`,
      c.admin,
      editBody(body, 1, { maxPlayers: 40 }),
    );
    expect(real.json<{ changed: boolean }>().changed).toBe(true);
    const back = await call(
      'PUT',
      `${base(c)}/${id}`,
      c.admin,
      editBody(body, 1, { maxPlayers: 40 }),
    );
    expect(back.statusCode).toBe(200);
    // The version moved on (2 > the form's 1), yet nothing was written: `changed` says so, not the version.
    expect(back.json<{ changed: boolean }>().changed).toBe(false);
    expect(sessionOf(back).version).toBe(2);
    expect(await row(id)).toMatchObject({ version: 2, max_players: 40 });
    expect(iso(before.updated_at)).not.toBe(iso((await row(id)).updated_at));
  });

  it('a court-only edit still bumps version and updated_at (explicitly stamped)', async () => {
    const c = await scene();
    const { id, body } = await createSession(c);
    const before = await row(id);
    h.clock.advance(60_000);
    const courts = nineCourts().map((court) =>
      court.identifier === 'Court 9' ? { ...court, identifier: 'Court 9A' } : court,
    );
    const first = await call('PUT', `${base(c)}/${id}`, c.admin, editBody(body, 1, { courts }));
    expect(first.statusCode).toBe(200);
    expect(first.json<{ material: boolean }>().material).toBe(false);
    expect(sessionOf(first).version).toBe(2);
    expect((await row(id)).updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    // A second court-only edit at the same clock reading still advances the version.
    const second = await call(
      'PUT',
      `${base(c)}/${id}`,
      c.admin,
      editBody(body, 2, {
        courts: courts.map((court) =>
          court.identifier === 'Court 9A' ? { ...court, identifier: 'Court 9B' } : court,
        ),
      }),
    );
    expect(sessionOf(second).version).toBe(3);
  });
});

describe('a series date is edited without breaking the series (override flag)', () => {
  async function instance(c: Scene) {
    const { id, body } = await createSession(c, { date: '2026-11-04' });
    const ruleId = await insertRule(database.pool, c.teamId);
    await database.pool.query(`UPDATE game_sessions SET recurring_rule_id = $2 WHERE id = $1`, [
      id,
      ruleId,
    ]);
    return { id, body, ruleId };
  }

  it('sets is_instance_overridden on a real change only; publish and cancel never set it', async () => {
    const c = await scene({ payout: true });
    const { id, body } = await instance(c);
    const noop = await call('PUT', `${base(c)}/${id}`, c.admin, editBody(body, 2));
    expect(noop.statusCode).toBe(200);
    expect((await row(id)).is_instance_overridden).toBe(false);

    const changed = await call(
      'PUT',
      `${base(c)}/${id}`,
      c.admin,
      editBody(body, 2, { maxPlayers: 30 }),
    );
    expect(sessionOf(changed)).toMatchObject({ isInstanceOverridden: true, draftReason: 'edited' });
    expect((await row(id)).is_instance_overridden).toBe(true);

    const other = await instance(c);
    const published = await publish(c, other.id, 2);
    expect(published.statusCode, published.body).toBe(200);
    expect((await row(other.id)).is_instance_overridden).toBe(false);
    const cancelled = await call('POST', `${base(c)}/${other.id}/cancel`, c.admin, {
      expectedVersion: sessionOf(published).version,
    });
    expect(cancelled.statusCode).toBe(200);
    expect((await row(other.id)).is_instance_overridden).toBe(false);
  });

  it('refuses a change of the date of a series instance (422 on date)', async () => {
    const c = await scene();
    const { id, body } = await instance(c);
    const res = await call(
      'PUT',
      `${base(c)}/${id}`,
      c.admin,
      editBody(body, 2, { date: '2026-11-11' }),
    );
    expect(res.statusCode).toBe(422);
    expect(errorOf(res).fieldErrors).toEqual({
      date: ['To move this night, cancel it and create a one-off session.'],
    });
    expect((await row(id)).date).toBe('2026-11-04');
  });
});

// ---------------------------------------------------------------------------------------------
// AC-HAPPY-4, AC-ERROR-1, AC-ERROR-4: publish
// ---------------------------------------------------------------------------------------------

describe('publish (AC-HAPPY-4, AC-ERROR-1, AC-ERROR-4)', () => {
  it('publishes a paid session for a payout-configured team, stamps fee_flat, and enqueues exactly one auto-enrol job in the same transaction', async () => {
    const c = await scene({ payout: true });
    const { id } = await createSession(c, PAID);
    const res = await publish(c, id, 1);
    expect(res.statusCode, res.body).toBe(200);
    expect(sessionOf(res)).toMatchObject({
      status: 'PUBLISHED',
      feeFlat: '10.00',
      draftReason: null,
    });
    expect(await row(id)).toMatchObject({
      status: 'PUBLISHED',
      fee_flat: '10.00',
      auto_enrol_required: true,
      auto_enrolled_at: null,
    });
    expect(enqueued).toEqual([
      {
        queue: 'session-auto-enrol',
        data: { sessionId: id, teamId: c.teamId, trigger: 'publish' },
        singletonKey: `session-auto-enrol:${id}`,
      },
    ]);
    const jobs = await autoEnrolJobs(id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toMatchObject({ sessionId: id, teamId: c.teamId, trigger: 'publish' });

    // A replayed publish answers 200 and writes and enqueues nothing.
    enqueued.length = 0;
    const replay = await publish(c, id, 1);
    expect(replay.statusCode).toBe(200);
    expect(sessionOf(replay).status).toBe('PUBLISHED');
    expect(enqueued).toHaveLength(0);
    expect(await autoEnrolJobs(id)).toHaveLength(1);
  });

  it('a free session publishes with no gate and no banking, and also enqueues one auto-enrol job', async () => {
    const c = await scene({ payout: false });
    const { id } = await createSession(c);
    recorder.reset();
    const res = await publish(c, id, 1);
    expect(res.statusCode, res.body).toBe(200);
    expect(
      recorder.indexOf(/select "is_payout_configured", "payout_blocked_at" from "teams"/),
    ).toBe(-1);
    expect(enqueued.map((job) => job.queue)).toEqual(['session-auto-enrol']);
  });

  it('refuses a paid publish for a team without banking (409), keeps the draft and its earlier saved changes, enqueues nothing', async () => {
    const c = await scene({ payout: false });
    const { id, body } = await createSession(c, PAID);
    // Save-then-publish: the save part commits first.
    const saved = await call(
      'PUT',
      `${base(c)}/${id}`,
      c.admin,
      editBody(body, 1, { location: 'Saved first' }),
    );
    expect(saved.statusCode).toBe(200);
    enqueued.length = 0;
    recorder.reset();
    const res = await publish(c, id, sessionOf(saved).version);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res)).toMatchObject({
      code: 'payout_not_configured',
      message: "Add your team's bank account details before publishing a paid session.",
    });
    expect(await row(id)).toMatchObject({ status: 'DRAFT', location: 'Saved first', version: 2 });
    expect(enqueued).toHaveLength(0);
    expect(await autoEnrolJobs(id)).toHaveLength(0);
    // Nothing was written to the session by the refused publish.
    expect(recorder.indexOf(/update "game_sessions"/)).toBe(-1);
  });

  it('refuses incomplete pricing, no court and a start that has passed, and the session stays a draft', async () => {
    const c = await scene({ payout: true });
    const skill = await createSession(c, {
      pricingStructure: 'BY_SKILL_LEVEL',
      feeBeginner: '8.00',
      feeIntermediate: '10.00',
    });
    const incomplete = await publish(c, skill.id, 1);
    expect(incomplete.statusCode).toBe(422);
    expect(Object.keys(errorOf(incomplete).fieldErrors ?? {})).toEqual(['feeAdvanced']);

    const noCourt = await createSession(c);
    await database.pool.query(`DELETE FROM session_courts WHERE session_id = $1`, [noCourt.id]);
    const stored = await row(noCourt.id);
    const missing = await publish(c, noCourt.id, stored.version);
    expect(missing.statusCode).toBe(422);
    expect(errorOf(missing).fieldErrors).toEqual({ courts: ['Add at least one court.'] });

    const late = await createSession(c, { date: '2026-10-07' });
    h.clock.set(new Date('2026-10-07T07:00:00Z'));
    const expired = await publish(c, late.id, 1);
    expect(expired.statusCode).toBe(409);
    expect(errorOf(expired).code).toBe('session_started');

    for (const id of [skill.id, noCourt.id, late.id]) expect((await row(id)).status).toBe('DRAFT');
    expect(enqueued).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-VERIFY-2: the gate comes before any session lock or write on every manual path
// ---------------------------------------------------------------------------------------------

describe('the paid check reads the effective flat rate', () => {
  it('a FLAT draft with no stored fee_flat but a positive calculated rate is gated on publish', async () => {
    const c = await scene({ payout: false });
    const id = await insertSession(
      database.pool,
      c.teamId,
      { flat: null },
      { calculatedRate: '17.00', date: '2026-11-04' },
    );
    expect((await row(id)).fee_flat).toBeNull();
    const res = await publish(c, id, (await row(id)).version);
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).code).toBe('payout_not_configured');
    expect((await row(id)).status).toBe('DRAFT');
    expect(enqueued).toHaveLength(0);
  });
});

describe('gate before lock (AC-VERIFY-2, manual paths)', () => {
  const GATE = /select "is_payout_configured", "payout_blocked_at" from "teams".*for key share/;
  const SESSION_LOCK_OR_WRITE =
    /from "game_sessions".*for update|update "game_sessions"|insert into "game_sessions"|insert into "session_courts"|delete from "session_courts"|update "session_courts"/;

  it('manual publish of a paid session: the gate precedes the first session lock or write', async () => {
    const c = await scene({ payout: true });
    const id = await insertSession(database.pool, c.teamId, {}, { calculatedRate: '17.00' });
    recorder.reset();
    const res = await publish(c, id, 1);
    expect(res.statusCode, res.body).toBe(200);
    recorder.assertBefore(GATE, SESSION_LOCK_OR_WRITE);
  });

  it('create-and-publish: the session made through the API is gated before its publish locks or writes it', async () => {
    const c = await scene({ payout: true });
    const { id } = await createSession(c, PAID);
    recorder.reset();
    const res = await publish(c, id, 1);
    expect(res.statusCode, res.body).toBe(200);
    recorder.assertBefore(GATE, SESSION_LOCK_OR_WRITE);
  });

  it('an unconfigured team is refused after the gate and before any session lock or write', async () => {
    const c = await scene({ payout: false });
    const { id } = await createSession(c, PAID);
    recorder.reset();
    const res = await publish(c, id, 1);
    expect(res.statusCode).toBe(409);
    expect(recorder.indexOf(GATE)).toBeGreaterThan(-1);
    expect(recorder.indexOf(SESSION_LOCK_OR_WRITE)).toBe(-1);
  });

  it('an edit that turns a PUBLISHED session from free to paid is gated first, and refused with nothing saved when unconfigured', async () => {
    const ok = await scene({ payout: true });
    const free = await publishedSession(ok);
    recorder.reset();
    const paid = await call(
      'PUT',
      `${base(ok)}/${free.id}`,
      ok.admin,
      editBody(free.body, free.version, PAID),
    );
    expect(paid.statusCode, paid.body).toBe(200);
    recorder.assertBefore(GATE, SESSION_LOCK_OR_WRITE);

    const bad = await scene({ payout: false });
    const freeToo = await publishedSession(bad);
    recorder.reset();
    const refused = await call(
      'PUT',
      `${base(bad)}/${freeToo.id}`,
      bad.admin,
      editBody(freeToo.body, freeToo.version, PAID),
    );
    expect(refused.statusCode).toBe(409);
    expect(errorOf(refused).code).toBe('payout_not_configured');
    expect(recorder.indexOf(SESSION_LOCK_OR_WRITE)).toBe(-1);
    expect(await row(freeToo.id)).toMatchObject({
      status: 'PUBLISHED',
      version: freeToo.version,
      fee_flat: '0.00',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// AC-HAPPY-8: capacity edits and the waitlist
// ---------------------------------------------------------------------------------------------

describe('capacity edit on a published session (AC-HAPPY-8)', () => {
  it('raising capacity or lowering host seats calls promoteWaitlist once, in the edit transaction; a cut demotes nobody', async () => {
    const c = await scene();
    const s = await publishedSession(c);
    const joiners = [await insertUser(database.pool), await insertUser(database.pool)];
    for (const userId of joiners) {
      await insertTeamMember(database.pool, { teamId: c.teamId, userId });
    }
    const players = [c.memberId, ...joiners];
    const registrations = await Promise.all(
      players.map((userId) =>
        insertRegistration(database.pool, { sessionId: s.id, teamId: c.teamId, userId }),
      ),
    );
    allocator.promoted = [
      { registrationId: registrations[0] ?? '', userId: c.memberId, promotedAt: h.clock.now() },
      {
        registrationId: registrations[1] ?? '',
        userId: players[1] ?? '',
        promotedAt: h.clock.now(),
      },
    ];

    // Raise max players 36 -> 40.
    const raised = await call(
      'PUT',
      `${base(c)}/${s.id}`,
      c.admin,
      editBody(s.body, s.version, { maxPlayers: 40 }),
    );
    expect(raised.statusCode, raised.body).toBe(200);
    expect(raised.json<{ promoted: number; material: boolean }>()).toMatchObject({
      promoted: 2,
      material: false,
    });
    expect(allocator.promoteCalls).toEqual([
      { teamId: c.teamId, sessionId: s.id, now: expect.any(Date) as Date, inTransaction: true },
    ]);

    // Lower host seats 2 -> 1.
    allocator.reset();
    const seats = await call(
      'PUT',
      `${base(c)}/${s.id}`,
      c.admin,
      editBody(s.body, sessionOf(raised).version, { maxPlayers: 40, reservedSeats: 1 }),
    );
    expect(seats.statusCode).toBe(200);
    expect(allocator.promoteCalls).toHaveLength(1);

    // A cut (lower max, more host seats) is saved, calls nothing and changes no registration.
    allocator.reset();
    const cut = await call(
      'PUT',
      `${base(c)}/${s.id}`,
      c.admin,
      editBody(s.body, sessionOf(seats).version, { maxPlayers: 2, reservedSeats: 2 }),
    );
    expect(cut.statusCode, cut.body).toBe(200);
    expect(allocator.promoteCalls).toHaveLength(0);
    expect(await row(s.id)).toMatchObject({ max_players: 2, reserved_seats: 2 });
    const { rows } = await database.pool.query<{ status: string }>(
      `SELECT status FROM registrations WHERE session_id = $1`,
      [s.id],
    );
    expect(rows.map((r) => r.status)).toEqual(['CONFIRMED', 'CONFIRMED', 'CONFIRMED']);

    // A no-op and a non-capacity edit call nothing either.
    allocator.reset();
    await call(
      'PUT',
      `${base(c)}/${s.id}`,
      c.admin,
      editBody(s.body, sessionOf(cut).version, { maxPlayers: 2, reservedSeats: 2 }),
    );
    await call(
      'PUT',
      `${base(c)}/${s.id}`,
      c.admin,
      editBody(s.body, sessionOf(cut).version, {
        maxPlayers: 2,
        reservedSeats: 2,
        location: 'Elsewhere',
      }),
    );
    expect(allocator.promoteCalls).toHaveLength(0);
  });

  it('a draft capacity raise is saved and calls nothing: there is no waitlist before publishing', async () => {
    const c = await scene();
    const { id, body } = await createSession(c);
    const res = await call(
      'PUT',
      `${base(c)}/${id}`,
      c.admin,
      editBody(body, 1, { maxPlayers: 60 }),
    );
    expect(res.statusCode).toBe(200);
    expect(allocator.promoteCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-HAPPY-9, AC-HAPPY-13: cancel with counts, registered counts on changes
// ---------------------------------------------------------------------------------------------

describe('cancel and registered counts (AC-HAPPY-9, AC-HAPPY-13)', () => {
  it("cancels a draft with a zero count and leaves a published session's registrations alone, telling the admin how many", async () => {
    const c = await scene();
    const draft = await createSession(c);
    const gone = await call('POST', `${base(c)}/${draft.id}/cancel`, c.admin, {
      expectedVersion: 1,
    });
    expect(gone.statusCode).toBe(200);
    expect(gone.json<{ activeRegistrationCount: number }>().activeRegistrationCount).toBe(0);
    expect(sessionOf(gone)).toMatchObject({ status: 'CANCELLED', draftReason: null });

    const s = await publishedSession(c);
    const confirmed = await insertUser(database.pool);
    const waiting = await insertUser(database.pool);
    await insertTeamMember(database.pool, { teamId: c.teamId, userId: confirmed });
    await insertTeamMember(database.pool, { teamId: c.teamId, userId: waiting });
    await insertRegistration(database.pool, {
      sessionId: s.id,
      teamId: c.teamId,
      userId: confirmed,
    });
    await insertRegistration(database.pool, {
      sessionId: s.id,
      teamId: c.teamId,
      userId: waiting,
      status: 'WAITLISTED',
      queuePosition: 1,
    });
    const regsBefore = await database.pool.query(
      `SELECT id, status, queue_position FROM registrations WHERE session_id = $1 ORDER BY id`,
      [s.id],
    );
    allocator.reset();
    enqueued.length = 0;

    const cancelled = await call('POST', `${base(c)}/${s.id}/cancel`, c.admin, {
      expectedVersion: s.version,
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json<{ activeRegistrationCount: number }>().activeRegistrationCount).toBe(2);
    expect(sessionOf(cancelled)).toMatchObject({ status: 'CANCELLED', version: s.version + 1 });
    expect((await row(s.id)).status).toBe('CANCELLED');
    // C-SSE-4, P-2: registrations untouched, no allocator call, no email or job of any kind.
    const regsAfter = await database.pool.query(
      `SELECT id, status, queue_position FROM registrations WHERE session_id = $1 ORDER BY id`,
      [s.id],
    );
    expect(regsAfter.rows).toEqual(regsBefore.rows);
    expect(allocator.promoteCalls).toHaveLength(0);
    expect(allocator.autoEnrolCalls).toHaveLength(0);
    expect(enqueued).toHaveLength(0);

    // A cancelled session is closed: every further write is refused.
    for (const [method, url, payload] of [
      ['PUT', `${base(c)}/${s.id}`, editBody(s.body, s.version + 1)],
      ['POST', `${base(c)}/${s.id}/publish`, { expectedVersion: s.version + 1 }],
      ['POST', `${base(c)}/${s.id}/cancel`, { expectedVersion: s.version + 1 }],
    ] as const) {
      const res = await call(method, url, c.admin, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(409);
      expect(errorOf(res).code).toBe('session_not_editable');
    }
  });

  it('tells the admin how many players are registered on a material save, and none on a non-material one', async () => {
    const c = await scene();
    const s = await publishedSession(c);
    const player = await insertUser(database.pool);
    await insertTeamMember(database.pool, { teamId: c.teamId, userId: player });
    await insertRegistration(database.pool, { sessionId: s.id, teamId: c.teamId, userId: player });

    const detail = await call('GET', `${base(c)}/${s.id}`, c.admin);
    expect(sessionOf(detail)).toMatchObject({
      activeRegistrationCount: 1,
      feesLocked: 'raise_only_blocked',
    });

    const material = await call(
      'PUT',
      `${base(c)}/${s.id}`,
      c.admin,
      editBody(s.body, s.version, { location: 'New hall' }),
    );
    expect(material.statusCode, material.body).toBe(200);
    expect(material.json<{ material: boolean }>().material).toBe(true);
    expect(sessionOf(material).activeRegistrationCount).toBe(1);

    const plain = await call(
      'PUT',
      `${base(c)}/${s.id}`,
      c.admin,
      editBody(s.body, sessionOf(material).version, { location: 'New hall', maxPlayers: 50 }),
    );
    expect(plain.json<{ material: boolean }>().material).toBe(false);
    expect(sessionOf(plain).activeRegistrationCount).toBe(1);
    expect(enqueued.filter((job) => job.queue === 'send-email')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-ERROR-5: closed and started sessions
// ---------------------------------------------------------------------------------------------

describe('started and closed sessions (AC-ERROR-5, AC-ERROR-11)', () => {
  it('refuses every edit and cancel after the first court starts (409 session_started), with the clock read in TS', async () => {
    const c = await scene();
    const draft = await createSession(c, { date: '2026-10-07' });
    const live = await publishedSession(c, { date: '2026-10-07' });
    // 19:00 NZDT on 7 Oct is 06:00Z; the first court of the 9-court layout starts at 08:00, so 7 Oct 08:00 NZDT = 19:00Z on the 6th.
    h.clock.set(new Date('2026-10-06T20:00:00Z'));
    for (const [name, target] of [
      ['draft', draft],
      ['published', live],
    ] as const) {
      const version = target === draft ? 1 : live.version;
      const edit = await call(
        'PUT',
        `${base(c)}/${target.id}`,
        c.admin,
        editBody(target.body, version, { maxPlayers: 20 }),
      );
      expect(edit.statusCode, `${name} edit`).toBe(409);
      expect(errorOf(edit).code).toBe('session_started');
      const cancel = await call('POST', `${base(c)}/${target.id}/cancel`, c.admin, {
        expectedVersion: version,
      });
      expect(cancel.statusCode, `${name} cancel`).toBe(409);
      expect(errorOf(cancel).code).toBe('session_started');
    }
    expect((await row(live.id)).max_players).toBe(36);
    expect(sessionOf(await call('GET', `${base(c)}/${live.id}`, c.admin)).phase).toBe('started');
    // A replayed publish of a published session is still a harmless 200.
    expect((await publish(c, live.id, live.version)).statusCode).toBe(200);
  });

  it('refuses every write on a COMPLETED session with 409 session_not_editable and labels it ended', async () => {
    const c = await scene({ payout: true });
    const id = await insertSession(
      database.pool,
      c.teamId,
      {},
      { status: 'COMPLETED', calculatedRate: '17.00', date: '2026-10-02' },
    );
    const detail = await call('GET', `${base(c)}/${id}`, c.admin);
    expect(sessionOf(detail)).toMatchObject({ status: 'COMPLETED', phase: 'ended' });
    for (const [method, url, payload] of [
      ['PUT', `${base(c)}/${id}`, editBody(createBody({ date: '2026-10-07' }), 1)],
      ['POST', `${base(c)}/${id}/publish`, { expectedVersion: 1 }],
      ['POST', `${base(c)}/${id}/cancel`, { expectedVersion: 1 }],
    ] as const) {
      const res = await call(method, url, c.admin, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(409);
      expect(errorOf(res).code).toBe('session_not_editable');
    }
  });
});

describe('an edit may not move a PUBLISHED session into the past (AC-ERROR-5)', () => {
  // 7 Oct 08:00 NZDT is 19:00Z on the 6th. At 18:30Z (07:30 NZDT) the session has not started yet.
  const earlyCourts = (): ReturnType<typeof nineCourts> =>
    nineCourts().map((court, index) =>
      index === 0 ? { ...court, startTime: '07:00', endTime: '10:00' } : court,
    );

  it('refuses a court start that has already passed with 409 session_started and writes nothing', async () => {
    const c = await scene();
    const live = await publishedSession(c, { date: '2026-10-07' });
    const before = await row(live.id);
    const courtsBefore = await courtsOf(live.id);
    h.clock.set(new Date('2026-10-06T18:30:00Z'));
    const res = await call(
      'PUT',
      `${base(c)}/${live.id}`,
      c.admin,
      editBody(live.body, live.version, { courts: earlyCourts() }),
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).code).toBe('session_started');
    const after = await row(live.id);
    expect(after.version).toBe(before.version);
    expect(after.starts_at).toEqual(before.starts_at);
    expect(await courtsOf(live.id)).toEqual(courtsBefore);
  });

  it('a DRAFT stays editable to a start that has passed (only publishing refuses it)', async () => {
    const c = await scene();
    const draft = await createSession(c, { date: '2026-10-07' });
    h.clock.set(new Date('2026-10-06T18:30:00Z'));
    const saved = await call(
      'PUT',
      `${base(c)}/${draft.id}`,
      c.admin,
      editBody(draft.body, 1, { courts: earlyCourts() }),
    );
    expect(saved.statusCode, saved.body).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-ERROR-10: the fee lock
// ---------------------------------------------------------------------------------------------

describe('fees can only go down once players have registered (AC-ERROR-10)', () => {
  it('refuses a raise, a pricing-model change and free-to-paid with raisedFields; accepts a decrease and a non-fee edit', async () => {
    const c = await scene({ payout: true });
    const s = await publishedSession(c, PAID);
    const player = await insertUser(database.pool);
    await insertTeamMember(database.pool, { teamId: c.teamId, userId: player });
    await insertRegistration(database.pool, { sessionId: s.id, teamId: c.teamId, userId: player });

    const raise = await call(
      'PUT',
      `${base(c)}/${s.id}`,
      c.admin,
      editBody(s.body, s.version, { courtCost: '720.00' }),
    );
    expect(raise.statusCode).toBe(409);
    expect(errorOf(raise)).toMatchObject({
      code: 'session_fee_locked',
      raisedFields: ['fee_flat'],
    });
    expect(await row(s.id)).toMatchObject({ fee_flat: '10.00', version: s.version });

    const model = await call(
      'PUT',
      `${base(c)}/${s.id}`,
      c.admin,
      editBody(s.body, s.version, {
        pricingStructure: 'BY_SEX',
        feeMale: '10.00',
        feeFemale: '10.00',
      }),
    );
    expect(model.statusCode).toBe(409);
    expect(errorOf(model).raisedFields).toContain('pricing_structure');

    const decrease = await call(
      'PUT',
      `${base(c)}/${s.id}`,
      c.admin,
      editBody(s.body, s.version, { customPlayerRate: '8.00' }),
    );
    expect(decrease.statusCode, decrease.body).toBe(200);
    expect(await row(s.id)).toMatchObject({ fee_flat: '8.00', custom_player_rate: '8.00' });

    const place = await call(
      'PUT',
      `${base(c)}/${s.id}`,
      c.admin,
      editBody(s.body, sessionOf(decrease).version, {
        customPlayerRate: '8.00',
        location: 'New hall',
      }),
    );
    expect(place.statusCode).toBe(200);

    // Raising back above the current fee is blocked again; a published session with nobody registered is free to raise.
    const back = await call(
      'PUT',
      `${base(c)}/${s.id}`,
      c.admin,
      editBody(s.body, sessionOf(place).version, {
        customPlayerRate: '9.00',
        location: 'New hall',
      }),
    );
    expect(back.statusCode).toBe(409);
    const open = await publishedSession(c, PAID);
    const freeRaise = await call(
      'PUT',
      `${base(c)}/${open.id}`,
      c.admin,
      editBody(open.body, open.version, { courtCost: '720.00' }),
    );
    expect(freeRaise.statusCode, freeRaise.body).toBe(200);
    expect(await row(open.id)).toMatchObject({ fee_flat: '20.00' });
  });
});

// ---------------------------------------------------------------------------------------------
// The admin list
// ---------------------------------------------------------------------------------------------

describe('series name on session rows (derived from the rule, no N+1)', () => {
  it('list rows and the detail GET carry seriesName for series dates and null for one-offs, with one rule read per list', async () => {
    const c = await scene({ payout: true });
    const weekly = await insertRule(database.pool, c.teamId);
    const monthly = await insertRule(database.pool, c.teamId, {
      frequency: 'MONTHLY',
      monthlyWeek: 1,
      startsOn: '2026-11-04',
    });
    const a = await insertSession(
      database.pool,
      c.teamId,
      {},
      { date: '2026-11-04', recurringRuleId: weekly },
    );
    const b = await insertSession(
      database.pool,
      c.teamId,
      {},
      { date: '2026-11-11', recurringRuleId: weekly },
    );
    const m = await insertSession(
      database.pool,
      c.teamId,
      {},
      { date: '2026-11-18', recurringRuleId: monthly },
    );
    const oneOff = await insertSession(database.pool, c.teamId, {}, { date: '2026-11-25' });

    recorder.reset();
    const res = await call('GET', `${base(c)}?view=drafts`, c.admin);
    expect(res.statusCode, res.body).toBe(200);
    const names = new Map(
      res.json<{ sessions: SessionResponse[] }>().sessions.map((x) => [x.id, x.seriesName]),
    );
    expect(names.get(a)).toBe('Wednesdays at Test Hall');
    expect(names.get(b)).toBe('Wednesdays at Test Hall');
    expect(names.get(m)).toBe('First Wednesday of the month at Test Hall');
    expect(names.get(oneOff)).toBeNull();
    expect(
      recorder.statements.filter((sql) => /from "recurring_session_rules"/.test(sql)),
    ).toHaveLength(1);

    for (const [id, expected] of [
      [a, 'Wednesdays at Test Hall'],
      [oneOff, null],
    ] as const) {
      const one = await call('GET', `${base(c)}/${id}`, c.admin);
      expect(sessionOf(one).seriesName).toBe(expected);
    }
  });
});

describe('the admin list (spec "API")', () => {
  it('splits upcoming, drafts and past by status and the API clock, in order, with isPayoutConfigured', async () => {
    // 07:00Z on 6 Oct 2026: the 6 Oct 19:00 NZDT session (06:00Z..08:00Z) has started.
    h.clock.set(new Date('2026-10-06T07:00:00Z'));
    const c = await scene({ payout: true });
    const pub = (date: string) =>
      insertSession(
        database.pool,
        c.teamId,
        {},
        { date, status: 'PUBLISHED', calculatedRate: '17.00' },
      );
    const later = await pub('2026-10-20');
    const sooner = await pub('2026-10-13');
    const started = await pub('2026-10-06');
    const ended = await pub('2026-10-02');
    const draftFuture = await insertSession(database.pool, c.teamId, {}, { date: '2026-10-15' });
    const draftPast = await insertSession(database.pool, c.teamId, {}, { date: '2026-10-01' });
    const cancelled = await insertSession(
      database.pool,
      c.teamId,
      {},
      { date: '2026-10-25', status: 'CANCELLED' },
    );
    const completed = await insertSession(
      database.pool,
      c.teamId,
      {},
      { date: '2026-10-03', status: 'COMPLETED', calculatedRate: '17.00' },
    );
    await insertSession(database.pool, c.otherTeamId);

    const list = async (view: string, query = '') => {
      const res = await call('GET', `${base(c)}?view=${view}${query}`, c.admin);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      return res.json<{
        sessions: SessionResponse[];
        nextCursor: string | null;
        isPayoutConfigured: boolean;
      }>();
    };

    const upcoming = await list('upcoming');
    expect(upcoming.isPayoutConfigured).toBe(true);
    expect(upcoming.sessions.map((s) => s.id)).toEqual([started, sooner, later]);
    expect(upcoming.sessions.map((s) => s.phase)).toEqual(['started', 'upcoming', 'upcoming']);

    const drafts = await list('drafts');
    expect(drafts.sessions.map((s) => s.id)).toEqual([draftFuture]);
    expect(drafts.sessions[0]?.draftReason).toBe('admin');

    const past = await list('past');
    // Most recent first: the cancelled 25 Oct, then 3 Oct (completed), 2 Oct (ended), 1 Oct (expired draft).
    expect(past.sessions.map((s) => s.id)).toEqual([cancelled, completed, ended, draftPast]);

    // Keyset paging, one at a time, with no repeats and a null cursor at the end.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page += 1) {
      const next: Awaited<ReturnType<typeof list>> = await list(
        'past',
        `&limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      seen.push(...next.sessions.map((s) => s.id));
      cursor = next.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual([cancelled, completed, ended, draftPast]);

    const unconfigured = await scene({ payout: false });
    expect(
      (await call('GET', `${base(unconfigured)}?view=drafts`, unconfigured.admin)).json<{
        isPayoutConfigured: boolean;
      }>().isPayoutConfigured,
    ).toBe(false);
    const bad = await call('GET', `${base(c)}?view=everything`, c.admin);
    expect(bad.statusCode).toBe(422);
  });

  it('reports the team-wide count of banking-refused drafts on every list view, even when that draft is past the first page (AC-ENTRY-2)', async () => {
    const c = await scene({ payout: false });
    const ruleId = await insertRule(database.pool, c.teamId);
    // 29 one-off drafts all dated before the series draft: it is the 30th, past the default page of 25.
    for (let day = 0; day < 29; day += 1) {
      await insertSession(
        database.pool,
        c.teamId,
        {},
        { date: `2026-11-${String(day + 1).padStart(2, '0')}` },
      );
    }
    const banking = await insertSession(
      database.pool,
      c.teamId,
      {},
      { date: '2026-12-20', recurringRuleId: ruleId },
    );
    // Not counted: an edited series draft, a published series date, another team's banking draft.
    const edited = await insertSession(
      database.pool,
      c.teamId,
      {},
      { date: '2026-12-21', recurringRuleId: ruleId },
    );
    await database.pool.query(
      `UPDATE game_sessions SET is_instance_overridden = true WHERE id = $1`,
      [edited],
    );
    await insertSession(
      database.pool,
      c.teamId,
      { flat: '0.00' },
      { date: '2026-12-22', recurringRuleId: ruleId, status: 'PUBLISHED' },
    );
    const otherRule = await insertRule(database.pool, c.otherTeamId);
    await insertSession(
      database.pool,
      c.otherTeamId,
      {},
      { date: '2026-12-20', recurringRuleId: otherRule },
    );

    const page = await call('GET', `${base(c)}?view=drafts`, c.admin);
    expect(page.statusCode, page.body).toBe(200);
    const firstPage = page.json<{
      sessions: SessionResponse[];
      nextCursor: string | null;
      bankingDrafts: number;
    }>();
    expect(firstPage.sessions).toHaveLength(25);
    expect(firstPage.sessions.map((s) => s.id)).not.toContain(banking);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(firstPage.bankingDrafts).toBe(1);
    for (const view of ['upcoming', 'past']) {
      const other = await call('GET', `${base(c)}?view=${view}`, c.admin);
      expect(other.json<{ bankingDrafts: number }>().bankingDrafts, view).toBe(1);
    }
  });

  it('reports zero banking drafts when the team has none', async () => {
    const c = await scene({ payout: false });
    await insertSession(database.pool, c.teamId, {}, { date: '2026-11-04' });
    const res = await call('GET', `${base(c)}?view=drafts`, c.admin);
    expect(res.json<{ bankingDrafts: number }>().bankingDrafts).toBe(0);
  });

  it('answers 422 validation_failed on a malformed cursor: a bad id or a bad time, never a 500', async () => {
    const c = await scene();
    const encode = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const goodId = randomUUID();
    for (const cursor of [
      encode({ at: '2026-01-01T00:00:00.000Z', id: '-'.repeat(36) }),
      encode({ at: '2026-01-01T00:00:00.000Z', id: 'z'.repeat(36) }),
      encode({ at: 'not-a-date', id: goodId }),
      'not-base64-json',
    ]) {
      const res = await call(
        'GET',
        `${base(c)}?view=upcoming&cursor=${encodeURIComponent(cursor)}`,
        c.admin,
      );
      expect(res.statusCode, cursor).toBe(422);
      expect(errorOf(res).code).toBe('validation_failed');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Logs: ids only
// ---------------------------------------------------------------------------------------------

describe('structured logs (observability)', () => {
  it('logs created, published and cancelled with ids and counts, never the address or location', async () => {
    const c = await scene({ payout: true });
    const { id } = await createSession(c, PAID);
    const res = await publish(c, id, 1);
    await call('POST', `${base(c)}/${id}/cancel`, c.admin, {
      expectedVersion: sessionOf(res).version,
    });
    const lines = h.logs
      .lines()
      .filter(
        (line) => typeof line.event === 'string' && String(line.event).startsWith('session.'),
      );
    const byEvent = (event: string) =>
      lines.find((line) => line.event === event && line.sessionId === id);
    expect(byEvent('session.created')).toMatchObject({ teamId: c.teamId, actorId: c.adminId });
    expect(byEvent('session.published')).toMatchObject({
      teamId: c.teamId,
      actorId: c.adminId,
      paid: true,
      autoEnrolQueued: true,
    });
    expect(byEvent('session.cancelled')).toMatchObject({
      teamId: c.teamId,
      actorId: c.adminId,
      fromStatus: 'PUBLISHED',
    });
    const text = JSON.stringify(lines);
    expect(text).not.toContain('Rosedale');
    expect(text).not.toContain('John Glenn');
  });
});

// ---------------------------------------------------------------------------------------------
// AC-ASYNC-2, AC-HAPPY-12 (manual paths): the auto-enrol follow-up
// ---------------------------------------------------------------------------------------------

describe('auto-enrol follow-up (AC-ASYNC-2, AC-HAPPY-12)', () => {
  const runLogs = captureLogs();
  const deps = () => ({
    db: createKysely(database.pool),
    clock: h.clock,
    allocator,
    log: runLogs.logger,
  });

  /** Members on Auto Enroll with distinct assignment times: [u1, u2] are selected for a 4 Nov session. */
  async function withAutoEnrollees(c: Scene) {
    const make = async (assigned: string, until: string | null, on = true) => {
      const userId = await insertUser(database.pool);
      await insertTeamMember(database.pool, { teamId: c.teamId, userId });
      if (on) {
        await database.pool.query(
          `UPDATE team_members SET is_auto_enroll = true, auto_enroll_assigned_at = $3, auto_enroll_until = $4
            WHERE team_id = $1 AND user_id = $2`,
          [c.teamId, userId, assigned, until],
        );
      }
      return userId;
    };
    const u1 = await make('2026-10-01T00:00:00Z', null);
    const u2 = await make('2026-10-02T00:00:00Z', '2026-11-04');
    await make('2026-10-03T00:00:00Z', '2026-11-03'); // ended before the session date
    await make('2026-10-04T00:00:00Z', null, false); // not on Auto Enroll
    return [u1, u2];
  }

  it('calls the allocator once with selectAutoEnrollees entries in order, stamps the marker in the same transaction, and never again', async () => {
    const c = await scene();
    const [u1, u2] = await withAutoEnrollees(c);
    const { id } = await publishedSession(c);
    const outcome = await runSessionAutoEnrol(deps(), { teamId: c.teamId, sessionId: id });
    expect(outcome).toMatchObject({
      kind: 'done',
      candidates: 2,
      confirmed: 2,
      waitlisted: 0,
      skipped: 0,
    });
    expect(allocator.autoEnrolCalls).toHaveLength(1);
    const call0 = allocator.autoEnrolCalls[0];
    expect(call0).toMatchObject({ teamId: c.teamId, sessionId: id, inTransaction: true });
    expect(call0?.entries.map((entry) => entry.userId)).toEqual([u1, u2]);
    expect(call0?.entries[0]?.assignedAt).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect((await row(id)).auto_enrolled_at).not.toBeNull();

    allocator.reset();
    const again = await runSessionAutoEnrol(deps(), { teamId: c.teamId, sessionId: id });
    expect(again.kind).toBe('not_due');
    expect(allocator.autoEnrolCalls).toHaveLength(0);
    const events = runLogs
      .lines()
      .filter((line) => line.sessionId === id)
      .map((line) => line.event);
    expect(events).toContain('session.auto_enrol.completed');
  });

  it('with the no-op port it logs port_noop, leaves the marker pending, and a later real allocator enrols the session once', async () => {
    const c = await scene();
    await withAutoEnrollees(c);
    const { id } = await publishedSession(c);
    allocator.enrols = false;
    const pending = await runSessionAutoEnrol(deps(), { teamId: c.teamId, sessionId: id });
    expect(pending).toMatchObject({ kind: 'noop_port', candidates: 2 });
    expect(allocator.autoEnrolCalls).toHaveLength(0);
    expect((await row(id)).auto_enrolled_at).toBeNull();
    expect(
      runLogs
        .lines()
        .find((line) => line.event === 'session.auto_enrol.port_noop' && line.sessionId === id),
    ).toMatchObject({
      teamId: c.teamId,
      candidates: 2,
    });

    allocator.enrols = true;
    const done = await runSessionAutoEnrol(deps(), { teamId: c.teamId, sessionId: id });
    expect(done.kind).toBe('done');
    expect(allocator.autoEnrolCalls).toHaveLength(1);
    expect((await row(id)).auto_enrolled_at).not.toBeNull();
  });

  it('never calls the allocator with no entries (it only stamps), and skips drafts, cancelled and started sessions', async () => {
    const c = await scene();
    const { id } = await publishedSession(c);
    const none = await runSessionAutoEnrol(deps(), { teamId: c.teamId, sessionId: id });
    expect(none).toMatchObject({ kind: 'no_candidates', candidates: 0 });
    expect(allocator.autoEnrolCalls).toHaveLength(0);
    expect((await row(id)).auto_enrolled_at).not.toBeNull();

    await withAutoEnrollees(c);
    const draft = await createSession(c);
    const cancelled = await publishedSession(c);
    await call('POST', `${base(c)}/${cancelled.id}/cancel`, c.admin, {
      expectedVersion: cancelled.version,
    });
    const started = await publishedSession(c, { date: '2026-10-07' });
    h.clock.set(new Date('2026-10-06T20:00:00Z'));
    for (const target of [draft.id, cancelled.id, started.id]) {
      const result = await runSessionAutoEnrol(deps(), { teamId: c.teamId, sessionId: target });
      expect(result.kind, target).toBe('not_due');
    }
    // A session of another team under this team's id is not due either.
    const foreign = await insertSession(database.pool, c.otherTeamId);
    expect((await runSessionAutoEnrol(deps(), { teamId: c.teamId, sessionId: foreign })).kind).toBe(
      'not_due',
    );
    expect(allocator.autoEnrolCalls).toHaveLength(0);
  });

  it('counts per-member refusals as skips and still stamps; a thrown error rolls the marker back and the handler retries', async () => {
    const c = await scene();
    await withAutoEnrollees(c);
    const { id } = await publishedSession(c);
    allocator.outcome = { ok: false, reason: 'overdue_payments' };
    const skipped = await runSessionAutoEnrol(deps(), { teamId: c.teamId, sessionId: id });
    expect(skipped).toMatchObject({ kind: 'done', candidates: 2, confirmed: 0, skipped: 2 });
    expect((await row(id)).auto_enrolled_at).not.toBeNull();
    allocator.outcome = { ok: true, status: 'CONFIRMED' };

    const second = await publishedSession(c);
    const failing = {
      ...allocator,
      autoEnrolInSession: () => Promise.reject(new Error('lock timeout')),
    };
    const handler = createSessionAutoEnrolHandler({
      db: createKysely(database.pool),
      clock: h.clock,
      allocator: failing,
    });
    const logger = captureLogs();
    const ctx = {
      logger: logger.logger,
      jobId: 'j',
      queue: 'session-auto-enrol',
      retryCount: 0,
      retryLimit: 3,
      signal: new AbortController().signal,
    } as unknown as JobContext;
    await expect(
      handler({ sessionId: second.id, teamId: c.teamId, trigger: 'publish' }, ctx),
    ).rejects.toThrow('lock timeout');
    expect((await row(second.id)).auto_enrolled_at).toBeNull();
    expect(logger.lines().find((line) => line.event === 'session.auto_enrol.failed')).toMatchObject(
      {
        teamId: c.teamId,
        sessionId: second.id,
      },
    );

    // The retry succeeds with a healthy allocator.
    const healthy = createSessionAutoEnrolHandler({
      db: createKysely(database.pool),
      clock: h.clock,
      allocator,
    });
    await healthy({ sessionId: second.id, teamId: c.teamId, trigger: 'publish' }, ctx);
    expect((await row(second.id)).auto_enrolled_at).not.toBeNull();
  });

  it('serialises concurrent runs on the advisory lock: two at once call the allocator once and stamp once (T-19)', async () => {
    const c = await scene();
    await withAutoEnrollees(c);
    const { id } = await publishedSession(c);
    const slow = {
      ...allocator,
      autoEnrolInSession: async (
        ctx: Parameters<typeof allocator.autoEnrolInSession>[0],
        input: Parameters<typeof allocator.autoEnrolInSession>[1],
      ) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return allocator.autoEnrolInSession(ctx, input);
      },
    };
    const results = await Promise.all([
      runSessionAutoEnrol({ ...deps(), allocator: slow }, { teamId: c.teamId, sessionId: id }),
      runSessionAutoEnrol({ ...deps(), allocator: slow }, { teamId: c.teamId, sessionId: id }),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(['done', 'not_due']);
    expect(allocator.autoEnrolCalls).toHaveLength(1);
  });
});
