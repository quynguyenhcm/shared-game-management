/**
 * Whether a recurring series is still running (binding P-3 / T-6: an ended series is never restarted: "To run it again, create
 * a new series"). Pure; the caller passes NZ "today" (the injected clock, never read here).
 *
 * A series is ended when its stored flag is off (End series with a last date of today or earlier switches it off at once,
 * `planEndSeries`) OR its last date has passed. The last date itself still counts as active: the last session is dated
 * that day, and the materialisation sweep keeps running rules with `recur_until >= today`, so the read and the sweep agree.
 * Nothing needs to flip the stored flag when the date passes: this predicate is the single read-time rule.
 */
import type { LocalDate } from '../time/time.ts';

export function isSeriesActive(
  rule: { readonly isActive: boolean; readonly recurUntil: LocalDate | string | null },
  today: LocalDate | string,
): boolean {
  if (!rule.isActive) return false;
  return rule.recurUntil === null || rule.recurUntil >= today;
}
