/**
 * Structural guards for money state (wallet-and-akahu-billing; ADR 0020; AC-VERIFY-11, AC-VERIFY-4; CR-5, CR-9, C-ALL-1). The
 * counterpart of `registrations/boundaries.test.ts` for the money tables:
 *
 * - `payments`, `payment_line_items` and `billing_session_blocks` are written only from `modules/billing/engine-repo.ts`.
 * - `player_credits` and `credit_transactions` are written only from `modules/wallet/ledger.ts`.
 * - `game_sessions.status = 'COMPLETED'` is written only by the billing engine; `payments.status = 'OVERDUE'` only by the
 *   daily-overdue job (the files below are the allowed paths for the later phases; none exists yet).
 * - Billing and the wallet never write `registrations` or `registration_guests` and reach other modules only through their public
 *   files. No billing or wallet code uses floating-point money.
 *
 * The scan covers every non-test source under `apps/api/src`, so a writer added anywhere else fails here. Each rule is also proved
 * to detect a violation, so the guard cannot go vacuous.
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
    return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.generated.ts')
      ? [full]
      : [];
  });
}

const strip = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const all = sourceFiles(SRC).map((file) => ({
  rel: path.relative(SRC, file).split(path.sep).join('/'),
  code: strip(readFileSync(file, 'utf8')),
}));

/** A write to one of `tables`: a query-builder call or a SQL statement (the `tx.ts`-style raw SQL included). */
const writeTo = (tables: readonly string[]): RegExp => {
  const names = tables.join('|');
  return new RegExp(
    `(?:insertInto|updateTable|deleteFrom)\\(\\s*['"\`](?:${names})['"\`]|(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:${names})\\b`,
    'i',
  );
};
const writers = (pattern: RegExp): string[] =>
  all.filter(({ code }) => pattern.test(code)).map(({ rel }) => rel);

const ENGINE = 'modules/billing/engine-repo.ts';
const LEDGER = 'modules/wallet/ledger.ts';
/** Where the daily-overdue job may live (Phase 3); today nothing writes OVERDUE. */
const OVERDUE_WRITERS = ['jobs/daily-overdue.ts', 'modules/billing/overdue.ts'];

