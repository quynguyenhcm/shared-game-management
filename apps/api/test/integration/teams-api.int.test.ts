/**
 * Teams API, Phase 2: create (with idempotency), Find, My teams, team detail, invite lookup, join requests and
 * the two invite-code admin routes, over a real cloned Postgres through `app.inject` (AC-HAPPY-1 to 5 and 12,
 * AC-ERROR-1 to 5, 10 and 15, AC-VERIFY-1, 3 and 4). The two deterministic races (join versus regenerate,
 * create versus create) hold a real row lock in the test and wait for the blocked backend in pg_stat_activity;
 * no sleep is the proof.
 */
import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateInviteCode } from '../../src/modules/teams/invite-code.ts';
import { buildFindQuery } from '../../src/modules/teams/repo.ts';
import { bearer, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import { insertAuthSession, insertTeamMember, insertUser } from '../helpers/factories.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';
import { waitFor } from '../helpers/wait-for.ts';

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

interface Player {
  readonly id: string;
  readonly token: string;
}
interface TeamPayload {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  memberCount?: number;
}
interface CreateBody {
  team: TeamPayload;
  membership: { status: string; role: string; skillLevel: string };
}
interface FindBody {
  teams: { id: string; name: string; memberCount: number; myStatus: string | null }[];
  nextCursor: string | null;
  prevCursor: string | null;
}
interface ErrorBody {
  error: { code: string; message: string; fieldErrors?: Record<string, string[]> };
}

async function player(): Promise<Player> {
  const id = await insertUser(h.pool);
  const { token } = await insertAuthSession(h.pool, id, { createdAt: h.clock.now() });
  return { id, token };
}

const call = (
  method: 'GET' | 'POST',
  url: string,
  token: string | null,
  payload?: unknown,
): Promise<LightMyRequestResponse> =>
  h.app.inject({
    method,
    url,
    ...(token === null ? {} : { headers: bearer(token) }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Rosedale Badminton',
    description: 'Wednesday nights, all levels welcome',
    visibility: 'PUBLIC',
    skillLevel: 'INTERMEDIATE',
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

/** Creates a team through the API and returns its id (the creator is the approved admin). */
async function createTeam(owner: Player, overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await call('POST', '/teams', owner.token, createBody(overrides));
  expect(response.statusCode).toBe(201);
  return response.json<CreateBody>().team.id;
}

async function inviteCodeOf(teamId: string): Promise<string> {
  const { rows } = await database.pool.query<{ invite_code: string }>(
    `SELECT invite_code FROM teams WHERE id = $1`,
    [teamId],
  );
  return rows[0]?.invite_code ?? '';
}

async function membershipRows(teamId: string, userId: string) {
  const { rows } = await database.pool.query<{
    role: string;
    status: string;
    skill_level: string;
    requested_at: Date;
    approved_at: Date | null;
    approved_by: string | null;
    banned_at: Date | null;
  }>(
    `SELECT role, status, skill_level, requested_at, approved_at, approved_by, banned_at
       FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId],
  );
  return rows;
}

/** Backends currently waiting on a lock in this database (the proof that a request is blocked). */
async function lockWaiters(): Promise<number> {
  const { rows } = await database.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  );
  return rows[0]?.n ?? 0;
}

async function waitForBlockedBackend(label: string): Promise<void> {
  await waitFor(async () => ((await lockWaiters()) > 0 ? true : undefined), { label });
}

/** Resolves `true` once `promise` settles, so a test can assert it has not settled yet. */
function trackSettled<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false;
  const tracked = promise.finally(() => {
    done = true;
  });
  return { promise: tracked, settled: () => done };
}

describe('POST /teams (AC-HAPPY-1, AC-HAPPY-2, AC-ERROR-1)', () => {
  it('creates a public team and makes the creator its approved admin with the chosen skill level', async () => {
    const owner = await player();
    const response = await call('POST', '/teams', owner.token, createBody());
    expect(response.statusCode).toBe(201);
    const body = response.json<CreateBody>();
    expect(body.team).toMatchObject({
      name: 'Rosedale Badminton',
      description: 'Wednesday nights, all levels welcome',
      visibility: 'PUBLIC',
    });
    expect(body.membership).toEqual({
      status: 'APPROVED',
      role: 'TEAM_ADMIN',
      skillLevel: 'INTERMEDIATE',
    });
    expect(response.body).not.toContain('invite');

    const [member] = await membershipRows(body.team.id, owner.id);
    expect(member).toMatchObject({
      role: 'TEAM_ADMIN',
      status: 'APPROVED',
      skill_level: 'INTERMEDIATE',
    });
    expect(member?.approved_at).toBeInstanceOf(Date);
    expect(member?.approved_by).toBe(owner.id);
    const { rows } = await database.pool.query<{ created_by: string; invite_code: string }>(
      `SELECT created_by, invite_code FROM teams WHERE id = $1`,
      [body.team.id],
    );
    expect(rows[0]?.created_by).toBe(owner.id);
    expect(rows[0]?.invite_code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('answers 422 naming each invalid field, creates nothing and rejects server-owned fields', async () => {
    const owner = await player();
    const before = await database.pool.query(`SELECT count(*)::int AS n FROM teams`);
    const cases: [Record<string, unknown>, string, string][] = [
      [{ name: '   ' }, 'name', 'Enter a team name.'],
      [{ name: 'x'.repeat(101) }, 'name', 'Use 100 characters or fewer.'],
      [{ description: 'y'.repeat(1001) }, 'description', 'Use 1000 characters or fewer.'],
      [{ visibility: undefined }, 'visibility', 'Choose who can find your team.'],
      [{ skillLevel: undefined }, 'skillLevel', 'Select your skill level to continue.'],
    ];
    for (const [overrides, field, message] of cases) {
      const response = await call('POST', '/teams', owner.token, createBody(overrides));
      expect(response.statusCode, field).toBe(422);
      const error = response.json<ErrorBody>().error;
      expect(error.code).toBe('validation_failed');
      expect(error.fieldErrors?.[field], field).toContain(message);
    }
    for (const extra of [{ inviteCode: 'x' }, { createdBy: owner.id }, { role: 'TEAM_ADMIN' }]) {
      const response = await call('POST', '/teams', owner.token, createBody(extra));
      expect(response.statusCode).toBe(422);
    }
    const after = await database.pool.query(`SELECT count(*)::int AS n FROM teams`);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('requires a session', async () => {
    const response = await call('POST', '/teams', null, createBody());
    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('unauthenticated');
  });
});

describe('create idempotency (AC-ERROR-15)', () => {
  it('replays the same key by the same user as 200 with the existing team and no second row; another user is an ordinary create', async () => {
    const owner = await player();
    const other = await player();
    const key = randomUUID();
    const first = await call(
      'POST',
      '/teams',
      owner.token,
      createBody({ name: 'Replay Club', idempotencyKey: key }),
    );
    expect(first.statusCode).toBe(201);
    const replay = await call(
      'POST',
      '/teams',
      owner.token,
      createBody({ name: 'Replay Club', idempotencyKey: key }),
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json<CreateBody>()).toEqual(first.json<CreateBody>());

    const foreign = await call(
      'POST',
      '/teams',
      other.token,
      createBody({ name: 'Replay Club', idempotencyKey: key }),
    );
    expect(foreign.statusCode).toBe(201);
    expect(foreign.json<CreateBody>().team.id).not.toBe(first.json<CreateBody>().team.id);

    const { rows } = await database.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM teams WHERE name = 'Replay Club'`,
    );
    expect(rows[0]?.n).toBe(2);
  });

  it('rejects a missing or malformed key with 422', async () => {
    const owner = await player();
    for (const idempotencyKey of [
      undefined,
      'not-a-uuid',
      '3f1c2d4e-5a6b-1c7d-8e9f-0a1b2c3d4e5f',
    ]) {
      const response = await call('POST', '/teams', owner.token, createBody({ idempotencyKey }));
      expect(response.statusCode, String(idempotencyKey)).toBe(422);
      expect(response.json<ErrorBody>().error.fieldErrors?.idempotencyKey).toBeDefined();
    }
  });

  it('a concurrent double submit with one key yields exactly one team (deterministic: the first create is held mid-transaction)', async () => {
    const owner = await player();
    const key = randomUUID();
    const holder = await database.pool.connect();
    try {
      await holder.query('BEGIN');
      const { rows } = await holder.query<{ id: string }>(
        `INSERT INTO teams (name, visibility, invite_code, created_by, create_idempotency_key)
         VALUES ('Held Club', 'PUBLIC', $1, $2, $3) RETURNING id`,
        [generateInviteCode(), owner.id, key],
      );
      const heldId = rows[0]?.id ?? '';
      await holder.query(
        `INSERT INTO team_members (team_id, user_id, role, status, skill_level, approved_at, approved_by)
         VALUES ($1, $2, 'TEAM_ADMIN', 'APPROVED', 'INTERMEDIATE', now(), $2)`,
        [heldId, owner.id],
      );
      expect(await lockWaiters()).toBe(0);
      const second = trackSettled(
        call('POST', '/teams', owner.token, createBody({ name: 'Held Club', idempotencyKey: key })),
      );
      await waitForBlockedBackend('the second create to wait on the held unique key');
      expect(second.settled()).toBe(false);
      await holder.query('COMMIT');
      const response = await second.promise;
      expect(response.statusCode).toBe(200);
      expect(response.json<CreateBody>().team.id).toBe(heldId);
    } finally {
      holder.release();
    }
    const { rows } = await database.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM teams WHERE created_by = $1`,
      [owner.id],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('five simultaneous submits with one key commit exactly one team: one 201 and four 200', async () => {
    const owner = await player();
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        call(
          'POST',
          '/teams',
          owner.token,
          createBody({ name: 'Burst Club', idempotencyKey: key }),
        ),
      ),
    );
    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(responses.map((response) => response.json<CreateBody>().team.id)).size).toBe(1);
    const { rows } = await database.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM teams WHERE created_by = $1`,
      [owner.id],
    );
    expect(rows[0]?.n).toBe(1);
  });
});

