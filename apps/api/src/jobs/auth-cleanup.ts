/**
 * `auth-cleanup` job (AC-ASYNC-3, algorithm step I): the daily housekeeping that deletes stale auth rows.
 *
 * Stale means: sessions revoked or past their idle or absolute expiry; reset tokens, OAuth states and pending
 * sign-ups used or expired; throttle counters whose newest attempt is older than the longest window (60 min).
 * Live sessions, valid tokens and live counters are never touched. Each table is cleared in batches so lock
 * time stays short, and a second run finds nothing, so the job is safe to repeat (at-least-once delivery).
 * Time comes from the injected clock. Only counts are logged, never row contents.
 */
import { sql, type RawBuilder } from 'kysely';
import type { Clock } from '../lib/clock.ts';
import type { Database } from '../lib/db/kysely.ts';
import type { JobHandler } from '../lib/jobs/jobs.ts';

export const AUTH_CLEANUP_BATCH_SIZE = 5000;
/** The longest throttle window (forgot and register limits are 60 min; sign-in windows are at most 60). */
const THROTTLE_RETENTION_MS = 60 * 60_000;

export interface AuthCleanupOptions {
  readonly db: Database;
  readonly clock: Clock;
  /** Rows deleted per statement; tests lower it to exercise the loop. */
  readonly batchSize?: number;
}

export interface AuthCleanupCounts {
  readonly sessions: number;
  readonly resetTokens: number;
  readonly oauthStates: number;
  readonly pendingSignups: number;
  readonly throttleRows: number;
}

type Table =
  | 'auth_sessions'
  | 'password_reset_tokens'
  | 'oauth_states'
  | 'oauth_pending_signups'
  | 'auth_throttle';

export function createAuthCleanupHandler(options: AuthCleanupOptions): JobHandler {
  const { db, clock } = options;
  const batchSize = options.batchSize ?? AUTH_CLEANUP_BATCH_SIZE;

  /** Deletes the rows matching `stale` in batches of `batchSize` until a batch comes back short. */
  async function purge(table: Table, stale: RawBuilder<unknown>): Promise<number> {
    let total = 0;
    for (;;) {
      const result = await sql`
        DELETE FROM ${sql.table(table)}
         WHERE ctid = ANY(ARRAY(
           SELECT ctid FROM ${sql.table(table)} WHERE ${stale} LIMIT ${batchSize}
             FOR UPDATE SKIP LOCKED))`.execute(db);
      const deleted = Number(result.numAffectedRows ?? 0n);
      total += deleted;
      if (deleted < batchSize) return total;
    }
  }

  return async (_payload, context) => {
    const now = clock.now();
    const throttleCutoff = new Date(now.getTime() - THROTTLE_RETENTION_MS);
    const deleted: AuthCleanupCounts = {
      sessions: await purge(
        'auth_sessions',
        sql`revoked_at IS NOT NULL OR expires_at <= ${now} OR absolute_expires_at <= ${now}`,
      ),
      resetTokens: await purge(
        'password_reset_tokens',
        sql`used_at IS NOT NULL OR expires_at <= ${now}`,
      ),
      oauthStates: await purge('oauth_states', sql`used_at IS NOT NULL OR expires_at <= ${now}`),
      pendingSignups: await purge(
        'oauth_pending_signups',
        sql`used_at IS NOT NULL OR expires_at <= ${now}`,
      ),
      throttleRows: await purge('auth_throttle', sql`updated_at <= ${throttleCutoff}`),
    };
    context.logger.info({ event: 'auth.cleanup.completed', deleted }, 'auth cleanup completed');
  };
}
