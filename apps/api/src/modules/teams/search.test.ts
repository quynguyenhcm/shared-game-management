/** Find a team search term handling (AC-HAPPY-3, AC-VERIFY-4): wildcards typed by the user are literal. */
import { decodeFindCursor, encodeFindCursor } from '@sgm/shared';
import { describe, expect, it } from 'vitest';
import { containsPattern, escapeLikePattern } from './search.ts';

describe('escapeLikePattern', () => {
  it('escapes the backslash first, then % and _, so nothing the user types is a wildcard', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%');
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
    expect(escapeLikePattern('back\\slash')).toBe('back\\\\slash');
    expect(escapeLikePattern('\\%_')).toBe('\\\\\\%\\_');
    expect(escapeLikePattern('plain text')).toBe('plain text');
  });
});

describe('containsPattern', () => {
  it('wraps the escaped term for a substring match', () => {
    expect(containsPattern('bad_min%')).toBe('%bad\\_min\\%%');
  });
});

describe('Find cursor with a long non-ASCII name (Phase 1 follow-up)', () => {
  it('round-trips a 100-character non-ASCII lower(name) inside the cursor length limit', () => {
    const name = 'Ōtāhuhu Ñandú 羽毛球'.repeat(5).slice(0, 100);
    expect([...name].length).toBeLessThanOrEqual(100);
    const payload = {
      v: 1 as const,
      n: name.toLowerCase(),
      i: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      d: 'f' as const,
    };
    const cursor = encodeFindCursor(payload);
    expect(cursor.length).toBeLessThanOrEqual(700);
    expect(decodeFindCursor(cursor)).toEqual(payload);
  });
});
