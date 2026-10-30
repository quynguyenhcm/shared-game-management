/**
 * Registration timing as pure functions of one injected instant (algorithm doc, "Time"). Comparisons are on UTC
 * instants only: `now` is a whole number of milliseconds and `pg` reads `timestamptz` as the floor in milliseconds, so
 * `now <= deadline` is exact. Pacific/Auckland appears only when formatting.
 */
import type { SessionStatus } from '@sgm/shared';

/** Open while PUBLISHED and strictly before `starts_at`. Runs BEFORE `classifyWithdrawal`. */
export function isRegistrationOpen(
  now: Date,
  session: { readonly status: SessionStatus; readonly startsAt: Date | null },
): boolean {
  return (
    session.status === 'PUBLISHED' &&
    session.startsAt !== null &&
    now.getTime() < session.startsAt.getTime()
  );
}

/** Workflows section 2: `now <= cancellation_deadline` is free (EARLY); any later instant is LATE. */
export function classifyWithdrawal(
  now: Date,
  session: { readonly cancellationDeadline: Date },
): 'EARLY' | 'LATE' {
  return now.getTime() <= session.cancellationDeadline.getTime() ? 'EARLY' : 'LATE';
}
