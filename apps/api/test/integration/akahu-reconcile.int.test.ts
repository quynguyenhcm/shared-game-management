/**
 * The `akahu-reconcile` sweep on a real PostgreSQL (wallet-and-akahu-billing Phase 4a; algorithm H, CR-12, CR-25; AC-ASYNC-3):
 * stale CREATING intents are closed, OPEN intents past the minimum age are re-read and applied through the single funnel (a missed
 * webhook), HELD and CLOSED-with-provider-id intents are polled for finality with hourly-then-daily backoff until the horizon,
 * a provider outage stops the run, and a long-open intent is logged as stuck. Akahu is the scriptable fake (synthetic).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeControl, createFakePaymentsGateway } from '../../src/lib/akahu/fake-adapter.ts';
import { GatewayUnavailableError, type PaymentsGateway } from '../../src/lib/akahu/gateway.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import { QUEUES } from '../../src/jobs/registry.ts';
import { createJobRunner, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import { runAkahuReconcile, type AkahuReconcileDeps } from '../../src/modules/billing/reconcile.ts';
import { testCrypto, testPaymentsConfig } from '../helpers/app-deps.ts';
import {
  insertPayment,
  insertPaymentAttempt,
  insertTeam,
  insertWalletTopUp,
} from '../helpers/factories.ts';
import { captureLogs, type CapturedLogs } from '../helpers/log-capture.ts';
import {
  createRecordingJobs,
  insertMember,
  type RecordingJobs,
} from '../helpers/registration-scene.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

const BASE = new Date('2026-11-10T00:00:00.000Z');
const WEB = 'https://games.example.nz';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const settings = testPaymentsConfig();

const crypto = testCrypto();
const clock = createManualClock(BASE);
const control = createFakeControl();

let database: TestDatabase;
let worker: JobRunner;
let jobs: RecordingJobs;
let logs: CapturedLogs;
const reads: string[] = [];

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 20 });
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
beforeEach(async () => {
  clock.set(BASE);
  control.reset();
  jobs.reset();
  logs = captureLogs();
  reads.length = 0;
  // Earlier tests' intents must not be candidates for this test's run: settle them out of the sweep's reach.
  await database.pool.query(
    `UPDATE payment_attempts SET last_synced_at = '2126-01-01T00:00:00Z' WHERE status IN ('OPEN', 'HELD', 'CLOSED')`,
  );
  await database.pool.query(
    `UPDATE wallet_top_ups SET last_synced_at = '2126-01-01T00:00:00Z' WHERE status IN ('OPEN', 'HELD', 'CLOSED')`,
  );
  await database.pool.query(
    `UPDATE payment_attempts SET status = 'CLOSED', close_reason = 'test', closed_at = now() WHERE status = 'CREATING'`,
  );
});

function observed(inner: PaymentsGateway = createFakePaymentsGateway({ clock, control })) {
  return {
    ...inner,
    getPayment(id: string) {
      reads.push(id);
      return inner.getPayment(id);
    },
  } satisfies PaymentsGateway;
}

const run = (overrides: Partial<AkahuReconcileDeps> = {}) =>
  runAkahuReconcile({
    db: createKysely(database.pool),
    gateway: observed(),
    jobs,
    clock,
    crypto,
    webBaseUrl: WEB,
    log: logs.logger,
    settings,
    ...overrides,
  });

const providerId = (cents: number): string =>
  `fake_ok_${cents}_${BASE.getTime() - DAY}_${randomBytes(4).toString('hex')}`;
const ago = (ms: number): Date => new Date(BASE.getTime() - ms);
const script = (id: string, providerStatus: string, providerStatusReason: string | null = null) =>
  control.scriptGet(id, [{ providerStatus, providerStatusReason }]);

async function owedPayment(): Promise<{ teamId: string; userId: string; paymentId: string }> {
  const teamId = await insertTeam(database.pool, { payoutConfigured: true });
  const userId = await insertMember(database.pool, teamId, {
    email: `payer-${randomUUID()}@example.test`,
  });
  const paymentId = await insertPayment(database.pool, {
    userId,
    teamId,
    registrationId: null,
    amount: '17.00',
    dueDate: new Date(BASE.getTime() + DAY),
  });
  return { teamId, userId, paymentId };
}
async function statusOf(table: 'payments' | 'payment_attempts' | 'wallet_top_ups', id: string) {
  const { rows } = await database.pool.query<{ status: string }>(
    `SELECT status FROM ${table} WHERE id = $1`,
    [id],
  );
  return rows[0]?.status;
}

describe('akahu-reconcile: missed webhooks (AC-ASYNC-3)', () => {
  it('re-reads OPEN intents past the minimum age and applies them: a top-up is credited and a payment paid', async () => {
    const owed = await owedPayment();
    const attemptPid = providerId(1700);
    const attempt = await insertPaymentAttempt(database.pool, {
      paymentId: owed.paymentId,
      amount: '17.00',
      status: 'OPEN',
      akahuPaymentId: attemptPid,
      createdAt: ago(10 * MINUTE),
    });
    const topUpPid = providerId(3000);
    const topUp = await insertWalletTopUp(database.pool, {
      userId: owed.userId,
      teamId: owed.teamId,
      amount: '30.00',
      status: 'OPEN',
      akahuPaymentId: topUpPid,
      createdAt: ago(10 * MINUTE),
    });
    script(attemptPid, 'SENT');
    script(topUpPid, 'SENT');

    const result = await run();
    expect(await statusOf('payments', owed.paymentId)).toBe('PAID');
    expect(await statusOf('payment_attempts', attempt)).toBe('APPLIED');
    expect(await statusOf('wallet_top_ups', topUp)).toBe('APPLIED');
    expect(result).toMatchObject({ checked: 2, stoppedEarly: false });
    expect(logs.lines().find((line) => line.event === 'akahu.reconcile.completed')).toMatchObject({
      checked: 2,
    });
  });

  it('leaves an OPEN intent younger than the minimum age, and one synced recently, unread', async () => {
    const owed = await owedPayment();
    const young = providerId(1700);
    await insertPaymentAttempt(database.pool, {
      paymentId: owed.paymentId,
      amount: '17.00',
      status: 'OPEN',
      akahuPaymentId: young,
      createdAt: ago(settings.reconcileMinAgeSeconds * 1000 - 1000),
    });
    const owed2 = await owedPayment();
    const recent = providerId(1700);
    await insertPaymentAttempt(database.pool, {
      paymentId: owed2.paymentId,
      amount: '17.00',
      status: 'OPEN',
      akahuPaymentId: recent,
      createdAt: ago(20 * MINUTE),
      lastSyncedAt: ago(MINUTE),
    });
    await run();
    expect(reads).not.toContain(young);
    expect(reads).not.toContain(recent);
  });

  it('closes CREATING intents older than the orphan age (never handed out), leaving younger ones', async () => {
    const owed = await owedPayment();
    const stale = await insertPaymentAttempt(database.pool, {
      paymentId: owed.paymentId,
      amount: '17.00',
      status: 'CREATING',
      createdAt: ago(settings.reconcileOrphanAgeSeconds * 1000 + 1000),
    });
    const staleTopUp = await insertWalletTopUp(database.pool, {
      userId: owed.userId,
      teamId: owed.teamId,
      amount: '20.00',
      status: 'CREATING',
      createdAt: ago(settings.reconcileOrphanAgeSeconds * 1000 + 1000),
    });
    const owed2 = await owedPayment();
    const fresh = await insertPaymentAttempt(database.pool, {
      paymentId: owed2.paymentId,
      amount: '17.00',
      status: 'CREATING',
      createdAt: ago(10_000),
    });
    const result = await run();
    expect(await statusOf('payment_attempts', stale)).toBe('CLOSED');
    expect(await statusOf('wallet_top_ups', staleTopUp)).toBe('CLOSED');
    expect(await statusOf('payment_attempts', fresh)).toBe('CREATING');
    expect(result.closedCreating).toBe(2);
    const { rows } = await database.pool.query<{ close_reason: string }>(
      `SELECT close_reason FROM payment_attempts WHERE id = $1`,
      [stale],
    );
    expect(rows[0]?.close_reason).toBe('create_abandoned');
  });

  it('reads at most the batch size per run', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      const owed = await owedPayment();
      const id = providerId(1700);
      ids.push(id);
      await insertPaymentAttempt(database.pool, {
        paymentId: owed.paymentId,
        amount: '17.00',
        status: 'OPEN',
        akahuPaymentId: id,
        createdAt: ago(30 * MINUTE),
      });
      script(id, 'SUBMITTED');
    }
    await run({ batchSize: 2 });
    expect(reads).toHaveLength(2);
  });

  it('stops scheduling reads when the provider is unavailable, reading no more than the parallelism', async () => {
    for (let n = 0; n < 8; n += 1) {
      const owed = await owedPayment();
      await insertPaymentAttempt(database.pool, {
        paymentId: owed.paymentId,
        amount: '17.00',
        status: 'OPEN',
        akahuPaymentId: providerId(1700),
        createdAt: ago(30 * MINUTE),
      });
    }
    const down: PaymentsGateway = {
      ...createFakePaymentsGateway({ clock, control }),
      getPayment: () => Promise.reject(new GatewayUnavailableError('provider_unavailable')),
    };
    const result = await run({ gateway: observed(down) });
    expect(result.stoppedEarly).toBe(true);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.length).toBeLessThanOrEqual(4);
    expect(logs.lines().some((line) => line.event === 'akahu.reconcile.unavailable')).toBe(true);
  });

  it('logs a long-open intent as stuck (ids and age only)', async () => {
    const owed = await owedPayment();
    const id = providerId(1700);
    const attempt = await insertPaymentAttempt(database.pool, {
      paymentId: owed.paymentId,
      amount: '17.00',
      status: 'OPEN',
      akahuPaymentId: id,
      createdAt: ago(settings.reconcileStuckAfterSeconds * 1000 + HOUR),
    });
    script(id, 'SUBMITTED');
    await run();
    const stuck = logs.lines().find((line) => line.event === 'akahu.reconcile.stuck');
    expect(stuck).toMatchObject({ intentKind: 'ATTEMPT', intentId: attempt });
    expect(stuck?.ageSeconds).toBeGreaterThan(settings.reconcileStuckAfterSeconds);
    expect(JSON.stringify(stuck)).not.toContain('17.00');
  });
});

describe('akahu-reconcile: finality polling (CR-25)', () => {
  it('a HELD attempt that Akahu later reports SENT is paid once (HELD -> SENT)', async () => {
    const owed = await owedPayment();
    const id = providerId(1700);
    const attempt = await insertPaymentAttempt(database.pool, {
      paymentId: owed.paymentId,
      amount: '17.00',
      status: 'HELD',
      akahuPaymentId: id,
      createdAt: ago(3 * HOUR),
      settledAt: ago(2 * HOUR),
      lastSyncedAt: ago(2 * HOUR),
    });
    script(id, 'SENT');
    await run();
    expect(await statusOf('payment_attempts', attempt)).toBe('APPLIED');
    expect(await statusOf('payments', owed.paymentId)).toBe('PAID');
  });

  it('a CLOSED attempt reported SENT after the player retried and paid is UNAPPLIED (DUPLICATE), never paid twice', async () => {
    const owed = await owedPayment();
    const firstId = providerId(1700);
    const first = await insertPaymentAttempt(database.pool, {
      paymentId: owed.paymentId,
      amount: '17.00',
      status: 'CLOSED',
      akahuPaymentId: firstId,
      createdAt: ago(5 * HOUR),
      settledAt: ago(4 * HOUR),
      lastSyncedAt: ago(4 * HOUR),
    });
    await database.pool.query(
      `UPDATE payments SET status = 'PAID', paid_at = $2, akahu_payment_id = 'retry-paid' WHERE id = $1`,
      [owed.paymentId, ago(3 * HOUR)],
    );
    script(firstId, 'SENT');
    await run();
    const { rows } = await database.pool.query<{ status: string; unapplied_reason: string }>(
      `SELECT status, unapplied_reason FROM payment_attempts WHERE id = $1`,
      [first],
    );
    expect(rows[0]).toEqual({ status: 'UNAPPLIED', unapplied_reason: 'DUPLICATE' });
    const { rows: payment } = await database.pool.query<{ akahu_payment_id: string }>(
      `SELECT akahu_payment_id FROM payments WHERE id = $1`,
      [owed.paymentId],
    );
    expect(payment[0]?.akahu_payment_id).toBe('retry-paid');
  });

  it('polls hourly in the first day, daily after, and stops at the finality horizon', async () => {
    const make = async (settledAgo: number, syncedAgo: number): Promise<string> => {
      const owed = await owedPayment();
      const id = providerId(1700);
      await insertPaymentAttempt(database.pool, {
        paymentId: owed.paymentId,
        amount: '17.00',
        status: 'CLOSED',
        akahuPaymentId: id,
        createdAt: ago(settledAgo + HOUR),
        settledAt: ago(settledAgo),
        lastSyncedAt: ago(syncedAgo),
      });
      script(id, 'CANCELLED', 'USER_CANCELLED');
      return id;
    };
    const firstDayDue = await make(3 * HOUR, HOUR + MINUTE);
    const firstDayNotDue = await make(3 * HOUR, 30 * MINUTE);
    const laterDue = await make(3 * DAY, DAY + MINUTE);
    const laterNotDue = await make(3 * DAY, 2 * HOUR);
    const pastHorizon = await make(settings.finalityHorizonHours * HOUR + HOUR, 2 * DAY);
    const laterLongUnread = await make(2 * DAY, 2 * DAY);
    await run();
    expect(reads).toEqual(expect.arrayContaining([firstDayDue, laterDue, laterLongUnread]));
    expect(reads).not.toContain(firstDayNotDue);
    expect(reads).not.toContain(laterNotDue);
    expect(reads).not.toContain(pastHorizon);
  });
});
