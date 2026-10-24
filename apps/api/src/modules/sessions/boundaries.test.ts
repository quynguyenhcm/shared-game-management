/**
 * Structural guard for the sessions module (AC-VERIFY-9, architecture SA-10 (iii) and (iv)):
 *
 * - `modules/sessions/**` reaches other modules only through their public files: `team-banking/publish-gate.ts`,
 *   `skill-levels/auto-enrol.ts` and `teams/admin-lock.ts`.
 * - It never writes `registrations`; the allocator port (registration-and-waitlist's adapter) is the only seam.
 * - Only `app.ts`, `main.ts`, `worker.ts`, `session-allocator.ts` and `jobs/*` import the sessions module, and any
 *   other module (registration, later) may import only `sessions/allocator-port.ts`.
 * - No sessions code takes a `teams` lock stronger than `KEY SHARE` (ADR 0016).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SESSIONS_DIR = fileURLToPath(new URL('./', import.meta.url));
const SRC_DIR = path.resolve(SESSIONS_DIR, '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function importSpecifiers(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gm)].map(
    (match) => match[1] ?? '',
  );
}

const PUBLIC_FILES = new Set([
  '../team-banking/publish-gate.ts',
  '../skill-levels/auto-enrol.ts',
  '../teams/admin-lock.ts',
]);

const isPlatform = (specifier: string): boolean =>
  specifier === 'kysely' ||
  specifier === '@sgm/shared' ||
  specifier === 'fastify' ||
  specifier === 'fastify-type-provider-zod' ||
  specifier === 'zod' ||
  specifier === 'pg' ||
  specifier.startsWith('node:') ||
  specifier.startsWith('../../lib/') ||
  specifier === '../../jobs/registry.ts';

const sessionsFiles = sourceFiles(SESSIONS_DIR);

describe('modules/sessions imports', () => {
  it('has module files to guard', () => {
    expect(sessionsFiles.length).toBeGreaterThan(0);
  });

  it.each(sessionsFiles.map((file) => [path.basename(file), file] as const))(
    '%s reaches other modules only through their public files',
    (_name, file) => {
      for (const specifier of importSpecifiers(file)) {
        const allowed =
          isPlatform(specifier) || specifier.startsWith('./') || PUBLIC_FILES.has(specifier);
        expect(allowed, `${path.basename(file)} imports ${specifier}`).toBe(true);
      }
    },
  );

  it('never writes the registrations table (the allocator port is the only seam)', () => {
    const writes =
      /(?:insertInto|updateTable|deleteFrom)\(\s*['"`]registrations['"`]|(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+registrations\b/i;
    for (const file of sessionsFiles) {
      expect(stripComments(readFileSync(file, 'utf8')), path.basename(file)).not.toMatch(writes);
    }
  });

  it('never locks the teams row harder than KEY SHARE', () => {
    for (const file of sessionsFiles) {
      const source = stripComments(readFileSync(file, 'utf8'));
      expect(source, path.basename(file)).not.toMatch(
        /lockTeamRow\([^)]*['"](?:update|noKeyUpdate|share)['"]/,
      );
      expect(source, path.basename(file)).not.toMatch(
        /selectFrom\(\s*['"]teams['"]\s*\)[^;]*\.for(?:Update|NoKeyUpdate|Share)\(/,
      );
    }
  });
});

describe('who may import the sessions module', () => {
  const OWNERS = new Set(['app.ts', 'main.ts', 'worker.ts', 'session-allocator.ts']);
  const outsiders = sourceFiles(SRC_DIR).filter((file) => !file.startsWith(SESSIONS_DIR));

  it('only the composition files and jobs import it; any other module may import only allocator-port.ts', () => {
    for (const file of outsiders) {
      const relative = path.relative(SRC_DIR, file);
      for (const specifier of importSpecifiers(file)) {
        if (!specifier.startsWith('.')) continue;
        const target = path.resolve(path.dirname(file), specifier);
        if (!target.startsWith(SESSIONS_DIR)) continue;
        const owner = OWNERS.has(relative) || relative.startsWith(`jobs${path.sep}`);
        const portOnly = target === path.join(SESSIONS_DIR, 'allocator-port.ts');
        expect(owner || portOnly, `${relative} imports ${specifier}`).toBe(true);
      }
    }
  });
});
