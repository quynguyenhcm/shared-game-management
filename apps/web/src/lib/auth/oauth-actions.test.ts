import { parseOAuthBinding } from '@sgm/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  sets: [] as { name: string; value: string; options: Record<string, unknown> }[],
  revalidated: [] as [string, string | undefined][],
}));

vi.mock('next/cache', () => ({
  revalidatePath: (path: string, type?: string) => {
    mocks.revalidated.push([path, type]);
  },
}));

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        mocks.jar.has(name) ? { name, value: mocks.jar.get(name) } : undefined,
      set: (name: string, value: string, options: Record<string, unknown>) => {
        mocks.sets.push({ name, value, options });
        if (value === '') mocks.jar.delete(name);
        else mocks.jar.set(name, value);
      },
    }),
  headers: () => Promise.resolve(new Headers({ 'user-agent': 'TestAgent/1.0' })),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string, type?: string) => {
    throw new Error(`REDIRECT:${url}:${type ?? 'push'}`);
  },
  RedirectType: { replace: 'replace', push: 'push' },
}));

const {
  chooseDifferentAccountAction,
  completeSignupAction,
  connectProviderAction,
  disconnectProviderAction,
  startOAuthAction,
} = await import('./actions.ts');

const STATE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const USER = {
  id: '7f3c2b1a-1111-4222-8333-444455556666',
  email: 'aroha.ngata@example.com',
  fullName: 'Aroha Ngata',
  sex: 'FEMALE',
  role: 'PLAYER',
};
const SESSION = { token: 'new-session-token', expiresAt: '2030-01-01T00:00:00.000Z' };
const AUTHORIZE = { authorizationUrl: 'https://accounts.example/o/authorize?x=1', state: STATE };

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

interface Stubbed {
  status: number;
  body: unknown;
}

function stubApi(routes: Record<string, Stubbed>) {
  const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
    const route = routes[new URL(url).pathname];
    if (route === undefined) return Promise.reject(new Error(`unexpected call ${url}`));
    return Promise.resolve(
      route.status === 204
        ? new Response(null, { status: 204 })
        : Response.json(route.body, { status: route.status }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    paths: (): string[] => fetchMock.mock.calls.map(([url]) => new URL(url).pathname),
    bodyOf: (index = 0): unknown => JSON.parse(fetchMock.mock.calls[index]?.[1]?.body as string),
  };
}

const apiError = (status: number, code: string, extra: Record<string, unknown> = {}): Stubbed => ({
  status,
  body: { error: { code, message: 'x', ...extra } },
});

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const message = (error as Error).message;
    if (message.startsWith('REDIRECT:')) return message.slice('REDIRECT:'.length);
    throw error;
  }
  throw new Error('expected a redirect');
}

beforeEach(() => {
  mocks.jar.clear();
  mocks.sets.length = 0;
  mocks.revalidated.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startOAuthAction (AC-HAPPY-3/4, AC-ERROR-9, AC-ERROR-10)', () => {
  it('stores the binding cookie from the shared codec and redirects to the provider (AC-VERIFY-15)', async () => {
    const api = stubApi({ '/auth/oauth/google/authorize': { status: 200, body: AUTHORIZE } });
    const target = await redirectOf(
      startOAuthAction({}, form({ provider: 'google', returnTo: '/account' })),
    );
    expect(target).toBe('https://accounts.example/o/authorize?x=1:push');
    const cookie = mocks.sets.find((set) => set.name === 'sgm_oauth');
    expect(cookie?.options).toMatchObject({ httpOnly: true, sameSite: 'lax', maxAge: 600 });
    expect(parseOAuthBinding(cookie?.value)).toEqual({
      ok: true,
      state: STATE,
      ctx: { returnTo: '/account', intent: 'signin' },
    });
    expect(api.bodyOf()).toEqual({ returnTo: '/account' });
  });

  it('passes rerequest for Facebook only ("Try Facebook again")', async () => {
    const api = stubApi({
      '/auth/oauth/facebook/authorize': { status: 200, body: AUTHORIZE },
      '/auth/oauth/google/authorize': { status: 200, body: AUTHORIZE },
    });
    await redirectOf(
      startOAuthAction({}, form({ provider: 'facebook', rerequest: 'true', returnTo: '/' })),
    );
    expect(api.bodyOf(0)).toEqual({ returnTo: '/', rerequest: true });
    await redirectOf(startOAuthAction({}, form({ provider: 'google', rerequest: 'true' })));
    expect(api.bodyOf(1)).not.toHaveProperty('rerequest');
  });

  it('reports a disabled provider or an outage in place, with no cookie and no redirect', async () => {
    stubApi({ '/auth/oauth/google/authorize': apiError(404, 'provider_not_enabled') });
    const disabled = await startOAuthAction({}, form({ provider: 'google' }));
    expect(disabled.error).toEqual({ code: 'provider_not_enabled' });
    expect(disabled.values).toEqual({ provider: 'google' });
    expect(mocks.sets).toHaveLength(0);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    const down = await startOAuthAction({}, form({ provider: 'google' }));
    expect(down.error?.code).toBe('service_unavailable');
  });

  it('refuses a provider that is not google or facebook without calling the API', async () => {
    const api = stubApi({});
    const state = await startOAuthAction({}, form({ provider: 'twitter' }));
    expect(state.error?.code).toBe('provider_not_enabled');
    expect(api.fetchMock).not.toHaveBeenCalled();
  });
});

