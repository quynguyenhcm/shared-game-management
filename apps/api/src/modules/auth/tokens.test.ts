import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OAUTH_STATE_PATTERN, encodeOAuthBinding, parseOAuthBinding } from '@sgm/shared';
import { hashToken, newToken } from './tokens.ts';

describe('tokens (AC-VERIFY-2)', () => {
  it('generates 256-bit base64url tokens that never repeat', () => {
    const tokens = Array.from({ length: 200 }, () => newToken().raw);
    expect(new Set(tokens).size).toBe(200);
    for (const raw of tokens) {
      expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(raw, 'base64url')).toHaveLength(32);
    }
  });

  it('stores only the SHA-256 digest, derived from the raw token alone', () => {
    const { raw, hash } = newToken();
    expect(hash).toHaveLength(32);
    expect(hash.equals(createHash('sha256').update(raw).digest())).toBe(true);
    expect(hashToken(raw).equals(hash)).toBe(true);
    expect(hash.toString('base64url')).not.toBe(raw);
  });

  it('produces OAuth states the shared sgm_oauth codec accepts (interop, AC-VERIFY-15)', () => {
    const { raw } = newToken();
    expect(raw).toMatch(OAUTH_STATE_PATTERN);
    const parsed = parseOAuthBinding(
      encodeOAuthBinding(raw, { returnTo: '/account', intent: 'signin' }),
    );
    expect(parsed).toMatchObject({ ok: true, state: raw });
  });
});
