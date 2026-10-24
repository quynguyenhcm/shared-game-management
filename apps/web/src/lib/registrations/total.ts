import {
  formatNZD,
  parseMoney,
  sum,
  toMoneyString,
  unitFee,
  type FeePerson,
  type Money,
  type MoneyString,
  type RegistrationReadResponse,
  type SkillTier,
  type UserSex,
} from '@sgm/shared';
import type { GuestValues } from './validation.ts';

type Pricing = RegistrationReadResponse['session']['pricingStructure'];
type Fees = RegistrationReadResponse['session']['fees'];

export type PartyTotal =
  | { kind: 'none' }
  | { kind: 'complete'; amount: string; people: number }
  | { kind: 'partial'; amount: string; people: number; missing: 'sex' | 'skill level' };

/**
 * The pre-submit total (AC-HAPPY-2, R11 PartyTotal): the registrant's fee is the server's `me.unitFee`, each guest is priced by
 * the shared `unitFee` rule from the server's `session.fees` and the sex or level the player chose, and everything is added with
 * the shared integer `Money` sum (never a number). It is an estimate: the API decides and billing charges. The registrant's own
 * sex and level are not in the read model, so their share is `me.unitFee`, not recomputed.
 */
export function partyTotal(input: {
  pricing: Pricing;
  fees: Fees;
  unitFee: string | null;
  guests: readonly GuestValues[];
}): PartyTotal {
  if (input.unitFee === null) return { kind: 'none' };
  const parts: Money[] = [parseMoney(input.unitFee)];
  let missing: 'sex' | 'skill level' | null = null;
  const columns = { pricing: input.pricing, ...input.fees };
  for (const guest of input.guests) {
    const needed = input.pricing === 'BY_SEX' ? guest.sex : guest.skillLevel;
    if (input.pricing !== 'FLAT' && needed === '') {
      missing = input.pricing === 'BY_SEX' ? 'sex' : 'skill level';
      continue;
    }
    const person: FeePerson = {
      sex: (guest.sex || 'OTHER') as UserSex,
      skillLevel: (guest.skillLevel || 'BEGINNER') as SkillTier,
    };
    const fee = unitFee(columns, person);
    if (fee === null) return { kind: 'none' };
    parts.push(fee);
  }
  const amount = toMoneyString(sum(parts)) satisfies MoneyString;
  const people = 1 + input.guests.length;
  return missing === null
    ? { kind: 'complete', amount, people }
    : { kind: 'partial', amount, people, missing };
}

export function totalLine(total: PartyTotal, pricing: Pricing): string | null {
  if (total.kind === 'none') return null;
  const amount = formatNZD(parseMoney(total.amount));
  if (total.kind === 'partial') {
    return `Total so far: ${amount}. Choose each guest's ${total.missing} to see the rest.`;
  }
  const lead = pricing === 'FLAT' ? 'Total' : 'Estimated total';
  return `${lead}: ${amount} for ${total.people === 1 ? '1 person' : `${total.people} people`}.`;
}
