/**
 * Policy numbers the billing pages quote. They mirror the API's (`REMINDER_COOLDOWN_MS` in `modules/billing/reminders.ts`,
 * `DEBT_LIMIT` in `modules/registrations/allocator.ts`) and are never typed into copy: every sentence is built from these.
 */

/** B6: a second reminder for the same payment is refused within 24 hours. */
export const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** The registration gate: this many overdue payments block registering for more sessions. */
export const OVERDUE_BLOCK_COUNT = 3;

/** The wallet page shows at most this many paid games (the API returns up to 50). */
export const PAID_SHOWN = 10;
