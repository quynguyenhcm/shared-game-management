/**
 * Resolving a held Akahu payment or top-up by hand (wallet-and-akahu-billing Phase 4a; CR-15, CR-26, H2; algorithm doc F / RF-7).
 * Two routes call `resolveHeld`: `POST /payments/:paymentId/hold-resolution` and
 * `POST /teams/:teamId/wallet/top-ups/:topUpId/hold-resolution`.
 *
 *   1. Who: team admins of the PAYEE team, or a GLOBAL_ADMIN (H2). The top-up route's guard checks the path team and this file
 *      checks the top-up belongs to it; the payment route has no team in its path, so this file checks the payment's team: an
 *      approved plain member of that team is 403, anyone else (another team's admin included) the same 404 as an unknown id.
 *   2. A replay of a recorded resolution, and a payment or top-up that is not held, are answered from the database without
 *      calling Akahu.
 *   3. Akahu is re-read INLINE and OUTSIDE any transaction. A definite provider answer wins (`decideHoldGate`): a SENT for the
 *      intent's amount is applied through the funnel and the manual verdict refused (409 `hold_resolved_by_provider`); a
 *      verdict that contradicts a definite answer is refused the same way.
 *   4. Otherwise the single apply funnel (`resolveHeldIntent`) writes the verdict under the CR-4 locks, re-checking the locked
 *      state. This file writes nothing itself.
 */
import {
  eq,
  parseMoney,
  type HoldResolutionRequest,
  type HoldResolutionResponse,
  type Money,
} from '@sgm/shared';
import {
  GatewayUnavailableError,
  type GatewayOutcome,
  type PaymentsGateway,
  type ProviderPayment,
} from '../../lib/akahu/gateway.ts';
import { AppError } from '../../lib/http/errors.ts';
import {
  applyAkahuResult,
  resolveHeldIntent,
  type AkahuApplyDeps,
  type IntentRef,
  type ResolutionOutcome,
} from './apply-akahu-result.ts';

// ---------------------------------------------------------------------------------------------------------------------------------
// The provider gate (pure)
// ---------------------------------------------------------------------------------------------------------------------------------

export type HoldGate = 'PROVIDER_APPLIES' | 'PROVIDER_REFUSES' | 'PROCEED';

export interface HoldGateInput {
  readonly outcome: ResolutionOutcome;
  /** The fresh read: its outcome and whether Akahu's amount equals the intent amount; `not_found` when Akahu has no record. */
  readonly fresh:
    { readonly kind: GatewayOutcome['kind']; readonly amountMatches: boolean } | 'not_found';
}

