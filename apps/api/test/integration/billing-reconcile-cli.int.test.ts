/**
 * `cli billing reconcile` on a real PostgreSQL (wallet-and-akahu-billing Phase 6; AC-VERIFY-12). The clean state is produced by the
 * real services (`bill-session`, `syncAkahuPayment`, the ledger writer behind them), so the check proves the money invariants hold
 * for what the application writes. Each discrepancy kind is then seeded with direct SQL inside a transaction that disables only the
 * guard that would refuse it, runs the check on that same connection and ROLLS BACK, so the shared clean state is never disturbed.
 * One last test commits a discrepancy to prove the process exit code and that the output carries ids and no email.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createFakeControl, createFakePaymentsGateway } from '../../src/lib/akahu/fake-adapter.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import { QUEUES } from '../../src/jobs/registry.ts';
import { createJobRunner } from '../../src/lib/jobs/jobs.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import { billSession } from '../../src/modules/billing/bill-session.ts';
import { syncAkahuPayment } from '../../src/modules/billing/apply-akahu-result.ts';
import {
  runBillingReconcile,
  type Discrepancy,
  type ReconcileReport,
} from '../../src/modules/billing/reconcile-cli.ts';
import { testCrypto } from '../helpers/app-deps.ts';
import {
  insertPaymentAttempt,
  insertPublishedSession,
  insertRegistration,
  insertTeam,
  insertTeamMember,
  insertUser,
  insertWallet,
  insertWalletTopUp,
  paymentReference,
} from '../helpers/factories.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import { createRecordingJobs, insertMember } from '../helpers/registration-scene.ts';
import { spawnNode } from '../helpers/spawn-node.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

const BASE = new Date('2026-11-10T00:00:00.000Z');
const clock = createManualClock(BASE);
const control = createFakeControl();
const logs = captureLogs();
const crypto = testCrypto();

let database: TestDatabase;

interface Scene {
  readonly teamId: string;
  readonly deductionUserId: string;
  readonly deductionRegistrationId: string;
  readonly walletId: string;
  readonly perGamePaymentId: string;
  readonly topUpUserId: string;
  readonly topUpAkahuId: string;
  readonly holdTopUpId: string;
  readonly payerEmail: string;
}
let scene: Scene;

const providerId = (cents: number): string =>
  `fake_ok_${cents}_${BASE.getTime() - 60_000}_${randomBytes(4).toString('hex')}`;

const syncDeps = () => ({
  db: createKysely(database.pool),
  gateway: createFakePaymentsGateway({ clock, control }),
  jobs: createRecordingJobs(),
  clock,
  crypto,
  webBaseUrl: 'https://games.example.nz',
  log: logs.logger,
});

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 10 });
  const teamId = await insertTeam(database.pool, { payoutConfigured: true });
  await insertTeamMember(database.pool, {
    teamId,
    userId: await insertUser(database.pool, 'FEMALE'),
    role: 'TEAM_ADMIN',
  });
  const { sessionId } = await insertPublishedSession(database.pool, teamId, { now: BASE });
  const { rows } = await database.pool.query<{ ends_at: Date }>(
    'SELECT ends_at FROM game_sessions WHERE id = $1',
    [sessionId],
  );
  clock.set(rows[0]?.ends_at ?? BASE);

  // Player A: a funded wallet, so billing deducts (PAID PREPAID_CREDIT + AUTO_DEDUCTION).
  const deductionUserId = await insertMember(database.pool, teamId);
  const deductionRegistrationId = await insertRegistration(database.pool, {
    sessionId,
    teamId,
    userId: deductionUserId,
  });
  const walletId = await insertWallet(database.pool, deductionUserId, teamId, '30.00');
  // Player B: no wallet, so billing creates a PENDING PER_GAME payment that a SENT attempt then pays.
  const payerEmail = `payer-${randomUUID()}@example.test`;
  const payerId = await insertMember(database.pool, teamId, { email: payerEmail });
  await insertRegistration(database.pool, { sessionId, teamId, userId: payerId });

  await billSession(
    {
      db: createKysely(database.pool),
      jobs: createRecordingJobs(),
      clock,
      crypto,
      webBaseUrl: 'https://games.example.nz',
      log: logs.logger,
    },
    { sessionId },
  );
  const payment = await database.pool.query<{ id: string }>(
    `SELECT id FROM payments WHERE user_id = $1 AND status = 'PENDING'`,
    [payerId],
  );
  const perGamePaymentId = payment.rows[0]?.id ?? '';
  const attemptAkahuId = providerId(1700);
  await insertPaymentAttempt(database.pool, {
    paymentId: perGamePaymentId,
    amount: '17.00',
    status: 'OPEN',
    akahuPaymentId: attemptAkahuId,
  });
  control.scriptGet(attemptAkahuId, [{ providerStatus: 'SENT', providerStatusReason: null }]);
  await syncAkahuPayment(syncDeps(), { akahuPaymentId: attemptAkahuId, source: 'webhook' });

  // Player C: a top-up applied through the funnel (TOPUP credit with its Akahu id).
  const topUpUserId = await insertMember(database.pool, teamId);
  const topUpAkahuId = providerId(2000);
  await insertWalletTopUp(database.pool, {
    userId: topUpUserId,
    teamId,
    amount: '20.00',
    status: 'OPEN',
    akahuPaymentId: topUpAkahuId,
  });
  control.scriptGet(topUpAkahuId, [{ providerStatus: 'SENT', providerStatusReason: null }]);
  await syncAkahuPayment(syncDeps(), { akahuPaymentId: topUpAkahuId, source: 'webhook' });

  // Player D: a top-up hold (CR-15), informational only.
  const holdUserId = await insertMember(database.pool, teamId);
  const holdTopUpId = await insertWalletTopUp(database.pool, {
    userId: holdUserId,
    teamId,
    amount: '10.00',
    status: 'HELD',
    akahuPaymentId: providerId(1000),
  });
  scene = {
    teamId,
    deductionUserId,
    deductionRegistrationId,
    walletId,
    perGamePaymentId,
    topUpUserId,
    topUpAkahuId,
    holdTopUpId,
    payerEmail,
  };
});
afterAll(async () => {
  await database.close();
});

const kinds = (report: ReconcileReport): string[] => report.discrepancies.map((d) => d.kind);
const find = (report: ReconcileReport, kind: Discrepancy['kind']): Discrepancy | undefined =>
  report.discrepancies.find((d) => d.kind === kind);

/** Seeds with `seed` on one connection, runs the check on that connection, and always rolls back. */
async function seeded(seed: (client: pg.PoolClient) => Promise<void>): Promise<ReconcileReport> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await seed(client);
    return await runBillingReconcile(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function cli(): Promise<{ code: number | null; output: string }> {
  const child = spawnNode('src/cli.ts', ['billing', 'reconcile'], {
    DATABASE_URL: database.url,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
  });
  const { code } = await child.exited;
  return { code, output: child.output() };
}

describe('billing reconcile on state produced by the real services', () => {
  it('the scene really holds a deduction, a paid per-game payment, a top-up credit and a hold', async () => {
    const counts = await database.pool.query<{ k: string; n: string }>(
      `SELECT 'deduction' AS k, count(*)::text AS n FROM credit_transactions WHERE transaction_type = 'AUTO_DEDUCTION'
       UNION ALL SELECT 'paid_per_game', count(*)::text FROM payments WHERE billing_type = 'PER_GAME' AND status = 'PAID'
       UNION ALL SELECT 'topup', count(*)::text FROM credit_transactions WHERE transaction_type = 'TOPUP' AND akahu_payment_id = '${scene.topUpAkahuId}'`,
    );
    expect(Object.fromEntries(counts.rows.map((row) => [row.k, row.n]))).toEqual({
      deduction: '1',
      paid_per_game: '1',
      topup: '1',
    });
  });

  it('reports zero discrepancies and lists the top-up hold as information, exit code 0', async () => {
    const report = await runBillingReconcile(database.pool);
    expect(report.discrepancies).toEqual([]);
    expect(report.holds.map((hold) => hold.id)).toEqual([scene.holdTopUpId]);
    expect(report.holds[0]).toMatchObject({ amount: '10.00', teamId: scene.teamId });
    const result = await cli();
    expect(result.code).toBe(0);
    expect(result.output).toContain('OK, 0 discrepancies');
    expect(result.output).toContain(`INFO top-up hold id=${scene.holdTopUpId}`);
  });
});

describe('each discrepancy kind is reported by id (AC-VERIFY-12)', () => {
  it('WALLET_BALANCE_SUM and WALLET_BALANCE_TAIL: a balance that no longer matches its ledger', async () => {
    const report = await seeded(async (client) => {
      await client.query('ALTER TABLE player_credits DISABLE TRIGGER player_credits_guard');
      await client.query('UPDATE player_credits SET balance = balance + 1.00 WHERE id = $1', [
        scene.walletId,
      ]);
    });
    expect(find(report, 'WALLET_BALANCE_SUM')).toMatchObject({
      id: scene.walletId,
      detail: 'balance=14.00 ledger_sum=13.00',
    });
    expect(find(report, 'WALLET_BALANCE_TAIL')?.id).toBe(scene.walletId);
    expect(kinds(report)).toEqual(['WALLET_BALANCE_SUM', 'WALLET_BALANCE_TAIL']);
  });

  it('LEDGER_CHAIN_BREAK: a ledger row whose starting balance matches no earlier row', async () => {
    let rowId = '';
    const report = await seeded(async (client) => {
      await client.query(
        'ALTER TABLE credit_transactions DISABLE TRIGGER credit_transactions_ledger_chain',
      );
      const intent = await client.query<{ id: string }>(
        `INSERT INTO wallet_top_ups (user_id, team_id, reference, idempotency_key, amount, status, akahu_payment_id)
         VALUES ($1, $2, $3, $4, 5.00, 'APPLIED', $5) RETURNING id`,
        [scene.topUpUserId, scene.teamId, paymentReference(), randomUUID(), providerId(500)],
      );
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO credit_transactions (user_id, team_id, amount, transaction_type, akahu_payment_id,
                                          wallet_top_up_id, resulting_balance)
         VALUES ($1, $2, 5.00, 'TOPUP', $3, $4, 77.00) RETURNING id`,
        [scene.topUpUserId, scene.teamId, providerId(500), intent.rows[0]?.id],
      );
      rowId = inserted.rows[0]?.id ?? '';
    });
    expect(rowId).not.toBe('');
    expect(find(report, 'LEDGER_CHAIN_BREAK')).toMatchObject({ id: rowId, detail: 'amount=5.00' });
  });

  it('DEDUCTION_UNPAID: an AUTO_DEDUCTION whose payment is no longer a PAID PREPAID_CREDIT payment', async () => {
    const deduction = await database.pool.query<{ id: string; payment_id: string }>(
      `SELECT c.id, p.id AS payment_id FROM credit_transactions c
         JOIN payments p ON p.registration_id = c.registration_id
        WHERE c.registration_id = $1`,
      [scene.deductionRegistrationId],
    );
    const { id: creditId, payment_id: paymentId } = deduction.rows[0] ?? { id: '', payment_id: '' };
    const report = await seeded(async (client) => {
      await client.query('ALTER TABLE payments DISABLE TRIGGER payments_guard_immutable');
      await client.query(`UPDATE payments SET billing_type = 'PER_GAME' WHERE id = $1`, [
        paymentId,
      ]);
    });
    expect(find(report, 'DEDUCTION_UNPAID')).toMatchObject({
      id: creditId,
      detail: 'amount=-17.00',
    });
    // The same flipped payment is now a PAID PER_GAME payment with no Akahu id.
    expect(find(report, 'PER_GAME_NO_AKAHU')?.id).toBe(paymentId);
  });

  it('PER_GAME_NO_AKAHU: a PAID PER_GAME payment that lost its Akahu payment id', async () => {
    const report = await seeded(async (client) => {
      await client.query('UPDATE payments SET akahu_payment_id = NULL WHERE id = $1', [
        scene.perGamePaymentId,
      ]);
    });
    expect(kinds(report)).toEqual(['PER_GAME_NO_AKAHU']);
    expect(report.discrepancies[0]).toMatchObject({
      id: scene.perGamePaymentId,
      detail: 'amount=17.00',
    });
  });

  it('TOPUP_NO_AKAHU: a TOPUP ledger row without an Akahu payment id', async () => {
    const credit = await database.pool.query<{ id: string }>(
      `SELECT id FROM credit_transactions WHERE akahu_payment_id = $1`,
      [scene.topUpAkahuId],
    );
    const creditId = credit.rows[0]?.id;
    const report = await seeded(async (client) => {
      await client.query(
        'ALTER TABLE credit_transactions DISABLE TRIGGER credit_transactions_append_only',
      );
      await client.query(
        'ALTER TABLE credit_transactions DROP CONSTRAINT credit_transactions_type_shape',
      );
      await client.query('UPDATE credit_transactions SET akahu_payment_id = NULL WHERE id = $1', [
        creditId,
      ]);
    });
    expect(find(report, 'TOPUP_NO_AKAHU')).toMatchObject({ id: creditId, detail: 'amount=20.00' });
  });

  it('rolled back: the shared state is clean again afterwards', async () => {
    expect((await runBillingReconcile(database.pool)).discrepancies).toEqual([]);
  });
});

describe('the process exit code and its output', () => {
  it('exits 1 on a committed discrepancy, printing the id and no email or Akahu id', async () => {
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE player_credits DISABLE TRIGGER player_credits_guard');
      await client.query('UPDATE player_credits SET balance = balance + 1.00 WHERE id = $1', [
        scene.walletId,
      ]);
      await client.query('ALTER TABLE player_credits ENABLE TRIGGER player_credits_guard');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const result = await cli();
    expect(result.code).toBe(1);
    expect(result.output).toContain(`DISCREPANCY WALLET_BALANCE_SUM id=${scene.walletId}`);
    expect(result.output).toContain('2 discrepancy(ies)');
    expect(result.output).not.toContain(scene.payerEmail);
    expect(result.output).not.toContain('@');
    expect(result.output).not.toContain(scene.topUpAkahuId);
  });

  it('rejects an unexpected argument with usage and a non-zero exit before touching the database', async () => {
    const child = spawnNode('src/cli.ts', ['billing', 'reconcile', '--oops'], {
      DATABASE_URL: database.url,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
    const { code } = await child.exited;
    expect(code).toBe(2);
    expect(child.output()).toContain('Usage: billing reconcile');
  });
});

describe('cli billing block-payout (CR-14 convenience wrapper over blockPayout)', () => {
  it('blocks the team, records one event with no actor, and a second run reports it already blocked', async () => {
    // The queues exist once a worker has booted (it defines them); the CLI is a producer only.
    const worker = createJobRunner({
      databaseUrl: database.url,
      logger: logs.logger,
      role: 'worker',
    });
    await worker.start();
    for (const queue of QUEUES) await worker.defineQueue(queue);
    await worker.stop();
    const run = async () => {
      const child = spawnNode(
        'src/cli.ts',
        ['billing', 'block-payout', scene.teamId, 'TEAM_REQUESTED'],
        { DATABASE_URL: database.url, NODE_ENV: 'test', LOG_LEVEL: 'silent' },
      );
      const { code } = await child.exited;
      return { code, output: child.output() };
    };
    const first = await run();
    expect(first.output).toContain('is now blocked');
    expect(first.code).toBe(0);
    expect(first.output).toContain('is now blocked');
    const second = await run();
    expect(second.code).toBe(0);
    expect(second.output).toContain('was already blocked');
    const events = await database.pool.query<{ n: string; actors: string }>(
      `SELECT count(*)::text AS n, count(actor_user_id)::text AS actors
         FROM payout_block_events WHERE team_id = $1`,
      [scene.teamId],
    );
    expect(events.rows[0]).toEqual({ n: '2', actors: '0' });
    const team = await database.pool.query<{ blocked: boolean }>(
      `SELECT payout_blocked_at IS NOT NULL AS blocked FROM teams WHERE id = $1`,
      [scene.teamId],
    );
    expect(team.rows[0]?.blocked).toBe(true);
  });

  it('refuses a bad team id or reason before touching the database', async () => {
    const child = spawnNode('src/cli.ts', ['billing', 'block-payout', 'nope', 'OTHER'], {
      DATABASE_URL: database.url,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
    expect((await child.exited).code).toBe(2);
    expect(child.output()).toContain('Usage: billing block-payout');
  });
});
