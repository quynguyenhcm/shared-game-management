import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SkillTier } from '../types/enums.ts';
import {
  SKILL_PROGRESSION_GAMES,
  SKILL_PROGRESSION_WINDOW_DAYS,
  SKILL_PROGRESSION_WINDOW_MS,
  decideProgression,
  nextSkillLevel,
} from './progression.ts';

describe('constants (AC-VERIFY-4)', () => {
  it('pins the product rule: 40 games in a trailing 365 days, and the window as milliseconds', () => {
    expect(SKILL_PROGRESSION_GAMES).toBe(40);
    expect(SKILL_PROGRESSION_WINDOW_DAYS).toBe(365);
    expect(SKILL_PROGRESSION_WINDOW_MS).toBe(365 * 86_400_000);
  });
});

describe('nextSkillLevel', () => {
  it('walks BEGINNER -> INTERMEDIATE -> ADVANCED -> null', () => {
    expect(nextSkillLevel('BEGINNER')).toBe('INTERMEDIATE');
    expect(nextSkillLevel('INTERMEDIATE')).toBe('ADVANCED');
    expect(nextSkillLevel('ADVANCED')).toBeNull();
  });
});

describe('decideProgression (every level against 0, 39, 40, 41 and 400 games)', () => {
  const expected: Record<
    SkillTier,
    Record<number, { kind: 'promote'; to: SkillTier } | { kind: 'none'; reason: string }>
  > = {
    BEGINNER: {
      0: { kind: 'none', reason: 'below_threshold' },
      39: { kind: 'none', reason: 'below_threshold' },
      40: { kind: 'promote', to: 'INTERMEDIATE' },
      41: { kind: 'promote', to: 'INTERMEDIATE' },
      400: { kind: 'promote', to: 'INTERMEDIATE' },
    },
    INTERMEDIATE: {
      0: { kind: 'none', reason: 'below_threshold' },
      39: { kind: 'none', reason: 'below_threshold' },
      40: { kind: 'promote', to: 'ADVANCED' },
      41: { kind: 'promote', to: 'ADVANCED' },
      400: { kind: 'promote', to: 'ADVANCED' },
    },
    ADVANCED: {
      0: { kind: 'none', reason: 'highest_level' },
      39: { kind: 'none', reason: 'highest_level' },
      40: { kind: 'none', reason: 'highest_level' },
      41: { kind: 'none', reason: 'highest_level' },
      400: { kind: 'none', reason: 'highest_level' },
    },
  };

  it.each(
    SkillTier.flatMap((level) => [0, 39, 40, 41, 400].map((games) => [level, games] as const)),
  )('%s with %i games', (level, games) => {
    const decision = decideProgression({ level, games });
    const want = expected[level][games];
    if (want?.kind === 'promote') {
      expect(decision).toEqual({ kind: 'promote', from: level, to: want.to });
    } else {
      expect(decision).toEqual(want);
    }
  });

  it('moves exactly one level however many games there are, and never down', () => {
    const decision = decideProgression({ level: 'BEGINNER', games: 4000 });
    expect(decision).toEqual({ kind: 'promote', from: 'BEGINNER', to: 'INTERMEDIATE' });
    for (const level of SkillTier) {
      const result = decideProgression({ level, games: 1_000_000 });
      if (result.kind === 'promote') {
        expect(SkillTier.indexOf(result.to)).toBe(SkillTier.indexOf(level) + 1);
      }
    }
  });
});

describe('the rule lives in one place (AC-VERIFY-4 grep guard)', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage', '.git', 'test-results']);
  const OWNER = join('packages', 'shared', 'src', 'skill', 'progression.ts');

  function* sourceFiles(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        yield* sourceFiles(path);
      } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) {
        yield path;
      }
    }
  }

  /** True when a source line states this rule's numbers (a number paired with its subject, or the day-to-ms arithmetic). */
  function statesTheRule(line: string): boolean {
    return (
      /\b40\b.*\b(games?|skill|progress)/i.test(line) ||
      /\b(games?|skill|progress).*\b40\b/i.test(line) ||
      /\b365\b.*\b(days?|window|trailing|skill|progress|games?)/i.test(line) ||
      /\b(days?|window|trailing|skill|progress|games?).*\b365\b/i.test(line) ||
      /\b365\b.*\*\s*24\b/.test(line)
    );
  }

  it('detects the rule being restated (positive control) and ignores unrelated numbers', () => {
    for (const line of [
      'const d = 40; // games',
      'const needed = 40 // skill',
      'trailing 365 days',
      'window = 365 * 86400000',
      'const ms = 365 * 24 * 60 * 60 * 1000',
    ]) {
      expect(statesTheRule(line), line).toBe(true);
    }
    for (const line of ['limit: 400', 'port 4040', 'max(40)', 'year 3650']) {
      expect(statesTheRule(line), line).toBe(false);
    }
  });

  it('finds the literals 40 and 365 for this rule only in the shared constants', () => {
    const offenders: string[] = [];
    for (const top of ['apps', 'packages']) {
      for (const file of sourceFiles(join(root, top))) {
        const path = relative(root, file);
        if (path === OWNER || path.endsWith('types.generated.ts')) continue;
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, index) => {
            if (statesTheRule(line)) offenders.push(`${path}:${index + 1}: ${line.trim()}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});
