import { describe, expect, it } from 'vitest';
import { toMoneyString, type MoneyString } from '../money/money.ts';
import { estimateTotal, unitFee, type SessionFeeColumns } from './fees.ts';

const m = (value: string): MoneyString => value as MoneyString;

const none = {
  flat: null,
  male: null,
  female: null,
  other: null,
  beginner: null,
  intermediate: null,
  advanced: null,
} as const;

const flat: SessionFeeColumns = { ...none, pricing: 'FLAT', flat: m('17.00') };
const bySex: SessionFeeColumns = {
  ...none,
  pricing: 'BY_SEX',
  male: m('20.00'),
  female: m('15.50'),
  other: m('18.00'),
};
const bySkill: SessionFeeColumns = {
  ...none,
  pricing: 'BY_SKILL_LEVEL',
  beginner: m('12.00'),
  intermediate: m('17.00'),
  advanced: m('22.25'),
};

const person = (
  sex: 'MALE' | 'FEMALE' | 'OTHER',
  skillLevel: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED',
) => ({
  sex,
  skillLevel,
});

describe('unitFee (AC-HAPPY-2: the fee line follows the session pricing structure)', () => {
  it('is the flat rate for everyone on a FLAT session', () => {
    expect(toMoneyString(unitFee(flat, person('MALE', 'ADVANCED'))!)).toBe('17.00');
    expect(toMoneyString(unitFee(flat, person('FEMALE', 'BEGINNER'))!)).toBe('17.00');
  });

  it('follows the person sex on a BY_SEX session and ignores skill', () => {
    expect(toMoneyString(unitFee(bySex, person('MALE', 'BEGINNER'))!)).toBe('20.00');
    expect(toMoneyString(unitFee(bySex, person('FEMALE', 'ADVANCED'))!)).toBe('15.50');
    expect(toMoneyString(unitFee(bySex, person('OTHER', 'ADVANCED'))!)).toBe('18.00');
  });

  it('follows the person skill level on a BY_SKILL_LEVEL session and ignores sex', () => {
    expect(toMoneyString(unitFee(bySkill, person('MALE', 'BEGINNER'))!)).toBe('12.00');
    expect(toMoneyString(unitFee(bySkill, person('MALE', 'INTERMEDIATE'))!)).toBe('17.00');
    expect(toMoneyString(unitFee(bySkill, person('FEMALE', 'ADVANCED'))!)).toBe('22.25');
  });

  it('is null when the fee column the person needs is not filled in', () => {
    expect(unitFee({ ...flat, flat: null }, person('MALE', 'BEGINNER'))).toBeNull();
    expect(unitFee({ ...bySex, other: null }, person('OTHER', 'BEGINNER'))).toBeNull();
    expect(unitFee({ ...bySkill, advanced: null }, person('MALE', 'ADVANCED'))).toBeNull();
  });
});

describe('estimateTotal', () => {
  it('sums the registrant and each guest at their own rate, in exact cents', () => {
    const total = estimateTotal(bySkill, person('FEMALE', 'INTERMEDIATE'), [
      person('FEMALE', 'INTERMEDIATE'),
      person('MALE', 'BEGINNER'),
    ]);
    expect(toMoneyString(total!)).toBe('46.00');
  });

  it('is the party size times the flat rate (AC-HAPPY-2: 3 x $17.00 = $51.00)', () => {
    const total = estimateTotal(flat, person('MALE', 'BEGINNER'), [
      person('MALE', 'BEGINNER'),
      person('FEMALE', 'ADVANCED'),
    ]);
    expect(toMoneyString(total!)).toBe('51.00');
  });

  it('is the registrant alone with no guests', () => {
    expect(toMoneyString(estimateTotal(bySex, person('FEMALE', 'BEGINNER'), [])!)).toBe('15.50');
  });

  it('is null when any member of the party has no fee to apply', () => {
    expect(
      estimateTotal({ ...bySex, male: null }, person('FEMALE', 'BEGINNER'), [
        person('MALE', 'BEGINNER'),
      ]),
    ).toBeNull();
  });

  it('adds without binary floating point (0.10 + 0.20 is exactly 0.30)', () => {
    const cheap: SessionFeeColumns = {
      ...none,
      pricing: 'BY_SEX',
      male: m('0.10'),
      female: m('0.20'),
      other: m('0.00'),
    };
    expect(
      toMoneyString(
        estimateTotal(cheap, person('MALE', 'BEGINNER'), [person('FEMALE', 'BEGINNER')])!,
      ),
    ).toBe('0.30');
  });
});
