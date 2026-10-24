/**
 * Registration lifecycle schema (AC-VERIFY-2, the schema half of AC-VERIFY-11): the lifecycle columns, the stamp,
 * fee-due, promotion and snapshot CHECKs (D-63), the `registrations_guard_update` transition trigger (D-64), the deferred
 * `registrations_within_capacity` backstop with its NOWAIT session lock (D-65, R4), the two partial indexes (D-66, D-67),
 * and the migrate, rollback, migrate round trip with the widened D-85 function (D-68, R20). Every rule is proven with raw
 * SQL; the allocator that will normally uphold them is a later phase.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateToLatest, rollbackMigrations } from '../../src/lib/db/migrate.ts';
import {
  ALLOWED_REGISTRATION_TRANSITIONS,
  REGISTRATION_TRANSITION_MATRIX,
} from '../fixtures/registration-transitions.ts';
import {
  insertGuest,
  insertPublishedSession,
  insertRegistration,
  insertSession,
  insertTeam,
  insertTeamMember,
  insertUser,
} from '../helpers/factories.ts';
import { catalogSnapshot } from '../helpers/schema-dump.ts';
import {
  createTestDatabase,
  expectPgError,
  inRollback,
  inTransaction,
  trySql,
  type TestDatabase,
} from '../helpers/test-db.ts';

let db: TestDatabase;
let teamId: string;
beforeAll(async () => {
  db = await createTestDatabase();
  teamId = await insertTeam(db.pool, { payoutConfigured: true });
});
afterAll(async () => {
  await db.close();
});

/** A PUBLISHED session in the future with room for `maxPlayers - reservedSeats` seats. */
async function session(maxPlayers = 50, reservedSeats = 0): Promise<string> {
  return (
    await insertPublishedSession(db.pool, teamId, { now: new Date(), maxPlayers, reservedSeats })
  ).sessionId;
}

async function member(): Promise<string> {
  const userId = await insertUser(db.pool, 'FEMALE');
  await insertTeamMember(db.pool, { teamId, userId, skillLevel: 'INTERMEDIATE' });
  return userId;
}

type Status = 'CONFIRMED' | 'WAITLISTED' | 'WITHDRAWN';

/** A registration row in `status` on a fresh session (or `sessionId`), with consistent stamps and snapshot. */
async function row(
  status: Status,
  extra: Partial<Parameters<typeof insertRegistration>[1]> = {},
  sessionId?: string,
): Promise<{ id: string; sessionId: string; userId: string }> {
  const sid = sessionId ?? (await session());
  const userId = await member();
  const id = await insertRegistration(db.pool, {
    sessionId: sid,
    teamId,
    userId,
    status,
    queuePosition: status === 'WAITLISTED' ? 1 : null,
    ...extra,
  });
  return { id, sessionId: sid, userId };
}

const readRow = async (id: string): Promise<Record<string, unknown>> =>
  (await db.pool.query(`SELECT * FROM registrations WHERE id = $1`, [id])).rows[0] as Record<
    string,
    unknown
  >;

describe('session factory deadline', () => {
  it('stores an explicit cancellationDeadline instead of the trigger-computed default', async () => {
    const now = new Date();
    const requested = new Date(now.getTime() + 72 * 3_600_000 - 6 * 3_600_000);
    const { sessionId } = await insertPublishedSession(db.pool, teamId, {
      now,
      cancellationDeadline: requested,
    });
    const stored = (
      await db.pool.query(`SELECT cancellation_deadline FROM game_sessions WHERE id = $1`, [
        sessionId,
      ])
    ).rows[0] as { cancellation_deadline: Date };
    expect(stored.cancellation_deadline.getTime()).toBe(requested.getTime());
  });
});

