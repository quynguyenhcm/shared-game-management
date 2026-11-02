/**
 * The post-game billing sweep (ADR 0004, algorithm doc G, B9; AC-ASYNC-1). Every 5 minutes, once at every worker boot, or
 * `pnpm run jobs:trigger post-game-billing`: it ENUMERATES the sessions that are due and enqueues one `bill-session` job each
 * (`singletonKey = bill-session:<sessionId>` on an exclusive queue, so a queued or active job for the session suppresses a
 * duplicate). It bills nothing itself and takes no lock.
 *
 * Due means PUBLISHED with `ends_at <= now`, served by `idx_game_sessions_billing_due`. Oldest first (B9): after a long outage the
 * backlog is billed in the order the games ended, and the single-concurrency queue keeps that order. A session already held by
 * B8 is skipped while its team is still blocked and has its marker, so a blocked session does not re-run (and re-log) every five
 * minutes; the first sweep after the account is fixed picks it up. Logs carry counts only.
 */
import { sql } from 'kysely';
import type { Clock } from '../../lib/clock.ts';
import type { Database } from '../../lib/db/kysely.ts';
import type { JobRunner } from '../../lib/jobs/jobs.ts';
import type { Logger } from '../../lib/logger/logger.ts';
import { QUEUE_NAMES } from '../../jobs/registry.ts';

export const POST_GAME_SWEEP_BATCH_SIZE = 500;

/** The singleton key of one session's billing job: a queued or active duplicate is dropped. */
export const billSessionKey = (sessionId: string): string => `bill-session:${sessionId}`;

export interface PostGameBillingSweepDeps {
  readonly db: Database;
  /** The worker's runner (queues the per-session jobs). */
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  readonly clock: Clock;
  readonly log: Pick<Logger, 'info'>;
  /** Rows per page; tests lower it to exercise the keyset loop. */
  readonly batchSize?: number;
}

export interface PostGameBillingSweepResult {
  /** Due sessions seen. */
  readonly scanned: number;
  /** Jobs actually queued (a session that already has one queued or active is not counted). */
  readonly enqueued: number;
}

export async function runPostGameBillingSweep(
  deps: PostGameBillingSweepDeps,
): Promise<PostGameBillingSweepResult> {
  const batchSize = deps.batchSize ?? POST_GAME_SWEEP_BATCH_SIZE;
  const now = deps.clock.now();
  let scanned = 0;
  let enqueued = 0;
  let after: { endsAt: Date; id: string } | undefined;
  for (;;) {
    let query = deps.db
      .selectFrom('game_sessions')
      .select(['id', 'ends_at'])
      .where('status', '=', 'PUBLISHED')
      .where('ends_at', '<=', now)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('billing_session_blocks as b')
              .innerJoin('teams as t', 't.id', 'b.team_id')
              .select('b.session_id')
              .whereRef('b.session_id', '=', 'game_sessions.id')
              .where('t.is_payout_configured', '=', false),
          ),
        ),
      );
    if (after !== undefined) {
      query = query.where(sql<boolean>`(ends_at, id) > (${after.endsAt}, ${after.id})`);
    }
    const page = await query.orderBy('ends_at').orderBy('id').limit(batchSize).execute();
    for (const session of page) {
      scanned += 1;
      const jobId = await deps.jobs.enqueue(
        QUEUE_NAMES.billSession,
        { sessionId: session.id, trigger: 'sweep' },
        { singletonKey: billSessionKey(session.id) },
      );
      if (jobId !== null) enqueued += 1;
    }
    const last = page.at(-1);
    if (page.length < batchSize || last?.ends_at == null) break;
    after = { endsAt: last.ends_at, id: last.id };
  }
  deps.log.info({ event: 'billing.sweep.enqueued', scanned, enqueued }, 'post-game billing sweep');
  return { scanned, enqueued };
}
