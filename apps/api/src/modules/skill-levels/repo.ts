/**
 * Kysely writes for the skill-levels admin saves. The service decides; this file locks and writes rows. Lock order
 * is the moderation shape: the caller has already locked the team row (`assertTeamAdminUnderLock`), then this file
 * locks the member row `FOR NO KEY UPDATE` (no key column changes; it still conflicts with the ban, a second save,
 * the progression job and `assertApprovedMember`'s `FOR SHARE`). Every timestamp is a `Date` from the injected
 * clock, never SQL `now()`, so what is stored is exactly the millisecond instant the API returns.
 */
import type { MembershipStatus, SkillTier } from '@sgm/shared';
import type { Database } from '../../lib/db/kysely.ts';
import type { AutoEnrolState } from './decisions.ts';

export interface LockedMember {
  readonly id: string;
  readonly status: MembershipStatus;
  readonly skillLevel: SkillTier;
  readonly changedAt: Date | null;
  readonly autoEnroll: AutoEnrolState;
}

/** The member row of `(teamId, userId)` locked for the rest of the transaction; `undefined` when there is none. */
export async function lockMemberRow(
  trx: Database,
  teamId: string,
  userId: string,
): Promise<LockedMember | undefined> {
  const row = await trx
    .selectFrom('team_members')
    .select([
      'id',
      'status',
      'skill_level',
      'skill_level_changed_at',
      'is_auto_enroll',
      'auto_enroll_until',
      'auto_enroll_assigned_at',
    ])
    .where('team_id', '=', teamId)
    .where('user_id', '=', userId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    id: row.id,
    status: row.status,
    skillLevel: row.skill_level,
    changedAt: row.skill_level_changed_at,
    autoEnroll: {
      enabled: row.is_auto_enroll,
      until: row.auto_enroll_until,
      assignedAt: row.auto_enroll_assigned_at,
    },
  };
}

/**
 * An admin override: the level, who and when, and the counting baseline, all from the one `now`
 * (`team_members_changed_after_override` holds with equality). Guarded on APPROVED; false when the row no longer
 * matches (unreachable while the caller holds the row lock).
 */
export async function applyOverride(
  trx: Database,
  membershipId: string,
  change: { readonly to: SkillTier; readonly actorId: string; readonly now: Date },
): Promise<boolean> {
  const result = await trx
    .updateTable('team_members')
    .set({
      skill_level: change.to,
      skill_level_override_by: change.actorId,
      skill_level_override_at: change.now,
      skill_level_changed_at: change.now,
    })
    .where('id', '=', membershipId)
    .where('status', '=', 'APPROVED')
    .executeTakeFirst();
  return result.numUpdatedRows > 0n;
}

/** Writes the three Auto Enroll columns together (the CHECKs pair them). Guarded on APPROVED, like the override. */
export async function applyAutoEnrol(
  trx: Database,
  membershipId: string,
  next: AutoEnrolState,
): Promise<boolean> {
  const result = await trx
    .updateTable('team_members')
    .set({
      is_auto_enroll: next.enabled,
      auto_enroll_until: next.until,
      auto_enroll_assigned_at: next.assignedAt,
    })
    .where('id', '=', membershipId)
    .where('status', '=', 'APPROVED')
    .executeTakeFirst();
  return result.numUpdatedRows > 0n;
}
