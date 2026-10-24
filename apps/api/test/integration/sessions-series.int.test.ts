/**
 * Series API (session-scheduling-engine Phase 3, part B) through the real `buildApp` over a cloned PostgreSQL and a real
 * pg-boss producer. ACs: AC-HAPPY-5 (create, replay, the per-rule job, the waiting signal), AC-HAPPY-6 (instance override),
 * AC-HAPPY-7 (series edit propagation, counts, whole-edit banking refusal), AC-HAPPY-10 (End series), AC-ASYNC-7 (Publish
 * drafts now), AC-ERROR-12 (fixed pattern), AC-VERIFY-2 (propagation path: the gate precedes every lock) and the lock order of
 * ARCH SA-2 on the series edit.
 *
 * The clock is the harness clock, Tuesday 2026-10-06 13:00 NZDT, so a Wednesday 19:00 series has the dates 10-07, 10-14,
 * 10-21, 10-28 inside the 28-day window. Materialisation is run by calling `materialiseRule` directly (the API only enqueues).
 */
import { randomUUID } from 'node:crypto';
import { PostgresDialect } from 'kysely';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SeriesResponse, SessionResponse } from '@sgm/shared';
import { QUEUES } from '../../src/jobs/registry.ts';
import { createJobRunner, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import { materialiseRule, type MaterialiseDeps } from '../../src/modules/sessions/materialise.ts';
import { START_TIME, bearer, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  insertAuthSession,
  insertRegistration,
  insertRule,
  insertSession,
} from '../helpers/factories.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import { createQueryRecorder, createRecordingDatabase } from '../helpers/query-recorder.ts';
import { createRecordingAllocator, createSessionsScene } from '../helpers/sessions-scene.ts';
import { raceUnderTeamLock } from '../helpers/lock-waiters.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

let database: TestDatabase;
let h: AuthTestApp;
let producer: JobRunner;
let worker: JobRunner;
const allocator = createRecordingAllocator();
const recorder = createQueryRecorder();
const enqueued: {
  queue: string;
  data: Record<string, unknown>;
  singletonKey: string | undefined;
}[] = [];

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 14 });
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
    db: createRecordingDatabase(new PostgresDialect({ pool: database.pool }), recorder),
    sessionAllocator: allocator,
    jobs: {
      enqueue: async (queue, data, options) => {
        enqueued.push({
          queue,
          data: data as Record<string, unknown>,
          singletonKey: options?.singletonKey,
        });
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
  allocator.promoted = [];
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
    payoutConfigured: options.payout ?? true,
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
    current?: SeriesResponse | SessionResponse;
  };
}
const errorOf = (res: LightMyRequestResponse): ApiError['error'] => res.json<ApiError>().error;
const seriesOf = (res: LightMyRequestResponse): SeriesResponse =>
  res.json<{ series: SeriesResponse }>().series;

type Body = Record<string, unknown>;

const WED_COURT = { identifier: 'Court 1', startTime: '19:00', endTime: '21:00' };

