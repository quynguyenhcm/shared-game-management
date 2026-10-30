/**
 * The billing hand-off (AC-INTEGRATION-3, AC-VERIFY-10, AC-VERIFY-11 hand-off half; R7, ADR 0018 C-BIL). Rows are produced by
 * the real allocator, so the flags the hand-off reads are the ones a real session ends with. A test-only billing stand-in
 * then writes one valid `payments` row (with line items) per returned registration, which proves the hand-off carries
 * enough for billing: the deferred `payment_lines_match_header` check passes at COMMIT.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Transaction } from 'kysely';
import { createJobRunner, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import { QUEUES } from '../../src/jobs/registry.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import type { DB } from '../../src/lib/db/types.generated.ts';
import { createAllocator, type GuestInput } from '../../src/modules/registrations/allocator.ts';
import {
  BillingHandoffError,
  listBillableRegistrations,
} from '../../src/modules/registrations/billing-handoff.ts';
import { HTTP_POLICY, runAllocatorTransaction } from '../../src/modules/registrations/tx.ts';
import {
  advanceSessionTo,
  insertPaymentRows,
  insertPublishedSession,
  insertSession,
  insertTeamMember,
} from '../helpers/factories.ts';
import { waitForLockWaiters } from '../helpers/lock-waiters.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import {
  createRecordingJobs,
  insertMember,
  moneyRowCounts,
  readRegistration,
} from '../helpers/registration-scene.ts';
import { createTestDatabase, inTransaction, type TestDatabase } from '../helpers/test-db.ts';

const BASE = new Date('2026-10-20T00:00:00.000Z');

let database: TestDatabase;
let worker: JobRunner;
const logs = captureLogs();
const clock = createManualClock(BASE);
const kysely = () => createKysely(database.pool);
let allocator: ReturnType<typeof createAllocator>;

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 10 });
  worker = createJobRunner({
    databaseUrl: database.url,
    logger: captureLogs().logger,
    role: 'worker',
  });
  await worker.start();
  for (const queue of QUEUES) await worker.defineQueue(queue);
  allocator = createAllocator({
    jobs: createRecordingJobs(),
    webBaseUrl: 'https://games.example.nz',
  });
});
afterAll(async () => {
  await worker.stop();
  await database.close();
});
beforeEach(() => {
  clock.set(BASE);
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

const guestsOf = (count: number): GuestInput[] =>
  Array.from({ length: count }, (_, index) => ({
    sex: index === 0 ? 'FEMALE' : 'OTHER',
    skillLevel: index === 0 ? 'ADVANCED' : 'INTERMEDIATE',
    displayName: null,
  }));

const run = <T>(s: Scene, work: (trx: Transaction<DB>, now: Date) => Promise<T>): Promise<T> =>
  runAllocatorTransaction(
    kysely(),
    HTTP_POLICY,
    { clock, teamId: s.teamId, path: 'test' },
    ({ trx, now }) => work(trx, now),
  );

const register = (s: Scene, userId: string, guests: readonly GuestInput[] = []) =>
  run(s, (trx, now) =>
    allocator.registerInSession(
      { trx, now, log: logs.logger },
      { teamId: s.teamId, sessionId: s.sessionId, userId, guests },
    ),
  );

const withdraw = (s: Scene, userId: string, cause: 'player' | 'ban' = 'player') =>
  run(s, (trx, now) =>
    allocator.withdrawFromSession(
      { trx, now, log: logs.logger },
      { teamId: s.teamId, sessionId: s.sessionId, userId, cause },
    ),
  );

/** Billing's shape: its own transaction, read at (or after) `starts_at`. */
const billAt = (sessionId: string, now: Date) =>
  kysely()
    .transaction()
    .execute((trx) => listBillableRegistrations(trx, sessionId, now));
const bill = (s: Scene, now: Date = s.startsAt) => billAt(s.sessionId, now);

