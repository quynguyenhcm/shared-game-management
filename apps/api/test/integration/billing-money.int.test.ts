/**
 * AC-VERIFY-4 (wallet-and-akahu-billing Phase 2): the database's generated GST columns are the shared HALF_UP rule. `fast-check` is
 * not a dependency, so the property is checked exhaustively: EVERY cent amount from 0.00 to 300.00 (30,001 payments inserted in one
 * statement) plus large amounts up to the column ceiling, for the GST-registered rate (3/23) and for a non-registered team
 * (0 bps), compared with `packages/shared` money arithmetic (bigint cents, no floating point).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GST_RATE_BPS,
  moneyFromCents,
  multiplyByRatio,
  subtract,
  toMoneyString,
} from '@sgm/shared';
import { insertTeam, insertUser } from '../helpers/factories.ts';
import { createTestDatabase, inRollback, type TestDatabase } from '../helpers/test-db.ts';

let database: TestDatabase;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database.close();
});

const MAX_CENTS = 30_000;
/** Large amounts up to the numeric(10,2) ceiling, beyond the exhaustive range. */
const EXTRA_CENTS = [99_999_999n, 12_345_678n, 1_000_000n, 99_999n, 100_001n];

describe('generated gst_amount and subtotal_amount equal the shared HALF_UP 3/23 rule', () => {
  it.each([
    ['GST registered (1500 bps)', true, 1500],
    ['not GST registered (0 bps)', false, 0],
  ] as const)(
    '%s: every amount from 0.00 to 300.00 and the extremes',
    async (_name, registered, bps) => {
      expect(GST_RATE_BPS).toBe(1500);
      const teamId = await insertTeam(database.pool, {
        payoutConfigured: true,
        gstRegistered: registered,
        ...(registered ? { gstNumber: '123456789' } : {}),
      });
      const userId = await insertUser(database.pool);
      const cents = [...Array.from({ length: MAX_CENTS + 1 }, (_, i) => BigInt(i)), ...EXTRA_CENTS];
      const amounts = cents.map((c) => toMoneyString(moneyFromCents(c)));

      const rows = await inRollback(database.pool, async (client) => {
        // One statement: header rows from the amounts, then one matching line each (the deferred line-sum check).
        await client.query(
          `INSERT INTO payments (user_id, team_id, registration_id, pricing_structure, gst_registered, gst_rate_bps, gst_number,
                               amount, payment_reference, due_date)
         SELECT $1, $2, NULL, 'FLAT', $3, $4, $5, a::numeric(10,2), 'SGM' || lpad(n::text, 8, '0'), '2026-10-10T00:00:00Z'
           FROM unnest($6::text[]) WITH ORDINALITY AS t(a, n)`,
          [userId, teamId, registered, bps, registered ? '123456789' : null, amounts],
        );
        await client.query(
          `INSERT INTO payment_line_items (payment_id, party_position, registration_guest_id, pricing_structure, applied_basis,
                                         party_sex, party_skill_level, unit_fee)
         SELECT id, 0, NULL, 'FLAT', 'FLAT', 'MALE', 'BEGINNER', amount FROM payments WHERE team_id = $1`,
          [teamId],
        );
        const { rows: read } = await client.query<{
          amount: string;
          gst_amount: string;
          subtotal_amount: string;
        }>(`SELECT amount, gst_amount, subtotal_amount FROM payments WHERE team_id = $1`, [teamId]);
        return read;
      });

      expect(rows).toHaveLength(cents.length);
      const mismatches: string[] = [];
      for (const row of rows) {
        const total = moneyFromCents(BigInt(row.amount.replace('.', '')));
        const gst =
          bps === 0
            ? moneyFromCents(0n)
            : multiplyByRatio(total, BigInt(bps), 10_000n + BigInt(bps), 'HALF_UP');
        if (
          row.gst_amount !== toMoneyString(gst) ||
          row.subtotal_amount !== toMoneyString(subtract(total, gst))
        ) {
          mismatches.push(
            `${row.amount}: db ${row.gst_amount}/${row.subtotal_amount}, shared ${toMoneyString(gst)}`,
          );
        }
      }
      expect(mismatches.slice(0, 5)).toEqual([]);
    },
  );
});
