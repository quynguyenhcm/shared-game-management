/** AC-VERIFY-9: the 80% coverage gate names the auth code, and CI runs it over unit and integration tests. */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url);

describe('coverage gate (AC-VERIFY-9)', () => {
  it('includes the auth module, the auth platform and the web lib with 80% thresholds', async () => {
    const config = await readFile(new URL('vitest.config.ts', root), 'utf8');
    expect(config).toContain("'apps/api/src/modules/auth/**/*.ts'");
    expect(config).toContain("'apps/api/src/lib/auth/**/*.ts'");
    expect(config).toContain("'apps/web/src/lib/**/*.ts'");
    // team-management (AC-VERIFY-8): the teams module is measured too.
    expect(config).toContain("'apps/api/src/modules/teams/**/*.ts'");
    // team-banking-and-gst (AC-VERIFY-12): the banking module and the shared NZ validators are measured too.
    expect(config).toContain("'apps/api/src/modules/team-banking/**/*.ts'");
    expect(config).toContain("'packages/shared/src/nz/**/*.ts'");
    // registration-and-waitlist (AC-VERIFY-9): the registrations module and the shared fee estimate are measured too.
    expect(config).toContain("'apps/api/src/modules/registrations/**/*.ts'");
    expect(config).toContain("'packages/shared/src/registrations/**/*.ts'");
    expect(config).toMatch(
      /thresholds: \{ lines: 80, functions: 80, branches: 80, statements: 80 \}/,
    );
  });

  it('is enforced by `pnpm run ci` through test:coverage, which runs every project (the DB-backed auth code is covered by integration tests)', async () => {
    const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['test:coverage']).toBe('vitest run --coverage');
    expect(pkg.scripts.ci).toContain('pnpm run test:coverage');
  });
});
