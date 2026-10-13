import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient, traceHeaders } from './api-client.ts';

const INCOMING = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;

function stubFetch() {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(Response.json({ status: 'ok', db: 'ok', version: '1.0.0' })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentHeaders(fetchMock: ReturnType<typeof stubFetch>): Record<string, string> {
  return (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  // Isolate from a developer's .env: empty means unset for the web config.
  vi.stubEnv('API_INTERNAL_URL', '');
  vi.stubEnv('API_INTERNAL_SHARED_SECRET', '');
  vi.stubEnv('WEB_TRUSTED_PROXY_HOPS', '');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const USER = {
  id: '7f3c2b1a-1111-4222-8333-444455556666',
  email: 'aroha.ngata@example.com',
  fullName: 'Aroha Ngata',
  sex: 'FEMALE',
  role: 'PLAYER',
};
const SECRET = 'internal-secret-for-tests-0123456789abcdef';

function stubJson(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(Response.json(body, { status, headers })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('apiClient auth calls (bearer, internal headers, client address)', () => {
  it('sends the bearer, traceparent, internal secret and a derived client address, and never the incoming internal headers (AC-VERIFY-14)', async () => {
    vi.stubEnv('API_INTERNAL_SHARED_SECRET', SECRET);
    vi.stubEnv('WEB_TRUSTED_PROXY_HOPS', '1');
    const fetchMock = stubJson(200, { user: USER });
    const result = await apiClient.me('session-token', {
      incoming: new Headers({
        traceparent: INCOMING,
        'x-forwarded-for': '6.6.6.6, 203.0.113.9',
        'x-sgm-client-ip': '9.9.9.9',
        'x-sgm-internal-auth': 'forged',
        authorization: 'Bearer stolen',
        cookie: 'sgm_session=stolen',
        'user-agent': 'TestAgent/1.0',
      }),
    });
    expect(result).toMatchObject({ ok: true, data: { user: { fullName: 'Aroha Ngata' } } });
    const headers = sentHeaders(fetchMock);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:4000/auth/me');
    expect(headers.authorization).toBe('Bearer session-token');
    expect(headers['x-sgm-internal-auth']).toBe(SECRET);
    expect(headers['x-sgm-client-ip']).toBe('203.0.113.9');
    expect(headers['user-agent']).toBe('TestAgent/1.0');
    expect(headers.traceparent?.split('-')[1]).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(headers.cookie).toBeUndefined();
    expect(JSON.stringify(headers)).not.toMatch(/forged|stolen|9\.9\.9\.9/);
  });

  it('omits x-sgm-client-ip when no address can be derived and the secret when unconfigured', async () => {
    const fetchMock = stubJson(200, { google: false, facebook: false });
    await apiClient.providers({
      incoming: new Headers({ 'x-forwarded-for': '6.6.6.6', 'x-sgm-client-ip': '9.9.9.9' }),
    });
    const headers = sentHeaders(fetchMock);
    expect(headers['x-sgm-client-ip']).toBeUndefined();
    expect(headers['x-sgm-internal-auth']).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  it('posts JSON bodies and returns a typed error with Retry-After on a 429', async () => {
    const fetchMock = stubJson(
      429,
      { error: { code: 'too_many_attempts', message: 'Too many sign-in attempts.' } },
      { 'retry-after': '840' },
    );
    const result = await apiClient.login({ email: 'a@example.com', password: 'x' });
    expect(result).toEqual({
      ok: false,
      status: 429,
      error: { code: 'too_many_attempts', message: 'Too many sign-in attempts.' },
      retryAfterSeconds: 840,
    });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ email: 'a@example.com', password: 'x' });
    expect(sentHeaders(fetchMock)['content-type']).toBe('application/json');
  });

  it('keeps fieldErrors on a 422', async () => {
    stubJson(422, {
      error: {
        code: 'validation_failed',
        message: 'Invalid',
        fieldErrors: { password: ['Use at least 10 characters.'] },
      },
    });
    const invalid = await apiClient.resetPassword({ token: 't', password: 'short' });
    expect(invalid).toMatchObject({
      ok: false,
      status: 422,
      error: { fieldErrors: { password: ['Use at least 10 characters.'] } },
    });
  });

  it('never throws: network failure, timeout, a 5xx and a non-JSON body all become a service_unavailable or internal_error result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    await expect(apiClient.me('t')).resolves.toMatchObject({
      ok: false,
      status: 0,
      error: { code: 'service_unavailable' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('<html>bad gateway</html>', { status: 502 }))),
    );
    await expect(apiClient.me('t')).resolves.toMatchObject({ ok: false, status: 502 });
    stubJson(200, { unexpected: 'shape' });
    await expect(apiClient.me('t')).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    });
  });
});

describe('apiClient OAuth and identity calls (Phase 5)', () => {
  const AUTHORIZE = { authorizationUrl: 'https://accounts.example/o?x=1', state: 'a'.repeat(43) };

  it('authorize posts the body to the lower-case provider path; callback forwards the bearer', async () => {
    const authorize = stubJson(200, AUTHORIZE);
    const result = await apiClient.oauthAuthorize('google', { returnTo: '/account' });
    expect(result).toMatchObject({ ok: true, data: AUTHORIZE });
    expect(String(authorize.mock.calls[0]?.[0])).toMatch(/\/auth\/oauth\/google\/authorize$/);
    expect(JSON.parse(authorize.mock.calls[0]?.[1]?.body as string)).toEqual({
      returnTo: '/account',
    });
    const callback = stubJson(409, {
      error: { code: 'oauth_account_exists', message: 'x', email: USER.email },
    });
    const failed = await apiClient.oauthCallback(
      'facebook',
      { state: AUTHORIZE.state, code: 'c' },
      { session: 'live-token' },
    );
    expect(failed).toMatchObject({ ok: false, error: { email: USER.email } });
    expect((callback.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe(
      'Bearer live-token',
    );
  });

  it('sends the pending handle only in X-Pending-Signup, and unlink resolves on 204', async () => {
    const pending = stubJson(200, {
      provider: 'GOOGLE',
      email: USER.email,
      fullName: null,
      expiresAt: '2030-01-01T00:00:00.000Z',
      returnTo: '/',
    });
    await expect(apiClient.oauthPending('pending-secret')).resolves.toMatchObject({ ok: true });
    expect(String(pending.mock.calls[0]?.[0])).not.toContain('pending-secret');
    expect(
      (pending.mock.calls[0]?.[1]?.headers as Record<string, string>)['x-pending-signup'],
    ).toBe('pending-secret');
    const unlink = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal('fetch', unlink);
    await expect(apiClient.unlink('google', 'live-token')).resolves.toMatchObject({
      ok: true,
      status: 204,
    });
    expect(unlink.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });
});

describe('apiClient trace propagation (web -> API)', () => {
  it('creates a W3C traceparent when the page has none, so every API call is traceable', async () => {
    const fetchMock = stubFetch();
    await expect(apiClient.health()).resolves.toMatchObject({ status: 'ok' });
    expect(sentHeaders(fetchMock).traceparent).toMatch(TRACEPARENT);
  });

  it('continues the incoming trace: same trace id as the browser/request traceparent', async () => {
    const fetchMock = stubFetch();
    await apiClient.health(new Headers({ traceparent: INCOMING, tracestate: 'a=b' }));
    const headers = sentHeaders(fetchMock);
    expect(headers.traceparent?.split('-')[1]).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(headers.tracestate).toBe('a=b');
  });

  it('ignores a malformed incoming traceparent and starts a fresh trace', () => {
    const headers = traceHeaders(new Headers({ traceparent: 'garbage' }));
    expect(headers.traceparent).toMatch(TRACEPARENT);
    expect(headers.traceparent).not.toBe('garbage');
  });
});
