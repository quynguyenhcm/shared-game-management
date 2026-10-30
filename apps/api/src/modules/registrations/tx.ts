/**
 * Transaction policy for this module's OWN entry points (the HTTP service and the ban handler), mirroring the sessions
 * module's shape (architecture Q2, L1). `runAllocatorTransaction` sets the policy's `lock_timeout` as its first
 * statement and retries the WHOLE transaction on a deadlock (`40P01`) or a lock timeout (`55P03`).
 *
 * `now` is read ONCE, before the first attempt, and every attempt gets the same instant: a lock wait can never turn an
 * EARLY withdrawal into a LATE one. The allocator itself (`allocator.ts`) never opens a transaction or sets a timeout:
 * a caller from another feature (session scheduling's capacity edit, auto-enrol) owns its transaction and retry (R22).
 */
import { sql } from 'kysely';
import type { Transaction } from 'kysely';
import type { Clock } from '../../lib/clock.ts';
import type { Database } from '../../lib/db/kysely.ts';
import type { DB } from '../../lib/db/types.generated.ts';

export interface AllocatorTxPolicy {
  /** `SET LOCAL lock_timeout`, in milliseconds. */
  readonly lockTimeoutMs: number;
  /** Total tries, including the first. */
  readonly attempts: number;
  /** Wait before try 2, try 3, ...; the last value repeats. */
  readonly backoffMs: readonly number[];
}

export const HTTP_POLICY: AllocatorTxPolicy = {
  lockTimeoutMs: 2000,
  attempts: 3,
  backoffMs: [25, 75],
};

export const JOB_POLICY: AllocatorTxPolicy = {
  lockTimeoutMs: 5000,
  attempts: 3,
  backoffMs: [100, 400],
};

export interface AllocatorTxOptions {
  readonly clock: Clock;
  /** Carried on every lock-retry log line. */
  readonly teamId: string;
  /** Which entry point runs (`register`, `withdraw`, `ban`, ...). */
  readonly path: string;
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

export async function runAllocatorTransaction<T>(
  db: Database,
  policy: AllocatorTxPolicy,
  options: AllocatorTxOptions,
  work: (context: { readonly trx: Transaction<DB>; readonly now: Date }) => Promise<T>,
): Promise<T> {
  if (!Number.isInteger(policy.lockTimeoutMs) || policy.lockTimeoutMs <= 0) {
    throw new Error('lockTimeoutMs must be a positive integer');
  }
  const sleep = options.sleep ?? wait;
  // The operation's single clock reading: the instant the player acted, reused by every retry.
  const now = options.clock.now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction().execute(async (trx) => {
        // The value is a validated integer, so it is safe to inline (SET cannot take a bind parameter).
        await sql.raw(`SET LOCAL lock_timeout = ${policy.lockTimeoutMs}`).execute(trx);
        return work({ trx, now });
      });
    } catch (error) {
      if (!isLockConflict(error)) throw error;
      const bindings = {
        teamId: options.teamId,
        path: options.path,
        sqlState: sqlState(error),
      };
      if (attempt >= policy.attempts) {
        options.log?.warn(
          { event: 'registration.lock_retry_exhausted', attempts: attempt, ...bindings },
          'registration transaction gave up after lock conflicts',
        );
        throw error;
      }
      options.log?.warn(
        { event: 'registration.lock_retry', attempt, ...bindings },
        'registration transaction hit a lock conflict and will retry',
      );
      const backoff = policy.backoffMs[Math.min(attempt - 1, policy.backoffMs.length - 1)] ?? 0;
      await sleep(backoff);
    }
  }
}
