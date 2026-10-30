/**
 * `registration-ban-reconcile` job (architecture Q4 sweep S-a; AC-ASYNC-3): the daily sweep (05:45 Pacific/Auckland, once at
 * every worker boot, or `pnpm run jobs:trigger registration-ban-reconcile`) that re-enqueues `member-banned` for every BANNED
 * member who still holds an active registration in a future PUBLISHED session. The work is in
 * `modules/registrations/reconcile.ts`; this wrapper runs it and logs the counts, nothing else (no ids, names or emails).
 *
 * It only enqueues. The member-banned handler (the real `registrations` ban handler) does the withdrawing, one session per
 * transaction, so the sweep never holds a session lock and a job already queued for a membership is not duplicated.
 */
import type { Clock } from '../lib/clock.ts';
import type { Database } from '../lib/db/kysely.ts';
import type { JobHandler, JobRunner } from '../lib/jobs/jobs.ts';
import { reconcileBannedMembers } from '../modules/registrations/reconcile.ts';

export interface BanReconcileOptions {
  readonly db: Database;
  /** The worker's runner (queues the `member-banned` jobs inside the sweep transaction). */
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  readonly clock: Clock;
  /** Test seam. */
  readonly reconcile?: typeof reconcileBannedMembers;
}

export function createBanReconcileHandler(options: BanReconcileOptions): JobHandler {
  const reconcile = options.reconcile ?? reconcileBannedMembers;
  return async (_payload, context) => {
    const startedAt = performance.now();
    const counts = await reconcile({ db: options.db, jobs: options.jobs, clock: options.clock });
    context.logger.info(
      {
        event: 'registration.ban_reconcile.completed',
        scanned: counts.scanned,
        enqueued: counts.enqueued,
        alreadyQueued: counts.alreadyQueued,
        invalid: counts.invalid,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'ban reconciliation sweep completed',
    );
  };
}
