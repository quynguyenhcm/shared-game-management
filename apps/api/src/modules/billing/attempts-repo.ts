/**
 * The payment-attempt START path's SQL (wallet-and-akahu-billing Phase 4a; CR-1, CR-6, AC-ERROR-10): the only start-path writer of
 * `payment_attempts` (boundaries.test). It claims the payment's one blocking slot (CREATING), records the provider's answer
 * (CREATING -> OPEN) or closes the attempt at create (CREATING -> CLOSED), each guarded on `status = 'CREATING'`. Every later
 * transition belongs to the apply funnel (`apply-akahu-result.ts`); stale CREATING rows to the reconcile sweep. An attempt has no
 * reference column: the provider is sent `payments.payment_reference`. Nothing here reads a clock or opens a transaction.
 */
import type { Kysely, Transaction } from 'kysely';
import { parseMoney, toMoneyString, type Money, type PaymentIntentStatus } from '@sgm/shared';
import type { DB } from '../../lib/db/types.generated.ts';

export interface AttemptIntent {
  readonly id: string;
  readonly paymentId: string;
  readonly amount: Money;
  readonly status: PaymentIntentStatus;
  readonly akahuPaymentId: string | null;
  readonly akahuStatus: string | null;
  readonly authorisationUrlEnc: string | null;
  readonly expiresAt: Date | null;
  readonly closeReason: string | null;
  readonly lastSyncedAt: Date | null;
  readonly createdAt: Date;
}

const COLUMNS = [
  'id',
  'payment_id',
  'amount',
  'status',
  'akahu_payment_id',
  'akahu_status',
  'authorisation_url_enc',
  'expires_at',
  'close_reason',
  'last_synced_at',
  'created_at',
] as const;

const toIntent = (row: {
  id: string;
  payment_id: string;
  amount: string;
  status: PaymentIntentStatus;
  akahu_payment_id: string | null;
  akahu_status: string | null;
  authorisation_url_enc: string | null;
  expires_at: Date | null;
  close_reason: string | null;
  last_synced_at: Date | null;
  created_at: Date;
}): AttemptIntent => ({
  id: row.id,
  paymentId: row.payment_id,
  amount: parseMoney(row.amount),
  status: row.status,
  akahuPaymentId: row.akahu_payment_id,
  akahuStatus: row.akahu_status,
  authorisationUrlEnc: row.authorisation_url_enc,
  expiresAt: row.expires_at,
  closeReason: row.close_reason,
  lastSyncedAt: row.last_synced_at,
  createdAt: row.created_at,
});

/** The attempt a key already made for this payment (an idempotent replay), if any. */
export async function findAttemptByKey(
  db: Kysely<DB>,
  paymentId: string,
  idempotencyKey: string,
): Promise<AttemptIntent | undefined> {
  const row = await db
    .selectFrom('payment_attempts')
    .select(COLUMNS)
    .where('payment_id', '=', paymentId)
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst();
  return row === undefined ? undefined : toIntent(row);
}

/** The payment's blocking attempt (CREATING, OPEN or HELD; at most one by the partial unique index), if any. */
export async function findBlockingAttempt(
  db: Kysely<DB>,
  paymentId: string,
): Promise<AttemptIntent | undefined> {
  const row = await db
    .selectFrom('payment_attempts')
    .select(COLUMNS)
    .where('payment_id', '=', paymentId)
    .where('status', 'in', ['CREATING', 'OPEN', 'HELD'])
    .executeTakeFirst();
  return row === undefined ? undefined : toIntent(row);
}

/** The payment's most recent attempt (any status), for the read model. */
export async function findLatestAttempt(
  db: Kysely<DB>,
  paymentId: string,
): Promise<AttemptIntent | undefined> {
  const row = await db
    .selectFrom('payment_attempts')
    .select(COLUMNS)
    .where('payment_id', '=', paymentId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row === undefined ? undefined : toIntent(row);
}

/**
 * Claims the payment's one blocking slot with a CREATING attempt for the payment's own amount. `ON CONFLICT DO NOTHING` covers the
 * key and the slot: a concurrent claim waits on the index until the other transaction ends; `undefined` means taken (the caller
 * reads which).
 */
export async function claimAttemptSlot(
  trx: Transaction<DB>,
  input: { readonly paymentId: string; readonly amount: Money; readonly idempotencyKey: string },
): Promise<string | undefined> {
  const row = await trx
    .insertInto('payment_attempts')
    .values({
      payment_id: input.paymentId,
      amount: toMoneyString(input.amount),
      idempotency_key: input.idempotencyKey,
      status: 'CREATING',
    })
    .onConflict((conflict) => conflict.doNothing())
    .returning('id')
    .executeTakeFirst();
  return row?.id;
}

/** tx2: CREATING -> OPEN with the provider's id, its status, the sealed consent URL and the link expiry. False when not CREATING. */
export async function openAttempt(
  db: Kysely<DB>,
  input: {
    readonly id: string;
    readonly akahuPaymentId: string;
    readonly akahuStatus: string;
    readonly akahuStatusReason: string | null;
    readonly authorisationUrlEnc: string;
    readonly expiresAt: Date;
  },
): Promise<boolean> {
  const updated = await db
    .updateTable('payment_attempts')
    .set({
      status: 'OPEN',
      akahu_payment_id: input.akahuPaymentId,
      akahu_status: input.akahuStatus,
      akahu_status_reason: input.akahuStatusReason,
      authorisation_url_enc: input.authorisationUrlEnc,
      expires_at: input.expiresAt,
    })
    .where('id', '=', input.id)
    .where('status', '=', 'CREATING')
    .returning('id')
    .executeTakeFirst();
  return updated !== undefined;
}

/** CREATING -> CLOSED when the provider could not start the payment (`create_unavailable`, `create_refused:<code>`). */
export async function closeAttemptAtCreate(
  db: Kysely<DB>,
  input: { readonly id: string; readonly reason: string; readonly now: Date },
): Promise<void> {
  await db
    .updateTable('payment_attempts')
    .set({ status: 'CLOSED', close_reason: input.reason, closed_at: input.now })
    .where('id', '=', input.id)
    .where('status', '=', 'CREATING')
    .execute();
}