/** CR-26: a definite provider answer wins over a person's verdict. */
export function decideHoldGate(input: HoldGateInput): HoldGate {
  const { fresh, outcome } = input;
  if (fresh === 'not_found') return 'PROCEED';
  if (fresh.kind === 'SUCCEEDED') {
    if (fresh.amountMatches) return 'PROVIDER_APPLIES';
    // Money did move (for another amount): "not received" is false; "received" goes on, with an observed amount.
    return outcome === 'NOT_RECEIVED' ? 'PROVIDER_REFUSES' : 'PROCEED';
  }
  if (fresh.kind === 'NOT_CHARGED' && outcome === 'RECEIVED') return 'PROVIDER_REFUSES';
  return 'PROCEED';
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The use case
// ---------------------------------------------------------------------------------------------------------------------------------

export interface HoldResolutionDeps extends AkahuApplyDeps {
  /** Re-read OUTSIDE any transaction. */
  readonly gateway: Pick<PaymentsGateway, 'getPayment'>;
}

export interface HoldActor {
  readonly userId: string;
  readonly role: string;
}

export type HoldTarget =
  | { readonly kind: 'payment'; readonly paymentId: string }
  | { readonly kind: 'topUp'; readonly teamId: string; readonly topUpId: string };

interface HeldIntentRow {
  readonly id: string;
  readonly status: string;
  readonly amount: string;
  readonly akahuPaymentId: string | null;
  readonly resolutionReason: string | null;
}

const notHeld = (): AppError =>
  new AppError('conflict', { message: 'This payment is not on hold.' });

/** Finds the intent the target names, enforcing who may act on it (H2). */
async function findIntent(
  deps: HoldResolutionDeps,
  target: HoldTarget,
  actor: HoldActor,
): Promise<{ ref: IntentRef; row: HeldIntentRow }> {
  if (target.kind === 'topUp') {
    // The route guard checked the caller against the team in the path; the top-up must belong to that team.
    const row = await deps.db
      .selectFrom('wallet_top_ups')
      .select(['id', 'status', 'amount', 'akahu_payment_id', 'resolution_reason'])
      .where('id', '=', target.topUpId)
      .where('team_id', '=', target.teamId)
      .executeTakeFirst();
    if (row === undefined) throw new AppError('not_found');
    return {
      ref: { kind: 'TOP_UP', id: row.id },
      row: {
        id: row.id,
        status: row.status,
        amount: row.amount,
        akahuPaymentId: row.akahu_payment_id,
        resolutionReason: row.resolution_reason,
      },
    };
  }
  const payment = await deps.db
    .selectFrom('payments')
    .select(['id', 'team_id'])
    .where('id', '=', target.paymentId)
    .executeTakeFirst();
  if (payment === undefined) throw new AppError('not_found');
  if (actor.role !== 'GLOBAL_ADMIN') {
    const membership = await deps.db
      .selectFrom('team_members')
      .select('role')
      .where('team_id', '=', payment.team_id)
      .where('user_id', '=', actor.userId)
      .where('status', '=', 'APPROVED')
      .executeTakeFirst();
    // Outside the payee team: the same 404 as an unknown id. A plain member of it: 403.
    if (membership === undefined) throw new AppError('not_found');
    if (membership.role !== 'TEAM_ADMIN') throw new AppError('forbidden');
  }
  // The blocking attempt if one is held; otherwise the latest resolved one (a replay).
  const attempt = await deps.db
    .selectFrom('payment_attempts')
    .select(['id', 'status', 'amount', 'akahu_payment_id', 'resolution_reason'])
    .where('payment_id', '=', payment.id)
    .where((eb) => eb.or([eb('status', '=', 'HELD'), eb('resolved_at', 'is not', null)]))
    .orderBy((eb) => eb.case().when('status', '=', 'HELD').then(0).else(1).end())
    .orderBy('resolved_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (attempt === undefined) throw notHeld();
  return {
    ref: { kind: 'ATTEMPT', id: attempt.id },
    row: {
      id: attempt.id,
      status: attempt.status,
      amount: attempt.amount,
      akahuPaymentId: attempt.akahu_payment_id,
      resolutionReason: attempt.resolution_reason,
    },
  };
}

const sameMoney = (amount: Money, stored: string): boolean => eq(amount, parseMoney(stored));

export async function resolveHeld(
  deps: HoldResolutionDeps,
  target: HoldTarget,
  actor: HoldActor,
  input: HoldResolutionRequest,
): Promise<HoldResolutionResponse> {
  const { ref, row } = await findIntent(deps, target, actor);
  const recorded = row.resolutionReason !== null;
  if (!recorded && row.status !== 'HELD') throw notHeld();

  let fresh: ProviderPayment | 'not_found' | null = null;
  if (!recorded && row.akahuPaymentId !== null) {
    try {
      fresh = await deps.gateway.getPayment(row.akahuPaymentId);
    } catch (error) {
      if (error instanceof GatewayUnavailableError) {
        throw new AppError('payment_provider_unavailable', { cause: error });
      }
      throw error;
    }
    const freshAmountMatches = fresh !== 'not_found' && sameMoney(fresh.amount, row.amount);
    const gate = decideHoldGate({
      outcome: input.outcome,
      fresh:
        fresh === 'not_found'
          ? 'not_found'
          : { kind: fresh.outcome.kind, amountMatches: freshAmountMatches },
    });
    if (gate !== 'PROCEED') {
      if (gate === 'PROVIDER_APPLIES' && fresh !== 'not_found') {
        await applyAkahuResult(deps, fresh, 'hold_resolution');
      }
      deps.log.info(
        {
          event: 'billing.hold.provider_definite',
          intentKind: ref.kind,
          intentId: ref.id,
          outcome: input.outcome,
          gate,
          actorId: actor.userId,
        },
        'a definite provider answer wins over the manual verdict',
      );
      throw new AppError('hold_resolved_by_provider');
    }
  }

  const freshView = fresh === null || fresh === 'not_found' ? null : fresh;
  const result = await resolveHeldIntent(deps, {
    ref,
    actorUserId: actor.userId,
    outcome: input.outcome,
    observedAmount: input.observedAmount ?? null,
    freshAmountMismatch:
      freshView !== null &&
      freshView.outcome.kind === 'SUCCEEDED' &&
      !sameMoney(freshView.amount, row.amount),
    freshIndeterminate: freshView !== null && freshView.outcome.kind === 'INDETERMINATE',
  });
  switch (result.outcome) {
    case 'resolved':
    case 'replayed':
      return {
        intentStatus: result.intentStatus,
        resolutionReason: result.resolutionReason,
        resolvedAt: result.resolvedAt.toISOString(),
      };
    case 'observed_amount_required':
      throw new AppError('validation_failed', {
        fieldErrors: {
          observedAmount: ['Enter the amount that arrived in the bank account.'],
        },
      });
    case 'not_held':
      throw notHeld();
  }
}
