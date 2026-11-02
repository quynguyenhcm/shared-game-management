/** Fixed Akahu integration constants (architecture "Configuration Variables"; code, not environment). */

export const CREATE_TIMEOUT_MS = 8_000;
export const READ_TIMEOUT_MS = 5_000;
export const KEY_FETCH_TIMEOUT_MS = 3_000;
export const KEY_CACHE_TTL_MS = 24 * 3_600_000;
export const NEGATIVE_KEY_CACHE_TTL_MS = 10 * 60_000;
export const KEY_FETCH_CAP_PER_MINUTE = 6;
export const KEY_CACHE_POSITIVE_MAX = 32;
export const KEY_CACHE_NEGATIVE_MAX = 256;
export const SYNC_THROTTLE_MS = 5_000;
export const READ_429_MAX_RETRIES = 2;

/** Webhook request body cap (`POST /webhooks/akahu`). */
export const WEBHOOK_BODY_LIMIT_BYTES = 16 * 1024;

/** Lower-case header names as Node exposes them. */
export const SIGNATURE_HEADER = 'x-akahu-payments-signature';
export const SIGNING_KEY_HEADER = 'x-akahu-payments-signing-key';

/** A signing key id is interpolated into a URL path, so it is validated before any use. */
export const SIGNING_KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Base64 signature: decoded 64 to 1024 bytes covers RSA 512 to 8192 bits. */
export const SIGNATURE_MIN_BYTES = 64;
export const SIGNATURE_MAX_BYTES = 1024;

export const PAYEE_NAME_MIN_LENGTH = 2;
export const PAYEE_NAME_MAX_LENGTH = 70;

export const DEFAULT_PAYMENTS_API_URL = 'https://api.payments.akahu.io';