describe('lifecycle columns, enums and indexes (D-62, D-63, D-66, D-67)', () => {
  it('adds the enums and columns with their defaults', async () => {
    const enums = await db.pool.query<{ name: string; labels: string[] }>(
      `SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
         FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname IN ('withdrawal_kind', 'registration_source') GROUP BY t.typname`,
    );
    expect(Object.fromEntries(enums.rows.map((r) => [r.name, r.labels]))).toEqual({
      withdrawal_kind: ['EARLY', 'LATE', 'BANNED'],
      registration_source: ['MEMBER', 'AUTO_ENROL'],
    });
    const columns = await db.pool.query<{
      column_name: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'registrations'
          AND column_name IN ('promoted_at', 'withdrawn_at', 'withdrawal_kind', 'withdrawal_fee_due', 'source',
                              'registrant_skill_level', 'registrant_sex')`,
    );
    expect(
      Object.fromEntries(
        columns.rows.map((c) => [
          c.column_name,
          [c.udt_name, c.is_nullable, c.column_default] as const,
        ]),
      ),
    ).toEqual({
      promoted_at: ['timestamptz', 'YES', null],
      withdrawn_at: ['timestamptz', 'YES', null],
      withdrawal_kind: ['withdrawal_kind', 'YES', null],
      withdrawal_fee_due: ['bool', 'NO', 'false'],
      source: ['registration_source', 'NO', "'MEMBER'::registration_source"],
      registrant_skill_level: ['skill_tier', 'YES', null],
      registrant_sex: ['user_sex', 'YES', null],
    });
  });

  it('has the two partial indexes', async () => {
    const { rows } = await db.pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE indexname IN ('idx_registrations_active_member', 'idx_registrations_fee_due')`,
    );
    const defs = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(defs.idx_registrations_active_member).toMatch(
      /\(team_id, user_id, session_id\) WHERE \(status = ANY \(ARRAY\['CONFIRMED'::registration_status, 'WAITLISTED'::registration_status\]\)\)/,
    );
    expect(defs.idx_registrations_fee_due).toMatch(
      /\(session_id, withdrawn_at\) WHERE withdrawal_fee_due/,
    );
  });
});

