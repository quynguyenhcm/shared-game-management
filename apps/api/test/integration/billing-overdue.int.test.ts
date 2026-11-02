/**
 * The daily-overdue job, the admin payments list and the manual reminder route on a real PostgreSQL and a real pg-boss producer
 * (wallet-and-akahu-billing Phase 3): AC-HAPPY-8 (+ ruling H1 / CR-27), AC-HAPPY-10, AC-ERROR-8, AC-VERIFY-1 (these routes),
 * AC-VERIFY-6 (the overdue boundary, across both NZ DST changes and at the 04:00 Pacific/Auckland slot) and AC-VERIFY-7 (no email,
 * bank detail or amount in a log line). Akahu is the stateless fake adapter with its scripting overlay; every email is read back
 * from the job it was enqueued as (all of them are sealed).
 *
 * Nothing sleeps. Time is an injected manual clock. Every test parks the earlier tests' still-PENDING payments in the far future
 * (`beforeEach`), so a job run only ever sees the rows its own test created.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { formatNzTime, type AdminPaymentsResponse, type ReminderResponse } from '@sgm/shared';
import { createFakeControl, createFakePaymentsGateway } from '../../src/lib/akahu/fake-adapter.ts';
import type { PaymentsGateway } from '../../src/lib/akahu/gateway.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import { QUEUES } from '../../src/jobs/registry.ts';
import { createJobRunner, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import type { EmailMessage } from '../../src/lib/notifications/notifier.ts';
import { billingDueDate } from '../../src/modules/billing/charge.ts';
import { runDailyOverdue, type DailyOverdueDeps } from '../../src/modules/billing/overdue.ts';
import { countOverdueByUser } from '../../src/modules/registrations/repo.ts';
import { START_TIME, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import { testCrypto } from '../helpers/app-deps.ts';
import {
  insertAuthSession,
  insertPayment,
  insertPaymentAttempt,
  insertPublishedSession,
  insertRegistration,
  insertTeam,
  insertTeamMember,
  insertUser,
} from '../helpers/factories.ts';
import { captureLogs, type CapturedLogs } from '../helpers/log-capture.ts';
import {
  call,
  errorOf,
  httpMember,
  registerAs,
  type HttpMember,
} from '../helpers/registrations-http.ts';
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
const ACCOUNT_DIGITS = '0902'; // inside the default test account number 01-0902-0068389-000

const crypto = testCrypto();
const clock = createManualClock(BASE);
const control = createFakeControl();

let database: TestDatabase;
let worker: JobRunner;
let jobs: RecordingJobs;
let logs: CapturedLogs;
let h: AuthTestApp;

/** Provider ids the fake adapter reads: `fake_<scenario>_<cents>_<createdAtMs>_<rand>`. */
const providerId = (cents: number, scenario = 'ok'): string =>
  `fake_${scenario}_${cents}_${BASE.getTime() - 60_000}_${randomBytes(4).toString('hex')}`;

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
  h = await buildAuthTestApp(database.pool, { jobs });
});
afterAll(async () => {
  await h.close();
  await worker.stop();
  await database.close();
});
beforeEach(async () => {
  clock.set(BASE);
  h.clock.set(START_TIME);
  control.reset();
  jobs.reset();
  logs = captureLogs();
  gatewayReads.length = 0;
  idleInTransactionDuringRead.length = 0;
  // Earlier tests' unpaid rows must not be candidates for this test's run.
  await database.pool.query(
    `UPDATE payments SET due_date = '2126-01-01T00:00:00Z' WHERE status = 'PENDING'`,
  );
});

const kysely = () => createKysely(database.pool);

// ---------------------------------------------------------------------------------------------
// The gateway: the fake adapter, observed. `getPayment` records every id it is asked for and, at that very moment, how many
// connections are sitting "idle in transaction" (a transaction waiting on Akahu would be one): the proof that the re-read is
// made outside any transaction.
// ---------------------------------------------------------------------------------------------

const gatewayReads: string[] = [];
const idleInTransactionDuringRead: number[] = [];

