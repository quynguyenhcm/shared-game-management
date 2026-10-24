/**
 * The registration emails through HTTP, against a real pg-boss producer (AC-ASYNC-1, AC-HAPPY-11 for the panel side).
 *
 * The promotion email is enqueued with `enqueueEmail(runner, message, { trx })` in the promoting transaction (P5): a request
 * that commits leaves exactly one `send-email` job with the documented idempotency key and copy; a request that rolls back
 * (the job producer fails AFTER inserting its row) leaves no job and no promotion. Nobody is emailed about their own
 * register or withdraw, and a banned member is never emailed. The auto-enrol emails (AC-HAPPY-11) and the capacity-edit
 * promotions are proven through SSE's real paths in `registrations-sse-integration.int.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QUEUES } from '../../src/jobs/registry.ts';
import { createJobRunner, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import { START_TIME, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import { TEST_WEB_BASE_URL } from '../helpers/app-deps.ts';
import { insertPublishedSession, insertRegistration, insertTeam } from '../helpers/factories.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import {
  httpMember,
  readAs,
  readModelOf,
  registerAs,
  sessionUrl,
  withdrawAs,
  withdrawnOf,
  type HttpMember,
} from '../helpers/registrations-http.ts';
import { createRecordingJobs, readRegistration } from '../helpers/registration-scene.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

let database: TestDatabase;
let h: AuthTestApp;
let worker: JobRunner;
let producer: JobRunner;
let failAfterEnqueue = false;
const TEAM_NAME = 'Emailers Badminton';
const jobs = createRecordingJobs({
  enqueue: async (queue, data, options) => {
    const id = await producer.enqueue(queue, data, options);
    if (failAfterEnqueue) throw new Error('simulated failure after the job row was inserted');
    return id;
  },
});

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 12 });
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
  h = await buildAuthTestApp(database.pool, { jobs });
});
afterAll(async () => {
  await h.close();
  await producer.stop();
  await worker.stop();
  await database.close();
});
beforeEach(() => {
  h.clock.set(START_TIME);
  jobs.reset();
  failAfterEnqueue = false;
});

interface Scene {
  teamId: string;
  sessionId: string;
  deadline: Date;
}

async function scene(maxPlayers = 1): Promise<Scene> {
  const teamId = await insertTeam(database.pool, { name: TEAM_NAME, payoutConfigured: true });
  const { sessionId } = await insertPublishedSession(database.pool, teamId, {
    now: h.clock.now(),
    maxPlayers,
  });
  const { rows } = await database.pool.query<{ cancellation_deadline: Date }>(
    `SELECT cancellation_deadline FROM game_sessions WHERE id = $1`,
    [sessionId],
  );
  return { teamId, sessionId, deadline: rows[0]?.cancellation_deadline as Date };
}

async function seed(
  s: Scene,
  who: HttpMember,
  status: 'CONFIRMED' | 'WAITLISTED' | 'WITHDRAWN',
  queuePosition?: number,
  source: 'MEMBER' | 'AUTO_ENROL' = 'MEMBER',
): Promise<string> {
  return insertRegistration(database.pool, {
    sessionId: s.sessionId,
    teamId: s.teamId,
    userId: who.userId,
    status,
    queuePosition,
    source,
  });
}

interface QueuedEmail {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
  singletonKey: string | null;
}

/** The `send-email` jobs addressed to `emails`, straight from the pg-boss table (what a rolled-back transaction must not leave). */
async function queued(...emails: string[]): Promise<QueuedEmail[]> {
  const { rows } = await database.pool.query<QueuedEmail>(
    `SELECT data->>'to' AS "to", data->>'subject' AS subject, data->>'text' AS text,
            data->>'idempotencyKey' AS "idempotencyKey", singleton_key AS "singletonKey"
       FROM pgboss.job WHERE name = 'send-email' AND data->>'to' = ANY($1::text[]) ORDER BY created_on`,
    [emails],
  );
  return rows;
}

