import { describe, expect, it } from 'vitest';
import { PAYMENT_DUE_AFTER_HOURS, paymentDueDate } from './due-date.ts';

describe('paymentDueDate (B2: billing instant + 72 h exactly)', () => {
  it('adds exactly 72 elapsed hours and keeps the millisecond', () => {
    expect(PAYMENT_DUE_AFTER_HOURS).toBe(72);
    expect(paymentDueDate(new Date('2026-10-07T09:30:00.123Z')).toISOString()).toBe(
      '2026-10-10T09:30:00.123Z',
    );
  });

  it('is elapsed time, not calendar days: across the Pacific/Auckland DST change it is still 72 h', () => {
    // NZ daylight time starts 2026-09-27 02:00 NZST (UTC 2026-09-26T14:00Z): a 3-calendar-day span there is only 71 h.
    const billed = new Date('2026-09-25T10:00:00.000Z');
    const due = paymentDueDate(billed);
    expect(due.getTime() - billed.getTime()).toBe(72 * 60 * 60 * 1000);
    expect(due.toISOString()).toBe('2026-09-28T10:00:00.000Z');
  });

  it('does not mutate its input and rejects an invalid instant', () => {
    const billed = new Date('2026-10-07T09:30:00.000Z');
    paymentDueDate(billed);
    expect(billed.toISOString()).toBe('2026-10-07T09:30:00.000Z');
    expect(() => paymentDueDate(new Date('nope'))).toThrow();
  });
});