async function idleInTransactionCount(): Promise<number> {
  const { rows } = await database.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_stat_activity
      WHERE datname = current_database() AND state LIKE 'idle in transaction%' AND pid <> pg_backend_pid()`,
  );
  return Number(rows[0]?.n ?? '0');
}

function observedGateway(): PaymentsGateway {
  const inner = createFakePaymentsGateway({ clock, control });
  return {
    ...inner,
    async getPayment(id) {
      gatewayReads.push(id);
      idleInTransactionDuringRead.push(await idleInTransactionCount());
      return inner.getPayment(id);
    },
  };
}

const runOverdue = (overrides: Partial<DailyOverdueDeps> = {}) =>
  runDailyOverdue({
    db: kysely(),
    gateway: observedGateway(),
    jobs,
    clock,
    crypto,
    webBaseUrl: WEB,
    log: logs.logger,
    ...overrides,
  });

// ---------------------------------------------------------------------------------------------
// Scene builders
// ---------------------------------------------------------------------------------------------

interface Scene {
  readonly teamId: string;
  readonly sessionId: string;
}

async function scene(options: { teamName?: string; payoutBlocked?: boolean } = {}): Promise<Scene> {
  const teamId = await insertTeam(database.pool, {
    payoutConfigured: true,
    name: options.teamName ?? 'Tuesday Smashers',
  });
  const { sessionId } = await insertPublishedSession(database.pool, teamId, {
    now: BASE,
    flat: '17.00',
  });
  // Akahu's refusal is recorded after the session was published (the publish gate would refuse the other order).
  if (options.payoutBlocked === true) {
    await database.pool.query(`UPDATE teams SET payout_blocked_at = $2 WHERE id = $1`, [
      teamId,
      new Date(BASE.getTime() - DAY),
    ]);
  }
  return { teamId, sessionId };
}

interface Owed {
  readonly userId: string;
  readonly email: string;
  readonly paymentId: string;
}

/** A payer with one payment of `amount` (default 17.00), due at `dueDate`, in `status` (default PENDING). */
async function owed(
  s: Scene,
  options: {
    dueDate: Date;
    status?: 'PENDING' | 'PAID' | 'OVERDUE';
    amount?: string;
    withRegistration?: boolean;
  },
): Promise<Owed> {
  const email = `payer-${randomUUID()}@example.test`;
  const userId = await insertMember(database.pool, s.teamId, { email });
  const registrationId =
    options.withRegistration === false
      ? null
      : await insertRegistration(database.pool, {
          sessionId: s.sessionId,
          teamId: s.teamId,
          userId,
        });
  const paymentId = await insertPayment(database.pool, {
    userId,
    teamId: s.teamId,
    registrationId,
    amount: options.amount ?? '17.00',
    dueDate: options.dueDate,
    ...(options.status === undefined ? {} : { status: options.status }),
  });
  return { userId, email, paymentId };
}

const ago = (ms: number): Date => new Date(BASE.getTime() - ms);

interface PaymentState {
  status: string;
  paid_at: Date | null;
  due_date: Date;
}
async function paymentOf(paymentId: string): Promise<PaymentState> {
  const { rows } = await database.pool.query<PaymentState>(
    `SELECT status, paid_at, due_date FROM payments WHERE id = $1`,
    [paymentId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`no payment ${paymentId}`);
  return row;
}
const statusOf = async (paymentId: string): Promise<string> => (await paymentOf(paymentId)).status;

interface AttemptState {
  status: string;
  hold_reason: string | null;
  akahu_status: string | null;
}
async function attemptOf(attemptId: string): Promise<AttemptState> {
  const { rows } = await database.pool.query<AttemptState>(
    `SELECT status, hold_reason, akahu_status FROM payment_attempts WHERE id = $1`,
    [attemptId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`no attempt ${attemptId}`);
  return row;
}

/** Every email job the recorder saw, opened with the sender's keyring; asserts each is sealed and committed with its cause. */
function emails(): EmailMessage[] {
  return jobs.recorded
    .filter((job) => job.queue === 'send-email')
    .map((job) => {
      expect(job.inTransaction, 'an email is enqueued inside the transaction that caused it').toBe(
        true,
      );
      const data = job.data as { idempotencyKey: string; sealed?: string };
      expect(data.sealed, 'every payment email is sealed').toBeTypeOf('string');
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
// daily-overdue
// =============================================================================================

describe('daily-overdue (AC-HAPPY-8)', () => {
  it('flips only PENDING payments due at or before now, one sealed email each, and a same-day re-run changes and sends nothing', async () => {
    const s = await scene();
    const dueBefore = await owed(s, { dueDate: ago(HOUR) });
    const dueLongAgo = await owed(s, { dueDate: ago(3 * DAY) });
    const dueLater = await owed(s, { dueDate: new Date(BASE.getTime() + HOUR) });
    const paidPastDue = await owed(s, { dueDate: ago(2 * DAY), status: 'PAID' });
    const alreadyOverdue = await owed(s, { dueDate: ago(5 * DAY), status: 'OVERDUE' });

    await runOverdue();

    expect(await statusOf(dueBefore.paymentId)).toBe('OVERDUE');
    expect(await statusOf(dueLongAgo.paymentId)).toBe('OVERDUE');
    expect(await statusOf(dueLater.paymentId)).toBe('PENDING');
    expect(await statusOf(paidPastDue.paymentId)).toBe('PAID');
    expect(await statusOf(alreadyOverdue.paymentId)).toBe('OVERDUE');

    const sent = emails();
    expect(emailKeys().sort()).toEqual(
      [`payment-overdue:${dueBefore.paymentId}`, `payment-overdue:${dueLongAgo.paymentId}`].sort(),
    );
    expect(sent.map((email) => email.to).sort()).toEqual(
      [dueBefore.email, dueLongAgo.email].sort(),
    );
    for (const email of sent) {
      expect(email.subject).toBe('Overdue: Tuesday Smashers, $17.00');
      expect(email.text).toContain(`${WEB}/payments/`);
      expect(email.text).not.toMatch(/akahu/i);
    }

    const recordedBefore = jobs.recorded.length;
    await runOverdue();
    expect(jobs.recorded.length, 'a same-day re-run sends nothing').toBe(recordedBefore);
    expect(await statusOf(dueLater.paymentId)).toBe('PENDING');
  });

  it('counts the new OVERDUE rows for the registration debt gate, which then refuses a registration', async () => {
    const teamId = await insertTeam(database.pool, { payoutConfigured: true });
    const member = await httpMember(h, teamId);
    const { sessionId } = await insertPublishedSession(database.pool, teamId, {
      now: h.clock.now(),
      flat: '10.00',
    });
    // Three charges for the same player, past due, with no registration row behind them.
    for (let n = 0; n < 3; n += 1) {
      await insertPayment(database.pool, {
        userId: member.userId,
        teamId,
        registrationId: null,
        amount: '10.00',
        dueDate: ago((n + 1) * HOUR),
      });
    }

    await runOverdue();

    const counts = await kysely()
      .transaction()
      .execute((trx) => countOverdueByUser(trx, [member.userId]));
    expect(counts.get(member.userId)).toBe(3);
    expect(emails().filter((email) => email.subject.startsWith('Overdue:'))).toHaveLength(3);
    const refused = await registerAs(h, member, teamId, sessionId);
    expect(refused.statusCode).toBe(403);
    expect(errorOf(refused).code).toBe('overdue_payments');
  });

  it('walks every candidate across keyset pages (a page of 2 over 5 due payments)', async () => {
    const s = await scene();
    const ids: string[] = [];
    for (let n = 0; n < 5; n += 1)
      ids.push((await owed(s, { dueDate: ago((n + 1) * HOUR) })).paymentId);
    await runOverdue({ batchSize: 2 });
    for (const id of ids) expect(await statusOf(id)).toBe('OVERDUE');
    expect(emailKeys().sort()).toEqual(ids.map((id) => `payment-overdue:${id}`).sort());
  });

  it('flips a payment of a payout-blocked team (CR-27: the team state does not defer the debt)', async () => {
    const s = await scene({ payoutBlocked: true });
    const p = await owed(s, { dueDate: ago(HOUR) });
    await runOverdue();
    expect(await statusOf(p.paymentId)).toBe('OVERDUE');
    expect(emailKeys()).toEqual([`payment-overdue:${p.paymentId}`]);
  });

  it('two runs at once flip each payment once and send one email per payment', async () => {
    const s = await scene();
    const ids: string[] = [];
    for (let n = 0; n < 6; n += 1)
      ids.push((await owed(s, { dueDate: ago((n + 1) * HOUR) })).paymentId);
    await Promise.all([runOverdue(), runOverdue()]);
    for (const id of ids) expect(await statusOf(id)).toBe('OVERDUE');
    expect(emailKeys().sort()).toEqual(ids.map((id) => `payment-overdue:${id}`).sort());
  });

  it('skips a payment row another transaction holds locked instead of waiting or failing, and picks it up next run', async () => {
    const s = await scene();
    const locked = await owed(s, { dueDate: ago(HOUR) });
    const free = await owed(s, { dueDate: ago(2 * HOUR) });
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT id FROM payments WHERE id = $1 FOR UPDATE`, [locked.paymentId]);
      await runOverdue();
      expect(await statusOf(free.paymentId)).toBe('OVERDUE');
      expect(await statusOf(locked.paymentId)).toBe('PENDING');
      expect(logs.lines().some((line) => line.event === 'billing.overdue.skipped')).toBe(true);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    await runOverdue();
    expect(await statusOf(locked.paymentId)).toBe('OVERDUE');
    expect(emailKeys().filter((key) => key.endsWith(locked.paymentId))).toHaveLength(1);
  });

  it('logs counts and ids only after commit: no email address, bank detail or amount', async () => {
    const s = await scene();
    const p = await owed(s, { dueDate: ago(HOUR) });
    await runOverdue();
    const marked = logs.lines().find((line) => line.event === 'billing.overdue.marked');
    expect(marked).toMatchObject({ count: 1 });
    const text = JSON.stringify(logs.lines());
    expect(text).not.toContain(p.email);
    expect(text).not.toContain('@example.test');
    expect(text).not.toContain('17.00');
    expect(text).not.toContain(ACCOUNT_DIGITS);
  });
});

