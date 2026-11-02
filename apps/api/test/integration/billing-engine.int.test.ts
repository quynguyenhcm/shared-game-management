/**
 * The post-game billing engine on a real PostgreSQL and a real pg-boss producer (wallet-and-akahu-billing Phase 2):
 * AC-HAPPY-2, 3, 5, 6, 7, 11, AC-ASYNC-1, AC-ERROR-5, 9, AC-VERIFY-4, 5, 6 and AC-INTEGRATION-2 (registrations produced by the
 * real allocator, never seeded payments). Every email is read back from the job it was enqueued as: all of them are sealed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { registerJobs } from '../../src/jobs/bootstrap.ts';
import { QUEUES } from '../../src/jobs/registry.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import { createJobRunner, type EnqueueOptions, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import { createInMemoryNotifier } from '../../src/lib/notifications/adapters/in-memory.ts';
import type { EmailMessage } from '../../src/lib/notifications/notifier.ts';
import { billSession, type BillSessionDeps } from '../../src/modules/billing/bill-session.ts';
import { runPostGameBillingSweep } from '../../src/modules/billing/sweep.ts';
import { createAllocator, type GuestInput } from '../../src/modules/registrations/allocator.ts';
import { HTTP_POLICY, runAllocatorTransaction } from '../../src/modules/registrations/tx.ts';
import { noopSessionAllocator } from '../../src/modules/sessions/allocator-port.ts';
import { testCrypto } from '../helpers/app-deps.ts';
import {
  advanceSessionTo,
  insertRegistration,
  insertGuest,
  insertPublishedSession,
  insertTeam,
  insertTeamMember,
  insertUser,
  insertWallet,
  type SessionFees,
} from '../helpers/factories.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import {
  createRecordingJobs,
  insertMember,
  readRegistration,
  type RecordingJobs,
} from '../helpers/registration-scene.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';
import { waitFor } from '../helpers/wait-for.ts';

const BASE = new Date('2026-10-20T00:00:00.000Z');
const WEB = 'https://games.example.nz';
const HOUR = 3_600_000;

const crypto = testCrypto();
const clock = createManualClock(BASE);

let database: TestDatabase;
let worker: JobRunner;
let jobs: RecordingJobs;
const logs = captureLogs();

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 10 });
  worker = createJobRunner({
    databaseUrl: database.url,
    logger: captureLogs().logger,
    role: 'worker',
  });
  await worker.start();
  for (const queue of QUEUES) await worker.defineQueue(queue);
});
afterAll(async () => {
  await worker.stop();
  await database.close();
});
beforeEach(() => {
  clock.set(BASE);
  jobs = createRecordingJobs(worker);
});

const kysely = () => createKysely(database.pool);
const deps = (overrides: Partial<BillSessionDeps> = {}): BillSessionDeps => ({
  db: kysely(),
  jobs,
  clock,
  crypto,
  webBaseUrl: WEB,
  log: logs.logger,
  ...overrides,
});
const bill = (sessionId: string, overrides: Partial<BillSessionDeps> = {}) =>
  billSession(deps(overrides), { sessionId });

/** The message of every `send-email` job the recorder saw, opened with the same keyring the sender uses. */
function emails(recorder: RecordingJobs = jobs): EmailMessage[] {
  return recorder.recorded
    .filter((job) => job.queue === 'send-email')
    .map((job) => {
      const data = job.data as { idempotencyKey: string; sealed?: string };
      expect(data.sealed, 'every billing email is sealed').toBeTypeOf('string');
      return JSON.parse(
        crypto.decrypt(data.sealed as string, {
          table: 'pgboss.job',
          column: 'data.send-email',
          rowId: data.idempotencyKey,
        }),
      ) as EmailMessage;
    });
}
const subjectsOf = (list: readonly EmailMessage[]): string[] => list.map((email) => email.subject);

const allocator = createAllocator({ jobs: createRecordingJobs(), webBaseUrl: WEB });

/** A registration through the real allocator, in its own transaction, at the test clock's `now`. */
const registerParty = (
  pool: pg.Pool,
  s: Pick<Scene, 'teamId' | 'sessionId'>,
  userId: string,
  guests: readonly GuestInput[] = [],
) =>
  runAllocatorTransaction(
    createKysely(pool),
    HTTP_POLICY,
    { clock, teamId: s.teamId, path: 'test' },
    ({ trx, now }) =>
      allocator.registerInSession(
        { trx, now, log: logs.logger },
        { teamId: s.teamId, sessionId: s.sessionId, userId, guests },
      ),
  );
const guest = (sex: GuestInput['sex'], skillLevel: GuestInput['skillLevel']): GuestInput => ({
  sex,
  skillLevel,
  displayName: null,
});

interface Scene {
  readonly teamId: string;
  readonly sessionId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly deadline: Date;
}

interface SceneOptions extends SessionFees {
  readonly maxPlayers?: number;
  readonly teamName?: string;
  readonly gstRegistered?: boolean;
  readonly gstNumber?: string;
  readonly startsInHours?: number;
  readonly now?: Date;
}

async function readTimes(sessionId: string) {
  const { rows } = await database.pool.query<{
    starts_at: Date;
    ends_at: Date;
    cancellation_deadline: Date;
  }>(`SELECT starts_at, ends_at, cancellation_deadline FROM game_sessions WHERE id = $1`, [
    sessionId,
  ]);
  const row = rows[0];
  if (row === undefined) throw new Error('session not found');
  return { startsAt: row.starts_at, endsAt: row.ends_at, deadline: row.cancellation_deadline };
}

