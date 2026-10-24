import { describe, expect, it } from 'vitest';
import { seriesName } from './series-name.ts';

describe('seriesName', () => {
  it.each([
    [{ frequency: 'WEEKLY', dayOfWeek: 3, monthlyWeek: null }, 'Wednesdays at Hall'],
    [{ frequency: 'WEEKLY', dayOfWeek: 0, monthlyWeek: null }, 'Sundays at Hall'],
    [
      { frequency: 'FORTNIGHTLY', dayOfWeek: 3, monthlyWeek: null },
      'Every second Wednesday at Hall',
    ],
    [
      { frequency: 'FORTNIGHTLY', dayOfWeek: 6, monthlyWeek: null },
      'Every second Saturday at Hall',
    ],
    [
      { frequency: 'MONTHLY', dayOfWeek: 3, monthlyWeek: 1 },
      'First Wednesday of the month at Hall',
    ],
    [{ frequency: 'MONTHLY', dayOfWeek: 1, monthlyWeek: 2 }, 'Second Monday of the month at Hall'],
    [{ frequency: 'MONTHLY', dayOfWeek: 5, monthlyWeek: 3 }, 'Third Friday of the month at Hall'],
    [{ frequency: 'MONTHLY', dayOfWeek: 2, monthlyWeek: 4 }, 'Fourth Tuesday of the month at Hall'],
    [{ frequency: 'MONTHLY', dayOfWeek: 4, monthlyWeek: -1 }, 'Last Thursday of the month at Hall'],
  ] as const)('names %j as %s', (pattern, expected) => {
    expect(seriesName({ ...pattern, location: 'Hall' })).toBe(expected);
  });

  it('uses the location as given', () => {
    expect(
      seriesName({
        frequency: 'WEEKLY',
        dayOfWeek: 3,
        monthlyWeek: null,
        location: 'Wellington Sports Centre',
      }),
    ).toBe('Wednesdays at Wellington Sports Centre');
  });

  // The name is derived for display only, so a row the DB CHECKs should never allow still gets a readable name.
  describe('fallbacks for values the schema should never store', () => {
    it('names an out-of-range weekday "Day" instead of "undefined"', () => {
      expect(
        seriesName({ frequency: 'WEEKLY', dayOfWeek: 9, monthlyWeek: null, location: 'Hall' }),
      ).toBe('Days at Hall');
      expect(
        seriesName({ frequency: 'WEEKLY', dayOfWeek: -1, monthlyWeek: null, location: 'Hall' }),
      ).toBe('Days at Hall');
    });

    it('reads a monthly series without a week as the First, and an unknown week (5) as the First', () => {
      expect(
        seriesName({ frequency: 'MONTHLY', dayOfWeek: 3, monthlyWeek: null, location: 'Hall' }),
      ).toBe('First Wednesday of the month at Hall');
      expect(
        seriesName({ frequency: 'MONTHLY', dayOfWeek: 3, monthlyWeek: 5, location: 'Hall' }),
      ).toBe('First Wednesday of the month at Hall');
    });
  });
});
