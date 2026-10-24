/**
 * THE CONTRACT TEST for the ban seam (Architecture 1B, ADR 0015, AC-ASYNC-1..3, AC-ERROR-12, AC-INTEGRATION-1).
 *
 * registration-and-waitlist's real `MemberBannedHandler` and its registration path MUST also pass this file:
 * swap the recording handler below for the real one (through `registerJobs({ memberBannedHandler })`) and the
 * assertions about the payload, the job commit, the retry, the idempotent redelivery and the
 * `assertApprovedMember` race still hold. It runs against a real cloned Postgres, a real pg-boss producer and
 * worker, and the real HTTP layer. The test only INSERTS a `registrations` row (the table exists); it implements
 * no waitlist logic beyond a guarded withdraw that stands in for the handler's selection-by-current-state.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerJobs } from '../../src/jobs/bootstrap.ts';
import { QUEUES } from '../../src/jobs/registry.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import { NonRetryableJobError, createJobRunner, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import { createInMemoryNotifier } from '../../src/lib/notifications/adapters/in-memory.ts';
import {
  noopMemberBannedHandler,
  type MemberBannedEvent,
  type MemberBannedHookContext,
  type MemberBannedOutcome,
} from '../../src/modules/teams/ban-hook.ts';
import { assertApprovedMember } from '../../src/modules/teams/membership.ts';
import { testCrypto } from '../helpers/app-deps.ts';
import { bearer, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  insertAuthSession,
  insertRegistration,
  insertSession,
  insertTeam,
  insertTeamMember,
  insertUser,
} from '../helpers/factories.ts';
import { waitForLockWaiters } from '../helpers/lock-waiters.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import { freePort, spawnNode } from '../helpers/spawn-node.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';
import { waitFor } from '../helpers/wait-for.ts';
import { noopSessionAllocator } from '../../src/modules/sessions/allocator-port.ts';

type Behaviour = (
  event: MemberBannedEvent,
  context: MemberBannedHookContext,
) => Promise<MemberBannedOutcome>;

interface HandlerCall {
  readonly event: MemberBannedEvent;
  readonly attempt: number;
  readonly affected: number | 'threw';
  readonly seen: readonly string[];
}

/** The seam test's stand-in for the real handler: selects registrations by CURRENT state, withdraws, never remembers. */
const withdrawActiveRegistrations: Behaviour = async (event) => {
  const { rows } = await database.pool.query<{ id: string }>(
    `UPDATE registrations SET status = 'WITHDRAWN', queue_position = NULL, updated_at = now(),
                              withdrawn_at = now(), withdrawal_kind = 'BANNED'
      WHERE team_id = $1 AND user_id = $2 AND status IN ('CONFIRMED', 'WAITLISTED')
      RETURNING id`,
    [event.teamId, event.userId],
  );
  return { affected: rows.length };
};

let behaviour: Behaviour = withdrawActiveRegistrations;
const calls: HandlerCall[] = [];

