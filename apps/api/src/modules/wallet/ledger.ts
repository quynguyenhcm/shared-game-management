/**
 * The wallet ledger: the ONLY TypeScript writer of `player_credits` and `credit_transactions` (CR-5, ADR 0020). It makes no
 * decisions: callers decide (all-or-nothing deduction, the top-up headroom) and this file moves the balance, always through a
 * `credit_transactions` row. The database is the backstop: the BEFORE INSERT trigger `credit_transactions_ledger_chain` refuses
 * a row whose `resulting_balance` is not the locked balance plus `amount`, and `player_credits.balance` changes only from inside
 * that trigger, so a bug here fails loudly instead of corrupting a balance.
 *
 * Lock order (CR-4, `LOCK_ORDER`): wallets sit after `registration_guests` and `wallet_top_ups` and before `payments`. Several
 * wallets in one transaction are locked by `lockWallets` in one statement ordered by `user_id`, so two transactions that share
 * players can never take them in opposite orders. A wallet row is created at 0.00 by `ensureWallet` (a read creates none) and
 * is never deleted.
 */
import type { Transaction } from 'kysely';
import {
  WALLET_CAP,
  ZERO,
  add,
  gt,
  lt,
  parseMoney,
  toMoneyString,
  type CreditTransactionType,
  type Money,
} from '@sgm/shared';
import type { DB } from '../../lib/db/types.generated.ts';

/** A movement the ledger refuses (no wallet, a balance outside 0.00-100.00, or a shape a movement type may not have). */
export class WalletLedgerError extends Error {
  constructor(
    readonly reason: 'no_wallet' | 'out_of_range' | 'bad_movement',
    message: string,
  ) {
    super(message);
    this.name = 'WalletLedgerError';
  }
}

export interface LockedWallet {
  readonly id: string;
  readonly userId: string;
  readonly balance: Money;
}

/**
 * Creates the wallet row (balance 0.00) when the player has none, and returns its id. A wallet exists before the first
 * movement because `credit_transactions` references it. Never call it from a read path.
 */
export async function ensureWallet(
  trx: Transaction<DB>,
  input: { readonly userId: string; readonly teamId: string },
): Promise<string> {
  await trx
    .insertInto('player_credits')
    .values({ user_id: input.userId, team_id: input.teamId })
    .onConflict((conflict) => conflict.columns(['user_id', 'team_id']).doNothing())
    .execute();
  const row = await trx
    .selectFrom('player_credits')
    .select('id')
    .where('user_id', '=', input.userId)
    .where('team_id', '=', input.teamId)
    .executeTakeFirstOrThrow();
  return row.id;
}

/**
 * Locks the existing wallets of `userIds` in one team, `FOR NO KEY UPDATE`, in ascending `user_id` order in ONE statement
 * (CR-4). A player with no wallet row is simply absent from the result: no wallet means a balance of 0.00 and nothing to lock.
 */
export async function lockWallets(
  trx: Transaction<DB>,
  teamId: string,
  userIds: readonly string[],
): Promise<Map<string, LockedWallet>> {
  const wallets = new Map<string, LockedWallet>();
  if (userIds.length === 0) return wallets;
  const rows = await trx
    .selectFrom('player_credits')
    .select(['id', 'user_id', 'balance'])
    .where('team_id', '=', teamId)
    .where('user_id', 'in', [...new Set(userIds)])
    .orderBy('user_id')
    .forNoKeyUpdate()
    .execute();
  for (const row of rows) {
    wallets.set(row.user_id, { id: row.id, userId: row.user_id, balance: parseMoney(row.balance) });
  }
  return wallets;
}

export interface Movement {
  readonly userId: string;
  readonly teamId: string;
  readonly type: Extract<CreditTransactionType, 'AUTO_DEDUCTION' | 'TOPUP'>;
  /** Signed: negative for `AUTO_DEDUCTION`, positive for `TOPUP`. */
  readonly amount: Money;
  /** `AUTO_DEDUCTION` only: the registration the fee was for. */
  readonly registrationId?: string;
  /** `TOPUP` only: the applied intent and Akahu's payment id. */
  readonly walletTopUpId?: string;
  readonly akahuPaymentId?: string;
}

export interface AppliedMovement {
  readonly id: string;
  readonly previousBalance: Money;
  readonly resultingBalance: Money;
}

/**
 * Moves the wallet balance by `amount` with one ledger row. The wallet row must exist; it is (re-)locked here, which costs
 * nothing when the caller already holds it from `lockWallets`. The new balance must stay within 0.00-100.00: it is never
 * clamped, a movement that would leave the range throws and the caller's transaction rolls back (a top-up that does not fit is
 * the caller's B3 case, decided before it gets here).
 */
export async function applyMovement(
  trx: Transaction<DB>,
  movement: Movement,
): Promise<AppliedMovement> {
  const shapeOk =
    movement.type === 'AUTO_DEDUCTION'
      ? lt(movement.amount, ZERO) && movement.registrationId !== undefined
      : gt(movement.amount, ZERO) &&
        movement.walletTopUpId !== undefined &&
        movement.akahuPaymentId !== undefined;
  if (!shapeOk) {
    throw new WalletLedgerError('bad_movement', `a ${movement.type} movement has the wrong shape`);
  }
  const wallet = await trx
    .selectFrom('player_credits')
    .select('balance')
    .where('user_id', '=', movement.userId)
    .where('team_id', '=', movement.teamId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (wallet === undefined) {
    throw new WalletLedgerError('no_wallet', 'the wallet row must exist before a movement');
  }
  const previousBalance = parseMoney(wallet.balance);
  const resultingBalance = add(previousBalance, movement.amount);
  if (lt(resultingBalance, ZERO) || gt(resultingBalance, WALLET_CAP)) {
    throw new WalletLedgerError(
      'out_of_range',
      `a ${movement.type} movement would leave the balance outside 0.00-100.00`,
    );
  }
  const row = await trx
    .insertInto('credit_transactions')
    .values({
      user_id: movement.userId,
      team_id: movement.teamId,
      amount: toMoneyString(movement.amount),
      transaction_type: movement.type,
      registration_id: movement.registrationId ?? null,
      wallet_top_up_id: movement.walletTopUpId ?? null,
      akahu_payment_id: movement.akahuPaymentId ?? null,
      resulting_balance: toMoneyString(resultingBalance),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, previousBalance, resultingBalance };
}
