/**
 * Structural guard for the invoice single-writer rule (tax-invoices-and-exports; ADR 0021 section 9; AC-VERIFY-7, partial in
 * Phase 1: the schema-level rules that hold before the issuance module exists).
 *
 * - No TypeScript source writes `payment_documents` or `team_invoice_counters`: the SQL function `issue_payment_document` is
 *   the only issuer, and `assign_invoice_number` is only ever called by it.
 * - Only `modules/invoices/repo.ts` may call `issue_payment_document(`.
 * - No source sets the invoice columns of `payments` (`invoice_number`, `invoice_issued_at`): the generated
 *   `is_tax_invoice_issued` cannot be written at all, and billing never sets any of them (ADR 0020 C-INV-1).
 * Each rule is proven to detect a violation, so a weakened regex cannot pass silently.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(fileURLToPath(new URL('./', import.meta.url)), '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

const strip = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const all = sourceFiles(SRC).map((file) => ({
  file,
  rel: path.relative(SRC, file).split(path.sep).join('/'),
  text: strip(readFileSync(file, 'utf8')),
}));

const DOCUMENT_TABLES = 'payment_documents|team_invoice_counters';
const WRITES_DOCUMENT_TABLES = new RegExp(
  `(?:insertInto|updateTable|deleteFrom)\\(\\s*['"\`](?:${DOCUMENT_TABLES})['"\`]` +
    `|(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:${DOCUMENT_TABLES})\\b`,
  'i',
);
const CALLS_ISSUER = /\bissue_payment_document\s*\(/;
const CALLS_ASSIGN = /\bassign_invoice_number\s*\(/;
/** A write to the invoice columns: a kysely `.set({ ... })` chain on payments or a raw UPDATE/INSERT naming them. */
const SETS_INVOICE_COLUMNS =
  /updateTable\(\s*['"`]payments['"`]\)[\s\S]{0,400}?\b(?:invoice_number|invoice_issued_at|is_tax_invoice_issued)\b|UPDATE\s+payments\b[\s\S]{0,400}?\bSET\b[\s\S]{0,300}?\b(?:invoice_number|invoice_issued_at|is_tax_invoice_issued)\b|INSERT\s+INTO\s+payments\b[^;]{0,600}?\b(?:invoice_number|invoice_issued_at|is_tax_invoice_issued)\b/i;
const ISSUER_FILES = ['modules/invoices/repo.ts'];

describe('the invoice issuer is the only writer (ADR 0021)', () => {
  it('scans the whole api source', () => {
    expect(all.length).toBeGreaterThan(100);
  });

  it('no TypeScript source writes payment_documents or team_invoice_counters', () => {
    const writers = all.filter(({ text }) => WRITES_DOCUMENT_TABLES.test(text));
    expect(writers.map(({ rel }) => rel)).toEqual([]);
  });

  it('only modules/invoices/repo.ts calls issue_payment_document, and no source calls assign_invoice_number', () => {
    const issuers = all.filter(({ text }) => CALLS_ISSUER.test(text)).map(({ rel }) => rel);
    // Phase 2: repo.ts exists and is the sole issuer (an exact match, so the rule cannot pass vacuously).
    expect(issuers).toEqual(ISSUER_FILES);
    expect(all.filter(({ text }) => CALLS_ASSIGN.test(text)).map(({ rel }) => rel)).toEqual([]);
  });

  it('no source sets the invoice columns of payments (billing and wallet included: ADR 0020 C-INV-1)', () => {
    const setters = all.filter(({ text }) => SETS_INVOICE_COLUMNS.test(text));
    expect(setters.map(({ rel }) => rel).filter((rel) => !ISSUER_FILES.includes(rel))).toEqual([]);
  });

  it('proves each rule detects a violation and ignores a read', () => {
    expect(WRITES_DOCUMENT_TABLES.test(`db.insertInto('payment_documents').values(x)`)).toBe(true);
    expect(
      WRITES_DOCUMENT_TABLES.test(`await trx.query('UPDATE team_invoice_counters SET x = 1')`),
    ).toBe(true);
    expect(WRITES_DOCUMENT_TABLES.test(`db.selectFrom('payment_documents').selectAll()`)).toBe(
      false,
    );
    expect(CALLS_ISSUER.test(`sql\`SELECT * FROM issue_payment_document(\${id})\``)).toBe(true);
    expect(CALLS_ISSUER.test('the issue_payment_document function')).toBe(false);
    expect(CALLS_ASSIGN.test('SELECT assign_invoice_number($1)')).toBe(true);
    expect(
      SETS_INVOICE_COLUMNS.test(
        `db.updateTable('payments').set({ invoice_number: 3 }).where('id', '=', id)`,
      ),
    ).toBe(true);
    expect(
      SETS_INVOICE_COLUMNS.test(`UPDATE payments SET status = 'PAID', invoice_issued_at = now()`),
    ).toBe(true);
    expect(
      SETS_INVOICE_COLUMNS.test(
        `db.updateTable('payments').set({ status: 'PAID' }).where('id', '=', id)`,
      ),
    ).toBe(false);
    expect(SETS_INVOICE_COLUMNS.test(`db.selectFrom('payments').select('invoice_number')`)).toBe(
      false,
    );
  });
});

/** The issuance code: the invoices module and the two jobs that drive it. */
const ISSUANCE_JOBS = ['jobs/issue-invoices.ts', 'jobs/invoice-reconcile.ts'];
const owned = all.filter(
  ({ rel }) => rel.startsWith('modules/invoices/') || ISSUANCE_JOBS.includes(rel),
);

describe('exact money and observability in the issuance code (AC-VERIFY-7)', () => {
  it('has the module and both jobs to scan', () => {
    expect(owned.map(({ rel }) => rel)).toEqual(
      expect.arrayContaining([
        'modules/invoices/repo.ts',
        'modules/invoices/issue.ts',
        ...ISSUANCE_JOBS,
      ]),
    );
  });

  it('uses no floating-point arithmetic or parsing, and types no money field as a number', () => {
    const moneyNumber =
      /\b(?:amount|total|balance|fee|price|subtotal|gst\w*|unitFee|resulting\w*)\s*[?:]\s*number\b/i;
    for (const { rel, text } of owned) {
      expect(text, rel).not.toMatch(
        /\bparseFloat\b|\.toFixed\(|\bNumber\(|\bMath\.|\bNumber\.parse/,
      );
      expect(text, rel).not.toMatch(moneyNumber);
    }
  });

  it('logs through the injected logger, never console', () => {
    for (const { rel, text } of owned) expect(text, rel).not.toMatch(/\bconsole\./);
  });
});

describe('imports of the issuance code', () => {
  /** The only files of other areas it may import (public files). */
  const PUBLIC = new Set([
    '../../jobs/registry.ts',
    '../modules/invoices/issue.ts',
    './registry.ts',
  ]);

  it('reach other modules only through public files: no billing, wallet or registrations import', () => {
    for (const { rel, text } of owned) {
      const specifiers = [
        ...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gm),
      ].map((match) => match[1] ?? '');
      for (const specifier of specifiers) {
        const external = !specifier.startsWith('.');
        const sameDir = specifier.startsWith('./');
        const platform = /^(?:\.\.\/)+lib\//.test(specifier);
        expect(
          external || sameDir || platform || PUBLIC.has(specifier),
          `${rel} imports ${specifier}`,
        ).toBe(true);
        expect(specifier, rel).not.toMatch(/billing|wallet|registrations|team-banking/);
      }
    }
  });

  it('the invoices module never imports a job except the queue registry', () => {
    for (const { rel, text } of owned.filter((file) => file.rel.startsWith('modules/invoices/'))) {
      for (const match of text.matchAll(/from\s+'([^']*jobs\/[^']*)'/g)) {
        expect(match[1], rel).toMatch(/jobs\/registry\.ts$/);
      }
    }
  });
});
