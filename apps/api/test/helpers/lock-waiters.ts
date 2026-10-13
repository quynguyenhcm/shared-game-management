/**
 * Deterministic race helpers: instead of sleeping, a test holds a real row lock, fires the requests under test and
 * waits until Postgres itself reports that many backends are blocked on a lock (`pg_stat_activity`).
 */
import type pg from 'pg';
import { waitFor } from './wait-for.ts';

/** Backends in this database currently waiting for a lock. */
export async function countLockWaiters(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  );
  return rows[0]?.n ?? 0;
}

/** Resolves once at least `count` backends are blocked on a lock. */
export async function waitForLockWaiters(
  pool: pg.Pool,
  count: number,
  label = 'blocked backends',
): Promise<void> {
  await waitFor(async () => ((await countLockWaiters(pool)) >= count ? true : undefined), {
    label: `${count} ${label}`,
    timeoutMs: 15_000,
  });
}

/** Holds `FOR UPDATE` on the team row in an open transaction until `release()`; every moderation request queues behind it. */
export async function holdTeamLock(
  pool: pg.Pool,
  teamId: string,
): Promise<{
  /** Runs SQL inside the held transaction (to change state while the requests wait). */
  query: (text: string, values?: unknown[]) => Promise<unknown>;
  /** COMMIT, letting the queued requests proceed. */
  release: () => Promise<void>;
}> {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT id FROM teams WHERE id = $1 FOR UPDATE', [teamId]);
  let released = false;
  return {
    query: (text, values) => client.query(text, values),
    // Idempotent, so a test can release in `finally` even after it released explicitly.
    async release() {
      if (released) return;
      released = true;
      try {
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Starts `requests` while the team row is locked by the test, waits until Postgres reports all of them blocked,
 * optionally lets the test change state in the held transaction, then releases and returns every result. The lock
 * is always released, even when an assertion in between fails, so a failing race never hangs the suite.
 */
export async function raceUnderTeamLock<T>(
  pool: pg.Pool,
  teamId: string,
  requests: readonly (() => Promise<T>)[],
  options: {
    beforeRelease?: (lock: Awaited<ReturnType<typeof holdTeamLock>>) => Promise<void>;
  } = {},
): Promise<T[]> {
  const lock = await holdTeamLock(pool, teamId);
  try {
    const pending = requests.map((start) => start());
    await waitForLockWaiters(pool, requests.length, 'requests blocked on the team row');
    await options.beforeRelease?.(lock);
    await lock.release();
    return await Promise.all(pending);
  } finally {
    await lock.release();
  }
}