async function scene(options: SceneOptions = {}): Promise<Scene> {
  const teamId = await insertTeam(database.pool, {
    payoutConfigured: true,
    name: options.teamName ?? 'Tuesday Smashers',
    ...(options.gstRegistered === undefined ? {} : { gstRegistered: options.gstRegistered }),
    ...(options.gstNumber === undefined ? {} : { gstNumber: options.gstNumber }),
  });
  const { sessionId } = await insertPublishedSession(database.pool, teamId, {
    now: options.now ?? BASE,
    ...options,
  });
  return { teamId, sessionId, ...(await readTimes(sessionId)) };
}

/** A CONFIRMED registrant in `s`, optionally with a wallet. */
async function player(s: Scene, wallet?: string, guests = 0) {
  const userId = await insertMember(database.pool, s.teamId);
  const registrationId = await insertRegistration(database.pool, {
    sessionId: s.sessionId,
    teamId: s.teamId,
    userId,
    guestCount: guests,
  });
  for (let position = 1; position <= guests; position += 1) {
    await insertGuest(database.pool, registrationId, position);
  }
  if (wallet !== undefined) await insertWallet(database.pool, userId, s.teamId, wallet);
  return { userId, registrationId };
}

interface PaymentRow {
  id: string;
  user_id: string;
  registration_id: string;
  billing_type: string;
  status: string;
  amount: string;
  pricing_structure: string;
  gst_registered: boolean;
  gst_rate_bps: number;
  gst_number: string | null;
  gst_amount: string;
  paid_at: Date | null;
  due_date: Date;
  payment_reference: string;
  akahu_payment_id: string | null;
}

async function paymentsOf(sessionId: string): Promise<PaymentRow[]> {
  const { rows } = await database.pool.query<PaymentRow>(
    `SELECT p.* FROM payments p JOIN registrations r ON r.id = p.registration_id
      WHERE r.session_id = $1 ORDER BY r.registered_at, r.id`,
    [sessionId],
  );
  return rows;
}

const paymentOf = async (sessionId: string, userId: string): Promise<PaymentRow> => {
  const row = (await paymentsOf(sessionId)).find((candidate) => candidate.user_id === userId);
  if (row === undefined) throw new Error(`no payment for ${userId}`);
  return row;
};

async function linesOf(paymentId: string) {
  const { rows } = await database.pool.query<{
    party_position: number;
    registration_guest_id: string | null;
    applied_basis: string;
    party_sex: string;
    party_skill_level: string;
    unit_fee: string;
  }>(
    `SELECT party_position, registration_guest_id, applied_basis, party_sex, party_skill_level, unit_fee
       FROM payment_line_items WHERE payment_id = $1 ORDER BY party_position`,
    [paymentId],
  );
  return rows;
}

async function ledgerOf(userId: string, teamId: string) {
  const { rows } = await database.pool.query<{
    amount: string;
    transaction_type: string;
    resulting_balance: string;
    registration_id: string | null;
    akahu_payment_id: string | null;
  }>(
    `SELECT amount, transaction_type, resulting_balance, registration_id, akahu_payment_id
       FROM credit_transactions WHERE user_id = $1 AND team_id = $2 ORDER BY created_at, id`,
    [userId, teamId],
  );
  return rows;
}

async function balanceOf(userId: string, teamId: string): Promise<string | null> {
  const { rows } = await database.pool.query<{ balance: string }>(
    `SELECT balance FROM player_credits WHERE user_id = $1 AND team_id = $2`,
    [userId, teamId],
  );
  return rows[0]?.balance ?? null;
}

async function statusOf(sessionId: string): Promise<string> {
  const { rows } = await database.pool.query<{ status: string }>(
    `SELECT status FROM game_sessions WHERE id = $1`,
    [sessionId],
  );
  return rows[0]?.status ?? 'MISSING';
}

async function count(pool: pg.Pool, table: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0]?.n ?? 0;
}

