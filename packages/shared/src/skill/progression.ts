/**
 * The automatic skill-progression rule, defined once (skill-levels-and-auto-enroll, AC-VERIFY-4).
 *
 * A member moves up one level (`BEGINNER` -> `INTERMEDIATE` -> `ADVANCED`) when they have
 * `SKILL_PROGRESSION_GAMES` qualifying games in the trailing `SKILL_PROGRESSION_WINDOW_DAYS` days that also
 * ended after their last level change. The job, the Members list progress line and the web copy all read
 * these constants and this function; the literals 40 and 365 must not appear for this rule anywhere else
 * (a repo-wide guard test enforces it).
 *
 * These are product rules, not deployment configuration (P7 does not apply): tests and UI copy must agree
 * with them, which an environment variable could not guarantee. Decision record:
 * memory-bank/creative/skill-levels-and-auto-enroll-progression-algorithm.md (Q6, option 6A).
 */
import { SkillTier } from '../types/enums.ts';

/** Qualifying games needed to move up one level. */
export const SKILL_PROGRESSION_GAMES = 40;
/** The trailing window games are counted in, in days. */
export const SKILL_PROGRESSION_WINDOW_DAYS = 365;
/** The same window as an absolute duration (P3: it is an interval on `ends_at`, not a calendar year). */
export const SKILL_PROGRESSION_WINDOW_MS = SKILL_PROGRESSION_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** `BEGINNER` -> `INTERMEDIATE` -> `ADVANCED` -> `null` (there is no level above `ADVANCED`). */
export function nextSkillLevel(level: SkillTier): SkillTier | null {
  const index = SkillTier.indexOf(level);
  return SkillTier[index + 1] ?? null;
}

export type ProgressionDecision =
  | { readonly kind: 'promote'; readonly from: SkillTier; readonly to: SkillTier }
  | { readonly kind: 'none'; readonly reason: 'highest_level' | 'below_threshold' };

/**
 * One level up when `games` has reached the threshold, never more than one per decision (surplus games
 * are discarded by the baseline reset that follows a promotion) and never down.
 */
export function decideProgression(input: {
  readonly level: SkillTier;
  readonly games: number;
}): ProgressionDecision {
  const to = nextSkillLevel(input.level);
  if (to === null) return { kind: 'none', reason: 'highest_level' };
  if (input.games < SKILL_PROGRESSION_GAMES) return { kind: 'none', reason: 'below_threshold' };
  return { kind: 'promote', from: input.level, to };
}

/** The Members row progress line: games toward `nextLevel`, out of `required`. */
export interface SkillProgress {
  readonly games: number;
  readonly required: number;
  readonly nextLevel: SkillTier;
}

/**
 * What the Members row shows for an APPROVED member: `games` of `required` toward `nextLevel`, capped at the
 * threshold (a member who reached it waits for the next daily run; the line never reads more than the
 * threshold). `null` at the highest level ("Highest level"). `games` must come from the same count the
 * progression job uses (`countQualifyingGames`), so the line matches what the next run decides.
 */
export function toSkillProgress(level: SkillTier, games: number): SkillProgress | null {
  const nextLevel = nextSkillLevel(level);
  if (nextLevel === null) return null;
  return {
    games: Math.min(Math.max(games, 0), SKILL_PROGRESSION_GAMES),
    required: SKILL_PROGRESSION_GAMES,
    nextLevel,
  };
}
