/**
 * Best-effort cancel of an Akahu payment (wallet-and-akahu-billing Phase 4a; A5, CR-14; the `akahu-cancel` job body). Akahu cancels
 * only in READY, and the call is made OUTSIDE any transaction:
 *
 *   - a local intent that is OPEN with the mirror still READY (or unknown) is cancelled, then re-read and applied through the
 *     single funnel, so a CANCELLED answer closes it there (and a payer who authorised meanwhile keeps it OPEN);
 *   - an intent that is in flight (AUTHORISED or later) or already settled is never cancelled: it is only re-read;
 *   - an orphan (Akahu created the payment but our intent was already closed, so no row stores its id) is cancelled outright;
 *     nobody was ever handed its URL.
 *
 * This file writes nothing itself.
 */
import type { PaymentsGateway } from '../../lib/akahu/gateway.ts';
import {
  findIntentByProviderId,
  syncAkahuPayment,
  type AkahuSyncDeps,
  type CancelSource,
  type SyncResult,
} from './apply-akahu-result.ts';

export interface AkahuCancelDeps extends AkahuSyncDeps {
  readonly gateway: Pick<PaymentsGateway, 'getPayment' | 'cancelPayment'>;
}

export type CancelResult =
  | { readonly outcome: 'orphan'; readonly cancelled: boolean }
  | {
      readonly outcome: 'skipped';
      readonly reason: 'in_flight' | 'settled';
      readonly sync: SyncResult | null;
    }
  | { readonly outcome: 'cancelled' | 'not_cancellable'; readonly sync: SyncResult };

export async function cancelAkahuPayment(
  deps: AkahuCancelDeps,
  input: { readonly akahuPaymentId: string; readonly source: CancelSource },
): Promise<CancelResult> {
  const ref = await findIntentByProviderId(deps.db, input.akahuPaymentId);
  if (ref === null) {
    const answer = await deps.gateway.cancelPayment(input.akahuPaymentId);
    deps.log.info(
      {
        event: 'akahu.cancel.orphan',
        akahuPaymentId: input.akahuPaymentId,
        source: input.source,
        cancelled: answer === 'cancelled',
      },
      'orphan akahu payment cancel requested',
    );
    return { outcome: 'orphan', cancelled: answer === 'cancelled' };
  }
  const local = await deps.db
    .selectFrom(ref.kind === 'ATTEMPT' ? 'payment_attempts' : 'wallet_top_ups')
    .select(['status', 'akahu_status'])
    .where('id', '=', ref.id)
    .executeTakeFirstOrThrow();
  if (local.status !== 'OPEN') {
    return { outcome: 'skipped', reason: 'settled', sync: null };
  }
  if (local.akahu_status !== null && local.akahu_status !== 'READY') {
    // The payer has authorised: never cancel; just bring the local state up to date.
    const sync = await syncAkahuPayment(deps, {
      akahuPaymentId: input.akahuPaymentId,
      source: 'cancel',
    });
    return { outcome: 'skipped', reason: 'in_flight', sync };
  }
  const answer = await deps.gateway.cancelPayment(input.akahuPaymentId);
  const sync = await syncAkahuPayment(deps, {
    akahuPaymentId: input.akahuPaymentId,
    source: 'cancel',
  });
  deps.log.info(
    {
      event: 'akahu.cancel.requested',
      intentKind: ref.kind,
      intentId: ref.id,
      source: input.source,
      answer,
    },
    'akahu payment cancel requested',
  );
  return { outcome: answer, sync };
}
