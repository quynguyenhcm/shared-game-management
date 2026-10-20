import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient, traceHeaders } from './api-client.ts';

const INCOMING = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;

function stubFetch() {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(Response.json({ status: 'ok', db: 'ok', version: '1.0.0' })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentHeaders(fetchMock: ReturnType<typeof stubFetch>): Record<string, string> {
  return (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  // Isolate from a developer's .env: empty means unset for the web config.
  vi.stubEnv('API_INTERNAL_URL', '');
  vi.stubEnv('API_INTERNAL_SHARED_SECRET', '');
  vi.stubEnv('WEB_TRUSTED_PROXY_HOPS', '');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const USER = {
  id: '7f3c2b1a-1111-4222-8333-444455556666',
  email: 'aroha.ngata@example.com',
  fullName: 'Aroha Ngata',
  sex: 'FEMALE',
  role: 'PLAYER',
};
const SECRET = 'internal-secret-for-tests-0123456789abcdef';

function stubJson(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(Response.json(body, { status, headers })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('apiClient auth calls (bearer, internal headers, client address)', () => {
  it('sends the bearer, traceparent, internal secret and a derived client address, and never the incoming internal headers (AC-VERIFY-14)', async () => {
    vi.stubEnv('API_INTERNAL_SHARED_SECRET', SECRET);
    vi.stubEnv('WEB_TRUSTED_PROXY_HOPS', '1');
    const fetchMock = stubJson(200, { user: USER });
    const result = await apiClient.me('session-token', {
      incoming: new Headers({
        traceparent: INCOMING,
        'x-forwarded-for': '6.6.6.6, 203.0.113.9',
        'x-sgm-client-ip': '9.9.9.9',
        'x-sgm-internal-auth': 'forged',
        authorization: 'Bearer stolen',
        cookie: 'sgm_session=stolen',
        'user-agent': 'TestAgent/1.0',
      }),
    });
    expect(result).toMatchObject({ ok: true, data: { user: { fullName: 'Aroha Ngata' } } });
    const headers = sentHeaders(fetchMock);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:4000/auth/me');
    expect(headers.authorization).toBe('Bearer session-token');
    expect(headers['x-sgm-internal-auth']).toBe(SECRET);
    expect(headers['x-sgm-client-ip']).toBe('203.0.113.9');
    expect(headers['user-agent']).toBe('TestAgent/1.0');
    expect(headers.traceparent?.split('-')[1]).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(headers.cookie).toBeUndefined();
    expect(JSON.stringify(headers)).not.toMatch(/forged|stolen|9\.9\.9\.9/);
  });

  it('omits x-sgm-client-ip when no address can be derived and the secret when unconfigured', async () => {
    const fetchMock = stubJson(200, { google: false, facebook: false });
    await apiClient.providers({
      incoming: new Headers({ 'x-forwarded-for': '6.6.6.6', 'x-sgm-client-ip': '9.9.9.9' }),
    });
    const headers = sentHeaders(fetchMock);
    expect(headers['x-sgm-client-ip']).toBeUndefined();
    expect(headers['x-sgm-internal-auth']).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  it('posts JSON bodies and returns a typed error with Retry-After on a 429', async () => {
    const fetchMock = stubJson(
      429,
      { error: { code: 'too_many_attempts', message: 'Too many sign-in attempts.' } },
      { 'retry-after': '840' },
    );
    const result = await apiClient.login({ email: 'a@example.com', password: 'x' });
    expect(result).toEqual({
      ok: false,
      status: 429,
      error: { code: 'too_many_attempts', message: 'Too many sign-in attempts.' },
      retryAfterSeconds: 840,
    });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ email: 'a@example.com', password: 'x' });
    expect(sentHeaders(fetchMock)['content-type']).toBe('application/json');
  });

  it('keeps fieldErrors on a 422', async () => {
    stubJson(422, {
      error: {
        code: 'validation_failed',
        message: 'Invalid',
        fieldErrors: { password: ['Use at least 10 characters.'] },
      },
    });
    const invalid = await apiClient.resetPassword({ token: 't', password: 'short' });
    expect(invalid).toMatchObject({
      ok: false,
      status: 422,
      error: { fieldErrors: { password: ['Use at least 10 characters.'] } },
    });
  });

  it('never throws: network failure, timeout, a 5xx and a non-JSON body all become a service_unavailable or internal_error result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    await expect(apiClient.me('t')).resolves.toMatchObject({
      ok: false,
      status: 0,
      error: { code: 'service_unavailable' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('<html>bad gateway</html>', { status: 502 }))),
    );
    await expect(apiClient.me('t')).resolves.toMatchObject({ ok: false, status: 502 });
    stubJson(200, { unexpected: 'shape' });
    await expect(apiClient.me('t')).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    });
  });
});

describe('apiClient OAuth and identity calls (Phase 5)', () => {
  const AUTHORIZE = { authorizationUrl: 'https://accounts.example/o?x=1', state: 'a'.repeat(43) };

  it('authorize posts the body to the lower-case provider path; callback forwards the bearer', async () => {
    const authorize = stubJson(200, AUTHORIZE);
    const result = await apiClient.oauthAuthorize('google', { returnTo: '/account' });
    expect(result).toMatchObject({ ok: true, data: AUTHORIZE });
    expect(String(authorize.mock.calls[0]?.[0])).toMatch(/\/auth\/oauth\/google\/authorize$/);
    expect(JSON.parse(authorize.mock.calls[0]?.[1]?.body as string)).toEqual({
      returnTo: '/account',
    });
    const callback = stubJson(409, {
      error: { code: 'oauth_account_exists', message: 'x', email: USER.email },
    });
    const failed = await apiClient.oauthCallback(
      'facebook',
      { state: AUTHORIZE.state, code: 'c' },
      { session: 'live-token' },
    );
    expect(failed).toMatchObject({ ok: false, error: { email: USER.email } });
    expect((callback.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe(
      'Bearer live-token',
    );
  });

  it('sends the pending handle only in X-Pending-Signup, and unlink resolves on 204', async () => {
    const pending = stubJson(200, {
      provider: 'GOOGLE',
      email: USER.email,
      fullName: null,
      expiresAt: '2030-01-01T00:00:00.000Z',
      returnTo: '/',
    });
    await expect(apiClient.oauthPending('pending-secret')).resolves.toMatchObject({ ok: true });
    expect(String(pending.mock.calls[0]?.[0])).not.toContain('pending-secret');
    expect(
      (pending.mock.calls[0]?.[1]?.headers as Record<string, string>)['x-pending-signup'],
    ).toBe('pending-secret');
    const unlink = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal('fetch', unlink);
    await expect(apiClient.unlink('google', 'live-token')).resolves.toMatchObject({
      ok: true,
      status: 204,
    });
    expect(unlink.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });
});

describe('apiClient trace propagation (web -> API)', () => {
  it('creates a W3C traceparent when the page has none, so every API call is traceable', async () => {
    const fetchMock = stubFetch();
    await expect(apiClient.health()).resolves.toMatchObject({ status: 'ok' });
    expect(sentHeaders(fetchMock).traceparent).toMatch(TRACEPARENT);
  });

  it('continues the incoming trace: same trace id as the browser/request traceparent', async () => {
    const fetchMock = stubFetch();
    await apiClient.health(new Headers({ traceparent: INCOMING, tracestate: 'a=b' }));
    const headers = sentHeaders(fetchMock);
    expect(headers.traceparent?.split('-')[1]).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(headers.tracestate).toBe('a=b');
  });

  it('ignores a malformed incoming traceparent and starts a fresh trace', () => {
    const headers = traceHeaders(new Headers({ traceparent: 'garbage' }));
    expect(headers.traceparent).toMatch(TRACEPARENT);
    expect(headers.traceparent).not.toBe('garbage');
  });
});

describe('apiClient team calls (shared zod contracts, optional vs required session)', () => {
  const TEAM_ID = '7f3c2b1a-1111-4222-8333-444455556666';
  const KEY = '2f6c1c1e-7a64-4c0e-9d61-3c1f0c1f0a11';
  const CODE = 'Zk3hQ9mXw2Lr8TfVb1NcY7uPaE4sJd6GoI0yHtKqRnA';
  const TEAM = { id: TEAM_ID, name: 'Rosedale', description: null, visibility: 'PUBLIC' };

  function call(fetchMock: ReturnType<typeof stubJson>) {
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    return { url: String(url), init, headers: (init?.headers ?? {}) as Record<string, string> };
  }

  it('createTeam POSTs the strict body as JSON with the bearer and parses the 201', async () => {
    const fetchMock = stubJson(201, {
      team: TEAM,
      membership: { status: 'APPROVED', role: 'TEAM_ADMIN', skillLevel: 'INTERMEDIATE' },
    });
    const result = await apiClient.createTeam(
      { name: 'Rosedale', visibility: 'PUBLIC', skillLevel: 'INTERMEDIATE', idempotencyKey: KEY },
      { session: 'tok' },
    );
    expect(result).toMatchObject({ ok: true, status: 201, data: { team: { id: TEAM_ID } } });
    const sent = call(fetchMock);
    expect(sent.url).toBe('http://localhost:4000/teams');
    expect(sent.init?.method).toBe('POST');
    expect(sent.headers.authorization).toBe('Bearer tok');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(JSON.parse(sent.init?.body as string)).toMatchObject({ idempotencyKey: KEY });
  });

  it('findTeams sends q and after as an encoded query, omits blanks and works without a session', async () => {
    const empty = { teams: [], nextCursor: null, prevCursor: null };
    const fetchMock = stubJson(200, empty);
    await expect(apiClient.findTeams({ q: 'bad min&x', after: 'abc_-1' })).resolves.toMatchObject({
      ok: true,
    });
    const sent = call(fetchMock);
    expect(sent.url).toBe('http://localhost:4000/teams/find?q=bad+min%26x&after=abc_-1');
    expect(sent.init?.method).toBe('GET');
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.init?.body).toBeUndefined();

    const bare = stubJson(200, empty);
    await apiClient.findTeams({ q: '', after: undefined }, { session: 'tok' });
    expect(call(bare).url).toBe('http://localhost:4000/teams/find');
    expect(call(bare).headers.authorization).toBe('Bearer tok');
  });

  it('mineTeams and teamDetail GET with the session (detail also works anonymously)', async () => {
    const mine = stubJson(200, {
      teams: [
        {
          id: TEAM_ID,
          name: 'Rosedale',
          visibility: 'PRIVATE',
          role: 'TEAM_ADMIN',
          status: 'APPROVED',
          pendingRequestCount: 2,
        },
      ],
    });
    const mineResult = await apiClient.mineTeams('tok');
    expect(mineResult).toMatchObject({ ok: true, data: { teams: [{ pendingRequestCount: 2 }] } });
    expect(call(mine).url).toBe('http://localhost:4000/teams/mine');
    expect(call(mine).headers.authorization).toBe('Bearer tok');

    const detail = stubJson(200, {
      team: { ...TEAM, memberCount: 3 },
      myStatus: null,
      myRole: null,
    });
    await expect(apiClient.teamDetail(TEAM_ID)).resolves.toMatchObject({
      ok: true,
      data: { team: { memberCount: 3 }, myStatus: null },
    });
    expect(call(detail).url).toBe(`http://localhost:4000/teams/${TEAM_ID}`);
    expect(call(detail).headers.authorization).toBeUndefined();
  });

  it('inviteLookup POSTs the code in the body, never in the URL', async () => {
    const fetchMock = stubJson(200, { team: { ...TEAM, memberCount: 1 }, myStatus: 'PENDING' });
    await expect(apiClient.inviteLookup({ code: CODE }, { session: 'tok' })).resolves.toMatchObject(
      {
        ok: true,
        data: { myStatus: 'PENDING' },
      },
    );
    const sent = call(fetchMock);
    expect(sent.url).toBe('http://localhost:4000/teams/invite/lookup');
    expect(sent.url).not.toContain(CODE);
    expect(JSON.parse(sent.init?.body as string)).toEqual({ code: CODE });
  });

  it('joinRequest POSTs to the team, and API errors come back typed (invite_invalid, banned_from_team)', async () => {
    const fetchMock = stubJson(201, { membership: { status: 'PENDING', skillLevel: 'ADVANCED' } });
    await expect(
      apiClient.joinRequest(TEAM_ID, { skillLevel: 'ADVANCED' }, { session: 'tok' }),
    ).resolves.toMatchObject({ ok: true, status: 201 });
    expect(call(fetchMock).url).toBe(`http://localhost:4000/teams/${TEAM_ID}/join-requests`);

    stubJson(404, { error: { code: 'invite_invalid', message: 'x' } });
    await expect(
      apiClient.inviteLookup({ code: 'old' }, { session: 'tok' }),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: { code: 'invite_invalid' },
    });
    stubJson(403, { error: { code: 'banned_from_team', message: 'x' } });
    await expect(
      apiClient.joinRequest(TEAM_ID, { skillLevel: 'BEGINNER' }, { session: 'tok' }),
    ).resolves.toMatchObject({ ok: false, status: 403, error: { code: 'banned_from_team' } });
  });

  it('never lets a hostile team id change the path', async () => {
    const fetchMock = stubJson(404, { error: { code: 'not_found', message: 'x' } });
    await apiClient.teamDetail('../auth/me?x=1');
    expect(call(fetchMock).url).toBe('http://localhost:4000/teams/..%2Fauth%2Fme%3Fx%3D1');
  });
});

describe('apiClient team-admin calls (members, moderation, invite code)', () => {
  const TEAM_ID = '7f3c2b1a-1111-4222-8333-444455556666';
  const USER_ID = '22222222-2222-4222-8222-222222222222';
  const MEMBER = {
    userId: USER_ID,
    fullName: 'Ana Lee',
    role: 'MEMBER',
    status: 'APPROVED',
    skillLevel: 'BEGINNER',
    requestedAt: '2026-10-03T01:00:00.000Z',
    approvedAt: '2026-10-04T01:00:00.000Z',
    bannedAt: null,
    banReason: null,
    skillOverride: null,
    skillChangedAt: null,
    autoEnroll: { enabled: false, until: null, assignedAt: null },
    skillProgress: { games: 0, required: 40, nextLevel: 'INTERMEDIATE' },
  };

  function call(fetchMock: ReturnType<typeof stubJson>) {
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    return { url: String(url), init, headers: (init?.headers ?? {}) as Record<string, string> };
  }

  it('teamMembers GETs one section with the opaque cursor and parses adminCount', async () => {
    const fetchMock = stubJson(200, { members: [MEMBER], nextCursor: 'n_-1', adminCount: 2 });
    const result = await apiClient.teamMembers(
      TEAM_ID,
      { status: 'APPROVED', after: 'c_-9' },
      { session: 'tok' },
    );
    expect(result).toMatchObject({ ok: true, data: { adminCount: 2, nextCursor: 'n_-1' } });
    const sent = call(fetchMock);
    expect(sent.url).toBe(
      `http://localhost:4000/teams/${TEAM_ID}/members?status=APPROVED&after=c_-9`,
    );
    expect(sent.headers.authorization).toBe('Bearer tok');
  });

  it('moderateMember POSTs the four one-tap actions with NO body and no JSON content-type', async () => {
    for (const action of ['approve', 'reject', 'promote', 'demote'] as const) {
      const fetchMock = stubJson(200, { member: MEMBER });
      const result = await apiClient.moderateMember(TEAM_ID, USER_ID, action, { session: 'tok' });
      expect(result).toMatchObject({ ok: true, data: { member: { fullName: 'Ana Lee' } } });
      const sent = call(fetchMock);
      expect(sent.url).toBe(`http://localhost:4000/teams/${TEAM_ID}/members/${USER_ID}/${action}`);
      expect(sent.init?.method).toBe('POST');
      expect(sent.init?.body).toBeUndefined();
      expect(sent.headers['content-type']).toBeUndefined();
    }
  });

  it('banMember POSTs the optional reason as JSON', async () => {
    const fetchMock = stubJson(200, { member: { ...MEMBER, status: 'BANNED' } });
    await apiClient.banMember(TEAM_ID, USER_ID, { reason: 'No-shows' }, { session: 'tok' });
    const sent = call(fetchMock);
    expect(sent.url).toBe(`http://localhost:4000/teams/${TEAM_ID}/members/${USER_ID}/ban`);
    expect(JSON.parse(sent.init?.body as string)).toEqual({ reason: 'No-shows' });
    expect(sent.headers['content-type']).toBe('application/json');
  });

  it('setSkillLevel and setAutoEnroll PUT JSON bodies and parse { member, changed }', async () => {
    const skill = stubJson(200, { member: MEMBER, changed: true });
    const levelResult = await apiClient.setSkillLevel(
      TEAM_ID,
      USER_ID,
      { skillLevel: 'ADVANCED', expectedSkillLevel: 'BEGINNER', expectedChangedAt: null },
      { session: 'tok' },
    );
    expect(levelResult).toMatchObject({ ok: true, data: { changed: true } });
    const sentSkill = call(skill);
    expect(sentSkill.url).toBe(
      `http://localhost:4000/teams/${TEAM_ID}/members/${USER_ID}/skill-level`,
    );
    expect(sentSkill.init?.method).toBe('PUT');
    expect(JSON.parse(sentSkill.init?.body as string)).toEqual({
      skillLevel: 'ADVANCED',
      expectedSkillLevel: 'BEGINNER',
      expectedChangedAt: null,
    });

    const enroll = stubJson(200, { member: MEMBER, changed: false });
    const enrollResult = await apiClient.setAutoEnroll(
      TEAM_ID,
      USER_ID,
      {
        enabled: true,
        until: '2026-11-30',
        expectedEnabled: false,
        expectedUntil: null,
        expectedAssignedAt: null,
      },
      { session: 'tok' },
    );
    expect(enrollResult).toMatchObject({ ok: true, data: { changed: false } });
    const sentEnroll = call(enroll);
    expect(sentEnroll.url).toBe(
      `http://localhost:4000/teams/${TEAM_ID}/members/${USER_ID}/auto-enroll`,
    );
    expect(sentEnroll.init?.method).toBe('PUT');
    expect(sentEnroll.headers['content-type']).toBe('application/json');
  });

  it('teamInviteCode GETs and regenerateInviteCode POSTs with no body and no JSON content-type (else the API answers 422)', async () => {
    const get = stubJson(200, { inviteCode: 'abc' });
    await expect(apiClient.teamInviteCode(TEAM_ID, { session: 'tok' })).resolves.toMatchObject({
      ok: true,
      data: { inviteCode: 'abc' },
    });
    expect(call(get).url).toBe(`http://localhost:4000/teams/${TEAM_ID}/invite-code`);

    const post = stubJson(200, { inviteCode: 'def' });
    await apiClient.regenerateInviteCode(TEAM_ID, { session: 'tok' });
    const sent = call(post);
    expect(sent.url).toBe(`http://localhost:4000/teams/${TEAM_ID}/invite-code/regenerate`);
    expect(sent.init?.method).toBe('POST');
    expect(sent.init?.body).toBeUndefined();
    expect(sent.headers['content-type']).toBeUndefined();
  });

  it('a 403 from an admin route comes back typed so the page can render the no-access state', async () => {
    stubJson(403, { error: { code: 'forbidden', message: 'x' } });
    await expect(
      apiClient.teamMembers(TEAM_ID, { status: 'PENDING' }, { session: 'tok' }),
    ).resolves.toMatchObject({ ok: false, status: 403, error: { code: 'forbidden' } });
  });
});

describe('apiClient banking and GST calls (team-banking-and-gst)', () => {
  const TEAM_ID = '7f3c2b1a-1111-4222-8333-444455556666';
  const KEY = '2f6c1c1e-7a64-4c0e-9d61-3c1f0c1f0a11';
  const BANKING = {
    banking: {
      isPayoutConfigured: true,
      payoutBlocked: false,
      accountName: 'Rosedale',
      unreadable: false,
      accountNumberLast4: '8389',
      lastChanged: null,
    },
  };

  function call(fetchMock: ReturnType<typeof stubJson>) {
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    return { url: String(url), init, headers: (init?.headers ?? {}) as Record<string, string> };
  }

  it('teamBanking GETs and parses the masked view with the shared schema', async () => {
    const fetchMock = stubJson(200, BANKING);
    const result = await apiClient.teamBanking(TEAM_ID, { session: 'tok' });
    expect(result).toMatchObject({ ok: true, data: { banking: { accountNumberLast4: '8389' } } });
    const sent = call(fetchMock);
    expect(sent.url).toBe(`http://localhost:4000/teams/${TEAM_ID}/banking`);
    expect(sent.init?.method).toBe('GET');
    expect(sent.headers.authorization).toBe('Bearer tok');
  });

  it('putTeamBanking PUTs the JSON body; removeTeamBanking DELETEs with no body', async () => {
    const put = stubJson(200, BANKING);
    await apiClient.putTeamBanking(
      TEAM_ID,
      { accountName: 'Rosedale', accountNumber: '01-0902-0068389-000', changeKey: KEY },
      { session: 'tok' },
    );
    const sentPut = call(put);
    expect(sentPut.init?.method).toBe('PUT');
    expect(sentPut.headers['content-type']).toBe('application/json');
    expect(JSON.parse(sentPut.init?.body as string)).toEqual({
      accountName: 'Rosedale',
      accountNumber: '01-0902-0068389-000',
      changeKey: KEY,
    });

    const del = stubJson(200, BANKING);
    await apiClient.removeTeamBanking(TEAM_ID, { session: 'tok' });
    const sentDelete = call(del);
    expect(sentDelete.url).toBe(`http://localhost:4000/teams/${TEAM_ID}/banking`);
    expect(sentDelete.init?.method).toBe('DELETE');
    expect(sentDelete.init?.body).toBeUndefined();
    expect(sentDelete.headers['content-type']).toBeUndefined();
  });

  it('teamGst GETs and putTeamGst PUTs, parsing the GST response', async () => {
    const get = stubJson(200, { gst: { gstRegistered: true, gstNumber: '49091850' } });
    await expect(apiClient.teamGst(TEAM_ID, { session: 'tok' })).resolves.toMatchObject({
      ok: true,
      data: { gst: { gstNumber: '49091850' } },
    });
    expect(call(get).url).toBe(`http://localhost:4000/teams/${TEAM_ID}/gst`);

    const put = stubJson(200, { gst: { gstRegistered: false, gstNumber: null } });
    const changeKey = '2f6c1c1e-7a64-4c0e-9d61-3c1f0c1f0a11';
    await apiClient.putTeamGst(
      TEAM_ID,
      { gstRegistered: false, gstNumber: null, changeKey },
      { session: 'tok' },
    );
    const sent = call(put);
    expect(sent.init?.method).toBe('PUT');
    expect(JSON.parse(sent.init?.body as string)).toEqual({
      gstRegistered: false,
      gstNumber: null,
      changeKey,
    });
  });

  it('a response that fails the shared schema is an internal error, never trusted data', async () => {
    stubJson(200, { banking: { accountNumberLast4: '123456789' } });
    await expect(apiClient.teamBanking(TEAM_ID, { session: 'tok' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    });
  });
});

describe('apiClient sessions calls (session-scheduling-engine)', () => {
  const TEAM_ID = '7f3c2b1a-1111-4222-8333-444455556666';
  const SESSION_ID = '11111111-1111-4111-8111-111111111111';
  const RULE_ID = '41111111-1111-4111-8111-111111111111';

  function sent(fetchMock: ReturnType<typeof stubJson>) {
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    return { url: String(url), init, headers: (init?.headers ?? {}) as Record<string, string> };
  }

  it('listSessions GETs one view with the cursor and limit as an encoded query', async () => {
    const fetchMock = stubJson(200, { sessions: [], nextCursor: null, isPayoutConfigured: false });
    const result = await apiClient.listSessions(
      TEAM_ID,
      { view: 'past', cursor: 'a b/c', limit: 25 },
      { session: 'tok' },
    );
    expect(result).toMatchObject({ ok: true, data: { isPayoutConfigured: false } });
    const call = sent(fetchMock);
    expect(call.url).toBe(
      `http://localhost:4000/teams/${TEAM_ID}/sessions?view=past&limit=25&cursor=a+b%2Fc`,
    );
    expect(call.init?.method).toBe('GET');
    expect(call.headers.authorization).toBe('Bearer tok');
  });

  it('createSession POSTs the wire body as JSON and updateSession PUTs it to the session', async () => {
    const body = { createKey: 'k', location: 'Rosedale' } as never;
    const post = stubJson(404, { error: { code: 'not_found', message: 'x' } });
    await apiClient.createSession(TEAM_ID, body, { session: 'tok' });
    expect(sent(post).url).toBe(`http://localhost:4000/teams/${TEAM_ID}/sessions`);
    expect(sent(post).init?.method).toBe('POST');
    expect(JSON.parse(sent(post).init?.body as string)).toEqual({
      createKey: 'k',
      location: 'Rosedale',
    });

    const put = stubJson(404, { error: { code: 'not_found', message: 'x' } });
    await apiClient.updateSession(TEAM_ID, SESSION_ID, body, { session: 'tok' });
    expect(sent(put).url).toBe(`http://localhost:4000/teams/${TEAM_ID}/sessions/${SESSION_ID}`);
    expect(sent(put).init?.method).toBe('PUT');
  });

  it('getSession, publishSession and cancelSession use the session paths; the commands carry expectedVersion', async () => {
    const get = stubJson(404, { error: { code: 'not_found', message: 'x' } });
    await apiClient.getSession(TEAM_ID, SESSION_ID, { session: 'tok' });
    expect(sent(get).url).toBe(`http://localhost:4000/teams/${TEAM_ID}/sessions/${SESSION_ID}`);
    expect(sent(get).init?.method).toBe('GET');

    const publish = stubJson(404, { error: { code: 'not_found', message: 'x' } });
    await apiClient.publishSession(TEAM_ID, SESSION_ID, { expectedVersion: 4 }, { session: 'tok' });
    expect(sent(publish).url).toBe(
      `http://localhost:4000/teams/${TEAM_ID}/sessions/${SESSION_ID}/publish`,
    );
    expect(JSON.parse(sent(publish).init?.body as string)).toEqual({ expectedVersion: 4 });

    const cancel = stubJson(404, { error: { code: 'not_found', message: 'x' } });
    await apiClient.cancelSession(TEAM_ID, SESSION_ID, { expectedVersion: 4 }, { session: 'tok' });
    expect(sent(cancel).url).toBe(
      `http://localhost:4000/teams/${TEAM_ID}/sessions/${SESSION_ID}/cancel`,
    );
  });

  it('series calls use /session-series: create, read, save, end and publish-drafts (no JSON body)', async () => {
    const body = { createKey: 'k' } as never;
    const create = stubJson(404, { error: { code: 'not_found', message: 'x' } });
    await apiClient.createSeries(TEAM_ID, body, { session: 'tok' });
    expect(sent(create).url).toBe(`http://localhost:4000/teams/${TEAM_ID}/session-series`);
    expect(sent(create).init?.method).toBe('POST');

    const read = stubJson(404, { error: { code: 'not_found', message: 'x' } });
    await apiClient.getSeries(TEAM_ID, RULE_ID, { session: 'tok' });
    expect(sent(read).url).toBe(`http://localhost:4000/teams/${TEAM_ID}/session-series/${RULE_ID}`);

    const save = stubJson(404, { error: { code: 'not_found', message: 'x' } });
    await apiClient.updateSeries(TEAM_ID, RULE_ID, body, { session: 'tok' });
    expect(sent(save).init?.method).toBe('PUT');

    const end = stubJson(404, { error: { code: 'not_found', message: 'x' } });
    await apiClient.endSeries(
      TEAM_ID,
      RULE_ID,
      { expectedVersion: 2, lastDate: '2026-12-16', alsoCancelPublished: true },
      { session: 'tok' },
    );
    expect(sent(end).url).toBe(
      `http://localhost:4000/teams/${TEAM_ID}/session-series/${RULE_ID}/end`,
    );
    expect(JSON.parse(sent(end).init?.body as string)).toEqual({
      expectedVersion: 2,
      lastDate: '2026-12-16',
      alsoCancelPublished: true,
    });

    const drafts = stubJson(404, { error: { code: 'not_found', message: 'x' } });
    await apiClient.publishSeriesDrafts(TEAM_ID, RULE_ID, { session: 'tok' });
    expect(sent(drafts).url).toBe(
      `http://localhost:4000/teams/${TEAM_ID}/session-series/${RULE_ID}/publish-drafts`,
    );
    expect(sent(drafts).init?.method).toBe('POST');
    expect(sent(drafts).init?.body).toBeUndefined();
    expect(sent(drafts).headers['content-type']).toBeUndefined();
  });

  it('a 422 keeps fieldErrors and the DST options the API sent, so the form can offer the choices', async () => {
    const dst = {
      field: 'courts.2.startTime',
      date: '2026-09-27',
      time: '02:30',
      kind: 'nonexistent',
      options: [
        { choice: 'shiftedForward', localTime: '03:30', instant: '2026-09-26T14:30:00.000Z' },
        { choice: 'shiftedBackward', localTime: '01:30', instant: '2026-09-26T12:30:00.000Z' },
      ],
    };
    stubJson(422, {
      error: {
        code: 'validation_failed',
        message: 'x',
        fieldErrors: { 'courts.2.startTime': ['local_time_nonexistent'] },
        dstOptions: [dst],
      },
    });
    const result = await apiClient.createSession(TEAM_ID, {} as never, { session: 'tok' });
    expect(result).toMatchObject({
      ok: false,
      status: 422,
      dstOptions: [dst],
      error: { fieldErrors: { 'courts.2.startTime': ['local_time_nonexistent'] } },
    });
  });

  it('a 409 session_fee_locked keeps raisedFields; a malformed extra never hides the error code', async () => {
    stubJson(409, {
      error: { code: 'session_fee_locked', message: 'x', raisedFields: ['fee_flat'] },
    });
    await expect(
      apiClient.updateSession(TEAM_ID, SESSION_ID, {} as never, { session: 'tok' }),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      raisedFields: ['fee_flat'],
      error: { code: 'session_fee_locked' },
    });

    stubJson(409, {
      error: { code: 'session_stale', message: 'x', current: { not: 'a session' }, dstOptions: 7 },
    });
    const stale = await apiClient.updateSession(TEAM_ID, SESSION_ID, {} as never, {
      session: 'tok',
    });
    expect(stale).toMatchObject({ ok: false, status: 409, error: { code: 'session_stale' } });
    expect(stale).not.toHaveProperty('dstOptions');
  });

  it('never lets a hostile id change the path', async () => {
    const fetchMock = stubJson(404, { error: { code: 'not_found', message: 'x' } });
    await apiClient.getSession(TEAM_ID, '../banking', { session: 'tok' });
    expect(sent(fetchMock).url).toBe(
      `http://localhost:4000/teams/${TEAM_ID}/sessions/..%2Fbanking`,
    );
  });
});
