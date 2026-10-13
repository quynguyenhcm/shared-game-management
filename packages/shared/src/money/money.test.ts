import { describe, expect, it } from 'vitest';
import {
  MONEY_MAX,
  MONEY_MIN,
  MoneyValidationError,
  ZERO,
  add,
  compare,
  divideByInteger,
  eq,
  formatNZD,
  gt,
  gte,
  isMoneyString,
  isNegative,
  isZero,
  lt,
  lte,
  max,
  min,
  moneyFromCents,
  multiplyByInteger,
  multiplyByRatio,
  negate,
  parseMoney,
  subtract,
  sum,
  toCents,
  toMoneyString,
  type MoneyErrorCode,
} from './money.ts';

const m = (s: string) => parseMoney(s);
const str = (x: ReturnType<typeof parseMoney>) => toMoneyString(x);

function codeOf(fn: () => unknown): MoneyErrorCode {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(MoneyValidationError);
    return (error as MoneyValidationError).code;
  }
  throw new Error('expected a MoneyValidationError');
}

describe('parse / format', () => {
  it('parses 0-2 dp strings exactly and formats NZD by hand', () => {
    expect(toCents(m('17.50'))).toBe(1750n);
    expect(toCents(m('17.5'))).toBe(1750n);
    expect(toCents(m('17'))).toBe(1700n);
    expect(toCents(m('-0.05'))).toBe(-5n);
    expect(toCents(m('-0.00'))).toBe(0n);
    expect(str(m('17.5'))).toBe('17.50');
    expect(formatNZD(m('17.50'))).toBe('$17.50');
    expect(formatNZD(m('1234.56'))).toBe('$1,234.56');
    expect(formatNZD(m('1234567.89'))).toBe('$1,234,567.89');
    expect(formatNZD(m('-5'))).toBe('-$5.00');
    expect(formatNZD(ZERO)).toBe('$0.00');
    expect(formatNZD(m('0.07'))).toBe('$0.07');
  });

  it('recognises canonical 2-dp money strings only', () => {
    expect(isMoneyString('17.50')).toBe(true);
    expect(isMoneyString('-0.05')).toBe(true);
    expect(isMoneyString('99999999.99')).toBe(true);
    for (const bad of ['17.5', '17', '01.00', '100000000.00', '1e3', 17.5, null, undefined]) {
      expect(isMoneyString(bad), String(bad)).toBe(false);
    }
  });

  it('rejects floats, NaN, Infinity, malformed and over-precise input with typed codes', () => {
    expect(codeOf(() => parseMoney(17.5))).toBe('NOT_A_STRING');
    expect(codeOf(() => parseMoney(Number.NaN))).toBe('NOT_A_STRING');
    expect(codeOf(() => parseMoney(Number.POSITIVE_INFINITY))).toBe('NOT_A_STRING');
    expect(codeOf(() => parseMoney(null))).toBe('NOT_A_STRING');
    expect(codeOf(() => parseMoney({}))).toBe('NOT_A_STRING');
    expect(codeOf(() => parseMoney('17.505'))).toBe('TOO_MANY_DECIMALS');
    for (const bad of ['abc', '1e3', ' 1.00', '+1', '.50', '17.', '01.00', '1,000.00', '', '-']) {
      expect(
        codeOf(() => parseMoney(bad)),
        JSON.stringify(bad),
      ).toBe('INVALID_FORMAT');
    }
    expect(codeOf(() => parseMoney('100000000.00'))).toBe('OUT_OF_RANGE');
    expect(codeOf(() => parseMoney('99999999999999999999.00'))).toBe('OUT_OF_RANGE');
  });

  it('errors never echo the offending input', () => {
    try {
      parseMoney('secret-abc-123');
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-abc-123');
    }
  });
});

