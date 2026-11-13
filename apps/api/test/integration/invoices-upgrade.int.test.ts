/**
 * tax-invoices-and-exports, Phase 1: the staged upgrade of a PRE-FEATURE database (creative amendment CR-1, ledger D-102).
 * The old `assign_invoice_number` numbered any payment, so a database can hold numbered PENDING, $0.00 and PAID rows,
 * interleaved across teams and GST statuses. The migration must CONVERT every numbered PAID payment above $0.00 (its number,
 * kind and issue time kept, its counter kept) and ABORT, naming the ids, if any numbered row cannot become a document.
 * It never clears a number and never rewinds a counter.
 */
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findMigrationsDir, migrateToLatest } from '../../src/lib/db/migrate.ts';
import {
  insertBilledRegistration,
  insertSession,
  insertTeam,
  issueDocument,
  type BilledRegistrationOptions,
} from '../helpers/factories.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

const LAST_PRE_FEATURE = '20261102000100000';

let preFeatureDir: string;
beforeAll(() => {
  const source = findMigrationsDir();
  preFeatureDir = mkdtempSync(join(tmpdir(), 'sgm-pre-invoices-migrations-'));
  for (const file of readdirSync(source).filter((name) => name.endsWith('.sql'))) {
    if (file.slice(0, LAST_PRE_FEATURE.length) <= LAST_PRE_FEATURE) {
      copyFileSync(join(source, file), join(preFeatureDir, file));
    }
  }
});
afterAll(() => {
  rmSync(preFeatureDir, { recursive: true, force: true });
});

/** Numbers a payment with the PRE-feature function (which never checked the payment's state). */
async function legacyNumber(pool: pg.Pool, paymentId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('SELECT assign_invoice_number($1) AS n', [
    paymentId,
  ]);
  return rows[0]?.n ?? Number.NaN;
}

async function paymentOf(
  pool: pg.Pool,
  teamId: string,
  sessionId: string,
  options: BilledRegistrationOptions,
): Promise<string> {
  return (await insertBilledRegistration(pool, teamId, sessionId, options)).paymentId;
}

