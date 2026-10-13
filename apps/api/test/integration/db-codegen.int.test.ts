/**
 * The committed kysely-codegen output matches a fresh generation against the migrated schema
 * (AC-INTEGRATION-2 / Q12 option 12A drift guard). Regenerate with `pnpm run db:codegen`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const GENERATED = fileURLToPath(new URL('../../src/lib/db/types.generated.ts', import.meta.url));

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

describe('kysely-codegen drift', () => {
  it('regenerating the types against the migrated database reproduces types.generated.ts', () => {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL('../../node_modules/kysely-codegen/dist/cli/bin.js', import.meta.url),
        ),
        '--url',
        db.url,
        '--print',
        '--log-level',
        'error',
      ],
      {
        cwd: API_ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, DATABASE_URL: db.url },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const committed = readFileSync(GENERATED, 'utf8');
    expect(result.stdout.trim()).toBe(committed.trim());
    // The overrides that keep money and wall-clock values branded are in effect.
    expect(committed).toMatch(/import type \{ .*MoneyString.* \} from "@sgm\/shared"/);
    expect(committed).toMatch(/amount: MoneyString;/);
    expect(committed).toMatch(/date: LocalDate;/);
    expect(committed).toMatch(/bank_account_number: Ciphertext \| null;/);
  });
});
