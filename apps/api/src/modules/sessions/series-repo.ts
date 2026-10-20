/**
 * Queries of the series use cases: the rule, its court template and its instances. Every query that starts from a request id
 * also filters by `team_id` from the path, so another team's series is simply not found. Reads take a `Database` (the pool or a
 * transaction); the writes run inside the series use case's locked transaction.
 */
import type { Insertable, Updateable } from 'kysely';
import type { LocalDate } from '@sgm/shared';
import type { Database } from '../../lib/db/kysely.ts';
import type { RecurringSessionRules } from '../../lib/db/types.generated.ts';
import type { StoredCourt } from './content.ts';
import type { LockedRule } from './locks.ts';
import type { RuleCourtRow } from './series-view.ts';
import type { SessionRow } from './view.ts';

export function findRule(
  db: Database,
  teamId: string,
  ruleId: string,
): Promise<LockedRule | undefined> {
  return db
    .selectFrom('recurring_session_rules')
    .selectAll()
    .where('id', '=', ruleId)
    .where('team_id', '=', teamId)
    .executeTakeFirst();
}

/** The team's series, active first, then oldest first (a stable order for the Sessions page's Series section). */
export function listRules(db: Database, teamId: string): Promise<LockedRule[]> {
  return db
    .selectFrom('recurring_session_rules')
    .selectAll()
    .where('team_id', '=', teamId)
    .orderBy('is_active', 'desc')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
}

export function findRuleByCreateKey(
  db: Database,
  teamId: string,
  createKey: string,
): Promise<LockedRule | undefined> {
  return db
    .selectFrom('recurring_session_rules')
    .selectAll()
    .where('team_id', '=', teamId)
    .where('create_key', '=', createKey)
    .executeTakeFirst();
}

export function listRuleCourts(db: Database, ruleId: string): Promise<RuleCourtRow[]> {
  return db
    .selectFrom('recurring_rule_courts')
    .select(['court_identifier', 'start_time', 'end_time', 'position'])
    .where('rule_id', '=', ruleId)
    .orderBy('position', 'asc')
    .execute();
}

/** `INSERT … ON CONFLICT (team_id, create_key) DO NOTHING RETURNING id`: undefined when the key was already used. */
export async function insertRule(
  db: Database,
  values: Insertable<RecurringSessionRules>,
): Promise<string | undefined> {
  const row = await db
    .insertInto('recurring_session_rules')
    .values(values)
    .onConflict((conflict) => conflict.columns(['team_id', 'create_key']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return row?.id;
}

/** The template courts, in the order given (`position` 1..n). The "active rule has a court" check runs at COMMIT. */
export async function insertRuleCourts(
  db: Database,
  ruleId: string,
  courts: readonly StoredCourt[],
): Promise<void> {
  if (courts.length === 0) return;
  await db
    .insertInto('recurring_rule_courts')
    .values(
      courts.map((court, index) => ({
        rule_id: ruleId,
        position: index + 1,
        court_identifier: court.identifier,
        start_time: court.startTime as never,
        end_time: court.endTime as never,
      })),
    )
    .execute();
}

export async function replaceRuleCourts(
  db: Database,
  ruleId: string,
  courts: readonly StoredCourt[],
): Promise<void> {
  await db.deleteFrom('recurring_rule_courts').where('rule_id', '=', ruleId).execute();
  await insertRuleCourts(db, ruleId, courts);
}

export async function updateRule(
  db: Database,
  ruleId: string,
  values: Updateable<RecurringSessionRules>,
): Promise<void> {
  await db.updateTable('recurring_session_rules').set(values).where('id', '=', ruleId).execute();
}

/**
 * The rule's instances dated on or after `from` (or strictly after it), in `(date, id)` order, read WITHOUT a lock: the
 * candidate list. The use case locks each one it will change and decides again on the locked row.
 */
export function listInstances(
  db: Database,
  input: {
    readonly ruleId: string;
    readonly teamId: string;
    readonly from: LocalDate;
    readonly inclusive: boolean;
  },
): Promise<SessionRow[]> {
  return db
    .selectFrom('game_sessions')
    .selectAll()
    .where('recurring_rule_id', '=', input.ruleId)
    .where('team_id', '=', input.teamId)
    .where('date', input.inclusive ? '>=' : '>', input.from)
    .orderBy('date', 'asc')
    .orderBy('id', 'asc')
    .execute();
}

/** Unedited, not-started PUBLISHED instances of a rule, unlocked: the input to the "could this make one paid" gate decision. */
export function listPublishedTargets(
  db: Database,
  input: { readonly ruleId: string; readonly teamId: string; readonly now: Date },
): Promise<
  Pick<
    SessionRow,
    | 'pricing_structure'
    | 'fee_flat'
    | 'fee_male'
    | 'fee_female'
    | 'fee_other'
    | 'fee_beginner'
    | 'fee_intermediate'
    | 'fee_advanced'
  >[]
> {
  return db
    .selectFrom('game_sessions')
    .select([
      'pricing_structure',
      'fee_flat',
      'fee_male',
      'fee_female',
      'fee_other',
      'fee_beginner',
      'fee_intermediate',
      'fee_advanced',
    ])
    .where('recurring_rule_id', '=', input.ruleId)
    .where('team_id', '=', input.teamId)
    .where('status', '=', 'PUBLISHED')
    .where('is_instance_overridden', '=', false)
    .where('starts_at', '>', input.now)
    .execute();
}

/** The guarded delete of an unedited DRAFT (the database allows deleting nothing else). */
export async function deleteDraft(db: Database, sessionId: string): Promise<boolean> {
  const result = await db
    .deleteFrom('game_sessions')
    .where('id', '=', sessionId)
    .where('status', '=', 'DRAFT')
    .executeTakeFirst();
  return result.numDeletedRows === 1n;
}

/** The most instances the series page lists. */
export const SERIES_INSTANCE_LIMIT = 100;

/**
 * The series page's instances, unlocked: dated today or later, plus any DRAFT (a past draft still needs the admin), soonest
 * first, capped at `SERIES_INSTANCE_LIMIT`.
 */
export function listSeriesPageInstances(
  db: Database,
  input: { readonly ruleId: string; readonly teamId: string; readonly today: LocalDate },
): Promise<SessionRow[]> {
  return db
    .selectFrom('game_sessions')
    .selectAll()
    .where('recurring_rule_id', '=', input.ruleId)
    .where('team_id', '=', input.teamId)
    .where((eb) => eb.or([eb('date', '>=', input.today), eb('status', '=', 'DRAFT')]))
    .orderBy('date', 'asc')
    .orderBy('id', 'asc')
    .limit(SERIES_INSTANCE_LIMIT)
    .execute();
}

/** All of the rule's DRAFT instances by reason: banking (not edited) and edited. */
export async function countRuleDrafts(
  db: Database,
  input: { readonly ruleId: string; readonly teamId: string },
): Promise<{ banking: number; edited: number }> {
  const rows = await db
    .selectFrom('game_sessions')
    .select(['is_instance_overridden', (eb) => eb.fn.countAll<string>().as('n')])
    .where('recurring_rule_id', '=', input.ruleId)
    .where('team_id', '=', input.teamId)
    .where('status', '=', 'DRAFT')
    .groupBy('is_instance_overridden')
    .execute();
  const counts = { banking: 0, edited: 0 };
  for (const row of rows) counts[row.is_instance_overridden ? 'edited' : 'banking'] = Number(row.n);
  return counts;
}
