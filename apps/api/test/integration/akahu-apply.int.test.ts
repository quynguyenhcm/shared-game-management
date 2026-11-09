/**
 * The single Akahu apply funnel on a real PostgreSQL and a real pg-boss producer (wallet-and-akahu-billing Phase 4a; CR-2, CR-3,
 * CR-4, CR-25, CR-27, B3; AC-HAPPY-1/4/12 API side, AC-ERROR-3/10, AC-INTEGRATION-3 Akahu races). Akahu is the stateless fake
 * adapter with its scripting overlay (provenance: synthetic). `syncAkahuPayment` re-reads the provider OUTSIDE any transaction and
 * applies the result under the CR-4 locks; every email is read back from the sealed job it was enqueued as.
 *
 * Nothing sleeps: races are ordered with `waitForLockWaiters` or run truly concurrently and judged by their invariant.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeControl, createFakePaymentsGateway } from '../../src/lib/akahu/fake-adapter.ts';
import type { PaymentsGateway } from '../../src/lib/akahu/gateway.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import { QUEUES } from '../../src/jobs/registry.ts';
import { createJobRunner, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import type { EmailMessage } from '../../src/lib/notifications/notifier.ts';
import {
  syncAkahuPayment,
  type AkahuSyncDeps,
} from '../../src/modules/billing/apply-akahu-result.ts';
import { testCrypto } from '../helpers/app-deps.ts';
import {
  insertPayment,
  insertPaymentAttempt,
  insertPublishedSession,
  insertRegistration,
  insertTeam,
  insertTeamMember,
  insertUser,
  insertWallet,
  insertWalletTopUp,
} from '../helpers/factories.ts';
import { waitForLockWaiters } from '../helpers/lock-waiters.ts';
import { captureLogs, type CapturedLogs } from '../helpers/log-capture.ts';
import {
  createRecordingJobs,
  insertMember,
  type RecordingJobs,
} from '../helpers/registration-scene.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

const BASE = new Date('2026-11-10T00:00:00.000Z');
const WEB = 'https://games.example.nz';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const crypto = testCrypto();
const clock = createManualClock(BASE);
const control = createFakeControl();

let database: TestDatabase;
let worker: JobRunner;
let jobs: RecordingJobs;
let logs: CapturedLogs;

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 30 });
  worker = createJobRunner({
    databaseUrl: database.url,
    logger: captureLogs().logger,
    role: 'worker',
  });
  await worker.start();
  for (const queue of QUEUES) await worker.defineQueue(queue);
  jobs = createRecordingJobs(worker);
});
afterAll(async () => {
  await worker.stop();
  await database.close();
});
beforeEach(() => {
  clock.set(BASE);
  control.reset();
  jobs.reset();
  logs = captureLogs();
});

const gateway = (): PaymentsGateway => createFakePaymentsGateway({ clock, control });

const deps = (overrides: Partial<AkahuSyncDeps> = {}): AkahuSyncDeps => ({
  db: createKysely(database.pool),
  gateway: gateway(),
  jobs,
  clock,
  crypto,
  webBaseUrl: WEB,
  log: logs.logger,
  ...overrides,
});

/** A provider id the fake reads: `fake_<scenario>_<cents>_<createdAtMs>_<rand>` (created a minute before BASE). */
const providerId = (cents: number): string =>
  `fake_ok_${cents}_${BASE.getTime() - 60_000}_${randomBytes(4).toString('hex')}`;

const script = (id: string, providerStatus: string, providerStatusReason: string | null = null) =>
  control.scriptGet(id, [{ providerStatus, providerStatusReason }]);

const sync = (akahuPaymentId: string, overrides: Partial<AkahuSyncDeps> = {}) =>
  syncAkahuPayment(deps(overrides), { akahuPaymentId, source: 'webhook' });

// ---------------------------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------------------------

interface Scene {
  readonly teamId: string;
  readonly sessionId: string;
  readonly adminEmails: readonly string[];
}

