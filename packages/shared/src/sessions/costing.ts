/**
 * Session costing and fee rules (algorithm doc A5 and conflict 10). Money is `Money` (integer cents) end to end:
 * no floats, every rounding site names its mode. Shared by the API and the web form (AC-VERIFY-5).
 */
import { add, divideByInteger, min, toCents, ZERO, type Money } from '../money/money.ts';
import type { PricingType } from '../types/enums.ts';

/** The fee columns of a session or series, `null` meaning unset (counts as $0.00 in fee comparisons). */
export interface SessionFees {
  readonly pricingStructure: PricingType;
  readonly feeFlat: Money | null;
  readonly feeMale: Money | null;
  readonly feeFemale: Money | null;
  readonly feeOther: Money | null;
  readonly feeBeginner: Money | null;
  readonly feeIntermediate: Money | null;
  readonly feeAdvanced: Money | null;
}

/** Column names (snake_case, as the API reports them in `raisedFields`). */
export type FeeKey =
  | 'fee_flat'
  | 'fee_male'
  | 'fee_female'
  | 'fee_other'
  | 'fee_beginner'
  | 'fee_intermediate'
  | 'fee_advanced';
export type RaisedField = FeeKey | 'pricing_structure';

type FeeField = Exclude<keyof SessionFees, 'pricingStructure'>;

const FEES_BY_STRUCTURE: Readonly<Record<PricingType, readonly (readonly [FeeKey, FeeField])[]>> = {
  FLAT: [['fee_flat', 'feeFlat']],
  BY_SEX: [
    ['fee_male', 'feeMale'],
    ['fee_female', 'feeFemale'],
    ['fee_other', 'feeOther'],
  ],
  BY_SKILL_LEVEL: [
    ['fee_beginner', 'feeBeginner'],
    ['fee_intermediate', 'feeIntermediate'],
    ['fee_advanced', 'feeAdvanced'],
  ],
};

/**
 * Suggested rate per player: (court hire + extras) / `max_players`, rounded UP to the next whole dollar.
 * Reserved host seats are not billed, so it under-recovers by design (spec owner's call).
 */
export function suggestedRate(courtCost: Money, extraExpenses: Money, maxPlayers: number): Money {
  if (!Number.isInteger(maxPlayers) || maxPlayers < 1) {
    throw new RangeError('max players must be a whole number of 1 or more');
  }
  return divideByInteger(add(courtCost, extraExpenses), BigInt(maxPlayers), 'CEIL', 'DOLLAR');
}

/** `fee_flat` of a FLAT session: the pinned custom rate, else the suggestion. `$0.00` is a real pin. */
export function finalFlatRate(customPlayerRate: Money | null, calculatedRate: Money): Money {
  return customPlayerRate ?? calculatedRate;
}

/**
 * `fee_other` for BY_SEX: an explicit value wins; otherwise a saved value is kept when the stored row was
 * already BY_SEX (never overwritten); otherwise the lower of male and female.
 */
export function defaultFeeOther(input: {
  readonly feeMale: Money;
  readonly feeFemale: Money;
  readonly feeOther: Money | null;
  readonly storedFeeOther: Money | null;
  readonly wasBySex: boolean;
}): Money {
  if (input.feeOther !== null) return input.feeOther;
  if (input.wasBySex && input.storedFeeOther !== null) return input.storedFeeOther;
  return min(input.feeMale, input.feeFemale);
}

/**
 * The fee-lock predicate (T-7): what a change from `before` to `after` raises. A pricing-structure change is
 * always reported (as `pricing_structure`); otherwise each fee that applies to the structure and went up.
 * NULL counts as $0.00, so free to paid is a raise. Fees of another structure never count.
 */
export function feeRaised(before: SessionFees, after: SessionFees): RaisedField[] {
  const raised: RaisedField[] = [];
  if (before.pricingStructure !== after.pricingStructure) raised.push('pricing_structure');
  for (const [key, field] of FEES_BY_STRUCTURE[after.pricingStructure]) {
    const was = before.pricingStructure === after.pricingStructure ? before[field] : null;
    const now = after[field];
    if (toCents(now ?? ZERO) > toCents(was ?? ZERO)) raised.push(key);
  }
  return raised;
}
