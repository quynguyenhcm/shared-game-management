import { safeReturnTo } from '@sgm/shared';
import type { AuthIntent } from './messages.ts';

/**
 * Pure mapping from outcomes and error codes to redirect URLs, so the landings are unit-tested once.
 * Notices and errors are codes in the query string, never text or emails. Every `returnTo` that leaves
 * this module has been through `safeReturnTo`, and `/` (the default) is omitted.
 */

type Params = Record<string, string | null | undefined>;

export function buildUrl(path: string, params: Params): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(name, value);
  }
  const text = query.toString();
  return text === '' ? path : `${path}?${text}`;
}

/** `returnTo` for a URL: validated, and `undefined` when it is just `/`. */
function carriedReturnTo(raw: string | null | undefined): string | undefined {
  const target = safeReturnTo(raw);
  return target === '/' ? undefined : target;
}

export interface LoginUrlOptions {
  returnTo?: string | null;
  notice?: string;
  error?: string;
  provider?: string | null;
  removed?: string | null;
}

export function loginUrl(options: LoginUrlOptions = {}): string {
  return buildUrl('/login', {
    notice: options.notice,
    error: options.error,
    provider: options.provider,
    removed: options.removed,
    returnTo: carriedReturnTo(options.returnTo),
  });
}

export function registerUrl(options: { returnTo?: string | null } = {}): string {
  return buildUrl('/register', { returnTo: carriedReturnTo(options.returnTo) });
}

export function forgotPasswordUrl(options: { returnTo?: string | null } = {}): string {
  return buildUrl('/forgot-password', { returnTo: carriedReturnTo(options.returnTo) });
}

/** Where a protected page sends a dead session cookie; the handler there decides what to delete. */
export function sessionExpiredUrl(returnTo: string): string {
  return buildUrl('/auth/session-expired', { returnTo: safeReturnTo(returnTo) });
}

export function sessionExpiredLanding(returnTo: string | null | undefined): string {
  return loginUrl({ notice: 'session_expired', returnTo });
}

export const SIGNED_OUT_URL = loginUrl({ notice: 'signed_out' });

/** After a completed reset. Removed providers send the user to `/account` to reconnect them (R1). */
export function passwordResetLanding(removedProviders: readonly string[]): string {
  if (removedProviders.length === 0) return loginUrl({ notice: 'password_updated' });
  return loginUrl({
    notice: 'password_updated',
    removed: removedProviders.join(','),
    returnTo: '/account',
  });
}

/** Adds the one-time `welcome` notice to a post-registration destination. */
export function withWelcome(target: string): string {
  return `${target}${target.includes('?') ? '&' : '?'}notice=welcome`;
}

export interface OAuthErrorLanding {
  code: string;
  provider: string;
  intent: AuthIntent;
  returnTo: string | null | undefined;
}

/**
 * The error landing table (user journey F3 and F8). Sign-in errors keep the original `returnTo`; the
 * email conflict always returns to `/account` (X5); link errors land on `/account`, except a session
 * problem, which needs a sign-in first. The conflicting email travels in `sgm_flash`, never the URL.
 */
export function oauthErrorLanding(landing: OAuthErrorLanding): string {
  const { code, provider, intent, returnTo } = landing;
  if (code === 'oauth_account_exists' || code === 'link_session_mismatch') {
    return loginUrl({ error: code, provider, returnTo: '/account' });
  }
  if (intent === 'link') return buildUrl('/account', { error: code, provider });
  return loginUrl({ error: code, provider, returnTo });
}

export interface ErrorLink {
  label: string;
  href: string;
}

/** Recovery links shown under an error banner (the "Actions" column of the copy deck). */
export function errorLinks(code: string, returnTo: string | null | undefined): ErrorLink[] {
  switch (code) {
    case 'email_taken':
      return [
        { label: 'Sign in instead', href: loginUrl({ returnTo }) },
        { label: 'Reset your password', href: forgotPasswordUrl({ returnTo }) },
      ];
    case 'too_many_attempts':
      return [{ label: 'Reset your password', href: forgotPasswordUrl({ returnTo }) }];
    case 'invalid_or_expired_token':
      return [
        { label: 'Request a new link', href: forgotPasswordUrl({ returnTo }) },
        { label: 'Back to sign in', href: loginUrl({ returnTo }) },
      ];
    case 'oauth_account_exists':
      return [
        { label: 'Sign in', href: loginUrl({ returnTo: '/account' }) },
        { label: 'Forgot your password?', href: forgotPasswordUrl({ returnTo: '/account' }) },
      ];
    default:
      return [];
  }
}
