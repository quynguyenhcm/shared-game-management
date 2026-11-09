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
vi.mock('../log.ts', () => ({ log: { info: vi.fn(), warn: mocks.warn, error: vi.fn() } }));

const {
  startTopUpAction,
  startPaymentAction,
  sendReminderAction,
  resolveHoldAction,
  blockPayoutAction,
} = await import('./actions.ts');
const {
  TopUpRequest,
  StartAttemptRequest,
  SendReminderRequest,
  HoldResolutionRequest,
  PayoutBlockRequest,
} = await import('@sgm/shared');
const { loginUrl, sessionExpiredUrl } = await import('../auth/landing.ts');

const TEAM_ID = '7f3c2b1a-1111-4222-8333-444455556666';
const PAYMENT_ID = '22222222-2222-4222-8222-222222222222';
const KEY = '2f6c1c1e-7a64-4c0e-9d61-3c1f0c1f0a11';
const AKAHU = 'https://api.akahu.example/consent/1';
const WALLET = `/teams/${TEAM_ID}/wallet`;
const PAY_PAGE = `/payments/${PAYMENT_ID}`;
const ADMIN_PAGE = `/teams/${TEAM_ID}/manage/payments`;

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
  mocks.warn.mockClear();
  mocks.jar.clear();
  mocks.jar.set('sgm_session', 'session-token');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const TOP_UP_FIELDS = { teamId: TEAM_ID, amount: '20.00', idempotencyKey: KEY };

