import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MoneyValidationError, parseMoney, toMoneyString } from '../money/money.ts';
import { GST_RATE_BPS, gstFraction, gstOfInclusive, splitInclusive } from './gst.ts';

describe('GST rate', () => {
  it('is 15% in basis points (NZ GST Act s8)', () => {
    expect(GST_RATE_BPS).toBe(1500);
  });

  it('derives the tax fraction 3/23 from the rate (1500 / 11500 reduced by gcd 500)', () => {
    expect(gstFraction(GST_RATE_BPS)).toEqual({ numerator: 3, denominator: 23 });
  });
});

describe('gstOfInclusive (AC-HAPPY-10)', () => {
  it('is 3/23 of the inclusive total to the cent for every AC vector, and subtotal plus GST is always the total', () => {
    const vectors: readonly [string, string][] = [
      ['0.01', '0.00'],
      ['0.50', '0.07'],
      ['1.00', '0.13'],
      ['5.00', '0.65'],
      ['10.00', '1.30'],
      ['12.00', '1.57'],
      ['23.00', '3.00'],
      ['37.00', '4.83'],
    ];
    for (const [total, gst] of vectors) {
      const split = splitInclusive(parseMoney(total), GST_RATE_BPS);
      expect(toMoneyString(split.gst), total).toBe(gst);
      expect(split.subtotal + split.gst, total).toBe(split.total);
      expect(gstOfInclusive(parseMoney(total), GST_RATE_BPS)).toBe(split.gst);
    }
  });

  it('is zero for a non-registered team (0 bps) and rounds half away from zero like Postgres round(numeric)', () => {
    const total = parseMoney('37.00');
    expect(splitInclusive(total, 0)).toEqual({ total, gst: parseMoney('0.00'), subtotal: total });
    // 2000 bps ties at c = 3 (mod 6): 0.03 * 2000 / 12000 = 0.005 -> 0.01; and the negative mirror.
    expect(toMoneyString(gstOfInclusive(parseMoney('0.03'), 2000))).toBe('0.01');
    expect(toMoneyString(gstOfInclusive(parseMoney('-0.03'), 2000))).toBe('-0.01');
    expect(toMoneyString(gstOfInclusive(parseMoney('-0.50'), GST_RATE_BPS))).toBe('-0.07');
  });

  it('refuses a rate that is not a whole number of basis points in 0..10000 (INVALID_RATIO)', () => {
    for (const bad of [-1, 10_001, 1.5, Number.NaN]) {
      expect(() => gstOfInclusive(parseMoney('1.00'), bad), String(bad)).toThrow(
        MoneyValidationError,
      );
    }
  });

  it('keeps money out of floating point: the new sources use no parseFloat, toFixed, rounding Math or Number()', () => {
    for (const file of ['./gst.ts', '../invoice/document.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(source, file).not.toMatch(
        /parseFloat|toFixed|Math\.(?:round|floor|ceil|trunc)|\bNumber\(/,
      );
    }
  });
});
