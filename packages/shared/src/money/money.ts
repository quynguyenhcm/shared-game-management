/**
 * NZD money as branded bigint cents (algorithm doc §Q6). No binary floating point anywhere:
 * strings in, strings out, integer arithmetic in between, and every rounding site names its mode.
 * `JSON.stringify` of a `Money` throws (native BigInt behaviour), so money cannot silently become
 * a JSON number; the wire form is `toMoneyString` (see `zod.ts`).
 */
declare const moneyBrand: unique symbol;
declare const moneyStringBrand: unique symbol;

/** Integer cents, NZD. Only created by this module. */
export type Money = bigint & { readonly [moneyBrand]: 'NZD_CENTS' };
/** Canonical DB/wire form: /^-?(0|[1-9]\d{0,7})\.\d{2}$/ e.g. '17.50', '-0.05', '0.00'. */
export type MoneyString = string & { readonly [moneyStringBrand]: 'NZD_2DP' };

/** HALF_UP = half away from zero (identical to PostgreSQL `round(numeric)`). */
export type RoundingMode = 'HALF_UP' | 'CEIL' | 'FLOOR';
export type RoundingUnit = 'CENT' | 'DOLLAR';

export type MoneyErrorCode =
  | 'NOT_A_STRING'
  | 'INVALID_FORMAT'
  | 'TOO_MANY_DECIMALS'
  | 'OUT_OF_RANGE'
  | 'DIVISION_BY_ZERO'
  | 'INVALID_RATIO';

export class MoneyValidationError extends Error {
  readonly code: MoneyErrorCode;

  constructor(code: MoneyErrorCode, message: string) {
    super(message);
    this.name = 'MoneyValidationError';
    this.code = code;
  }
}

const cents = (value: bigint): Money => value as Money;

/** 99,999,999.99 = the DECIMAL(10,2) maximum. */
export const MONEY_MAX: Money = cents(9_999_999_999n);
export const MONEY_MIN: Money = cents(-9_999_999_999n);
export const ZERO: Money = cents(0n);

const MONEY_STRING_PATTERN = /^-?(0|[1-9]\d{0,7})\.\d{2}$/;
const DECIMAL_INPUT_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/;

function checked(value: bigint): Money {
  if (value > MONEY_MAX || value < MONEY_MIN) {
    throw new MoneyValidationError('OUT_OF_RANGE', 'amount is outside +/-99,999,999.99');
  }
  return cents(value);
}

/** Accepts 0-2 dp decimal strings only ('17', '17.5', '17.50', '-0.05'); everything else throws. */
export function parseMoney(input: unknown): Money {
  if (typeof input !== 'string') {
    throw new MoneyValidationError('NOT_A_STRING', 'money must be a decimal string, not a number');
  }
  const match = DECIMAL_INPUT_PATTERN.exec(input);
  if (match === null) {
    throw new MoneyValidationError('INVALID_FORMAT', 'money must look like "17.50"');
  }
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > 2) {
    throw new MoneyValidationError('TOO_MANY_DECIMALS', 'money allows at most 2 decimal places');
  }
  const magnitude = BigInt(whole ?? '0') * 100n + BigInt(fraction.padEnd(2, '0'));
  return checked(sign === '-' ? -magnitude : magnitude);
}

export function isMoneyString(input: unknown): input is MoneyString {
  return typeof input === 'string' && MONEY_STRING_PATTERN.test(input);
}

export function moneyFromCents(value: bigint): Money {
  return checked(value);
}

export function toCents(m: Money): bigint {
  return m;
}

export function toMoneyString(m: Money): MoneyString {
  const value = toCents(m);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const text = `${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
  return (negative ? `-${text}` : text) as MoneyString;
}

/** '$1,234.56' / '-$5.00'. Hand-rolled so output never depends on the ICU locale data. */
export function formatNZD(m: Money): string {
  const value = toCents(m);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const dollars = String(abs / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${dollars}.${String(abs % 100n).padStart(2, '0')}`;
}

export function add(a: Money, b: Money): Money {
  return checked(a + b);
}

export function subtract(a: Money, b: Money): Money {
  return checked(a - b);
}

export function negate(a: Money): Money {
  return checked(-toCents(a));
}

export function sum(items: readonly Money[]): Money {
  return items.reduce<Money>((total, item) => add(total, item), ZERO);
}

export function multiplyByInteger(m: Money, n: bigint): Money {
  return checked(m * n);
}

/** n / d rounded to an integer under `mode`; d must be > 0. */
function divideRounded(n: bigint, d: bigint, mode: RoundingMode): bigint {
  const quotient = n / d; // truncates toward zero
  const remainder = n % d; // carries the sign of n
  if (remainder === 0n) return quotient;
  switch (mode) {
    case 'FLOOR':
      return remainder < 0n ? quotient - 1n : quotient;
    case 'CEIL':
      return remainder > 0n ? quotient + 1n : quotient;
    case 'HALF_UP': {
      const twice = (remainder < 0n ? -remainder : remainder) * 2n;
      if (twice < d) return quotient;
      return n < 0n ? quotient - 1n : quotient + 1n;
    }
  }
}

/** `m * numerator / denominator`, rounded to a cent under the required `mode`. */
export function multiplyByRatio(
  m: Money,
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode,
): Money {
  if (denominator <= 0n) {
    throw new MoneyValidationError('INVALID_RATIO', 'ratio denominator must be greater than zero');
  }
  return checked(divideRounded(m * numerator, denominator, mode));
}

/** `m / divisor`, rounded to a cent or whole dollar under the required `mode` and `unit`. */
export function divideByInteger(
  m: Money,
  divisor: bigint,
  mode: RoundingMode,
  unit: RoundingUnit,
): Money {
  if (divisor === 0n) {
    throw new MoneyValidationError('DIVISION_BY_ZERO', 'cannot divide money by zero');
  }
  if (divisor < 0n) {
    throw new MoneyValidationError('INVALID_RATIO', 'divisor must be greater than zero');
  }
  const step = unit === 'DOLLAR' ? 100n : 1n;
  return checked(divideRounded(m, divisor * step, mode) * step);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const eq = (a: Money, b: Money): boolean => a === b;
export const lt = (a: Money, b: Money): boolean => a < b;
export const lte = (a: Money, b: Money): boolean => a <= b;
export const gt = (a: Money, b: Money): boolean => a > b;
export const gte = (a: Money, b: Money): boolean => a >= b;
export const isZero = (a: Money): boolean => a === 0n;
export const isNegative = (a: Money): boolean => a < 0n;
export const min = (a: Money, b: Money): Money => (a <= b ? a : b);
export const max = (a: Money, b: Money): Money => (a >= b ? a : b);
