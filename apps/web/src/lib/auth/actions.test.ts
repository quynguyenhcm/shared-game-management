import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  sets: [] as { name: string; value: string; options: Record<string, unknown> }[],
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

const { forgotPasswordAction, loginAction, registerAction, resetPasswordAction, signOutAction } =
  await import('./actions.ts');

const USER = {
  id: '7f3c2b1a-1111-4222-8333-444455556666',
  email: 'aroha.ngata@example.com',
  fullName: 'Aroha Ngata',
  sex: 'FEMALE',
  role: 'PLAYER',
};
const SESSION = { token: 'new-session-token', expiresAt: '2030-01-01T00:00:00.000Z' };

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(
      status === 204 ? new Response(null, { status }) : Response.json(body, { status, headers }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
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

beforeEach(() => {
  mocks.jar.clear();
  mocks.sets.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loginAction', () => {
  const credentials = { email: 'aroha.ngata@example.com', password: 'kowhai-court-27' };

  it('sets the session cookie and redirects to a validated returnTo, replacing history (AC-ENTRY-7)', async () => {
    stubFetch(200, { user: USER, session: SESSION });
    const target = await redirectOf(
      loginAction({}, form({ ...credentials, returnTo: '/account' })),
    );
    expect(target).toBe('/account:replace');
    expect(mocks.sets[0]).toMatchObject({
      name: 'sgm_session',
      value: 'new-session-token',
      options: { httpOnly: true, sameSite: 'lax', path: '/' },
    });
  });

  it.each([
    'https://evil.example/',
    '//evil.example',
    '/\\evil.example',
    '/login',
    '/auth/callback/google',
  ])('lands on / when returnTo is %s (AC-ERROR-13)', async (returnTo) => {
    stubFetch(200, { user: USER, session: SESSION });
    await expect(redirectOf(loginAction({}, form({ ...credentials, returnTo })))).resolves.toBe(
      '/:replace',
    );
  });

  it('presents an existing session so the API can replace it', async () => {
    mocks.jar.set('sgm_session', 'old-token');
    const fetchMock = stubFetch(200, { user: USER, session: SESSION });
    await redirectOf(loginAction({}, form(credentials)));
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe(
      'Bearer old-token',
    );
  });

  it('keeps the email, never echoes the password, and reports 401 invalid_credentials (AC-ERROR-3)', async () => {
    stubFetch(401, {
      error: { code: 'invalid_credentials', message: 'Incorrect email or password.' },
    });
    const state = await loginAction({}, form({ ...credentials, returnTo: '/account' }));
    expect(state.error).toEqual({ code: 'invalid_credentials' });
    expect(state.values).toEqual({ email: credentials.email });
    expect(JSON.stringify(state)).not.toContain(credentials.password);
    expect(mocks.sets).toHaveLength(0);
  });

  it('passes Retry-After through on a 429 (AC-ERROR-4)', async () => {
    stubFetch(
      429,
      { error: { code: 'too_many_attempts', message: 'x' } },
      { 'retry-after': '600' },
    );
    const state = await loginAction({}, form(credentials));
    expect(state.error).toEqual({ code: 'too_many_attempts', retryAfterSeconds: 600 });
  });

  it('blocks a malformed email before calling the API (X10)', async () => {
    const fetchMock = stubFetch(200, {});
    const state = await loginAction({}, form({ email: 'aroha@gmail', password: 'x' }));
    expect(state.fieldErrors).toEqual({ email: ['Enter a valid email address.'] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('survives an unreachable API with the generic banner and kept email (AC-ERROR-18)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    const state = await loginAction({}, form(credentials));
    expect(state.error?.code).toBe('service_unavailable');
    expect(state.values?.email).toBe(credentials.email);
  });
});

describe('registerAction', () => {
  const fields = {
    fullName: 'Aroha Ngata',
    email: 'Aroha.Ngata@Example.com',
    password: 'kowhai-court-27',
    sex: 'FEMALE',
  };

  it('does not call the API without a sex and keeps the other fields (AC-ENTRY-3)', async () => {
    const fetchMock = stubFetch(201, {});
    const withoutSex = {
      fullName: fields.fullName,
      email: fields.email,
      password: fields.password,
    };
    const state = await registerAction({}, form(withoutSex));
    expect(state.fieldErrors).toEqual({ sex: ['Select your sex to continue.'] });
    expect(state.values).toEqual({ fullName: 'Aroha Ngata', email: fields.email });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates the session and lands on returnTo with the one-time welcome notice (AC-HAPPY-1)', async () => {
    const fetchMock = stubFetch(201, { user: USER, session: SESSION });
    const target = await redirectOf(registerAction({}, form({ ...fields, returnTo: '/account' })));
    expect(target).toBe('/account?notice=welcome:replace');
    expect(mocks.sets[0]?.name).toBe('sgm_session');
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      fullName: 'Aroha Ngata',
      email: 'aroha.ngata@example.com',
      password: 'kowhai-court-27',
      sex: 'FEMALE',
    });
  });

  it('keeps name, email and sex but clears the password on a duplicate email (AC-ERROR-1)', async () => {
    stubFetch(409, { error: { code: 'email_taken', message: 'x' } });
    const state = await registerAction({}, form(fields));
    expect(state.error).toEqual({ code: 'email_taken' });
    expect(state.values).toEqual({ fullName: 'Aroha Ngata', email: fields.email, sex: 'FEMALE' });
  });

  it('maps API fieldErrors from a 422 onto the form', async () => {
    stubFetch(422, {
      error: {
        code: 'validation_failed',
        message: 'x',
        fieldErrors: {
          password: ['This password is too common or too easy to guess. Choose a different one.'],
        },
      },
    });
    const state = await registerAction({}, form(fields));
    expect(state.fieldErrors?.password?.[0]).toMatch(/too common/);
  });
});

describe('forgotPasswordAction and resetPasswordAction', () => {
  it('shows the sent state for any valid email, echoing the typed address (AC-ASYNC-1)', async () => {
    stubFetch(202, { accepted: true });
    const state = await forgotPasswordAction({}, form({ email: 'Nobody@Example.com' }));
    expect(state.sent).toEqual({ email: 'Nobody@Example.com' });
  });

  it('rejects a syntactically invalid forgot email in the web (X10)', async () => {
    const fetchMock = stubFetch(202, { accepted: true });
    const state = await forgotPasswordAction({}, form({ email: 'aroha@gmail' }));
    expect(state.fieldErrors?.email).toEqual(['Enter a valid email address.']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes this browser's session cookie and lands on /login after a reset, naming removed providers (AC-HAPPY-6)", async () => {
    mocks.jar.set('sgm_session', 'old');
    stubFetch(200, { removedProviders: ['FACEBOOK'] });
    const target = await redirectOf(
      resetPasswordAction({}, form({ token: 'reset-token', password: 'a-brand-new-password' })),
    );
    expect(target).toBe(
      '/login?notice=password_updated&removed=FACEBOOK&returnTo=%2Faccount:replace',
    );
    expect(mocks.sets.at(-1)).toMatchObject({
      name: 'sgm_session',
      value: '',
      options: { maxAge: 0 },
    });
  });

  it('keeps the token usable on a weak password (422) and reports a dead link (400)', async () => {
    stubFetch(422, {
      error: {
        code: 'validation_failed',
        message: 'x',
        fieldErrors: { password: ['Use at least 10 characters.'] },
      },
    });
    const weak = await resetPasswordAction({}, form({ token: 't', password: 'short' }));
    expect(weak.fieldErrors?.password).toEqual(['Use at least 10 characters.']);
    stubFetch(400, { error: { code: 'invalid_or_expired_token', message: 'x' } });
    const dead = await resetPasswordAction(
      {},
      form({ token: 't', password: 'a-brand-new-password' }),
    );
    expect(dead.error).toEqual({ code: 'invalid_or_expired_token' });
    expect(JSON.stringify(dead)).not.toContain('a-brand-new-password');
  });
});

describe('signOutAction (AC-HAPPY-13)', () => {
  it('lands on /login?notice=signed_out and deletes the cookie after a successful logout', async () => {
    mocks.jar.set('sgm_session', 'live');
    const fetchMock = stubFetch(204, null);
    const target = await redirectOf(signOutAction());
    expect(target).toBe('/login?notice=signed_out:replace');
    expect(mocks.jar.has('sgm_session')).toBe(false);
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe(
      'Bearer live',
    );
  });

  it('lands on /login and deletes the cookie even when the API is unreachable', async () => {
    mocks.jar.set('sgm_session', 'live');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    const target = await redirectOf(signOutAction());
    expect(target).toBe('/login?notice=signed_out:replace');
    expect(mocks.jar.has('sgm_session')).toBe(false);
  });

  it('lands on /login with no cookie at all, without calling the API', async () => {
    const fetchMock = stubFetch(204, null);
    await expect(redirectOf(signOutAction())).resolves.toBe('/login?notice=signed_out:replace');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
