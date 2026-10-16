import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  revalidate: vi.fn<(path: string) => void>(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        mocks.jar.has(name) ? { name, value: mocks.jar.get(name) } : undefined,
      set: () => undefined,
    }),
  headers: () => Promise.resolve(new Headers({ 'user-agent': 'TestAgent/1.0' })),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string, type?: string) => {
    throw new Error(`REDIRECT:${url}:${type ?? 'push'}`);
  },
  RedirectType: { replace: 'replace', push: 'push' },
}));

const {
  createTeamAction,
  joinTeamAction,
  approveMemberAction,
  rejectMemberAction,
  promoteMemberAction,
  demoteMemberAction,
  demoteSelfAction,
  banMemberAction,
  regenerateInviteAction,
  setSkillLevelAction,
  setAutoEnrollAction,
} = await import('./actions.ts');

const TEAM_ID = '7f3c2b1a-1111-4222-8333-444455556666';
const KEY = '2f6c1c1e-7a64-4c0e-9d61-3c1f0c1f0a11';
const CODE = 'Zk3hQ9mXw2Lr8TfVb1NcY7uPaE4sJd6GoI0yHtKqRnA';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(Response.json(body, { status })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof stubFetch>): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
}

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const message = (error as Error).message;
    if (message.startsWith('REDIRECT:')) return message.slice('REDIRECT:'.length);
    throw error;
  }
  throw new Error('expected a redirect');
}

