/**
 * AC-INTEGRATION-6: the registrations adapter fills session-scheduling-engine's allocator port end to end. The port comes from
 * `createSessionAllocator` (the composition function both entrypoints call), so these tests prove the swap itself, through
 * SSE's real paths on a real cloned PostgreSQL:
 *
 *  1. a PUBLISHED session left pending under the no-op (`auto_enrol_required`, `auto_enrolled_at` NULL) is enrolled by SSE's
 *     `recurrence-materialisation` sweep on a real pg-boss worker: once, in `selectAutoEnrollees` order, rows `AUTO_ENROL`,
 *     the AC-HAPPY-11 emails enqueued in that transaction, the marker stamped, and a second sweep enrols nobody;
 *  2. an admin raises public capacity on a full PUBLISHED session with a waitlist through `PUT /teams/:teamId/sessions/:id`:
 *     first-fit promotion, owed fees released, the AC-ASYNC-1 emails on that transaction, `promoted` equal to the number of
 *     promoted seats, and a rolled-back edit leaves no promotion, no release and no email;
 *  3. the same through a series edit that propagates to the instance.
 */
import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerJobs } from '../../src/jobs/bootstrap.ts';
import { QUEUES, QUEUE_NAMES } from '../../src/jobs/registry.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import { createJobRunner, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import { createInMemoryNotifier } from '../../src/lib/notifications/adapters/in-memory.ts';
import { runSessionAutoEnrol } from '../../src/modules/sessions/auto-enrol.ts';
import { createSessionAllocator } from '../../src/session-allocator.ts';
import { TEST_WEB_BASE_URL, testCrypto } from '../helpers/app-deps.ts';
import { START_TIME, bearer, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  insertAuthSession,
  insertPublishedSession,
  insertRegistration,
  insertRule,
  insertSession,
  setAutoEnroll,
} from '../helpers/factories.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import {
  createRecordingJobs,
  insertMember,
  readRegistration,
  readRegistrations,
} from '../helpers/registration-scene.ts';
import { createSessionsScene } from '../helpers/sessions-scene.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';
import { waitFor } from '../helpers/wait-for.ts';

let database: TestDatabase;
let producer: JobRunner;
let failAfterEnqueue = false;
const clock = createManualClock(START_TIME);
// The sweep worker is started by test (1) and reused by the O5 sweep test below.
let worker: JobRunner;
const workerLogs = captureLogs();

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
});
afterAll(async () => {
  await worker?.stop();
  await producer.stop();
  await database.close();
});
beforeEach(() => {
  clock.set(START_TIME);
  failAfterEnqueue = false;
});

const TEAM_NAME = 'Port Test Club';

async function sendEmailJobs(): Promise<
  { to: string; subject: string; text: string; idempotencyKey: string }[]
> {
  const { rows } = await database.pool.query<{
    to: string;
    subject: string;
    text: string;
    idempotencyKey: string;
  }>(
    `SELECT data->>'to' AS "to", data->>'subject' AS subject, data->>'text' AS text,
            data->>'idempotencyKey' AS "idempotencyKey"
       FROM pgboss.job WHERE name = 'send-email' ORDER BY created_on`,
  );
  return rows;
}

const emailOf = async (userId: string): Promise<string> =>
  (await database.pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId]))
    .rows[0]?.email as string;

// ---------------------------------------------------------------------------------------------
// (1) the sweep, on a real worker, with the real adapter
// ---------------------------------------------------------------------------------------------

