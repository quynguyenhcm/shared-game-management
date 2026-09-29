/**
 * Per-file database isolation for integration tests (AC-VERIFY-17).
 *
 * `createTestDatabase()` clones this run's migrated template (see `test/global-setup.ts`) with
 * `CREATE DATABASE … TEMPLATE …`, which takes well under a second, and returns a pool on the clone.
 * Tests may COMMIT freely: nothing outside the clone is affected. `{ empty: true }` creates an
 * unmigrated database instead (for migrate/rollback round trips).
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { expect, inject } from 'vitest';
import { createPool } from '../../src/lib/db/pool.ts';
import { databaseUrlFor } from './db-url.ts';

export type Queryable = Pick<pg.ClientBase, 'query'>;

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  readonly pool: pg.Pool;
  /** Ends the pool and drops the database. */
  close(): Promise<void>;
}

/** Serialises clone creation on the server (CREATE DATABASE needs the template to be idle). */
const CLONE_LOCK_KEY = 72_415_002;

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: inject('sgmAdminDatabaseUrl') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createTestDatabase(
  options: { empty?: boolean; poolMax?: number } = {},
): Promise<TestDatabase> {
  const worker = process.env.VITEST_POOL_ID ?? '0';
  const name = `sgm_test_${inject('sgmRunId')}_${worker}_${randomBytes(4).toString('hex')}`;
  const template = options.empty ? 'template1' : inject('sgmTemplateDatabase');
  await admin(async (client) => {
    await client.query('SELECT pg_advisory_lock($1)', [CLONE_LOCK_KEY]);
    try {
      await client.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [CLONE_LOCK_KEY]);
    }
  });
  const url = databaseUrlFor(inject('sgmAdminDatabaseUrl'), name);
  const pool = createPool({ connectionString: url, max: options.poolMax ?? 5 });
  return {
    name,
    url,
    pool,
    async close() {
      await pool.end();
      await admin(async (client) => {
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      });
    },
  };
}

/** The part of a node-postgres error the tests assert on. */
export interface PgErrorInfo {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
  readonly message: string;
}

function toPgError(error: unknown): PgErrorInfo {
  if (error instanceof Error) {
    const { code, constraint } = error as Error & { code?: string; constraint?: string };
    return { code, constraint, message: error.message };
  }
  return { code: undefined, constraint: undefined, message: String(error) };
}

/** Resolves to the rejection's SQLSTATE details; fails the test if the promise resolves. */
export async function pgError(promise: Promise<unknown>): Promise<PgErrorInfo> {
  try {
    await promise;
  } catch (error) {
    return toPgError(error);
  }
  throw new Error('expected the statement to fail, but it succeeded');
}

/** Asserts that `promise` rejects with SQLSTATE `code` (and, when given, the named constraint). */
export async function expectPgError(
  promise: Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<PgErrorInfo> {
  const info = await pgError(promise);
  expect({ code: info.code, message: info.message }).toMatchObject({ code });
  if (constraint !== undefined) {
    expect(info.constraint).toBe(constraint);
  }
  return info;
}

/**
 * Runs one statement inside a SAVEPOINT on an open transaction and returns its error (or undefined),
 * so a single transaction can probe several constraint violations.
 */
export async function trySql(
  client: pg.PoolClient,
  text: string,
  values: readonly unknown[] = [],
): Promise<PgErrorInfo | undefined> {
  await client.query('SAVEPOINT probe');
  try {
    await client.query(text, values as unknown[]);
    await client.query('RELEASE SAVEPOINT probe');
    return undefined;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT probe');
    return toPgError(error);
  }
}

/** Runs `fn` on one connection inside BEGIN … COMMIT (ROLLBACK on error, then rethrows). */
export async function inTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Runs `fn` inside a transaction that is always rolled back. */
export async function inRollback<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}
