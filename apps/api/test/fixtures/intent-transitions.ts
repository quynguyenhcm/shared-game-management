/**
 * The `payment_intent_status` lifecycle shared by `payment_attempts` and `wallet_top_ups`, as hand-written data
 * (wallet-and-akahu-billing CR-1; algorithm doc "State machines" > "Intent state"). One list, three consumers:
 *   - `billing-schema.int.test.ts` replays every `(from, to, hasProviderId)` against `payment_intent_transition_allowed`
 *     and the real guard triggers (SQLSTATE 23000, constraint `<table>_status_transition`);
 *   - `packages/shared/src/billing/intent-status.test.ts` replays it against `INTENT_STATUS_TRANSITIONS`;
 *   - the Phase 2 and Phase 4 apply functions replay it against their decision table.
 *
 * Expected values are written out from the rules below, never computed by production code:
 *   CREATING -> OPEN | CLOSED
 *   OPEN     -> HELD | APPLIED | UNAPPLIED | CLOSED
 *   HELD     -> APPLIED | UNAPPLIED | CLOSED
 *   CLOSED   -> APPLIED | UNAPPLIED, only when the row has an `akahu_payment_id` (a late SENT on a locally closed intent)
 *   APPLIED and UNAPPLIED are terminal. A same-status write (a mirror refresh) is not a transition.
 * Blocking (occupies the one-open slot, counts for `team_banking_in_use`): CREATING, OPEN, HELD.
 */
export type IntentStatusName = 'CREATING' | 'OPEN' | 'HELD' | 'APPLIED' | 'UNAPPLIED' | 'CLOSED';

export interface IntentTransitionRow {
  readonly from: IntentStatusName;
  readonly to: IntentStatusName;
  readonly allowed: boolean;
  /** True when the move is allowed only for a row that already holds a provider payment id. */
  readonly needsProviderId?: true;
}

/** All 36 ordered pairs. */
export const INTENT_TRANSITION_MATRIX: readonly IntentTransitionRow[] = [
  { from: 'CREATING', to: 'CREATING', allowed: true },
  { from: 'CREATING', to: 'OPEN', allowed: true },
  { from: 'CREATING', to: 'HELD', allowed: false },
  { from: 'CREATING', to: 'APPLIED', allowed: false },
  { from: 'CREATING', to: 'UNAPPLIED', allowed: false },
  { from: 'CREATING', to: 'CLOSED', allowed: true },

  { from: 'OPEN', to: 'CREATING', allowed: false },
  { from: 'OPEN', to: 'OPEN', allowed: true },
  { from: 'OPEN', to: 'HELD', allowed: true },
  { from: 'OPEN', to: 'APPLIED', allowed: true },
  { from: 'OPEN', to: 'UNAPPLIED', allowed: true },
  { from: 'OPEN', to: 'CLOSED', allowed: true },

  { from: 'HELD', to: 'CREATING', allowed: false },
  { from: 'HELD', to: 'OPEN', allowed: false },
  { from: 'HELD', to: 'HELD', allowed: true },
  { from: 'HELD', to: 'APPLIED', allowed: true },
  { from: 'HELD', to: 'UNAPPLIED', allowed: true },
  { from: 'HELD', to: 'CLOSED', allowed: true },

  { from: 'APPLIED', to: 'CREATING', allowed: false },
  { from: 'APPLIED', to: 'OPEN', allowed: false },
  { from: 'APPLIED', to: 'HELD', allowed: false },
  { from: 'APPLIED', to: 'APPLIED', allowed: true },
  { from: 'APPLIED', to: 'UNAPPLIED', allowed: false },
  { from: 'APPLIED', to: 'CLOSED', allowed: false },

  { from: 'UNAPPLIED', to: 'CREATING', allowed: false },
  { from: 'UNAPPLIED', to: 'OPEN', allowed: false },
  { from: 'UNAPPLIED', to: 'HELD', allowed: false },
  { from: 'UNAPPLIED', to: 'APPLIED', allowed: false },
  { from: 'UNAPPLIED', to: 'UNAPPLIED', allowed: true },
  { from: 'UNAPPLIED', to: 'CLOSED', allowed: false },

  { from: 'CLOSED', to: 'CREATING', allowed: false },
  { from: 'CLOSED', to: 'OPEN', allowed: false },
  { from: 'CLOSED', to: 'HELD', allowed: false },
  { from: 'CLOSED', to: 'APPLIED', allowed: true, needsProviderId: true },
  { from: 'CLOSED', to: 'UNAPPLIED', allowed: true, needsProviderId: true },
  { from: 'CLOSED', to: 'CLOSED', allowed: true },
];

/** The statuses that block a new intent for the same payment or wallet. */
export const BLOCKING_INTENT_STATUSES: readonly IntentStatusName[] = ['CREATING', 'OPEN', 'HELD'];
