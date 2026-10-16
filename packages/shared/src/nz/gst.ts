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
