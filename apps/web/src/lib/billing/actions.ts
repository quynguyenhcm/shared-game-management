'use server';

import {
  HoldResolutionRequest,
  PayoutBlockRequest,
  SendReminderRequest,
  StartAttemptRequest,
  TopUpRequest,
  toMoneyString,
} from '@sgm/shared';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { RedirectType, redirect } from 'next/navigation';
import { z } from 'zod';
import { apiClient, type ApiCallOptions, type ApiResult } from '../api-client.ts';
import { readCookie } from '../auth/cookies.ts';
import type { FormState } from '../auth/form-state.ts';
import { loginUrl, sessionExpiredUrl } from '../auth/landing.ts';
import { log } from '../log.ts';
import { fieldErrorsOf } from '../teams/banking-view.ts';
import type { ModerationResult } from '../teams/moderation.ts';
import {
  billingErrorLines,
  holdResolutionResultMessage,
  payoutBlockResultMessage,
  reminderSuccess,
} from './labels.ts';
import { toAdminResult, toStartOutcome, type StartOutcome } from './outcome.ts';
import { adminPaymentsPath, paymentPath, walletPath } from './paths.ts';

/**
 * Server Actions of the billing pages: start a top-up, start a payment (both redirect to Akahu on success), send a reminder,
 * record what happened to a held payment and block a team's payouts. The API stays the authority: this module builds the
 * strict request body, maps what the API answered (`outcome.ts`) and decides nothing about amounts, holds or cooldowns.
 * Never optimistic: a 5xx or an unreachable API changes nothing and revalidates nothing; a known state change revalidates
 * the page so it renders the truth. `redirect()` to Akahu happens only on a success the API confirmed, with a URL that is
 * http(s). A lapsed session goes to sign-in expiry and returns here.
 *
 * Privacy: no amount, key, payment link or token is ever logged; failures log the action, status and error code only.
 */

// Private on purpose: a `'use server'` module may export only Server Actions, and exporting a helper would make it
// callable from the browser.

const isUuid = (value: string | undefined): value is string => z.uuid().safeParse(value).success;

function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === 'string' ? value : undefined;
}

async function requireSession(returnTo: string): Promise<string> {
  const token = await readCookie('session');
  return token ?? redirect(loginUrl({ returnTo }), RedirectType.replace);
}

async function callOptions(token: string): Promise<ApiCallOptions> {
  return { session: token, incoming: await headers() };
}

function logFailure(action: string, api: ApiResult<unknown>): void {
  if (!api.ok)
    log.warn('web.billing.api_failure', { action, status: api.status, code: api.error.code });
}

function expired(here: string): never {
  return redirect(sessionExpiredUrl(here), RedirectType.replace);
}

/** Follow the URL, or report in place (revalidating the page when what it shows is now stale). */
function finishStart(
  action: string,
  here: string,
  api: ApiResult<{ redirectUrl: string }>,
  values: Record<string, string>,
): FormState {
  if (!api.ok && api.status === 401) return expired(here);
  const outcome: StartOutcome = toStartOutcome(api, values);
  if (outcome.kind === 'redirect') return redirect(outcome.url);
  logFailure(action, api);
  if (outcome.revalidate) revalidatePath(here);
  return outcome.state;
}

/** "Top up with Akahu" and "Continue with Akahu" on the wallet page. */
export async function startTopUpAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const teamId = field(formData, 'teamId');
  const amount = field(formData, 'amount') ?? '';
  const values = { amount };
  if (!isUuid(teamId)) return { error: { code: 'not_found' }, values };

  const parsed = TopUpRequest.safeParse({
    amount,
    idempotencyKey: field(formData, 'idempotencyKey'),
  });
  if (!parsed.success) {
    const errors = fieldErrorsOf(parsed.error);
    if (errors.idempotencyKey !== undefined) return { error: { code: 'key_invalid' }, values };
    return { fieldErrors: errors, values };
  }

  const here = walletPath(teamId);
  const options = await callOptions(await requireSession(here));
  const api = await apiClient.startTopUp(
    teamId,
    { amount: toMoneyString(parsed.data.amount), idempotencyKey: parsed.data.idempotencyKey },
    options,
  );
  return finishStart('start_top_up', here, api, values);
}

/** "Pay with Akahu", "Try again" and "Continue with Akahu" on the payment page: the payment's own amount, only a key. */
export async function startPaymentAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const paymentId = field(formData, 'paymentId');
  if (!isUuid(paymentId)) return { error: { code: 'not_found' }, values: {} };

  const parsed = StartAttemptRequest.safeParse({
    idempotencyKey: field(formData, 'idempotencyKey'),
  });
  if (!parsed.success) return { error: { code: 'key_invalid' }, values: {} };

  const here = paymentPath(paymentId);
  const options = await callOptions(await requireSession(here));
  const api = await apiClient.startAttempt(paymentId, parsed.data, options);
  return finishStart('start_payment', here, api, {});
}

const finalFailure = (
  code: string,
  message: string,
  fieldErrors?: Record<string, string[]>,
): ModerationResult => ({
  ok: false,
  code,
  message,
  refresh: false,
  ...(fieldErrors === undefined ? {} : { fieldErrors }),
});

