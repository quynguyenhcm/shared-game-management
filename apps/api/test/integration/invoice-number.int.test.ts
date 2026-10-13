/**
 * Per-team gapless invoice numbers via assign_invoice_number(payment_id) (AC-VERIFY-9).
 * Uses its own cloned database and a pool of 25 so 20 allocations truly run on 20 connections.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  insertBilledRegistration,
  insertSession,
  insertTeam,
  type BilledRegistration,
} from '../helpers/factories.ts';
import { createTestDatabase, expectPgError, type TestDatabase } from '../helpers/test-db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ poolMax: 25 });
});
afterAll(async () => {
  await db.close();
});

async function billedTeam(
  count: number,
): Promise<{ teamId: string; billed: BilledRegistration[] }> {
  const teamId = await insertTeam(db.pool);
  const sessionId = await insertSession(db.pool, teamId);
  const billed: BilledRegistration[] = [];
  for (let i = 0; i < count; i += 1)
    billed.push(await insertBilledRegistration(db.pool, teamId, sessionId));
  return { teamId, billed };
}

/** BEGIN; assign; brief hold; COMMIT on one dedicated connection. */
async function assignAndCommit(paymentId: string, holdSeconds = 0.01): Promise<number> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ n: number }>('SELECT assign_invoice_number($1) AS n', [
      paymentId,
    ]);
    await client.query('SELECT pg_sleep($1)', [holdSeconds]);
    await client.query('COMMIT');
    return rows[0]?.n ?? Number.NaN;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function counter(teamId: string): Promise<number | undefined> {
  const { rows } = await db.pool.query<{ last_number: number }>(
    'SELECT last_number FROM team_invoice_counters WHERE team_id = $1',
    [teamId],
  );
  return rows[0]?.last_number;
}

describe('assign_invoice_number (AC-VERIFY-9)', () => {
  it('gives 20 concurrent team-A payments exactly {1..20} and team B {1,2,3}', async () => {
    const [teamA, teamB] = [await billedTeam(20), await billedTeam(3)];
    const startedAt = Date.now();
    const [numbersA, numbersB] = await Promise.all([
      Promise.all(teamA.billed.map((b) => assignAndCommit(b.paymentId))),
      Promise.all(teamB.billed.map((b) => assignAndCommit(b.paymentId))),
    ]);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect([...numbersA].sort((x, y) => x - y)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect([...numbersB].sort((x, y) => x - y)).toEqual([1, 2, 3]);
    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS n, count(DISTINCT invoice_number)::int AS distinct_n,
              bool_and(is_tax_invoice_issued AND invoice_issued_at IS NOT NULL) AS issued
         FROM payments WHERE team_id = $1`,
      [teamA.teamId],
    );
    expect(rows[0]).toEqual({ n: 20, distinct_n: 20, issued: true });
  });

  it('is gapless across rollbacks and unique per team (23505), while another team may reuse a number', async () => {
    const [teamA, teamB] = [await billedTeam(2), await billedTeam(1)];
    const [first, second] = teamA.billed;
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ n: number }>('SELECT assign_invoice_number($1) AS n', [
        first?.paymentId,
      ]);
      expect(rows[0]?.n).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await counter(teamA.teamId)).toBeUndefined();
    expect(await assignAndCommit(second?.paymentId ?? '')).toBe(1);
    expect(await assignAndCommit(first?.paymentId ?? '')).toBe(2);

    // UNIQUE(team_id, invoice_number): simulate a buggy writer bypassing the function.
    const { rows: constraint } = await db.pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'uq_payments_team_invoice_number'`,
    );
    expect(constraint[0]).toEqual({ def: 'UNIQUE (team_id, invoice_number)' });
    const other = await insertBilledRegistration(
      db.pool,
      teamA.teamId,
      await insertSession(db.pool, teamA.teamId),
    );
    await expectPgError(
      db.pool.query(
        `UPDATE payments SET invoice_number = 1, invoice_issued_at = now(), is_tax_invoice_issued = true
          WHERE id = $1`,
        [other.paymentId],
      ),
      '23505',
      'uq_payments_team_invoice_number',
    );
    const teamBPayment = teamB.billed[0]?.paymentId ?? '';
    await db.pool.query(
      `UPDATE payments SET invoice_number = 1, invoice_issued_at = now(), is_tax_invoice_issued = true
        WHERE id = $1`,
      [teamBPayment],
    );
  });

  it('lets only one of two concurrent issuers of the same payment win; the other gets 23000 and no number leaks', async () => {
    const { teamId, billed } = await billedTeam(2);
    const [target, next] = billed;
    const winner = await db.pool.connect();
    const loser = await db.pool.connect();
    try {
      await winner.query('BEGIN');
      const { rows } = await winner.query<{ n: number }>('SELECT assign_invoice_number($1) AS n', [
        target?.paymentId,
      ]);
      await loser.query('BEGIN');
      const racing = loser.query('SELECT assign_invoice_number($1) AS n', [target?.paymentId]);
      racing.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await winner.query('COMMIT');
      const info = await expectPgError(racing, '23000', 'payments_invoice_number_set_once');
      expect(info.message).toMatch(/already has invoice number/);
      await loser.query('ROLLBACK');
      expect(rows[0]?.n).toBe(1);
    } finally {
      winner.release();
      loser.release();
    }
    expect(await counter(teamId)).toBe(1);
    expect(await assignAndCommit(next?.paymentId ?? '')).toBe(2);
  });

  it('refuses an already-invoiced payment (23000) and never lets an issued number change', async () => {
    const { teamId, billed } = await billedTeam(1);
    const paymentId = billed[0]?.paymentId ?? '';
    expect(await assignAndCommit(paymentId)).toBe(1);
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
      db.pool.query(`SELECT assign_invoice_number('00000000-0000-0000-0000-000000000000')`),
      'P0002',
    );
  });
});
