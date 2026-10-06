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
    expect(pkg.engines.node).toBe('>=24.7 <25');
    expect(pkg.scripts.ci).toBe(
      'pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run test:integration && pnpm run build',
    );
  });
});

describe('root dev target (runs web, api and worker)', () => {
  const apiPkg = JSON.parse(
    readFileSync(new URL('../apps/api/package.json', import.meta.url), 'utf8'),
  ) as { scripts: Record<string, string> };

  it('runs every app dev script in parallel', () => {
    expect(pkg.scripts.dev).toContain('pnpm -r --parallel --filter "./apps/*" dev');
  });

  it("@sgm/api's dev starts both the API and the worker (cron slots and queued jobs run)", () => {
    const selector = /pnpm run "\/(.+)\/"/.exec(apiPkg.scripts.dev ?? '')?.[1];
    expect(selector, 'api dev must run a script regex').toBeDefined();
    const pattern = new RegExp(selector ?? '$^');
    const selected = Object.keys(apiPkg.scripts).filter((name) => pattern.test(name));
    expect(selected.sort()).toEqual(['dev:api', 'dev:worker']);
    expect(apiPkg.scripts['dev:api']).toContain('src/main.ts');
    expect(apiPkg.scripts['dev:worker']).toContain('src/worker.ts');
    for (const name of selected) {
      expect(apiPkg.scripts[name], name).toContain('--import ./src/instrumentation.ts');
    }
  });
});
