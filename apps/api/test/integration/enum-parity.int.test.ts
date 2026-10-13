/**
 * Shared TS enums equal the real PostgreSQL enums (AC-INTEGRATION-2, runtime guard).
 * The compile-time guard is apps/api/src/lib/db/enum-parity.ts; the codegen drift guard is
 * db-codegen.int.test.ts.
 */
import { DB_ENUMS } from '@sgm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

describe('enum parity', () => {
  it('maps every public pg_enum to a shared tuple with identical values in the same order, and vice versa', async () => {
    const { rows } = await db.pool.query<{ name: string; labels: string[] }>(
      `SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
         FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typnamespace = 'public'::regnamespace GROUP BY t.typname ORDER BY t.typname`,
    );
    const database = Object.fromEntries(rows.map((row) => [row.name, row.labels]));
    const shared = Object.fromEntries(
      Object.entries(DB_ENUMS as Readonly<Record<string, readonly string[]>>).map(
        ([name, values]) => [name, [...values]],
      ),
    );
    expect(shared).toEqual(database);
    expect(Object.keys(database)).toEqual(expect.arrayContaining(['auth_provider', 'fee_basis']));
  });
});
