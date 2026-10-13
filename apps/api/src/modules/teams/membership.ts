/**
 * The approved-member gate (Architecture 1B, ADR 0015): the contract registration-and-waitlist and auto-enrol call
 * to deliver "a banned member cannot register" without this feature touching registration code.
 */
import type { Transaction } from 'kysely';
import type { SkillTier, TeamRole } from '@sgm/shared';
import type { DB } from '../../lib/db/types.generated.ts';
import { AppError } from '../../lib/http/errors.ts';

export interface ApprovedMembership {
  readonly membershipId: string;
  readonly role: TeamRole;
  /** The self-assessed level, for `BY_SKILL_LEVEL` pricing in the same transaction. */
  readonly skillLevel: SkillTier;
}

/**
 * Throws `forbidden` unless `userId` is an APPROVED member of `teamId`.
 *
 * Contract (ADR 0015): call it INSIDE your registration or auto-enrol transaction, BEFORE that transaction takes
 * any `game_sessions` lock (canonical lock order: teams, team_members, game_sessions, registrations). It holds the
 * `team_members` row `FOR SHARE` until COMMIT, so a concurrent ban (a row `UPDATE`) waits for it and vice versa:
 * a registration either commits before the ban, where the ban's job will see it, or waits, reads `BANNED` and is
 * refused. There is no status predicate in the query: the row is locked whatever its state, and the status is read
 * from the version returned after any wait. It assumes READ COMMITTED (the project default); under a stricter
 * isolation level a concurrent ban surfaces as SQLSTATE 40001 and the caller must retry.
 */
export async function assertApprovedMember(
  trx: Transaction<DB>,
  teamId: string,
  userId: string,
): Promise<ApprovedMembership> {
  if (!trx.isTransaction) {
    throw new Error('assertApprovedMember must run inside a transaction');
  }
  const row = await trx
    .selectFrom('team_members')
    .select(['id', 'role', 'status', 'skill_level'])
    .where('team_id', '=', teamId)
    .where('user_id', '=', userId)
    .forShare()
    .executeTakeFirst();
  if (row === undefined || row.status !== 'APPROVED') throw new AppError('forbidden');
  return { membershipId: row.id, role: row.role, skillLevel: row.skill_level };
}