const controls: {
  beforeEnqueue: (() => Promise<void>) | undefined;
  failBefore: boolean;
  failAfter: boolean;
} = { beforeEnqueue: undefined, failBefore: false, failAfter: false };

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
  await registerJobs({
    sessionAllocator: noopSessionAllocator,
    webBaseUrl: 'https://app.example.test',
    runner: worker,
    notifier: createInMemoryNotifier(),
    crypto: testCrypto(),
    db: createKysely(database.pool),
    // A short retry policy so the transient-failure test runs in seconds.
    queues: QUEUES.map((queue) =>
      queue.name === 'member-banned'
        ? { ...queue, retryLimit: 2, retryDelay: 1, retryBackoff: false }
        : queue,
    ),
    memberBannedHandler: {
      name: 'recording',
      async handle(event, context) {
        let affected: number | 'threw' = 'threw';
        const seen: string[] = [];
        try {
          const before = await database.pool.query<{ id: string }>(
            `SELECT id FROM registrations
              WHERE team_id = $1 AND user_id = $2 AND status IN ('CONFIRMED', 'WAITLISTED')`,
            [event.teamId, event.userId],
          );
          seen.push(...before.rows.map((r) => r.id));
          const outcome = await behaviour(event, context);
          affected = outcome.affected;
          return outcome;
        } finally {
          calls.push({ event, attempt: context.attempt, affected, seen });
        }
      },
    },
  });
  h = await buildAuthTestApp(database.pool, {
    jobs: {
      enqueue: async (queue, data, options) => {
        await controls.beforeEnqueue?.();
        if (controls.failBefore) throw new Error('enqueue failed');
        const id = await producer.enqueue(queue, data, options);
        if (controls.failAfter) throw new Error('late failure after the job row was written');
        return id;
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

interface Person {
  readonly id: string;
  readonly token: string;
  readonly fullName: string;
  readonly email: string;
}

async function person(fullName: string): Promise<Person> {
  const email = `${fullName.toLowerCase().replace(/\s+/g, '.')}.${randomUUID().slice(0, 6)}@seam.example.test`;
  const id = await insertUser(database.pool, 'MALE', { email });
  await database.pool.query(`UPDATE users SET full_name = $2 WHERE id = $1`, [id, fullName]);
  const { token } = await insertAuthSession(database.pool, id, { createdAt: h.clock.now() });
  return { id, token, fullName, email };
}

interface Scene {
  readonly teamId: string;
  readonly admin: Person;
  readonly member: Person;
  readonly membershipId: string;
  readonly sessionId: string;
}

async function scene(): Promise<Scene> {
  const admin = await person('Seam Admin');
  const member = await person('Seam Member');
  const teamId = await insertTeam(database.pool);
  await insertTeamMember(database.pool, { teamId, userId: admin.id, role: 'TEAM_ADMIN' });
  const membershipId = await insertTeamMember(database.pool, { teamId, userId: member.id });
  const sessionId = await insertSession(database.pool, teamId);
  return { teamId, admin, member, membershipId, sessionId };
}

const ban = (s: Scene, reason?: string) =>
  h.app.inject({
    method: 'POST',
    url: `/teams/${s.teamId}/members/${s.member.id}/ban`,
    headers: bearer(s.admin.token),
    payload: reason === undefined ? {} : { reason },
  });

async function memberStatus(s: Scene): Promise<string | undefined> {
  const { rows } = await database.pool.query<{ status: string }>(
    `SELECT status FROM team_members WHERE id = $1`,
    [s.membershipId],
  );
  return rows[0]?.status;
}

interface JobRow {
  id: string;
  state: string;
  retry_count: number;
  singleton_key: string | null;
  data: Record<string, unknown>;
}

async function jobsFor(membershipId: string): Promise<JobRow[]> {
  const { rows } = await database.pool.query<JobRow>(
    `SELECT id, state, retry_count, singleton_key, data FROM pgboss.job
      WHERE name = 'member-banned' AND singleton_key = $1 ORDER BY created_on`,
    [`member-banned:${membershipId}`],
  );
  return rows;
}

const waitForJobState = (membershipId: string, state: string, index = 0) =>
  waitFor(
    async () => {
      const job = (await jobsFor(membershipId))[index];
      return job?.state === state ? job : undefined;
    },
    { timeoutMs: 20_000, label: `member-banned job ${String(index)} to be ${state}` },
  );

const callsFor = (s: Scene) => calls.filter((c) => c.event.membershipId === s.membershipId);

function withoutMeta(data: Record<string, unknown>): Record<string, unknown> {
  const { _meta: meta, ...rest } = data;
  void meta;
  return rest;
}

describe('the ban commits its job and the handler receives exactly that payload (AC-ASYNC-1, AC-INTEGRATION-1)', () => {
  it('writes a real pgboss.job row with the strict id-only payload, the handler sees the registration by current state, and a redelivery is harmless', async () => {
    behaviour = withdrawActiveRegistrations;
    const s = await scene();
    const registrationId = await insertRegistration(database.pool, {
      sessionId: s.sessionId,
      teamId: s.teamId,
      userId: s.member.id,
      status: 'CONFIRMED',
    });

    const response = await ban(s, 'private reason text');
    expect(response.statusCode).toBe(200);
    expect(await memberStatus(s)).toBe('BANNED');

    const job = await waitForJobState(s.membershipId, 'completed');
    expect(job.singleton_key).toBe(`member-banned:${s.membershipId}`);
    expect(Object.keys(withoutMeta(job.data)).sort()).toEqual(
      ['bannedAt', 'bannedBy', 'membershipId', 'teamId', 'userId'].sort(),
    );
    expect(withoutMeta(job.data)).toMatchObject({
      teamId: s.teamId,
      userId: s.member.id,
      membershipId: s.membershipId,
      bannedBy: s.admin.id,
    });
    expect(String(job.data.bannedAt)).toMatch(/Z$/);
    // Trace context rides along for the worker span.
    expect((job.data._meta as { traceparent?: string }).traceparent).toMatch(/^00-/);
    // No name, email or reason is stored in the job table.
    const stored = JSON.stringify(job.data);
    for (const secret of [s.member.fullName, s.member.email, 'private reason text']) {
      expect(stored).not.toContain(secret);
    }

    const first = callsFor(s);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      affected: 1,
      seen: [registrationId],
      event: { teamId: s.teamId, userId: s.member.id, bannedBy: s.admin.id },
    });
    expect(first[0]?.event.bannedAt).toBeInstanceOf(Date);
    const { rows } = await database.pool.query<{ status: string }>(
      `SELECT status FROM registrations WHERE id = $1`,
      [registrationId],
    );
    expect(rows[0]?.status).toBe('WITHDRAWN');

    // At-least-once: the same job delivered again (a replay after completion) changes nothing.
    await producer.enqueue('member-banned', withoutMeta(job.data), {
      singletonKey: `member-banned:${s.membershipId}`,
    });
    await waitForJobState(s.membershipId, 'completed', 1);
    const all = callsFor(s);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ affected: 0, seen: [] });
    expect(await memberStatus(s)).toBe('BANNED');
  });

  it('runs the default no-op handler through the port: it logs team.member.banned.hook_noop and the job completes', async () => {
    behaviour = (event, context) => noopMemberBannedHandler.handle(event, context);
    const s = await scene();
    expect((await ban(s)).statusCode).toBe(200);
    await waitForJobState(s.membershipId, 'completed');
    const lines = workerLogs.lines().filter((line) => line.userId === s.member.id);
    expect(lines.map((line) => line.event)).toEqual(
      expect.arrayContaining(['team.member.banned.hook_noop', 'team.member.banned.handled']),
    );
    expect(JSON.stringify(lines)).not.toContain(s.member.fullName);
    expect(JSON.stringify(lines)).not.toContain(s.member.email);
  });
});

