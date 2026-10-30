/**
 * Real-concurrency proofs for the allocator (AC-INTEGRATION-1 a-d, AC-ERROR-3, AC-ERROR-7, AC-VERIFY-3, R4, R16) on a real
 * PostgreSQL 17 with real connections. Nothing sleeps: a test holds a real lock (the session row, or a member row), starts the
 * contenders, asks `pg_stat_activity` until Postgres itself reports them blocked (`waitForLockWaiters`), and only then
 * releases the lock. After each test no lock retry was logged, no SQLSTATE 40P01 appeared, and every recorded transaction
 * respected the canonical lock order.
 *
 * AC-INTEGRATION-1 asks for these runs through real HTTP; the routes arrive in Phase 3, where the same scenarios are repeated
 * through `buildAuthTestApp`. Here the allocator is driven through `runAllocatorTransaction`, the entry point the routes use.
 */
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createJobRunner, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import { QUEUES } from '../../src/jobs/registry.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import { createAllocator, type GuestInput } from '../../src/modules/registrations/allocator.ts';
import {
  runAllocatorTransaction,
  type AllocatorTxPolicy,
} from '../../src/modules/registrations/tx.ts';
import {
  insertGuest,
  insertPublishedSession,
  insertRegistration,
  setAutoEnroll,
} from '../helpers/factories.ts';
import { waitForLockWaiters } from '../helpers/lock-waiters.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import {
  createRecordingJobs,
  insertMember,
  readRegistration,
  readRegistrations,
  sqlSeats,
} from '../helpers/registration-scene.ts';
import {
  createGatedDatabase,
  lockOrderViolations,
  type GatedDatabase,
} from '../helpers/statement-gate.ts';
import {
  createTestDatabase,
  expectPgError,
  inTransaction,
  type TestDatabase,
} from '../helpers/test-db.ts';

const BASE = new Date('2026-10-20T00:00:00.000Z');
/** A generous timeout so a loaded CI machine cannot turn a legitimate wait into a retry: this suite proves ordering, not speed. */
const PATIENT: AllocatorTxPolicy = { lockTimeoutMs: 20_000, attempts: 3, backoffMs: [25, 75] };

let database: TestDatabase;
let gate: GatedDatabase;
let worker: JobRunner;
let producer: JobRunner;
const logs = captureLogs();
const clock = createManualClock(BASE);
let jobs: ReturnType<typeof createRecordingJobs>;
let allocator: ReturnType<typeof createAllocator>;
let logMark = 0;
let statementMark = 0;

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 40 });
  gate = createGatedDatabase(database.pool);
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
  jobs = createRecordingJobs(producer);
  allocator = createAllocator({ jobs, webBaseUrl: 'https://games.example.nz' });
});
afterAll(async () => {
  await producer.stop();
  await worker.stop();
  await database.close();
});
beforeEach(() => {
  clock.set(BASE);
  jobs.reset();
  logMark = logs.lines().length;
  statementMark = gate.statements.length;
});
afterEach(() => {
  const lines = logs.lines().slice(logMark);
  // A retried transaction would hide a deadlock or a lock timeout, so neither the retry nor the SQLSTATE may appear.
  expect(
    lines.filter(
      (line) =>
        line.event === 'registration.lock_retry' ||
        line.event === 'registration.lock_retry_exhausted',
    ),
  ).toEqual([]);
  expect(lines.filter((line) => line.sqlState === '40P01')).toEqual([]);
  expect(lockOrderViolations(gate.statements.slice(statementMark))).toEqual([]);
});

interface Scene {
  teamId: string;
  sessionId: string;
  startsAt: Date;
  deadline: Date;
}

async function scene(maxPlayers: number): Promise<Scene> {
  const { sessionId, teamId } = await insertPublishedSession(database.pool, undefined, {
    now: BASE,
    maxPlayers,
  });
  const { rows } = await database.pool.query<{ starts_at: Date; cancellation_deadline: Date }>(
    `SELECT starts_at, cancellation_deadline FROM game_sessions WHERE id = $1`,
    [sessionId],
  );
  return {
    teamId,
    sessionId,
    startsAt: rows[0]?.starts_at as Date,
    deadline: rows[0]?.cancellation_deadline as Date,
  };
}

