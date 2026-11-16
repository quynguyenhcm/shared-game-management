import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from './api-client.ts';
import { openBody, openRow, registrationRow, registrationsBody } from './dashboard/fixtures.ts';

const OPTIONS = { session: 'tok' };

function stubJson(status: number, body: unknown) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(Response.json(body, { status })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const url = (fetchMock: ReturnType<typeof stubJson>) => String(fetchMock.mock.calls[0]?.[0]);
const init = (fetchMock: ReturnType<typeof stubJson>) => fetchMock.mock.calls[0]?.[1];

beforeEach(() => {
  vi.stubEnv('API_INTERNAL_URL', '');
  vi.stubEnv('API_INTERNAL_SHARED_SECRET', '');
  vi.stubEnv('WEB_TRUSTED_PROXY_HOPS', '');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('apiClient dashboard reads (player-dashboard)', () => {
  it('openSessions: GET /me/sessions/open with the bearer, parsed with the shared schema, no cursor', async () => {
    const fetchMock = stubJson(200, openBody([openRow()], 2, true));
    const result = await apiClient.openSessions(OPTIONS);
    expect(url(fetchMock)).toBe('http://localhost:4000/me/sessions/open');
    expect(init(fetchMock)?.method).toBe('GET');
    expect((init(fetchMock)?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(result.ok && result.data.overdueCount).toBe(2);
    expect(result.ok && result.data.sessions[0]?.unitFee).toBe('12.00');
  });

  it('myRegistrations: GET /me/registrations with an optional cursor, encoded', async () => {
    const fetchMock = stubJson(200, registrationsBody([registrationRow()], [], 'n/x'));
    const result = await apiClient.myRegistrations({ cursor: 'a b' }, OPTIONS);
    expect(url(fetchMock)).toBe('http://localhost:4000/me/registrations?cursor=a+b');
    expect(result.ok && result.data.nextCursor).toBe('n/x');
    const plain = stubJson(200, registrationsBody([]));
    await apiClient.myRegistrations({}, OPTIONS);
    expect(url(plain)).toBe('http://localhost:4000/me/registrations');
  });

  it('myPaidPayments: GET /payments/me?status=PAID with an optional cursor', async () => {
    const fetchMock = stubJson(200, { teams: [], nextCursor: null });
    await apiClient.myPaidPayments({ cursor: 'c1' }, OPTIONS);
    expect(url(fetchMock)).toBe('http://localhost:4000/payments/me?status=PAID&cursor=c1');
    const plain = stubJson(200, { teams: [], nextCursor: null });
    await apiClient.myPaidPayments({}, OPTIONS);
    expect(url(plain)).toBe('http://localhost:4000/payments/me?status=PAID');
  });

  it('a malformed body is an internal_error, never a half-parsed value; a 422 keeps its status', async () => {
    stubJson(200, { sessions: [{ sessionId: 'x' }] });
    const bad = await apiClient.openSessions(OPTIONS);
    expect(bad.ok).toBe(false);
    stubJson(422, { error: { code: 'validation_failed', message: 'bad cursor' } });
    const refused = await apiClient.myRegistrations({ cursor: 'zzz' }, OPTIONS);
    expect(!refused.ok && refused.status).toBe(422);
  });
});
