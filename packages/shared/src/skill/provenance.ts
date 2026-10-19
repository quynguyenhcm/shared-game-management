/**
 * Where a member's current level came from, derived (never stored) from the `TeamMemberRow` fields
 * `skillOverride` and `skillChangedAt` (skill-levels-and-auto-enroll, seams architecture D1a):
 *
 * - `self`: the level has never changed since the member joined (`skillChangedAt` is null): "Self-assessed".
 * - `admin`: the last change is the override. An override writes the same instant to `skill_level_override_at`
 *   and `skill_level_changed_at`, so the two are equal: "Set by {byName} · {at}".
 * - `auto`: the level changed after any override (or with none), which only the progression job does:
 *   "Moved up automatically · {at}".
 *
 * The database CHECK `team_members_changed_after_override` (override time requires a baseline at or after it)
 * makes the three cases exhaustive. Instants are compared as instants, not strings.
 */

export interface SkillOverrideStamp {
  readonly byName: string;
  readonly at: string;
}

export type SkillProvenance =
  | { readonly kind: 'self' }
  | { readonly kind: 'admin'; readonly byName: string; readonly at: string }
  | { readonly kind: 'auto'; readonly at: string };

export function deriveSkillProvenance(row: {
  readonly skillOverride: SkillOverrideStamp | null;
  readonly skillChangedAt: string | null;
}): SkillProvenance {
  const { skillOverride, skillChangedAt } = row;
  if (
    skillOverride !== null &&
    (skillChangedAt === null || Date.parse(skillChangedAt) <= Date.parse(skillOverride.at))
  ) {
    return { kind: 'admin', byName: skillOverride.byName, at: skillOverride.at };
  }
  if (skillChangedAt === null) return { kind: 'self' };
  return { kind: 'auto', at: skillChangedAt };
}
