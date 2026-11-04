import type { ApiResult } from '../api-client.ts';
import type { FormState } from '../auth/form-state.ts';
import type { ModerationResult } from '../teams/moderation.ts';
import { billingErrorLines } from './labels.ts';

type Failure = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * What an action does with an API answer, as pure data (so the whole mapping is table-tested without Next): the two start
 * routes (top-up and payment attempt) either follow a URL or leave an in-place state, and the three admin routes report a
 * `ModerationResult` the Payments area already knows how to announce. Nothing here echoes server text, only stable codes.
 */

/** Only a web URL is ever followed: a `javascript:` or `data:` URL from a bad response never reaches the browser. */
export function isFollowableUrl(url: string | null | undefined): url is string {
  if (url === null || url === undefined) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

export type StartOutcome =
  | { kind: 'redirect'; url: string }
  | {
      kind: 'state';
      state: FormState;
      /** The page's truth changed (settled, held, blocked, still open): revalidate it so it renders that. */
      revalidate: boolean;
    };

const inPlace = (
  code: string,
  values: Record<string, string>,
  revalidate: boolean,
  retryAfterSeconds?: number,
): StartOutcome => ({
  kind: 'state',
  state: {
    error: { code, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) },
    values,
  },
  revalidate,
});

/** The codes after which the page the player is looking at is out of date. */
const STALE_PAGE_CODES: ReadonlySet<string> = new Set([
  'payment_settled',
  'payment_on_hold',
  'payout_not_configured',
  'payment_in_progress',
  'top_up_in_progress',
]);

function startFailure(result: Failure, values: Record<string, string>): StartOutcome {
  const code = result.error.code;
  if (result.status === 422 && result.error.fieldErrors !== undefined) {
    return {
      kind: 'state',
      state: { fieldErrors: result.error.fieldErrors, values },
      revalidate: false,
    };
  }
  if (code === 'payment_provider_refused') {
    return inPlace(
      result.refusalReason === undefined
        ? 'payment_provider_refused'
        : `refused_${result.refusalReason}`,
      values,
      false,
    );
  }
  if (code === 'payment_in_progress' || code === 'top_up_in_progress') {
    // CR-6: while the open link has time left the API hands it back, and following it is the right answer, not an error.
    const resume = result.resume?.redirectUrl;
    if (isFollowableUrl(resume)) return { kind: 'redirect', url: resume };
  }
  if (result.status === 409 && STALE_PAGE_CODES.has(code)) return inPlace(code, values, true);
  if (result.status === 503) return inPlace('payment_provider_unavailable', values, false);
  if (result.status === 403) return inPlace('forbidden', values, false);
  if (result.status === 404) return inPlace('not_found', values, false);
  if (result.status === 429) {
    return inPlace('too_many_requests', values, false, result.retryAfterSeconds);
  }
  return inPlace('service_unavailable', values, false);
}

/** The answer of `POST .../top-ups` or `POST .../attempts`: follow the Akahu URL on success. `values` is what was typed. */
export function toStartOutcome(
  result: ApiResult<{ redirectUrl: string }>,
  values: Record<string, string>,
): StartOutcome {
  if (result.ok) {
    return isFollowableUrl(result.data.redirectUrl)
      ? { kind: 'redirect', url: result.data.redirectUrl }
      : inPlace('service_unavailable', values, false);
  }
  return startFailure(result, values);
}

/** Known refusals the API answers with a state the page now shows: close the confirm and refresh the row. */
const FINAL_CODES: ReadonlySet<string> = new Set([
  'payment_settled',
  'reminder_too_soon',
  'payment_on_hold',
  'payout_not_configured',
  'hold_resolved_by_provider',
  'conflict',
  'forbidden',
  'not_found',
]);

/**
 * The outcome of a reminder, a hold resolution or a payout block as the Payments area announces it. Success carries the
 * message the action built from the row; a 5xx or an unreachable API changes nothing, refreshes nothing and keeps the confirm
 * open with what was typed (AC-ERROR-11).
 */
export function toAdminResult(
  result: ApiResult<unknown>,
  context: { success: string },
): ModerationResult {
  if (result.ok) return { ok: true, message: context.success, refresh: true };
  const { status } = result;
  const scope = { scope: 'admin' as const, retryAfterSeconds: result.retryAfterSeconds };
  const failure = (code: string, refresh: boolean, close = false): ModerationResult => ({
    ok: false,
    code,
    message: billingErrorLines(code, scope)[0] ?? '',
    refresh,
    ...(close ? { close: true } : {}),
  });

  if (status === 422 && result.error.fieldErrors !== undefined) {
    const first = Object.values(result.error.fieldErrors)[0]?.[0];
    return {
      ok: false,
      code: 'validation_failed',
      message: first ?? billingErrorLines('service_unavailable', scope)[0] ?? '',
      refresh: false,
      fieldErrors: result.error.fieldErrors,
    };
  }
  const code = status === 403 ? 'forbidden' : status === 404 ? 'not_found' : result.error.code;
  if (status >= 400 && status < 500 && FINAL_CODES.has(code)) return failure(code, true, true);
  if (status === 429) return failure('too_many_requests', false);
  return failure('service_unavailable', false);
}