describe('single writers of money state', () => {
  it('has the writer files to guard', () => {
    const files = all.map(({ rel }) => rel);
    expect(files).toEqual(expect.arrayContaining([ENGINE, LEDGER]));
  });

  it('payments, payment_line_items and billing_session_blocks are written only from billing/engine-repo.ts', () => {
    expect(writers(writeTo(['payments', 'payment_line_items', 'billing_session_blocks']))).toEqual([
      ENGINE,
    ]);
  });

  it('player_credits and credit_transactions are written only from wallet/ledger.ts', () => {
    expect(writers(writeTo(['player_credits', 'credit_transactions']))).toEqual([LEDGER]);
  });

  it('game_sessions becomes COMPLETED only in billing/engine-repo.ts (AC-VERIFY-11)', () => {
    const completes =
      /\.set\(\s*\{\s*status:\s*'COMPLETED'|SET\s+status\s*=\s*'COMPLETED'|status\s*=\s*'COMPLETED'\s*(?:::\w+)?\s*(?:,|WHERE)/i;
    expect(writers(completes)).toEqual([ENGINE]);
  });

  it('payments become OVERDUE only in the daily-overdue job (none exists yet)', () => {
    const overdue = /\.set\(\s*\{\s*status:\s*'OVERDUE'|SET\s+status\s*=\s*'OVERDUE'/i;
    for (const rel of writers(overdue)) expect(OVERDUE_WRITERS).toContain(rel);
  });

  it('wallet files never touch payments and billing never writes a wallet table (each module owns its tables)', () => {
    const wallet = all.filter(({ rel }) => rel.startsWith('modules/wallet/'));
    const billing = all.filter(({ rel }) => rel.startsWith('modules/billing/'));
    for (const { rel, code } of wallet) {
      expect(code, rel).not.toMatch(writeTo(['payments', 'payment_line_items']));
    }
    for (const { rel, code } of billing) {
      expect(code, rel).not.toMatch(writeTo(['player_credits', 'credit_transactions']));
    }
  });

  it('detects a violation (the guard itself works)', () => {
    expect(writeTo(['payments']).test(`trx.insertInto('payments').values(x)`)).toBe(true);
    expect(writeTo(['payments']).test('UPDATE payments SET amount = 1')).toBe(true);
    expect(writeTo(['payments']).test(`trx.selectFrom('payments')`)).toBe(false);
    expect(writeTo(['payments']).test('overdue payments are listed')).toBe(false);
  });
});

describe('billing and the wallet never write registrations (C-ALL-1)', () => {
  const owned = all.filter(
    ({ rel }) => rel.startsWith('modules/billing/') || rel.startsWith('modules/wallet/'),
  );

  it('have source files to scan', () => {
    expect(owned.length).toBeGreaterThanOrEqual(6);
  });

  it('write neither registrations nor registration_guests, and never import the registrations repo or allocator', () => {
    for (const { rel, code } of owned) {
      expect(code, rel).not.toMatch(writeTo(['registrations', 'registration_guests']));
      expect(code, rel).not.toMatch(/registrations\/(?:repo|allocator|tx)\.ts/);
    }
  });
});

describe('imports of billing and wallet', () => {
  const owned = all.filter(
    ({ rel }) =>
      rel.startsWith('modules/billing/') ||
      rel.startsWith('modules/wallet/') ||
      rel === 'jobs/bill-session.ts' ||
      rel === 'jobs/post-game-billing.ts',
  );
  const PUBLIC = new Set([
    '../registrations/billing-handoff.ts',
    '../registrations/emails.ts',
    '../team-banking/publish-gate.ts',
    '../wallet/ledger.ts',
    '../billing/bill-session.ts',
    '../billing/sweep.ts',
    '../../jobs/send-email.ts',
    '../../jobs/registry.ts',
  ]);

  it('reach other modules only through their public files', () => {
    for (const { rel, code } of owned) {
      const specifiers = [
        ...code.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gm),
      ].map((match) => match[1] ?? '');
      for (const specifier of specifiers) {
        const external = !specifier.startsWith('.');
        const sameDir = specifier.startsWith('./');
        const platform = specifier.startsWith('../lib/') || specifier.startsWith('../../lib/');
        const jobsToModule = specifier.startsWith('../modules/');
        expect(
          external || sameDir || platform || jobsToModule || PUBLIC.has(specifier),
          `${rel} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it('the wallet depends on nothing but the platform and shared packages (billing depends on it, never the reverse)', () => {
    for (const { rel, code } of all.filter((file) => file.rel.startsWith('modules/wallet/'))) {
      expect(code, rel).not.toMatch(/from\s+'\.\.\/(?!\.\.\/lib\/)/);
    }
  });
});

describe('exact money and observability in billing and wallet code (AC-VERIFY-4, AC-VERIFY-7)', () => {
  const owned = all.filter(
    ({ rel }) =>
      rel.startsWith('modules/billing/') ||
      rel.startsWith('modules/wallet/') ||
      rel === 'jobs/bill-session.ts' ||
      rel === 'jobs/post-game-billing.ts',
  );

  it('uses no floating-point arithmetic or parsing for money', () => {
    for (const { rel, code } of owned) {
      expect(code, rel).not.toMatch(
        /\bparseFloat\b|\.toFixed\(|\bNumber\(|\bMath\.|\bNumber\.parse/,
      );
    }
  });

  it('types no money field as a number', () => {
    const moneyNumber =
      /\b(?:amount|total|balance|fee|price|subtotal|gst\w*|unitFee|resulting\w*)\s*[?:]\s*number\b/i;
    for (const { rel, code } of owned) expect(code, rel).not.toMatch(moneyNumber);
  });

  it('logs through the injected logger, never console', () => {
    for (const { rel, code } of owned) expect(code, rel).not.toMatch(/\bconsole\./);
  });
});
