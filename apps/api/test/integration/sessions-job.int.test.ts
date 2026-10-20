/**
 * The series materialiser and its jobs on real PostgreSQL 17 + pg-boss (session-scheduling-engine Phase 3, job side).
 * ACs: AC-ASYNC-1..6, AC-ERROR-9, AC-VERIFY-2 (materialiser and retry paths), AC-HAPPY-12 (materialiser path),
 * AC-INTEGRATION-2 (materialiser path). The run is called directly with an injected manual clock, a recording allocator
 * double and a statement recorder (gate-before-lock), and the sweep fan-out and boot enqueue go through the production
 * `registerJobs` wiring on a real worker. Every test uses its own team, so rows left by an earlier test never change
 * another test's counts; the sweep and end-to-end blocks first retire every earlier rule and pending session.
 *
 * "Today" is Tuesday 2026-10-20 in NZ (the clock reads 2026-10-19T21:00Z, 10:00 NZDT). A Tuesday rule that starts at 19:00
 * therefore has the window dates 10-20, 10-27, 11-03, 11-10 and 11-17 (today and today + 28, both inclusive).
 */
import { PostgresDialect } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerJobs, enqueueBootSweeps } from '../../src/jobs/bootstrap.ts';
import { createRecurrenceMaterialisationHandler } from '../../src/jobs/recurrence-materialisation.ts';
import { QUEUES } from '../../src/jobs/registry.ts';
import { createKysely, type Database } from '../../src/lib/db/kysely.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import { createJobRunner, type JobContext, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import { createInMemoryNotifier } from '../../src/lib/notifications/adapters/in-memory.ts';
import { selectAutoEnrollees } from '../../src/modules/skill-levels/auto-enrol.ts';
import type { SessionAllocatorContext } from '../../src/modules/sessions/allocator-port.ts';
import {
  failureVerdict,
  materialiseRule,
  type MaterialiseDeps,
} from '../../src/modules/sessions/materialise.ts';
import type { RecurrenceRulePayload } from '../../src/modules/sessions/rule-jobs.ts';
import { testCrypto } from '../helpers/app-deps.ts';
import {
  insertRule,
  insertSession,
  insertTeamMember,
  insertUser,
  payoutBlockFor,
  type RuleOptions,
} from '../helpers/factories.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import { createQueryRecorder, createRecordingDatabase } from '../helpers/query-recorder.ts';
import { createRecordingAllocator, createSessionsScene } from '../helpers/sessions-scene.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';
import { waitFor } from '../helpers/wait-for.ts';

/** 10:00 on Tuesday 2026-10-20 in NZ (NZDT, +13). */
const NOW = new Date('2026-10-19T21:00:00Z');
const FIVE_DATES = ['2026-10-20', '2026-10-27', '2026-11-03', '2026-11-10', '2026-11-17'];
const GATE = /select "is_payout_configured", "payout_blocked_at" from "teams".*for key share/;
const SESSION_LOCK_OR_WRITE =
  /from "game_sessions".*for update|update "game_sessions"|insert into "game_sessions"|insert into "session_courts"|delete from "session_courts"|update "session_courts"/;

let database: TestDatabase;
let kysely: Database;
let producer: JobRunner;
let worker: JobRunner;
const recorder = createQueryRecorder();
const clock = createManualClock(NOW);
const allocator = createRecordingAllocator();
const recordingAutoEnrol = allocator.autoEnrolInSession.bind(allocator);
const enqueued: {
  queue: string;
  data: Record<string, unknown>;
  singletonKey: string | undefined;
}[] = [];

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 16 });
  kysely = createRecordingDatabase(new PostgresDialect({ pool: database.pool }), recorder);
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
  // Queues must exist for a producer to send; the direct-run tests do not work them.
  for (const queue of QUEUES) await worker.defineQueue(queue);
});
afterAll(async () => {
  await producer.stop();
  await worker.stop();
  await database.close();
});
beforeEach(() => {
  clock.set(NOW);
  allocator.reset();
  allocator.enrols = true;
  allocator.outcome = { ok: true, status: 'CONFIRMED' };
  allocator.autoEnrolInSession = recordingAutoEnrol;
  recorder.reset();
  enqueued.length = 0;
});

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

interface Harness {
  readonly deps: MaterialiseDeps;
  readonly logs: ReturnType<typeof captureLogs>;
  readonly emails: { to: string; subject: string; text: string; idempotencyKey: string }[];
}

function harness(over: Partial<MaterialiseDeps> = {}): Harness {
  const logs = captureLogs();
  const emails: Harness['emails'] = [];
  const deps: MaterialiseDeps = {
    db: kysely,
    clock,
    allocator,
    jobs: {
      enqueue: (queue, data, options) => {
        enqueued.push({
          queue,
          data: data as Record<string, unknown>,
          singletonKey: options?.singletonKey,
        });
        return producer.enqueue(queue, data, options);
      },
    },
    notice: {
      webBaseUrl: 'https://app.example.test',
      sendEmail: (message) => {
        emails.push(message);
        return Promise.resolve();
      },
    },
    log: logs.logger,
    horizonDays: 28,
    ...over,
  };
  return { deps, logs, emails };
}

const payloadFor = (
  ruleId: string,
  teamId: string,
  trigger: RecurrenceRulePayload['trigger'] = 'sweep',
): RecurrenceRulePayload => ({ ruleId, teamId, trigger });

/** A Tuesday rule (19:00-21:00 NZ) with a $17.00 pinned FLAT rate, so its sessions are paid. */
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

/** A Tuesday rule with no costing: its sessions are free, so the publish gate is never consulted. */
const freeRule = (teamId: string, options: RuleOptions = {}): Promise<string> =>
  insertRule(database.pool, teamId, { dayOfWeek: 2, startsOn: '2026-10-06', ...options });