describe('a ban clears Auto Enroll in the same UPDATE (skill-levels-and-auto-enroll AC-ERROR-5, D-59)', () => {
  it('bans an auto-enrolled member with 200 and leaves the three Auto Enroll columns cleared', async () => {
    behaviour = withdrawActiveRegistrations;
    const s = await scene();
    await database.pool.query(
      `UPDATE team_members SET is_auto_enroll = true, auto_enroll_until = '2027-01-31',
                               auto_enroll_assigned_at = now() WHERE id = $1`,
      [s.membershipId],
    );
    expect((await ban(s)).statusCode).toBe(200);
    // Let the member-banned job finish before the next test swaps the shared handler behaviour.
    await waitForJobState(s.membershipId, 'completed');
    const { rows } = await database.pool.query(
      `SELECT status, is_auto_enroll, auto_enroll_until, auto_enroll_assigned_at
         FROM team_members WHERE id = $1`,
      [s.membershipId],
    );
    expect(rows).toEqual([
      {
        status: 'BANNED',
        is_auto_enroll: false,
        auto_enroll_until: null,
        auto_enroll_assigned_at: null,
      },
    ]);
  });
});

describe('a failing handler never undoes or delays the ban (AC-ERROR-12)', () => {
  it('retries a transient failure to success while the member stays banned and the answer was already 200', async () => {
    let failures = 0;
    behaviour = async (event, context) => {
      if (failures === 0) {
        failures += 1;
        throw new Error('transient: database blip');
      }
      return withdrawActiveRegistrations(event, context);
    };
    const s = await scene();
    const registrationId = await insertRegistration(database.pool, {
      sessionId: s.sessionId,
      teamId: s.teamId,
      userId: s.member.id,
    });
    const response = await ban(s);
    expect(response.statusCode).toBe(200);
    expect(await memberStatus(s)).toBe('BANNED');

    const job = await waitForJobState(s.membershipId, 'completed');
    expect(job.retry_count).toBe(1);
    expect(await memberStatus(s)).toBe('BANNED');
    const mine = callsFor(s);
    expect(mine.map((c) => c.affected)).toEqual(['threw', 1]);
    expect(mine[1]?.seen).toEqual([registrationId]);
    const failed = workerLogs
      .lines()
      .find(
        (line) => line.event === 'team.member.banned.hook_failed' && line.userId === s.member.id,
      );
    expect(failed).toMatchObject({ level: 'warn', teamId: s.teamId, willRetry: true });
    // Access stays revoked throughout.
    const gate = h.db
      .transaction()
      .execute((trx) => assertApprovedMember(trx, s.teamId, s.member.id));
    await expect(gate).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('ends a permanent failure in failed with an error log an operator can alert on, keeps the ban, and can be re-run by hand', async () => {
    behaviour = () => Promise.reject(new NonRetryableJobError('invariant breach'));
    const s = await scene();
    const registrationId = await insertRegistration(database.pool, {
      sessionId: s.sessionId,
      teamId: s.teamId,
      userId: s.member.id,
    });
    expect((await ban(s, 'secret reason')).statusCode).toBe(200);
    const failedJob = await waitForJobState(s.membershipId, 'failed');
    expect(failedJob.retry_count).toBe(0);
    expect(await memberStatus(s)).toBe('BANNED');
    const lines = workerLogs
      .lines()
      .filter(
        (line) => line.event === 'team.member.banned.hook_failed' && line.userId === s.member.id,
      );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'error',
      teamId: s.teamId,
      userId: s.member.id,
      willRetry: false,
    });
    const serialised = JSON.stringify(lines);
    for (const secret of [s.member.fullName, s.member.email, 'secret reason']) {
      expect(serialised).not.toContain(secret);
    }

    // Operator re-run (A12): the failed job no longer blocks the singleton key; a fixed handler completes it.
    behaviour = withdrawActiveRegistrations;
    await producer.enqueue('member-banned', withoutMeta(failedJob.data), {
      singletonKey: `member-banned:${s.membershipId}`,
    });
    await waitForJobState(s.membershipId, 'completed', 1);
    const { rows } = await database.pool.query<{ status: string }>(
      `SELECT status FROM registrations WHERE id = $1`,
      [registrationId],
    );
    expect(rows[0]?.status).toBe('WITHDRAWN');
  });
});

