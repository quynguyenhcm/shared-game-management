import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { config, proxy } from './proxy.ts';

function request(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(new URL(path, 'http://localhost:3000'), init);
}

describe('proxy.ts (Next 16 file convention; runs before every page)', () => {
  it('redirects a protected path without a session cookie to /login with returnTo (AC-ENTRY-4)', () => {
    const response = proxy(request('/account?tab=methods'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?returnTo=%2Faccount%3Ftab%3Dmethods',
    );
  });

  it('lets a protected path through when a session cookie exists (the real check is requireUser)', () => {
    const response = proxy(request('/account', { headers: { cookie: 'sgm_session=anything' } }));
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('strips incoming x-sgm-client-ip and x-sgm-internal-auth request headers (AC-VERIFY-14)', () => {
    const response = proxy(
      request('/', {
        headers: {
          'x-sgm-client-ip': '6.6.6.6',
          'x-sgm-internal-auth': 'forged',
          'x-forwarded-for': '203.0.113.9',
        },
      }),
    );
    const overridden = response.headers.get('x-middleware-override-headers') ?? '';
    expect(overridden).not.toContain('x-sgm-client-ip');
    expect(overridden).not.toContain('x-sgm-internal-auth');
    expect(overridden).toContain('x-forwarded-for');
  });

  it('refuses a mutating request from a foreign Origin with 403 and allows the app origin (AC-ERROR-15)', () => {
    const foreign = proxy(
      request('/login', { method: 'POST', headers: { origin: 'https://evil.example' } }),
    );
    expect(foreign.status).toBe(403);
    const own = proxy(
      request('/login', { method: 'POST', headers: { origin: 'http://localhost:3000' } }),
    );
    expect(own.status).not.toBe(403);
    const noOrigin = proxy(request('/login', { method: 'POST' }));
    expect(noOrigin.status).not.toBe(403);
    const getWithForeignOrigin = proxy(
      request('/login', { headers: { origin: 'https://evil.example' } }),
    );
    expect(getWithForeignOrigin.status).not.toBe(403);
  });

  it('sets no-referrer and no-store on /reset-password so the token never leaks (AC-VERIFY-2)', () => {
    const response = proxy(request('/reset-password?token=abc'));
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('marks auth pages no-store so Back never shows a stale form, and leaves other pages alone', () => {
    for (const path of ['/login', '/register', '/forgot-password', '/account']) {
      const response = proxy(request(path, { headers: { cookie: 'sgm_session=x' } }));
      expect(response.headers.get('cache-control'), path).toContain('no-store');
    }
    expect(proxy(request('/')).headers.get('cache-control')).toBeNull();
    expect(proxy(request('/login')).headers.get('referrer-policy')).toBeNull();
  });

  it('lets the OAuth callback GET through from a provider Origin, marks it no-store and no-referrer, and covers /register/complete', () => {
    const callback = proxy(
      request('/auth/callback/google?state=s&code=c', {
        headers: { origin: 'https://accounts.google.com' },
      }),
    );
    expect(callback.status).not.toBe(403);
    expect(callback.headers.get('location')).toBeNull();
    expect(callback.headers.get('cache-control')).toContain('no-store');
    expect(callback.headers.get('referrer-policy')).toBe('no-referrer');
    expect(proxy(request('/register/complete')).headers.get('cache-control')).toContain('no-store');
    const flashClear = proxy(
      request('/auth/clear-flash', { method: 'POST', headers: { origin: 'https://evil.example' } }),
    );
    expect(flashClear.status).toBe(403);
  });

  it('matches pages but not static assets', () => {
    expect(config.matcher).toEqual(['/((?!_next/static|_next/image|favicon.ico).*)']);
  });
});
