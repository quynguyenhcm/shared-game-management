/**
 * Vectors trace to one of:
 *  - "IRD Ex n": worked example n in IRD "Payroll Calculations & Business Rules Specification, 1 April 2026 to
 *    31 March 2027" v1.0 (24 Mar 2026), section 7 (bank account number validation), pp. 99-103.
 *  - "Hand": arithmetic against the s7 weight table, shown in the vector's comment and in the algorithm creative
 *    doc (team-banking-and-gst-nz-validation-algorithm.md, Testing Strategy). Every sum was also re-derived by a
 *    throwaway script that is independent of the implementation.
 * No expected value is produced by calling the code under test.
 */
import { describe, expect, it } from 'vitest';
import {
  NZ_AB_THRESHOLD,
  NZ_BANK_ALGORITHMS,
  NZ_BANK_IDS,
  deriveBankAccountLast4,
  parseNzBankAccount,
  weightedSumOk,
  type NzBankAlgorithm,
} from './bank-account.ts';

/** Same 18-position layout as IRD s7: bank(2) branch(4) "0" account(7) suffix zero-filled to 4. */
function digits18(formatted: string): string {
  const [bank, branch, account, suffix] = formatted.split('-') as [string, string, string, string];
  return `${bank}${branch}0${account}${suffix.padStart(4, '0')}`;
}

function ok(input: string) {
  const result = parseNzBankAccount(input);
  if (!result.ok) throw new Error(`expected ok, got ${result.reason} for a vector`);
  return result.value;
}

function reason(input: string): string {
  const result = parseNzBankAccount(input);
  if (result.ok) throw new Error('expected a failure');
  return result.reason;
}

describe('parseNzBankAccount: valid vectors per algorithm class', () => {
  const valid: ReadonlyArray<[string, string, NzBankAlgorithm]> = [
    // IRD Ex 1: branch 9*3+2*9=45; base 6*5+8*8+3*4+8*2+9*1=131; 176 = 11*16.
    ['01-0902-0068389-00', 'IRD Ex 1', 'A'],
    // Hand: branch 3*6+4*7=46; base 1*10+2*5+3*8+4*4+5*2+5*1=75; 121 = 11*11.
    ['12-3040-0123455-00', 'Hand', 'A'],
    // Hand (AB boundary, A side): branch 9*6=54; base 265; 319 = 11*29. Under B it would be 265 = 1 mod 11.
    ['38-9000-0989999-00', 'Hand', 'A'],
    // Hand: B base 9*10+9*5+8*1 = 143 = 11*13. Under A it would be 197 = 10 mod 11.
    ['38-9000-0990008-00', 'Hand', 'B'],
    // Hand: same base, other bank and branch: B ignores the branch -> 143.
    ['12-3040-0990008-00', 'Hand', 'B'],
    // Hand: 9*(10+5+8+4+2)+3*1 = 264 = 11*24.
    ['01-0001-9999993-00', 'Hand', 'B'],
    // IRD Ex 2: 1*7+9*6+5*5+4*4+5*3+1*2+2*1 = 121 = 11*11.
    ['08-6523-1954512-001', 'IRD Ex 2', 'D'],
    // Hand: 1*7+4*1 = 11.
    ['08-6501-1000004-00', 'Hand', 'D'],
    // Hand: 7*3+0*2+1*1 = 22.
    ['08-6599-0000701-00', 'Hand', 'D'],
    // Hand (D has no AB rule): 9*6+9*5 = 99 = 11*9. Under B it would be 135 = 3 mod 11.
    ['08-6501-0990000-00', 'Hand', 'D'],
    // Hand: 5*3+5*1 = 20 = 0 mod 10.
    ['25-2500-0000055-00', 'Hand', 'F'],
    // Hand: 1*1+2*7+3*3+4*1+5*7+6*3+9*1 = 90.
    ['25-2570-1234569-00', 'Hand', 'F'],
    // Hand: suffix weights are 0 for F, so a 3-digit suffix leaves the sum at 20.
    ['25-2500-0000055-123', 'Hand', 'F'],
    // S7 note: algorithm X has modulus 1 and always verifies.
    ['31-2825-1234567-00', 'S7 note 2', 'X'],
    ['31-2840-0000001-001', 'S7 note 2', 'X'],
    ['31-2830-9999999-99', 'S7 note 2', 'X'],
  ];

  it.each(valid)('accepts %s (%s) with algorithm %s', (input, _source, algorithm) => {
    const value = ok(input);
    expect(value.algorithm).toBe(algorithm);
  });

  it('stores IRD Ex 1 as the canonical padded form and last4 from the account base', () => {
    const value = ok('01-0902-0068389-00');
    expect(value).toMatchObject({
      canonical: '01-0902-0068389-000',
      bank: '01',
      branch: '0902',
      account: '0068389',
      suffix: '000',
      last4: '8389',
    });
  });

  it('keeps a 3-digit suffix as given (IRD Ex 2) and pads a 2-digit suffix to 3', () => {
    expect(ok('08-6523-1954512-001').canonical).toBe('08-6523-1954512-001');
    expect(ok('08-6523-1954512-001').last4).toBe('4512');
    expect(ok('25-2500-0000055-00').suffix).toBe('000');
  });
});

