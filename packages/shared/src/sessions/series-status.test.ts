import { describe, expect, it } from 'vitest';
import { parseLocalDate } from '../time/time.ts';
import { isSeriesActive } from './series-status.ts';

const day = parseLocalDate;
const TODAY = day('2026-10-14');

describe('isSeriesActive (P-3 / T-6: a series past its last date stays ended)', () => {
  it('is active with no last date', () => {
    expect(isSeriesActive({ isActive: true, recurUntil: null }, TODAY)).toBe(true);
  });

  it('is active before its last date and ON its last date (the last session may still be today)', () => {
    expect(isSeriesActive({ isActive: true, recurUntil: day('2026-10-15') }, TODAY)).toBe(true);
    expect(isSeriesActive({ isActive: true, recurUntil: day('2026-10-14') }, TODAY)).toBe(true);
  });

  it('is ended the day after its last date, whatever the stored flag says', () => {
    expect(isSeriesActive({ isActive: true, recurUntil: day('2026-10-13') }, TODAY)).toBe(false);
    expect(
      isSeriesActive({ isActive: true, recurUntil: day('2026-10-13') }, day('2027-01-01')),
    ).toBe(false);
  });

  it('is ended when the stored flag is false, even with no last date or a future one', () => {
    expect(isSeriesActive({ isActive: false, recurUntil: null }, TODAY)).toBe(false);
    expect(isSeriesActive({ isActive: false, recurUntil: day('2026-12-01') }, TODAY)).toBe(false);
  });
});