/** A free Wednesday series (first date 2026-10-07, 24 players, one court 19:00-21:00). */
function createBody(over: Body = {}): Body {
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
const PAID = { courtCost: '240.00' };

/** The PUT body that re-sends `body` unchanged (plus `over`). */
function editBody(body: Body, expectedVersion: number, over: Body = {}): Body {
  const rest: Body = { ...body };
  delete rest.createKey;
  return { ...rest, expectedVersion, ...over };
}

const base = (c: Scene) => `/teams/${c.teamId}/session-series`;
const sessions = (c: Scene) => `/teams/${c.teamId}/sessions`;

interface DbRule {
  version: number;
  is_active: boolean;
  recur_until: string | null;
  starts_on: string;
  day_of_week: number;
  frequency: string;
  monthly_week: number | null;
  materialised_version: number | null;
  default_location: string;
  default_max_players: number;
  default_court_count: number;
  default_start_time: string;
  default_end_time: string;
  pricing_structure: string;
  fee_flat: string | null;
  create_key: string | null;
}

async function rule(id: string): Promise<DbRule> {
  const { rows } = await database.pool.query<DbRule>(
    `SELECT *, starts_on::text AS starts_on, recur_until::text AS recur_until FROM recurring_session_rules WHERE id = $1`,
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
  is_instance_overridden: boolean;
  location: string;
  max_players: number;
  fee_flat: string | null;
  auto_enrol_required: boolean;
}

async function sessionsOf(ruleId: string): Promise<DbSession[]> {
  const { rows } = await database.pool.query<DbSession>(
    `SELECT id, date::text AS date, status, version, is_instance_overridden, location, max_players, fee_flat,
            auto_enrol_required
       FROM game_sessions WHERE recurring_rule_id = $1 ORDER BY date`,
    [ruleId],
  );
  return rows;
}

async function sessionRow(id: string): Promise<DbSession> {
  const { rows } = await database.pool.query<DbSession>(
    `SELECT id, date::text AS date, status, version, is_instance_overridden, location, max_players, fee_flat,
            auto_enrol_required FROM game_sessions WHERE id = $1`,
    [id],
  );
  const found = rows[0];
  if (found === undefined) throw new Error('no such session');
  return found;
}

async function courtTimes(sessionId: string): Promise<string[]> {
  const { rows } = await database.pool.query<{ t: string }>(
    `SELECT to_char(start_time, 'HH24:MI') || '-' || to_char(end_time, 'HH24:MI') AS t
       FROM session_courts WHERE session_id = $1 ORDER BY court_identifier`,
    [sessionId],
  );
  return rows.map((r) => r.t);
}

async function ruleJobs(ruleId: string): Promise<{ trigger: string }[]> {
  const { rows } = await database.pool.query<{ trigger: string }>(
    `SELECT data->>'trigger' AS trigger FROM pgboss.job
      WHERE name = 'recurrence-rule' AND singleton_key = $1 ORDER BY created_on`,
    [`recurrence-rule:${ruleId}`],
  );
  return rows;
}

/** The triggers the API asked for, in order (a still-queued job dedupes in pg-boss, so the table alone would hide later ones). */
const triggersOf = (ruleId: string): string[] =>
  enqueued
    .filter((job) => job.queue === 'recurrence-rule' && job.data.ruleId === ruleId)
    .map((job) => String(job.data.trigger));

function materialiseDeps(): MaterialiseDeps {
  return {
    db: h.db,
    clock: h.clock,
    allocator,
    jobs: { enqueue: (queue, data, options) => producer.enqueue(queue, data, options) },
    notice: { webBaseUrl: 'https://app.example.test', sendEmail: () => Promise.resolve() },
    log: captureLogs().logger,
    horizonDays: 28,
  };
}

/** Creates a series through the API and runs the materialiser once, as the queued job would. */
async function seriesWithInstances(
  c: Scene,
  over: Body = {},
): Promise<{ ruleId: string; body: Body; version: number }> {
  const body = createBody(over);
  const res = await call('POST', base(c), c.admin, body);
  expect(res.statusCode, res.body).toBe(201);
  const ruleId = seriesOf(res).id;
  await materialiseRule(materialiseDeps(), { ruleId, teamId: c.teamId, trigger: 'rule_created' });
  return { ruleId, body, version: (await rule(ruleId)).version };
}

const GATE = /select "is_payout_configured", "payout_blocked_at" from "teams".*for key share/;
const SERIES_LOCK_OR_WRITE =
  /from "recurring_session_rules".*for no key update|update "recurring_session_rules"|from "game_sessions".*for update|update "game_sessions"|insert into "game_sessions"|insert into "session_courts"|delete from "session_courts"|update "session_courts"|delete from "recurring_rule_courts"/;

// ---------------------------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------------------------

describe('access control', () => {
  it('answers 401 anonymously, 403 to a member, another team admin and for a series of another team (ruled 2026-10-24), and 404 for an id that does not exist, changing nothing', async () => {
    const c = await scene();
    const ruleId = await insertRule(database.pool, c.teamId);
    const foreign = await insertRule(database.pool, c.otherTeamId);
    const before = await rule(ruleId);
    const foreignBefore = await rule(foreign);
    const routes: ['GET' | 'POST' | 'PUT', string, object | undefined][] = [
      ['POST', base(c), createBody()],
      ['GET', `${base(c)}/${ruleId}`, undefined],
      ['PUT', `${base(c)}/${ruleId}`, editBody(createBody(), 1)],
      ['POST', `${base(c)}/${ruleId}/end`, { expectedVersion: 1, lastDate: '2026-11-04' }],
      ['POST', `${base(c)}/${ruleId}/publish-drafts`, {}],
    ];
    for (const [method, url, payload] of routes) {
      expect((await call(method, url, null, payload)).statusCode, `anon ${method} ${url}`).toBe(
        401,
      );
      for (const token of [c.member, c.otherAdmin]) {
        const res = await call(method, url, token, payload);
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(errorOf(res).code).toBe('forbidden');
      }
    }
    for (const [method, suffix, payload] of [
      ['GET', '', undefined],
      ['PUT', '', editBody(createBody(), 1)],
      ['POST', '/end', { expectedVersion: 1, lastDate: '2026-11-04' }],
      ['POST', '/publish-drafts', {}],
    ] as const) {
      const res = await call(method, `${base(c)}/${foreign}${suffix}`, c.admin, payload);
      expect(res.statusCode, `${method} ${suffix}`).toBe(403);
      expect(errorOf(res).code).toBe('forbidden');
      const missing = await call(method, `${base(c)}/${randomUUID()}${suffix}`, c.admin, payload);
      expect(missing.statusCode, `missing ${method} ${suffix}`).toBe(404);
      expect(errorOf(missing).code).toBe('not_found');
    }
    expect(await rule(foreign)).toEqual(foreignBefore);
    expect(await rule(ruleId)).toEqual(before);
    expect(enqueued).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-HAPPY-5: create
// ---------------------------------------------------------------------------------------------

describe('create a series (AC-HAPPY-5)', () => {
  it('stores the rule and its court template, enqueues one rule_created job in the same transaction, replays a createKey, and shows the waiting state until materialised', async () => {
    const c = await scene();
    const body = createBody({
      courts: [
        { identifier: 'Court 1', startTime: '19:00', endTime: '21:00' },
        { identifier: 'Court 2', startTime: '18:00', endTime: '20:00' },
      ],
    });
    const res = await call('POST', base(c), c.admin, body);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const created = seriesOf(res);
    expect(created).toMatchObject({
      teamId: c.teamId,
      frequency: 'WEEKLY',
      dayOfWeek: 3,
      startsOn: '2026-10-07',
      monthlyWeek: null,
      recurUntil: null,
      isActive: true,
      version: 1,
      materialising: true,
      maxPlayers: 24,
    });
    expect(created.courts.map((court) => court.identifier)).toEqual(['Court 1', 'Court 2']);

    expect(await rule(created.id)).toMatchObject({
      starts_on: '2026-10-07',
      day_of_week: 3,
      materialised_version: null,
      default_court_count: 2,
      default_start_time: '18:00:00',
      default_end_time: '21:00:00',
    });
    const { rows: template } = await database.pool.query<{ i: string; p: number }>(
      `SELECT court_identifier AS i, position AS p FROM recurring_rule_courts WHERE rule_id = $1 ORDER BY position`,
      [created.id],
    );
    expect(template).toEqual([
      { i: 'Court 1', p: 1 },
      { i: 'Court 2', p: 2 },
    ]);
    expect(await ruleJobs(created.id)).toEqual([{ trigger: 'rule_created' }]);
    expect(enqueued.filter((job) => job.queue === 'recurrence-rule')).toHaveLength(1);

    // A replay of the committed request answers 200 with the same series and enqueues nothing more.
    enqueued.length = 0;
    const replay = await call('POST', base(c), c.admin, body);
    expect(replay.statusCode).toBe(200);
    expect(seriesOf(replay).id).toBe(created.id);
    expect(enqueued).toHaveLength(0);
    expect(await ruleJobs(created.id)).toHaveLength(1);

    // The job runs: the waiting signal clears and the dates appear, published, as unedited rule instances.
    expect(seriesOf(await call('GET', `${base(c)}/${created.id}`, c.admin)).materialising).toBe(
      true,
    );
    await materialiseRule(materialiseDeps(), {
      ruleId: created.id,
      teamId: c.teamId,
      trigger: 'rule_created',
    });
    expect(seriesOf(await call('GET', `${base(c)}/${created.id}`, c.admin)).materialising).toBe(
      false,
    );
    const instances = await sessionsOf(created.id);
    expect(instances.map((s) => s.date)).toEqual([
      '2026-10-07',
      '2026-10-14',
      '2026-10-21',
      '2026-10-28',
    ]);
    expect(instances.every((s) => s.status === 'PUBLISHED' && !s.is_instance_overridden)).toBe(
      true,
    );
  });

  it('refuses an inconsistent or incomplete series with field errors and stores nothing', async () => {
    const c = await scene();
    const cases: [Body, string][] = [
      [{ dayOfWeek: 4 }, 'startsOn'],
      [{ pricingStructure: 'BY_SEX', feeFemale: '12.00' }, 'feeMale'],
      [{ recurUntil: '2026-09-01' }, 'recurUntil'],
      [{ courts: [] }, 'courts'],
    ];
    for (const [over, field] of cases) {
      const res = await call('POST', base(c), c.admin, createBody(over));
      expect(res.statusCode, JSON.stringify(over)).toBe(422);
      expect(errorOf(res).code).toBe('validation_failed');
      expect(Object.keys(errorOf(res).fieldErrors ?? {}), JSON.stringify(over)).toContain(field);
    }
    const unknownKey = await call('POST', base(c), c.admin, createBody({ isActive: false }));
    expect(unknownKey.statusCode).toBe(422);
    const { rows } = await database.pool.query(
      `SELECT 1 FROM recurring_session_rules WHERE team_id = $1`,
      [c.teamId],
    );
    expect(rows).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-HAPPY-6: one date is an override
// ---------------------------------------------------------------------------------------------

describe('series read model for the admin UI', () => {
  it('names the series, reports the payout flag and draft counts, and lists instances with one of four change effects', async () => {
    const c = await scene({ payout: true });
    const ruleId = await insertRule(database.pool, c.teamId);
    const elsewhere = await insertRule(database.pool, c.otherTeamId);
    const mk = (date: string, status: 'DRAFT' | 'PUBLISHED' | 'CANCELLED' | 'COMPLETED') =>
      insertSession(database.pool, c.teamId, {}, { date, status, recurringRuleId: ruleId });
    const pastDraft = await mk('2026-09-23', 'DRAFT');
    await mk('2026-09-30', 'COMPLETED');
    const banking = await mk('2026-10-14', 'DRAFT');
    const registered = await mk('2026-10-21', 'PUBLISHED');
    const edited = await mk('2026-10-28', 'PUBLISHED');
    const cancelled = await mk('2026-11-04', 'CANCELLED');
    const editedDraft = await mk('2026-11-11', 'DRAFT');
    await insertSession(
      database.pool,
      c.otherTeamId,
      {},
      { date: '2026-10-14', recurringRuleId: elsewhere },
    );
    await insertRegistration(database.pool, {
      sessionId: registered,
      teamId: c.teamId,
      userId: c.memberId,
      status: 'CONFIRMED',
    });
    await database.pool.query(
      `UPDATE game_sessions SET is_instance_overridden = true WHERE id = ANY($1::uuid[])`,
      [[edited, editedDraft]],
    );
    await database.pool.query(
      `UPDATE game_sessions SET cancellation_deadline = starts_at - interval '2 days' WHERE id = ANY($1::uuid[])`,
      [[registered, edited]],
    );

    const res = await call('GET', `${base(c)}/${ruleId}`, c.admin);
    expect(res.statusCode, res.body).toBe(200);
    const series = seriesOf(res);
    expect(series).toMatchObject({
      name: 'Wednesdays at Test Hall',
      isPayoutConfigured: true,
      bankingDrafts: 2,
      editedDrafts: 1,
    });
    expect(series.instances.map((i) => [i.id, i.seriesChangeEffect])).toEqual([
      [pastDraft, 'closed'],
      [banking, 'will_update'],
      [registered, 'has_registrations'],
      [edited, 'edited'],
      [cancelled, 'closed'],
      [editedDraft, 'edited'],
    ]);
    const row = series.instances.find((i) => i.id === registered);
    expect(row).toMatchObject({
      date: '2026-10-21',
      status: 'PUBLISHED',
      phase: 'upcoming',
      draftReason: null,
      isInstanceOverridden: false,
      activeRegistrationCount: 1,
    });
    expect(row?.startsAt).toEqual(expect.any(String));
    expect(series.instances.find((i) => i.id === banking)?.draftReason).toBe('banking');
    expect(series.instances.find((i) => i.id === editedDraft)?.draftReason).toBe('edited');
  });

  it('reports isPayoutConfigured false for a team without banking, and every embedding response carries the read model', async () => {
    const c = await scene({ payout: false });
    const { ruleId, body, version } = await seriesWithInstances(c);
    const got = seriesOf(await call('GET', `${base(c)}/${ruleId}`, c.admin));
    expect(got.isPayoutConfigured).toBe(false);
    expect(got.instances).toHaveLength(4);

    const put = await call(
      'PUT',
      `${base(c)}/${ruleId}`,
      c.admin,
      editBody(body, version, { maxPlayers: 20 }),
    );
    expect(put.statusCode, put.body).toBe(200);
    expect(seriesOf(put)).toMatchObject({
      name: 'Wednesdays at Rosedale Badminton Centre',
      isPayoutConfigured: false,
    });
    // The first date's deadline (two days before it) has passed on this clock, so it is closed; the later dates update.
    expect(seriesOf(put).instances.map((i) => i.seriesChangeEffect)).toEqual([
      'closed',
      'will_update',
      'will_update',
      'will_update',
    ]);

    const publish = await call('POST', `${base(c)}/${ruleId}/publish-drafts`, c.admin, {});
    expect(publish.statusCode).toBe(202);
    expect(seriesOf(publish).instances).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------------------------
// Series list read (AC-ENTRY-2, AC-ASYNC-6, AC-HAPPY-15): the Sessions page's Series section
// ---------------------------------------------------------------------------------------------

interface SeriesListBody {
  series: {
    id: string;
    name: string;
    isActive: boolean;
    materialising: boolean;
    recurUntil: string | null;
    startsOn: string;
    version: number;
  }[];
  horizonDays: number;
}

describe('series list read for the Sessions page', () => {
  it('lists a just-created, still-materialising series, then clears the flag once the run completes', async () => {
    const c = await scene();
    const created = seriesOf(await call('POST', base(c), c.admin, createBody()));
    const before = await call('GET', base(c), c.admin);
    expect(before.statusCode, before.body).toBe(200);
    expect(before.headers['cache-control']).toBe('no-store');
    expect(before.json<SeriesListBody>().series).toEqual([
      {
        id: created.id,
        name: 'Wednesdays at Rosedale Badminton Centre',
        isActive: true,
        materialising: true,
        recurUntil: null,
        startsOn: '2026-10-07',
        version: 1,
      },
    ]);
    await materialiseRule(materialiseDeps(), {
      ruleId: created.id,
      teamId: c.teamId,
      trigger: 'rule_created',
    });
    const after = (await call('GET', base(c), c.admin)).json<SeriesListBody>();
    expect(after.series.map((s) => [s.id, s.materialising])).toEqual([[created.id, false]]);
  });

  it('lists an ended series with its end date, and a series with no sessions at all, newest first', async () => {
    const c = await scene();
    const ended = await insertRule(database.pool, c.teamId, {
      isActive: false,
      startsOn: '2026-08-05',
      recurUntil: '2026-09-16',
    });
    const empty = await insertRule(database.pool, c.teamId, {
      dayOfWeek: 6,
      startsOn: '2026-10-10',
    });
    const res = await call('GET', base(c), c.admin);
    expect(res.statusCode, res.body).toBe(200);
    const listed = res.json<SeriesListBody>().series;
    expect(listed.map((s) => s.id)).toEqual([empty, ended]);
    expect(listed[0]).toMatchObject({ name: 'Saturdays at Test Hall', isActive: true });
    expect(listed[1]).toMatchObject({ isActive: false, recurUntil: '2026-09-16' });
    expect(await sessionsOf(empty)).toHaveLength(0);
  });

  it('lists the newest series first whether or not it is active (AC-ENTRY-2: "newest first")', async () => {
    const c = await scene();
    const oldActive = await insertRule(database.pool, c.teamId, { startsOn: '2026-10-07' });
    const newEnded = await insertRule(database.pool, c.teamId, {
      isActive: false,
      dayOfWeek: 6,
      startsOn: '2026-08-08',
      recurUntil: '2026-09-12',
    });
    const newestActive = await insertRule(database.pool, c.teamId, {
      dayOfWeek: 0,
      startsOn: '2026-10-11',
    });
    const res = await call('GET', base(c), c.admin);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<SeriesListBody>().series.map((s) => s.id)).toEqual([
      newestActive,
      newEnded,
      oldActive,
    ]);
  });

  it('lists only this team, answers an empty list when there is none, and refuses anonymous, member and other-team admin', async () => {
    const c = await scene();
    expect((await call('GET', base(c), c.admin)).json<SeriesListBody>().series).toEqual([]);
    await insertRule(database.pool, c.otherTeamId);
    expect((await call('GET', base(c), c.admin)).json<SeriesListBody>().series).toEqual([]);
    expect((await call('GET', base(c), null)).statusCode).toBe(401);
    for (const token of [c.member, c.otherAdmin]) {
      const res = await call('GET', base(c), token);
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).code).toBe('forbidden');
    }
  });

  it('reports the configured materialisation horizon on the list and on every series read, never a copy in the web', async () => {
    const c = await scene();
    const ruleId = await insertRule(database.pool, c.teamId);
    expect((await call('GET', base(c), c.admin)).json<SeriesListBody>().horizonDays).toBe(28);
    expect(seriesOf(await call('GET', `${base(c)}/${ruleId}`, c.admin)).horizonDays).toBe(28);

    const wide = await buildAuthTestApp(database.pool, { recurrenceHorizonDays: 56 });
    try {
      const get = (url: string) =>
        wide.app.inject({ method: 'GET', url, headers: bearer(c.admin) });
      expect((await get(base(c))).json<SeriesListBody>().horizonDays).toBe(56);
      expect(seriesOf(await get(`${base(c)}/${ruleId}`)).horizonDays).toBe(56);
    } finally {
      await wide.close();
    }
  });
});

describe('editing one date of a series (AC-HAPPY-6)', () => {
  it('marks the instance edited only on a real change, never on a no-op, and refuses to move its date', async () => {
    const c = await scene();
    const { ruleId } = await seriesWithInstances(c);
    const [first, second] = await sessionsOf(ruleId);
    if (first === undefined || second === undefined) throw new Error('expected instances');

    const read = async (id: string): Promise<Body> => {
      const res = await call('GET', `${sessions(c)}/${id}`, c.admin);
      const s = res.json<{ session: SessionResponse }>().session;
      return {
        date: s.date,
        location: s.location,
        address: s.address,
        maxPlayers: s.maxPlayers,
        reservedSeats: s.reservedSeats,
        courtCost: s.courtCost,
        extraExpenses: s.extraExpenses,
        customPlayerRate: s.customPlayerRate,
        pricingStructure: s.pricingStructure,
        cancellationDeadline: null,
        courts: s.courts.map((court) => ({
          identifier: court.identifier,
          startTime: court.startTime,
          endTime: court.endTime,
        })),
        expectedVersion: s.version,
      };
    };

    // A save that changes nothing leaves the flag false and writes nothing.
    const noop = await call('PUT', `${sessions(c)}/${first.id}`, c.admin, await read(first.id));
    expect(noop.statusCode, noop.body).toBe(200);
    expect(await sessionRow(first.id)).toMatchObject({
      is_instance_overridden: false,
      version: first.version,
    });

    // A real change marks it edited; the neighbour and the rule are untouched.
    const ruleBefore = await rule(ruleId);
    const edit = await call('PUT', `${sessions(c)}/${first.id}`, c.admin, {
      ...(await read(first.id)),
      maxPlayers: 30,
    });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(await sessionRow(first.id)).toMatchObject({
      is_instance_overridden: true,
      max_players: 30,
    });
    expect(await sessionRow(second.id)).toEqual(second);
    expect(await rule(ruleId)).toEqual(ruleBefore);

    // A date change on a rule instance is refused.
    const moved = await call('PUT', `${sessions(c)}/${second.id}`, c.admin, {
      ...(await read(second.id)),
      date: '2026-10-15',
    });
    expect(moved.statusCode).toBe(422);
    expect(Object.keys(errorOf(moved).fieldErrors ?? {})).toContain('date');
    expect(await sessionRow(second.id)).toEqual(second);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-HAPPY-7: series edit propagation
// ---------------------------------------------------------------------------------------------

describe('series edit propagation (AC-HAPPY-7)', () => {
  it('updates unedited upcoming sessions in one transaction and reports why the others were left alone', async () => {
    const c = await scene({ payout: true });
    const ruleId = await insertRule(database.pool, c.teamId);
    const mk = (
      date: string,
      status: 'DRAFT' | 'PUBLISHED' | 'CANCELLED' | 'COMPLETED',
      rate?: string,
    ) =>
      insertSession(
        database.pool,
        c.teamId,
        {},
        {
          date,
          status,
          recurringRuleId: ruleId,
          ...(rate === undefined ? {} : { customRate: rate }),
        },
      );
    const past = await mk('2026-09-30', 'COMPLETED');
    const deadlinePassed = await mk('2026-10-07', 'PUBLISHED');
    const registered = await mk('2026-10-14', 'PUBLISHED', '5.00');
    await insertRegistration(database.pool, {
      sessionId: registered,
      teamId: c.teamId,
      userId: c.memberId,
      status: 'CONFIRMED',
    });
    const publishedTarget = await mk('2026-10-21', 'PUBLISHED');
    const draftTarget = await mk('2026-10-28', 'DRAFT');
    const edited = await mk('2026-11-04', 'DRAFT');
    await database.pool.query(
      `UPDATE game_sessions SET is_instance_overridden = true WHERE id = $1`,
      [edited],
    );
    const cancelled = await mk('2026-11-11', 'CANCELLED');
    const untouched = [past, deadlinePassed, registered, edited, cancelled];
    const beforeRows = await Promise.all(untouched.map((id) => sessionRow(id)));
    const beforeCourts = await Promise.all(untouched.map((id) => courtTimes(id)));
    const version = (await rule(ruleId)).version;

    const res = await call(
      'PUT',
      `${base(c)}/${ruleId}`,
      c.admin,
      editBody(createBody(), version, {
        location: 'New Hall',
        maxPlayers: 24,
        ...PAID,
        courts: [{ identifier: 'Court 1', startTime: '18:30', endTime: '20:30' }],
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const saved = res.json<{
      series: SeriesResponse;
      outcome: {
        updated: number;
        unchanged: number;
        skipped: Record<string, number>;
      };
    }>();
    expect(saved.outcome).toEqual({
      updated: 2,
      unchanged: 0,
      skipped: { edited: 1, started: 0, closed: 1, deadlinePassed: 1, feeLocked: 1 },
    });
    expect(res.json<{ changed: boolean }>().changed).toBe(true);
    expect(saved.series.version).toBeGreaterThan(version);
    expect(saved.series.location).toBe('New Hall');

    for (const id of [publishedTarget, draftTarget]) {
      expect(await sessionRow(id)).toMatchObject({
        location: 'New Hall',
        max_players: 24,
        fee_flat: '10.00',
      });
      expect(await courtTimes(id)).toEqual(['18:30-20:30']);
    }
    expect((await sessionRow(publishedTarget)).status).toBe('PUBLISHED');
    expect((await sessionRow(draftTarget)).status).toBe('DRAFT');
    expect((await sessionRow(publishedTarget)).is_instance_overridden).toBe(false);
    // Edited, closed, past, deadline-passed and fee-locked instances are byte-for-byte unchanged.
    expect(await Promise.all(untouched.map((id) => sessionRow(id)))).toEqual(beforeRows);
    expect(await Promise.all(untouched.map((id) => courtTimes(id)))).toEqual(beforeCourts);
    expect(triggersOf(ruleId)).toEqual(['rule_updated']);
    // Capacity rose from 12 to 24 on every target: only the one published target that was updated is promoted.
    expect(allocator.promoteCalls.map((call) => call.sessionId)).toEqual([publishedTarget]);
    expect(allocator.promoteCalls.every((call) => call.inTransaction)).toBe(true);
  });

  it('calls promoteWaitlist once per published target whose public capacity rose, and not for a lowered one', async () => {
    const c = await scene({ payout: true });
    const ruleId = await insertRule(database.pool, c.teamId);
    const grow = await insertSession(
      database.pool,
      c.teamId,
      {},
      { date: '2026-10-21', status: 'PUBLISHED', recurringRuleId: ruleId, maxPlayers: 12 },
    );
    const version = (await rule(ruleId)).version;
    const res = await call(
      'PUT',
      `${base(c)}/${ruleId}`,
      c.admin,
      editBody(createBody(), version, {
        maxPlayers: 20,
        reservedSeats: 0,
        ...PAID,
        courtCost: '200.00',
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(allocator.promoteCalls).toHaveLength(1);
    expect(allocator.promoteCalls[0]).toMatchObject({ sessionId: grow, teamId: c.teamId });

    allocator.reset();
    const lowered = await call(
      'PUT',
      `${base(c)}/${ruleId}`,
      c.admin,
      editBody(createBody(), (await rule(ruleId)).version, {
        maxPlayers: 10,
        reservedSeats: 0,
        courtCost: '100.00',
      }),
    );
    expect(lowered.statusCode, lowered.body).toBe(200);
    expect(allocator.promoteCalls).toHaveLength(0);
    expect((await sessionRow(grow)).max_players).toBe(10);
  });

  it('refuses the WHOLE edit with 409 when a free-to-paid change would reach a published session and banking is not set up', async () => {
    const c = await scene({ payout: false });
    const ruleId = await insertRule(database.pool, c.teamId);
    const published = await insertSession(
      database.pool,
      c.teamId,
      { flat: '0.00' },
      { date: '2026-10-21', status: 'PUBLISHED', recurringRuleId: ruleId },
    );
    const draft = await insertSession(
      database.pool,
      c.teamId,
      { flat: '0.00' },
      { date: '2026-10-28', recurringRuleId: ruleId },
    );
    const ruleBefore = await rule(ruleId);
    const publishedBefore = await sessionRow(published);
    const draftBefore = await sessionRow(draft);
    recorder.reset();

    const res = await call(
      'PUT',
      `${base(c)}/${ruleId}`,
      c.admin,
      editBody(createBody(), ruleBefore.version, PAID),
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).code).toBe('payout_not_configured');
    // The gate ran, and before any rule or session lock or write; nothing was saved.
    recorder.assertBefore(GATE, SERIES_LOCK_OR_WRITE);
    expect(recorder.indexOf(SERIES_LOCK_OR_WRITE)).toBe(-1);
    expect(await rule(ruleId)).toEqual(ruleBefore);
    expect(await sessionRow(published)).toEqual(publishedBefore);
    expect(await sessionRow(draft)).toEqual(draftBefore);
    expect(triggersOf(ruleId)).toEqual([]);
  });

  it('updates DRAFT-only targets for an unconfigured team without consulting the gate', async () => {
    const c = await scene({ payout: false });
    const ruleId = await insertRule(database.pool, c.teamId);
    const draft = await insertSession(
      database.pool,
      c.teamId,
      { flat: '0.00' },
      { date: '2026-10-28', recurringRuleId: ruleId },
    );
    recorder.reset();
    const res = await call(
      'PUT',
      `${base(c)}/${ruleId}`,
      c.admin,
      editBody(createBody(), (await rule(ruleId)).version, PAID),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(recorder.indexOf(GATE)).toBe(-1);
    expect(await sessionRow(draft)).toMatchObject({ fee_flat: '10.00', status: 'DRAFT' });
  });

  it('gates a configured team before any lock, then takes the locks in the ARCH order: teams, rule, member, sessions', async () => {
    const c = await scene({ payout: true });
    const ruleId = await insertRule(database.pool, c.teamId);
    const published = await insertSession(
      database.pool,
      c.teamId,
      { flat: '0.00' },
      { date: '2026-10-21', status: 'PUBLISHED', recurringRuleId: ruleId },
    );
    recorder.reset();
    const res = await call(
      'PUT',
      `${base(c)}/${ruleId}`,
      c.admin,
      editBody(createBody(), (await rule(ruleId)).version, PAID),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect((await sessionRow(published)).fee_flat).toBe('10.00');
    recorder.assertBefore(GATE, SERIES_LOCK_OR_WRITE);
    const at = (pattern: RegExp): number => recorder.indexOf(pattern);
    const order = [
      at(/from "teams".*for key share/),
      at(/from "recurring_session_rules".*for no key update/),
      at(/from "team_members".*for share/),
      at(/from "game_sessions".*for update/),
    ];
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('answers 409 series_stale with the current series on a stale real change, and 200 with no write on a no-op', async () => {
    const c = await scene();
    const { ruleId, body, version } = await seriesWithInstances(c);
    enqueued.length = 0;

    const noop = await call('PUT', `${base(c)}/${ruleId}`, c.admin, editBody(body, version));
    expect(noop.statusCode, noop.body).toBe(200);
    expect(noop.json<{ changed: boolean }>().changed).toBe(false);
    expect((await rule(ruleId)).version).toBe(version);
    expect(enqueued).toHaveLength(0);
    // Whatever the version: nothing to change is not stale.
    const noopStale = await call(
      'PUT',
      `${base(c)}/${ruleId}`,
      c.admin,
      editBody(body, version + 7),
    );
    expect(noopStale.statusCode).toBe(200);
    expect(noopStale.json<{ changed: boolean }>().changed).toBe(false);

    const stale = await call(
      'PUT',
      `${base(c)}/${ruleId}`,
      c.admin,
      editBody(body, version + 7, { maxPlayers: 30 }),
    );
    expect(stale.statusCode, stale.body).toBe(409);
    expect(errorOf(stale).code).toBe('series_stale');
    expect(errorOf(stale).current).toMatchObject({ id: ruleId, version });
    expect((await rule(ruleId)).default_max_players).toBe(24);
    expect(enqueued).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Re-checks under the locks: the unlocked read passed, then the series changed while the write queued behind the team lock
// ---------------------------------------------------------------------------------------------

describe('a series write re-checks the rule once it holds the locks (AC-ERROR-7, P-3, T-6)', () => {
  /** A rule with a last date and no instances: it matches `createBody({ recurUntil })`, so a PUT passes every unlocked check. */
  async function ruleWithLastDate(c: Scene): Promise<{ ruleId: string; body: Body }> {
    const ruleId = await insertRule(database.pool, c.teamId, { recurUntil: '2026-12-30' });
    return { ruleId, body: createBody({ recurUntil: '2026-12-30', location: 'Changed Hall' }) };
  }
  const endBody = { expectedVersion: 1, lastDate: '2026-11-04' };
  const putUnderLock = (
    c: Scene,
    ruleId: string,
    body: Body,
    change: string,
  ): Promise<LightMyRequestResponse[]> =>
    raceUnderTeamLock(
      database.pool,
      c.teamId,
      [() => call('PUT', `${base(c)}/${ruleId}`, c.admin, editBody(body, 1))],
      { beforeRelease: (lock) => lock.query(change, [ruleId]).then(() => undefined) },
    );
  const endUnderLock = (
    c: Scene,
    ruleId: string,
    change: string,
  ): Promise<LightMyRequestResponse[]> =>
    raceUnderTeamLock(
      database.pool,
      c.teamId,
      [() => call('POST', `${base(c)}/${ruleId}/end`, c.admin, endBody)],
      { beforeRelease: (lock) => lock.query(change, [ruleId]).then(() => undefined) },
    );
  const SWITCH_OFF = 'UPDATE recurring_session_rules SET is_active = false WHERE id = $1';
  const DELETE_RULE = 'DELETE FROM recurring_session_rules WHERE id = $1';

  it('End series refuses an old expectedVersion with 409 series_stale and the current series, ending nothing', async () => {
    const c = await scene();
    const { ruleId } = await ruleWithLastDate(c);
    enqueued.length = 0;
    const res = await call('POST', `${base(c)}/${ruleId}/end`, c.admin, {
      expectedVersion: 7,
      lastDate: '2026-11-04',
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).code).toBe('series_stale');
    expect(errorOf(res).current).toMatchObject({ id: ruleId, version: 1 });
    expect((await rule(ruleId)).recur_until).toBe('2026-12-30');
    expect(enqueued).toHaveLength(0);
  });

  it('an edit that queued behind the team lock finds the series switched off meanwhile: 409 series_ended, nothing written', async () => {
    const c = await scene();
    const { ruleId, body } = await ruleWithLastDate(c);
    const [res] = await putUnderLock(c, ruleId, body, SWITCH_OFF);
    expect(res?.statusCode, res?.body).toBe(409);
    expect(res && errorOf(res).code).toBe('series_ended');
    expect((await rule(ruleId)).default_location).toBe('Test Hall');
  });

  it('an edit that queued behind the team lock finds the series deleted meanwhile: 404 not_found', async () => {
    const c = await scene();
    const { ruleId, body } = await ruleWithLastDate(c);
    const [res] = await putUnderLock(c, ruleId, body, DELETE_RULE);
    expect(res?.statusCode, res?.body).toBe(404);
    expect(res && errorOf(res).code).toBe('not_found');
  });

  it('an edit that queued behind the team lock finds its last date shortened meanwhile: 422 on recurUntil, nothing written', async () => {
    const c = await scene();
    const { ruleId, body } = await ruleWithLastDate(c);
    const [res] = await putUnderLock(
      c,
      ruleId,
      body,
      "UPDATE recurring_session_rules SET recur_until = '2027-03-31' WHERE id = $1",
    );
    expect(res?.statusCode, res?.body).toBe(422);
    expect(Object.keys((res && errorOf(res).fieldErrors) ?? {})).toContain('recurUntil');
    expect((await rule(ruleId)).default_location).toBe('Test Hall');
  });

  it('End series that queued behind the team lock finds the series switched off meanwhile: 409 series_ended', async () => {
    const c = await scene();
    const { ruleId } = await ruleWithLastDate(c);
    const [res] = await endUnderLock(c, ruleId, SWITCH_OFF);
    expect(res?.statusCode, res?.body).toBe(409);
    expect(res && errorOf(res).code).toBe('series_ended');
  });

  it('End series that queued behind the team lock finds the series deleted meanwhile: 404 not_found', async () => {
    const c = await scene();
    const { ruleId } = await ruleWithLastDate(c);
    const [res] = await endUnderLock(c, ruleId, DELETE_RULE);
    expect(res?.statusCode, res?.body).toBe(404);
    expect(res && errorOf(res).code).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------------------------
// AC-ERROR-12: the pattern is fixed
// ---------------------------------------------------------------------------------------------

describe('a series pattern is fixed after creation (AC-ERROR-12)', () => {
  it('refuses a changed day, frequency, first date or monthly week, and a shortened recurUntil; extending or clearing is allowed', async () => {
    const c = await scene();
    const { ruleId, body, version } = await seriesWithInstances(c, { recurUntil: '2026-12-30' });
    const before = await rule(ruleId);
    enqueued.length = 0;

    const moved = await call(
      'PUT',
      `${base(c)}/${ruleId}`,
      c.admin,
      editBody(body, version, { dayOfWeek: 4, startsOn: '2026-10-08' }),
    );
    expect(moved.statusCode, moved.body).toBe(422);
    expect(errorOf(moved).code).toBe('validation_failed');
    expect(errorOf(moved).fieldErrors).toMatchObject({
      dayOfWeek: ['series_pattern_fixed'],
      startsOn: ['series_pattern_fixed'],
    });

    const frequency = await call(
      'PUT',
      `${base(c)}/${ruleId}`,
      c.admin,
      editBody(body, version, { frequency: 'FORTNIGHTLY' }),
    );
    expect(frequency.statusCode).toBe(422);
    expect(errorOf(frequency).fieldErrors).toMatchObject({ frequency: ['series_pattern_fixed'] });

    const shortened = await call(
      'PUT',
      `${base(c)}/${ruleId}`,
      c.admin,
      editBody(body, version, { recurUntil: '2026-11-25' }),
    );
    expect(shortened.statusCode).toBe(422);
    expect(errorOf(shortened).fieldErrors).toEqual({
      recurUntil: ['To stop the series sooner, use End series.'],
    });
    expect(await rule(ruleId)).toEqual(before);
    expect(enqueued).toHaveLength(0);

    const extended = await call(
      'PUT',
      `${base(c)}/${ruleId}`,
      c.admin,
      editBody(body, version, { recurUntil: '2027-03-31' }),
    );
    expect(extended.statusCode, extended.body).toBe(200);
    expect((await rule(ruleId)).recur_until).toBe('2027-03-31');
    expect(triggersOf(ruleId)).toEqual(['rule_updated']);
    const cleared = await call(
      'PUT',
      `${base(c)}/${ruleId}`,
      c.admin,
      editBody(body, (await rule(ruleId)).version, { recurUntil: null }),
    );
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((await rule(ruleId)).recur_until).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// AC-HAPPY-10: End series
// ---------------------------------------------------------------------------------------------

/** A series that began 2026-09-30, with the instances of AC-HAPPY-10 after 2026-10-14. */
async function endScene(c: Scene): Promise<{
  ruleId: string;
  drafts: string[];
  editedDraft: string;
  published: string[];
  onOrBefore: string[];
}> {
  const ruleId = await insertRule(database.pool, c.teamId, { startsOn: '2026-09-30' });
  const mk = (date: string, status: 'DRAFT' | 'PUBLISHED') =>
    insertSession(database.pool, c.teamId, {}, { date, status, recurringRuleId: ruleId });
  const onOrBefore = [await mk('2026-10-07', 'PUBLISHED'), await mk('2026-10-14', 'DRAFT')];
  const drafts = [await mk('2026-10-21', 'DRAFT'), await mk('2026-10-28', 'DRAFT')];
  const editedDraft = await mk('2026-11-04', 'DRAFT');
  await database.pool.query(
    `UPDATE game_sessions SET is_instance_overridden = true WHERE id = $1`,
    [editedDraft],
  );
  const published = [
    await mk('2026-11-11', 'PUBLISHED'),
    await mk('2026-11-18', 'PUBLISHED'),
    await mk('2026-11-25', 'PUBLISHED'),
  ];
  for (const sessionId of published) {
    await insertRegistration(database.pool, {
      sessionId,
      teamId: c.teamId,
      userId: c.memberId,
      status: 'CONFIRMED',
    });
  }
  return { ruleId, drafts, editedDraft, published, onOrBefore };
}

describe('End series (AC-HAPPY-10)', () => {
  it('sets recur_until, deletes unedited drafts after it, keeps edited drafts and published sessions, enqueues rule_ended', async () => {
    const c = await scene();
    const s = await endScene(c);
    const beforeKept = await Promise.all(
      [...s.onOrBefore, s.editedDraft, ...s.published].map((id) => sessionRow(id)),
    );
    const res = await call('POST', `${base(c)}/${s.ruleId}/end`, c.admin, {
      expectedVersion: (await rule(s.ruleId)).version,
      lastDate: '2026-10-14',
    });
    expect(res.statusCode, res.body).toBe(200);
    const ended = res.json<{
      series: SeriesResponse;
      removedDrafts: number;
      cancelledPublished: number;
      keptOffPattern: { sessionId: string; date: string; status: string }[];
      activeRegistrationCount: number;
    }>();
    expect(ended).toMatchObject({
      removedDrafts: 2,
      cancelledPublished: 0,
      activeRegistrationCount: 0,
    });
    expect(ended.keptOffPattern.map((kept) => kept.sessionId).sort()).toEqual(
      [s.editedDraft, ...s.published].sort(),
    );
    expect(ended.series).toMatchObject({ recurUntil: '2026-10-14', isActive: true });
    expect(await rule(s.ruleId)).toMatchObject({ recur_until: '2026-10-14', is_active: true });
    expect((await sessionsOf(s.ruleId)).map((row) => row.date)).toEqual([
      '2026-10-07',
      '2026-10-14',
      '2026-11-04',
      '2026-11-11',
      '2026-11-18',
      '2026-11-25',
    ]);
    // Everything kept is byte-for-byte as it was.
    expect(
      await Promise.all(
        [...s.onOrBefore, s.editedDraft, ...s.published].map((id) => sessionRow(id)),
      ),
    ).toEqual(beforeKept);
    expect(triggersOf(s.ruleId)).toEqual(['rule_ended']);
  });

  it('cancels the published sessions after the last date when asked, leaves registrations alone, and deactivates a series ended today', async () => {
    const c = await scene();
    const s = await endScene(c);
    const res = await call('POST', `${base(c)}/${s.ruleId}/end`, c.admin, {
      expectedVersion: (await rule(s.ruleId)).version,
      lastDate: '2026-10-06',
      alsoCancelPublished: true,
    });
    expect(res.statusCode, res.body).toBe(200);
    const ended = res.json<{
      series: SeriesResponse;
      removedDrafts: number;
      cancelledPublished: number;
      activeRegistrationCount: number;
    }>();
    // 10-07 is published and after the last date too: four published sessions are cancelled, three with a player each.
    expect(ended).toMatchObject({
      removedDrafts: 3,
      cancelledPublished: 4,
      activeRegistrationCount: 3,
    });
    expect(ended.series).toMatchObject({ recurUntil: '2026-10-06', isActive: false });
    const after = await sessionsOf(s.ruleId);
    expect(after.filter((row) => row.status === 'CANCELLED')).toHaveLength(4);
    expect(after.filter((row) => row.status === 'DRAFT').map((row) => row.date)).toEqual([
      '2026-11-04',
    ]);
    const { rows } = await database.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM registrations WHERE session_id = ANY($1::uuid[]) AND status = 'CONFIRMED'`,
      [s.published],
    );
    expect(Number(rows[0]?.n)).toBe(3);
    expect(triggersOf(s.ruleId)).toEqual(['rule_ended']);

    // An ended series cannot be edited again.
    const again = await call(
      'PUT',
      `${base(c)}/${s.ruleId}`,
      c.admin,
      editBody(createBody({ startsOn: '2026-09-30' }), (await rule(s.ruleId)).version, {
        maxPlayers: 30,
      }),
    );
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).code).toBe('series_ended');
  });
});

// ---------------------------------------------------------------------------------------------
// P-3 / T-6: a series past its last date is ended, read-time (nothing flips is_active later)
// ---------------------------------------------------------------------------------------------

describe('a series past its last date is ended (P-3, T-6)', () => {
  /** 13:00 NZDT on the given 2026 October day (the injected clock; no sleeping). */
  const nzDay = (day: number): Date => new Date(Date.UTC(2026, 9, day, 0, 0, 0));
  interface ListBody {
    series: { id: string; isActive: boolean; recurUntil: string | null }[];
  }

  it('is still active ON its last date, then reads as ended the day after: GET, list order, edit, End and Publish drafts all refuse', async () => {
    const c = await scene();
    const { ruleId, body } = await seriesWithInstances(c, { recurUntil: '2026-10-14' });
    const later = await insertRule(database.pool, c.teamId, {
      dayOfWeek: 6,
      startsOn: '2026-10-10',
    });

    // The last date itself: the series is still active (its last session may be today).
    h.clock.set(nzDay(14));
    const onLastDate = await call('GET', `${base(c)}/${ruleId}`, c.admin);
    expect(seriesOf(onLastDate)).toMatchObject({ isActive: true, recurUntil: '2026-10-14' });
    const listOn = (await call('GET', base(c), c.admin)).json<ListBody>().series;
    expect(listOn.find((s) => s.id === ruleId)?.isActive).toBe(true);
    const publishOn = await call('POST', `${base(c)}/${ruleId}/publish-drafts`, c.admin, {});
    expect(publishOn.statusCode, publishOn.body).toBe(202);

    // The day after: ended, though no job ever flipped the stored flag.
    h.clock.set(nzDay(15));
    const before = await rule(ruleId);
    expect(before.is_active).toBe(true);
    const got = await call('GET', `${base(c)}/${ruleId}`, c.admin);
    expect(got.statusCode, got.body).toBe(200);
    expect(seriesOf(got)).toMatchObject({ isActive: false, recurUntil: '2026-10-14' });
    const listed = (await call('GET', base(c), c.admin)).json<ListBody>().series;
    expect(listed.map((s) => [s.id, s.isActive])).toEqual([
      [later, true],
      [ruleId, false],
    ]);
    expect(listed[1]?.recurUntil).toBe('2026-10-14');

    enqueued.length = 0;
    for (const recurUntil of [null, '2026-12-30']) {
      const put = await call(
        'PUT',
        `${base(c)}/${ruleId}`,
        c.admin,
        editBody(body, before.version, { recurUntil }),
      );
      expect(put.statusCode, `PUT recurUntil ${String(recurUntil)}`).toBe(409);
      expect(errorOf(put).code).toBe('series_ended');
    }
    const end = await call('POST', `${base(c)}/${ruleId}/end`, c.admin, {
      expectedVersion: before.version,
      lastDate: '2026-10-20',
    });
    expect(end.statusCode, end.body).toBe(409);
    expect(errorOf(end).code).toBe('series_ended');
    const publish = await call('POST', `${base(c)}/${ruleId}/publish-drafts`, c.admin, {});
    expect(publish.statusCode, publish.body).toBe(409);
    expect(errorOf(publish).code).toBe('series_ended');

    // Nothing restarted it.
    expect(await rule(ruleId)).toEqual(before);
    expect(enqueued).toHaveLength(0);
  });

  it('shows a series ended by End series (future last date) as ended once that date has passed', async () => {
    const c = await scene();
    const s = await seriesWithInstances(c);
    const res = await call('POST', `${base(c)}/${s.ruleId}/end`, c.admin, {
      expectedVersion: s.version,
      lastDate: '2026-10-14',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(seriesOf(res).isActive).toBe(true);
    h.clock.set(nzDay(15));
    expect(seriesOf(await call('GET', `${base(c)}/${s.ruleId}`, c.admin)).isActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-ASYNC-7: Publish drafts now
// ---------------------------------------------------------------------------------------------

describe('Publish drafts now (AC-ASYNC-7)', () => {
  it('enqueues one manual rule job and answers 202; a double click leaves one queued job; the run publishes unedited drafts only', async () => {
    const c = await scene({ payout: true });
    const ruleId = await insertRule(database.pool, c.teamId);
    const unedited = await insertSession(
      database.pool,
      c.teamId,
      {},
      { date: '2026-10-07', recurringRuleId: ruleId },
    );
    const edited = await insertSession(
      database.pool,
      c.teamId,
      {},
      { date: '2026-10-14', recurringRuleId: ruleId },
    );
    await database.pool.query(
      `UPDATE game_sessions SET is_instance_overridden = true WHERE id = $1`,
      [edited],
    );

    const first = await call('POST', `${base(c)}/${ruleId}/publish-drafts`, c.admin, {});
    expect(first.statusCode, first.body).toBe(202);
    expect(first.json<{ queued: boolean }>().queued).toBe(true);
    const second = await call('POST', `${base(c)}/${ruleId}/publish-drafts`, c.admin, {});
    expect(second.statusCode).toBe(202);
    expect(second.json<{ queued: boolean }>().queued).toBe(false);
    expect(await ruleJobs(ruleId)).toEqual([{ trigger: 'manual' }]);

    await materialiseRule(materialiseDeps(), { ruleId, teamId: c.teamId, trigger: 'manual' });
    expect((await sessionRow(unedited)).status).toBe('PUBLISHED');
    expect((await sessionRow(edited)).status).toBe('DRAFT');
    expect(allocator.autoEnrolCalls.map((entry) => entry.sessionId)).not.toContain(edited);
  });
});
