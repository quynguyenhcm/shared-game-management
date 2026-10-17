/**
 * Race safety of the skill-progression job (skill-levels-and-auto-enroll Phase 4: AC-VERIFY-5, AC-ASYNC-2).
 * Every interleaving is forced deterministically, never with a sleep: the test holds a real lock, starts the
 * work under test, waits until Postgres reports the backend blocked (`lock-waiters.ts`), changes state, then lets
 * go. To hold the job itself mid-transaction (it has locked the member row but not yet written) the test installs
 * a throwaway trigger on `team_members` that waits on an advisory lock the test owns; the job blocks there while
 * the competing writer queues behind the job's row lock. Time is an injected manual clock.
 *
 * The decisions under test: the job re-reads level, status and baseline under the member-row lock and decides
 * again, so a promotion based on a count taken before an override or a ban never lands; an override or a ban
 * never loses to a stale progression write; the final row always satisfies every CHECK.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSkillProgressionHandler } from '../../src/jobs/skill-progression.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import { createKysely, type Database } from '../../src/lib/db/kysely.ts';
import type { JobContext } from '../../src/lib/jobs/jobs.ts';
import { MemberStaleError } from '../../src/modules/skill-levels/errors.ts';
import { createSkillLevelsService } from '../../src/modules/skill-levels/service.ts';
import { insertTeam } from '../helpers/factories.ts';
import { waitForLockWaiters } from '../helpers/lock-waiters.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import {
  addMember,
  expectInvariants,
  makeSessions,
  readMemberState,
  register,
} from '../helpers/progression-scene.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

const T0 = new Date('2027-01-15T00:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GATE_KEY = 424_242;
const clock = createManualClock(T0);

let database: TestDatabase;
let kysely: Database;
beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 10 });
  kysely = createKysely(database.pool);
});
afterAll(async () => {
  await database.close();
});

/** One run of the sweep with its own logger; resolves to the `skill.progression.completed` summary. */
async function runSweep(): Promise<Record<string, unknown> | undefined> {
  const logs = captureLogs();
  const ctx = {
    logger: logs.logger,
    jobId: 'race-run',
    queue: 'skill-progression',
    retryCount: 0,
    retryLimit: 0,
    signal: new AbortController().signal,
  } as unknown as JobContext;
  await createSkillProgressionHandler({ db: kysely, clock })({}, ctx);
  return logs.lines().find((line) => line.event === 'skill.progression.completed');
}

/** A team with one admin and one member holding 40 qualifying games (a promotion candidate). */
async function candidateScene(extraGames = 0) {
  const teamId = await insertTeam(database.pool);
  const admin = await addMember(database.pool, teamId, { role: 'TEAM_ADMIN' });
  const member = await addMember(database.pool, teamId);
  const sessions = await makeSessions(database.pool, teamId, 40 + extraGames, '2026-10-10');
  await register(database.pool, teamId, member.userId, sessions);
  return { teamId, admin, member, sessions };
}

/** The member row locked in an open transaction until `release()`, like a competing admin save or ban. */
async function holdMemberLock(teamId: string, userId: string) {
  const client = await database.pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE', [
    teamId,
    userId,
  ]);
  let released = false;
  return {
    query: (text: string, values?: unknown[]) => client.query(text, values),
    async release() {
      if (released) return;
      released = true;
      try {
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Makes the next level change of any `team_members` row wait on an advisory lock the test holds, so a job that
 * has locked the member row stays suspended until `release()`.
 */
async function withJobSuspended<T>(
  work: (gate: { release: () => Promise<void> }) => Promise<T>,
): Promise<T> {
  await database.pool.query(`
    CREATE FUNCTION sgm_test_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(${GATE_KEY}); RETURN NEW; END $$`);
  await database.pool.query(`
    CREATE TRIGGER sgm_test_gate BEFORE UPDATE ON team_members
      FOR EACH ROW WHEN (OLD.skill_level IS DISTINCT FROM NEW.skill_level)
      EXECUTE FUNCTION sgm_test_gate()`);
  const client: pg.PoolClient = await database.pool.connect();
  await client.query('SELECT pg_advisory_lock($1)', [GATE_KEY]);
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [GATE_KEY]);
    } finally {
      client.release();
    }
  };
  try {
    return await work({ release });
  } finally {
    await release();
    await database.pool.query('DROP TRIGGER sgm_test_gate ON team_members');
    await database.pool.query('DROP FUNCTION sgm_test_gate()');
  }
}