describe('(1) a session pending under the no-op is enrolled by the recurrence sweep (the marker proof, real adapter)', () => {
  const notifier = createInMemoryNotifier();

  it('enrols once in selection order with AUTO_ENROL rows and AC-HAPPY-11 emails, stamps the marker, and a second sweep enrols nobody', async () => {
    const { sessionId, teamId } = await insertPublishedSession(database.pool, undefined, {
      now: START_TIME,
      maxPlayers: 2,
    });
    await database.pool.query(`UPDATE teams SET name = $2 WHERE id = $1`, [teamId, TEAM_NAME]);
    const order: string[] = [];
    for (const [index, assignedAt] of [
      '2026-10-01T00:00:00Z',
      '2026-10-02T00:00:00Z',
      '2026-10-03T00:00:00Z',
    ].entries()) {
      const userId = await insertMember(database.pool, teamId, {
        email: `auto-${index}@example.test`,
      });
      await setAutoEnroll(database.pool, {
        teamId,
        userId,
        enabled: true,
        assignedAt: new Date(assignedAt),
      });
      order.push(userId);
    }
    const marker = async (): Promise<Date | null> =>
      (
        await database.pool.query<{ auto_enrolled_at: Date | null }>(
          `SELECT auto_enrolled_at FROM game_sessions WHERE id = $1`,
          [sessionId],
        )
      ).rows[0]?.auto_enrolled_at ?? null;
    // Pending under the no-op, exactly as SSE left it.
    expect(await marker()).toBeNull();
    expect(await readRegistrations(database.pool, sessionId)).toEqual([]);

    worker = createJobRunner({
      databaseUrl: database.url,
      logger: workerLogs.logger,
      role: 'worker',
      pollingIntervalSeconds: 0.5,
    });
    await worker.start();
    await registerJobs({
      runner: worker,
      notifier,
      crypto: testCrypto(),
      db: createKysely(database.pool),
      clock,
      // The real composition function, with the worker runner: emails go on the sweep's own transaction.
      sessionAllocator: createSessionAllocator({
        db: createKysely(database.pool),
        jobs: worker,
        clock,
        webBaseUrl: TEST_WEB_BASE_URL,
      }),
      recurrenceHorizonDays: 28,
      webBaseUrl: TEST_WEB_BASE_URL,
    });
    await waitFor(
      async () =>
        (await worker.trigger(QUEUE_NAMES.recurrenceMaterialisation)) === null ? undefined : true,
      { timeoutMs: 10_000, label: 'a sweep to queue' },
    );
    await waitFor(async () => ((await marker()) !== null ? true : undefined), {
      timeoutMs: 30_000,
      label: 'the pending session to be stamped',
    });

    const rows = await readRegistrations(database.pool, sessionId);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.source === 'AUTO_ENROL')).toBe(true);
    // Placed in `selectAutoEnrollees` order: the first two take the 2 places, the third waits.
    expect(order.map((userId) => rows.find((row) => row.userId === userId)?.status)).toEqual([
      'CONFIRMED',
      'CONFIRMED',
      'WAITLISTED',
    ]);

    // AC-HAPPY-11: one email per placed member, committed with the placements.
    const mails = (await sendEmailJobs()).filter((mail) => mail.to.startsWith('auto-'));
    expect(mails.map((mail) => mail.to).sort()).toEqual([
      'auto-0@example.test',
      'auto-1@example.test',
      'auto-2@example.test',
    ]);
    const byTo = (to: string) => mails.find((mail) => mail.to === to);
    expect(byTo('auto-0@example.test')?.subject).toMatch(
      new RegExp(`^You've been added to ${TEAM_NAME}, \\w{3} \\d{1,2} \\w{3}$`),
    );
    expect(byTo('auto-2@example.test')?.subject).toMatch(
      new RegExp(`^You've been added to the waitlist for ${TEAM_NAME}, `),
    );
    expect(byTo('auto-0@example.test')?.text).toContain(
      "Your team admin turned on Auto Enroll for you. Withdraw on the session page if you can't play.",
    );
    expect(byTo('auto-0@example.test')?.text).not.toContain('deadline has passed');
    expect(byTo('auto-0@example.test')?.idempotencyKey).toMatch(
      new RegExp(`^auto-enrol:${rows.find((row) => row.userId === order[0])?.id}:`),
    );

    // A further sweep offers nothing: the marker makes it a no-op.
    const sweeps = workerLogs
      .lines()
      .filter((line) => line.event === 'session.recurrence.sweep_completed').length;
    await waitFor(
      async () =>
        (await worker.trigger(QUEUE_NAMES.recurrenceMaterialisation)) === null ? undefined : true,
      { timeoutMs: 10_000, label: 'a second sweep to queue' },
    );
    await waitFor(
      () =>
        workerLogs.lines().filter((line) => line.event === 'session.recurrence.sweep_completed')
          .length > sweeps
          ? true
          : undefined,
      { timeoutMs: 30_000, label: 'the second sweep' },
    );
    expect(await readRegistrations(database.pool, sessionId)).toHaveLength(3);
    expect((await sendEmailJobs()).filter((mail) => mail.to.startsWith('auto-'))).toHaveLength(3);
    const placed = workerLogs.lines().filter((line) => line.event === 'registration.created');
    expect(placed).toHaveLength(3);
    expect(placed.every((line) => line.source === 'AUTO_ENROL')).toBe(true);
    expect(JSON.stringify(workerLogs.lines())).not.toContain('auto-0@example.test');
  });
});

