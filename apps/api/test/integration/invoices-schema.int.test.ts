/**
 * tax-invoices-and-exports, Phase 1: the document snapshot schema (ADR 0021; ledger D-99..D-105).
 * AC-VERIFY-4 (issued documents are immutable and snapshotted), AC-ERROR-1 / AC-ERROR-5 at the database level (no number
 * for an unpaid or $0.00 payment), CR-2 (forward-only once a document exists) and the migrate / rollback / migrate round trip.
 */
import { formatDocumentNumber } from '@sgm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateToLatest, rollbackMigrations } from '../../src/lib/db/migrate.ts';
import {
  insertBilledRegistration,
  insertSession,
  insertTeam,
  issueDocument,
} from '../helpers/factories.ts';
import { catalogSnapshot } from '../helpers/schema-dump.ts';
import {
  createTestDatabase,
  expectPgError,
  inRollback,
  trySql,
  type TestDatabase,
} from '../helpers/test-db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

interface Scene {
  teamId: string;
  sessionId: string;
  userId: string;
  paymentId: string;
}

async function scene(
  options: Parameters<typeof insertBilledRegistration>[3] = { status: 'PAID' },
): Promise<Scene> {
  const teamId = await insertTeam(db.pool, { name: 'Hōkio Badminton Club' });
  const sessionId = await insertSession(db.pool, teamId);
  const billed = await insertBilledRegistration(db.pool, teamId, sessionId, options);
  return { teamId, sessionId, userId: billed.userId, paymentId: billed.paymentId };
}

