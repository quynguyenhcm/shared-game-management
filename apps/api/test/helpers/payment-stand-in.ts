/**
 * TEST-ONLY stand-in for wallet-and-akahu-billing's payment creation (not production code; nothing outside `test/`
 * imports it). It follows contract C-BIL-PAY of ADR 0016 so the publish-gate race suite can prove the contract
 * before the real billing code exists:
 *
 *   every payment-creation path takes `teams FOR KEY SHARE` and checks `is_payout_configured` BEFORE inserting
 *   any payment row, including a post-game payment link for an already COMPLETED session.
 *
 * A removal therefore either waits for the payment and then refuses (`banking_in_use`, the payment is PENDING), or
 * commits first and the stand-in fails cleanly with `payout_not_configured`, having inserted nothing.
 * When the real billing feature lands it replaces this helper with its own payment path under the same contract.
 */
import type pg from 'pg';
import { AppError } from '../../src/lib/http/errors.ts';
import { insertPaymentRows, type PaymentInput } from './factories.ts';
import { inTransaction } from './test-db.ts';

/**
 * Step 1 of C-BIL-PAY: lock the team row `FOR KEY SHARE` and read the generated flag in the same statement.
 * Throws `payout_not_configured` (409) when the destination is missing, blocked, or the team is gone.
 */
export async function guardPayoutDestination(client: pg.PoolClient, teamId: string): Promise<void> {
  const { rows } = await client.query<{ is_payout_configured: boolean }>(
    'SELECT is_payout_configured FROM teams WHERE id = $1 FOR KEY SHARE',
    [teamId],
  );
  if (rows[0]?.is_payout_configured !== true) throw new AppError('payout_not_configured');
}

/** Guard, then insert the payment and its line items on the caller's open transaction. Returns the payment id. */
export async function createStandInPayment(
  client: pg.PoolClient,
  input: PaymentInput,
): Promise<string> {
  await guardPayoutDestination(client, input.teamId);
  return insertPaymentRows(client, input);
}

export type StandInOutcome = { readonly paymentId: string } | { readonly refused: unknown };

/** One whole stand-in transaction; a refusal is returned, not thrown, so a race test can await it safely. */
export async function attemptStandInPayment(
  pool: pg.Pool,
  input: PaymentInput,
): Promise<StandInOutcome> {
  try {
    return {
      paymentId: await inTransaction(pool, (client) => createStandInPayment(client, input)),
    };
  } catch (error) {
    return { refused: error };
  }
}
