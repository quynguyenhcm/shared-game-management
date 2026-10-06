import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIELD_MESSAGES } from '@sgm/shared';
import {
  checkPasswordForSet,
  createCommonPasswordBlocklist,
  parseCommonPasswords,
} from './password-policy.ts';

const blocklist = createCommonPasswordBlocklist('# header\n\nPassword123456\nqwertyuiop12\n');
const email = 'aroha.ngata@example.com';

describe('checkPasswordForSet', () => {
  it('accepts 10 and 128 code points (astral characters count once) and rejects 9 and 129', () => {
    expect(checkPasswordForSet('a1b2c3d4e5', email, blocklist)).toEqual({ ok: true });
    expect(checkPasswordForSet('😀'.repeat(10), email, blocklist)).toEqual({ ok: true });
    expect(checkPasswordForSet('x9'.repeat(64), email, blocklist)).toEqual({ ok: true });
    expect(checkPasswordForSet('a1b2c3d4e', email, blocklist)).toEqual({
      ok: false,
      message: FIELD_MESSAGES.passwordTooShort,
    });
    expect(checkPasswordForSet('😀'.repeat(9), email, blocklist)).toMatchObject({ ok: false });
    expect(checkPasswordForSet('x'.repeat(129), email, blocklist)).toEqual({
      ok: false,
      message: FIELD_MESSAGES.passwordTooLong,
    });
  });

  it('rejects common passwords case-insensitively and after NFKC folding', () => {
    for (const candidate of ['password123456', 'PASSWORD123456', 'ｑｗｅｒｔｙｕｉｏｐ１２']) {
      expect(checkPasswordForSet(candidate, email, blocklist)).toEqual({
        ok: false,
        message: FIELD_MESSAGES.passwordCommon,
      });
    }
  });

  it('rejects a password equal to the email or its local part', () => {
    expect(checkPasswordForSet(email, email, blocklist)).toMatchObject({ ok: false });
    expect(checkPasswordForSet('Aroha.Ngata', email, blocklist)).toEqual({
      ok: false,
      message: FIELD_MESSAGES.passwordCommon,
    });
    expect(checkPasswordForSet('aroha.ngata2', email, blocklist)).toEqual({ ok: true });
  });
});

describe('common-password list', () => {
  it('ignores comments and blanks and lowercases entries', () => {
    const parsed = parseCommonPasswords('# c\n\n  Hello-World-12 \nabc\n');
    expect([...parsed]).toEqual(['hello-world-12', 'abc']);
  });

  it('ships a bundled list with a source and licence header and only policy-length entries', () => {
    const text = readFileSync(new URL('./common-passwords.txt', import.meta.url), 'utf8');
    expect(text.split('\n')[0]).toMatch(/^#/);
    expect(text).toMatch(/Source:/);
    expect(text).toMatch(/Licen[cs]e:/);
    const entries = parseCommonPasswords(text);
    expect(entries.size).toBeGreaterThan(100);
    for (const entry of entries) {
      expect([...entry].length).toBeGreaterThanOrEqual(10);
      expect([...entry].length).toBeLessThanOrEqual(128);
    }
    expect(createCommonPasswordBlocklist().has('password123')).toBe(true);
  });
});
