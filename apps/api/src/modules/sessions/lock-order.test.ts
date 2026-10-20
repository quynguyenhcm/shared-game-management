/**
 * Static lock-order guard for the sessions module (AC-VERIFY-3, ADR 0016 lock rules, ADR 0019 T-1). The runtime half is the race
 * matrix (`sessions-races.int.test.ts`), which records the statements of every transaction and checks their order; this half reads
 * the source:
 *
 * - `modules/sessions/**` never takes `teams` stronger than `FOR KEY SHARE` (no `lockTeamRow(..., 'update' | 'noKeyUpdate' | 'share')`,
 *   no `teams` select with a `FOR UPDATE` / `FOR NO KEY UPDATE` / `FOR SHARE` clause).
 * - Inside every transaction callback (`async (trx) => ...`), no `teams` lock or gate call and no rule lock comes after the first
 *   `game_sessions` lock: `teams -> recurring_session_rules -> team_members -> game_sessions`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SESSIONS_DIR = fileURLToPath(new URL('./', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Calls that take or re-take `teams FOR KEY SHARE` (the prologue, and the publish gate whose read is `FOR KEY SHARE`). */
const TEAMS_LOCK_CALLS = [
  'lockTeamKeyShare(',
  'gateOrRefuse(',
  'checkTeamCanPublishPaidSession(',
  'lockTeamRow(',
];
const RULE_LOCK_CALLS = ['lockRule('];
/** Calls that lock `game_sessions` rows `FOR UPDATE`. */
const SESSION_LOCK_CALLS = ['lockSession(', 'lockRuleInstances(', 'lockedInstances('];

const lastIndexOfAny = (text: string, needles: readonly string[]): number =>
  Math.max(...needles.map((needle) => text.lastIndexOf(needle)));
const firstIndexOfAny = (text: string, needles: readonly string[]): number => {
  const found = needles.map((needle) => text.indexOf(needle)).filter((index) => index >= 0);
  return found.length === 0 ? -1 : Math.min(...found);
};

/** Splits a source into transaction callbacks: each region starts at an `async (trx` and runs to the next one. */
export function transactionRegions(source: string): string[] {
  const starts = [...source.matchAll(/async \(trx\b/g)].map((match) => match.index ?? 0);
  return starts.map((start, index) => source.slice(start, starts[index + 1] ?? source.length));
}

/** Order problems of one source: a teams or rule lock after the first `game_sessions` lock of a transaction callback. */
export function lockOrderProblems(source: string): string[] {
  const problems: string[] = [];
  for (const region of transactionRegions(stripComments(source))) {
    const firstSession = firstIndexOfAny(region, SESSION_LOCK_CALLS);
    if (firstSession === -1) continue;
    const afterSession = region.slice(firstSession + 1);
    const teamsAfter = lastIndexOfAny(afterSession, TEAMS_LOCK_CALLS);
    const ruleAfter = lastIndexOfAny(afterSession, RULE_LOCK_CALLS);
    // A `lockedInstances(` call inside its own definition region is not an acquisition after anything.
    if (teamsAfter >= 0)
      problems.push('a teams lock or the publish gate after a game_sessions lock');
    if (ruleAfter >= 0) problems.push('a recurring_session_rules lock after a game_sessions lock');
  }
  return problems;
}

/** `teams` locks stronger than KEY SHARE in a source. */
export function strongTeamsLocks(source: string): string[] {
  const code = stripComments(source);
  return [
    ...[...code.matchAll(/lockTeamRow\([^)]*'(update|noKeyUpdate|share)'/g)].map((m) => m[0]),
    ...[
      ...code.matchAll(/selectFrom\('teams'\)[^;]*?\.(forUpdate|forNoKeyUpdate|forShare)\(\)/g),
    ].map((m) => m[0]),
    ...[...code.matchAll(/from\s+teams\b[^;`]*\bfor\s+(update|no key update|share)\b/gi)].map(
      (m) => m[0],
    ),
  ];
}

describe('lock order in modules/sessions (static)', () => {
  const files = sourceFiles(SESSIONS_DIR);
  const sources = files.map((file) => ({
    file: path.relative(SESSIONS_DIR, file),
    source: readFileSync(file, 'utf8'),
  }));

  it('never takes teams stronger than FOR KEY SHARE', () => {
    for (const { file, source } of sources) {
      expect(strongTeamsLocks(source), file).toEqual([]);
    }
  });

  it('never takes a teams lock, the gate or a rule lock after the first game_sessions lock of a transaction', () => {
    let checked = 0;
    for (const { file, source } of sources) {
      for (const region of transactionRegions(stripComments(source))) {
        if (firstIndexOfAny(region, SESSION_LOCK_CALLS) >= 0) checked += 1;
      }
      expect(lockOrderProblems(source), file).toEqual([]);
    }
    // The guard is not vacuous: the one-off service, series service and the retry all lock sessions inside a transaction.
    expect(checked).toBeGreaterThanOrEqual(6);
  });

  it('detects a violation (the guard itself works)', () => {
    const bad = `
      db.run(async (trx) => {
        await lockSession(trx, input);
        await lockTeamKeyShare(trx, teamId);
      });
      db.run(async (trx) => {
        await lockSession(trx, input);
        await lockRule(trx, ref);
      });`;
    expect(lockOrderProblems(bad)).toHaveLength(2);
    expect(strongTeamsLocks(`await lockTeamRow(trx, teamId, 'noKeyUpdate');`)).toHaveLength(1);
    const good = `db.run(async (trx) => { await lockTeamKeyShare(trx, t); await lockRule(trx, r); await lockSession(trx, s); });`;
    expect(lockOrderProblems(good)).toEqual([]);
  });
});
