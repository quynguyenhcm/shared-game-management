/**
 * The top-up START path's SQL (wallet-and-akahu-billing Phase 4a; CR-1, CR-6, CR-24): the only start-path writer of
 * `wallet_top_ups` (boundaries.test). It claims the one-blocking slot (CREATING), records the provider's answer (CREATING -> OPEN)
 * or closes the intent at create (CREATING -> CLOSED). Every later transition (HELD, APPLIED, UNAPPLIED, CLOSED by the provider) is
 * the apply funnel's; stale CREATING rows are the reconcile sweep's. Each write is guarded on `status = 'CREATING'`, so a row the
 * sweep already closed is never reopened. Nothing here reads a clock or opens a transaction.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { parseMoney, toMoneyString, type Money, type PaymentIntentStatus } from '@sgm/shared';
import type { DB } from '../../lib/db/types.generated.ts';

export interface TopUpIntent {
  readonly id: string;
  readonly userId: string;
  readonly teamId: string;
  readonly amount: Money;
  readonly reference: string;
  readonly status: PaymentIntentStatus;
  readonly akahuPaymentId: string | null;
  readonly akahuStatus: string | null;
  readonly authorisationUrlEnc: string | null;
  readonly expiresAt: Date | null;
  readonly closeReason: string | null;
  readonly closedAt: Date | null;
  readonly unappliedReason: 'OVER_CAP' | 'DUPLICATE' | 'LATE' | 'AMOUNT_MISMATCH' | null;
  readonly lastSyncedAt: Date | null;
  readonly createdAt: Date;
}

const COLUMNS = [
  'id',
  'user_id',
  'team_id',
  'amount',
  'reference',
  'status',
  'akahu_payment_id',
  'akahu_status',
  'authorisation_url_enc',
  'expires_at',
  'close_reason',
  'closed_at',
  'unapplied_reason',
  'last_synced_at',
  'created_at',
] as const;

type Row = {
  id: string;
  user_id: string;
  team_id: string;
  amount: string;
  reference: string;
  status: PaymentIntentStatus;
  akahu_payment_id: string | null;
  akahu_status: string | null;
  authorisation_url_enc: string | null;
  expires_at: Date | null;
  close_reason: string | null;
  closed_at: Date | null;
  unapplied_reason: TopUpIntent['unappliedReason'];
  last_synced_at: Date | null;
  created_at: Date;
};

const toIntent = (row: Row): TopUpIntent => ({
  id: row.id,
  userId: row.user_id,
  teamId: row.team_id,
  amount: parseMoney(row.amount),
  reference: row.reference,
  status: row.status,
  akahuPaymentId: row.akahu_payment_id,
  akahuStatus: row.akahu_status,
  authorisationUrlEnc: row.authorisation_url_enc,
  expiresAt: row.expires_at,
  closeReason: row.close_reason,
  closedAt: row.closed_at,
  unappliedReason: row.unapplied_reason,
  lastSyncedAt: row.last_synced_at,
  createdAt: row.created_at,
});

export interface WalletOwner {
  readonly userId: string;
  readonly teamId: string;
}

/** The top-up a key already made for this wallet (an idempotent replay), if any. */
export async function findTopUpByKey(
  db: Kysely<DB>,
  owner: WalletOwner,
  idempotencyKey: string,
): Promise<TopUpIntent | undefined> {
  const row = await db
    .selectFrom('wallet_top_ups')
    .select(COLUMNS)
    .where('user_id', '=', owner.userId)
    .where('team_id', '=', owner.teamId)
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst();
  return row === undefined ? undefined : toIntent(row);
}

/** The wallet's blocking top-up (CREATING, OPEN or HELD; at most one by the partial unique index), if any. */
export async function findBlockingTopUp(
  db: Kysely<DB>,
  owner: WalletOwner,
): Promise<TopUpIntent | undefined> {
  const row = await db
    .selectFrom('wallet_top_ups')
    .select(COLUMNS)
    .where('user_id', '=', owner.userId)
    .where('team_id', '=', owner.teamId)
    .where('status', 'in', ['CREATING', 'OPEN', 'HELD'])
    .executeTakeFirst();
  return row === undefined ? undefined : toIntent(row);
}

/** The most recent finished top-up of the wallet (by close or creation time), for the B3 notice. */
export async function findLatestFinishedTopUp(
  db: Kysely<DB>,
  owner: WalletOwner,
): Promise<TopUpIntent | undefined> {
  const row = await db
    .selectFrom('wallet_top_ups')
    .select(COLUMNS)
    .where('user_id', '=', owner.userId)
    .where('team_id', '=', owner.teamId)
    .where('status', 'in', ['APPLIED', 'UNAPPLIED', 'CLOSED'])
    .orderBy(sql`coalesce(closed_at, created_at)`, 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row === undefined ? undefined : toIntent(row);
}

/**
 * Claims the wallet's one blocking slot with a CREATING row (CR-24: before the balance is read). `ON CONFLICT DO NOTHING` covers
 * every unique index: a concurrent claim waits on the index until the other transaction ends, then either inserts (the other
 * intent is no longer blocking) or returns `undefined` (the slot is taken, the key was used, or the reference collided; the
 * caller tells them apart by reading).
 */
export async function claimTopUpSlot(
  trx: Transaction<DB>,
  input: WalletOwner & {
    readonly amount: Money;
    readonly reference: string;
    readonly idempotencyKey: string;
  },
): Promise<string | undefined> {
  const row = await trx
    .insertInto('wallet_top_ups')
    .values({
      user_id: input.userId,
      team_id: input.teamId,
      amount: toMoneyString(input.amount),
      reference: input.reference,
      idempotency_key: input.idempotencyKey,
      status: 'CREATING',
    })
    .onConflict((conflict) => conflict.doNothing())
    .returning('id')
    .executeTakeFirst();
  return row?.id;
}

/** tx2: CREATING -> OPEN with the provider's id, its status, the sealed consent URL and the link expiry. False when not CREATING. */
export async function openTopUp(
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
    .updateTable('wallet_top_ups')
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
export async function closeTopUpAtCreate(
  db: Kysely<DB>,
  input: { readonly id: string; readonly reason: string; readonly now: Date },
): Promise<void> {
  await db
    .updateTable('wallet_top_ups')
    .set({ status: 'CLOSED', close_reason: input.reason, closed_at: input.now })
    .where('id', '=', input.id)
    .where('status', '=', 'CREATING')
    .execute();
}
