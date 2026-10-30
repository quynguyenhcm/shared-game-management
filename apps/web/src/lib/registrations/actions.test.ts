import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REGISTRATION_ID, SESSION_ID, TEAM_ID, registrationFixture } from './fixtures.ts';

const mocks = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  revalidate: vi.fn<(path: string) => void>(),
  warn: vi.fn<(event: string, fields?: Record<string, unknown>) => void>(),
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
vi.mock('../log.ts', () => ({
  log: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));

const { registerAction, withdrawAction } = await import('./actions.ts');

const SESSION_URL = `/teams/${TEAM_ID}/sessions/${SESSION_ID}`;
const API = `http://localhost:4000/teams/${TEAM_ID}/sessions/${SESSION_ID}`;

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

function callOf(fetchMock: ReturnType<typeof stubFetch>) {
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  return {
    url: String(url),
    method: init?.method,
    body: init?.body === undefined ? undefined : (JSON.parse(init.body as string) as unknown),
    headers: (init?.headers ?? {}) as Record<string, string>,
  };
}

const err = (code: string, message = 'x', extra: Record<string, unknown> = {}) => ({
  error: { code, message, ...extra },
});

const REGISTER_FORM = { teamId: TEAM_ID, sessionId: SESSION_ID, intent: 'register', party: '0' };
const WITHDRAW_FORM = {
  teamId: TEAM_ID,
  sessionId: SESSION_ID,
  intent: 'withdraw',
  expectLate: 'false',
  grouped: '0',
};

beforeEach(() => {
  mocks.revalidate.mockClear();
  mocks.warn.mockClear();
  mocks.jar.clear();
  mocks.jar.set('sgm_session', 'session-token');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registerAction: the strict body and the success results (AC-HAPPY-1..3, AC-ERROR-5)', () => {
  it('POSTs only { guests } with the bearer session, trims names, and reports "You\'re in."', async () => {
    const fetchMock = stubFetch(201, {
      registration: registrationFixture({ status: 'CONFIRMED', guestCount: 1 }),
    });
    const result = await registerAction(
      null,
      form({
        ...REGISTER_FORM,
        party: '1',
        guest1Sex: 'FEMALE',
        guest1Skill: 'INTERMEDIATE',
        guest1Name: '  Ana  ',
      }),
    );
    const call = callOf(fetchMock);
    expect(call.url).toBe(`${API}/registrations`);
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe('Bearer session-token');
    expect(call.body).toEqual({
      guests: [{ sex: 'FEMALE', skillLevel: 'INTERMEDIATE', displayName: 'Ana' }],
    });
    expect(result).toMatchObject({ ok: true, message: "You're in.", refresh: true });
    expect(mocks.revalidate).toHaveBeenCalledWith(SESSION_URL);
  });

  it('says where the server put a waitlisted party, using registration.waitlistRank', async () => {
    stubFetch(201, {
      registration: registrationFixture({
        id: REGISTRATION_ID,
        status: 'WAITLISTED',
        waitlistRank: 3,
      }),
    });
    const result = await registerAction(null, form({ ...REGISTER_FORM, intent: 'waitlist' }));
    expect(result).toMatchObject({
      ok: true,
      message: "You're on the waitlist (#3). We'll email you if a place opens up.",
    });
  });

  it('a party of 0 sends no guests, and extra guest fields for a smaller party are ignored', async () => {
    const fetchMock = stubFetch(201, { registration: registrationFixture() });
    await registerAction(
      null,
      form({ ...REGISTER_FORM, guest1Sex: 'MALE', guest1Skill: 'BEGINNER' }),
    );
    expect(callOf(fetchMock).body).toEqual({ guests: [] });
  });

  it('422 validation_failed maps guests.{i}.* to the form ids and refreshes nothing (AC-ERROR-5)', async () => {
    stubFetch(
      422,
      err('validation_failed', 'x', { fieldErrors: { 'guests.0.sex': ['Choose a sex.'] } }),
    );
    const result = await registerAction(
      null,
      form({ ...REGISTER_FORM, party: '1', guest1Skill: 'BEGINNER' }),
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'validation_failed',
      fieldErrors: { guest1Sex: ["Choose Guest 1's sex."] },
      refresh: false,
    });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});

describe('registerAction: every registration error code maps to words and a refresh rule', () => {
  const table = [
    {
      status: 403,
      code: 'overdue_payments',
      api: 'You have 3 overdue payments. Pay them before registering for more sessions.',
      message:
        'You have 3 overdue payments. Pay them before registering for more sessions. If you think this is wrong, ask your team admin.',
      refresh: true,
    },
    {
      status: 403,
      code: 'forbidden',
      api: 'x',
      message: 'You need to be a member of this team to register.',
      refresh: true,
    },
    {
      status: 404,
      code: 'not_found',
      api: 'x',
      message: "We couldn't find that session. It may have been removed.",
      refresh: true,
    },
    {
      status: 409,
      code: 'session_not_open',
      api: 'x',
      message: 'Registration for this session is closed.',
      refresh: true,
    },
    {
      status: 409,
      code: 'already_registered',
      api: 'x',
      message: "You're already registered for this session.",
      refresh: true,
    },
    {
      status: 409,
      code: 'late_withdrawal_fee_due',
      api: 'x',
      message:
        "You owe the late-withdrawal fee for this session. You can register again only if there's a place for your whole group right now.",
      refresh: true,
    },
    {
      status: 422,
      code: 'party_exceeds_capacity',
      api: "This session has 2 public places, so a group of 3 can't register.",
      message: "This session has 2 public places, so a group of 3 can't register.",
      refresh: false,
    },
    {
      status: 500,
      code: 'service_unavailable',
      api: 'x',
      message:
        'Something went wrong on our side. Your details are still here. Try again in a minute.',
      refresh: false,
    },
    {
      status: 503,
      code: 'service_unavailable',
      api: 'x',
      message:
        'Something went wrong on our side. Your details are still here. Try again in a minute.',
      refresh: false,
    },
  ] as const;

  it.each(table)('$status $code', async ({ status, code, api, message, refresh }) => {
    stubFetch(status, err(status >= 500 ? 'internal_error' : code, api));
    const result = await registerAction(null, form(REGISTER_FORM));
    expect(result).toMatchObject({ ok: false, code, message, refresh });
    expect(mocks.revalidate).toHaveBeenCalledTimes(refresh ? 1 : 0);
  });

  it('an unreachable API is an outage that keeps the form and never half-applies (AC-ERROR-8)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    const result = await registerAction(null, form(REGISTER_FORM));
    expect(result).toMatchObject({ ok: false, code: 'service_unavailable', refresh: false });
    expect(result.message).toContain('Your details are still here');
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('a lapsed session redirects to sign-in expiry, returning to the player page', async () => {
    stubFetch(401, err('unauthenticated'));
    await expect(registerAction(null, form(REGISTER_FORM))).rejects.toThrow(
      `REDIRECT:/auth/session-expired?returnTo=${encodeURIComponent(SESSION_URL)}:replace`,
    );
  });

  it('no session cookie redirects to /login with returnTo and calls no API', async () => {
    mocks.jar.clear();
    const fetchMock = stubFetch(201, {});
    await expect(registerAction(null, form(REGISTER_FORM))).rejects.toThrow(
      `REDIRECT:/login?returnTo=${encodeURIComponent(SESSION_URL)}:replace`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a non-UUID id is not a session: nothing reaches the API path', async () => {
    const fetchMock = stubFetch(201, {});
    const result = await registerAction(null, form({ ...REGISTER_FORM, sessionId: '../x' }));
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('withdrawAction: the strict { expectLate } body and its results (AC-HAPPY-4..7, R9)', () => {
  const response = (kind: 'EARLY' | 'LATE', replacedBy: 'waitlist' | 'nobody', fee = '0.00') => ({
    registration: {
      status: 'WITHDRAWN',
      withdrawalKind: kind,
      withdrawalFeeDue: kind === 'LATE' && replacedBy === 'nobody',
    },
    replacedBy,
    feeEstimate: fee,
  });

  it('sends exactly { expectLate: false } for the early wording and reports a free withdrawal', async () => {
    const fetchMock = stubFetch(200, response('EARLY', 'nobody'));
    const result = await withdrawAction(null, form(WITHDRAW_FORM));
    const call = callOf(fetchMock);
    expect(call.url).toBe(`${API}/registrations/me/withdraw`);
    expect(call.body).toEqual({ expectLate: false });
    expect(result).toMatchObject({
      ok: true,
      message: "You've withdrawn. You won't be charged.",
      refresh: true,
    });
    expect(mocks.revalidate).toHaveBeenCalledWith(SESSION_URL);
  });

  it('sends { expectLate: true } and reports the response feeEstimate when nobody took the place', async () => {
    const fetchMock = stubFetch(200, response('LATE', 'nobody', '51.00'));
    const result = await withdrawAction(
      null,
      form({ ...WITHDRAW_FORM, expectLate: 'true', grouped: '1' }),
    );
    expect(callOf(fetchMock).body).toEqual({ expectLate: true });
    expect(result.message).toBe(
      "You've withdrawn. No one could take your place yet, so the $51.00 fee for your group applies unless someone takes your place before the game.",
    );
  });

  it('a late withdrawal the waitlist refilled is free (response.replacedBy)', async () => {
    stubFetch(200, response('LATE', 'waitlist'));
    const result = await withdrawAction(null, form({ ...WITHDRAW_FORM, expectLate: 'true' }));
    expect(result.message).toBe(
      "You've withdrawn. A player from the waitlist took your place, so you won't be charged.",
    );
  });

  it('leaving the waitlist reports "You\'ve left the waitlist."', async () => {
    stubFetch(200, response('LATE', 'nobody'));
    const result = await withdrawAction(null, form({ ...WITHDRAW_FORM, intent: 'leave' }));
    expect(result.message).toBe("You've left the waitlist.");
  });

  it('409 cancellation_terms_changed re-opens the confirmation with the late wording (R9, AC-ERROR-10)', async () => {
    stubFetch(409, err('cancellation_terms_changed'));
    const result = await withdrawAction(null, form(WITHDRAW_FORM));
    expect(result).toMatchObject({
      ok: false,
      code: 'cancellation_terms_changed',
      reopenConfirm: true,
      refresh: true,
      message:
        'The free cancellation deadline passed while you were reading. Check the details below and confirm again.',
    });
    expect(mocks.revalidate).toHaveBeenCalledWith(SESSION_URL);
  });

  it.each([
    [409, 'not_registered', "You're not registered for this session."],
    [409, 'session_not_open', 'Registration for this session is closed.'],
    [403, 'forbidden', 'You need to be a member of this team to register.'],
    [404, 'not_found', "We couldn't find that session. It may have been removed."],
  ] as const)('%s %s refreshes to the true state', async (status, code, message) => {
    stubFetch(status, err(code));
    const result = await withdrawAction(null, form(WITHDRAW_FORM));
    expect(result).toMatchObject({ ok: false, code, message, refresh: true });
    expect(result.reopenConfirm).toBeUndefined();
    expect(mocks.revalidate).toHaveBeenCalledWith(SESSION_URL);
  });

  it('a 5xx keeps the confirmation open and changes nothing (AC-ERROR-8)', async () => {
    stubFetch(500, err('internal_error'));
    const result = await withdrawAction(null, form(WITHDRAW_FORM));
    expect(result).toMatchObject({ ok: false, code: 'service_unavailable', refresh: false });
    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith('web.registrations.api_failure', {
      action: 'withdraw',
      status: 500,
      code: 'internal_error',
    });
  });
});
