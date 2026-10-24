/**
 * The seat allocator against a real PostgreSQL 17 (registration-and-waitlist Phase 2, part A): AC-HAPPY-1..9 and
 * AC-HAPPY-11 (domain side), AC-ERROR-4, AC-VERIFY-3, 4, 5, 10, 11, AC-INTEGRATION-5. The scenario matrix is the SAME data the
 * pure `decideAllocation` unit test runs, seeded here as real rows, so the SQL path and the TypeScript decision cannot drift.
 *
 * Time: a `ManualClock` is advanced between the calls of one scenario and every operation reads it once (learned rule
 * testing-injected-clock). A session placed from BASE starts BASE + 72 h and its cancellation deadline is BASE + 24 h.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Transaction } from 'kysely';
import { createJobRunner, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import { QUEUES } from '../../src/jobs/registry.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import type { DB } from '../../src/lib/db/types.generated.ts';
import { createAllocator, type GuestInput } from '../../src/modules/registrations/allocator.ts';
import { HTTP_POLICY, runAllocatorTransaction } from '../../src/modules/registrations/tx.ts';
import {
  ALLOCATION_MATRIX,
  type MatrixParty,
  type MatrixScenario,
} from '../fixtures/allocation-matrix.ts';
import {
  advanceSessionTo,
  insertGuest,
  insertPayment,
  insertPublishedSession,
  insertRegistration,
  insertSession,
  insertTeam,
  insertTeamMember,
  insertUser,
  setAutoEnroll,
} from '../helpers/factories.ts';
import {
  createRecordingJobs,
  insertMember,
  moneyRowCounts,
  readGuests,
  readRegistration,
  readRegistrations,
  sqlSeats,
} from '../helpers/registration-scene.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import {
  createGatedDatabase,
  lockOrderViolations,
  transactionsOf,
  type GatedDatabase,
} from '../helpers/statement-gate.ts';
import {
  createTestDatabase,
  expectPgError,
  inTransaction,
  type TestDatabase,
} from '../helpers/test-db.ts';

const BASE = new Date('2026-10-20T00:00:00.000Z');
const WEB = 'https://games.example.nz';

let database: TestDatabase;
let gate: GatedDatabase;
let worker: JobRunner;
let producer: JobRunner;
const logs = captureLogs();
const clock = createManualClock(BASE);
let jobs: ReturnType<typeof createRecordingJobs>;
let allocator: ReturnType<typeof createAllocator>;

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 20 });
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
  allocator = createAllocator({ jobs, webBaseUrl: WEB });
});
afterAll(async () => {
  await producer.stop();
  await worker.stop();
  await database.close();
});
beforeEach(() => {
  clock.set(BASE);
  jobs.reset();
});
afterEach(() => {
  // No allocator path may need a lock retry, and none may breach the canonical lock order (AC-VERIFY-3).
  expect(logs.lines().filter((line) => line.event === 'registration.lock_retry')).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Builders and operations
// ---------------------------------------------------------------------------------------------

interface Scene {
  readonly teamId: string;
  readonly sessionId: string;
  startsAt: Date;
  deadline: Date;
}

async function scene(
  options: {
    maxPlayers?: number;
    reservedSeats?: number;
    teamId?: string;
    startsInHours?: number;
    now?: Date;
  } = {},
): Promise<Scene> {
  const { sessionId, teamId } = await insertPublishedSession(database.pool, options.teamId, {
    now: options.now ?? BASE,
    startsInHours: options.startsInHours,
    maxPlayers: options.maxPlayers ?? 12,
    reservedSeats: options.reservedSeats ?? 0,
  });
  const { rows } = await database.pool.query<{ starts_at: Date; cancellation_deadline: Date }>(
    `SELECT starts_at, cancellation_deadline FROM game_sessions WHERE id = $1`,
    [sessionId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('session not found');
  return { teamId, sessionId, startsAt: row.starts_at, deadline: row.cancellation_deadline };
}

const guests = (count: number): GuestInput[] =>
  Array.from({ length: count }, (_, index) => ({
    sex: index === 0 ? 'FEMALE' : 'MALE',
    skillLevel: index === 0 ? 'INTERMEDIATE' : 'BEGINNER',
    displayName: index === 0 ? 'Ana' : null,
  }));

function run<T>(
  s: Scene,
  path: string,
  work: (trx: Transaction<DB>, now: Date) => Promise<T>,
): Promise<T> {
  return runAllocatorTransaction(
    gate.db,
    HTTP_POLICY,
    { clock, teamId: s.teamId, path, log: logs.logger },
    ({ trx, now }) => work(trx, now),
  );
}

const register = (s: Scene, userId: string, withGuests: readonly GuestInput[] = []) =>
  run(s, 'register', (trx, now) =>
    allocator.registerInSession(
      { trx, now, log: logs.logger },
      { teamId: s.teamId, sessionId: s.sessionId, userId, guests: withGuests },
    ),
  );

const withdraw = (
  s: Scene,
  userId: string,
  cause: 'player' | 'ban' = 'player',
  expectLate?: boolean,
) =>
  run(s, 'withdraw', (trx, now) =>
    allocator.withdrawFromSession(
      { trx, now, log: logs.logger },
      {
        teamId: s.teamId,
        sessionId: s.sessionId,
        userId,
        cause,
        ...(expectLate === undefined ? {} : { expectLate }),
      },
    ),
  );

const promote = (s: Scene) =>
  run(s, 'promote', (trx, now) =>
    allocator.promoteWaitlist(
      { trx, now, log: logs.logger },
      { teamId: s.teamId, sessionId: s.sessionId },
    ),
  );

const autoEnrol = (s: Scene, entries: { userId: string; assignedAt: Date }[]) =>
  run(s, 'auto_enrol', (trx, now) =>
    allocator.autoEnrolInSession(
      { trx, now, log: logs.logger },
      { teamId: s.teamId, sessionId: s.sessionId, entries },
    ),
  );

/** Seeds one row with its guest rows in one transaction (the deferred guest-count trigger checks at COMMIT). */
async function seedRow(
  s: Scene,
  userId: string,
  size: number,
  options: {
    status: 'CONFIRMED' | 'WAITLISTED' | 'WITHDRAWN';
    queuePosition?: number;
    feeDue?: boolean;
    withdrawnAt?: Date;
    source?: 'MEMBER' | 'AUTO_ENROL';
    kind?: 'EARLY' | 'LATE' | 'BANNED';
  },
): Promise<string> {
  return inTransaction(database.pool, async (client) => {
    const id = await insertRegistration(client, {
      sessionId: s.sessionId,
      teamId: s.teamId,
      userId,
      status: options.status,
      queuePosition: options.queuePosition,
      guestCount: size - 1,
      withdrawalFeeDue: options.feeDue,
      withdrawnAt: options.withdrawnAt,
      withdrawalKind: options.kind,
      source: options.source,
    });
    for (let position = 1; position < size; position += 1) await insertGuest(client, id, position);
    return id;
  });
}

const sizeOfRow = (row: { guestCount: number }): number => 1 + row.guestCount;