describe('listBillableRegistrations (AC-INTEGRATION-3)', () => {
  /** Session 1: confirmed parties, a promotion after the deadline, an early withdrawal, a refilled late withdrawal, a ban, a waitlisted party that never got in. */
  async function sessionOne() {
    const s = await scene(6);
    const people = {
      c1: await insertMember(database.pool, s.teamId, { sex: 'FEMALE', skill: 'INTERMEDIATE' }),
      early: await insertMember(database.pool, s.teamId),
      refilled: await insertMember(database.pool, s.teamId),
      banned: await insertMember(database.pool, s.teamId),
      y: await insertMember(database.pool, s.teamId),
      z: await insertMember(database.pool, s.teamId),
      p0: await insertMember(database.pool, s.teamId),
      p1: await insertMember(database.pool, s.teamId, { sex: 'OTHER', skill: 'ADVANCED' }),
      w: await insertMember(database.pool, s.teamId),
    };
    for (const key of ['c1', 'early', 'refilled', 'banned', 'y', 'z'] as const) {
      clock.advance(1_000);
      await register(s, people[key]);
    }
    for (const [key, size] of [
      ['p0', 0],
      ['p1', 0],
      ['w', 2],
    ] as const) {
      clock.advance(1_000);
      await register(s, people[key], guestsOf(size));
    }
    clock.set(new Date(s.deadline.getTime() - 60_000));
    await withdraw(s, people.early); // EARLY: promotes p0 before the deadline
    clock.set(new Date(s.deadline.getTime() + 60_000));
    await withdraw(s, people.refilled); // LATE: promotes p1 AFTER the deadline, so the fee moves to p1
    await withdraw(s, people.banned, 'ban'); // BANNED: free 1 seat, the party of 3 still cannot fit
    return { s, people };
  }

  it('returns the CONFIRMED rows and nothing else (early, refilled-late, banned and waitlisted rows are excluded)', async () => {
    const { s, people } = await sessionOne();
    clock.set(s.startsAt);
    const billable = await bill(s);
    const byUser = new Map(billable.map((row) => [row.userId, row]));
    expect([...byUser.keys()].sort()).toEqual(
      [people.c1, people.y, people.z, people.p0, people.p1].sort(),
    );
    for (const row of billable) {
      expect(row).toMatchObject({ teamId: s.teamId, reason: 'CONFIRMED' });
      expect(Object.keys(row).sort()).toEqual([
        'guests',
        'reason',
        'registrantSex',
        'registrantSkillLevel',
        'registrationId',
        'teamId',
        'userId',
      ]);
    }
    expect(byUser.get(people.p1)).toMatchObject({
      registrantSex: 'OTHER',
      registrantSkillLevel: 'ADVANCED',
    });
    // Ordered by registered_at then id.
    const rows = await database.pool.query<{ user_id: string }>(
      `SELECT user_id FROM registrations WHERE session_id = $1 AND status = 'CONFIRMED' ORDER BY registered_at, id`,
      [s.sessionId],
    );
    expect(billable.map((row) => row.userId)).toEqual(rows.rows.map((row) => row.user_id));
  });

  it('includes a fee-due LATE withdrawal with its guests, and drops one released by a later newcomer (oldest first)', async () => {
    const s = await scene(8);
    const released = await insertMember(database.pool, s.teamId);
    const owing = await insertMember(database.pool, s.teamId, { sex: 'FEMALE', skill: 'ADVANCED' });
    await register(s, released);
    clock.advance(1_000);
    await register(s, owing, guestsOf(2));
    clock.set(new Date(s.deadline.getTime() + 60_000));
    await withdraw(s, released);
    clock.advance(1_000);
    await withdraw(s, owing);
    expect(await bill(s)).toMatchObject([
      { userId: released, reason: 'LATE_WITHDRAWAL' },
      { userId: owing, reason: 'LATE_WITHDRAWAL' },
    ]);
    // A newcomer confirms 1 seat: the OLDEST owed fee is released, the other stays.
    const newcomer = await insertMember(database.pool, s.teamId);
    clock.advance(1_000);
    await register(s, newcomer);
    const billable = await bill(s);
    expect(billable.map((row) => [row.userId, row.reason])).toEqual([
      [owing, 'LATE_WITHDRAWAL'],
      [newcomer, 'CONFIRMED'],
    ]);
    const late = billable[0];
    expect(late?.registrantSex).toBe('FEMALE');
    expect(late?.registrantSkillLevel).toBe('ADVANCED');
    expect(
      late?.guests.map(({ position, sex, skillLevel }) => ({ position, sex, skillLevel })),
    ).toEqual([
      { position: 1, sex: 'FEMALE', skillLevel: 'ADVANCED' },
      { position: 2, sex: 'OTHER', skillLevel: 'INTERMEDIATE' },
    ]);
    for (const guest of late?.guests ?? []) expect(guest.guestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('R2/R3: a fee-due B re-registering into the seat it freed leaves A still billable (the refilled seat clears one fee, not two)', async () => {
    const s = await scene(2);
    const a = await insertMember(database.pool, s.teamId);
    const b = await insertMember(database.pool, s.teamId);
    await register(s, a);
    clock.advance(1_000);
    await register(s, b);
    clock.set(new Date(s.deadline.getTime() + 60_000));
    await withdraw(s, a); // LATE, nobody behind: owes
    clock.advance(1_000);
    await withdraw(s, b); // LATE, nobody behind: owes
    await register(s, b); // B re-registers into the freed seats: its own fee clears
    const billable = (await bill(s)).map((row) => [row.userId, row.reason]);
    expect(billable).toContainEqual([a, 'LATE_WITHDRAWAL']);
    expect(billable).toContainEqual([b, 'CONFIRMED']);
  });

  it('AC-VERIFY-11: returns the snapshot taken at confirmation, not the member level or sex at charge time', async () => {
    const s = await scene(4);
    const priya = await insertMember(database.pool, s.teamId, {
      sex: 'FEMALE',
      skill: 'INTERMEDIATE',
    });
    await register(s, priya);
    await database.pool.query(
      `UPDATE team_members SET skill_level = 'ADVANCED' WHERE user_id = $1`,
      [priya],
    );
    await database.pool.query(`UPDATE users SET sex = 'MALE' WHERE id = $1`, [priya]);
    clock.set(s.startsAt);
    const [row] = await bill(s);
    expect(row).toMatchObject({ registrantSex: 'FEMALE', registrantSkillLevel: 'INTERMEDIATE' });
  });

  it('is empty for a CANCELLED, DRAFT or unknown session', async () => {
    const s = await scene(4);
    await register(s, await insertMember(database.pool, s.teamId));
    expect(await bill(s)).toHaveLength(1);
    await advanceSessionTo(database.pool, s.sessionId, 'CANCELLED');
    expect(await bill(s)).toEqual([]);
    const draft = await insertSession(database.pool, s.teamId, {}, { status: 'DRAFT' });
    expect(await billAt(draft, s.startsAt)).toEqual([]);
    expect(await billAt('00000000-0000-4000-8000-000000000000', s.startsAt)).toEqual([]);
  });

  it('C2: refuses a read before starts_at (R7), with a typed error, and allows exactly starts_at', async () => {
    const s = await scene(4);
    await register(s, await insertMember(database.pool, s.teamId));
    const early = new Date(s.startsAt.getTime() - 1);
    await expect(bill(s, early)).rejects.toBeInstanceOf(BillingHandoffError);
    await expect(bill(s, early)).rejects.toMatchObject({ reason: 'before_start' });
    expect(await bill(s, s.startsAt)).toHaveLength(1);
  });

  it('C2: refuses a pool handle: the read must sit inside the caller transaction', async () => {
    const s = await scene(4);
    await expect(
      listBillableRegistrations(kysely() as unknown as Transaction<DB>, s.sessionId, s.startsAt),
    ).rejects.toMatchObject({ name: 'BillingHandoffError', reason: 'not_in_transaction' });
  });

  it('C2: a cancellation in flight commits first, so the read (which waits on the session row) sees the cancelled session and returns nothing', async () => {
    const s = await scene(4);
    await register(s, await insertMember(database.pool, s.teamId));
    const holder = await database.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM game_sessions WHERE id = $1 FOR UPDATE', [s.sessionId]);
      const pending = bill(s);
      await waitForLockWaiters(database.pool, 1, 'billing read blocked on the session row');
      await holder.query(`UPDATE game_sessions SET status = 'CANCELLED' WHERE id = $1`, [
        s.sessionId,
      ]);
      await holder.query('COMMIT');
      expect(await pending).toEqual([]);
    } finally {
      holder.release();
    }
  });

  it('is still the same list for a COMPLETED session (billing completes the session, then bills)', async () => {
    const s = await scene(4);
    await register(s, await insertMember(database.pool, s.teamId));
    clock.set(s.startsAt);
    const before = await bill(s);
    await advanceSessionTo(database.pool, s.sessionId, 'COMPLETED');
    expect(await bill(s)).toEqual(before);
  });

  it('carries enough for billing: a stand-in writes one valid payment with lines per returned registration (AC-VERIFY-10 counts the stand-in only)', async () => {
    const { s } = await sessionOne();
    clock.set(s.startsAt);
    const billable = await bill(s);
    expect(billable.length).toBeGreaterThan(0);
    const before = await moneyRowCounts(database.pool);
    for (const row of billable) {
      await inTransaction(database.pool, (client) =>
        insertPaymentRows(client, {
          userId: row.userId,
          teamId: row.teamId,
          registrationId: row.registrationId,
          amount: (17 * (1 + row.guests.length)).toFixed(2),
          lines: [
            {
              position: 0,
              basis: 'FLAT',
              sex: row.registrantSex,
              skill: row.registrantSkillLevel,
              unitFee: '17.00',
            },
            ...row.guests.map((guest) => ({
              position: guest.position,
              basis: 'FLAT',
              sex: guest.sex,
              skill: guest.skillLevel,
              unitFee: '17.00',
              guestId: guest.guestId,
            })),
          ],
        }),
      );
    }
    const after = await moneyRowCounts(database.pool);
    expect(after.payments).toBe((before.payments ?? 0) + billable.length);
    // The allocator and the hand-off wrote none of them: the stand-in did, once per returned registration.
    expect(after.payment_line_items).toBeGreaterThanOrEqual(
      (before.payment_line_items ?? 0) + billable.length,
    );
    // The rows the hand-off read are untouched by billing.
    expect(
      (await readRegistration(database.pool, s.sessionId, billable[0]?.userId ?? ''))?.status,
    ).toBe('CONFIRMED');
  });

  describe('O6: a registrant banned in the team at or before starts_at is never billed (ADR 0018 C3 mitigation)', () => {
    /**
     * The C3 residual straight in the database: the member is BANNED while their row is still CONFIRMED or owes a late fee,
     * because the `member-banned` job and the sweep never succeeded before the start. `banned_by` is the member's own id
     * (any user satisfies D-41); the ban hook is deliberately not run.
     */
    const banAt = (teamId: string, userId: string, at: Date) =>
      database.pool.query(
        `UPDATE team_members SET status = 'BANNED', banned_at = $3, banned_by = user_id, ban_reason = 'Test ban'
          WHERE team_id = $1 AND user_id = $2`,
        [teamId, userId, at],
      );
    const users = (rows: readonly { userId: string; reason: string }[]) =>
      rows.map((row) => [row.userId, row.reason]);

    it('excludes a CONFIRMED row banned before the start and one banned exactly at starts_at; other members are billed', async () => {
      const s = await scene(6);
      const [kept, bannedBefore, bannedAtStart] = [
        await insertMember(database.pool, s.teamId),
        await insertMember(database.pool, s.teamId),
        await insertMember(database.pool, s.teamId),
      ];
      for (const userId of [kept, bannedBefore, bannedAtStart]) {
        clock.advance(1_000);
        await register(s, userId);
      }
      await banAt(s.teamId, bannedBefore, new Date(s.startsAt.getTime() - 3_600_000));
      await banAt(s.teamId, bannedAtStart, s.startsAt);
      // The rows are still CONFIRMED: no handler ran, which is exactly the residual.
      expect((await readRegistration(database.pool, s.sessionId, bannedBefore))?.status).toBe(
        'CONFIRMED',
      );
      expect(users(await bill(s))).toEqual([[kept, 'CONFIRMED']]);
    });

    it('excludes a fee-due LATE withdrawal whose registrant was banned before the start', async () => {
      const s = await scene(4);
      const kept = await insertMember(database.pool, s.teamId);
      const owing = await insertMember(database.pool, s.teamId);
      const stillOwing = await insertMember(database.pool, s.teamId);
      for (const userId of [kept, owing, stillOwing]) {
        clock.advance(1_000);
        await register(s, userId);
      }
      clock.set(new Date(s.deadline.getTime() + 60_000));
      await withdraw(s, owing);
      clock.advance(1_000);
      await withdraw(s, stillOwing);
      expect(users(await bill(s))).toEqual([
        [kept, 'CONFIRMED'],
        [owing, 'LATE_WITHDRAWAL'],
        [stillOwing, 'LATE_WITHDRAWAL'],
      ]);
      await banAt(s.teamId, owing, new Date(s.deadline.getTime() + 120_000));
      expect(users(await bill(s))).toEqual([
        [kept, 'CONFIRMED'],
        [stillOwing, 'LATE_WITHDRAWAL'],
      ]);
    });

    it('still bills a registrant banned after starts_at (billing is final at the start)', async () => {
      const s = await scene(4);
      const kept = await insertMember(database.pool, s.teamId);
      const bannedLater = await insertMember(database.pool, s.teamId);
      await register(s, kept);
      clock.advance(1_000);
      await register(s, bannedLater);
      const atStart = await bill(s);
      await banAt(s.teamId, bannedLater, new Date(s.startsAt.getTime() + 1));
      const later = new Date(s.startsAt.getTime() + 60_000);
      expect(await bill(s, later)).toEqual(atStart);
      expect(users(atStart)).toEqual([
        [kept, 'CONFIRMED'],
        [bannedLater, 'CONFIRMED'],
      ]);
    });

    it('excludes a banned-before-start registrant with a guest: neither the registration nor its guest is billed', async () => {
      const s = await scene(6);
      const kept = await insertMember(database.pool, s.teamId);
      const host = await insertMember(database.pool, s.teamId);
      await register(s, kept);
      clock.advance(1_000);
      await register(s, host, guestsOf(1));
      const before = await bill(s);
      expect(before.find((row) => row.userId === host)?.guests).toHaveLength(1);
      await banAt(s.teamId, host, new Date(s.startsAt.getTime() - 3_600_000));
      const billable = await bill(s);
      expect(users(billable)).toEqual([[kept, 'CONFIRMED']]);
      // Guests ride only on their registration: no guest of the banned party appears anywhere in the list.
      expect(billable.flatMap((row) => row.guests)).toEqual([]);
    });

    it('is scoped to the session team: a ban in another team does not exclude the row', async () => {
      const s = await scene(4);
      const other = await scene(4);
      const member = await insertMember(database.pool, s.teamId);
      await insertTeamMember(database.pool, { teamId: other.teamId, userId: member });
      await register(s, member);
      await banAt(other.teamId, member, new Date(s.startsAt.getTime() - 3_600_000));
      expect(users(await bill(s))).toEqual([[member, 'CONFIRMED']]);
    });
  });

  it('AC-VERIFY-10: the allocator and the hand-off write no money row', async () => {
    const before = await moneyRowCounts(database.pool);
    const s = await scene(3);
    for (let i = 0; i < 3; i += 1) await register(s, await insertMember(database.pool, s.teamId));
    await bill(s);
    expect(await moneyRowCounts(database.pool)).toEqual(before);
  });
});
