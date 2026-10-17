import {
  deriveSkillProvenance,
  type MemberSkillChangeResponse,
  type SkillProgress,
  type SkillTier,
  type TeamMemberRow,
} from '@sgm/shared';
import type { ApiResult } from '../api-client.ts';
import {
  AUTO_ENROLL_STALE_MESSAGE,
  NO_ACCESS_HEADING,
  SAVE_FAILED_MESSAGE,
  SKILL_OPTIONS,
  SKILL_STALE_MESSAGE,
  UNCONFIRMED_MESSAGE,
  formatManageDate,
} from './labels.ts';
import type { ModerationResult } from './moderation.ts';

/**
 * Pure view rules of the "Skill and Auto Enroll" row lines and panel (member-panel UI/UX and admin-journey
 * docs): provenance, progress and Auto Enroll tag copy, the "ended" derivation, the client pre-check of the
 * end date, and the mapping from an API answer to the copy the admin reads. No React, so each rule is
 * unit-tested once. The API stays the authority: nothing here hides a rule it cannot prove.
 */

const CALENDAR_DATE = new Intl.DateTimeFormat('en-NZ', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  // `until` is a calendar date, not an instant: formatting it in UTC means no zone can shift the day.
  timeZone: 'UTC',
});

/** `2026-11-30` -> `30 Nov 2026`. Never pass an instant here (use `formatManageDate`). */
export function formatCalendarDate(date: string): string {
  return CALENDAR_DATE.format(new Date(`${date}T00:00:00Z`)).replace('Sept', 'Sep');
}

export function skillLevelLabel(level: SkillTier): string {
  return SKILL_OPTIONS.find((option) => option.value === level)?.label ?? level;
}

/** "Self-assessed", "Set by {admin} · {date}" or "Moved up automatically · {date}" (dates in Pacific/Auckland). */
export function skillProvenanceLine(
  member: Pick<TeamMemberRow, 'skillOverride' | 'skillChangedAt'>,
): string {
  const provenance = deriveSkillProvenance(member);
  switch (provenance.kind) {
    case 'self':
      return 'Self-assessed';
    case 'admin':
      return `Set by ${provenance.byName === '' ? 'a former admin' : provenance.byName} · ${formatManageDate(provenance.at)}`;
    case 'auto':
      return `Moved up automatically · ${formatManageDate(provenance.at)}`;
  }
}

/** Games toward the next level, capped at what is required; the top level has no next one. */
export function skillProgressLine(progress: SkillProgress | null): string {
  if (progress === null) return 'Highest level';
  const games = Math.min(Math.max(progress.games, 0), progress.required);
  return `${games} of ${progress.required} games toward ${skillLevelLabel(progress.nextLevel)}`;
}

export type AutoEnrollState =
  { kind: 'off' } | { kind: 'active'; until: string | null } | { kind: 'ended'; until: string };

/**
 * The stored flag stays set after its end date, so "ended" is derived at render: `until` before today in
 * Pacific/Auckland (`todayNz`, a `YYYY-MM-DD`). An `until` equal to today is still active.
 */
export function autoEnrollState(
  autoEnroll: TeamMemberRow['autoEnroll'],
  todayNz: string,
): AutoEnrollState {
  if (!autoEnroll.enabled) return { kind: 'off' };
  if (autoEnroll.until !== null && autoEnroll.until < todayNz) {
    return { kind: 'ended', until: autoEnroll.until };
  }
  return { kind: 'active', until: autoEnroll.until };
}

export function autoEnrollTag(
  autoEnroll: TeamMemberRow['autoEnroll'],
  todayNz: string,
): string | null {
  const state = autoEnrollState(autoEnroll, todayNz);
  switch (state.kind) {
    case 'off':
      return null;
    case 'ended':
      return `Auto Enroll ended ${formatCalendarDate(state.until)}`;
    case 'active':
      return state.until === null
        ? 'Auto Enroll, no end date'
        : `Auto Enroll until ${formatCalendarDate(state.until)}`;
  }
}

const UNTIL_PAST = 'Choose today or a later date.';
const UNTIL_INCOMPLETE = 'Enter a complete date, or clear the field.';

/**
 * Client pre-check of the end date. A partly typed date reports `''` with `validity.badInput`, which would
 * otherwise save as "no end date". The API still validates (AC-ERROR-3).
 */