const overrideService = () => createSkillLevelsService({ db: kysely, clock });
const serviceContext = () => ({ log: captureLogs().logger });

describe('override vs progression (AC-VERIFY-5)', () => {
  it('progression first: the queued override is refused as stale, and a retry with the refreshed values applies', async () => {
    clock.set(T0);
    const { teamId, admin, member } = await candidateScene();
    await withJobSuspended(async (gate) => {
      const sweep = runSweep();
      await waitForLockWaiters(database.pool, 1, 'the job suspended inside its transaction');
      // The admin's panel still shows BEGINNER with no baseline.
      const staleSave = overrideService().setSkillLevel(
        { teamId, actorId: admin.userId, userId: member.userId },
        { skillLevel: 'ADVANCED', expectedSkillLevel: 'BEGINNER', expectedChangedAt: null },
        serviceContext(),
      );
      const outcome = staleSave.then(
        () => undefined,
        (error: unknown) => error,
      );
      await waitForLockWaiters(database.pool, 2, 'the override queued behind the job');
      await gate.release();
      expect(await sweep).toMatchObject({ promoted: 1, failed: 0 });
      expect(await outcome).toBeInstanceOf(MemberStaleError);
    });

    const afterRace = await readMemberState(database.pool, teamId, member.userId);
    expect(afterRace).toMatchObject({ skillLevel: 'INTERMEDIATE', overrideBy: null });
    expect(afterRace.changedAt?.getTime()).toBe(T0.getTime());
    expectInvariants(afterRace);

    const retried = await overrideService().setSkillLevel(
      { teamId, actorId: admin.userId, userId: member.userId },
      {
        skillLevel: 'ADVANCED',
        expectedSkillLevel: 'INTERMEDIATE',
        expectedChangedAt: T0.toISOString(),
      },
      serviceContext(),
    );
    expect(retried.changed).toBe(true);
    const final = await readMemberState(database.pool, teamId, member.userId);
    expect(final).toMatchObject({ skillLevel: 'ADVANCED', overrideBy: admin.userId });
    expectInvariants(final);
  });

  it('override first: a promotion computed before the override never lands, and the override keeps its stamps', async () => {
    clock.set(T0);
    const { teamId, admin, member } = await candidateScene(40); // 80 games before the override
    const lock = await holdMemberLock(teamId, member.userId);
    try {
      const sweep = runSweep();
      await waitForLockWaiters(database.pool, 1, 'the job queued behind the override');
      await lock.query(
        `UPDATE team_members
            SET skill_level = 'INTERMEDIATE', skill_level_override_by = $3,
                skill_level_override_at = $4, skill_level_changed_at = $4
          WHERE team_id = $1 AND user_id = $2`,
        [teamId, member.userId, admin.userId, T0],
      );
      clock.set(new Date(T0.getTime() + HOUR)); // the job reads `now` only after it gets the lock
      await lock.release();
      expect(await sweep).toMatchObject({ promoted: 0, failed: 0 });
    } finally {
      await lock.release();
    }
    const state = await readMemberState(database.pool, teamId, member.userId);
    expect(state).toMatchObject({ skillLevel: 'INTERMEDIATE', overrideBy: admin.userId });
    expect(state.changedAt?.getTime()).toBe(T0.getTime());
    expect(state.overrideAt?.getTime()).toBe(T0.getTime());
    expectInvariants(state);
  });
});

