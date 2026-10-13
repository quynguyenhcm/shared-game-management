import { describe, expect, it } from 'vitest';
import { RETURN_TO_MAX_LENGTH, safeReturnTo } from './return-to.ts';

describe('safeReturnTo', () => {
  it('keeps a same-origin path with its query', () => {
    expect(safeReturnTo('/account')).toBe('/account');
    expect(safeReturnTo('/teams/42/sessions?week=3')).toBe('/teams/42/sessions?week=3');
    expect(safeReturnTo('/')).toBe('/');
  });

  it('falls back to / for missing, empty or non-path values', () => {
    for (const raw of [
      undefined,
      null,
      '',
      'account',
      'https://evil.example/',
      'javascript:alert(1)',
    ]) {
      expect(safeReturnTo(raw), String(raw)).toBe('/');
    }
  });

  it('rejects open-redirect shapes: protocol-relative, backslash, encoded and control characters', () => {
    for (const raw of [
      '//evil.example',
      '/\\evil.example',
      '/\\/evil.example',
      '/%2Fevil.example',
      '/%5Cevil.example',
      '/ok\nSet-Cookie: x=1',
      '/ok\u0000',
      '/%0d%0aSet-Cookie',
      '/%E0%A4%A',
    ]) {
      expect(safeReturnTo(raw), raw).toBe('/');
    }
  });

  it('rejects dot-segment inputs that normalise to a protocol-relative URL', () => {
    for (const raw of [
      '/.//evil.example',
      '/a/..//evil.example',
      '/%2e//evil.example',
      '/..//evil.example',
      '/a/./\\x',
    ]) {
      expect(safeReturnTo(raw), raw).toBe('/');
    }
  });

  it('maps auth pages and everything under /auth/ to / (loop prevention)', () => {
    for (const raw of [
      '/login',
      '/login?returnTo=%2Faccount',
      '/register',
      '/register/complete',
      '/forgot-password',
      '/reset-password?token=abc',
      '/auth/callback/google',
      '/auth',
      '/Login',
      '/login/',
      '/a/../login',
      '/%6Cogin',
    ]) {
      expect(safeReturnTo(raw), raw).toBe('/');
    }
    expect(safeReturnTo('/registered-teams')).toBe('/registered-teams');
    expect(safeReturnTo('/authors')).toBe('/authors');
  });

  it('rejects values longer than the 512-character storage limit', () => {
    expect(safeReturnTo(`/${'a'.repeat(RETURN_TO_MAX_LENGTH - 1)}`)).toHaveLength(
      RETURN_TO_MAX_LENGTH,
    );
    expect(safeReturnTo(`/${'a'.repeat(RETURN_TO_MAX_LENGTH)}`)).toBe('/');
  });
});
