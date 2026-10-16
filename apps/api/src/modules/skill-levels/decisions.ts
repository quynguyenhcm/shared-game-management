/**
 * Pure decisions for the two admin saves, taken under the member-row lock before anything is written
 * (skill-levels-and-auto-enroll seams architecture "decisions.ts"; Binding Reconciliation decisions 3 and 4).
 * No I/O, no clock: the service passes `now` and today's Pacific/Auckland date.
 */
import type { LocalDate, SkillTier } from '@sgm/shared';

export type OverrideDecision =
  | { readonly kind: 'noop' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'change'; readonly from: SkillTier; readonly to: SkillTier };

/** Two baselines are the same instant at millisecond precision (what the API returns), nulls equal only nulls. */
function sameInstant(expected: string | null, current: Date | null): boolean {
  if (expected === null || current === null) return expected === null && current === null;
  return Date.parse(expected) === current.getTime();
}

/**
 * An admin override.
 * - The member already has the requested level: a no-op, whatever the panel saw (a retried save after a lost
 *   response is safe, and nothing is reset: AC-HAPPY-3).
 * - Otherwise the level and baseline the panel was showing must still be current (optimistic concurrency,
 *   decision 4): another admin's save or an automatic promotion since makes it `stale`.
 * - Otherwise the level changes, up or down; the caller stamps who and when and resets the baseline.
 *
 * `current.changedAt` is read by node-postgres, which keeps milliseconds only; comparing it with the
 * millisecond ISO string the API returned is exact even when the column holds microseconds.
 */
export function decideOverride(
  current: { readonly skillLevel: SkillTier; readonly changedAt: Date | null },
  input: {
    readonly skillLevel: SkillTier;
    readonly expectedSkillLevel: SkillTier;
    readonly expectedChangedAt: string | null;
  },
): OverrideDecision {
  if (input.skillLevel === current.skillLevel) return { kind: 'noop' };
  if (
    input.expectedSkillLevel !== current.skillLevel ||
    !sameInstant(input.expectedChangedAt, current.changedAt)
  ) {
    return { kind: 'stale' };
  }
  return { kind: 'change', from: current.skillLevel, to: input.skillLevel };
}

/** The three Auto Enroll columns (`is_auto_enroll`, `auto_enroll_until`, `auto_enroll_assigned_at`). */
export interface AutoEnrolState {
  readonly enabled: boolean;
  readonly until: LocalDate | null;
  readonly assignedAt: Date | null;
}

export type AutoEnrolDecision =
  | { readonly kind: 'invalid_until' }
  | { readonly kind: 'noop' }
  | { readonly kind: 'set'; readonly next: AutoEnrolState };

const OFF: AutoEnrolState = { enabled: false, until: null, assignedAt: null };

/**
 * An Auto Enroll save. `until` is inclusive and compared with today in Pacific/Auckland (`YYYY-MM-DD` strings
 * order like dates).
 * - An end date before today is refused (422 on `until`).
 * - Off: clears all three columns; already off is a no-op.
 * - On, from off or from an ENDED assignment (`until` before today): a new assignment at the back of the
 *   order (`assignedAt = now`, decision 3). An `until` of today is still active.
 * - On, from an active assignment: keeps its place (`assignedAt` unchanged); an unchanged `until` is a no-op.
 */
export function decideAutoEnrolChange(
  current: AutoEnrolState,
  input: { readonly enabled: boolean; readonly until: string | null },
  context: { readonly todayNz: LocalDate; readonly now: Date },
): AutoEnrolDecision {
  const until = input.until as LocalDate | null;
  if (input.enabled && until !== null && until < context.todayNz) return { kind: 'invalid_until' };
  if (!input.enabled) return current.enabled ? { kind: 'set', next: OFF } : { kind: 'noop' };
  const active = current.enabled && (current.until === null || current.until >= context.todayNz);
  if (!active) return { kind: 'set', next: { enabled: true, until, assignedAt: context.now } };
  if (current.until === until) return { kind: 'noop' };
  return { kind: 'set', next: { enabled: true, until, assignedAt: current.assignedAt } };
}