/** A payment of `status` owed by `userId`, on a registration of a session of ANOTHER team (the debt gate counts across teams). */
async function owes(
  userId: string,
  status: 'OVERDUE' | 'PENDING' | 'PAID' | 'FAILED',
): Promise<void> {
  const elsewhere = await scene();
  const registrationId = await seedRow(elsewhere, userId, 1, { status: 'CONFIRMED' });
  const paymentId = await insertPayment(database.pool, {
    userId,
    teamId: elsewhere.teamId,
    registrationId,
    amount: '17.00',
  });
  if (status !== 'PENDING') {
    await database.pool.query(
      `UPDATE payments SET status = $2::payment_status, paid_at = CASE WHEN $3::boolean THEN now() END WHERE id = $1`,
      [paymentId, status, status === 'PAID'],
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The shared matrix, replayed against real rows
// ---------------------------------------------------------------------------------------------

async function seedMatrix(scenario: MatrixScenario): Promise<{
  s: Scene;
  userOf: Map<string, string>;
  nameOf: Map<string, string>;
}> {
  // Seed at full capacity, then cut: a capacity cut is allowed and never demotes, so over-capacity rows are reachable.
  const s = await scene({ maxPlayers: 24 });
  const userOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  const member = async (name: string): Promise<string> => {
    const userId = await insertMember(database.pool, s.teamId);
    userOf.set(name, userId);
    nameOf.set(userId, name);
    return userId;
  };
  for (const party of scenario.confirmed)
    await seedRow(s, await member(party.name), party.size, { status: 'CONFIRMED' });
  let position = 0;
  for (const party of scenario.waitlist) {
    position += 1;
    await seedRow(s, await member(party.name), party.size, {
      status: 'WAITLISTED',
      queuePosition: position,
    });
  }
  let owedIndex = 0;
  for (const party of scenario.owed ?? []) {
    owedIndex += 1;
    await seedRow(s, await member(party.name), party.size, {
      status: 'WITHDRAWN',
      feeDue: true,
      withdrawnAt: new Date(BASE.getTime() - (10 - owedIndex) * 3_600_000),
    });
  }
  const request = scenario.request;
  if (request.kind !== 'rebalance' && !userOf.has(request.name)) await member(request.name);
  const capacity = Math.max(scenario.capacity, 1);
  await database.pool.query(
    `UPDATE game_sessions SET max_players = $2, reserved_seats = $3 WHERE id = $1`,
    [s.sessionId, capacity, capacity - scenario.capacity],
  );
  return { s, userOf, nameOf };
}

describe('the allocation matrix on real rows (the same rows decideAllocation is tested with)', () => {
  it.each(ALLOCATION_MATRIX.map((scenario) => [scenario.name, scenario] as const))(
    '%s',
    async (_name, scenario) => {
      const { s, userOf, nameOf } = await seedMatrix(scenario);
      const request = scenario.request;
      let refused: string | undefined;
      if (request.kind === 'register') {
        const outcome = await register(
          s,
          userOf.get(request.name) as string,
          guests(request.size - 1),
        );
        if (!outcome.ok) refused = outcome.reason;
      } else if (request.kind === 'withdraw') {
        clock.set(
          new Date(
            s.deadline.getTime() + (request.withdrawalKind === 'LATE' ? 3_600_000 : -3_600_000),
          ),
        );
        const known = userOf.get(request.name);
        const outcome = await withdraw(
          s,
          known ?? (await insertMember(database.pool, s.teamId)),
          request.withdrawalKind === 'BANNED' ? 'ban' : 'player',
        );
        if (!outcome.ok) refused = outcome.reason;
        if (request.withdrawalKind === 'BANNED' && outcome.ok)
          expect(outcome.withdrawalKind).toBe('BANNED');
      } else {
        await promote(s);
      }

      const rows = await readRegistrations(database.pool, s.sessionId);
      const name = (userId: string): string => nameOf.get(userId) ?? userId;
      const confirmed = rows
        .filter((row) => row.status === 'CONFIRMED')
        .map((row) => name(row.userId))
        .sort();
      const waitlist = rows
        .filter((row) => row.status === 'WAITLISTED')
        .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0))
        .map((row) => name(row.userId));
      const owed = rows
        .filter((row) => row.status === 'WITHDRAWN' && row.feeDue)
        .sort((a, b) => (a.withdrawnAt?.getTime() ?? 0) - (b.withdrawnAt?.getTime() ?? 0))
        .map((row) => name(row.userId));
      expect({ refused, confirmed, waitlist, owed }).toEqual({
        refused: scenario.expected.refused,
        confirmed: scenario.expected.confirmed,
        waitlist: scenario.expected.waitlist,
        owed: scenario.expected.owed,
      });
      // Whatever the step did, the queue positions stay unique and no party was split (guest_count matches guest rows).
      const seats = await sqlSeats(database.pool, s.sessionId);
      expect(new Set(seats.waitlistPositions).size).toBe(seats.waitlistPositions.length);
      for (const row of rows)
        expect((await readGuests(database.pool, row.id)).length).toBe(row.guestCount);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Register (AC-HAPPY-1, 2, 3, AC-ERROR-4)
// ---------------------------------------------------------------------------------------------

describe('registerInSession', () => {
  it('AC-HAPPY-1: a solo player gets a confirmed seat, with the pricing snapshot and source MEMBER', async () => {
    const s = await scene({ maxPlayers: 12, reservedSeats: 2 });
    for (let i = 0; i < 7; i += 1) await register(s, await insertMember(database.pool, s.teamId));
    const userId = await insertMember(database.pool, s.teamId, {
      sex: 'FEMALE',
      skill: 'INTERMEDIATE',
    });
    clock.advance(5_000);
    const outcome = await register(s, userId);
    expect(outcome).toMatchObject({
      ok: true,
      status: 'CONFIRMED',
      queuePosition: null,
      waitlistRank: null,
      reRegistration: false,
    });
    const row = await readRegistration(database.pool, s.sessionId, userId);
    expect(row).toMatchObject({
      status: 'CONFIRMED',
      guestCount: 0,
      queuePosition: null,
      source: 'MEMBER',
      promotedAt: null,
      withdrawnAt: null,
      feeDue: false,
      snapshotSex: 'FEMALE',
      snapshotSkill: 'INTERMEDIATE',
    });
    expect(row?.registeredAt).toEqual(clock.now());
    expect(await readGuests(database.pool, row?.id ?? '')).toEqual([]);
    const seats = await sqlSeats(database.pool, s.sessionId);
    expect(seats).toMatchObject({ seatsTaken: 8, capacity: 10 });
  });

  it('AC-HAPPY-2: a registrant with two guests is confirmed together, guest rows in position order', async () => {
    const s = await scene({ maxPlayers: 10 });
    for (let i = 0; i < 7; i += 1) await register(s, await insertMember(database.pool, s.teamId));
    const userId = await insertMember(database.pool, s.teamId);
    const outcome = await register(s, userId, guests(2));
    expect(outcome).toMatchObject({ ok: true, status: 'CONFIRMED' });
    const row = await readRegistration(database.pool, s.sessionId, userId);
    expect(row?.guestCount).toBe(2);
    expect(await readGuests(database.pool, row?.id ?? '')).toEqual([
      { position: 1, sex: 'FEMALE', skillLevel: 'INTERMEDIATE', displayName: 'Ana' },
      { position: 2, sex: 'MALE', skillLevel: 'BEGINNER', displayName: null },
    ]);
    expect((await sqlSeats(database.pool, s.sessionId)).seatsTaken).toBe(10);
  });

  it('AC-HAPPY-3: a group that does not fit is waitlisted whole at max + 1, never split, with no snapshot', async () => {
    const s = await scene({ maxPlayers: 10 });
    for (let i = 0; i < 3; i += 1)
      await register(s, await insertMember(database.pool, s.teamId), guests(2));
    const w1 = await insertMember(database.pool, s.teamId);
    const w2 = await insertMember(database.pool, s.teamId);
    await register(s, w1, guests(1));
    await register(s, w2, guests(1));
    expect(await register(s, await insertMember(database.pool, s.teamId))).toMatchObject({
      ok: true,
      status: 'CONFIRMED',
    });
    const userId = await insertMember(database.pool, s.teamId);
    const outcome = await register(s, userId, guests(1));
    expect(outcome).toMatchObject({
      ok: true,
      status: 'WAITLISTED',
      queuePosition: 3,
      waitlistRank: 3,
    });
    const row = await readRegistration(database.pool, s.sessionId, userId);
    expect(row).toMatchObject({
      status: 'WAITLISTED',
      queuePosition: 3,
      guestCount: 1,
      snapshotSex: null,
      snapshotSkill: null,
    });
    expect(await readGuests(database.pool, row?.id ?? '')).toHaveLength(1);
    const later = await register(s, await insertMember(database.pool, s.teamId), guests(1));
    expect(later).toMatchObject({ ok: true, status: 'WAITLISTED', queuePosition: 4 });
  });

  it('AC-ERROR-4: a party that can never fit is refused and nothing is written', async () => {
    for (const [maxPlayers, reservedSeats] of [
      [2, 0],
      [4, 4],
    ] as const) {
      const s = await scene({ maxPlayers, reservedSeats });
      const userId = await insertMember(database.pool, s.teamId);
      const outcome = await register(s, userId, guests(2));
      expect(outcome).toEqual({
        ok: false,
        reason: 'party_exceeds_capacity',
        publicCapacity: maxPlayers - reservedSeats,
      });
      expect(await readRegistrations(database.pool, s.sessionId)).toEqual([]);
    }
  });

  it('AC-ERROR-3: a second register is refused as already_registered and consumes no queue position', async () => {
    const s = await scene({ maxPlayers: 1 });
    await register(s, await insertMember(database.pool, s.teamId));
    const waiting = await insertMember(database.pool, s.teamId);
    await register(s, waiting);
    expect(await register(s, waiting)).toEqual({ ok: false, reason: 'already_registered' });
    const next = await register(s, await insertMember(database.pool, s.teamId));
    expect(next).toMatchObject({ status: 'WAITLISTED', queuePosition: 2 });
    expect(
      (await readRegistrations(database.pool, s.sessionId)).filter((row) => row.userId === waiting),
    ).toHaveLength(1);
  });

  it('AC-ERROR-7: a caller who is not an approved member is refused as forbidden and nothing is written', async () => {
    const s = await scene();
    const outsider = await insertUser(database.pool);
    const stray = await insertTeam(database.pool);
    await insertTeamMember(database.pool, { teamId: stray, userId: outsider });
    const pending = await insertMember(database.pool, s.teamId, { status: 'PENDING' });
    const banned = await insertMember(database.pool, s.teamId, { status: 'BANNED' });
    for (const userId of [outsider, pending, banned]) {
      expect(await register(s, userId)).toEqual({ ok: false, reason: 'forbidden' });
    }
    expect(await readRegistrations(database.pool, s.sessionId)).toEqual([]);
  });

  it('refuses a session that is not open: not_found for a DRAFT or foreign id, session_not_open for closed ones', async () => {
    const s = await scene();
    const userId = await insertMember(database.pool, s.teamId);
    const draft = await insertSession(database.pool, s.teamId, {}, { status: 'DRAFT' });
    expect(
      await run(s, 'register', (trx, now) =>
        allocator.registerInSession(
          { trx, now, log: logs.logger },
          { teamId: s.teamId, sessionId: draft, userId, guests: [] },
        ),
      ),
    ).toEqual({ ok: false, reason: 'not_found' });
    const other = await scene();
    expect(
      await run(s, 'register', (trx, now) =>
        allocator.registerInSession(
          { trx, now, log: logs.logger },
          { teamId: s.teamId, sessionId: other.sessionId, userId, guests: [] },
        ),
      ),
    ).toEqual({ ok: false, reason: 'not_found' });
    // Started: exactly at starts_at the session is closed; one millisecond earlier it is open.
    clock.set(new Date(s.startsAt.getTime() - 1));
    expect(await register(s, userId)).toMatchObject({ ok: true });
    const late = await insertMember(database.pool, s.teamId);
    clock.set(s.startsAt);
    expect(await register(s, late)).toEqual({ ok: false, reason: 'session_not_open' });
    for (const status of ['CANCELLED', 'COMPLETED'] as const) {
      const closed = await scene({ teamId: s.teamId });
      await advanceSessionTo(database.pool, closed.sessionId, status);
      clock.set(BASE);
      expect(await register(closed, late)).toEqual({ ok: false, reason: 'session_not_open' });
    }
  });

  it('AC-ERROR-1: the debt gate blocks at 3 OVERDUE payments across teams and not at 2, and never blocks a withdrawal', async () => {
    const s = await scene();
    const debtor = await insertMember(database.pool, s.teamId);
    const nearly = await insertMember(database.pool, s.teamId);
    for (let i = 0; i < 3; i += 1) await owes(debtor, 'OVERDUE');
    for (const status of ['OVERDUE', 'OVERDUE', 'PENDING', 'PAID'] as const)
      await owes(nearly, status);
    expect(await register(s, debtor)).toEqual({
      ok: false,
      reason: 'overdue_payments',
      overdueCount: 3,
    });
    expect(await readRegistration(database.pool, s.sessionId, debtor)).toBeUndefined();
    expect(await register(s, nearly)).toMatchObject({ ok: true, status: 'CONFIRMED' });
    // Withdrawing is never blocked by debt: give the debtor a row by hand, then withdraw.
    await seedRow(s, debtor, 1, { status: 'CONFIRMED' });
    expect(await withdraw(s, debtor)).toMatchObject({ ok: true, withdrawalKind: 'EARLY' });
  });
});

// ---------------------------------------------------------------------------------------------
// Withdraw (AC-HAPPY-4..7, AC-ERROR-6, AC-VERIFY-5)
// ---------------------------------------------------------------------------------------------

describe('withdrawFromSession', () => {
  async function fullSessionWithQueue(): Promise<{
    s: Scene;
    p: string;
    a: string;
    b: string;
    aEmail: string;
  }> {
    const aEmail = `promoted-${randomUUID()}@example.test`;
    const s = await scene({ maxPlayers: 2 });
    const p = await insertMember(database.pool, s.teamId);
    await register(s, p);
    await register(s, await insertMember(database.pool, s.teamId));
    clock.advance(1_000);
    const a = await insertMember(database.pool, s.teamId, {
      sex: 'FEMALE',
      skill: 'ADVANCED',
      email: aEmail,
    });
    const b = await insertMember(database.pool, s.teamId);
    await register(s, a);
    await register(s, b);
    return { s, p, a, b, aEmail };
  }

  it('AC-HAPPY-4: an early withdrawal exactly at the deadline is free and promotes the head of the queue', async () => {
    const { s, p, a, b, aEmail } = await fullSessionWithQueue();
    clock.set(s.deadline);
    const outcome = await withdraw(s, p);
    expect(outcome).toMatchObject({
      ok: true,
      withdrawalKind: 'EARLY',
      feeDue: false,
      wasConfirmed: true,
    });
    expect(outcome.ok && outcome.promoted.map((one) => one.userId)).toEqual([a]);
    expect(await readRegistration(database.pool, s.sessionId, p)).toMatchObject({
      status: 'WITHDRAWN',
      withdrawalKind: 'EARLY',
      feeDue: false,
      queuePosition: null,
      withdrawnAt: s.deadline,
    });
    const promoted = await readRegistration(database.pool, s.sessionId, a);
    expect(promoted).toMatchObject({
      status: 'CONFIRMED',
      queuePosition: null,
      promotedAt: s.deadline,
      snapshotSex: 'FEMALE',
      snapshotSkill: 'ADVANCED',
    });
    // B keeps position 2 (never renumbered) and is now rank 1.
    expect(await readRegistration(database.pool, s.sessionId, b)).toMatchObject({
      status: 'WAITLISTED',
      queuePosition: 2,
    });
    // AC-ASYNC-1 (domain): one email for the promoted player only, enqueued in the transaction.
    const sent = jobs.emails();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: aEmail,
      idempotencyKey: `registration-promoted:${promoted?.id}:${s.deadline.getTime()}`,
    });
    expect(sent[0]?.subject).toMatch(/^You're in: .+, \w{3} \d{1,2} \w{3}$/);
    expect(jobs.recorded.every((job) => job.inTransaction)).toBe(true);
    expect(sent[0]?.text).toContain(`${WEB}/teams/${s.teamId}/sessions/${s.sessionId}`);
    expect(sent[0]?.text).toContain('Free cancellation until');
  });

  it('AC-HAPPY-5: a late withdrawal 1 ms after the deadline with a waitlist hands the place over and the email says the deadline passed', async () => {
    const { s, p, a } = await fullSessionWithQueue();
    clock.set(new Date(s.deadline.getTime() + 1));
    const outcome = await withdraw(s, p);
    expect(outcome).toMatchObject({ ok: true, withdrawalKind: 'LATE', feeDue: false });
    expect(await readRegistration(database.pool, s.sessionId, p)).toMatchObject({
      status: 'WITHDRAWN',
      withdrawalKind: 'LATE',
      feeDue: false,
    });
    expect(await readRegistration(database.pool, s.sessionId, a)).toMatchObject({
      status: 'CONFIRMED',
    });
    expect(jobs.emails()[0]?.text).toContain('The free cancellation deadline has passed');
  });

  it('AC-HAPPY-6: a late withdrawal with nobody to promote leaves the withdrawer owing for the whole party, guests kept', async () => {
    const s = await scene({ maxPlayers: 10 });
    const p = await insertMember(database.pool, s.teamId);
    await register(s, p, guests(2));
    clock.set(new Date(s.deadline.getTime() + 1));
    const outcome = await withdraw(s, p);
    expect(outcome).toMatchObject({ ok: true, withdrawalKind: 'LATE', feeDue: true, promoted: [] });
    const row = await readRegistration(database.pool, s.sessionId, p);
    expect(row).toMatchObject({
      status: 'WITHDRAWN',
      feeDue: true,
      withdrawalKind: 'LATE',
      snapshotSkill: 'BEGINNER',
    });
    expect(await readGuests(database.pool, row?.id ?? '')).toHaveLength(2);
    expect(jobs.emails()).toEqual([]);
  });

  it('AC-HAPPY-7: leaving the waitlist is free by the clock, keeps every other position and promotes nobody', async () => {
    const s = await scene({ maxPlayers: 1 });
    await register(s, await insertMember(database.pool, s.teamId));
    const one = await insertMember(database.pool, s.teamId);
    const two = await insertMember(database.pool, s.teamId);
    const three = await insertMember(database.pool, s.teamId);
    for (const userId of [one, two, three]) await register(s, userId);
    clock.set(new Date(s.deadline.getTime() + 60_000));
    const outcome = await withdraw(s, two);
    expect(outcome).toMatchObject({
      ok: true,
      withdrawalKind: 'LATE',
      feeDue: false,
      wasConfirmed: false,
      promoted: [],
    });
    expect(await readRegistration(database.pool, s.sessionId, two)).toMatchObject({
      status: 'WITHDRAWN',
      queuePosition: null,
      feeDue: false,
    });
    expect((await readRegistration(database.pool, s.sessionId, one))?.queuePosition).toBe(1);
    expect((await readRegistration(database.pool, s.sessionId, three))?.queuePosition).toBe(3);
  });

  it('AC-ERROR-6: withdrawing with no active registration is refused and changes nothing', async () => {
    const s = await scene();
    const userId = await insertMember(database.pool, s.teamId);
    expect(await withdraw(s, userId)).toEqual({ ok: false, reason: 'not_registered' });
    await register(s, userId);
    await withdraw(s, userId);
    const before = await readRegistration(database.pool, s.sessionId, userId);
    jobs.reset();
    expect(await withdraw(s, userId)).toEqual({ ok: false, reason: 'not_registered' });
    expect(await readRegistration(database.pool, s.sessionId, userId)).toEqual(before);
    expect(jobs.recorded).toEqual([]);
  });

  it('refuses to withdraw from a started or cancelled session as session_not_open', async () => {
    const s = await scene();
    const userId = await insertMember(database.pool, s.teamId);
    await register(s, userId);
    clock.set(s.startsAt);
    expect(await withdraw(s, userId)).toEqual({ ok: false, reason: 'session_not_open' });
    clock.set(BASE);
    await advanceSessionTo(database.pool, s.sessionId, 'CANCELLED');
    expect(await withdraw(s, userId)).toEqual({ ok: false, reason: 'session_not_open' });
  });

  it('R9: a late classification the caller did not expect is refused before anything is written', async () => {
    const s = await scene();
    const userId = await insertMember(database.pool, s.teamId);
    await register(s, userId);
    clock.set(new Date(s.deadline.getTime() + 1));
    expect(await withdraw(s, userId, 'player', false)).toEqual({
      ok: false,
      reason: 'cancellation_terms_changed',
    });
    expect((await readRegistration(database.pool, s.sessionId, userId))?.status).toBe('CONFIRMED');
    expect(await withdraw(s, userId, 'player', true)).toMatchObject({
      ok: true,
      withdrawalKind: 'LATE',
    });
  });

  it('AC-VERIFY-5: the deadline boundary is exact to 1 ms, also for sessions across both NZ daylight-saving changes', async () => {
    const cases = [
      { now: new Date('2026-09-24T01:00:00Z'), hours: 72 },
      { now: new Date('2027-04-01T00:00:00Z'), hours: 72 },
      { now: BASE, hours: 72 },
    ];
    for (const { now, hours } of cases) {
      const s = await scene({ now, startsInHours: hours });
      const early = [-1, 0];
      const players: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const userId = await insertMember(database.pool, s.teamId);
        clock.set(now);
        await register(s, userId);
        players.push(userId);
      }
      const kinds: string[] = [];
      for (const [index, offset] of [...early, 1].entries()) {
        clock.set(new Date(s.deadline.getTime() + offset));
        const outcome = await withdraw(s, players[index] as string);
        kinds.push(outcome.ok ? outcome.withdrawalKind : 'refused');
      }
      expect(kinds).toEqual(['EARLY', 'EARLY', 'LATE']);
    }
  });

  it('R2: a ban withdrawal promotes the waitlist, releases an older owed fee, and is never liable or emailed to the banned member', async () => {
    const s = await scene({ maxPlayers: 3 });
    const owedMember = await insertMember(database.pool, s.teamId);
    const confirmed = await insertMember(database.pool, s.teamId, {
      email: 'banned-person@example.test',
    });
    await seedRow(s, owedMember, 1, {
      status: 'WITHDRAWN',
      feeDue: true,
      withdrawnAt: new Date(BASE.getTime() - 3_600_000),
    });
    await seedRow(s, confirmed, 3, { status: 'CONFIRMED' });
    const waiting = await insertMember(database.pool, s.teamId, { email: 'next-up@example.test' });
    await seedRow(s, waiting, 1, { status: 'WAITLISTED', queuePosition: 1 });
    clock.set(new Date(s.deadline.getTime() + 60_000));
    const outcome = await withdraw(s, confirmed, 'ban');
    expect(outcome).toMatchObject({
      ok: true,
      withdrawalKind: 'BANNED',
      feeDue: false,
      liabilitiesReleased: 1,
    });
    expect(await readRegistration(database.pool, s.sessionId, owedMember)).toMatchObject({
      feeDue: false,
      status: 'WITHDRAWN',
    });
    expect(jobs.emails().map((mail) => mail.to)).toEqual(['next-up@example.test']);
  });
});

// ---------------------------------------------------------------------------------------------
// Re-registration (AC-HAPPY-8, R3, R17)
// ---------------------------------------------------------------------------------------------

describe('re-registration', () => {
  it('AC-HAPPY-8: reuses the same row, replaces the guests, clears the stamps, and a promoted row that re-queues loses promoted_at', async () => {
    const s = await scene({ maxPlayers: 2 });
    const holder = await insertMember(database.pool, s.teamId);
    await register(s, holder);
    await register(s, await insertMember(database.pool, s.teamId));
    const player = await insertMember(database.pool, s.teamId);
    await register(s, player);
    clock.advance(1_000);
    await withdraw(s, holder);
    expect((await readRegistration(database.pool, s.sessionId, player))?.promotedAt).not.toBeNull();
    clock.advance(1_000);
    await withdraw(s, player);
    const withdrawn = await readRegistration(database.pool, s.sessionId, player);
    expect(withdrawn?.status).toBe('WITHDRAWN');
    // The freed seat is taken again, so the re-registration with a guest (a party of 2) lands on the waitlist.
    await register(s, await insertMember(database.pool, s.teamId));
    clock.advance(1_000);
    const outcome = await register(s, player, guests(1));
    expect(outcome).toMatchObject({
      ok: true,
      status: 'WAITLISTED',
      queuePosition: 1,
      reRegistration: true,
    });
    const rows = await readRegistrations(database.pool, s.sessionId);
    expect(rows.filter((row) => row.userId === player)).toHaveLength(1);
    const again = rows.find((row) => row.userId === player);
    expect(again).toMatchObject({
      id: withdrawn?.id,
      status: 'WAITLISTED',
      queuePosition: 1,
      guestCount: 1,
      promotedAt: null,
      withdrawnAt: null,
      withdrawalKind: null,
      feeDue: false,
    });
    expect(again?.registeredAt).toEqual(clock.now());
    expect(await readGuests(database.pool, again?.id ?? '')).toHaveLength(1);
  });

  it('R3: while a fee is owed, a waitlisted or smaller re-registration is refused and a confirmed group at least as large takes the place over', async () => {
    const s = await scene({ maxPlayers: 4 });
    const player = await insertMember(database.pool, s.teamId);
    await register(s, player, guests(1));
    clock.set(new Date(s.deadline.getTime() + 1));
    await withdraw(s, player);
    expect((await readRegistration(database.pool, s.sessionId, player))?.feeDue).toBe(true);
    expect(await register(s, player)).toEqual({ ok: false, reason: 'late_withdrawal_fee_due' });
    const refused = await readRegistration(database.pool, s.sessionId, player);
    expect(refused).toMatchObject({ status: 'WITHDRAWN', feeDue: true });
    expect(await readGuests(database.pool, refused?.id ?? '')).toHaveLength(1);
    const outcome = await register(s, player, guests(2));
    expect(outcome).toMatchObject({ ok: true, status: 'CONFIRMED', reRegistration: true });
    expect(await readRegistration(database.pool, s.sessionId, player)).toMatchObject({
      status: 'CONFIRMED',
      feeDue: false,
      guestCount: 2,
      withdrawnAt: null,
    });
  });

  it('R17: a panel register or re-register is MEMBER, even over an AUTO_ENROL row that was withdrawn', async () => {
    const s = await scene();
    const userId = await insertMember(database.pool, s.teamId);
    await seedRow(s, userId, 1, { status: 'WITHDRAWN', source: 'AUTO_ENROL' });
    expect(await register(s, userId)).toMatchObject({ ok: true, reRegistration: true });
    expect((await readRegistration(database.pool, s.sessionId, userId))?.source).toBe('MEMBER');
  });
});

// ---------------------------------------------------------------------------------------------
// promoteWaitlist (the capacity-edit entry point)
// ---------------------------------------------------------------------------------------------

describe('promoteWaitlist', () => {
  it('promotes first-fit after a capacity raise, releases an owed fee, emails the promoted party and returns the seats', async () => {
    const s = await scene({ maxPlayers: 3 });
    for (let i = 0; i < 3; i += 1) await register(s, await insertMember(database.pool, s.teamId));
    const big = await insertMember(database.pool, s.teamId);
    const small = await insertMember(database.pool, s.teamId, { email: 'cap-raise@example.test' });
    await register(s, big, guests(2));
    await register(s, small);
    expect(await readRegistration(database.pool, s.sessionId, small)).toMatchObject({
      status: 'WAITLISTED',
      queuePosition: 2,
    });
    const owed = await insertMember(database.pool, s.teamId);
    await seedRow(s, owed, 1, {
      status: 'WITHDRAWN',
      feeDue: true,
      withdrawnAt: new Date(BASE.getTime() - 1_000),
    });
    await database.pool.query(`UPDATE game_sessions SET max_players = 4 WHERE id = $1`, [
      s.sessionId,
    ]);
    clock.advance(2_000);
    const promoted = await promote(s);
    expect(promoted.map((seat) => seat.userId)).toEqual([small]);
    expect(promoted[0]?.promotedAt).toEqual(clock.now());
    expect(await readRegistration(database.pool, s.sessionId, big)).toMatchObject({
      status: 'WAITLISTED',
      queuePosition: 1,
    });
    expect(await readRegistration(database.pool, s.sessionId, owed)).toMatchObject({
      feeDue: false,
    });
    expect(jobs.emails().map((mail) => mail.to)).toEqual(['cap-raise@example.test']);
    // A second call changes nothing: the invariant already holds.
    jobs.reset();
    expect(await promote(s)).toEqual([]);
    expect(jobs.recorded).toEqual([]);
  });

  it('promotes nobody on a started, cancelled or unknown session', async () => {
    const s = await scene({ maxPlayers: 1 });
    await register(s, await insertMember(database.pool, s.teamId));
    const waiting = await insertMember(database.pool, s.teamId);
    await register(s, waiting);
    await database.pool.query(`UPDATE game_sessions SET max_players = 5 WHERE id = $1`, [
      s.sessionId,
    ]);
    clock.set(s.startsAt);
    expect(await promote(s)).toEqual([]);
    expect((await readRegistration(database.pool, s.sessionId, waiting))?.status).toBe(
      'WAITLISTED',
    );
    expect(
      await run(s, 'promote', (trx, now) =>
        allocator.promoteWaitlist(
          { trx, now, log: logs.logger },
          { teamId: s.teamId, sessionId: randomUUID() },
        ),
      ),
    ).toEqual([]);
  });

  it('R22: runs several times inside a transaction that already holds the session lock, with no lock timeout of its own and no new lock', async () => {
    const s = await scene({ maxPlayers: 1 });
    await register(s, await insertMember(database.pool, s.teamId));
    const waiting = await insertMember(database.pool, s.teamId, {
      email: 'inside-caller@example.test',
    });
    await register(s, waiting);
    const mark = gate.statements.length;
    const calls = await gate.db.transaction().execute(async (trx) => {
      // What session scheduling's capacity edit does: lock the session, change capacity, then ask for promotion.
      await trx
        .selectFrom('game_sessions')
        .select('id')
        .where('id', '=', s.sessionId)
        .forUpdate()
        .execute();
      await trx
        .updateTable('game_sessions')
        .set({ max_players: 2 })
        .where('id', '=', s.sessionId)
        .execute();
      const ctx = { trx, now: clock.now(), log: logs.logger };
      const first = await allocator.promoteWaitlist(ctx, {
        teamId: s.teamId,
        sessionId: s.sessionId,
      });
      const second = await allocator.promoteWaitlist(ctx, {
        teamId: s.teamId,
        sessionId: s.sessionId,
      });
      return { first, second };
    });
    expect(calls.first.map((seat) => seat.userId)).toEqual([waiting]);
    expect(calls.second).toEqual([]);
    const statements = gate.statements.slice(mark);
    expect(statements.some((statement) => /lock_timeout/i.test(statement.sql))).toBe(false);
    expect(lockOrderViolations(statements)).toEqual([]);
    expect(jobs.emails().map((mail) => mail.to)).toEqual(['inside-caller@example.test']);
  });

  it('part A risk: never promotes a waitlisted member whose membership is no longer APPROVED (banned, ban job not run yet); the next in line is promoted instead', async () => {
    const s = await scene({ maxPlayers: 1 });
    await register(s, await insertMember(database.pool, s.teamId));
    const banned = await insertMember(database.pool, s.teamId, {
      email: 'banned-wait@example.test',
    });
    const next = await insertMember(database.pool, s.teamId, { email: 'next-wait@example.test' });
    await register(s, banned);
    await register(s, next);
    await database.pool.query(
      `UPDATE team_members SET status = 'BANNED', banned_at = now(), banned_by = $2 WHERE team_id = $1 AND user_id = $2`,
      [s.teamId, banned],
    );
    await database.pool.query(`UPDATE game_sessions SET max_players = 2 WHERE id = $1`, [
      s.sessionId,
    ]);
    const promoted = await promote(s);
    expect(promoted.map((seat) => seat.userId)).toEqual([next]);
    expect(await readRegistration(database.pool, s.sessionId, banned)).toMatchObject({
      status: 'WAITLISTED',
      promotedAt: null,
    });
    expect(jobs.emails().map((mail) => mail.to)).toEqual(['next-wait@example.test']);
  });

  it('a banned waitlisted member at the tail still holds their queue position, so a newcomer queues behind it without a unique-index clash', async () => {
    const s = await scene({ maxPlayers: 1 });
    await register(s, await insertMember(database.pool, s.teamId));
    const banned = await insertMember(database.pool, s.teamId);
    await register(s, banned);
    await database.pool.query(
      `UPDATE team_members SET status = 'BANNED', banned_at = now(), banned_by = $2 WHERE team_id = $1 AND user_id = $2`,
      [s.teamId, banned],
    );
    const newcomer = await insertMember(database.pool, s.teamId);
    const outcome = await register(s, newcomer);
    expect(outcome).toMatchObject({ ok: true, status: 'WAITLISTED', queuePosition: 2 });
  });

  it("B1: a banned member's WAITLISTED row can still be withdrawn with cause ban: row WITHDRAWN kind BANNED, no queue position, nobody ahead of it is disturbed", async () => {
    const s = await scene({ maxPlayers: 1 });
    await register(s, await insertMember(database.pool, s.teamId));
    const banned = await insertMember(database.pool, s.teamId);
    const behind = await insertMember(database.pool, s.teamId);
    await register(s, banned);
    await register(s, behind);
    await database.pool.query(
      `UPDATE team_members SET status = 'BANNED', banned_at = now(), banned_by = $2 WHERE team_id = $1 AND user_id = $2`,
      [s.teamId, banned],
    );
    const outcome = await withdraw(s, banned, 'ban');
    expect(outcome).toMatchObject({
      ok: true,
      withdrawalKind: 'BANNED',
      feeDue: false,
      wasConfirmed: false,
    });
    expect(await readRegistration(database.pool, s.sessionId, banned)).toMatchObject({
      status: 'WITHDRAWN',
      withdrawalKind: 'BANNED',
      queuePosition: null,
      feeDue: false,
    });
    expect(await readRegistration(database.pool, s.sessionId, behind)).toMatchObject({
      status: 'WAITLISTED',
    });
  });

  it('C3 (accepted residual): a member banned right after being promoted is withdrawn later with kind BANNED and no fee, even past the deadline', async () => {
    const s = await scene({ maxPlayers: 1 });
    const first = await insertMember(database.pool, s.teamId);
    const promotedThenBanned = await insertMember(database.pool, s.teamId);
    await register(s, first);
    await register(s, promotedThenBanned);
    await withdraw(s, first);
    expect(await readRegistration(database.pool, s.sessionId, promotedThenBanned)).toMatchObject({
      status: 'CONFIRMED',
    });
    await database.pool.query(
      `UPDATE team_members SET status = 'BANNED', banned_at = now(), banned_by = $2 WHERE team_id = $1 AND user_id = $2`,
      [s.teamId, promotedThenBanned],
    );
    clock.set(new Date(s.deadline.getTime() + 60_000));
    expect(await withdraw(s, promotedThenBanned, 'ban')).toMatchObject({
      ok: true,
      withdrawalKind: 'BANNED',
      feeDue: false,
      wasConfirmed: true,
    });
    expect(await readRegistration(database.pool, s.sessionId, promotedThenBanned)).toMatchObject({
      status: 'WITHDRAWN',
      withdrawalKind: 'BANNED',
      feeDue: false,
    });
  });

  it('refuses to run outside a transaction (R22: it never opens one itself)', async () => {
    const s = await scene();
    await expect(
      allocator.promoteWaitlist(
        { trx: gate.db as unknown as Transaction<DB>, now: BASE, log: logs.logger },
        { teamId: s.teamId, sessionId: s.sessionId },
      ),
    ).rejects.toThrow(/transaction/);
  });
});

// ---------------------------------------------------------------------------------------------
// R2 release through auto-enrol, AC-HAPPY-11, AC-INTEGRATION-5
// ---------------------------------------------------------------------------------------------

describe('autoEnrolInSession', () => {
  const assignedAt = (offsetSeconds: number): Date =>
    new Date(BASE.getTime() - 86_400_000 + offsetSeconds * 1000);

  async function enrollee(
    s: Scene,
    offset: number,
    options: {
      email?: string;
      sex?: 'MALE' | 'FEMALE' | 'OTHER';
      skill?: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';
    } = {},
  ) {
    const userId = await insertMember(database.pool, s.teamId, options);
    const at = assignedAt(offset);
    await setAutoEnroll(database.pool, { teamId: s.teamId, userId, enabled: true, assignedAt: at });
    return { userId, assignedAt: at };
  }

  it('AC-HAPPY-11 / R17: places members in order with source AUTO_ENROL, the snapshot, and one email per placed member', async () => {
    const s = await scene({ maxPlayers: 2 });
    const first = await enrollee(s, 1, {
      email: 'first@example.test',
      sex: 'FEMALE',
      skill: 'INTERMEDIATE',
    });
    const second = await enrollee(s, 2, { email: 'second@example.test' });
    const third = await enrollee(s, 3, { email: 'third@example.test' });
    const results = await autoEnrol(s, [first, second, third]);
    expect(results).toEqual([
      { userId: first.userId, outcome: { ok: true, status: 'CONFIRMED' } },
      { userId: second.userId, outcome: { ok: true, status: 'CONFIRMED' } },
      { userId: third.userId, outcome: { ok: true, status: 'WAITLISTED' } },
    ]);
    expect(await readRegistration(database.pool, s.sessionId, first.userId)).toMatchObject({
      status: 'CONFIRMED',
      source: 'AUTO_ENROL',
      guestCount: 0,
      snapshotSex: 'FEMALE',
      snapshotSkill: 'INTERMEDIATE',
    });
    expect(await readRegistration(database.pool, s.sessionId, third.userId)).toMatchObject({
      status: 'WAITLISTED',
      queuePosition: 1,
      source: 'AUTO_ENROL',
    });
    const sent = jobs.emails();
    expect(sent.map((mail) => mail.to)).toEqual([
      'first@example.test',
      'second@example.test',
      'third@example.test',
    ]);
    expect(sent[0]?.subject).toMatch(/^You've been added to .+, \w{3} \d{1,2} \w{3}$/);
    expect(sent[2]?.subject).toMatch(
      /^You've been added to the waitlist for .+, \w{3} \d{1,2} \w{3}$/,
    );
    expect(sent[0]?.text).toContain(
      'Your team admin turned on Auto Enroll for you. Withdraw before',
    );
    expect(sent[0]?.idempotencyKey).toMatch(/^auto-enrol:[0-9a-f-]{36}:2026-10-20T00:00:00\.000Z$/);
    expect(jobs.recorded.every((job) => job.inTransaction)).toBe(true);
  });

  it('AC-INTEGRATION-5: a member who turned Auto Enroll off, let it lapse, or turned it off and on again is skipped; valid members are placed', async () => {
    const s = await scene({ maxPlayers: 6 });
    const off = await enrollee(s, 1);
    const lapsed = await enrollee(s, 2);
    const flipped = await enrollee(s, 3);
    const valid = await enrollee(s, 4);
    await setAutoEnroll(database.pool, { teamId: s.teamId, userId: off.userId, enabled: false });
    const { rows } = await database.pool.query<{ date: string }>(
      `SELECT date::text AS date FROM game_sessions WHERE id = $1`,
      [s.sessionId],
    );
    const dayBefore = new Date(`${rows[0]?.date}T00:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    await setAutoEnroll(database.pool, {
      teamId: s.teamId,
      userId: lapsed.userId,
      enabled: true,
      until: dayBefore.toISOString().slice(0, 10),
      assignedAt: lapsed.assignedAt,
    });
    await setAutoEnroll(database.pool, {
      teamId: s.teamId,
      userId: flipped.userId,
      enabled: false,
    });
    await setAutoEnroll(database.pool, {
      teamId: s.teamId,
      userId: flipped.userId,
      enabled: true,
      assignedAt: new Date(flipped.assignedAt.getTime() + 5_000),
    });
    const results = await autoEnrol(s, [off, lapsed, flipped, valid]);
    expect(results.map((entry) => entry.outcome)).toEqual([
      { ok: false, reason: 'auto_enroll_changed' },
      { ok: false, reason: 'auto_enroll_changed' },
      { ok: false, reason: 'auto_enroll_changed' },
      { ok: true, status: 'CONFIRMED' },
    ]);
    const stored = await readRegistrations(database.pool, s.sessionId);
    expect(stored.map((row) => row.userId)).toEqual([valid.userId]);
    expect(jobs.emails()).toHaveLength(1);
  });

  it('R21: an existing row in ANY status is skipped as already_registered and left exactly as it was', async () => {
    const s = await scene({ maxPlayers: 10 });
    const rowsToSeed: { name: string; options: Parameters<typeof seedRow>[3]; size: number }[] = [
      { name: 'confirmed', options: { status: 'CONFIRMED', source: 'MEMBER' }, size: 1 },
      { name: 'waitlisted', options: { status: 'WAITLISTED', queuePosition: 1 }, size: 1 },
      { name: 'early', options: { status: 'WITHDRAWN', kind: 'EARLY' }, size: 1 },
      { name: 'late', options: { status: 'WITHDRAWN', kind: 'LATE' }, size: 1 },
      { name: 'owed', options: { status: 'WITHDRAWN', feeDue: true }, size: 2 },
      { name: 'banned', options: { status: 'WITHDRAWN', kind: 'BANNED' }, size: 1 },
    ];
    const entries: { userId: string; assignedAt: Date }[] = [];
    for (const [index, spec] of rowsToSeed.entries()) {
      const member = await enrollee(s, index + 1);
      entries.push(member);
      await seedRow(s, member.userId, spec.size, spec.options);
    }
    const before = await readRegistrations(database.pool, s.sessionId);
    const results = await autoEnrol(s, entries);
    expect(results.map((entry) => entry.outcome)).toEqual(
      rowsToSeed.map(() => ({ ok: false, reason: 'already_registered' })),
    );
    expect(await readRegistrations(database.pool, s.sessionId)).toEqual(before);
    expect(jobs.emails()).toEqual([]);
    // A re-run of a placed set is harmless for the same reason.
    const fresh = await enrollee(s, 20);
    await autoEnrol(s, [fresh]);
    jobs.reset();
    expect((await autoEnrol(s, [fresh]))[0]?.outcome).toEqual({
      ok: false,
      reason: 'already_registered',
    });
    expect(jobs.emails()).toEqual([]);
  });

  it('skips a member who is no longer approved (forbidden) or owes 3 overdue payments, without a row', async () => {
    const s = await scene({ maxPlayers: 6 });
    const banned = await enrollee(s, 1);
    await database.pool.query(
      `UPDATE team_members SET status = 'BANNED', banned_at = now(), banned_by = user_id, is_auto_enroll = false,
            auto_enroll_until = NULL, auto_enroll_assigned_at = NULL WHERE team_id = $1 AND user_id = $2`,
      [s.teamId, banned.userId],
    );
    const debtor = await enrollee(s, 2);
    for (let i = 0; i < 3; i += 1) await owes(debtor.userId, 'OVERDUE');
    const good = await enrollee(s, 3);
    const results = await autoEnrol(s, [banned, debtor, good]);
    expect(results.map((entry) => entry.outcome)).toEqual([
      { ok: false, reason: 'forbidden' },
      { ok: false, reason: 'overdue_payments' },
      { ok: true, status: 'CONFIRMED' },
    ]);
    expect((await readRegistrations(database.pool, s.sessionId)).map((row) => row.userId)).toEqual([
      good.userId,
    ]);
  });

  it('reports session_not_open and not_found for every entry when the session cannot take members', async () => {
    const s = await scene();
    const member = await enrollee(s, 1);
    clock.set(s.startsAt);
    expect((await autoEnrol(s, [member]))[0]?.outcome).toEqual({
      ok: false,
      reason: 'session_not_open',
    });
    clock.set(BASE);
    const missing = await run(s, 'auto_enrol', (trx, now) =>
      allocator.autoEnrolInSession(
        { trx, now, log: logs.logger },
        { teamId: s.teamId, sessionId: randomUUID(), entries: [member] },
      ),
    );
    expect(missing[0]?.outcome).toEqual({ ok: false, reason: 'not_found' });
    expect(await readRegistrations(database.pool, s.sessionId)).toEqual([]);
  });

  it('R2: a placed auto-enrol member releases the oldest owed late-withdrawal fee', async () => {
    const s = await scene({ maxPlayers: 3 });
    const owed = await insertMember(database.pool, s.teamId);
    await seedRow(s, owed, 1, {
      status: 'WITHDRAWN',
      feeDue: true,
      withdrawnAt: new Date(BASE.getTime() - 1_000),
    });
    const member = await enrollee(s, 1);
    await autoEnrol(s, [member]);
    expect(await readRegistration(database.pool, s.sessionId, owed)).toMatchObject({
      feeDue: false,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// AC-VERIFY-11: the pricing snapshot at every way into CONFIRMED
// ---------------------------------------------------------------------------------------------

describe('the registrant pricing snapshot (AC-VERIFY-11, R15)', () => {
  it('is written by register, promotion, auto-enrol and a confirmed re-registration, and never moves with later changes', async () => {
    const s = await scene({ maxPlayers: 4 });
    const priya = await insertMember(database.pool, s.teamId, {
      sex: 'FEMALE',
      skill: 'INTERMEDIATE',
    });
    // 1. immediate register
    await register(s, priya);
    // 2. waitlist promotion
    const full = await scene({ maxPlayers: 1 });
    const holder = await insertMember(database.pool, full.teamId);
    await register(full, holder);
    const promoted = await insertMember(database.pool, full.teamId, {
      sex: 'FEMALE',
      skill: 'INTERMEDIATE',
    });
    await register(full, promoted);
    expect(
      (await readRegistration(database.pool, full.sessionId, promoted))?.snapshotSkill,
    ).toBeNull();
    await withdraw(full, holder);
    // 3. auto-enrol
    const auto = await insertMember(database.pool, s.teamId, {
      sex: 'FEMALE',
      skill: 'INTERMEDIATE',
    });
    const at = new Date(BASE.getTime() - 1000);
    await setAutoEnroll(database.pool, {
      teamId: s.teamId,
      userId: auto,
      enabled: true,
      assignedAt: at,
    });
    await autoEnrol(s, [{ userId: auto, assignedAt: at }]);
    // 4. confirmed re-registration after an early withdrawal
    const again = await insertMember(database.pool, s.teamId, {
      sex: 'FEMALE',
      skill: 'INTERMEDIATE',
    });
    await register(s, again);
    await withdraw(s, again);
    await register(s, again);

    const check = async (
      sessionId: string,
      userId: string,
      sex: string,
      skill: string,
    ): Promise<void> => {
      expect(await readRegistration(database.pool, sessionId, userId)).toMatchObject({
        status: 'CONFIRMED',
        snapshotSex: sex,
        snapshotSkill: skill,
      });
    };
    for (const [sessionId, userId] of [
      [s.sessionId, priya],
      [full.sessionId, promoted],
      [s.sessionId, auto],
      [s.sessionId, again],
    ] as const)
      await check(sessionId, userId, 'FEMALE', 'INTERMEDIATE');

    // An admin override and a profile change afterwards leave every snapshot alone.
    for (const userId of [priya, promoted, auto, again]) {
      await database.pool.query(
        `UPDATE team_members SET skill_level = 'ADVANCED' WHERE user_id = $1`,
        [userId],
      );
      await database.pool.query(`UPDATE users SET sex = 'MALE' WHERE id = $1`, [userId]);
    }
    for (const [sessionId, userId] of [
      [s.sessionId, priya],
      [full.sessionId, promoted],
      [s.sessionId, auto],
      [s.sessionId, again],
    ] as const)
      await check(sessionId, userId, 'FEMALE', 'INTERMEDIATE');

    // A withdrawn row that is confirmed again re-takes the snapshot from the values at that moment.
    await withdraw(s, again);
    await register(s, again);
    await check(s.sessionId, again, 'MALE', 'ADVANCED');
  });

  it('a CHECK refuses a CONFIRMED row without the snapshot (SQLSTATE 23514)', async () => {
    const s = await scene();
    const userId = await insertMember(database.pool, s.teamId);
    await expectPgError(
      database.pool.query(
        `INSERT INTO registrations (session_id, team_id, user_id, status, registrant_sex, registrant_skill_level)
         VALUES ($1, $2, $3, 'CONFIRMED', NULL, NULL)`,
        [s.sessionId, s.teamId, userId],
      ),
      '23514',
      'registrations_registrant_snapshot',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// AC-VERIFY-3: lock order and shape, read from the real statements
// ---------------------------------------------------------------------------------------------

describe('statement order (AC-VERIFY-3)', () => {
  const MEMBER_SHARE = /from "team_members".* for share$/;
  const SESSION_LOCK = /from "game_sessions".* for update$/;
  const DEBT = /from "payments"/;
  const REG_READ = /from "registrations"/;
  const REG_WRITE = /^(insert into|update) "registrations"/;
  const GUEST_WRITE = /^(insert into|delete from) "registration_guests"/;

  async function trace<T>(work: () => Promise<T>): Promise<string[][]> {
    const mark = gate.statements.length;
    await work();
    const slice = gate.statements.slice(mark);
    expect(lockOrderViolations(slice)).toEqual([]);
    return transactionsOf(slice);
  }
  const first = (statements: string[], pattern: RegExp): number =>
    statements.findIndex((sql) => pattern.test(sql));

  it('register: lock timeout, debt read, member gate, session lock, registrations, then guests; nothing else locks', async () => {
    const s = await scene({ maxPlayers: 5 });
    const userId = await insertMember(database.pool, s.teamId);
    const [tx] = await trace(() => register(s, userId, guests(2)));
    const statements = tx ?? [];
    expect(statements[0]).toMatch(/^set local lock_timeout = 2000$/i);
    const order = [DEBT, MEMBER_SHARE, SESSION_LOCK, REG_READ, REG_WRITE, GUEST_WRITE].map(
      (pattern) => first(statements, pattern),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(
      statements.some(
        (sql) =>
          /for (update|no key update|share|key share)$/.test(sql) && /from "teams"/.test(sql),
      ),
    ).toBe(false);
    expect(statements.some((sql) => /^update "game_sessions"/.test(sql))).toBe(false);
    expect(statements.some((sql) => /pg_advisory|serializable/i.test(sql))).toBe(false);
  });

  it('withdraw and promoteWaitlist take the session lock first and no member lock', async () => {
    const s = await scene({ maxPlayers: 1 });
    const holder = await insertMember(database.pool, s.teamId);
    await register(s, holder);
    await register(s, await insertMember(database.pool, s.teamId));
    const [tx] = await trace(() => withdraw(s, holder));
    const statements = tx ?? [];
    expect(first(statements, SESSION_LOCK)).toBeLessThan(first(statements, REG_READ));
    expect(first(statements, MEMBER_SHARE)).toBe(-1);
    expect(first(statements, REG_WRITE)).toBeGreaterThan(first(statements, SESSION_LOCK));
    const [promoting] = await trace(() => promote(s));
    expect(first(promoting ?? [], MEMBER_SHARE)).toBe(-1);
    expect(first(promoting ?? [], SESSION_LOCK)).toBeGreaterThanOrEqual(0);
  });

  it('autoEnrolInSession gates every member (team_members FOR SHARE) before the one session lock', async () => {
    const s = await scene({ maxPlayers: 5 });
    const entries: { userId: string; assignedAt: Date }[] = [];
    for (let i = 0; i < 3; i += 1) {
      const userId = await insertMember(database.pool, s.teamId);
      const at = new Date(BASE.getTime() - 1000 * (10 - i));
      await setAutoEnroll(database.pool, {
        teamId: s.teamId,
        userId,
        enabled: true,
        assignedAt: at,
      });
      entries.push({ userId, assignedAt: at });
    }
    const [tx] = await trace(() => autoEnrol(s, entries));
    const statements = tx ?? [];
    const gates = statements
      .map((sql, index) => (MEMBER_SHARE.test(sql) ? index : -1))
      .filter((index) => index >= 0);
    expect(gates).toHaveLength(3);
    const sessionLocks = statements.filter((sql) => SESSION_LOCK.test(sql));
    expect(sessionLocks).toHaveLength(1);
    expect(Math.max(...gates)).toBeLessThan(first(statements, SESSION_LOCK));
    expect(first(statements, DEBT)).toBeLessThan(Math.min(...gates));
  });
});

// ---------------------------------------------------------------------------------------------
// AC-VERIFY-10, AC-VERIFY-6 (domain events), atomicity (P5)
// ---------------------------------------------------------------------------------------------

describe('side effects', () => {
  it('AC-VERIFY-10: no money row is written by any register, withdraw, promotion or auto-enrol', async () => {
    const before = await moneyRowCounts(database.pool);
    const s = await scene({ maxPlayers: 2 });
    const players: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      players.push(await insertMember(database.pool, s.teamId));
      await register(s, players[i] as string, guests(i % 2));
    }
    clock.set(new Date(s.deadline.getTime() + 1));
    await withdraw(s, players[0] as string);
    await withdraw(s, players[1] as string, 'ban');
    await promote(s);
    expect(await moneyRowCounts(database.pool)).toEqual(before);
  });

  it('AC-VERIFY-6: emits registration.* events with ids and enums only, never an email, name, guest name or team name', async () => {
    const s = await scene({ maxPlayers: 1 });
    const mark = logs.lines().length;
    const holder = await insertMember(database.pool, s.teamId, {
      email: 'secret-holder@example.test',
    });
    const waiting = await insertMember(database.pool, s.teamId, {
      email: 'secret-waiting@example.test',
    });
    await register(s, holder);
    await register(s, waiting, []);
    await register(s, holder);
    await withdraw(s, holder);
    const lines = logs
      .lines()
      .slice(mark)
      .filter((line) => typeof line.event === 'string' && line.event.startsWith('registration.'));
    const byEvent = (event: string) => lines.filter((line) => line.event === event);
    expect(byEvent('registration.created')[0]).toMatchObject({
      teamId: s.teamId,
      sessionId: s.sessionId,
      userId: holder,
      status: 'CONFIRMED',
      partySize: 1,
      source: 'MEMBER',
      reRegistration: false,
    });
    expect(byEvent('registration.created')[1]).toMatchObject({
      status: 'WAITLISTED',
      userId: waiting,
    });
    expect(byEvent('registration.refused')[0]).toMatchObject({
      reason: 'already_registered',
      userId: holder,
      sessionId: s.sessionId,
      teamId: s.teamId,
    });
    expect(byEvent('registration.withdrawn')[0]).toMatchObject({
      withdrawalKind: 'EARLY',
      feeDue: false,
      promotedCount: 1,
      wasConfirmed: true,
      userId: holder,
    });
    expect(byEvent('registration.promoted')[0]).toMatchObject({
      userId: waiting,
      sessionId: s.sessionId,
      cause: 'withdrawal',
    });
    const text = JSON.stringify(lines);
    expect(text).not.toMatch(/@example\.test|Test Player|Ana|Test Hall/);
    expect(lines.some((line) => 'code' in line)).toBe(false);
  });

  it('P5: the promotion email commits with the promotion and a rolled-back promotion leaves no job and no change', async () => {
    const s = await scene({ maxPlayers: 1 });
    const holder = await insertMember(database.pool, s.teamId);
    const waiting = await insertMember(database.pool, s.teamId, { email: 'atomic@example.test' });
    await register(s, holder);
    await register(s, waiting);
    const jobCount = async (): Promise<number> => {
      const { rows } = await database.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'send-email' AND data->>'to' = 'atomic@example.test'`,
      );
      return rows[0]?.n ?? 0;
    };
    await expect(
      run(s, 'withdraw', async (trx, now) => {
        await allocator.withdrawFromSession(
          { trx, now, log: logs.logger },
          { teamId: s.teamId, sessionId: s.sessionId, userId: holder, cause: 'player' },
        );
        throw new Error('abort after the promotion');
      }),
    ).rejects.toThrow('abort after the promotion');
    expect(await jobCount()).toBe(0);
    expect((await readRegistration(database.pool, s.sessionId, waiting))?.status).toBe(
      'WAITLISTED',
    );
    expect((await readRegistration(database.pool, s.sessionId, holder))?.status).toBe('CONFIRMED');
    await withdraw(s, holder);
    expect(await jobCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-VERIFY-4: random sequences against the real rows
// ---------------------------------------------------------------------------------------------

describe('seat accounting under random sequences (AC-VERIFY-4)', () => {
  function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it.each([11, 29, 47])(
    'seed %i: seats never exceed capacity, positions stay unique and strictly increasing, nobody waitlisted fits',
    async (seed) => {
      const random = mulberry32(seed);
      const capacity = 4 + Math.floor(random() * 5);
      const s = await scene({ maxPlayers: capacity });
      const members: string[] = [];
      for (let i = 0; i < 12; i += 1) members.push(await insertMember(database.pool, s.teamId));
      for (let step = 0; step < 40; step += 1) {
        const userId = members[Math.floor(random() * members.length)] as string;
        const row = await readRegistration(database.pool, s.sessionId, userId);
        const roll = random();
        clock.advance(1_000);
        if (row === undefined || row.status === 'WITHDRAWN' ? roll < 0.8 : roll < 0.3) {
          if (row === undefined || row.status === 'WITHDRAWN')
            await register(s, userId, guests(Math.floor(random() * 3)));
        } else if (row !== undefined && row.status !== 'WITHDRAWN') {
          await withdraw(s, userId, random() < 0.2 ? 'ban' : 'player');
        }
        const rows = await readRegistrations(database.pool, s.sessionId);
        const seats = await sqlSeats(database.pool, s.sessionId);
        expect(seats.seatsTaken).toBeLessThanOrEqual(seats.capacity);
        expect(
          rows.filter((r) => r.status === 'CONFIRMED').reduce((sum, r) => sum + sizeOfRow(r), 0),
        ).toBe(seats.seatsTaken);
        expect(new Set(seats.waitlistPositions).size).toBe(seats.waitlistPositions.length);
        expect(seats.waitlistPositions).toEqual([...seats.waitlistPositions].sort((a, b) => a - b));
        const free = seats.capacity - seats.seatsTaken;
        for (const waiting of rows.filter((r) => r.status === 'WAITLISTED'))
          expect(sizeOfRow(waiting)).toBeGreaterThan(free);
        const owed = rows
          .filter((r) => r.status === 'WITHDRAWN' && r.feeDue)
          .reduce((sum, r) => sum + sizeOfRow(r), 0);
        expect(owed).toBeLessThanOrEqual(free);
      }
    },
  );
});

// Keep the helper types referenced so an unused-import lint cannot hide a mistake in the matrix builders.
export type { MatrixParty };
