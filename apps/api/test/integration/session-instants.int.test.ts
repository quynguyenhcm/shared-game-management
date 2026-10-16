/**
 * DB-maintained session instants and the SQL `nz_local_to_utc` port of the DST policy
 * (algorithm doc §Q7, S3). The TS↔SQL parity test arrives with the TS time module in Phase 4.
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

async function instants(
  sessionId: string,
): Promise<{ starts_at: string | null; ends_at: string | null }> {
  const { rows } = await db.pool.query<{ starts_at: Date | null; ends_at: Date | null }>(
    'SELECT starts_at, ends_at FROM game_sessions WHERE id = $1',
    [sessionId],
  );
  const row = rows[0];
  return {
    starts_at: row?.starts_at?.toISOString() ?? null,
    ends_at: row?.ends_at?.toISOString() ?? null,
  };
}

describe('game_sessions.starts_at / ends_at', () => {
  it('derives the instants from date and courts and recomputes them on every court or date edit', async () => {
    const teamId = await insertTeam(db.pool);
    const sessionId = await insertSession(db.pool, teamId, {}, { date: '2026-10-07' }); // court 19:00–21:00
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO session_courts (session_id, court_identifier, start_time, end_time)
       VALUES ($1, 'Court 2', '20:00', '22:00') RETURNING id`,
      [sessionId],
    );
    const court2 = rows[0]?.id;
    // NZDT (+13): 19:00 → 06:00Z, 22:00 → 09:00Z.
    expect(await instants(sessionId)).toEqual({
      starts_at: '2026-10-07T06:00:00.000Z',
      ends_at: '2026-10-07T09:00:00.000Z',
    });
    await db.pool.query(`UPDATE session_courts SET end_time = '22:30' WHERE id = $1`, [court2]);
    expect((await instants(sessionId)).ends_at).toBe('2026-10-07T09:30:00.000Z');
    await db.pool.query('DELETE FROM session_courts WHERE id = $1', [court2]);
    expect((await instants(sessionId)).ends_at).toBe('2026-10-07T08:00:00.000Z');
    // Winter date (NZST, +12), and a direct write to the instants is overwritten.
    await db.pool.query(
      `UPDATE game_sessions SET date = '2026-07-01', cancellation_deadline = '2026-06-29T07:00:00Z',
                                ends_at = '2000-01-01T00:00:00Z' WHERE id = $1`,
      [sessionId],
    );
    expect(await instants(sessionId)).toEqual({
      starts_at: '2026-07-01T07:00:00.000Z',
      ends_at: '2026-07-01T09:00:00.000Z',
    });
  });

  it('keeps a session without courts DRAFT: publishing it fails with 23514', async () => {
    const teamId = await insertTeam(db.pool);
    // A free session: a paid one would be refused by the payout gate (game_sessions_paid_requires_payout) first.
    const sessionId = await insertSession(db.pool, teamId, { flat: '0.00' }, { withCourt: false });
    expect(await instants(sessionId)).toEqual({ starts_at: null, ends_at: null });
    await expectPgError(
      db.pool.query(`UPDATE game_sessions SET status = 'PUBLISHED' WHERE id = $1`, [sessionId]),
      '23514',
      'game_sessions_instants_when_live',
    );
  });
});

describe('nz_local_to_utc (SQL port of the DST policy)', () => {
  // Algorithm doc DST vector table rows 1–15 and 18–21: [date, time, compatible, reject].
  const VECTORS: readonly (readonly [string, string, string, string | null])[] = [
    ['2026-07-01', '19:00', '2026-07-01T07:00:00.000Z', '2026-07-01T07:00:00.000Z'],
    ['2026-10-07', '19:00', '2026-10-07T06:00:00.000Z', '2026-10-07T06:00:00.000Z'],
    ['2026-09-27', '01:59', '2026-09-26T13:59:00.000Z', '2026-09-26T13:59:00.000Z'],
    ['2026-09-27', '02:00', '2026-09-26T14:00:00.000Z', null],
    ['2026-09-27', '02:30', '2026-09-26T14:30:00.000Z', null],
    ['2026-09-27', '02:59', '2026-09-26T14:59:00.000Z', null],
    ['2026-09-27', '03:00', '2026-09-26T14:00:00.000Z', '2026-09-26T14:00:00.000Z'],
    ['2026-09-27', '04:00', '2026-09-26T15:00:00.000Z', '2026-09-26T15:00:00.000Z'],
    ['2027-04-04', '01:59', '2027-04-03T12:59:00.000Z', '2027-04-03T12:59:00.000Z'],
    ['2027-04-04', '02:00', '2027-04-03T13:00:00.000Z', null],
    ['2027-04-04', '02:30', '2027-04-03T13:30:00.000Z', null],
    ['2027-04-04', '02:59', '2027-04-03T13:59:00.000Z', null],
    ['2027-04-04', '03:00', '2027-04-03T15:00:00.000Z', '2027-04-03T15:00:00.000Z'],
    ['2027-04-04', '04:00', '2027-04-03T16:00:00.000Z', '2027-04-03T16:00:00.000Z'],
    ['2027-04-05', '19:00', '2027-04-05T07:00:00.000Z', '2027-04-05T07:00:00.000Z'],
    ['2027-09-26', '02:30', '2027-09-25T14:30:00.000Z', null],
    ['2028-04-02', '02:30', '2028-04-01T13:30:00.000Z', null],
    ['2026-12-31', '23:30', '2026-12-31T10:30:00.000Z', '2026-12-31T10:30:00.000Z'],
    ['2027-01-01', '00:00', '2026-12-31T11:00:00.000Z', '2026-12-31T11:00:00.000Z'],
    ['2026-07-01', '24:00', '2026-07-01T12:00:00.000Z', '2026-07-01T12:00:00.000Z'],
  ];

  it('matches the vector table for compatible and reject, overriding PG-native overlap resolution', async () => {
    const convert = async (date: string, time: string, policy: string): Promise<string> => {
      const { rows } = await db.pool.query<{ at: Date }>(
        'SELECT nz_local_to_utc($1::date, $2::time, $3) AS at',
        [date, time, policy],
      );
      return rows[0]?.at.toISOString() ?? '';
    };
    for (const [date, time, compatible, reject] of VECTORS) {
      expect(await convert(date, time, 'compatible'), `${date} ${time} compatible`).toBe(
        compatible,
      );
      if (reject === null) {
        await expectPgError(convert(date, time, 'reject'), '22007');
      } else {
        expect(await convert(date, time, 'reject'), `${date} ${time} reject`).toBe(reject);
      }
    }
    expect(await convert('2027-04-04', '02:30', 'later')).toBe('2027-04-03T14:30:00.000Z');
    expect(await convert('2026-09-27', '02:30', 'earlier')).toBe('2026-09-26T13:30:00.000Z');
    // Contrast: plain AT TIME ZONE picks the LATER instant for the ambiguous 02:30.
    const { rows } = await db.pool.query<{ at: Date }>(
      `SELECT (DATE '2027-04-04' + TIME '02:30') AT TIME ZONE 'Pacific/Auckland' AS at`,
    );
    expect(rows[0]?.at.toISOString()).toBe('2027-04-03T14:30:00.000Z');
    await expectPgError(convert('2026-07-01', '19:00', 'sideways'), '22023');
  });
});
