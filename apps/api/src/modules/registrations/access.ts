/**
 * What the read model says about registering, as pure functions (AC-ERROR-1, AC-ERROR-2, AC-VERIFY-4).
 *
 * `blockedReason` reports the first thing that stops a NEW registration, in this order: the session is not open, the caller
 * already has an active registration, three or more payments are overdue, the session has no public place at all. A fee-due
 * withdrawn caller can still try: whether the whole group fits right now is the allocator's answer (`late_withdrawal_fee_due`),
 * not something the page can know without reading the whole queue.
 *
 * Precedence across the two surfaces: an unknown, DRAFT or other-team session is a 404 before any of this (O2, the service
 * resolves visibility first). For a visible but closed session the read model says `session_not_open` first, while a debtor's
 * POST gets the allocator's 403 `overdue_payments` (its member gate precedes the session check). That asymmetry is
 * deliberate: the session is visible, so the debt answer leaks nothing, and the member must clear the debt either way.
 */
import type { RegistrationBlockedReason } from '@sgm/shared';
import { DEBT_LIMIT } from './allocator.ts';

export interface AccessInput {
  readonly sessionOpen: boolean;
  readonly overdueCount: number;
  readonly hasActiveRegistration: boolean;
  readonly publicCapacity: number;
}

export interface Access {
  readonly canRegister: boolean;
  readonly blockedReason: RegistrationBlockedReason | null;
}

export function decideAccess(input: AccessInput): Access {
  const blockedReason: RegistrationBlockedReason | null = !input.sessionOpen
    ? 'session_not_open'
    : input.hasActiveRegistration
      ? 'already_registered'
      : input.overdueCount >= DEBT_LIMIT
        ? 'overdue_payments'
        : input.publicCapacity < 1
          ? 'party_exceeds_capacity'
          : null;
  return { canRegister: blockedReason === null, blockedReason };
}

/** `1 + the waiting parties ahead`, never the raw `queue_position` (it keeps gaps); null unless the row is WAITLISTED. */
export function waitlistRankOf(status: string, waitingAhead: number): number | null {
  return status === 'WAITLISTED' ? waitingAhead + 1 : null;
}
