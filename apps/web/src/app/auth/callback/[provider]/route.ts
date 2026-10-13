import {
  bindingMatchesState,
  parseOAuthBinding,
  safeReturnTo,
  type OAuthCallbackRequest,
} from '@sgm/shared';
import { type NextRequest, NextResponse } from 'next/server';
import { apiClient, type OAuthProviderPath } from '../../../../lib/api-client.ts';
import { cookieName, cookieSpec, expiredCookieSpec } from '../../../../lib/auth/cookies.ts';
import { buildUrl, oauthErrorLanding } from '../../../../lib/auth/landing.ts';
import { isUrlErrorCode } from '../../../../lib/auth/messages.ts';
import { loadWebConfig } from '../../../../lib/config.ts';
import { log } from '../../../../lib/log.ts';

export const dynamic = 'force-dynamic';

/** Provider error text is never shown; it only needs to fit the API's field limit. */
const PROVIDER_ERROR_MAX = 256;

function providerPath(raw: string): OAuthProviderPath | null {
  return raw === 'google' || raw === 'facebook' ? raw : null;
}

/** An API error code to the code the landing shows; anything unexpected reads as a provider outage. */
function landingCode(code: string): string {
  if (code === 'session_expired' || code === 'unauthenticated') return 'link_session_mismatch';
  const generic = code === 'internal_error' || code === 'service_unavailable';
  return isUrlErrorCode(code) && !generic ? code : 'provider_unavailable';
}

/**
 * The OAuth redirect target (architecture Q6, user journey F3 and F8). The web owns this URL because only
 * the web is reachable from the browser. Order matters:
 *  1. compare the cookie's state component with the query `state` (constant time) BEFORE any API call, so a
 *     login-CSRF callback cannot consume a server-side state;
 *  2. delete `sgm_oauth` on every outcome, so a replayed callback URL finds no cookie;
 *  3. call the API, then map the outcome with `landing.ts`. Only codes travel in URLs; the conflicting email
 *     goes in the 60-second `sgm_flash` cookie.
 * The cookie's `ctx` is untrusted: it can only choose where an error message appears.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const provider = providerPath((await params).provider);
  if (provider === null) return new NextResponse(null, { status: 404 });

  const { webBaseUrl } = loadWebConfig();
  const redirectTo = (target: string): NextResponse => {
    const response = NextResponse.redirect(new URL(target, webBaseUrl));
    response.headers.set('cache-control', 'no-store');
    const expired = expiredCookieSpec('oauth', webBaseUrl);
    response.cookies.set(expired.name, expired.value, expired.options);
    return response;
  };

  const query = request.nextUrl.searchParams;
  const state = query.get('state');
  const bindingCookie = request.cookies.get(cookieName('oauth', webBaseUrl))?.value;
  const binding = parseOAuthBinding(bindingCookie);
  const ctx = binding.ctx;
  const session = request.cookies.get(cookieName('session', webBaseUrl))?.value || null;

  if (!bindingMatchesState(binding, state)) {
    log.warn('web.auth.oauth_binding_failed', {
      provider,
      reason: binding.ok ? 'state_mismatch' : binding.reason,
    });
    // A used callback URL replayed in a signed-in browser (or Back into it) goes home silently. The
    // `link` hint of a cookie that is still there keeps its message, so a lost connect attempt is explained.
    if (session !== null && ctx?.intent !== 'link') {
      const me = await apiClient.me(session, { incoming: request.headers });
      if (me.ok) return redirectTo('/');
    }
    return redirectTo(
      oauthErrorLanding({
        code: 'oauth_state_invalid',
        provider,
        intent: ctx?.intent ?? 'signin',
        returnTo: ctx?.returnTo,
      }),
    );
  }

  const providerError = query.get('error');
  const code = query.get('code');
  let body: OAuthCallbackRequest;
  if (providerError !== null && providerError !== '') {
    body = { state: state ?? '', error: providerError.slice(0, PROVIDER_ERROR_MAX) };
  } else if (code !== null && code !== '') {
    body = { state: state ?? '', code };
  } else {
    // The provider sent neither a code nor an error; nothing to hand to the API.
    return redirectTo(
      oauthErrorLanding({
        code: 'oauth_state_invalid',
        provider,
        intent: ctx?.intent ?? 'signin',
        returnTo: ctx?.returnTo,
      }),
    );
  }

  const result = await apiClient.oauthCallback(provider, body, {
    session,
    incoming: request.headers,
  });

  if (!result.ok) {
    const errorCode = landingCode(result.error.code);
    log.info('web.auth.oauth_callback', { provider, outcome: errorCode, status: result.status });
    // Whatever the cookie says, these two can only be a connect problem.
    const linkOnly = errorCode === 'identity_in_use' || errorCode === 'provider_already_connected';
    const response = redirectTo(
      oauthErrorLanding({
        code: errorCode,
        provider,
        intent: linkOnly ? 'link' : (ctx?.intent ?? 'signin'),
        returnTo: ctx?.returnTo,
      }),
    );
    if (errorCode === 'oauth_account_exists' && result.error.email) {
      const flash = cookieSpec('flash', webBaseUrl, { value: result.error.email });
      response.cookies.set(flash.name, flash.value, flash.options);
    }
    return response;
  }

  const outcome = result.data;
  log.info('web.auth.oauth_callback', {
    provider,
    outcome: outcome.outcome,
    status: result.status,
  });
  switch (outcome.outcome) {
    case 'signed_in': {
      const response = redirectTo(safeReturnTo(outcome.returnTo));
      const spec = cookieSpec('session', webBaseUrl, {
        value: outcome.session.token,
        expiresAt: outcome.session.expiresAt,
      });
      response.cookies.set(spec.name, spec.value, spec.options);
      return response;
    }
    case 'pending_signup': {
      const response = redirectTo('/register/complete');
      const spec = cookieSpec('pending', webBaseUrl, { value: outcome.pendingToken });
      response.cookies.set(spec.name, spec.value, spec.options);
      return response;
    }
    case 'linked':
    case 'already_linked':
      return redirectTo(buildUrl('/account', { notice: outcome.outcome, provider }));
  }
}