async function scene(): Promise<Scene> {
  const teamId = await insertTeam(database.pool, {
    payoutConfigured: true,
    name: 'Tuesday Smashers',
  });
  const adminEmails: string[] = [];
  for (let n = 0; n < 2; n += 1) {
    const email = `admin-${randomUUID()}@example.test`;
    const adminId = await insertUser(database.pool, 'FEMALE', { email });
    await insertTeamMember(database.pool, { teamId, userId: adminId, role: 'TEAM_ADMIN' });
    adminEmails.push(email);
  }
  const { sessionId } = await insertPublishedSession(database.pool, teamId, {
    now: BASE,
    flat: '17.00',
  });
  return { teamId, sessionId, adminEmails };
}

interface Payer {
  readonly userId: string;
  readonly email: string;
}

async function payer(s: Scene): Promise<Payer> {
  const email = `payer-${randomUUID()}@example.test`;
  const userId = await insertMember(database.pool, s.teamId, { email });
  return { userId, email };
}

async function charge(
  s: Scene,
  p: Payer,
  options: { status?: 'PENDING' | 'OVERDUE' | 'PAID'; dueDate?: Date; amount?: string } = {},
): Promise<string> {
  const registrationId = await insertRegistration(database.pool, {
    sessionId: s.sessionId,
    teamId: s.teamId,
    userId: p.userId,
  });
  return insertPayment(database.pool, {
    userId: p.userId,
    teamId: s.teamId,
    registrationId,
    amount: options.amount ?? '17.00',
    dueDate: options.dueDate ?? new Date(BASE.getTime() + 2 * DAY),
    ...(options.status === undefined ? {} : { status: options.status }),
  });
}

interface Row {
  [key: string]: unknown;
}
async function one(sqlText: string, values: unknown[]): Promise<Row> {
  const { rows } = await database.pool.query<Row>(sqlText, values);
  const row = rows[0];
  if (row === undefined) throw new Error(`no row for ${sqlText}`);
  return row;
}
const paymentOf = (id: string) =>
  one(`SELECT status, paid_at, due_date, akahu_payment_id FROM payments WHERE id = $1`, [id]);
const attemptOf = (id: string) =>
  one(
    `SELECT status, hold_reason, unapplied_reason, close_reason, akahu_status, closed_at, last_synced_at
       FROM payment_attempts WHERE id = $1`,
    [id],
  );
const topUpOf = (id: string) =>
  one(
    `SELECT status, hold_reason, unapplied_reason, close_reason, akahu_status FROM wallet_top_ups WHERE id = $1`,
    [id],
  );
