import type { ApiResult } from '../api-client.ts';
import type { FieldErrors } from '../auth/validation.ts';
import { OUTAGE_MESSAGE } from '../teams/labels.ts';
import {
  ALREADY_REGISTERED_MESSAGE,
  CAPACITY_FALLBACK_MESSAGE,
  DEADLINE_CHANGED_MESSAGE,
  FEE_DUE_MESSAGE,
  NOT_MEMBER_MESSAGE,
  NOT_REGISTERED_MESSAGE,
  OVERDUE_HELP,
  SESSION_CLOSED_MESSAGE,
  SESSION_NOT_FOUND_MESSAGE,
  registerResultMessage,
  withdrawResultMessage,
  type RegisterIntent,
  type WithdrawIntent,
} from './labels.ts';
import { fieldErrorsFromApi } from './validation.ts';

/**
 * What a registration Server Action reports to the panel: the mapping from an API answer to the words the player reads
 * (AC-ERROR-1..8, R9). Pure, so every code is unit-tested once through the actions. `refresh` says the action revalidated the
 * page (a known state change: 403, 404, 409, success); a 5xx or an unreachable API never does, so nothing is shown that did
 * not happen and the form and the open confirmation keep what the player typed (AC-ERROR-8).
 */
export interface RegistrationActionResult {
  ok: boolean;
  message: string;
  code?: string;
  refresh: boolean;
  fieldErrors?: FieldErrors;
  /** `cancellation_terms_changed`: the confirmation stays (or re-opens) and now carries the late wording. */
  reopenConfirm?: boolean;
}

export type RegistrationAction = (
  previous: RegistrationActionResult | null,
  formData: FormData,
) => Promise<RegistrationActionResult>;

type Failure = Extract<ApiResult<unknown>, { ok: false }>;

const failure = (
  code: string,
  message: string,
  refresh: boolean,
  extra: Partial<RegistrationActionResult> = {},
): RegistrationActionResult => ({ ok: false, code, message, refresh, ...extra });

const outage = (): RegistrationActionResult =>
  failure('service_unavailable', OUTAGE_MESSAGE, false);

/** Failures the same words for register and withdraw: who you are, what exists, and whether the session is open. */
function commonFailure(result: Failure): RegistrationActionResult | null {
  const { status, error } = result;
  if (status === 403 && error.code === 'forbidden') {
    return failure('forbidden', NOT_MEMBER_MESSAGE, true);
  }
  if (status === 403 && error.code === 'overdue_payments') {
    // The read model said otherwise for a visible closed session; the API's own message carries the count it computed.
    return failure('overdue_payments', `${error.message} ${OVERDUE_HELP}`, true);
  }
  if (status === 404) return failure('not_found', SESSION_NOT_FOUND_MESSAGE, true);
  if (status === 409 && error.code === 'session_not_open') {
    return failure('session_not_open', SESSION_CLOSED_MESSAGE, true);
  }
  return null;
}

export function toRegisterResult(
  result: ApiResult<{
    registration: { status: 'CONFIRMED' | 'WAITLISTED'; waitlistRank: number | null };
  }>,
  context: { intent: RegisterIntent },
): RegistrationActionResult {
  if (result.ok) {
    const { status, waitlistRank } = result.data.registration;
    return {
      ok: true,
      message: registerResultMessage({ status, rank: waitlistRank, intent: context.intent }),
      refresh: true,
    };
  }
  const common = commonFailure(result);
  if (common !== null) return common;
  const { status, error } = result;
  if (status === 409 && error.code === 'already_registered') {
    return failure('already_registered', ALREADY_REGISTERED_MESSAGE, true);
  }
  if (status === 409 && error.code === 'late_withdrawal_fee_due') {
    return failure('late_withdrawal_fee_due', FEE_DUE_MESSAGE, true);
  }
  if (status === 422 && error.code === 'party_exceeds_capacity') {
    return failure('party_exceeds_capacity', error.message || CAPACITY_FALLBACK_MESSAGE, false);
  }
  if (status === 422 && error.fieldErrors !== undefined) {
    return failure('validation_failed', "There's a problem", false, {
      fieldErrors: fieldErrorsFromApi(error.fieldErrors),
    });
  }
  return outage();
}

export function toWithdrawResult(
  result: ApiResult<{
    registration: { withdrawalKind: 'EARLY' | 'LATE' | 'BANNED' };
    replacedBy: 'waitlist' | 'nobody';
    feeEstimate: string;
  }>,
  context: { intent: WithdrawIntent; grouped: boolean },
): RegistrationActionResult {
  if (result.ok) {
    const { registration, replacedBy, feeEstimate } = result.data;
    return {
      ok: true,
      message: withdrawResultMessage({
        intent: context.intent,
        kind: registration.withdrawalKind,
        replacedBy,
        feeEstimate,
        grouped: context.grouped,
      }),
      refresh: true,
    };
  }
  const common = commonFailure(result);
  if (common !== null) return common;
  const { status, error } = result;
  if (status === 409 && error.code === 'not_registered') {
    return failure('not_registered', NOT_REGISTERED_MESSAGE, true);
  }
  if (status === 409 && error.code === 'cancellation_terms_changed') {
    return failure('cancellation_terms_changed', DEADLINE_CHANGED_MESSAGE, true, {
      reopenConfirm: true,
    });
  }
  return outage();
}
