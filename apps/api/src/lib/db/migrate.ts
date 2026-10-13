/**
 * Schema lifecycle: node-pg-migrate over the plain-SQL files in `db/migrations`, plus the pg-boss
 * schema install/upgrade (architecture Q3/Q4). Used by `cli.ts db migrate|rollback|reset` and by the
 * integration-test global setup. The api and worker never run DDL at boot.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { PgBoss } from 'pg-boss';

/** node-pg-migrate's bookkeeping table (in `public`; excluded from schema conformance and codegen). */
export const MIGRATIONS_TABLE = 'pgmigrations';
/** Schema owned by pg-boss. `db:rollback` never touches it; `db:reset` drops it. */
export const PGBOSS_SCHEMA = 'pgboss';

export interface MigrateOptions {
  readonly databaseUrl: string;
  /** Receives progress lines; silent when omitted. */
  readonly log?: (message: string) => void;
  /** Overrides the `db/migrations` directory lookup. */
  readonly migrationsDir?: string;
}

/**
 * Finds `db/migrations` by walking up from this module, so the same code works from
 * `apps/api/src/lib/db` (tsx), `apps/api/dist` (bundled cli) and `/app/dist` (Docker image).
 * `MIGRATIONS_DIR` overrides the lookup.
 */
export function findMigrationsDir(start: string = dirname(fileURLToPath(import.meta.url))): string {
  const override = process.env.MIGRATIONS_DIR;
  if (override) return override;
  let current = start;
  for (;;) {
    const candidate = join(current, 'db', 'migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`db/migrations not found above ${start}; set MIGRATIONS_DIR`);
    }
    current = parent;
  }
}

async function run(
  options: MigrateOptions,
  direction: 'up' | 'down',
  count: number,
): Promise<string[]> {
  const log = options.log ?? (() => undefined);
  const applied = await runner({
    databaseUrl: { connectionString: options.databaseUrl, options: '-c TimeZone=UTC' },
    dir: options.migrationsDir ?? findMigrationsDir(),
    direction,
    count,
    migrationsTable: MIGRATIONS_TABLE,
    checkOrder: true,
    // One transaction per file (C-6): an enum added in one file can be used by the next.
    singleTransaction: false,
    logger: { debug: () => undefined, info: log, warn: log, error: log },
  });
  return applied.map((migration) => migration.name);
}

/** Installs or upgrades the pg-boss schema (idempotent). */
export async function installJobSchema(options: MigrateOptions): Promise<void> {
  const boss = new PgBoss({
    connectionString: options.databaseUrl,
    schema: PGBOSS_SCHEMA,
    migrate: true,
    createSchema: true,
    supervise: false,
    schedule: false,
    max: 2,
  });
  boss.on('error', (error: unknown) => {
    options.log?.(`pg-boss: ${error instanceof Error ? error.message : String(error)}`);
  });
  await boss.start();
  await boss.stop({ graceful: false, close: true });
}

/** Applies every pending app migration, then installs/upgrades the pg-boss schema. */
export async function migrateToLatest(options: MigrateOptions): Promise<string[]> {
  const applied = await run(options, 'up', Infinity);
  await installJobSchema(options);
  return applied;
}

/** Reverts the last `count` app migrations (`Infinity` = back to version zero). */
export function rollbackMigrations(options: MigrateOptions & { count: number }): Promise<string[]> {
  return run(options, 'down', options.count);
}

/** Drops `public` and the pg-boss schema, recreates `public`, then migrates to the latest version. */
export async function resetDatabase(options: MigrateOptions): Promise<string[]> {
  const client = new pg.Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${PGBOSS_SCHEMA} CASCADE`);
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
  return migrateToLatest(options);
}