describe('parseNzBankAccount: algorithm selection (AB rule)', () => {
  it('uses A at 989999 and B at exactly 990000 (threshold constant)', () => {
    expect(NZ_AB_THRESHOLD).toBe(990_000);
    expect(ok('38-9000-0989999-00').algorithm).toBe('A');
    // Hand: bank 01 branch 0111 base 0990000. Under B: 9*10+9*5 = 135 = 3 mod 11 -> invalid.
    // Under A the branch adds 0*6+1*3+1*7+1*9 = 19, so 135 + 19 = 154 = 11*14 -> valid; invalid here proves B.
    expect(reason('01-0111-0990000-00')).toBe('check_digit');
  });
});

describe('parseNzBankAccount: single-digit corruptions fail', () => {
  const corrupted: ReadonlyArray<[string, string]> = [
    // IRD Ex 1 with the last digit -1: 175 = 10 mod 11.
    ['01-0902-0068388-00', 'last digit -1 (A)'],
    // Adjacent swap 8<->9: 177 = 1 mod 11.
    ['01-0902-0068398-00', 'transposition (A)'],
    // Branch typo, +9 in the 3-weighted position: 185 = 9 mod 11 (A weights the branch).
    ['01-0903-0068389-00', 'branch digit (A)'],
    ['01-0001-9999994-00', 'last digit (B): 265 = 1 mod 11'],
    ['08-6523-1954513-001', 'last digit (D): 122 = 1 mod 11'],
    ['25-2570-1234567-00', 'last digit (F): 88 = 8 mod 10'],
  ];
  it.each(corrupted)('rejects %s (%s) as check_digit', (input) => {
    expect(reason(input)).toBe('check_digit');
  });
});

describe('parseNzBankAccount: unknown and legacy banks', () => {
  it.each([
    // IRD Ex 3 (valid under G, sum 30) is bank 26, which is no longer in the table.
    '26-2600-0320871-032',
    // Valid under E (sum 33) but bank 09 is legacy.
    '09-0000-0001234-003',
    '07-0000-0000000-00',
    '99-0001-0000001-00',
  ])('rejects %s as unknown_bank', (input) => {
    expect(reason(input)).toBe('unknown_bank');
  });

  it.each(['07', '09', '26', '28', '29', '33', '35'])('refuses legacy bank id %s', (bank) => {
    expect(reason(`${bank}-2600-0320871-032`)).toBe('unknown_bank');
    expect(Object.hasOwn(NZ_BANK_IDS, bank)).toBe(false);
  });

  it('does not treat prototype keys as bank ids', () => {
    expect(Object.hasOwn(NZ_BANK_IDS, 'constructor')).toBe(false);
  });

  it('lists exactly the S7 table: AB x25, D x1, F x1, X x1', () => {
    const ids = Object.keys(NZ_BANK_IDS).sort();
    expect(ids).toEqual([
      '01',
      '02',
      '03',
      '04',
      '05',
      '06',
      '08',
      '10',
      '11',
      '12',
      '13',
      '14',
      '15',
      '16',
      '17',
      '18',
      '19',
      '20',
      '21',
      '22',
      '23',
      '24',
      '25',
      '27',
      '30',
      '31',
      '38',
      '88',
    ]);
    expect(NZ_BANK_IDS['08']).toBe('D');
    expect(NZ_BANK_IDS['25']).toBe('F');
    expect(NZ_BANK_IDS['31']).toBe('X');
  });
});

describe('parseNzBankAccount: input shape', () => {
  it.each([
    '01 0902 0068389 00',
    '010902006838900',
    '0109020068389000',
    '01–0902–0068389–00', // en dash
    '  01-0902-0068389-00  ',
    '01 - 0902 - 0068389 - 00',
  ])('accepts the separator form %j and canonicalises it', (input) => {
    // "0109020068389000" is the 16 digit run for suffix 000.
    expect(ok(input).canonical).toBe('01-0902-0068389-000');
  });

  it.each([
    ['', 'required'],
    ['   ', 'required'],
    ['12345678901234', 'format'], // 14 digits
    ['12345678901234567', 'format'], // 17 digits
    ['01-902-0068389-00', 'format'], // short branch group
    ['01-0902-068389-00', 'format'], // short account group
    ['0l-0902-0068389-00', 'format'], // letter l
    ['01-0902-0068389-0000', 'format'], // 4 digit suffix
    ['01-0902-0068389-0', 'format'], // 1 digit suffix
    ['01-0902-0068389', 'format'], // missing suffix group
    ['١٢-0902-0068389-00', 'format'], // Arabic-Indic digits
    ['01.0902.0068389.00', 'format'],
    ['01/0902/0068389/00', 'format'],
  ])('rejects %j as %s', (input, expected) => {
    expect(reason(input)).toBe(expected);
  });
});

