/**
 * Request contracts for the two team-admin member routes added by skill-levels-and-auto-enroll, shared by the
 * Fastify routes and the web Server Actions:
 *
 * - `PUT /teams/:teamId/members/:userId/skill-level`
 * - `PUT /teams/:teamId/members/:userId/auto-enroll`
 *
 * Bodies are strict: an unknown field is a 422, so a client can never set what the server owns (the override
 * actor and time, the baseline, the Auto Enroll assignment time). Field messages are the copy deck of the
 * member-panel and journey documents, so the web and the API show the same text. Whether `until` is before
 * today in Pacific/Auckland needs the injected clock and is checked by the service, not here.
 *
 * Decisions: memory-bank/tasks/skill-levels-and-auto-enroll.md "Binding Reconciliation" (decision 4:
 * optimistic concurrency on the skill-level body) and the creative docs it references.
 */
import { z } from 'zod';
import { parseLocalDate } from '../time/time.ts';
import { SkillTier } from '../types/enums.ts';
import { ErrorResponse } from './errors.ts';
import { TeamMemberRow } from './teams.ts';

export const SKILL_LEVELS_FIELD_MESSAGES = {
  skillLevelRequired: 'Select a skill level.',
  untilInvalid: 'Choose today or a later date.',
  untilNeedsAutoEnroll: 'Clear the date to turn Auto Enroll off.',
  staleTokenInvalid: 'Reload the page and try again.',
} as const;

/** The level an admin sets. No default: a missing or unknown value is a field error, never a silent level. */
const SkillLevelField = z.enum(SkillTier, {
  error: SKILL_LEVELS_FIELD_MESSAGES.skillLevelRequired,
});

/** The hidden "what the panel was showing" token: not user-editable, so a bad value says to reload. */
const StaleLevelToken = z.enum(SkillTier, {
  error: SKILL_LEVELS_FIELD_MESSAGES.staleTokenInvalid,
});

/** A real calendar date as `YYYY-MM-DD` (the Pacific/Auckland wall date the admin picked). */
const UntilDate = z.string({ error: SKILL_LEVELS_FIELD_MESSAGES.untilInvalid }).refine(
  (value) => {
    try {
      parseLocalDate(value);
      return true;
    } catch {
      return false;
    }
  },
  { error: SKILL_LEVELS_FIELD_MESSAGES.untilInvalid },
);

/**
 * `PUT /teams/:teamId/members/:userId/skill-level`. `expectedSkillLevel` and `expectedChangedAt` are what the
 * panel was showing; the service compares both under the member-row lock and answers 409 `skill_level_stale`
 * with the current member when either differs (another admin saved, or the progression job promoted).
 * `expectedChangedAt` is the row's `skillChangedAt` exactly as the API returned it (UTC ISO instant), or
 * `null` when the level has never changed.
 */
export const SetSkillLevelRequest = z.strictObject({
  skillLevel: SkillLevelField,
  expectedSkillLevel: StaleLevelToken,
  expectedChangedAt: z.iso
    .datetime({ error: SKILL_LEVELS_FIELD_MESSAGES.staleTokenInvalid })
    .nullable(),
});
export type SetSkillLevelRequest = z.infer<typeof SetSkillLevelRequest>;

/**
 * `PUT /teams/:teamId/members/:userId/auto-enroll`. `until` is optional in meaning, not in shape: send `null`
 * for "no end date". `enabled: false` with a date is rejected so a client cannot leave an end date on an off
 * flag (the database forbids it too).
 */
export const SetAutoEnrollRequest = z
  .strictObject({
    enabled: z.boolean(),
    until: UntilDate.nullable(),
  })
  .superRefine((value, context) => {
    if (!value.enabled && value.until !== null) {
      context.addIssue({
        code: 'custom',
        path: ['until'],
        message: SKILL_LEVELS_FIELD_MESSAGES.untilNeedsAutoEnroll,
      });
    }
  });
export type SetAutoEnrollRequest = z.infer<typeof SetAutoEnrollRequest>;

/**
 * `200` for both routes: the member after the save, and whether anything changed. `changed: false` is a no-op
 * (the level the member already has, Auto Enroll off -> off, or an unchanged on -> on): nothing was written and
 * no event was logged, so the web can say "already ..." instead of claiming a change.
 */
export const MemberSkillChangeResponse = z.object({
  member: TeamMemberRow,
  changed: z.boolean(),
});
export type MemberSkillChangeResponse = z.infer<typeof MemberSkillChangeResponse>;

/**
 * `409` on `PUT .../skill-level`. With `skill_level_stale` (the panel's `expectedSkillLevel` or
 * `expectedChangedAt` no longer matches) the body also carries the current `member`, so the panel refreshes
 * without another request. `membership_state_conflict` carries no member.
 */
export const SkillLevelConflictResponse = ErrorResponse.extend({
  member: TeamMemberRow.optional(),
});
export type SkillLevelConflictResponse = z.infer<typeof SkillLevelConflictResponse>;
