/**
 * The `skill-progression` job end to end on real PostgreSQL 17 + pg-boss (skill-levels-and-auto-enroll Phase 4:
 * AC-HAPPY-4..6, AC-ASYNC-1, AC-ASYNC-2, AC-ERROR-7, AC-INTEGRATION-2). The job runs through the production
 * `registerJobs` wiring; time comes from an injected manual clock, so "run time" is an exact, assertable instant.
 * Every scene uses its own team, so members left over from an earlier test never change another test's counts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerJobs } from '../../src/jobs/bootstrap.ts';
import { QUEUES } from '../../src/jobs/registry.ts';
import { createSkillProgressionHandler } from '../../src/jobs/skill-progression.ts';
import { createKysely, type Database } from '../../src/lib/db/kysely.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import { createJobRunner, type JobContext, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import { createInMemoryNotifier } from '../../src/lib/notifications/adapters/in-memory.ts';
import { testCrypto } from '../helpers/app-deps.ts';
import { insertTeam } from '../helpers/factories.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import {
  addMember,
  applyRawOverride,
  expectInvariants,
  makeSessions,
  readMemberState,
  register,
} from '../helpers/progression-scene.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';
import { waitFor } from '../helpers/wait-for.ts';
import { noopSessionAllocator } from '../../src/modules/sessions/allocator-port.ts';

const T0 = new Date('2027-01-15T00:00:00.000Z');
const clock = createManualClock(T0);

let database: TestDatabase;
let kysely: Database;
let worker: JobRunner;
const workerLogs = captureLogs();

beforeAll(async () => {
  database = await createTestDatabase();
  kysely = createKysely(database.pool);
  worker = createJobRunner({
    databaseUrl: database.url,
    logger: workerLogs.logger,
    role: 'worker',
    pollingIntervalSeconds: 0.5,
  });
  await worker.start();
  await registerJobs({
    sessionAllocator: noopSessionAllocator,
    runner: worker,
    notifier: createInMemoryNotifier(),
    crypto: testCrypto(),
    db: kysely,
    clock,
    // A failed sweep must end `failed` at once instead of retrying after the default 5 s backoff.
    queues: QUEUES.map((queue) =>
      queue.name === 'skill-progression' ? { ...queue, retryLimit: 0 } : queue,
    ),
  });
});

afterAll(async () => {
  await worker.stop();
  await database.close();
});

interface RunResult {
  readonly id: string;
  readonly state: string;
  readonly summary: Record<string, unknown> | undefined;
}

/** Triggers the queue (as `cli jobs trigger skill-progression` does) and waits for its final state. */
async function runJob(): Promise<RunResult> {
  const id = await worker.trigger('skill-progression');
  expect(id).toEqual(expect.any(String));
  const state = await waitFor(
    async () => {
      const { rows } = await database.pool.query<{ state: string }>(
        'SELECT state FROM pgboss.job WHERE name = $1 AND id = $2',
        ['skill-progression', id],
      );
      const current = rows[0]?.state;
      return current === 'completed' || current === 'failed' ? current : undefined;
    },
    { timeoutMs: 20_000, label: 'skill-progression run to finish' },
  );
  const summary = workerLogs
    .lines()
    .find((line) => line.event === 'skill.progression.completed' && line.jobId === id);
  return { id: id as string, state, summary };
}

const logsFor = (event: string, jobId: string) =>
  workerLogs.lines().filter((line) => line.event === event && line.jobId === jobId);