const op = <T>(
  s: Scene,
  path: string,
  work: Parameters<typeof runAllocatorTransaction<T>>[3],
): Promise<T> =>
  runAllocatorTransaction(
    gate.db,
    PATIENT,
    { clock, teamId: s.teamId, path, log: logs.logger },
    work,
  );

const register = (s: Scene, userId: string, guests: readonly GuestInput[] = []) =>
  op(s, 'register', ({ trx, now }) =>
    allocator.registerInSession(
      { trx, now, log: logs.logger },
      { teamId: s.teamId, sessionId: s.sessionId, userId, guests },
    ),
  );

const withdraw = (s: Scene, userId: string, cause: 'player' | 'ban' = 'player') =>
  op(s, 'withdraw', ({ trx, now }) =>
    allocator.withdrawFromSession(
      { trx, now, log: logs.logger },
      { teamId: s.teamId, sessionId: s.sessionId, userId, cause },
    ),
  );

const autoEnrol = (s: Scene, entries: { userId: string; assignedAt: Date }[]) =>
  op(s, 'auto_enrol', ({ trx, now }) =>
    allocator.autoEnrolInSession(
      { trx, now, log: logs.logger },
      { teamId: s.teamId, sessionId: s.sessionId, entries, notify: true },
    ),
  );

