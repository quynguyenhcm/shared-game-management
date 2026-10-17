/**
 * `skill-progression` job (skill-levels-and-auto-enroll Phase 4: AC-HAPPY-4..6, AC-ASYNC-1/2, AC-ERROR-7).
 * The daily sweep (05:30 Pacific/Auckland, or `pnpm run jobs:trigger skill-progression`) that moves a member up
 * one level when they have `SKILL_PROGRESSION_GAMES` qualifying games since their last level change.
 *
 * Two phases:
 *   1. A read-only keyset pre-pass over APPROVED, non-ADVANCED members (pages of 500, ordered by team and user),
 *      counting qualifying games per page with the one shared predicate (`countQualifyingGamesBatch`). It locks
 *      nothing and only decides who is worth a transaction.
 *   2. One transaction per candidate (`progressMember`): lock the member row, read `now`, recount, decide, guarded
 *      UPDATE. The pre-pass is advisory; the locked recount is authoritative.
 *
 * Delivery is at-least-once and runs may overlap, so correctness rests on the per-member guard, not the queue:
 * a promotion resets the baseline, and a second pass finds 0 games. A member whose transaction fails (lock
 * timeout, constraint violation) is logged with ids and an error code only and the sweep carries on; when any
 * member failed the run ends failed after the sweep, so it stays visible in `pgboss.job` and retries.
 * Logs carry ids, levels and counts, never names or emails.
 */
import { trace } from '@opentelemetry/api';
import { SKILL_PROGRESSION_GAMES } from '@sgm/shared';
import { sql } from 'kysely';
import type { Clock } from '../lib/clock.ts';
import type { Database } from '../lib/db/kysely.ts';
import type { JobHandler } from '../lib/jobs/jobs.ts';
import { countQualifyingGamesBatch } from '../modules/skill-levels/games.ts';
import { progressMember } from '../modules/skill-levels/progression.ts';

export const SKILL_PROGRESSION_BATCH_SIZE = 500;

export interface SkillProgressionOptions {
  readonly db: Database;
  readonly clock: Clock;
  /** Members per pre-pass page; tests lower it to exercise the keyset loop. */
  readonly batchSize?: number;
}

interface Candidate {
  readonly id: string;
  readonly team_id: string;
  readonly user_id: string;
}

/** SQLSTATE for a database error, else the error's name: a code, never the message (it may echo row data). */
function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.name : 'unknown';
}

export function createSkillProgressionHandler(options: SkillProgressionOptions): JobHandler {
  const { db, clock } = options;
  const batchSize = options.batchSize ?? SKILL_PROGRESSION_BATCH_SIZE;

  /** The next page of members after `cursor` (keyset on `(team_id, user_id)`; no OFFSET, no locks). */
  function readPage(cursor: Candidate | undefined): Promise<Candidate[]> {
    let query = db
      .selectFrom('team_members')
      .select(['id', 'team_id', 'user_id'])
      .where('status', '=', 'APPROVED')
      .where('skill_level', '<>', 'ADVANCED');
    if (cursor !== undefined) {
      query = query.where(
        sql<boolean>`(team_id, user_id) > (${cursor.team_id}, ${cursor.user_id})`,
      );
    }
    return query.orderBy('team_id').orderBy('user_id').limit(batchSize).execute();
  }

  /** Members of `page` whose count already reaches the threshold, counted one team at a time. */
  async function selectCandidates(page: readonly Candidate[], now: Date): Promise<Candidate[]> {
    const byTeam = new Map<string, Candidate[]>();
    for (const member of page) {
      const group = byTeam.get(member.team_id);
      if (group) group.push(member);
      else byTeam.set(member.team_id, [member]);
    }
    const candidates: Candidate[] = [];
    for (const [teamId, members] of byTeam) {
      const counts = await countQualifyingGamesBatch(db, {
        teamId,
        userIds: members.map((member) => member.user_id),
        now,
      });
      candidates.push(
        ...members.filter((member) => (counts.get(member.user_id) ?? 0) >= SKILL_PROGRESSION_GAMES),
      );
    }
    return candidates;
  }

  return async (_payload, context) => {
    const startedAt = performance.now();
    const counts = { scanned: 0, candidates: 0, promoted: 0, skipped: 0, failed: 0 };
    let aborted = false;
    let cursor: Candidate | undefined;

    sweep: for (;;) {
      if (context.signal.aborted) {
        aborted = true;
        break;
      }
      const page = await readPage(cursor);
      if (page.length === 0) break;
      counts.scanned += page.length;
      const candidates = await selectCandidates(page, clock.now());
      counts.candidates += candidates.length;

      for (const candidate of candidates) {
        if (context.signal.aborted) {
          aborted = true;
          break sweep;
        }
        const ids = {
          teamId: candidate.team_id,
          userId: candidate.user_id,
          membershipId: candidate.id,
        };
        try {
          const outcome = await progressMember(
            { db, clock },
            { teamId: candidate.team_id, userId: candidate.user_id },
          );
          if (outcome.kind === 'promoted') {
            counts.promoted += 1;
            context.logger.info(
              {
                event: 'team.member.skill_progressed',
                ...ids,
                from: outcome.from,
                to: outcome.to,
                games: outcome.games,
              },
              'member skill level progressed',
            );
          } else {
            counts.skipped += 1;
          }
        } catch (error) {
          counts.failed += 1;
          const errorCode = errorCodeOf(error);
          context.logger.error(
            { event: 'skill.progression.member_failed', ...ids, errorCode },
            'skill progression failed for one member',
          );
          trace.getActiveSpan()?.addEvent('skill.progression.member_failed', {
            teamId: ids.teamId,
            userId: ids.userId,
            errorCode,
          });
        }
      }

      const last = page.at(-1);
      if (page.length < batchSize || last === undefined) break;
      cursor = last;
    }

    context.logger.info(
      {
        event: 'skill.progression.completed',
        ...counts,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'skill progression completed',
    );
    if (aborted) throw new Error('skill-progression aborted before the sweep finished');
    if (counts.failed > 0) {
      throw new Error(
        `skill-progression: ${counts.failed} member(s) failed; see member_failed logs`,
      );
    }
  };
}