const notFound = (): ModerationResult =>
  finalFailure('not_found', billingErrorLines('not_found', { scope: 'admin' })[0] ?? '');
const keyInvalid = (): ModerationResult =>
  finalFailure('key_invalid', billingErrorLines('key_invalid')[0] ?? '');

/** The shared tail of the three admin actions: session expiry, the mapped result, and a revalidate when it says so. */
function finishAdmin(
  action: string,
  here: string,
  api: ApiResult<unknown>,
  success: string,
): ModerationResult {
  if (!api.ok && api.status === 401) return expired(here);
  logFailure(action, api);
  const result = toAdminResult(api, { success });
  if (result.refresh) revalidatePath(here);
  return result;
}

/** "Send reminder" on a row of the Payments area. The first name and amount only build the announcement. */
export async function sendReminderAction(
  _previous: ModerationResult | null,
  formData: FormData,
): Promise<ModerationResult> {
  const teamId = field(formData, 'teamId');
  const paymentId = field(formData, 'paymentId');
  if (!isUuid(teamId) || !isUuid(paymentId)) return notFound();
  const parsed = SendReminderRequest.safeParse({ changeKey: field(formData, 'changeKey') });
  if (!parsed.success) return keyInvalid();

  const here = adminPaymentsPath(teamId);
  const options = await callOptions(await requireSession(here));
  const api = await apiClient.sendReminder(teamId, paymentId, parsed.data, options);

  let success = 'Reminder sent.';
  try {
    success = reminderSuccess(
      field(formData, 'firstName') ?? 'the player',
      field(formData, 'amount') ?? '',
    );
  } catch {
    // An unreadable amount only costs the announcement its detail; the reminder itself already went.
  }
  return finishAdmin('send_reminder', here, api, success);
}

/** Record what happened to a held payment (payee-team admins or GLOBAL_ADMIN, ruling H2; CR-26 guards are the API's). */
export async function resolveHoldAction(
  _previous: ModerationResult | null,
  formData: FormData,
): Promise<ModerationResult> {
  const teamId = field(formData, 'teamId');
  const paymentId = field(formData, 'paymentId');
  if (!isUuid(teamId) || !isUuid(paymentId)) return notFound();

  const outcome = field(formData, 'outcome');
  if (outcome !== 'RECEIVED' && outcome !== 'NOT_RECEIVED') {
    const message = 'Choose whether the money arrived.';
    return finalFailure('validation_failed', message, { outcome: [message] });
  }
  // Only a received payment has an observed amount: a stale value typed before switching to "didn't arrive" is dropped.
  const observed = outcome === 'RECEIVED' ? (field(formData, 'observedAmount') ?? '').trim() : '';
  const parsed = HoldResolutionRequest.safeParse({
    outcome,
    changeKey: field(formData, 'changeKey'),
    ...(observed === '' ? {} : { observedAmount: observed }),
  });
  if (!parsed.success) {
    const errors = fieldErrorsOf(parsed.error);
    if (errors.changeKey !== undefined) return keyInvalid();
    const first = Object.values(errors)[0]?.[0] ?? '';
    return finalFailure('validation_failed', first, errors);
  }

  const here = adminPaymentsPath(teamId);
  const options = await callOptions(await requireSession(here));
  const body = {
    outcome: parsed.data.outcome,
    changeKey: parsed.data.changeKey,
    ...(parsed.data.observedAmount === undefined
      ? {}
      : { observedAmount: toMoneyString(parsed.data.observedAmount) }),
  };
  const api = await apiClient.resolveHold(paymentId, body, options);
  return finishAdmin(
    'resolve_hold',
    here,
    api,
    api.ok ? holdResolutionResultMessage(api.data.intentStatus) : '',
  );
}

/** Block a team's payouts (GLOBAL_ADMIN only; an enum reason and an optional Akahu payment id, never free text). */
export async function blockPayoutAction(
  _previous: ModerationResult | null,
  formData: FormData,
): Promise<ModerationResult> {
  const teamId = field(formData, 'teamId');
  if (!isUuid(teamId)) return notFound();

  const akahuPaymentId = (field(formData, 'akahuPaymentId') ?? '').trim();
  const parsed = PayoutBlockRequest.safeParse({
    reason: field(formData, 'reason'),
    changeKey: field(formData, 'changeKey'),
    ...(akahuPaymentId === '' ? {} : { akahuPaymentId }),
  });
  if (!parsed.success) {
    const errors = fieldErrorsOf(parsed.error);
    if (errors.changeKey !== undefined) return keyInvalid();
    if (errors.reason !== undefined) errors.reason = ['Choose a reason.'];
    const first = Object.values(errors)[0]?.[0] ?? '';
    return finalFailure('validation_failed', first, errors);
  }

  const here = adminPaymentsPath(teamId);
  const options = await callOptions(await requireSession(here));
  const api = await apiClient.blockPayout(teamId, parsed.data, options);
  return finishAdmin(
    'block_payout',
    here,
    api,
    api.ok ? payoutBlockResultMessage(api.data.alreadyBlocked) : '',
  );
}
