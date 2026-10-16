import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const { saveBankingAction, removeBankingAction, saveGstAction } =
  await import('./banking-actions.ts');
const { PutBankingRequest, PutGstRequest } = await import('@sgm/shared');

const TEAM_ID = '7f3c2b1a-1111-4222-8333-444455556666';
const KEY = '2f6c1c1e-7a64-4c0e-9d61-3c1f0c1f0a11';
const PAGE = `/teams/${TEAM_ID}/manage/banking`;
const ACCOUNT = '01-0902-0068389-00';
const CANONICAL = '01-0902-0068389-000';
const SESSION_PATH = `/teams/${TEAM_ID}/sessions/abc/edit`;

const BANKING_BODY = {
  banking: {
    isPayoutConfigured: true,
    payoutBlocked: false,
    accountName: 'Rosedale Badminton Club',
    unreadable: false,
    accountNumberLast4: '8389',
    lastChanged: null,
  },
};
const GST_BODY = { gst: { gstRegistered: true, gstNumber: '49091850' } };

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

const BANKING_FIELDS = {
  teamId: TEAM_ID,
  accountName: 'Rosedale Badminton Club',
  accountNumber: ACCOUNT,
  changeKey: KEY,
  wasConfigured: 'false',
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

describe('saveBankingAction: success (AC-HAPPY-1 to 3, R6 notices, R8 changeKey)', () => {
  it('first save: PUTs the name, canonical number and the per-render changeKey with the session, then revalidates and redirects (replace) with banking_saved', async () => {
    const fetchMock = stubFetch(200, BANKING_BODY);
    const target = await redirectOf(saveBankingAction({}, form(BANKING_FIELDS)));
    expect(target).toBe(`${PAGE}?notice=banking_saved:replace`);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:4000/teams/${TEAM_ID}/banking`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('PUT');
    const body = sentBody(fetchMock);
    expect(body).toEqual({
      accountName: 'Rosedale Badminton Club',
      accountNumber: CANONICAL,
      changeKey: KEY,
    });
    // The body the action sends is one the API contract accepts as-is.
    expect(PutBankingRequest.safeParse(body).success).toBe(true);
    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe('Bearer session-token');
    expect(mocks.revalidate).toHaveBeenCalledWith(PAGE);
  });

  it('a blank number keeps the saved one: the body omits it and the notice is banking_updated', async () => {
    const fetchMock = stubFetch(200, BANKING_BODY);
    const target = await redirectOf(
      saveBankingAction(
        {},
        form({ ...BANKING_FIELDS, accountNumber: '  ', wasConfigured: 'true' }),
      ),
    );
    expect(target).toBe(`${PAGE}?notice=banking_updated:replace`);
    expect(sentBody(fetchMock)).toEqual({
      accountName: 'Rosedale Badminton Club',
      changeKey: KEY,
    });
  });

  it('a typed number on a configured team is banking_account_changed', async () => {
    stubFetch(200, BANKING_BODY);
    const target = await redirectOf(
      saveBankingAction({}, form({ ...BANKING_FIELDS, wasConfigured: 'true' })),
    );
    expect(target).toBe(`${PAGE}?notice=banking_account_changed:replace`);
  });

  it('keeps a valid same-team returnTo through the redirect and drops an invalid one', async () => {
    stubFetch(200, BANKING_BODY);
    const kept = await redirectOf(
      saveBankingAction({}, form({ ...BANKING_FIELDS, returnTo: SESSION_PATH })),
    );
    expect(kept).toBe(
      `${PAGE}?notice=banking_saved&returnTo=${encodeURIComponent(SESSION_PATH)}:replace`,
    );
    const dropped = await redirectOf(
      saveBankingAction({}, form({ ...BANKING_FIELDS, returnTo: 'https://evil.example/' })),
    );
    expect(dropped).toBe(`${PAGE}?notice=banking_saved:replace`);
  });
});

describe('saveBankingAction: validation and write-only values (AC-ERROR-1, R6)', () => {
  it('blocks a bad number before any request and re-echoes the typed name and number, with no revalidate', async () => {
    const fetchMock = stubFetch(200, BANKING_BODY);
    const state = await saveBankingAction(
      {},
      form({ ...BANKING_FIELDS, accountNumber: '12-3456-789' }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.fieldErrors?.accountNumber).toEqual([
      'Enter an NZ account number in the format 00-0000-0000000-00.',
    ]);
    expect(state.values).toMatchObject({
      accountName: 'Rosedale Badminton Club',
      accountNumber: '12-3456-789',
    });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("maps the API's 422 field errors in place and keeps the typed values", async () => {
    stubFetch(422, {
      error: {
        code: 'validation_failed',
        message: 'Invalid',
        fieldErrors: { accountNumber: ['Enter the account number.'] },
      },
    });
    const state = await saveBankingAction(
      {},
      form({ ...BANKING_FIELDS, accountNumber: '', wasConfigured: 'false' }),
    );
    expect(state.fieldErrors).toEqual({ accountNumber: ['Enter the account number.'] });
    expect(state.values).toMatchObject({ accountName: 'Rosedale Badminton Club' });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('a retry after a failure resends the same changeKey (a replayed key is a 200 no-op on the API)', async () => {
    const first = stubFetch(503, { error: { code: 'service_unavailable', message: 'down' } });
    await saveBankingAction({}, form(BANKING_FIELDS));
    const firstKey = sentBody(first).changeKey;
    const second = stubFetch(200, BANKING_BODY);
    await redirectOf(saveBankingAction({}, form(BANKING_FIELDS)));
    expect(sentBody(second).changeKey).toBe(firstKey);
    expect(firstKey).toBe(KEY);
  });

  it('refuses a non-UUID team id without calling the API', async () => {
    const fetchMock = stubFetch(200, BANKING_BODY);
    const state = await saveBankingAction({}, form({ ...BANKING_FIELDS, teamId: '../x' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.error).toEqual({ code: 'not_found' });
  });
});

describe('saveBankingAction: failures (AC-ERROR-13 MUST, A7 rule)', () => {
  it('a 5xx keeps the typed values, shows the outage code, never revalidates and never redirects', async () => {
    stubFetch(503, { error: { code: 'service_unavailable', message: 'down' } });
    const state = await saveBankingAction({}, form(BANKING_FIELDS));
    expect(state.error).toEqual({ code: 'service_unavailable' });
    expect(state.values).toMatchObject({
      accountName: 'Rosedale Badminton Club',
      accountNumber: ACCOUNT,
    });
    expect(state.fieldErrors).toBeUndefined();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('an unreachable API (network error) is the same outage, not a crash', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const state = await saveBankingAction({}, form(BANKING_FIELDS));
    expect(state.error).toEqual({ code: 'service_unavailable' });
    expect(state.values?.accountNumber).toBe(ACCOUNT);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('a 403 (demoted or banned meanwhile) revalidates so the page becomes NoAccess, and keeps no typed values', async () => {
    stubFetch(403, { error: { code: 'forbidden', message: 'no' } });
    const state = await saveBankingAction({}, form(BANKING_FIELDS));
    expect(state.error).toEqual({ code: 'forbidden' });
    expect(state.values ?? {}).toEqual({});
    expect(mocks.revalidate).toHaveBeenCalledWith(PAGE);
  });

  it('a 401 goes to session-expired and returns to this page in edit mode with the returnTo', async () => {
    stubFetch(401, { error: { code: 'unauthenticated', message: 'no' } });
    const target = await redirectOf(
      saveBankingAction({}, form({ ...BANKING_FIELDS, edit: 'banking', returnTo: SESSION_PATH })),
    );
    const expectedReturn = `${PAGE}?edit=banking&returnTo=${encodeURIComponent(SESSION_PATH)}`;
    expect(target).toBe(
      `/auth/session-expired?returnTo=${encodeURIComponent(expectedReturn)}:replace`,
    );
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('with no session cookie it redirects to sign in without calling the API', async () => {
    mocks.jar.clear();
    const fetchMock = stubFetch(200, BANKING_BODY);
    const target = await redirectOf(saveBankingAction({}, form(BANKING_FIELDS)));
    expect(target).toBe(`/login?returnTo=${encodeURIComponent(PAGE)}:replace`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never logs a typed value (account name, account number or the change key)', async () => {
    stubFetch(503, { error: { code: 'service_unavailable', message: 'down' } });
    await saveBankingAction({}, form(BANKING_FIELDS));
    expect(mocks.warn).toHaveBeenCalledWith(
      'web.teams.api_failure',
      expect.objectContaining({ action: 'save_banking', status: 503 }),
    );
    const logged = JSON.stringify(mocks.warn.mock.calls);
    for (const secret of ['Rosedale', ACCOUNT, '0068389', KEY]) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe('removeBankingAction (AC-HAPPY-4, AC-ERROR-10, R6)', () => {
  const REMOVE_FIELDS = { teamId: TEAM_ID };

  it('DELETEs, revalidates and redirects (replace) with banking_removed', async () => {
    const fetchMock = stubFetch(200, {
      banking: {
        ...BANKING_BODY.banking,
        isPayoutConfigured: false,
        accountName: null,
        accountNumberLast4: null,
      },
    });
    const target = await redirectOf(removeBankingAction(null, form(REMOVE_FIELDS)));
    expect(target).toBe(`${PAGE}?notice=banking_removed:replace`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('DELETE');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(mocks.revalidate).toHaveBeenCalledWith(PAGE);
  });

  it('409 banking_in_use closes the confirm, shows the copy that mentions unpaid payments, and changes nothing', async () => {
    stubFetch(409, { error: { code: 'banking_in_use', message: 'x' } });
    const result = await removeBankingAction(null, form(REMOVE_FIELDS));
    expect(result).toMatchObject({
      ok: false,
      code: 'banking_in_use',
      close: true,
      refresh: false,
    });
    expect(result.message).toBe(
      'Cancel or complete your published paid sessions, and wait for unpaid payments to be settled, before removing the banking details.',
    );
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('a 5xx keeps the confirm open with the removal outage copy and no revalidate', async () => {
    stubFetch(503, { error: { code: 'service_unavailable', message: 'down' } });
    const result = await removeBankingAction(null, form(REMOVE_FIELDS));
    expect(result.ok).toBe(false);
    expect(result.close).toBeFalsy();
    expect(result.message).toBe(
      'Something went wrong on our side and nothing was removed. Try again in a minute.',
    );
    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      'web.teams.api_failure',
      expect.objectContaining({ action: 'remove_banking', status: 503 }),
    );
  });

  it('a 403 closes the confirm and revalidates so the page becomes NoAccess', async () => {
    stubFetch(403, { error: { code: 'forbidden', message: 'no' } });
    const result = await removeBankingAction(null, form(REMOVE_FIELDS));
    expect(result).toMatchObject({ ok: false, code: 'forbidden', close: true, refresh: true });
    expect(mocks.revalidate).toHaveBeenCalledWith(PAGE);
  });
});

describe('saveGstAction (AC-HAPPY-5, AC-ERROR-13)', () => {
  const GST_FIELDS = { teamId: TEAM_ID, gstRegistered: 'on', gstNumber: '49-091-850' };

  it('registering sends gstRegistered and the canonical number, then redirects with gst_saved', async () => {
    const fetchMock = stubFetch(200, GST_BODY);
    const target = await redirectOf(saveGstAction({}, form(GST_FIELDS)));
    expect(target).toBe(`${PAGE}?notice=gst_saved:replace`);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:4000/teams/${TEAM_ID}/gst`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('PUT');
    const body = sentBody(fetchMock);
    expect(body).toEqual({ gstRegistered: true, gstNumber: '49091850' });
    expect(PutGstRequest.safeParse(body).success).toBe(true);
    expect(mocks.revalidate).toHaveBeenCalledWith(PAGE);
  });

  it('turning GST off sends only gstRegistered: false, so the saved number is kept (AC-HAPPY-6)', async () => {
    const fetchMock = stubFetch(200, { gst: { gstRegistered: false, gstNumber: '49091850' } });
    await redirectOf(saveGstAction({}, form({ teamId: TEAM_ID })));
    expect(sentBody(fetchMock)).toEqual({ gstRegistered: false });
  });

  it('keeps the returnTo through the save redirect', async () => {
    stubFetch(200, GST_BODY);
    const target = await redirectOf(
      saveGstAction({}, form({ ...GST_FIELDS, returnTo: SESSION_PATH })),
    );
    expect(target).toBe(
      `${PAGE}?notice=gst_saved&returnTo=${encodeURIComponent(SESSION_PATH)}:replace`,
    );
  });

  it('blocks a failed check digit before any request and keeps the toggle and the typed number', async () => {
    const fetchMock = stubFetch(200, GST_BODY);
    const state = await saveGstAction({}, form({ ...GST_FIELDS, gstNumber: '49-091-851' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.fieldErrors?.gstNumber).toEqual([
      'That GST number does not look right. Check the digits and try again.',
    ]);
    expect(state.values).toMatchObject({ gstRegistered: 'on', gstNumber: '49-091-851' });
  });

  it("maps the API's 'number required' 422 and keeps the toggle on", async () => {
    stubFetch(422, {
      error: {
        code: 'validation_failed',
        message: 'Invalid',
        fieldErrors: { gstNumber: ['Enter your GST number to register for GST.'] },
      },
    });
    const state = await saveGstAction({}, form({ teamId: TEAM_ID, gstRegistered: 'on' }));
    expect(state.fieldErrors).toEqual({
      gstNumber: ['Enter your GST number to register for GST.'],
    });
    expect(state.values?.gstRegistered).toBe('on');
  });

  it('a 5xx keeps the typed values (including an unticked toggle), no success, no revalidate', async () => {
    stubFetch(503, { error: { code: 'service_unavailable', message: 'down' } });
    const state = await saveGstAction({}, form({ teamId: TEAM_ID }));
    expect(state.error).toEqual({ code: 'service_unavailable' });
    expect(state.values?.gstRegistered).toBe('off');
    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('49091850');
  });
});
