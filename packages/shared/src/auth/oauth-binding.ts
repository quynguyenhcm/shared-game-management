/**
 * The `sgm_oauth` browser-binding cookie (architecture Q6, "the one schema"). Value: `<state>.<ctx>`.
 *  - `state`: the raw OAuth state from the API's `authorize` (43 base64url characters, no `.`).
 *  - `ctx`: base64url (no padding) of UTF-8 JSON `{ v: 1, r: <returnTo>, i: 'signin' | 'link' }`.
 * Only the state component is ever compared with the callback's query `state` (constant time). `ctx` is not
 * authenticated: `r` is re-validated with `safeReturnTo` and `i` is a hint for the error landing only; the
 * server-side `oauth_states` row decides what a callback does. The codec uses no Node API, so the web server
 * and the API tests share it.
 */
import { z } from 'zod';
import { RETURN_TO_MAX_LENGTH, safeReturnTo } from './return-to.ts';

/** 32 random bytes as base64url (43 characters); contains no `.`. */
export const OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** The whole cookie value is rejected above this size before any decoding. */
export const OAUTH_BINDING_MAX_BYTES = 1024;

export type OAuthIntent = 'signin' | 'link';

export interface OAuthBindingContext {
  readonly returnTo: string;
  readonly intent: OAuthIntent;
}

export type OAuthBindingParse =
  | { readonly ok: true; readonly state: string; readonly ctx: OAuthBindingContext }
  | {
      readonly ok: false;
      readonly reason: 'missing' | 'oversized' | 'malformed';
      /** Present when the state component was well-formed (the landing may still use it). */
      readonly state?: string;
      /** Present when `ctx` itself parsed even though the binding failed; already sanitised. */
      readonly ctx?: OAuthBindingContext;
    };

const CtxSchema = z.strictObject({
  v: z.literal(1),
  r: z.string().max(RETURN_TO_MAX_LENGTH),
  i: z.enum(['signin', 'link']),
});

const BASE64URL = /^[A-Za-z0-9_-]*$/;

function utf8ToBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlToUtf8(value: string): string | null {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return null;
  try {
    const padded =
      value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The cookie value for a flow the API just started. `returnTo` is sanitised on the way in. */
export function encodeOAuthBinding(
  state: string,
  ctx: { returnTo?: string | null | undefined; intent: OAuthIntent },
): string {
  if (!OAUTH_STATE_PATTERN.test(state))
    throw new RangeError('state does not match OAUTH_STATE_PATTERN');
  const json = JSON.stringify({ v: 1, r: safeReturnTo(ctx.returnTo), i: ctx.intent });
  const value = `${state}.${utf8ToBase64Url(json)}`;
  if (value.length > OAUTH_BINDING_MAX_BYTES) throw new RangeError('binding value too large');
  return value;
}

/** Parses the cookie value. Never throws; a failure says why and keeps whatever sanitised context parsed. */
export function parseOAuthBinding(raw: string | null | undefined): OAuthBindingParse {
  if (raw === null || raw === undefined || raw === '') return { ok: false, reason: 'missing' };
  if (raw.length > OAUTH_BINDING_MAX_BYTES) return { ok: false, reason: 'oversized' };
  const parts = raw.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [state = '', encoded = ''] = parts;
  if (!OAUTH_STATE_PATTERN.test(state)) return { ok: false, reason: 'malformed' };
  const json = base64UrlToUtf8(encoded);
  if (json === null) return { ok: false, reason: 'malformed', state };
  let candidate: unknown;
  try {
    candidate = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'malformed', state };
  }
  const parsed = CtxSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, reason: 'malformed', state };
  return {
    ok: true,
    state,
    ctx: { returnTo: safeReturnTo(parsed.data.r), intent: parsed.data.i },
  };
}

/**
 * Constant-time equality of two strings: always walks the longer length, so neither a mismatch position nor a
 * length difference shortens the work. Both operands are short ASCII here (state values).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return diff === 0;
}

/**
 * Does the callback's query `state` match the cookie's state component? Only the state component is compared
 * (never `ctx`); a query state that is not shaped like a state is a mismatch without comparing.
 */
export function bindingMatchesState(
  binding: OAuthBindingParse,
  queryState: string | null | undefined,
): boolean {
  if (!binding.ok) return false;
  if (typeof queryState !== 'string' || !OAUTH_STATE_PATTERN.test(queryState)) return false;
  return constantTimeEqual(binding.state, queryState);
}
