import { createHash, randomBytes } from 'node:crypto';

/** PKCE verifier (RFC 7636): 32 random bytes as base64url = 43 characters. */
export function newCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** S256 challenge: base64url(SHA-256(verifier)). */
export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** OIDC nonce bound into the ID token. */
export function newNonce(): string {
  return randomBytes(16).toString('base64url');
}