describe('AC-HAPPY-2: the fee is taken from a wallet that covers it', () => {
  it('completes the session, writes one PAID PREPAID_CREDIT payment, one ledger row and the low-credit email', async () => {
    const s = await scene();
    const a = await player(s, '30.00');
    clock.set(s.endsAt);

    expect(await bill(s.sessionId)).toMatchObject({
      kind: 'completed',
      payments: 1,
      deducted: 1,
      linked: 0,
      zero: 0,
    });

    expect(await statusOf(s.sessionId)).toBe('COMPLETED');
    const payment = await paymentOf(s.sessionId, a.userId);
    expect(payment).toMatchObject({
      billing_type: 'PREPAID_CREDIT',
      status: 'PAID',
      amount: '17.00',
      pricing_structure: 'FLAT',
      akahu_payment_id: null,
    });
    expect(payment.paid_at).toEqual(s.endsAt); // the job's `now`
    expect(payment.payment_reference).toMatch(/^SGM[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(await linesOf(payment.id)).toMatchObject([
      { party_position: 0, registration_guest_id: null, applied_basis: 'FLAT', unit_fee: '17.00' },
    ]);
    expect(await ledgerOf(a.userId, s.teamId)).toMatchObject([
      { transaction_type: 'TOPUP', amount: '30.00', resulting_balance: '30.00' },
      {
        transaction_type: 'AUTO_DEDUCTION',
        amount: '-17.00',
        resulting_balance: '13.00',
        registration_id: a.registrationId,
      },
    ]);
    expect(await balanceOf(a.userId, s.teamId)).toBe('13.00');

    // No Akahu call exists in this phase; no payment-due email; the balance fell under $20.00, so one low-credit email.
    const sent = emails();
    expect(subjectsOf(sent)).toEqual(['Your Tuesday Smashers wallet is running low ($13.00)']);
    expect(sent[0]?.idempotencyKey).toMatch(/^low-credit:/);
    expect(jobs.recorded.every((job) => job.inTransaction)).toBe(true);
  });

  it('a redelivered job finds the session COMPLETED and changes and sends nothing (replay no-op)', async () => {
    const s = await scene();
    await player(s, '30.00');
    clock.set(s.endsAt);
    await bill(s.sessionId);
    const emailsBefore = emails().length;
    const before = [
      await count(database.pool, 'payments'),
      await count(database.pool, 'credit_transactions'),
    ];

    expect(await bill(s.sessionId)).toMatchObject({ kind: 'skipped', reason: 'not_published' });

    expect(emails()).toHaveLength(emailsBefore);
    expect([
      await count(database.pool, 'payments'),
      await count(database.pool, 'credit_transactions'),
    ]).toEqual(before);
  });

  it('two workers billing the same session at once produce one COMPLETED move and one payment per registration (AC-INTEGRATION-3, billing half)', async () => {
    const s = await scene();
    const a = await player(s, '30.00');
    const b = await player(s);
    clock.set(s.endsAt);

    const outcomes = await Promise.all([bill(s.sessionId), bill(s.sessionId)]);

    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['completed', 'skipped']);
    expect(await paymentsOf(s.sessionId)).toHaveLength(2);
    expect(await ledgerOf(a.userId, s.teamId)).toHaveLength(2); // the top-up and ONE deduction
    expect(await balanceOf(b.userId, s.teamId)).toBeNull(); // billing never creates a wallet
  });
});

describe('AC-HAPPY-3: without enough credit a pay-by-bank charge is created, due 72 hours later', () => {
  it('creates PENDING PER_GAME payments with a sealed payment-due email, takes nothing from the wallet', async () => {
    const s = await scene();
    const b = await player(s, '10.00');
    const c = await player(s);
    clock.set(new Date(s.endsAt.getTime() + 90_000));
    const billedAt = clock.now();

    expect(await bill(s.sessionId)).toMatchObject({
      kind: 'completed',
      payments: 2,
      deducted: 0,
      linked: 2,
    });

    for (const user of [b, c]) {
      const payment = await paymentOf(s.sessionId, user.userId);
      expect(payment).toMatchObject({
        billing_type: 'PER_GAME',
        status: 'PENDING',
        amount: '17.00',
        paid_at: null,
        akahu_payment_id: null,
      });
      expect(payment.due_date).toEqual(new Date(billedAt.getTime() + 72 * HOUR)); // B2, from the billing instant
    }
    // No partial deduction: B's wallet is untouched (only its seeding top-up), C never got a wallet.
    expect(await balanceOf(b.userId, s.teamId)).toBe('10.00');
    expect(await ledgerOf(b.userId, s.teamId)).toHaveLength(1);
    expect(await balanceOf(c.userId, s.teamId)).toBeNull();

    // Sealed: the job row holds only the envelope and the readable key, never a link or an address.
    const sealedJobs = jobs.recorded.filter((job) => job.queue === 'send-email');
    expect(sealedJobs).toHaveLength(2);
    for (const job of sealedJobs) {
      expect(
        Object.keys(job.data)
          .filter((key) => key !== '_meta')
          .sort(),
      ).toEqual(['idempotencyKey', 'sealed']);
      expect(job.singletonKey).toBe(
        `notify:${(job.data as { idempotencyKey: string }).idempotencyKey}`,
      );
      expect(job.inTransaction).toBe(true);
    }
    const bPayment = await paymentOf(s.sessionId, b.userId);
    const bEmail = emails().find((email) => email.idempotencyKey === `payment-due:${bPayment.id}`);
    expect(bEmail?.text).toContain(`${WEB}/payments/${bPayment.id}`);
    expect(bEmail?.text).toContain("Your Tuesday Smashers wallet ($10.00) didn't cover this game");
    expect(subjectsOf(emails())).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Payment due: Tuesday Smashers, .+, \$17\.00, due /),
      ]),
    );
  });
});

describe('AC-HAPPY-7: a deduction that leaves the wallet under $20.00 sends one low-credit reminder (B5)', () => {
  it('matches the matrix: 35.00 -> 18.00 yes, 36.00 -> 19.00 yes, 37.00 -> 20.00 no, 15.00 paying 10.00 -> 5.00 yes', async () => {
    const s17 = await scene({ flat: '17.00' });
    const w35 = await player(s17, '35.00');
    const w36 = await player(s17, '36.00');
    const w37 = await player(s17, '37.00');
    const s10 = await scene({ flat: '10.00' });
    const w15 = await player(s10, '15.00');
    clock.set(new Date(Math.max(s17.endsAt.getTime(), s10.endsAt.getTime())));

    await bill(s17.sessionId);
    await bill(s10.sessionId);

    expect(await balanceOf(w35.userId, s17.teamId)).toBe('18.00');
    expect(await balanceOf(w36.userId, s17.teamId)).toBe('19.00');
    expect(await balanceOf(w37.userId, s17.teamId)).toBe('20.00');
    expect(await balanceOf(w15.userId, s10.teamId)).toBe('5.00');
    const sent = emails();
    expect(subjectsOf(sent).sort()).toEqual([
      'Your Tuesday Smashers wallet is running low ($18.00)',
      'Your Tuesday Smashers wallet is running low ($19.00)',
      'Your Tuesday Smashers wallet is running low ($5.00)',
    ]);
    // One key per deduction, so a replay (or a redelivered job after a crash) sends once.
    const deductionIds = (
      await database.pool.query<{ id: string }>(
        `SELECT id FROM credit_transactions WHERE transaction_type = 'AUTO_DEDUCTION' AND user_id = ANY($1)`,
        [[w35.userId, w36.userId, w15.userId]],
      )
    ).rows.map((row) => `low-credit:${row.id}`);
    expect(sent.map((email) => email.idempotencyKey).sort()).toEqual(deductionIds.sort());
  });
});