describe('promotion on real registration and session rows (AC-HAPPY-4, AC-ASYNC-1, AC-INTEGRATION-2)', () => {
  it('promotes the member at 40 qualifying games and nobody else; the result follows the seeded rows', async () => {
    clock.set(T0);
    const teamId = await insertTeam(database.pool);
    const completed = await makeSessions(database.pool, teamId, 40, '2026-10-10');
    const cancelled = await makeSessions(database.pool, teamId, 5, '2027-01-01', 'CANCELLED');
    const a = await addMember(database.pool, teamId);
    const b = await addMember(database.pool, teamId);
    const c = await addMember(database.pool, teamId);
    const banned = await addMember(database.pool, teamId, { status: 'BANNED' });
    const top = await addMember(database.pool, teamId, { skillLevel: 'ADVANCED' });
    await register(database.pool, teamId, a.userId, completed);
    // B: 40 registrations, but only 30 qualify (5 WITHDRAWN, 5 in a CANCELLED session).
    await register(database.pool, teamId, b.userId, completed.slice(0, 30));
    await register(database.pool, teamId, b.userId, completed.slice(30, 35), 'WITHDRAWN');
    await register(database.pool, teamId, b.userId, cancelled);
    await register(database.pool, teamId, c.userId, completed.slice(0, 39));
    await register(database.pool, teamId, banned.userId, completed);
    await register(database.pool, teamId, top.userId, completed);

    const run = await runJob();
    expect(run.state).toBe('completed');

    const promoted = await readMemberState(database.pool, teamId, a.userId);
    expect(promoted).toMatchObject({
      skillLevel: 'INTERMEDIATE',
      status: 'APPROVED',
      role: 'MEMBER',
      overrideBy: null,
      overrideAt: null,
    });
    expect(promoted.changedAt?.getTime()).toBe(T0.getTime());
    expectInvariants(promoted);
    for (const member of [b, c]) {
      const state = await readMemberState(database.pool, teamId, member.userId);
      expect(state).toMatchObject({ skillLevel: 'BEGINNER', changedAt: null });
    }
    expect(await readMemberState(database.pool, teamId, banned.userId)).toMatchObject({
      status: 'BANNED',
      skillLevel: 'BEGINNER',
      changedAt: null,
    });
    expect(await readMemberState(database.pool, teamId, top.userId)).toMatchObject({
      skillLevel: 'ADVANCED',
      changedAt: null,
    });

    expect(logsFor('team.member.skill_progressed', run.id)).toEqual([
      expect.objectContaining({
        teamId,
        userId: a.userId,
        membershipId: a.membershipId,
        from: 'BEGINNER',
        to: 'INTERMEDIATE',
        games: 40,
      }),
    ]);
    expect(run.summary).toMatchObject({ promoted: 1, failed: 0 });
    for (const key of ['scanned', 'candidates', 'promoted', 'skipped', 'failed', 'durationMs']) {
      expect(typeof run.summary?.[key], key).toBe('number');
    }

    // The same rows plus one more confirmed game for C (39 -> 40): now C moves too.
    await register(database.pool, teamId, c.userId, completed.slice(39));
    const second = await runJob();
    expect(second.state).toBe('completed');
    expect(await readMemberState(database.pool, teamId, c.userId)).toMatchObject({
      skillLevel: 'INTERMEDIATE',
    });
    expect((await readMemberState(database.pool, teamId, b.userId)).skillLevel).toBe('BEGINNER');
  });
});

describe('one level per run and per block of 40 new games (AC-HAPPY-5, AC-ASYNC-2)', () => {
  it('moves 85 games up one level, then nothing on an immediate re-run, then one more level after 40 new games, then never past ADVANCED', async () => {
    clock.set(T0);
    const teamId = await insertTeam(database.pool);
    const member = await addMember(database.pool, teamId);
    const first = await makeSessions(database.pool, teamId, 85, '2026-10-10');
    await register(database.pool, teamId, member.userId, first);

    expect((await runJob()).state).toBe('completed');
    const afterFirst = await readMemberState(database.pool, teamId, member.userId);
    expect(afterFirst.skillLevel).toBe('INTERMEDIATE');
    expect(afterFirst.changedAt?.getTime()).toBe(T0.getTime());

    // Redelivery / second run at once: the baseline reset leaves 0 games, so nothing changes.
    const rerun = await runJob();
    expect(rerun.state).toBe('completed');
    expect(rerun.summary).toMatchObject({ promoted: 0, failed: 0 });
    expect(await readMemberState(database.pool, teamId, member.userId)).toEqual(afterFirst);

    // 40 games that end after the first run.
    clock.set(new Date('2027-03-01T00:00:00.000Z'));
    const next40 = await makeSessions(database.pool, teamId, 40, '2027-01-16');
    await register(database.pool, teamId, member.userId, next40);
    expect((await runJob()).state).toBe('completed');
    const afterThird = await readMemberState(database.pool, teamId, member.userId);
    expect(afterThird.skillLevel).toBe('ADVANCED');
    expect(afterThird.changedAt?.getTime()).toBe(new Date('2027-03-01T00:00:00.000Z').getTime());

    // ADVANCED never moves, however many games follow.
    clock.set(new Date('2027-06-01T00:00:00.000Z'));
    const more = await makeSessions(database.pool, teamId, 45, '2027-03-02');
    await register(database.pool, teamId, member.userId, more);
    expect((await runJob()).state).toBe('completed');
    expect(await readMemberState(database.pool, teamId, member.userId)).toEqual(afterThird);
  });
});

