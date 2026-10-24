/**
 * The real ban handler against a real cloned Postgres, a real pg-boss producer and worker and the real HTTP ban route
 * (AC-HAPPY-10 API side, AC-ERROR-9, AC-ASYNC-2; architecture Q4, ADR 0015).
 *
 * The worker runs `createRegistrationsBanHandler` exactly as `worker.ts` wires it. The clock is the test app's START_TIME, so
 * the sessions the factories build ("72 h after now") are in the future for the handler too.
 *
 * Failures are real database errors: a trigger raises the SQLSTATE the test asks for when a registration of a chosen session
 * is withdrawn. A sequence (not a table the transaction could roll back) counts the attempts, so "fail the first N times"
 * survives the rollback of the failing transaction.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerJobs } from '../../src/jobs/bootstrap.ts';
import { QUEUES } from '../../src/jobs/registry.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import { createJobRunner, type EnqueueOptions, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import { createInMemoryNotifier } from '../../src/lib/notifications/adapters/in-memory.ts';
import { createRegistrationsBanHandler } from '../../src/modules/registrations/ban-handler.ts';
import { noopSessionAllocator } from '../../src/modules/sessions/allocator-port.ts';
import { testCrypto } from '../helpers/app-deps.ts';
import { START_TIME, bearer, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  insertAuthSession,
  insertPublishedSession,
  insertRegistration,
  insertSession,
  insertTeam,
  insertTeamMember,
  insertUser,
} from '../helpers/factories.ts';
import { waitForLockWaiters } from '../helpers/lock-waiters.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import { readRegistration } from '../helpers/registration-scene.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';
import { waitFor } from '../helpers/wait-for.ts';

const clock = createManualClock(START_TIME);
const notifier = createInMemoryNotifier();
const controls = { failEmailEnqueue: false };

let database: TestDatabase;
let worker: JobRunner;
let producer: JobRunner;
let h: AuthTestApp;
const workerLogs = captureLogs();

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 12 });
  worker = createJobRunner({
    databaseUrl: database.url,
    logger: workerLogs.logger,
    role: 'worker',
    pollingIntervalSeconds: 0.5,
    superviseIntervalSeconds: 2,
  });
  producer = createJobRunner({
    databaseUrl: database.url,
    logger: captureLogs().logger,
    role: 'producer',
  });
  await worker.start();
  await producer.start();
  const db = createKysely(database.pool);
  // The handler's runner: the worker's, with a switch that fails the promotion email so a test can prove the email commits
  // (or rolls back) with the withdrawal.
  const handlerJobs: Pick<JobRunner, 'enqueue'> = {
    enqueue: async (queue, data, options?: EnqueueOptions) => {
      if (controls.failEmailEnqueue && queue === 'send-email')
        throw new Error('email enqueue failed');
      return worker.enqueue(queue, data, options);
    },
  };
  await registerJobs({
    sessionAllocator: noopSessionAllocator,
    webBaseUrl: 'https://app.example.test',
    runner: worker,
    notifier,
    crypto: testCrypto(),
    db,
    clock,
    queues: QUEUES.map((queue) =>
      queue.name === 'member-banned'
        ? { ...queue, retryLimit: 2, retryDelay: 1, retryBackoff: false }
        : queue,
    ),
    memberBannedHandler: createRegistrationsBanHandler({
      db,
      jobs: handlerJobs,
      clock,
      webBaseUrl: 'https://app.example.test',
    }),
  });
  h = await buildAuthTestApp(database.pool, { jobs: producer });
});
afterAll(async () => {
  await h.close();
  await producer.stop();
  await worker.stop();
  await database.close();
});
afterEach(async () => {
  controls.failEmailEnqueue = false;
  await disarm();
});

interface Person {
  readonly id: string;
  readonly token: string;
  readonly email: string;
  readonly membershipId: string;
}

async function member(teamId: string, tag: string, role: 'MEMBER' | 'TEAM_ADMIN' = 'MEMBER') {
  const email = `${tag}.${randomUUID().slice(0, 8)}@ban.example.test`;
  const id = await insertUser(database.pool, 'MALE', { email });
  const membershipId = await insertTeamMember(database.pool, { teamId, userId: id, role });
  const { token } = await insertAuthSession(database.pool, id, { createdAt: clock.now() });
  return { id, token, email, membershipId } satisfies Person;
}

const ban = (teamId: string, admin: Person, target: Person) =>
  h.app.inject({
    method: 'POST',
    url: `/teams/${teamId}/members/${target.id}/ban`,
    headers: bearer(admin.token),
    payload: { reason: 'private reason text' },
  });

interface JobRow {
  id: string;
  state: string;
  retry_count: number;
  data: Record<string, unknown>;
}

async function jobsFor(membershipId: string): Promise<JobRow[]> {
  const { rows } = await database.pool.query<JobRow>(
    `SELECT id, state, retry_count, data FROM pgboss.job
      WHERE name = 'member-banned' AND singleton_key = $1 ORDER BY created_on`,
    [`member-banned:${membershipId}`],
  );
  return rows;
}

const waitForJob = (membershipId: string, state: string, index = 0) =>
  waitFor(
    async () => {
      const job = (await jobsFor(membershipId))[index];
      return job?.state === state ? job : undefined;
    },
    {
      timeoutMs: 20_000,
      label: `member-banned job ${String(index)} of ${membershipId} to be ${state}`,
    },
  );

function withoutMeta(data: Record<string, unknown>): Record<string, unknown> {
  const { _meta: meta, ...rest } = data;
  void meta;
  return rest;
}

const logsFor = (event: string, userId: string) =>
  workerLogs.lines().filter((line) => line.event === event && line.userId === userId);

// ---- Fault injection -----------------------------------------------------------------------------------------------------

async function arm(sessionId: string, sqlState: string, failFirst: number): Promise<void> {
  await database.pool.query(
    `CREATE TABLE ban_fault (session_id uuid PRIMARY KEY, fail_first int NOT NULL)`,
  );
  await database.pool.query(`CREATE SEQUENCE ban_fault_seq`);
  await database.pool.query(`INSERT INTO ban_fault (session_id, fail_first) VALUES ($1, $2)`, [
    sessionId,
    failFirst,
  ]);
  await database.pool.query(`
    CREATE FUNCTION ban_fault_fn() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE limit_n int;
    BEGIN
      SELECT fail_first INTO limit_n FROM ban_fault WHERE session_id = NEW.session_id;
      IF FOUND AND nextval('ban_fault_seq') <= limit_n THEN
        RAISE EXCEPTION 'injected fault' USING ERRCODE = '${sqlState}';
      END IF;
      RETURN NEW;
    END $$`);
  await database.pool.query(`
    CREATE TRIGGER ban_fault_trg BEFORE UPDATE ON registrations FOR EACH ROW
    WHEN (NEW.status = 'WITHDRAWN' AND OLD.status <> 'WITHDRAWN')
    EXECUTE FUNCTION ban_fault_fn()`);
}

async function disarm(): Promise<void> {
  await database.pool.query(`DROP TRIGGER IF EXISTS ban_fault_trg ON registrations`);
  await database.pool.query(`DROP FUNCTION IF EXISTS ban_fault_fn()`);
  await database.pool.query(`DROP SEQUENCE IF EXISTS ban_fault_seq`);
  await database.pool.query(`DROP TABLE IF EXISTS ban_fault`);
}

// ---- Scenes --------------------------------------------------------------------------------------------------------------

async function published(
  teamId: string,
  options: { maxPlayers?: number; startsInHours?: number; deadlineHoursBeforeStart?: number } = {},
) {
  const startsInHours = options.startsInHours ?? 72;
  const startsAt = new Date(clock.now().getTime() + startsInHours * 3_600_000);
  const { sessionId } = await insertPublishedSession(database.pool, teamId, {
    now: clock.now(),
    maxPlayers: options.maxPlayers ?? 12,
    startsInHours,
    ...(options.deadlineHoursBeforeStart === undefined
      ? {}
      : {
          cancellationDeadline: new Date(
            startsAt.getTime() - options.deadlineHoursBeforeStart * 3_600_000,
          ),
        }),
  });
  return sessionId;
}

async function sessionOf(teamId: string, status: 'CANCELLED' | 'DRAFT') {
  return insertSession(database.pool, teamId, {}, { status });
}

describe('AC-HAPPY-10: a ban withdraws the member from upcoming sessions and promotes the waitlist', () => {
  it('withdraws CONFIRMED and WAITLISTED rows as BANNED with no fee, promotes the waitlisted party and emails it, and leaves everything else alone', async () => {
    const teamId = await insertTeam(database.pool, { payoutConfigured: true });
    const otherTeamId = await insertTeam(database.pool, { payoutConfigured: true });
    const admin = await member(teamId, 'admin', 'TEAM_ADMIN');
    const m = await member(teamId, 'banned');
    const w = await member(teamId, 'waiting');
    const z = await member(teamId, 'holder');
    await insertTeamMember(database.pool, { teamId: otherTeamId, userId: m.id });

    // S1: full, M confirmed, W waiting; its cancellation deadline has passed, so a player withdrawal would be LATE.
    const s1 = await published(teamId, { maxPlayers: 1, deadlineHoursBeforeStart: 100 });
    await insertRegistration(database.pool, {
      sessionId: s1,
      teamId,
      userId: m.id,
      status: 'CONFIRMED',
    });
    await insertRegistration(database.pool, {
      sessionId: s1,
      teamId,
      userId: w.id,
      status: 'WAITLISTED',
      queuePosition: 1,
    });
    // S2: M waitlisted behind Z.
    const s2 = await published(teamId, { maxPlayers: 1, startsInHours: 96 });
    await insertRegistration(database.pool, {
      sessionId: s2,
      teamId,
      userId: z.id,
      status: 'CONFIRMED',
    });
    await insertRegistration(database.pool, {
      sessionId: s2,
      teamId,
      userId: m.id,
      status: 'WAITLISTED',
      queuePosition: 1,
    });
    // S0: already started. S3: another team. S4: cancelled. S5: draft.
    const s0 = await published(teamId, { startsInHours: -2 });
    await insertRegistration(database.pool, {
      sessionId: s0,
      teamId,
      userId: m.id,
      status: 'CONFIRMED',
    });
    const s3 = await published(otherTeamId);
    await insertRegistration(database.pool, {
      sessionId: s3,
      teamId: otherTeamId,
      userId: m.id,
      status: 'CONFIRMED',
    });
    const s4 = await sessionOf(teamId, 'CANCELLED');
    await insertRegistration(database.pool, {
      sessionId: s4,
      teamId,
      userId: m.id,
      status: 'CONFIRMED',
    });

    const paymentsBefore = await database.pool.query(`SELECT count(*)::int AS n FROM payments`);

    expect((await ban(teamId, admin, m)).statusCode).toBe(200);
    // The ban row as the ban route committed it; the handler must leave it exactly like this.
    const memberRowBefore = await database.pool.query(
      `SELECT status, banned_at, banned_by, ban_reason FROM team_members WHERE id = $1`,
      [m.membershipId],
    );
    expect(memberRowBefore.rows).toEqual([expect.objectContaining({ status: 'BANNED' })]);
    const job = await waitForJob(m.membershipId, 'completed');
    expect(job.retry_count).toBe(0);

    expect(await readRegistration(database.pool, s1, m.id)).toMatchObject({
      status: 'WITHDRAWN',
      withdrawalKind: 'BANNED',
      feeDue: false,
      queuePosition: null,
    });
    expect(await readRegistration(database.pool, s2, m.id)).toMatchObject({
      status: 'WITHDRAWN',
      withdrawalKind: 'BANNED',
      feeDue: false,
    });
    // W is promoted in S1, with the standard promotion; Z is untouched in S2.
    expect(await readRegistration(database.pool, s1, w.id)).toMatchObject({
      status: 'CONFIRMED',
      queuePosition: null,
    });
    expect((await readRegistration(database.pool, s1, w.id))?.promotedAt).toBeInstanceOf(Date);
    expect(await readRegistration(database.pool, s2, z.id)).toMatchObject({ status: 'CONFIRMED' });
    // Everything the ban must not touch.
    expect(await readRegistration(database.pool, s0, m.id)).toMatchObject({ status: 'CONFIRMED' });
    expect(await readRegistration(database.pool, s3, m.id)).toMatchObject({ status: 'CONFIRMED' });
    expect(await readRegistration(database.pool, s4, m.id)).toMatchObject({ status: 'CONFIRMED' });
    expect((await database.pool.query(`SELECT count(*)::int AS n FROM payments`)).rows).toEqual(
      paymentsBefore.rows,
    );

    // The promotion email reaches W, through the real send-email worker; the banned member receives nothing.
    await waitFor(() => (notifier.sent.some((mail) => mail.to === w.email) ? true : undefined), {
      label: 'the promotion email to W',
    });
    expect(notifier.sent.filter((mail) => mail.to === w.email)).toHaveLength(1);
    expect(notifier.sent.filter((mail) => mail.to === m.email)).toEqual([]);

    // The handler never writes team_members and the log names ids and counts only.
    const memberRowAfter = await database.pool.query(
      `SELECT status, banned_at, banned_by, ban_reason FROM team_members WHERE id = $1`,
      [m.membershipId],
    );
    expect(memberRowAfter.rows).toEqual(memberRowBefore.rows);
    expect(logsFor('team.member.banned.handled', m.id)).toEqual([
      expect.objectContaining({ hook: 'registrations', affected: 2, teamId }),
    ]);
    const serialised = JSON.stringify(workerLogs.lines().filter((line) => line.userId === m.id));
    for (const secret of [m.email, 'private reason text']) expect(serialised).not.toContain(secret);
  });

  it('a redelivery of the same job finds nothing active, returns affected 0 and changes nothing', async () => {
    const teamId = await insertTeam(database.pool, { payoutConfigured: true });
    const admin = await member(teamId, 'admin', 'TEAM_ADMIN');
    const m = await member(teamId, 'banned');
    const s1 = await published(teamId);
    await insertRegistration(database.pool, { sessionId: s1, teamId, userId: m.id });
    expect((await ban(teamId, admin, m)).statusCode).toBe(200);
    const first = await waitForJob(m.membershipId, 'completed');
    const before = await readRegistration(database.pool, s1, m.id);

    await producer.enqueue('member-banned', withoutMeta(first.data), {
      singletonKey: `member-banned:${m.membershipId}`,
    });
    await waitForJob(m.membershipId, 'completed', 1);
    expect(logsFor('team.member.banned.handled', m.id).map((line) => line.affected)).toEqual([
      1, 0,
    ]);
    expect(await readRegistration(database.pool, s1, m.id)).toEqual(before);
  });
});

describe('the promotion and its email commit with the withdrawal (AC-INTEGRATION-2)', () => {
  it('rolls the withdrawal back when the promotion email cannot be enqueued, and the retry completes both', async () => {
    const teamId = await insertTeam(database.pool, { payoutConfigured: true });
    const admin = await member(teamId, 'admin', 'TEAM_ADMIN');
    const m = await member(teamId, 'banned');
    const w = await member(teamId, 'waiting');
    const s1 = await published(teamId, { maxPlayers: 1 });
    await insertRegistration(database.pool, { sessionId: s1, teamId, userId: m.id });
    await insertRegistration(database.pool, {
      sessionId: s1,
      teamId,
      userId: w.id,
      status: 'WAITLISTED',
      queuePosition: 1,
    });

    controls.failEmailEnqueue = true;
    expect((await ban(teamId, admin, m)).statusCode).toBe(200);
    await waitFor(
      () => (logsFor('team.member.banned.hook_failed', m.id).length > 0 ? true : undefined),
      {
        label: 'the first failed attempt',
      },
    );
    // The ban stands, but nothing half-applied: M still holds the seat and W is still waiting.
    expect(await readRegistration(database.pool, s1, m.id)).toMatchObject({ status: 'CONFIRMED' });
    expect(await readRegistration(database.pool, s1, w.id)).toMatchObject({ status: 'WAITLISTED' });

    controls.failEmailEnqueue = false;
    await waitForJob(m.membershipId, 'completed');
    expect(await readRegistration(database.pool, s1, m.id)).toMatchObject({ status: 'WITHDRAWN' });
    expect(await readRegistration(database.pool, s1, w.id)).toMatchObject({ status: 'CONFIRMED' });
    await waitFor(() => (notifier.sent.some((mail) => mail.to === w.email) ? true : undefined), {
      label: 'the promotion email to W after the retry',
    });
    expect(notifier.sent.filter((mail) => mail.to === w.email)).toHaveLength(1);
  });
});

describe('AC-ERROR-9: a failing handler never undoes the ban and is visible to operators', () => {
  it('a transient error on one session is retried: the session already processed stays committed and is not processed twice', async () => {
    const teamId = await insertTeam(database.pool, { payoutConfigured: true });
    const admin = await member(teamId, 'admin', 'TEAM_ADMIN');
    const m = await member(teamId, 'banned');
    const s1 = await published(teamId, { startsInHours: 72 });
    const s2 = await published(teamId, { startsInHours: 96 });
    await insertRegistration(database.pool, { sessionId: s1, teamId, userId: m.id });
    await insertRegistration(database.pool, { sessionId: s2, teamId, userId: m.id });
    // Serialisation failure on S2's first withdrawal attempt only.
    await arm(s2, '40001', 1);

    expect((await ban(teamId, admin, m)).statusCode).toBe(200);
    const job = await waitForJob(m.membershipId, 'completed');
    expect(job.retry_count).toBe(1);

    expect(await readRegistration(database.pool, s1, m.id)).toMatchObject({
      status: 'WITHDRAWN',
      withdrawalKind: 'BANNED',
    });
    expect(await readRegistration(database.pool, s2, m.id)).toMatchObject({
      status: 'WITHDRAWN',
      withdrawalKind: 'BANNED',
    });
    // S1 was withdrawn on the first attempt and never again: one withdrawn event per session id.
    const withdrawn = workerLogs
      .lines()
      .filter((line) => line.event === 'registration.withdrawn' && line.userId === m.id);
    expect(withdrawn.map((line) => line.sessionId).sort()).toEqual([s1, s2].sort());
    expect(logsFor('registration.ban.session_failed', m.id)).toEqual([
      expect.objectContaining({ sessionId: s2, class: 'transient', sqlState: '40001' }),
    ]);
    expect(logsFor('team.member.banned.hook_failed', m.id)[0]).toMatchObject({
      level: 'warn',
      hook: 'registrations',
      willRetry: true,
    });
    expect(
      (await database.pool.query(`SELECT status FROM team_members WHERE id = $1`, [m.membershipId]))
        .rows,
    ).toEqual([{ status: 'BANNED' }]);
  });

  it('a permanent error ends the job in failed with an error log (ids only), keeps the ban and the other session committed', async () => {
    const teamId = await insertTeam(database.pool, { payoutConfigured: true });
    const admin = await member(teamId, 'admin', 'TEAM_ADMIN');
    const m = await member(teamId, 'banned');
    const s1 = await published(teamId, { startsInHours: 72 });
    const s2 = await published(teamId, { startsInHours: 96 });
    await insertRegistration(database.pool, { sessionId: s1, teamId, userId: m.id });
    await insertRegistration(database.pool, { sessionId: s2, teamId, userId: m.id });
    await arm(s2, '23514', 1_000_000);

    expect((await ban(teamId, admin, m)).statusCode).toBe(200);
    const failed = await waitForJob(m.membershipId, 'failed');
    expect(failed.retry_count).toBe(0);
    expect(await readRegistration(database.pool, s1, m.id)).toMatchObject({ status: 'WITHDRAWN' });
    expect(await readRegistration(database.pool, s2, m.id)).toMatchObject({ status: 'CONFIRMED' });
    const lines = logsFor('team.member.banned.hook_failed', m.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'error',
      hook: 'registrations',
      willRetry: false,
      teamId,
    });
    expect(JSON.stringify(lines)).not.toContain(m.email);
    expect(logsFor('registration.ban.session_failed', m.id)).toEqual([
      expect.objectContaining({ sessionId: s2, class: 'permanent', sqlState: '23514' }),
    ]);

    // The ban stands, and the next sweep re-enqueues the job while S2 is still active; once the fault is gone it completes.
    expect(
      (await database.pool.query(`SELECT status FROM team_members WHERE id = $1`, [m.membershipId]))
        .rows,
    ).toEqual([{ status: 'BANNED' }]);
    await disarm();
    const sweepId = await worker.trigger('registration-ban-reconcile', {
      source: 'integration-test',
    });
    expect(sweepId).toEqual(expect.any(String));
    await waitForJob(m.membershipId, 'completed', 1);
    expect(await readRegistration(database.pool, s2, m.id)).toMatchObject({ status: 'WITHDRAWN' });
  });
});

describe('the ban/promotion residual (ADR 0018 C3): the handler heals a promotion that committed after the ban', () => {
  it('a promotion in flight when the ban commits can promote the banned member, and the handler then withdraws that now-CONFIRMED row as BANNED', async () => {
    const teamId = await insertTeam(database.pool, { payoutConfigured: true });
    const admin = await member(teamId, 'admin', 'TEAM_ADMIN');
    const w = await member(teamId, 'waiting');
    const s1 = await published(teamId, { maxPlayers: 2 });
    await insertRegistration(database.pool, {
      sessionId: s1,
      teamId,
      userId: w.id,
      status: 'WAITLISTED',
      queuePosition: 1,
    });

    // A promotion transaction that read W as APPROVED holds the session lock; the ban commits meanwhile (the allocator cannot
    // lock team_members after the session, so it cannot see the ban). The member-banned job selects W's WAITLISTED row, then
    // blocks on the session lock.
    const promotion = await database.pool.connect();
    try {
      await promotion.query('BEGIN');
      await promotion.query('SELECT id FROM game_sessions WHERE id = $1 FOR UPDATE', [s1]);
      expect((await ban(teamId, admin, w)).statusCode).toBe(200);
      await waitForLockWaiters(database.pool, 1, 'the ban handler blocked on the session lock');
      await promotion.query(
        `UPDATE registrations SET status = 'CONFIRMED', queue_position = NULL, promoted_at = $2,
                                  registrant_sex = 'MALE', registrant_skill_level = 'BEGINNER', updated_at = $2
          WHERE session_id = $1 AND user_id = $3`,
        [s1, clock.now(), w.id],
      );
      await promotion.query('COMMIT');
    } finally {
      promotion.release();
    }

    await waitForJob(w.membershipId, 'completed');
    expect(await readRegistration(database.pool, s1, w.id)).toMatchObject({
      status: 'WITHDRAWN',
      withdrawalKind: 'BANNED',
      feeDue: false,
    });
    expect(logsFor('team.member.banned.handled', w.id)).toEqual([
      expect.objectContaining({ affected: 1 }),
    ]);
  });
});