async function holdLock(pool: pg.Pool, sql: string, values: unknown[]) {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query(sql, values);
  let released = false;
  return {
    query: (text: string, params?: unknown[]) => client.query(text, params),
    async release(): Promise<void> {
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

/** Starts `contenders` while the session row is locked by the test, waits until Postgres reports them all blocked, then releases. */
async function raceUnderSessionLock<T>(
  sessionId: string,
  contenders: readonly (() => Promise<T>)[],
): Promise<T[]> {
  const held = await holdLock(
    database.pool,
    'SELECT id FROM game_sessions WHERE id = $1 FOR UPDATE',
    [sessionId],
  );
  try {
    const pending = contenders.map((start) => start());
    await waitForLockWaiters(
      database.pool,
      contenders.length,
      'contenders blocked on the session row',
    );
    await held.release();
    return await Promise.all(pending);
  } finally {
    await held.release();
  }
}

async function seed(
  s: Scene,
  userId: string,
  size: number,
  options: { status: 'CONFIRMED' | 'WAITLISTED'; queuePosition?: number },
): Promise<string> {
  return inTransaction(database.pool, async (client) => {
    const id = await insertRegistration(client, {
      sessionId: s.sessionId,
      teamId: s.teamId,
      userId,
      status: options.status,
      queuePosition: options.queuePosition,
      guestCount: size - 1,
    });
    for (let position = 1; position < size; position += 1) await insertGuest(client, id, position);
    return id;
  });
}

// ---------------------------------------------------------------------------------------------
// AC-INTEGRATION-1
// ---------------------------------------------------------------------------------------------

describe('seat allocation under real concurrency (AC-INTEGRATION-1)', () => {
  it('(a) 20 members register at once for 10 places: exactly 10 CONFIRMED and 10 WAITLISTED at positions 1..10, no 23505 anywhere', async () => {
    const s = await scene(10);
    const members: string[] = [];
    for (let i = 0; i < 20; i += 1) members.push(await insertMember(database.pool, s.teamId));
    const outcomes = await raceUnderSessionLock(
      s.sessionId,
      members.map((userId) => () => register(s, userId)),
    );
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    const rows = await readRegistrations(database.pool, s.sessionId);
    expect(rows.filter((row) => row.status === 'CONFIRMED')).toHaveLength(10);
    const waiting = rows.filter((row) => row.status === 'WAITLISTED');
    expect(waiting.map((row) => row.queuePosition).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    const seats = await sqlSeats(database.pool, s.sessionId);
    expect(seats).toMatchObject({ seatsTaken: 10, capacity: 10 });
  });

  it('(b) 10 withdrawals race 5 newcomers on a full session with a waitlist: the waitlist is served first, then the invariant holds', async () => {
    const s = await scene(10);
    const confirmed: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const userId = await insertMember(database.pool, s.teamId);
      confirmed.push(userId);
      await seed(s, userId, 1, { status: 'CONFIRMED' });
    }
    const waiting: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const userId = await insertMember(database.pool, s.teamId);
      waiting.push(userId);
      await seed(s, userId, 1, { status: 'WAITLISTED', queuePosition: i + 1 });
    }
    const newcomers: string[] = [];
    for (let i = 0; i < 5; i += 1) newcomers.push(await insertMember(database.pool, s.teamId));
    const contenders = [
      ...confirmed.map((userId) => () => withdraw(s, userId)),
      ...newcomers.map((userId) => () => register(s, userId)),
    ];
    const outcomes = await raceUnderSessionLock<{ ok: boolean }>(s.sessionId, contenders);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    const rows = await readRegistrations(database.pool, s.sessionId);
    // Every original waitlisted party was promoted before any newcomer could take a seat.
    for (const userId of waiting)
      expect(rows.find((row) => row.userId === userId)?.status).toBe('CONFIRMED');
    const seats = await sqlSeats(database.pool, s.sessionId);
    expect(seats.seatsTaken).toBe(10);
    const waitlisted = rows.filter((row) => row.status === 'WAITLISTED');
    expect(waitlisted).toHaveLength(1);
    expect(newcomers).toContain(waitlisted[0]?.userId);
    expect(new Set(seats.waitlistPositions).size).toBe(seats.waitlistPositions.length);
    // One promotion email per promoted registration, none for a newcomer's own registration.
    const promotedRows = rows.filter((row) => row.promotedAt !== null);
    expect(jobs.emails()).toHaveLength(promotedRows.length);
    expect(new Set(jobs.emails().map((mail) => mail.idempotencyKey)).size).toBe(
      promotedRows.length,
    );
  });

  it('(c) two late withdrawals each free one seat while a party of 2 waits: it is promoted exactly once, by the second, and neither withdrawer owes', async () => {
    const s = await scene(2);
    const a = await insertMember(database.pool, s.teamId);
    const b = await insertMember(database.pool, s.teamId);
    const w = await insertMember(database.pool, s.teamId, { email: 'party-of-two@example.test' });
    await seed(s, a, 1, { status: 'CONFIRMED' });
    await seed(s, b, 1, { status: 'CONFIRMED' });
    await seed(s, w, 2, { status: 'WAITLISTED', queuePosition: 1 });
    clock.set(new Date(s.deadline.getTime() + 1));
    const outcomes = await raceUnderSessionLock(s.sessionId, [
      () => withdraw(s, a),
      () => withdraw(s, b),
    ]);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    const promotions = outcomes.flatMap((outcome) => (outcome.ok ? outcome.promoted : []));
    expect(promotions.map((one) => one.userId)).toEqual([w]);
    expect(await readRegistration(database.pool, s.sessionId, w)).toMatchObject({
      status: 'CONFIRMED',
      guestCount: 1,
    });
    for (const userId of [a, b])
      expect(await readRegistration(database.pool, s.sessionId, userId)).toMatchObject({
        status: 'WITHDRAWN',
        withdrawalKind: 'LATE',
        feeDue: false,
      });
    expect(jobs.emails().filter((mail) => mail.to === 'party-of-two@example.test')).toHaveLength(1);
  });

  it('(d) a player withdrawal races the ban withdrawal of the same registration: it is withdrawn exactly once and the waitlist promoted once', async () => {
    const s = await scene(1);
    const x = await insertMember(database.pool, s.teamId);
    const next = await insertMember(database.pool, s.teamId, { email: 'only-once@example.test' });
    await seed(s, x, 1, { status: 'CONFIRMED' });
    await seed(s, next, 1, { status: 'WAITLISTED', queuePosition: 1 });
    const [player, ban] = await raceUnderSessionLock(s.sessionId, [
      () => withdraw(s, x, 'player'),
      () => withdraw(s, x, 'ban'),
    ]);
    const results = [player, ban];
    expect(results.filter((result) => result?.ok)).toHaveLength(1);
    expect(results.filter((result) => result !== undefined && !result.ok)).toEqual([
      { ok: false, reason: 'not_registered' },
    ]);
    expect(await readRegistration(database.pool, s.sessionId, next)).toMatchObject({
      status: 'CONFIRMED',
    });
    expect((await readRegistration(database.pool, s.sessionId, x))?.status).toBe('WITHDRAWN');
    expect(jobs.emails().filter((mail) => mail.to === 'only-once@example.test')).toHaveLength(1);
  });

  it('AC-ERROR-3: two concurrent first-time submits from one member make exactly one registration and one queue position', async () => {
    const s = await scene(1);
    await seed(s, await insertMember(database.pool, s.teamId), 1, { status: 'CONFIRMED' });
    const twice = await insertMember(database.pool, s.teamId);
    const results = await raceUnderSessionLock(s.sessionId, [
      () => register(s, twice),
      () => register(s, twice),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: 'already_registered' },
    ]);
    const rows = (await readRegistrations(database.pool, s.sessionId)).filter(
      (row) => row.userId === twice,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.queuePosition).toBe(1);
  });
});

describe('the lock timeout and retry policy against a real lock (architecture Q2, L1)', () => {
  it('retries the whole transaction after a real 55P03, with the SAME clock reading, and then commits', async () => {
    const s = await scene(5);
    const userId = await insertMember(database.pool, s.teamId);
    const quiet = captureLogs();
    const held = await holdLock(
      database.pool,
      'SELECT id FROM game_sessions WHERE id = $1 FOR UPDATE',
      [s.sessionId],
    );
    let sleeps = 0;
    const first = clock.now();
    try {
      const outcome = await runAllocatorTransaction(
        gate.db,
        { lockTimeoutMs: 300, attempts: 3, backoffMs: [10] },
        {
          clock,
          teamId: s.teamId,
          path: 'register',
          log: quiet.logger,
          // The first attempt timed out on the held lock; free it, and let time pass: the retry must not re-read the clock.
          sleep: async () => {
            sleeps += 1;
            clock.advance(60_000);
            await held.release();
          },
        },
        ({ trx, now }) =>
          allocator.registerInSession(
            { trx, now, log: logs.logger },
            { teamId: s.teamId, sessionId: s.sessionId, userId, guests: [] },
          ),
      );
      expect(outcome).toMatchObject({ ok: true, status: 'CONFIRMED' });
    } finally {
      await held.release();
    }
    expect(sleeps).toBe(1);
    expect((await readRegistration(database.pool, s.sessionId, userId))?.registeredAt).toEqual(
      first,
    );
    const retries = quiet.lines().filter((line) => line.event === 'registration.lock_retry');
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      teamId: s.teamId,
      path: 'register',
      attempt: 1,
      sqlState: '55P03',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// R4: the capacity backstop locks the session NOWAIT, so a bypass cannot join a wait cycle
// ---------------------------------------------------------------------------------------------

describe('the capacity backstop and writers that skip the allocator (R4)', () => {
  const SESSION_LOCK = /from "game_sessions".* for update$/;

  /** An out-of-allocator promotion of `waitingId`: it updates the row, then COMMIT fires the deferred capacity trigger. */
  async function bypassPromotion(waitingId: string): Promise<void> {
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE registrations SET status = 'CONFIRMED', queue_position = NULL, promoted_at = now(),
                registrant_sex = 'MALE', registrant_skill_level = 'BEGINNER' WHERE id = $1`,
        [waitingId],
      );
      await expectPgError(client.query('COMMIT'), '55P03');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  async function against(
    label: string,
    start: (s: Scene, fresh: GatedDatabase) => Promise<unknown>,
  ): Promise<void> {
    const s = await scene(30);
    const waitingUser = await insertMember(database.pool, s.teamId);
    const waitingId = await seed(s, waitingUser, 1, { status: 'WAITLISTED', queuePosition: 1 });
    const fresh = createGatedDatabase(database.pool);
    const hold = fresh.arm(SESSION_LOCK);
    const running = start(s, fresh);
    await hold.reached;
    // The allocator now holds the session row. The bypass writer is refused at COMMIT instead of queueing behind it.
    await bypassPromotion(waitingId);
    hold.release();
    await running;
    // The allocator committed (its own assertions run inside `start`); nothing it did was undone by the refused bypass.
    expect((await readRegistrations(database.pool, s.sessionId)).length, label).toBeGreaterThan(0);
  }

  const viaFresh = <T>(
    s: Scene,
    fresh: GatedDatabase,
    path: string,
    work: Parameters<typeof runAllocatorTransaction<T>>[3],
  ): Promise<T> =>
    runAllocatorTransaction(
      fresh.db,
      PATIENT,
      { clock, teamId: s.teamId, path, log: logs.logger },
      work,
    );

  it('refuses the bypass with 55P03 while register holds the session, and register commits', async () => {
    await against('register', async (s, fresh) => {
      const userId = await insertMember(database.pool, s.teamId);
      const outcome = await viaFresh(s, fresh, 'register', ({ trx, now }) =>
        allocator.registerInSession(
          { trx, now, log: logs.logger },
          { teamId: s.teamId, sessionId: s.sessionId, userId, guests: [] },
        ),
      );
      expect(outcome).toMatchObject({ ok: true });
    });
  });

  it('refuses the bypass while withdraw holds the session, and withdraw commits', async () => {
    await against('withdraw', async (s, fresh) => {
      const userId = await insertMember(database.pool, s.teamId);
      await seed(s, userId, 1, { status: 'CONFIRMED' });
      const outcome = await viaFresh(s, fresh, 'withdraw', ({ trx, now }) =>
        allocator.withdrawFromSession(
          { trx, now, log: logs.logger },
          { teamId: s.teamId, sessionId: s.sessionId, userId, cause: 'player' },
        ),
      );
      expect(outcome).toMatchObject({ ok: true });
    });
  });

  it('refuses the bypass while promoteWaitlist holds the session, and it commits', async () => {
    await against('promote', async (s, fresh) => {
      await viaFresh(s, fresh, 'promote', ({ trx, now }) =>
        allocator.promoteWaitlist(
          { trx, now, log: logs.logger },
          { teamId: s.teamId, sessionId: s.sessionId },
        ),
      );
    });
  });

  it('refuses the bypass while auto-enrol holds the session, and it commits', async () => {
    await against('auto-enrol', async (s, fresh) => {
      const userId = await insertMember(database.pool, s.teamId);
      const assignedAt = new Date(BASE.getTime() - 1000);
      await setAutoEnroll(database.pool, { teamId: s.teamId, userId, enabled: true, assignedAt });
      const results = await viaFresh(s, fresh, 'auto_enrol', ({ trx, now }) =>
        allocator.autoEnrolInSession(
          { trx, now, log: logs.logger },
          {
            teamId: s.teamId,
            sessionId: s.sessionId,
            entries: [{ userId, assignedAt }],
            notify: true,
          },
        ),
      );
      expect(results[0]?.outcome).toEqual({ ok: true, status: 'CONFIRMED' });
    });
  });
});

// ---------------------------------------------------------------------------------------------
// AC-INTEGRATION-5 race, AC-ERROR-7: the member gate under a held member row
// ---------------------------------------------------------------------------------------------

describe('the member gate under a concurrent write (R16, AC-ERROR-7)', () => {
  it('R16: an admin save in flight turns Auto Enroll off and commits first, so the member is skipped, then a save that changes nothing leaves them placed', async () => {
    const s = await scene(10);
    const assignedAt = new Date(BASE.getTime() - 5_000);
    const off = await insertMember(database.pool, s.teamId);
    const keep = await insertMember(database.pool, s.teamId);
    for (const userId of [off, keep])
      await setAutoEnroll(database.pool, { teamId: s.teamId, userId, enabled: true, assignedAt });

    // The admin's save holds the member row FOR NO KEY UPDATE; the allocator must wait at the gate, then re-check.
    const held = await holdLock(
      database.pool,
      'SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2 FOR NO KEY UPDATE',
      [s.teamId, off],
    );
    const pending = autoEnrol(s, [
      { userId: off, assignedAt },
      { userId: keep, assignedAt },
    ]);
    await waitForLockWaiters(database.pool, 1, 'auto-enrol blocked on the member row');
    await held.query(
      `UPDATE team_members SET is_auto_enroll = false, auto_enroll_until = NULL, auto_enroll_assigned_at = NULL WHERE team_id = $1 AND user_id = $2`,
      [s.teamId, off],
    );
    await held.release();
    const results = await pending;
    expect(results.map((entry) => entry.outcome)).toEqual([
      { ok: false, reason: 'auto_enroll_changed' },
      { ok: true, status: 'CONFIRMED' },
    ]);
    expect(await readRegistration(database.pool, s.sessionId, off)).toBeUndefined();

    // A save that commits WITHOUT changing the opt-out: the waiting allocator proceeds and places the member.
    const s2 = await scene(10);
    const stays = await insertMember(database.pool, s2.teamId);
    await setAutoEnroll(database.pool, {
      teamId: s2.teamId,
      userId: stays,
      enabled: true,
      assignedAt,
    });
    const held2 = await holdLock(
      database.pool,
      'SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2 FOR NO KEY UPDATE',
      [s2.teamId, stays],
    );
    const pending2 = autoEnrol(s2, [{ userId: stays, assignedAt }]);
    await waitForLockWaiters(database.pool, 1, 'auto-enrol blocked on the member row');
    await held2.query(
      `UPDATE team_members SET skill_level = 'ADVANCED' WHERE team_id = $1 AND user_id = $2`,
      [s2.teamId, stays],
    );
    await held2.release();
    expect((await pending2)[0]?.outcome).toEqual({ ok: true, status: 'CONFIRMED' });
    // The snapshot is the value the gate read after the wait: the save's committed level.
    expect(await readRegistration(database.pool, s2.sessionId, stays)).toMatchObject({
      snapshotSkill: 'ADVANCED',
    });
  });

  it('C1: a session date edit that commits between the header read and the session lock (moving the date past auto_enroll_until) skips the member as auto_enroll_changed', async () => {
    const s = await scene(10);
    const assignedAt = new Date(BASE.getTime() - 5_000);
    const { rows } = await database.pool.query<{ date: string }>(
      `SELECT date::text AS date FROM game_sessions WHERE id = $1`,
      [s.sessionId],
    );
    const sessionDate = rows[0]?.date as string;
    const member = await insertMember(database.pool, s.teamId);
    await setAutoEnroll(database.pool, {
      teamId: s.teamId,
      userId: member,
      enabled: true,
      until: sessionDate,
      assignedAt,
    });
    // The date editor holds the session row; auto-enrol has already read the OLD date (header) and passed the gate.
    const held = await holdLock(
      database.pool,
      'SELECT id FROM game_sessions WHERE id = $1 FOR UPDATE',
      [s.sessionId],
    );
    const pending = autoEnrol(s, [{ userId: member, assignedAt }]);
    await waitForLockWaiters(database.pool, 1, 'auto-enrol blocked on the session row');
    await held.query(`UPDATE game_sessions SET date = date + 7 WHERE id = $1`, [s.sessionId]);
    await held.release();
    expect((await pending)[0]?.outcome).toEqual({ ok: false, reason: 'auto_enroll_changed' });
    expect(await readRegistration(database.pool, s.sessionId, member)).toBeUndefined();
  });

  it('AC-ERROR-7: a ban in flight makes register wait at the gate and then refuse, and a registration that held the gate first stays', async () => {
    const s = await scene(10);
    const victim = await insertMember(database.pool, s.teamId);
    const held = await holdLock(
      database.pool,
      'SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2 FOR NO KEY UPDATE',
      [s.teamId, victim],
    );
    const pending = register(s, victim);
    await waitForLockWaiters(database.pool, 1, 'register blocked on the member row');
    await held.query(
      `UPDATE team_members SET status = 'BANNED', banned_at = now(), banned_by = user_id WHERE team_id = $1 AND user_id = $2`,
      [s.teamId, victim],
    );
    await held.release();
    expect(await pending).toEqual({ ok: false, reason: 'forbidden' });
    expect(await readRegistration(database.pool, s.sessionId, victim)).toBeUndefined();
  });
});

// Guest input type kept in scope for the helpers above.
export type { GuestInput };