describe('weightedSumOk: every algorithm row, including classes no current bank uses', () => {
  const cases: ReadonlyArray<[NzBankAlgorithm, string, boolean, string]> = [
    ['G', '26-2600-0320871-032', true, 'IRD Ex 3: folded products 9,5,6,4,1 + suffix 3,2 = 30'],
    ['G', '26-2600-0000001-009', true, 'Hand: 1*1 + 9*1 = 10'],
    // Hand: 7*7=49 -> 13 -> 4 (double fold); 6*1=6; 4+6 = 10. A single fold gives 19, no fold 55.
    ['G', '29-2150-0000070-006', true, 'Hand: proves the double digit-sum fold'],
    ['G', '26-2600-0320871-033', false, 'Hand: 31'],
    ['E', '09-0000-0001234-003', true, 'Hand: 1*5+2*4+3*3+4*2 = 30; + 3*1 = 33'],
    // Hand: 45->9, 36->9, 27->9, 18->9 = 36; + 8 = 44. Without the fold: 134 = 2 mod 11.
    ['E', '09-0000-0009999-008', true, 'Hand: proves the E fold'],
    ['E', '09-0000-0000011-006', true, 'Hand: 1*3+1*2 = 5; + 6 = 11'],
    ['E', '09-0000-0009999-009', false, 'Hand: 45'],
    ['C', '01-0000-0000004-00', true, 'Hand: bank 1*7 = 7 + 4 = 11'],
    ['C', '04-0000-0000005-00', true, 'Hand: bank 4*7 = 28 + 5 = 33'],
    ['C', '01-0000-1000003-00', true, 'Hand: 7 + 1*1 (base position 2) + 3 = 11'],
    ['C', '01-0000-0000005-00', false, 'Hand: 12'],
    ['A', '01-0902-0068389-00', true, 'IRD Ex 1: 176'],
    ['B', '01-0001-9999993-00', true, 'Hand: 264'],
    ['D', '08-6523-1954512-001', true, 'IRD Ex 2: 121'],
    ['F', '25-2500-0000055-00', true, 'Hand: 20 mod 10'],
    ['X', '99-9999-9999999-99', true, 'modulus 1'],
  ];
  it.each(cases)('algorithm %s on %s is %s (%s)', (algorithm, formatted, expected) => {
    expect(weightedSumOk(algorithm, digits18(formatted))).toBe(expected);
  });

  it('rejects an input that is not exactly 18 digits', () => {
    expect(() => weightedSumOk('A', '123')).toThrow(RangeError);
  });
});

describe('NZ_BANK_ALGORITHMS table structure', () => {
  it('has all eight rows with 18 weights, moduli in {1,10,11}, fold only for E and G', () => {
    expect(Object.keys(NZ_BANK_ALGORITHMS).sort()).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
      'G',
      'X',
    ]);
    for (const [name, spec] of Object.entries(NZ_BANK_ALGORITHMS)) {
      expect(spec.weights).toHaveLength(18);
      expect([1, 10, 11]).toContain(spec.modulus);
      expect(spec.foldDigits).toBe(name === 'E' || name === 'G');
    }
    expect(NZ_BANK_ALGORITHMS.F.modulus).toBe(10);
    expect(NZ_BANK_ALGORITHMS.G.modulus).toBe(10);
    expect(NZ_BANK_ALGORITHMS.X.modulus).toBe(1);
  });
});

describe('deriveBankAccountLast4 (R9: last 4 digits of the account base)', () => {
  it('takes the account base from a full number, in any separator form', () => {
    expect(deriveBankAccountLast4('01-0902-0068389-00')).toBe('8389');
    expect(deriveBankAccountLast4('01-0902-0068389-000')).toBe('8389');
    expect(deriveBankAccountLast4('010902006838900')).toBe('8389');
  });

  it('takes the last 4 of a bare 7 digit account base', () => {
    expect(deriveBankAccountLast4('0068389')).toBe('8389');
  });

  it('refuses input that is neither an account base nor a full number', () => {
    expect(() => deriveBankAccountLast4('12-3')).toThrow(RangeError);
    expect(() => deriveBankAccountLast4('')).toThrow(RangeError);
  });
});
