/**
 * Per-team gapless document numbers (AC-VERIFY-9 of platform-foundation; tax-invoices-and-exports AC-HAPPY-4, AC-ASYNC-2).
 * Numbers are now allocated only through `issue_payment_document` (which calls the series-aware `assign_invoice_number`
 * and writes the immutable snapshot in the same transaction), in one gapless series per team and document kind.
 * Uses its own cloned database and a pool of 25 so 20 allocations truly run on 20 connections.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  insertBilledRegistration,
  insertSession,
  insertTeam,
  issueDocument,
  type BilledRegistration,
} from '../helpers/factories.ts';
import { waitForLockWaiters } from '../helpers/lock-waiters.ts';
import { createTestDatabase, expectPgError, type TestDatabase } from '../helpers/test-db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ poolMax: 25 });
});
afterAll(async () => {
  await db.close();
});

/** A team with `count` PAID payments (registered for GST unless `gstRegistered` says otherwise). */
async function paidTeam(
  count: number,
  gstRegistered = true,
): Promise<{ teamId: string; billed: BilledRegistration[] }> {
  const teamId = await insertTeam(db.pool);
  // Public capacity must hold every billed player (the capacity backstop, D-65).
  const sessionId = await insertSession(db.pool, teamId, {}, { maxPlayers: Math.max(count, 1) });
  const billed: BilledRegistration[] = [];
  for (let i = 0; i < count; i += 1) {
    billed.push(
      await insertBilledRegistration(db.pool, teamId, sessionId, { status: 'PAID', gstRegistered }),
    );
  }
  return { teamId, billed };
}

/** BEGIN; issue; brief hold; COMMIT on one dedicated connection. */
async function issueAndCommit(paymentId: string, holdSeconds = 0.01): Promise<string> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ n: string }>(
      'SELECT number_display AS n FROM issue_payment_document($1)',
      [paymentId],
    );
    await client.query('SELECT pg_sleep($1)', [holdSeconds]);
    await client.query('COMMIT');
    return rows[0]?.n ?? '';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function counter(teamId: string, kind = 'TAX_INVOICE'): Promise<number | undefined> {
  const { rows } = await db.pool.query<{ last_number: number }>(
    'SELECT last_number FROM team_invoice_counters WHERE team_id = $1 AND document_kind = $2',
    [teamId, kind],
  );
  return rows[0]?.last_number;
}