describe('AC-HAPPY-5: the fee comes from the pricing model and every guest, from the snapshot (AC-INTEGRATION-2: real allocator)', () => {
  const register = (sc: Scene, userId: string, guests: readonly GuestInput[] = []) =>
    registerParty(database.pool, sc, userId, guests);

  it.each([
    {
      name: 'FLAT $17.00, party of 3',
      fees: { pricing: 'FLAT', flat: '17.00' } satisfies SessionFees,
      guests: [guest('FEMALE', 'ADVANCED'), guest('OTHER', 'BEGINNER')],
      amount: '51.00',
      bases: ['FLAT', 'FLAT', 'FLAT'],
      fees3: ['17.00', '17.00', '17.00'],
    },
    {
      name: 'BY_SEX: male registrant, female guest, OTHER guest',
      fees: {
        pricing: 'BY_SEX',
        male: '15.00',
        female: '12.00',
        other: '13.00',
      } satisfies SessionFees,
      guests: [guest('FEMALE', 'BEGINNER'), guest('OTHER', 'BEGINNER')],
      amount: '40.00',
      bases: ['SEX_MALE', 'SEX_FEMALE', 'SEX_OTHER'],
      fees3: ['15.00', '12.00', '13.00'],
    },
  ])('$name', async ({ fees, guests, amount, bases, fees3 }) => {
    const s = await scene(fees);
    const userId = await insertMember(database.pool, s.teamId, { sex: 'MALE' });
    await register(s, userId, guests);
    const registrationsBefore = await registrationRows(s.sessionId);
    clock.set(s.endsAt);

    await bill(s.sessionId);

    const payment = await paymentOf(s.sessionId, userId);
    expect(payment).toMatchObject({ amount, status: 'PENDING', billing_type: 'PER_GAME' });
    const lines = await linesOf(payment.id);
    expect(lines.map((line) => line.applied_basis)).toEqual(bases);
    expect(lines.map((line) => line.unit_fee)).toEqual(fees3);
    expect(lines.map((line) => line.registration_guest_id !== null)).toEqual([false, true, true]);
    // C-ALL-1: billing never writes `registrations`.
    expect(await registrationRows(s.sessionId)).toEqual(registrationsBefore);
  });

  it('BY_SKILL_LEVEL: a registrant snapshotted INTERMEDIATE is charged $14.00 although the member level is now ADVANCED', async () => {
    const s = await scene({
      pricing: 'BY_SKILL_LEVEL',
      beginner: '10.00',
      intermediate: '14.00',
      advanced: '18.00',
    });
    const userId = await insertMember(database.pool, s.teamId, {
      sex: 'FEMALE',
      skill: 'INTERMEDIATE',
    });
    await register(s, userId);
    await database.pool.query(
      `UPDATE team_members SET skill_level = 'ADVANCED' WHERE user_id = $1`,
      [userId],
    );
    await database.pool.query(`UPDATE users SET sex = 'MALE' WHERE id = $1`, [userId]);
    clock.set(s.endsAt);

    await bill(s.sessionId);

    const payment = await paymentOf(s.sessionId, userId);
    expect(payment.amount).toBe('14.00');
    expect(await linesOf(payment.id)).toMatchObject([
      {
        applied_basis: 'SKILL_INTERMEDIATE',
        party_sex: 'FEMALE',
        party_skill_level: 'INTERMEDIATE',
        unit_fee: '14.00',
      },
    ]);
  });

  it('AC-HAPPY-6: bills exactly the hand-off: confirmed, promoted and late-owing parties yes; early, replaced, waitlisted and banned-before-start no', async () => {
    const s = await scene({ maxPlayers: 6 });
    const people = {
      confirmed: await insertMember(database.pool, s.teamId),
      early: await insertMember(database.pool, s.teamId),
      refilled: await insertMember(database.pool, s.teamId),
      banned: await insertMember(database.pool, s.teamId),
      owing: await insertMember(database.pool, s.teamId),
      promoted: await insertMember(database.pool, s.teamId),
      waiting: await insertMember(database.pool, s.teamId),
    };
    // Seats: confirmed 1, early 1, refilled 1, banned 1, owing party of 2 = 6 of 6; `promoted` (party of 2) waits, so does `waiting` (party of 3).
    for (const [key, guests] of [
      ['confirmed', 0],
      ['early', 0],
      ['refilled', 0],
      ['banned', 0],
      ['owing', 1],
    ] as const) {
      clock.advance(1_000);
      await register(
        s,
        people[key],
        Array.from({ length: guests }, () => guest('FEMALE', 'INTERMEDIATE')),
      );
    }
    clock.advance(1_000);
    await register(s, people.promoted, [guest('OTHER', 'ADVANCED')]); // the session is full: waitlisted
    clock.advance(1_000);
    await register(s, people.waiting, [guest('MALE', 'BEGINNER'), guest('MALE', 'BEGINNER')]); // waitlisted
    expect((await readRegistration(database.pool, s.sessionId, people.promoted))?.status).toBe(
      'WAITLISTED',
    );

    clock.set(new Date(s.deadline.getTime() - 60_000));
    await withdraw(s, people.early); // EARLY: frees 1 seat, nobody behind fits yet (party of 2 needs 2)
    clock.set(new Date(s.deadline.getTime() + 60_000));
    await withdraw(s, people.refilled); // LATE: frees a 2nd seat, `promoted` (party of 2) is promoted AFTER the deadline: the fee moves to it
    clock.advance(1_000);
    await withdraw(s, people.owing); // LATE with nobody behind that fits: owes the fee for the party of 2
    // The C3 residual: banned before the start while still CONFIRMED (the ban hook never ran).
    await database.pool.query(
      `UPDATE team_members SET status = 'BANNED', banned_at = $3, banned_by = user_id, ban_reason = 'Test ban'
        WHERE team_id = $1 AND user_id = $2`,
      [s.teamId, people.banned, new Date(s.startsAt.getTime() - HOUR)],
    );
    // A CANCELLED session with a CONFIRMED row is never completed or billed.
    const cancelled = await scene();
    await player(cancelled);
    await advanceSessionTo(database.pool, cancelled.sessionId, 'CANCELLED');

    const registrationsBefore = await registrationRows(s.sessionId);
    clock.set(new Date(Math.max(s.endsAt.getTime(), cancelled.endsAt.getTime())));
    await bill(s.sessionId);
    expect(await bill(cancelled.sessionId)).toMatchObject({
      kind: 'skipped',
      reason: 'not_published',
    });

    const billed = await paymentsOf(s.sessionId);
    expect(billed.map((payment) => payment.user_id).sort()).toEqual(
      [people.confirmed, people.promoted, people.owing].sort(),
    );
    expect(billed.find((p) => p.user_id === people.owing)?.amount).toBe('34.00'); // the whole party of 2
    expect(billed.find((p) => p.user_id === people.promoted)?.amount).toBe('34.00');
    expect(billed.find((p) => p.user_id === people.confirmed)?.amount).toBe('17.00');
    expect(await paymentsOf(cancelled.sessionId)).toEqual([]);
    expect(await statusOf(cancelled.sessionId)).toBe('CANCELLED');
    expect(await registrationRows(s.sessionId)).toEqual(registrationsBefore);

    const owingPayment = billed.find((p) => p.user_id === people.owing);
    const lateEmail = emails().find(
      (email) => email.idempotencyKey === `payment-due:${owingPayment?.id}`,
    );
    expect(lateEmail?.text).toContain('Late withdrawal fee for Test Hall');
    expect(lateEmail?.text).toContain('(you and 1 guest)');
    const confirmedPayment = billed.find((p) => p.user_id === people.confirmed);
    expect(
      emails().find((email) => email.idempotencyKey === `payment-due:${confirmedPayment?.id}`)
        ?.text,
    ).toContain('Thanks for playing with Tuesday Smashers');
    // A fee-due party's line items follow the withdrawn registration's own snapshot and its guest.
    expect(
      (await linesOf(owingPayment?.id ?? '')).map((line) => line.registration_guest_id !== null),
    ).toEqual([false, true]);

    async function withdraw(sc: Scene, userId: string) {
      await runAllocatorTransaction(
        kysely(),
        HTTP_POLICY,
        { clock, teamId: sc.teamId, path: 'test' },
        ({ trx, now }) =>
          allocator.withdrawFromSession(
            { trx, now, log: logs.logger },
            { teamId: sc.teamId, sessionId: sc.sessionId, userId, cause: 'player' },
          ),
      );
    }
  });
});

