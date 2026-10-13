/**
 * Route guards over real sessions and real team_members rows (AC-HAPPY-8, AC-HAPPY-9, AC-ERROR-11,
 * AC-ERROR-12, AC-HAPPY-10): the global role and team role are read from the database on every request.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  authenticated,
  optionalSession,
  requireGlobalRole,
  requireTeamRole,
} from '../../src/lib/auth/policy.ts';
import { setUserRole } from '../../src/modules/auth/repo.ts';
import {
  bearer,
  buildAuthTestApp,
  createPasswordUser,
  sessionFor,
  type AuthTestApp,
} from '../helpers/auth-app.ts';
import { insertAuthSession, insertTeam, insertTeamMember } from '../helpers/factories.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

const fixtures: FastifyPluginAsync = (app) => {
  app.get('/_t/authenticated', { config: { policy: authenticated() } }, (request) => ({
    userId: request.auth?.userId,
    role: request.auth?.role,
  }));
  app.get('/_t/optional', { config: { policy: optionalSession() } }, (request) => ({
    userId: request.auth?.userId ?? null,
  }));
  app.get('/_t/admin', { config: { policy: requireGlobalRole('GLOBAL_ADMIN') } }, () => ({
    ok: true,
  }));
  app.get('/_t/teams/:teamId/admin', { config: { policy: requireTeamRole('TEAM_ADMIN') } }, () => ({
    ok: true,
  }));
  app.get('/_t/teams/:teamId/member', { config: { policy: requireTeamRole('MEMBER') } }, () => ({
    ok: true,
  }));
  app.get(
    '/_t/teams/:teamId/admin-or-global',
    { config: { policy: requireTeamRole('TEAM_ADMIN', { allowGlobalAdmin: true }) } },
    () => ({ ok: true }),
  );
  // Mutating routes with a validated body: the guard must answer before validation can (AC-ERROR-11).
  const body = { body: z.strictObject({ name: z.string().min(1) }) };
  app.post(
    '/_t/admin-body',
    { config: { policy: requireGlobalRole('GLOBAL_ADMIN') }, schema: body },
    () => ({ ok: true }),
  );
  app.post(
    '/_t/teams/:teamId/admin-body',
    { config: { policy: requireTeamRole('TEAM_ADMIN') }, schema: body },
    () => ({ ok: true }),
  );
  return Promise.resolve();
};

let database: TestDatabase;
let h: AuthTestApp;
beforeAll(async () => {
  database = await createTestDatabase();
  h = await buildAuthTestApp(database.pool, { extraPlugins: [fixtures] });
});
afterAll(async () => {
  await h.close();
  await database.close();
});

const get = (url: string, token?: string) =>
  h.app.inject({ method: 'GET', url, ...(token === undefined ? {} : { headers: bearer(token) }) });

describe('global role guard', () => {
  it('lets GLOBAL_ADMIN through, refuses PLAYER with 403 and reads the role fresh on the very next request (AC-HAPPY-8)', async () => {
    const player = await createPasswordUser(h, { email: 'guard.player@example.com' });
    const admin = await createPasswordUser(h, {
      email: 'guard.admin@example.com',
      role: 'GLOBAL_ADMIN',
    });
    const playerToken = await sessionFor(h, player);
    const adminToken = await sessionFor(h, admin);

    const denied = await get('/_t/admin', playerToken);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect((await get('/_t/admin', adminToken)).statusCode).toBe(200);

    await h.pool.query(`UPDATE users SET role = 'PLAYER' WHERE id = $1`, [admin.id]);
    expect((await get('/_t/admin', adminToken)).statusCode).toBe(403);
  });

  it('answers 401 unauthenticated without a token and session_expired for revoked and expired sessions (AC-ERROR-11)', async () => {
    expect((await get('/_t/admin')).json()).toMatchObject({ error: { code: 'unauthenticated' } });
    expect((await get('/_t/authenticated', 'unknown-token-value')).json()).toMatchObject({
      error: { code: 'session_expired' },
    });

    const user = await createPasswordUser(h, { email: 'guard.dead@example.com' });
    const revoked = await insertAuthSession(h.pool, user.id, { createdAt: h.clock.now() });
    await h.pool.query(
      `UPDATE auth_sessions SET revoked_at = created_at, revoked_reason = 'logout' WHERE id = $1`,
      [revoked.id],
    );
    expect((await get('/_t/authenticated', revoked.token)).json()).toMatchObject({
      error: { code: 'session_expired' },
    });
    const expired = await insertAuthSession(h.pool, user.id, {
      createdAt: new Date(h.clock.now().getTime() - 8 * 86_400_000),
    });
    expect((await get('/_t/authenticated', expired.token)).json()).toMatchObject({
      error: { code: 'session_expired' },
    });
  });

  it('optionalSession never fails: a dead or absent token just means no identity', async () => {
    const user = await createPasswordUser(h, { email: 'guard.optional@example.com' });
    const token = await sessionFor(h, user);
    expect((await get('/_t/optional', token)).json()).toEqual({ userId: user.id });
    expect((await get('/_t/optional', 'garbage')).json()).toEqual({ userId: null });
    expect((await get('/_t/optional')).json()).toEqual({ userId: null });
  });
});

describe('team role guard', () => {
  it('is scoped to the team: admin of A passes A, MEMBER of B and strangers fail (AC-HAPPY-9)', async () => {
    const user = await createPasswordUser(h, { email: 'team.scoped@example.com' });
    const [teamA, teamB, teamC] = [
      await insertTeam(h.pool),
      await insertTeam(h.pool),
      await insertTeam(h.pool),
    ];
    await insertTeamMember(h.pool, {
      teamId: teamA,
      userId: user.id,
      role: 'TEAM_ADMIN',
      status: 'APPROVED',
    });
    await insertTeamMember(h.pool, {
      teamId: teamB,
      userId: user.id,
      role: 'MEMBER',
      status: 'APPROVED',
    });
    const token = await sessionFor(h, user);
    expect((await get(`/_t/teams/${teamA}/admin`, token)).statusCode).toBe(200);
    expect((await get(`/_t/teams/${teamB}/admin`, token)).statusCode).toBe(403);
    expect((await get(`/_t/teams/${teamC}/admin`, token)).statusCode).toBe(403);
    // TEAM_ADMIN satisfies a MEMBER route; MEMBER of B passes the MEMBER route; C still fails.
    expect((await get(`/_t/teams/${teamA}/member`, token)).statusCode).toBe(200);
    expect((await get(`/_t/teams/${teamB}/member`, token)).statusCode).toBe(200);
    expect((await get(`/_t/teams/${teamC}/member`, token)).statusCode).toBe(403);
    // A malformed team id can never match a membership.
    expect((await get('/_t/teams/not-a-uuid/admin', token)).statusCode).toBe(403);
  });

  it('does not let GLOBAL_ADMIN through unless the route opts in with allowGlobalAdmin', async () => {
    const admin = await createPasswordUser(h, {
      email: 'team.global@example.com',
      role: 'GLOBAL_ADMIN',
    });
    const team = await insertTeam(h.pool);
    const token = await sessionFor(h, admin);
    expect((await get(`/_t/teams/${team}/admin`, token)).statusCode).toBe(403);
    expect((await get(`/_t/teams/${team}/member`, token)).statusCode).toBe(403);
    expect((await get(`/_t/teams/${team}/admin-or-global`, token)).statusCode).toBe(200);
    expect((await get(`/_t/teams/${randomUUID()}/admin-or-global`, token)).statusCode).toBe(200);
  });

  it('derives team access only from an APPROVED membership and applies status changes on the next request (AC-ERROR-12)', async () => {
    const user = await createPasswordUser(h, { email: 'team.status@example.com' });
    const team = await insertTeam(h.pool);
    const token = await sessionFor(h, user);
    expect((await get(`/_t/teams/${team}/member`, token)).statusCode).toBe(403); // no row

    // team-management D-40/D-42: an admin is always APPROVED and statuses only move along the state
    // machine (PENDING -> REJECTED -> PENDING -> APPROVED -> BANNED), so the row is a MEMBER until approved.
    const memberId = await insertTeamMember(h.pool, {
      teamId: team,
      userId: user.id,
      role: 'MEMBER',
      status: 'PENDING',
    });
    const stampsFor = (status: string): string =>
      status === 'APPROVED'
        ? `approved_at = now(), approved_by = user_id`
        : status === 'BANNED'
          ? `banned_at = now(), banned_by = user_id`
          : `approved_at = NULL, approved_by = NULL`;
    const moveTo = (status: string): Promise<unknown> =>
      h.pool.query(`UPDATE team_members SET status = $2, ${stampsFor(status)} WHERE id = $1`, [
        memberId,
        status,
      ]);
    const expectNoAccess = async (label: string): Promise<void> => {
      expect((await get(`/_t/teams/${team}/member`, token)).statusCode, label).toBe(403);
      expect((await get(`/_t/teams/${team}/admin`, token)).statusCode, label).toBe(403);
    };
    await expectNoAccess('PENDING');
    await moveTo('REJECTED');
    await expectNoAccess('REJECTED');
    await moveTo('PENDING');
    await expectNoAccess('PENDING again');
    await moveTo('APPROVED');
    expect((await get(`/_t/teams/${team}/member`, token)).statusCode).toBe(200);
    expect((await get(`/_t/teams/${team}/admin`, token)).statusCode).toBe(403);
    // Promotion makes the approved member an admin on the very next request.
    await h.pool.query(`UPDATE team_members SET role = 'TEAM_ADMIN' WHERE id = $1`, [memberId]);
    expect((await get(`/_t/teams/${team}/admin`, token)).statusCode).toBe(200);
    // A team keeps another admin, and an admin is demoted before a ban (D-40, D-43).
    await insertTeamMember(h.pool, {
      teamId: team,
      userId: (await createPasswordUser(h, { email: 'team.status.other@example.com' })).id,
      role: 'TEAM_ADMIN',
    });
    await h.pool.query(`UPDATE team_members SET role = 'MEMBER' WHERE id = $1`, [memberId]);
    await moveTo('BANNED');
    expect((await get(`/_t/teams/${team}/member`, token)).statusCode).toBe(403);
    expect((await get(`/_t/teams/${team}/admin`, token)).statusCode).toBe(403);
  });
});

describe('guards answer before body validation (AC-ERROR-11: no 422 before 403)', () => {
  const post = (url: string, payload: unknown, token?: string) =>
    h.app.inject({
      method: 'POST',
      url,
      payload: payload as object,
      ...(token === undefined ? {} : { headers: bearer(token) }),
    });

  it('answers 403 forbidden, not 422, to a valid session without the global role and an invalid body', async () => {
    const player = await createPasswordUser(h, { email: 'body.player@example.com' });
    const token = await sessionFor(h, player);
    for (const invalid of [{}, { name: '' }, { name: 'x', role: 'GLOBAL_ADMIN' }]) {
      const response = await post('/_t/admin-body', invalid, token);
      expect(response.statusCode, JSON.stringify(invalid)).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'forbidden' } });
      expect(JSON.stringify(response.json())).not.toContain('fieldErrors');
    }
  });

  it('still validates the body for a caller who passes the guard (422), and answers 401 before 422 without a session', async () => {
    const admin = await createPasswordUser(h, {
      email: 'body.admin@example.com',
      role: 'GLOBAL_ADMIN',
    });
    const token = await sessionFor(h, admin);
    expect((await post('/_t/admin-body', {}, token)).statusCode).toBe(422);
    expect((await post('/_t/admin-body', { name: 'ok' }, token)).statusCode).toBe(200);
    const anonymous = await post('/_t/admin-body', {});
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  });

  it('answers 403, not 422, to a non-member on a team route with an invalid body, and 422 to the team admin', async () => {
    const user = await createPasswordUser(h, { email: 'body.team@example.com' });
    const [mine, theirs] = [await insertTeam(h.pool), await insertTeam(h.pool)];
    await insertTeamMember(h.pool, { teamId: mine, userId: user.id, role: 'TEAM_ADMIN' });
    const token = await sessionFor(h, user);
    const denied = await post(`/_t/teams/${theirs}/admin-body`, {}, token);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect((await post('/_t/teams/not-a-uuid/admin-body', {}, token)).statusCode).toBe(403);
    expect((await post(`/_t/teams/${mine}/admin-body`, {}, token)).statusCode).toBe(422);
    expect((await post(`/_t/teams/${mine}/admin-body`, { name: 'ok' }, token)).statusCode).toBe(
      200,
    );
  });
});

describe('operator role assignment (AC-HAPPY-10)', () => {
  it('sets GLOBAL_ADMIN by normalised email, returns id and role, and the existing session sees it next request', async () => {
    const user = await createPasswordUser(h, { email: 'operator.promote@example.com' });
    const token = await sessionFor(h, user);
    expect((await get('/_t/admin', token)).statusCode).toBe(403);
    const result = await setUserRole(h.db, 'Operator.Promote@Example.com', 'GLOBAL_ADMIN');
    expect(result).toEqual({ id: user.id, role: 'GLOBAL_ADMIN' });
    expect((await get('/_t/admin', token)).statusCode).toBe(200);
  });

  it('returns null for an unknown email and changes nothing', async () => {
    const before = await h.pool.query(`SELECT count(*) FROM users WHERE role = 'GLOBAL_ADMIN'`);
    expect(await setUserRole(h.db, 'nobody.at.all@example.com', 'GLOBAL_ADMIN')).toBeNull();
    const after = await h.pool.query(`SELECT count(*) FROM users WHERE role = 'GLOBAL_ADMIN'`);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('keeps TEAM_ADMIN out of users.role even if an argument check were bypassed (database CHECK)', async () => {
    const user = await createPasswordUser(h, { email: 'operator.bypass@example.com' });
    await expect(
      setUserRole(h.db, user.email, 'TEAM_ADMIN' as unknown as 'PLAYER'),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
