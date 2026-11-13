/**
 * The shared TypeScript `gstOfInclusive` equals the database's generated `payments.gst_amount` (AC-HAPPY-10, AC-VERIFY-1).
 * The matrices evaluate the column's OWN expression text (read from `pg_get_expr`), so they cannot drift from it:
 * every cent from $0.00 to $100.00 at 15%, a seeded random sample up to the field maximum and the edges around 23-cent
 * multiples, the rates where exact half-cent ties exist (2000 and 10000 bps), a sweep of every basis-point rate and
 * negative totals. Real inserted rows then confirm the eight AC vectors through the table itself.
 */
import { GST_RATE_BPS, gstOfInclusive, parseMoney, toMoneyString } from '@sgm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBilledRegistration, insertSession, insertTeam } from '../helpers/factories.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

const dollars = (cents: bigint): string => {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
};

async function generatedExpression(): Promise<string> {
  const { rows } = await db.pool.query<{ expr: string }>(
    `SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
       FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE d.adrelid = 'payments'::regclass AND a.attname = 'gst_amount'`,
  );
  const expr = rows[0]?.expr;
  if (expr === undefined) throw new Error('payments.gst_amount has no generation expression');
  return expr;
}

/** Evaluates the column expression for each (amount, rate) pair, and returns every pair where TypeScript disagrees. */
async function mismatches(pairs: readonly (readonly [bigint, number])[]): Promise<string[]> {
  const expr = await generatedExpression();
  const bad: string[] = [];
  const CHUNK = 20_000;
  for (let start = 0; start < pairs.length; start += CHUNK) {
    const chunk = pairs.slice(start, start + CHUNK);
    const { rows } = await db.pool.query<{ amount: string; bps: number; gst: string }>(
      `SELECT v.amount::text AS amount, v.gst_rate_bps AS bps, (${expr})::text AS gst
         FROM unnest($1::numeric(10,2)[], $2::smallint[]) AS v(amount, gst_rate_bps)`,
      [chunk.map(([cents]) => dollars(cents)), chunk.map(([, bps]) => bps)],
    );
    for (const row of rows) {
      const ts = toMoneyString(gstOfInclusive(parseMoney(row.amount), row.bps));
      if (ts !== row.gst) bad.push(`${row.amount} @ ${row.bps}: db ${row.gst}, ts ${ts}`);
    }
  }
  return bad;
}

/** A small seeded generator (mulberry32), so the "random" sample is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('gstOfInclusive equals payments.gst_amount (AC-HAPPY-10, AC-VERIFY-1)', () => {
  it('agrees at 15% for every cent up to $100.00, a seeded sample up to the field maximum and the edges around the 23-cent multiples', async () => {
    const pairs: (readonly [bigint, number])[] = [];
    for (let cents = 0n; cents <= 10_000n; cents += 1n) pairs.push([cents, GST_RATE_BPS]);
    const next = seeded(20_261_110);
    for (let i = 0; i < 1_000; i += 1) {
      pairs.push([BigInt(Math.floor(next() * 10_000_000_000)), GST_RATE_BPS]);
    }
    for (const edge of [2299n, 2300n, 2301n, 4599n, 4600n, 4601n, 9_999_999_999n]) {
      pairs.push([edge, GST_RATE_BPS]);
    }
    expect(await mismatches(pairs)).toEqual([]);
  }, 60_000);

  it('agrees where exact half-cent ties exist (2000 and 10000 bps), on a sweep of every rate, and on negative totals', async () => {
    const pairs: (readonly [bigint, number])[] = [];
    for (let cents = 3n; cents <= 1_000n; cents += 6n) pairs.push([cents, 2000]);
    for (let cents = 1n; cents <= 1_001n; cents += 2n) pairs.push([cents, 10_000]);
    const amounts = [1n, 3n, 7n, 23n, 46n, 1150n, 2300n, 9_999_999_999n];
    for (let bps = 0; bps <= 10_000; bps += 1)
      for (const cents of amounts) pairs.push([cents, bps]);
    for (const bps of [1500, 2000, 10_000]) {
      for (let cents = -200n; cents <= -1n; cents += 1n) pairs.push([cents, bps]);
    }
    expect(await mismatches(pairs)).toEqual([]);
  }, 120_000);

  it('matches the stored gst_amount and subtotal_amount of real inserted payments for the eight AC vectors, and 0.00 for a non-registered team', async () => {
    const teamId = await insertTeam(db.pool);
    const sessionId = await insertSession(db.pool, teamId, {}, { maxPlayers: 12 });
    const vectors: readonly [string, string][] = [
      ['0.01', '0.00'],
      ['0.50', '0.07'],
      ['1.00', '0.13'],
      ['5.00', '0.65'],
      ['10.00', '1.30'],
      ['12.00', '1.57'],
      ['23.00', '3.00'],
      ['37.00', '4.83'],
    ];
    for (const [amount, gst] of vectors) {
      const { paymentId } = await insertBilledRegistration(db.pool, teamId, sessionId, { amount });
      const { rows } = await db.pool.query<{ gst_amount: string; subtotal_amount: string }>(
        'SELECT gst_amount, subtotal_amount FROM payments WHERE id = $1',
        [paymentId],
      );
      const total = parseMoney(amount);
      expect(rows[0]?.gst_amount, amount).toBe(gst);
      expect(toMoneyString(gstOfInclusive(total, GST_RATE_BPS)), amount).toBe(gst);
      expect(parseMoney(rows[0]?.subtotal_amount) + parseMoney(rows[0]?.gst_amount)).toBe(total);
    }
    const { paymentId } = await insertBilledRegistration(db.pool, teamId, sessionId, {
      amount: '37.00',
      gstRegistered: false,
    });
    const { rows } = await db.pool.query(
      'SELECT gst_amount, subtotal_amount FROM payments WHERE id = $1',
      [paymentId],
    );
    expect(rows[0]).toEqual({ gst_amount: '0.00', subtotal_amount: '37.00' });
  }, 60_000);
});
