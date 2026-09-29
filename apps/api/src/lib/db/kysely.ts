import { Kysely, PostgresDialect } from 'kysely';
import type pg from 'pg';
import type { DB } from './types.generated.ts';

export type Database = Kysely<DB>;

/**
 * Kysely over the shared pg pool (`createPool`), so money stays a `MoneyString`, DATE/TIME stay
 * strings and every connection runs in UTC. Destroying the Kysely instance ends the pool.
 */
export function createKysely(pool: pg.Pool): Database {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