describe('an admin override resets the baseline (AC-HAPPY-6)', () => {
  it('counts only games after the override, never lowers anyone and leaves the override stamps alone', async () => {
    clock.set(T0);
    const teamId = await insertTeam(database.pool);
    const admin = await addMember(database.pool, teamId, { role: 'TEAM_ADMIN' });
    const member = await addMember(database.pool, teamId);
    const before = await makeSessions(database.pool, teamId, 38, '2026-10-10');
    await register(database.pool, teamId, member.userId, before);
    await applyRawOverride(database.pool, teamId, member.userId, {
      to: 'INTERMEDIATE',
      actorId: admin.userId,
      at: T0,
    });

    // 2 more games after the override: 2 count, the 38 before it do not.
    clock.set(new Date('2027-02-01T00:00:00.000Z'));
    await register(
      database.pool,
      teamId,
      member.userId,
      await makeSessions(database.pool, teamId, 2, '2027-01-16'),
    );
    expect((await runJob()).state).toBe('completed');
    expect(await readMemberState(database.pool, teamId, member.userId)).toMatchObject({
      skillLevel: 'INTERMEDIATE',
      overrideBy: admin.userId,
    });

    // 38 more: 2 + 38 = 40 since the override.
    clock.set(new Date('2027-04-01T00:00:00.000Z'));
    await register(
      database.pool,
      teamId,
      member.userId,
      await makeSessions(database.pool, teamId, 38, '2027-02-02'),
    );
    expect((await runJob()).state).toBe('completed');
    const state = await readMemberState(database.pool, teamId, member.userId);
    expect(state.skillLevel).toBe('ADVANCED');
    expect(state.overrideBy).toBe(admin.userId);
    expect(state.overrideAt?.getTime()).toBe(T0.getTime());
    expect(state.changedAt?.getTime()).toBe(new Date('2027-04-01T00:00:00.000Z').getTime());
    expectInvariants(state);
  });
});

