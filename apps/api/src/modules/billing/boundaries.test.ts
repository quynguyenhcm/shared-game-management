/**
 * Structural guards for money state (wallet-and-akahu-billing; ADR 0020; AC-VERIFY-11, AC-VERIFY-4; CR-5, CR-9, C-ALL-1). The
 * counterpart of `registrations/boundaries.test.ts` for the money tables:
 *
 * - `payment_line_items` and `billing_session_blocks` are written only from `modules/billing/engine-repo.ts`; `payments` only from
 *   there, from `modules/billing/overdue.ts` (the daily job's OVERDUE flip) and from the single Akahu apply funnel
 *   `modules/billing/apply-akahu-result.ts` (PAID and the CR-27 grace; CR-3: no second apply path), which is also the only file
 *   that moves a payment to PAID; `payment_reminders` only from `modules/billing/reminders.ts`.
 * - The intent tables `payment_attempts` and `wallet_top_ups` are written only from the funnel and the reconcile sweep
 *   `modules/billing/reconcile.ts` (stale CREATING); Phase 4a part 2 adds the start paths.
 * - `player_credits` and `credit_transactions` are written only from `modules/wallet/ledger.ts`.
 * - `game_sessions.status = 'COMPLETED'` is written only by the billing engine; `payments.status = 'OVERDUE'` only by
 *   `modules/billing/overdue.ts` (C-BIL-2: only billing's daily-overdue job writes OVERDUE; the job file is a thin handler).
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
/** A write that sets a payment to OVERDUE: a query-builder `.set({ status: 'OVERDUE' ...})` or a SQL `SET status = 'OVERDUE'`. */
const OVERDUE_WRITE = /\.set\(\s*\{\s*status:\s*'OVERDUE'|SET\s+status\s*=\s*'OVERDUE'/i;
const writers = (pattern: RegExp): string[] =>
  all.filter(({ code }) => pattern.test(code)).map(({ rel }) => rel);

const ENGINE = 'modules/billing/engine-repo.ts';
const LEDGER = 'modules/wallet/ledger.ts';
const OVERDUE = 'modules/billing/overdue.ts';
const REMINDERS = 'modules/billing/reminders.ts';
const APPLY = 'modules/billing/apply-akahu-result.ts';
const RECONCILE = 'modules/billing/reconcile.ts';
const ATTEMPTS_REPO = 'modules/billing/attempts-repo.ts';
const TOP_UP_REPO = 'modules/wallet/top-up-repo.ts';
const PAYOUT_BLOCK = 'modules/billing/payout-block.ts';
const HOLD_RESOLUTION = 'modules/billing/hold-resolution.ts';
const sorted = (files: readonly string[]): string[] => [...files].sort();

describe('single writers of money state', () => {
  it('has the writer files to guard', () => {
    const files = all.map(({ rel }) => rel);
    expect(files).toEqual(
      expect.arrayContaining([
        ENGINE,
        LEDGER,
        OVERDUE,
        REMINDERS,
        APPLY,
        RECONCILE,
        ATTEMPTS_REPO,
        TOP_UP_REPO,
        PAYOUT_BLOCK,
        HOLD_RESOLUTION,
      ]),
    );
  });

  it('payment_line_items and billing_session_blocks are written only from billing/engine-repo.ts', () => {
    expect(writers(writeTo(['payment_line_items', 'billing_session_blocks']))).toEqual([ENGINE]);
  });

  it('payments are written only from billing/engine-repo.ts (insert), billing/overdue.ts (OVERDUE flip) and the Akahu apply funnel', () => {
    expect(sorted(writers(writeTo(['payments'])))).toEqual(sorted([ENGINE, OVERDUE, APPLY]));
  });

  it('a payment is moved to PAID only by the Akahu apply funnel (CR-3: no second apply path)', () => {
    const paid = /\.set\(\s*\{\s*status:\s*'PAID'|SET\s+status\s*=\s*'PAID'/i;
    expect(paid.test(`trx.updateTable('payments').set({ status: 'PAID', paid_at: now })`)).toBe(
      true,
    );
    expect(writers(paid)).toEqual([APPLY]);
  });

  it('payment_attempts and wallet_top_ups are written only from the apply funnel, the reconcile sweep and one start-path repo each', () => {
    expect(sorted(writers(writeTo(['payment_attempts', 'wallet_top_ups'])))).toEqual(
      sorted([APPLY, RECONCILE, ATTEMPTS_REPO, TOP_UP_REPO]),
    );
    // Each start path writes only its own intent table.
    expect(writers(writeTo(['payment_attempts']))).not.toContain(TOP_UP_REPO);
    expect(writers(writeTo(['wallet_top_ups']))).not.toContain(ATTEMPTS_REPO);
  });

  it('a start path never moves an intent past OPEN: APPLIED, UNAPPLIED and HELD are written only by the apply funnel', () => {
    const settles =
      /status:\s*'(?:APPLIED|UNAPPLIED|HELD)'|SET\s+status\s*=\s*'(?:APPLIED|UNAPPLIED|HELD)'/;
    for (const rel of [ATTEMPTS_REPO, TOP_UP_REPO, RECONCILE]) {
      const file = all.find((entry) => entry.rel === rel);
      expect(file?.code, rel).not.toMatch(settles);
    }
  });

  it('the payments gateway is called (create, read, cancel) only from the shared start step, the apply funnel, the cancel job, daily-overdue (CR-27 re-read) and the hold resolution (CR-26 re-read)', () => {
    const calls = /\.(?:createPayment|getPayment|cancelPayment)\(/;
    expect(sorted(writers(calls))).toEqual(
      sorted(['lib/akahu/start.ts', APPLY, 'modules/billing/cancel.ts', OVERDUE, HOLD_RESOLUTION]),
    );
  });

  it('a hold is resolved only through the apply funnel: the hold-resolution file re-reads Akahu but writes nothing (CR-15)', () => {
    const file = all.find((entry) => entry.rel === HOLD_RESOLUTION);
    expect(file?.code).not.toMatch(
      writeTo(['payments', 'payment_attempts', 'wallet_top_ups', 'player_credits']),
    );
  });

  it('payout_block_events and a payout block (teams.payout_blocked_at set) are written only from billing/payout-block.ts (A3, CR-14)', () => {
    expect(writers(writeTo(['payout_block_events']))).toEqual([PAYOUT_BLOCK]);
    // Setting the block (anything but null) outside team-banking, whose banking save clears it (R3).
    const sets = /payout_blocked_at:(?!\s*null\b)|SET\s+payout_blocked_at\s*=(?!\s*NULL\b)/i;
    expect(sets.test(`.set({ payout_blocked_at: now })`)).toBe(true);
    expect(sets.test(`.set({ payout_blocked_at: null })`)).toBe(false);
    expect(writers(sets).filter((rel) => !rel.startsWith('modules/team-banking/'))).toEqual([
      PAYOUT_BLOCK,
    ]);
    // Billing writes the teams row only to set the block, and never a banking column.
    const billing = all.filter(({ rel }) => rel.startsWith('modules/billing/'));
    expect(
      billing.filter(({ code }) => writeTo(['teams']).test(code)).map(({ rel }) => rel),
    ).toEqual([PAYOUT_BLOCK]);
    const block = all.find((entry) => entry.rel === PAYOUT_BLOCK);
    expect(block?.code).not.toMatch(/bank_account_\w+\s*:/);
  });

  it('payment_reminders is written only from billing/reminders.ts', () => {
    expect(writers(writeTo(['payment_reminders']))).toEqual([REMINDERS]);
  });

  it('player_credits and credit_transactions are written only from wallet/ledger.ts', () => {
    expect(writers(writeTo(['player_credits', 'credit_transactions']))).toEqual([LEDGER]);
  });

  it('game_sessions becomes COMPLETED only in billing/engine-repo.ts (AC-VERIFY-11)', () => {
    const completes =
      /\.set\(\s*\{\s*status:\s*'COMPLETED'|SET\s+status\s*=\s*'COMPLETED'|status\s*=\s*'COMPLETED'\s*(?:::\w+)?\s*(?:,|WHERE)/i;
    expect(writers(completes)).toEqual([ENGINE]);
  });

  it('payments become OVERDUE only in billing/overdue.ts (the daily-overdue job body; C-BIL-2, AC-HAPPY-8)', () => {
    const writes = writers(OVERDUE_WRITE);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes).toEqual([OVERDUE]);
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

  it('detects an OVERDUE write in each shape the code could take (the OVERDUE rule cannot go vacuous)', () => {
    expect(OVERDUE_WRITE.test(`trx.updateTable('payments').set({ status: 'OVERDUE' })`)).toBe(true);
    expect(OVERDUE_WRITE.test(`.set({\n status: 'OVERDUE',\n })`)).toBe(true);
    expect(OVERDUE_WRITE.test(`UPDATE payments SET status = 'OVERDUE'::payment_status`)).toBe(true);
    expect(OVERDUE_WRITE.test(`.where('status', '=', 'OVERDUE')`)).toBe(false);
    expect(OVERDUE_WRITE.test(`status: 'OVERDUE' as const`)).toBe(false);
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
      rel === 'jobs/post-game-billing.ts' ||
      rel === 'jobs/daily-overdue.ts' ||
      rel === 'jobs/akahu-jobs.ts',
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
      rel === 'jobs/post-game-billing.ts' ||
      rel === 'jobs/daily-overdue.ts' ||
      rel === 'jobs/akahu-jobs.ts',
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
