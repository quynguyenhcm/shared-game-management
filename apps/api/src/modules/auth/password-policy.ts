/**
 * Password policy for a password being SET (register, reset), algorithm S2-b: NFKC, 10 to 128 code points,
 * no composition rules, and refusal of common passwords and of the email or its local part. Never applied at
 * sign-in. The length bounds also exist in the shared zod schema (`NewPasswordInput`); they are repeated
 * here so the policy is correct when called on its own (reset flow, tests).
 */
import { readFileSync } from 'node:fs';
import { FIELD_MESSAGES, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@sgm/shared';

/** A set of lowercased, NFKC-normalised passwords. A later HIBP adapter can implement this interface. */
export interface PasswordBlocklist {
  has(candidate: string): boolean;
}

export type PasswordVerdict =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

/** Entries of the bundled list: trimmed, lowercased, NFKC-folded; comments and blank lines dropped. */
export function parseCommonPasswords(text: string): Set<string> {
  const entries = new Set<string>();
  for (const line of text.split('\n')) {
    const entry = line.trim();
    if (entry === '' || entry.startsWith('#')) continue;
    entries.add(entry.normalize('NFKC').toLowerCase());
  }
  return entries;
}

let bundled: PasswordBlocklist | undefined;

/**
 * The blocklist from `text`, or the bundled `common-passwords.txt` (loaded once per process; next to this
 * file in source and copied beside the bundle by the build, see tsup.config.ts).
 */
export function createCommonPasswordBlocklist(text?: string): PasswordBlocklist {
  if (text !== undefined) return parseCommonPasswords(text);
  bundled ??= parseCommonPasswords(
    readFileSync(new URL('./common-passwords.txt', import.meta.url), 'utf8'),
  );
  return bundled;
}

export function checkPasswordForSet(
  password: string,
  email: string,
  blocklist: PasswordBlocklist,
): PasswordVerdict {
  const normalised = password.normalize('NFKC');
  const length = [...normalised].length;
  if (length < PASSWORD_MIN_LENGTH) return { ok: false, message: FIELD_MESSAGES.passwordTooShort };
  if (length > PASSWORD_MAX_LENGTH) return { ok: false, message: FIELD_MESSAGES.passwordTooLong };
  const lowered = normalised.toLowerCase();
  const localPart = email.split('@')[0] ?? email;
  if (blocklist.has(lowered) || lowered === email || lowered === localPart) {
    return { ok: false, message: FIELD_MESSAGES.passwordCommon };
  }
  return { ok: true };
}