describe('O5: a session already inside its free-cancellation window enrols nobody and is still stamped', () => {
  async function pendingInsideWindow(prefix: string) {
    // Starts in 24 h, so the default deadline (start - 48 h) is already 24 h behind the clock.
    const { sessionId, teamId } = await insertPublishedSession(database.pool, undefined, {
      now: START_TIME,
      maxPlayers: 4,
      startsInHours: 24,
    });
    for (const [index, assignedAt] of ['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'].entries()) {
      const userId = await insertMember(database.pool, teamId, {
        email: `${prefix}-${index}@example.test`,
      });
      await setAutoEnroll(database.pool, {
        teamId,
        userId,
        enabled: true,
        assignedAt: new Date(assignedAt),
      });
    }
    return { sessionId, teamId };
  }
  const markerOf = async (sessionId: string): Promise<Date | null> =>
    (
      await database.pool.query<{ auto_enrolled_at: Date | null }>(
        `SELECT auto_enrolled_at FROM game_sessions WHERE id = $1`,
        [sessionId],
      )
    ).rows[0]?.auto_enrolled_at ?? null;

  it('runSessionAutoEnrol skips every member as deadline_passed, stamps the marker, and a second run is not due', async () => {
    const { sessionId, teamId } = await pendingInsideWindow('inside-direct');
    const logs = captureLogs();
    const deps = {
      db: createKysely(database.pool),
      clock,
      allocator: createSessionAllocator({
        db: createKysely(database.pool),
        jobs: producer,
        clock,
        webBaseUrl: TEST_WEB_BASE_URL,
      }),
      log: logs.logger,
    };
    expect(await runSessionAutoEnrol(deps, { teamId, sessionId })).toMatchObject({
      kind: 'done',
      candidates: 2,
      confirmed: 0,
      waitlisted: 0,
      skipped: 2,
    });
    expect(await markerOf(sessionId)).not.toBeNull();
    expect(await readRegistrations(database.pool, sessionId)).toEqual([]);
    expect((await sendEmailJobs()).filter((mail) => mail.to.startsWith('inside-direct'))).toEqual(
      [],
    );
    expect(await runSessionAutoEnrol(deps, { teamId, sessionId })).toMatchObject({
      kind: 'not_due',
    });
  });

  it('the recurrence sweep stamps such a session without enrolling anyone, and a second sweep changes nothing', async () => {
    const { sessionId } = await pendingInsideWindow('inside-sweep');
    expect(await markerOf(sessionId)).toBeNull();
    const sweeps = (): number =>
      workerLogs.lines().filter((line) => line.event === 'session.recurrence.sweep_completed')
        .length;
    for (let round = 0; round < 2; round += 1) {
      const before = sweeps();
      await waitFor(
        async () =>
          (await worker.trigger(QUEUE_NAMES.recurrenceMaterialisation)) === null ? undefined : true,
        { timeoutMs: 10_000, label: 'a sweep to queue' },
      );
      await waitFor(() => (sweeps() > before ? true : undefined), {
        timeoutMs: 30_000,
        label: 'the sweep',
      });
      if (round === 0)
        await waitFor(async () => ((await markerOf(sessionId)) !== null ? true : undefined), {
          timeoutMs: 30_000,
          label: 'the inside-window session to be stamped',
        });
    }
    expect(await readRegistrations(database.pool, sessionId)).toEqual([]);
    expect((await sendEmailJobs()).filter((mail) => mail.to.startsWith('inside-sweep'))).toEqual(
      [],
    );
  });
});

