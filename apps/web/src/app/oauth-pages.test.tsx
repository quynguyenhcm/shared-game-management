import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  userAgent: 'Mozilla/5.0 (Macintosh) Safari/605.1',
}));

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        mocks.jar.has(name) ? { name, value: mocks.jar.get(name) } : undefined,
      set: () => undefined,
    }),
  headers: () => Promise.resolve(new Headers({ 'user-agent': mocks.userAgent })),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string, type?: string) => {
    throw new Error(`REDIRECT:${url}:${type ?? 'push'}`);
  },
  RedirectType: { replace: 'replace', push: 'push' },
  useSearchParams: () => new URLSearchParams(),
}));

const { default: LoginPage } = await import('./login/page.tsx');
const { default: RegisterPage } = await import('./register/page.tsx');
const { default: CompleteSignupPage } = await import('./register/complete/page.tsx');
const { default: AccountPage } = await import('./account/page.tsx');
const { ClearFlash } = await import('../components/auth/clear-flash.tsx');

const USER = {
  id: '7f3c2b1a-1111-4222-8333-444455556666',
  email: 'aroha.ngata@example.com',
  fullName: 'Aroha Ngata',
  sex: 'FEMALE',
  role: 'PLAYER',
};
const FB_APP_UA = 'Mozilla/5.0 (iPhone) AppleWebKit/605.1 [FBAN/FBIOS;FBAV/450.0]';