describe('stamp, fee-due, promotion and snapshot CHECKs (D-63)', () => {
  const insert = `INSERT INTO registrations (session_id, team_id, user_id, status, queue_position, promoted_at,
                    withdrawn_at, withdrawal_kind, withdrawal_fee_due, registrant_sex, registrant_skill_level)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`;

  it('sets withdrawn_at and withdrawal_kind iff WITHDRAWN (23514)', async () => {
    const sid = await session();
    await inRollback(db.pool, async (client) => {
      const attempt = async (...v: unknown[]) =>
        trySql(client, insert, [sid, teamId, await member(), ...v]);
      const now = new Date();
      // [status, queue, promoted, withdrawn_at, kind, fee_due, sex, skill]
      expect(await attempt('WITHDRAWN', null, null, null, null, false, null, null)).toMatchObject({
        code: '23514',
        constraint: 'registrations_withdrawal_stamps',
      });
      expect(await attempt('WITHDRAWN', null, null, now, null, false, null, null)).toMatchObject({
        code: '23514',
        constraint: 'registrations_withdrawal_stamps',
      });
      expect(
        await attempt('WITHDRAWN', null, null, null, 'EARLY', false, null, null),
      ).toMatchObject({ code: '23514', constraint: 'registrations_withdrawal_stamps' });
      expect(
        await attempt('CONFIRMED', null, null, now, null, false, 'MALE', 'BEGINNER'),
      ).toMatchObject({ code: '23514', constraint: 'registrations_withdrawal_stamps' });
      expect(
        await attempt('CONFIRMED', null, null, null, 'EARLY', false, 'MALE', 'BEGINNER'),
      ).toMatchObject({ code: '23514', constraint: 'registrations_withdrawal_stamps' });
      expect(
        await attempt('WITHDRAWN', null, null, now, 'EARLY', false, null, null),
      ).toBeUndefined();
    });
  });

  it('allows withdrawal_fee_due only on a LATE withdrawal (23514)', async () => {
    const sid = await session();
    await inRollback(db.pool, async (client) => {
      const attempt = async (...v: unknown[]) =>
        trySql(client, insert, [sid, teamId, await member(), ...v]);
      const now = new Date();
      // [status, queue, promoted, withdrawn_at, kind, fee_due, sex, skill]
      expect(
        await attempt('CONFIRMED', null, null, null, null, true, 'MALE', 'BEGINNER'),
      ).toMatchObject({ code: '23514', constraint: 'registrations_fee_due_only_late' });
      expect(
        await attempt('WITHDRAWN', null, null, now, 'EARLY', true, 'MALE', 'BEGINNER'),
      ).toMatchObject({ code: '23514', constraint: 'registrations_fee_due_only_late' });
      expect(
        await attempt('WITHDRAWN', null, null, now, 'BANNED', true, 'MALE', 'BEGINNER'),
      ).toMatchObject({ code: '23514', constraint: 'registrations_fee_due_only_late' });
      expect(
        await attempt('WITHDRAWN', null, null, now, 'LATE', true, 'MALE', 'BEGINNER'),
      ).toBeUndefined();
    });
  });

  it('keeps promoted_at NULL while WAITLISTED (23514)', async () => {
    const sid = await session();
    await inRollback(db.pool, async (client) => {
      const attempt = async (...v: unknown[]) =>
        trySql(client, insert, [sid, teamId, await member(), ...v]);
      expect(
        await attempt('WAITLISTED', 1, new Date(), null, null, false, null, null),
      ).toMatchObject({ code: '23514', constraint: 'registrations_promoted_at_not_waitlisted' });
      expect(await attempt('WAITLISTED', 2, null, null, null, false, null, null)).toBeUndefined();
    });
  });

  it('requires the R15 snapshot on CONFIRMED and on a fee-due withdrawal, and nowhere else (23514)', async () => {
    const sid = await session();
    await inRollback(db.pool, async (client) => {
      const attempt = async (...v: unknown[]) =>
        trySql(client, insert, [sid, teamId, await member(), ...v]);
      const now = new Date();
      // [status, queue, promoted, withdrawn_at, kind, fee_due, sex, skill]
      for (const [sex, skill] of [
        [null, 'BEGINNER'],
        ['MALE', null],
        [null, null],
      ]) {
        expect(await attempt('CONFIRMED', null, null, null, null, false, sex, skill)).toMatchObject(
          { code: '23514', constraint: 'registrations_registrant_snapshot' },
        );
        expect(await attempt('WITHDRAWN', null, null, now, 'LATE', true, sex, skill)).toMatchObject(
          { code: '23514', constraint: 'registrations_registrant_snapshot' },
        );
      }
      expect(
        await attempt('CONFIRMED', null, null, null, null, false, 'OTHER', 'ADVANCED'),
      ).toBeUndefined();
      // Never confirmed (WAITLISTED) or withdrawn with no fee owed: both columns may stay NULL.
      expect(await attempt('WAITLISTED', 1, null, null, null, false, null, null)).toBeUndefined();
      expect(
        await attempt('WITHDRAWN', null, null, now, 'EARLY', false, null, null),
      ).toBeUndefined();
    });
  });
});

