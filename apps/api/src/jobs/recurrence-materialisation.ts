/**
 * `recurrence-materialisation` sweep (03:00 Pacific/Auckland, once at every worker boot, or `jobs trigger`): the fan-out of the
 * series materialiser (architecture SA-1, SA-5; AC-ASYNC-1, AC-ASYNC-5). It enumerates; it never creates a session itself.
 *
 *   1. Keyset pages of 500 over active rules that have not ended: one `recurrence-rule` job per rule (`stately`, so a rule that
 *      already has a queued job is not queued twice).
 *   2. Keyset pages of 500 over PUBLISHED, not-yet-started sessions whose auto-enrol is still pending
 *      (`idx_game_sessions_auto_enrol_pending`): one `session-auto-enrol` job per session. The per-session advisory lock and the
 *      D-80 marker make a duplicate, an inline follow-up or a replay harmless.
 *
 * Both reads take no locks. Logs carry counts only.
 */
import { instantToLocal } from '@sgm/shared';
import { sql } from 'kysely';
import type { Clock } from '../lib/clock.ts';
import type { Database } from '../lib/db/kysely.ts';
import type { JobHandler, JobRunner } from '../lib/jobs/jobs.ts';
import { sessionAutoEnrolKey } from '../modules/sessions/auto-enrol.ts';
import { enqueueRuleMaterialisation } from '../modules/sessions/rule-jobs.ts';
import { QUEUE_NAMES } from './registry.ts';

export const RECURRENCE_SWEEP_BATCH_SIZE = 500;

export interface RecurrenceSweepOptions {
  readonly db: Database;
  readonly clock: Clock;
  /** The worker's runner (queues the per-rule and per-session jobs). */
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  /** Rows per page; tests lower it to exercise the keyset loop. */
  readonly batchSize?: number;
}

export function createRecurrenceMaterialisationHandler(
  options: RecurrenceSweepOptions,
): JobHandler {
  const { db, clock, jobs } = options;
  const batchSize = options.batchSize ?? RECURRENCE_SWEEP_BATCH_SIZE;

  return async (_payload, context) => {
    const startedAt = performance.now();
    const now = clock.now();
    const today = instantToLocal(now).date;
    let rulesScanned = 0;
    let rulesEnqueued = 0;
    let pendingAutoEnrolEnqueued = 0;

    let afterRule: string | undefined;
    for (;;) {
      if (context.signal.aborted)
        throw new Error('recurrence-materialisation aborted before the sweep finished');
      let query = db
        .selectFrom('recurring_session_rules')
        .select(['id', 'team_id'])
        .where('is_active', '=', true)
        .where((eb) => eb.or([eb('recur_until', 'is', null), eb('recur_until', '>=', today)]));
      if (afterRule !== undefined) query = query.where('id', '>', afterRule);
      const page = await query.orderBy('id').limit(batchSize).execute();
      for (const rule of page) {
        rulesScanned += 1;
        const jobId = await enqueueRuleMaterialisation(jobs, {
          ruleId: rule.id,
          teamId: rule.team_id,
          trigger: 'sweep',
        });
        if (jobId !== null) rulesEnqueued += 1;
      }
      const last = page.at(-1);
      if (page.length < batchSize || last === undefined) break;
      afterRule = last.id;
    }

    let after: { startsAt: Date; id: string } | undefined;
    for (;;) {
      if (context.signal.aborted)
        throw new Error('recurrence-materialisation aborted before the sweep finished');
      let query = db
        .selectFrom('game_sessions')
        .select(['id', 'team_id', 'starts_at'])
        .where('status', '=', 'PUBLISHED')
        .where('auto_enrol_required', '=', true)
        .where('auto_enrolled_at', 'is', null)
        .where('starts_at', '>', now);
      if (after !== undefined) {
        query = query.where(sql<boolean>`(starts_at, id) > (${after.startsAt}, ${after.id})`);
      }
      const page = await query.orderBy('starts_at').orderBy('id').limit(batchSize).execute();
      for (const session of page) {
        const jobId = await jobs.enqueue(
          QUEUE_NAMES.sessionAutoEnrol,
          { sessionId: session.id, teamId: session.team_id, trigger: 'sweep' },
          { singletonKey: sessionAutoEnrolKey(session.id) },
        );
        if (jobId !== null) pendingAutoEnrolEnqueued += 1;
      }
      const last = page.at(-1);
      if (page.length < batchSize || last?.starts_at == null) break;
      after = { startsAt: last.starts_at, id: last.id };
    }

    context.logger.info(
      {
        event: 'session.recurrence.sweep_completed',
        rulesScanned,
        rulesEnqueued,
        pendingAutoEnrolEnqueued,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'recurrence sweep completed',
    );
  };
}
