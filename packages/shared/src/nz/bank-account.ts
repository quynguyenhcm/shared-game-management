/**
 * NZ bank account number validation.
 *
 * Source: Inland Revenue, "Payroll Calculations & Business Rules Specification, 1 April 2026 to 31 March 2027",
 * v1.0 (24 March 2026), section 7 "Bank account number validation", pp. 99-103: the bank ID to algorithm table,
 * the AB rule ("below 00990000 apply algorithm A, otherwise algorithm B") and the weight table (A-G, X).
 * Transcribed by hand; the bank IDs are cross-checked against the Payments NZ Bank Branch Register of 25 Sep 2026.
 * No branch ranges are checked: IRD defers branch validity to that monthly register (see creative doc
 * team-banking-and-gst-nz-validation-algorithm.md, Q1). Review every April when IRD republishes the specification.
 *
 * Isomorphic and pure: no Node APIs. Results carry reason codes only, never a message, so nothing typed is echoed.
 */

export const NZ_BANK_SOURCE = {
  document: 'IRD Payroll Calculations & Business Rules Specification 2026-27 v1.0, s7 pp.99-103',
  bankIdsCrossChecked: 'Payments NZ Bank Branch Register 2026-09-25',
} as const;

export type NzBankAlgorithm = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'X';

interface AlgorithmSpec {
  /** 18 weights over bank(2) branch(4) account base(8) suffix(4). */
  readonly weights: readonly number[];
  readonly modulus: 1 | 10 | 11;
  /** E and G replace each product by its digit sum, applied twice (49 -> 13 -> 4). */
  readonly foldDigits: boolean;
}

export const NZ_BANK_ALGORITHMS: Readonly<Record<NzBankAlgorithm, AlgorithmSpec>> = {
  A: {
    weights: [0, 0, 6, 3, 7, 9, 0, 0, 10, 5, 8, 4, 2, 1, 0, 0, 0, 0],
    modulus: 11,
    foldDigits: false,
  },
  B: {
    weights: [0, 0, 0, 0, 0, 0, 0, 0, 10, 5, 8, 4, 2, 1, 0, 0, 0, 0],
    modulus: 11,
    foldDigits: false,
  },
  C: {
    weights: [3, 7, 0, 0, 0, 0, 9, 1, 10, 5, 3, 4, 2, 1, 0, 0, 0, 0],
    modulus: 11,
    foldDigits: false,
  },
  D: {
    weights: [0, 0, 0, 0, 0, 0, 0, 7, 6, 5, 4, 3, 2, 1, 0, 0, 0, 0],
    modulus: 11,
    foldDigits: false,
  },
  E: {
    weights: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 4, 3, 2, 0, 0, 0, 1],
    modulus: 11,
    foldDigits: true,
  },
  F: {
    weights: [0, 0, 0, 0, 0, 0, 0, 1, 7, 3, 1, 7, 3, 1, 0, 0, 0, 0],
    modulus: 10,
    foldDigits: false,
  },
  G: {
    weights: [0, 0, 0, 0, 0, 0, 0, 1, 3, 7, 1, 3, 7, 1, 0, 3, 7, 1],
    modulus: 10,
    foldDigits: true,
  },
  X: {
    weights: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    modulus: 1,
    foldDigits: false,
  },
};

/** "below 00990000 then apply algorithm A, otherwise apply algorithm B" (s7 AB rule). */
export const NZ_AB_THRESHOLD = 990_000;

/** Bank ID to algorithm (s7 table). Look up with `Object.hasOwn` so prototype keys never match. */
export const NZ_BANK_IDS: Readonly<Record<string, 'AB' | 'D' | 'F' | 'X'>> = {
  '01': 'AB',
  '02': 'AB',
  '03': 'AB',
  '04': 'AB',
  '05': 'AB',
  '06': 'AB',
  '08': 'D',
  '10': 'AB',
  '11': 'AB',
  '12': 'AB',
  '13': 'AB',
  '14': 'AB',
  '15': 'AB',
  '16': 'AB',
  '17': 'AB',
  '18': 'AB',
  '19': 'AB',
  '20': 'AB',
  '21': 'AB',
  '22': 'AB',
  '23': 'AB',
  '24': 'AB',
  '25': 'F',
  '27': 'AB',
  '30': 'AB',
  '31': 'X',
  '38': 'AB',
  '88': 'AB',
};

