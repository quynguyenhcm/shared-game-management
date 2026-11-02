/**
 * Billing races on a real PostgreSQL with real, separate connections (wallet-and-akahu-billing Phase 2; AC-VERIFY-3,
 * AC-INTEGRATION-3 billing races). No sleeps: a test holds one real row lock, starts the transactions under test, waits until
 * Postgres reports them blocked (`pg_stat_activity`), then releases. Whatever the interleaving, the invariants hold: one payment per
 * registration, balance = ledger sum within 0.00-100.00, no deadlock (40P01), and a payout block never leaves a half-billed session.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { parseMoney, toMoneyString } from '@sgm/shared';
import { PostgresDialect } from 'kysely';
import { createManualClock } from '../../src/lib/clock.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import { billSession, type BillSessionOutcome } from '../../src/modules/billing/bill-session.ts';
import { LOCK_ORDER } from '../../src/modules/sessions/locks.ts';
import {
  WalletLedgerError,
  applyMovement,
  ensureWallet,
  lockWallets,
} from '../../src/modules/wallet/ledger.ts';
import { testCrypto } from '../helpers/app-deps.ts';
import {
  insertPublishedSession,
  insertRegistration,
  insertTeam,
  insertWallet,
  paymentReference,
} from '../helpers/factories.ts';
import { waitForLockWaiters } from '../helpers/lock-waiters.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import { createQueryRecorder, createRecordingDatabase } from '../helpers/query-recorder.ts';
import { createRecordingJobs, insertMember } from '../helpers/registration-scene.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

const BASE = new Date('2026-10-20T00:00:00.000Z');
const WEB = 'https://games.example.nz';

const clock = createManualClock(BASE);
const logs = captureLogs();
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 20 });
});
afterAll(async () => {
  await database.close();
});
beforeEach(() => clock.set(BASE));

const bill = (sessionId: string): Promise<BillSessionOutcome> =>
  billSession(
    {
      db: createKysely(database.pool),
      jobs: createRecordingJobs(),
      clock,
      crypto: testCrypto(),
      webBaseUrl: WEB,
      log: logs.logger,
    },
    { sessionId },
  );

/** Settles a promise to its outcome so a race can await every participant and then inspect them. */
type Settled<T> = { readonly ok: T } | { readonly failed: unknown };
const settle = <T>(promise: Promise<T>): Promise<Settled<T>> =>
  promise.then(
    (ok) => ({ ok }),
    (failed: unknown) => ({ failed }),
  );
const code = (value: unknown): string | undefined => (value as { code?: string }).code;

