/**
 * AC-INTEGRATION-1 (a)-(d) and AC-ERROR-3 over real HTTP through `buildAuthTestApp` on a real PostgreSQL 17 (the Phase 2 file
 * `registrations-races.int.test.ts` proves the same scenarios one layer down, through `runAllocatorTransaction`).
 *
 * Nothing sleeps. A test holds the session row lock on a real connection, fires the requests, asks `pg_stat_activity` until
 * Postgres itself reports every contender blocked (`waitForLockWaiters`), and only then releases. After each test no lock
 * retry was logged, no 5xx and no SQLSTATE 23505 reached a client or a log line, and every recorded transaction respected the
 * canonical lock order. The pool is larger than the number of parallel requests (learned rule: testing-integration-db-isolation).
 */
import type { LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createManualClock } from '../../src/lib/clock.ts';
import { createAllocator } from '../../src/modules/registrations/allocator.ts';
import { HTTP_POLICY, runAllocatorTransaction } from '../../src/modules/registrations/tx.ts';
import { START_TIME, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import { insertGuest, insertPublishedSession, insertRegistration } from '../helpers/factories.ts';
import { waitForLockWaiters } from '../helpers/lock-waiters.ts';
import {
  errorOf,
  httpMember,
  registeredOf,
  registerAs,
  withdrawAs,
  withdrawnOf,
  type HttpMember,
} from '../helpers/registrations-http.ts';
import {
  createRecordingJobs,
  readRegistration,
  readRegistrations,
  sqlSeats,
} from '../helpers/registration-scene.ts';
import {
  createGatedDatabase,
  lockOrderViolations,
  type GatedDatabase,
} from '../helpers/statement-gate.ts';
import { createTestDatabase, inTransaction, type TestDatabase } from '../helpers/test-db.ts';

let database: TestDatabase;
let gate: GatedDatabase;
let h: AuthTestApp;
const jobs = createRecordingJobs();
let statementMark = 0;
let logMark = 0;

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 60 });
  gate = createGatedDatabase(database.pool);
  h = await buildAuthTestApp(database.pool, { db: gate.db, jobs });
});
afterAll(async () => {
  await h.close();
  await database.close();
});
beforeEach(() => {
  h.clock.set(START_TIME);
  jobs.reset();
  statementMark = gate.statements.length;
  logMark = h.logs.lines().length;
});
afterEach(() => {
  const lines = h.logs.lines().slice(logMark);
  expect(
    lines.filter(
      (line) => typeof line.event === 'string' && line.event.startsWith('registration.lock_retry'),
    ),
  ).toEqual([]);
  expect(lines.filter((line) => line.sqlState === '40P01' || line.sqlState === '23505')).toEqual(
    [],
  );
  expect(lines.filter((line) => line.level === 'error' || line.level === 'fatal')).toEqual([]);
  expect(lockOrderViolations(gate.statements.slice(statementMark))).toEqual([]);
});

interface Scene {
  teamId: string;
  sessionId: string;
  deadline: Date;
}

