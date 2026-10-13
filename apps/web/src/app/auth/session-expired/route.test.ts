import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route.ts';

const USER = {
  id: '7f3c2b1a-1111-4222-8333-444455556666',
  email: 'aroha.ngata@example.com',
  fullName: 'Aroha Ngata',
  sex: 'FEMALE',
  role: 'PLAYER',
};

function call(returnTo: string | null, cookie?: string) {
  const url = new URL('http://localhost:3000/auth/session-expired');
  if (returnTo !== null) url.searchParams.set('returnTo', returnTo);
  return GET(new NextRequest(url, { headers: cookie ? { cookie } : {} }));
}

function stubMe(status: number) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(
      status === 200
        ? Response.json({ user: USER })
        : Response.json({ error: { code: 'session_expired', message: 'x' } }, { status }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /auth/session-expired (X14: only a confirmed-dead session cookie is deleted)', () => {
  it('deletes the cookie and lands on /login with the session-expired notice when /auth/me answers 401', async () => {
    const fetchMock = stubMe(401);
    const response = await call('/account', 'sgm_session=dead-token');
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?notice=session_expired&returnTo=%2Faccount',
    );
    const cleared = response.cookies.get('sgm_session');
    expect(cleared?.value).toBe('');
    expect(response.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe(
      'Bearer dead-token',
    );
  });

  it('keeps a live session cookie and just redirects to returnTo (a cross-site GET cannot sign anyone out)', async () => {
    stubMe(200);
    const response = await call('/account', 'sgm_session=live-token');
    expect(response.headers.get('location')).toBe('http://localhost:3000/account');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('does not delete anything when the API is unreachable, and never redirects off-site', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    const down = await call('/account', 'sgm_session=live-token');
    expect(down.headers.get('set-cookie')).toBeNull();
    stubMe(401);
    const evil = await call('https://evil.example/', 'sgm_session=dead-token');
    expect(evil.headers.get('location')).toBe('http://localhost:3000/login?notice=session_expired');
  });

  it('with no cookie goes straight to /login without calling the API', async () => {
    const fetchMock = stubMe(401);
    const response = await call('/account');
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?notice=session_expired&returnTo=%2Faccount',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