describe('daily-overdue time boundaries (AC-VERIFY-6)', () => {
  it('leaves a payment untouched at due_date - 1 ms and flips it at exactly due_date', async () => {
    const s = await scene();
    const due = new Date('2026-11-20T03:00:00.000Z');
    const p = await owed(s, { dueDate: due });
    clock.set(new Date(due.getTime() - 1));
    await runOverdue();
    expect(await statusOf(p.paymentId)).toBe('PENDING');
    expect(emails()).toHaveLength(0);
    clock.set(due);
    await runOverdue();
    expect(await statusOf(p.paymentId)).toBe('OVERDUE');
    expect(emails()).toHaveLength(1);
  });

  it.each([
    // Billed Fri 2 Apr 18:00 NZDT; 72 elapsed hours later NZ has gone back to standard time (3 Apr 03:00 -> 02:00 on Sun 4 Apr).
    [
      'DST end',
      '2027-04-02T05:00:00.000Z',
      '2027-04-05T05:00:00.000Z',
      '2027-04-04T16:00:00.000Z',
      '2027-04-05T16:00:00.000Z',
    ],
    // Billed Fri 25 Sep 17:00 NZST; NZ goes forward on Sun 27 Sep 02:00 -> 03:00 inside the window.
    [
      'DST start',
      '2026-09-25T05:00:00.000Z',
      '2026-09-28T05:00:00.000Z',
      '2026-09-27T15:00:00.000Z',
      '2026-09-28T15:00:00.000Z',
    ],
  ])(
    'a charge billed before the %s is due exactly 72 h later, untouched at the earlier 04:00 slot and flipped at the first 04:00 slot after due',
    async (_label, billedIso, dueIso, earlierSlotIso, laterSlotIso) => {
      const billedAt = new Date(billedIso);
      const due = billingDueDate(billedAt);
      expect(due.toISOString()).toBe(dueIso);
      const earlierSlot = new Date(earlierSlotIso);
      const laterSlot = new Date(laterSlotIso);
      // Both are real 04:00 Pacific/Auckland slots, and the due instant is between them.
      expect(formatNzTime(earlierSlot)).toBe('4:00 am');
      expect(formatNzTime(laterSlot)).toBe('4:00 am');
      expect(earlierSlot.getTime()).toBeLessThan(due.getTime());
      expect(laterSlot.getTime()).toBeGreaterThanOrEqual(due.getTime());

      const s = await scene();
      const p = await owed(s, { dueDate: due });
      clock.set(new Date(due.getTime() - 1));
      await runOverdue();
      expect(await statusOf(p.paymentId)).toBe('PENDING');
      clock.set(earlierSlot);
      await runOverdue();
      expect(await statusOf(p.paymentId)).toBe('PENDING');
      clock.set(laterSlot);
      await runOverdue();
      expect(await statusOf(p.paymentId)).toBe('OVERDUE');
      expect(emails()).toHaveLength(1);
    },
  );
});

