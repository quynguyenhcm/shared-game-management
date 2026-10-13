/**
 * Schema snapshots for the AC-VERIFY-5 migrate → rollback → migrate round trip.
 *
 * - `catalogSnapshot` reads the `public` schema from the system catalogs (columns, defaults,
 *   constraints, indexes, triggers, functions, enum labels, sequences). It needs no client binary,
 *   so it runs identically locally and in CI.
 * - `pgDumpSnapshot` runs the server's own `pg_dump --schema-only --schema=public --no-owner
 *   --no-comments` through `docker compose exec` (no client/server version skew). It returns
 *   undefined when the Compose `postgres` service is not reachable (e.g. the CI service container).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Queryable } from './test-db.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const CATALOG_QUERIES: readonly string[] = [
  `SELECT format('column %s.%s %s notnull=%s default=%s generated=%s', c.relname, a.attname,
          format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attgenerated)
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND a.attnum > 0
      AND NOT a.attisdropped`,
  `SELECT format('constraint %s %s %s deferrable=%s deferred=%s', conrelid::regclass, conname,
          pg_get_constraintdef(oid), condeferrable, condeferred)
     FROM pg_constraint WHERE connamespace = 'public'::regnamespace`,
  `SELECT format('index %s', indexdef) FROM pg_indexes WHERE schemaname = 'public'`,
  `SELECT format('trigger %s', pg_get_triggerdef(t.oid))
     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal`,
  `SELECT format('function %s', pg_get_functiondef(p.oid))
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace`,
  `SELECT format('enum %s %s', t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder))
     FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typnamespace = 'public'::regnamespace GROUP BY t.typname`,
  `SELECT format('sequence %s', relname) FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relkind = 'S'`,
  `SELECT format('extension %s', extname) FROM pg_extension`,
];

export async function catalogSnapshot(db: Queryable): Promise<string[]> {
  const lines: string[] = [];
  for (const text of CATALOG_QUERIES) {
    const { rows } = await db.query<{ format: string }>(text);
    lines.push(...rows.map((row) => row.format));
  }
  return lines.sort();
}

export function pgDumpSnapshot(databaseUrl: string, database: string): string | undefined {
  const user = decodeURIComponent(new URL(databaseUrl).username);
  const result = spawnSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'pg_dump',
      '-U',
      user,
      '-d',
      database,
      '--schema-only',
      '--schema=public',
      '--no-owner',
      '--no-comments',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000 },
  );
  if (result.status !== 0) return undefined;
  return result.stdout
    .split('\n')
    .filter((line) => !/^\\(un)?restrict /.test(line) && !line.startsWith('--') && line.trim())
    .join('\n');
}
