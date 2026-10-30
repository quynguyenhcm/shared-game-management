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

  describe('team pages (AC-ENTRY-3, AC-ENTRY-4)', () => {
    const TEAM_ID = '7f3c2b1a-1111-4222-8333-444455556666';
    const CODE = 'Zk3hQ9mXw2Lr8TfVb1NcY7uPaE4sJd6GoI0yHtKqRnA';
    const withCookie = { headers: { cookie: 'sgm_session=x' } };

    it.each([
      ['/teams', '%2Fteams'],
      ['/teams/new', '%2Fteams%2Fnew'],
      [`/teams/${TEAM_ID}/manage`, `%2Fteams%2F${TEAM_ID}%2Fmanage`],
    ])('redirects anonymous %s to /login with returnTo', (path, encoded) => {
      const response = proxy(request(path));
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe(
        `http://localhost:3000/login?returnTo=${encoded}`,
      );
    });

    it('keeps the invite code in returnTo through the sign-in redirect', () => {
      const response = proxy(request(`/teams/join?code=${CODE}`));
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe(
        `http://localhost:3000/login?returnTo=${encodeURIComponent(`/teams/join?code=${CODE}`)}`,
      );
    });

    it('leaves the public pages (Find, a team page, a non-UUID manage path) unprotected', () => {
      for (const path of [
        '/teams/find',
        '/teams/find?q=bad',
        `/teams/${TEAM_ID}`,
        '/teams/x/manage',
      ]) {
        const response = proxy(request(path));
        expect(response.headers.get('location'), path).toBeNull();
      }
    });

    it('protects the banking page: anonymous callers go to /login with the full path (and edit/returnTo) kept', () => {
      const path = `/teams/${TEAM_ID}/manage/banking`;
      const response = proxy(request(path));
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe(
        `http://localhost:3000/login?returnTo=${encodeURIComponent(path)}`,
      );
      const withQuery = proxy(request(`${path}?edit=banking`));
      expect(withQuery.headers.get('location')).toBe(
        `http://localhost:3000/login?returnTo=${encodeURIComponent(`${path}?edit=banking`)}`,
      );
    });

    it('marks the banking page no-store (banking details are personal information) and sets no referrer override', () => {
      for (const path of [
        `/teams/${TEAM_ID}/manage/banking`,
        `/teams/${TEAM_ID}/manage/banking?notice=banking_saved`,
      ]) {
        const response = proxy(request(path, withCookie));
        expect(response.headers.get('location'), path).toBeNull();
        expect(response.headers.get('cache-control'), path).toContain('no-store');
      }
    });

    it('marks the invite page no-store and no-referrer so the code never leaks (AC-ENTRY-4)', () => {
      const response = proxy(request(`/teams/join?code=${CODE}`, withCookie));
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    });

    it('marks the manage page (it embeds the invite code), My teams and Create no-store', () => {
      for (const path of [`/teams/${TEAM_ID}/manage`, '/teams', '/teams/new']) {
        const response = proxy(request(path, withCookie));
        expect(response.headers.get('cache-control'), path).toContain('no-store');
        expect(response.headers.get('referrer-policy'), path).toBeNull();
      }
    });

    it('does not make the public team pages uncacheable or change their referrer policy', () => {
      for (const path of ['/teams/find', `/teams/${TEAM_ID}`]) {
        const response = proxy(request(path));
        expect(response.headers.get('cache-control'), path).toBeNull();
        expect(response.headers.get('referrer-policy'), path).toBeNull();
      }
    });
  });

  describe('player session page (AC-ENTRY-1, AC-ENTRY-2, UI/UX 12)', () => {
    const TEAM_ID = '7f3c2b1a-1111-4222-8333-444455556666';
    const SESSION_ID = '11111111-1111-4111-8111-111111111111';
    const PAGE = `/teams/${TEAM_ID}/sessions/${SESSION_ID}`;
    const withCookie = { headers: { cookie: 'sgm_session=x' } };

    it('redirects anonymous callers to /login with the page as returnTo (and keeps a query)', () => {
      const response = proxy(request(PAGE));
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe(
        `http://localhost:3000/login?returnTo=${encodeURIComponent(PAGE)}`,
      );
      const withQuery = proxy(request(`${PAGE}?notice=x`));
      expect(withQuery.headers.get('location')).toBe(
        `http://localhost:3000/login?returnTo=${encodeURIComponent(`${PAGE}?notice=x`)}`,
      );
    });

    it('lets a caller with a session cookie through and marks the page no-store (it shows their guests)', () => {
      const response = proxy(request(PAGE, withCookie));
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('cache-control')).toContain('no-store');
    });

    it('does not protect a non-UUID session id, the team page itself, or a path that only looks like it', () => {
      for (const path of [
        `/teams/${TEAM_ID}/sessions/x`,
        `/teams/x/sessions/${SESSION_ID}`,
        `/teams/${TEAM_ID}/sessions`,
        `/teams/${TEAM_ID}`,
        `/teams/${TEAM_ID}/sessionsX/${SESSION_ID}`,
      ]) {
        const response = proxy(request(path));
        expect(response.headers.get('location'), path).toBeNull();
        expect(response.headers.get('cache-control'), path).toBeNull();
      }
    });

    it('the admin pages stay protected by their own rule under /manage/sessions', () => {
      const response = proxy(request(`/teams/${TEAM_ID}/manage/sessions/${SESSION_ID}`));
      expect(response.status).toBe(307);
    });
  });

  it('matches pages but not static assets', () => {
    expect(config.matcher).toEqual(['/((?!_next/static|_next/image|favicon.ico).*)']);
  });
});
