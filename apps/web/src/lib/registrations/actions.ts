'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { RedirectType, redirect } from 'next/navigation';
import { z } from 'zod';
import { apiClient, type ApiCallOptions, type ApiResult } from '../api-client.ts';
import { readCookie } from '../auth/cookies.ts';
import { loginUrl, sessionExpiredUrl } from '../auth/landing.ts';
import { log } from '../log.ts';
import { SESSION_NOT_FOUND_MESSAGE, type RegisterIntent, type WithdrawIntent } from './labels.ts';
import { toRegisterResult, toWithdrawResult, type RegistrationActionResult } from './outcome.ts';
import { playerSessionPath } from './paths.ts';
import { buildRegisterBody, type GuestValues } from './validation.ts';

/**
 * Server Actions of the registration panel: register and withdraw. The API stays the authority: this module builds the strict
 * request body, maps what the API answered (`outcome.ts`) and decides nothing about seats, fees or the waitlist. Never
 * optimistic: a 5xx or an unreachable API changes nothing on the page and revalidates nothing; a known state change (403, 404,
 * 409, success) revalidates the page so it renders the truth. A lapsed session goes to sign-in expiry and returns here.
 *
 * Privacy: no guest name, field value or token is ever logged; failures log the action, status and code only.
 */

// Private on purpose: a `'use server'` module may export only Server Actions, and exporting a helper would make it
// callable from the browser.

const isUuid = (value: string): boolean => z.uuid().safeParse(value).success;

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
};

async function requireSession(returnTo: string): Promise<string> {
  const token = await readCookie('session');
  return token ?? redirect(loginUrl({ returnTo }), RedirectType.replace);
}

async function callOptions(token: string): Promise<ApiCallOptions> {
  return { session: token, incoming: await headers() };
}

function afterApi(
  action: string,
  here: string,
  api: ApiResult<unknown>,
  result: RegistrationActionResult,
): RegistrationActionResult {
  if (!api.ok) {
    if (api.status === 401) return redirect(sessionExpiredUrl(here), RedirectType.replace);
    log.warn('web.registrations.api_failure', { action, status: api.status, code: api.error.code });
  }
  if (result.refresh) revalidatePath(here);
  return result;
}

const notFound = (): RegistrationActionResult => ({
  ok: false,
  code: 'not_found',
  message: SESSION_NOT_FOUND_MESSAGE,
  refresh: false,
});

/** The guests the form posted: `party` of them (0 to 2), read from the flat `guest{n}Sex`, `guest{n}Skill`, `guest{n}Name` fields. */
function guestsOf(formData: FormData): GuestValues[] {
  const party = Math.min(Math.max(Number(text(formData, 'party')) || 0, 0), 2);
  return Array.from({ length: party }, (_, index) => ({
    sex: text(formData, `guest${index + 1}Sex`),
    skillLevel: text(formData, `guest${index + 1}Skill`),
    displayName: text(formData, `guest${index + 1}Name`),
  }));
}

/** "Register" and "Join waitlist": one POST; the server decides CONFIRMED or WAITLISTED. */
export async function registerAction(
  _previous: RegistrationActionResult | null,
  formData: FormData,
): Promise<RegistrationActionResult> {
  const teamId = text(formData, 'teamId');
  const sessionId = text(formData, 'sessionId');
  if (!isUuid(teamId) || !isUuid(sessionId)) return notFound();

  const here = playerSessionPath(teamId, sessionId);
  const intent: RegisterIntent = text(formData, 'intent') === 'waitlist' ? 'waitlist' : 'register';
  const options = await callOptions(await requireSession(here));
  const api = await apiClient.registerForSession(
    teamId,
    sessionId,
    buildRegisterBody(guestsOf(formData)),
    options,
  );
  return afterApi('register', here, api, toRegisterResult(api, { intent }));
}

/** "Withdraw" and "Leave waitlist": the body is only the caller's view of the terms (`expectLate`, R9). */
export async function withdrawAction(
  _previous: RegistrationActionResult | null,
  formData: FormData,
): Promise<RegistrationActionResult> {
  const teamId = text(formData, 'teamId');
  const sessionId = text(formData, 'sessionId');
  if (!isUuid(teamId) || !isUuid(sessionId)) return notFound();

  const here = playerSessionPath(teamId, sessionId);
  const intent: WithdrawIntent = text(formData, 'intent') === 'leave' ? 'leave' : 'withdraw';
  const options = await callOptions(await requireSession(here));
  const api = await apiClient.withdrawFromSession(
    teamId,
    sessionId,
    { expectLate: text(formData, 'expectLate') === 'true' },
    options,
  );
  return afterApi(
    'withdraw',
    here,
    api,
    toWithdrawResult(api, { intent, grouped: text(formData, 'grouped') === '1' }),
  );
}