async function registrationRows(sessionId: string): Promise<unknown[]> {
  const { rows } = await database.pool.query<Record<string, unknown>>(
    `SELECT * FROM registrations WHERE session_id = $1 ORDER BY id`,
    [sessionId],
  );
  return rows;
}

describe('AC-HAPPY-11 and B7: nothing to charge still completes', () => {
  it('a free session and a paid session with no billable registrations complete with no rows and no emails', async () => {
    const free = await scene({ flat: '0.00' });
    await player(free);
    const empty = await scene();
    clock.set(new Date(Math.max(free.endsAt.getTime(), empty.endsAt.getTime())));
    const before = await count(database.pool, 'payments');

    expect(await bill(free.sessionId)).toMatchObject({ kind: 'completed', payments: 0 });
    expect(await bill(empty.sessionId)).toMatchObject({ kind: 'completed', payments: 0 });

    expect(await statusOf(free.sessionId)).toBe('COMPLETED');
    expect(await statusOf(empty.sessionId)).toBe('COMPLETED');
    expect(await count(database.pool, 'payments')).toBe(before);
    expect(emails()).toEqual([]);
  });

  it('B7: a $0.00 party on a paid session gets a PAID $0.00 PER_GAME row, no email, and its wallet is untouched', async () => {
    const s = await scene({ pricing: 'BY_SEX', male: '0.00', female: '12.00', other: '13.00' });
    const free = await insertMember(database.pool, s.teamId, { sex: 'MALE' });
    await insertRegistration(database.pool, {
      sessionId: s.sessionId,
      teamId: s.teamId,
      userId: free,
    });
    await insertWallet(database.pool, free, s.teamId, '50.00');
    clock.set(s.endsAt);

    expect(await bill(s.sessionId)).toMatchObject({
      kind: 'completed',
      payments: 1,
      zero: 1,
      deducted: 0,
      linked: 0,
    });

    const payment = await paymentOf(s.sessionId, free);
    expect(payment).toMatchObject({ billing_type: 'PER_GAME', status: 'PAID', amount: '0.00' });
    expect(payment.paid_at).toEqual(s.endsAt);
    expect(await linesOf(payment.id)).toMatchObject([
      { party_position: 0, applied_basis: 'SEX_MALE', unit_fee: '0.00' },
    ]);
    expect(await balanceOf(free, s.teamId)).toBe('50.00');
    expect(await ledgerOf(free, s.teamId)).toHaveLength(1);
    expect(emails()).toEqual([]);
  });

  it('a free session of a payout-blocked team still completes: B8 applies to paid sessions only', async () => {
    const s = await scene({ flat: '0.00' });
    await database.pool.query(`UPDATE teams SET payout_blocked_at = $2 WHERE id = $1`, [
      s.teamId,
      BASE,
    ]);
    clock.set(s.endsAt);
    expect(await bill(s.sessionId)).toMatchObject({ kind: 'completed' });
    expect(await statusOf(s.sessionId)).toBe('COMPLETED');
  });
});