describe('connectProviderAction and disconnectProviderAction (AC-HAPPY-11/12)', () => {
  it('starts a link with the session bearer, binds with intent link and returns to /account afterwards', async () => {
    mocks.jar.set('sgm_session', 'live-token');
    const api = stubApi({ '/auth/identities/google/link': { status: 200, body: AUTHORIZE } });
    const target = await redirectOf(connectProviderAction(form({ provider: 'google' })));
    expect(target).toBe('https://accounts.example/o/authorize?x=1:push');
    expect(
      (api.fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization,
    ).toBe('Bearer live-token');
    const binding = parseOAuthBinding(mocks.sets.find((set) => set.name === 'sgm_oauth')?.value);
    expect(binding).toMatchObject({ ok: true, ctx: { returnTo: '/account', intent: 'link' } });
  });

  it('sends a dead session through /auth/session-expired and maps other failures to /account codes', async () => {
    mocks.jar.set('sgm_session', 'dead');
    stubApi({ '/auth/identities/google/link': apiError(401, 'session_expired') });
    await expect(redirectOf(connectProviderAction(form({ provider: 'google' })))).resolves.toBe(
      '/auth/session-expired?returnTo=%2Faccount:replace',
    );
    stubApi({ '/auth/identities/google/link': apiError(404, 'provider_not_enabled') });
    await expect(redirectOf(connectProviderAction(form({ provider: 'google' })))).resolves.toBe(
      '/account?error=provider_not_enabled&provider=google:replace',
    );
    stubApi({ '/auth/identities/google/link': apiError(503, 'service_unavailable') });
    await expect(redirectOf(connectProviderAction(form({ provider: 'google' })))).resolves.toBe(
      '/account?error=service_unavailable&provider=google:replace',
    );
  });

  it('disconnects and lands on /account with the unlinked notice; the last method is refused (AC-HAPPY-12)', async () => {
    mocks.jar.set('sgm_session', 'live-token');
    stubApi({ '/auth/identities/google': { status: 204, body: null } });
    await expect(redirectOf(disconnectProviderAction(form({ provider: 'google' })))).resolves.toBe(
      '/account?notice=unlinked&provider=google:replace',
    );
    stubApi({ '/auth/identities/google': apiError(409, 'last_sign_in_method') });
    await expect(redirectOf(disconnectProviderAction(form({ provider: 'google' })))).resolves.toBe(
      '/account?error=last_sign_in_method:replace',
    );
  });
});

describe('completeSignupAction (AC-HAPPY-3/4, AC-ERROR-14, AC-ENTRY-8)', () => {
  const fields = {
    fullName: 'Aroha Ngata',
    sex: 'FEMALE',
    returnTo: '/account',
    provider: 'google',
  };

  it('treats a missing sgm_pending as expired: /login?error=signup_expired, no API call (AC-ERROR-14)', async () => {
    const api = stubApi({});
    await expect(redirectOf(completeSignupAction({}, form(fields)))).resolves.toBe(
      '/login?error=signup_expired:replace',
    );
    expect(api.fetchMock).not.toHaveBeenCalled();
  });

  it('sends a browser that is already signed in (finished in another tab) to returnTo instead (AC-ENTRY-8)', async () => {
    mocks.jar.set('sgm_session', 'live-token');
    stubApi({ '/auth/me': { status: 200, body: { user: USER } } });
    await expect(redirectOf(completeSignupAction({}, form(fields)))).resolves.toBe(
      '/account:replace',
    );
    // The tab never set a cookie, so Next would reuse its cached signed-out layout (header) after the
    // redirect: the action must invalidate the layout so the header shows the signed-in state.
    expect(mocks.revalidated).toContainEqual(['/', 'layout']);
  });

  it('blocks a missing sex before the API and keeps the name (AC-ENTRY-3 pattern)', async () => {
    mocks.jar.set('sgm_pending', 'pending-secret');
    const api = stubApi({});
    const state = await completeSignupAction({}, form({ fullName: 'Aroha Ngata', returnTo: '/' }));
    expect(state.fieldErrors).toEqual({ sex: ['Select your sex to continue.'] });
    expect(state.values?.fullName).toBe('Aroha Ngata');
    expect(api.fetchMock).not.toHaveBeenCalled();
    expect(mocks.jar.get('sgm_pending')).toBe('pending-secret');
  });

  it('creates the account (201): session cookie, pending cleared, welcome notice on returnTo', async () => {
    mocks.jar.set('sgm_pending', 'pending-secret');
    const api = stubApi({
      '/auth/oauth/complete': {
        status: 201,
        body: { user: USER, session: SESSION, returnTo: '/account' },
      },
    });
    await expect(redirectOf(completeSignupAction({}, form(fields)))).resolves.toBe(
      '/account?notice=welcome:replace',
    );
    expect(api.bodyOf()).toEqual({
      pendingToken: 'pending-secret',
      fullName: 'Aroha Ngata',
      sex: 'FEMALE',
    });
    expect(mocks.jar.get('sgm_session')).toBe('new-session-token');
    expect(mocks.jar.has('sgm_pending')).toBe(false);
  });

  it('signs in without a welcome when the account already existed (200)', async () => {
    mocks.jar.set('sgm_pending', 'pending-secret');
    stubApi({
      '/auth/oauth/complete': {
        status: 200,
        body: { user: USER, session: SESSION, returnTo: '/' },
      },
    });
    await expect(redirectOf(completeSignupAction({}, form(fields)))).resolves.toBe('/:replace');
  });

  it('keeps the pending sign-up on a 422 and clears it on an expired (400) or conflicting (409) one', async () => {
    mocks.jar.set('sgm_pending', 'pending-secret');
    stubApi({
      '/auth/oauth/complete': {
        status: 422,
        body: {
          error: {
            code: 'validation_failed',
            message: 'x',
            fieldErrors: { fullName: ['Enter your name.'] },
          },
        },
      },
    });
    const invalid = await completeSignupAction({}, form(fields));
    expect(invalid.fieldErrors).toEqual({ fullName: ['Enter your name.'] });
    expect(mocks.jar.has('sgm_pending')).toBe(true);

    stubApi({ '/auth/oauth/complete': apiError(400, 'signup_expired') });
    await expect(redirectOf(completeSignupAction({}, form(fields)))).resolves.toBe(
      '/login?error=signup_expired:replace',
    );
    expect(mocks.jar.has('sgm_pending')).toBe(false);

    mocks.jar.set('sgm_pending', 'pending-secret');
    stubApi({
      '/auth/oauth/complete': apiError(409, 'oauth_account_exists', { email: USER.email }),
    });
    await expect(redirectOf(completeSignupAction({}, form(fields)))).resolves.toBe(
      '/login?error=oauth_account_exists&provider=google&returnTo=%2Faccount:replace',
    );
    expect(mocks.jar.get('sgm_flash')).toBe(USER.email);
    expect(mocks.jar.has('sgm_pending')).toBe(false);
  });

  it('"Use a different account" clears sgm_pending and returns to /login without an API call', async () => {
    mocks.jar.set('sgm_pending', 'pending-secret');
    const api = stubApi({});
    await expect(redirectOf(chooseDifferentAccountAction(form({})))).resolves.toBe(
      '/login:replace',
    );
    expect(mocks.jar.has('sgm_pending')).toBe(false);
    expect(api.fetchMock).not.toHaveBeenCalled();
  });
});
