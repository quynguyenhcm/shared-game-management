/**
 * The `payment_intent_status` matrix shared by `payment_attempts` and `wallet_top_ups` (wallet-and-akahu-billing CR-1;
 * algorithm doc "Intent state"). The TS twin of `payment_intent_transition_allowed` and the two guard triggers: any
 * change here changes the SQL and `apps/api/test/fixtures/intent-transitions.ts` in the same commit.
 *
 * CREATING -> OPEN | CLOSED; OPEN -> HELD | APPLIED | UNAPPLIED | CLOSED; HELD -> APPLIED | UNAPPLIED | CLOSED;
 * CLOSED -> APPLIED | UNAPPLIED only for a row that holds a provider payment id (a late SENT on a locally closed intent);
 * APPLIED and UNAPPLIED are terminal.
 */
import type { PaymentIntentStatus } from '../types/enums.ts';

export const INTENT_STATUS_TRANSITIONS: Readonly<
  Record<PaymentIntentStatus, readonly PaymentIntentStatus[]>
> = {
  CREATING: ['OPEN', 'CLOSED'],
  OPEN: ['HELD', 'APPLIED', 'UNAPPLIED', 'CLOSED'],
  HELD: ['APPLIED', 'UNAPPLIED', 'CLOSED'],
  APPLIED: [],
  UNAPPLIED: [],
  CLOSED: ['APPLIED', 'UNAPPLIED'],
};

/** The CLOSED moves that need a provider payment id on the row. */
export const CLOSED_MOVES_NEEDING_PROVIDER_ID: readonly PaymentIntentStatus[] = [
  'APPLIED',
  'UNAPPLIED',
];

/** Occupy the one-open slot of a payment or wallet, and count for `team_banking_in_use`. */
export const BLOCKING_INTENT_STATUSES: readonly PaymentIntentStatus[] = [
  'CREATING',
  'OPEN',
  'HELD',
];

export function isBlockingIntent(status: PaymentIntentStatus): boolean {
  return BLOCKING_INTENT_STATUSES.includes(status);
}

/** True for a legal move; a same-status write (a mirror refresh) is not a transition and is always accepted. */
export function canTransitionIntent(
  from: PaymentIntentStatus,
  to: PaymentIntentStatus,
  row: { readonly hasProviderId: boolean },
): boolean {
  if (from === to) return true;
  if (!INTENT_STATUS_TRANSITIONS[from].includes(to)) return false;
  return from !== 'CLOSED' || row.hasProviderId;
}
