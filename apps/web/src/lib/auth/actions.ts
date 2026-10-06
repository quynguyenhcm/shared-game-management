'use server';

import {
  ForgotPasswordRequest,
  LoginRequest,
  OAuthCompleteRequest,
  RegisterRequest,
  ResetPasswordRequest,
  encodeOAuthBinding,
  safeReturnTo,
} from '@sgm/shared';
import { headers } from 'next/headers';
import { RedirectType, redirect } from 'next/navigation';
import { apiClient, type ApiResult, type OAuthProviderPath } from '../api-client.ts';
import { log } from '../log.ts';
import { clearCookie, readCookie, setCookie } from './cookies.ts';
import type { FormState } from './form-state.ts';
import {
  SIGNED_OUT_URL,
  buildUrl,
  loginUrl,
  oauthErrorLanding,
  passwordResetLanding,
  sessionExpiredUrl,
  withWelcome,
} from './landing.ts';
import { isUrlErrorCode } from './messages.ts';
import { getSessionState } from './session.ts';
import {
  validateCompleteSignup,
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

// ---------------------------------------------------------------------------------------------
// OAuth sign-in, sign-up completion and identity linking (Phase 5)
// ---------------------------------------------------------------------------------------------

function providerPath(raw: string | undefined): OAuthProviderPath | null {
  return raw === 'google' || raw === 'facebook' ? raw : null;
}

/** Stores the browser-binding cookie, then sends the browser to the provider's consent screen. */
async function beginProviderFlow(
  authorize: { authorizationUrl: string; state: string },
  context: { returnTo: string; intent: 'signin' | 'link' },
): Promise<never> {
  await setCookie('oauth', encodeOAuthBinding(authorize.state, context));
  return redirect(authorize.authorizationUrl);
}

/** "Continue with Google/Facebook" and "Try Facebook again" (`rerequest`). Failures stay on the page. */
export async function startOAuthAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const provider = providerPath(field(formData, 'provider'));
  if (provider === null) return { error: { code: 'provider_not_enabled' } };
  const values = { provider };
  const returnTo = safeReturnTo(field(formData, 'returnTo'));
  const rerequest = provider === 'facebook' && field(formData, 'rerequest') === 'true';

  const result = await apiClient.oauthAuthorize(
    provider,
    { returnTo, ...(rerequest ? { rerequest: true } : {}) },
    { incoming: await headers() },
  );
  if (!result.ok) return failed('oauth_authorize', result, values);
  try {
    return await beginProviderFlow(result.data, { returnTo, intent: 'signin' });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    log.error('web.auth.oauth_binding_rejected', { provider });
    return { error: { code: 'internal_error' }, values };
  }
}

/** A link or unlink failure lands on `/account` as a code the page knows how to word. */
function accountFailure(
  result: Extract<ApiResult<unknown>, { ok: false }>,
  provider: OAuthProviderPath,
): never {
  if (result.status === 401) return redirect(sessionExpiredUrl('/account'), RedirectType.replace);
  const code = isUrlErrorCode(result.error.code) ? result.error.code : 'service_unavailable';
  return redirect(
    buildUrl('/account', {
      error: code,
      provider: code === 'last_sign_in_method' ? null : provider,
    }),
    RedirectType.replace,
  );
}

/** "Connect Google/Facebook" on /account: the same flow with intent `link`; always returns to /account. */
export async function connectProviderAction(formData: FormData): Promise<void> {
  const provider = providerPath(field(formData, 'provider'));
  if (provider === null) {
    return redirect(buildUrl('/account', { error: 'provider_not_enabled' }), RedirectType.replace);
  }
  const session = await readCookie('session');
  if (session === null) return redirect(loginUrl({ returnTo: '/account' }), RedirectType.replace);

  const result = await apiClient.startLink(provider, session, { incoming: await headers() });
  if (!result.ok) return accountFailure(result, provider);
  return beginProviderFlow(result.data, { returnTo: '/account', intent: 'link' });
}

/** "Disconnect" on /account. The API refuses the last sign-in method (409), whatever the button looked like. */
export async function disconnectProviderAction(formData: FormData): Promise<void> {
  const provider = providerPath(field(formData, 'provider'));
  if (provider === null) {
    return redirect(buildUrl('/account', { error: 'provider_not_enabled' }), RedirectType.replace);
  }
  const session = await readCookie('session');
  if (session === null) return redirect(loginUrl({ returnTo: '/account' }), RedirectType.replace);

  const result = await apiClient.unlink(provider, session, { incoming: await headers() });
  if (!result.ok) return accountFailure(result, provider);
  return redirect(buildUrl('/account', { notice: 'unlinked', provider }), RedirectType.replace);
}

/** The pending sign-up is gone: a live session means it finished in another tab (AC-ENTRY-8). */
async function signupExpired(returnTo: string): Promise<never> {
  const session = await getSessionState();
  if (session.kind === 'signed_in') return redirect(returnTo, RedirectType.replace);
  return redirect(loginUrl({ error: 'signup_expired' }), RedirectType.replace);
}

/** "Finish sign-up" on /register/complete: the account is created only here, with the chosen sex. */
export async function completeSignupAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const returnTo = safeReturnTo(field(formData, 'returnTo'));
  const pendingToken = await readCookie('pending');
  if (pendingToken === null) return signupExpired(returnTo);

  const raw = { fullName: field(formData, 'fullName'), sex: field(formData, 'sex') };
  const values: Record<string, string> = {
    fullName: raw.fullName ?? '',
    ...(raw.sex ? { sex: raw.sex } : {}),
  };
  const fieldErrors = validateCompleteSignup(raw);
  if (hasErrors(fieldErrors)) return { fieldErrors, values };

  const result = await apiClient.oauthComplete(
    OAuthCompleteRequest.parse({ pendingToken, fullName: raw.fullName, sex: raw.sex }),
    { incoming: await headers() },
  );
  if (result.ok) {
    await clearCookie('pending');
    await establishSession(result.data.session.token, result.data.session.expiresAt);
    const target = safeReturnTo(result.data.returnTo);
    // 201 is a new account; 200 means the identity already existed (no welcome for an old account).
    return redirect(result.status === 201 ? withWelcome(target) : target, RedirectType.replace);
  }
  if (result.error.code === 'signup_expired') {
    await clearCookie('pending');
    return signupExpired(returnTo);
  }
  if (result.error.code === 'oauth_account_exists') {
    await clearCookie('pending');
    if (result.error.email) await setCookie('flash', result.error.email);
    return redirect(
      oauthErrorLanding({
        code: 'oauth_account_exists',
        provider: providerPath(field(formData, 'provider')) ?? '',
        intent: 'signin',
        returnTo,
      }),
      RedirectType.replace,
    );
  }
  return failed('complete_signup', result, values);
}

/** "Use a different account": forget the pending sign-up and go back to sign-in. No API call (the row expires). */
export async function chooseDifferentAccountAction(formData?: FormData): Promise<void> {
  await clearCookie('pending');
  const returnTo = formData === undefined ? undefined : field(formData, 'returnTo');
  return redirect(loginUrl({ returnTo }), RedirectType.replace);
}
