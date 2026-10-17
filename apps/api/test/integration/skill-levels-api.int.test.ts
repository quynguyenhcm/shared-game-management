/**
 * Skill-levels admin API, Phase 3 (skill-levels-and-auto-enroll): `PUT .../skill-level` and `PUT .../auto-enroll`
 * through the real `buildApp` over a cloned PostgreSQL, plus the additive `TeamMemberRow` fields on the existing
 * members list. ACs: AC-HAPPY-1..3, AC-HAPPY-7..11 and AC-HAPPY-13 (API half), AC-ERROR-1..5, AC-ERROR-9,
 * AC-VERIFY-7, AC-INTEGRATION-3 (`assertApprovedMember` sees the new level).
 *
 * Races hold a real team-row lock in the test and wait until Postgres reports the requests blocked behind it
 * (`lock-waiters.ts`); no sleep is the proof.
 */
import { Kysely, PostgresDialect } from 'kysely';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SKILL_PROGRESSION_GAMES, TeamMemberRow, type LocalDate } from '@sgm/shared';
import type { DB } from '../../src/lib/db/types.generated.ts';
import { selectAutoEnrollees } from '../../src/modules/skill-levels/auto-enrol.ts';
import { assertApprovedMember } from '../../src/modules/teams/membership.ts';
import { listMembers } from '../../src/modules/teams/repo.ts';
import { START_TIME, bearer, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  insertAuthSession,
  insertRegistration,
  insertSession,
  insertTeam,
  insertTeamMember,
  insertUser,
} from '../helpers/factories.ts';
import { holdTeamLock, waitForLockWaiters } from '../helpers/lock-waiters.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

let database: TestDatabase;
let h: AuthTestApp;
beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 12 });
  h = await buildAuthTestApp(database.pool);
});
afterAll(async () => {
  await h.close();
  await database.close();
});
beforeEach(() => {
  // 2026-10-06T00:00Z is 13:00 on 6 Oct in Pacific/Auckland: "today" for `until` validation.
  h.clock.set(START_TIME);
});

const DAY = 86_400_000;
/** The factory's sessions end on 7 Oct 2026 at 21:00 in Auckland (08:00Z); this is the next morning. */
const AFTER_GAMES = new Date('2026-10-08T00:00:00.000Z');

interface Person {
  readonly id: string;
  readonly token: string;
  readonly fullName: string;
}
interface MemberBody {
  userId: string;
  fullName: string;
  status: string;
  role: string;
  skillLevel: string;
  skillOverride: { byName: string; at: string } | null;
  skillChangedAt: string | null;
  autoEnroll: { enabled: boolean; until: string | null; assignedAt: string | null };
  skillProgress: { games: number; required: number; nextLevel: string } | null;
}
interface ChangeBody {
  member: MemberBody;
  changed: boolean;
}
interface ErrorBody {
  error: { code: string; message: string; fieldErrors?: Record<string, string[]> };
  member?: MemberBody;
}

let counter = 0;
async function person(fullName?: string): Promise<Person> {
  counter += 1;
  const name = fullName ?? `Player ${String(counter).padStart(4, '0')}`;
  const id = await insertUser(database.pool, 'FEMALE', {
    email: `skill-${counter}-${Date.now()}@example.test`,
  });
  await database.pool.query(`UPDATE users SET full_name = $2 WHERE id = $1`, [id, name]);
  const { token } = await insertAuthSession(database.pool, id, { createdAt: h.clock.now() });
  return { id, token, fullName: name };
}

interface Scene {
  readonly teamId: string;
  readonly aroha: Person;
  readonly bo: Person;
  readonly priya: Person;
}

/** "Tuesday Smashers": admins Aroha and Bo, approved BEGINNER member Priya. */
async function scene(): Promise<Scene> {
  const teamId = await insertTeam(database.pool, { name: `Tuesday Smashers ${counter}` });
  const aroha = await person('Aroha Ngata');
  const bo = await person('Bo Tamihana');
  const priya = await person('Priya Patel');
  for (const admin of [aroha, bo]) {
    await insertTeamMember(database.pool, { teamId, userId: admin.id, role: 'TEAM_ADMIN' });
  }
  await insertTeamMember(database.pool, { teamId, userId: priya.id, skillLevel: 'BEGINNER' });
  return { teamId, aroha, bo, priya };
}