function stubApi(routes: Record<string, { status: number; body: unknown }>) {
  const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
    const route = routes[new URL(url).pathname];
    if (route === undefined) return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(Response.json(route.body, { status: route.status }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const PROVIDERS = { '/auth/providers': { status: 200, body: { google: true, facebook: true } } };

function containsType(node: ReactNode, type: unknown): boolean {
  if (Array.isArray(node)) {
    return (node as ReactNode[]).some((child) => containsType(child, type));
  }
  if (!isValidElement(node)) return false;
  const props = node.props as { children?: ReactNode };
  return node.type === type || containsType(props.children, type);
}

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

const search = (params: Record<string, string> = {}) => Promise.resolve(params);

beforeEach(() => {
  mocks.jar.clear();
  mocks.userAgent = 'Mozilla/5.0 (Macintosh) Safari/605.1';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/login and /register: OAuth first (AC-ENTRY-2, AC-VERIFY-12, AC-VERIFY-13, AC-ERROR-18)', () => {
  it('renders the OAuth buttons above the email form on both pages, preserving returnTo', async () => {
    stubApi(PROVIDERS);
    for (const page of [
      renderToStaticMarkup(await LoginPage({ searchParams: search({ returnTo: '/account' }) })),
      renderToStaticMarkup(await RegisterPage({ searchParams: search({ returnTo: '/account' }) })),
    ]) {
      expect(page.indexOf('Continue with Google')).toBeGreaterThan(-1);
      expect(page.indexOf('Continue with Google')).toBeLessThan(page.indexOf('name="email"'));
      expect(page.indexOf('Continue with Facebook')).toBeLessThan(page.indexOf('name="email"'));
      expect(page).toMatch(/<input[^>]*name="returnTo"[^>]*value="\/account"/);
    }
  });

  it('shows the in-app browser hint above the Google button only inside the Facebook or Instagram app', async () => {
    stubApi(PROVIDERS);
    const ordinary = renderToStaticMarkup(await LoginPage({ searchParams: search() }));
    expect(ordinary).not.toContain('Open in browser');
    mocks.userAgent = FB_APP_UA;
    const html = renderToStaticMarkup(await LoginPage({ searchParams: search() }));
    expect(html.indexOf('Open in browser')).toBeGreaterThan(-1);
    expect(html.indexOf('Open in browser')).toBeLessThan(html.indexOf('Continue with Google'));
  });

  it('hides the buttons and says so when the providers call fails, keeping the email form', async () => {
    stubApi({});
    const html = renderToStaticMarkup(await LoginPage({ searchParams: search() }));
    expect(html).toContain('Sign-in is having trouble right now.');
    expect(html).not.toContain('Continue with');
    expect(html).toContain('name="email"');
  });

  it('offers "Try Facebook again" under the missing-email banner (AC-ERROR-9)', async () => {
    stubApi(PROVIDERS);
    const html = renderToStaticMarkup(
      await LoginPage({
        searchParams: search({ error: 'oauth_email_missing', provider: 'facebook' }),
      }),
    );
    expect(html).toContain('Facebook didn&#x27;t share an email address');
    expect(html).toContain('Try Facebook again');
  });

  it('reads the conflict email from sgm_flash and then clears the cookie (AC-ERROR-20, carry-forward)', async () => {
    stubApi(PROVIDERS);
    mocks.jar.set('sgm_flash', 'aroha.ngata@example.com');
    const params = { error: 'oauth_account_exists', provider: 'facebook', returnTo: '/account' };
    const element = await LoginPage({ searchParams: search(params) });
    expect(renderToStaticMarkup(element)).toContain(
      'An account already exists for aroha.ngata@example.com.',
    );
    expect(containsType(element, ClearFlash)).toBe(true);

    mocks.jar.clear();
    const without = await LoginPage({ searchParams: search(params) });
    expect(renderToStaticMarkup(without)).toContain(
      'for the email address on your Facebook account.',
    );
    expect(containsType(without, ClearFlash)).toBe(false);
  });
});

describe('/register/complete page (AC-HAPPY-3, AC-ERROR-14, AC-ENTRY-8)', () => {
  const PENDING = {
    provider: 'GOOGLE',
    email: 'aroha.ngata@example.com',
    fullName: 'Aroha Ngata',
    expiresAt: '2030-01-01T00:00:00.000Z',
    returnTo: '/account',
  };

  it('prefills the form from GET /auth/oauth/pending, sending the handle in a header', async () => {
    mocks.jar.set('sgm_pending', 'pending-secret');
    const fetchMock = stubApi({ '/auth/oauth/pending': { status: 200, body: PENDING } });
    const html = renderToStaticMarkup(await CompleteSignupPage());
    expect(html).toContain('Finish signing up');
    expect(html).toContain('Aroha Ngata');
    expect(html).toMatch(/<input[^>]*name="returnTo"[^>]*value="\/account"/);
    const init = fetchMock.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)['x-pending-signup']).toBe('pending-secret');
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('pending-secret');
  });

  it('sends a missing or expired pending sign-up to /login?error=signup_expired, or on when already signed in', async () => {
    stubApi({});
    await expect(redirectOf(CompleteSignupPage())).resolves.toBe(
      '/login?error=signup_expired:replace',
    );
    mocks.jar.set('sgm_pending', 'old');
    stubApi({
      '/auth/oauth/pending': {
        status: 400,
        body: { error: { code: 'signup_expired', message: 'x' } },
      },
    });
    await expect(redirectOf(CompleteSignupPage())).resolves.toBe(
      '/login?error=signup_expired:replace',
    );
    mocks.jar.set('sgm_session', 'live');
    stubApi({
      '/auth/oauth/pending': {
        status: 400,
        body: { error: { code: 'signup_expired', message: 'x' } },
      },
      '/auth/me': { status: 200, body: { user: USER } },
    });
    await expect(redirectOf(CompleteSignupPage())).resolves.toBe('/:replace');
  });
});

describe('/account page (AC-HAPPY-11/12)', () => {
  it('replaces the stub with the identities from GET /auth/identities', async () => {
    mocks.jar.set('sgm_session', 'live');
    stubApi({
      '/auth/me': { status: 200, body: { user: USER } },
      '/auth/identities': {
        status: 200,
        body: {
          identities: [
            { provider: 'PASSWORD', connectedAt: '2026-10-01T00:00:00.000Z', lastUsedAt: null },
          ],
          enabledProviders: { google: true, facebook: true },
        },
      },
    });
    const html = renderToStaticMarkup(
      await AccountPage({ searchParams: search({ notice: 'linked', provider: 'google' }) }),
    );
    expect(html).toContain('Connect Google');
    expect(html).toContain('Connect Facebook');
    expect(html).toContain('Google connected. You can now sign in with it.');
  });
});
