/**
 * Vitest globalSetup for the integration project (AC-VERIFY-17).
 *
 * Builds one template database `sgm_tpl_<runId>` per run (app migrations + pg-boss schema) under a
 * Postgres advisory lock, then hands its name to the test files. Each test file clones its own
 * database from the template (`test/helpers/test-db.ts`), so parallel files never see each other's
 * rows, and tests that roll migrations back never touch the dev `sgm` database. Teardown drops the
 * template and any clone this run left behind.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrateToLatest } from '../src/lib/db/migrate.ts';
import { databaseUrlFor } from './helpers/db-url.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Maintenance connection string (the DATABASE_URL server), used to create and drop clones. */
    sgmAdminDatabaseUrl: string;
    /** Name of this run's migrated template database. */
    sgmTemplateDatabase: string;
    /** Unique per `test:integration` run; prefixes every clone name. */
    sgmRunId: string;
  }
}

/** Serialises template builds across concurrent runs on the same server (arbitrary constant). */
const TEMPLATE_LOCK_KEY = 72_415_001;

async function withAdminClient<T>(
  adminUrl: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    throw new Error('test:integration needs DATABASE_URL (a PostgreSQL 17 server with CREATEDB)');
  }
  const runId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const template = `sgm_tpl_${runId}`;

  await withAdminClient(adminUrl, async (client) => {
    await client.query('SELECT pg_advisory_lock($1)', [TEMPLATE_LOCK_KEY]);
    try {
      await client.query(`CREATE DATABASE ${template}`);
      await migrateToLatest({ databaseUrl: databaseUrlFor(adminUrl, template) });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [TEMPLATE_LOCK_KEY]);
    }
  });

  project.provide('sgmAdminDatabaseUrl', adminUrl);
  project.provide('sgmTemplateDatabase', template);
  project.provide('sgmRunId', runId);

  return async () => {
    await withAdminClient(adminUrl, async (client) => {
      const { rows } = await client.query<{ datname: string }>(
        `SELECT datname FROM pg_database WHERE datname = $1 OR datname LIKE $2`,
        [template, `sgm\\_test\\_${runId}\\_%`],
      );
      for (const { datname } of rows) {
        await client.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`);
      }
    });
  };
}