describe('upgrading a database that already holds numbered payments (CR-1)', () => {
  let db: TestDatabase;
  let teamOne: string;
  let teamTwo: string;
  const ids: Record<string, string> = {};
  let issuedAt: Record<string, Date> = {};

  beforeAll(async () => {
    db = await createTestDatabase({ empty: true });
    await migrateToLatest({ databaseUrl: db.url, migrationsDir: preFeatureDir });
    teamOne = await insertTeam(db.pool, { name: 'Hōkio Badminton Club' });
    teamTwo = await insertTeam(db.pool, { name: 'Whangārei Shuttlers' });
    const [sessionOne, sessionTwo] = [
      await insertSession(db.pool, teamOne, {}, { maxPlayers: 12 }),
      await insertSession(db.pool, teamTwo, {}, { maxPlayers: 12 }),
    ];
    // Interleaved numbering across teams and across GST status, in this order:
    // team one: a (registered) = 1, b (NOT registered) = 2, team two: d = 1, team one: c (registered) = 3.
    ids.a = await paymentOf(db.pool, teamOne, sessionOne, { status: 'PAID', amount: '23.00' });
    ids.b = await paymentOf(db.pool, teamOne, sessionOne, {
      status: 'PAID',
      amount: '12.50',
      gstRegistered: false,
    });
    ids.d = await paymentOf(db.pool, teamTwo, sessionTwo, { status: 'PAID', amount: '20.00' });
    ids.c = await paymentOf(db.pool, teamOne, sessionOne, { status: 'PAID', amount: '37.00' });
    for (const key of ['a', 'b', 'd', 'c']) await legacyNumber(db.pool, ids[key] ?? '');
    // Not numbered and left alone: a PAID payment and a PENDING one.
    ids.unnumberedPaid = await paymentOf(db.pool, teamOne, sessionOne, { status: 'PAID' });
    ids.pending = await paymentOf(db.pool, teamOne, sessionOne, { status: 'PENDING' });
    const { rows } = await db.pool.query<{ id: string; invoice_issued_at: Date }>(
      'SELECT id, invoice_issued_at FROM payments WHERE invoice_number IS NOT NULL',
    );
    issuedAt = Object.fromEntries(rows.map((row) => [row.id, row.invoice_issued_at]));
    await migrateToLatest({ databaseUrl: db.url });
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });

  it('converts each numbered PAID payment: its number, kind and issue time are kept, its facts snapshotted', async () => {
    const { rows } = await db.pool.query<{
      payment_id: string;
      document_kind: string;
      number_display: string;
      issued_at: Date;
      supplier_name: string;
      charge_reason: string;
    }>(
      `SELECT payment_id, document_kind, number_display, issued_at, supplier_name, charge_reason
         FROM payment_documents`,
    );
    const byPayment = Object.fromEntries(rows.map((row) => [row.payment_id, row]));
    expect(rows).toHaveLength(4);
    expect(byPayment[ids.a ?? '']).toMatchObject({
      document_kind: 'TAX_INVOICE',
      number_display: 'INV-000001',
      supplier_name: 'Hōkio Badminton Club',
      charge_reason: 'GAME_FEE',
    });
    // The unregistered payment keeps its number 2, now as a receipt in its own series.
    expect(byPayment[ids.b ?? '']).toMatchObject({
      document_kind: 'RECEIPT',
      number_display: 'RCT-000002',
    });
    expect(byPayment[ids.c ?? '']).toMatchObject({ number_display: 'INV-000003' });
    expect(byPayment[ids.d ?? '']).toMatchObject({
      number_display: 'INV-000001',
      supplier_name: 'Whangārei Shuttlers',
    });
    for (const key of ['a', 'b', 'c', 'd']) {
      expect(byPayment[ids[key] ?? '']?.issued_at.getTime(), key).toBe(
        issuedAt[ids[key] ?? '']?.getTime(),
      );
    }
    // The flag now means "a TAX invoice was issued": the receipt-kind payment is false although the old flag said true.
    const { rows: flags } = await db.pool.query<{ id: string; is_tax_invoice_issued: boolean }>(
      'SELECT id, is_tax_invoice_issued FROM payments WHERE id = ANY($1)',
      [[ids.a, ids.b, ids.c, ids.d, ids.unnumberedPaid, ids.pending]],
    );
    const flagById = Object.fromEntries(flags.map((row) => [row.id, row.is_tax_invoice_issued]));
    expect(flagById).toEqual({
      [ids.a ?? '']: true,
      [ids.b ?? '']: false,
      [ids.c ?? '']: true,
      [ids.d ?? '']: true,
      [ids.unnumberedPaid ?? '']: false,
      [ids.pending ?? '']: false,
    });
  });

  it('rebuilds the counters per series from the numbers issued, so the next number never collides, and leaves unnumbered payments alone', async () => {
    const { rows } = await db.pool.query<{
      team_id: string;
      document_kind: string;
      last_number: number;
    }>('SELECT team_id, document_kind, last_number FROM team_invoice_counters ORDER BY 1, 2');
    const counters = Object.fromEntries(
      rows.map((row) => [`${row.team_id}:${row.document_kind}`, row.last_number]),
    );
    expect(counters).toEqual({
      [`${teamOne}:TAX_INVOICE`]: 3,
      [`${teamOne}:RECEIPT`]: 2,
      [`${teamTwo}:TAX_INVOICE`]: 1,
    });
    expect((await issueDocument(db.pool, ids.unnumberedPaid ?? '')).numberDisplay).toBe(
      'INV-000004',
    );
    const { rows: pending } = await db.pool.query(
      'SELECT invoice_number FROM payments WHERE id = $1',
      [ids.pending],
    );
    expect(pending[0]).toEqual({ invoice_number: null });
  });
});

describe('a numbered payment that cannot become a document stops the deploy (CR-1)', () => {
  it('aborts naming a numbered PENDING and a numbered $0.00 payment, clears no number, rewinds no counter and leaves the old schema', async () => {
    const db = await createTestDatabase({ empty: true });
    try {
      await migrateToLatest({ databaseUrl: db.url, migrationsDir: preFeatureDir });
      const teamId = await insertTeam(db.pool);
      const sessionId = await insertSession(db.pool, teamId, {}, { maxPlayers: 6 });
      const good = await paymentOf(db.pool, teamId, sessionId, { status: 'PAID' });
      const pending = await paymentOf(db.pool, teamId, sessionId, { status: 'PENDING' });
      const zero = await paymentOf(db.pool, teamId, sessionId, { status: 'PAID', amount: '0.00' });
      for (const id of [good, pending, zero]) await legacyNumber(db.pool, id);

      const failure = await migrateToLatest({ databaseUrl: db.url }).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(failure).toMatch(/not PAID above 0\.00/);
      expect(failure).toContain(pending);
      expect(failure).toContain(zero);
      expect(failure).not.toContain(good);

      // Nothing was changed: the migration ran in one transaction that rolled back.
      const { rows } = await db.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM payments WHERE invoice_number IS NOT NULL',
      );
      expect(rows[0]?.n).toBe(3);
      const { rows: counter } = await db.pool.query(
        'SELECT last_number FROM team_invoice_counters WHERE team_id = $1',
        [teamId],
      );
      expect(counter[0]).toEqual({ last_number: 3 });
      const { rows: shape } = await db.pool.query(
        `SELECT to_regclass('payment_documents') AS t,
                (SELECT attgenerated FROM pg_attribute
                  WHERE attrelid = 'payments'::regclass AND attname = 'is_tax_invoice_issued') AS g`,
      );
      expect(shape[0]).toEqual({ t: null, g: '' });
    } finally {
      await db.close();
    }
  }, 120_000);
});