describe('AC-ERROR-5 and B8: a team that cannot take payments at billing time is not half-billed', () => {
  it('holds the session, notifies each admin once, and bills normally on the first run after the account is fixed', async () => {
    const s = await scene();
    const a = await player(s, '30.00');
    const adminOne = await insertUser(database.pool, 'MALE', { email: 'one@example.test' });
    const adminTwo = await insertUser(database.pool, 'MALE', { email: 'two@example.test' });
    await insertTeamMember(database.pool, {
      teamId: s.teamId,
      userId: adminOne,
      role: 'TEAM_ADMIN',
    });
    await insertTeamMember(database.pool, {
      teamId: s.teamId,
      userId: adminTwo,
      role: 'TEAM_ADMIN',
    });
    await database.pool.query(`UPDATE teams SET payout_blocked_at = $2 WHERE id = $1`, [
      s.teamId,
      BASE,
    ]);
    clock.set(new Date(s.endsAt.getTime() + 5 * 60_000));

    expect(await bill(s.sessionId)).toMatchObject({ kind: 'blocked' });
    expect(await bill(s.sessionId)).toMatchObject({ kind: 'blocked' }); // the next sweep's job: one notice only

    expect(await statusOf(s.sessionId)).toBe('PUBLISHED');
    expect(await paymentsOf(s.sessionId)).toEqual([]);
    expect(await balanceOf(a.userId, s.teamId)).toBe('30.00');
    const sent = emails();
    expect(sent.map((email) => email.to).sort()).toEqual(['one@example.test', 'two@example.test']);
    expect(new Set(sent.map((email) => email.idempotencyKey))).toEqual(
      new Set([
        `billing-paused:${s.sessionId}:${adminOne}`,
        `billing-paused:${s.sessionId}:${adminTwo}`,
      ]),
    );
    expect(sent[0]?.subject).toMatch(/^Billing is paused: Tuesday Smashers, /);
    expect(sent[0]?.text).toContain(`${WEB}/teams/${s.teamId}/manage/banking`);
    expect(sent[0]?.text).not.toMatch(/account (name|number)/i);
    const marker = await database.pool.query<{ notified_at: Date | null }>(
      `SELECT notified_at FROM billing_session_blocks WHERE session_id = $1`,
      [s.sessionId],
    );
    expect(marker.rows).toHaveLength(1);
    expect(marker.rows[0]?.notified_at).not.toBeNull();
    expect(
      logs
        .lines()
        .filter(
          (line) => line.event === 'billing.session.blocked' && line.sessionId === s.sessionId,
        ),
    ).toHaveLength(2);
    expect(emails().some((email) => email.subject.startsWith('Payment due'))).toBe(false);

    // The account is fixed (re-saving banking clears the block): the next run bills S normally.
    await database.pool.query(`UPDATE teams SET payout_blocked_at = NULL WHERE id = $1`, [
      s.teamId,
    ]);
    clock.advance(5 * 60_000);
    expect(await bill(s.sessionId)).toMatchObject({ kind: 'completed', payments: 1, deducted: 1 });
    expect(await statusOf(s.sessionId)).toBe('COMPLETED');
    expect(await balanceOf(a.userId, s.teamId)).toBe('13.00');
  });
});

describe('AC-ERROR-9: a failing billing job never half-applies', () => {
  it('rolls back the COMPLETED move, payments, lines, deductions and emails, and a retry bills once', async () => {
    const s = await scene();
    const a = await player(s, '30.00');
    const b = await player(s);
    clock.set(s.endsAt);
    const emailJobsBefore = await count(database.pool, 'pgboss.job');
    let calls = 0;
    const failing: Pick<JobRunner, 'enqueue'> = {
      enqueue: <T extends object>(queue: string, data: T, options?: EnqueueOptions) => {
        calls += 1;
        if (calls === 2)
          return Promise.reject(new Error('injected failure after payments were written'));
        return jobs.enqueue(queue, data, options);
      },
    };

    await expect(bill(s.sessionId, { jobs: failing })).rejects.toThrow(/injected failure/);

    expect(calls).toBe(2);
    expect(await statusOf(s.sessionId)).toBe('PUBLISHED');
    expect(await paymentsOf(s.sessionId)).toEqual([]);
    expect(await ledgerOf(a.userId, s.teamId)).toHaveLength(1); // only the seeding top-up
    expect(await balanceOf(a.userId, s.teamId)).toBe('30.00');
    expect(await balanceOf(b.userId, s.teamId)).toBeNull();
    expect(await count(database.pool, 'pgboss.job')).toBe(emailJobsBefore);

    jobs.reset();
    expect(await bill(s.sessionId)).toMatchObject({ kind: 'completed', payments: 2 });
    expect(await paymentsOf(s.sessionId)).toHaveLength(2);
    expect(await ledgerOf(a.userId, s.teamId)).toHaveLength(2);
  });
});

describe('AC-VERIFY-5: the GST snapshot is taken at charge time and never changes', () => {
  it('copies gst_registered, the rate and gst_number from the team in the charging statement; a later team change alters nothing', async () => {
    const registered = await scene({ gstRegistered: true, gstNumber: '123456789' });
    const plain = await scene({ teamName: 'Plain Club' });
    const r = await player(registered);
    const u = await player(plain);
    clock.set(new Date(Math.max(registered.endsAt.getTime(), plain.endsAt.getTime())));

    await bill(registered.sessionId);
    await bill(plain.sessionId);

    expect(await paymentOf(registered.sessionId, r.userId)).toMatchObject({
      gst_registered: true,
      gst_rate_bps: 1500,
      gst_number: '123456789',
      gst_amount: '2.22', // 3/23 of $17.00, HALF_UP
    });
    expect(await paymentOf(plain.sessionId, u.userId)).toMatchObject({
      gst_registered: false,
      gst_rate_bps: 0,
      gst_number: null,
      gst_amount: '0.00',
    });

    await database.pool.query(
      `UPDATE teams SET gst_registered = false, gst_number = NULL WHERE id = $1`,
      [registered.teamId],
    );
    expect(await paymentOf(registered.sessionId, r.userId)).toMatchObject({
      gst_registered: true,
      gst_rate_bps: 1500,
      gst_number: '123456789',
    });
  });
});