describe('O8: the pre-deploy backlog (auto_enrol_notify = false) is enrolled without auto-enrol emails', () => {
  async function pendingSession(prefix: string, notify: boolean) {
    const { sessionId, teamId } = await insertPublishedSession(database.pool, undefined, {
      now: START_TIME,
      maxPlayers: 1,
    });
    if (!notify) {
      await database.pool.query(
        `UPDATE game_sessions SET auto_enrol_notify = false WHERE id = $1`,
        [sessionId],
      );
    }
    for (const [index, assignedAt] of ['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'].entries()) {
      const userId = await insertMember(database.pool, teamId, {
        email: `${prefix}-${index}@example.test`,
      });
      await setAutoEnroll(database.pool, {
        teamId,
        userId,
        enabled: true,
        assignedAt: new Date(assignedAt),
      });
    }
    return { sessionId, teamId };
  }
  const depsWith = (log: ReturnType<typeof captureLogs>['logger']) => ({
    db: createKysely(database.pool),
    clock,
    allocator: createSessionAllocator({
      db: createKysely(database.pool),
      jobs: producer,
      clock,
      webBaseUrl: TEST_WEB_BASE_URL,
    }),
    log,
  });
  const versionOf = async (sessionId: string): Promise<number> =>
    (
      await database.pool.query<{ version: number }>(
        `SELECT version FROM game_sessions WHERE id = $1`,
        [sessionId],
      )
    ).rows[0]?.version as number;

  it('places the members as usual (AUTO_ENROL, CONFIRMED then WAITLISTED, marker stamped) and enqueues no send-email job', async () => {
    const { sessionId, teamId } = await pendingSession('silent', false);
    const logs = captureLogs();
    expect(await runSessionAutoEnrol(depsWith(logs.logger), { teamId, sessionId })).toMatchObject({
      kind: 'done',
      candidates: 2,
      confirmed: 1,
      waitlisted: 1,
      skipped: 0,
    });
    const rows = await readRegistrations(database.pool, sessionId);
    expect(rows.map((row) => [row.status, row.source]).sort()).toEqual([
      ['CONFIRMED', 'AUTO_ENROL'],
      ['WAITLISTED', 'AUTO_ENROL'],
    ]);
    expect(
      (
        await database.pool.query<{ auto_enrolled_at: Date | null }>(
          `SELECT auto_enrolled_at FROM game_sessions WHERE id = $1`,
          [sessionId],
        )
      ).rows[0]?.auto_enrolled_at,
    ).not.toBeNull();
    expect((await sendEmailJobs()).filter((mail) => mail.to.startsWith('silent-'))).toEqual([]);
    // The placements are still logged; the completed event says how many went out silently (counts only, no addresses).
    expect(logs.lines().filter((line) => line.event === 'registration.created')).toHaveLength(2);
    const completed = logs.lines().find((line) => line.event === 'session.auto_enrol.completed');
    expect(completed).toMatchObject({ sessionId, teamId, confirmed: 1, waitlisted: 1, silent: 2 });
    expect(JSON.stringify(logs.lines())).not.toContain('silent-0@example.test');
  });

  it('a default session (auto_enrol_notify = true) still emails every placed member, and the completed event has no silent count', async () => {
    const { sessionId, teamId } = await pendingSession('loud', true);
    const logs = captureLogs();
    const version = await versionOf(sessionId);
    await runSessionAutoEnrol(depsWith(logs.logger), { teamId, sessionId });
    expect(
      (await sendEmailJobs())
        .filter((mail) => mail.to.startsWith('loud-'))
        .map((mail) => mail.to)
        .sort(),
    ).toEqual(['loud-0@example.test', 'loud-1@example.test']);
    const completed = logs.lines().find((line) => line.event === 'session.auto_enrol.completed');
    expect(completed).toBeDefined();
    expect(completed).not.toHaveProperty('silent');
    // The D-80 stamp is bookkeeping, so the run leaves the session version alone.
    expect(await versionOf(sessionId)).toBe(version);
  });
});

// ---------------------------------------------------------------------------------------------
// (2) and (3): a capacity raise through SSE's edit transactions
// ---------------------------------------------------------------------------------------------