export function validateUntil(value: string, badInput: boolean, todayNz: string): string | null {
  if (badInput) return UNTIL_INCOMPLETE;
  if (value !== '' && value < todayNz) return UNTIL_PAST;
  return null;
}

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

/** The rule and consequence line beside "Save skill level" (AC-HAPPY-12). */
export function skillRuleLine(
  fullName: string,
  level: SkillTier,
  progress: SkillProgress | null,
): string {
  const name = firstName(fullName);
  if (progress === null) {
    return `${skillLevelLabel(level)} is the highest level. Saving a lower level restarts ${name}'s count at 0.`;
  }
  const games = Math.min(Math.max(progress.games, 0), progress.required);
  return `Members move up one level after ${progress.required} games with this team in a year. ${name} has ${games} of ${progress.required} toward ${skillLevelLabel(progress.nextLevel)}. Saving a different level restarts the count at 0.`;
}

export type SkillResultKind = 'skill' | 'autoEnroll';

/** What a skill-panel Server Action reports: the moderation result plus which form it belongs to. */
export interface SkillPanelResult extends ModerationResult {
  kind: SkillResultKind;
}

export type SkillPanelAction = (
  previous: SkillPanelResult | null,
  formData: FormData,
) => Promise<SkillPanelResult>;

function successText(
  kind: SkillResultKind,
  data: MemberSkillChangeResponse,
  fullName: string,
): string {
  const { member, changed } = data;
  if (kind === 'skill') {
    const level = skillLevelLabel(member.skillLevel);
    return changed
      ? `Skill level for ${fullName} set to ${level}.`
      : `${fullName} is already ${level}.`;
  }
  const { enabled, until } = member.autoEnroll;
  if (!changed) {
    return `Nothing to change. Auto Enroll for ${fullName} is already ${enabled ? 'on' : 'off'}.`;
  }
  if (!enabled) return `Auto Enroll turned off for ${fullName}.`;
  return until === null
    ? `Auto Enroll on for ${fullName}, with no end date.`
    : `Auto Enroll on for ${fullName} until ${formatCalendarDate(until)}.`;
}

/**
 * The outcome shown for an API answer (AC-ERROR-3/6/8/9). `refresh` says whether the action revalidated the
 * manage page; a definite or unknown failure never does (no optimistic or partial change). A result with
 * `close` means the row is gone or unreachable: it reports in the Members region and the panel closes.
 */
export function toSkillResult(
  kind: SkillResultKind,
  result: ApiResult<MemberSkillChangeResponse>,
  context: { fullName: string },
): SkillPanelResult {
  const { fullName } = context;
  if (result.ok) {
    const name = result.data.member.fullName || fullName;
    return { ok: true, kind, message: successText(kind, result.data, name), refresh: true };
  }
  const { status } = result;
  const code = result.error.code;
  if (status === 0) {
    return {
      ok: false,
      kind,
      code: 'service_unavailable',
      message: UNCONFIRMED_MESSAGE,
      refresh: false,
    };
  }
  if (code === 'skill_level_stale') {
    return { ok: false, kind, code, message: SKILL_STALE_MESSAGE, refresh: true };
  }
  if (code === 'auto_enroll_stale') {
    return { ok: false, kind, code, message: AUTO_ENROLL_STALE_MESSAGE, refresh: true };
  }
  if (code === 'membership_state_conflict' || status === 404) {
    return {
      ok: false,
      kind,
      code: 'membership_state_conflict',
      message: `${fullName} is no longer an approved member. The list has been refreshed.`,
      refresh: true,
      close: true,
    };
  }
  if (status === 403) {
    return {
      ok: false,
      kind,
      code: 'forbidden',
      message: NO_ACCESS_HEADING,
      refresh: true,
      close: true,
    };
  }
  if (status === 422 && result.error.fieldErrors !== undefined) {
    const first = Object.values(result.error.fieldErrors)[0]?.[0] ?? SAVE_FAILED_MESSAGE;
    return {
      ok: false,
      kind,
      code: 'validation_failed',
      message: first,
      refresh: false,
      fieldErrors: result.error.fieldErrors,
    };
  }
  return {
    ok: false,
    kind,
    code: 'service_unavailable',
    message: SAVE_FAILED_MESSAGE,
    refresh: false,
  };
}
