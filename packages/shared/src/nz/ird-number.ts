/**
 * IRD number validation, used for the GST number (IRD: "Your GST number will be the same as your IRD number").
 *
 * Source: Inland Revenue "Payroll Calculations & Business Rules Specification, 1 April 2026 to 31 March 2027" v1.0,
 * s6.1, and "Payday Filing File Upload Specification 2026-27" v1.1, s5.8 (identical steps and range), plus the IRD
 * notice "Increase to IRD number validation upper limit" of 10 Feb 2026 (200,000,000). Review every April.
 *
 * Decision (creative doc Q2, T1): the secondary weights apply only when the primary result is 10. A second 10 is
 * invalid. The s6.1 worked example 150000026 contradicts those steps and is treated as an erratum: it is rejected.
 *
 * Pure and isomorphic. Results carry reason codes only, never a message.
 */

/** Inclusive lower bound: s6.1 "< 10-000-000 ... then the number is invalid". */
export const IRD_NUMBER_MIN = 10_000_000;
/** Inclusive upper bound: s6.1 "> 200-000-000 ... then the number is invalid" (raised from 150,000,000 in 2026). */
export const IRD_NUMBER_MAX = 200_000_000;
/** s6.1 primary weights. */
export const IRD_PRIMARY_WEIGHTS = [3, 2, 7, 6, 5, 4, 3, 2] as const;
/** s6.1 secondary weights, used only when the primary result is 10. */
export const IRD_SECONDARY_WEIGHTS = [7, 4, 3, 2, 5, 2, 7, 6] as const;

export type IrdNumberFailure = 'required' | 'format' | 'range' | 'check_digit';

export type IrdNumberResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: IrdNumberFailure };

const SEPARATORS = /[ \t\-‐-―−]/g;

/** `0` when the remainder is 0, otherwise `11 - remainder` (so 10 is possible). */
function checkDigit(base8: string, weights: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < 8; i += 1) sum += Number(base8[i]) * (weights[i] as number);
  const remainder = sum % 11;
  return remainder === 0 ? 0 : 11 - remainder;
}

/** Canonical form is the digits as a number: no leading zero, 8 or 9 digits. */
export function parseIrdNumber(input: string): IrdNumberResult {
  const text = input.trim();
  if (text === '') return { ok: false, reason: 'required' };
  const digits = text.replace(SEPARATORS, '');
  if (!/^[0-9]{8,9}$/.test(digits)) return { ok: false, reason: 'format' };

  const value = Number(digits);
  if (value < IRD_NUMBER_MIN || value > IRD_NUMBER_MAX) return { ok: false, reason: 'range' };

  const canonical = String(value);
  const base8 = canonical.slice(0, -1).padStart(8, '0');
  const supplied = Number(canonical.slice(-1));
  let computed = checkDigit(base8, IRD_PRIMARY_WEIGHTS);
  if (computed === 10) {
    computed = checkDigit(base8, IRD_SECONDARY_WEIGHTS);
    if (computed === 10) return { ok: false, reason: 'check_digit' };
  }
  return computed === supplied
    ? { ok: true, value: canonical }
    : { ok: false, reason: 'check_digit' };
}

/** Display grouping in threes from the right: `49-091-850`, `136-410-132`. */
export function formatIrdNumber(canonical: string): string {
  const groups: string[] = [];
  for (let end = canonical.length; end > 0; end -= 3) {
    groups.unshift(canonical.slice(Math.max(0, end - 3), end));
  }
  return groups.join('-');
}