interface Row {
  id: string;
  date: string;
  status: string;
  auto_enrolled_at: Date | null;
  fee_flat: string | null;
  deadline_is_default: boolean;
  auto_enrol_required: boolean;
}

async function sessionsOf(ruleId: string): Promise<Row[]> {
  const { rows } = await database.pool.query<Row>(
    `SELECT id, date::text AS date, status, auto_enrolled_at, fee_flat, deadline_is_default, auto_enrol_required
       FROM game_sessions WHERE recurring_rule_id = $1 ORDER BY date`,
    [ruleId],
  );
  return rows;
}

async function configureBanking(teamId: string): Promise<void> {
  const block = payoutBlockFor(teamId);
  await database.pool.query(
    `UPDATE teams SET bank_account_name = $2, bank_account_number = $3, bank_account_last4 = $4 WHERE id = $1`,
    [teamId, block.name, block.number, block.last4],
  );
}

async function claimsOf(ruleId: string): Promise<string[]> {
  const { rows } = await database.pool.query<{ window_start: string }>(
    `SELECT window_start::text AS window_start FROM payout_notice_claims WHERE rule_id = $1 ORDER BY window_start`,
    [ruleId],
  );
  return rows.map((row) => row.window_start);
}

async function autoEnrollMember(
  teamId: string,
  assignedAt: string,
  until: string | null,
): Promise<{ userId: string; membershipId: string }> {
  const userId = await insertUser(database.pool, 'MALE');
  const membershipId = await insertTeamMember(database.pool, { teamId, userId });
  await database.pool.query(
    `UPDATE team_members SET is_auto_enroll = true, auto_enroll_assigned_at = $2, auto_enroll_until = $3 WHERE id = $1`,
    [membershipId, assignedAt, until],
  );
  return { userId, membershipId };
}

const eventsOf = (logs: ReturnType<typeof captureLogs>, event: string) =>
  logs.lines().filter((line) => line.event === event);

// ---------------------------------------------------------------------------------------------
// AC-ASYNC-1: window, idempotency, DST
// ---------------------------------------------------------------------------------------------

