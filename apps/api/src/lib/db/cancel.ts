import pg from 'pg';

const { Client } = pg;

/** Budget for opening the cancel connection and for its one statement. */
const CANCEL_TIMEOUT_MS = 2000;

/**
 * Identifies one transaction on one backend: its pid, and its start (`now()` inside the transaction, as text so no
 * microsecond is lost). A backend that has moved on to another transaction no longer matches.
 */
export interface BackendTransaction {
  readonly pid: number;
  readonly xactStart: string;
}

/** Sends `pg_cancel_backend` to `target` if it is still in that transaction. Never rejects. */
export type BackendCanceller = (target: BackendTransaction) => Promise<void>;

export interface BackendCancellerOptions {
  readonly connectionString: string;
  /** Connect and statement budget in milliseconds (default 2,000). */
  readonly timeoutMs?: number;
}

/**
 * A canceller on its OWN short-lived connection, never the shared pool: the transaction being cancelled may hold the pool's
 * last connection (DATABASE_POOL_MAX at or below the active exports), and a cancel queued behind it would never run. The
 * `xact_start` guard means a cancel that arrives after the transaction ended (its connection released and reused) does
 * nothing, so the caller can release its connection without waiting for the cancel.
 */
export function createBackendCanceller(options: BackendCancellerOptions): BackendCanceller {
  const timeoutMs = options.timeoutMs ?? CANCEL_TIMEOUT_MS;
  return async (target) => {
    const client = new Client({
      connectionString: options.connectionString,
      connectionTimeoutMillis: timeoutMs,
      query_timeout: timeoutMs,
    });
    // An error after connect (the server going away) must not crash the process.
    client.on('error', () => undefined);
    try {
      await client.connect();
      await client.query(
        `SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid = $1 AND xact_start = $2::timestamptz`,
        [target.pid, target.xactStart],
      );
    } catch {
      // Best effort: statement_timeout and idle_in_transaction_session_timeout end the transaction anyway.
    } finally {
      await client.end().catch(() => undefined);
    }
  };
}
