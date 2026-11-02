/**
 * Akahu Payments webhook signature (A4): RSA-SHA256 over the raw request bytes, base64 signature in
 * `X-Akahu-Payments-Signature`, key id in `X-Akahu-Payments-Signing-Key`. Pure functions; key lookup is `key-cache.ts`.
 * The padding scheme (PKCS#1 v1.5 assumed) is confirmed by MVE-005 before Phase 4.
 */
import { verify, type KeyObject } from 'node:crypto';
import { SIGNATURE_MAX_BYTES, SIGNATURE_MIN_BYTES, SIGNING_KEY_ID_PATTERN } from './constants.ts';

export type SignatureHeaderResult =
  | { readonly ok: true; readonly keyId: string; readonly signature: Buffer }
  | {
      readonly ok: false;
      readonly reason: 'missing_header' | 'bad_key_id' | 'bad_signature_format';
    };

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Validates both header values (step 1 of the webhook order of checks). Values are `unknown`: Node may give arrays. */
export function parseSignatureHeaders(signature: unknown, keyId: unknown): SignatureHeaderResult {
  if (signature === undefined || keyId === undefined)
    return { ok: false, reason: 'missing_header' };
  if (typeof keyId !== 'string' || !SIGNING_KEY_ID_PATTERN.test(keyId)) {
    return { ok: false, reason: 'bad_key_id' };
  }
  if (typeof signature !== 'string' || signature.length > 2048 || !BASE64.test(signature)) {
    return { ok: false, reason: 'bad_signature_format' };
  }
  const bytes = Buffer.from(signature, 'base64');
  if (bytes.length < SIGNATURE_MIN_BYTES || bytes.length > SIGNATURE_MAX_BYTES) {
    return { ok: false, reason: 'bad_signature_format' };
  }
  return { ok: true, keyId, signature: bytes };
}

/** True only when `signature` is a valid RSA-SHA256 signature of exactly `rawBody` under `key`. Never throws. */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signature: Buffer,
  key: KeyObject,
): boolean {
  try {
    return verify('sha256', rawBody, key, signature);
  } catch {
    return false;
  }
}