async function balanceOf(userId: string, teamId: string): Promise<string | null> {
  const { rows } = await database.pool.query<{ balance: string }>(
    `SELECT balance FROM player_credits WHERE user_id = $1 AND team_id = $2`,
    [userId, teamId],
  );
  return rows[0]?.balance ?? null;
}
async function topUpLedgerRows(topUpId: string): Promise<number> {
  const { rows } = await database.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM credit_transactions WHERE wallet_top_up_id = $1`,
    [topUpId],
  );
  return rows[0]?.n ?? 0;
}

/** Every email job the recorder saw, opened with the sender's keyring; each must be sealed and enqueued inside its cause's tx. */
function emails(): EmailMessage[] {
  return jobs.recorded
    .filter((job) => job.queue === 'send-email')
    .map((job) => {
      expect(job.inTransaction, 'an email is enqueued inside the transaction that caused it').toBe(
        true,
      );
      const data = job.data as { idempotencyKey: string; sealed?: string };
      expect(data.sealed, 'every Akahu-result email is sealed').toBeTypeOf('string');
      return JSON.parse(
        crypto.decrypt(data.sealed as string, {
          table: 'pgboss.job',
          column: 'data.send-email',
          rowId: data.idempotencyKey,
        }),
      ) as EmailMessage;
    });
}
const emailKeys = (): string[] => emails().map((email) => email.idempotencyKey);

// =============================================================================================
// Top-ups
// =============================================================================================

describe('top-up results (AC-HAPPY-1 API side, B3)', () => {
  it('credits a SENT top-up once with the intent amount, emails the new balance, and a replay changes nothing', async () => {
    const s = await scene();
    const p = await payer(s);
    await insertWallet(database.pool, p.userId, s.teamId, '15.00');
    const id = providerId(3000);
    const topUpId = await insertWalletTopUp(database.pool, {
      userId: p.userId,
      teamId: s.teamId,
      amount: '30.00',
      status: 'OPEN',
      akahuPaymentId: id,
    });
    script(id, 'SENT');

    const result = await sync(id);
    expect(result).toMatchObject({ outcome: 'applied', intentKind: 'TOP_UP', intentId: topUpId });
    expect((await topUpOf(topUpId)).status).toBe('APPLIED');
    expect(await balanceOf(p.userId, s.teamId)).toBe('45.00');
    expect(await topUpLedgerRows(topUpId)).toBe(1);
    const [received] = emails();
    expect(received?.idempotencyKey).toBe(`top-up-received:${topUpId}`);
    expect(received?.to).toBe(p.email);
    expect(received?.text).toContain('Your balance is now $45.00.');

    jobs.reset();
    await sync(id);
    expect(await balanceOf(p.userId, s.teamId)).toBe('45.00');
    expect(await topUpLedgerRows(topUpId)).toBe(1);
    expect(emails()).toEqual([]);
  });

  it('creates the wallet row for a first top-up (no wallet yet) and credits it', async () => {
    const s = await scene();
    const p = await payer(s);
    const id = providerId(2500);
    const topUpId = await insertWalletTopUp(database.pool, {
      userId: p.userId,
      teamId: s.teamId,
      amount: '25.00',
      status: 'OPEN',
      akahuPaymentId: id,
    });
    script(id, 'SENT');
    await sync(id);
    expect(await balanceOf(p.userId, s.teamId)).toBe('25.00');
    expect((await topUpOf(topUpId)).status).toBe('APPLIED');
  });

  it('never credits beyond the $100.00 cap: an over-cap SENT is UNAPPLIED (OVER_CAP), no ledger row, notices to the player and every admin', async () => {
    const s = await scene();
    const p = await payer(s);
    await insertWallet(database.pool, p.userId, s.teamId, '90.00');
    const id = providerId(2000);
    const topUpId = await insertWalletTopUp(database.pool, {
      userId: p.userId,
      teamId: s.teamId,
      amount: '20.00',
      status: 'OPEN',
      akahuPaymentId: id,
    });
    script(id, 'SENT');
    await sync(id);
    const row = await topUpOf(topUpId);
    expect(row).toMatchObject({ status: 'UNAPPLIED', unapplied_reason: 'OVER_CAP' });
    expect(await balanceOf(p.userId, s.teamId)).toBe('90.00');
    expect(await topUpLedgerRows(topUpId)).toBe(0);
    const sent = emails();
    expect(sent.map((email) => email.to).sort()).toEqual([p.email, ...s.adminEmails].sort());
    expect(sent.find((email) => email.to === p.email)?.subject).toBe(
      'We received an extra payment from you',
    );
    expect(
      sent.filter((email) => email.subject === 'A payment to Tuesday Smashers needs a refund'),
    ).toHaveLength(2);
    const warn = logs.lines().find((line) => line.event === 'akahu.intent.unapplied');
    expect(warn).toMatchObject({ intentKind: 'TOP_UP', intentId: topUpId, reason: 'OVER_CAP' });
  });

  it('absorbs a late SENT on a CLOSED top-up that still fits, and records one that no longer fits as UNAPPLIED (LATE)', async () => {
    const s = await scene();
    const fits = await payer(s);
    await insertWallet(database.pool, fits.userId, s.teamId, '50.00');
    const fitsId = providerId(3000);
    const fitsTopUp = await insertWalletTopUp(database.pool, {
      userId: fits.userId,
      teamId: s.teamId,
      amount: '30.00',
      status: 'CLOSED',
      akahuPaymentId: fitsId,
    });
    script(fitsId, 'SENT');
    await sync(fitsId);
    expect((await topUpOf(fitsTopUp)).status).toBe('APPLIED');
    expect(await balanceOf(fits.userId, s.teamId)).toBe('80.00');

    const late = await payer(s);
    await insertWallet(database.pool, late.userId, s.teamId, '80.00');
    const lateId = providerId(3000);
    const lateTopUp = await insertWalletTopUp(database.pool, {
      userId: late.userId,
      teamId: s.teamId,
      amount: '30.00',
      status: 'CLOSED',
      akahuPaymentId: lateId,
    });
    script(lateId, 'SENT');
    await sync(lateId);
    expect(await topUpOf(lateTopUp)).toMatchObject({
      status: 'UNAPPLIED',
      unapplied_reason: 'LATE',
    });
    expect(await balanceOf(late.userId, s.teamId)).toBe('80.00');
  });

  it('closes a top-up Akahu reports cancelled before authorisation without any email', async () => {
    const s = await scene();
    const p = await payer(s);
    const id = providerId(2000);
    const topUpId = await insertWalletTopUp(database.pool, {
      userId: p.userId,
      teamId: s.teamId,
      amount: '20.00',
      status: 'OPEN',
      akahuPaymentId: id,
    });
    script(id, 'CANCELLED', 'TIMED_OUT');
    await sync(id);
    expect(await topUpOf(topUpId)).toMatchObject({
      status: 'CLOSED',
      close_reason: 'akahu:CANCELLED:TIMED_OUT',
    });
    expect(emails()).toEqual([]);
  });
});

// =============================================================================================
// Payment attempts
// =============================================================================================

describe('payment attempt results (AC-HAPPY-4, AC-HAPPY-12 API side)', () => {
  it('marks the payment PAID once (paid_at = now, Akahu id recorded) with one payment-received email; a replay changes nothing', async () => {
    const s = await scene();
    const p = await payer(s);
    const paymentId = await charge(s, p);
    const id = providerId(1700);
    const attemptId = await insertPaymentAttempt(database.pool, {
      paymentId,
      amount: '17.00',
      status: 'OPEN',
      akahuPaymentId: id,
    });
    script(id, 'SENT');
    await sync(id);
    expect(await paymentOf(paymentId)).toMatchObject({ status: 'PAID', akahu_payment_id: id });
    expect(((await paymentOf(paymentId)).paid_at as Date).toISOString()).toBe(BASE.toISOString());
    expect((await attemptOf(attemptId)).status).toBe('APPLIED');
    expect(emailKeys()).toEqual([`payment-received:${paymentId}`]);
    expect(emails()[0]?.to).toBe(p.email);

    jobs.reset();
    clock.set(new Date(BASE.getTime() + HOUR));
    await sync(id);
    expect(((await paymentOf(paymentId)).paid_at as Date).toISOString()).toBe(BASE.toISOString());
    expect(emails()).toEqual([]);
  });

  it('two syncs of the same SENT at once apply it once (one PAID, one email)', async () => {
    const s = await scene();
    const p = await payer(s);
    const paymentId = await charge(s, p);
    const id = providerId(1700);
    await insertPaymentAttempt(database.pool, {
      paymentId,
      amount: '17.00',
      status: 'OPEN',
      akahuPaymentId: id,
    });
    script(id, 'SENT');
    await Promise.all([sync(id), sync(id), sync(id)]);
    expect((await paymentOf(paymentId)).status).toBe('PAID');
    expect(emailKeys()).toEqual([`payment-received:${paymentId}`]);
  });

  it('moves an OVERDUE payment to PAID', async () => {
    const s = await scene();
    const p = await payer(s);
    const paymentId = await charge(s, p, {
      status: 'OVERDUE',
      dueDate: new Date(BASE.getTime() - DAY),
    });
    const id = providerId(1700);
    await insertPaymentAttempt(database.pool, {
      paymentId,
      amount: '17.00',
      status: 'OPEN',
      akahuPaymentId: id,
    });
    script(id, 'SENT');
    await sync(id);
    expect((await paymentOf(paymentId)).status).toBe('PAID');
  });

  it('holds a SENT whose amount differs (AMOUNT_MISMATCH) and never marks the payment paid, also when the attempt amount itself is wrong', async () => {
    const s = await scene();
    const p = await payer(s);
    const paymentId = await charge(s, p);
    const id = providerId(1600);
    const attemptId = await insertPaymentAttempt(database.pool, {
      paymentId,
      amount: '17.00',
      status: 'OPEN',
      akahuPaymentId: id,
    });
    script(id, 'SENT');
    await sync(id);
    expect(await attemptOf(attemptId)).toMatchObject({
      status: 'HELD',
      hold_reason: 'AMOUNT_MISMATCH',
    });
    expect((await paymentOf(paymentId)).status).toBe('PENDING');
    expect(emailKeys()).toEqual([`payment-held:${attemptId}`]);

    // A second identical re-read keeps it held for a person (no second email).
    jobs.reset();
    await sync(id);
    expect((await attemptOf(attemptId)).status).toBe('HELD');
    expect(emails()).toEqual([]);

    // The attempt was (wrongly) created for 16.00 and Akahu confirms 16.00: still not the payment's amount -> held.
    const other = await payer(s);
    const otherPayment = await charge(s, other);
    const wrongId = providerId(1600);
    const wrongAttempt = await insertPaymentAttempt(database.pool, {
      paymentId: otherPayment,
      amount: '16.00',
      status: 'OPEN',
      akahuPaymentId: wrongId,
    });
    script(wrongId, 'SENT');
    await sync(wrongId);
    expect((await attemptOf(wrongAttempt)).hold_reason).toBe('AMOUNT_MISMATCH');
    expect((await paymentOf(otherPayment)).status).toBe('PENDING');
  });

  it('holds an INDETERMINATE result (held notice, payment untouched), then a later SENT re-read pays it once (CR-25 HELD -> SENT)', async () => {
    const s = await scene();
    const p = await payer(s);
    const paymentId = await charge(s, p);
    const id = providerId(1700);
    const attemptId = await insertPaymentAttempt(database.pool, {
      paymentId,
      amount: '17.00',
      status: 'OPEN',
      akahuPaymentId: id,
      akahuStatus: 'SUBMITTED',
    });
    script(id, 'FAILED', 'BANK_ERROR_INDETERMINATE');
    await sync(id);
    expect(await attemptOf(attemptId)).toMatchObject({
      status: 'HELD',
      hold_reason: 'INDETERMINATE',
    });
    expect((await paymentOf(paymentId)).status).toBe('PENDING');
    const [held] = emails();
    expect(held?.idempotencyKey).toBe(`payment-held:${attemptId}`);
    expect(held?.text).not.toMatch(/haven't been charged/);
    expect(logs.lines().find((line) => line.event === 'akahu.intent.held')).toMatchObject({
      intentKind: 'ATTEMPT',
      intentId: attemptId,
      reason: 'INDETERMINATE',
    });

    jobs.reset();
    script(id, 'SENT');
    await sync(id);
    expect((await paymentOf(paymentId)).status).toBe('PAID');
    expect((await attemptOf(attemptId)).status).toBe('APPLIED');
    const [received] = emails();
    expect(received?.idempotencyKey).toBe(`payment-received:${paymentId}`);
    expect(received?.text).toContain('We checked with your bank and your payment went through.');
  });

  it('a late SENT on a CLOSED attempt pays a still-unpaid payment, and cancels the newer open attempt', async () => {
    const s = await scene();
    const p = await payer(s);
    const paymentId = await charge(s, p);
    const lateId = providerId(1700);
    const lateAttempt = await insertPaymentAttempt(database.pool, {
      paymentId,
      amount: '17.00',
      status: 'CLOSED',
      akahuPaymentId: lateId,
    });
    const retryId = providerId(1700);
    await insertPaymentAttempt(database.pool, {
      paymentId,
      amount: '17.00',
      status: 'OPEN',
      akahuPaymentId: retryId,
    });
    script(lateId, 'SENT');
    await sync(lateId);
    expect((await paymentOf(paymentId)).status).toBe('PAID');
    expect((await attemptOf(lateAttempt)).status).toBe('APPLIED');
    const cancel = jobs.recorded.find((job) => job.queue === 'akahu-cancel');
    expect(cancel).toMatchObject({
      singletonKey: `akahu-cancel:${retryId}`,
      data: { akahuPaymentId: retryId, source: 'superseded' },
      inTransaction: true,
    });
  });

  it('a second success for a PAID payment is UNAPPLIED (DUPLICATE): never PAID twice, no wallet credit, refund notices (CR-25 CLOSED -> SENT after a retry)', async () => {
    const s = await scene();
    const p = await payer(s);
    const paymentId = await charge(s, p);
    const firstId = providerId(1700);
    const first = await insertPaymentAttempt(database.pool, {
      paymentId,
      amount: '17.00',
      status: 'CLOSED',
      akahuPaymentId: firstId,
    });
    const retryId = providerId(1700);
    await insertPaymentAttempt(database.pool, {
      paymentId,
      amount: '17.00',
      status: 'OPEN',
      akahuPaymentId: retryId,
    });
    script(retryId, 'SENT');
    await sync(retryId);
    const paidAt = (await paymentOf(paymentId)).paid_at as Date;

    jobs.reset();
    clock.set(new Date(BASE.getTime() + HOUR));
    script(firstId, 'SENT');
    await sync(firstId);
    expect(await attemptOf(first)).toMatchObject({
      status: 'UNAPPLIED',
      unapplied_reason: 'DUPLICATE',
    });
    const payment = await paymentOf(paymentId);
    expect(payment.status).toBe('PAID');
    expect((payment.paid_at as Date).toISOString()).toBe(paidAt.toISOString());
    expect(payment.akahu_payment_id).toBe(retryId);
    expect(await balanceOf(p.userId, s.teamId)).toBeNull();
    expect(
      emails()
        .map((email) => email.to)
        .sort(),
    ).toEqual([p.email, ...s.adminEmails].sort());
    expect(
      emails().find((email) => email.to !== p.email)?.text,
      'admins are told it was paid twice',
    ).toContain('paid twice for');
  });

  it('only moves the OPEN mirror forward: a stale READY re-read never regresses SUBMITTED', async () => {
    const s = await scene();
    const p = await payer(s);
    const paymentId = await charge(s, p);
    const id = providerId(1700);
    const attemptId = await insertPaymentAttempt(database.pool, {
      paymentId,
      amount: '17.00',
      status: 'OPEN',
      akahuPaymentId: id,
    });
    script(id, 'SUBMITTED');
    await sync(id);
    expect((await attemptOf(attemptId)).akahu_status).toBe('SUBMITTED');
    script(id, 'READY');
    await sync(id);
    const row = await attemptOf(attemptId);
    expect(row).toMatchObject({ status: 'OPEN', akahu_status: 'SUBMITTED' });
    expect((row.last_synced_at as Date).toISOString()).toBe(BASE.toISOString());
    expect(emails()).toEqual([]);
  });
});

// =============================================================================================
// CR-27 grace
// =============================================================================================

describe('24 h grace after a post-authorisation failure (CR-27)', () => {
  async function failingAfter(mirror: string, options: Parameters<typeof charge>[2] = {}) {
    const s = await scene();
    const p = await payer(s);
    const paymentId = await charge(s, p, options);
    const id = providerId(1700);
    const attemptId = await insertPaymentAttempt(database.pool, {
      paymentId,
      amount: '17.00',
      status: 'OPEN',
      akahuPaymentId: id,
      akahuStatus: mirror,
    });
    return { paymentId, attemptId, id };
  }

  it('closes the attempt, raises a PENDING due date to now + 24 h, and emails the new due date', async () => {
    const c = await failingAfter('AUTHORISED', { dueDate: new Date(BASE.getTime() + HOUR) });
    script(c.id, 'FAILED', 'REJECTED');
    await sync(c.id);
    expect((await attemptOf(c.attemptId)).status).toBe('CLOSED');
    const payment = await paymentOf(c.paymentId);
    expect(payment.status).toBe('PENDING');
    expect((payment.due_date as Date).toISOString()).toBe(
      new Date(BASE.getTime() + DAY).toISOString(),
    );
    const [notCompleted] = emails();
    expect(notCompleted?.idempotencyKey).toBe(`payment-not-completed:${c.attemptId}`);
    expect(notCompleted?.text).toContain('The payment is still due by Wed 11 Nov, 1:00 pm.');
  });

  it('never shortens a due date that is already later than now + 24 h', async () => {
    const due = new Date(BASE.getTime() + 3 * DAY);
    const c = await failingAfter('SUBMITTED', { dueDate: due });
    script(c.id, 'CANCELLED', 'TIMED_OUT');
    await sync(c.id);
    expect(((await paymentOf(c.paymentId)).due_date as Date).toISOString()).toBe(due.toISOString());
  });

  it('does not move an OVERDUE payment back or change its due date', async () => {
    const due = new Date(BASE.getTime() - DAY);
    const c = await failingAfter('AUTHORISED', { status: 'OVERDUE', dueDate: due });
    script(c.id, 'FAILED', 'BANK_ERROR');
    await sync(c.id);
    const payment = await paymentOf(c.paymentId);
    expect(payment.status).toBe('OVERDUE');
    expect((payment.due_date as Date).toISOString()).toBe(due.toISOString());
    expect(emails()[0]?.text).toContain('is now overdue');
  });

  it('gives no grace and sends nothing for a link abandoned before authorisation', async () => {
    const due = new Date(BASE.getTime() + HOUR);
    const c = await failingAfter('READY', { dueDate: due });
    script(c.id, 'CANCELLED', 'USER_CANCELLED');
    await sync(c.id);
    expect((await attemptOf(c.attemptId)).status).toBe('CLOSED');
    expect(((await paymentOf(c.paymentId)).due_date as Date).toISOString()).toBe(due.toISOString());
    expect(emails()).toEqual([]);
  });
});

// =============================================================================================
// Correlation and failure modes
// =============================================================================================

describe('correlation and provider failures (A4)', () => {
  it('ignores a provider id no intent has stored, and leaves an intent untouched when Akahu does not know it', async () => {
    expect(await sync(providerId(1700))).toEqual({ outcome: 'unmatched' });
    const s = await scene();
    const p = await payer(s);
    const paymentId = await charge(s, p);
    const unknown = 'akahu-id-the-provider-never-issued';
    const attemptId = await insertPaymentAttempt(database.pool, {
      paymentId,
      amount: '17.00',
      status: 'OPEN',
      akahuPaymentId: unknown,
    });
    expect(await sync(unknown)).toEqual({ outcome: 'not_found' });
    expect((await attemptOf(attemptId)).status).toBe('OPEN');
    expect(logs.lines().some((line) => line.event === 'akahu.sync.anomaly')).toBe(true);
  });

  it('propagates a transient provider failure (the job retries) and writes nothing', async () => {
    const s = await scene();
    const p = await payer(s);
    const paymentId = await charge(s, p);
    const id = providerId(1700);
    await insertPaymentAttempt(database.pool, {
      paymentId,
      amount: '17.00',
      status: 'OPEN',
      akahuPaymentId: id,
    });
    control.failNextGet('timeout');
    await expect(sync(id)).rejects.toThrow(/unavailable/);
    expect((await paymentOf(paymentId)).status).toBe('PENDING');
  });

  it('logs ids and decisions only: no email address, amount or account digits', async () => {
    const s = await scene();
    const p = await payer(s);
    await insertWallet(database.pool, p.userId, s.teamId, '90.00');
    const id = providerId(2000);
    await insertWalletTopUp(database.pool, {
      userId: p.userId,
      teamId: s.teamId,
      amount: '20.00',
      status: 'OPEN',
      akahuPaymentId: id,
    });
    script(id, 'SENT');
    await sync(id);
    const text = JSON.stringify(logs.lines());
    expect(text).toContain('akahu.sync.applied');
    expect(text).not.toContain('@example.test');
    expect(text).not.toContain('20.00');
    expect(text).not.toContain('90.00');
  });
});

// =============================================================================================
// Money cap races (AC-INTEGRATION-3, I1)
// =============================================================================================

describe('money cap races', () => {
  it('a late confirmation racing another top-up on one wallet: exactly one credited, the other UNAPPLIED, never over the cap', async () => {
    const s = await scene();
    const p = await payer(s);
    await insertWallet(database.pool, p.userId, s.teamId, '80.00');
    const lateId = providerId(1000);
    const late = await insertWalletTopUp(database.pool, {
      userId: p.userId,
      teamId: s.teamId,
      amount: '10.00',
      status: 'CLOSED',
      akahuPaymentId: lateId,
    });
    const openId = providerId(2000);
    const open = await insertWalletTopUp(database.pool, {
      userId: p.userId,
      teamId: s.teamId,
      amount: '20.00',
      status: 'OPEN',
      akahuPaymentId: openId,
    });
    script(lateId, 'SENT');
    script(openId, 'SENT');
    await Promise.all([sync(lateId), sync(openId)]);
    const states = [(await topUpOf(late)).status, (await topUpOf(open)).status].sort();
    expect(states).toEqual(['APPLIED', 'UNAPPLIED']);
    const balance = await balanceOf(p.userId, s.teamId);
    expect(['90.00', '100.00']).toContain(balance);
    expect((await topUpLedgerRows(late)) + (await topUpLedgerRows(open))).toBe(1);
    const chain = await one(
      `SELECT sum(amount)::text AS total FROM credit_transactions WHERE user_id = $1 AND team_id = $2`,
      [p.userId, s.teamId],
    );
    expect(chain.total).toBe(balance);
  });

  it('a confirmation waiting behind a wallet deduction sees the deducted balance (no stale cap check, no deadlock)', async () => {
    const s = await scene();
    const p = await payer(s);
    await insertWallet(database.pool, p.userId, s.teamId, '90.00');
    const registrationId = await insertRegistration(database.pool, {
      sessionId: s.sessionId,
      teamId: s.teamId,
      userId: p.userId,
    });
    const id = providerId(2500);
    const topUpId = await insertWalletTopUp(database.pool, {
      userId: p.userId,
      teamId: s.teamId,
      amount: '25.00',
      status: 'OPEN',
      akahuPaymentId: id,
    });
    script(id, 'SENT');
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT id FROM player_credits WHERE user_id = $1 AND team_id = $2 FOR NO KEY UPDATE`,
        [p.userId, s.teamId],
      );
      await client.query(
        `INSERT INTO credit_transactions (user_id, team_id, amount, transaction_type, registration_id, resulting_balance)
         VALUES ($1, $2, '-17.00', 'AUTO_DEDUCTION', $3, '73.00')`,
        [p.userId, s.teamId, registrationId],
      );
      const pending = sync(id);
      await waitForLockWaiters(database.pool, 1, 'apply waiting on the wallet');
      await client.query('COMMIT');
      await pending;
    } finally {
      client.release();
    }
    // 90.00 alone would not take 25.00; after the deduction 73.00 + 25.00 = 98.00 fits.
    expect((await topUpOf(topUpId)).status).toBe('APPLIED');
    expect(await balanceOf(p.userId, s.teamId)).toBe('98.00');
  });
});
