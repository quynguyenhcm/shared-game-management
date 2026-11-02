/**
 * The pure decisions of post-game billing (algorithm doc A; ADR 0012, ADR 0018 C-BIL-1). No I/O, no clock, no database: every
 * rule here is table-tested, and the database refuses whatever these functions should never produce (P1).
 *
 * - `computeCharge`: one line per party, priced by the shared `unitFee` from the session's fee columns and the registration
 *   snapshot (registrant sex and skill at confirmation, each guest's own), never `users.sex` or `team_members.skill_level`.
 * - `decideSettlement`: all-or-nothing. A wallet that covers the whole total pays it (`gte`); any shortfall, or no wallet, makes
 *   a pay-by-bank charge; a $0.00 party is its own case (B7). The low-credit flag is B5: every deduction that leaves the
 *   balance below $20.00.
 * - `billingDueDate`: B2, the billing instant plus 72 hours, exactly (the shared rule).
 */
import {
  LOW_CREDIT_THRESHOLD,
  gte,
  isZero,
  lt,
  paymentDueDate,
  subtract,
  sum,
  unitFee,
  type FeeBasis,
  type FeePerson,
  type Money,
  type PricingType,
  type SessionFeeColumns,
  type SkillTier,
  type UserSex,
} from '@sgm/shared';
import type { BillableRegistration } from '../registrations/billing-handoff.ts';

/** A party has no fee to apply, or a registration has no snapshot: a broken invariant, so the billing transaction rolls back. */
export class ChargeInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChargeInvariantError';
  }
}

export interface ChargeLine {
  /** 0 for the registrant, 1-2 for guests. */
  readonly position: 0 | 1 | 2;
  /** `registration_guests.id` for a guest line, null for the registrant. */
  readonly guestId: string | null;
  readonly basis: FeeBasis;
  /** The snapshotted attributes of this party (what the line item stores). */
  readonly sex: UserSex;
  readonly skillLevel: SkillTier;
  readonly unitFee: Money;
}

export interface Charge {
  readonly lines: readonly ChargeLine[];
  /** The whole party's GST-inclusive total: the sum of the line fees. */
  readonly total: Money;
}

/** The basis a line was priced on (`payment_line_items.applied_basis`); the table CHECK ties it to the snapshot. */
export function appliedBasis(pricing: PricingType, person: FeePerson): FeeBasis {
  switch (pricing) {
    case 'FLAT':
      return 'FLAT';
    case 'BY_SEX':
      return `SEX_${person.sex}`;
    case 'BY_SKILL_LEVEL':
      return `SKILL_${person.skillLevel}`;
  }
}

function line(
  fees: SessionFeeColumns,
  position: ChargeLine['position'],
  guestId: string | null,
  person: FeePerson,
): ChargeLine {
  const fee = unitFee(fees, person);
  if (fee === null) {
    throw new ChargeInvariantError(
      `no ${fees.pricing} fee applies to party position ${position}: the session fees are incomplete`,
    );
  }
  return {
    position,
    guestId,
    basis: appliedBasis(fees.pricing, person),
    sex: person.sex,
    skillLevel: person.skillLevel,
    unitFee: fee,
  };
}

/** Prices one billable registration: the registrant and each guest at their own snapshot rate. */
export function computeCharge(fees: SessionFeeColumns, registration: BillableRegistration): Charge {
  const lines = [
    line(fees, 0, null, {
      sex: registration.registrantSex,
      skillLevel: registration.registrantSkillLevel,
    }),
    ...registration.guests.map((guest) =>
      line(fees, guest.position, guest.guestId, { sex: guest.sex, skillLevel: guest.skillLevel }),
    ),
  ];
  return { lines, total: sum(lines.map((entry) => entry.unitFee)) };
}

export type Settlement =
  | { readonly kind: 'ZERO' }
  | { readonly kind: 'WALLET'; readonly newBalance: Money; readonly lowCredit: boolean }
  | { readonly kind: 'LINK' };

/**
 * How a charge is settled. `balance` is the locked wallet balance, null when the player has no wallet row. ZERO (B7) is decided
 * first: a $0.00 party is recorded PAID and never touches a wallet. WALLET only when the balance covers the whole total.
 */
export function decideSettlement(balance: Money | null, total: Money): Settlement {
  if (isZero(total)) return { kind: 'ZERO' };
  if (balance !== null && gte(balance, total)) {
    const newBalance = subtract(balance, total);
    return { kind: 'WALLET', newBalance, lowCredit: lt(newBalance, LOW_CREDIT_THRESHOLD) };
  }
  return { kind: 'LINK' };
}

/** B2: the due instant of a pay-by-bank charge. */
export const billingDueDate = paymentDueDate;
