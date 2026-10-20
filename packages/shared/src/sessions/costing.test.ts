import { describe, expect, it } from 'vitest';
import { parseMoney, toMoneyString, type Money } from '../money/money.ts';
import {
  defaultFeeOther,
  feeRaised,
  finalFlatRate,
  suggestedRate,
  type SessionFees,
} from './costing.ts';

const m = (s: string): Money => parseMoney(s);
const str = (x: Money): string => toMoneyString(x);

const NO_FEES: SessionFees = {
  pricingStructure: 'FLAT',
  feeFlat: null,
  feeMale: null,
  feeFemale: null,
  feeOther: null,
  feeBeginner: null,
  feeIntermediate: null,
  feeAdvanced: null,
};
const flat = (fee: string | null): SessionFees => ({
  ...NO_FEES,
  feeFlat: fee === null ? null : m(fee),
});
const skill = (b: string, i: string, a: string): SessionFees => ({
  ...NO_FEES,
  pricingStructure: 'BY_SKILL_LEVEL',
  feeBeginner: m(b),
  feeIntermediate: m(i),
  feeAdvanced: m(a),
});

describe('suggestedRate: exact ceil to whole dollars (AC-HAPPY-2, AC-VERIFY-5)', () => {
  it.each([
    ['C1', '120.00', '12.00', 12, '11.00'],
    ['C2', '130.00', '12.00', 12, '12.00'],
    ['C3', '120.00', '0.00', 14, '9.00'],
    ['C4', '120.01', '12.00', 12, '12.00'],
    ['C5 free session', '0.00', '0.00', 20, '0.00'],
  ])('%s', (_id, cost, extras, players, expected) => {
    expect(str(suggestedRate(m(cost), m(extras), players))).toBe(expected);
  });

  it('never rounds down on an exact multiple plus one cent', () => {
    expect(str(suggestedRate(m('120.00'), m('0.01'), 12))).toBe('11.00'); // 10.00083 per player
    expect(str(suggestedRate(m('132.00'), m('0.00'), 12))).toBe('11.00'); // exact: stays 11
    expect(str(suggestedRate(m('132.01'), m('0.00'), 12))).toBe('12.00');
  });

  it('refuses a non-positive or fractional player count instead of dividing by zero', () => {
    expect(() => suggestedRate(m('10.00'), m('0.00'), 0)).toThrow();
    expect(() => suggestedRate(m('10.00'), m('0.00'), -1)).toThrow();
    expect(() => suggestedRate(m('10.00'), m('0.00'), 2.5)).toThrow();
  });
});

describe('finalFlatRate: the fee_flat rule (T-9)', () => {
  it('C6: no custom rate follows the suggestion', () => {
    expect(str(finalFlatRate(null, m('11.00')))).toBe('11.00');
  });
  it('C7: a custom rate pins the fee', () => {
    expect(str(finalFlatRate(m('10.00'), m('11.00')))).toBe('10.00');
  });
  it('a custom rate of $0.00 is a real pin, not "unset"', () => {
    expect(str(finalFlatRate(m('0.00'), m('11.00')))).toBe('0.00');
  });
});

describe('defaultFeeOther (AC-HAPPY-3)', () => {
  it('C8: switching into BY_SEX defaults to the lower of male and female', () => {
    expect(
      str(
        defaultFeeOther({
          feeMale: m('17.00'),
          feeFemale: m('16.00'),
          feeOther: null,
          storedFeeOther: null,
          wasBySex: false,
        }),
      ),
    ).toBe('16.00');
  });
  it('C9: a saved fee_other is never overwritten when omitted on a later save', () => {
    expect(
      str(
        defaultFeeOther({
          feeMale: m('17.00'),
          feeFemale: m('16.00'),
          feeOther: null,
          storedFeeOther: m('15.00'),
          wasBySex: true,
        }),
      ),
    ).toBe('15.00');
  });
  it('an explicit fee_other always wins, and the stored value is ignored if it was not BY_SEX', () => {
    const base = { feeMale: m('17.00'), feeFemale: m('16.00'), wasBySex: false };
    expect(str(defaultFeeOther({ ...base, feeOther: m('18.00'), storedFeeOther: null }))).toBe(
      '18.00',
    );
    expect(str(defaultFeeOther({ ...base, feeOther: null, storedFeeOther: m('15.00') }))).toBe(
      '16.00',
    );
  });
});

describe('feeRaised: the fee-lock predicate (AC-ERROR-10)', () => {
  it('C10: a decrease is not a raise', () => {
    expect(feeRaised(flat('17.00'), flat('16.00'))).toEqual([]);
  });
  it('C11: free to paid is a raise (NULL counts as $0)', () => {
    expect(feeRaised(flat('0.00'), flat('5.00'))).toEqual(['fee_flat']);
    expect(feeRaised(flat(null), flat('5.00'))).toEqual(['fee_flat']);
  });
  it('C12: only the skill fees that went up are named', () => {
    expect(feeRaised(skill('10.00', '12.00', '14.00'), skill('10.00', '13.00', '12.00'))).toEqual([
      'fee_intermediate',
    ]);
  });
  it('equal fees are not a raise', () => {
    expect(feeRaised(flat('17.00'), flat('17.00'))).toEqual([]);
  });
  it('C13: a followed FLAT suggestion that rises is a raise ($132, 12 -> 10 players)', () => {
    const before = suggestedRate(m('132.00'), m('0.00'), 12);
    const after = suggestedRate(m('132.00'), m('0.00'), 10);
    expect([str(before), str(after)]).toEqual(['11.00', '14.00']);
    expect(
      feeRaised(
        { ...NO_FEES, feeFlat: finalFlatRate(null, before) },
        { ...NO_FEES, feeFlat: finalFlatRate(null, after) },
      ),
    ).toEqual(['fee_flat']);
  });
  it('any pricing-structure change counts as a raise', () => {
    expect(
      feeRaised(flat('17.00'), { ...NO_FEES, pricingStructure: 'BY_SEX', feeMale: m('1.00') }),
    ).toContain('pricing_structure');
  });
  it('only the fees that apply to the structure count (a stale column of another model is ignored)', () => {
    const before = { ...flat('17.00'), feeMale: m('1.00') };
    const after = { ...flat('17.00'), feeMale: m('99.00') };
    expect(feeRaised(before, after)).toEqual([]);
  });
});
