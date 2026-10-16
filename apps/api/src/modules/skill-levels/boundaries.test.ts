/**
 * Structural guard for the skill-levels read seams (seams architecture, "Import graph"): `games.ts` and
 * `auto-enrol.ts` are LEAVES. They may import only `lib/`, `kysely`, `@sgm/shared` and Node built-ins, never
 * another module's internals, so `teams/member-read.ts` can embed the counting fragment (Phase 3) without a cycle.
 * TODO(Phase 3): add `../teams/member-read.ts` to the checked files (it may import only `skill-levels/games.ts`
 * from this module) and the other files' allowed edges.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const LEAVES = ['games.ts', 'auto-enrol.ts'] as const;

function importSpecifiers(file: string): string[] {
  const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8');
  return [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gm)].map(
    (match) => match[1] ?? '',
  );
}

describe('skill-levels leaf files', () => {
  it.each(LEAVES)('%s imports nothing from another module or from its siblings', (file) => {
    const specifiers = importSpecifiers(file);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      const allowed =
        specifier === 'kysely' ||
        specifier === '@sgm/shared' ||
        specifier.startsWith('node:') ||
        specifier.startsWith('../../lib/');
      expect(allowed, `${file} imports ${specifier}`).toBe(true);
    }
  });
});
