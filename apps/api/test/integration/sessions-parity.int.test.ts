/**
 * TS/SQL parity of the D-85 predicate (Phase 2 carry-forward): `countActiveRegistrations`
 * (`apps/api/src/modules/sessions/repo.ts`, behind "N players are registered" and the 409 `session_fee_locked`) and the
 * SQL function `game_session_has_active_registrations` (behind the raw-SQL trigger `game_sessions_fee_raise_locked`) must
 * agree for every registration status. They agree today on CONFIRMED and WAITLISTED. Registration-and-waitlist widens BOTH
 * in its build (WITHDRAWN with `withdrawal_fee_due`, ALG R-a, T-17); this test fails loudly if only one side moves, or if a
 * new `registration_status` value appears that nobody has classified.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKysely, type Database } from '../../src/lib/db/kysely.ts';
import { countActiveRegistrations } from '../../src/modules/sessions/repo.ts';
import {
  insertRegistration,
  insertSession,
  insertTeam,
  insertTeamMember,
  insertUser,
} from '../helpers/factories.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

type Status = 'CONFIRMED' | 'WAITLISTED' | 'WITHDRAWN';

/** The definition both sides hold today: written out by hand, so a change on one side is a failing test. */
const ACTIVE_TODAY: Readonly<Record<Status, boolean>> = {
  CONFIRMED: true,
  WAITLISTED: true,
  WITHDRAWN: false,
};

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

async function register(sessionId: string, status: Status): Promise<void> {
  const userId = await insertUser(database.pool, 'FEMALE');
  await insertTeamMember(database.pool, { teamId, userId });
  const queued = await database.pool.query<{ next: number }>(
    `SELECT coalesce(max(queue_position), 0) + 1 AS next FROM registrations
      WHERE session_id = $1 AND status = 'WAITLISTED'`,
    [sessionId],
  );
  await insertRegistration(database.pool, {
    sessionId,
    teamId,
    userId,
    status,
    queuePosition: status === 'WAITLISTED' ? (queued.rows[0]?.next ?? 1) : null,
  });
}

describe('countActiveRegistrations and game_session_has_active_registrations agree (D-85)', () => {
  it('classifies every registration_status the database knows, so a new status cannot slip past both sides', async () => {
    const { rows } = await database.pool.query<{ label: string }>(
      `SELECT enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'registration_status' ORDER BY e.enumsortorder`,
    );
    expect(rows.map((row) => row.label).sort()).toEqual(Object.keys(ACTIVE_TODAY).sort());
  });

  it.each(Object.entries(ACTIVE_TODAY) as [Status, boolean][])(
    'a session whose only registration is %s: TS count and SQL predicate both say active = %s',
    async (status, active) => {
      const sessionId = await insertSession(database.pool, teamId);
      await register(sessionId, status);
      expect(await sqlPredicate(sessionId)).toBe(active);
      expect(await tsCount(sessionId)).toBe(active ? 1 : 0);
    },
  );

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

    await register(mixed, 'CONFIRMED');
    await register(mixed, 'WAITLISTED');
    await register(mixed, 'WAITLISTED');
    expect(await sqlPredicate(mixed)).toBe(true);
    expect(await tsCount(mixed)).toBe(3);

    // One call over several sessions keeps each session's own count.
    const counts = await countActiveRegistrations(db, [empty, mixed, other]);
    expect([...counts.entries()]).toEqual([
      [empty, 0],
      [mixed, 3],
      [other, 1],
    ]);
  });
});
