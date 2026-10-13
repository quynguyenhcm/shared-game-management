import { describe, expect, it } from 'vitest';
import { EMAIL_MAX_LENGTH, normaliseEmail } from './email.ts';

describe('normaliseEmail', () => {
  it('trims, NFC-normalises and lowercases an ASCII address', () => {
    expect(normaliseEmail('  Aroha.Ngata@Example.COM ')).toBe('aroha.ngata@example.com');
    expect(normaliseEmail('a+tag@sub.example.co.nz')).toBe('a+tag@sub.example.co.nz');
  });

  it('converts an internationalised domain to lowercase punycode and keeps a macron .nz domain usable', () => {
    expect(normaliseEmail('user@Münich.example')).toBe('user@xn--mnich-kva.example');
    expect(normaliseEmail('kia@māori.nz')).toBe('kia@xn--mori-qsa.nz');
  });

  it('rejects a non-ASCII local part, whitespace and a missing or empty side of the @', () => {
    for (const raw of [
      'jürgen@example.com',
      'a b@example.com',
      'plain',
      '@example.com',
      'user@',
      '',
      '   ',
      'user@@example.com',
      'user@example',
      '.user@example.com',
      'us..er@example.com',
      'user@-bad.example.com',
      'user@exa_mple.com',
      'user@example.123',
    ]) {
      expect(normaliseEmail(raw), raw).toBeNull();
    }
  });

  it('splits at the last @ and rejects an @ left in the local part', () => {
    expect(normaliseEmail('a@b@example.com')).toBeNull();
  });

  it('accepts exactly 254 characters and rejects 255', () => {
    const domain = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;
    const at254 = `${'a'.repeat(64)}@${domain}`;
    expect(at254).toHaveLength(EMAIL_MAX_LENGTH);
    expect(normaliseEmail(at254)).toBe(at254);
    expect(normaliseEmail(`${at254}x`)).toBeNull();
    expect(normaliseEmail(`${'a'.repeat(65)}@${domain.slice(0, -1)}`)).toBeNull();
  });

  it('is idempotent and always yields the database normal form', () => {
    const once = normaliseEmail('Some.One+Tag@EXAMPLE.org');
    expect(once).not.toBeNull();
    expect(normaliseEmail(once ?? '')).toBe(once);
    expect(once).toMatch(/^[!-?A-~]+@[!-?A-~]+$/);
    expect(once).toBe(once?.toLowerCase());
  });
});
