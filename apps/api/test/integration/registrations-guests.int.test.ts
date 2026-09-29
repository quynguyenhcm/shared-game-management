/**
 * Registrations, guests and the waitlist (AC-VERIFY-7, AC-VERIFY-19, ownership chain of AC-VERIFY-8).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  insertGuest,
  insertRegistration,
  insertSession,
  insertTeam,
  insertUser,
} from '../helpers/factories.ts';
import {
  createTestDatabase,
  expectPgError,
  inRollback,
  inTransaction,
  pgError,
  trySql,
  type TestDatabase,
} from '../helpers/test-db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ poolMax: 6 });
});
afterAll(async () => {
  await db.close();
});

async function sessionFixture(): Promise<{ teamId: string; sessionId: string }> {
  const teamId = await insertTeam(db.pool);
  const sessionId = await insertSession(db.pool, teamId);
  return { teamId, sessionId };
}

describe('registrations (AC-VERIFY-7)', () => {
  it('rejects a second registration for the same (session_id, user_id) with 23505', async () => {
    const { teamId, sessionId } = await sessionFixture();
    const userId = await insertUser(db.pool);
    await insertRegistration(db.pool, { sessionId, teamId, userId });
    await expectPgError(
      insertRegistration(db.pool, { sessionId, teamId, userId, status: 'WITHDRAWN' }),
      '23505',
      'uq_registrations_session_user',
    );
  });

  it('rejects guest_count -1 with 23514', async () => {
    const { teamId, sessionId } = await sessionFixture();
    const userId = await insertUser(db.pool);
    await expectPgError(
      insertRegistration(db.pool, { sessionId, teamId, userId, guestCount: -1 }),
      '23514',
      'registrations_guest_count_range',
    );
  });

  it('rejects guest_count 3 with 23514', async () => {
    const { teamId, sessionId } = await sessionFixture();
    const userId = await insertUser(db.pool);
    await expectPgError(
      insertRegistration(db.pool, { sessionId, teamId, userId, guestCount: 3 }),
      '23514',
      'registrations_guest_count_range',
    );
  });

  it('stores each guest with NOT NULL sex and skill at positions 1..2, kept in step with guest_count', async () => {
    const { teamId, sessionId } = await sessionFixture();
    const userId = await insertUser(db.pool);
    const registrationId = await inTransaction(db.pool, async (client) => {
      const id = await insertRegistration(client, { sessionId, teamId, userId, guestCount: 2 });
      await insertGuest(client, id, 1, 'OTHER', 'ADVANCED');
      await insertGuest(client, id, 2, 'MALE', 'BEGINNER');
      return id;
    });
    const { rows } = await db.pool.query(
      `SELECT position, sex, skill_level FROM registration_guests WHERE registration_id = $1 ORDER BY position`,
      [registrationId],
    );
    expect(rows).toEqual([
      { position: 1, sex: 'OTHER', skill_level: 'ADVANCED' },
      { position: 2, sex: 'MALE', skill_level: 'BEGINNER' },
    ]);

    await inRollback(db.pool, async (client) => {
      await client.query(
        'SET CONSTRAINTS registration_guest_count_matches_r, registration_guest_count_matches_g IMMEDIATE',
      );
      const insert = `INSERT INTO registration_guests (registration_id, position, sex, skill_level)
                      VALUES ($1, $2, $3, $4)`;
      expect(await trySql(client, insert, [registrationId, 3, 'MALE', 'BEGINNER'])).toMatchObject({
        code: '23514',
      });
      expect(await trySql(client, insert, [registrationId, 2, 'MALE', 'BEGINNER'])).toMatchObject({
        code: '23505',
      });
      expect(await trySql(client, insert, [registrationId, 1, null, 'BEGINNER'])).toMatchObject({
        code: '23502',
      });
      expect(await trySql(client, insert, [registrationId, 1, 'MALE', null])).toMatchObject({
        code: '23502',
      });
    });

    // guest_count 2 with only one guest row fails at COMMIT.
    const other = await insertUser(db.pool);
    const info = await pgError(
      inTransaction(db.pool, async (client) => {
        const id = await insertRegistration(client, {
          sessionId,
          teamId,
          userId: other,
          guestCount: 2,
        });
        await insertGuest(client, id, 1);
      }),
    );
    expect(info).toMatchObject({ code: '23514', constraint: 'registration_guest_count_matches' });
  });

  it('rejects guest_count 1 with only a position-2 guest (23514)', async () => {
    const { teamId, sessionId } = await sessionFixture();
    const userId = await insertUser(db.pool);
    const info = await pgError(
      inTransaction(db.pool, async (client) => {
        const id = await insertRegistration(client, { sessionId, teamId, userId, guestCount: 1 });
        await insertGuest(client, id, 2);
      }),
    );
    expect(info).toMatchObject({ code: '23514', constraint: 'registration_guest_count_matches' });
  });

  it('rejects a registration whose team_id differs from its session team (23503, ownership chain)', async () => {
    const { sessionId } = await sessionFixture();
    const otherTeam = await insertTeam(db.pool);
    const userId = await insertUser(db.pool);
    await expectPgError(
      insertRegistration(db.pool, { sessionId, teamId: otherTeam, userId }),
      '23503',
      'fk_registrations_session_team',
    );
  });
});

describe('waitlist positions (AC-VERIFY-19)', () => {
  it('rejects a duplicate WAITLISTED position (23505) but does not constrain other statuses', async () => {
    const { teamId, sessionId } = await sessionFixture();
    const [a, b, c, d] = [
      await insertUser(db.pool),
      await insertUser(db.pool),
      await insertUser(db.pool),
      await insertUser(db.pool),
    ];
    await insertRegistration(db.pool, {
      sessionId,
      teamId,
      userId: a,
      status: 'WAITLISTED',
      queuePosition: 1,
    });
    await expectPgError(
      insertRegistration(db.pool, {
        sessionId,
        teamId,
        userId: b,
        status: 'WAITLISTED',
        queuePosition: 1,
      }),
      '23505',
      'uq_registrations_waitlist_position',
    );
    await insertRegistration(db.pool, {
      sessionId,
      teamId,
      userId: b,
      status: 'WAITLISTED',
      queuePosition: 2,
    });
    // A promoted (CONFIRMED) row drops its position; the freed number can be reused by the queue.
    await insertRegistration(db.pool, { sessionId, teamId, userId: c, status: 'CONFIRMED' });
    await db.pool.query(
      `UPDATE registrations SET status = 'CONFIRMED', queue_position = NULL WHERE session_id = $1 AND user_id = $2`,
      [sessionId, a],
    );
    await insertRegistration(db.pool, {
      sessionId,
      teamId,
      userId: d,
      status: 'WAITLISTED',
      queuePosition: 1,
    });
    const { rows } = await db.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_registrations_waitlist_position'`,
    );
    expect(rows[0]?.indexdef).toMatch(
      /UNIQUE INDEX .*\(session_id, queue_position\) WHERE \(status = 'WAITLISTED'/,
    );
  });

  it('requires queue_position if and only if the row is WAITLISTED (23514)', async () => {
    const { teamId, sessionId } = await sessionFixture();
    const userId = await insertUser(db.pool);
    await expectPgError(
      insertRegistration(db.pool, {
        sessionId,
        teamId,
        userId,
        status: 'WAITLISTED',
        queuePosition: null,
      }),
      '23514',
      'registrations_queue_position_iff_waitlisted',
    );
    await expectPgError(
      insertRegistration(db.pool, {
        sessionId,
        teamId,
        userId,
        status: 'CONFIRMED',
        queuePosition: 4,
      }),
      '23514',
      'registrations_queue_position_iff_waitlisted',
    );
  });

  it('lets exactly one of two concurrent enqueues at the same position commit; the other gets 23505', async () => {
    const { teamId, sessionId } = await sessionFixture();
    const users = [await insertUser(db.pool), await insertUser(db.pool)];
    const enqueue = async (userId: string): Promise<void> => {
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        await insertRegistration(client, {
          sessionId,
          teamId,
          userId,
          status: 'WAITLISTED',
          queuePosition: 1,
        });
        await client.query('SELECT pg_sleep(0.2)');
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
    const results = await Promise.allSettled(users.map((userId) => enqueue(userId)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      code: '23505',
      constraint: 'uq_registrations_waitlist_position',
    });
    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS n FROM registrations WHERE session_id = $1 AND status = 'WAITLISTED'`,
      [sessionId],
    );
    expect(rows[0]).toEqual({ n: 1 });
  });
});
