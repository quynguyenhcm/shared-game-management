/**
 * C-SKL-1 (ADR 0017): the auto-enrol selection seam consumed by session-scheduling-engine's materialiser.
 *
 * A plain SELECT that takes NO row locks, so the caller keeps the canonical lock order
 * `teams -> team_members -> game_sessions` and the allocator's `assertApprovedMember` (plus its re-check of the
 * Auto Enroll columns under the member-row lock) remains the authoritative gate. A LEAF file: it imports only
 * `lib/`, `kysely` and `@sgm/shared` (enforced by `boundaries.test.ts`).
 */
import { sql } from 'kysely';
import type { LocalDate } from '@sgm/shared';
import type { Database } from '../../lib/db/kysely.ts';

export interface AutoEnrollee {
  /** What `allocator.autoEnrolInSession` takes, in the returned order. */
  readonly userId: string;
  /** For the caller's logs; never needed for the allocator call. */
  readonly membershipId: string;
  /** `auto_enroll_assigned_at` (UTC): the order key. */
  readonly assignedAt: Date;
}

/**
 * Approved members of `teamId` with Auto Enroll on and not ended on `sessionDate`, ordered
 * `auto_enroll_assigned_at ASC, id ASC`. `until` is inclusive (a member with `until = 30 Nov` is selected for a
 * 30 Nov session, not for 1 Dec); an expired row stays flagged and simply stops matching. `db` may be the pool
 * handle or the caller's transaction. `sessionDate` is the session's `game_sessions.date` (a Pacific/Auckland
 * calendar date), never derived from `starts_at`.
 */
export async function selectAutoEnrollees(
  db: Database,
  input: { readonly teamId: string; readonly sessionDate: LocalDate },
): Promise<readonly AutoEnrollee[]> {
  const rows = await db
    .selectFrom('team_members')
    .select(['user_id', 'id', 'auto_enroll_assigned_at'])
    .where('team_id', '=', input.teamId)
    .where('status', '=', 'APPROVED')
    .where('is_auto_enroll', '=', true)
    .where((eb) =>
      eb.or([
        eb('auto_enroll_until', 'is', null),
        eb('auto_enroll_until', '>=', sql<LocalDate>`${input.sessionDate}::date`),
      ]),
    )
    .orderBy('auto_enroll_assigned_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows.map((row) => ({
    userId: row.user_id,
    membershipId: row.id,
    // The CHECK team_members_auto_enroll_assigned guarantees a time whenever the flag is on.
    assignedAt: row.auto_enroll_assigned_at as Date,
  }));
}
