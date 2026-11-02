/**
 * Manual payment reminders (B6, CR-8; AC-HAPPY-10, AC-ERROR-8): the pure decision and the one writer of `payment_reminders`.
 *
 * `payment_reminders` is the only record of a manual reminder (append-only, `UNIQUE (payment_id, change_key)`); `lastReminderAt`
 * is derived from it, never stored on `payments`. The automatic overdue email is not a reminder and never counts. The caller
 * (the reminder service) holds the payment row `FOR UPDATE`, so these statements run serialised per payment: two concurrent
 * requests with the same `changeKey` write one row, and two with different keys cannot both pass the cooldown.
 */
import type { Transaction } from 'kysely';
import type { PaymentStatus } from '@sgm/shared';
import type { DB } from '../../lib/db/types.generated.ts';

/** B6: one manual reminder per payment per 24 hours, measured exactly from the last one. */
export const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type ReminderVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'payment_settled' | 'reminder_too_soon' };

/** A PAID payment is settled; otherwise a reminder is allowed at exactly `last + 24 h` and not one millisecond earlier. */
export function reminderAllowed(
  payment: { readonly status: PaymentStatus },
  lastReminderAt: Date | null,
  now: Date,
): ReminderVerdict {
  if (payment.status === 'PAID') return { ok: false, code: 'payment_settled' };
  if (lastReminderAt !== null && now.getTime() < lastReminderAt.getTime() + REMINDER_COOLDOWN_MS) {
    return { ok: false, code: 'reminder_too_soon' };
  }
  return { ok: true };
}

/** The reminder already recorded for this (payment, key): the replay claim. */
export async function findReminderByKey(
  trx: Transaction<DB>,
  input: { readonly paymentId: string; readonly changeKey: string },
): Promise<{ readonly createdAt: Date } | undefined> {
  const row = await trx
    .selectFrom('payment_reminders')
    .select('created_at')
    .where('payment_id', '=', input.paymentId)
    .where('change_key', '=', input.changeKey)
    .executeTakeFirst();
  return row === undefined ? undefined : { createdAt: row.created_at };
}

/** The newest manual reminder of the payment, or null when it was never reminded. */
export async function latestReminderAt(
  trx: Transaction<DB>,
  paymentId: string,
): Promise<Date | null> {
  const row = await trx
    .selectFrom('payment_reminders')
    .select('created_at')
    .where('payment_id', '=', paymentId)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.created_at ?? null;
}

/** Appends the reminder, stamped with the injected clock's `now` (not the database's). */
export async function insertReminder(
  trx: Transaction<DB>,
  input: {
    readonly paymentId: string;
    readonly actorUserId: string;
    readonly changeKey: string;
    readonly now: Date;
  },
): Promise<void> {
  await trx
    .insertInto('payment_reminders')
    .values({
      payment_id: input.paymentId,
      actor_user_id: input.actorUserId,
      change_key: input.changeKey,
      created_at: input.now,
    })
    .execute();
}
