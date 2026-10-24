/**
 * The `registration-ban-reconcile` sweep against a real cloned Postgres and a real pg-boss producer and worker
 * (AC-ASYNC-3, architecture Q4 sweep S-a). It owns its database, so the counts it asserts are exact.
 *
 * The worker runs the real sweep AND the real ban handler: the sweep only enqueues `member-banned` jobs, and the handler
 * does the withdrawing, so the "once that job runs, a second sweep enqueues nothing" half of the AC needs both.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerJobs } from '../../src/jobs/bootstrap.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import { createJobRunner, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import { createInMemoryNotifier } from '../../src/lib/notifications/adapters/in-memory.ts';
import { createRegistrationsBanHandler } from '../../src/modules/registrations/ban-handler.ts';
import { reconcileBannedMembers } from '../../src/modules/registrations/reconcile.ts';
import { MemberBannedPayload } from '../../src/modules/teams/ban-hook.ts';
import { noopSessionAllocator } from '../../src/modules/sessions/allocator-port.ts';
import { testCrypto } from '../helpers/app-deps.ts';
import { START_TIME } from '../helpers/auth-app.ts';
import {
  insertPublishedSession,
  insertRegistration,
  insertSession,
  insertTeam,
  insertTeamMember,
  insertUser,
} from '../helpers/factories.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import { createRecordingJobs, readRegistration } from '../helpers/registration-scene.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';
import { waitFor } from '../helpers/wait-for.ts';

const clock = createManualClock(START_TIME);

let database: TestDatabase;
let worker: JobRunner;
const workerLogs = captureLogs();

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 10 });
  worker = createJobRunner({
    databaseUrl: database.url,
    logger: workerLogs.logger,
    role: 'worker',
    pollingIntervalSeconds: 0.5,
    superviseIntervalSeconds: 2,
  });
  await worker.start();
  const db = createKysely(database.pool);
  await registerJobs({
    sessionAllocator: noopSessionAllocator,
    webBaseUrl: 'https://app.example.test',
    runner: worker,
    notifier: createInMemoryNotifier(),
    crypto: testCrypto(),
    db,
    clock,
    memberBannedHandler: createRegistrationsBanHandler({
      db,
      jobs: worker,
      clock,
      webBaseUrl: 'https://app.example.test',
    }),
  });
});
afterAll(async () => {
  await worker.stop();
  await database.close();
});

async function runSweep(): Promise<Record<string, unknown>> {
  const id = (await worker.trigger('registration-ban-reconcile', {
    source: 'integration-test',
  })) as string;
  return waitFor(
    () =>
      workerLogs
        .lines()
        .find((line) => line.event === 'registration.ban_reconcile.completed' && line.jobId === id),
    { label: 'the sweep to log its counts' },
  );
}

async function memberJobs(membershipId: string) {
  const { rows } = await database.pool.query<{ state: string; data: Record<string, unknown> }>(
    `SELECT state, data FROM pgboss.job WHERE name = 'member-banned' AND singleton_key = $1 ORDER BY created_on`,
    [`member-banned:${membershipId}`],
  );
  return rows;
}

async function bannedMember(teamId: string, adminId: string) {
  const userId = await insertUser(database.pool, 'FEMALE');
  const membershipId = await insertTeamMember(database.pool, {
    teamId,
    userId,
    status: 'BANNED',
    actorId: adminId,
  });
  return { userId, membershipId };
}

async function published(teamId: string, startsInHours = 72) {
  const { sessionId } = await insertPublishedSession(database.pool, teamId, {
    now: clock.now(),
    startsInHours,
  });
  return sessionId;
}

describe('the daily reconciliation sweep (AC-ASYNC-3)', () => {
  it('enqueues exactly one member-banned job per banned member who still holds an active future registration, then nothing once the handler ran', async () => {
    const teamId = await insertTeam(database.pool, { payoutConfigured: true });
    const admin = await insertUser(database.pool, 'MALE');
    await insertTeamMember(database.pool, { teamId, userId: admin, role: 'TEAM_ADMIN' });

    // A: banned while the no-op handler ran; still active in a future PUBLISHED session (and withdrawn in an older one).
    const a = await bannedMember(teamId, admin);
    const upcoming = await published(teamId);
    await insertRegistration(database.pool, { sessionId: upcoming, teamId, userId: a.userId });
    const gone = await published(teamId, 96);
    await insertRegistration(database.pool, {
      sessionId: gone,
      teamId,
      userId: a.userId,
      status: 'WITHDRAWN',
    });
    // B: banned with nothing active (only a withdrawn row).
    const b = await bannedMember(teamId, admin);
    await insertRegistration(database.pool, {
      sessionId: gone,
      teamId,
      userId: b.userId,
      status: 'WITHDRAWN',
    });
    // C: banned, active only in a session that already started, a cancelled one and a draft.
    const c = await bannedMember(teamId, admin);
    const started = await published(teamId, -2);
    await insertRegistration(database.pool, { sessionId: started, teamId, userId: c.userId });
    const cancelled = await insertSession(database.pool, teamId, {}, { status: 'CANCELLED' });
    await insertRegistration(database.pool, { sessionId: cancelled, teamId, userId: c.userId });
    // D: an APPROVED member with an active registration is not a ban candidate.
    const dUser = await insertUser(database.pool, 'MALE');
    await insertTeamMember(database.pool, { teamId, userId: dUser });
    await insertRegistration(database.pool, { sessionId: upcoming, teamId, userId: dUser });

    const first = await runSweep();
    expect(first).toMatchObject({ scanned: 1, enqueued: 1, alreadyQueued: 0, invalid: 0 });
    expect(Object.keys(first)).not.toEqual(expect.arrayContaining(['userId', 'teamId']));

    // The payload is rebuilt from the membership row; no other member got a job.
    const aJobs = await memberJobs(a.membershipId);
    expect(aJobs).toHaveLength(1);
    const { _meta: meta, ...payload } = aJobs[0]?.data ?? {};
    void meta;
    const row = (
      await database.pool.query<{ banned_by: string; banned_at: Date }>(
        `SELECT banned_by, banned_at FROM team_members WHERE id = $1`,
        [a.membershipId],
      )
    ).rows[0];
    expect(MemberBannedPayload.parse(payload)).toEqual({
      teamId,
      userId: a.userId,
      membershipId: a.membershipId,
      bannedBy: row?.banned_by,
      bannedAt: row?.banned_at.toISOString(),
    });
    for (const other of [b, c]) expect(await memberJobs(other.membershipId)).toEqual([]);

    // The real handler runs that job: A is withdrawn as BANNED, C's started and cancelled sessions are untouched.
    await waitFor(
      async () => ((await memberJobs(a.membershipId))[0]?.state === 'completed' ? true : undefined),
      {
        label: 'the member-banned job for A',
      },
    );
    expect(await readRegistration(database.pool, upcoming, a.userId)).toMatchObject({
      status: 'WITHDRAWN',
      withdrawalKind: 'BANNED',
    });
    expect(await readRegistration(database.pool, started, c.userId)).toMatchObject({
      status: 'CONFIRMED',
    });
    expect(await readRegistration(database.pool, upcoming, dUser)).toMatchObject({
      status: 'CONFIRMED',
    });

    // Idempotent: a second sweep finds nothing to do.
    const second = await runSweep();
    expect(second).toMatchObject({ scanned: 0, enqueued: 0, alreadyQueued: 0, invalid: 0 });
    expect(await memberJobs(a.membershipId)).toHaveLength(1);
  });

  it('does not duplicate a job that is already queued: a second pass counts it as alreadyQueued', async () => {
    const teamId = await insertTeam(database.pool, { payoutConfigured: true });
    const admin = await insertUser(database.pool, 'MALE');
    await insertTeamMember(database.pool, { teamId, userId: admin, role: 'TEAM_ADMIN' });
    const m = await bannedMember(teamId, admin);
    const sessionId = await published(teamId);
    await insertRegistration(database.pool, { sessionId, teamId, userId: m.userId });

    // Hold the membership's singleton slot with a deferred job (state `created`, startAfter far ahead): the worker will not take
    // it, and the exclusive queue treats it as queued, so the sweep must count it instead of enqueueing a second one.
    const producer = createJobRunner({
      databaseUrl: database.url,
      logger: captureLogs().logger,
      role: 'producer',
    });
    await producer.start();
    try {
      const db = createKysely(database.pool);
      const row = (
        await database.pool.query<{ banned_by: string; banned_at: Date }>(
          `SELECT banned_by, banned_at FROM team_members WHERE id = $1`,
          [m.membershipId],
        )
      ).rows[0];
      await producer.enqueue(
        'member-banned',
        {
          teamId,
          userId: m.userId,
          membershipId: m.membershipId,
          bannedBy: row?.banned_by,
          bannedAt: row?.banned_at.toISOString(),
        },
        {
          singletonKey: `member-banned:${m.membershipId}`,
          startAfter: new Date(clock.now().getTime() + 30 * 24 * 3_600_000),
        },
      );
      const recording = createRecordingJobs(producer);
      const counts = await reconcileBannedMembers({ db, jobs: recording, clock });
      expect(counts).toEqual({ scanned: 1, enqueued: 0, alreadyQueued: 1, invalid: 0 });
      expect(await memberJobs(m.membershipId)).toHaveLength(1);
      expect(
        recording.recorded.every((job) => job.inTransaction && job.queue === 'member-banned'),
      ).toBe(true);
    } finally {
      await producer.stop();
    }
  });
});
