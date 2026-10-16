/**
 * Paid-session parity matrix (algorithm doc Q5, blocks M1 to M6). Shared by the SQL test
 * (`team-banking-schema.int.test.ts`, evaluated in one query) and the TypeScript `isPaidSession` test of
 * Phase 3. Fees are `MoneyString` literals, `null` is an unset column.
 *
 * Expected values are hand-written from the rule, never computed by production code:
 *   paid = some fee column that APPLIES to the pricing structure is > 0.00 (NULL counts as 0, a negative
 *   fee is not paid, columns of another structure never count).
 */
export type PricingStructure = 'FLAT' | 'BY_SEX' | 'BY_SKILL_LEVEL';

export const FEE_KEYS = [
  'feeFlat',
  'feeMale',
  'feeFemale',
  'feeOther',
  'feeBeginner',
  'feeIntermediate',
  'feeAdvanced',
] as const;
export type FeeKey = (typeof FEE_KEYS)[number];

export type Fees = { readonly [K in FeeKey]: string | null };

export interface PaidSessionCase {
  readonly name: string;
  readonly pricingStructure: PricingStructure;
  readonly fees: Fees;
  readonly expectedPaid: boolean;
  /**
   * True when the row also satisfies `game_sessions` CHECKs (BY_SEX needs all three sex fees), so the
   * integration test can publish a real session with it.
   */
  readonly insertable: boolean;
}

const NO_FEES: Fees = {
  feeFlat: null,
  feeMale: null,
  feeFemale: null,
  feeOther: null,
  feeBeginner: null,
  feeIntermediate: null,
  feeAdvanced: null,
};

/** Hand-written statement of which columns apply to which structure. */
const APPLIES: Readonly<Record<PricingStructure, readonly FeeKey[]>> = {
  FLAT: ['feeFlat'],
  BY_SEX: ['feeMale', 'feeFemale', 'feeOther'],
  BY_SKILL_LEVEL: ['feeBeginner', 'feeIntermediate', 'feeAdvanced'],
};

const STRUCTURES: readonly PricingStructure[] = ['FLAT', 'BY_SEX', 'BY_SKILL_LEVEL'];
const SINGLE_VALUES: readonly { value: string | null; positive: boolean }[] = [
  { value: null, positive: false },
  { value: '0.00', positive: false },
  { value: '0.01', positive: true },
  { value: '-0.01', positive: false },
  { value: '99999999.99', positive: true },
];

function build(): PaidSessionCase[] {
  const cases: PaidSessionCase[] = [];

  // M1: one fee column set, the rest NULL: 3 structures x 7 columns x 5 values = 105 rows.
  for (const pricingStructure of STRUCTURES) {
    for (const key of FEE_KEYS) {
      for (const { value, positive } of SINGLE_VALUES) {
        cases.push({
          name: `M1 ${pricingStructure} ${key}=${value ?? 'NULL'}`,
          pricingStructure,
          fees: { ...NO_FEES, [key]: value },
          expectedPaid: positive && APPLIES[pricingStructure].includes(key),
          // BY_SEX rows need all three sex fees non-NULL to be insertable: only never true for M1.
          insertable: pricingStructure !== 'BY_SEX',
        });
      }
    }
  }

  // M2: every applicable fee zero, one inapplicable fee large: never paid.
  cases.push(
    {
      name: 'M2 FLAT fee_flat=0.00, fee_male=99999999.99',
      pricingStructure: 'FLAT',
      fees: { ...NO_FEES, feeFlat: '0.00', feeMale: '99999999.99' },
      expectedPaid: false,
      insertable: true,
    },
    {
      name: 'M2 BY_SEX sex fees 0.00, fee_flat=99999999.99',
      pricingStructure: 'BY_SEX',
      fees: {
        ...NO_FEES,
        feeMale: '0.00',
        feeFemale: '0.00',
        feeOther: '0.00',
        feeFlat: '99999999.99',
      },
      expectedPaid: false,
      insertable: true,
    },
    {
      name: 'M2 BY_SKILL_LEVEL skill fees 0.00, fee_flat=99999999.99',
      pricingStructure: 'BY_SKILL_LEVEL',
      fees: {
        ...NO_FEES,
        feeBeginner: '0.00',
        feeIntermediate: '0.00',
        feeAdvanced: '0.00',
        feeFlat: '99999999.99',
      },
      expectedPaid: false,
      insertable: true,
    },
  );

  // M3: all NULL.
  for (const pricingStructure of STRUCTURES) {
    cases.push({
      name: `M3 ${pricingStructure} all NULL`,
      pricingStructure,
      fees: NO_FEES,
      expectedPaid: false,
      insertable: pricingStructure !== 'BY_SEX',
    });
  }

  // M4: one applicable fee 0.01, the others 0.00 (BY_SEX uses fee_other to prove it counts).
  cases.push(
    {
      name: 'M4 FLAT fee_flat=0.01',
      pricingStructure: 'FLAT',
      fees: { ...NO_FEES, feeFlat: '0.01' },
      expectedPaid: true,
      insertable: true,
    },
    {
      name: 'M4 BY_SEX fee_other=0.01 (male, female 0.00)',
      pricingStructure: 'BY_SEX',
      fees: { ...NO_FEES, feeMale: '0.00', feeFemale: '0.00', feeOther: '0.01' },
      expectedPaid: true,
      insertable: true,
    },
    {
      name: 'M4 BY_SKILL_LEVEL fee_advanced=0.01 (beginner, intermediate 0.00)',
      pricingStructure: 'BY_SKILL_LEVEL',
      fees: { ...NO_FEES, feeBeginner: '0.00', feeIntermediate: '0.00', feeAdvanced: '0.01' },
      expectedPaid: true,
      insertable: true,
    },
  );

  // M5: BY_SEX zeros that satisfy the table CHECK.
  cases.push({
    name: 'M5 BY_SEX male=female=other=0.00',
    pricingStructure: 'BY_SEX',
    fees: { ...NO_FEES, feeMale: '0.00', feeFemale: '0.00', feeOther: '0.00' },
    expectedPaid: false,
    insertable: true,
  });

  // M6: negative mixed with positive or zero.
  cases.push(
    {
      name: 'M6 BY_SKILL_LEVEL -5.00, 0.00, 0.01',
      pricingStructure: 'BY_SKILL_LEVEL',
      fees: { ...NO_FEES, feeBeginner: '-5.00', feeIntermediate: '0.00', feeAdvanced: '0.01' },
      expectedPaid: true,
      insertable: true,
    },
    {
      name: 'M6 BY_SKILL_LEVEL -5.00, 0.00, 0.00',
      pricingStructure: 'BY_SKILL_LEVEL',
      fees: { ...NO_FEES, feeBeginner: '-5.00', feeIntermediate: '0.00', feeAdvanced: '0.00' },
      expectedPaid: false,
      insertable: true,
    },
  );

  return cases;
}

export const PAID_SESSION_MATRIX: readonly PaidSessionCase[] = build();
