import { describe, expect, it } from 'vitest';
import { POST } from './route.ts';

describe('POST /auth/clear-flash (the login page deletes sgm_flash once it has read it)', () => {
  it('answers 204 with no-store and expires the HttpOnly flash cookie', () => {
    const response = POST();
    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const cookie = response.headers.getSetCookie()[0] ?? '';
    expect(cookie).toMatch(/^sgm_flash=;/);
    expect(cookie).toMatch(/Max-Age=0/i);
    expect(cookie).toMatch(/HttpOnly/i);
  });
});
