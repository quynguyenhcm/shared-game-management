/**
 * NUMERIC(10,2) money columns round-trip exactly through the driver as strings (AC-VERIFY-14, DB side).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertSession, insertTeam } from '../helpers/factories.ts';
import { createTestDatabase, expectPgError, type TestDatabase } from '../helpers/test-db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

describe('money round trip', () => {
  it('stores 99999999.99 exactly, returns strings, and rejects 100000000.00 with 22003', async () => {
    const teamId = await insertTeam(db.pool);
    const sessionId = await insertSession(db.pool, teamId);
    await db.pool.query(
      `UPDATE game_sessions SET total_court_cost = '99999999.99', extra_expenses = '0.00',
                                custom_player_rate = '0.01' WHERE id = $1`,
      [sessionId],
    );
    const { rows } = await db.pool.query(
      'SELECT total_court_cost, extra_expenses, custom_player_rate FROM game_sessions WHERE id = $1',
      [sessionId],
    );
    expect(rows[0]).toEqual({
      total_court_cost: '99999999.99',
      extra_expenses: '0.00',
      custom_player_rate: '0.01',
    });
    await expectPgError(
      db.pool.query(`UPDATE game_sessions SET total_court_cost = '100000000.00' WHERE id = $1`, [
        sessionId,
      ]),
      '22003',
    );
  });
});