describe('daily-overdue re-reads Akahu before deciding (ruling H1, CR-27)', () => {
  /** A payment due before now with a blocking attempt of the given local state; Akahu answers `script` when re-read. */
  async function withAttempt(options: {
    status?: 'CREATING' | 'OPEN' | 'HELD';
    mirror?: string;
    cents?: number;
    script?: { providerStatus: string; providerStatusReason?: string | null };
    amount?: string;
  }) {
    const s = await scene();
    const p = await owed(s, { dueDate: ago(HOUR), amount: options.amount ?? '17.00' });
    const akahuPaymentId = providerId(options.cents ?? 1700);
    const attemptId = await insertPaymentAttempt(database.pool, {
      paymentId: p.paymentId,
      amount: options.amount ?? '17.00',
      status: options.status ?? 'OPEN',
      akahuPaymentId,
      akahuStatus: options.mirror ?? 'READY',
    });
    if (options.script !== undefined) {
      control.scriptGet(akahuPaymentId, [
        {
          providerStatus: options.script.providerStatus,
          providerStatusReason: options.script.providerStatusReason ?? null,
        },
      ]);
    }
    return { ...p, attemptId, akahuPaymentId };
  }

  it('skips a stale READY mirror that Akahu now reports SUBMITTED, changing nothing', async () => {
    const c = await withAttempt({ script: { providerStatus: 'SUBMITTED' } });
    await runOverdue();
    expect(await statusOf(c.paymentId)).toBe('PENDING');
    expect((await attemptOf(c.attemptId)).status).toBe('OPEN');
    expect(emails()).toHaveLength(0);
    expect(gatewayReads).toContain(c.akahuPaymentId);
  });

  it('marks a payment Akahu reports SENT (right amount) as PAID with paid_at = now, never OVERDUE, and sends no overdue email', async () => {
    const c = await withAttempt({ script: { providerStatus: 'SENT' } });
    await runOverdue();
    const payment = await paymentOf(c.paymentId);
    expect(payment.status).toBe('PAID');
    expect(payment.paid_at?.toISOString()).toBe(BASE.toISOString());
    expect((await attemptOf(c.attemptId)).status).toBe('APPLIED');
    expect(emails()).toHaveLength(0);
  });

  it('holds an attempt Akahu reports SENT for a different amount (AMOUNT_MISMATCH) and leaves the payment untouched', async () => {
    const c = await withAttempt({ cents: 1600, script: { providerStatus: 'SENT' } });
    await runOverdue();
    expect(await statusOf(c.paymentId)).toBe('PENDING');
    const attempt = await attemptOf(c.attemptId);
    expect(attempt.status).toBe('HELD');
    expect(attempt.hold_reason).toBe('AMOUNT_MISMATCH');
    expect(emails()).toHaveLength(0);
  });

  it('leaves the payment untouched and logs billing.overdue.deferred (ids and reason only) when the re-read fails', async () => {
    const c = await withAttempt({});
    control.failNextGet('timeout');
    await runOverdue();
    expect(await statusOf(c.paymentId)).toBe('PENDING');
    expect(emails()).toHaveLength(0);
    const deferred = logs.lines().filter((line) => line.event === 'billing.overdue.deferred');
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({ paymentId: c.paymentId, reason: 'unavailable' });
    expect(JSON.stringify(deferred)).not.toContain('timeout');
    // Never flipped on stale data: the next run, with Akahu reachable again, decides.
    control.scriptGet(c.akahuPaymentId, [{ providerStatus: 'READY', providerStatusReason: null }]);
    await runOverdue();
    expect(await statusOf(c.paymentId)).toBe('OVERDUE');
  });

  it('defers a status the mapping does not recognise, and an id Akahu does not know, leaving both untouched', async () => {
    const unknownStatus = await withAttempt({ script: { providerStatus: 'SOMETHING_NEW' } });
    // A provider id outside the fake's vocabulary reads as not found.
    const s = await scene();
    const missing = await owed(s, { dueDate: ago(HOUR) });
    await insertPaymentAttempt(database.pool, {
      paymentId: missing.paymentId,
      amount: '17.00',
      status: 'OPEN',
      akahuPaymentId: 'akahu-id-the-provider-never-issued',
    });
    await runOverdue();
    const deferred = logs.lines().filter((line) => line.event === 'billing.overdue.deferred');
    expect(deferred).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ paymentId: unknownStatus.paymentId, reason: 'unrecognised' }),
        expect.objectContaining({ paymentId: missing.paymentId, reason: 'not_found' }),
      ]),
    );
    expect(await statusOf(unknownStatus.paymentId)).toBe('PENDING');
    expect(await statusOf(missing.paymentId)).toBe('PENDING');
    expect(emails()).toHaveLength(0);
  });

  it('flips a payment whose attempt Akahu still reports READY (a link opened at 03:59 does not defer the debt)', async () => {
    const c = await withAttempt({ script: { providerStatus: 'READY' } });
    await runOverdue();
    expect(await statusOf(c.paymentId)).toBe('OVERDUE');
    expect((await attemptOf(c.attemptId)).status).toBe('OPEN');
    expect(emailKeys()).toEqual([`payment-overdue:${c.paymentId}`]);
  });

  it('skips a HELD attempt without re-reading Akahu', async () => {
    const c = await withAttempt({ status: 'HELD' });
    await runOverdue();
    expect(await statusOf(c.paymentId)).toBe('PENDING');
    expect(gatewayReads).not.toContain(c.akahuPaymentId);
    expect(emails()).toHaveLength(0);
  });

  it('flips a payment with no attempt and one whose attempt is only CREATING, without calling Akahu', async () => {
    const s = await scene();
    const none = await owed(s, { dueDate: ago(HOUR) });
    const creating = await owed(s, { dueDate: ago(HOUR) });
    await insertPaymentAttempt(database.pool, {
      paymentId: creating.paymentId,
      amount: '17.00',
      status: 'CREATING',
    });
    await runOverdue();
    expect(await statusOf(none.paymentId)).toBe('OVERDUE');
    expect(await statusOf(creating.paymentId)).toBe('OVERDUE');
    expect(gatewayReads).toHaveLength(0);
  });

  it.each([
    ['AUTHORISED', 'FAILED', 'REJECTED', 'PENDING'],
    ['SUBMITTED', 'FAILED', 'BANK_ERROR', 'PENDING'],
    ['SETTLEMENT_IN_PROGRESS', 'CANCELLED', 'USER_CANCELLED', 'PENDING'],
    ['READY', 'CANCELLED', 'USER_CANCELLED', 'OVERDUE'],
  ])(
    'a NOT_CHARGED re-read with stored mirror %s (%s/%s) leaves the payment %s',
    async (mirror, providerStatus, reason, expected) => {
      const c = await withAttempt({
        mirror,
        script: { providerStatus, providerStatusReason: reason },
      });
      await runOverdue();
      expect(await statusOf(c.paymentId)).toBe(expected);
    },
  );

  it('skips an INDETERMINATE re-read, untouched', async () => {
    const c = await withAttempt({
      script: { providerStatus: 'FAILED', providerStatusReason: 'BANK_ERROR_INDETERMINATE' },
    });
    await runOverdue();
    expect(await statusOf(c.paymentId)).toBe('PENDING');
    expect((await attemptOf(c.attemptId)).status).toBe('OPEN');
  });

  it('never calls Akahu inside a database transaction, and the probe can tell (positive control)', async () => {
    const c = await withAttempt({ script: { providerStatus: 'READY' } });
    await runOverdue();
    expect(gatewayReads).toContain(c.akahuPaymentId);
    expect(idleInTransactionDuringRead.length).toBeGreaterThan(0);
    expect(idleInTransactionDuringRead.every((n) => n === 0)).toBe(true);
    // Positive control: a connection left inside a transaction is seen by the same probe.
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1');
      expect(await idleInTransactionCount()).toBeGreaterThanOrEqual(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('reads at most 4 payments from Akahu at a time (bounded parallelism)', async () => {
    const s = await scene();
    let inFlight = 0;
    let peak = 0;
    const inner = createFakePaymentsGateway({ clock, control });
    const slow: PaymentsGateway = {
      ...inner,
      async getPayment(id) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 25));
        inFlight -= 1;
        return inner.getPayment(id);
      },
    };
    for (let n = 0; n < 9; n += 1) {
      const p = await owed(s, { dueDate: ago(HOUR) });
      const akahuPaymentId = providerId(1700);
      await insertPaymentAttempt(database.pool, {
        paymentId: p.paymentId,
        amount: '17.00',
        status: 'OPEN',
        akahuPaymentId,
      });
      control.scriptGet(akahuPaymentId, [
        { providerStatus: 'SUBMITTED', providerStatusReason: null },
      ]);
    }
    await runOverdue({ gateway: slow });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });
});