describe('AC-VERIFY-6: time boundaries are exact', () => {
  it('bills nothing at ends_at - 1 ms and bills from ends_at on, due exactly 72 hours later', async () => {
    const s = await scene();
    await player(s);

    clock.set(new Date(s.endsAt.getTime() - 1));
    expect(await bill(s.sessionId)).toMatchObject({ kind: 'skipped', reason: 'not_due' });
    expect(await statusOf(s.sessionId)).toBe('PUBLISHED');
    expect(await paymentsOf(s.sessionId)).toEqual([]);

    clock.set(s.endsAt);
    expect(await bill(s.sessionId)).toMatchObject({ kind: 'completed' });
    const [payment] = await paymentsOf(s.sessionId);
    expect(payment?.due_date).toEqual(new Date(s.endsAt.getTime() + 72 * HOUR));
  });

  it('never bills before starts_at, even for a job enqueued early (C-BIL-3)', async () => {
    const s = await scene();
    await player(s);
    clock.set(new Date(s.startsAt.getTime() - 1));
    expect(await bill(s.sessionId)).toMatchObject({ kind: 'skipped', reason: 'not_due' });
    clock.set(s.startsAt);
    expect(await bill(s.sessionId)).toMatchObject({ kind: 'skipped', reason: 'not_due' }); // ends_at is later
  });

  it('adds exactly 72 elapsed hours across the Auckland DST end (2027-04-04 03:00 NZDT)', async () => {
    const dstNow = new Date('2027-04-01T00:00:00.000Z');
    const s = await scene({ now: dstNow, startsInHours: 48 });
    const a = await player(s);
    clock.set(s.endsAt);
    await bill(s.sessionId);
    expect((await paymentOf(s.sessionId, a.userId)).due_date).toEqual(
      new Date(s.endsAt.getTime() + 72 * HOUR),
    );
  });

  it('an unknown session is skipped, not an error', async () => {
    expect(await bill('00000000-0000-4000-8000-000000000000')).toMatchObject({
      kind: 'skipped',
      reason: 'missing',
    });
  });
});

describe('the post-game sweep (AC-ASYNC-1, B8, B9)', () => {
  let sweepDb: TestDatabase;
  let sweepWorker: JobRunner;
  const sweepClock = createManualClock(BASE);
  const sweepLogs = captureLogs();

  beforeAll(async () => {
    sweepDb = await createTestDatabase({ poolMax: 5 });
    sweepWorker = createJobRunner({
      databaseUrl: sweepDb.url,
      logger: captureLogs().logger,
      role: 'worker',
    });
    await sweepWorker.start();
    for (const queue of QUEUES) await sweepWorker.defineQueue(queue);
  });
  afterAll(async () => {
    await sweepWorker.stop();
    await sweepDb.close();
  });

  const publish = (startsInHours: number, teamId?: string) =>
    insertPublishedSession(sweepDb.pool, teamId, { now: BASE, startsInHours });
  const sweep = (batchSize?: number) =>
    runPostGameBillingSweep({
      db: createKysely(sweepDb.pool),
      jobs: sweepWorker,
      clock: sweepClock,
      log: sweepLogs.logger,
      ...(batchSize === undefined ? {} : { batchSize }),
    });
  const queued = async () =>
    (
      await sweepDb.pool.query<{ singleton_key: string }>(
        `SELECT singleton_key FROM pgboss.job
          WHERE name = 'bill-session' AND state IN ('created', 'retry', 'active') ORDER BY created_on, id`,
      )
    ).rows.map((row) => row.singleton_key);
  const clearQueue = () => sweepDb.pool.query(`DELETE FROM pgboss.job WHERE name = 'bill-session'`);

  it('enqueues one bill-session job per ended PUBLISHED session only, once, under singletonKey bill-session:<id>', async () => {
    const ended = await publish(72); // ends BASE + 74 h
    await publish(75); // ends BASE + 77 h: still running at the sweep
    const cancelled = await publish(72);
    await advanceSessionTo(sweepDb.pool, cancelled.sessionId, 'CANCELLED');
    sweepClock.set(new Date(BASE.getTime() + 74 * HOUR + 60_000)); // one minute after the first ended

    expect(await sweep()).toEqual({ scanned: 1, enqueued: 1 });
    expect(await queued()).toEqual([`bill-session:${ended.sessionId}`]);

    // A second sweep (or a second worker) enqueues nothing new while the first job is queued.
    expect(await sweep()).toEqual({ scanned: 1, enqueued: 0 });
    expect(await queued()).toEqual([`bill-session:${ended.sessionId}`]);
    expect(
      sweepLogs
        .lines()
        .some((line) => line.event === 'billing.sweep.enqueued' && line.enqueued === 1),
    ).toBe(true);
    await clearQueue();
  });

  it('B9: enqueues the backlog oldest first, across keyset pages', async () => {
    const third = await publish(110);
    const first = await publish(100);
    const second = await publish(105);
    sweepClock.set(new Date(BASE.getTime() + 200 * HOUR));
    // Earlier tests' PUBLISHED sessions (ending at +77 h, etc.) are also due now; they come first by ends_at.
    const before = (await sweep(1)).enqueued;
    const keys = await queued();
    expect(keys).toHaveLength(before);
    const own = keys.filter((key) =>
      [first, second, third].some((session) => key === `bill-session:${session.sessionId}`),
    );
    expect(own).toEqual(
      [first, second, third].map((session) => `bill-session:${session.sessionId}`),
    );
    await clearQueue();
  });

  it('B8: a session whose team is still blocked and already has its marker is not re-enqueued until the account is fixed', async () => {
    await sweepDb.pool.query(
      `UPDATE game_sessions SET status = 'COMPLETED' WHERE status = 'PUBLISHED'`,
    );
    const teamId = await insertTeam(sweepDb.pool, { payoutConfigured: true });
    const held = await publish(72, teamId);
    await sweepDb.pool.query(`UPDATE teams SET payout_blocked_at = $2 WHERE id = $1`, [
      teamId,
      BASE,
    ]);
    await sweepDb.pool.query(
      `INSERT INTO billing_session_blocks (session_id, team_id, notified_at) VALUES ($1, $2, $3)`,
      [held.sessionId, teamId, BASE],
    );
    sweepClock.set(new Date(BASE.getTime() + 300 * HOUR));

    expect(await sweep()).toEqual({ scanned: 0, enqueued: 0 });

    await sweepDb.pool.query(`UPDATE teams SET payout_blocked_at = NULL WHERE id = $1`, [teamId]);
    expect(await sweep()).toEqual({ scanned: 1, enqueued: 1 });
    expect(await queued()).toEqual([`bill-session:${held.sessionId}`]);
  });
});

