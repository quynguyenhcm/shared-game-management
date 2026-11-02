/**
 * The wallet ledger writer (CR-5, AC-VERIFY-4): the only TypeScript path that moves a balance, always through a
 * `credit_transactions` row, never clamping, with the database trigger as the backstop.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from 'kysely';
import { parseMoney } from '@sgm/shared';
import { createKysely } from '../../src/lib/db/kysely.ts';
import type { DB } from '../../src/lib/db/types.generated.ts';
import {
  WalletLedgerError,
  applyMovement,
  ensureWallet,
  lockWallets,
} from '../../src/modules/wallet/ledger.ts';
import {
  insertPublishedSession,
  insertRegistration,
  insertTeam,
  insertUser,
  insertWallet,
  paymentReference,
} from '../helpers/factories.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

let database: TestDatabase;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database.close();
});

const kysely = () => createKysely(database.pool);
const run = <T>(work: (trx: Transaction<DB>) => Promise<T>) => kysely().transaction().execute(work);

async function fixture() {
  const teamId = await insertTeam(database.pool, { payoutConfigured: true });
  const { sessionId } = await insertPublishedSession(database.pool, teamId, {
    now: new Date('2026-10-20T00:00:00Z'),
  });
  const userId = await insertUser(database.pool);
  const registrationId = await insertRegistration(database.pool, { sessionId, teamId, userId });
  return { teamId, userId, registrationId };
}

describe('ensureWallet and lockWallets', () => {
  it('creates the wallet at 0.00 once, and locks only the wallets that exist, sorted by user id', async () => {
    const teamId = await insertTeam(database.pool, { payoutConfigured: true });
    const [a, b, c] = [
      await insertUser(database.pool),
      await insertUser(database.pool),
      await insertUser(database.pool),
    ];
    await insertWallet(database.pool, b, teamId, '12.00');
    const first = await run((trx) => ensureWallet(trx, { userId: a, teamId }));
    const second = await run((trx) => ensureWallet(trx, { userId: a, teamId }));
    expect(second).toBe(first);

    const locked = await run((trx) => lockWallets(trx, teamId, [c, b, a, a]));
    expect([...locked.keys()]).toEqual([a, b].sort());
    expect(locked.get(a)?.balance).toBe(parseMoney('0.00'));
    expect(locked.get(b)?.balance).toBe(parseMoney('12.00'));
    expect(await run((trx) => lockWallets(trx, teamId, []))).toEqual(new Map());
  });
});

describe('applyMovement', () => {
  it('deducts with one ledger row carrying the resulting balance, and the wallet follows', async () => {
    const { teamId, userId, registrationId } = await fixture();
    await insertWallet(database.pool, userId, teamId, '30.00');
    const applied = await run((trx) =>
      applyMovement(trx, {
        userId,
        teamId,
        type: 'AUTO_DEDUCTION',
        amount: parseMoney('-17.00'),
        registrationId,
      }),
    );
    expect(applied.previousBalance).toBe(parseMoney('30.00'));
    expect(applied.resultingBalance).toBe(parseMoney('13.00'));
    const { rows } = await database.pool.query(
      `SELECT balance FROM player_credits WHERE user_id = $1 AND team_id = $2`,
      [userId, teamId],
    );
    expect(rows[0]).toEqual({ balance: '13.00' });
  });

  it('credits a top-up (Phase 4 path) against an applied intent', async () => {
    const { teamId, userId } = await fixture();
    await run((trx) => ensureWallet(trx, { userId, teamId }));
    const akahuPaymentId = `pay_${randomUUID()}`;
    const { rows } = await database.pool.query<{ id: string }>(
      `INSERT INTO wallet_top_ups (user_id, team_id, reference, idempotency_key, amount, status, akahu_payment_id)
       VALUES ($1, $2, $3, $4, 25.00, 'APPLIED', $5) RETURNING id`,
      [userId, teamId, paymentReference(), randomUUID(), akahuPaymentId],
    );
    const applied = await run((trx) =>
      applyMovement(trx, {
        userId,
        teamId,
        type: 'TOPUP',
        amount: parseMoney('25.00'),
        walletTopUpId: rows[0]?.id,
        akahuPaymentId,
      }),
    );
    expect(applied.resultingBalance).toBe(parseMoney('25.00'));
  });

  it('refuses a movement that would leave 0.00-100.00 instead of clamping, and a missing wallet, and a malformed movement', async () => {
    const { teamId, userId, registrationId } = await fixture();
    await insertWallet(database.pool, userId, teamId, '10.00');
    await expect(
      run((trx) =>
        applyMovement(trx, {
          userId,
          teamId,
          type: 'AUTO_DEDUCTION',
          amount: parseMoney('-10.01'),
          registrationId,
        }),
      ),
    ).rejects.toMatchObject({ name: 'WalletLedgerError', reason: 'out_of_range' });
    await expect(
      run((trx) =>
        applyMovement(trx, {
          userId: randomUUID(),
          teamId,
          type: 'AUTO_DEDUCTION',
          amount: parseMoney('-1.00'),
          registrationId,
        }),
      ),
    ).rejects.toMatchObject({ reason: 'no_wallet' });
    await expect(
      run((trx) =>
        applyMovement(trx, {
          userId,
          teamId,
          type: 'AUTO_DEDUCTION',
          amount: parseMoney('1.00'),
          registrationId,
        }),
      ),
    ).rejects.toBeInstanceOf(WalletLedgerError);
    await expect(
      run((trx) =>
        applyMovement(trx, { userId, teamId, type: 'AUTO_DEDUCTION', amount: parseMoney('-1.00') }),
      ),
    ).rejects.toMatchObject({ reason: 'bad_movement' });
    const { rows } = await database.pool.query(
      `SELECT balance FROM player_credits WHERE user_id = $1 AND team_id = $2`,
      [userId, teamId],
    );
    expect(rows[0]).toEqual({ balance: '10.00' });
  });
});
