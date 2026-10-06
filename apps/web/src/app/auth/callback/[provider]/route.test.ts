import { encodeOAuthBinding } from '@sgm/shared';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route.ts';

const STATE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const OTHER_STATE = 'ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvutsrqponmlkj';
const BASE = 'http://localhost:3000';
const USER = {
  id: '7f3c2b1a-1111-4222-8333-444455556666',
  email: 'aroha.ngata@example.com',
  fullName: 'Aroha Ngata',
  sex: 'FEMALE',
  role: 'PLAYER',
};
const SESSION = { token: 'new-session-token', expiresAt: '2030-01-01T00:00:00.000Z' };

interface Stubbed {
  status: number;
  body: unknown;
}

/** Routes the stubbed API by path; anything unlisted is a test failure (404 with a marker body). */
function stubApi(routes: Record<string, Stubbed>) {
  const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
    const path = new URL(url).pathname;
    const route = routes[path];
    if (route === undefined) return Promise.reject(new Error(`unexpected API call ${path}`));
    return Promise.resolve(Response.json(route.body, { status: route.status }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const pathsCalled = (): string[] => fetchMock.mock.calls.map(([url]) => new URL(url).pathname);
  return { fetchMock, pathsCalled };
}

const error = (code: string, extra: Record<string, unknown> = {}): Stubbed => ({
  status: 409,
  body: { error: { code, message: 'x', ...extra } },
});

interface CallOptions {
  provider?: string;
  query?: Record<string, string>;
  binding?: string | null;
  session?: string;
}

async function call(options: CallOptions = {}) {
  const { provider = 'google', query = { state: STATE, code: 'auth-code' } } = options;
  const binding =
    options.binding === undefined
      ? encodeOAuthBinding(STATE, { returnTo: '/account', intent: 'signin' })
      : options.binding;
  const url = new URL(`${BASE}/auth/callback/${provider}`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const cookie = [
    binding === null ? null : `sgm_oauth=${binding}`,
    options.session === undefined ? null : `sgm_session=${options.session}`,
  ]
    .filter((part) => part !== null)
    .join('; ');
  return GET(new NextRequest(url, { headers: cookie === '' ? {} : { cookie } }), {
    params: Promise.resolve({ provider }),
  });
}

function setCookieOf(response: Response, name: string): string {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`)) ?? '';
}

function cookieClearedOf(response: Response, name: string): boolean {
  return (
    /^[^=]+=;/.test(setCookieOf(response, name)) && /Max-Age=0/i.test(setCookieOf(response, name))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /auth/callback/[provider]: the browser binding (AC-VERIFY-15)', () => {
  const GOOD_CTX_BINDING = encodeOAuthBinding(STATE, { returnTo: '/account', intent: 'signin' });

  it.each([
    ['a missing cookie', null, STATE, '/login?error=oauth_state_invalid&provider=google'],
    [
      'a state component that differs from the query state (valid ctx keeps its returnTo)',
      encodeOAuthBinding(OTHER_STATE, { returnTo: '/account', intent: 'signin' }),
      STATE,
      '/login?error=oauth_state_invalid&provider=google&returnTo=%2Faccount',
    ],
    [
      'a malformed value',
      'not-a-binding',
      STATE,
      '/login?error=oauth_state_invalid&provider=google',
    ],
    [
      'an oversized value',
      `${STATE}.${'A'.repeat(1100)}`,
      STATE,
      '/login?error=oauth_state_invalid&provider=google',
    ],
    [
      'a query state that is not shaped like a state',
      GOOD_CTX_BINDING,
      'short',
      '/login?error=oauth_state_invalid&provider=google&returnTo=%2Faccount',
    ],
    [
      'an unparseable ctx',
      `${STATE}.%%%`,
      STATE,
      '/login?error=oauth_state_invalid&provider=google',
    ],
  ])(
    'lands on the invalid-state error without calling the API for %s',
    async (_name, binding, state, landing) => {
      const { fetchMock } = stubApi({});
      const response = await call({ binding, query: { state, code: 'auth-code' } });
      expect(response.headers.get('location')).toBe(`${BASE}${landing}`);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(cookieClearedOf(response, 'sgm_oauth')).toBe(true);
    },
  );

  it('sends a signed-in browser replaying a used callback to / silently (AC-ENTRY-8)', async () => {
    const { pathsCalled } = stubApi({ '/auth/me': { status: 200, body: { user: USER } } });
    const response = await call({ binding: null, session: 'live-token' });
    expect(response.headers.get('location')).toBe(`${BASE}/`);
    expect(pathsCalled()).toEqual(['/auth/me']);
    expect(cookieClearedOf(response, 'sgm_oauth')).toBe(true);
  });

  it('shows the error to a browser whose session cookie is dead', async () => {
    stubApi({
      '/auth/me': { status: 401, body: { error: { code: 'session_expired', message: 'x' } } },
    });
    const response = await call({ binding: null, session: 'dead-token' });
    expect(response.headers.get('location')).toBe(
      `${BASE}/login?error=oauth_state_invalid&provider=google`,
    );
  });

  it('lets an edited ctx change only the error landing: returnTo is re-validated, intent is a hint', async () => {
    const forged = (ctx: Record<string, unknown>): string =>
      `${STATE}.${Buffer.from(JSON.stringify(ctx)).toString('base64url')}`;
    stubApi({
      '/auth/oauth/google/callback': {
        status: 400,
        body: { error: { code: 'oauth_cancelled', message: 'x' } },
      },
    });
    const evilReturn = await call({
      binding: forged({ v: 1, r: 'https://evil.example/', i: 'signin' }),
      query: { state: STATE, error: 'access_denied' },
    });
    expect(evilReturn.headers.get('location')).toBe(
      `${BASE}/login?error=oauth_cancelled&provider=google`,
    );
    const asLink = await call({
      binding: forged({ v: 1, r: '/account', i: 'link' }),
      query: { state: STATE, error: 'access_denied' },
    });
    expect(asLink.headers.get('location')).toBe(
      `${BASE}/account?error=oauth_cancelled&provider=google`,
    );
  });
});

describe('GET /auth/callback/[provider]: outcomes (AC-HAPPY-3/5/11, AC-ERROR-7/8/9/10/17/20)', () => {
  it('signs in: sets the session cookie, deletes the binding and replaces to the API returnTo (AC-HAPPY-5)', async () => {
    const { fetchMock } = stubApi({
      '/auth/oauth/google/callback': {
        status: 200,
        body: { outcome: 'signed_in', user: USER, session: SESSION, returnTo: '/account' },
      },
    });
    const response = await call();
    expect(response.headers.get('location')).toBe(`${BASE}/account`);
    expect(response.cookies.get('sgm_session')?.value).toBe('new-session-token');
    expect(setCookieOf(response, 'sgm_session')).toMatch(/HttpOnly/i);
    expect(cookieClearedOf(response, 'sgm_oauth')).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      state: STATE,
      code: 'auth-code',
    });
  });

  it('starts a first-time sign-up: sets sgm_pending for 15 minutes and goes to /register/complete with no query (AC-HAPPY-3)', async () => {
    stubApi({
      '/auth/oauth/google/callback': {
        status: 200,
        body: { outcome: 'pending_signup', pendingToken: 'pending-secret', returnTo: '/account' },
      },
    });
    const response = await call();
    expect(response.headers.get('location')).toBe(`${BASE}/register/complete`);
    const pending = response.cookies.get('sgm_pending');
    expect(pending?.value).toBe('pending-secret');
    expect(setCookieOf(response, 'sgm_pending')).toMatch(/Max-Age=900/i);
    expect(response.headers.get('location')).not.toContain('pending-secret');
  });

  it.each(['linked', 'already_linked'])(
    'forwards the bearer for a connect flow and lands on /account with the %s notice (AC-HAPPY-11, AC-ERROR-17)',
    async (outcome) => {
      const { fetchMock } = stubApi({
        '/auth/oauth/facebook/callback': { status: 200, body: { outcome, returnTo: '/account' } },
      });
      const response = await call({
        provider: 'facebook',
        binding: encodeOAuthBinding(STATE, { returnTo: '/account', intent: 'link' }),
        session: 'live-token',
      });
      expect(response.headers.get('location')).toBe(
        `${BASE}/account?notice=${outcome}&provider=facebook`,
      );
      expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe(
        'Bearer live-token',
      );
    },
  );

  it('keeps the email out of the URL: oauth_account_exists lands on /login for /account and sets a 60 s sgm_flash (AC-ERROR-8, AC-ERROR-20)', async () => {
    stubApi({
      '/auth/oauth/facebook/callback': error('oauth_account_exists', {
        email: 'aroha.ngata@example.com',
      }),
    });
    const response = await call({ provider: 'facebook' });
    const location = response.headers.get('location') ?? '';
    expect(location).toBe(
      `${BASE}/login?error=oauth_account_exists&provider=facebook&returnTo=%2Faccount`,
    );
    expect(location).not.toMatch(/aroha|example|%40|@/);
    expect(response.cookies.get('sgm_flash')?.value).toBe('aroha.ngata@example.com');
    expect(setCookieOf(response, 'sgm_flash')).toMatch(/Max-Age=60/i);
    expect(setCookieOf(response, 'sgm_flash')).toMatch(/HttpOnly/i);
  });

  it.each([
    [
      'cancelled',
      400,
      'oauth_cancelled',
      '/login?error=oauth_cancelled&provider=google&returnTo=%2Faccount',
    ],
    [
      'facebook-style missing email',
      422,
      'oauth_email_missing',
      '/login?error=oauth_email_missing&provider=google&returnTo=%2Faccount',
    ],
    [
      'unverified email',
      422,
      'oauth_email_unverified',
      '/login?error=oauth_email_unverified&provider=google&returnTo=%2Faccount',
    ],
    [
      'a disabled provider',
      404,
      'provider_not_enabled',
      '/login?error=provider_not_enabled&provider=google&returnTo=%2Faccount',
    ],
    [
      'a provider outage',
      502,
      'provider_unavailable',
      '/login?error=provider_unavailable&provider=google&returnTo=%2Faccount',
    ],
    [
      'a used or expired state',
      400,
      'oauth_state_invalid',
      '/login?error=oauth_state_invalid&provider=google&returnTo=%2Faccount',
    ],
  ])(
    'maps %s to a code-only /login landing that keeps returnTo',
    async (_name, status, code, landing) => {
      stubApi({
        '/auth/oauth/google/callback': { status, body: { error: { code, message: 'x' } } },
      });
      const response = await call();
      expect(response.headers.get('location')).toBe(`${BASE}${landing}`);
      expect(response.cookies.get('sgm_session')).toBeUndefined();
    },
  );

  it('sends link errors to /account, and a dead link session to sign-in (AC-ERROR-17)', async () => {
    stubApi({
      '/auth/oauth/google/callback': error('identity_in_use'),
    });
    const inUse = await call({
      binding: encodeOAuthBinding(STATE, { returnTo: '/account', intent: 'signin' }),
      session: 'live-token',
    });
    expect(inUse.headers.get('location')).toBe(
      `${BASE}/account?error=identity_in_use&provider=google`,
    );
    stubApi({
      '/auth/oauth/google/callback': {
        status: 401,
        body: { error: { code: 'session_expired', message: 'x' } },
      },
    });
    const expired = await call({
      binding: encodeOAuthBinding(STATE, { returnTo: '/account', intent: 'link' }),
    });
    expect(expired.headers.get('location')).toBe(
      `${BASE}/login?error=link_session_mismatch&provider=google&returnTo=%2Faccount`,
    );
  });

  it('survives an unreachable API as a provider-unavailable landing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    const response = await call();
    expect(response.headers.get('location')).toBe(
      `${BASE}/login?error=provider_unavailable&provider=google&returnTo=%2Faccount`,
    );
  });

  it('answers 404 for a provider that does not exist, without touching the API', async () => {
    const { fetchMock } = stubApi({});
    const response = await call({ provider: 'twitter' });
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