describe('issue_payment_document and the immutable snapshot (AC-VERIFY-4)', () => {
  it('stores the issue-time facts once, returns the same document on a repeat call, and never follows later renames', async () => {
    const s = await scene();
    await db.pool.query(`UPDATE users SET full_name = 'Aroha Ngata' WHERE id = $1`, [s.userId]);
    const first = await issueDocument(db.pool, s.paymentId);
    expect(first).toEqual({ numberDisplay: 'INV-000001', issued: true });
    expect(await issueDocument(db.pool, s.paymentId)).toEqual({
      numberDisplay: 'INV-000001',
      issued: false,
    });

    const read = (): Promise<Record<string, unknown>> =>
      db.pool
        .query<Record<string, unknown>>(
          `SELECT d.document_kind, d.number_display, d.supplier_name, d.buyer_name, d.session_location,
                  d.charge_reason, d.layout_version, d.issued_at = p.invoice_issued_at AS issued_at_matches,
                  d.session_starts_at = g.starts_at AS starts_match, p.invoice_number
             FROM payment_documents d
             JOIN payments p ON p.id = d.payment_id
             JOIN registrations r ON r.id = p.registration_id
             JOIN game_sessions g ON g.id = r.session_id
            WHERE d.payment_id = $1`,
          [s.paymentId],
        )
        .then((result) => result.rows[0] ?? {});
    const expected = {
      document_kind: 'TAX_INVOICE',
      number_display: 'INV-000001',
      supplier_name: 'Hōkio Badminton Club',
      buyer_name: 'Aroha Ngata',
      session_location: 'Test Hall',
      charge_reason: 'GAME_FEE',
      layout_version: 1,
      issued_at_matches: true,
      starts_match: true,
      invoice_number: 1,
    };
    expect(await read()).toEqual(expected);

    // A rename of the team or the payer afterwards leaves the issued document exactly as issued.
    await db.pool.query(`UPDATE teams SET name = 'Renamed Club' WHERE id = $1`, [s.teamId]);
    await db.pool.query(`UPDATE users SET full_name = 'Someone Else' WHERE id = $1`, [s.userId]);
    expect(await read()).toEqual(expected);
  });

  it('issues nothing for an unpaid or $0.00 payment: 23514 payments_invoice_requires_paid, and no counter row appears', async () => {
    const unpaid = [
      await scene({ status: 'PENDING' }),
      await scene({ status: 'OVERDUE' }),
      await scene({ status: 'PAID', amount: '0.00' }),
    ];
    for (const s of unpaid) {
      await expectPgError(
        db.pool.query('SELECT * FROM issue_payment_document($1)', [s.paymentId]),
        '23514',
        'payments_invoice_requires_paid',
      );
      await expectPgError(
        db.pool.query('SELECT assign_invoice_number($1)', [s.paymentId]),
        '23514',
        'payments_invoice_requires_paid',
      );
      // The CHECK is the same rule: a raw number on such a payment is refused too.
      await expectPgError(
        db.pool.query(
          'UPDATE payments SET invoice_number = 1, invoice_issued_at = now() WHERE id = $1',
          [s.paymentId],
        ),
        '23514',
        'payments_invoice_requires_paid',
      );
    }
    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS n FROM team_invoice_counters WHERE team_id = ANY($1)`,
      [unpaid.map((s) => s.teamId)],
    );
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('rejects any UPDATE or DELETE of a document (23000), a snapshot that disagrees with its payment, a numbered payment without a document, and a moved paid_at', async () => {
    const s = await scene();
    await issueDocument(db.pool, s.paymentId);
    await expectPgError(
      db.pool.query(`UPDATE payment_documents SET supplier_name = 'x' WHERE payment_id = $1`, [
        s.paymentId,
      ]),
      '23000',
    );
    await expectPgError(
      db.pool.query('DELETE FROM payment_documents WHERE payment_id = $1', [s.paymentId]),
      '23000',
    );
    await expectPgError(
      db.pool.query('DELETE FROM payments WHERE id = $1', [s.paymentId]),
      '23503',
    );
    // paid_at is frozen once set (D-104): the printed "Paid on" and the export period filter depend on it.
    await expectPgError(
      db.pool.query(`UPDATE payments SET paid_at = paid_at + interval '1 day' WHERE id = $1`, [
        s.paymentId,
      ]),
      '23000',
    );

    const other = await scene();
    await inRollback(db.pool, async (client) => {
      await client.query('SELECT assign_invoice_number($1)', [other.paymentId]);
      const wrongKind = await trySql(
        client,
        `INSERT INTO payment_documents (payment_id, document_kind, number_display, issued_at, supplier_name,
                                        buyer_name, session_location, session_starts_at, charge_reason)
         SELECT p.id, 'RECEIPT', 'RCT-000001', p.invoice_issued_at, 'T', 'B', 'L', now(), 'GAME_FEE'
           FROM payments p WHERE p.id = $1`,
        [other.paymentId],
      );
      expect(wrongKind).toMatchObject({
        code: '23514',
        constraint: 'payment_documents_matches_payment',
      });
      const wrongNumber = await trySql(
        client,
        `INSERT INTO payment_documents (payment_id, document_kind, number_display, issued_at, supplier_name,
                                        buyer_name, session_location, session_starts_at, charge_reason)
         SELECT p.id, 'TAX_INVOICE', 'INV-000099', p.invoice_issued_at, 'T', 'B', 'L', now(), 'GAME_FEE'
           FROM payments p WHERE p.id = $1`,
        [other.paymentId],
      );
      expect(wrongNumber).toMatchObject({
        code: '23514',
        constraint: 'payment_documents_matches_payment',
      });
    });

    // Allocating without issuing cannot commit: the deferred trigger refuses at COMMIT.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT assign_invoice_number($1)', [other.paymentId]);
      await expectPgError(client.query('COMMIT'), '23514', 'payment_documents_required');
    } finally {
      client.release();
    }
    const { rows } = await db.pool.query('SELECT invoice_number FROM payments WHERE id = $1', [
      other.paymentId,
    ]);
    expect(rows[0]).toEqual({ invoice_number: null });
  });

  it('has the shape the design records: kind enum, generated flag, series counter key, SQL number format twin and the unissued index', async () => {
    const { rows: enumRows } = await db.pool.query<{ label: string }>(
      `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'payment_document_kind' ORDER BY e.enumsortorder`,
    );
    expect(enumRows.map((r) => r.label)).toEqual(['TAX_INVOICE', 'RECEIPT']);

    const { rows: flag } = await db.pool.query<{ attgenerated: string }>(
      `SELECT attgenerated FROM pg_attribute
        WHERE attrelid = 'payments'::regclass AND attname = 'is_tax_invoice_issued' AND NOT attisdropped`,
    );
    expect(flag[0]).toEqual({ attgenerated: 's' });

    const { rows: key } = await db.pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'team_invoice_counters'::regclass AND contype = 'p'`,
    );
    expect(key[0]?.def).toBe('PRIMARY KEY (team_id, document_kind)');

    const { rows: index } = await db.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_payments_unissued'`,
    );
    expect(index[0]?.indexdef).toMatch(/\(team_id, paid_at, id\)/);
    expect(index[0]?.indexdef).toMatch(/status = 'PAID'/);
    expect(index[0]?.indexdef).toMatch(/invoice_number IS NULL/);

    // SQL twin of the shared formatter, including a number wider than six digits (never truncated).
    for (const kind of ['TAX_INVOICE', 'RECEIPT'] as const) {
      for (const n of [1, 42, 999_999, 1_234_567]) {
        const { rows: printed } = await db.pool.query<{ s: string }>(
          'SELECT format_document_number($1::payment_document_kind, $2) AS s',
          [kind, n],
        );
        expect(printed[0]?.s, `${kind} ${n}`).toBe(formatDocumentNumber(kind, n));
      }
    }
  });
});