describe('issue_payment_document numbering (AC-HAPPY-4, AC-ASYNC-2)', () => {
  it('gives 20 concurrent team-A payments exactly INV-1..20 and team B INV-1..3, all stamped together', async () => {
    const [teamA, teamB] = [await paidTeam(20), await paidTeam(3)];
    const [numbersA, numbersB] = await Promise.all([
      Promise.all(teamA.billed.map((b) => issueAndCommit(b.paymentId))),
      Promise.all(teamB.billed.map((b) => issueAndCommit(b.paymentId))),
    ]);
    expect([...numbersA].sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => `INV-${String(i + 1).padStart(6, '0')}`).sort(),
    );
    expect([...numbersB].sort()).toEqual(['INV-000001', 'INV-000002', 'INV-000003']);
    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS n, count(DISTINCT invoice_number)::int AS distinct_n,
              bool_and(is_tax_invoice_issued AND invoice_issued_at IS NOT NULL) AS issued,
              (SELECT count(*)::int FROM payment_documents d JOIN payments x ON x.id = d.payment_id
                WHERE x.team_id = $1) AS documents
         FROM payments WHERE team_id = $1`,
      [teamA.teamId],
    );
    expect(rows[0]).toEqual({ n: 20, distinct_n: 20, issued: true, documents: 20 });
  });

  it('keeps tax invoices and receipts in separate gapless series for one team', async () => {
    const teamId = await insertTeam(db.pool);
    const sessionId = await insertSession(db.pool, teamId, {}, { maxPlayers: 6 });
    const registered = [
      await insertBilledRegistration(db.pool, teamId, sessionId, { status: 'PAID' }),
      await insertBilledRegistration(db.pool, teamId, sessionId, { status: 'PAID' }),
    ];
    const unregistered = [
      await insertBilledRegistration(db.pool, teamId, sessionId, {
        status: 'PAID',
        gstRegistered: false,
      }),
    ];
    expect((await issueDocument(db.pool, registered[0]?.paymentId ?? '')).numberDisplay).toBe(
      'INV-000001',
    );
    expect((await issueDocument(db.pool, unregistered[0]?.paymentId ?? '')).numberDisplay).toBe(
      'RCT-000001',
    );
    expect((await issueDocument(db.pool, registered[1]?.paymentId ?? '')).numberDisplay).toBe(
      'INV-000002',
    );
    expect([await counter(teamId), await counter(teamId, 'RECEIPT')]).toEqual([2, 1]);
    // The flag keeps its meaning: only a GST-registered (tax invoice) payment sets it, a receipt does not.
    const { rows } = await db.pool.query<{ id: string; is_tax_invoice_issued: boolean }>(
      'SELECT id, is_tax_invoice_issued FROM payments WHERE id = $1',
      [unregistered[0]?.paymentId],
    );
    expect(rows[0]?.is_tax_invoice_issued).toBe(false);
  });

  it('is gapless across rollbacks and unique per series (23505), while another team may reuse a number', async () => {
    const [teamA, teamB] = [await paidTeam(2), await paidTeam(1)];
    const [first, second] = teamA.billed;
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ n: string }>(
        'SELECT number_display AS n FROM issue_payment_document($1)',
        [first?.paymentId],
      );
      expect(rows[0]?.n).toBe('INV-000001');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await counter(teamA.teamId)).toBeUndefined();
    expect(await issueAndCommit(second?.paymentId ?? '')).toBe('INV-000001');
    expect(await issueAndCommit(first?.paymentId ?? '')).toBe('INV-000002');

    // UNIQUE(team_id, gst_registered, invoice_number): simulate a buggy writer bypassing the function.
    const { rows: constraint } = await db.pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'uq_payments_team_series_number'`,
    );
    expect(constraint[0]).toEqual({ def: 'UNIQUE (team_id, gst_registered, invoice_number)' });
    const other = await insertBilledRegistration(
      db.pool,
      teamA.teamId,
      await insertSession(db.pool, teamA.teamId),
      { status: 'PAID' },
    );
    await expectPgError(
      db.pool.query(
        `UPDATE payments SET invoice_number = 1, invoice_issued_at = now() WHERE id = $1`,
        [other.paymentId],
      ),
      '23505',
      'uq_payments_team_series_number',
    );
    expect(await issueAndCommit(teamB.billed[0]?.paymentId ?? '')).toBe('INV-000001');
  });

  it("lets two concurrent issuers of one payment end with one number: the loser gets the winner's document back and no number leaks", async () => {
    const { teamId, billed } = await paidTeam(2);
    const [target, next] = billed;
    const winner = await db.pool.connect();
    const loser = await db.pool.connect();
    try {
      await winner.query('BEGIN');
      const { rows } = await winner.query<{ n: string }>(
        'SELECT number_display AS n FROM issue_payment_document($1)',
        [target?.paymentId],
      );
      await loser.query('BEGIN');
      const racing = loser.query<{ n: string; issued: boolean }>(
        'SELECT number_display AS n, issued FROM issue_payment_document($1)',
        [target?.paymentId],
      );
      await waitForLockWaiters(db.pool, 1, 'issuers blocked on the payment row');
      await winner.query('COMMIT');
      const raced = await racing;
      await loser.query('COMMIT');
      expect(rows[0]?.n).toBe('INV-000001');
      expect(raced.rows[0]).toEqual({ n: 'INV-000001', issued: false });
    } finally {
      winner.release();
      loser.release();
    }
    expect(await counter(teamId)).toBe(1);
    expect(await issueAndCommit(next?.paymentId ?? '')).toBe('INV-000002');
  });

  it('refuses a direct re-assignment of an issued payment (23000), never lets an issued number change, and answers P0002 for an unknown payment', async () => {
    const { teamId, billed } = await paidTeam(1);
    const paymentId = billed[0]?.paymentId ?? '';
    expect(await issueAndCommit(paymentId)).toBe('INV-000001');
    await expectPgError(
      db.pool.query('SELECT assign_invoice_number($1)', [paymentId]),
      '23000',
      'payments_invoice_number_set_once',
    );
    expect(await counter(teamId)).toBe(1);
    await expectPgError(
      db.pool.query('UPDATE payments SET invoice_number = 7 WHERE id = $1', [paymentId]),
      '23000',
    );
    await expectPgError(
      db.pool.query(`SELECT issue_payment_document('00000000-0000-0000-0000-000000000000')`),
      'P0002',
    );
  });
});
