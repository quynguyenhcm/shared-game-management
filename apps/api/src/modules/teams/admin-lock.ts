/**
 * The teams module's public lock and authority helpers, used by every module that mutates team-scoped state under
 * the per-team mutex (team-banking-and-gst Architecture "Shared code"; ADR 0015). Other modules import this file,
 * never `repo.ts`, so they cannot reach the invite code (`repo.lockTeam` selects it, `lockTeamRow` does not).
 *
 * Lock modes, strongest first: `update` (FOR UPDATE; leaf transactions only: invite regenerate, banking removal),
 * `noKeyUpdate` (the moderation and banking-write mutex; does not block foreign-key inserts), `share`, `keyShare`.
 */
import type { TeamRole } from '@sgm/shared';
import type { Database } from '../../lib/db/kysely.ts';
import { AppError } from '../../lib/http/errors.ts';

export type TeamLockMode = 'keyShare' | 'share' | 'noKeyUpdate' | 'update';

/** The caller's role when (and only when) approved: the authority re-check inside a locked transaction. */
export async function findApprovedRole(
  db: Database,
  teamId: string,
  userId: string,
): Promise<TeamRole | undefined> {
  const row = await db
    .selectFrom('team_members')
    .select('role')
    .where('team_id', '=', teamId)
    .where('user_id', '=', userId)
    .where('status', '=', 'APPROVED')
    .executeTakeFirst();
  return row?.role;
}

/** Locks the team row (selecting only its id) for the rest of the transaction; false when there is no such team. */
export async function lockTeamRow(
  trx: Database,
  teamId: string,
  mode: TeamLockMode,
): Promise<boolean> {
  const query = trx.selectFrom('teams').select('id').where('id', '=', teamId);
  const locked =
    mode === 'keyShare'
      ? query.forKeyShare()
      : mode === 'share'
        ? query.forShare()
        : mode === 'noKeyUpdate'
          ? query.forNoKeyUpdate()
          : query.forUpdate();
  return (await locked.executeTakeFirst()) !== undefined;
}

/**
 * Locks the team row FIRST, then re-checks under that lock that `actorId` is still an approved `TEAM_ADMIN`: the
 * route guard ran outside this transaction, so a demotion or ban that committed since is caught here. A missing
 * team and a non-admin give the same 403 (no existence probe).
 */
export async function assertTeamAdminUnderLock(
  trx: Database,
  teamId: string,
  actorId: string,
  mode: 'noKeyUpdate' | 'update',
): Promise<void> {
  if (!trx.isTransaction) {
    throw new Error('assertTeamAdminUnderLock must run inside a transaction');
  }
  if (!(await lockTeamRow(trx, teamId, mode))) throw new AppError('forbidden');
  if ((await findApprovedRole(trx, teamId, actorId)) !== 'TEAM_ADMIN') {
    throw new AppError('forbidden');
  }
}
