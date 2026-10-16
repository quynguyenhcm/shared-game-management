import { describe, expect, it } from 'vitest';
import { GST_RATE_BPS, gstFraction } from './gst.ts';

describe('GST rate', () => {
  it('is 15% in basis points (NZ GST Act s8)', () => {
    expect(GST_RATE_BPS).toBe(1500);
  });

  it('derives the tax fraction 3/23 from the rate (1500 / 11500 reduced by gcd 500)', () => {
    expect(gstFraction(GST_RATE_BPS)).toEqual({ numerator: 3, denominator: 23 });
  });
});
