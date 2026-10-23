/**
 * Queries of the sessions module. Every query that starts from a request id also filters by `team_id` from the path,
 * so a session of another team is simply not found. Readers take a `Database` (the pool or a transaction); the writes
 * run inside the service's locked transaction.
 */
import { sql, type Insertable, type Updateable } from 'kysely';
import type { ListSessionsQuery } from '@sgm/shared';
import type { Database } from '../../lib/db/kysely.ts';
import type { GameSessions } from '../../lib/db/types.generated.ts';
import { AppError } from '../../lib/http/errors.ts';
import type { StoredCourt } from './content.ts';
import { seriesNameOf } from './series-view.ts';
import type { CourtRow, SessionRow } from './view.ts';

export function findSession(
  db: Database,
  teamId: string,
  sessionId: string,
): Promise<SessionRow | undefined> {
  return db
    .selectFrom('game_sessions')
    .selectAll()
    .where('id', '=', sessionId)
    .where('team_id', '=', teamId)
    .executeTakeFirst();
}

/**
 * A plain existence read by id alone (no team filter, no lock): called only after a team-scoped read found nothing, to
 * tell "belongs to another team" (403, AC-ERROR-8) from "does not exist" (404).
 */
export async function sessionExists(db: Database, sessionId: string): Promise<boolean> {
  const row = await db
    .selectFrom('game_sessions')
    .select('id')
    .where('id', '=', sessionId)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * The team's series DRAFT dates a banking refusal left behind (a series date, not edited by an admin): the same rule as
 * `draftReasonOf` = 'banking', counted across the whole team and not one page of it.
 */
export async function countBankingDrafts(db: Database, teamId: string): Promise<number> {
  const row = await db
    .selectFrom('game_sessions')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('team_id', '=', teamId)
    .where('status', '=', 'DRAFT')
    .where('recurring_rule_id', 'is not', null)
    .where('is_instance_overridden', '=', false)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export function findSessionByCreateKey(
  db: Database,
  teamId: string,
  createKey: string,
): Promise<SessionRow | undefined> {
  return db
    .selectFrom('game_sessions')
    .selectAll()
    .where('team_id', '=', teamId)
    .where('create_key', '=', createKey)
    .executeTakeFirst();
}

export function listCourts(db: Database, sessionId: string): Promise<CourtRow[]> {
  return db
    .selectFrom('session_courts')
    .select(['id', 'court_identifier', 'start_time', 'end_time'])
    .where('session_id', '=', sessionId)
    .execute();
}

export async function listCourtsFor(
  db: Database,
  sessionIds: readonly string[],
): Promise<Map<string, CourtRow[]>> {
  const grouped = new Map<string, CourtRow[]>(sessionIds.map((id) => [id, []]));
  if (sessionIds.length === 0) return grouped;
  const rows = await db
    .selectFrom('session_courts')
    .select(['id', 'session_id', 'court_identifier', 'start_time', 'end_time'])
    .where('session_id', 'in', [...sessionIds])
    .execute();
  for (const { session_id: sessionId, ...court } of rows) grouped.get(sessionId)?.push(court);
  return grouped;
}

/**
 * Players with a CONFIRMED or WAITLISTED registration: the count behind "N players are registered" and the fee lock.
 * Read-only. The database function `game_session_has_active_registrations` (D-85) holds the same definition for the
 * raw-SQL backstop; registration-and-waitlist widens both to withdrawals with a fee due (ALG R-a, binding T-17).
 */
export async function countActiveRegistrations(
  db: Database,
  sessionIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>(sessionIds.map((id) => [id, 0]));
  if (sessionIds.length === 0) return counts;
  const rows = await db
    .selectFrom('registrations')
    .select(['session_id', (eb) => eb.fn.countAll<string>().as('n')])
    .where('session_id', 'in', [...sessionIds])
    .where('status', 'in', ['CONFIRMED', 'WAITLISTED'])
    .groupBy('session_id')
    .execute();
  for (const row of rows) counts.set(row.session_id, Number(row.n));
  return counts;
}

export async function readPayoutConfigured(db: Database, teamId: string): Promise<boolean> {
  const row = await db
    .selectFrom('teams')
    .select('is_payout_configured')
    .where('id', '=', teamId)
    .executeTakeFirst();
  return row?.is_payout_configured === true;
}

/** `INSERT … ON CONFLICT (team_id, create_key) DO NOTHING RETURNING id`: undefined when the key was already used. */
export async function insertSession(
  db: Database,
  values: Insertable<GameSessions>,
): Promise<string | undefined> {
  const row = await db
    .insertInto('game_sessions')
    .values(values)
    .onConflict((conflict) => conflict.columns(['team_id', 'create_key']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return row?.id;
}

export async function insertCourts(
  db: Database,
  sessionId: string,
  courts: readonly StoredCourt[],
): Promise<void> {
  if (courts.length === 0) return;
  await db
    .insertInto('session_courts')
    .values(
      courts.map((court) => ({
        session_id: sessionId,
        court_identifier: court.identifier,
        start_time: court.startTime as never,
        end_time: court.endTime as never,
      })),
    )
    .execute();
}

/**
 * Makes the stored courts equal `next` without ever leaving the session with none (a PUBLISHED session must keep its
 * instants): rows kept by name are updated in place, new names are inserted, then the removed ones are deleted.
 */
export async function syncCourts(
  db: Database,
  sessionId: string,
  current: readonly CourtRow[],
  next: readonly StoredCourt[],
): Promise<void> {
  const trim = (time: string): string => time.slice(0, 5);
  const byName = new Map(current.map((court) => [court.court_identifier, court]));
  const wanted = new Set(next.map((court) => court.identifier));

  for (const court of next) {
    const stored = byName.get(court.identifier);
    if (stored === undefined) continue;
    if (trim(stored.start_time) === court.startTime && trim(stored.end_time) === court.endTime)
      continue;
    await db
      .updateTable('session_courts')
      .set({ start_time: court.startTime as never, end_time: court.endTime as never })
      .where('id', '=', stored.id)
      .execute();
  }
  await insertCourts(
    db,
    sessionId,
    next.filter((court) => !byName.has(court.identifier)),
  );
  const removed = current.filter((court) => !wanted.has(court.court_identifier)).map((c) => c.id);
  if (removed.length > 0) {
    await db.deleteFrom('session_courts').where('id', 'in', removed).execute();
  }
}

export async function updateSession(
  db: Database,
  sessionId: string,
  values: Updateable<GameSessions>,
): Promise<void> {
  await db.updateTable('game_sessions').set(values).where('id', '=', sessionId).execute();
}

/** The guarded publish: succeeds only while the row is still a DRAFT. Returns whether it changed a row. */
export async function publishDraft(
  db: Database,
  sessionId: string,
  values: Updateable<GameSessions>,
): Promise<boolean> {
  const result = await db
    .updateTable('game_sessions')
    .set({ ...values, status: 'PUBLISHED' })
    .where('id', '=', sessionId)
    .where('status', '=', 'DRAFT')
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/** The guarded cancel: succeeds only while the row is still the status the caller locked. */
export async function cancelFrom(
  db: Database,
  sessionId: string,
  from: 'DRAFT' | 'PUBLISHED',
  values: Updateable<GameSessions>,
): Promise<boolean> {
  const result = await db
    .updateTable('game_sessions')
    .set({ ...values, status: 'CANCELLED' })
    .where('id', '=', sessionId)
    .where('status', '=', from)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

// ---------------------------------------------------------------------------------------------
// The admin list (keyset paged)
// ---------------------------------------------------------------------------------------------

/** Rows sort by when they start; a session with no court yet falls back to when it was made. */
// Truncated to milliseconds so the keyset cursor (a JavaScript Date) compares exactly.
const SORT_AT = sql<Date>`date_trunc('milliseconds', coalesce(starts_at, created_at))`;

/** Canonical 8-4-4-4-12 hex, so nothing that Postgres would reject as a uuid reaches the query. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Cursor {
  readonly at: string;
  readonly id: string;
}

export function encodeCursor(row: Pick<SessionRow, 'id' | 'starts_at' | 'created_at'>): string {
  const at = (row.starts_at ?? row.created_at).toISOString();
  return Buffer.from(JSON.stringify({ at, id: row.id } satisfies Cursor)).toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    const at = typeof parsed.at === 'string' ? new Date(parsed.at) : undefined;
    if (
      at === undefined ||
      Number.isNaN(at.getTime()) ||
      typeof parsed.id !== 'string' ||
      !UUID_PATTERN.test(parsed.id)
    ) {
      throw new Error('shape');
    }
    return { at: at.toISOString(), id: parsed.id };
  } catch {
    throw new AppError('validation_failed', { fieldErrors: { cursor: ['Invalid page cursor.'] } });
  }
}

/**
 * One section of the list, `limit` rows after `cursor`, plus the cursor of the next page (null at the end).
 * upcoming: PUBLISHED and not ended, soonest first. drafts: DRAFT with a future start, soonest first.
 * past: COMPLETED, CANCELLED, PUBLISHED that has ended and DRAFT whose start passed, most recent first.
 */
export async function listSessionsPage(
  db: Database,
  input: {
    readonly teamId: string;
    readonly view: ListSessionsQuery['view'];
    readonly now: Date;
    readonly limit: number;
    readonly cursor: string | undefined;
  },
): Promise<{ rows: SessionRow[]; nextCursor: string | null }> {
  const { now } = input;
  let query = db.selectFrom('game_sessions').selectAll().where('team_id', '=', input.teamId);

  if (input.view === 'upcoming') {
    query = query
      .where('status', '=', 'PUBLISHED')
      .where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', now)]));
  } else if (input.view === 'drafts') {
    query = query
      .where('status', '=', 'DRAFT')
      .where((eb) => eb.or([eb('starts_at', 'is', null), eb('starts_at', '>', now)]));
  } else {
    query = query.where((eb) =>
      eb.or([
        eb('status', 'in', ['COMPLETED', 'CANCELLED']),
        eb.and([eb('status', '=', 'PUBLISHED'), eb('ends_at', '<=', now)]),
        eb.and([eb('status', '=', 'DRAFT'), eb('starts_at', '<=', now)]),
      ]),
    );
  }

  const descending = input.view === 'past';
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(input.cursor);
    query = query.where(
      descending
        ? sql<boolean>`(${SORT_AT}, id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
        : sql<boolean>`(${SORT_AT}, id) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
    );
  }
  const fetched = await query
    .orderBy(SORT_AT, (order) => (descending ? order.desc() : order.asc()))
    .orderBy('id', (order) => (descending ? order.desc() : order.asc()))
    .limit(input.limit + 1)
    .execute();
  const rows = fetched.slice(0, input.limit);
  const last = rows.at(-1);
  return {
    rows,
    nextCursor: fetched.length > input.limit && last !== undefined ? encodeCursor(last) : null,
  };
}

/**
 * The pattern and location of the rules behind a page of sessions, keyed by rule id: one query for the whole page, so a
 * list never reads a rule per row. Team-scoped like every other read.
 */
export async function listRuleNames(
  db: Database,
  teamId: string,
  ruleIds: readonly string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (ruleIds.length === 0) return names;
  const rows = await db
    .selectFrom('recurring_session_rules')
    .select(['id', 'frequency', 'day_of_week', 'monthly_week', 'default_location'])
    .where('team_id', '=', teamId)
    .where('id', 'in', [...ruleIds])
    .execute();
  for (const row of rows) names.set(row.id, seriesNameOf(row));
  return names;
}
