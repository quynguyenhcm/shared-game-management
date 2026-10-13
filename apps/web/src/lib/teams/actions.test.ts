import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ jar: new Map<string, string>() }));

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

const { createTeamAction, joinTeamAction } = await import('./actions.ts');

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
