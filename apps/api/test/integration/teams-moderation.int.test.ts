/**
 * Teams moderation API, Phase 3: the admin member lists, approve, reject, re-request, promote, demote and ban,
 * over a real cloned Postgres through `app.inject` (AC-HAPPY-6..11, AC-ERROR-6..9, AC-ASYNC-1 and 3 from the API
 * side, AC-INTEGRATION-2). The races hold a real team-row lock in the test and wait for Postgres to report the
 * blocked backends; no sleep is the proof. Where a simultaneous cross-demotion is concerned, Architecture
 * amendment A10 (the actor is re-checked under the team lock) wins over AC-ERROR-7's wording: the loser is no
 * longer an admin when its turn comes, so it is refused with 403 `forbidden`; the sole-admin and 20-way
 * self-demotion cases still answer 409 `last_team_admin`.
 */
import type { FastifyPluginAsync, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireTeamRole } from '../../src/lib/auth/policy.ts';
import { assertApprovedMember } from '../../src/modules/teams/membership.ts';
import { bearer, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  insertAuthSession,
  insertTeam,
  insertTeamMember,
  insertUser,
} from '../helpers/factories.ts';
import { raceUnderTeamLock } from '../helpers/lock-waiters.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

interface Enqueued {
  readonly queue: string;
  readonly data: Record<string, unknown>;
  readonly options: { singletonKey?: string; trx?: unknown };
}
const enqueued: Enqueued[] = [];

/** Guard fixture routes: what `requireTeamRole` answers on the next request after each moderation change. */
const fixtures: FastifyPluginAsync = (app) => {
  app.get('/_t/teams/:teamId/admin', { config: { policy: requireTeamRole('TEAM_ADMIN') } }, () => ({
    ok: true,
  }));
  app.get('/_t/teams/:teamId/member', { config: { policy: requireTeamRole('MEMBER') } }, () => ({
    ok: true,
  }));
  return Promise.resolve();
};

let database: TestDatabase;
let h: AuthTestApp;
beforeAll(async () => {
  // 20-way races need a connection per blocked request plus the lock holder.
  database = await createTestDatabase({ poolMax: 32 });
  h = await buildAuthTestApp(database.pool, {
    extraPlugins: [fixtures],
    jobs: {
      enqueue: (queue, data, options) => {
        enqueued.push({
          queue,
          data: JSON.parse(JSON.stringify(data)) as Record<string, unknown>,
          options: options ?? {},
        });
        return Promise.resolve('job-test');
      },
    },
  });
});
afterAll(async () => {
  await h.close();
  await database.close();
});

interface Person {
  readonly id: string;
  readonly token: string;
  readonly fullName: string;
  readonly email: string;
}
interface MemberBody {
  userId: string;
  fullName: string;
  role: string;
  status: string;
  skillLevel: string;
  requestedAt: string;
  approvedAt: string | null;
  bannedAt: string | null;
  banReason: string | null;
}
interface MembersBody {
  members: MemberBody[];
  nextCursor: string | null;
  adminCount: number;
}
interface ErrorBody {
  error: { code: string; message: string };
}

let counter = 0;
async function person(fullName?: string): Promise<Person> {
  counter += 1;
  const name = fullName ?? `Player ${String(counter).padStart(4, '0')}`;
  const email = `mod-${counter}-${Date.now()}@example.test`;
  const id = await insertUser(database.pool, 'FEMALE', { email });
  await database.pool.query(`UPDATE users SET full_name = $2 WHERE id = $1`, [id, name]);
  const { token } = await insertAuthSession(database.pool, id, { createdAt: h.clock.now() });
  return { id, token, fullName: name, email };
}

/** A team with the given admins already approved (the factory stamps approval). */
async function teamWith(
  admins: readonly Person[],
  visibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC',
): Promise<string> {
  const teamId = await insertTeam(database.pool, { visibility, name: `Team ${(counter += 1)}` });
  for (const admin of admins) {
    await insertTeamMember(database.pool, { teamId, userId: admin.id, role: 'TEAM_ADMIN' });
  }
  return teamId;
}

async function addMember(
  teamId: string,
  who: Person,
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'BANNED',
  role: 'MEMBER' | 'TEAM_ADMIN' = 'MEMBER',
  actor?: Person,
): Promise<void> {
  await insertTeamMember(database.pool, {
    teamId,
    userId: who.id,
    status,
    role,
    ...(actor === undefined ? {} : { actorId: actor.id }),
  });
}

