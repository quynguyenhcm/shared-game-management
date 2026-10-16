/**
 * "Qualifying game" (C-GAME-1, ADR 0017), defined once. A game for member M of team T at time `now` is a
 * `registrations` row with `team_id = T`, `user_id = M` and `status = 'CONFIRMED'`, joined to the team's
 * `game_sessions` row with `status = 'COMPLETED'` and `ends_at` in
 * `(greatest(now - SKILL_PROGRESSION_WINDOW_MS, skill_level_changed_at), now]`.
 *
 * - Guests, party size and payment state are irrelevant: one registration is one game.
 * - No-shows count (no attendance data exists); charged late withdrawals do not (they are WITHDRAWN).
 * - The window start is computed here and bound as a parameter (P3: never a SQL day interval or `now()`
 *   in SQL); a NULL baseline means "no lower bound beyond the window".
 *
 * `qualifyingGamesQuery` is the ONE predicate builder. The single-member count, the per-page batch count and
 * (Phase 4) the progression sweep's pre-pass are all this query, so they cannot drift apart. Everything here is
 * a plain read: no row locks, and callers may pass their transaction.
 *
 * This file is a LEAF (imports only `lib/`, `kysely` and `@sgm/shared`): `teams/member-read.ts` embeds it in the
 * Members read model, so it must never import from `teams` (enforced by `boundaries.test.ts`).
 */
import { sql } from 'kysely';
import { SKILL_PROGRESSION_WINDOW_MS } from '@sgm/shared';
import type { Database } from '../../lib/db/kysely.ts';

export interface QualifyingGamesInput {
  readonly teamId: string;
  readonly userIds: readonly string[];
  readonly now: Date;
}

/** Qualifying-game counts per member of `userIds` in one grouped query (members with no game have no row). */
export function qualifyingGamesQuery(db: Database, input: QualifyingGamesInput) {
  const windowStart = new Date(input.now.getTime() - SKILL_PROGRESSION_WINDOW_MS);
  return db
    .selectFrom('team_members as tm')
    .innerJoin('registrations as r', (join) =>
      join
        .onRef('r.team_id', '=', 'tm.team_id')
        .onRef('r.user_id', '=', 'tm.user_id')
        .on('r.status', '=', 'CONFIRMED'),
    )
    .innerJoin('game_sessions as s', (join) =>
      join
        .onRef('s.id', '=', 'r.session_id')
        .onRef('s.team_id', '=', 'r.team_id')
        .on('s.status', '=', 'COMPLETED'),
    )
    .where('tm.team_id', '=', input.teamId)
    .where('tm.user_id', 'in', input.userIds)
    .where('s.ends_at', '<=', input.now)
    .where(
      sql<boolean>`s.ends_at > greatest(${windowStart}::timestamptz, coalesce(tm.skill_level_changed_at, '-infinity'::timestamptz))`,
    )
    .select('tm.user_id')
    .select((eb) => eb.fn.countAll<string>().as('games'))
    .groupBy('tm.user_id');
}

/** Qualifying games per user for one page of members (up to 50) in a single query; absent users count 0. */
export async function countQualifyingGamesBatch(
  db: Database,
  input: QualifyingGamesInput,
): Promise<ReadonlyMap<string, number>> {
  if (input.userIds.length === 0) return new Map();
  const rows = await qualifyingGamesQuery(db, input).execute();
  const counts = new Map<string, number>(input.userIds.map((userId) => [userId, 0]));
  for (const row of rows) counts.set(row.user_id, Number(row.games));
  return counts;
}

/** Qualifying games for one member: the authoritative count the progression job recounts under its lock. */
export async function countQualifyingGames(
  db: Database,
  input: { readonly teamId: string; readonly userId: string; readonly now: Date },
): Promise<number> {
  const counts = await countQualifyingGamesBatch(db, {
    teamId: input.teamId,
    userIds: [input.userId],
    now: input.now,
  });
  return counts.get(input.userId) ?? 0;
}
