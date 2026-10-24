/**
 * Allocator refusals as HTTP errors (AC-ERROR-1..7). The allocator RETURNS a refusal; the service throws the `AppError` this file
 * builds. Every message is safe to show: the only variable parts are counts the server itself computed (overdue payments, the
 * session's public capacity, the party size it counted), never anything the client sent.
 */
import { AppError } from '../../lib/http/errors.ts';
import type { RegisterOutcome, WithdrawOutcome } from './allocator.ts';

/** AC-ERROR-2: the same words for register and withdraw on a session that is not open. */
export const REGISTRATION_CLOSED_MESSAGE = 'Registration for this session is closed.';

export function registerRefusalError(
  refusal: Extract<RegisterOutcome, { ok: false }>,
  partySize: number,
): AppError {
  switch (refusal.reason) {
    case 'overdue_payments': {
      const count = refusal.overdueCount;
      return count === undefined
        ? new AppError('overdue_payments')
        : new AppError('overdue_payments', {
            message: `You have ${count} overdue payments. Pay them before registering for more sessions.`,
          });
    }
    case 'session_not_open':
      return new AppError('session_not_open', { message: REGISTRATION_CLOSED_MESSAGE });
    case 'party_exceeds_capacity':
      return refusal.publicCapacity === undefined
        ? new AppError('party_exceeds_capacity')
        : new AppError('party_exceeds_capacity', {
            message: `This session has ${refusal.publicCapacity} public places, so a group of ${partySize} can't register.`,
          });
    case 'already_registered':
    case 'late_withdrawal_fee_due':
    case 'forbidden':
    case 'not_found':
      return new AppError(refusal.reason);
  }
}

export function withdrawRefusalError(refusal: Extract<WithdrawOutcome, { ok: false }>): AppError {
  switch (refusal.reason) {
    case 'session_not_open':
      return new AppError('session_not_open', { message: REGISTRATION_CLOSED_MESSAGE });
    case 'not_registered':
    case 'cancellation_terms_changed':
    case 'not_found':
      return new AppError(refusal.reason);
  }
}
