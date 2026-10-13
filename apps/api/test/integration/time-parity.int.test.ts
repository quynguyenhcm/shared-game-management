/**
 * TS `localToInstant` and SQL `nz_local_to_utc` implement one DST policy (algorithm doc §Q7):
 * they must agree on every vector row, every policy and every quarter-hour of both transition days,
 * and the trigger-maintained session instants must equal the TS result.
 * (Vector-by-vector SQL behaviour and court-edit recomputation live in session-instants.int.test.ts.)
 */
import { DST_VECTORS } from '@sgm/shared/time/dst-vectors';
import {
  AmbiguousLocalTimeError,
  NonexistentLocalTimeError,
  localToInstant,
  parseLocalDate,
  parseLocalTime,
  type Disambiguation,
} from '@sgm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertSession, insertTeam } from '../helpers/factories.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

type Outcome = { at: string } | { error: 'nonexistent' | 'ambiguous' };

function tsOutcome(date: string, time: string, policy: Disambiguation): Outcome {
  try {
    return { at: localToInstant(parseLocalDate(date), parseLocalTime(time), policy).toISOString() };
  } catch (error) {
    if (error instanceof NonexistentLocalTimeError) return { error: 'nonexistent' };
    if (error instanceof AmbiguousLocalTimeError) return { error: 'ambiguous' };
    throw error;
  }
}

async function sqlOutcome(date: string, time: string, policy: Disambiguation): Promise<Outcome> {
  try {
    const { rows } = await db.pool.query<{ at: Date }>(
      'SELECT nz_local_to_utc($1::date, $2::time, $3) AS at',
      [date, time, policy],
    );
    return { at: rows[0]?.at.toISOString() ?? '' };
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    expect(code, `${date} ${time} ${policy}`).toBe('22007');
    return { error: message.includes('nonexistent') ? 'nonexistent' : 'ambiguous' };
  }
}

describe('TS and SQL agree on the DST policy', () => {
  it('matches on every vector row for compatible, earlier, later and reject', async () => {
    for (const v of DST_VECTORS) {
      for (const policy of ['compatible', 'earlier', 'later', 'reject'] as const) {
        expect(await sqlOutcome(v.date, v.time, policy), `${v.date} ${v.time} ${policy}`).toEqual(
          tsOutcome(v.date, v.time, policy),
        );
      }
    }
  });

  it('matches on all 96 quarter-hour slots of 2026-09-27 (gap) and 2027-04-04 (overlap)', async () => {
    let compared = 0;
    let nonexistent = 0;
    let ambiguous = 0;
    for (const date of ['2026-09-27', '2027-04-04']) {
      for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
        const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
        for (const policy of ['compatible', 'reject'] as const) {
          const ts = tsOutcome(date, time, policy);
          expect(await sqlOutcome(date, time, policy), `${date} ${time} ${policy}`).toEqual(ts);
          compared++;
          if ('error' in ts) {
            if (ts.error === 'nonexistent') nonexistent++;
            else ambiguous++;
          }
        }
      }
    }
    expect({ compared, nonexistent, ambiguous }).toEqual({
      compared: 2 * 96 * 2,
      nonexistent: 4,
      ambiguous: 4,
    });
  });

  it('documents that plain AT TIME ZONE disagrees with the compatible policy on the overlap', async () => {
    const { rows } = await db.pool.query<{ at: Date }>(
      `SELECT (DATE '2027-04-04' + TIME '02:30') AT TIME ZONE 'Pacific/Auckland' AS at`,
    );
    expect(rows[0]?.at.toISOString()).toBe('2027-04-03T14:30:00.000Z'); // PG picks the later instant
    expect(tsOutcome('2027-04-04', '02:30', 'compatible')).toEqual({
      at: '2027-04-03T13:30:00.000Z',
    });
  });

  it('trigger-maintained session instants equal the TS compatible result on DST days', async () => {
    const teamId = await insertTeam(db.pool);
    for (const [date, start, end] of [
      ['2026-09-27', '02:30', '04:00'],
      ['2027-04-04', '02:30', '03:30'],
      ['2026-07-01', '19:00', '24:00'],
    ] as const) {
      const sessionId = await insertSession(db.pool, teamId, {}, { date, withCourt: false });
      await db.pool.query(
        `UPDATE game_sessions SET cancellation_deadline = '2026-01-01T00:00:00Z' WHERE id = $1`,
        [sessionId],
      );
      await db.pool.query(
        `INSERT INTO session_courts (session_id, court_identifier, start_time, end_time)
         VALUES ($1, 'Court 1', $2, $3)`,
        [sessionId, start, end],
      );
      const { rows } = await db.pool.query<{ starts_at: Date; ends_at: Date }>(
        'SELECT starts_at, ends_at FROM game_sessions WHERE id = $1',
        [sessionId],
      );
      expect(rows[0]?.starts_at.toISOString(), `${date} start`).toBe(
        (tsOutcome(date, start, 'compatible') as { at: string }).at,
      );
      expect(rows[0]?.ends_at.toISOString(), `${date} end`).toBe(
        (tsOutcome(date, end, 'compatible') as { at: string }).at,
      );
    }
  });
});