async function scene(maxPlayers: number): Promise<Scene> {
  const { sessionId, teamId } = await insertPublishedSession(database.pool, undefined, {
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
  userId: string,
  size: number,
  options: { status: 'CONFIRMED' | 'WAITLISTED'; queuePosition?: number },
): Promise<void> {
  await inTransaction(database.pool, async (client) => {
    const id = await insertRegistration(client, {
      sessionId: s.sessionId,
      teamId: s.teamId,
      userId,
      status: options.status,
      queuePosition: options.queuePosition,
      guestCount: size - 1,
    });
    for (let position = 1; position < size; position += 1) await insertGuest(client, id, position);
  });
}

/** Starts the contenders while the test holds the session row, waits until Postgres reports them all blocked, then releases. */
async function raceUnderSessionLock<T>(
  sessionId: string,
  contenders: readonly (() => Promise<T>)[],
): Promise<T[]> {
  const client: pg.PoolClient = await database.pool.connect();
  let open = true;
  const release = async (): Promise<void> => {
    if (!open) return;
    open = false;
    try {
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  };
  await client.query('BEGIN');
  try {
    await client.query('SELECT id FROM game_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
    const pending = contenders.map((start) => start());
    await waitForLockWaiters(
      database.pool,
      contenders.length,
      'requests blocked on the session row',
    );
    await release();
    return await Promise.all(pending);
  } finally {
    await release();
  }
}

const statuses = (responses: readonly LightMyRequestResponse[]): number[] =>
  responses.map((res) => res.statusCode);

describe('seat allocation under real concurrency over HTTP (AC-INTEGRATION-1)', () => {
  it('(a) 20 members register at once for 10 places: exactly 10 CONFIRMED and 10 WAITLISTED at ranks 1..10, no 5xx and no 23505', async () => {
    const s = await scene(10);
    const members: HttpMember[] = [];
    for (let i = 0; i < 20; i += 1) members.push(await httpMember(h, s.teamId));
    const responses = await raceUnderSessionLock(
      s.sessionId,
      members.map((who) => () => registerAs(h, who, s.teamId, s.sessionId)),
    );
    expect(statuses(responses)).toEqual(Array.from({ length: 20 }, () => 201));
    const rows = await readRegistrations(database.pool, s.sessionId);
    expect(rows.filter((row) => row.status === 'CONFIRMED')).toHaveLength(10);
    const waiting = rows.filter((row) => row.status === 'WAITLISTED');
    expect(waiting.map((row) => row.queuePosition).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    // What each client was told matches what was stored: 10 confirmed, and the ranks of the waiting are exactly 1..10.
    const told = responses.map((res) => registeredOf(res));
    expect(told.filter((one) => one.status === 'CONFIRMED')).toHaveLength(10);
    expect(
      told
        .filter((one) => one.status === 'WAITLISTED')
        .map((one) => one.waitlistRank)
        .sort((a, b) => (a ?? 0) - (b ?? 0)),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await sqlSeats(database.pool, s.sessionId)).toMatchObject({
      seatsTaken: 10,
      capacity: 10,
    });
    expect(jobs.emails()).toEqual([]);
  });

  it('(b) 10 withdrawals race 5 newcomers on a full session with a waitlist: the waitlist is served first, in order, and the invariant holds', async () => {
    const s = await scene(10);
    const confirmed: HttpMember[] = [];
    for (let i = 0; i < 10; i += 1) {
      const who = await httpMember(h, s.teamId);
      confirmed.push(who);
      await seed(s, who.userId, 1, { status: 'CONFIRMED' });
    }
    const waiting: HttpMember[] = [];
    for (let i = 0; i < 6; i += 1) {
      const who = await httpMember(h, s.teamId, { email: `waiting-${i}@example.test` });
      waiting.push(who);
      await seed(s, who.userId, 1, { status: 'WAITLISTED', queuePosition: i + 1 });
    }
    const newcomers: HttpMember[] = [];
    for (let i = 0; i < 5; i += 1) newcomers.push(await httpMember(h, s.teamId));

    const responses = await raceUnderSessionLock(s.sessionId, [
      ...confirmed.map((who) => () => withdrawAs(h, who, s.teamId, s.sessionId)),
      ...newcomers.map((who) => () => registerAs(h, who, s.teamId, s.sessionId)),
    ]);
    expect(statuses(responses.slice(0, 10))).toEqual(Array.from({ length: 10 }, () => 200));
    expect(statuses(responses.slice(10))).toEqual(Array.from({ length: 5 }, () => 201));

    const rows = await readRegistrations(database.pool, s.sessionId);
    for (const who of waiting) {
      expect(rows.find((row) => row.userId === who.userId)?.status, who.userId).toBe('CONFIRMED');
    }
    // 10 seats, 11 parties queued at some point: the last newcomer waits, and nobody else does.
    const seats = await sqlSeats(database.pool, s.sessionId);
    expect(seats.seatsTaken).toBe(10);
    const waitlisted = rows.filter((row) => row.status === 'WAITLISTED');
    expect(waitlisted).toHaveLength(1);
    expect(newcomers.map((who) => who.userId)).toContain(waitlisted[0]?.userId);
    expect(new Set(seats.waitlistPositions).size).toBe(seats.waitlistPositions.length);
    // FIFO: the six original waiters were promoted (and emailed) in queue order, whatever the newcomers did.
    const promotedOrder = jobs
      .emails()
      .map((mail) => mail.to)
      .filter((to) => to.startsWith('waiting-'));
    expect(promotedOrder).toEqual(waiting.map((_, i) => `waiting-${i}@example.test`));
  });

  it('(c) two withdrawals each free one seat while a party of 2 waits: it is promoted exactly once, by the second, and neither withdrawer owes', async () => {
    const s = await scene(2);
    const a = await httpMember(h, s.teamId);
    const b = await httpMember(h, s.teamId);
    const party = await httpMember(h, s.teamId, { email: 'party-of-two@example.test' });
    await seed(s, a.userId, 1, { status: 'CONFIRMED' });
    await seed(s, b.userId, 1, { status: 'CONFIRMED' });
    await seed(s, party.userId, 2, { status: 'WAITLISTED', queuePosition: 1 });
    h.clock.set(new Date(s.deadline.getTime() + 1));
    const responses = await raceUnderSessionLock(s.sessionId, [
      () => withdrawAs(h, a, s.teamId, s.sessionId, { expectLate: true }),
      () => withdrawAs(h, b, s.teamId, s.sessionId, { expectLate: true }),
    ]);
    expect(statuses(responses)).toEqual([200, 200]);
    expect(responses.map((res) => withdrawnOf(res).replacedBy).sort()).toEqual([
      'nobody',
      'waitlist',
    ]);
    expect(await readRegistration(database.pool, s.sessionId, party.userId)).toMatchObject({
      status: 'CONFIRMED',
      guestCount: 1,
    });
    for (const who of [a, b]) {
      expect(await readRegistration(database.pool, s.sessionId, who.userId)).toMatchObject({
        status: 'WITHDRAWN',
        withdrawalKind: 'LATE',
        feeDue: false,
      });
    }
    expect(jobs.emails().filter((mail) => mail.to === 'party-of-two@example.test')).toHaveLength(1);
  });

  it('(d) a player withdrawal races the ban withdrawal of the same registration: it is withdrawn exactly once and the waitlist promoted once', async () => {
    const s = await scene(1);
    const x = await httpMember(h, s.teamId);
    const next = await httpMember(h, s.teamId, { email: 'only-once@example.test' });
    await seed(s, x.userId, 1, { status: 'CONFIRMED' });
    await seed(s, next.userId, 1, { status: 'WAITLISTED', queuePosition: 1 });
    // Phase 4's ban handler does not exist yet: the ban path is the allocator's `withdrawFromSession` with cause 'ban', run
    // through the same transaction entry point the handler will use.
    const allocator = createAllocator({ jobs, webBaseUrl: 'https://games.example.nz' });
    const clock = createManualClock(START_TIME);
    const ban = (): Promise<{ ok: boolean }> =>
      runAllocatorTransaction(
        gate.db,
        HTTP_POLICY,
        { clock, teamId: s.teamId, path: 'ban', log: h.logs.logger },
        ({ trx, now }) =>
          allocator.withdrawFromSession(
            { trx, now, log: h.logs.logger },
            { teamId: s.teamId, sessionId: s.sessionId, userId: x.userId, cause: 'ban' },
          ),
      );
    const [player, banned] = await raceUnderSessionLock<LightMyRequestResponse | { ok: boolean }>(
      s.sessionId,
      [() => withdrawAs(h, x, s.teamId, s.sessionId), ban],
    );
    const playerResponse = player as LightMyRequestResponse;
    const banResult = banned as { ok: boolean };
    // Exactly one of the two withdrew the row; the other found it already withdrawn.
    expect([playerResponse.statusCode === 200, banResult.ok].filter(Boolean)).toHaveLength(1);
    if (playerResponse.statusCode !== 200) {
      expect(playerResponse.statusCode).toBe(409);
      expect(errorOf(playerResponse).code).toBe('not_registered');
    }
    const row = await readRegistration(database.pool, s.sessionId, x.userId);
    expect(row?.status).toBe('WITHDRAWN');
    expect(['EARLY', 'BANNED']).toContain(row?.withdrawalKind);
    expect(row?.feeDue).toBe(false);
    expect(await readRegistration(database.pool, s.sessionId, next.userId)).toMatchObject({
      status: 'CONFIRMED',
    });
    expect(jobs.emails().filter((mail) => mail.to === 'only-once@example.test')).toHaveLength(1);
  });

  it('AC-ERROR-3: two concurrent first-time submits from one member make exactly one registration (201) and one 409, no 23505 to the client', async () => {
    const s = await scene(1);
    await seed(s, (await httpMember(h, s.teamId)).userId, 1, { status: 'CONFIRMED' });
    const twice = await httpMember(h, s.teamId);
    const responses = await raceUnderSessionLock(s.sessionId, [
      () => registerAs(h, twice, s.teamId, s.sessionId),
      () => registerAs(h, twice, s.teamId, s.sessionId),
    ]);
    expect(statuses(responses).sort()).toEqual([201, 409]);
    const refused = responses.find((res) => res.statusCode === 409);
    expect(refused === undefined ? undefined : errorOf(refused).code).toBe('already_registered');
    const mine = (await readRegistrations(database.pool, s.sessionId)).filter(
      (row) => row.userId === twice.userId,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.queuePosition).toBe(1);
  });
});