const emailOf = async (userId: string): Promise<string> =>
  (await database.pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId]))
    .rows[0]?.email as string;

describe('the promotion email (AC-ASYNC-1)', () => {
  it('is enqueued in the promoting transaction with the documented key and copy, and the withdraw response names nobody', async () => {
    const s = await scene();
    const holder = await httpMember(h, s.teamId);
    const next = await httpMember(h, s.teamId);
    await seed(s, holder, 'CONFIRMED');
    await seed(s, next, 'WAITLISTED', 1);
    const to = await emailOf(next.userId);

    const res = await withdrawAs(h, holder, s.teamId, s.sessionId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(to);
    expect(res.body).not.toContain(next.userId);
    expect(withdrawnOf(res).replacedBy).toBe('waitlist');

    const row = await readRegistration(database.pool, s.sessionId, next.userId);
    expect(row?.status).toBe('CONFIRMED');
    const emails = await queued(to);
    expect(emails).toHaveLength(1);
    const [mail] = emails;
    expect(mail?.idempotencyKey).toBe(
      `registration-promoted:${row?.id}:${row?.promotedAt?.getTime()}`,
    );
    expect(mail?.singletonKey).toBe(`notify:${mail?.idempotencyKey}`);
    expect(mail?.subject).toMatch(new RegExp(`^You're in: ${TEAM_NAME}, \\w{3} \\d{1,2} \\w{3}$`));
    expect(mail?.text).toContain('Test Hall');
    expect(mail?.text).toContain('1 Test Street, Auckland');
    expect(mail?.text).toContain(`${TEST_WEB_BASE_URL}/teams/${s.teamId}/sessions/${s.sessionId}`);
    expect(mail?.text).toContain('$17.00');
    expect(mail?.text).toContain('Free cancellation until');
    // Enqueued with the caller's transaction, once.
    const recorded = jobs.recorded.filter((job) => job.queue === 'send-email');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.inTransaction).toBe(true);
  });

  it('after the deadline the copy says the free cancellation has passed and what applies', async () => {
    const s = await scene();
    const holder = await httpMember(h, s.teamId);
    const next = await httpMember(h, s.teamId);
    await seed(s, holder, 'CONFIRMED');
    await seed(s, next, 'WAITLISTED', 1);
    h.clock.set(new Date(s.deadline.getTime() + 1));
    expect(
      (await withdrawAs(h, holder, s.teamId, s.sessionId, { expectLate: true })).statusCode,
    ).toBe(200);
    const [mail] = await queued(await emailOf(next.userId));
    expect(mail?.text).toContain(
      "The free cancellation deadline has passed. If you can't play, withdraw on the session page: you won't be charged if someone from the waitlist takes your place, otherwise the fee applies.",
    );
  });

  it('a rolled-back promotion leaves no job and no promotion; the retry sends exactly one', async () => {
    const s = await scene();
    const holder = await httpMember(h, s.teamId);
    const next = await httpMember(h, s.teamId);
    await seed(s, holder, 'CONFIRMED');
    await seed(s, next, 'WAITLISTED', 1);
    const to = await emailOf(next.userId);

    failAfterEnqueue = true;
    const failed = await withdrawAs(h, holder, s.teamId, s.sessionId);
    expect(failed.statusCode).toBeGreaterThanOrEqual(500);
    expect(failed.json()).toMatchObject({ error: { code: 'internal_error' } });
    expect(await queued(to)).toEqual([]);
    expect((await readRegistration(database.pool, s.sessionId, holder.userId))?.status).toBe(
      'CONFIRMED',
    );
    expect(await readRegistration(database.pool, s.sessionId, next.userId)).toMatchObject({
      status: 'WAITLISTED',
      promotedAt: null,
    });

    failAfterEnqueue = false;
    expect((await withdrawAs(h, holder, s.teamId, s.sessionId)).statusCode).toBe(200);
    expect(await queued(to)).toHaveLength(1);
    // A second withdraw is refused and promotes nobody, so no second email.
    expect((await withdrawAs(h, holder, s.teamId, s.sessionId)).statusCode).toBe(409);
    expect(await queued(to)).toHaveLength(1);
  });

  it('emails each promoted party of one withdrawal, in queue order, once per promotion', async () => {
    const s = await scene(2);
    const a = await httpMember(h, s.teamId);
    const b = await httpMember(h, s.teamId);
    const w1 = await httpMember(h, s.teamId);
    const w2 = await httpMember(h, s.teamId);
    await seed(s, a, 'CONFIRMED');
    await seed(s, b, 'CONFIRMED');
    await seed(s, w1, 'WAITLISTED', 1);
    await seed(s, w2, 'WAITLISTED', 2);
    expect((await withdrawAs(h, a, s.teamId, s.sessionId)).statusCode).toBe(200);
    expect(await queued(await emailOf(w1.userId))).toHaveLength(1);
    expect(await queued(await emailOf(w2.userId))).toHaveLength(0);
    expect((await withdrawAs(h, b, s.teamId, s.sessionId)).statusCode).toBe(200);
    expect(await queued(await emailOf(w2.userId))).toHaveLength(1);
  });

  it('nobody is emailed about their own register or withdraw, and a banned waitlisted member is never emailed', async () => {
    const s = await scene();
    const holder = await httpMember(h, s.teamId);
    const mine = await httpMember(h, s.teamId);
    const banned = await httpMember(h, s.teamId);
    const next = await httpMember(h, s.teamId);
    await seed(s, holder, 'CONFIRMED');
    // Own register (waitlisted) and own withdraw: no email to the actor.
    expect((await registerAs(h, mine, s.teamId, s.sessionId)).statusCode).toBe(201);
    expect((await withdrawAs(h, mine, s.teamId, s.sessionId)).statusCode).toBe(200);
    expect(await queued(await emailOf(mine.userId), await emailOf(holder.userId))).toEqual([]);

    await seed(s, banned, 'WAITLISTED', 5);
    await database.pool.query(
      `UPDATE team_members SET status = 'BANNED', banned_at = now(), banned_by = user_id WHERE team_id = $1 AND user_id = $2`,
      [s.teamId, banned.userId],
    );
    await seed(s, next, 'WAITLISTED', 6);
    expect((await withdrawAs(h, holder, s.teamId, s.sessionId)).statusCode).toBe(200);
    expect(await queued(await emailOf(banned.userId))).toEqual([]);
    expect(await queued(await emailOf(next.userId))).toHaveLength(1);
    expect((await readRegistration(database.pool, s.sessionId, banned.userId))?.status).toBe(
      'WAITLISTED',
    );
  });
});

describe('AC-HAPPY-11 on the panel side', () => {
  it('shows source AUTO_ENROL on the read model, and re-registering through the panel makes it MEMBER with no email', async () => {
    const s = await scene(10);
    const priya = await httpMember(h, s.teamId);
    await seed(s, priya, 'CONFIRMED', undefined, 'AUTO_ENROL');
    const model = readModelOf(await readAs(h, priya, s.teamId, s.sessionId));
    expect(model.me.registration).toMatchObject({ status: 'CONFIRMED', source: 'AUTO_ENROL' });

    expect((await withdrawAs(h, priya, s.teamId, s.sessionId)).statusCode).toBe(200);
    const again = await registerAs(h, priya, s.teamId, s.sessionId);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json<{ registration: { source: string } }>().registration.source).toBe('MEMBER');
    expect((await readRegistration(database.pool, s.sessionId, priya.userId))?.source).toBe(
      'MEMBER',
    );
    expect(await queued(await emailOf(priya.userId))).toEqual([]);
    void sessionUrl;
  });
});