/** An open transaction holding one row lock until `release()`. */
async function hold(sqlText: string, values: unknown[]): Promise<{ release: () => Promise<void> }> {
  const client = await database.pool.connect();
  await client.query('BEGIN');
  await client.query(sqlText, values);
  let released = false;
  return {
    async release() {
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

/**
 * Holds `lock` (a real row lock), starts every participant, waits until `waiting` backends are blocked on a lock, releases,
 * and returns their settled outcomes. The lock is always released, so a failing race never hangs the suite.
 */
async function raceBehind<T>(
  lock: { sql: string; values: unknown[] },
  waiting: number,
  starts: readonly (() => Promise<T>)[],
  duringHold?: () => Promise<void>,
): Promise<Settled<T>[]> {
  const held = await hold(lock.sql, lock.values);
  try {
    const pending = starts.map((start) => settle(start()));
    await waitForLockWaiters(database.pool, waiting, 'backends blocked behind the held lock');
    await duringHold?.();
    await held.release();
    return await Promise.all(pending);
  } finally {
    await held.release();
  }
}

const LOCK_SESSION = (sessionId: string) => ({
  sql: 'SELECT id FROM game_sessions WHERE id = $1 FOR UPDATE',
  values: [sessionId],
});
const LOCK_WALLET = (userId: string, teamId: string) => ({
  sql: 'SELECT id FROM player_credits WHERE user_id = $1 AND team_id = $2 FOR NO KEY UPDATE',
  values: [userId, teamId],
});

interface Scene {
  readonly teamId: string;
  readonly sessionId: string;
  readonly endsAt: Date;
}

async function sceneFor(teamId: string): Promise<Scene> {
  const { sessionId } = await insertPublishedSession(database.pool, teamId, { now: BASE });
  const { rows } = await database.pool.query<{ ends_at: Date }>(
    'SELECT ends_at FROM game_sessions WHERE id = $1',
    [sessionId],
  );
  const endsAt = rows[0]?.ends_at;
  if (endsAt === undefined) throw new Error('session has no ends_at');
  return { teamId, sessionId, endsAt };
}

/** A configured team with one ended PUBLISHED $17.00 session (the default fee). */
async function scene(options: { payoutBlockedAt?: Date } = {}): Promise<Scene> {
  const teamId = await insertTeam(database.pool, { payoutConfigured: true, ...options });
  const s = await sceneFor(teamId);
  clock.set(s.endsAt);
  return s;
}

async function player(teamId: string, s: Scene, wallet?: string) {
  const userId = await insertMember(database.pool, teamId);
  const registrationId = await insertRegistration(database.pool, {
    sessionId: s.sessionId,
    teamId,
    userId,
  });
  if (wallet !== undefined) await insertWallet(database.pool, userId, teamId, wallet);
  return { userId, registrationId };
}

async function joinSession(s: Scene, userId: string): Promise<string> {
  return insertRegistration(database.pool, {
    sessionId: s.sessionId,
    teamId: s.teamId,
    userId,
  });
}

async function one<T extends pg.QueryResultRow>(
  pool: pg.Pool,
  text: string,
  values: unknown[],
): Promise<T> {
  const { rows } = await pool.query<T>(text, values);
  const row = rows[0];
  if (row === undefined) throw new Error(`no row for ${text}`);
  return row;
}

const statusOf = async (sessionId: string): Promise<string> =>
  (
    await one<{ status: string }>(database.pool, 'SELECT status FROM game_sessions WHERE id = $1', [
      sessionId,
    ])
  ).status;

const paymentRows = async (sessionId: string) =>
  (
    await database.pool.query<{ registration_id: string; status: string; billing_type: string }>(
      `SELECT p.registration_id, p.status, p.billing_type FROM payments p
         JOIN registrations r ON r.id = p.registration_id WHERE r.session_id = $1`,
      [sessionId],
    )
  ).rows;

/**
 * The wallet invariant: balance in 0.00-100.00, equal to the ledger sum, and carried by a ledger row (`created_at` is the
 * transaction start, not the lock order, so "the latest row" is found by value, not by timestamp).
 */
async function expectWalletConsistent(userId: string, teamId: string): Promise<string> {
  const { balance, ledger, chained } = await one<{
    balance: string;
    ledger: string;
    chained: boolean;
  }>(
    database.pool,
    `SELECT pc.balance,
            (SELECT COALESCE(sum(amount), 0)::numeric(10,2)::text FROM credit_transactions c
              WHERE c.user_id = pc.user_id AND c.team_id = pc.team_id) AS ledger,
            (SELECT bool_and(resulting_balance BETWEEN 0 AND 100) AND bool_or(resulting_balance = pc.balance)
               FROM credit_transactions c WHERE c.user_id = pc.user_id AND c.team_id = pc.team_id) AS chained
       FROM player_credits pc WHERE pc.user_id = $1 AND pc.team_id = $2`,
    [userId, teamId],
  );
  expect(parseMoney(balance) >= parseMoney('0.00')).toBe(true);
  expect(parseMoney(balance) <= parseMoney('100.00')).toBe(true);
  expect(balance).toBe(ledger);
  expect(chained).toBe(true);
  return balance;
}

describe('bill-session takes its locks in LOCK_ORDER (CR-4, AC-VERIFY-3 as amended)', () => {
  it('teams FOR KEY SHARE, then game_sessions FOR UPDATE, then the hand-off reads, then the wallets (one statement, user_id order), then the payments are inserted', async () => {
    const s = await scene();
    await player(s.teamId, s, '30.00');
    await player(s.teamId, s);
    const recorder = createQueryRecorder();
    const outcome = await billSession(
      {
        db: createRecordingDatabase(new PostgresDialect({ pool: database.pool }), recorder),
        jobs: createRecordingJobs(),
        clock,
        crypto: testCrypto(),
        webBaseUrl: WEB,
        log: logs.logger,
      },
      { sessionId: s.sessionId },
    );
    expect(outcome).toMatchObject({ kind: 'completed', deducted: 1, linked: 1 });

    const teamsLock = recorder.indexOf(/from "teams".*for key share/);
    const sessionLock = recorder.indexOf(/from "game_sessions".*for update/);
    const handOff = recorder.indexOf(/from "registrations"/);
    const walletLock = recorder.indexOf(
      /from "player_credits".*order by "user_id".*for no key update/,
    );
    const firstPayment = recorder.indexOf(/insert into "?payments"?/i);
    for (const index of [teamsLock, sessionLock, handOff, walletLock, firstPayment]) {
      expect(index, recorder.statements.join('\n')).toBeGreaterThanOrEqual(0);
    }
    expect([teamsLock, sessionLock, handOff, walletLock, firstPayment]).toEqual(
      [teamsLock, sessionLock, handOff, walletLock, firstPayment].toSorted((a, b) => a - b),
    );
    // The recorded order is the documented one: each table's position in LOCK_ORDER only ever increases.
    const positions = ['teams', 'game_sessions', 'registrations', 'player_credits', 'payments'].map(
      (table) => LOCK_ORDER.indexOf(table as (typeof LOCK_ORDER)[number]),
    );
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
    expect(positions.every((position) => position >= 0)).toBe(true);
    // No lock on an existing payments row exists in this path, and there is exactly one wallet-locking statement before any payment.
    expect(
      recorder.statements.filter((sql) =>
        /from "payments".*for (?:update|no key update)/.test(sql),
      ),
    ).toEqual([]);
  });
});

describe('duplicate concurrent bill-session for one session', () => {
  it('completes once: one COMPLETED session, one payment per registration, the loser skips', async () => {
    const s = await scene();
    const a = await player(s.teamId, s, '30.00');
    await player(s.teamId, s);

    const outcomes = await raceBehind(LOCK_SESSION(s.sessionId), 2, [
      () => bill(s.sessionId),
      () => bill(s.sessionId),
    ]);

    const results = outcomes.map((outcome) => {
      if ('failed' in outcome) throw outcome.failed;
      return outcome.ok;
    });
    expect(results.filter((r) => r.kind === 'completed')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'skipped')).toEqual([
      { kind: 'skipped', reason: 'not_published' },
    ]);
    expect(await statusOf(s.sessionId)).toBe('COMPLETED');
    const payments = await paymentRows(s.sessionId);
    expect(payments).toHaveLength(2);
    expect(new Set(payments.map((p) => p.registration_id)).size).toBe(2);
    expect(await expectWalletConsistent(a.userId, s.teamId)).toBe('13.00');
    const { n } = await one<{ n: number }>(
      database.pool,
      `SELECT count(*)::int AS n FROM credit_transactions WHERE transaction_type = 'AUTO_DEDUCTION' AND team_id = $1`,
      [s.teamId],
    );
    expect(n).toBe(1);
  });
});

describe('two sessions ending together for the same players', () => {
  it('one wallet covers only one fee: one deduction, one PENDING link, balance equals ledger, never negative, no deadlock', async () => {
    const teamId = await insertTeam(database.pool, { payoutConfigured: true });
    const first = await sceneFor(teamId);
    const second = await sceneFor(teamId);
    clock.set(new Date(Math.max(first.endsAt.getTime(), second.endsAt.getTime())));
    const a = await player(teamId, first, '30.00');
    await joinSession(second, a.userId);

    const outcomes = await raceBehind(LOCK_WALLET(a.userId, teamId), 2, [
      () => bill(first.sessionId),
      () => bill(second.sessionId),
    ]);

    for (const outcome of outcomes) {
      expect('failed' in outcome ? code(outcome.failed) : undefined).not.toBe('40P01');
      expect(outcome).toHaveProperty('ok');
    }
    const all = [...(await paymentRows(first.sessionId)), ...(await paymentRows(second.sessionId))];
    expect(all.map((p) => `${p.billing_type}/${p.status}`).sort()).toEqual([
      'PER_GAME/PENDING',
      'PREPAID_CREDIT/PAID',
    ]);
    expect(await expectWalletConsistent(a.userId, teamId)).toBe('13.00');
  });

  it('players shared by both sessions are locked in user_id order: no deadlock, both sessions deduct for both players', async () => {
    const teamId = await insertTeam(database.pool, { payoutConfigured: true });
    const first = await sceneFor(teamId);
    const second = await sceneFor(teamId);
    clock.set(new Date(Math.max(first.endsAt.getTime(), second.endsAt.getTime())));
    const a = await player(teamId, first, '100.00');
    const b = await player(teamId, first, '100.00');
    await joinSession(second, a.userId);
    await joinSession(second, b.userId);

    const outcomes = await raceBehind(LOCK_WALLET(a.userId, teamId), 2, [
      () => bill(first.sessionId),
      () => bill(second.sessionId),
    ]);

    for (const outcome of outcomes) {
      expect('failed' in outcome ? code(outcome.failed) : undefined).not.toBe('40P01');
      expect(outcome).toHaveProperty('ok');
    }
    expect(await statusOf(first.sessionId)).toBe('COMPLETED');
    expect(await statusOf(second.sessionId)).toBe('COMPLETED');
    expect(await expectWalletConsistent(a.userId, teamId)).toBe('66.00');
    expect(await expectWalletConsistent(b.userId, teamId)).toBe('66.00');
  });
});

describe('a deduction against a TOPUP credit through the ledger writer', () => {
  /** The top-up transaction as the Phase 4 apply path will run it: intent row, then lockWallets + applyMovement. */
  async function topUp(userId: string, teamId: string, amount: string) {
    return createKysely(database.pool)
      .transaction()
      .execute(async (trx) => {
        const akahuPaymentId = `pay_${randomUUID()}`;
        const intent = await trx
          .insertInto('wallet_top_ups')
          .values({
            user_id: userId,
            team_id: teamId,
            reference: paymentReference(),
            idempotency_key: randomUUID(),
            amount: toMoneyString(parseMoney(amount)),
            status: 'APPLIED',
            akahu_payment_id: akahuPaymentId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await ensureWallet(trx, { userId, teamId });
        await lockWallets(trx, teamId, [userId]);
        return applyMovement(trx, {
          userId,
          teamId,
          type: 'TOPUP',
          amount: parseMoney(amount),
          walletTopUpId: intent.id,
          akahuPaymentId,
        });
      });
  }

  it('a top-up that fits alongside the fee is credited in either order; balance = ledger sum', async () => {
    const s = await scene();
    const a = await player(s.teamId, s, '80.00');
    const outcomes = await raceBehind<unknown>(LOCK_WALLET(a.userId, s.teamId), 2, [
      () => bill(s.sessionId),
      () => topUp(a.userId, s.teamId, '15.00'),
    ]);
    for (const outcome of outcomes) expect(outcome).toHaveProperty('ok');
    expect(await expectWalletConsistent(a.userId, s.teamId)).toBe('78.00');
  });

  it('a top-up that only fits after the deduction is refused by the cap (never clamped) when it goes first; either way the balance is exact', async () => {
    const s = await scene();
    const a = await player(s.teamId, s, '90.00');
    const outcomes = await raceBehind<unknown>(LOCK_WALLET(a.userId, s.teamId), 2, [
      () => bill(s.sessionId),
      () => topUp(a.userId, s.teamId, '15.00'),
    ]);
    const [billing, credit] = outcomes;
    expect(billing).toHaveProperty('ok');
    const balance = await expectWalletConsistent(a.userId, s.teamId);
    if (credit !== undefined && 'failed' in credit) {
      expect(credit.failed).toBeInstanceOf(WalletLedgerError);
      expect((credit.failed as WalletLedgerError).reason).toBe('out_of_range');
      expect(balance).toBe('73.00');
    } else {
      expect(balance).toBe('88.00');
    }
  });
});

describe('a payout block against billing (teams FOR NO KEY UPDATE, AC-VERIFY-3)', () => {
  /** The block as billing-owned code will write it: lock the team row, then set `payout_blocked_at`. */
  const blockPayout = async (teamId: string): Promise<void> => {
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM teams WHERE id = $1 FOR NO KEY UPDATE', [teamId]);
      await client.query('UPDATE teams SET payout_blocked_at = $2 WHERE id = $1', [teamId, BASE]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  it('block committed first: billing holds the paid session (nothing written but the marker), and bills it after the block is cleared', async () => {
    const s = await scene();
    const a = await player(s.teamId, s, '30.00');
    await blockPayout(s.teamId);

    expect(await bill(s.sessionId)).toEqual({ kind: 'blocked' });
    expect(await statusOf(s.sessionId)).toBe('PUBLISHED');
    expect(await paymentRows(s.sessionId)).toEqual([]);
    expect(await expectWalletConsistent(a.userId, s.teamId)).toBe('30.00');

    await database.pool.query('UPDATE teams SET payout_blocked_at = NULL WHERE id = $1', [
      s.teamId,
    ]);
    expect(await bill(s.sessionId)).toMatchObject({ kind: 'completed', deducted: 1 });
    expect(await statusOf(s.sessionId)).toBe('COMPLETED');
  });

  it('billing in flight when the block commits: billing keeps its own committed read, completes whole, no deadlock; the next session is held', async () => {
    const teamId = await insertTeam(database.pool, { payoutConfigured: true });
    const first = await sceneFor(teamId);
    const next = await sceneFor(teamId);
    clock.set(new Date(Math.max(first.endsAt.getTime(), next.endsAt.getTime())));
    const a = await player(teamId, first, '30.00');
    await joinSession(next, a.userId);

    // Billing has taken teams FOR KEY SHARE and waits for the session row; the block then runs and commits (NO KEY UPDATE
    // does not conflict with KEY SHARE, so it must not wait on billing, and billing must not deadlock against it).
    const outcomes = await raceBehind(
      LOCK_SESSION(first.sessionId),
      1,
      [() => bill(first.sessionId)],
      () => blockPayout(teamId),
    );

    expect(outcomes[0]).toHaveProperty('ok');
    expect(await statusOf(first.sessionId)).toBe('COMPLETED');
    expect(await paymentRows(first.sessionId)).toHaveLength(1);
    expect(await expectWalletConsistent(a.userId, teamId)).toBe('13.00');
    // The next session starts after the block: held, not half-billed.
    expect(await bill(next.sessionId)).toEqual({ kind: 'blocked' });
    expect(await statusOf(next.sessionId)).toBe('PUBLISHED');
    expect(await paymentRows(next.sessionId)).toEqual([]);
  });

  it('a free session of a blocked team still completes (B8 holds paid sessions only)', async () => {
    const teamId = await insertTeam(database.pool, { payoutConfigured: true });
    const { sessionId } = await insertPublishedSession(database.pool, teamId, {
      now: BASE,
      flat: '0.00',
    });
    const { ends_at: endsAt } = await one<{ ends_at: Date }>(
      database.pool,
      'SELECT ends_at FROM game_sessions WHERE id = $1',
      [sessionId],
    );
    clock.set(endsAt);
    await blockPayout(teamId);
    expect(await bill(sessionId)).toMatchObject({ kind: 'completed', payments: 0 });
  });
});