// =============================================================================================
// Admin payments list and manual reminders over HTTP
// =============================================================================================

async function signedIn(userId: string): Promise<HttpMember> {
  const { token } = await insertAuthSession(database.pool, userId, {
    createdAt: h.clock.now(),
    idleDays: 90,
    absoluteDays: 180,
  });
  return { userId, token };
}
async function teamAdmin(teamId: string): Promise<HttpMember> {
  const userId = await insertUser(database.pool, 'FEMALE');
  await insertTeamMember(database.pool, { teamId, userId, role: 'TEAM_ADMIN' });
  return signedIn(userId);
}
async function globalAdmin(): Promise<HttpMember> {
  const userId = await insertUser(database.pool, 'FEMALE');
  await database.pool.query(`UPDATE users SET role = 'GLOBAL_ADMIN' WHERE id = $1`, [userId]);
  return signedIn(userId);
}

const remind = (
  who: HttpMember | null,
  teamId: string,
  paymentId: string,
  body: unknown = { changeKey: randomUUID() },
): Promise<LightMyRequestResponse> =>
  call(h, 'POST', `/teams/${teamId}/payments/${paymentId}/reminders`, who?.token ?? null, body);
const listAs = (
  who: HttpMember | null,
  teamId: string,
  query = '',
): Promise<LightMyRequestResponse> =>
  call(h, 'GET', `/teams/${teamId}/payments${query}`, who?.token ?? null);

