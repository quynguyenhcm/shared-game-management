/**
 * Vectors trace to IRD "Payroll Calculations & Business Rules Specification 2026-27" v1.0 s6.1 and "Payday Filing
 * File Upload Specification 2026-27" v1.1 s5.8 (worked examples), or to hand arithmetic recorded beside the vector
 * (primary weights 3,2,7,6,5,4,3,2; secondary 7,4,3,2,5,2,7,6; also re-derived by an independent throwaway script).
 */
import { describe, expect, it } from 'vitest';
import {
  IRD_NUMBER_MAX,
  IRD_NUMBER_MIN,
  IRD_PRIMARY_WEIGHTS,
  IRD_SECONDARY_WEIGHTS,
  formatIrdNumber,
  parseIrdNumber,
} from './ird-number.ts';

function ok(input: string): string {
  const result = parseIrdNumber(input);
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.value;
}
function reason(input: string): string {
  const result = parseIrdNumber(input);
  if (result.ok) throw new Error('expected failure');
  return result.reason;
}

describe('parseIrdNumber: constants', () => {
  it('pins the 2026-27 range and the weights', () => {
    expect(IRD_NUMBER_MIN).toBe(10_000_000);
    expect(IRD_NUMBER_MAX).toBe(200_000_000);
    expect([...IRD_PRIMARY_WEIGHTS]).toEqual([3, 2, 7, 6, 5, 4, 3, 2]);
    expect([...IRD_SECONDARY_WEIGHTS]).toEqual([7, 4, 3, 2, 5, 2, 7, 6]);
  });
});

describe('parseIrdNumber: valid numbers', () => {
  it.each([
    // [input, canonical, source]
    ['49-091-850', '49091850', 'IRD Ex 1: sum 154 = 0 mod 11 -> check 0'],
    ['35901981', '35901981', 'IRD Ex 2: sum 142 = 10 mod 11 -> check 1'],
    ['136-410-132', '136410132', 'Payday Ex 3: primary 89 = 1 -> 10; secondary 75 = 9 -> 2'],
    ['150000009', '150000009', 'Hand: 1*3+5*2 = 13 = 2 mod 11 -> 9. Above the old 150M limit'],
    [
      '10000009',
      '10000009',
      'Hand: base 01000000: 1*2 = 2 -> 9. Lowest check-valid number in range',
    ],
    ['199999990', '199999990', 'Hand: 3 + 9*(2+7+6+5+4+3+2) = 264 = 0 mod 11 -> 0'],
    ['049 091 850', '49091850', 'leading zero and spaces'],
    ['049-091-850', '49091850', 'leading zero'],
  ])('accepts %s -> %s (%s)', (input, canonical) => {
    expect(ok(input)).toBe(canonical);
  });

  it('accepts en-dash separators', () => {
    expect(ok('49–091–850')).toBe('49091850');
  });
});

describe('parseIrdNumber: rejections', () => {
  it('rejects corrupted check digits', () => {
    expect(reason('49091851')).toBe('check_digit');
    expect(reason('136410133')).toBe('check_digit');
  });

  it('rejects a second 10 (primary and secondary both 10): 10000051', () => {
    // Hand: base 01000005. Primary 1*2+5*2 = 12 = 1 mod 11 -> 10; secondary 1*4+5*6 = 34 = 1 mod 11 -> 10.
    expect(reason('10000051')).toBe('check_digit');
  });

  it('pins 150000026 as rejected (IRD s6.1 Ex 3 erratum; creative doc Q2 T1)', () => {
    // The primary result is 5 (not 10), so the step text never reaches the secondary weights; 5 != 6.
    expect(reason('150000026')).toBe('check_digit');
  });

  it.each([
    ['09999996', 'Hand: check-valid (primary 10, secondary 6) but 9,999,996 < 10,000,000'],
    ['200000005', 'Hand: 2*3 = 6 -> 5, check-valid but 200,000,005 > 200,000,000'],
  ])('rejects %s as range (%s)', (input) => {
    expect(reason(input)).toBe('range');
  });

  it.each([
    ['', 'required'],
    ['   ', 'required'],
    ['9125568', 'format'], // IRD Ex 4: 7 digits
    ['1234567890', 'format'], // 10 digits
    ['12a45678', 'format'],
    ['4909185O', 'format'], // letter O
    ['٤٩091850', 'format'], // Arabic-Indic digits
  ])('rejects %j as %s', (input, expected) => {
    expect(reason(input)).toBe(expected);
  });
});

describe('formatIrdNumber', () => {
  it('groups in threes from the right', () => {
    expect(formatIrdNumber('49091850')).toBe('49-091-850');
    expect(formatIrdNumber('136410132')).toBe('136-410-132');
  });
});
