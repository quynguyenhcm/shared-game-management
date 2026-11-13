/**
 * Structural guard for the income exports (tax-invoices-and-exports Phase 4; architecture section 6; AC-VERIFY-5, AC-VERIFY-7):
 *
 * - `modules/income-exports/**` and `lib/tabular/**` write no table: an export is a pure read.
 * - Neither selects a column that could leak a secret or a contact detail into a file: no email address, bank detail, Akahu id,
 *   authorisation URL or token, and no `payment_attempts` / `credit_transactions` / `team_banking` read.
 * - Exact money and observability: no floating-point parsing or arithmetic, no money field typed `number`, no `console`.
 * - The module reaches other modules only through their public files, and the generic writers import no module at all.
 * Each rule is proven to detect a violation, so a weakened pattern cannot pass silently.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(fileURLToPath(new URL('./', import.meta.url)), '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
  });
}

const strip = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const owned = ['modules/income-exports', 'lib/tabular'].flatMap((dir) =>
  sourceFiles(path.join(SRC, dir)).map((file) => ({
    rel: path.relative(SRC, file).split(path.sep).join('/'),
    text: strip(readFileSync(file, 'utf8')),
  })),
);

const WRITES =
  /(?:insertInto|updateTable|deleteFrom|replaceInto|mergeInto)\(|\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE)\b/i;
const SENSITIVE =
  /\bemail\b|akahu_|authorisation_url|payment_link_token|bank_account|ird_number|\btoken\b|payment_attempts|credit_transactions|team_banking|wallet_top_ups/i;
const FLOAT = /\bparseFloat\b|\.toFixed\(|\bNumber\(|\bMath\.|\bNumber\.parse/;
const MONEY_NUMBER =
  /\b(?:amount|total|balance|fee|price|subtotal|gst\w*|unitFee|resulting\w*)\s*[?:]\s*number\b/i;

describe('income exports are read-only and leak nothing (AC-VERIFY-5)', () => {
  it('has the module and the writers to scan', () => {
    expect(owned.map(({ rel }) => rel)).toEqual(
      expect.arrayContaining([
        'lib/tabular/cells.ts',
        'lib/tabular/csv.ts',
        'lib/tabular/xlsx.ts',
        'modules/income-exports/repo.ts',
        'modules/income-exports/rows.ts',
        'modules/income-exports/service.ts',
        'modules/income-exports/routes.ts',
      ]),
    );
  });

  it('writes no table and names no sensitive column or table', () => {
    for (const { rel, text } of owned) {
      expect(text, rel).not.toMatch(WRITES);
      expect(text, rel).not.toMatch(SENSITIVE);
    }
  });

  it('uses no floating-point money, types no money field as a number and never logs to console', () => {
    for (const { rel, text } of owned) {
      expect(text, rel).not.toMatch(FLOAT);
      expect(text, rel).not.toMatch(MONEY_NUMBER);
      expect(text, rel).not.toMatch(/\bconsole\./);
    }
  });

  it('the writers import no module, and the module imports other modules only through public files', () => {
    const PUBLIC = new Set([
      '../../lib/tabular/cells.ts',
      '../../lib/tabular/csv.ts',
      '../../lib/tabular/xlsx.ts',
    ]);
    for (const { rel, text } of owned) {
      const specifiers = [
        ...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gm),
      ].map((match) => match[1] ?? '');
      for (const specifier of specifiers) {
        expect(specifier, `${rel} imports ${specifier}`).not.toMatch(/modules\//);
        if (rel.startsWith('lib/tabular/')) {
          expect(
            specifier.startsWith('./') || !specifier.startsWith('.'),
            `${rel} imports ${specifier}`,
          ).toBe(true);
        } else {
          const ok =
            !specifier.startsWith('.') ||
            specifier.startsWith('./') ||
            /^\.\.\/\.\.\/lib\/(?!tabular\/)/.test(specifier) ||
            PUBLIC.has(specifier);
          expect(ok, `${rel} imports ${specifier}`).toBe(true);
        }
      }
    }
  });

  it('proves each rule detects a violation and ignores a read', () => {
    expect(WRITES.test(`db.insertInto('payments').values(x)`)).toBe(true);
    expect(WRITES.test(`sql\`UPDATE payments SET paid_at = now()\``)).toBe(true);
    expect(WRITES.test(`db.selectFrom('payments').select('id')`)).toBe(false);
    expect(WRITES.test(`sql\`DECLARE income_export NO SCROLL CURSOR FOR \${query}\``)).toBe(false);
    expect(SENSITIVE.test(`.select('u.email')`)).toBe(true);
    expect(SENSITIVE.test(`'p.akahu_payment_id'`)).toBe(true);
    expect(SENSITIVE.test(`.select('p.payment_reference')`)).toBe(false);
    expect(FLOAT.test('Number(cell)')).toBe(true);
    expect(FLOAT.test('parseMoney(cell)')).toBe(false);
    expect(MONEY_NUMBER.test('readonly total: number')).toBe(true);
    expect(MONEY_NUMBER.test('readonly total: MoneyString')).toBe(false);
  });
});