describe('the ban and its job commit or roll back together (AC-ASYNC-1)', () => {
  it('rolls the ban back and leaves no job when the enqueue fails', async () => {
    const s = await scene();
    controls.failBefore = true;
    try {
      const response = await ban(s);
      expect(response.statusCode).toBe(500);
    } finally {
      controls.failBefore = false;
    }
    expect(await memberStatus(s)).toBe('APPROVED');
    expect(await jobsFor(s.membershipId)).toHaveLength(0);
  });

  it('leaves no job row behind when the transaction fails after the job was written', async () => {
    const s = await scene();
    controls.failAfter = true;
    try {
      expect((await ban(s)).statusCode).toBe(500);
    } finally {
      controls.failAfter = false;
    }
    expect(await memberStatus(s)).toBe('APPROVED');
    expect(await jobsFor(s.membershipId)).toHaveLength(0);
    // And the ban works once the fault is gone: no stale singleton key blocks it.
    behaviour = withdrawActiveRegistrations;
    expect((await ban(s)).statusCode).toBe(200);
    await waitForJobState(s.membershipId, 'completed');
  });
});

describe('assertApprovedMember serialises with a concurrent ban (AC-ASYNC-3, AC-INTEGRATION-1)', () => {
  it('a registration holding the gate first commits, the ban waits for it, and the handler then sees that registration', async () => {
    behaviour = withdrawActiveRegistrations;
    const s = await scene();
    let gateAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => (gateAcquired = resolve));
    let finishRegistration!: () => void;
    const mayFinish = new Promise<void>((resolve) => (finishRegistration = resolve));
    const registrationId = randomUUID();

    const registering = h.db.transaction().execute(async (trx) => {
      await assertApprovedMember(trx, s.teamId, s.member.id);
      await sql`INSERT INTO registrations (id, session_id, team_id, user_id, status, registrant_sex,
                                           registrant_skill_level)
                VALUES (${registrationId}, ${s.sessionId}, ${s.teamId}, ${s.member.id}, 'CONFIRMED',
                        'MALE', 'BEGINNER')`.execute(trx);
      gateAcquired();
      await mayFinish;
    });
    await acquired;
    const banning = ban(s);
    // The ban is blocked on the member's row, which the gate holds FOR SHARE.
    await waitForLockWaiters(database.pool, 1, 'ban blocked behind the registration gate');
    expect(await memberStatus(s)).toBe('APPROVED');
    finishRegistration();
    await registering;
    expect((await banning).statusCode).toBe(200);

    await waitForJobState(s.membershipId, 'completed');
    const handled = callsFor(s);
    expect(handled).toHaveLength(1);
    expect(handled[0]?.seen).toEqual([registrationId]);
    expect(handled[0]?.affected).toBe(1);
  });

  it('a ban in flight holds the row, so a registration gate waits and is then refused: nothing slips in between', async () => {
    behaviour = withdrawActiveRegistrations;
    const s = await scene();
    let banInFlight!: () => void;
    const inFlight = new Promise<void>((resolve) => (banInFlight = resolve));
    let commitBan!: () => void;
    const mayCommit = new Promise<void>((resolve) => (commitBan = resolve));
    // Runs inside the ban transaction, after the row UPDATE and before COMMIT.
    controls.beforeEnqueue = async () => {
      banInFlight();
      await mayCommit;
    };
    const banning = ban(s);
    await inFlight;
    controls.beforeEnqueue = undefined;

    const registering = h.db.transaction().execute(async (trx) => {
      await assertApprovedMember(trx, s.teamId, s.member.id);
      await sql`INSERT INTO registrations (session_id, team_id, user_id, status, registrant_sex,
                                           registrant_skill_level)
                VALUES (${s.sessionId}, ${s.teamId}, ${s.member.id}, 'CONFIRMED', 'MALE',
                        'BEGINNER')`.execute(trx);
    });
    // Attach the assertion before the ban commits so the rejection is never unhandled.
    const refused = expect(registering).rejects.toMatchObject({ code: 'forbidden' });
    await waitForLockWaiters(database.pool, 1, 'gate blocked behind the ban');
    commitBan();
    expect((await banning).statusCode).toBe(200);
    await refused;

    const { rows } = await database.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM registrations WHERE team_id = $1 AND user_id = $2`,
      [s.teamId, s.member.id],
    );
    expect(rows[0]?.n).toBe(0);
    await waitForJobState(s.membershipId, 'completed');
    expect(callsFor(s)[0]).toMatchObject({ affected: 0, seen: [] });
  });
});

describe('operator re-run through the CLI (Architecture A12)', () => {
  it('enqueues a validated member-banned job under the membership singleton key and rejects a bad payload', async () => {
    behaviour = withdrawActiveRegistrations;
    const s = await scene();
    const env = {
      DATABASE_URL: database.url,
      NOTIFIER_ADAPTER: 'memory',
      LOG_FORMAT: 'json',
      LOG_LEVEL: 'silent',
      WORKER_HEALTH_PORT: String(await freePort()),
    };
    const payload = {
      teamId: s.teamId,
      userId: s.member.id,
      membershipId: s.membershipId,
      bannedBy: s.admin.id,
      bannedAt: new Date().toISOString(),
    };
    // The membership must be BANNED for the handler to act, as in a real re-run.
    expect((await ban(s)).statusCode).toBe(200);
    await waitForJobState(s.membershipId, 'completed');

    const run = spawnNode(
      'src/cli.ts',
      ['jobs', 'trigger', 'member-banned', JSON.stringify(payload)],
      env,
    );
    const { code } = await run.exited;
    expect(code, run.output()).toBe(0);
    expect(run.output()).toMatch(/enqueued member-banned job [0-9a-f-]{36}/);
    await waitForJobState(s.membershipId, 'completed', 1);
    expect((await jobsFor(s.membershipId))[1]?.singleton_key).toBe(
      `member-banned:${s.membershipId}`,
    );

    const bad = spawnNode(
      'src/cli.ts',
      ['jobs', 'trigger', 'member-banned', JSON.stringify({ ...payload, email: 'x@y.test' })],
      env,
    );
    expect((await bad.exited).code).not.toBe(0);
  }, 60_000);
});
