import { describe, expect, it } from 'vitest';
import { partyTotal, totalLine } from './total.ts';

const money = (value: string) => value as never;
const fees = (over: Record<string, string | null> = {}) =>
  ({
    flat: money('17.00'),
    male: null,
    female: null,
    other: null,
    beginner: null,
    intermediate: null,
    advanced: null,
    ...over,
  }) as never;
const guest = (sex = '', skillLevel = '') => ({ sex, skillLevel, displayName: '' });

describe('partyTotal sums me.unitFee and session.fees with the shared fee rule (money, never number)', () => {
  it('FLAT: 3 x $17.00 = $51.00 for 3 people (AC-HAPPY-2)', () => {
    const total = partyTotal({
      pricing: 'FLAT',
      fees: fees(),
      unitFee: money('17.00'),
      guests: [guest(), guest()],
    });
    expect(total).toEqual({ kind: 'complete', amount: '51.00', people: 3 });
    expect(totalLine(total, 'FLAT')).toBe('Total: $51.00 for 3 people.');
  });

  it('solo says "1 person"', () => {
    const total = partyTotal({
      pricing: 'FLAT',
      fees: fees(),
      unitFee: money('17.00'),
      guests: [],
    });
    expect(totalLine(total, 'FLAT')).toBe('Total: $17.00 for 1 person.');
  });

  it('BY_SEX with every guest sex chosen is an estimate', () => {
    const total = partyTotal({
      pricing: 'BY_SEX',
      fees: fees({ flat: null, male: '20.00', female: '17.00', other: '18.00' }),
      unitFee: money('20.00'),
      guests: [guest('FEMALE'), guest('OTHER')],
    });
    expect(total).toEqual({ kind: 'complete', amount: '55.00', people: 3 });
    expect(totalLine(total, 'BY_SEX')).toBe('Estimated total: $55.00 for 3 people.');
  });

  it('partial until each guest has the needed value, naming what is missing', () => {
    const total = partyTotal({
      pricing: 'BY_SKILL_LEVEL',
      fees: fees({ flat: null, beginner: '15.00', intermediate: '17.00', advanced: '20.00' }),
      unitFee: money('17.00'),
      guests: [guest('', 'BEGINNER'), guest('', '')],
    });
    expect(total).toEqual({ kind: 'partial', amount: '32.00', people: 3, missing: 'skill level' });
    expect(totalLine(total, 'BY_SKILL_LEVEL')).toBe(
      "Total so far: $32.00. Choose each guest's skill level to see the rest.",
    );
  });

  it('no server fee means no total', () => {
    expect(
      partyTotal({ pricing: 'FLAT', fees: fees({ flat: null }), unitFee: null, guests: [] }),
    ).toEqual({ kind: 'none' });
    expect(totalLine({ kind: 'none' }, 'FLAT')).toBeNull();
  });
});
