/**
 * B2: a PER_GAME charge is due the billing instant plus 72 hours, exactly. Elapsed time, not calendar days, so a
 * Pacific/Auckland DST change inside the window neither shortens nor stretches it; with the 04:00 `daily-overdue` run a
 * charge therefore turns OVERDUE between 3 and 4 days after the game. Stored as an exact UTC instant.
 */
import { addHours } from '../time/time.ts';

export const PAYMENT_DUE_AFTER_HOURS = 72;

export function paymentDueDate(billedAt: Date): Date {
  return addHours(billedAt, PAYMENT_DUE_AFTER_HOURS);
}
