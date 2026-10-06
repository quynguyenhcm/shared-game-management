import { createHash, randomBytes } from 'node:crypto';

/**
 * Session and reset tokens: 32 random bytes (256 bits) as base64url, stored only as their SHA-256 digest.
 * A plain digest is enough because a 256-bit random value cannot be brute-forced back from a leaked hash.
 * Raw tokens exist only in a response body or an email; never put one in a log field, error or span.
 */
export interface NewToken {
  readonly raw: string;
  readonly hash: Buffer;
}

export function hashToken(raw: string): Buffer {
  return createHash('sha256').update(raw).digest();
}

export function newToken(): NewToken {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashToken(raw) };
}
