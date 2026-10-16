'use server';

import { PutBankingRequest, PutGstRequest } from '@sgm/shared';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { RedirectType, redirect } from 'next/navigation';
import { z } from 'zod';
import { apiClient, type ApiResult } from '../api-client.ts';
import { readCookie } from '../auth/cookies.ts';
import type { FormState } from '../auth/form-state.ts';
import { loginUrl, sessionExpiredUrl } from '../auth/landing.ts';
import { log } from '../log.ts';
import {
  BANKING_IN_USE_MESSAGE,
  REMOVE_OUTAGE_MESSAGE,
  bankingPageUrl,
  bankingPath,
  bankingReturnTo,
  fieldErrorsOf,
  parseEditParam,
} from './banking-view.ts';
import { NOT_FOUND_HEADING, NO_ACCESS_HEADING } from './labels.ts';
import type { ModerationResult } from './moderation.ts';

/**
 * Server Actions of the banking page: save banking details, remove them, save GST. Successful writes
 * revalidate the page and `redirect(..., replace)` with a codes-only `?notice=` (Back never shows a stale
 * form). Everything else is an in-place result. Never optimistic: a 5xx or an unreachable API reports
 * the outage, keeps what was typed, and neither revalidates nor claims success (AC-ERROR-13).
 *
 * Privacy (P4): typed values go back only into the same form's `defaultValue` (the account number is
 * re-echoed on purpose: it is what is most often mistyped; the page is no-store). No field value, change
 * key or token is ever logged: failures log the action, status and error code only.
 */

// These two helpers are duplicated from `actions.ts` on purpose: a `'use server'` module exports only
// Server Actions, and exporting them there would make them callable from the browser.
function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === 'string' ? value : undefined;
}

async function requireSession(returnTo: string): Promise<string> {
  const token = await readCookie('session');
  return token ?? redirect(loginUrl({ returnTo }), RedirectType.replace);
}

type Failure = Extract<ApiResult<unknown>, { ok: false }>;

function logFailure(action: string, result: Failure): void {
  log.warn('web.teams.api_failure', { action, status: result.status, code: result.error.code });
}

/** The page the form was on, as the place to return to after a sign-in (edit mode and returnTo kept). */
function hereOf(teamId: string, formData: FormData): string {
  return bankingPageUrl({
    teamId,
    edit: parseEditParam(field(formData, 'edit')),
    returnTo: bankingReturnTo(teamId, field(formData, 'returnTo')),
  });
}

/**
 * The in-place state for a failed save (a 401 is a redirect before this). A 403 means the caller lost
 * admin rights: revalidate so the page becomes the no-access page, and keep nothing they typed.
 */
function failedForm(
  action: string,
  teamId: string,
  result: Failure,
  values: Record<string, string>,
): FormState {
  if (result.status === 403) {
    revalidatePath(bankingPath(teamId));
    return { error: { code: 'forbidden' }, values: {} };
  }
  if (result.status === 422 && result.error.fieldErrors !== undefined) {
    return { fieldErrors: result.error.fieldErrors, values };
  }
  logFailure(action, result);
  return { error: { code: 'service_unavailable' }, values };
}

const noTeam = (values: Record<string, string>): FormState => ({
  error: { code: 'not_found' },
  values,
});

