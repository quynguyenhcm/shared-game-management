/**
 * Refusal codes for the skill-levels admin routes and the database errors they map from (mirrors
 * `team-banking/errors.ts`: keyed on SQLSTATE plus `err.constraint`, never on message text).
 */
import type { TeamMemberRow } from '@sgm/shared';
import { AppError } from '../../lib/http/errors.ts';

/** SQLSTATE `lock_not_available`: the 2 s `lock_timeout` of an admin save expired behind another writer. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * 409 `skill_level_stale` (Binding Reconciliation decision 4) or `auto_enroll_stale` (final review): the save was
 * based on a view of the member that is no longer current. Carries the current member so the route can answer
 * with it and the panel refreshes.
 */
export class MemberStaleError extends AppError {
  readonly member: TeamMemberRow;

  constructor(code: 'skill_level_stale' | 'auto_enroll_stale', member: TeamMemberRow) {
    super(code);
    this.name = 'MemberStaleError';
    this.member = member;
  }
}

/** An `AppError` for a known database refusal on these routes, otherwise the error unchanged. */
export function mapSkillLevelsDbError(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof AppError) return error;
  const { code, constraint } = error as Error & { code?: unknown; constraint?: unknown };
  // Retryable: the save waited too long for the team or member row and wrote nothing.
  if (code === LOCK_NOT_AVAILABLE) return new AppError('service_unavailable', { cause: error });
  // Backstop for a ban that slipped past the row lock: Auto Enroll exists only on APPROVED rows (D-59).
  if (code === '23514' && constraint === 'team_members_auto_enroll_approved_only') {
    return new AppError('membership_state_conflict', { cause: error });
  }
  return error;
}