describe('ban vs progression (AC-VERIFY-5)', () => {
  const ban = `UPDATE team_members
                  SET status = 'BANNED', banned_at = $3, banned_by = $4,
                      is_auto_enroll = false, auto_enroll_until = NULL, auto_enroll_assigned_at = NULL
                WHERE team_id = $1 AND user_id = $2`;

  it('ban first: the job finds the member no longer approved and writes nothing', async () => {
    clock.set(T0);
    const { teamId, admin, member } = await candidateScene();
    const lock = await holdMemberLock(teamId, member.userId);
    try {
      const sweep = runSweep();
      await waitForLockWaiters(database.pool, 1, 'the job queued behind the ban');
      await lock.query(ban, [teamId, member.userId, T0, admin.userId]);
      await lock.release();
      expect(await sweep).toMatchObject({ promoted: 0, failed: 0 });
    } finally {
      await lock.release();
    }
    const state = await readMemberState(database.pool, teamId, member.userId);
    expect(state).toMatchObject({ status: 'BANNED', skillLevel: 'BEGINNER', changedAt: null });
  });

  it('progression first: the ban waits for the job, then wins; the row ends banned and valid', async () => {
    clock.set(T0);
    const { teamId, admin, member } = await candidateScene();
    await withJobSuspended(async (gate) => {
      const sweep = runSweep();
      await waitForLockWaiters(database.pool, 1, 'the job suspended inside its transaction');
      const banned = database.pool.query(ban, [teamId, member.userId, T0, admin.userId]);
      await waitForLockWaiters(database.pool, 2, 'the ban queued behind the job');
      await gate.release();
      expect(await sweep).toMatchObject({ promoted: 1, failed: 0 });
      await banned;
    });
    const state = await readMemberState(database.pool, teamId, member.userId);
    expect(state).toMatchObject({ status: 'BANNED', skillLevel: 'INTERMEDIATE' });
    expectInvariants(state);
  });
});

describe('two runs and a redelivery (AC-ASYNC-2, AC-VERIFY-5)', () => {
  it('two runs started at once promote the member exactly once', async () => {
    clock.set(T0);
    const { teamId, member } = await candidateScene();
    const lock = await holdMemberLock(teamId, member.userId);
    let summaries: (Record<string, unknown> | undefined)[] = [];
    try {
      const runs = [runSweep(), runSweep()];
      await waitForLockWaiters(database.pool, 2, 'both runs queued on the member row');
      await lock.release();
      summaries = await Promise.all(runs);
    } finally {
      await lock.release();
    }
    expect(summaries.reduce((sum, summary) => sum + Number(summary?.promoted ?? 0), 0)).toBe(1);
    expect(summaries.reduce((sum, summary) => sum + Number(summary?.failed ?? 0), 0)).toBe(0);
    const state = await readMemberState(database.pool, teamId, member.userId);
    expect(state.skillLevel).toBe('INTERMEDIATE');
    expect(state.changedAt?.getTime()).toBe(T0.getTime());
    expectInvariants(state);
  });

  it('a redelivery after the clock moved changes nothing, and the next level needs 40 new games', async () => {
    clock.set(T0);
    const { teamId, member } = await candidateScene();
    expect(await runSweep()).toMatchObject({ promoted: 1 });
    const promoted = await readMemberState(database.pool, teamId, member.userId);

    clock.advance(HOUR);
    expect(await runSweep()).toMatchObject({ promoted: 0, failed: 0 });
    expect(await readMemberState(database.pool, teamId, member.userId)).toEqual(promoted);

    // 39 games after the promotion are not enough; the 40th is.
    clock.set(new Date(T0.getTime() + 60 * DAY));
    const newer = await makeSessions(database.pool, teamId, 40, '2027-01-16');
    await register(database.pool, teamId, member.userId, newer.slice(0, 39));
    expect(await runSweep()).toMatchObject({ promoted: 0, failed: 0 });
    expect((await readMemberState(database.pool, teamId, member.userId)).skillLevel).toBe(
      'INTERMEDIATE',
    );
    await register(database.pool, teamId, member.userId, newer.slice(39));
    expect(await runSweep()).toMatchObject({ promoted: 1, failed: 0 });
    const final = await readMemberState(database.pool, teamId, member.userId);
    expect(final.skillLevel).toBe('ADVANCED');
    expect(final.changedAt?.getTime()).toBe(clock.now().getTime());
    expectInvariants(final);
  });
});
