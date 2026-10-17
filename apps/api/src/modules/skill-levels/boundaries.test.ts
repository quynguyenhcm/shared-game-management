/**
 * Structural guard for the skill-levels read seams (seams architecture, "Import graph"). The graph is two-way at
 * module level (`teams/member-read.ts` -> `skill-levels/games.ts`, `skill-levels/*` -> `teams/admin-lock.ts` and
 * `teams/member-read.ts`), so it must stay acyclic at file level:
 *
 * - `games.ts` and `auto-enrol.ts` are LEAVES: only `lib/`, `kysely`, `@sgm/shared` and Node built-ins.
 * - `teams/member-read.ts` (the one `TeamMemberRow` mapper) may add exactly one module edge: `skill-levels/games.ts`.
 * - The rest of `skill-levels/` may reach into `teams/` only through its public files `admin-lock.ts` and
 *   `member-read.ts` (never `teams/repo.ts` or `teams/service.ts`), and into no other module.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const LEAVES = ['games.ts', 'auto-enrol.ts'] as const;

function importSpecifiers(relativePath: string): string[] {
  const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
  return [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gm)].map(
    (match) => match[1] ?? '',
  );
}

const isPlatform = (specifier: string): boolean =>
  specifier === 'kysely' ||
  specifier === '@sgm/shared' ||
  specifier.startsWith('node:') ||
  specifier.startsWith('../../lib/');

describe('skill-levels leaf files', () => {
  it.each(LEAVES)('%s imports nothing from another module or from its siblings', (file) => {
    const specifiers = importSpecifiers(`./${file}`);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(isPlatform(specifier), `${file} imports ${specifier}`).toBe(true);
    }
  });

  it('teams/member-read.ts imports only the platform and skill-levels/games.ts (no cycle back)', () => {
    const specifiers = importSpecifiers('../teams/member-read.ts');
    expect(specifiers).toContain('../skill-levels/games.ts');
    for (const specifier of specifiers) {
      expect(
        isPlatform(specifier) || specifier === '../skill-levels/games.ts',
        `member-read.ts imports ${specifier}`,
      ).toBe(true);
    }
  });

  it('the other skill-levels files reach teams only through admin-lock.ts and member-read.ts', () => {
    const dir = fileURLToPath(new URL('./', import.meta.url));
    const files = readdirSync(dir).filter(
      (name) =>
        name.endsWith('.ts') && !name.endsWith('.test.ts') && !LEAVES.includes(name as never),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      for (const specifier of importSpecifiers(`./${file}`)) {
        const allowed =
          isPlatform(specifier) ||
          specifier.startsWith('./') ||
          specifier === 'fastify' ||
          specifier === 'fastify-type-provider-zod' ||
          specifier === '../teams/admin-lock.ts' ||
          specifier === '../teams/member-read.ts';
        expect(allowed, `${file} imports ${specifier}`).toBe(true);
      }
    }
  });
});
