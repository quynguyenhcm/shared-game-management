import { describe, expect, it } from 'vitest';
import { cookieName, cookieSpec, expiredCookieSpec } from './cookies.ts';

const HTTPS = 'https://games.example.nz';
const HTTP = 'http://localhost:3000';

describe('cookie names and flags follow the WEB_BASE_URL scheme, not NODE_ENV (AC-VERIFY-2)', () => {
  it('uses __Host- names and Secure when WEB_BASE_URL is https', () => {
    expect(cookieName('session', HTTPS)).toBe('__Host-sgm_session');
    expect(cookieName('oauth', HTTPS)).toBe('__Host-sgm_oauth');
    expect(cookieName('pending', HTTPS)).toBe('__Host-sgm_pending');
    expect(cookieName('flash', HTTPS)).toBe('__Host-sgm_flash');
    const spec = cookieSpec('session', HTTPS, {
      value: 'tok',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(spec.name).toBe('__Host-sgm_session');
    expect(spec.options).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: true,
      expires: new Date('2030-01-01T00:00:00.000Z'),
    });
    expect(spec.options).not.toHaveProperty('domain');
  });

  it('uses plain names and no Secure flag over http (the Compose E2E stack)', () => {
    expect(cookieName('session', HTTP)).toBe('sgm_session');
    const spec = cookieSpec('session', HTTP, {
      value: 'tok',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(spec.options).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: false,
    });
  });

  it('gives the short-lived cookies their Max-Age (oauth 600, pending 900, flash 60) and no Expires', () => {
    expect(cookieSpec('oauth', HTTP, { value: 'x' }).options.maxAge).toBe(600);
    expect(cookieSpec('pending', HTTP, { value: 'x' }).options.maxAge).toBe(900);
    expect(cookieSpec('flash', HTTP, { value: 'x' }).options.maxAge).toBe(60);
    expect(cookieSpec('flash', HTTP, { value: 'x' }).options).not.toHaveProperty('expires');
  });

  it('expires a cookie with the same name, path and Secure flag so the browser actually drops it', () => {
    const spec = expiredCookieSpec('session', HTTPS);
    expect(spec).toMatchObject({ name: '__Host-sgm_session', value: '' });
    expect(spec.options).toMatchObject({ path: '/', secure: true, maxAge: 0, httpOnly: true });
    expect(spec.options.expires).toEqual(new Date(0));
  });
});