describe('transition trigger registrations_guard_update (D-64)', () => {
  const SET: Record<Status, string> = {
    CONFIRMED: `status = 'CONFIRMED', queue_position = NULL, withdrawn_at = NULL, withdrawal_kind = NULL,
                promoted_at = $2, registrant_sex = 'MALE', registrant_skill_level = 'BEGINNER'`,
    WAITLISTED: `status = 'WAITLISTED', queue_position = 1, withdrawn_at = NULL, withdrawal_kind = NULL`,
    WITHDRAWN: `status = 'WITHDRAWN', queue_position = NULL, withdrawn_at = now(), withdrawal_kind = 'EARLY'`,
  };

  it('replays the shared matrix: exactly five status moves are allowed, a demotion is 23000', async () => {
    expect(REGISTRATION_TRANSITION_MATRIX).toHaveLength(6);
    expect(ALLOWED_REGISTRATION_TRANSITIONS).toHaveLength(5);
    for (const { from, to, allowed } of REGISTRATION_TRANSITION_MATRIX) {
      const { id } = await row(from);
      const promotedAt = from === 'WAITLISTED' ? new Date() : null;
      // $2 is referenced only by the CONFIRMED target; the other targets pass it unused via a cast-free no-op.
      const sql = `UPDATE registrations SET ${SET[to]} WHERE id = $1`;
      const params = to === 'CONFIRMED' ? [id, promotedAt] : [id];
      const update = db.pool.query(sql, params);
      if (allowed) {
        await update;
        expect((await readRow(id)).status, `${from} -> ${to}`).toBe(to);
      } else {
        await expectPgError(update, '23000', 'registrations_status_transition');
        expect((await readRow(id)).status, `${from} -> ${to}`).toBe(from);
      }
    }
  });

  it('allows a same-status update of unguarded columns', async () => {
    for (const status of ['CONFIRMED', 'WAITLISTED', 'WITHDRAWN'] as const) {
      const { id } = await row(status);
      await db.pool.query(`UPDATE registrations SET updated_at = now() WHERE id = $1`, [id]);
    }
  });

  it('makes session_id, team_id and user_id immutable (23000)', async () => {
    const { id, sessionId } = await row('CONFIRMED');
    const otherSession = await session();
    const otherTeam = await insertTeam(db.pool);
    const otherUser = await insertUser(db.pool);
    for (const [column, value] of [
      ['session_id', otherSession],
      ['team_id', otherTeam],
      ['user_id', otherUser],
    ] as const) {
      await expectPgError(
        db.pool.query(`UPDATE registrations SET ${column} = $2 WHERE id = $1`, [id, value]),
        '23000',
        'registrations_keys_immutable',
      );
    }
    expect((await readRow(id)).session_id).toBe(sessionId);
  });

  it('never renumbers a row that stays WAITLISTED (23000)', async () => {
    const { id } = await row('WAITLISTED');
    await expectPgError(
      db.pool.query(`UPDATE registrations SET queue_position = 5 WHERE id = $1`, [id]),
      '23000',
      'registrations_queue_position_stable',
    );
    await db.pool.query(`UPDATE registrations SET queue_position = 1 WHERE id = $1`, [id]);
  });

  it('changes guest_count only on WITHDRAWN -> CONFIRMED|WAITLISTED (23000 otherwise)', async () => {
    for (const status of ['CONFIRMED', 'WAITLISTED', 'WITHDRAWN'] as const) {
      const { id } = await row(status);
      await expectPgError(
        db.pool.query(`UPDATE registrations SET guest_count = 1 WHERE id = $1`, [id]),
        '23000',
        'registrations_guest_count_frozen',
      );
    }
    // A re-registration reuses the row and brings its new party (the deferred guest trigger checks it at COMMIT).
    const { id } = await row('WITHDRAWN');
    await inTransaction(db.pool, async (client) => {
      await client.query(
        `UPDATE registrations SET ${SET.CONFIRMED}, guest_count = 2 WHERE id = $1`,
        [id, null],
      );
      await insertGuest(client, id, 1);
      await insertGuest(client, id, 2);
    });
    expect(await readRow(id)).toMatchObject({ status: 'CONFIRMED', guest_count: 2 });
  });

  it('requires promoted_at on WAITLISTED -> CONFIRMED and leaves it NULL on WITHDRAWN -> CONFIRMED (23000)', async () => {
    const waiting = await row('WAITLISTED');
    await expectPgError(
      db.pool.query(`UPDATE registrations SET ${SET.CONFIRMED} WHERE id = $1`, [waiting.id, null]),
      '23000',
      'registrations_promotion_stamp',
    );
    const gone = await row('WITHDRAWN');
    await expectPgError(
      db.pool.query(`UPDATE registrations SET ${SET.CONFIRMED} WHERE id = $1`, [
        gone.id,
        new Date(),
      ]),
      '23000',
      'registrations_promotion_stamp',
    );
    await db.pool.query(`UPDATE registrations SET ${SET.CONFIRMED} WHERE id = $1`, [gone.id, null]);
    await db.pool.query(`UPDATE registrations SET ${SET.CONFIRMED} WHERE id = $1`, [
      waiting.id,
      new Date(),
    ]);
  });

  it('lets withdrawal_fee_due go true -> false but never false -> true after the withdrawing update (R2, 23000)', async () => {
    // Set in the same UPDATE that withdraws the row: allowed.
    const confirmed = await row('CONFIRMED');
    await db.pool.query(
      `UPDATE registrations SET status = 'WITHDRAWN', withdrawn_at = now(), withdrawal_kind = 'LATE',
                                withdrawal_fee_due = true
        WHERE id = $1`,
      [confirmed.id],
    );
    expect(await readRow(confirmed.id)).toMatchObject({ withdrawal_fee_due: true });
    // Released once: true -> false is allowed, and is final.
    await db.pool.query(`UPDATE registrations SET withdrawal_fee_due = false WHERE id = $1`, [
      confirmed.id,
    ]);
    await expectPgError(
      db.pool.query(`UPDATE registrations SET withdrawal_fee_due = true WHERE id = $1`, [
        confirmed.id,
      ]),
      '23000',
      'registrations_fee_due_one_way',
    );
    // A LATE withdrawal that never owed a fee cannot start owing one later either.
    const late = await row('WITHDRAWN', { withdrawalKind: 'LATE' });
    await expectPgError(
      db.pool.query(`UPDATE registrations SET withdrawal_fee_due = true WHERE id = $1`, [late.id]),
      '23000',
      'registrations_fee_due_one_way',
    );
    // Re-registration takes the place over and clears the flag (R3).
    const owing = await row('WITHDRAWN', { withdrawalFeeDue: true });
    await db.pool.query(
      `UPDATE registrations SET ${SET.CONFIRMED}, withdrawal_fee_due = false WHERE id = $1`,
      [owing.id, null],
    );
    expect(await readRow(owing.id)).toMatchObject({
      status: 'CONFIRMED',
      withdrawal_fee_due: false,
    });
  });

  it('changes the R15 snapshot only on a transition into CONFIRMED, including a re-take (23000 otherwise)', async () => {
    const confirmed = await row('CONFIRMED', { registrantSkillLevel: 'INTERMEDIATE' });
    for (const set of [
      `registrant_skill_level = 'ADVANCED'`,
      `registrant_sex = 'OTHER'`,
      `registrant_skill_level = NULL`,
    ]) {
      await expectPgError(
        db.pool.query(`UPDATE registrations SET ${set} WHERE id = $1`, [confirmed.id]),
        '23000',
        'registrations_snapshot_immutable',
      );
    }
    // Withdrawing keeps it, and a withdrawn row cannot rewrite it.
    await db.pool.query(
      `UPDATE registrations SET status = 'WITHDRAWN', withdrawn_at = now(), withdrawal_kind = 'EARLY'
        WHERE id = $1`,
      [confirmed.id],
    );
    await expectPgError(
      db.pool.query(`UPDATE registrations SET registrant_sex = 'OTHER' WHERE id = $1`, [
        confirmed.id,
      ]),
      '23000',
      'registrations_snapshot_immutable',
    );
    // A re-take re-reads both.
    await db.pool.query(
      `UPDATE registrations SET status = 'CONFIRMED', withdrawn_at = NULL, withdrawal_kind = NULL,
                                registrant_skill_level = 'ADVANCED', registrant_sex = 'OTHER'
        WHERE id = $1`,
      [confirmed.id],
    );
    expect(await readRow(confirmed.id)).toMatchObject({
      registrant_skill_level: 'ADVANCED',
      registrant_sex: 'OTHER',
    });
  });

  it('sets source on creation and re-activation only (23000 while the row stays active or withdrawn)', async () => {
    const member1 = await row('CONFIRMED', { source: 'AUTO_ENROL' });
    await expectPgError(
      db.pool.query(`UPDATE registrations SET source = 'MEMBER' WHERE id = $1`, [member1.id]),
      '23000',
      'registrations_source_immutable',
    );
    await db.pool.query(
      `UPDATE registrations SET status = 'WITHDRAWN', withdrawn_at = now(), withdrawal_kind = 'EARLY'
        WHERE id = $1`,
      [member1.id],
    );
    await expectPgError(
      db.pool.query(`UPDATE registrations SET source = 'MEMBER' WHERE id = $1`, [member1.id]),
      '23000',
      'registrations_source_immutable',
    );
    await db.pool.query(
      `UPDATE registrations SET status = 'WAITLISTED', queue_position = 1, withdrawn_at = NULL,
                                withdrawal_kind = NULL, source = 'MEMBER'
        WHERE id = $1`,
      [member1.id],
    );
    expect(await readRow(member1.id)).toMatchObject({ status: 'WAITLISTED', source: 'MEMBER' });
  });
});