export type NzBankAccountFailure = 'required' | 'format' | 'unknown_bank' | 'check_digit';

export interface NzBankAccount {
  /** `BB-bbbb-AAAAAAA-SSS`, suffix zero-padded to 3 digits. */
  readonly canonical: string;
  readonly bank: string;
  readonly branch: string;
  readonly account: string;
  readonly suffix: string;
  readonly algorithm: NzBankAlgorithm;
  /** Last 4 digits of the 7-digit account base. */
  readonly last4: string;
}

export type NzBankAccountResult =
  | { readonly ok: true; readonly value: NzBankAccount }
  | { readonly ok: false; readonly reason: NzBankAccountFailure };

/** ASCII space/tab, hyphen, U+2010-U+2015 (dashes pasted from documents) and U+2212. */
const SEPARATOR_RUN = /[ \t\-‐-―−]+/;

function digitSum(value: number): number {
  let sum = 0;
  for (let rest = value; rest > 0; rest = Math.floor(rest / 10)) sum += rest % 10;
  return sum;
}

/** The weighted-sum test for one algorithm over the 18-digit layout (exported for per-class vectors). */
export function weightedSumOk(algorithm: NzBankAlgorithm, digits18: string): boolean {
  if (!/^[0-9]{18}$/.test(digits18)) throw new RangeError('expected exactly 18 digits');
  const { weights, modulus, foldDigits } = NZ_BANK_ALGORITHMS[algorithm];
  let sum = 0;
  for (let i = 0; i < 18; i += 1) {
    const product = (weights[i] as number) * Number(digits18[i]);
    sum += foldDigits ? digitSum(digitSum(product)) : product;
  }
  return sum % modulus === 0;
}

export function parseNzBankAccount(input: string): NzBankAccountResult {
  const text = input.trim();
  if (text === '') return { ok: false, reason: 'required' };

  let bank: string;
  let branch: string;
  let account: string;
  let suffix: string;
  const groups = text.split(SEPARATOR_RUN);
  if (groups.length === 1 && /^[0-9]{15,16}$/.test(text)) {
    bank = text.slice(0, 2);
    branch = text.slice(2, 6);
    account = text.slice(6, 13);
    suffix = text.slice(13);
  } else if (
    groups.length === 4 &&
    /^[0-9]{2}$/.test(groups[0] as string) &&
    /^[0-9]{4}$/.test(groups[1] as string) &&
    /^[0-9]{7}$/.test(groups[2] as string) &&
    /^[0-9]{2,3}$/.test(groups[3] as string)
  ) {
    [bank, branch, account, suffix] = groups as [string, string, string, string];
  } else {
    return { ok: false, reason: 'format' };
  }

  if (!Object.hasOwn(NZ_BANK_IDS, bank)) return { ok: false, reason: 'unknown_bank' };
  const entry = NZ_BANK_IDS[bank] as 'AB' | 'D' | 'F' | 'X';
  const algorithm: NzBankAlgorithm =
    entry === 'AB' ? (Number(account) < NZ_AB_THRESHOLD ? 'A' : 'B') : entry;

  if (!weightedSumOk(algorithm, `${bank}${branch}0${account}${suffix.padStart(4, '0')}`)) {
    return { ok: false, reason: 'check_digit' };
  }
  const suffix3 = suffix.padStart(3, '0');
  return {
    ok: true,
    value: {
      canonical: `${bank}-${branch}-${account}-${suffix3}`,
      bank,
      branch,
      account,
      suffix: suffix3,
      algorithm,
      last4: account.slice(-4),
    },
  };
}

/**
 * The `bank_account_last4` display rule: the last 4 digits of the 7-digit account base (never the suffix), so
 * `01-0902-0068389-00` shows `8389`. Accepts a bare account base or a full number (15/16 digits, any separators).
 */
export function deriveBankAccountLast4(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, '');
  const base =
    digits.length === 7 ? digits : /^[0-9]{15,16}$/.test(digits) ? digits.slice(6, 13) : null;
  if (base === null) {
    throw new RangeError('expected a 7 digit account base or a full NZ account number');
  }
  return base.slice(-4);
}