export async function saveBankingAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const teamId = field(formData, 'teamId') ?? '';
  const accountName = field(formData, 'accountName');
  const accountNumber = field(formData, 'accountNumber');
  const values: Record<string, string> = {};
  if (accountName !== undefined) values.accountName = accountName;
  if (accountNumber !== undefined) values.accountNumber = accountNumber;

  // A non-UUID id is not a team: never put it in an API path.
  if (!z.uuid().safeParse(teamId).success) return noTeam(values);
  const parsed = PutBankingRequest.safeParse({
    accountName: accountName ?? '',
    accountNumber,
    changeKey: field(formData, 'changeKey'),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values };

  const here = hereOf(teamId, formData);
  const token = await requireSession(here);
  const result = await apiClient.putTeamBanking(teamId, parsed.data, {
    session: token,
    incoming: await headers(),
  });
  if (!result.ok) {
    if (result.status === 401) return redirect(sessionExpiredUrl(here), RedirectType.replace);
    return failedForm('save_banking', teamId, result, values);
  }

  const wasConfigured = field(formData, 'wasConfigured') === 'true';
  const replacedNumber = parsed.data.accountNumber !== undefined;
  const notice = !wasConfigured
    ? 'banking_saved'
    : replacedNumber
      ? 'banking_account_changed'
      : 'banking_updated';
  revalidatePath(bankingPath(teamId));
  return redirect(
    bankingPageUrl({
      teamId,
      notice,
      returnTo: bankingReturnTo(teamId, field(formData, 'returnTo')),
    }),
    RedirectType.replace,
  );
}

export async function saveGstAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const teamId = field(formData, 'teamId') ?? '';
  const gstNumber = field(formData, 'gstNumber');
  const registered = field(formData, 'gstRegistered') === 'on';
  const values: Record<string, string> = { gstRegistered: registered ? 'on' : 'off' };
  if (gstNumber !== undefined) values.gstNumber = gstNumber;

  if (!z.uuid().safeParse(teamId).success) return noTeam(values);
  // A hidden number input is not in the form at all, which the API reads as "keep the saved number".
  const parsed = PutGstRequest.safeParse({
    gstRegistered: registered,
    ...(gstNumber === undefined ? {} : { gstNumber }),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values };

  const here = hereOf(teamId, formData);
  const token = await requireSession(here);
  const result = await apiClient.putTeamGst(teamId, parsed.data, {
    session: token,
    incoming: await headers(),
  });
  if (!result.ok) {
    if (result.status === 401) return redirect(sessionExpiredUrl(here), RedirectType.replace);
    return failedForm('save_gst', teamId, result, values);
  }

  revalidatePath(bankingPath(teamId));
  return redirect(
    bankingPageUrl({
      teamId,
      notice: 'gst_saved',
      returnTo: bankingReturnTo(teamId, field(formData, 'returnTo')),
    }),
    RedirectType.replace,
  );
}

/**
 * Removal, run by the page's `InlineConfirm`. `banking_in_use` and a lost admin role are final (the server
 * state is known and unchanged), so they close the confirm; a 5xx leaves it open to retry.
 */
export async function removeBankingAction(
  _previous: ModerationResult | null,
  formData: FormData,
): Promise<ModerationResult> {
  const teamId = field(formData, 'teamId') ?? '';
  if (!z.uuid().safeParse(teamId).success) {
    return {
      ok: false,
      code: 'not_found',
      message: NOT_FOUND_HEADING,
      refresh: false,
      close: true,
    };
  }
  const here = hereOf(teamId, formData);
  const token = await requireSession(here);
  const result = await apiClient.removeTeamBanking(teamId, {
    session: token,
    incoming: await headers(),
  });
  if (result.ok) {
    revalidatePath(bankingPath(teamId));
    return redirect(
      bankingPageUrl({
        teamId,
        notice: 'banking_removed',
        returnTo: bankingReturnTo(teamId, field(formData, 'returnTo')),
      }),
      RedirectType.replace,
    );
  }
  if (result.status === 401) return redirect(sessionExpiredUrl(here), RedirectType.replace);
  if (result.status === 403) {
    revalidatePath(bankingPath(teamId));
    return {
      ok: false,
      code: 'forbidden',
      message: NO_ACCESS_HEADING,
      refresh: true,
      close: true,
    };
  }
  if (result.error.code === 'banking_in_use') {
    return {
      ok: false,
      code: 'banking_in_use',
      message: BANKING_IN_USE_MESSAGE,
      refresh: false,
      close: true,
    };
  }
  logFailure('remove_banking', result);
  return {
    ok: false,
    code: 'service_unavailable',
    message: REMOVE_OUTAGE_MESSAGE,
    refresh: false,
  };
}