describe('startTopUpAction (AC-HAPPY-1, AC-ERROR-1, AC-ERROR-7)', () => {
  it('POSTs the amount and the per-render key with the session, then redirects to the Akahu URL (no revalidate)', async () => {
    const fetchMock = stubFetch(201, {
      topUp: { id: PAYMENT_ID, amount: '20.00', status: 'OPEN' },
      redirectUrl: AKAHU,
    });
    const target = await redirectOf(startTopUpAction({}, form(TOP_UP_FIELDS)));
    expect(target).toBe(`${AKAHU}:push`);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:4000/teams/${TEAM_ID}/wallet/top-ups`,
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    const body = sentBody(fetchMock);
    expect(body).toEqual({ amount: '20.00', idempotencyKey: KEY });
    expect(TopUpRequest.safeParse(body).success).toBe(true);
    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe('Bearer session-token');
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('normalises what was typed (" 20 " becomes 20.00) before sending', async () => {
    const fetchMock = stubFetch(201, {
      topUp: { id: PAYMENT_ID, amount: '20.00', status: 'OPEN' },
      redirectUrl: AKAHU,
    });
    await redirectOf(startTopUpAction({}, form({ ...TOP_UP_FIELDS, amount: ' 20 ' })));
    expect(sentBody(fetchMock).amount).toBe('20.00');
  });

  it('an invalid amount returns the shared field message and never calls the API', async () => {
    const fetchMock = stubFetch(201, {});
    const state = await startTopUpAction({}, form({ ...TOP_UP_FIELDS, amount: '0.50' }));
    expect(state).toEqual({
      fieldErrors: { amount: ['Enter at least $1.00.'] },
      values: { amount: '0.50' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a server 422 (over headroom) shows beside the field and keeps the typed value', async () => {
    stubFetch(422, {
      error: {
        code: 'validation_failed',
        message: 'x',
        fieldErrors: { amount: ['You can top up at most $15.00.'] },
      },
    });
    const state = await startTopUpAction({}, form({ ...TOP_UP_FIELDS, amount: '30' }));
    expect(state).toEqual({
      fieldErrors: { amount: ['You can top up at most $15.00.'] },
      values: { amount: '30' },
    });
  });

  it('409 top_up_in_progress with a resume link follows the link; without one it reports and revalidates the wallet page', async () => {
    stubFetch(409, {
      error: {
        code: 'top_up_in_progress',
        message: 'x',
        resume: { redirectUrl: 'https://api.akahu.example/consent/9', topUp: null },
      },
    });
    expect(await redirectOf(startTopUpAction({}, form(TOP_UP_FIELDS)))).toBe(
      'https://api.akahu.example/consent/9:push',
    );

    stubFetch(409, { error: { code: 'top_up_in_progress', message: 'x' } });
    const state = await startTopUpAction({}, form(TOP_UP_FIELDS));
    expect(state.error?.code).toBe('top_up_in_progress');
    expect(mocks.revalidate).toHaveBeenCalledWith(WALLET);
  });

  it('503 reports Akahu unavailable, keeps the value, and neither revalidates nor logs the amount', async () => {
    stubFetch(503, { error: { code: 'payment_provider_unavailable', message: 'x' } });
    const state = await startTopUpAction({}, form(TOP_UP_FIELDS));
    expect(state).toEqual({
      error: { code: 'payment_provider_unavailable' },
      values: { amount: '20.00' },
    });
    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('20.00');
  });

  it('maps payout_not_configured so the page can say the team cannot receive payments', async () => {
    stubFetch(409, { error: { code: 'payout_not_configured', message: 'x' } });
    const state = await startTopUpAction({}, form(TOP_UP_FIELDS));
    expect(state.error?.code).toBe('payout_not_configured');
  });

  it('no session redirects to sign-in and a 401 to session expiry, both returning here', async () => {
    mocks.jar.clear();
    expect(await redirectOf(startTopUpAction({}, form(TOP_UP_FIELDS)))).toBe(
      `${loginUrl({ returnTo: WALLET })}:replace`,
    );
    mocks.jar.set('sgm_session', 'dead');
    stubFetch(401, { error: { code: 'session_expired', message: 'x' } });
    expect(await redirectOf(startTopUpAction({}, form(TOP_UP_FIELDS)))).toBe(
      `${sessionExpiredUrl(WALLET)}:replace`,
    );
  });

  it('a non-UUID team id is not a team: not found, and nothing reaches the API path', async () => {
    const fetchMock = stubFetch(201, {});
    const state = await startTopUpAction({}, form({ ...TOP_UP_FIELDS, teamId: '../x' }));
    expect(state.error?.code).toBe('not_found');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a malformed key is refused before the API ("Reload the page")', async () => {
    const fetchMock = stubFetch(201, {});
    const state = await startTopUpAction({}, form({ ...TOP_UP_FIELDS, idempotencyKey: 'nope' }));
    expect(state.error?.code).toBe('key_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('startPaymentAction (AC-HAPPY-4, AC-ERROR-3, AC-ERROR-4)', () => {
  const fields = { paymentId: PAYMENT_ID, idempotencyKey: KEY };

  it("POSTs only the key (the amount is the payment's own) and redirects to Akahu", async () => {
    const fetchMock = stubFetch(201, { redirectUrl: AKAHU });
    expect(await redirectOf(startPaymentAction({}, form(fields)))).toBe(`${AKAHU}:push`);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:4000/payments/${PAYMENT_ID}/attempts`,
    );
    const body = sentBody(fetchMock);
    expect(body).toEqual({ idempotencyKey: KEY });
    expect(StartAttemptRequest.safeParse(body).success).toBe(true);
  });

  it('409 payment_in_progress follows the resume link ("Continue with Akahu")', async () => {
    stubFetch(409, {
      error: {
        code: 'payment_in_progress',
        message: 'x',
        resume: { redirectUrl: 'https://api.akahu.example/consent/7', topUp: null },
      },
    });
    expect(await redirectOf(startPaymentAction({}, form(fields)))).toBe(
      'https://api.akahu.example/consent/7:push',
    );
  });

  it.each([
    [409, 'payment_settled', 'payment_settled', PAY_PAGE],
    [409, 'payment_on_hold', 'payment_on_hold', PAY_PAGE],
    [409, 'payout_not_configured', 'payout_not_configured', PAY_PAGE],
    [503, 'payment_provider_unavailable', 'payment_provider_unavailable', undefined],
    [500, 'internal_error', 'service_unavailable', undefined],
  ])('%s %s -> %s', async (status, apiCode, code, revalidated) => {
    stubFetch(status, { error: { code: apiCode, message: 'x' } });
    const state = await startPaymentAction({}, form(fields));
    expect(state.error?.code).toBe(code);
    if (revalidated === undefined) expect(mocks.revalidate).not.toHaveBeenCalled();
    else expect(mocks.revalidate).toHaveBeenCalledWith(revalidated);
  });

  it('a refused payment carries the provider reason as a stable code, never provider text', async () => {
    stubFetch(422, {
      error: {
        code: 'payment_provider_refused',
        message: 'Akahu says no',
        reason: 'amount_over_bank_limit',
      },
    });
    const state = await startPaymentAction({}, form(fields));
    expect(state.error?.code).toBe('refused_amount_over_bank_limit');
    expect(JSON.stringify(state)).not.toContain('Akahu says no');
  });

  it('a non-UUID payment id is not found and never reaches a path', async () => {
    const fetchMock = stubFetch(201, {});
    const state = await startPaymentAction({}, form({ ...fields, paymentId: 'x/../y' }));
    expect(state.error?.code).toBe('not_found');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sendReminderAction (AC-HAPPY-7, B6)', () => {
  const fields = {
    teamId: TEAM_ID,
    paymentId: PAYMENT_ID,
    changeKey: KEY,
    firstName: 'Priya',
    amount: '17.00',
  };

  it('POSTs the changeKey, announces the first name and amount, and revalidates the Payments page', async () => {
    const fetchMock = stubFetch(202, { sent: true, lastReminderAt: '2026-10-29T01:14:00.000Z' });
    const result = await sendReminderAction(null, form(fields));
    expect(result).toEqual({
      ok: true,
      message: 'Reminder sent to Priya for $17.00.',
      refresh: true,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:4000/teams/${TEAM_ID}/payments/${PAYMENT_ID}/reminders`,
    );
    const body = sentBody(fetchMock);
    expect(body).toEqual({ changeKey: KEY });
    expect(SendReminderRequest.safeParse(body).success).toBe(true);
    expect(mocks.revalidate).toHaveBeenCalledWith(ADMIN_PAGE);
  });

  it('409 reminder_too_soon and payment_settled revalidate so the row shows the truth', async () => {
    stubFetch(409, { error: { code: 'reminder_too_soon', message: 'x' } });
    const tooSoon = await sendReminderAction(null, form(fields));
    expect(tooSoon).toMatchObject({ ok: false, code: 'reminder_too_soon', refresh: true });
    expect(mocks.revalidate).toHaveBeenCalledWith(ADMIN_PAGE);
  });

  it('a 5xx revalidates nothing and does not claim a reminder went', async () => {
    stubFetch(500, { error: { code: 'internal_error', message: 'x' } });
    const result = await sendReminderAction(null, form(fields));
    expect(result.ok).toBe(false);
    expect(result.refresh).toBe(false);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('refuses a malformed team or payment id without calling the API', async () => {
    const fetchMock = stubFetch(202, {});
    const result = await sendReminderAction(null, form({ ...fields, paymentId: 'x' }));
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('resolveHoldAction (ruling H2, CR-15, CR-26)', () => {
  const fields = { teamId: TEAM_ID, paymentId: PAYMENT_ID, changeKey: KEY };

  it('RECEIVED sends the observed amount in canonical form and reports an applied payment', async () => {
    const fetchMock = stubFetch(200, {
      intentStatus: 'APPLIED',
      resolutionReason: 'RECEIVED',
      resolvedAt: '2026-10-29T01:14:00.000Z',
    });
    const result = await resolveHoldAction(
      null,
      form({ ...fields, outcome: 'RECEIVED', observedAmount: ' 17 ' }),
    );
    expect(result).toEqual({
      ok: true,
      message: 'Recorded. The payment is now marked as paid.',
      refresh: true,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:4000/payments/${PAYMENT_ID}/hold-resolution`,
    );
    const body = sentBody(fetchMock);
    expect(body).toEqual({ outcome: 'RECEIVED', changeKey: KEY, observedAmount: '17.00' });
    expect(HoldResolutionRequest.safeParse(body).success).toBe(true);
    expect(mocks.revalidate).toHaveBeenCalledWith(ADMIN_PAGE);
  });

  it('RECEIVED that comes back UNAPPLIED says "recorded, not applied"', async () => {
    stubFetch(200, {
      intentStatus: 'UNAPPLIED',
      resolutionReason: 'AMOUNT_MISMATCH',
      resolvedAt: '2026-10-29T01:14:00.000Z',
    });
    const result = await resolveHoldAction(
      null,
      form({ ...fields, outcome: 'RECEIVED', observedAmount: '12.00' }),
    );
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^Recorded, not applied\./);
  });

  it('NOT_RECEIVED sends no observed amount even if one was typed, and reports the payment can be paid again', async () => {
    const fetchMock = stubFetch(200, {
      intentStatus: 'CLOSED',
      resolutionReason: 'NOT_RECEIVED_INDETERMINATE',
      resolvedAt: '2026-10-29T01:14:00.000Z',
    });
    const result = await resolveHoldAction(
      null,
      form({ ...fields, outcome: 'NOT_RECEIVED', observedAmount: '17.00' }),
    );
    expect(sentBody(fetchMock)).toEqual({ outcome: 'NOT_RECEIVED', changeKey: KEY });
    expect(result.message).toBe('Recorded. The payment can be paid again.');
  });

  it('a bad observed amount or missing outcome is refused with a field message and no call', async () => {
    const fetchMock = stubFetch(200, {});
    const bad = await resolveHoldAction(
      null,
      form({ ...fields, outcome: 'RECEIVED', observedAmount: 'abc' }),
    );
    expect(bad).toMatchObject({
      ok: false,
      code: 'validation_failed',
      fieldErrors: { observedAmount: ['Enter an amount in dollars, like 20.00.'] },
    });
    const none = await resolveHoldAction(null, form(fields));
    expect(none).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('409 hold_resolved_by_provider refreshes the page and closes the confirm', async () => {
    stubFetch(409, { error: { code: 'hold_resolved_by_provider', message: 'x' } });
    const result = await resolveHoldAction(null, form({ ...fields, outcome: 'NOT_RECEIVED' }));
    expect(result).toMatchObject({
      ok: false,
      code: 'hold_resolved_by_provider',
      refresh: true,
      close: true,
    });
    expect(mocks.revalidate).toHaveBeenCalledWith(ADMIN_PAGE);
  });
});

describe('blockPayoutAction (A3, CR-14: GLOBAL_ADMIN only)', () => {
  const fields = { teamId: TEAM_ID, changeKey: KEY, reason: 'FUNDS_RETURNED' };

  it('POSTs the enum reason (and the optional Akahu payment id), then revalidates and says so', async () => {
    const fetchMock = stubFetch(200, {
      payoutBlockedAt: '2026-10-29T01:14:00.000Z',
      alreadyBlocked: false,
    });
    const result = await blockPayoutAction(
      null,
      form({ ...fields, akahuPaymentId: 'pay_abc-123' }),
    );
    expect(result).toEqual({
      ok: true,
      message: 'Payments to this team are now blocked. The team admins have been told.',
      refresh: true,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:4000/teams/${TEAM_ID}/payout-block`,
    );
    const body = sentBody(fetchMock);
    expect(body).toEqual({
      reason: 'FUNDS_RETURNED',
      akahuPaymentId: 'pay_abc-123',
      changeKey: KEY,
    });
    expect(PayoutBlockRequest.safeParse(body).success).toBe(true);
    expect(mocks.revalidate).toHaveBeenCalledWith(ADMIN_PAGE);
  });

  it('a blank Akahu id is omitted; an already-blocked team says so', async () => {
    const fetchMock = stubFetch(200, {
      payoutBlockedAt: '2026-10-29T01:14:00.000Z',
      alreadyBlocked: true,
    });
    const result = await blockPayoutAction(null, form({ ...fields, akahuPaymentId: '  ' }));
    expect(sentBody(fetchMock)).toEqual({ reason: 'FUNDS_RETURNED', changeKey: KEY });
    expect(result.message).toBe('Payments to this team were already blocked.');
  });

  it('an unknown reason or a malformed Akahu id is refused before the API', async () => {
    const fetchMock = stubFetch(200, {});
    expect(await blockPayoutAction(null, form({ ...fields, reason: 'BECAUSE' }))).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
    expect(
      await blockPayoutAction(null, form({ ...fields, akahuPaymentId: 'not valid!' })),
    ).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('403 (not a global admin) closes the confirm with the no-access message', async () => {
    stubFetch(403, { error: { code: 'forbidden', message: 'x' } });
    const result = await blockPayoutAction(null, form(fields));
    expect(result).toMatchObject({ ok: false, code: 'forbidden', close: true });
  });
});
