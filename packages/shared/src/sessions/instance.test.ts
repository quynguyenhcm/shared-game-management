import { describe, expect, it } from 'vitest';
import { parseMoney, toMoneyString, type Money } from '../money/money.ts';
import { parseLocalDate, parseLocalTime } from '../time/time.ts';
import {
  buildInstance,
  isCourtWhollyInDstGap,
  normaliseDerived,
  type RuleCourtTemplate,
  type SeriesTemplate,
} from './instance.ts';

const m = (s: string): Money => parseMoney(s);
const date = parseLocalDate;
const time = parseLocalTime;
const court = (identifier: string, start: string, end: string): RuleCourtTemplate => ({
  courtIdentifier: identifier,
  startTime: time(start),
  endTime: time(end),
});

const FLAT_RULE: SeriesTemplate = {
  location: 'Rosedale Hall',
  address: '1 Hall Rd, Auckland',
  maxPlayers: 12,
  reservedSeats: 2,
  courtCost: m('120.00'),
  extraExpenses: m('12.00'),
  customPlayerRate: null,
  pricingStructure: 'FLAT',
  feeFlat: null,
  feeMale: null,
  feeFemale: null,
  feeOther: null,
  feeBeginner: null,
  feeIntermediate: null,
  feeAdvanced: null,
};

describe('normaliseDerived: DST gap rewrite (T1, T2)', () => {
  it('rewrites a gap time to the real wall time of its resolved instant', () => {
    expect(normaliseDerived(date('2026-09-27'), time('02:30'))).toBe('03:30');
    expect(normaliseDerived(date('2026-09-27'), time('02:00'))).toBe('03:00');
  });
  it('leaves overlap and ordinary times unchanged', () => {
    expect(normaliseDerived(date('2027-04-04'), time('02:30'))).toBe('02:30');
    expect(normaliseDerived(date('2026-09-27'), time('19:00'))).toBe('19:00');
    expect(normaliseDerived(date('2026-09-27'), time('04:00'))).toBe('04:00');
  });
});

describe('buildInstance: DST, deadlines and start instants (AC-ASYNC-1, AC-HAPPY-11)', () => {
  it.each([
    // id, date, court, stored start, stored end, startsAt, deadline
    [
      'T1',
      '2026-09-27',
      ['02:30', '04:00'],
      ['03:30', '04:00'],
      '2026-09-26T14:30:00.000Z',
      '2026-09-24T14:30:00.000Z',
    ],
    [
      'T2',
      '2027-04-04',
      ['02:30', '04:00'],
      ['02:30', '04:00'],
      '2027-04-03T13:30:00.000Z',
      '2027-04-01T13:30:00.000Z',
    ],
    [
      'T3',
      '2026-09-27',
      ['19:00', '21:00'],
      ['19:00', '21:00'],
      '2026-09-27T06:00:00.000Z',
      '2026-09-25T06:00:00.000Z',
    ],
    [
      'T4',
      '2026-09-28',
      ['19:00', '21:00'],
      ['19:00', '21:00'],
      '2026-09-28T06:00:00.000Z',
      '2026-09-26T06:00:00.000Z',
    ],
    [
      'T5',
      '2027-04-05',
      ['19:00', '21:00'],
      ['19:00', '21:00'],
      '2027-04-05T07:00:00.000Z',
      '2027-04-03T07:00:00.000Z',
    ],
  ] as const)('%s', (_id, day, [start, end], [storedStart, storedEnd], startsAt, deadline) => {
    const plan = buildInstance(FLAT_RULE, [court('1', start, end)], date(day));
    expect(plan.courts).toEqual([
      { courtIdentifier: '1', startTime: storedStart, endTime: storedEnd },
    ]);
    expect(plan.startsAt.toISOString()).toBe(startsAt);
    expect(plan.cancellationDeadline.toISOString()).toBe(deadline);
    expect(plan.deadlineIsDefault).toBe(true);
    expect(plan.isInstanceOverridden).toBe(false);
    expect(plan.date).toBe(day);
  });

  it('starts at the earliest court and keeps an end-of-day 24:00 marker', () => {
    const plan = buildInstance(
      FLAT_RULE,
      [court('B', '19:00', '21:00'), court('A', '18:00', '24:00')],
      date('2026-10-28'),
    );
    expect(plan.startsAt.toISOString()).toBe('2026-10-28T05:00:00.000Z'); // 18:00 NZDT
    expect(plan.courts.map((c) => c.endTime)).toEqual(['21:00', '24:00']);
  });

  it('refuses an empty court template (a rule without courts is invalid)', () => {
    expect(() => buildInstance(FLAT_RULE, [], date('2026-10-28'))).toThrow();
  });
});