describe('AC-INTEGRATION-2: the worker bills registrations produced by the real allocator', () => {
  let flowDb: TestDatabase;
  let flowWorker: JobRunner;
  const flowLogs = captureLogs();
  const notifier = createInMemoryNotifier();
  const flowClock = createManualClock(BASE);

  beforeAll(async () => {
    flowDb = await createTestDatabase({ poolMax: 10 });
    flowWorker = createJobRunner({
      databaseUrl: flowDb.url,
      logger: flowLogs.logger,
      role: 'worker',
      pollingIntervalSeconds: 0.5,
      superviseIntervalSeconds: 2,
    });
    await flowWorker.start();
    await registerJobs({
      runner: flowWorker,
      notifier,
      crypto,
      db: createKysely(flowDb.pool),
      clock: flowClock,
      sessionAllocator: noopSessionAllocator,
      webBaseUrl: WEB,
    });
  });
  afterAll(async () => {
    await flowWorker.stop();
    await flowDb.close();
  });

  it('the sweep enqueues bill-session, the handler completes S once, and a later sweep changes nothing', async () => {
    const teamId = await insertTeam(flowDb.pool, { payoutConfigured: true, name: 'Flow Club' });
    const { sessionId } = await insertPublishedSession(flowDb.pool, teamId, {
      now: BASE,
      flat: '17.00',
    });
    const times = await flowDb.pool.query<{ ends_at: Date }>(
      `SELECT ends_at FROM game_sessions WHERE id = $1`,
      [sessionId],
    );
    const endsAt = times.rows[0]?.ends_at as Date;
    const scene = { teamId, sessionId };
    const funded = await insertMember(flowDb.pool, teamId);
    const unfunded = await insertMember(flowDb.pool, teamId);
    const withGuest = await insertMember(flowDb.pool, teamId);
    flowClock.set(BASE);
    await registerParty(flowDb.pool, scene, funded);
    await registerParty(flowDb.pool, scene, unfunded);
    await registerParty(flowDb.pool, scene, withGuest, [guest('FEMALE', 'BEGINNER')]);
    await insertWallet(flowDb.pool, funded, teamId, '30.00');

    flowClock.set(new Date(endsAt.getTime() + 60_000));
    await flowWorker.trigger('post-game-billing', { source: 'integration-test' });
    await waitFor(
      async () =>
        (
          await flowDb.pool.query(
            `SELECT 1 FROM game_sessions WHERE id = $1 AND status = 'COMPLETED'`,
            [sessionId],
          )
        ).rowCount === 1
          ? true
          : undefined,
      { label: 'the worker to bill and complete the session' },
    );

    const payments = await flowDb.pool.query<{
      user_id: string;
      amount: string;
      billing_type: string;
      status: string;
    }>(`SELECT user_id, amount, billing_type, status FROM payments ORDER BY amount`);
    expect(payments.rows).toHaveLength(3);
    expect(payments.rows.find((row) => row.user_id === funded)).toMatchObject({
      billing_type: 'PREPAID_CREDIT',
      status: 'PAID',
      amount: '17.00',
    });
    expect(payments.rows.find((row) => row.user_id === unfunded)).toMatchObject({
      billing_type: 'PER_GAME',
      status: 'PENDING',
      amount: '17.00',
    });
    expect(payments.rows.find((row) => row.user_id === withGuest)).toMatchObject({
      billing_type: 'PER_GAME',
      status: 'PENDING',
      amount: '34.00',
    });

    // The emails were enqueued in the billing transaction and then delivered, unsealed, by send-email.
    await waitFor(() => (notifier.sent.length >= 3 ? true : undefined), {
      label: 'the emails to be delivered',
    });
    expect(notifier.sent.map((email) => email.subject).sort()).toEqual([
      expect.stringMatching(/^Payment due: Flow Club, .+, \$17\.00, due /),
      expect.stringMatching(/^Payment due: Flow Club, .+, \$34\.00, due /),
      'Your Flow Club wallet is running low ($13.00)',
    ]);

    // The next sweep finds nothing PUBLISHED and ended.
    const jobsBefore = await flowDb.pool.query(
      `SELECT 1 FROM pgboss.job WHERE name = 'bill-session'`,
    );
    await flowWorker.trigger('post-game-billing', { source: 'integration-test' });
    await waitFor(
      () =>
        flowLogs.lines().filter((line) => line.event === 'billing.sweep.enqueued').length >= 2
          ? true
          : undefined,
      { label: 'the second sweep' },
    );
    expect(
      (await flowDb.pool.query(`SELECT 1 FROM pgboss.job WHERE name = 'bill-session'`)).rowCount,
    ).toBe(jobsBefore.rowCount);
    expect((await flowDb.pool.query(`SELECT 1 FROM payments`)).rowCount).toBe(3);
  });
});