const put = (
  path: 'skill-level' | 'auto-enroll',
  teamId: string,
  userId: string,
  who: Person | null,
  payload: unknown,
): Promise<LightMyRequestResponse> =>
  h.app.inject({
    method: 'PUT',
    url: `/teams/${teamId}/members/${userId}/${path}`,
    ...(who === null ? {} : { headers: bearer(who.token) }),
    payload: payload as Record<string, unknown>,
  });

const setLevel = (
  s: Scene,
  who: Person | null,
  body: { skillLevel: string; expectedSkillLevel?: string; expectedChangedAt?: string | null },
  userId = s.priya.id,
) =>
  put('skill-level', s.teamId, userId, who, {
    expectedSkillLevel: 'BEGINNER',
    expectedChangedAt: null,
    ...body,
  });

/** A panel that saw Auto Enroll off (the expected-state token of a fresh member). */
const SAW_OFF = { expectedEnabled: false, expectedUntil: null, expectedAssignedAt: null };

/** The expected-state token of a panel opened now: the member's stored Auto Enroll, as the API returns it. */
async function shownAutoEnroll(teamId: string, userId: string) {
  const { rows } = await database.pool.query<{
    is_auto_enroll: boolean;
    until: string | null;
    auto_enroll_assigned_at: Date | null;
  }>(
    `SELECT is_auto_enroll, auto_enroll_until::text AS until, auto_enroll_assigned_at
       FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId],
  );
  const row = rows[0];
  if (row === undefined) return SAW_OFF;
  return {
    expectedEnabled: row.is_auto_enroll,
    expectedUntil: row.until,
    expectedAssignedAt: row.auto_enroll_assigned_at?.toISOString() ?? null,
  };
}

/** An Auto Enroll save from a panel opened just now, unless `body` brings its own expected-state token. */
const setAuto = async (s: Scene, who: Person | null, body: object, userId = s.priya.id) =>
  put('auto-enroll', s.teamId, userId, who, {
    ...(await shownAutoEnroll(s.teamId, userId)),
    ...body,
  });

async function columns(teamId: string, userId: string) {
  const { rows } = await database.pool.query<{
    skill_level: string;
    skill_level_override_by: string | null;
    skill_level_override_at: Date | null;
    skill_level_changed_at: Date | null;
    is_auto_enroll: boolean;
    auto_enroll_until: string | null;
    auto_enroll_assigned_at: Date | null;
    status: string;
  }>(
    `SELECT skill_level, skill_level_override_by, skill_level_override_at, skill_level_changed_at,
            is_auto_enroll, auto_enroll_until, auto_enroll_assigned_at, status
       FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId],
  );
  return rows[0];
}