const call = (
  method: 'GET' | 'POST',
  url: string,
  who: Person | null,
  payload?: unknown,
): Promise<LightMyRequestResponse> =>
  h.app.inject({
    method,
    url,
    ...(who === null ? {} : { headers: bearer(who.token) }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

const act = (teamId: string, userId: string, action: string, who: Person | null, body?: unknown) =>
  call('POST', `/teams/${teamId}/members/${userId}/${action}`, who, body);

const list = (teamId: string, who: Person | null, query: string) =>
  call('GET', `/teams/${teamId}/members?${query}`, who);

const errorCode = (response: LightMyRequestResponse): string =>
  response.json<ErrorBody>().error.code;

async function row(teamId: string, userId: string) {
  const { rows } = await database.pool.query<{
    role: string;
    status: string;
    approved_by: string | null;
    approved_at: Date | null;
    banned_by: string | null;
    banned_at: Date | null;
    ban_reason: string | null;
    skill_level: string;
  }>(
    `SELECT role, status, approved_by, approved_at, banned_by, banned_at, ban_reason, skill_level
       FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId],
  );
  return rows[0];
}

const adminRoute = (teamId: string) => `/_t/teams/${teamId}/admin`;
const memberRoute = (teamId: string) => `/_t/teams/${teamId}/member`;
const status = async (url: string, who: Person) => (await call('GET', url, who)).statusCode;

describe('GET /teams/:teamId/members (AC-HAPPY-6 list, Architecture A13)', () => {
  it('lists pending requests oldest first with fullName and skill, never an email, and reports adminCount', async () => {
    const admin = await person();
    const teamId = await teamWith([admin]);
    const newest = await person('Newest Nora');
    const oldest = await person('Oldest Olu');
    const middle = await person('Middle Mere');
    for (const [who, days] of [
      [newest, 1],
      [oldest, 3],
      [middle, 2],
    ] as const) {
      await addMember(teamId, who, 'PENDING');
      await database.pool.query(
        `UPDATE team_members SET requested_at = now() - make_interval(days => $3), skill_level = 'ADVANCED'
          WHERE team_id = $1 AND user_id = $2`,
        [teamId, who.id, days],
      );
    }
    const response = await list(teamId, admin, 'status=PENDING');
    expect(response.statusCode).toBe(200);
    const body = response.json<MembersBody>();
    expect(body.members.map((m) => m.fullName)).toEqual([
      'Oldest Olu',
      'Middle Mere',
      'Newest Nora',
    ]);
    expect(body.members[0]).toMatchObject({
      userId: oldest.id,
      role: 'MEMBER',
      status: 'PENDING',
      skillLevel: 'ADVANCED',
      approvedAt: null,
      bannedAt: null,
      banReason: null,
    });
    expect(body.members[0]?.requestedAt).toMatch(/Z$/);
    expect(body.adminCount).toBe(1);
    expect(body.nextCursor).toBeNull();
    expect(response.headers['cache-control']).toBe('no-store');
    // No email, in any field, for anyone.
    expect(response.body).not.toContain('@');
    expect(response.body).not.toContain(oldest.email);
  });

  it('lists approved admins first, then everyone by name regardless of letter case', async () => {
    const zed = await person('Zed Admin');
    const yolanda = await person('Yolanda Admin');
    const teamId = await teamWith([zed, yolanda]);
    for (const name of ['chris', 'Beth', 'amy']) {
      await addMember(teamId, await person(name), 'APPROVED');
    }
    await addMember(teamId, await person('Pending Pat'), 'PENDING');
    const body = (await list(teamId, zed, 'status=APPROVED')).json<MembersBody>();
    expect(body.members.map((m) => m.fullName)).toEqual([
      'Yolanda Admin',
      'Zed Admin',
      'amy',
      'Beth',
      'chris',
    ]);
    expect(body.members.map((m) => m.role)).toEqual([
      'TEAM_ADMIN',
      'TEAM_ADMIN',
      'MEMBER',
      'MEMBER',
      'MEMBER',
    ]);
    expect(body.adminCount).toBe(2);
    expect(body.members.every((m) => m.approvedAt !== null)).toBe(true);
  });

  it('lists banned people newest first with the ban reason, and only the banned list carries a reason', async () => {
    const admin = await person();
    const teamId = await teamWith([admin]);
    const early = await person('Early Ban');
    const late = await person('Late Ban');
    const approved = await person('Fine Fran');
    await addMember(teamId, approved, 'APPROVED');
    for (const [who, days, reason] of [
      [early, 5, 'rude to others'],
      [late, 1, null],
    ] as const) {
      await addMember(teamId, who, 'BANNED', 'MEMBER', admin);
      await database.pool.query(
        `UPDATE team_members SET banned_at = now() - make_interval(days => $3), ban_reason = $4
          WHERE team_id = $1 AND user_id = $2`,
        [teamId, who.id, days, reason],
      );
    }
    const banned = (await list(teamId, admin, 'status=BANNED')).json<MembersBody>();
    expect(banned.members.map((m) => m.fullName)).toEqual(['Late Ban', 'Early Ban']);
    expect(banned.members.map((m) => m.banReason)).toEqual([null, 'rude to others']);
    expect(banned.members.every((m) => m.bannedAt !== null && m.status === 'BANNED')).toBe(true);
    const approvedList = (await list(teamId, admin, 'status=APPROVED')).json<MembersBody>();
    expect(approvedList.members.every((m) => m.banReason === null)).toBe(true);
  });

  it('pages 50 per section with a stable cursor even when every request time is identical', async () => {
    const admin = await person();
    const teamId = await teamWith([admin]);
    for (let i = 0; i < 55; i += 1) await addMember(teamId, await person(), 'PENDING');
    await database.pool.query(
      `UPDATE team_members SET requested_at = '2026-10-01T00:00:00Z' WHERE team_id = $1 AND status = 'PENDING'`,
      [teamId],
    );
    const first = (await list(teamId, admin, 'status=PENDING')).json<MembersBody>();
    expect(first.members).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (
      await list(teamId, admin, `status=PENDING&after=${first.nextCursor ?? ''}`)
    ).json<MembersBody>();
    expect(second.members).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.members, ...second.members].map((m) => m.userId);
    expect(new Set(ids).size).toBe(55);
  });

  it('pages the approved section too (admins first across the page boundary)', async () => {
    const admin = await person('Aaa Admin');
    const teamId = await teamWith([admin]);
    for (let i = 0; i < 51; i += 1) await addMember(teamId, await person(), 'APPROVED');
    const first = (await list(teamId, admin, 'status=APPROVED')).json<MembersBody>();
    expect(first.members).toHaveLength(50);
    const second = (
      await list(teamId, admin, `status=APPROVED&after=${first.nextCursor ?? ''}`)
    ).json<MembersBody>();
    expect(second.members).toHaveLength(2);
    expect(new Set([...first.members, ...second.members].map((m) => m.userId)).size).toBe(52);
  });

  it('pages the banned section newest first', async () => {
    const admin = await person();
    const teamId = await teamWith([admin]);
    for (let i = 0; i < 52; i += 1)
      await addMember(teamId, await person(), 'BANNED', 'MEMBER', admin);
    const first = (await list(teamId, admin, 'status=BANNED')).json<MembersBody>();
    const second = (
      await list(teamId, admin, `status=BANNED&after=${first.nextCursor ?? ''}`)
    ).json<MembersBody>();
    expect([first.members.length, second.members.length]).toEqual([50, 2]);
    expect(new Set([...first.members, ...second.members].map((m) => m.userId)).size).toBe(52);
  });

  it('rejects a missing status, a cursor from another section and a malformed cursor with 422 for an admin', async () => {
    const admin = await person();
    const teamId = await teamWith([admin]);
    for (let i = 0; i < 51; i += 1) await addMember(teamId, await person(), 'PENDING');
    const pending = (await list(teamId, admin, 'status=PENDING')).json<MembersBody>();
    expect((await list(teamId, admin, '')).statusCode).toBe(422);
    expect((await list(teamId, admin, 'status=REJECTED')).statusCode).toBe(422);
    const foreign = await list(teamId, admin, `status=BANNED&after=${pending.nextCursor ?? ''}`);
    expect(foreign.statusCode).toBe(422);
    expect(errorCode(foreign)).toBe('validation_failed');
    expect((await list(teamId, admin, 'status=PENDING&after=not-a-cursor')).statusCode).toBe(422);
  });
});

describe('approve and reject (AC-HAPPY-6, AC-HAPPY-7, AC-HAPPY-8)', () => {
  it('approves a request: stamps approver and time, keeps the skill level, and the next MEMBER request succeeds', async () => {
    const admin = await person();
    const teamId = await teamWith([admin]);
    const asker = await person('Aroha Asker');
    await addMember(teamId, asker, 'PENDING');
    await database.pool.query(
      `UPDATE team_members SET skill_level = 'ADVANCED' WHERE team_id = $1 AND user_id = $2`,
      [teamId, asker.id],
    );
    expect(await status(memberRoute(teamId), asker)).toBe(403);

    const response = await act(teamId, asker.id, 'approve', admin);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ member: MemberBody }>().member).toMatchObject({
      userId: asker.id,
      fullName: 'Aroha Asker',
      role: 'MEMBER',
      status: 'APPROVED',
      skillLevel: 'ADVANCED',
      bannedAt: null,
      banReason: null,
    });
    expect(response.json<{ member: MemberBody }>().member.approvedAt).toMatch(/Z$/);
    expect(await row(teamId, asker.id)).toMatchObject({
      status: 'APPROVED',
      approved_by: admin.id,
      skill_level: 'ADVANCED',
    });
    // Next request, no re-login.
    expect(await status(memberRoute(teamId), asker)).toBe(200);
    expect(await status(adminRoute(teamId), asker)).toBe(403);
    const pending = (await list(teamId, admin, 'status=PENDING')).json<MembersBody>();
    expect(pending.members.map((m) => m.userId)).not.toContain(asker.id);
  });

  it('rejects a request; the person keeps no access, and a re-request returns the same row to PENDING', async () => {
    const admin = await person();
    const teamId = await teamWith([admin]);
    const asker = await person('Rua Rejected');
    await addMember(teamId, asker, 'PENDING');
    const response = await act(teamId, asker.id, 'reject', admin);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ member: MemberBody }>().member).toMatchObject({
      status: 'REJECTED',
      fullName: 'Rua Rejected',
    });
    expect(await status(memberRoute(teamId), asker)).toBe(403);

    // AC-HAPPY-8: the player asks again and the same row is reused with a fresh request.
    const again = await call('POST', `/teams/${teamId}/join-requests`, asker, {
      skillLevel: 'INTERMEDIATE',
    });
    expect(again.statusCode).toBe(201);
    const { rows } = await database.pool.query(
      `SELECT status, skill_level, approved_at FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [teamId, asker.id],
    );
    expect(rows).toEqual([{ status: 'PENDING', skill_level: 'INTERMEDIATE', approved_at: null }]);
    const pending = (await list(teamId, admin, 'status=PENDING')).json<MembersBody>();
    expect(pending.members.map((m) => m.userId)).toEqual([asker.id]);
  });

  it('answers 409 membership_state_conflict to an action that no longer matches the row, and changes nothing', async () => {
    const admin = await person();
    const teamId = await teamWith([admin]);
    const asker = await person();
    await addMember(teamId, asker, 'PENDING');
    expect((await act(teamId, asker.id, 'approve', admin)).statusCode).toBe(200);
    for (const action of ['approve', 'reject']) {
      const stale = await act(teamId, asker.id, action, admin);
      expect(stale.statusCode, action).toBe(409);
      expect(errorCode(stale)).toBe('membership_state_conflict');
    }
    expect((await row(teamId, asker.id))?.status).toBe('APPROVED');
    // A rejected request cannot be approved either.
    const rejected = await person();
    await addMember(teamId, rejected, 'REJECTED');
    const response = await act(teamId, rejected.id, 'approve', admin);
    expect(response.statusCode).toBe(409);
    expect((await row(teamId, rejected.id))?.status).toBe('REJECTED');
  });

  it('answers 404 not_found for a user with no row in this team, however the id came about, never touching another team', async () => {
    const admin = await person();
    const otherAdmin = await person();
    const teamId = await teamWith([admin]);
    const otherTeamId = await teamWith([otherAdmin]);
    const foreigner = await person();
    await addMember(otherTeamId, foreigner, 'PENDING');
    for (const action of ['approve', 'reject', 'promote', 'demote', 'ban']) {
      const crossTeam = await act(teamId, foreigner.id, action, admin);
      expect(crossTeam.statusCode, action).toBe(404);
      expect(errorCode(crossTeam)).toBe('not_found');
      const unknown = await act(teamId, '8f0c0b3e-6a53-4f3e-9a58-0e9d4e6a1d11', action, admin);
      expect(unknown.statusCode, action).toBe(404);
    }
    expect((await row(otherTeamId, foreigner.id))?.status).toBe('PENDING');
  });

  it('commits exactly one outcome when an approve and a reject of one request race (deterministic)', async () => {
    const adminA = await person();
    const adminB = await person();
    const teamId = await teamWith([adminA, adminB]);
    const asker = await person();
    await addMember(teamId, asker, 'PENDING');
    const results = await raceUnderTeamLock(database.pool, teamId, [
      () => act(teamId, asker.id, 'approve', adminA),
      () => act(teamId, asker.id, 'reject', adminB),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const winner = results.findIndex((r) => r.statusCode === 200) === 0 ? 'APPROVED' : 'REJECTED';
    expect((await row(teamId, asker.id))?.status).toBe(winner);
    expect(errorCode(results.find((r) => r.statusCode === 409) as LightMyRequestResponse)).toBe(
      'membership_state_conflict',
    );
  });
});

describe('promote and demote (AC-HAPPY-9, AC-HAPPY-10, AC-ERROR-7)', () => {
  it('promotes an approved member, whose very next TEAM_ADMIN request succeeds; promoting an admin or a non-member conflicts', async () => {
    const admin = await person();
    const teamId = await teamWith([admin]);
    const member = await person('Mere Member');
    await addMember(teamId, member, 'APPROVED');
    expect(await status(adminRoute(teamId), member)).toBe(403);
    const response = await act(teamId, member.id, 'promote', admin);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ member: MemberBody }>().member).toMatchObject({
      fullName: 'Mere Member',
      role: 'TEAM_ADMIN',
      status: 'APPROVED',
    });
    expect(await status(adminRoute(teamId), member)).toBe(200);
    expect(errorCode(await act(teamId, member.id, 'promote', admin))).toBe(
      'membership_state_conflict',
    );
    const pending = await person();
    await addMember(teamId, pending, 'PENDING');
    expect((await act(teamId, pending.id, 'promote', admin)).statusCode).toBe(409);
    expect((await row(teamId, pending.id))?.role).toBe('MEMBER');
  });

  it('demotes another admin to a plain member; all admins are equal, so the creator can be demoted too', async () => {
    const creator = await person('Creator');
    const second = await person('Second');
    const teamId = await teamWith([creator, second]);
    // The second admin demotes the first (the creator has no special standing).
    const response = await act(teamId, creator.id, 'demote', second);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ member: MemberBody }>().member).toMatchObject({
      role: 'MEMBER',
      status: 'APPROVED',
      fullName: 'Creator',
    });
    expect(await status(adminRoute(teamId), creator)).toBe(403);
    expect(await status(memberRoute(teamId), creator)).toBe(200);
    expect((await list(teamId, second, 'status=APPROVED')).json<MembersBody>().adminCount).toBe(1);
  });

  it('lets an admin demote themselves when another admin remains, and returns the member so the web can redirect', async () => {
    const one = await person('Self Demoter');
    const two = await person();
    const teamId = await teamWith([one, two]);
    const response = await act(teamId, one.id, 'demote', one);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ member: MemberBody }>().member).toMatchObject({
      userId: one.id,
      role: 'MEMBER',
      fullName: 'Self Demoter',
    });
    expect(await status(adminRoute(teamId), one)).toBe(403);
    expect(await status(memberRoute(teamId), one)).toBe(200);
  });

  it('refuses to demote the last admin, themselves included, with 409 last_team_admin', async () => {
    const only = await person();
    const teamId = await teamWith([only]);
    const response = await act(teamId, only.id, 'demote', only);
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('last_team_admin');
    expect((await row(teamId, only.id))?.role).toBe('TEAM_ADMIN');
  });

  it('refuses to demote someone who is not an admin with 409 membership_state_conflict', async () => {
    const admin = await person();
    const teamId = await teamWith([admin]);
    const member = await person();
    await addMember(teamId, member, 'APPROVED');
    const response = await act(teamId, member.id, 'demote', admin);
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('membership_state_conflict');
  });

  it('lets exactly one of two admins who demote each other at the same moment succeed (deterministic; A10: the loser is refused as a non-admin)', async () => {
    const a = await person();
    const b = await person();
    const teamId = await teamWith([a, b]);
    const results = await raceUnderTeamLock(database.pool, teamId, [
      () => act(teamId, b.id, 'demote', a),
      () => act(teamId, a.id, 'demote', b),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 403]);
    const { rows } = await database.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM team_members
        WHERE team_id = $1 AND role = 'TEAM_ADMIN' AND status = 'APPROVED'`,
      [teamId],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('keeps one admin when twenty admins demote themselves at once: 19 succeed and one gets 409 last_team_admin', async () => {
    const admins = await Promise.all(Array.from({ length: 20 }, () => person()));
    const teamId = await teamWith(admins);
    const results = await raceUnderTeamLock(
      database.pool,
      teamId,
      admins.map((who) => () => act(teamId, who.id, 'demote', who)),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((code) => code === 200)).toHaveLength(19);
    expect(codes.filter((code) => code === 409)).toHaveLength(1);
    expect(errorCode(results.find((r) => r.statusCode === 409) as LightMyRequestResponse)).toBe(
      'last_team_admin',
    );
    const { rows } = await database.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM team_members WHERE team_id = $1 AND role = 'TEAM_ADMIN'`,
      [teamId],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('re-checks the actor under the team lock: an admin demoted after the guard passed is refused and nothing changes (A10)', async () => {
    const stays = await person();
    const demoted = await person();
    const teamId = await teamWith([stays, demoted]);
    const member = await person();
    await addMember(teamId, member, 'APPROVED');
    // The guard (outside any transaction) passes: `demoted` is still an approved admin when the request starts.
    const [response] = await raceUnderTeamLock(
      database.pool,
      teamId,
      [() => act(teamId, member.id, 'ban', demoted)],
      {
        beforeRelease: async (lock) => {
          await lock.query(
            `UPDATE team_members SET role = 'MEMBER' WHERE team_id = $1 AND user_id = $2`,
            [teamId, demoted.id],
          );
        },
      },
    );
    if (response === undefined) throw new Error('no response');
    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe('forbidden');
    expect((await row(teamId, member.id))?.status).toBe('APPROVED');
  });
});

