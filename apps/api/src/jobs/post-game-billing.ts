/**
 * `post-game-billing` sweep (every 5 minutes, once at every worker boot, or `pnpm run jobs:trigger post-game-billing`): the
 * fan-out of the billing engine (ADR 0004, AC-ASYNC-1). It enqueues one `bill-session` job per ended PUBLISHED session, oldest
 * first, and bills nothing itself; the work is in `modules/billing/sweep.ts`. It replaces the foundation's placeholder handler.
 */
import type { Clock } from '../lib/clock.ts';
import type { Database } from '../lib/db/kysely.ts';
import type { JobHandler, JobRunner } from '../lib/jobs/jobs.ts';
import { runPostGameBillingSweep } from '../modules/billing/sweep.ts';

export interface PostGameBillingOptions {
  readonly db: Database;
  /** The worker's runner (queues the `bill-session` jobs). */
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  readonly clock: Clock;
}

export function createPostGameBillingHandler(options: PostGameBillingOptions): JobHandler {
  return async (_payload, context) => {
    await runPostGameBillingSweep({
      db: options.db,
      jobs: options.jobs,
      clock: options.clock,
      log: context.logger,
    });
  };
}
