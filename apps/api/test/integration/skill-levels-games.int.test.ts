/**
 * THE CONTRACT TEST for the skill-levels read seams (skill-levels-and-auto-enroll Phase 2: AC-VERIFY-3,
 * AC-INTEGRATION-1, AC-ASYNC-3, AC-INTEGRATION-3). It runs against a real cloned PostgreSQL 17 and inserts
 * `registrations` / `game_sessions` rows through the factories; no application code writes them yet.
 *
 *   C-GAME-1 (ADR 0017): a game is a CONFIRMED registration in a COMPLETED session of the same team. This file
 *     is the single table that defines it (`countQualifyingGames`, `countQualifyingGamesBatch`).
 *   C-SKL-1 (ADR 0017): session-scheduling-engine's materialiser calls `selectAutoEnrollees` after the session
 *     is PUBLISHED, then `allocator.autoEnrolInSession` once per session with the userIds in the returned order.
 *     The selection takes no locks, so Auto Enroll can be turned off between selection and allocation.
 *
 * OBLIGATION ON THE ALLOCATOR (C-SKL-1, reconciliation decision 5): `autoEnrolInSession`, under its own
 * `team_members` row lock and BEFORE it creates a registration, MUST re-check `is_auto_enroll`,
 * `auto_enroll_until >= session date` and `auto_enroll_assigned_at` equal to the value `selectAutoEnrollees`
 * returned for that member. The opt-out is authoritative at registration time. A deterministic race test lands
 * with whichever feature ships the allocator; whoever writes it should reuse `holdMemberLock` below.
 *
 * The "consumer contract" block at the bottom also pins the `TeamMemberRow` additive fields (`skillOverride`,
 * `skillChangedAt`, `autoEnroll`, `skillProgress`) with a strict parse of a real `GET /teams/:id/members` row: the
 * web panel and any later consumer read exactly these keys and shapes.
 */
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import {
  SKILL_PROGRESSION_GAMES,
  SKILL_PROGRESSION_WINDOW_MS,
  TeamMemberRow,
  parseLocalDate,
  type LocalDate,
  type SkillTier,
} from '@sgm/shared';
import { createKysely } from '../../src/lib/db/kysely.ts';
import type { DB } from '../../src/lib/db/types.generated.ts';
import {
  countQualifyingGames,
  countQualifyingGamesBatch,
  qualifyingGamesQuery,
} from '../../src/modules/skill-levels/games.ts';
import {
  selectAutoEnrollees,
  type AutoEnrollee,
} from '../../src/modules/skill-levels/auto-enrol.ts';
import { assertApprovedMember } from '../../src/modules/teams/membership.ts';
import {
  insertAuthSession,
  insertGuest,
  insertRegistration,
  insertSession,
  insertTeam,
  insertTeamMember,
  insertUser,
} from '../helpers/factories.ts';
import { bearer, buildAuthTestApp } from '../helpers/auth-app.ts';
import { countLockWaiters } from '../helpers/lock-waiters.ts';
import { createTestDatabase, inTransaction, type TestDatabase } from '../helpers/test-db.ts';

let database: TestDatabase;
let kysely: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  kysely = createKysely(database.pool);
});
afterAll(async () => {
  await database.close();
});

const HOUR = 3_600_000;
const SECOND = 1_000;

type SessionStatus = 'DRAFT' | 'PUBLISHED' | 'CANCELLED' | 'COMPLETED';
type RegistrationStatus = 'CONFIRMED' | 'WAITLISTED' | 'WITHDRAWN';

/** A free session in `teamId` (court 19:00-21:00 NZ) moved to `status`; returns its derived `ends_at`. */
async function seedSession(
  teamId: string,
  status: SessionStatus,
  date = '2026-10-07',
): Promise<{ id: string; endsAt: Date }> {
  const id = await insertSession(database.pool, teamId, { flat: '0.00' }, { date, status });
  const { rows } = await database.pool.query<{ ends_at: Date }>(
    'SELECT ends_at FROM game_sessions WHERE id = $1',
    [id],
  );
  const endsAt = rows[0]?.ends_at;
  if (endsAt === undefined) throw new Error('session has no ends_at');
  return { id, endsAt };
}

async function approvedMember(teamId: string, skillLevel: SkillTier = 'BEGINNER'): Promise<string> {
  const userId = await insertUser(database.pool);
  await insertTeamMember(database.pool, { teamId, userId, skillLevel });
  return userId;
}

