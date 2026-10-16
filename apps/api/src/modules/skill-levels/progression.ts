/**
 * One member's automatic progression, in one transaction (progression-algorithm creative doc, Binding
 * Reconciliation "Job"). The `skill-progression` sweep calls this per candidate; it never trusts what the
 * read-only pre-pass saw:
 *
 *   1. `SET LOCAL lock_timeout = '5s'` (a member whose row stays locked fails alone; the sweep continues),
 *   2. the member row `FOR NO KEY UPDATE` (never the team row: the job takes no team lock, so it cannot
 *      deadlock with the moderation shape teams -> team_members),
 *   3. `now` from the injected clock, read AFTER the lock so a wait cannot leave a stale instant,
 *   4. recount under the lock (`countQualifyingGames`, the same predicate the pre-pass and the Members row use;
 *      it reads the baseline from the locked row, so an override committed meanwhile resets the count),
 *   5. `decideProgression` (pure, one level at most),
 *   6. `UPDATE ... WHERE status = 'APPROVED' AND skill_level = $from AND skill_level_changed_at IS NOT DISTINCT
 *      FROM $baseline`, setting only the level and the baseline. A redelivery or a second run finds the reset
 *      baseline and changes nothing.
 *
 * Every instant is a JS `Date`, never SQL `now()`.
 */
import { decideProgression, type SkillTier } from '@sgm/shared';
import { sql } from 'kysely';
import type { Clock } from '../../lib/clock.ts';
import type { Database } from '../../lib/db/kysely.ts';
import { countQualifyingGames } from './games.ts';
import * as repo from './repo.ts';

export type ProgressMemberOutcome =
  | {
      readonly kind: 'promoted';
      readonly membershipId: string;
      readonly from: SkillTier;
      readonly to: SkillTier;
      readonly games: number;
    }
  | {
      readonly kind: 'skipped';
      readonly reason:
        'missing' | 'not_approved' | 'highest_level' | 'below_threshold' | 'changed_concurrently';
    };

export async function progressMember(
  deps: { readonly db: Database; readonly clock: Clock },
  target: { readonly teamId: string; readonly userId: string },
): Promise<ProgressMemberOutcome> {
  const { db, clock } = deps;
  return db.transaction().execute(async (trx): Promise<ProgressMemberOutcome> => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    const member = await repo.lockMemberForProgression(trx, target.teamId, target.userId);
    if (member === undefined) return { kind: 'skipped', reason: 'missing' };
    if (member.status !== 'APPROVED') return { kind: 'skipped', reason: 'not_approved' };

    const now = clock.now();
    const games = await countQualifyingGames(trx, { ...target, now });
    const decision = decideProgression({ level: member.skillLevel, games });
    if (decision.kind === 'none') return { kind: 'skipped', reason: decision.reason };

    const written = await repo.applyProgression(trx, member.id, {
      from: decision.from,
      to: decision.to,
      now,
      baselineExact: member.baselineExact,
    });
    if (!written) return { kind: 'skipped', reason: 'changed_concurrently' };
    return {
      kind: 'promoted',
      membershipId: member.id,
      from: decision.from,
      to: decision.to,
      games,
    };
  });
}
