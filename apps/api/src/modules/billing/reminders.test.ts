import { describe, expect, it } from 'vitest';
import { REMINDER_COOLDOWN_MS, reminderAllowed } from './reminders.ts';

const NOW = new Date('2026-11-05T01:00:00.000Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

describe('reminderAllowed (B6, algorithm T7)', () => {
  it('refuses a PAID payment as settled, whatever the history', () => {
    expect(reminderAllowed({ status: 'PAID' }, null, NOW)).toEqual({
      ok: false,
      code: 'payment_settled',
    });
    expect(reminderAllowed({ status: 'PAID' }, ago(1000), NOW)).toEqual({
      ok: false,
      code: 'payment_settled',
    });
  });

  it('allows a first reminder for a PENDING or an OVERDUE payment', () => {
    expect(reminderAllowed({ status: 'PENDING' }, null, NOW)).toEqual({ ok: true });
    expect(reminderAllowed({ status: 'OVERDUE' }, null, NOW)).toEqual({ ok: true });
  });

  it('refuses a second reminder 24 hours minus 1 ms after the first, and allows it at exactly 24 hours', () => {
    expect(REMINDER_COOLDOWN_MS).toBe(24 * 3_600_000);
    expect(reminderAllowed({ status: 'OVERDUE' }, ago(REMINDER_COOLDOWN_MS - 1), NOW)).toEqual({
      ok: false,
      code: 'reminder_too_soon',
    });
    expect(reminderAllowed({ status: 'OVERDUE' }, ago(REMINDER_COOLDOWN_MS), NOW)).toEqual({
      ok: true,
    });
    expect(reminderAllowed({ status: 'OVERDUE' }, ago(REMINDER_COOLDOWN_MS + 1), NOW)).toEqual({
      ok: true,
    });
  });

  it('refuses a reminder stamped in the future (clock skew) as too soon rather than allowing a burst', () => {
    expect(reminderAllowed({ status: 'PENDING' }, new Date(NOW.getTime() + 1000), NOW)).toEqual({
      ok: false,
      code: 'reminder_too_soon',
    });
  });
});
