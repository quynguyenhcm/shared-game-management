/**
 * The `payments.status` lifecycle as hand-written data (wallet-and-akahu-billing D-87, B4; algorithm doc "Payment
 * status"). One list, three consumers, so the SQL guard, the shared TS table and the engine's decisions cannot drift:
 *   - `billing-schema.int.test.ts` replays every `(from, to)` pair against `payment_status_transition_allowed` and, for
 *     every pair a row can reach, as a raw `UPDATE` against the `payments_guard_status` trigger (SQLSTATE 23000,
 *     constraint `payments_status_transition`);
 *   - `packages/shared/src/billing/payment-status.test.ts` replays it against `PAYMENT_STATUS_TRANSITIONS`;
 *   - `apps/api/src/modules/billing` will replay it against its decision functions (Phase 2).
 *
 * Expected values are written out from the rules below, never computed by production code:
 *   PENDING -> PAID | OVERDUE;  OVERDUE -> PAID;  PAID is terminal;  nothing enters FAILED (B4 default: a failed
 *   Akahu attempt is recorded on the attempt, the charge stays payable);  a same-status write is not a transition.
 * Any change to the matrix changes the SQL, the TS and this file in one commit (the ADR 0016 discipline).
 */
export type PaymentStatusName = 'PENDING' | 'PAID' | 'FAILED' | 'OVERDUE';

export interface PaymentTransitionRow {
  readonly from: PaymentStatusName;
  readonly to: PaymentStatusName;
  /** For `from === to` the row is a same-status write: not a transition, so the trigger accepts it. */
  readonly allowed: boolean;
}

/** All 16 ordered pairs. */
export const PAYMENT_TRANSITION_MATRIX: readonly PaymentTransitionRow[] = [
  { from: 'PENDING', to: 'PENDING', allowed: true },
  { from: 'PENDING', to: 'PAID', allowed: true },
  { from: 'PENDING', to: 'FAILED', allowed: false },
  { from: 'PENDING', to: 'OVERDUE', allowed: true },
  { from: 'PAID', to: 'PENDING', allowed: false },
  { from: 'PAID', to: 'PAID', allowed: true },
  { from: 'PAID', to: 'FAILED', allowed: false },
  { from: 'PAID', to: 'OVERDUE', allowed: false },
  { from: 'FAILED', to: 'PENDING', allowed: false },
  { from: 'FAILED', to: 'PAID', allowed: false },
  { from: 'FAILED', to: 'FAILED', allowed: true },
  { from: 'FAILED', to: 'OVERDUE', allowed: false },
  { from: 'OVERDUE', to: 'PENDING', allowed: false },
  { from: 'OVERDUE', to: 'PAID', allowed: true },
  { from: 'OVERDUE', to: 'FAILED', allowed: false },
  { from: 'OVERDUE', to: 'OVERDUE', allowed: true },
];

/**
 * Statuses a payment row may be INSERTed with. OVERDUE stays insertable because registrations' debt-gate fixtures seed
 * OVERDUE rows with raw SQL (only the `daily-overdue` job writing OVERDUE is an application rule, C-BIL-2);
 * FAILED is refused on insert as well (nothing enters FAILED).
 */
export const PAYMENT_INSERT_STATUS_MATRIX: readonly {
  readonly status: PaymentStatusName;
  readonly allowed: boolean;
}[] = [
  { status: 'PENDING', allowed: true },
  { status: 'PAID', allowed: true },
  { status: 'OVERDUE', allowed: true },
  { status: 'FAILED', allowed: false },
];