beforeEach(() => {
  mocks.revalidate.mockClear();
  mocks.jar.clear();
  mocks.jar.set('sgm_session', 'session-token');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const CREATE_FIELDS = {
  name: 'Rosedale Badminton',
  description: 'Wednesday nights, all levels welcome',
  visibility: 'PUBLIC',
  skillLevel: 'INTERMEDIATE',
  idempotencyKey: KEY,
};
const CREATED = {
  team: { id: TEAM_ID, name: 'Rosedale Badminton', description: null, visibility: 'PUBLIC' },
  membership: { status: 'APPROVED', role: 'TEAM_ADMIN', skillLevel: 'INTERMEDIATE' },
};

describe('createTeamAction (AC-HAPPY-1, AC-ERROR-1, AC-ERROR-11, AC-ERROR-15)', () => {
  it('posts the typed fields with the idempotency key and redirects (replace) to the manage page with the notice', async () => {
    const fetchMock = stubFetch(201, CREATED);
    const target = await redirectOf(createTeamAction({}, form(CREATE_FIELDS)));
    expect(target).toBe(`/teams/${TEAM_ID}/manage?notice=team_created:replace`);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:4000/teams');
    expect(sentBody(fetchMock)).toEqual({
      name: 'Rosedale Badminton',
      description: 'Wednesday nights, all levels welcome',
      visibility: 'PUBLIC',
      skillLevel: 'INTERMEDIATE',
      idempotencyKey: KEY,
    });
    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe('Bearer session-token');
  });

  it('a replay of the same key (200) lands on the same team without a second create', async () => {
    stubFetch(200, CREATED);
    const target = await redirectOf(createTeamAction({}, form(CREATE_FIELDS)));
    expect(target).toBe(`/teams/${TEAM_ID}/manage?notice=team_created:replace`);
  });

  it('blocks invalid input before any request and keeps every typed value and choice', async () => {
    const fetchMock = stubFetch(201, CREATED);
    const state = await createTeamAction(
      {},
      form({ ...CREATE_FIELDS, name: '   ', visibility: '', skillLevel: '' }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.fieldErrors).toMatchObject({
      name: ['Enter a team name.'],
      visibility: ['Choose who can find your team.'],
      skillLevel: ['Select your skill level to continue.'],
    });
    expect(state.values).toMatchObject({ name: '   ', description: CREATE_FIELDS.description });
  });

  it("shows the API's 422 field errors in place and keeps the values", async () => {
    stubFetch(422, {
      error: {
        code: 'validation_failed',
        message: 'Invalid',
        fieldErrors: { name: ['Use 100 characters or fewer.'] },
      },
    });
    const state = await createTeamAction({}, form(CREATE_FIELDS));
    expect(state.fieldErrors).toEqual({ name: ['Use 100 characters or fewer.'] });
    expect(state.values?.skillLevel).toBe('INTERMEDIATE');
  });

  it('a 5xx or an unreachable API keeps every value, shows the outage code and never redirects to /login', async () => {
    stubFetch(503, { error: { code: 'service_unavailable', message: 'down' } });
    const state = await createTeamAction({}, form(CREATE_FIELDS));
    expect(state.error).toEqual({ code: 'service_unavailable' });
    expect(state.values).toMatchObject({
      name: 'Rosedale Badminton',
      visibility: 'PUBLIC',
      skillLevel: 'INTERMEDIATE',
      idempotencyKey: KEY,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    const offline = await createTeamAction({}, form(CREATE_FIELDS));
    expect(offline.error?.code).toBe('service_unavailable');
    expect(offline.values?.name).toBe('Rosedale Badminton');
  });

  it('sends a visitor without a session cookie to sign in and back to /teams/new', async () => {
    mocks.jar.clear();
    const fetchMock = stubFetch(201, CREATED);
    const target = await redirectOf(createTeamAction({}, form(CREATE_FIELDS)));
    expect(target).toBe('/login?returnTo=%2Fteams%2Fnew:replace');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 401 from the API goes through the session-expired round trip back to /teams/new', async () => {
    stubFetch(401, { error: { code: 'unauthenticated', message: 'no' } });
    const target = await redirectOf(createTeamAction({}, form(CREATE_FIELDS)));
    expect(target).toBe('/auth/session-expired?returnTo=%2Fteams%2Fnew:replace');
  });
});

describe('joinTeamAction (AC-HAPPY-4/5, AC-ERROR-2..5)', () => {
  const JOINED = { membership: { status: 'PENDING', skillLevel: 'ADVANCED' } };
  const PUBLIC_FIELDS = { teamId: TEAM_ID, skillLevel: 'ADVANCED', returnTo: `/teams/${TEAM_ID}` };

  it('requests to join a public team and redirects (replace) to its page with the notice', async () => {
    const fetchMock = stubFetch(201, JOINED);
    const target = await redirectOf(joinTeamAction({}, form(PUBLIC_FIELDS)));
    expect(target).toBe(`/teams/${TEAM_ID}?notice=join_requested:replace`);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:4000/teams/${TEAM_ID}/join-requests`,
    );
    expect(sentBody(fetchMock)).toEqual({ skillLevel: 'ADVANCED' });
  });

  it('sends the invite code from the invite page and strips it from the redirect (A1)', async () => {
    const fetchMock = stubFetch(201, { membership: { status: 'PENDING', skillLevel: 'BEGINNER' } });
    const target = await redirectOf(
      joinTeamAction(
        {},
        form({
          teamId: TEAM_ID,
          skillLevel: 'BEGINNER',
          inviteCode: CODE,
          returnTo: `/teams/join?code=${CODE}`,
        }),
      ),
    );
    expect(sentBody(fetchMock)).toEqual({ skillLevel: 'BEGINNER', inviteCode: CODE });
    expect(target).toBe(`/teams/${TEAM_ID}?notice=join_requested:replace`);
    expect(target).not.toContain(CODE);
  });

  it('blocks a missing skill level with no request and keeps the form values', async () => {
    const fetchMock = stubFetch(201, JOINED);
    const state = await joinTeamAction({}, form({ ...PUBLIC_FIELDS, skillLevel: '' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.fieldErrors).toEqual({ skillLevel: ['Select your skill level to continue.'] });
  });

  it('treats a non-UUID team id as not found without calling the API', async () => {
    const fetchMock = stubFetch(201, JOINED);
    const state = await joinTeamAction({}, form({ ...PUBLIC_FIELDS, teamId: '../admin' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.error).toEqual({ code: 'not_found' });
  });

  it.each([
    [409, 'already_requested'],
    [409, 'already_member'],
    [403, 'banned_from_team'],
    [404, 'invite_invalid'],
    [404, 'not_found'],
  ])(
    'passes a %i %s through so the page shows the matching status instead of the form',
    async (status, code) => {
      stubFetch(status, { error: { code, message: 'x' } });
      const state = await joinTeamAction({}, form(PUBLIC_FIELDS));
      expect(state.error).toEqual({ code });
    },
  );

  it('a 5xx keeps the chosen level and shows the outage code, without redirecting', async () => {
    stubFetch(500, { error: { code: 'internal_error', message: 'x' } });
    const state = await joinTeamAction({}, form(PUBLIC_FIELDS));
    expect(state.error?.code).toBe('internal_error');
    expect(state.values?.skillLevel).toBe('ADVANCED');
  });

  it('keeps the invite page as the sign-in return target, validated by safeReturnTo', async () => {
    mocks.jar.clear();
    const target = await redirectOf(
      joinTeamAction({}, form({ ...PUBLIC_FIELDS, returnTo: `/teams/join?code=${CODE}` })),
    );
    expect(target).toBe(
      `/login?returnTo=${encodeURIComponent(`/teams/join?code=${CODE}`)}:replace`,
    );

    const hostile = await redirectOf(
      joinTeamAction({}, form({ ...PUBLIC_FIELDS, returnTo: 'https://evil.example' })),
    );
    expect(hostile).toBe('/login:replace');
  });
});

describe('moderation Server Actions (AC-HAPPY-6..12, AC-ERROR-6/7/9/11 web side)', () => {
  const USER_ID = '22222222-2222-4222-8222-222222222222';
  const MANAGE = `/teams/${TEAM_ID}/manage`;
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
  const FIELDS = { teamId: TEAM_ID, userId: USER_ID, fullName: 'Ana Lee' };
  const NONE = null;

  it.each([
    ['approve', approveMemberAction, 'Ana Lee has been approved.'],
    ['reject', rejectMemberAction, "Ana Lee's request was declined."],
    ['promote', promoteMemberAction, 'Ana Lee is now a team admin.'],
    ['demote', demoteMemberAction, 'Ana Lee is no longer a team admin.'],
  ] as const)(
    '%s POSTs with the bearer and no body, reports the name from the API and revalidates the manage page',
    async (kind, action, message) => {
      const fetchMock = stubFetch(200, { member: MEMBER });
      const result = await action(NONE, form(FIELDS));
      expect(result).toEqual({ ok: true, message, refresh: true });
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        `http://localhost:4000/teams/${TEAM_ID}/members/${USER_ID}/${kind}`,
      );
      expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
      const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
      expect(headers.authorization).toBe('Bearer session-token');
      expect(mocks.revalidate).toHaveBeenCalledWith(MANAGE);
    },
  );

  it('ban sends the trimmed reason (or none) and reports "{Full name} has been banned."', async () => {
    const fetchMock = stubFetch(200, { member: { ...MEMBER, status: 'BANNED' } });
    const result = await banMemberAction(NONE, form({ ...FIELDS, reason: '  Repeated no-shows ' }));
    expect(result).toMatchObject({ ok: true, message: 'Ana Lee has been banned.' });
    expect(sentBody(fetchMock)).toEqual({ reason: 'Repeated no-shows' });

    const bare = stubFetch(200, { member: { ...MEMBER, status: 'BANNED' } });
    await banMemberAction(NONE, form({ ...FIELDS, reason: '   ' }));
    expect(sentBody(bare)).toEqual({});
  });

  it('a 409 conflict reloads the list with the stale banner (AC-ERROR-9)', async () => {
    stubFetch(409, { error: { code: 'membership_state_conflict', message: 'x' } });
    const result = await approveMemberAction(NONE, form(FIELDS));
    expect(result).toMatchObject({
      ok: false,
      message: 'Someone else already handled this request. The list has been refreshed.',
      refresh: true,
    });
    expect(mocks.revalidate).toHaveBeenCalledWith(MANAGE);
  });

  it('a 409 team_admin_cannot_be_banned uses the name from the form (AC-ERROR-6)', async () => {
    stubFetch(409, { error: { code: 'team_admin_cannot_be_banned', message: 'x' } });
    const result = await banMemberAction(NONE, form({ ...FIELDS, fullName: 'Cam Ng' }));
    expect(result.message).toBe('Remove admin rights from Cam Ng before banning them.');
  });

  it('a 5xx changes nothing: no revalidate, no sign-out redirect, the outage copy (AC-ERROR-11)', async () => {
    stubFetch(503, { error: { code: 'service_unavailable', message: 'down' } });
    const result = await banMemberAction(NONE, form({ ...FIELDS, reason: 'typed' }));
    expect(result).toEqual({
      ok: false,
      code: 'service_unavailable',
      message:
        'Something went wrong on our side. Your details are still here. Try again in a minute.',
      refresh: false,
    });
    expect(mocks.revalidate).not.toHaveBeenCalled();

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    expect((await approveMemberAction(NONE, form(FIELDS))).code).toBe('service_unavailable');
  });

  it('a 401 goes through the session-expired round trip back to the manage page', async () => {
    stubFetch(401, { error: { code: 'unauthenticated', message: 'no' } });
    const target = await redirectOf(approveMemberAction(NONE, form(FIELDS)));
    expect(target).toBe(`/auth/session-expired?returnTo=${encodeURIComponent(MANAGE)}:replace`);
  });

  it('no session cookie sends the visitor to sign in without calling the API', async () => {
    mocks.jar.clear();
    const fetchMock = stubFetch(200, { member: MEMBER });
    const target = await redirectOf(approveMemberAction(NONE, form(FIELDS)));
    expect(target).toBe(`/login?returnTo=${encodeURIComponent(MANAGE)}:replace`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('non-UUID ids never reach an API path: they are the stale-list answer', async () => {
    const fetchMock = stubFetch(200, { member: MEMBER });
    const result = await approveMemberAction(NONE, form({ teamId: TEAM_ID, userId: '../x' }));
    expect(result).toMatchObject({ ok: false, refresh: false });
    expect(fetchMock).not.toHaveBeenCalled();
    const badTeam = await approveMemberAction(NONE, form({ teamId: 'nope', userId: USER_ID }));
    expect(badTeam.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('self-demote redirects (replace) to the team page with the self_demoted notice', async () => {
    const fetchMock = stubFetch(200, { member: { ...MEMBER, role: 'MEMBER' } });
    const target = await redirectOf(demoteSelfAction(NONE, form(FIELDS)));
    expect(target).toBe(`/teams/${TEAM_ID}?notice=self_demoted:replace`);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:4000/teams/${TEAM_ID}/members/${USER_ID}/demote`,
    );
  });

  it('self-demote as the sole admin stays on the page with the last-admin banner (AC-ERROR-7)', async () => {
    stubFetch(409, { error: { code: 'last_team_admin', message: 'x' } });
    const result = await demoteSelfAction(NONE, form(FIELDS));
    expect(result).toMatchObject({
      ok: false,
      message: 'A team needs at least one admin. Make another member an admin first.',
    });
  });

  it('regenerate POSTs with no body, reports the new-link copy and revalidates so the page shows the new URL', async () => {
    const fetchMock = stubFetch(200, { inviteCode: 'NEWCODE' });
    const result = await regenerateInviteAction(NONE, form({ teamId: TEAM_ID }));
    expect(result).toEqual({
      ok: true,
      message: 'New invite link generated. The old link no longer works.',
      refresh: true,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:4000/teams/${TEAM_ID}/invite-code/regenerate`,
    );
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('NEWCODE');
    expect(mocks.revalidate).toHaveBeenCalledWith(MANAGE);
  });
});

describe('setSkillLevelAction (AC-HAPPY-1/3, AC-ERROR-3/6/8/9)', () => {
  const USER_ID = '22222222-2222-4222-8222-222222222222';
  const FIELDS = {
    teamId: TEAM_ID,
    userId: USER_ID,
    fullName: 'Priya Patel',
    skillLevel: 'ADVANCED',
    expectedSkillLevel: 'BEGINNER',
    expectedChangedAt: '',
  };
  const MEMBER = {
    userId: USER_ID,
    fullName: 'Priya Patel',
    role: 'MEMBER',
    status: 'APPROVED',
    skillLevel: 'ADVANCED',
    requestedAt: '2026-10-03T01:00:00.000Z',
    approvedAt: '2026-10-04T01:00:00.000Z',
    bannedAt: null,
    banReason: null,
    skillOverride: { byName: 'Aroha Ngata', at: '2026-10-17T01:00:00.000Z' },
    skillChangedAt: '2026-10-17T01:00:00.000Z',
    autoEnroll: { enabled: false, until: null, assignedAt: null },
    skillProgress: null,
  };

  it('PUTs the level with what the panel was showing, announces the result and revalidates', async () => {
    const fetchMock = stubFetch(200, { member: MEMBER, changed: true });
    const result = await setSkillLevelAction(null, form(FIELDS));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:4000/teams/${TEAM_ID}/members/${USER_ID}/skill-level`,
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('PUT');
    expect(sentBody(fetchMock)).toEqual({
      skillLevel: 'ADVANCED',
      expectedSkillLevel: 'BEGINNER',
      expectedChangedAt: null,
    });
    expect(result).toMatchObject({
      ok: true,
      message: 'Skill level for Priya Patel set to Advanced.',
    });
    expect(mocks.revalidate).toHaveBeenCalledWith(`/teams/${TEAM_ID}/manage`);
  });

  it('sends a non-empty expectedChangedAt as the instant the API returned', async () => {
    const fetchMock = stubFetch(200, { member: MEMBER, changed: false });
    const result = await setSkillLevelAction(
      null,
      form({ ...FIELDS, expectedChangedAt: '2026-10-17T01:00:00.000Z' }),
    );
    expect(sentBody(fetchMock).expectedChangedAt).toBe('2026-10-17T01:00:00.000Z');
    expect(result.message).toBe('Priya Patel is already Advanced.');
  });

  it('no level selected is a field error with no request', async () => {
    const fetchMock = stubFetch(200, { member: MEMBER, changed: true });
    const result = await setSkillLevelAction(null, form({ ...FIELDS, skillLevel: '' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      code: 'validation_failed',
      refresh: false,
      fieldErrors: { skillLevel: ['Select a skill level.'] },
    });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('a stale level refreshes without closing; a 5xx never revalidates', async () => {
    stubFetch(409, { error: { code: 'skill_level_stale', message: 'stale' }, member: MEMBER });
    const stale = await setSkillLevelAction(null, form(FIELDS));
    expect(stale).toMatchObject({ ok: false, code: 'skill_level_stale', refresh: true });
    expect(mocks.revalidate).toHaveBeenCalledTimes(1);

    mocks.revalidate.mockClear();
    stubFetch(503, { error: { code: 'service_unavailable', message: 'busy' } });
    const down = await setSkillLevelAction(null, form(FIELDS));
    expect(down).toMatchObject({
      ok: false,
      message: "We couldn't save that. Nothing was changed. Try again.",
    });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('a banned target closes the panel with the member-specific line from the form name', async () => {
    stubFetch(409, { error: { code: 'membership_state_conflict', message: 'gone' } });
    const result = await setSkillLevelAction(null, form(FIELDS));
    expect(result).toMatchObject({
      ok: false,
      close: true,
      message: 'Priya Patel is no longer an approved member. The list has been refreshed.',
    });
  });

  it('a non-UUID target is the stale answer and never reaches an API path', async () => {
    const fetchMock = stubFetch(200, { member: MEMBER, changed: true });
    const result = await setSkillLevelAction(null, form({ ...FIELDS, userId: '../x' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, close: true });
  });

  it('a 401 goes through the session-expired round trip back to the Members section', async () => {
    stubFetch(401, { error: { code: 'unauthenticated', message: 'no' } });
    const target = await redirectOf(setSkillLevelAction(null, form(FIELDS)));
    expect(target).toBe(`/auth/session-expired?returnTo=%2Fteams%2F${TEAM_ID}%2Fmanage:replace`);
  });
});

describe('setAutoEnrollAction (AC-HAPPY-7/8/10, AC-ERROR-3)', () => {
  const USER_ID = '22222222-2222-4222-8222-222222222222';
  const BASE = { teamId: TEAM_ID, userId: USER_ID, fullName: 'Priya Patel' };
  const MEMBER = (autoEnroll: Record<string, unknown>) => ({
    userId: USER_ID,
    fullName: 'Priya Patel',
    role: 'MEMBER',
    status: 'APPROVED',
    skillLevel: 'BEGINNER',
    requestedAt: '2026-10-03T01:00:00.000Z',
    approvedAt: '2026-10-04T01:00:00.000Z',
    bannedAt: null,
    banReason: null,
    skillOverride: null,
    skillChangedAt: null,
    autoEnroll,
    skillProgress: { games: 0, required: 40, nextLevel: 'INTERMEDIATE' },
  });

  it('ticked with a date sends enabled and until', async () => {
    const fetchMock = stubFetch(200, {
      member: MEMBER({
        enabled: true,
        until: '2026-11-30',
        assignedAt: '2026-10-17T01:00:00.000Z',
      }),
      changed: true,
    });
    const result = await setAutoEnrollAction(
      null,
      form({ ...BASE, enabled: 'true', until: '2026-11-30' }),
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:4000/teams/${TEAM_ID}/members/${USER_ID}/auto-enroll`,
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('PUT');
    expect(sentBody(fetchMock)).toEqual({ enabled: true, until: '2026-11-30' });
    expect(result.message).toBe('Auto Enroll on for Priya Patel until 30 Nov 2026.');
    expect(mocks.revalidate).toHaveBeenCalled();
  });

  it('ticked with no date sends until null', async () => {
    const fetchMock = stubFetch(200, {
      member: MEMBER({ enabled: true, until: null, assignedAt: '2026-10-17T01:00:00.000Z' }),
      changed: true,
    });
    const result = await setAutoEnrollAction(null, form({ ...BASE, enabled: 'true', until: '' }));
    expect(sentBody(fetchMock)).toEqual({ enabled: true, until: null });
    expect(result.message).toBe('Auto Enroll on for Priya Patel, with no end date.');
  });

  it('unticked drops any date from the request (off with a date is refused)', async () => {
    const fetchMock = stubFetch(200, {
      member: MEMBER({ enabled: false, until: null, assignedAt: null }),
      changed: true,
    });
    const result = await setAutoEnrollAction(null, form({ ...BASE, until: '2026-11-30' }));
    expect(sentBody(fetchMock)).toEqual({ enabled: false, until: null });
    expect(result.message).toBe('Auto Enroll turned off for Priya Patel.');
  });

  it('a malformed date is a field error with no request', async () => {
    const fetchMock = stubFetch(200, {});
    const result = await setAutoEnrollAction(
      null,
      form({ ...BASE, enabled: 'true', until: '30/11/2026' }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      fieldErrors: { until: ['Choose today or a later date.'] },
    });
  });

  it("shows the API's 422 for a past date and keeps the panel open", async () => {
    stubFetch(422, {
      error: {
        code: 'validation_failed',
        message: 'Invalid',
        fieldErrors: { until: ['Choose today or a later date.'] },
      },
    });
    const result = await setAutoEnrollAction(
      null,
      form({ ...BASE, enabled: 'true', until: '2020-01-01' }),
    );
    expect(result).toMatchObject({
      ok: false,
      refresh: false,
      fieldErrors: { until: ['Choose today or a later date.'] },
    });
    expect(result.close).toBeUndefined();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('an unreachable API is the unknown-outcome line and never revalidates', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    const result = await setAutoEnrollAction(null, form({ ...BASE, enabled: 'true', until: '' }));
    expect(result.message).toBe(
      "We couldn't confirm that was saved. Try again; saving the same change twice is safe.",
    );
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