describe('a capacity raise promotes inside SSE edit transactions with the real adapter', () => {
  let h: AuthTestApp;
  const jobs = createRecordingJobs({
    enqueue: async (queue, data, options) => {
      const id = await producer.enqueue(queue, data, options);
      if (failAfterEnqueue) throw new Error('simulated failure after the job row was inserted');
      return id;
    },
  });

  beforeAll(async () => {
    const db = createKysely(database.pool);
    h = await buildAuthTestApp(database.pool, {
      db,
      jobs,
      sessionAllocator: createSessionAllocator({
        db,
        jobs,
        clock,
        webBaseUrl: TEST_WEB_BASE_URL,
      }),
    });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.clock.set(START_TIME);
    jobs.reset();
  });

  interface Scene {
    teamId: string;
    admin: string;
  }

  async function scene(payout: boolean): Promise<Scene> {
    const base = await createSessionsScene(database.pool, { payoutConfigured: payout });
    const { token } = await insertAuthSession(database.pool, base.adminId, {
      createdAt: h.clock.now(),
      idleDays: 90,
      absoluteDays: 180,
    });
    await database.pool.query(`UPDATE teams SET name = $2 WHERE id = $1`, [base.teamId, TEAM_NAME]);
    return { teamId: base.teamId, admin: token };
  }

  const send = (
    method: 'POST' | 'PUT',
    url: string,
    token: string,
    payload: object,
  ): Promise<LightMyRequestResponse> =>
    h.app.inject({
      method,
      url,
      headers: bearer(token),
      payload: payload as Record<string, unknown>,
    });

  /** A full session (`seats` confirmed solo parties) with `waiting` parties queued and one late withdrawal still owed. */
  async function fill(
    teamId: string,
    sessionId: string,
    seats: number,
    waiting: number,
  ): Promise<{ confirmed: string[]; waiting: string[]; owing: string }> {
    const confirmed: string[] = [];
    for (let i = 0; i < seats; i += 1) {
      const userId = await insertMember(database.pool, teamId);
      await insertRegistration(database.pool, { sessionId, teamId, userId, status: 'CONFIRMED' });
      confirmed.push(userId);
    }
    const queue: string[] = [];
    for (let i = 0; i < waiting; i += 1) {
      const userId = await insertMember(database.pool, teamId, {
        email: `queued-${sessionId.slice(0, 6)}-${i}@example.test`,
      });
      await insertRegistration(database.pool, {
        sessionId,
        teamId,
        userId,
        status: 'WAITLISTED',
        queuePosition: i + 1,
      });
      queue.push(userId);
    }
    const owing = await insertMember(database.pool, teamId);
    await insertRegistration(database.pool, {
      sessionId,
      teamId,
      userId: owing,
      status: 'WITHDRAWN',
      withdrawalFeeDue: true,
    });
    return { confirmed, waiting: queue, owing };
  }

  const statusOf = async (sessionId: string, userId: string) =>
    (await readRegistration(database.pool, sessionId, userId))?.status;

  const promotionMails = async (userIds: readonly string[]) => {
    const wanted = new Set(await Promise.all(userIds.map(emailOf)));
    return (await sendEmailJobs()).filter(
      (mail) => wanted.has(mail.to) && mail.idempotencyKey.startsWith('registration-promoted:'),
    );
  };

  function freeSessionBody(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      createKey: randomUUID(),
      date: '2026-11-04',
      location: 'Rosedale Badminton Centre',
      address: '12B John Glenn Avenue, Rosedale, Auckland 0632',
      maxPlayers: 4,
      reservedSeats: 0,
      courtCost: '0.00',
      extraExpenses: '0.00',
      pricingStructure: 'FLAT',
      courts: [{ identifier: 'Court 1', startTime: '19:00', endTime: '21:00' }],
      ...over,
    };
  }

  async function publishedViaApi(
    c: Scene,
  ): Promise<{ id: string; body: Record<string, unknown>; version: number }> {
    const body = freeSessionBody();
    const created = await send('POST', `/teams/${c.teamId}/sessions`, c.admin, body);
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<{ session: { id: string } }>().session.id;
    const published = await send('POST', `/teams/${c.teamId}/sessions/${id}/publish`, c.admin, {
      expectedVersion: 1,
    });
    expect(published.statusCode, published.body).toBe(200);
    return {
      id,
      body,
      version: published.json<{ session: { version: number } }>().session.version,
    };
  }

  const editOf = (body: Record<string, unknown>, expectedVersion: number, over: object) => {
    const rest = { ...body };
    delete rest.createKey;
    return { ...rest, expectedVersion, ...over };
  };

  const feeDueOf = async (sessionId: string, userId: string) =>
    (await readRegistration(database.pool, sessionId, userId))?.feeDue;

  it('(2) the session PUT promotes first-fit, releases the owed fee, enqueues the emails on that transaction, and reports promoted = the seats', async () => {
    const c = await scene(false);
    const s = await publishedViaApi(c);
    const people = await fill(c.teamId, s.id, 4, 3);
    const res = await send(
      'PUT',
      `/teams/${c.teamId}/sessions/${s.id}`,
      c.admin,
      editOf(s.body, s.version, { maxPlayers: 6 }),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ promoted: number }>().promoted).toBe(2);

    const rows = await readRegistrations(database.pool, s.id);
    const promoted = rows.filter((row) => row.promotedAt !== null);
    expect(promoted.map((row) => row.userId)).toEqual(people.waiting.slice(0, 2));
    expect(await statusOf(s.id, people.waiting[2] as string)).toBe('WAITLISTED');
    expect(await feeDueOf(s.id, people.owing)).toBe(false);

    const mails = await promotionMails(people.waiting);
    expect(mails).toHaveLength(2);
    for (const row of promoted) {
      expect(mails.map((mail) => mail.idempotencyKey)).toContain(
        `registration-promoted:${row.id}:${row.promotedAt?.getTime()}`,
      );
    }
    expect(
      jobs.recorded.filter((job) => job.queue === 'send-email').every((job) => job.inTransaction),
    ).toBe(true);
  });

  it('(2) a rolled-back edit leaves no promotion, no release and no email', async () => {
    const c = await scene(false);
    const s = await publishedViaApi(c);
    const people = await fill(c.teamId, s.id, 4, 3);
    failAfterEnqueue = true;
    const res = await send(
      'PUT',
      `/teams/${c.teamId}/sessions/${s.id}`,
      c.admin,
      editOf(s.body, s.version, { maxPlayers: 6 }),
    );
    failAfterEnqueue = false;
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    const { rows } = await database.pool.query<{ max_players: number }>(
      `SELECT max_players FROM game_sessions WHERE id = $1`,
      [s.id],
    );
    expect(rows[0]?.max_players).toBe(4);
    for (const userId of people.waiting) expect(await statusOf(s.id, userId)).toBe('WAITLISTED');
    expect(await feeDueOf(s.id, people.owing)).toBe(true);
    expect(await promotionMails(people.waiting)).toEqual([]);
  });

  it('(3) a series edit that raises capacity promotes the waitlist of the propagated instance, emails on that transaction, and a rolled-back edit leaves nothing', async () => {
    const c = await scene(true);
    const ruleId = await insertRule(database.pool, c.teamId);
    const instance = await insertSession(
      database.pool,
      c.teamId,
      {},
      { date: '2026-10-21', status: 'PUBLISHED', recurringRuleId: ruleId, maxPlayers: 2 },
    );
    const people = await fill(c.teamId, instance, 2, 3);
    const version = (
      await database.pool.query<{ version: number }>(
        `SELECT version FROM recurring_session_rules WHERE id = $1`,
        [ruleId],
      )
    ).rows[0]?.version as number;
    const seriesBody = {
      frequency: 'WEEKLY',
      dayOfWeek: 3,
      startsOn: '2026-10-07',
      monthlyWeek: null,
      recurUntil: null,
      location: 'New Hall',
      address: '12B John Glenn Avenue, Rosedale, Auckland 0632',
      maxPlayers: 24,
      reservedSeats: 0,
      courtCost: '240.00',
      extraExpenses: '0.00',
      pricingStructure: 'FLAT',
      courts: [{ identifier: 'Court 1', startTime: '19:00', endTime: '21:00' }],
      expectedVersion: version,
    };

    failAfterEnqueue = true;
    const rolledBack = await send(
      'PUT',
      `/teams/${c.teamId}/session-series/${ruleId}`,
      c.admin,
      seriesBody,
    );
    failAfterEnqueue = false;
    expect(rolledBack.statusCode).toBeGreaterThanOrEqual(500);
    for (const userId of people.waiting)
      expect(await statusOf(instance, userId)).toBe('WAITLISTED');
    expect(await feeDueOf(instance, people.owing)).toBe(true);
    expect(await promotionMails(people.waiting)).toEqual([]);

    const res = await send(
      'PUT',
      `/teams/${c.teamId}/session-series/${ruleId}`,
      c.admin,
      seriesBody,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ outcome: { updated: number } }>().outcome.updated).toBeGreaterThanOrEqual(1);
    for (const userId of people.waiting) expect(await statusOf(instance, userId)).toBe('CONFIRMED');
    expect(await feeDueOf(instance, people.owing)).toBe(false);
    expect(await promotionMails(people.waiting)).toHaveLength(3);
  });
});