describe('capacity backstop registrations_within_capacity (D-65, R4)', () => {
  it('refuses a COMMIT in which CONFIRMED parties exceed max_players - reserved_seats (23514)', async () => {
    const sid = await session(4, 1); // public capacity 3
    await row('CONFIRMED', {}, sid);
    await row('CONFIRMED', {}, sid);
    await row('CONFIRMED', {}, sid);
    await expectPgError(
      insertRegistration(db.pool, {
        sessionId: sid,
        teamId,
        userId: await member(),
        status: 'CONFIRMED',
      }),
      '23514',
      'registrations_within_capacity',
    );
    // WAITLISTED and WITHDRAWN rows never count and are never refused.
    await row('WAITLISTED', {}, sid);
    await row('WITHDRAWN', {}, sid);
  });

  it('counts each party as 1 + guest_count, and checks at COMMIT, not per statement', async () => {
    const sid = await session(3, 0);
    const party = await member();
    await inTransaction(db.pool, async (client) => {
      const id = await insertRegistration(client, {
        sessionId: sid,
        teamId,
        userId: party,
        status: 'CONFIRMED',
        guestCount: 2,
      });
      await insertGuest(client, id, 1);
      await insertGuest(client, id, 2);
    });
    // Over capacity inside the transaction, back within it before COMMIT: accepted.
    const first = await row('CONFIRMED', {}, await session(1, 0));
    await inTransaction(db.pool, async (client) => {
      await insertRegistration(client, {
        sessionId: first.sessionId,
        teamId,
        userId: await member(),
        status: 'CONFIRMED',
      });
      await client.query(
        `UPDATE registrations SET status = 'WITHDRAWN', withdrawn_at = now(), withdrawal_kind = 'EARLY'
          WHERE id = $1`,
        [first.id],
      );
    });
    // The full party of three leaves no seat for a solo newcomer.
    await expectPgError(
      insertRegistration(db.pool, {
        sessionId: sid,
        teamId,
        userId: await member(),
        status: 'CONFIRMED',
      }),
      '23514',
      'registrations_within_capacity',
    );
  });

  it('refuses re-confirming a withdrawn row into a full session, but never blocks a capacity cut or a withdrawal', async () => {
    const sid = await session(2, 0);
    const a = await row('CONFIRMED', {}, sid);
    await row('CONFIRMED', {}, sid);
    const gone = await row('WITHDRAWN', {}, sid);
    await expectPgError(
      db.pool.query(
        `UPDATE registrations SET status = 'CONFIRMED', withdrawn_at = NULL, withdrawal_kind = NULL,
                                  registrant_sex = 'MALE', registrant_skill_level = 'BEGINNER'
          WHERE id = $1`,
        [gone.id],
      ),
      '23514',
      'registrations_within_capacity',
    );
    // An admin capacity cut below the confirmed seats is not blocked, nor is a touch of a confirmed row.
    await db.pool.query(`UPDATE game_sessions SET max_players = 1 WHERE id = $1`, [sid]);
    await db.pool.query(`UPDATE registrations SET updated_at = now() WHERE session_id = $1`, [sid]);
    await db.pool.query(
      `UPDATE registrations SET status = 'WITHDRAWN', withdrawn_at = now(), withdrawal_kind = 'EARLY'
        WHERE id = $1`,
      [a.id],
    );
    expect((await readRow(a.id)).status).toBe('WITHDRAWN');
  });

  it('takes the session lock NOWAIT: an out-of-allocator promotion is refused 55P03 while the lock is held, an allocator-style one commits (R4)', async () => {
    const sid = await session(5, 0);
    const waiting = await row('WAITLISTED', {}, sid);
    const holder = await db.pool.connect();
    const bypass = await db.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM game_sessions WHERE id = $1 FOR UPDATE`, [sid]);

      await bypass.query('BEGIN');
      await bypass.query(
        `UPDATE registrations SET status = 'CONFIRMED', queue_position = NULL, promoted_at = now(),
                                  registrant_sex = 'MALE', registrant_skill_level = 'BEGINNER'
          WHERE id = $1`,
        [waiting.id],
      );
      // The deferred trigger asks for the session row at COMMIT and refuses at once instead of waiting.
      const started = Date.now();
      await expectPgError(bypass.query('COMMIT'), '55P03');
      expect(Date.now() - started).toBeLessThan(2_000);
      await bypass.query('ROLLBACK').catch(() => undefined);
      expect((await readRow(waiting.id)).status).toBe('WAITLISTED');

      await holder.query('COMMIT');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      bypass.release();
    }
    // The lock-then-write path (what the allocator does) commits: it already holds the lock the trigger asks for.
    await inTransaction(db.pool, async (client) => {
      await client.query(`SELECT id FROM game_sessions WHERE id = $1 FOR UPDATE`, [sid]);
      await client.query(
        `UPDATE registrations SET status = 'CONFIRMED', queue_position = NULL, promoted_at = now(),
                                  registrant_sex = 'MALE', registrant_skill_level = 'BEGINNER'
          WHERE id = $1`,
        [waiting.id],
      );
    });
    expect((await readRow(waiting.id)).status).toBe('CONFIRMED');
  });
});

describe('game_session_has_active_registrations after the widening (D-68, R20)', () => {
  const active = async (id: string): Promise<boolean> =>
    (
      await db.pool.query<{ a: boolean }>(`SELECT game_session_has_active_registrations($1) AS a`, [
        id,
      ])
    ).rows[0]?.a ?? false;

  it('is true for CONFIRMED, WAITLISTED and a WITHDRAWN row with a fee still owed; false for none and a released fee', async () => {
    for (const [status, extra, expected] of [
      ['CONFIRMED', {}, true],
      ['WAITLISTED', {}, true],
      ['WITHDRAWN', {}, false],
      ['WITHDRAWN', { withdrawalKind: 'LATE' as const }, false],
      ['WITHDRAWN', { withdrawalFeeDue: true }, true],
    ] as const) {
      const r = await row(status, extra);
      expect(await active(r.sessionId), `${status} ${JSON.stringify(extra)}`).toBe(expected);
    }
    expect(await active(await session())).toBe(false);
    const owing = await row('WITHDRAWN', { withdrawalFeeDue: true });
    await db.pool.query(`UPDATE registrations SET withdrawal_fee_due = false WHERE id = $1`, [
      owing.id,
    ]);
    expect(await active(owing.sessionId)).toBe(false);
  });
});

describe('migrate, rollback, migrate round trip (AC-VERIFY-2)', () => {
  it("rolls back to SSE's original function body, restores the old schema, and backfills legacy rows on the way up", async () => {
    const empty = await createTestDatabase({ empty: true });
    try {
      await migrateToLatest({ databaseUrl: empty.url });
      const latest = await catalogSnapshot(empty.pool);
      expect(latest.some((line) => line.includes('registrations_guard_update'))).toBe(true);
      expect(latest.some((line) => line.includes('fee_due'))).toBe(true);

      const reverted = await rollbackMigrations({ databaseUrl: empty.url, count: 1 });
      expect(reverted).toHaveLength(1);
      expect(reverted[0]).toContain('registration_lifecycle');
      const before = await catalogSnapshot(empty.pool);
      for (const gone of [
        'registrations_guard_update',
        'registrations_within_capacity',
        'registrations_enforce_capacity',
        'idx_registrations_active_member',
        'idx_registrations_fee_due',
        'withdrawal_kind',
        'registration_source',
        'registrant_skill_level',
        'withdrawal_fee_due',
      ]) {
        expect(
          before.filter((line) => line.includes(gone)),
          gone,
        ).toEqual([]);
      }
      // SSE still owns the function: it is back to its original body, and the fee-lock trigger still exists.
      const fn = before.find((line) =>
        line.includes('FUNCTION public.game_session_has_active_registrations'),
      );
      expect(fn?.replaceAll(/\s+/g, ' ')).toContain(
        "WHERE r.session_id = p_session_id AND r.status IN ('CONFIRMED', 'WAITLISTED')",
      );
      expect(fn).not.toContain('withdrawal_fee_due');
      expect(before.some((line) => line.includes('game_sessions_fee_raise_locked'))).toBe(true);

      // Legacy rows written before the lifecycle columns existed.
      const legacyTeam = await insertTeam(empty.pool, { payoutConfigured: true });
      const legacySession = await insertSession(
        empty.pool,
        legacyTeam,
        {},
        { status: 'PUBLISHED' },
      );
      const [sam, wendy] = [
        await insertUser(empty.pool, 'MALE'),
        await insertUser(empty.pool, 'FEMALE'),
      ];
      await insertTeamMember(empty.pool, {
        teamId: legacyTeam,
        userId: sam,
        skillLevel: 'ADVANCED',
      });
      await insertTeamMember(empty.pool, { teamId: legacyTeam, userId: wendy });
      await empty.pool.query(
        `INSERT INTO registrations (session_id, team_id, user_id, status, updated_at) VALUES
           ($1, $2, $3, 'CONFIRMED', now()), ($1, $2, $4, 'WITHDRAWN', '2026-10-01T00:00:00Z')`,
        [legacySession, legacyTeam, sam, wendy],
      );

      await migrateToLatest({ databaseUrl: empty.url });
      expect(await catalogSnapshot(empty.pool)).toEqual(latest);
      const { rows } = await empty.pool.query<Record<string, unknown>>(
        `SELECT user_id, status, withdrawn_at, withdrawal_kind, withdrawal_fee_due, source, registrant_sex,
                registrant_skill_level FROM registrations ORDER BY status`,
      );
      expect(rows).toEqual([
        {
          user_id: sam,
          status: 'CONFIRMED',
          withdrawn_at: null,
          withdrawal_kind: null,
          withdrawal_fee_due: false,
          source: 'MEMBER',
          registrant_sex: 'MALE',
          registrant_skill_level: 'ADVANCED',
        },
        {
          user_id: wendy,
          status: 'WITHDRAWN',
          withdrawn_at: new Date('2026-10-01T00:00:00Z'),
          withdrawal_kind: 'EARLY',
          withdrawal_fee_due: false,
          source: 'MEMBER',
          registrant_sex: null,
          registrant_skill_level: null,
        },
      ]);
    } finally {
      await empty.close();
    }
  }, 120_000);
});
