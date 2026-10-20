/**
 * Lock prologue helpers for the sessions module (architecture SA-2). The canonical order, restated from ADR 0015,
 * ADR 0016 and C-ALL-1 and extended by ADR 0019, is
 *
 *   teams -> recurring_session_rules -> team_members -> game_sessions -> registrations -> registration_guests -> payments
 *
 * - `teams` only as `KEY SHARE` (`lockTeamKeyShare`, and the publish gate), never `FOR UPDATE` / `NO KEY UPDATE`.
 * - `recurring_session_rules` only `FOR NO KEY UPDATE` (`lockRule`): series edit and end, the materialiser's
 *   instance transaction, its bookkeeping stamp. Instance edits, publish, cancel and the allocator never lock rules.
 * - `team_members`: the actor re-check `FOR SHARE` (`assertSessionAdmin`) and the allocator's own member gates.
 * - `game_sessions` `FOR UPDATE` (`lockSession`, D-14), one row per transaction, except the series edit, which locks
 *   a rule's instances in `(date, id)` order under the rule lock (`lockRuleInstances`).
 * - Lower levels only through the allocator.
 *
 * The auto-enrol advisory lock (T-19) is the one lock outside this order: it is taken FIRST in its transaction,
 * before any row lock, and only `runSessionAutoEnrol` ever takes it.
 */
import { sql } from 'kysely';
import type { Selectable, Transaction } from 'kysely';
import { AppError } from '../../lib/http/errors.ts';
import type { DB, GameSessions, RecurringSessionRules } from '../../lib/db/types.generated.ts';
import { lockTeamRow } from '../teams/admin-lock.ts';

/** The documented acquisition order, for tests and for ADR 0019. */
export const LOCK_ORDER = [
  'teams',
  'recurring_session_rules',
  'team_members',
  'game_sessions',
  'registrations',
  'registration_guests',
  'payments',
] as const;

/**
 * First key of `pg_advisory_xact_lock(key1, key2)` for the per-session auto-enrol serialisation (T-19); the second
 * key is `hashtext(<session id>)`. An int4 ('SEAS'). Recorded in ADR 0019 so no other feature reuses the namespace.
 */
export const SESSION_AUTO_ENROL_LOCK_NAMESPACE = 0x5345_4153;

export type LockedSession = Selectable<GameSessions>;
export type LockedRule = Selectable<RecurringSessionRules>;

/** `teams FOR KEY SHARE`, explicitly first in every admin write; false when there is no such team. */
export function lockTeamKeyShare(trx: Transaction<DB>, teamId: string): Promise<boolean> {
  return lockTeamRow(trx, teamId, 'keyShare');
}

/**
 * The route guard ran outside this transaction, so re-check under a lock that the actor is still an approved
 * `TEAM_ADMIN`: `team_members(actor) FOR SHARE` conflicts with a demotion or ban of that actor, so the two
 * serialise. Takes no `teams` lock, so an admin write never waits on banking saves or moderation of other members.
 * A non-admin and an unknown team give the same 403 (no existence probe).
 */
export async function assertSessionAdmin(
  trx: Transaction<DB>,
  teamId: string,
  actorId: string,
): Promise<void> {
  const row = await trx
    .selectFrom('team_members')
    .select(['role', 'status'])
    .where('team_id', '=', teamId)
    .where('user_id', '=', actorId)
    .forShare()
    .executeTakeFirst();
  if (row?.status !== 'APPROVED' || row.role !== 'TEAM_ADMIN') throw new AppError('forbidden');
}

/** `recurring_session_rules FOR NO KEY UPDATE`, scoped to the team; undefined for another team's or a missing rule. */
export function lockRule(
  trx: Transaction<DB>,
  input: { readonly ruleId: string; readonly teamId: string },
): Promise<LockedRule | undefined> {
  return trx
    .selectFrom('recurring_session_rules')
    .selectAll()
    .where('id', '=', input.ruleId)
    .where('team_id', '=', input.teamId)
    .forNoKeyUpdate()
    .executeTakeFirst();
}

/** `SELECT … FROM game_sessions WHERE id = $1 FOR UPDATE` (D-14), scoped to the team. */
export function lockSession(
  trx: Transaction<DB>,
  input: { readonly sessionId: string; readonly teamId: string },
): Promise<LockedSession | undefined> {
  return trx
    .selectFrom('game_sessions')
    .selectAll()
    .where('id', '=', input.sessionId)
    .where('team_id', '=', input.teamId)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * Every instance of a rule, locked `FOR UPDATE` in `(date, id)` order. Only the series edit and end use it, under
 * the rule lock, so two multi-session writers of the same rule can never take the rows in opposite orders.
 */
export function lockRuleInstances(
  trx: Transaction<DB>,
  input: { readonly ruleId: string; readonly teamId: string },
): Promise<LockedSession[]> {
  return trx
    .selectFrom('game_sessions')
    .selectAll()
    .where('recurring_rule_id', '=', input.ruleId)
    .where('team_id', '=', input.teamId)
    .orderBy('date', 'asc')
    .orderBy('id', 'asc')
    .forUpdate()
    .execute();
}

/**
 * T-19: the FIRST statement of the auto-enrol follow-up transaction. Serialises the inline follow-up, the sweep and a
 * replayed `session-auto-enrol` job per session; released at COMMIT or ROLLBACK.
 */
export async function lockSessionAutoEnrol(trx: Transaction<DB>, sessionId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${SESSION_AUTO_ENROL_LOCK_NAMESPACE}, hashtext(${sessionId}::text))`.execute(
    trx,
  );
}