describe('arithmetic', () => {
  it('adds, subtracts, sums and multiplies exactly (0.10 + 0.10 + 0.10 = 0.30)', () => {
    expect(str(add(add(m('0.10'), m('0.10')), m('0.10')))).toBe('0.30');
    expect(str(sum([m('0.10'), m('0.20')]))).toBe('0.30');
    expect(str(sum([]))).toBe('0.00');
    expect(str(subtract(m('0.30'), m('0.10')))).toBe('0.20');
    expect(str(negate(m('1.25')))).toBe('-1.25');
    expect(str(multiplyByInteger(m('17.00'), 3n))).toBe('51.00');
    expect(str(multiplyByInteger(m('0.01'), -7n))).toBe('-0.07');
  });

  it('range-checks every result (OUT_OF_RANGE) and exposes the DECIMAL(10,2) limits', () => {
    expect(MONEY_MAX).toBe(9_999_999_999n);
    expect(MONEY_MIN).toBe(-9_999_999_999n);
    expect(str(MONEY_MAX)).toBe('99999999.99');
    expect(codeOf(() => add(MONEY_MAX, m('0.01')))).toBe('OUT_OF_RANGE');
    expect(codeOf(() => subtract(MONEY_MIN, m('0.01')))).toBe('OUT_OF_RANGE');
    expect(codeOf(() => multiplyByInteger(MONEY_MAX, 2n))).toBe('OUT_OF_RANGE');
    expect(codeOf(() => moneyFromCents(MONEY_MAX + 1n))).toBe('OUT_OF_RANGE');
    expect(toCents(moneyFromCents(-5n))).toBe(-5n);
  });

  it('GST-inclusive split: multiplyByRatio(total, 3, 23, HALF_UP) matches the design vectors', () => {
    const gst = (total: string): [string, string] => {
      const t = m(total);
      const g = multiplyByRatio(t, 3n, 23n, 'HALF_UP');
      return [str(g), str(subtract(t, g))];
    };
    expect(gst('17.00')).toEqual(['2.22', '14.78']);
    expect(gst('16.00')).toEqual(['2.09', '13.91']);
    expect(gst('115.00')).toEqual(['15.00', '100.00']);
    expect(gst('12.00')).toEqual(['1.57', '10.43']);
    expect(gst('1.00')).toEqual(['0.13', '0.87']);
    expect(gst('0.01')).toEqual(['0.00', '0.01']);
  });

  it('GST property: gst + subtotal == total and gst == independent bigint half-up of 3T/23', () => {
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    for (let i = 0; i < 2000; i++) {
      const cents = BigInt(next() % 10_000_001);
      const total = moneyFromCents(cents);
      const gstAmount = multiplyByRatio(total, 3n, 23n, 'HALF_UP');
      // Independent rational: round-half-up(3T/23) == floor((6T + 23) / 46); ties are impossible (23 is odd).
      expect(toCents(gstAmount)).toBe((6n * cents + 23n) / 46n);
      expect(toCents(add(gstAmount, subtract(total, gstAmount)))).toBe(cents);
    }
  });

  it('rounds HALF_UP away from zero, and CEIL / FLOOR toward +/- infinity, on ties and negatives', () => {
    expect(str(multiplyByRatio(m('0.05'), 1n, 2n, 'HALF_UP'))).toBe('0.03');
    expect(str(multiplyByRatio(m('-0.05'), 1n, 2n, 'HALF_UP'))).toBe('-0.03'); // PG round(-0.025, 2)
    expect(str(multiplyByRatio(m('0.04'), 1n, 3n, 'HALF_UP'))).toBe('0.01'); // 1.33c
    expect(str(multiplyByRatio(m('-0.04'), 1n, 3n, 'HALF_UP'))).toBe('-0.01');
    expect(str(multiplyByRatio(m('0.05'), 1n, 2n, 'CEIL'))).toBe('0.03');
    expect(str(multiplyByRatio(m('-0.05'), 1n, 2n, 'CEIL'))).toBe('-0.02');
    expect(str(multiplyByRatio(m('0.05'), 1n, 2n, 'FLOOR'))).toBe('0.02');
    expect(str(multiplyByRatio(m('-0.05'), 1n, 2n, 'FLOOR'))).toBe('-0.03');
    expect(str(multiplyByRatio(m('1.00'), 2n, 1n, 'FLOOR'))).toBe('2.00'); // exact: no adjustment
    expect(str(multiplyByRatio(m('-1.00'), 2n, 1n, 'CEIL'))).toBe('-2.00');
  });

  it('rate suggestion: divideByInteger(..., CEIL, DOLLAR) never falls below break-even', () => {
    const rate = (court: string, extra: string, players: bigint): string =>
      str(divideByInteger(add(m(court), m(extra)), players, 'CEIL', 'DOLLAR'));
    expect(rate('120.00', '12.00', 12n)).toBe('11.00'); // (120+12)/12
    expect(rate('130.00', '12.00', 12n)).toBe('12.00');
    expect(rate('120.00', '0.00', 14n)).toBe('9.00');
    expect(rate('120.01', '12.00', 12n)).toBe('12.00');
    expect(str(divideByInteger(m('10.00'), 3n, 'HALF_UP', 'CENT'))).toBe('3.33');
    expect(str(divideByInteger(m('-10.00'), 3n, 'FLOOR', 'DOLLAR'))).toBe('-4.00');
  });

  it('rejects invalid ratios and divisors with typed codes', () => {
    expect(codeOf(() => divideByInteger(m('1.00'), 0n, 'CEIL', 'CENT'))).toBe('DIVISION_BY_ZERO');
    expect(codeOf(() => divideByInteger(m('1.00'), -2n, 'CEIL', 'CENT'))).toBe('INVALID_RATIO');
    expect(codeOf(() => multiplyByRatio(m('1.00'), 1n, 0n, 'HALF_UP'))).toBe('INVALID_RATIO');
    expect(codeOf(() => multiplyByRatio(m('1.00'), 1n, -3n, 'HALF_UP'))).toBe('INVALID_RATIO');
  });

  it('compares and orders values', () => {
    expect(compare(m('1.00'), m('2.00'))).toBe(-1);
    expect(compare(m('2.00'), m('2.00'))).toBe(0);
    expect(compare(m('3.00'), m('2.00'))).toBe(1);
    expect(eq(m('2'), m('2.00'))).toBe(true);
    expect(lt(m('1'), m('2'))).toBe(true);
    expect(lte(m('2'), m('2'))).toBe(true);
    expect(gt(m('3'), m('2'))).toBe(true);
    expect(gte(m('1'), m('2'))).toBe(false);
    expect(isZero(ZERO)).toBe(true);
    expect(isNegative(m('-0.01'))).toBe(true);
    expect(isNegative(ZERO)).toBe(false);
    expect(str(min(m('1'), m('2')))).toBe('1.00');
    expect(str(max(m('1'), m('2')))).toBe('2.00');
  });
});

describe('guards', () => {
  it('JSON.stringify(Money) throws so money can never silently serialise as a JSON number', () => {
    const value = m('17.50');
    expect(() => JSON.stringify(value)).toThrow(TypeError);
    expect(() => JSON.stringify({ amount: value })).toThrow(TypeError);
    // The wire form is the explicit 2-dp string.
    expect(JSON.stringify({ amount: toMoneyString(value) })).toBe('{"amount":"17.50"}');
  });

  it('the brand rejects raw numbers at compile time', () => {
    const cents = 100n;
    // @ts-expect-error a plain bigint is not Money
    toMoneyString(cents);
    // @ts-expect-error a JS number cannot be added to Money
    expect(() => add(m('1.00'), 1)).toThrow();
  });
});
