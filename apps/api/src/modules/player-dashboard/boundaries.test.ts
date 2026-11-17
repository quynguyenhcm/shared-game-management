/**
 * Structural guard for the player-dashboard module (AC-HAPPY-7): it is a READ model over tables other modules own.
 *
 * - No source here inserts, updates or deletes anything (query builder or raw SQL), and no lock clause is taken.
 * - Reads run in a read-only snapshot transaction.
 * - It reaches other modules only through the public registrations helpers it reuses (fees, access, deadline, read-model and the
 *   OVERDUE count in repo.ts), and logs through nothing but the injected request logger (no `console`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('./', import.meta.url));
const own = readdirSync(DIR)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => path.join(DIR, name));

const strip = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (file: string): string => strip(readFileSync(file, 'utf8'));

const WRITE =
  /\b(?:insertInto|updateTable|deleteFrom|mergeInto)\s*\(|\b(?:INSERT\s+INTO|UPDATE\s+\w+|DELETE\s+FROM|TRUNCATE)\b/i;
const LOCK =
  /\.for(?:Update|NoKeyUpdate|Share|KeyShare)\(|\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE)\b/i;

describe('the player-dashboard module is read-only', () => {
  it('has the files to guard', () => {
    expect(own.map((file) => path.basename(file)).sort()).toEqual([
      'repo.ts',
      'routes.ts',
      'service.ts',
    ]);
  });

  it('writes and locks nothing, in any file', () => {
    for (const file of own) {
      expect(read(file), path.basename(file)).not.toMatch(WRITE);
      expect(read(file), path.basename(file)).not.toMatch(LOCK);
    }
  });

  it('proves the guard detects a write and a lock', () => {
    expect(WRITE.test(`trx.insertInto('registrations').values(x)`)).toBe(true);
    expect(WRITE.test(`sql\`UPDATE payments SET status = 'PAID'\``)).toBe(true);
    expect(WRITE.test(`trx.deleteFrom("payments")`)).toBe(true);
    expect(WRITE.test(`trx.selectFrom('payments').selectAll()`)).toBe(false);
    expect(LOCK.test(`q.forUpdate()`)).toBe(true);
  });

  it('reads inside a read-only, snapshot transaction', () => {
    const service = read(path.join(DIR, 'service.ts'));
    expect(service).toMatch(/setIsolationLevel\('repeatable read'\)/);
    expect(service).toMatch(/setAccessMode\('read only'\)/);
  });
});

describe('imports and logging', () => {
  const PUBLIC = new Set([
    '../registrations/access.ts',
    '../registrations/deadline.ts',
    '../registrations/read-model.ts',
    '../registrations/repo.ts',
  ]);
  const isPlatform = (specifier: string): boolean =>
    specifier === 'kysely' ||
    specifier === 'fastify' ||
    specifier === 'fastify-type-provider-zod' ||
    specifier === '@sgm/shared' ||
    specifier.startsWith('node:') ||
    specifier.startsWith('../../lib/') ||
    specifier.startsWith('./');

  it.each(own.map((file) => [path.basename(file), file] as const))(
    '%s reaches other modules only through the registrations helpers it reuses',
    (_name, file) => {
      const specifiers = [
        ...readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gm),
      ].map((match) => match[1] ?? '');
      for (const specifier of specifiers) {
        expect(isPlatform(specifier) || PUBLIC.has(specifier), specifier).toBe(true);
      }
    },
  );

  it('never calls console', () => {
    for (const file of own) expect(read(file), path.basename(file)).not.toMatch(/\bconsole\./);
  });
});