describe('ban (AC-HAPPY-11, AC-ERROR-6, AC-ASYNC-1 and 3)', () => {
  it('bans an approved member: stamps, trimmed reason, fullName in the answer, and the job is enqueued inside the transaction', async () => {
    const admin = await person();
    const teamId = await teamWith([admin]);
    const member = await person('Bad Behaviour');
    await addMember(teamId, member, 'APPROVED');
    enqueued.length = 0;
    const response = await act(teamId, member.id, 'ban', admin, { reason: '  shouted at staff  ' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ member: MemberBody }>().member).toMatchObject({
      userId: member.id,
      fullName: 'Bad Behaviour',
      status: 'BANNED',
      banReason: 'shouted at staff',
    });
    expect(await row(teamId, member.id)).toMatchObject({
      status: 'BANNED',
      banned_by: admin.id,
      ban_reason: 'shouted at staff',
    });
    const { rows } = await database.pool.query<{ id: string }>(
      `SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [teamId, member.id],
    );
    expect(enqueued).toHaveLength(1);
    const job = enqueued[0] as Enqueued;
    expect(job.queue).toBe('member-banned');
    expect(Object.keys(job.data).sort()).toEqual(
      ['bannedAt', 'bannedBy', 'membershipId', 'teamId', 'userId'].sort(),
    );
    expect(job.data).toMatchObject({
      teamId,
      userId: member.id,
      membershipId: rows[0]?.id,
      bannedBy: admin.id,
    });
    expect(job.data.bannedAt).toMatch(/Z$/);
    expect(job.options.singletonKey).toBe(`member-banned:${rows[0]?.id ?? ''}`);
    expect(job.options.trx).toBeDefined();
    // Neither the name nor the reason travels in the job.
    expect(JSON.stringify(job.data)).not.toContain('Bad Behaviour');
    expect(JSON.stringify(job.data)).not.toContain('shouted');
  });

  it('accepts a ban with no body or a blank reason, and rejects an over-long reason or an unknown field with 422', async () => {
    const admin = await person();
    const teamId = await teamWith([admin]);
    const first = await person();
    const second = await person();
    const third = await person();
    for (const who of [first, second, third]) await addMember(teamId, who, 'APPROVED');
    expect((await act(teamId, first.id, 'ban', admin)).statusCode).toBe(200);
    expect((await row(teamId, first.id))?.ban_reason).toBeNull();
    expect((await act(teamId, second.id, 'ban', admin, { reason: '   ' })).statusCode).toBe(200);
    expect((await row(teamId, second.id))?.ban_reason).toBeNull();
    const tooLong = await act(teamId, third.id, 'ban', admin, { reason: 'x'.repeat(501) });
    expect(tooLong.statusCode).toBe(422);
    expect(errorCode(tooLong)).toBe('validation_failed');
    expect(
      (await act(teamId, third.id, 'ban', admin, { reason: 'ok', status: 'X' })).statusCode,
    ).toBe(422);
    expect((await row(teamId, third.id))?.status).toBe('APPROVED');
    expect(
      (await act(teamId, third.id, 'ban', admin, { reason: 'x'.repeat(500) })).statusCode,
    ).toBe(200);
  });

  it('cannot ban an admin (another admin or oneself) until they are demoted, then it succeeds; no job for the refusal', async () => {
    const one = await person('Admin One');
    const two = await person('Admin Two');
    const teamId = await teamWith([one, two]);
    enqueued.length = 0;
    const other = await act(teamId, two.id, 'ban', one);
    expect(other.statusCode).toBe(409);
    expect(errorCode(other)).toBe('team_admin_cannot_be_banned');
    const self = await act(teamId, one.id, 'ban', one);
    expect(self.statusCode).toBe(409);
    expect(errorCode(self)).toBe('team_admin_cannot_be_banned');
    expect((await row(teamId, two.id))?.status).toBe('APPROVED');
    expect(enqueued).toHaveLength(0);

    expect((await act(teamId, two.id, 'demote', one)).statusCode).toBe(200);
    expect((await act(teamId, two.id, 'ban', one)).statusCode).toBe(200);
    expect((await row(teamId, two.id))?.status).toBe('BANNED');
    expect(enqueued).toHaveLength(1);
  });

  it('refuses to ban someone who is pending, rejected or already banned with 409 and enqueues nothing', async () => {
    const admin = await person();
    const teamId = await teamWith([admin]);
    enqueued.length = 0;
    for (const state of ['PENDING', 'REJECTED', 'BANNED'] as const) {
      const who = await person();
      await addMember(teamId, who, state, 'MEMBER', admin);
      const response = await act(teamId, who.id, 'ban', admin);
      expect(response.statusCode, state).toBe(409);
      expect(errorCode(response)).toBe('membership_state_conflict');
      expect((await row(teamId, who.id))?.status).toBe(state);
    }
    expect(enqueued).toHaveLength(0);
  });

  it('revokes access the moment the ban commits, with no worker running (AC-ASYNC-3), and the account stays valid', async () => {
    const admin = await person();
    const teamId = await teamWith([admin], 'PUBLIC');
    const member = await person();
    await addMember(teamId, member, 'APPROVED');
    expect(await status(memberRoute(teamId), member)).toBe(200);
    expect((await act(teamId, member.id, 'ban', admin, { reason: 'no' })).statusCode).toBe(200);

    expect(await status(memberRoute(teamId), member)).toBe(403);
    expect(await status(adminRoute(teamId), member)).toBe(403);
    expect((await call('GET', `/teams/${teamId}/members?status=BANNED`, member)).statusCode).toBe(
      403,
    );
    // The account is untouched: sign-in state and /auth/me stay valid; the team is gone from My teams.
    expect((await call('GET', '/auth/me', member)).statusCode).toBe(200);
    const mine = await call('GET', '/teams/mine', member);
    expect(mine.json<{ teams: unknown[] }>().teams).toEqual([]);
    // The public team page shows the banned state and joining is refused.
    const detail = (await call('GET', `/teams/${teamId}`, member)).json<{ myStatus: string }>();
    expect(detail.myStatus).toBe('BANNED');
    const join = await call('POST', `/teams/${teamId}/join-requests`, member, {
      skillLevel: 'BEGINNER',
    });
    expect(join.statusCode).toBe(403);
    expect(errorCode(join)).toBe('banned_from_team');
    // The registration gate is the same row: it refuses without any job having run.
    await expect(
      h.db.transaction().execute((trx) => assertApprovedMember(trx, teamId, member.id)),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('assertApprovedMember (AC-ASYNC-3)', () => {
  it('returns the membership for an approved member and throws forbidden for anyone else', async () => {
    const admin = await person();
    const teamId = await teamWith([admin]);
    const member = await person();
    await addMember(teamId, member, 'APPROVED');
    const gate = (userId: string) =>
      h.db.transaction().execute((trx) => assertApprovedMember(trx, teamId, userId));
    await expect(gate(member.id)).resolves.toMatchObject({
      role: 'MEMBER',
      skillLevel: 'BEGINNER',
      membershipId: expect.any(String) as string,
    });
    await expect(gate(admin.id)).resolves.toMatchObject({ role: 'TEAM_ADMIN' });
    for (const state of ['PENDING', 'REJECTED', 'BANNED'] as const) {
      const who = await person();
      await addMember(teamId, who, state, 'MEMBER', admin);
      await expect(gate(who.id), state).rejects.toMatchObject({ code: 'forbidden' });
    }
    const stranger = await person();
    await expect(gate(stranger.id)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses to run outside a transaction, because FOR SHARE only means something inside one', async () => {
    await expect(assertApprovedMember(h.db as never, 'a', 'b')).rejects.toThrow(/transaction/);
  });
});

describe('guards answer before validation, for every kind of caller (AC-ERROR-8)', () => {
  it('answers 401 to anonymous callers and an identical 403 to everyone who is not an admin of this team, for existing and unknown teams alike', async () => {
    const admin = await person();
    const teamId = await teamWith([admin]);
    const target = await person();
    await addMember(teamId, target, 'APPROVED');
    const pending = await person();
    await addMember(teamId, pending, 'PENDING');
    const rejected = await person();
    await addMember(teamId, rejected, 'REJECTED');
    const banned = await person();
    await addMember(teamId, banned, 'BANNED', 'MEMBER', admin);
    const member = await person();
    await addMember(teamId, member, 'APPROVED');
    const stranger = await person();
    const globalAdmin = await person();
    await database.pool.query(`UPDATE users SET role = 'GLOBAL_ADMIN' WHERE id = $1`, [
      globalAdmin.id,
    ]);
    const otherAdmin = await person();
    await teamWith([otherAdmin]);

    const unknownTeam = '5c8a9d1e-3b52-4a43-8f4d-7b0c2f1e9a66';
    // Invalid bodies on purpose: the guard must answer first, so a 422 would leak the body shape.
    const invalid = { reason: 'x'.repeat(5000), junk: true };
    const routes = (id: string) =>
      [
        ['GET', `/teams/${id}/members?status=NOPE`, undefined],
        ['POST', `/teams/${id}/members/${target.id}/approve`, undefined],
        ['POST', `/teams/${id}/members/${target.id}/reject`, undefined],
        ['POST', `/teams/${id}/members/${target.id}/promote`, undefined],
        ['POST', `/teams/${id}/members/${target.id}/demote`, undefined],
        ['POST', `/teams/${id}/members/${target.id}/ban`, invalid],
        ['GET', `/teams/${id}/invite-code`, undefined],
        ['POST', `/teams/${id}/invite-code/regenerate`, undefined],
      ] as const;

    for (const [method, url, payload] of routes(teamId)) {
      const anonymous = await call(method, url, null, payload);
      expect(anonymous.statusCode, url).toBe(401);
      expect(errorCode(anonymous)).toBe('unauthenticated');
    }
    for (const caller of [pending, rejected, banned, member, stranger, globalAdmin, otherAdmin]) {
      for (const [index, [method, url, payload]] of routes(teamId).entries()) {
        const existing = await call(method, url, caller, payload);
        expect(existing.statusCode, `${index} ${url}`).toBe(403);
        expect(errorCode(existing)).toBe('forbidden');
        const counterpart = routes(unknownTeam)[index];
        if (counterpart === undefined) throw new Error('route table mismatch');
        const [, unknownUrl, unknownPayload] = counterpart;
        const missing = await call(method, unknownUrl, caller, unknownPayload);
        expect(missing.statusCode).toBe(403);
        expect(missing.json()).toEqual(existing.json());
      }
    }
    // Nothing changed.
    expect((await row(teamId, target.id))?.status).toBe('APPROVED');
    expect((await row(teamId, target.id))?.role).toBe('MEMBER');
  });

  it('lets a real admin through to validation: invalid input is 422 only after the guard says yes', async () => {
    const admin = await person();
    const teamId = await teamWith([admin]);
    expect((await list(teamId, admin, 'status=NOPE')).statusCode).toBe(422);
    expect((await act(teamId, 'not-a-uuid', 'approve', admin)).statusCode).toBe(422);
  });
});

describe('moderation drives the existing guards on the next request (AC-INTEGRATION-2)', () => {
  it('approve, promote, demote and ban change requireTeamRole answers 403/200 each time with no re-login, while /auth/me stays valid', async () => {
    const admin = await person();
    const teamId = await teamWith([admin]);
    const player = await person();
    const join = await call('POST', `/teams/${teamId}/join-requests`, player, {
      skillLevel: 'INTERMEDIATE',
    });
    expect(join.statusCode).toBe(201);
    const answers = async () => ({
      member: await status(memberRoute(teamId), player),
      admin: await status(adminRoute(teamId), player),
      me: await status('/auth/me', player),
    });
    expect(await answers()).toEqual({ member: 403, admin: 403, me: 200 });
    expect((await act(teamId, player.id, 'approve', admin)).statusCode).toBe(200);
    expect(await answers()).toEqual({ member: 200, admin: 403, me: 200 });
    expect((await act(teamId, player.id, 'promote', admin)).statusCode).toBe(200);
    expect(await answers()).toEqual({ member: 200, admin: 200, me: 200 });
    expect((await act(teamId, player.id, 'demote', admin)).statusCode).toBe(200);
    expect(await answers()).toEqual({ member: 200, admin: 403, me: 200 });
    expect((await act(teamId, player.id, 'ban', admin)).statusCode).toBe(200);
    expect(await answers()).toEqual({ member: 403, admin: 403, me: 200 });
  });
});
