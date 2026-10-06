'use server';

import {
  ForgotPasswordRequest,
  LoginRequest,
  RegisterRequest,
  ResetPasswordRequest,
  safeReturnTo,
} from '@sgm/shared';
import { headers } from 'next/headers';
import { RedirectType, redirect } from 'next/navigation';
import { apiClient, type ApiResult } from '../api-client.ts';
import { log } from '../log.ts';
import { clearCookie, readCookie, setCookie } from './cookies.ts';
import type { FormState } from './form-state.ts';
import { SIGNED_OUT_URL, passwordResetLanding, withWelcome } from './landing.ts';
import {
  validateForgotPassword,
  validateLogin,
  validateRegister,
  validateResetPassword,
} from './validation.ts';

/** Server Actions for the auth forms. Every navigation is a `redirect(..., replace)` so Back never shows a stale form. */

function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === 'string' ? value : undefined;
}

function hasErrors(errors: Record<string, string[]>): boolean {
  return Object.keys(errors).length > 0;
}

/** The in-place state for a failed API call. Passwords are never in `values`. */
function failed(
  action: string,
  result: Extract<ApiResult<unknown>, { ok: false }>,
  values: Record<string, string>,
): FormState {
  if (result.status === 0 || result.status >= 500) {
    log.warn('web.auth.api_failure', { action, status: result.status, code: result.error.code });
  }
  if (result.status === 422 && result.error.fieldErrors !== undefined) {
    return { fieldErrors: result.error.fieldErrors, values };
  }
  return {
    error: {
      code: result.error.code,
      ...(result.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: result.retryAfterSeconds }
        : {}),
    },
    values,
  };
}

async function establishSession(token: string, expiresAt: string): Promise<void> {
  await setCookie('session', token, expiresAt);
}

export async function registerAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const raw = {
    fullName: field(formData, 'fullName'),
    email: field(formData, 'email'),
    password: field(formData, 'password'),
    sex: field(formData, 'sex'),
  };
  const values: Record<string, string> = {
    fullName: raw.fullName ?? '',
    email: raw.email ?? '',
    ...(raw.sex ? { sex: raw.sex } : {}),
  };
  const fieldErrors = validateRegister(raw);
  if (hasErrors(fieldErrors)) return { fieldErrors, values };

  const result = await apiClient.register(RegisterRequest.parse(raw), {
    incoming: await headers(),
  });
  if (!result.ok) return failed('register', result, values);
  await establishSession(result.data.session.token, result.data.session.expiresAt);
  return redirect(withWelcome(safeReturnTo(field(formData, 'returnTo'))), RedirectType.replace);
}

export async function loginAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const raw = { email: field(formData, 'email'), password: field(formData, 'password') };
  const values = { email: raw.email ?? '' };
  const fieldErrors = validateLogin(raw);
  if (hasErrors(fieldErrors)) return { fieldErrors, values };

  // An existing session is presented so the API can revoke it as `replaced`.
  const result = await apiClient.login(
    LoginRequest.parse({ email: raw.email, password: raw.password }),
    { session: await readCookie('session'), incoming: await headers() },
  );
  if (!result.ok) return failed('login', result, values);
  await establishSession(result.data.session.token, result.data.session.expiresAt);
  return redirect(safeReturnTo(field(formData, 'returnTo')), RedirectType.replace);
}

export async function forgotPasswordAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = field(formData, 'email') ?? '';
  const values = { email };
  const fieldErrors = validateForgotPassword({ email });
  if (hasErrors(fieldErrors)) return { fieldErrors, values };

  const result = await apiClient.forgotPassword(ForgotPasswordRequest.parse({ email }), {
    incoming: await headers(),
  });
  if (!result.ok) return failed('forgot_password', result, values);
  return { sent: { email: email.trim() }, values };
}

export async function resetPasswordAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const token = field(formData, 'token') ?? '';
  const password = field(formData, 'password');
  if (token === '') return { error: { code: 'invalid_or_expired_token' } };
  const fieldErrors = validateResetPassword({ password });
  if (hasErrors(fieldErrors)) return { fieldErrors };

  const result = await apiClient.resetPassword(ResetPasswordRequest.parse({ token, password }), {
    incoming: await headers(),
  });
  if (!result.ok) return failed('reset_password', result, {});
  // The API revoked every session of the user, this browser's included.
  await clearCookie('session');
  return redirect(passwordResetLanding(result.data.removedProviders), RedirectType.replace);
}

/** Sign-out never shows an error: the cookie goes and the user lands on /login whatever the API answered. */
export async function signOutAction(_formData?: FormData): Promise<void> {
  const token = await readCookie('session');
  if (token !== null) {
    try {
      const result = await apiClient.logout({ session: token, incoming: await headers() });
      if (!result.ok && result.status !== 401) {
        log.warn('web.auth.logout_api_failed', { status: result.status, code: result.error.code });
      }
    } catch {
      log.warn('web.auth.logout_api_failed', { status: 0, code: 'exception' });
    }
  }
  await clearCookie('session');
  return redirect(SIGNED_OUT_URL, RedirectType.replace);
}
