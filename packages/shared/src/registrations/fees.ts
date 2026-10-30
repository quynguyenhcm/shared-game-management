/**
 * Fee estimate for a registration party (R11: shared by the API and the web panel). Money only: `Money` cents in, `Money`
 * out, summed with integer arithmetic, never a number. This is an ESTIMATE shown before and after registering; billing
 * computes the charge at session end from the stored session fee columns and the pricing snapshot (ADR 0012, ADR 0017).
 */
import { parseMoney, sum, type Money, type MoneyString } from '../money/money.ts';
import type { PricingType, SkillTier, UserSex } from '../types/enums.ts';

/** The session's fee columns for its pricing structure (`null` where a column is not filled in). */
export interface SessionFeeColumns {
  readonly pricing: PricingType;
  readonly flat: MoneyString | null;
  readonly male: MoneyString | null;
  readonly female: MoneyString | null;
  readonly other: MoneyString | null;
  readonly beginner: MoneyString | null;
  readonly intermediate: MoneyString | null;
  readonly advanced: MoneyString | null;
}

export interface FeePerson {
  readonly sex: UserSex;
  readonly skillLevel: SkillTier;
}

const SEX_COLUMN = { MALE: 'male', FEMALE: 'female', OTHER: 'other' } as const;
const SKILL_COLUMN = {
  BEGINNER: 'beginner',
  INTERMEDIATE: 'intermediate',
  ADVANCED: 'advanced',
} as const;

/** One person's fee under the session's pricing structure, or null when the column they need is empty. */
export function unitFee(fees: SessionFeeColumns, person: FeePerson): Money | null {
  const column =
    fees.pricing === 'FLAT'
      ? fees.flat
      : fees.pricing === 'BY_SEX'
        ? fees[SEX_COLUMN[person.sex]]
        : fees[SKILL_COLUMN[person.skillLevel]];
  return column === null ? null : parseMoney(column);
}

/** The registrant plus each guest at their own rate; null when anyone in the party has no fee to apply. */
export function estimateTotal(
  fees: SessionFeeColumns,
  registrant: FeePerson,
  guests: readonly FeePerson[],
): Money | null {
  const parts: Money[] = [];
  for (const person of [registrant, ...guests]) {
    const fee = unitFee(fees, person);
    if (fee === null) return null;
    parts.push(fee);
  }
  return sum(parts);
}