describe('forward-only schema and the round trip (CR-2)', () => {
  it('migrates, rolls the document migration back and migrates again to an identical schema; refuses to roll back once a document exists', async () => {
    const empty = await createTestDatabase({ empty: true });
    try {
      await migrateToLatest({ databaseUrl: empty.url });
      const before = await catalogSnapshot(empty.pool);

      // Nothing issued yet: the rollback restores the D-22 shape ...
      await rollbackMigrations({ databaseUrl: empty.url, count: 1 });
      const { rows: restored } = await empty.pool.query<{ attgenerated: string }>(
        `SELECT attgenerated FROM pg_attribute
          WHERE attrelid = 'payments'::regclass AND attname = 'is_tax_invoice_issued' AND NOT attisdropped`,
      );
      expect(restored[0]).toEqual({ attgenerated: '' });
      const { rows: gone } = await empty.pool.query(
        `SELECT to_regclass('payment_documents') AS t, to_regproc('issue_payment_document') AS f`,
      );
      expect(gone[0]).toEqual({ t: null, f: null });

      // ... and migrating forward again reproduces the original schema exactly.
      await migrateToLatest({ databaseUrl: empty.url });
      expect(await catalogSnapshot(empty.pool)).toEqual(before);

      // Once a document exists the rollback refuses and changes nothing (7-year tax records are not dropped).
      const teamId = await insertTeam(empty.pool);
      const sessionId = await insertSession(empty.pool, teamId);
      const billed = await insertBilledRegistration(empty.pool, teamId, sessionId, {
        status: 'PAID',
      });
      await issueDocument(empty.pool, billed.paymentId);
      await expect(rollbackMigrations({ databaseUrl: empty.url, count: 1 })).rejects.toThrow(
        /forward-only/,
      );
      const { rows: kept } = await empty.pool.query(
        'SELECT number_display FROM payment_documents WHERE payment_id = $1',
        [billed.paymentId],
      );
      expect(kept).toEqual([{ number_display: 'INV-000001' }]);
      expect(await catalogSnapshot(empty.pool)).toEqual(before);
    } finally {
      await empty.close();
    }
  }, 180_000);
});