async function listed(s: Scene, userId = s.priya.id): Promise<MemberBody | undefined> {
  const response = await h.app.inject({
    method: 'GET',
    url: `/teams/${s.teamId}/members?status=APPROVED`,
    headers: bearer(s.aroha.token),
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ members: MemberBody[] }>().members.find((m) => m.userId === userId);
}

const eventsFor = (name: string, userId: string) =>
  h.logs.lines().filter((line) => line.event === name && line.userId === userId);

const errorOf = (response: LightMyRequestResponse) => response.json<ErrorBody>();

describe('PUT .../skill-level: override (AC-HAPPY-1..3, AC-INTEGRATION-3)', () => {
  it('raises a level: 200 changed, the stamps and baseline from one injected instant, provenance "set by admin"', async () => {
    const s = await scene();
    const now = h.clock.now();
    const response = await setLevel(s, s.aroha, { skillLevel: 'ADVANCED' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<ChangeBody>();
    expect(body.changed).toBe(true);
    expect(body.member).toMatchObject({
      userId: s.priya.id,
      fullName: 'Priya Patel',
      skillLevel: 'ADVANCED',
      skillOverride: { byName: 'Aroha Ngata', at: now.toISOString() },
      skillChangedAt: now.toISOString(),
      skillProgress: null,
    });
    expect(TeamMemberRow.strict().safeParse(body.member).success).toBe(true);
    expect(await columns(s.teamId, s.priya.id)).toMatchObject({
      skill_level: 'ADVANCED',
      skill_level_override_by: s.aroha.id,
      skill_level_override_at: now,
      skill_level_changed_at: now,
    });
    expect(eventsFor('team.member.skill_overridden', s.priya.id)).toHaveLength(1);
  });

  it('lowers a level that was moved up automatically and restarts the count at 0 (AC-HAPPY-2)', async () => {
    const s = await scene();
    const promotedAt = new Date(START_TIME.getTime() - 10 * DAY);
    await database.pool.query(
      `UPDATE team_members SET skill_level = 'ADVANCED', skill_level_changed_at = $3
        WHERE team_id = $1 AND user_id = $2`,
      [s.teamId, s.priya.id, promotedAt],
    );
    // A game completed after the promotion counts toward nothing at ADVANCED, and must not count after the override.
    const session = await insertSession(database.pool, s.teamId, { flat: '0.00' });
    await database.pool.query(`UPDATE game_sessions SET status = 'COMPLETED' WHERE id = $1`, [
      session,
    ]);
    await insertRegistration(database.pool, {
      sessionId: session,
      teamId: s.teamId,
      userId: s.priya.id,
    });
    // After the session ended (7 Oct, 21:00 NZ).
    h.clock.set(AFTER_GAMES);
    const response = await setLevel(s, s.bo, {
      skillLevel: 'INTERMEDIATE',
      expectedSkillLevel: 'ADVANCED',
      expectedChangedAt: promotedAt.toISOString(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<ChangeBody>().member).toMatchObject({
      skillLevel: 'INTERMEDIATE',
      skillOverride: { byName: 'Bo Tamihana' },
      skillProgress: { games: 0, required: SKILL_PROGRESSION_GAMES, nextLevel: 'ADVANCED' },
    });
  });

  it('saving the level the member already has is a 200 no-op: no stamps, no baseline reset, no event (AC-HAPPY-3)', async () => {
    const s = await scene();
    const before = await columns(s.teamId, s.priya.id);
    const response = await setLevel(s, s.aroha, { skillLevel: 'BEGINNER' });
    expect(response.statusCode).toBe(200);
    expect(response.json<ChangeBody>()).toMatchObject({
      changed: false,
      member: { skillLevel: 'BEGINNER', skillOverride: null, skillChangedAt: null },
    });
    expect(await columns(s.teamId, s.priya.id)).toEqual(before);
    expect(eventsFor('team.member.skill_overridden', s.priya.id)).toHaveLength(0);
  });

  it('an admin may override their own level, and assertApprovedMember returns the new level at once', async () => {
    const s = await scene();
    const response = await setLevel(s, s.aroha, { skillLevel: 'INTERMEDIATE' }, s.aroha.id);
    expect(response.statusCode).toBe(200);
    expect(response.json<ChangeBody>().member.skillOverride?.byName).toBe('Aroha Ngata');
    expect((await setLevel(s, s.aroha, { skillLevel: 'ADVANCED' })).statusCode).toBe(200);
    const gate = await h.db
      .transaction()
      .execute((trx) => assertApprovedMember(trx, s.teamId, s.priya.id));
    expect(gate.skillLevel).toBe('ADVANCED');
  });
});

describe('PUT .../skill-level: optimistic concurrency (Binding Reconciliation decision 4, AC-ERROR-9)', () => {
  it('a save based on a level another admin changed meanwhile is 409 skill_level_stale with the current member, and writes nothing', async () => {
    const s = await scene();
    expect((await setLevel(s, s.bo, { skillLevel: 'INTERMEDIATE' })).statusCode).toBe(200);
    const after = await columns(s.teamId, s.priya.id);
    h.clock.advance(60_000);
    const stale = await setLevel(s, s.aroha, { skillLevel: 'ADVANCED' });
    expect(stale.statusCode).toBe(409);
    const body = errorOf(stale);
    expect(body.error.code).toBe('skill_level_stale');
    expect(body.member).toMatchObject({
      userId: s.priya.id,
      skillLevel: 'INTERMEDIATE',
      skillOverride: { byName: 'Bo Tamihana' },
    });
    expect(await columns(s.teamId, s.priya.id)).toEqual(after);
    // Re-sent with what the refreshed panel shows, it applies.
    const retried = await setLevel(s, s.aroha, {
      skillLevel: 'ADVANCED',
      expectedSkillLevel: 'INTERMEDIATE',
      expectedChangedAt: body.member?.skillChangedAt ?? null,
    });
    expect(retried.statusCode).toBe(200);
  });

  it('compares the baseline at millisecond precision although it is stored with microseconds', async () => {
    const s = await scene();
    // Written by SQL with microseconds (as a job or a manual fix could); the API returns it to the millisecond.
    await database.pool.query(
      `UPDATE team_members SET skill_level = 'INTERMEDIATE',
              skill_level_changed_at = '2026-10-01T00:00:00.123456Z'
        WHERE team_id = $1 AND user_id = $2`,
      [s.teamId, s.priya.id],
    );
    const shown = await listed(s);
    expect(shown?.skillChangedAt).toBe('2026-10-01T00:00:00.123Z');
    const off = await setLevel(s, s.aroha, {
      skillLevel: 'ADVANCED',
      expectedSkillLevel: 'INTERMEDIATE',
      expectedChangedAt: '2026-10-01T00:00:00.124Z',
    });
    expect(errorOf(off).error.code).toBe('skill_level_stale');
    const exact = await setLevel(s, s.aroha, {
      skillLevel: 'ADVANCED',
      expectedSkillLevel: 'INTERMEDIATE',
      expectedChangedAt: shown?.skillChangedAt ?? null,
    });
    expect(exact.statusCode).toBe(200);
    // The writer binds the injected clock's Date, so the stored baseline is exactly the returned instant.
    const { rows } = await database.pool.query<{ t: string }>(
      `SELECT to_char(skill_level_changed_at AT TIME ZONE 'UTC', 'US') AS t
         FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [s.teamId, s.priya.id],
    );
    expect(rows[0]?.t.endsWith('000')).toBe(true);
  });
});

describe('PUT .../auto-enroll (AC-HAPPY-7..10, AC-HAPPY-13)', () => {
  it('turns Auto Enroll on with an end date, on with none, and keeps the place when only the date changes', async () => {
    const s = await scene();
    const sam = await person('Sam Rangi');
    await insertTeamMember(database.pool, { teamId: s.teamId, userId: sam.id });
    const priyaAt = h.clock.now();
    const on = await setAuto(s, s.aroha, { enabled: true, until: '2026-11-30' });
    expect(on.statusCode).toBe(200);
    expect(on.json<ChangeBody>()).toMatchObject({
      changed: true,
      member: {
        autoEnroll: { enabled: true, until: '2026-11-30', assignedAt: priyaAt.toISOString() },
      },
    });
    expect(await columns(s.teamId, s.priya.id)).toMatchObject({
      is_auto_enroll: true,
      auto_enroll_until: '2026-11-30',
      auto_enroll_assigned_at: priyaAt,
    });
    h.clock.advance(60_000);
    const samOn = await setAuto(s, s.aroha, { enabled: true, until: null }, sam.id);
    expect(samOn.json<ChangeBody>().member.autoEnroll).toEqual({
      enabled: true,
      until: null,
      assignedAt: h.clock.now().toISOString(),
    });
    h.clock.advance(60_000);
    for (const until of ['2026-12-24', null]) {
      const moved = await setAuto(s, s.bo, { enabled: true, until });
      expect(moved.json<ChangeBody>()).toMatchObject({
        changed: true,
        member: { autoEnroll: { until, assignedAt: priyaAt.toISOString() } },
      });
    }
    const order = await selectAutoEnrollees(h.db, {
      teamId: s.teamId,
      sessionDate: '2026-10-20' as LocalDate,
    });
    expect(order.map((e) => e.userId)).toEqual([s.priya.id, sam.id]);
    expect(eventsFor('team.member.auto_enroll_changed', s.priya.id)).toHaveLength(3);
  });

  it('turning it off clears all three columns; on again goes to the back; off->off and an unchanged on are no-ops', async () => {
    const s = await scene();
    const sam = await person();
    await insertTeamMember(database.pool, { teamId: s.teamId, userId: sam.id });
    await setAuto(s, s.aroha, { enabled: true, until: '2026-11-30' });
    h.clock.advance(60_000);
    await setAuto(s, s.aroha, { enabled: true, until: null }, sam.id);
    h.clock.advance(60_000);

    const off = await setAuto(s, s.aroha, { enabled: false, until: null });
    expect(off.json<ChangeBody>()).toMatchObject({
      changed: true,
      member: { autoEnroll: { enabled: false, until: null, assignedAt: null } },
    });
    expect(await columns(s.teamId, s.priya.id)).toMatchObject({
      is_auto_enroll: false,
      auto_enroll_until: null,
      auto_enroll_assigned_at: null,
    });
    const events = () => eventsFor('team.member.auto_enroll_changed', s.priya.id).length;
    const before = events();
    expect(
      (await setAuto(s, s.aroha, { enabled: false, until: null })).json<ChangeBody>().changed,
    ).toBe(false);
    h.clock.advance(60_000);
    expect(
      (await setAuto(s, s.aroha, { enabled: true, until: null })).json<ChangeBody>().changed,
    ).toBe(true);
    const unchanged = await setAuto(s, s.aroha, { enabled: true, until: null });
    expect(unchanged.json<ChangeBody>().changed).toBe(false);
    expect(events()).toBe(before + 1);
    const order = await selectAutoEnrollees(h.db, {
      teamId: s.teamId,
      sessionDate: '2026-10-20' as LocalDate,
    });
    expect(order.map((e) => e.userId)).toEqual([sam.id, s.priya.id]);
    // Not retroactive: nothing is written to registrations.
    const { rows } = await database.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM registrations WHERE team_id = $1`,
      [s.teamId],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('an ended Auto Enroll renews at the back of the order, while an until of today keeps the place (AC-HAPPY-13)', async () => {
    let s = await scene();
    const sam = await person();
    const kim = await person();
    for (const who of [sam, kim]) {
      await insertTeamMember(database.pool, { teamId: s.teamId, userId: who.id });
    }
    await setAuto(s, s.aroha, { enabled: true, until: '2026-11-30' });
    h.clock.advance(60_000);
    await setAuto(s, s.aroha, { enabled: true, until: '2026-12-02' }, kim.id);
    h.clock.advance(60_000);
    await setAuto(s, s.aroha, { enabled: true, until: null }, sam.id);

    // 2 Dec 2026, 10:00 in Auckland: Priya's assignment ended on 30 Nov, Kim's ends today.
    h.clock.set(new Date('2026-12-01T21:00:00.000Z'));
    // Weeks later: Aroha signs in again (her first session is past its idle limit).
    const { token } = await insertAuthSession(database.pool, s.aroha.id, {
      createdAt: h.clock.now(),
    });
    s = { ...s, aroha: { ...s.aroha, token } };
    const shown = await listed(s);
    // The flag stays set in the database and the API: the view derives "ended" from until < today (NZ).
    expect(shown?.autoEnroll).toMatchObject({ enabled: true, until: '2026-11-30' });
    const renewed = await setAuto(s, s.aroha, { enabled: true, until: null });
    expect(renewed.json<ChangeBody>().member.autoEnroll.assignedAt).toBe(
      h.clock.now().toISOString(),
    );
    const kept = await setAuto(s, s.aroha, { enabled: true, until: null }, kim.id);
    expect(kept.json<ChangeBody>().changed).toBe(true);
    const order = await selectAutoEnrollees(h.db, {
      teamId: s.teamId,
      sessionDate: '2026-12-05' as LocalDate,
    });
    expect(order.map((e) => e.userId)).toEqual([kim.id, sam.id, s.priya.id]);
  });

  it('a stale panel cannot re-enrol a member another admin turned off: 409 auto_enroll_stale with the current member (final review)', async () => {
    const s = await scene();
    await setAuto(s, s.aroha, { enabled: true, until: '2026-11-30' });
    // Aroha's panel was opened now, showing "on until 30 Nov".
    const arohaSaw = await shownAutoEnroll(s.teamId, s.priya.id);
    h.clock.advance(60_000);
    expect((await setAuto(s, s.bo, { enabled: false, until: null })).statusCode).toBe(200);
    const before = await columns(s.teamId, s.priya.id);
    const events = eventsFor('team.member.auto_enroll_changed', s.priya.id).length;

    h.clock.advance(60_000);
    const stale = await setAuto(s, s.aroha, { enabled: true, until: '2026-12-24', ...arohaSaw });
    expect(stale.statusCode).toBe(409);
    const body = errorOf(stale);
    expect(body.error.code).toBe('auto_enroll_stale');
    expect(body.member?.autoEnroll).toEqual({ enabled: false, until: null, assignedAt: null });
    expect(await columns(s.teamId, s.priya.id)).toEqual(before);
    expect(eventsFor('team.member.auto_enroll_changed', s.priya.id)).toHaveLength(events);
    expect(
      await selectAutoEnrollees(h.db, { teamId: s.teamId, sessionDate: '2026-10-20' as LocalDate }),
    ).toEqual([]);

    // A save that would change nothing is still a no-op on a stale view (retries stay safe), and a save
    // from the refreshed panel goes through.
    const retried = await setAuto(s, s.aroha, { enabled: false, until: null, ...arohaSaw });
    expect(retried.json<ChangeBody>().changed).toBe(false);
    const fresh = await setAuto(s, s.aroha, { enabled: true, until: '2026-12-24' });
    expect(fresh.statusCode).toBe(200);
  });
});

describe('refusals (AC-ERROR-1..3)', () => {
  it('a member, another team admin and a non-member global admin get 403 and a signed-out caller 401, before any body check', async () => {
    const s = await scene();
    const member = await person();
    await insertTeamMember(database.pool, { teamId: s.teamId, userId: member.id });
    const otherAdmin = await person();
    const otherTeam = await insertTeam(database.pool);
    await insertTeamMember(database.pool, {
      teamId: otherTeam,
      userId: otherAdmin.id,
      role: 'TEAM_ADMIN',
    });
    const globalAdmin = await person();
    await database.pool.query(`UPDATE users SET role = 'GLOBAL_ADMIN' WHERE id = $1`, [
      globalAdmin.id,
    ]);
    const before = await columns(s.teamId, s.priya.id);

    const bodies = {
      'skill-level': [
        { skillLevel: 'ADVANCED', expectedSkillLevel: 'BEGINNER', expectedChangedAt: null },
        { skillLevel: 'EXPERT', extra: true },
      ],
      'auto-enroll': [{ enabled: true, until: null }, { enabled: 'yes' }],
    } as const;
    for (const path of ['skill-level', 'auto-enroll'] as const) {
      for (const body of bodies[path]) {
        for (const who of [member, otherAdmin, globalAdmin]) {
          const response = await put(path, s.teamId, s.priya.id, who, body);
          expect(response.statusCode, `${path} ${JSON.stringify(body)}`).toBe(403);
          expect(response.json<ErrorBody>()).not.toHaveProperty('member');
        }
        expect((await put(path, s.teamId, s.priya.id, null, body)).statusCode).toBe(401);
      }
    }
    expect(await columns(s.teamId, s.priya.id)).toEqual(before);
  });

  it('a user with no row is 404; PENDING, REJECTED and BANNED targets are 409 membership_state_conflict', async () => {
    const s = await scene();
    const stranger = await person();
    const level = {
      skillLevel: 'ADVANCED',
      expectedSkillLevel: 'BEGINNER',
      expectedChangedAt: null,
    };
    const auto = { enabled: true, until: null };
    expect(errorOf(await setLevel(s, s.aroha, level, stranger.id)).error.code).toBe('not_found');
    expect(errorOf(await setAuto(s, s.aroha, auto, stranger.id)).error.code).toBe('not_found');
    for (const status of ['PENDING', 'REJECTED', 'BANNED'] as const) {
      const target = await person();
      await insertTeamMember(database.pool, {
        teamId: s.teamId,
        userId: target.id,
        status,
        actorId: s.aroha.id,
      });
      const before = await columns(s.teamId, target.id);
      for (const response of [
        await setLevel(s, s.aroha, level, target.id),
        await setAuto(s, s.aroha, auto, target.id),
      ]) {
        expect(response.statusCode, status).toBe(409);
        expect(errorOf(response).error.code).toBe('membership_state_conflict');
      }
      expect(await columns(s.teamId, target.id)).toEqual(before);
    }
  });

  it('invalid input is 422 validation_failed with fieldErrors and changes nothing', async () => {
    const s = await scene();
    const before = await columns(s.teamId, s.priya.id);
    const cases: ['skill-level' | 'auto-enroll', unknown, string][] = [
      [
        'skill-level',
        { skillLevel: 'EXPERT', expectedSkillLevel: 'BEGINNER', expectedChangedAt: null },
        'skillLevel',
      ],
      [
        'skill-level',
        {
          skillLevel: 'ADVANCED',
          expectedSkillLevel: 'BEGINNER',
          expectedChangedAt: null,
          overrideBy: 'x',
        },
        '_form',
      ],
      ['auto-enroll', { enabled: true, until: '30/11/2026', ...SAW_OFF }, 'until'],
      // Yesterday in Pacific/Auckland (today is 6 Oct): needs the injected clock, so the service checks it.
      ['auto-enroll', { enabled: true, until: '2026-10-05', ...SAW_OFF }, 'until'],
      ['auto-enroll', { enabled: false, until: '2026-11-30', ...SAW_OFF }, 'until'],
      ['auto-enroll', { enabled: true, until: null }, 'expectedEnabled'],
    ];
    for (const [path, body, field] of cases) {
      const response = await put(path, s.teamId, s.priya.id, s.aroha, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(422);
      const error = errorOf(response).error;
      expect(error.code).toBe('validation_failed');
      expect(Object.keys(error.fieldErrors ?? {}), JSON.stringify(body)).toContain(field);
    }
    expect(await columns(s.teamId, s.priya.id)).toEqual(before);
    // Today itself is allowed.
    expect((await setAuto(s, s.aroha, { enabled: true, until: '2026-10-06' })).statusCode).toBe(
      200,
    );
  });
});

describe('races under the team lock (AC-ERROR-4, AC-ERROR-5)', () => {
  it('an admin demoted while both saves wait for the team lock is refused with 403 and nothing is written', async () => {
    const s = await scene();
    const before = await columns(s.teamId, s.priya.id);
    const lock = await holdTeamLock(database.pool, s.teamId);
    try {
      const pending = [
        setLevel(s, s.aroha, { skillLevel: 'ADVANCED' }),
        setAuto(s, s.aroha, { enabled: true, until: null }),
      ];
      await waitForLockWaiters(database.pool, 2, 'saves blocked on the team row');
      await lock.query(
        `UPDATE team_members SET role = 'MEMBER' WHERE team_id = $1 AND user_id = $2`,
        [s.teamId, s.aroha.id],
      );
      await lock.release();
      const results = await Promise.all(pending);
      expect(results.map((r) => r.statusCode)).toEqual([403, 403]);
    } finally {
      await lock.release();
    }
    expect(await columns(s.teamId, s.priya.id)).toEqual(before);
  });

  it('a ban that commits while a toggle waits wins: the toggle gets 409 and the row stays cleared', async () => {
    const s = await scene();
    expect((await setAuto(s, s.aroha, { enabled: true, until: null })).statusCode).toBe(200);
    const lock = await holdTeamLock(database.pool, s.teamId);
    try {
      const pending = setAuto(s, s.aroha, { enabled: true, until: '2026-11-30' });
      await waitForLockWaiters(database.pool, 1, 'toggle blocked on the team row');
      // The ban path's single UPDATE (teams/repo.ts), committed while the toggle waits.
      await lock.query(
        `UPDATE team_members SET status = 'BANNED', banned_at = now(), banned_by = $3,
                is_auto_enroll = false, auto_enroll_until = NULL, auto_enroll_assigned_at = NULL
          WHERE team_id = $1 AND user_id = $2`,
        [s.teamId, s.priya.id, s.bo.id],
      );
      await lock.release();
      const response = await pending;
      expect(response.statusCode).toBe(409);
      expect(errorOf(response).error.code).toBe('membership_state_conflict');
    } finally {
      await lock.release();
    }
    expect(await columns(s.teamId, s.priya.id)).toMatchObject({
      status: 'BANNED',
      is_auto_enroll: false,
      auto_enroll_until: null,
      auto_enroll_assigned_at: null,
    });
  });

  it('both saves stamp the instant they wrote, not when they arrived: the clock is read after the locks (final review)', async () => {
    const s = await scene();
    const sam = await person();
    await insertTeamMember(database.pool, { teamId: s.teamId, userId: sam.id });
    const lock = await holdTeamLock(database.pool, s.teamId);
    // 2026-10-06T10:59:30Z is 23:59:30 on 6 Oct in Auckland: the saves arrive before NZ midnight...
    h.clock.set(new Date('2026-10-06T10:59:30.000Z'));
    try {
      const pending = [
        setLevel(s, s.aroha, { skillLevel: 'ADVANCED' }),
        // ...with an end date of 6 Oct, which is still today when they arrive.
        setAuto(s, s.aroha, { enabled: true, until: '2026-10-06' }, sam.id),
      ];
      await waitForLockWaiters(database.pool, 2, 'saves blocked on the team row');
      // ...and get their locks after midnight.
      h.clock.set(new Date('2026-10-06T11:00:30.000Z'));
      await lock.release();
      const [level, auto] = await Promise.all(pending);
      expect(level?.statusCode).toBe(200);
      expect(level?.json<ChangeBody>().member.skillOverride?.at).toBe('2026-10-06T11:00:30.000Z');
      expect(level?.json<ChangeBody>().member.skillChangedAt).toBe('2026-10-06T11:00:30.000Z');
      // 6 Oct is yesterday by the time the save runs, so it is refused and nothing is written.
      expect(auto?.statusCode).toBe(422);
      expect(errorOf(auto as LightMyRequestResponse).error.fieldErrors).toHaveProperty('until');
    } finally {
      await lock.release();
    }
    expect(await columns(s.teamId, sam.id)).toMatchObject({ is_auto_enroll: false });
  });

  it('a toggle that committed first is cleared by the ban, and a later toggle gets 409', async () => {
    const s = await scene();
    expect((await setAuto(s, s.aroha, { enabled: true, until: null })).statusCode).toBe(200);
    const ban = await h.app.inject({
      method: 'POST',
      url: `/teams/${s.teamId}/members/${s.priya.id}/ban`,
      headers: bearer(s.bo.token),
    });
    expect(ban.statusCode).toBe(200);
    expect(await columns(s.teamId, s.priya.id)).toMatchObject({
      status: 'BANNED',
      is_auto_enroll: false,
      auto_enroll_assigned_at: null,
    });
    const late = await setAuto(s, s.aroha, { enabled: true, until: null });
    expect(errorOf(late).error.code).toBe('membership_state_conflict');
    expect(
      await selectAutoEnrollees(h.db, { teamId: s.teamId, sessionDate: '2026-10-20' as LocalDate }),
    ).toEqual([]);
  });
});

describe('GET /teams/:teamId/members additive fields (AC-HAPPY-11, AC-VERIFY-7)', () => {
  async function games(s: Scene, userId: string, n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      const session = await insertSession(database.pool, s.teamId, { flat: '0.00' });
      await database.pool.query(`UPDATE game_sessions SET status = 'COMPLETED' WHERE id = $1`, [
        session,
      ]);
      await insertRegistration(database.pool, { sessionId: session, teamId: s.teamId, userId });
    }
  }

  it('every row carries the four fields; progress comes from the shared count, null at ADVANCED and off the APPROVED list', async () => {
    h.clock.set(AFTER_GAMES);
    const s = await scene();
    const sam = await person('Sam Advanced');
    await insertTeamMember(database.pool, {
      teamId: s.teamId,
      userId: sam.id,
      skillLevel: 'ADVANCED',
    });
    await games(s, s.priya.id, 3);
    await games(s, sam.id, 2);
    const pending = await person();
    await insertTeamMember(database.pool, {
      teamId: s.teamId,
      userId: pending.id,
      status: 'PENDING',
    });

    const priya = await listed(s);
    expect(priya).toMatchObject({
      skillOverride: null,
      skillChangedAt: null,
      autoEnroll: { enabled: false, until: null, assignedAt: null },
      skillProgress: { games: 3, required: SKILL_PROGRESSION_GAMES, nextLevel: 'INTERMEDIATE' },
    });
    expect((await listed(s, sam.id))?.skillProgress).toBeNull();
    const response = await h.app.inject({
      method: 'GET',
      url: `/teams/${s.teamId}/members?status=PENDING`,
      headers: bearer(s.aroha.token),
    });
    const [row] = response.json<{ members: MemberBody[] }>().members;
    expect(row).toMatchObject({
      skillProgress: null,
      autoEnroll: { enabled: false, until: null, assignedAt: null },
    });
    for (const member of [priya, row]) {
      expect(TeamMemberRow.strict().safeParse(member).success).toBe(true);
    }
  });

  it('computes a whole page with ONE counting query, however many members it holds (no N+1)', async () => {
    h.clock.set(AFTER_GAMES);
    const queries: string[] = [];
    const counting = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: database.pool }),
      log: (event) => {
        if (event.level === 'query') queries.push(event.query.sql);
      },
    });
    const perPage: number[] = [];
    for (const size of [2, 6]) {
      const s = await scene();
      for (let i = 0; i < size; i += 1) {
        const who = await person();
        await insertTeamMember(database.pool, { teamId: s.teamId, userId: who.id });
        await games(s, who.id, 1);
      }
      queries.length = 0;
      const page = await listMembers(counting, s.teamId, 'APPROVED', null, h.clock.now());
      expect(page.members.filter((m) => m.skillProgress?.games === 1)).toHaveLength(size);
      perPage.push(queries.length);
      expect(queries.filter((text) => /registrations/.test(text))).toHaveLength(1);
    }
    expect(perPage[0]).toBe(perPage[1]);
    expect(perPage[0]).toBeLessThanOrEqual(2);
  });
});