describe('buildInstance: costing and fees (AC-HAPPY-2, AC-HAPPY-3)', () => {
  const courts = [court('1', '19:00', '21:00')];
  const dayOf = date('2026-10-28');

  it('FLAT without a custom rate follows the suggestion', () => {
    const plan = buildInstance(FLAT_RULE, courts, dayOf);
    expect(toMoneyString(plan.calculatedRatePerPlayer)).toBe('11.00');
    expect(plan.customPlayerRate).toBeNull();
    expect(plan.feeFlat).toBe(plan.calculatedRatePerPlayer);
  });

  it('FLAT with a custom rate pins fee_flat to it, but still records the suggestion', () => {
    const plan = buildInstance({ ...FLAT_RULE, customPlayerRate: m('10.00') }, courts, dayOf);
    expect(toMoneyString(plan.feeFlat as Money)).toBe('10.00');
    expect(toMoneyString(plan.calculatedRatePerPlayer)).toBe('11.00');
  });

  it('recomputes the suggestion from the instance’s own capacity and costs', () => {
    const plan = buildInstance(
      { ...FLAT_RULE, maxPlayers: 10, courtCost: m('132.00'), extraExpenses: m('0.00') },
      courts,
      dayOf,
    );
    expect(toMoneyString(plan.calculatedRatePerPlayer)).toBe('14.00');
    expect(toMoneyString(plan.feeFlat as Money)).toBe('14.00');
  });

  it('BY_SEX and BY_SKILL leave fee_flat NULL and clear the fees of the other models', () => {
    const bySex = buildInstance(
      {
        ...FLAT_RULE,
        pricingStructure: 'BY_SEX',
        feeFlat: m('99.00'),
        feeMale: m('17.00'),
        feeFemale: m('16.00'),
        feeOther: m('16.00'),
        feeBeginner: m('1.00'),
      },
      courts,
      dayOf,
    );
    expect(bySex.feeFlat).toBeNull();
    expect(bySex.feeBeginner).toBeNull();
    expect(
      [bySex.feeMale, bySex.feeFemale, bySex.feeOther].map((x) => toMoneyString(x as Money)),
    ).toEqual(['17.00', '16.00', '16.00']);

    const bySkill = buildInstance(
      {
        ...FLAT_RULE,
        pricingStructure: 'BY_SKILL_LEVEL',
        feeMale: m('5.00'),
        feeBeginner: m('10.00'),
        feeIntermediate: m('12.00'),
        feeAdvanced: m('14.00'),
      },
      courts,
      dayOf,
    );
    expect(bySkill.feeFlat).toBeNull();
    expect(bySkill.feeMale).toBeNull();
    expect(toMoneyString(bySkill.feeAdvanced as Money)).toBe('14.00');
  });

  it('copies the series defaults onto the instance', () => {
    const plan = buildInstance(FLAT_RULE, courts, dayOf);
    expect(plan).toMatchObject({
      location: 'Rosedale Hall',
      address: '1 Hall Rd, Auckland',
      maxPlayers: 12,
      reservedSeats: 2,
    });
  });
});

describe('isCourtWhollyInDstGap (T9: the rule-save refusal)', () => {
  it.each([
    ['02:15', '02:45', true],
    ['02:00', '03:00', true],
    ['01:00', '02:30', false],
    ['02:30', '04:00', false],
    ['19:00', '21:00', false],
  ])('%s-%s -> %s', (start, end, expected) => {
    expect(isCourtWhollyInDstGap(court('1', start, end))).toBe(expected);
  });
});
