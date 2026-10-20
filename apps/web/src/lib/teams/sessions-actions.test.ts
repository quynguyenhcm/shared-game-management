import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREATE_KEY,
  RULE_ID,
  SESSION_ID,
  TEAM_ID,
  instanceFixture,
  seriesFixture,
  sessionFixture,
} from './sessions-fixtures.ts';

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

const {
  cancelSessionAction,
  createSeriesAction,
  createSessionAction,
  endSeriesAction,
  publishDraftsAction,
  saveSeriesAction,
  saveSessionAction,
} = await import('./sessions-actions.ts');

const BASE = `/teams/${TEAM_ID}/manage/sessions`;
const SESSION_URL = `${BASE}/${SESSION_ID}`;
const SERIES_URL = `${BASE}/series/${RULE_ID}`;
const NEW_URL = `${BASE}/new`;
const NEW_SERIES_URL = `${BASE}/series/new`;
const API = `http://localhost:4000/teams/${TEAM_ID}`;

const STALE_SESSION =
  'This session changed since you opened it. Review the latest version and save again. Your unsaved changes were not kept.';
const STALE_SERIES =
  'This series changed since you opened it. Review the latest version and save again. Your unsaved changes were not kept.';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

type Reply = readonly [status: number, body: unknown];

/** Answers each fetch in order, so a save-then-publish action can be given two different replies. */
function stubFetch(...replies: Reply[]) {
  const queue = [...replies];
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => {
    const next = queue.shift() ?? replies[replies.length - 1];
    if (next === undefined) throw new Error('no reply configured');
    return Promise.resolve(Response.json(next[1], { status: next[0] }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function callOf(fetchMock: ReturnType<typeof stubFetch>, index: number) {
  const [url, init] = fetchMock.mock.calls[index] ?? [];
  return {
    url: String(url),
    method: init?.method,
    body: init?.body === undefined ? undefined : (JSON.parse(init.body as string) as unknown),
    headers: (init?.headers ?? {}) as Record<string, string>,
  };
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

const err = (code: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message: 'x', ...extra },
});
const write = (overrides = {}, extra: Record<string, unknown> = {}) => ({
  session: sessionFixture(overrides),
  promoted: 0,
  material: false,
  ...extra,
});

const SESSION_FORM: Record<string, string> = {
  teamId: TEAM_ID,
  location: 'Rosedale',
  address: '1 Court Rd',
  date: '2026-11-04',
  maxPlayers: '18',
  reservedSeats: '2',
  courtCost: '180.00',
  extraExpenses: '20.00',
  pricingStructure: 'FLAT',
  deadlineMode: 'default',
  'courts.0.identifier': 'Court 1',
  'courts.0.startTime': '08:00',
  'courts.0.endTime': '10:00',
};
const CREATE_FORM = { ...SESSION_FORM, createKey: CREATE_KEY, intent: 'draft' };
const EDIT_FORM = {
  ...SESSION_FORM,
  sessionId: SESSION_ID,
  expectedVersion: '3',
  status: 'DRAFT',
  overridden: 'false',
  intent: 'draft',
};

const SERIES_FORM: Record<string, string> = {
  teamId: TEAM_ID,
  frequency: 'WEEKLY',
  startsOn: '2026-11-04',
  recurUntil: '',
  location: 'Rosedale',
  address: '1 Court Rd',
  maxPlayers: '18',
  reservedSeats: '0',
  courtCost: '180.00',
  extraExpenses: '20.00',
  pricingStructure: 'FLAT',
  'courts.0.identifier': 'Court 1',
  'courts.0.startTime': '08:00',
  'courts.0.endTime': '10:00',
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

describe('createSessionAction: Save draft (AC-HAPPY-1, AC-HAPPY-4)', () => {
  it('POSTs the strict body with the createKey and the session, then redirects (replace) to the draft with draft_saved', async () => {
    const fetchMock = stubFetch([201, write()]);
    const target = await redirectOf(createSessionAction({}, form(CREATE_FORM)));
    expect(target).toBe(`${SESSION_URL}?notice=draft_saved:replace`);
    const call = callOf(fetchMock, 0);
    expect(call.url).toBe(`${API}/sessions`);
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe('Bearer session-token');
    expect(call.body).toMatchObject({
      createKey: CREATE_KEY,
      maxPlayers: 18,
      cancellationDeadline: null,
      courts: [{ identifier: 'Court 1', startTime: '08:00', endTime: '10:00' }],
    });
  });

  it('a replayed createKey answers 200 with the same session and lands on the same draft', async () => {
    stubFetch([200, write()]);
    await expect(redirectOf(createSessionAction({}, form(CREATE_FORM)))).resolves.toBe(
      `${SESSION_URL}?notice=draft_saved:replace`,
    );
  });
});

describe('createSessionAction: Save and publish on /new (create-and-publish, UJ A4)', () => {
  const publishForm = { ...CREATE_FORM, intent: 'publish' };

  it('creates then publishes with the version the create returned, landing on the published session', async () => {
    const fetchMock = stubFetch(
      [201, write({ version: 5 })],
      [200, write({ status: 'PUBLISHED', version: 6 })],
    );
    const target = await redirectOf(createSessionAction({}, form(publishForm)));
    expect(target).toBe(`${SESSION_URL}?notice=published:replace`);
    const publish = callOf(fetchMock, 1);
    expect(publish.url).toBe(`${API}/sessions/${SESSION_ID}/publish`);
    expect(publish.method).toBe('POST');
    expect(publish.body).toEqual({ expectedVersion: 5 });
  });

  it('a banking refusal keeps the created draft and lands on it with the banking alert (AC-ERROR-1)', async () => {
    stubFetch([201, write()], [409, err('payout_not_configured')]);
    await expect(redirectOf(createSessionAction({}, form(publishForm)))).resolves.toBe(
      `${SESSION_URL}?notice=publish_refused_banking:replace`,
    );
  });

  it('an incomplete session keeps the created draft and says so (AC-ERROR-4)', async () => {
    stubFetch(
      [201, write()],
      [
        422,
        err('validation_failed', { fieldErrors: { feeMale: ['Enter an amount like 12.00.'] } }),
      ],
    );
    await expect(redirectOf(createSessionAction({}, form(publishForm)))).resolves.toBe(
      `${SESSION_URL}?notice=publish_incomplete:replace`,
    );
  });

  it('a start that has already passed lands on the read-only draft with the started notice', async () => {
    stubFetch([201, write()], [409, err('session_started')]);
    await expect(redirectOf(createSessionAction({}, form(publishForm)))).resolves.toBe(
      `${SESSION_URL}?notice=session_started:replace`,
    );
  });
});

describe('createSessionAction: refusals stay in place and keep what was typed (AC-ERROR-2, AC-ERROR-3)', () => {
  it('client-side invalid input never reaches the API and comes back as field errors', async () => {
    const fetchMock = stubFetch([201, write()]);
    const result = await createSessionAction({}, form({ ...CREATE_FORM, location: '' }));
    expect(result.fieldErrors?.location).toEqual(['Enter a location.']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 422 returns the API field errors and the DST choices', async () => {
    const dst = {
      field: 'courts.0.startTime',
      date: '2026-09-27',
      time: '02:30',
      kind: 'nonexistent',
      options: [
        { choice: 'shiftedForward', localTime: '03:30', instant: '2026-09-26T14:30:00.000Z' },
      ],
    };
    stubFetch([
      422,
      err('validation_failed', {
        fieldErrors: { 'courts.0.startTime': ['local_time_nonexistent'] },
        dstOptions: [dst],
      }),
    ]);
    const result = await createSessionAction({}, form(CREATE_FORM));
    expect(result.fieldErrors).toEqual({ 'courts.0.startTime': ['local_time_nonexistent'] });
    expect(result.dstOptions).toEqual([dst]);
  });

  it('a 5xx says nothing was changed; no answer says it may have saved; neither logs a typed value', async () => {
    stubFetch([503, err('service_unavailable')]);
    await expect(createSessionAction({}, form(CREATE_FORM))).resolves.toMatchObject({
      error: { code: 'save_failed' },
    });
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('network')));
    await expect(createSessionAction({}, form(CREATE_FORM))).resolves.toMatchObject({
      error: { code: 'unconfirmed' },
    });
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toMatch(/Rosedale|Court Rd/);
  });

  it('a 401 goes to sign-in and returns to /new; a 403 is forbidden; a missing cookie signs in', async () => {
    stubFetch([401, err('session_expired')]);
    const expired = await redirectOf(createSessionAction({}, form(CREATE_FORM)));
    expect(expired).toContain('/auth/session-expired');
    expect(decodeURIComponent(expired)).toContain(NEW_URL);

    stubFetch([403, err('forbidden')]);
    await expect(createSessionAction({}, form(CREATE_FORM))).resolves.toMatchObject({
      error: { code: 'forbidden' },
    });

    mocks.jar.clear();
    const signedOut = await redirectOf(createSessionAction({}, form(CREATE_FORM)));
    expect(decodeURIComponent(signedOut)).toContain(NEW_URL);
  });

  it('a team id that is not a UUID is not a team: not_found, no API call', async () => {
    const fetchMock = stubFetch([201, write()]);
    const result = await createSessionAction({}, form({ ...CREATE_FORM, teamId: '../banking' }));
    expect(result.error?.code).toBe('not_found');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('saveSessionAction: Save draft and Save changes', () => {
  it('Save draft PUTs expectedVersion with the content and redirects draft_saved', async () => {
    const fetchMock = stubFetch([200, write({ version: 4 })]);
    const target = await redirectOf(saveSessionAction({}, form(EDIT_FORM)));
    expect(target).toBe(`${SESSION_URL}?notice=draft_saved:replace`);
    const call = callOf(fetchMock, 0);
    expect(call.url).toBe(`${API}/sessions/${SESSION_ID}`);
    expect(call.method).toBe('PUT');
    expect(call.body).toMatchObject({ expectedVersion: 3, location: 'Rosedale' });
    expect(call.body).not.toHaveProperty('createKey');
  });

  it('a save that changed nothing (version unchanged) says so, without claiming a save', async () => {
    stubFetch([200, write({ version: 3 })]);
    await expect(redirectOf(saveSessionAction({}, form(EDIT_FORM)))).resolves.toBe(
      `${SESSION_URL}?notice=nothing_changed:replace`,
    );
  });

  it('Save changes on a published session with a material change tells the admin the registered count and promotions (P-2)', async () => {
    stubFetch([
      200,
      write(
        { status: 'PUBLISHED', version: 4, activeRegistrationCount: 12 },
        { material: true, promoted: 2 },
      ),
    ]);
    const target = await redirectOf(
      saveSessionAction({}, form({ ...EDIT_FORM, status: 'PUBLISHED', intent: 'save' })),
    );
    expect(target).toBe(
      `${SESSION_URL}?notice=changes_saved&registered=12&promoted=2&material=1:replace`,
    );
  });

  it('a non-material save is a plain "Changes saved."', async () => {
    stubFetch([200, write({ status: 'PUBLISHED', version: 4, activeRegistrationCount: 12 })]);
    await expect(
      redirectOf(
        saveSessionAction({}, form({ ...EDIT_FORM, status: 'PUBLISHED', intent: 'save' })),
      ),
    ).resolves.toBe(`${SESSION_URL}?notice=changes_saved:replace`);
  });

  it('the first edit of a series date marks it Edited and names the date (AC-HAPPY-6)', async () => {
    stubFetch([
      200,
      write({
        version: 4,
        recurringRuleId: RULE_ID,
        seriesName: 'Wednesdays at Rosedale',
        isInstanceOverridden: true,
      }),
    ]);
    await expect(redirectOf(saveSessionAction({}, form(EDIT_FORM)))).resolves.toBe(
      `${SESSION_URL}?notice=instance_saved_first&date=2026-11-04:replace`,
    );
  });
});

describe('saveSessionAction: Save and publish on an existing draft (A4 outcome table)', () => {
  const publishForm = { ...EDIT_FORM, intent: 'publish' };

  it('PUT ok then publish ok: one save, one publish with the version the save returned, then published', async () => {
    const fetchMock = stubFetch(
      [200, write({ version: 4 })],
      [200, write({ status: 'PUBLISHED', version: 5 })],
    );
    const target = await redirectOf(saveSessionAction({}, form(publishForm)));
    expect(target).toBe(`${SESSION_URL}?notice=published:replace`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callOf(fetchMock, 1).body).toEqual({ expectedVersion: 4 });
  });

  it('PUT 422 stops before publishing and keeps the values in place', async () => {
    const fetchMock = stubFetch([
      422,
      err('validation_failed', {
        fieldErrors: { maxPlayers: ['Enter a whole number of 1 or more.'] },
      }),
    ]);
    const result = await saveSessionAction({}, form(publishForm));
    expect(result.fieldErrors?.maxPlayers).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('PUT ok then publish 409 payout_not_configured: the changes stay as a draft and the banking alert shows', async () => {
    stubFetch([200, write({ version: 4 })], [409, err('payout_not_configured')]);
    await expect(redirectOf(saveSessionAction({}, form(publishForm)))).resolves.toBe(
      `${SESSION_URL}?notice=publish_refused_banking:replace`,
    );
  });

  it('PUT ok then publish 422: field errors in place, "your other changes are saved", and the page is refreshed to the new version', async () => {
    stubFetch(
      [200, write({ version: 4 })],
      [
        422,
        err('validation_failed', { fieldErrors: { feeFemale: ['Enter an amount like 12.00.'] } }),
      ],
    );
    const result = await saveSessionAction({}, form(publishForm));
    expect(result.error?.code).toBe('publish_incomplete');
    expect(result.fieldErrors).toEqual({ feeFemale: ['Enter an amount like 12.00.'] });
    expect(mocks.revalidate).toHaveBeenCalledWith(SESSION_URL);
  });

  it('PUT ok then publish 409 session_started: the draft is now read-only with the reason', async () => {
    stubFetch([200, write({ version: 4 })], [409, err('session_started')]);
    await expect(redirectOf(saveSessionAction({}, form(publishForm)))).resolves.toBe(
      `${SESSION_URL}?notice=session_started:replace`,
    );
  });

  it('a stale publish reloads the latest version with the stale banner', async () => {
    stubFetch([200, write({ version: 4 })], [409, err('session_stale')]);
    await expect(redirectOf(saveSessionAction({}, form(publishForm)))).resolves.toBe(
      `${SESSION_URL}?notice=session_stale:replace`,
    );
  });
});

describe('saveSessionAction: known-state refusals (AC-ERROR-5, AC-ERROR-7, AC-ERROR-10)', () => {
  it.each([
    ['session_stale', 'session_stale'],
    ['session_started', 'session_started'],
    ['session_not_editable', 'session_not_editable'],
    ['session_state_conflict', 'session_not_editable'],
  ])('409 %s reloads the session with notice %s', async (code, notice) => {
    stubFetch([409, err(code)]);
    await expect(redirectOf(saveSessionAction({}, form(EDIT_FORM)))).resolves.toBe(
      `${SESSION_URL}?notice=${notice}:replace`,
    );
  });

  it('409 session_fee_locked puts the fee-over-the-limit copy under each raised fee, in place', async () => {
    stubFetch([409, err('session_fee_locked', { raisedFields: ['fee_flat'] })]);
    const result = await saveSessionAction(
      {},
      form({ ...EDIT_FORM, status: 'PUBLISHED', intent: 'save' }),
    );
    expect(result.error?.code).toBe('session_fee_locked');
    expect(result.fieldErrors?.customPlayerRate?.[0]).toMatch(/higher than the current fee/);
  });

  it('409 payout_not_configured on a free-to-paid edit of a published session is a banking refusal in place', async () => {
    stubFetch([409, err('payout_not_configured')]);
    const result = await saveSessionAction(
      {},
      form({ ...EDIT_FORM, status: 'PUBLISHED', intent: 'save' }),
    );
    expect(result.error?.code).toBe('payout_not_configured');
  });

  it('404 (unknown or another team’s session) is not_found with no detail', async () => {
    stubFetch([404, err('not_found')]);
    await expect(saveSessionAction({}, form(EDIT_FORM))).resolves.toMatchObject({
      error: { code: 'not_found' },
    });
  });

  it('403 is forbidden and refreshes the page so it becomes the no-access page', async () => {
    stubFetch([403, err('forbidden')]);
    await expect(saveSessionAction({}, form(EDIT_FORM))).resolves.toMatchObject({
      error: { code: 'forbidden' },
    });
    expect(mocks.revalidate).toHaveBeenCalledWith(SESSION_URL);
  });

  it('a 401 returns to this session after sign-in', async () => {
    stubFetch([401, err('session_expired')]);
    const target = await redirectOf(saveSessionAction({}, form(EDIT_FORM)));
    expect(decodeURIComponent(target)).toContain(SESSION_URL);
  });

  it('a session id that is not a UUID is not_found with no API call', async () => {
    const fetchMock = stubFetch([200, write()]);
    const result = await saveSessionAction({}, form({ ...EDIT_FORM, sessionId: '../x' }));
    expect(result.error?.code).toBe('not_found');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('cancelSessionAction (AC-HAPPY-9, AC-HAPPY-13)', () => {
  const fields = {
    teamId: TEAM_ID,
    sessionId: SESSION_ID,
    expectedVersion: '3',
    wasDraft: 'false',
  };
  const cancelled = (registered: number) => ({
    session: sessionFixture({ status: 'CANCELLED' }),
    activeRegistrationCount: registered,
  });

  it('POSTs the cancel with the version and redirects to the cancelled session with the registered count', async () => {
    const fetchMock = stubFetch([200, cancelled(12)]);
    const target = await redirectOf(cancelSessionAction(null, form(fields)));
    expect(target).toBe(`${SESSION_URL}?notice=cancelled&registered=12:replace`);
    const call = callOf(fetchMock, 0);
    expect(call.url).toBe(`${API}/sessions/${SESSION_ID}/cancel`);
    expect(call.body).toEqual({ expectedVersion: 3 });
  });

  it('no registrations is "No one had registered."', async () => {
    stubFetch([200, cancelled(0)]);
    await expect(redirectOf(cancelSessionAction(null, form(fields)))).resolves.toBe(
      `${SESSION_URL}?notice=cancelled&registered=0:replace`,
    );
  });

  it('cancelling a draft says "Draft cancelled." and carries no count', async () => {
    stubFetch([200, cancelled(0)]);
    await expect(
      redirectOf(cancelSessionAction(null, form({ ...fields, wasDraft: 'true' }))),
    ).resolves.toBe(`${SESSION_URL}?notice=cancelled_draft:replace`);
  });

  it('a stale view closes the confirm with the stale text and refreshes the page', async () => {
    stubFetch([409, err('session_stale')]);
    await expect(cancelSessionAction(null, form(fields))).resolves.toEqual({
      ok: false,
      code: 'session_stale',
      message: STALE_SESSION,
      refresh: true,
      close: true,
    });
    expect(mocks.revalidate).toHaveBeenCalledWith(SESSION_URL);
  });

  it.each([
    ['session_started', 'session_started'],
    ['session_not_editable', 'session_not_editable'],
  ])('409 %s reloads the session as read-only with notice %s', async (code, notice) => {
    stubFetch([409, err(code)]);
    await expect(redirectOf(cancelSessionAction(null, form(fields)))).resolves.toBe(
      `${SESSION_URL}?notice=${notice}:replace`,
    );
  });

  it('a 5xx keeps the confirm open with the not-changed copy; no answer says it may have saved', async () => {
    stubFetch([500, err('internal_error')]);
    await expect(cancelSessionAction(null, form(fields))).resolves.toMatchObject({
      ok: false,
      refresh: false,
      message: "We couldn't save that. Nothing was changed. Try again.",
    });
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('network')));
    const result = await cancelSessionAction(null, form(fields));
    expect(result.message).toMatch(/couldn't confirm that was saved/);
  });

  it('a 403 refreshes to the no-access page; a bad id is a not-found result', async () => {
    stubFetch([403, err('forbidden')]);
    await expect(cancelSessionAction(null, form(fields))).resolves.toMatchObject({
      ok: false,
      code: 'forbidden',
      refresh: true,
    });
    const fetchMock = stubFetch([200, cancelled(0)]);
    await expect(
      cancelSessionAction(null, form({ ...fields, sessionId: 'x' })),
    ).resolves.toMatchObject({ ok: false, code: 'not_found' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createSeriesAction (AC-HAPPY-5)', () => {
  const create = { ...SERIES_FORM, createKey: CREATE_KEY };

  it('POSTs the series body (weekday derived from the first date) and lands on the waiting series page', async () => {
    const fetchMock = stubFetch([201, { series: seriesFixture({ materialising: true }) }]);
    const target = await redirectOf(createSeriesAction({}, form(create)));
    expect(target).toBe(`${SERIES_URL}?notice=series_created:replace`);
    const call = callOf(fetchMock, 0);
    expect(call.url).toBe(`${API}/session-series`);
    expect(call.body).toMatchObject({ createKey: CREATE_KEY, dayOfWeek: 3, frequency: 'WEEKLY' });
  });

  it('refuses invalid input with field errors and no API call; a 422 is returned in place', async () => {
    const fetchMock = stubFetch([
      422,
      err('validation_failed', {
        fieldErrors: { startsOn: ['Choose a first date that falls on the chosen day and week.'] },
      }),
    ]);
    const local = await createSeriesAction({}, form({ ...create, location: '' }));
    expect(local.fieldErrors?.location).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
    const remote = await createSeriesAction({}, form(create));
    expect(remote.fieldErrors?.startsOn).toBeDefined();
  });

  it('a 401 returns to /series/new after sign-in', async () => {
    stubFetch([401, err('session_expired')]);
    const target = await redirectOf(createSeriesAction({}, form(create)));
    expect(decodeURIComponent(target)).toContain(NEW_SERIES_URL);
  });
});

describe('saveSeriesAction (AC-HAPPY-7)', () => {
  const edit = { ...SERIES_FORM, ruleId: RULE_ID, expectedVersion: '2' };
  const saved = (version: number, outcome = {}) => ({
    series: seriesFixture({ version, instances: [instanceFixture()] }),
    outcome: {
      updated: 4,
      unchanged: 0,
      skipped: { edited: 1, started: 0, closed: 0, deadlinePassed: 0, feeLocked: 0 },
      ...outcome,
    },
  });

  it('PUTs with expectedVersion and redirects to the series page with the counts the API returned', async () => {
    const fetchMock = stubFetch([200, saved(3)]);
    const target = await redirectOf(saveSeriesAction({}, form(edit)));
    expect(target).toBe(`${SERIES_URL}?notice=series_saved&count=4&edited=1:replace`);
    const call = callOf(fetchMock, 0);
    expect(call.url).toBe(`${API}/session-series/${RULE_ID}`);
    expect(call.method).toBe('PUT');
    expect(call.body).toMatchObject({ expectedVersion: 2 });
  });

  it('carries every skip reason that is not zero', async () => {
    stubFetch([
      200,
      saved(3, {
        updated: 2,
        skipped: { edited: 0, started: 1, closed: 1, deadlinePassed: 1, feeLocked: 2 },
      }),
    ]);
    await expect(redirectOf(saveSeriesAction({}, form(edit)))).resolves.toBe(
      `${SERIES_URL}?notice=series_saved&count=2&started=1&closed=1&deadlinePassed=1&feeLocked=2:replace`,
    );
  });

  it('an unchanged version is "Nothing to change."', async () => {
    stubFetch([
      200,
      saved(2, {
        updated: 0,
        skipped: { edited: 0, started: 0, closed: 0, deadlinePassed: 0, feeLocked: 0 },
      }),
    ]);
    await expect(redirectOf(saveSeriesAction({}, form(edit)))).resolves.toBe(
      `${SERIES_URL}?notice=series_nothing_changed:replace`,
    );
  });

  it('a stale series reloads the edit form with the latest values and the stale banner', async () => {
    stubFetch([409, err('series_stale')]);
    await expect(redirectOf(saveSeriesAction({}, form(edit)))).resolves.toBe(
      `${SERIES_URL}?edit=details&notice=series_stale:replace`,
    );
  });

  it('a free-to-paid change that banking refuses saves nothing and shows the banking alert in place (T-5)', async () => {
    stubFetch([409, err('payout_not_configured')]);
    const result = await saveSeriesAction({}, form(edit));
    expect(result.error?.code).toBe('payout_not_configured');
  });

  it('an ended series reloads the series page with the ended notice', async () => {
    stubFetch([409, err('series_ended')]);
    await expect(redirectOf(saveSeriesAction({}, form(edit)))).resolves.toBe(
      `${SERIES_URL}?notice=series_already_ended:replace`,
    );
  });

  it('422 comes back in place with the API copy (shorten, fixed pattern)', async () => {
    stubFetch([
      422,
      err('validation_failed', {
        fieldErrors: { recurUntil: ['To stop the series sooner, use End series.'] },
      }),
    ]);
    const result = await saveSeriesAction({}, form(edit));
    expect(result.fieldErrors?.recurUntil).toEqual(['To stop the series sooner, use End series.']);
  });

  it('a rule id that is not a UUID is not_found with no API call', async () => {
    const fetchMock = stubFetch([200, saved(3)]);
    const result = await saveSeriesAction({}, form({ ...edit, ruleId: 'nope' }));
    expect(result.error?.code).toBe('not_found');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('endSeriesAction (AC-HAPPY-10; a ModerationAction)', () => {
  const fields = {
    teamId: TEAM_ID,
    ruleId: RULE_ID,
    expectedVersion: '2',
    lastDate: '2026-12-16',
  };
  const ended = (over = {}) => ({
    series: seriesFixture({ isActive: false, recurUntil: '2026-12-16' }),
    removedDrafts: 2,
    cancelledPublished: 3,
    keptOffPattern: [],
    activeRegistrationCount: 9,
    ...over,
  });

  it('POSTs the last date and the cancel flag, refreshes the series page and the list, and reports the counts', async () => {
    const fetchMock = stubFetch([200, ended()]);
    const result = await endSeriesAction(null, form({ ...fields, alsoCancelPublished: 'true' }));
    expect(result).toEqual({
      ok: true,
      message:
        'Series ended. No new sessions will be added after 16 Dec 2026. 3 sessions after that date were cancelled. 9 players were registered for them. Let them know.',
      refresh: true,
    });
    const call = callOf(fetchMock, 0);
    expect(call.url).toBe(`${API}/session-series/${RULE_ID}/end`);
    expect(call.body).toEqual({
      expectedVersion: 2,
      lastDate: '2026-12-16',
      alsoCancelPublished: true,
    });
    expect(mocks.revalidate).toHaveBeenCalledWith(SERIES_URL);
    expect(mocks.revalidate).toHaveBeenCalledWith(BASE);
  });

  it('an unticked box sends false and the message has no cancel line', async () => {
    const fetchMock = stubFetch([
      200,
      ended({ cancelledPublished: 0, activeRegistrationCount: 0 }),
    ]);
    const result = await endSeriesAction(null, form(fields));
    expect(callOf(fetchMock, 0).body).toMatchObject({ alsoCancelPublished: false });
    expect(result.message).toBe('Series ended. No new sessions will be added after 16 Dec 2026.');
  });

  it('a stale series closes the confirm with the stale text', async () => {
    stubFetch([409, err('series_stale')]);
    await expect(endSeriesAction(null, form(fields))).resolves.toEqual({
      ok: false,
      code: 'series_stale',
      message: STALE_SERIES,
      refresh: true,
      close: true,
    });
  });

  it('an already-ended series closes the confirm and refreshes to the ended state', async () => {
    stubFetch([409, err('series_ended')]);
    await expect(endSeriesAction(null, form(fields))).resolves.toMatchObject({
      ok: false,
      code: 'series_ended',
      message: 'This series has already ended.',
      refresh: true,
      close: true,
    });
  });

  it('a bad last date keeps the confirm open with the field error', async () => {
    stubFetch([
      422,
      err('validation_failed', { fieldErrors: { lastDate: ['Enter a valid date.'] } }),
    ]);
    await expect(endSeriesAction(null, form(fields))).resolves.toMatchObject({
      ok: false,
      message: 'Enter a valid date.',
      refresh: false,
      fieldErrors: { lastDate: ['Enter a valid date.'] },
    });
  });

  it('a 5xx says nothing changed and keeps the confirm open', async () => {
    stubFetch([500, err('internal_error')]);
    await expect(endSeriesAction(null, form(fields))).resolves.toMatchObject({
      ok: false,
      refresh: false,
      message: "We couldn't save that. Nothing was changed. Try again.",
    });
  });

  it('a malformed last date is refused before any call', async () => {
    const fetchMock = stubFetch([200, ended()]);
    const result = await endSeriesAction(null, form({ ...fields, lastDate: 'soon' }));
    expect(result).toMatchObject({ ok: false, message: 'Enter a valid date.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('publishDraftsAction (AC-ASYNC-7)', () => {
  const fields = { teamId: TEAM_ID, ruleId: RULE_ID };

  it('POSTs with no body and lands on the series page with the publishing notice', async () => {
    const fetchMock = stubFetch([202, { series: seriesFixture(), queued: true }]);
    await expect(redirectOf(publishDraftsAction(null, form(fields)))).resolves.toBe(
      `${SERIES_URL}?notice=publishing_drafts:replace`,
    );
    const call = callOf(fetchMock, 0);
    expect(call.url).toBe(`${API}/session-series/${RULE_ID}/publish-drafts`);
    expect(call.body).toBeUndefined();
  });

  it('a double click (queued false) is the same landing', async () => {
    stubFetch([202, { series: seriesFixture(), queued: false }]);
    await expect(redirectOf(publishDraftsAction(null, form(fields)))).resolves.toContain(
      'notice=publishing_drafts',
    );
  });

  it('an ended series lands on the ended state', async () => {
    stubFetch([409, err('series_ended')]);
    await expect(redirectOf(publishDraftsAction(null, form(fields)))).resolves.toBe(
      `${SERIES_URL}?notice=series_already_ended:replace`,
    );
  });

  it('a 5xx reports the outage in place', async () => {
    stubFetch([503, err('service_unavailable')]);
    await expect(publishDraftsAction(null, form(fields))).resolves.toMatchObject({
      ok: false,
      message: "We couldn't save that. Nothing was changed. Try again.",
    });
  });
});