describe('window and idempotency (AC-ASYNC-1)', () => {
  it('creates each date from today to today + horizon inclusive as a published, defaulted session with its courts and stamps the rule', async () => {
    const scene = await createSessionsScene(database.pool, { payoutConfigured: true });
    const ruleId = await paidRule(scene.teamId);
    const { deps, logs } = harness();

    const result = await materialiseRule(deps, payloadFor(ruleId, scene.teamId));

    expect(result).toMatchObject({
      created: 5,
      published: 5,
      savedAsDraft: 0,
      draftsRetried: 0,
      failed: 0,
      windowStart: '2026-10-20',
    });
    const rows = await sessionsOf(ruleId);
    expect(rows.map((row) => row.date)).toEqual(FIVE_DATES);
    expect(rows.every((row) => row.status === 'PUBLISHED')).toBe(true);
    expect(rows.every((row) => row.fee_flat === '17.00')).toBe(true);
    expect(rows.every((row) => row.deadline_is_default && row.auto_enrol_required)).toBe(true);

    const { rows: courts } = await database.pool.query<{ n: string; ok: boolean }>(
      `SELECT count(*)::text AS n,
              bool_and(s.cancellation_deadline = s.starts_at - interval '48 hours') AS ok
         FROM session_courts c JOIN game_sessions s ON s.id = c.session_id WHERE s.recurring_rule_id = $1`,
      [ruleId],
    );
    expect(courts[0]).toEqual({ n: '5', ok: true });

    const { rows: rule } = await database.pool.query<{ stamped: boolean; at: Date | null }>(
      `SELECT materialised_version = version AS stamped, materialised_at AS at
         FROM recurring_session_rules WHERE id = $1`,
      [ruleId],
    );
    expect(rule[0]?.stamped).toBe(true);
    expect(rule[0]?.at).toBeInstanceOf(Date);

    expect(eventsOf(logs, 'session.recurrence.instance_created')).toHaveLength(5);
    expect(typeof eventsOf(logs, 'session.recurrence.run_completed')[0]?.durationMs).toBe('number');
    expect(eventsOf(logs, 'session.recurrence.run_completed')[0]).toMatchObject({
      teamId: scene.teamId,
      ruleId,
      trigger: 'sweep',
      windowStart: '2026-10-20',
      created: 5,
      published: 5,
      savedAsDraft: 0,
      draftsRetried: 0,
      failed: 0,
    });
  });

  it('skips a date whose start has already passed instead of creating or publishing it', async () => {
    const scene = await createSessionsScene(database.pool, { payoutConfigured: true });
    const ruleId = await paidRule(scene.teamId);
    // 20:00 NZDT on 10-20: today's 19:00 session has started.
    clock.set(new Date('2026-10-20T07:00:00Z'));
    const { deps } = harness();

    const result = await materialiseRule(deps, payloadFor(ruleId, scene.teamId));

    expect(result.created).toBe(4);
    expect((await sessionsOf(ruleId)).map((row) => row.date)).toEqual(FIVE_DATES.slice(1));
  });

  it('honours a shorter horizon: 7 days gives today and today + 7 only', async () => {
    const scene = await createSessionsScene(database.pool, { payoutConfigured: true });
    const ruleId = await paidRule(scene.teamId);
    const { deps } = harness({ horizonDays: 7 });

    await materialiseRule(deps, payloadFor(ruleId, scene.teamId));

    expect((await sessionsOf(ruleId)).map((row) => row.date)).toEqual(['2026-10-20', '2026-10-27']);
  });

  it('a re-run creates nothing and leaves every row as it was', async () => {
    const scene = await createSessionsScene(database.pool, { payoutConfigured: true });
    const ruleId = await paidRule(scene.teamId);
    const { deps } = harness();
    await materialiseRule(deps, payloadFor(ruleId, scene.teamId));
    const before = await sessionsOf(ruleId);

    const again = await materialiseRule(deps, payloadFor(ruleId, scene.teamId));

    expect(again).toMatchObject({ created: 0, published: 0, savedAsDraft: 0, failed: 0 });
    expect(await sessionsOf(ruleId)).toEqual(before);
  });

  it('two runs at the same moment create each date exactly once', async () => {
    const scene = await createSessionsScene(database.pool, { payoutConfigured: true });
    const ruleId = await paidRule(scene.teamId);
    const a = harness();
    const b = harness();

    const [first, second] = await Promise.all([
      materialiseRule(a.deps, payloadFor(ruleId, scene.teamId)),
      materialiseRule(b.deps, payloadFor(ruleId, scene.teamId)),
    ]);

    expect(first.created + second.created).toBe(5);
    expect(first.failed + second.failed).toBe(0);
    expect(await sessionsOf(ruleId)).toHaveLength(5);
  });

  it('does nothing for an inactive, ended or unknown rule, and stops an existing one from waiting', async () => {
    const scene = await createSessionsScene(database.pool, { payoutConfigured: true });
    const inactive = await paidRule(scene.teamId, { isActive: false });
    const ended = await paidRule(scene.teamId, { recurUntil: '2026-10-13' });
    const { deps, logs } = harness();

    expect(await materialiseRule(deps, payloadFor(inactive, scene.teamId))).toMatchObject({
      skipped: 'inactive',
      created: 0,
    });
    expect(await materialiseRule(deps, payloadFor(ended, scene.teamId))).toMatchObject({
      skipped: 'ended',
      created: 0,
    });
    expect(
      await materialiseRule(deps, payloadFor('0b6f0a5e-5d0b-4a52-9d52-0d9a0f0b1c11', scene.teamId)),
    ).toMatchObject({ skipped: 'not_found' });

    expect(await sessionsOf(inactive)).toHaveLength(0);
    expect(await sessionsOf(ended)).toHaveLength(0);
    expect(eventsOf(logs, 'session.recurrence.rule_skipped').map((line) => line.reason)).toEqual([
      'inactive',
      'ended',
      'not_found',
    ]);
    const { rows } = await database.pool.query<{ stamped: boolean }>(
      `SELECT materialised_version = version AS stamped FROM recurring_session_rules WHERE id = ANY($1::uuid[])`,
      [[inactive, ended]],
    );
    expect(rows.every((row) => row.stamped)).toBe(true);
  });

  it('stores a template court time inside the spring-forward gap as the real wall time, and never fails the run', async () => {
    const scene = await createSessionsScene(database.pool);
    // Sunday 2026-09-27 is the DST start: 02:30 does not exist and becomes 03:30.
    const ruleId = await insertRule(database.pool, scene.teamId, {
      dayOfWeek: 0,
      startsOn: '2026-09-20',
      courts: [{ identifier: 'Court 1', start: '02:30', end: '04:30' }],
    });
    clock.set(new Date('2026-09-20T12:00:00Z')); // 00:00 on 2026-09-21 NZST
    const { deps } = harness({ horizonDays: 7 });

    const result = await materialiseRule(deps, payloadFor(ruleId, scene.teamId));

    expect(result).toMatchObject({ created: 1, published: 1, failed: 0 });
    const { rows } = await database.pool.query<{
      start_time: string;
      end_time: string;
      starts_at: Date;
    }>(
      `SELECT c.start_time::text, c.end_time::text, s.starts_at
         FROM session_courts c JOIN game_sessions s ON s.id = c.session_id WHERE s.recurring_rule_id = $1`,
      [ruleId],
    );
    expect(rows[0]?.start_time).toBe('03:30:00');
    expect(rows[0]?.end_time).toBe('04:30:00');
    expect(rows[0]?.starts_at.toISOString()).toBe('2026-09-26T14:30:00.000Z');
  });

  it('shows the waiting state until a run has covered the rule version (AC-ASYNC-6 signal)', async () => {
    const scene = await createSessionsScene(database.pool, { payoutConfigured: true });
    const ruleId = await paidRule(scene.teamId);
    const state = async (): Promise<boolean> => {
      const { rows } = await database.pool.query<{ pending: boolean }>(
        `SELECT materialised_version IS NULL OR materialised_version < version AS pending
           FROM recurring_session_rules WHERE id = $1`,
        [ruleId],
      );
      return rows[0]?.pending ?? false;
    };
    expect(await state()).toBe(true);

    const { deps } = harness();
    await materialiseRule(deps, payloadFor(ruleId, scene.teamId, 'rule_created'));
    expect(await state()).toBe(false);

    await database.pool.query(
      `UPDATE recurring_session_rules SET default_location = 'New Hall' WHERE id = $1`,
      [ruleId],
    );
    expect(await state()).toBe(true);
    await materialiseRule(deps, payloadFor(ruleId, scene.teamId, 'rule_updated'));
    expect(await state()).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-ASYNC-3, AC-VERIFY-2: the gate, drafts and the weekly email
// ---------------------------------------------------------------------------------------------

describe('gate before lock, banking drafts and the weekly email (AC-ASYNC-3, AC-VERIFY-2)', () => {
  it('a payout-configured team publishes, and the gate precedes the first session lock or write', async () => {
    const scene = await createSessionsScene(database.pool, { payoutConfigured: true });
    const ruleId = await paidRule(scene.teamId);
    const { deps, emails } = harness();
    recorder.reset();

    const result = await materialiseRule(deps, payloadFor(ruleId, scene.teamId));

    expect(result.published).toBe(5);
    recorder.assertBefore(GATE, SESSION_LOCK_OR_WRITE);
    expect(emails).toHaveLength(0);
    expect(await claimsOf(ruleId)).toEqual([]);
  });

  it('an unconfigured team gets DRAFT sessions, not a failure, and the admins one email, still gated before any write', async () => {
    const scene = await createSessionsScene(database.pool);
    const second = await insertUser(database.pool, 'FEMALE');
    await insertTeamMember(database.pool, {
      teamId: scene.teamId,
      userId: second,
      role: 'TEAM_ADMIN',
    });
    const ruleId = await paidRule(scene.teamId);
    const { deps, emails, logs } = harness();
    recorder.reset();

    const result = await materialiseRule(deps, payloadFor(ruleId, scene.teamId));

    expect(result).toMatchObject({ created: 5, published: 0, savedAsDraft: 5, failed: 0 });
    recorder.assertBefore(GATE, SESSION_LOCK_OR_WRITE);
    const rows = await sessionsOf(ruleId);
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.status === 'DRAFT')).toBe(true);

    expect(await claimsOf(ruleId)).toEqual(['2026-10-19']);
    expect(emails).toHaveLength(2);
    expect(new Set(emails.map((email) => email.idempotencyKey)).size).toBe(2);
    expect(emails[0]?.idempotencyKey).toMatch(new RegExp(`^payout-missing:${ruleId}:2026-10-19:`));
    expect(emails[0]?.subject).toContain('bank account needed');
    expect(emails[0]?.text).toContain(`/teams/${scene.teamId}/manage/banking`);
    expect(emails[0]?.text).toContain(`/manage/sessions/series/${ruleId}`);

    const refused = eventsOf(logs, 'session.recurrence.publish_refused');
    expect(refused).toHaveLength(5);
    expect(refused[0]).toMatchObject({ teamId: scene.teamId, ruleId, reason: 'not_configured' });
    expect(typeof refused[0]?.sessionId).toBe('string');
  });

  it('sends nothing more in the same NZ week and one set again the next week', async () => {
    const scene = await createSessionsScene(database.pool);
    const ruleId = await paidRule(scene.teamId);
    const { deps, emails } = harness();
    await materialiseRule(deps, payloadFor(ruleId, scene.teamId));
    expect(emails).toHaveLength(1);

    await materialiseRule(deps, payloadFor(ruleId, scene.teamId)); // same week: the retry is refused, the claim exists
    clock.set(new Date('2026-10-20T07:00:00Z')); // later the same Tuesday
    await materialiseRule(deps, payloadFor(ruleId, scene.teamId));
    expect(emails).toHaveLength(1);
    expect(await claimsOf(ruleId)).toEqual(['2026-10-19']);

    clock.set(new Date('2026-10-26T21:00:00Z')); // Tuesday 2026-10-27 NZ: the next week (Monday 10-26)
    await materialiseRule(deps, payloadFor(ruleId, scene.teamId));
    expect(emails).toHaveLength(2);
    expect(await claimsOf(ruleId)).toEqual(['2026-10-19', '2026-10-26']);
  });

  it('two runs at once on a refused team claim the week once and email each admin once', async () => {
    const scene = await createSessionsScene(database.pool);
    const ruleId = await paidRule(scene.teamId);
    const a = harness();
    const b = harness();

    await Promise.all([
      materialiseRule(a.deps, payloadFor(ruleId, scene.teamId)),
      materialiseRule(b.deps, payloadFor(ruleId, scene.teamId)),
    ]);

    expect(await claimsOf(ruleId)).toEqual(['2026-10-19']);
    expect(a.emails.length + b.emails.length).toBe(1); // the scene has one admin
    expect(await sessionsOf(ruleId)).toHaveLength(5);
  });

  it('a free series needs no gate: it publishes on an unconfigured team without consulting it', async () => {
    const scene = await createSessionsScene(database.pool);
    const ruleId = await freeRule(scene.teamId);
    const { deps, emails } = harness();
    recorder.reset();

    const result = await materialiseRule(deps, payloadFor(ruleId, scene.teamId));

    expect(result).toMatchObject({ created: 5, published: 5, savedAsDraft: 0 });
    expect(recorder.indexOf(GATE)).toBe(-1);
    expect(emails).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-ASYNC-4: draft retry
// ---------------------------------------------------------------------------------------------

describe('draft retry (AC-ASYNC-4)', () => {
  it('publishes the unedited drafts once banking is set up, queues one auto-enrol job each and leaves the edited draft alone', async () => {
    const scene = await createSessionsScene(database.pool);
    const ruleId = await paidRule(scene.teamId);
    const { deps, emails, logs } = harness();
    await materialiseRule(deps, payloadFor(ruleId, scene.teamId));
    const drafts = await sessionsOf(ruleId);
    const edited = drafts[1] as Row;
    await database.pool.query(
      `UPDATE game_sessions SET is_instance_overridden = true WHERE id = $1`,
      [edited.id],
    );
    await configureBanking(scene.teamId);
    enqueued.length = 0;
    recorder.reset();

    const result = await materialiseRule(deps, payloadFor(ruleId, scene.teamId, 'manual'));

    expect(result).toMatchObject({ created: 0, draftsRetried: 4, failed: 0 });
    recorder.assertBefore(GATE, SESSION_LOCK_OR_WRITE);
    const after = await sessionsOf(ruleId);
    expect(after.filter((row) => row.status === 'PUBLISHED').map((row) => row.date)).toEqual([
      '2026-10-20',
      '2026-11-03',
      '2026-11-10',
      '2026-11-17',
    ]);
    expect(after.find((row) => row.id === edited.id)?.status).toBe('DRAFT');

    const jobs = enqueued.filter((entry) => entry.queue === 'session-auto-enrol');
    expect(jobs).toHaveLength(4);
    expect(jobs.map((entry) => entry.singletonKey).sort()).toEqual(
      after
        .filter((row) => row.status === 'PUBLISHED')
        .map((row) => `session-auto-enrol:${row.id}`)
        .sort(),
    );
    expect(jobs[0]?.data).toMatchObject({ teamId: scene.teamId, trigger: 'publish' });
    expect(emails).toHaveLength(1); // the one from the first run; the retry succeeded, so no new claim
    expect(eventsOf(logs, 'session.recurrence.run_completed').at(-1)).toMatchObject({
      draftsRetried: 4,
    });
  });

  it('keeps a draft that the gate still refuses, logs it and sends no second email that week', async () => {
    const scene = await createSessionsScene(database.pool);
    const ruleId = await paidRule(scene.teamId);
    const { deps, emails, logs } = harness();
    await materialiseRule(deps, payloadFor(ruleId, scene.teamId));

    const result = await materialiseRule(deps, payloadFor(ruleId, scene.teamId, 'manual'));

    expect(result.draftsRetried).toBe(0);
    expect((await sessionsOf(ruleId)).every((row) => row.status === 'DRAFT')).toBe(true);
    expect(emails).toHaveLength(1);
    expect(eventsOf(logs, 'session.recurrence.publish_refused').length).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-ASYNC-2, AC-HAPPY-12, AC-INTEGRATION-2: inline auto-enrol after commit
// ---------------------------------------------------------------------------------------------

describe('inline auto-enrol after each publish (AC-ASYNC-2, AC-HAPPY-12, AC-INTEGRATION-2)', () => {
  async function scene(options: { configured: boolean }) {
    const base = await createSessionsScene(database.pool, { payoutConfigured: options.configured });
    // Selection order is assigned_at then id: the first member was enrolled latest in the table, to prove the order key.
    const late = await autoEnrollMember(base.teamId, '2026-10-02T00:00:00Z', null);
    const early = await autoEnrollMember(base.teamId, '2026-10-01T00:00:00Z', null);
    const endsBeforeNov = await autoEnrollMember(base.teamId, '2026-10-03T00:00:00Z', '2026-10-30');
    return { ...base, late, early, endsBeforeNov };
  }

  it('calls the allocator once per published session, after the commit, with the selection in order, and stamps the marker', async () => {
    const c = await scene({ configured: true });
    const ruleId = await paidRule(c.teamId);
    const visibleAtCall: string[] = [];
    allocator.autoEnrolInSession = (ctx: SessionAllocatorContext, input) => {
      // A second connection sees the session only if the instance transaction has committed.
      void database.pool
        .query<{ status: string }>(`SELECT status FROM game_sessions WHERE id = $1`, [
          input.sessionId,
        ])
        .then((res) => visibleAtCall.push(res.rows[0]?.status ?? 'invisible'));
      allocator.autoEnrolCalls.push({
        teamId: input.teamId,
        sessionId: input.sessionId,
        now: ctx.now,
        entries: input.entries,
        inTransaction: ctx.trx.isTransaction,
      });
      return Promise.resolve(
        input.entries.map((entry) => ({ userId: entry.userId, outcome: allocator.outcome })),
      );
    };
    const { deps } = harness();

    const result = await materialiseRule(deps, payloadFor(ruleId, c.teamId));

    expect(result).toMatchObject({ published: 5, autoEnrolled: 5, failed: 0 });
    expect(allocator.autoEnrolCalls).toHaveLength(5);
    const rows = await sessionsOf(ruleId);
    expect(new Set(allocator.autoEnrolCalls.map((call) => call.sessionId))).toEqual(
      new Set(rows.map((row) => row.id)),
    );
    expect(
      allocator.autoEnrolCalls.every((call) => call.inTransaction && call.teamId === c.teamId),
    ).toBe(true);
    await waitFor(() => (visibleAtCall.length === 5 ? true : undefined), {
      label: 'visibility probes',
    });
    expect(visibleAtCall.every((status) => status === 'PUBLISHED')).toBe(true);

    for (const call of allocator.autoEnrolCalls) {
      const row = rows.find((candidate) => candidate.id === call.sessionId) as Row;
      const expected = (
        await selectAutoEnrollees(kysely, { teamId: c.teamId, sessionDate: row.date as never })
      ).map((member) => ({
        userId: member.userId,
        assignedAt: member.assignedAt,
        membershipId: member.membershipId,
      }));
      expect(call.entries).toEqual(expected);
      // The member whose Auto Enroll ended 2026-10-30 is selected for the first two dates only.
      expect(call.entries.map((entry) => entry.userId)).toEqual(
        row.date <= '2026-10-30'
          ? [c.early.userId, c.late.userId, c.endsBeforeNov.userId]
          : [c.early.userId, c.late.userId],
      );
    }
    expect(rows.every((row) => row.auto_enrolled_at !== null)).toBe(true);
  });

  it('never calls the allocator for a DRAFT, and a re-run calls it no further time', async () => {
    const c = await scene({ configured: false });
    const ruleId = await paidRule(c.teamId);
    const { deps } = harness();

    await materialiseRule(deps, payloadFor(ruleId, c.teamId));
    await materialiseRule(deps, payloadFor(ruleId, c.teamId));

    expect(allocator.autoEnrolCalls).toHaveLength(0);
    expect(
      (await sessionsOf(ruleId)).every(
        (row) => row.status === 'DRAFT' && row.auto_enrolled_at === null,
      ),
    ).toBe(true);

    const free = await freeRule(c.teamId);
    await materialiseRule(deps, payloadFor(free, c.teamId));
    expect(allocator.autoEnrolCalls).toHaveLength(5);
    await materialiseRule(deps, payloadFor(free, c.teamId));
    expect(allocator.autoEnrolCalls).toHaveLength(5);
  });

  it('with nobody selected it makes no allocator call and still stamps the session', async () => {
    const base = await createSessionsScene(database.pool, { payoutConfigured: true });
    const ruleId = await paidRule(base.teamId);
    const { deps } = harness();

    const result = await materialiseRule(deps, payloadFor(ruleId, base.teamId));

    expect(result).toMatchObject({ published: 5, failed: 0 });
    expect(allocator.autoEnrolCalls).toHaveLength(0);
    expect((await sessionsOf(ruleId)).every((row) => row.auto_enrolled_at !== null)).toBe(true);
  });

  it('with the no-op port the sessions stay pending and port_noop is logged with the candidate count', async () => {
    const c = await scene({ configured: true });
    const ruleId = await paidRule(c.teamId);
    allocator.enrols = false;
    const { deps, logs } = harness();

    await materialiseRule(deps, payloadFor(ruleId, c.teamId));

    expect(allocator.autoEnrolCalls).toHaveLength(0);
    expect((await sessionsOf(ruleId)).every((row) => row.auto_enrolled_at === null)).toBe(true);
    const noop = eventsOf(logs, 'session.auto_enrol.port_noop');
    expect(noop).toHaveLength(5);
    expect(noop[0]).toMatchObject({ teamId: c.teamId, candidates: 3 });
    expect(typeof noop[0]?.sessionId).toBe('string');
  });

  it('per-member refusals and a thrown allocator error never stop the run', async () => {
    const c = await scene({ configured: true });
    const refusing = await paidRule(c.teamId);
    allocator.outcome = { ok: false, reason: 'overdue_payments' };
    const first = harness();
    const refused = await materialiseRule(first.deps, payloadFor(refusing, c.teamId));
    expect(refused).toMatchObject({ published: 5, autoEnrolled: 5, failed: 0 });
    expect((await sessionsOf(refusing)).every((row) => row.auto_enrolled_at !== null)).toBe(true);

    const throwing = await paidRule(c.teamId);
    allocator.outcome = { ok: true, status: 'CONFIRMED' };
    allocator.autoEnrolInSession = () =>
      Promise.reject(Object.assign(new Error('allocator exploded'), { code: 'XX000' }));
    const second = harness();
    const failed = await materialiseRule(second.deps, payloadFor(throwing, c.teamId));

    expect(failed).toMatchObject({ created: 5, published: 5, autoEnrolled: 0, failed: 0 });
    expect(eventsOf(second.logs, 'session.auto_enrol.failed')).toHaveLength(5);
    expect((await sessionsOf(throwing)).every((row) => row.auto_enrolled_at === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-ERROR-9: one bad instance never stops the run
// ---------------------------------------------------------------------------------------------

describe('one failing instance does not stop the run (AC-ERROR-9)', () => {
  async function failDate(
    ruleId: string,
    date: string,
    sqlState: string,
  ): Promise<() => Promise<void>> {
    const name = `it_fail_${ruleId.replaceAll('-', '').slice(0, 12)}`;
    await database.pool.query(`
      CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.recurring_rule_id = '${ruleId}' AND NEW.date = DATE '${date}' THEN
          RAISE EXCEPTION 'injected failure' USING ERRCODE = '${sqlState}';
        END IF;
        RETURN NEW;
      END $$`);
    await database.pool.query(
      `CREATE TRIGGER ${name} BEFORE INSERT ON game_sessions FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    return async () => {
      await database.pool.query(`DROP TRIGGER ${name} ON game_sessions`);
      await database.pool.query(`DROP FUNCTION ${name}()`);
    };
  }

  it('a permanent failure rolls back that date only, is logged with ids and codes at error, and fails the job without retries', async () => {
    const scene = await createSessionsScene(database.pool, { payoutConfigured: true });
    const ruleId = await paidRule(scene.teamId);
    const undo = await failDate(ruleId, '2026-11-03', '23514');
    const { deps, logs } = harness();

    const result = await materialiseRule(deps, payloadFor(ruleId, scene.teamId));
    await undo();

    expect(result).toMatchObject({ created: 4, published: 4, failed: 1 });
    expect((await sessionsOf(ruleId)).map((row) => row.date)).toEqual(
      FIVE_DATES.filter((date) => date !== '2026-11-03'),
    );
    expect(failureVerdict(result.failures)).toBe('permanent');
    const failed = eventsOf(logs, 'session.recurrence.instance_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      level: 'error',
      teamId: scene.teamId,
      ruleId,
      date: '2026-11-03',
      sqlState: '23514',
      errorCode: '23514',
      transient: false,
    });
    expect(failed[0]).not.toHaveProperty('code');
    expect(JSON.stringify(logs.lines())).not.toContain('injected failure');
  });

  it('a transient failure is logged at warn, leaves the rule pending and the job to retry, and the retry completes the date', async () => {
    const scene = await createSessionsScene(database.pool, { payoutConfigured: true });
    const ruleId = await paidRule(scene.teamId);
    const undo = await failDate(ruleId, '2026-10-27', '40001');
    const { deps, logs } = harness();

    const result = await materialiseRule(deps, payloadFor(ruleId, scene.teamId));
    await undo();

    expect(result).toMatchObject({ created: 4, failed: 1 });
    expect(failureVerdict(result.failures)).toBe('retry');
    expect(eventsOf(logs, 'session.recurrence.instance_failed')[0]).toMatchObject({
      level: 'warn',
      sqlState: '40001',
      transient: true,
    });
    const { rows } = await database.pool.query<{ materialised_version: number | null }>(
      `SELECT materialised_version FROM recurring_session_rules WHERE id = $1`,
      [ruleId],
    );
    expect(rows[0]?.materialised_version).toBeNull();

    const retry = await materialiseRule(deps, payloadFor(ruleId, scene.teamId));
    expect(retry).toMatchObject({ created: 1, failed: 0 });
    expect(await sessionsOf(ruleId)).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-ASYNC-1, AC-ASYNC-5: the sweep and the boot enqueue through the production wiring
// ---------------------------------------------------------------------------------------------

/** Retires every earlier rule and pending session so the sweep sees only what the test creates. */
async function retireEverything(): Promise<void> {
  await database.pool.query(`UPDATE recurring_session_rules SET is_active = false`);
  await database.pool.query(
    `UPDATE game_sessions SET auto_enrol_required = false, auto_enrolled_at = NULL
      WHERE status IN ('DRAFT', 'PUBLISHED')`,
  );
}

function sweepContext(logger: ReturnType<typeof captureLogs>['logger']): JobContext {
  return {
    logger,
    jobId: 'sweep-1',
    queue: 'recurrence-materialisation',
    retryCount: 0,
    retryLimit: 3,
    signal: new AbortController().signal,
  } as unknown as JobContext;
}

describe('sweep fan-out (AC-ASYNC-1, AC-ASYNC-5)', () => {
  beforeEach(retireEverything);

  it('queues one recurrence-rule job per active, not-ended rule in keyset pages, and nothing for the others', async () => {
    const scene = await createSessionsScene(database.pool, { payoutConfigured: true });
    const active = await Promise.all([1, 2, 3, 4, 5].map(() => paidRule(scene.teamId)));
    const inactive = await paidRule(scene.teamId, { isActive: false });
    const ended = await paidRule(scene.teamId, { recurUntil: '2026-10-13' });
    const { deps, logs } = harness();
    const handler = createRecurrenceMaterialisationHandler({
      db: kysely,
      clock,
      jobs: deps.jobs,
      batchSize: 2,
    });

    await handler({}, sweepContext(logs.logger));

    const ruleJobs = enqueued.filter((entry) => entry.queue === 'recurrence-rule');
    expect(ruleJobs.map((entry) => entry.data.ruleId).sort()).toEqual([...active].sort());
    expect(ruleJobs.map((entry) => entry.data.ruleId)).not.toContain(inactive);
    expect(ruleJobs.map((entry) => entry.data.ruleId)).not.toContain(ended);
    expect(ruleJobs[0]).toMatchObject({
      data: { teamId: scene.teamId, trigger: 'sweep' },
      singletonKey: `recurrence-rule:${ruleJobs[0]?.data.ruleId as string}`,
    });
    expect(eventsOf(logs, 'session.recurrence.sweep_completed')[0]).toMatchObject({
      rulesScanned: 5,
      rulesEnqueued: 5,
      pendingAutoEnrolEnqueued: 0,
    });
    expect(typeof eventsOf(logs, 'session.recurrence.sweep_completed')[0]?.durationMs).toBe(
      'number',
    );
  });

  it('a second sweep while the jobs are still queued queues no duplicate rule jobs', async () => {
    const scene = await createSessionsScene(database.pool, { payoutConfigured: true });
    await Promise.all([1, 2, 3].map(() => paidRule(scene.teamId)));
    const { deps, logs } = harness();
    const handler = createRecurrenceMaterialisationHandler({ db: kysely, clock, jobs: deps.jobs });

    await handler({}, sweepContext(logs.logger));
    await handler({}, sweepContext(logs.logger));

    const [first, second] = eventsOf(logs, 'session.recurrence.sweep_completed');
    expect(first).toMatchObject({ rulesScanned: 3, rulesEnqueued: 3 });
    expect(second).toMatchObject({ rulesScanned: 3, rulesEnqueued: 0 });
  });

  it('offers each pending future published session once and nothing past, cancelled, draft or already stamped', async () => {
    const scene = await createSessionsScene(database.pool, { payoutConfigured: true });
    const pending = await Promise.all(
      ['2026-10-30', '2026-11-02', '2026-11-05'].map((date) =>
        insertSession(
          database.pool,
          scene.teamId,
          {},
          { date, status: 'PUBLISHED', calculatedRate: '17.00' },
        ),
      ),
    );
    const stamped = await insertSession(
      database.pool,
      scene.teamId,
      {},
      { date: '2026-11-06', status: 'PUBLISHED' },
    );
    const past = await insertSession(
      database.pool,
      scene.teamId,
      {},
      { date: '2026-10-07', status: 'PUBLISHED' },
    );
    const cancelled = await insertSession(
      database.pool,
      scene.teamId,
      {},
      { date: '2026-11-07', status: 'CANCELLED' },
    );
    const draft = await insertSession(database.pool, scene.teamId, {}, { date: '2026-11-08' });
    await database.pool.query(
      `UPDATE game_sessions SET auto_enrol_required = true WHERE id = ANY($1::uuid[])`,
      [[...pending, stamped, past, cancelled, draft]],
    );
    await database.pool.query(`UPDATE game_sessions SET auto_enrolled_at = $2 WHERE id = $1`, [
      stamped,
      NOW,
    ]);
    const { deps, logs } = harness();
    const handler = createRecurrenceMaterialisationHandler({
      db: kysely,
      clock,
      jobs: deps.jobs,
      batchSize: 2,
    });

    await handler({}, sweepContext(logs.logger));

    const offered = enqueued.filter((entry) => entry.queue === 'session-auto-enrol');
    expect(offered.map((entry) => entry.data.sessionId).sort()).toEqual([...pending].sort());
    expect(offered[0]).toMatchObject({
      data: { teamId: scene.teamId, trigger: 'sweep' },
      singletonKey: `session-auto-enrol:${offered[0]?.data.sessionId as string}`,
    });
    expect(eventsOf(logs, 'session.recurrence.sweep_completed')[0]).toMatchObject({
      pendingAutoEnrolEnqueued: 3,
    });
  });
});

describe('the worker, the boot sweep and pending reconciliation end to end (AC-ASYNC-1, AC-ASYNC-5)', () => {
  let e2eWorker: JobRunner;
  const notifier = createInMemoryNotifier();
  const workerLogs = captureLogs();
  const e2eAllocator = createRecordingAllocator({ enrols: false });

  beforeAll(async () => {
    await retireEverything();
    e2eWorker = createJobRunner({
      databaseUrl: database.url,
      logger: workerLogs.logger,
      role: 'worker',
      pollingIntervalSeconds: 0.5,
    });
    await e2eWorker.start();
    await registerJobs({
      runner: e2eWorker,
      notifier,
      crypto: testCrypto(),
      db: createKysely(database.pool),
      clock,
      sessionAllocator: e2eAllocator,
      recurrenceHorizonDays: 28,
      webBaseUrl: 'https://app.example.test',
    });
  });
  afterAll(async () => {
    await e2eWorker.stop();
  });

  /** `trigger` answers null while another sweep is queued or active (the queue is exclusive): try again until it queues. */
  async function triggerSweep(): Promise<void> {
    await waitFor(
      async () =>
        (await e2eWorker.trigger('recurrence-materialisation')) === null ? undefined : true,
      { timeoutMs: 10_000, label: 'a sweep to queue' },
    );
  }

  const stamped = (ruleId: string) => async (): Promise<true | undefined> => {
    const { rows } = await database.pool.query<{ done: boolean }>(
      `SELECT materialised_version = version AS done FROM recurring_session_rules WHERE id = $1`,
      [ruleId],
    );
    return rows[0]?.done === true ? true : undefined;
  };

  it('the boot sweep materialises an active series, and pending sessions stay pending under the no-op port then enrol once a real allocator runs', async () => {
    const c = await createSessionsScene(database.pool, { payoutConfigured: true });
    const member = await autoEnrollMember(c.teamId, '2026-10-01T00:00:00Z', null);
    const ruleId = await paidRule(c.teamId);

    await enqueueBootSweeps(e2eWorker, workerLogs.logger);
    await waitFor(stamped(ruleId), {
      timeoutMs: 20_000,
      label: 'the boot sweep to materialise the rule',
    });

    const rows = await sessionsOf(ruleId);
    expect(rows.map((row) => row.date)).toEqual(FIVE_DATES);
    expect(rows.every((row) => row.status === 'PUBLISHED')).toBe(true);
    // The inline follow-up ran with the no-op port (enrols: false): nothing was placed and every marker is still pending.
    expect(e2eAllocator.autoEnrolCalls).toHaveLength(0);
    expect(rows.every((row) => row.auto_enrolled_at === null)).toBe(true);
    expect(
      eventsOf(workerLogs, 'session.recurrence.sweep_completed').length,
    ).toBeGreaterThanOrEqual(1);

    // A real allocator arrives (the deploy that wires registration): the next sweep offers each pending session and each is
    // enrolled exactly once, even though the sweep ran before and the follow-ups raced.
    e2eAllocator.enrols = true;
    await triggerSweep();
    await waitFor(
      async () => {
        const after = await sessionsOf(ruleId);
        return after.every((row) => row.auto_enrolled_at !== null) ? true : undefined;
      },
      { timeoutMs: 20_000, label: 'pending sessions to be enrolled by the sweep' },
    );
    expect(e2eAllocator.autoEnrolCalls).toHaveLength(5);
    expect(new Set(e2eAllocator.autoEnrolCalls.map((call) => call.sessionId)).size).toBe(5);
    expect(e2eAllocator.autoEnrolCalls[0]?.entries.map((entry) => entry.userId)).toEqual([
      member.userId,
    ]);

    // Nothing more happens on a further sweep.
    await triggerSweep();
    await waitFor(
      () =>
        eventsOf(workerLogs, 'session.recurrence.sweep_completed').length >= 3 ? true : undefined,
      { timeoutMs: 20_000, label: 'a further sweep' },
    );
    expect(e2eAllocator.autoEnrolCalls).toHaveLength(5);
  });

  it('a refused team gets its drafts and the admin email through the real send-email job, and a later sweep publishes the drafts once banking is set up', async () => {
    e2eAllocator.enrols = true;
    const c = await createSessionsScene(database.pool);
    const ruleId = await paidRule(c.teamId);

    await triggerSweep();
    await waitFor(stamped(ruleId), {
      timeoutMs: 20_000,
      label: 'the sweep to materialise the rule',
    });
    expect((await sessionsOf(ruleId)).every((row) => row.status === 'DRAFT')).toBe(true);
    const mail = await waitFor(
      () =>
        notifier.sent.find((message) =>
          message.idempotencyKey.startsWith(`payout-missing:${ruleId}:`),
        ),
      { timeoutMs: 20_000, label: 'the bank-account email' },
    );
    expect(mail.subject).toContain('bank account needed');

    await configureBanking(c.teamId);
    await triggerSweep();
    await waitFor(
      async () =>
        (await sessionsOf(ruleId)).every((row) => row.status === 'PUBLISHED') ? true : undefined,
      { timeoutMs: 20_000, label: 'the drafts to be published' },
    );
    // The retry queued the auto-enrol job per draft; the worker ran it (no one selected, so the marker is stamped).
    await waitFor(
      async () =>
        (await sessionsOf(ruleId)).every((row) => row.auto_enrolled_at !== null) ? true : undefined,
      { timeoutMs: 20_000, label: 'the retried drafts to be stamped' },
    );
  });
});