describe('one member failing does not stop the sweep (AC-ERROR-7)', () => {
  it('finishes every other member, logs ids and errorCode only, and ends the job failed; a re-run promotes the rest once', async () => {
    clock.set(T0);
    const teamId = await insertTeam(database.pool);
    const sessions = await makeSessions(database.pool, teamId, 40, '2026-10-10');
    const members = [
      await addMember(database.pool, teamId),
      await addMember(database.pool, teamId),
      await addMember(database.pool, teamId),
    ];
    for (const member of members) {
      await register(database.pool, teamId, member.userId, sessions);
    }
    const [healthyOne, broken, healthyTwo] = members as [
      (typeof members)[number],
      (typeof members)[number],
      (typeof members)[number],
    ];
    // A constraint-style failure for one member only (uuid from our own factory, never user input).
    await database.pool.query(`
      CREATE FUNCTION sgm_test_fail_member() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.user_id = '${broken.userId}' THEN
          RAISE EXCEPTION 'secret detail that must not be logged' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END $$`);
    await database.pool.query(`
      CREATE TRIGGER sgm_test_fail_member BEFORE UPDATE ON team_members
        FOR EACH ROW EXECUTE FUNCTION sgm_test_fail_member()`);
    try {
      const run = await runJob();
      expect(run.state).toBe('failed');
      expect(run.summary).toMatchObject({ promoted: 2, failed: 1 });
      for (const healthy of [healthyOne, healthyTwo]) {
        expect((await readMemberState(database.pool, teamId, healthy.userId)).skillLevel).toBe(
          'INTERMEDIATE',
        );
      }
      expect(await readMemberState(database.pool, teamId, broken.userId)).toMatchObject({
        skillLevel: 'BEGINNER',
        changedAt: null,
      });
      const failures = logsFor('skill.progression.member_failed', run.id);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        teamId,
        userId: broken.userId,
        membershipId: broken.membershipId,
        errorCode: 'P0001',
      });
      expect(JSON.stringify(failures[0])).not.toContain('secret detail');
      expect(failures[0]).not.toHaveProperty('err');
    } finally {
      await database.pool.query('DROP TRIGGER sgm_test_fail_member ON team_members');
      await database.pool.query('DROP FUNCTION sgm_test_fail_member()');
    }

    // The queue's retry (here a manual run) is safe: the two promoted members are not promoted again.
    const retry = await runJob();
    expect(retry.state).toBe('completed');
    expect(retry.summary).toMatchObject({ promoted: 1, failed: 0 });
    const states = await Promise.all(
      members.map((member) => readMemberState(database.pool, teamId, member.userId)),
    );
    expect(states.map((state) => state.skillLevel)).toEqual([
      'INTERMEDIATE',
      'INTERMEDIATE',
      'INTERMEDIATE',
    ]);
  });
});

describe('the sweep itself (keyset paging and abort)', () => {
  function directContext(signal: AbortSignal): {
    ctx: JobContext;
    logs: ReturnType<typeof captureLogs>;
  } {
    const logs = captureLogs();
    const ctx = {
      logger: logs.logger,
      jobId: 'direct-run',
      queue: 'skill-progression',
      retryCount: 0,
      retryLimit: 0,
      signal,
    } as unknown as JobContext;
    return { ctx, logs };
  }

  it('pages across teams with a tiny batch size and promotes every candidate exactly once', async () => {
    clock.set(T0);
    const teams = [await insertTeam(database.pool), await insertTeam(database.pool)];
    const promotable: { teamId: string; userId: string }[] = [];
    for (const teamId of teams) {
      const sessions = await makeSessions(database.pool, teamId, 40, '2026-10-10');
      for (let index = 0; index < 3; index += 1) {
        const member = await addMember(database.pool, teamId);
        await register(database.pool, teamId, member.userId, sessions);
        promotable.push({ teamId, userId: member.userId });
      }
      // One below the threshold in each team, to prove the pre-pass filters on the count.
      const short = await addMember(database.pool, teamId);
      await register(database.pool, teamId, short.userId, sessions.slice(0, 5));
    }
    const handler = createSkillProgressionHandler({ db: kysely, clock, batchSize: 2 });
    const { ctx, logs } = directContext(new AbortController().signal);
    await handler({}, ctx);

    for (const { teamId, userId } of promotable) {
      expect((await readMemberState(database.pool, teamId, userId)).skillLevel).toBe(
        'INTERMEDIATE',
      );
    }
    const summary = logs.lines().find((line) => line.event === 'skill.progression.completed');
    expect(summary).toMatchObject({ promoted: 6, failed: 0 });
    expect(Number(summary?.candidates)).toBeGreaterThanOrEqual(6);
    expect(Number(summary?.scanned)).toBeGreaterThanOrEqual(8);
  });

  it('stops between members when the job is aborted and fails the run instead of reporting success', async () => {
    clock.set(T0);
    const teamId = await insertTeam(database.pool);
    const sessions = await makeSessions(database.pool, teamId, 40, '2026-10-10');
    const member = await addMember(database.pool, teamId);
    await register(database.pool, teamId, member.userId, sessions);
    const controller = new AbortController();
    controller.abort();
    const handler = createSkillProgressionHandler({ db: kysely, clock });
    const { ctx } = directContext(controller.signal);
    await expect(handler({}, ctx)).rejects.toThrow(/abort/i);
    expect((await readMemberState(database.pool, teamId, member.userId)).skillLevel).toBe(
      'BEGINNER',
    );
  });
});
