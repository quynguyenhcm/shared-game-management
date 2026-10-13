import pg, { type CustomTypesConfig } from 'pg';
import type { Logger } from '../logger/logger.ts';

const { Pool, types } = pg;

/** Postgres type OIDs that must not be parsed into lossy JS values. */
const STRING_OIDS: ReadonlySet<number> = new Set([
  20 /* INT8 */, 1700 /* NUMERIC */, 1082 /* DATE */, 1083 /* TIME */,
]);

/** Health probe budget: `SELECT 1` is abandoned after this many milliseconds (AC-ERROR-2: 503 within 3 s). */
export const HEALTH_CHECK_TIMEOUT_MS = 1500;
const CONNECTION_TIMEOUT_MS = 1000;

export interface PoolOptions {
  readonly connectionString: string;
  readonly max: number;
  readonly logger?: Logger;
}

const asString = (value: string): string => value;

function getTypeParser(oid: number, format?: 'text' | 'binary'): (value: string) => unknown {
  if (STRING_OIDS.has(oid)) return asString;
  const parser: unknown =
    format === 'binary' ? types.getTypeParser(oid, 'binary') : types.getTypeParser(oid);
  return parser as (value: string) => unknown;
}

/**
 * Creates the shared pg pool.
 * - NUMERIC / INT8 / DATE / TIME are returned as strings: money stays exact (P2) and dates never
 *   shift through a JS Date (P3).
 * - Every connection runs with `TimeZone=UTC`.
 * - Connections are opened lazily on checkout, so the pool recovers by itself after a DB restart.
 */
export function createPool(options: PoolOptions): pg.Pool {
  const typeParsers: CustomTypesConfig = { getTypeParser };
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    options: '-c TimeZone=UTC',
    types: typeParsers,
  });
  // An idle client can be killed by a DB restart; without a listener that would crash the process.
  pool.on('error', (error) => {
    options.logger?.warn({ err: error }, 'idle database client error');
  });
  return pool;
}

/** Resolves true when `SELECT 1` succeeds within the health budget; never rejects. */
export async function checkDatabase(
  pool: Pick<pg.Pool, 'query'>,
  timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
  });
  const probe = pool.query('SELECT 1').then(
    () => true,
    () => false,
  );
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