describe('GET /teams/find (AC-HAPPY-3, AC-ERROR-10, AC-VERIFY-4)', () => {
  it('lists PUBLIC teams only, matches name or description case-insensitively, never lists a private team', async () => {
    const owner = await player();
    const rosedale = await createTeam(owner, { name: 'Badminton Zeta Rosedale' });
    await createTeam(owner, { name: 'badminton ZETA Albany' });
    const netball = await createTeam(owner, {
      name: 'Netball Zeta North Shore',
      description: 'Casual badminton on the side',
    });
    await createTeam(owner, { name: 'Badminton Zeta Hidden', visibility: 'PRIVATE' });

    const response = await call('GET', '/teams/find?q=BADMINTON%20zeta', null);
    expect(response.statusCode).toBe(200);
    expect(response.json<FindBody>().teams.map((team) => team.name)).toEqual([
      'badminton ZETA Albany',
      'Badminton Zeta Rosedale',
    ]);

    const byDescription = await call('GET', '/teams/find?q=ON%20THE%20SIDE', null);
    expect(byDescription.json<FindBody>().teams.map((team) => team.id)).toEqual([netball]);

    const exactPrivate = await call('GET', '/teams/find?q=Badminton%20Zeta%20Hidden', null);
    expect(exactPrivate.json<FindBody>().teams).toEqual([]);
    expect(response.body).not.toContain(await inviteCodeOf(rosedale));
  });

  it('matches %, _ and backslash literally and lists everything for an empty query', async () => {
    const owner = await player();
    await createTeam(owner, { name: 'Wild 100% Club', description: undefined });
    await createTeam(owner, { name: 'Wild 100x Club' });
    await createTeam(owner, { name: 'Under_score Club' });
    await createTeam(owner, { name: 'UnderXscore Club' });
    await createTeam(owner, { name: 'Back\\slash Club' });
    const find = async (q: string) =>
      (await call('GET', `/teams/find?q=${encodeURIComponent(q)}`, null))
        .json<FindBody>()
        .teams.map((team) => team.name);
    expect(await find('100%')).toEqual(['Wild 100% Club']);
    expect(await find('r_s')).toEqual(['Under_score Club']);
    expect(await find('k\\s')).toEqual(['Back\\slash Club']);
    expect(await find('%')).toEqual(['Wild 100% Club']);
  });

  it('pages 20 at a time in (lower(name), id) order with a stable cursor in both directions', async () => {
    await database.pool.query(
      `INSERT INTO teams (name, visibility, invite_code)
       SELECT 'Pager ' || lpad(i::text, 2, '0'), 'PUBLIC',
              replace(translate(encode(sha256(convert_to('pager' || i::text, 'UTF8')), 'base64'), '+/', '-_'), '=', '')
         FROM generate_series(1, 45) AS i`,
    );
    const page = async (after?: string) =>
      (
        await call(
          'GET',
          `/teams/find?q=Pager${after === undefined ? '' : `&after=${after}`}`,
          null,
        )
      ).json<FindBody>();
    const first = await page();
    expect(first.teams).toHaveLength(20);
    expect(first.prevCursor).toBeNull();
    // An empty query lists all public teams (AC-HAPPY-3): 20 per page, never a private one.
    const everything = (await call('GET', '/teams/find', null)).json<FindBody>();
    expect(everything.teams).toHaveLength(20);
    expect(everything.nextCursor).not.toBeNull();
    const privateIds = (
      await database.pool.query<{ id: string }>(`SELECT id FROM teams WHERE visibility = 'PRIVATE'`)
    ).rows.map((row) => row.id);
    for (const team of everything.teams) expect(privateIds).not.toContain(team.id);
    const second = await page(first.nextCursor ?? '');
    expect(second.teams).toHaveLength(20);
    const third = await page(second.nextCursor ?? '');
    expect(third.teams).toHaveLength(5);
    expect(third.nextCursor).toBeNull();

    const names = [...first.teams, ...second.teams, ...third.teams].map((team) => team.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(45);

    const backToSecond = await page(third.prevCursor ?? '');
    expect(backToSecond.teams.map((team) => team.id)).toEqual(second.teams.map((team) => team.id));
    const backToFirst = await page(backToSecond.prevCursor ?? '');
    expect(backToFirst.teams.map((team) => team.id)).toEqual(first.teams.map((team) => team.id));
    expect(backToFirst.prevCursor).toBeNull();
    expect(backToFirst.nextCursor).toBe(first.nextCursor);
  });

  it('pages correctly across teams whose 100-character names are non-ASCII (cursor round trip through the API)', async () => {
    const owner = await player();
    const unicode = (n: number) => `Ōtāhuhu 羽毛球 ${String(n).padStart(2, '0')} `.padEnd(100, 'Ñ');
    for (let n = 1; n <= 22; n += 1) await createTeam(owner, { name: unicode(n) });
    const first = (
      await call('GET', `/teams/find?q=${encodeURIComponent('Ōtāhuhu 羽毛球')}`, null)
    ).json<FindBody>();
    expect(first.teams).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    const second = (
      await call(
        'GET',
        `/teams/find?q=${encodeURIComponent('Ōtāhuhu 羽毛球')}&after=${first.nextCursor ?? ''}`,
        null,
      )
    ).json<FindBody>();
    expect(second.teams).toHaveLength(2);
    expect([...first.teams, ...second.teams].map((team) => team.name)).toEqual(
      Array.from({ length: 22 }, (_, i) => unicode(i + 1)),
    );
    const back = (
      await call(
        'GET',
        `/teams/find?q=${encodeURIComponent('Ōtāhuhu 羽毛球')}&after=${second.prevCursor ?? ''}`,
        null,
      )
    ).json<FindBody>();
    expect(back.teams.map((team) => team.id)).toEqual(first.teams.map((team) => team.id));
  });

  it('counts only APPROVED members, shows the caller their own status and hides BANNED as null', async () => {
    const owner = await player();
    const pending = await player();
    const banned = await player();
    const member = await player();
    const teamId = await createTeam(owner, { name: 'Counted Club' });
    await insertTeamMember(database.pool, { teamId, userId: member.id });
    await insertTeamMember(database.pool, { teamId, userId: pending.id, status: 'PENDING' });
    await insertTeamMember(database.pool, {
      teamId,
      userId: banned.id,
      status: 'BANNED',
      actorId: owner.id,
    });

    const as = async (who: Player | null) =>
      (await call('GET', '/teams/find?q=Counted%20Club', who?.token ?? null)).json<FindBody>()
        .teams[0];
    expect(await as(null)).toMatchObject({ memberCount: 2, myStatus: null });
    expect(await as(pending)).toMatchObject({ memberCount: 2, myStatus: 'PENDING' });
    expect(await as(member)).toMatchObject({ myStatus: 'APPROVED' });
    expect(await as(banned)).toMatchObject({ myStatus: null });
  });

  it('answers 422 for a query over 100 characters or a malformed cursor', async () => {
    expect((await call('GET', `/teams/find?q=${'a'.repeat(101)}`, null)).statusCode).toBe(422);
    expect((await call('GET', '/teams/find?after=not-a-cursor', null)).statusCode).toBe(422);
    expect((await call('GET', '/teams/find?after=e30', null)).statusCode).toBe(422);
  });

  it('orders by the partial index (lower(name), id) with no OFFSET (EXPLAIN over several hundred teams)', async () => {
    await database.pool.query(
      `INSERT INTO teams (name, visibility, invite_code)
       SELECT 'Bulk ' || i::text, CASE WHEN i % 3 = 0 THEN 'PRIVATE'::team_visibility ELSE 'PUBLIC'::team_visibility END,
              replace(translate(encode(sha256(convert_to('bulk' || i::text, 'UTF8')), 'base64'), '+/', '-_'), '=', '')
         FROM generate_series(1, 500) AS i`,
    );
    await database.pool.query('ANALYZE teams');
    const compiled = buildFindQuery({
      callerId: null,
      pattern: null,
      cursor: { n: 'bulk 1', i: randomUUID(), d: 'f' },
    }).compile(h.db);
    expect(compiled.sql.toLowerCase()).not.toContain('offset');
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN ${compiled.sql}`,
        compiled.parameters as unknown[],
      );
      await client.query('ROLLBACK');
      expect(rows.map((row) => row['QUERY PLAN']).join('\n')).toContain('idx_teams_public_name');
    } finally {
      client.release();
    }
  });
});

describe('GET /teams/mine', () => {
  it('lists the caller teams with role and status, omits BANNED, adds pendingRequestCount for admin rows and puts rows needing action first', async () => {
    const me = await player();
    const waiting = await player();
    const waiting2 = await player();
    const owner = await player();
    const quiet = await createTeam(me, { name: 'Mine A Quiet' });
    const busy = await createTeam(me, { name: 'Mine Z Busy', visibility: 'PRIVATE' });
    await insertTeamMember(database.pool, { teamId: busy, userId: waiting.id, status: 'PENDING' });
    await insertTeamMember(database.pool, { teamId: busy, userId: waiting2.id, status: 'PENDING' });
    const joined = await createTeam(owner, { name: 'Mine M Joined' });
    await insertTeamMember(database.pool, { teamId: joined, userId: me.id });
    await insertTeamMember(database.pool, {
      teamId: joined,
      userId: waiting.id,
      status: 'PENDING',
    });
    const asked = await createTeam(owner, { name: 'Mine N Asked' });
    await insertTeamMember(database.pool, { teamId: asked, userId: me.id, status: 'PENDING' });
    const bannedFrom = await createTeam(owner, { name: 'Mine B Banned' });
    await insertTeamMember(database.pool, {
      teamId: bannedFrom,
      userId: me.id,
      status: 'BANNED',
      actorId: owner.id,
    });

    const response = await call('GET', '/teams/mine', me.token);
    expect(response.statusCode).toBe(200);
    const rows = response.json<{
      teams: {
        id: string;
        name: string;
        role: string;
        status: string;
        visibility: string;
        pendingRequestCount?: number;
      }[];
    }>().teams;
    expect(rows.map((row) => row.name)).toEqual([
      'Mine Z Busy',
      'Mine A Quiet',
      'Mine M Joined',
      'Mine N Asked',
    ]);
    expect(rows[0]).toMatchObject({
      id: busy,
      role: 'TEAM_ADMIN',
      status: 'APPROVED',
      visibility: 'PRIVATE',
      pendingRequestCount: 2,
    });
    expect(rows[1]).toMatchObject({ id: quiet, pendingRequestCount: 0 });
    expect(rows[2]).toMatchObject({ role: 'MEMBER', status: 'APPROVED' });
    expect(rows[2]).not.toHaveProperty('pendingRequestCount');
    expect(rows[3]).toMatchObject({ status: 'PENDING' });
    expect(response.body).not.toContain(await inviteCodeOf(busy));
    expect((await call('GET', '/teams/mine', null)).statusCode).toBe(401);
  });
});

describe('GET /teams/:teamId (AC-ERROR-10, Journey A17)', () => {
  it('shows a public team to anyone with member count, myStatus and myRole (BANNED included)', async () => {
    const owner = await player();
    const banned = await player();
    const stranger = await player();
    const teamId = await createTeam(owner, { name: 'Detail Public' });
    await insertTeamMember(database.pool, {
      teamId,
      userId: banned.id,
      status: 'BANNED',
      actorId: owner.id,
    });

    const anon = await call('GET', `/teams/${teamId}`, null);
    expect(anon.statusCode).toBe(200);
    expect(anon.json()).toEqual({
      team: {
        id: teamId,
        name: 'Detail Public',
        description: 'Wednesday nights, all levels welcome',
        visibility: 'PUBLIC',
        memberCount: 1,
      },
      myStatus: null,
      myRole: null,
    });
    expect((await call('GET', `/teams/${teamId}`, stranger.token)).json()).toMatchObject({
      myStatus: null,
      myRole: null,
    });
    expect((await call('GET', `/teams/${teamId}`, owner.token)).json()).toMatchObject({
      myStatus: 'APPROVED',
      myRole: 'TEAM_ADMIN',
    });
    expect((await call('GET', `/teams/${teamId}`, banned.token)).json()).toMatchObject({
      myStatus: 'BANNED',
      myRole: 'MEMBER',
    });
    expect(anon.body).not.toContain(await inviteCodeOf(teamId));
  });

  it('answers a private team 404 not_found for anonymous, non-member and banned callers with the body of a missing team, and shows it to non-banned members', async () => {
    const owner = await player();
    const member = await player();
    const pending = await player();
    const stranger = await player();
    const banned = await player();
    const teamId = await createTeam(owner, { name: 'Detail Private', visibility: 'PRIVATE' });
    await insertTeamMember(database.pool, { teamId, userId: member.id });
    await insertTeamMember(database.pool, { teamId, userId: pending.id, status: 'PENDING' });
    await insertTeamMember(database.pool, {
      teamId,
      userId: banned.id,
      status: 'BANNED',
      actorId: owner.id,
    });

    const missing = await call('GET', `/teams/${randomUUID()}`, stranger.token);
    expect(missing.statusCode).toBe(404);
    for (const token of [null, stranger.token, banned.token]) {
      const response = await call('GET', `/teams/${teamId}`, token);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(missing.json());
    }
    for (const who of [owner, member, pending]) {
      const response = await call('GET', `/teams/${teamId}`, who.token);
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(await inviteCodeOf(teamId));
    }
  });
});

describe('POST /teams/invite/lookup (AC-ERROR-3, AC-HAPPY-5)', () => {
  it('returns the team preview and the caller status for a current code of a private or a public team', async () => {
    const owner = await player();
    const visitor = await player();
    const priv = await createTeam(owner, { name: 'Lookup Private', visibility: 'PRIVATE' });
    const pub = await createTeam(owner, { name: 'Lookup Public' });
    await insertTeamMember(database.pool, { teamId: pub, userId: visitor.id, status: 'PENDING' });

    const first = await call('POST', '/teams/invite/lookup', visitor.token, {
      code: await inviteCodeOf(priv),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      team: {
        id: priv,
        name: 'Lookup Private',
        description: 'Wednesday nights, all levels welcome',
        visibility: 'PRIVATE',
        memberCount: 1,
      },
      myStatus: null,
    });
    const second = await call('POST', '/teams/invite/lookup', visitor.token, {
      code: await inviteCodeOf(pub),
    });
    expect(second.json()).toMatchObject({
      team: { id: pub, visibility: 'PUBLIC' },
      myStatus: 'PENDING',
    });
    expect(first.body).not.toContain(await inviteCodeOf(priv));
  });

  it('answers 404 invite_invalid for unknown, malformed and NUL-bearing codes, and 401 without a session', async () => {
    const visitor = await player();
    for (const code of [
      generateInviteCode(),
      'short',
      `${'a'.repeat(40)}\u0000`,
      'x'.repeat(200),
    ]) {
      const response = await call('POST', '/teams/invite/lookup', visitor.token, { code });
      expect(response.statusCode, code).toBe(404);
      expect(response.json<ErrorBody>().error.code).toBe('invite_invalid');
    }
    expect((await call('POST', '/teams/invite/lookup', visitor.token, {})).statusCode).toBe(422);
    expect(
      (await call('POST', '/teams/invite/lookup', null, { code: generateInviteCode() })).statusCode,
    ).toBe(401);
  });

  it('answers a banned caller 403 banned_from_team with no team preview', async () => {
    const owner = await player();
    const banned = await player();
    const teamId = await createTeam(owner, { name: 'Lookup Banned', visibility: 'PRIVATE' });
    await insertTeamMember(database.pool, {
      teamId,
      userId: banned.id,
      status: 'BANNED',
      actorId: owner.id,
    });
    const response = await call('POST', '/teams/invite/lookup', banned.token, {
      code: await inviteCodeOf(teamId),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorBody>().error.code).toBe('banned_from_team');
    expect(response.body).not.toContain('Lookup Banned');
    expect(response.json()).not.toHaveProperty('team');
  });
});

describe('POST /teams/:teamId/join-requests', () => {
  it('creates a PENDING MEMBER row with the chosen skill level and no approval or ban stamps (AC-HAPPY-4)', async () => {
    const owner = await player();
    const joiner = await player();
    const teamId = await createTeam(owner, { name: 'Join Public' });
    const response = await call('POST', `/teams/${teamId}/join-requests`, joiner.token, {
      skillLevel: 'ADVANCED',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ membership: { status: 'PENDING', skillLevel: 'ADVANCED' } });
    const rows = await membershipRows(teamId, joiner.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'MEMBER',
      status: 'PENDING',
      skill_level: 'ADVANCED',
      approved_at: null,
      approved_by: null,
      banned_at: null,
    });
    expect(rows[0]?.requested_at).toBeInstanceOf(Date);
  });

  it('joins a private team through its invite code and a public team with its current code (AC-HAPPY-5)', async () => {
    const owner = await player();
    const joiner = await player();
    const joiner2 = await player();
    const priv = await createTeam(owner, { name: 'Join Private', visibility: 'PRIVATE' });
    const pub = await createTeam(owner, { name: 'Join Public Code' });
    const viaPrivate = await call('POST', `/teams/${priv}/join-requests`, joiner.token, {
      skillLevel: 'BEGINNER',
      inviteCode: await inviteCodeOf(priv),
    });
    expect(viaPrivate.statusCode).toBe(201);
    const viaPublic = await call('POST', `/teams/${pub}/join-requests`, joiner2.token, {
      skillLevel: 'BEGINNER',
      inviteCode: await inviteCodeOf(pub),
    });
    expect(viaPublic.statusCode).toBe(201);
    expect(viaPrivate.body).not.toContain(await inviteCodeOf(priv));
  });

  it('answers a private team without or with a wrong code 404 not_found, identical to a team that does not exist (AC-ERROR-3)', async () => {
    const owner = await player();
    const joiner = await player();
    const priv = await createTeam(owner, { name: 'Join Hidden', visibility: 'PRIVATE' });
    const missing = await call('POST', `/teams/${randomUUID()}/join-requests`, joiner.token, {
      skillLevel: 'BEGINNER',
    });
    expect(missing.statusCode).toBe(404);
    for (const inviteCode of [undefined, generateInviteCode(), 'short']) {
      const response = await call('POST', `/teams/${priv}/join-requests`, joiner.token, {
        skillLevel: 'BEGINNER',
        ...(inviteCode === undefined ? {} : { inviteCode }),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(missing.json());
    }
    expect(await membershipRows(priv, joiner.id)).toHaveLength(0);
  });

  it('answers a public team with a stale invite code 404 invite_invalid and without a code succeeds', async () => {
    const owner = await player();
    const joiner = await player();
    const teamId = await createTeam(owner, { name: 'Join Stale' });
    const stale = await call('POST', `/teams/${teamId}/join-requests`, joiner.token, {
      skillLevel: 'BEGINNER',
      inviteCode: generateInviteCode(),
    });
    expect(stale.statusCode).toBe(404);
    expect(stale.json<ErrorBody>().error.code).toBe('invite_invalid');
    expect(await membershipRows(teamId, joiner.id)).toHaveLength(0);
    expect(
      (
        await call('POST', `/teams/${teamId}/join-requests`, joiner.token, {
          skillLevel: 'BEGINNER',
        })
      ).statusCode,
    ).toBe(201);
  });

  it('refuses a missing skill level, an unknown field and a missing session without creating a row (AC-ERROR-2)', async () => {
    const owner = await player();
    const joiner = await player();
    const teamId = await createTeam(owner, { name: 'Join Strict' });
    const missing = await call('POST', `/teams/${teamId}/join-requests`, joiner.token, {});
    expect(missing.statusCode).toBe(422);
    expect(missing.json<ErrorBody>().error.fieldErrors?.skillLevel).toContain(
      'Select your skill level to continue.',
    );
    expect(
      (
        await call('POST', `/teams/${teamId}/join-requests`, joiner.token, {
          skillLevel: 'BEGINNER',
          status: 'APPROVED',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await call('POST', `/teams/${teamId}/join-requests`, null, { skillLevel: 'BEGINNER' }))
        .statusCode,
    ).toBe(401);
    expect(await membershipRows(teamId, joiner.id)).toHaveLength(0);
  });

  it('answers a PENDING or APPROVED caller 409 already_requested or already_member and keeps one row (AC-ERROR-4)', async () => {
    const owner = await player();
    const joiner = await player();
    const teamId = await createTeam(owner, { name: 'Join Twice' });
    const join = () =>
      call('POST', `/teams/${teamId}/join-requests`, joiner.token, { skillLevel: 'BEGINNER' });
    expect((await join()).statusCode).toBe(201);
    const again = await join();
    expect(again.statusCode).toBe(409);
    expect(again.json<ErrorBody>().error.code).toBe('already_requested');
    await database.pool.query(
      `UPDATE team_members SET status = 'APPROVED', approved_at = now(), approved_by = $2 WHERE team_id = $1 AND user_id = $3`,
      [teamId, owner.id, joiner.id],
    );
    const member = await join();
    expect(member.statusCode).toBe(409);
    expect(member.json<ErrorBody>().error.code).toBe('already_member');
    expect(await membershipRows(teamId, joiner.id)).toHaveLength(1);
    expect(
      (
        await call('POST', `/teams/${teamId}/join-requests`, owner.token, {
          skillLevel: 'BEGINNER',
        })
      ).json<ErrorBody>().error.code,
    ).toBe('already_member');
  });

  it('a double submit creates one row: one 201 and one 409', async () => {
    const owner = await player();
    const joiner = await player();
    const teamId = await createTeam(owner, { name: 'Join Double' });
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        call('POST', `/teams/${teamId}/join-requests`, joiner.token, { skillLevel: 'BEGINNER' }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409, 409, 409]);
    expect(await membershipRows(teamId, joiner.id)).toHaveLength(1);
  });

  it('answers a banned caller 403 banned_from_team with or without a valid code and leaves the row unchanged (AC-ERROR-5)', async () => {
    const owner = await player();
    const banned = await player();
    const teamId = await createTeam(owner, { name: 'Join Banned', visibility: 'PRIVATE' });
    await insertTeamMember(database.pool, {
      teamId,
      userId: banned.id,
      status: 'BANNED',
      actorId: owner.id,
    });
    const before = await membershipRows(teamId, banned.id);
    for (const inviteCode of [undefined, await inviteCodeOf(teamId)]) {
      const response = await call('POST', `/teams/${teamId}/join-requests`, banned.token, {
        skillLevel: 'ADVANCED',
        ...(inviteCode === undefined ? {} : { inviteCode }),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json<ErrorBody>().error.code).toBe('banned_from_team');
    }
    expect(await membershipRows(teamId, banned.id)).toEqual(before);
  });

  it('lets a REJECTED caller ask again: the same row returns to PENDING with the new skill level and a fresh request time', async () => {
    const owner = await player();
    const joiner = await player();
    const teamId = await createTeam(owner, { name: 'Join Again' });
    await insertTeamMember(database.pool, {
      teamId,
      userId: joiner.id,
      status: 'REJECTED',
      skillLevel: 'BEGINNER',
    });
    await database.pool.query(
      `UPDATE team_members SET requested_at = '2020-01-01T00:00:00Z' WHERE team_id = $1 AND user_id = $2`,
      [teamId, joiner.id],
    );
    const response = await call('POST', `/teams/${teamId}/join-requests`, joiner.token, {
      skillLevel: 'ADVANCED',
    });
    expect(response.statusCode).toBe(201);
    const rows = await membershipRows(teamId, joiner.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'PENDING',
      skill_level: 'ADVANCED',
      approved_at: null,
    });
    expect(rows[0]?.requested_at.getTime() ?? 0).toBeGreaterThan(new Date('2021-01-01').getTime());
  });
});

describe('invite-code admin routes (AC-HAPPY-12, AC-ERROR-8, AC-ERROR-3)', () => {
  it('shows the current code to an admin and regenerates it: the old code stops working, the new one works, requests and members are untouched', async () => {
    const owner = await player();
    const requester = await player();
    const later = await player();
    const teamId = await createTeam(owner, { name: 'Rotate Club', visibility: 'PRIVATE' });
    const c1 = await inviteCodeOf(teamId);
    const shown = await call('GET', `/teams/${teamId}/invite-code`, owner.token);
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toEqual({ inviteCode: c1 });
    expect(shown.headers['cache-control']).toBe('no-store');
    expect(
      (
        await call('POST', `/teams/${teamId}/join-requests`, requester.token, {
          skillLevel: 'BEGINNER',
          inviteCode: c1,
        })
      ).statusCode,
    ).toBe(201);

    const regenerated = await call('POST', `/teams/${teamId}/invite-code/regenerate`, owner.token);
    expect(regenerated.statusCode).toBe(200);
    const c2 = regenerated.json<{ inviteCode: string }>().inviteCode;
    expect(c2).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(c2).not.toBe(c1);
    expect(await inviteCodeOf(teamId)).toBe(c2);
    expect(regenerated.headers['cache-control']).toBe('no-store');

    const oldLookup = await call('POST', '/teams/invite/lookup', later.token, { code: c1 });
    expect(oldLookup.statusCode).toBe(404);
    expect(oldLookup.json<ErrorBody>().error.code).toBe('invite_invalid');
    expect(
      (
        await call('POST', `/teams/${teamId}/join-requests`, later.token, {
          skillLevel: 'BEGINNER',
          inviteCode: c1,
        })
      ).statusCode,
    ).toBe(404);
    expect((await call('POST', '/teams/invite/lookup', later.token, { code: c2 })).statusCode).toBe(
      200,
    );
    expect((await membershipRows(teamId, requester.id))[0]?.status).toBe('PENDING');
    expect((await membershipRows(teamId, owner.id))[0]?.status).toBe('APPROVED');
  });

  it('answers non-admins 403 and anonymous 401 before validation, with one body for a real and a missing team', async () => {
    const owner = await player();
    const member = await player();
    const pending = await player();
    const banned = await player();
    const outsider = await player();
    const otherAdmin = await player();
    const globalAdmin = await player();
    await database.pool.query(`UPDATE users SET role = 'GLOBAL_ADMIN' WHERE id = $1`, [
      globalAdmin.id,
    ]);
    const teamId = await createTeam(owner, { name: 'Guarded Club', visibility: 'PRIVATE' });
    await createTeam(otherAdmin, { name: 'Other Club' });
    await insertTeamMember(database.pool, { teamId, userId: member.id });
    await insertTeamMember(database.pool, { teamId, userId: pending.id, status: 'PENDING' });
    await insertTeamMember(database.pool, {
      teamId,
      userId: banned.id,
      status: 'BANNED',
      actorId: owner.id,
    });
    const before = await inviteCodeOf(teamId);

    const routes: ['GET' | 'POST', string][] = [
      ['GET', 'invite-code'],
      ['POST', 'invite-code/regenerate'],
    ];
    for (const [method, path] of routes) {
      const missing = await call(
        method,
        `/teams/${randomUUID()}/${path}`,
        outsider.token,
        method === 'POST' ? { junk: 1 } : undefined,
      );
      expect(missing.statusCode).toBe(403);
      for (const who of [member, pending, banned, outsider, otherAdmin, globalAdmin]) {
        const response = await call(
          method,
          `/teams/${teamId}/${path}`,
          who.token,
          method === 'POST' ? { junk: 1 } : undefined,
        );
        expect(response.statusCode, `${method} ${path}`).toBe(403);
        expect(response.json()).toEqual(missing.json());
        expect(response.json<ErrorBody>().error.code).toBe('forbidden');
      }
      expect((await call(method, `/teams/${teamId}/${path}`, null)).statusCode).toBe(401);
    }
    expect(await inviteCodeOf(teamId)).toBe(before);
  });
});

describe('invite rotation race (critique finding 2: the join transaction locks the team FOR SHARE)', () => {
  it('a private join with the old code waits for a rotation in flight and then fails; no membership row appears', async () => {
    const owner = await player();
    const joiner = await player();
    const teamId = await createTeam(owner, { name: 'Race Private', visibility: 'PRIVATE' });
    const oldCode = await inviteCodeOf(teamId);
    const holder = await database.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM teams WHERE id = $1 FOR UPDATE`, [teamId]);
      await holder.query(`UPDATE teams SET invite_code = $2 WHERE id = $1`, [
        teamId,
        generateInviteCode(),
      ]);
      expect(await lockWaiters()).toBe(0);
      const join = trackSettled(
        call('POST', `/teams/${teamId}/join-requests`, joiner.token, {
          skillLevel: 'BEGINNER',
          inviteCode: oldCode,
        }),
      );
      await waitForBlockedBackend('the join to wait on the rotating team row');
      expect(join.settled()).toBe(false);
      await holder.query('COMMIT');
      const response = await join.promise;
      expect(response.statusCode).toBe(404);
      expect(response.json<ErrorBody>().error.code).toBe('not_found');
    } finally {
      holder.release();
    }
    expect(await membershipRows(teamId, joiner.id)).toHaveLength(0);
  });

  it('a public join with the old code answers invite_invalid after the rotation commits', async () => {
    const owner = await player();
    const joiner = await player();
    const teamId = await createTeam(owner, { name: 'Race Public' });
    const oldCode = await inviteCodeOf(teamId);
    const holder = await database.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM teams WHERE id = $1 FOR UPDATE`, [teamId]);
      await holder.query(`UPDATE teams SET invite_code = $2 WHERE id = $1`, [
        teamId,
        generateInviteCode(),
      ]);
      const join = trackSettled(
        call('POST', `/teams/${teamId}/join-requests`, joiner.token, {
          skillLevel: 'BEGINNER',
          inviteCode: oldCode,
        }),
      );
      await waitForBlockedBackend('the public join to wait on the rotating team row');
      await holder.query('COMMIT');
      const response = await join.promise;
      expect(response.statusCode).toBe(404);
      expect(response.json<ErrorBody>().error.code).toBe('invite_invalid');
    } finally {
      holder.release();
    }
    expect(await membershipRows(teamId, joiner.id)).toHaveLength(0);
  });

  it('a regenerate waits for a join in flight (which holds the team FOR SHARE) and then commits the new code', async () => {
    const owner = await player();
    const teamId = await createTeam(owner, { name: 'Race Regenerate', visibility: 'PRIVATE' });
    const before = await inviteCodeOf(teamId);
    const holder = await database.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM teams WHERE id = $1 FOR SHARE`, [teamId]);
      const regenerate = trackSettled(
        call('POST', `/teams/${teamId}/invite-code/regenerate`, owner.token),
      );
      await waitForBlockedBackend('the regenerate to wait on the join lock');
      expect(regenerate.settled()).toBe(false);
      expect(await inviteCodeOf(teamId)).toBe(before);
      await holder.query('COMMIT');
      const response = await regenerate.promise;
      expect(response.statusCode).toBe(200);
      expect(response.json<{ inviteCode: string }>().inviteCode).toBe(await inviteCodeOf(teamId));
    } finally {
      holder.release();
    }
    expect(await inviteCodeOf(teamId)).not.toBe(before);
  });
});

describe('no invite code outside the permitted responses (AC-VERIFY-3, AC-ERROR-10)', () => {
  it('never appears in create, find, mine, detail, lookup or join bodies', async () => {
    const owner = await player();
    const joiner = await player();
    const created = await call(
      'POST',
      '/teams',
      owner.token,
      createBody({ name: 'Leak Check', visibility: 'PRIVATE' }),
    );
    const teamId = created.json<CreateBody>().team.id;
    const code = await inviteCodeOf(teamId);
    const bodies = [
      created.body,
      (await call('GET', '/teams/find?q=Leak', owner.token)).body,
      (await call('GET', '/teams/mine', owner.token)).body,
      (await call('GET', `/teams/${teamId}`, owner.token)).body,
      (await call('POST', '/teams/invite/lookup', joiner.token, { code })).body,
      (
        await call('POST', `/teams/${teamId}/join-requests`, joiner.token, {
          skillLevel: 'BEGINNER',
          inviteCode: code,
        })
      ).body,
    ];
    for (const body of bodies) expect(body).not.toContain(code);
  });
});
