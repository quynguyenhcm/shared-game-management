/**
 * Transaction policy for every sessions write (architecture SA-2). `runSessionTransaction` opens a transaction,
 * sets the policy's `lock_timeout` as its first statement, and retries the WHOLE transaction when PostgreSQL reports
 * a deadlock (`40P01`) or a lock timeout (`55P03`). The lock policies are code constants, not deployment config:
 * they are behaviour, and registration's allocator uses the same shape (2 s HTTP, 5 s job).
 */
import { sql } from 'kysely';
import type { Transaction } from 'kysely';
import type { Database } from '../../lib/db/kysely.ts';
import type { DB } from '../../lib/db/types.generated.ts';

export interface SessionTxPolicy {
  /** `SET LOCAL lock_timeout`, in milliseconds. */
  readonly lockTimeoutMs: number;
  /** Total tries, including the first. */
  readonly attempts: number;
  /** Wait before try 2, try 3, …; the last value repeats. */
  readonly backoffMs: readonly number[];
}

export const HTTP_POLICY: SessionTxPolicy = {
  lockTimeoutMs: 2000,
  attempts: 3,
  backoffMs: [25, 75],
};

export const JOB_POLICY: SessionTxPolicy = {
  lockTimeoutMs: 5000,
  attempts: 3,
  backoffMs: [100, 400],
};

export interface SessionTxOptions {
  /** Which code path is running (`publish`, `edit`, `materialiser`, …): logged on a retry. */
  readonly path?: string;
  readonly log?: { warn(bindings: object, message: string): void };
  /** Test seam: replaces the real backoff wait. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const LOCK_CONFLICT_STATES: ReadonlySet<string> = new Set(['40P01', '55P03']);

function sqlState(error: unknown): string | undefined {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** True for a deadlock or a lock timeout: the only failures a whole-transaction retry can cure. */
export function isLockConflict(error: unknown): boolean {
  const state = sqlState(error);
  return state !== undefined && LOCK_CONFLICT_STATES.has(state);
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function runSessionTransaction<T>(
  db: Database,
  policy: SessionTxPolicy,
  fn: (trx: Transaction<DB>) => Promise<T>,
  options: SessionTxOptions = {},
): Promise<T> {
  if (!Number.isInteger(policy.lockTimeoutMs) || policy.lockTimeoutMs <= 0) {
    throw new Error('lockTimeoutMs must be a positive integer');
  }
  const sleep = options.sleep ?? wait;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction().execute(async (trx) => {
        // The value is a validated integer, so it is safe to inline (SET cannot take a bind parameter).
        await sql.raw(`SET LOCAL lock_timeout = ${policy.lockTimeoutMs}`).execute(trx);
        return fn(trx);
      });
    } catch (error) {
      if (!isLockConflict(error)) throw error;
      const bindings = { path: options.path, attempt, sqlState: sqlState(error) };
      if (attempt >= policy.attempts) {
        options.log?.warn(
          { event: 'session.lock_retry_exhausted', ...bindings },
          'session transaction gave up after lock conflicts',
        );
        throw error;
      }
      options.log?.warn(
        { event: 'session.lock_retry', ...bindings },
        'session transaction hit a lock conflict and will retry',
      );
      const backoff = policy.backoffMs[Math.min(attempt - 1, policy.backoffMs.length - 1)] ?? 0;
      await sleep(backoff);
    }
  }
}