/** Sets the counting baseline (a level change with no override: provenance "moved up automatically"). */
async function setBaseline(teamId: string, userId: string, at: Date): Promise<void> {
  await database.pool.query(
    'UPDATE team_members SET skill_level_changed_at = $3 WHERE team_id = $1 AND user_id = $2',
    [teamId, userId, at],
  );
}

describe('countQualifyingGames: the qualifying-game table (AC-VERIFY-3, C-GAME-1)', () => {
  interface Row {
    readonly name: string;
    readonly registration?: RegistrationStatus;
    readonly session?: SessionStatus;
    readonly guests?: number;
    /** Whose registration / which team's session carries the game. */
    readonly owner?: 'member' | 'other-member' | 'other-team';
    /** `now - ends_at` in ms. */
    readonly nowAfterEnd: number;
    /** `baseline - ends_at` in ms; omitted = never changed (NULL baseline). */
    readonly baselineAfterEnd?: number;
    readonly expected: 0 | 1;
  }

  const rows: readonly Row[] = [
    {
      name: 'a confirmed registration in a completed session counts',
      nowAfterEnd: HOUR,
      expected: 1,
    },
    {
      name: 'guests and party size are irrelevant: one registration is one game',
      guests: 2,
      nowAfterEnd: HOUR,
      expected: 1,
    },
    {
      name: 'a WAITLISTED registration is excluded',
      registration: 'WAITLISTED',
      nowAfterEnd: HOUR,
      expected: 0,
    },
    {
      name: 'a WITHDRAWN registration is excluded (early, and a charged late withdrawal alike)',
      registration: 'WITHDRAWN',
      nowAfterEnd: HOUR,
      expected: 0,
    },
    { name: 'a DRAFT session is excluded', session: 'DRAFT', nowAfterEnd: HOUR, expected: 0 },
    {
      name: 'a PUBLISHED session is excluded',
      session: 'PUBLISHED',
      nowAfterEnd: HOUR,
      expected: 0,
    },
    {
      name: 'a CANCELLED session is excluded',
      session: 'CANCELLED',
      nowAfterEnd: HOUR,
      expected: 0,
    },
    {
      name: "another member's registration is excluded",
      owner: 'other-member',
      nowAfterEnd: HOUR,
      expected: 0,
    },
    {
      name: "another team's session is excluded",
      owner: 'other-team',
      nowAfterEnd: HOUR,
      expected: 0,
    },
    {
      name: 'a session that ended exactly 365 days ago is excluded',
      nowAfterEnd: SKILL_PROGRESSION_WINDOW_MS,
      expected: 0,
    },
    {
      name: 'a session that ended more than 365 days ago is excluded',
      nowAfterEnd: SKILL_PROGRESSION_WINDOW_MS + SECOND,
      expected: 0,
    },
    {
      name: 'a session that ended 364 days 23 hours ago is included',
      nowAfterEnd: SKILL_PROGRESSION_WINDOW_MS - HOUR,
      expected: 1,
    },
    {
      name: 'a session that ended exactly at the baseline is excluded',
      nowAfterEnd: HOUR,
      baselineAfterEnd: 0,
      expected: 0,
    },
    {
      name: 'a session that ended before the baseline is excluded',
      nowAfterEnd: HOUR,
      baselineAfterEnd: SECOND,
      expected: 0,
    },
    {
      name: 'a session that ended one second after the baseline is included',
      nowAfterEnd: HOUR,
      baselineAfterEnd: -SECOND,
      expected: 1,
    },
    {
      name: 'a baseline older than the window does not widen the window',
      nowAfterEnd: SKILL_PROGRESSION_WINDOW_MS,
      baselineAfterEnd: -2 * SKILL_PROGRESSION_WINDOW_MS,
      expected: 0,
    },
    {
      name: 'a completed session whose end is after now is excluded (upper bound)',
      nowAfterEnd: -SECOND,
      expected: 0,
    },
    { name: 'a session that ended exactly at now is included', nowAfterEnd: 0, expected: 1 },
  ];

  it.each(rows)('$name', async (row) => {
    const teamId = await insertTeam(database.pool);
    const otherTeamId = await insertTeam(database.pool);
    const userId = await approvedMember(teamId);
    const otherUserId = await approvedMember(teamId);
    const gameTeam = row.owner === 'other-team' ? otherTeamId : teamId;
    const gameUser = row.owner === 'other-member' ? otherUserId : userId;
    const session = await seedSession(gameTeam, row.session ?? 'COMPLETED');
    // guest rows are checked at COMMIT, so a party is modelled by guest_count + guest rows in one transaction.
    await inTransaction(database.pool, async (client) => {
      const registrationId = await insertRegistration(client, {
        sessionId: session.id,
        teamId: gameTeam,
        userId: gameUser,
        status: row.registration ?? 'CONFIRMED',
        queuePosition: row.registration === 'WAITLISTED' ? 1 : null,
        guestCount: row.guests ?? 0,
      });
      for (let position = 1; position <= (row.guests ?? 0); position += 1) {
        await insertGuest(client, registrationId, position);
      }
    });
    if (row.baselineAfterEnd !== undefined) {
      await setBaseline(teamId, userId, new Date(session.endsAt.getTime() + row.baselineAfterEnd));
    }
    const now = new Date(session.endsAt.getTime() + row.nowAfterEnd);
    expect(await countQualifyingGames(kysely, { teamId, userId, now })).toBe(row.expected);
  });

  it('is not a stub: the count follows the seeded rows (0, then 1, then 2 games)', async () => {
    const teamId = await insertTeam(database.pool);
    const userId = await approvedMember(teamId);
    const first = await seedSession(teamId, 'COMPLETED', '2026-10-07');
    const second = await seedSession(teamId, 'COMPLETED', '2026-10-14');
    const now = new Date(second.endsAt.getTime() + HOUR);
    expect(await countQualifyingGames(kysely, { teamId, userId, now })).toBe(0);
    await insertRegistration(database.pool, { sessionId: first.id, teamId, userId });
    expect(await countQualifyingGames(kysely, { teamId, userId, now })).toBe(1);
    await insertRegistration(database.pool, { sessionId: second.id, teamId, userId });
    expect(await countQualifyingGames(kysely, { teamId, userId, now })).toBe(2);
    // The baseline moves between the two games: only the later one belongs to the current level.
    await setBaseline(teamId, userId, new Date(first.endsAt.getTime() + HOUR));
    expect(await countQualifyingGames(kysely, { teamId, userId, now })).toBe(1);
  });

  it('batch and scalar forms agree for every member (one predicate builder, parity)', async () => {
    const teamId = await insertTeam(database.pool);
    const sessions = [
      await seedSession(teamId, 'COMPLETED', '2026-10-07'),
      await seedSession(teamId, 'COMPLETED', '2026-10-14'),
      await seedSession(teamId, 'COMPLETED', '2026-10-21'),
      await seedSession(teamId, 'PUBLISHED', '2026-10-28'),
    ];
    const none = await approvedMember(teamId);
    const some = await approvedMember(teamId);
    const baselined = await approvedMember(teamId);
    const stranger = await insertUser(database.pool); // no team_members row at all
    for (const s of sessions) {
      await insertRegistration(database.pool, { sessionId: s.id, teamId, userId: baselined });
    }
    for (const s of sessions.slice(0, 2)) {
      await insertRegistration(database.pool, { sessionId: s.id, teamId, userId: some });
    }
    const now = new Date(sessions[2]!.endsAt.getTime() + HOUR);
    await setBaseline(teamId, baselined, new Date(sessions[0]!.endsAt.getTime() + HOUR));

    const userIds = [none, some, baselined, stranger];
    const batch = await countQualifyingGamesBatch(kysely, { teamId, userIds, now });
    for (const userId of userIds) {
      expect(batch.get(userId), userId).toBe(
        await countQualifyingGames(kysely, { teamId, userId, now }),
      );
    }
    expect([...userIds.map((id) => batch.get(id))]).toEqual([0, 2, 2, 0]);
    expect(await countQualifyingGamesBatch(kysely, { teamId, userIds: [], now })).toEqual(
      new Map(),
    );
  });

  it('uses idx_registrations_confirmed_member for the count (EXPLAIN with sequential scans discouraged)', async () => {
    const teamId = await insertTeam(database.pool);
    const userId = await approvedMember(teamId);
    for (let day = 1; day <= 25; day += 1) {
      const s = await seedSession(teamId, 'COMPLETED', `2026-11-${String(day).padStart(2, '0')}`);
      await insertRegistration(database.pool, { sessionId: s.id, teamId, userId });
    }
    await database.pool.query('ANALYZE registrations');
    await database.pool.query('ANALYZE game_sessions');
    await database.pool.query('ANALYZE team_members');
    const compiled = qualifyingGamesQuery(kysely, {
      teamId,
      userIds: [userId],
      now: new Date(),
    }).compile();
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON) ${compiled.sql}`,
        [...compiled.parameters],
      );
      await client.query('ROLLBACK');
      expect(JSON.stringify(rows[0]?.['QUERY PLAN'])).toContain(
        'idx_registrations_confirmed_member',
      );
    } finally {
      client.release();
    }
  });
});

/** Seeds an approved member with Auto Enroll on (the factory has no Auto Enroll options). */
async function autoEnrolMember(
  teamId: string,
  assignedAt: Date,
  until: string | null,
): Promise<{ userId: string; membershipId: string }> {
  const userId = await insertUser(database.pool);
  const membershipId = await insertTeamMember(database.pool, { teamId, userId });
  await database.pool.query(
    `UPDATE team_members SET is_auto_enroll = true, auto_enroll_until = $2, auto_enroll_assigned_at = $3
      WHERE id = $1`,
    [membershipId, until, assignedAt],
  );
  return { userId, membershipId };
}

const DAY1 = new Date('2026-10-01T02:00:00.000Z');
const DAY2 = new Date('2026-10-02T02:00:00.000Z');
const DAY3 = new Date('2026-10-03T02:00:00.000Z');
const DEC_1 = parseLocalDate('2026-12-01');
const NOV_30 = parseLocalDate('2026-11-30');

const byMembershipId = (a: { membershipId: string }, b: { membershipId: string }): number =>
  a.membershipId < b.membershipId ? -1 : 1;

describe('selectAutoEnrollees: predicate and order (AC-INTEGRATION-1, C-SKL-1)', () => {
  it('returns exactly the right members in assigned_at, id order, and the date changes the result', async () => {
    const teamId = await insertTeam(database.pool);
    const otherTeamId = await insertTeam(database.pool);
    const first = await autoEnrolMember(teamId, DAY1, null);
    const tieA = await autoEnrolMember(teamId, DAY2, '2026-12-01'); // until == session date: included
    const tieB = await autoEnrolMember(teamId, DAY2, null); // same instant as tieA: id breaks the tie
    const dayBefore = await autoEnrolMember(teamId, DAY3, '2026-11-30'); // until the day before 12-01
    await autoEnrolMember(otherTeamId, DAY1, null); // another team
    await approvedMember(teamId); // flag off
    const banned = await insertUser(database.pool);
    await insertTeamMember(database.pool, { teamId, userId: banned, status: 'BANNED' });

    const tie = [tieA, tieB].sort(byMembershipId);

    const onDec1 = await selectAutoEnrollees(kysely, { teamId, sessionDate: DEC_1 });
    expect(onDec1.map((e) => e.userId)).toEqual([first.userId, ...tie.map((e) => e.userId)]);
    expect(onDec1.map((e) => e.membershipId)).toEqual([
      first.membershipId,
      ...tie.map((e) => e.membershipId),
    ]);
    expect(onDec1.map((e) => e.userId)).not.toContain(dayBefore.userId);
    expect(onDec1[0]?.assignedAt).toEqual(DAY1);

    const onNov30 = await selectAutoEnrollees(kysely, { teamId, sessionDate: NOV_30 });
    expect(onNov30.map((e) => e.userId)).toEqual([
      first.userId,
      ...tie.map((e) => e.userId),
      dayBefore.userId,
    ]);
  });

  it('an auto-enrolled member who is then banned (flag cleared by the ban) is never selected', async () => {
    const teamId = await insertTeam(database.pool);
    const kept = await autoEnrolMember(teamId, DAY1, null);
    const banned = await autoEnrolMember(teamId, DAY2, null);
    await database.pool.query(
      `UPDATE team_members SET status = 'BANNED', banned_at = now(), banned_by = approved_by,
              is_auto_enroll = false, auto_enroll_until = NULL, auto_enroll_assigned_at = NULL
        WHERE id = $1`,
      [banned.membershipId],
    );
    const selected = await selectAutoEnrollees(kysely, { teamId, sessionDate: DEC_1 });
    expect(selected.map((e) => e.userId)).toEqual([kept.userId]);
  });

  it('returns an empty list for a team nobody auto-enrolled in', async () => {
    const teamId = await insertTeam(database.pool);
    await approvedMember(teamId);
    expect(await selectAutoEnrollees(kysely, { teamId, sessionDate: DEC_1 })).toEqual([]);
  });
});

describe('Auto Enroll ends by itself (AC-ASYNC-3)', () => {
  it('until 30 Nov is selected for a 30 Nov session and not for 1 Dec, with the flag still true and no job', async () => {
    const teamId = await insertTeam(database.pool);
    const member = await autoEnrolMember(teamId, DAY1, '2026-11-30');
    expect(
      (await selectAutoEnrollees(kysely, { teamId, sessionDate: NOV_30 })).map((e) => e.userId),
    ).toEqual([member.userId]);
    expect(await selectAutoEnrollees(kysely, { teamId, sessionDate: DEC_1 })).toEqual([]);
    const { rows } = await database.pool.query<{ is_auto_enroll: boolean }>(
      'SELECT is_auto_enroll FROM team_members WHERE id = $1',
      [member.membershipId],
    );
    expect(rows[0]?.is_auto_enroll).toBe(true); // the predicate did the work, nothing cleaned up
  });

  it('an expired row that is re-enabled is a NEW assignment: it joins at the back, in assigned_at order (binding decision 3)', async () => {
    const teamId = await insertTeam(database.pool);
    const expired = await autoEnrolMember(teamId, DAY1, '2026-11-01'); // oldest, but ended before the session
    const regular = await autoEnrolMember(teamId, DAY2, null);
    expect(
      (await selectAutoEnrollees(kysely, { teamId, sessionDate: DEC_1 })).map((e) => e.userId),
    ).toEqual([regular.userId]);

    // The service (Phase 3) treats an enabled save on an expired row as a new assignment: new time, new until.
    await database.pool.query(
      `UPDATE team_members SET auto_enroll_until = NULL, auto_enroll_assigned_at = $2 WHERE id = $1`,
      [expired.membershipId, DAY3],
    );
    expect(
      (await selectAutoEnrollees(kysely, { teamId, sessionDate: DEC_1 })).map((e) => e.userId),
    ).toEqual([regular.userId, expired.userId]);
  });
});

/** Holds `FOR UPDATE` on every member row of the team in an open transaction until `release()`. */
async function holdMemberLock(teamId: string): Promise<() => Promise<void>> {
  const client = await database.pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT id FROM team_members WHERE team_id = $1 FOR UPDATE', [teamId]);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  };
}

describe('the seams take no locks (AC-INTEGRATION-1, C-SKL-1)', () => {
  it('both functions complete while another transaction holds FOR UPDATE on the member rows, and add no lock waiter', async () => {
    const teamId = await insertTeam(database.pool);
    const member = await autoEnrolMember(teamId, DAY1, null);
    const session = await seedSession(teamId, 'COMPLETED');
    await insertRegistration(database.pool, {
      sessionId: session.id,
      teamId,
      userId: member.userId,
    });
    const now = new Date(session.endsAt.getTime() + HOUR);

    const release = await holdMemberLock(teamId);
    try {
      const timeout = new Promise<'blocked'>((resolve) =>
        setTimeout(() => resolve('blocked'), 5_000),
      );
      const both = Promise.all([
        selectAutoEnrollees(kysely, { teamId, sessionDate: DEC_1 }),
        countQualifyingGames(kysely, { teamId, userId: member.userId, now }),
      ]);
      const outcome = await Promise.race([both, timeout]);
      expect(outcome).not.toBe('blocked');
      const [selected, games] = outcome as Awaited<typeof both>;
      expect(selected.map((e) => e.userId)).toEqual([member.userId]);
      expect(games).toBe(1);
      expect(await countLockWaiters(database.pool)).toBe(0);
    } finally {
      await release();
    }
  }, 15_000);

  it('also works on the caller transaction and leaves no lock on the rows it read', async () => {
    const teamId = await insertTeam(database.pool);
    const member = await autoEnrolMember(teamId, DAY1, null);
    await kysely.transaction().execute(async (trx) => {
      const selected = await selectAutoEnrollees(trx, { teamId, sessionDate: DEC_1 });
      expect(selected.map((e) => e.userId)).toEqual([member.userId]);
      // A competing writer is not blocked by the open transaction that selected the row.
      const writer = await database.pool.connect();
      try {
        await writer.query("SET lock_timeout = '1s'");
        await writer.query('UPDATE team_members SET skill_level = $2 WHERE id = $1', [
          member.membershipId,
          'INTERMEDIATE',
        ]);
      } finally {
        writer.release();
      }
    });
  });
});

describe('consumer contract (AC-INTEGRATION-3)', () => {
  it('pins the selection and count signatures and the selection return shape', async () => {
    expectTypeOf(selectAutoEnrollees).parameters.toEqualTypeOf<
      [Kysely<DB>, { readonly teamId: string; readonly sessionDate: LocalDate }]
    >();
    expectTypeOf(selectAutoEnrollees).returns.toEqualTypeOf<Promise<readonly AutoEnrollee[]>>();
    expectTypeOf<AutoEnrollee>().toEqualTypeOf<{
      readonly userId: string;
      readonly membershipId: string;
      readonly assignedAt: Date;
    }>();
    expectTypeOf(countQualifyingGames).parameters.toEqualTypeOf<
      [Kysely<DB>, { readonly teamId: string; readonly userId: string; readonly now: Date }]
    >();
    expectTypeOf(countQualifyingGames).returns.toEqualTypeOf<Promise<number>>();

    const teamId = await insertTeam(database.pool);
    await autoEnrolMember(teamId, DAY1, null);
    const [row] = await selectAutoEnrollees(kysely, { teamId, sessionDate: DEC_1 });
    expect(Object.keys(row ?? {}).sort()).toEqual(['assignedAt', 'membershipId', 'userId']);
    expect(row?.assignedAt).toBeInstanceOf(Date);
  });

  it('assertApprovedMember (the gate registration-and-waitlist calls) returns the new level at once after a change', async () => {
    const teamId = await insertTeam(database.pool);
    const userId = await approvedMember(teamId, 'BEGINNER');
    const gate = (): Promise<SkillTier> =>
      kysely
        .transaction()
        .execute(async (trx) => (await assertApprovedMember(trx, teamId, userId)).skillLevel);
    expect(await gate()).toBe('BEGINNER');
    const actor = await insertUser(database.pool);
    const at = new Date('2026-10-17T00:00:00.000Z');
    // An override as the service will write it: level, both stamps and the baseline from one instant.
    await database.pool.query(
      `UPDATE team_members SET skill_level = 'ADVANCED', skill_level_override_by = $3,
              skill_level_override_at = $4, skill_level_changed_at = $4
        WHERE team_id = $1 AND user_id = $2`,
      [teamId, userId, actor, at],
    );
    expect(await gate()).toBe('ADVANCED');
  });

  it('pins the TeamMemberRow additive fields with a strict parse of a real members-list row', async () => {
    const harness = await buildAuthTestApp(database.pool);
    try {
      const teamId = await insertTeam(database.pool);
      const admin = await insertUser(database.pool);
      await database.pool.query(`UPDATE users SET full_name = 'Contract Admin' WHERE id = $1`, [
        admin,
      ]);
      await insertTeamMember(database.pool, { teamId, userId: admin, role: 'TEAM_ADMIN' });
      const { token } = await insertAuthSession(database.pool, admin, {
        createdAt: harness.clock.now(),
      });
      const member = await approvedMember(teamId, 'INTERMEDIATE');
      const overrideAt = new Date('2026-10-01T00:00:00.000Z');
      await database.pool.query(
        `UPDATE team_members SET skill_level_override_by = $3, skill_level_override_at = $4,
                skill_level_changed_at = $4, is_auto_enroll = true, auto_enroll_until = '2026-11-30',
                auto_enroll_assigned_at = $4
          WHERE team_id = $1 AND user_id = $2`,
        [teamId, member, admin, overrideAt],
      );
      const response = await harness.app.inject({
        method: 'GET',
        url: `/teams/${teamId}/members?status=APPROVED`,
        headers: bearer(token),
      });
      expect(response.statusCode).toBe(200);
      const rows = response.json<{ members: unknown[] }>().members;
      for (const row of rows) expect(TeamMemberRow.strict().parse(row)).toEqual(row);
      const pinned = rows
        .map((row) => TeamMemberRow.strict().parse(row))
        .find((row) => row.userId === member);
      expect(pinned).toMatchObject({
        skillLevel: 'INTERMEDIATE',
        skillOverride: { byName: 'Contract Admin', at: overrideAt.toISOString() },
        skillChangedAt: overrideAt.toISOString(),
        autoEnroll: { enabled: true, until: '2026-11-30', assignedAt: overrideAt.toISOString() },
        skillProgress: { games: 0, required: SKILL_PROGRESSION_GAMES, nextLevel: 'ADVANCED' },
      });
      expect(Object.keys(pinned ?? {}).sort()).toEqual(
        [
          'approvedAt',
          'autoEnroll',
          'banReason',
          'bannedAt',
          'fullName',
          'requestedAt',
          'role',
          'skillChangedAt',
          'skillLevel',
          'skillOverride',
          'skillProgress',
          'status',
          'userId',
        ].sort(),
      );
    } finally {
      await harness.close();
    }
  });
});
