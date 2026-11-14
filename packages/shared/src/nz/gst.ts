import {
  MoneyValidationError,
  multiplyByRatio,
  subtract,
  ZERO,
  type Money,
} from '../money/money.ts';

/**
 * The single source of the NZ GST rate (architecture doc Q10). A statutory rate, not deployment configuration.
 * The database never hard-codes it: `payments` snapshots `gst_rate_bps` per row.
 */

/** 15% in basis points (Goods and Services Tax Act 1985, s8). */
export const GST_RATE_BPS = 1500;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** The GST share of a GST-inclusive price: `bps / (10000 + bps)` reduced, so 1500 gives 3/23. */
export function gstFraction(rateBps: number): { numerator: number; denominator: number } {
  const denominator = 10_000 + rateBps;
  const divisor = gcd(rateBps, denominator);
  return { numerator: rateBps / divisor, denominator: denominator / divisor };
}

/**
 * The GST contained in a GST-inclusive total: `total * bps / (10000 + bps)` as one exact rational, rounded once HALF_UP
 * (half away from zero, like PostgreSQL `round(numeric)`), so it equals the `payments.gst_amount` generated column for
 * every amount and rate (algorithm doc D2 proves the equality; `gst-parity.int.test.ts` checks it against the column).
 * At 1500 bps this is 3/23 of the total. The stored column stays authoritative for documents and exports; this twin exists
 * so TypeScript can prove it agrees and can price a charge before it is stored.
 */
export function gstOfInclusive(total: Money, rateBps: number): Money {
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new MoneyValidationError(
      'INVALID_RATIO',
      'GST rate must be a whole number of basis points, 0 to 10000',
    );
  }
  if (rateBps === 0) return ZERO;
  return multiplyByRatio(total, BigInt(rateBps), BigInt(10_000 + rateBps), 'HALF_UP');
}

export interface InclusiveSplit {
  readonly total: Money;
  readonly gst: Money;
  readonly subtotal: Money;
}

/** The inclusive total split into its GST and the GST-exclusive subtotal; `subtotal + gst` is always `total`. */
export function splitInclusive(total: Money, rateBps: number): InclusiveSplit {
  const gst = gstOfInclusive(total, rateBps);
  return { total, gst, subtotal: subtract(total, gst) };
}
