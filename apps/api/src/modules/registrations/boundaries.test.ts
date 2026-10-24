/**
 * Structural guard for the registrations module (architecture Q2 guideline 4; AC-VERIFY-3, AC-VERIFY-10; R5, R22):
 *
 * - `repo.ts` is the ONLY file that writes `registrations` / `registration_guests`, and its promotion writer is imported
 *   only by `allocator.ts` (`promoteWaitlist` is the only promoter).
 * - No source here writes a money table; the OVERDUE debt count is the one read of `payments`.
 * - The allocator never opens a transaction, never sets a lock timeout, never retries, never takes an advisory lock or a
 *   `teams` lock, never updates `game_sessions`, and reads no clock of its own (one `now` per operation).
 * - Imports stay inside the platform, `teams/membership.ts` and `jobs/send-email.ts`; from the sessions module only the port.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('./', import.meta.url));
const SRC = path.resolve(DIR, '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

const strip = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (file: string): string => strip(readFileSync(file, 'utf8'));
const own = sourceFiles(DIR);
const named = (name: string): string => path.join(DIR, name);

const WRITES =
  /(?:insertInto|updateTable|deleteFrom)\(\s*['"`](?:registrations|registration_guests)['"`]|(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:registrations|registration_guests)\b/i;

describe('who writes registrations', () => {
  it('has the module files to guard', () => {
    expect(own.map((file) => path.basename(file))).toEqual(
      expect.arrayContaining(['allocation.ts', 'allocator.ts', 'repo.ts', 'deadline.ts', 'tx.ts']),
    );
  });

  it('only modules/registrations/repo.ts writes registrations or registration_guests, anywhere in apps/api/src', () => {
    const writers = sourceFiles(SRC).filter((file) => WRITES.test(read(file)));
    expect(writers.map((file) => path.relative(SRC, file))).toEqual([
      path.join('modules', 'registrations', 'repo.ts'),
    ]);
  });

  it('only allocator.ts imports the promotion writer, and the writer exists', () => {
    expect(read(named('repo.ts'))).toMatch(/export (?:async )?function promoteRegistrations\b/);
    const importers = own.filter(
      (file) => path.basename(file) !== 'repo.ts' && /\bpromoteRegistrations\b/.test(read(file)),
    );
    expect(importers.map((file) => path.basename(file))).toEqual(['allocator.ts']);
  });
});

describe('money tables (AC-VERIFY-10)', () => {
  const MONEY =
    /\b(?:payments|payment_line_items|credit_transactions|player_credits|team_invoice_counters)\b/;

  it('no source writes a money table', () => {
    for (const file of own) {
      expect(read(file), path.basename(file)).not.toMatch(
        /(?:insertInto|updateTable|deleteFrom)\(\s*['"`](?:payments|payment_line_items|credit_transactions|player_credits|team_invoice_counters)['"`]/,
      );
    }
  });

  it('only repo.ts mentions one, and only to count OVERDUE payments', () => {
    const mentioning = own.filter((file) => MONEY.test(read(file)));
    expect(mentioning.map((file) => path.basename(file))).toEqual(['repo.ts']);
    const repo = read(named('repo.ts'));
    expect(repo.match(/\bpayments\b/g)?.length).toBeGreaterThan(0);
    expect(repo).not.toMatch(
      /\b(?:payment_line_items|credit_transactions|player_credits|team_invoice_counters)\b/,
    );
    expect(repo).toMatch(/selectFrom\(\s*['"]payments['"]\s*\)/);
  });
});

describe('the allocator never manages its caller transaction', () => {
  const allocator = (): string => read(named('allocator.ts'));

  it('opens no transaction, sets no lock timeout, retries nothing (R22)', () => {
    expect(allocator()).not.toMatch(
      /\.transaction\(\)|lock_timeout|runAllocatorTransaction|setTimeout/,
    );
  });

  it('the port adapter is a wrapper: no transaction, lock, retry, clock or SQL of its own, and only allocator.ts plus the port file as imports (R19)', () => {
    const adapter = read(named('session-allocator-adapter.ts'));
    expect(adapter).not.toMatch(
      /\.transaction\(\)|lock_timeout|runAllocatorTransaction|setTimeout|selectFrom|insertInto|updateTable|new Date\(|Date\.now|\.now\(\)/,
    );
    const specifiers = [...adapter.matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1]);
    expect(specifiers.filter((s) => s?.includes('sessions'))).toEqual([
      '../sessions/allocator-port.ts',
    ]);
  });

  it('takes no advisory lock, no SERIALIZABLE, no teams lock and never updates game_sessions', () => {
    for (const file of own.filter((f) => !f.endsWith('tx.ts'))) {
      const source = read(file);
      expect(source, path.basename(file)).not.toMatch(/pg_advisory|SERIALIZABLE/i);
      expect(source, path.basename(file)).not.toMatch(
        /selectFrom\(\s*['"]teams['"]\s*\)[^;]*\.for(?:Update|NoKeyUpdate|Share|KeyShare)\(/,
      );
      expect(source, path.basename(file)).not.toMatch(/updateTable\(\s*['"]game_sessions['"]/);
    }
  });

  it('reads no clock of its own: time arrives as `now` and SQL never calls now()', () => {
    for (const name of [
      'allocation.ts',
      'allocator.ts',
      'deadline.ts',
      'repo.ts',
      'billing-handoff.ts',
    ]) {
      const source = read(named(name));
      expect(source, name).not.toMatch(/new Date\(\)|Date\.now\(\)|clock\.now\(\)/);
      expect(source, name).not.toMatch(/\bnow\(\)|CURRENT_TIMESTAMP/i);
    }
  });

  it('logs through the injected logger, never console', () => {
    for (const file of own) expect(read(file), path.basename(file)).not.toMatch(/\bconsole\./);
  });
});

describe('imports', () => {
  const isPlatform = (specifier: string): boolean =>
    specifier === 'kysely' ||
    specifier === '@sgm/shared' ||
    specifier.startsWith('node:') ||
    specifier.startsWith('../../lib/') ||
    specifier.startsWith('./');
  const PUBLIC = new Set([
    '../teams/membership.ts',
    '../../jobs/send-email.ts',
    '../sessions/allocator-port.ts',
  ]);

  it.each(own.map((file) => [path.basename(file), file] as const))(
    '%s reaches other modules only through their public files',
    (_name, file) => {
      const source = readFileSync(file, 'utf8');
      const specifiers = [
        ...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gm),
      ].map((match) => match[1] ?? '');
      for (const specifier of specifiers) {
        expect(
          isPlatform(specifier) || PUBLIC.has(specifier),
          `${path.basename(file)} imports ${specifier}`,
        ).toBe(true);
      }
    },
  );
});
