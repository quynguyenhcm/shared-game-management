import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
  packageManager: string;
  engines: { node: string };
};

const REQUIRED_TARGETS = [
  'setup',
  'dev',
  'lint',
  'typecheck',
  'test',
  'test:integration',
  'db:migrate',
  'db:rollback',
  'db:reset',
  'build',
  'ci',
  'db:new',
  'db:codegen',
  'openapi',
  'jobs:trigger',
  'test:e2e',
  'lint:actions',
];

describe('root package.json targets (AC-VERIFY-1)', () => {
  it.each(REQUIRED_TARGETS)('defines the %s script', (target) => {
    expect(pkg.scripts[target], `missing root script "${target}"`).toBeTruthy();
  });

  it('pins pnpm 10 and Node 24 and keeps ci equal to the local gates', () => {
    expect(pkg.packageManager).toMatch(/^pnpm@10\./);
    expect(pkg.engines.node).toBe('>=24 <25');
    expect(pkg.scripts.ci).toBe(
      'pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run test:integration && pnpm run build',
    );
  });
});
