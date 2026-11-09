/**
 * Pure payee-name normaliser (architecture Q1a). The charset below is an ASSUMPTION from the spike digests:
 * to be re-read from the live Akahu documentation at the Phase 4 gate (A7). A name that cannot be normalised is a
 * local `payee_unusable` refusal: no Akahu call is made.
 */
import { PAYEE_NAME_MAX_LENGTH, PAYEE_NAME_MIN_LENGTH } from './constants.ts';

export type PayeeNameResult =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly reason: 'payee_unusable' };

const COMBINING_MARKS = /\p{M}/gu;
const DISALLOWED = /[^A-Za-z0-9 .,'&/()-]/g;
const WHITESPACE = /\s+/g;

export function normalisePayeeName(raw: string): PayeeNameResult {
  const cleaned = raw
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(WHITESPACE, ' ')
    .replace(DISALLOWED, '')
    .replace(WHITESPACE, ' ')
    .trim()
    .slice(0, PAYEE_NAME_MAX_LENGTH)
    .trim();
  if (cleaned.length < PAYEE_NAME_MIN_LENGTH || !/[A-Za-z0-9]/.test(cleaned)) {
    return { ok: false, reason: 'payee_unusable' };
  }
  return { ok: true, name: cleaned };
}