async function reminderRows(paymentId: string) {
  const { rows } = await database.pool.query<{
    change_key: string;
    actor_user_id: string;
    created_at: Date;
  }>(
    `SELECT change_key, actor_user_id, created_at FROM payment_reminders WHERE payment_id = $1 ORDER BY created_at`,
    [paymentId],
  );
  return rows;
}

describe('POST /teams/:teamId/payments/:paymentId/reminders (AC-HAPPY-10, AC-ERROR-8, AC-VERIFY-1)', () => {
  const T0 = new Date('2026-11-12T01:00:00.000Z');

  it('answers 202 for a TEAM_ADMIN and for a GLOBAL_ADMIN, enqueueing one sealed reminder in the same transaction', async () => {
    const s = await scene();
    const admin = await teamAdmin(s.teamId);
    const global = await globalAdmin();
    const first = await owed(s, { dueDate: ago(DAY), status: 'OVERDUE' });
    const second = await owed(s, { dueDate: ago(DAY) });
    h.clock.set(T0);

    const byAdmin = await remind(admin, s.teamId, first.paymentId);
    expect(byAdmin.statusCode).toBe(202);
    expect(byAdmin.json<ReminderResponse>()).toEqual({
      sent: true,
      lastReminderAt: T0.toISOString(),
    });
    const byGlobal = await remind(global, s.teamId, second.paymentId);
    expect(byGlobal.statusCode).toBe(202);

    const sent = emails();
    expect(sent.map((email) => email.to).sort()).toEqual([first.email, second.email].sort());
    for (const email of sent) {
      expect(email.subject).toBe(
        'Reminder: $17.00 for Tuesday Smashers, ' + email.subject.split(', ')[1],
      );
      expect(email.text).toContain(`${WEB}/payments/`);
      expect(email.text).not.toMatch(/akahu/i);
    }
    expect(sent.find((email) => email.to === first.email)?.text).toContain('is now overdue');
    const rows = await reminderRows(first.paymentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_user_id).toBe(admin.userId);
    expect(rows[0]?.created_at.toISOString()).toBe(T0.toISOString());
  });

  it('a replay with the same changeKey returns the same answer and sends and writes nothing, even inside the cooldown', async () => {
    const s = await scene();
    const admin = await teamAdmin(s.teamId);
    const p = await owed(s, { dueDate: ago(DAY) });
    const changeKey = randomUUID();
    h.clock.set(T0);
    const first = await remind(admin, s.teamId, p.paymentId, { changeKey });
    h.clock.set(new Date(T0.getTime() + HOUR));
    const replay = await remind(admin, s.teamId, p.paymentId, { changeKey });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(first.json());
    expect(emails()).toHaveLength(1);
    expect(await reminderRows(p.paymentId)).toHaveLength(1);
  });

  it('refuses a PAID payment with 409 payment_settled and sends nothing', async () => {
    const s = await scene();
    const admin = await teamAdmin(s.teamId);
    const p = await owed(s, { dueDate: ago(DAY), status: 'PAID' });
    const res = await remind(admin, s.teamId, p.paymentId);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('payment_settled');
    expect(emails()).toHaveLength(0);
    expect(await reminderRows(p.paymentId)).toHaveLength(0);
  });

  it('refuses a payment whose attempt is HELD with 409 payment_on_hold and sends nothing (CR-18)', async () => {
    const s = await scene();
    const admin = await teamAdmin(s.teamId);
    const p = await owed(s, { dueDate: ago(HOUR) });
    await insertPaymentAttempt(database.pool, {
      paymentId: p.paymentId,
      amount: '17.00',
      status: 'HELD',
      akahuPaymentId: 'fake_bei_1700_1_abcd',
    });
    const res = await remind(admin, s.teamId, p.paymentId);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('payment_on_hold');
    expect(emails()).toHaveLength(0);
    expect(await reminderRows(p.paymentId)).toHaveLength(0);
  });

  it('enforces the 24 h cooldown exactly: 24 h - 1 ms is 409 reminder_too_soon, exactly 24 h is 202', async () => {
    const s = await scene();
    const admin = await teamAdmin(s.teamId);
    const p = await owed(s, { dueDate: ago(DAY) });
    h.clock.set(T0);
    expect((await remind(admin, s.teamId, p.paymentId)).statusCode).toBe(202);
    h.clock.set(new Date(T0.getTime() + DAY - 1));
    const tooSoon = await remind(admin, s.teamId, p.paymentId);
    expect(tooSoon.statusCode).toBe(409);
    expect(errorOf(tooSoon).code).toBe('reminder_too_soon');
    expect(emails()).toHaveLength(1);
    h.clock.set(new Date(T0.getTime() + DAY));
    const allowed = await remind(admin, s.teamId, p.paymentId);
    expect(allowed.statusCode).toBe(202);
    expect(allowed.json<ReminderResponse>().lastReminderAt).toBe(
      new Date(T0.getTime() + DAY).toISOString(),
    );
    expect(emails()).toHaveLength(2);
    expect(await reminderRows(p.paymentId)).toHaveLength(2);
  });

  it("answers 404 not_found for another team's payment and an unknown id, and a foreign admin gets 403", async () => {
    const mine = await scene({ teamName: 'Mine' });
    const theirs = await scene({ teamName: 'Theirs' });
    const admin = await teamAdmin(mine.teamId);
    const foreign = await owed(theirs, { dueDate: ago(DAY) });
    const ownTeamUrlForeignPayment = await remind(admin, mine.teamId, foreign.paymentId);
    expect(ownTeamUrlForeignPayment.statusCode).toBe(404);
    expect(errorOf(ownTeamUrlForeignPayment).code).toBe('not_found');
    const unknown = await remind(admin, mine.teamId, randomUUID());
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual(ownTeamUrlForeignPayment.json());
    const wrongTeam = await remind(admin, theirs.teamId, foreign.paymentId);
    expect(wrongTeam.statusCode).toBe(403);
    expect(emails()).toHaveLength(0);
    expect(await reminderRows(foreign.paymentId)).toHaveLength(0);
  });

  it('answers 403 to a MEMBER before the body is looked at (even an invalid body), and 401 to nobody', async () => {
    const s = await scene();
    const p = await owed(s, { dueDate: ago(DAY) });
    const member = await httpMember(h, s.teamId);
    for (const body of [{}, { changeKey: 'nope', extra: 1 }, { changeKey: randomUUID() }]) {
      const res = await remind(member, s.teamId, p.paymentId, body);
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).code).toBe('forbidden');
    }
    const anonymous = await remind(null, s.teamId, p.paymentId);
    expect(anonymous.statusCode).toBe(401);
    expect(emails()).toHaveLength(0);
    expect(await reminderRows(p.paymentId)).toHaveLength(0);
  });

  it('refuses a body with extra keys, a missing or malformed changeKey (strict), and writes nothing', async () => {
    const s = await scene();
    const admin = await teamAdmin(s.teamId);
    const p = await owed(s, { dueDate: ago(DAY) });
    for (const body of [
      { changeKey: randomUUID(), status: 'PAID' },
      { changeKey: randomUUID(), userId: randomUUID() },
      {},
      { changeKey: 'not-a-uuid' },
    ]) {
      const res = await remind(admin, s.teamId, p.paymentId, body);
      expect(res.statusCode).toBe(422);
    }
    expect(emails()).toHaveLength(0);
    expect(await reminderRows(p.paymentId)).toHaveLength(0);
    expect(await statusOf(p.paymentId)).toBe('PENDING');
  });

  it('sends once for two concurrent requests with the same changeKey, and honours the cooldown for two different keys', async () => {
    const s = await scene();
    const admin = await teamAdmin(s.teamId);
    const sameKey = await owed(s, { dueDate: ago(DAY) });
    const key = randomUUID();
    h.clock.set(T0);
    const [a, b] = await Promise.all([
      remind(admin, s.teamId, sameKey.paymentId, { changeKey: key }),
      remind(admin, s.teamId, sameKey.paymentId, { changeKey: key }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    expect(a.json()).toEqual(b.json());
    expect(emails()).toHaveLength(1);
    expect(await reminderRows(sameKey.paymentId)).toHaveLength(1);

    jobs.reset();
    const differentKeys = await owed(s, { dueDate: ago(DAY) });
    const results = await Promise.all([
      remind(admin, s.teamId, differentKeys.paymentId),
      remind(admin, s.teamId, differentKeys.paymentId),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409]);
    const refused = results.find((r) => r.statusCode === 409);
    expect(refused === undefined ? '' : errorOf(refused).code).toBe('reminder_too_soon');
    expect(emails()).toHaveLength(1);
    expect(await reminderRows(differentKeys.paymentId)).toHaveLength(1);
  });

  it('logs ids and the outcome only: no email address, bank detail or Akahu text', async () => {
    const s = await scene();
    const admin = await teamAdmin(s.teamId);
    const p = await owed(s, { dueDate: ago(DAY) });
    await remind(admin, s.teamId, p.paymentId);
    await remind(admin, s.teamId, p.paymentId); // refused: too soon
    const text = JSON.stringify(h.logs.lines());
    expect(text).not.toContain(p.email);
    expect(text).not.toContain(ACCOUNT_DIGITS);
    expect(text).not.toMatch(/Bearer\s/i);
    expect(
      h.logs
        .lines()
        .some((line) => line.event === 'billing.reminder.sent' && line.paymentId === p.paymentId),
    ).toBe(true);
  });
});

describe('GET /teams/:teamId/payments (AC-ENTRY-3 API side, AC-VERIFY-1)', () => {
  it('lists unpaid (default), paid and all payments of this team only, newest facts first, with names but never an email or bank detail', async () => {
    const s = await scene({ teamName: 'Lister' });
    const other = await scene({ teamName: 'Other Team' });
    const admin = await teamAdmin(s.teamId);
    const pending = await owed(s, { dueDate: new Date(BASE.getTime() + DAY) });
    const overdue = await owed(s, { dueDate: ago(2 * DAY), status: 'OVERDUE' });
    const paid = await owed(s, { dueDate: ago(3 * DAY), status: 'PAID' });
    const foreign = await owed(other, { dueDate: ago(DAY), status: 'OVERDUE' });

    const unpaid = await listAs(admin, s.teamId);
    expect(unpaid.statusCode).toBe(200);
    const unpaidBody = unpaid.json<AdminPaymentsResponse>();
    expect(unpaidBody.payments.map((p) => p.id)).toEqual([overdue.paymentId, pending.paymentId]);
    expect(unpaidBody.nextCursor).toBeNull();
    expect(unpaidBody.payments[0]).toMatchObject({
      status: 'OVERDUE',
      amount: '17.00',
      player: { userId: overdue.userId, fullName: 'Test Player' },
      lastReminderAt: null,
      onHold: false,
      paidAt: null,
    });

    const paidBody = (await listAs(admin, s.teamId, '?status=PAID')).json<AdminPaymentsResponse>();
    expect(paidBody.payments.map((p) => p.id)).toEqual([paid.paymentId]);
    expect(paidBody.payments[0]?.paidAt).not.toBeNull();

    const all = (await listAs(admin, s.teamId, '?status=ALL')).json<AdminPaymentsResponse>();
    expect(all.payments.map((p) => p.id).sort()).toEqual(
      [pending.paymentId, overdue.paymentId, paid.paymentId].sort(),
    );
    expect(all.payments.map((p) => p.id)).not.toContain(foreign.paymentId);

    const text = unpaid.body + JSON.stringify(all);
    for (const secret of [
      pending.email,
      overdue.email,
      paid.email,
      '@example.test',
      ACCOUNT_DIGITS,
      'Smashers account',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/bank|account|iban/i);
    expect(unpaid.headers['cache-control']).toBe('no-store');
  });

  it('derives lastReminderAt, onHold and payoutBlocked', async () => {
    const s = await scene({ payoutBlocked: true });
    const admin = await teamAdmin(s.teamId);
    const held = await owed(s, { dueDate: ago(DAY) });
    await insertPaymentAttempt(database.pool, {
      paymentId: held.paymentId,
      amount: '17.00',
      status: 'HELD',
      akahuPaymentId: providerId(1700),
    });
    const reminded = await owed(s, { dueDate: ago(DAY) });
    h.clock.set(new Date('2026-11-12T01:00:00.000Z'));
    expect((await remind(admin, s.teamId, reminded.paymentId)).statusCode).toBe(202);

    const body = (await listAs(admin, s.teamId)).json<AdminPaymentsResponse>();
    expect(body.payoutBlocked).toBe(true);
    expect(body.payments.find((p) => p.id === held.paymentId)?.onHold).toBe(true);
    expect(body.payments.find((p) => p.id === reminded.paymentId)).toMatchObject({
      lastReminderAt: '2026-11-12T01:00:00.000Z',
      onHold: false,
    });
  });

  it('allows a GLOBAL_ADMIN for any team and refuses a MEMBER (403), a foreign team admin (403) and nobody (401)', async () => {
    const s = await scene();
    const other = await scene();
    const p = await owed(s, { dueDate: ago(DAY) });
    const global = await globalAdmin();
    const asGlobal = await listAs(global, s.teamId);
    expect(asGlobal.statusCode).toBe(200);
    expect(asGlobal.json<AdminPaymentsResponse>().payments.map((row) => row.id)).toContain(
      p.paymentId,
    );
    const member = await httpMember(h, s.teamId);
    expect((await listAs(member, s.teamId)).statusCode).toBe(403);
    const foreignAdmin = await teamAdmin(other.teamId);
    expect((await listAs(foreignAdmin, s.teamId)).statusCode).toBe(403);
    expect((await listAs(null, s.teamId)).statusCode).toBe(401);
  });

  it('refuses an unknown status or an unreadable cursor with 422', async () => {
    const s = await scene();
    const admin = await teamAdmin(s.teamId);
    expect((await listAs(admin, s.teamId, '?status=LATE')).statusCode).toBe(422);
    expect((await listAs(admin, s.teamId, '?cursor=not-a-cursor')).statusCode).toBe(422);
    expect((await listAs(admin, s.teamId, '?extra=1')).statusCode).toBe(422);
  });

  it('pages with an opaque cursor: every row exactly once across pages, no overlap', async () => {
    const s = await scene();
    const admin = await teamAdmin(s.teamId);
    const payer = await insertMember(database.pool, s.teamId);
    const ids = new Set<string>();
    for (let n = 0; n < 55; n += 1) {
      ids.add(
        await insertPayment(database.pool, {
          userId: payer,
          teamId: s.teamId,
          registrationId: null,
          amount: '5.00',
          dueDate: ago((n % 7) * HOUR + 1000), // many equal due dates: the id breaks the ties
        }),
      );
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await listAs(
        admin,
        s.teamId,
        cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`,
      );
      expect(res.statusCode).toBe(200);
      const body: AdminPaymentsResponse = res.json<AdminPaymentsResponse>();
      seen.push(...body.payments.map((p) => p.id));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...ids].sort());
  });
});
