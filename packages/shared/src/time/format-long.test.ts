import { describe, expect, it } from 'vitest';
import { formatNzDateLong, formatNzWeekdayDate, formatNzWeekdayDateTime } from './format-long.ts';
import { parseLocalDate } from './time.ts';

describe('long NZ date formats for printed documents', () => {
  it('prints the NZ calendar day of an instant with the month name, across the UTC date line', () => {
    // 2027-06-03T07:30 NZST is 2027-06-02T19:30Z: the NZ day, not the UTC day.
    expect(formatNzDateLong(new Date('2027-06-02T19:30:00Z'))).toBe('3 June 2027');
    expect(formatNzDateLong(parseLocalDate('2027-02-28'))).toBe('28 February 2027');
  });

  it('adds the weekday, and the 12-hour time, without a narrow no-break space', () => {
    expect(formatNzWeekdayDate(parseLocalDate('2027-06-03'))).toBe('Thursday 3 June 2027');
    const text = formatNzWeekdayDateTime(new Date('2027-06-03T07:30:00Z'));
    expect(text).toBe('Thursday 3 June 2027, 7:30 pm');
    expect(text).not.toMatch(/[\u202f\u00a0]/);
  });

  it('is host-time-zone independent at the daylight-saving boundary (1 April 2027 00:00 NZDT)', () => {
    expect(formatNzDateLong(new Date('2027-03-31T11:00:00Z'))).toBe('1 April 2027');
    expect(formatNzDateLong(new Date('2027-03-31T10:59:59Z'))).toBe('31 March 2027');
  });
});
