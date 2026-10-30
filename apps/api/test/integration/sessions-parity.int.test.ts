/**
 * TS/SQL parity of the D-85 predicate (AC-VERIFY-12): `countActiveRegistrations` (`apps/api/src/modules/sessions/repo.ts`,
 * the fee-lock count behind `feesLocked` and the 409 `session_fee_locked`) and the SQL function
 * `game_session_has_active_registrations` (behind the raw-SQL trigger `game_sessions_fee_raise_locked`) must agree for
 * every registration case. Registration-and-waitlist widened BOTH to a WITHDRAWN row whose late fee is still owed
 * (`withdrawal_fee_due`, ALG R-a, T-17, R20); this test fails loudly if only one side moves, or if a new
 * `registration_status` value appears that nobody has classified. `countRegisteredPlayers` (the display count behind
 * "N players are registered") has no SQL twin and counts only CONFIRMED and WAITLISTED rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKysely, type Database } from '../../src/lib/db/kysely.ts';
import {
  countActiveRegistrations,
  countRegisteredPlayers,
} from '../../src/modules/sessions/repo.ts';
import {
  insertRegistration,
  insertSession,
  insertTeam,
  insertTeamMember,
  insertUser,
} from '../helpers/factories.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

type Status = 'CONFIRMED' | 'WAITLISTED' | 'WITHDRAWN';

interface Case {
  readonly name: string;
  readonly status: Status;
  readonly feeDue: boolean;
  /** Fee-lock count and SQL predicate. */
  readonly feeLocked: boolean;
  /** Display count. */
  readonly registered: boolean;
}

/** The definition both fee-lock sides hold: written out by hand, so a change on one side is a failing test. */
const CASES: readonly Case[] = [
  { name: 'CONFIRMED', status: 'CONFIRMED', feeDue: false, feeLocked: true, registered: true },
  { name: 'WAITLISTED', status: 'WAITLISTED', feeDue: false, feeLocked: true, registered: true },
  { name: 'WITHDRAWN', status: 'WITHDRAWN', feeDue: false, feeLocked: false, registered: false },
  {
    name: 'WITHDRAWN with a fee still owed',
    status: 'WITHDRAWN',
    feeDue: true,
    feeLocked: true,
    registered: false,
  },
];

let database: TestDatabase;
let db: Database;
let teamId: string;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createKysely(database.pool);
  teamId = await insertTeam(database.pool, { name: 'Parity Club' });
});
afterAll(async () => {
  await database.close();
});

async function sqlPredicate(sessionId: string): Promise<boolean> {
  const { rows } = await database.pool.query<{ active: boolean }>(
    `SELECT game_session_has_active_registrations($1) AS active`,
    [sessionId],
  );
  return rows[0]?.active === true;
}

async function tsCount(sessionId: string): Promise<number> {
  return (await countActiveRegistrations(db, [sessionId])).get(sessionId) ?? 0;
}

async function registered(sessionId: string): Promise<number> {
  return (await countRegisteredPlayers(db, [sessionId])).get(sessionId) ?? 0;
}

async function register(sessionId: string, status: Status, feeDue = false): Promise<string> {
  const userId = await insertUser(database.pool, 'FEMALE');
  await insertTeamMember(database.pool, { teamId, userId });
  const queued = await database.pool.query<{ next: number }>(
    `SELECT coalesce(max(queue_position), 0) + 1 AS next FROM registrations
      WHERE session_id = $1 AND status = 'WAITLISTED'`,
    [sessionId],
  );
  return insertRegistration(database.pool, {
    sessionId,
    teamId,
    userId,
    status,
    queuePosition: status === 'WAITLISTED' ? (queued.rows[0]?.next ?? 1) : null,
    withdrawalFeeDue: feeDue,
  });
}

describe('countActiveRegistrations and game_session_has_active_registrations agree (D-85)', () => {
  it('classifies every registration_status the database knows, so a new status cannot slip past both sides', async () => {
    const { rows } = await database.pool.query<{ label: string }>(
      `SELECT enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'registration_status' ORDER BY e.enumsortorder`,
    );
    expect(rows.map((row) => row.label).sort()).toEqual(
      [...new Set(CASES.map((c) => c.status))].sort(),
    );
  });

  it.each(CASES)(
    'a session whose only registration is $name: fee-lock count and SQL predicate say $feeLocked, display count says $registered',
    async ({ status, feeDue, feeLocked, registered: shown }) => {
      const sessionId = await insertSession(database.pool, teamId);
      await register(sessionId, status, feeDue);
      expect(await sqlPredicate(sessionId)).toBe(feeLocked);
      expect(await tsCount(sessionId)).toBe(feeLocked ? 1 : 0);
      expect(await registered(sessionId)).toBe(shown ? 1 : 0);
    },
  );

  it('AC-VERIFY-12: a late withdrawer who still owes the fee is fee-locked (1, true) but not registered (0); releasing the fee zeroes all three', async () => {
    const sessionId = await insertSession(database.pool, teamId);
    const id = await register(sessionId, 'WITHDRAWN', true);
    expect(await tsCount(sessionId)).toBe(1);
    expect(await sqlPredicate(sessionId)).toBe(true);
    expect(await registered(sessionId)).toBe(0);

    await database.pool.query(`UPDATE registrations SET withdrawal_fee_due = false WHERE id = $1`, [
      id,
    ]);
    expect(await tsCount(sessionId)).toBe(0);
    expect(await sqlPredicate(sessionId)).toBe(false);
    expect(await registered(sessionId)).toBe(0);
  });

  it('agree on a mixed session and on none: each registration is one player, and other sessions never leak in', async () => {
    const empty = await insertSession(database.pool, teamId);
    expect(await sqlPredicate(empty)).toBe(false);
    expect(await tsCount(empty)).toBe(0);

    const mixed = await insertSession(database.pool, teamId);
    const other = await insertSession(database.pool, teamId);
    await register(other, 'CONFIRMED');
    await register(mixed, 'WITHDRAWN');
    expect(await sqlPredicate(mixed)).toBe(false);
    expect(await tsCount(mixed)).toBe(0);
    expect(await registered(mixed)).toBe(0);

    await register(mixed, 'CONFIRMED');
    await register(mixed, 'WAITLISTED');
    await register(mixed, 'WAITLISTED');
    await register(mixed, 'WITHDRAWN', true);
    expect(await sqlPredicate(mixed)).toBe(true);
    expect(await tsCount(mixed)).toBe(4); // three registered plus the owed late fee
    expect(await registered(mixed)).toBe(3);

    // One call over several sessions keeps each session's own count.
    const counts = await countActiveRegistrations(db, [empty, mixed, other]);
    expect([...counts.entries()]).toEqual([
      [empty, 0],
      [mixed, 4],
      [other, 1],
    ]);
    const shown = await countRegisteredPlayers(db, [empty, mixed, other]);
    expect([...shown.entries()]).toEqual([
      [empty, 0],
      [mixed, 3],
      [other, 1],
    ]);
  });
});
