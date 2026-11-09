/**
 * The `payments.status` matrix (wallet-and-akahu-billing D-87, B4). The TS twin of the `payments_guard_status` trigger
 * and of `payment_status_transition_allowed`: any change here changes the SQL and
 * `apps/api/test/fixtures/payment-transitions.ts` in the same commit.
 *
 * PENDING -> PAID | OVERDUE, OVERDUE -> PAID. PAID is terminal. Nothing enters FAILED: a failed Akahu attempt is
 * recorded on the attempt and the charge stays payable. OVERDUE is written only by the `daily-overdue` job (C-BIL-2).
 */
import type { PaymentStatus } from '../types/enums.ts';

export const PAYMENT_STATUS_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> =
  {
    PENDING: ['PAID', 'OVERDUE'],
    OVERDUE: ['PAID'],
    PAID: [],
    FAILED: [],
  };

/** Statuses a payment row may be created with (FAILED is refused; OVERDUE stays seedable by raw SQL fixtures). */
export const PAYMENT_INSERT_STATUSES: readonly PaymentStatus[] = ['PENDING', 'PAID', 'OVERDUE'];

/** True for a legal move; a same-status write is not a transition and is always accepted. */
export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return from === to || PAYMENT_STATUS_TRANSITIONS[from].includes(to);
}

/** PAID (and the unreachable FAILED): no further moves. */
export function isPaymentTerminal(status: PaymentStatus): boolean {
  return PAYMENT_STATUS_TRANSITIONS[status].length === 0;
}
