import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from './api-client.ts';

const TEAM = '7f3c2b1a-1111-4222-8333-444455556666';
const PAYMENT = '22222222-2222-4222-8222-222222222222';
const KEY = '2f6c1c1e-7a64-4c0e-9d61-3c1f0c1f0a11';
const OPTIONS = { session: 'tok' };

function stubJson(status: number, body: unknown) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(Response.json(body, { status })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const call = (fetchMock: ReturnType<typeof stubJson>) => ({
  url: fetchMock.mock.calls[0]?.[0],
  method: fetchMock.mock.calls[0]?.[1]?.method,
  body: fetchMock.mock.calls[0]?.[1]?.body as string | undefined,
  headers: (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>,
});

beforeEach(() => {
  vi.stubEnv('API_INTERNAL_URL', '');
  vi.stubEnv('API_INTERNAL_SHARED_SECRET', '');
  vi.stubEnv('WEB_TRUSTED_PROXY_HOPS', '');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const WALLET_BODY = {
  wallet: {
    balance: '12.50',
    cap: '100.00',
    headroom: '87.50',
    lowCreditThreshold: '20.00',
    pendingTopUp: null,
    lastClosedTopUp: null,
  },
  transactions: [],
  nextCursor: null,
};

describe('apiClient billing reads: exact paths, query strings, bearer', () => {
  it('wallet: GET /teams/:id/wallet with the cursor and topUp query, parsed with the shared schema', async () => {
    const fetchMock = stubJson(200, WALLET_BODY);
    const result = await apiClient.wallet(TEAM, { cursor: 'abc', topUp: PAYMENT }, OPTIONS);
    expect(call(fetchMock).url).toBe(
      `http://localhost:4000/teams/${TEAM}/wallet?cursor=abc&topUp=${PAYMENT}`,
    );
    expect(call(fetchMock).method).toBe('GET');
    expect(call(fetchMock).headers.authorization).toBe('Bearer tok');
    expect(result.ok && result.data.wallet.balance).toBe('12.50');
  });

  it('wallet: no query string when there is none; a hostile id is encoded into one path segment', async () => {
    const fetchMock = stubJson(200, WALLET_BODY);
    await apiClient.wallet('a/../b', {}, OPTIONS);
    expect(call(fetchMock).url).toBe('http://localhost:4000/teams/a%2F..%2Fb/wallet');
  });

  it('payment: GET /payments/:id; a body that is not the contract becomes an internal error, not a crash', async () => {
    const fetchMock = stubJson(200, { payment: { nope: true } });
    const result = await apiClient.payment(PAYMENT, OPTIONS);
    expect(call(fetchMock).url).toBe(`http://localhost:4000/payments/${PAYMENT}`);
    expect(result.ok).toBe(false);
  });

  it('myUnpaidPayments: GET /payments/me?status=UNPAID with an optional cursor', async () => {
    const fetchMock = stubJson(200, { teams: [], nextCursor: null });
    await apiClient.myUnpaidPayments({ cursor: 'c1' }, OPTIONS);
    expect(call(fetchMock).url).toBe('http://localhost:4000/payments/me?status=UNPAID&cursor=c1');
    const second = stubJson(200, { teams: [], nextCursor: null });
    await apiClient.myUnpaidPayments({}, OPTIONS);
    expect(call(second).url).toBe('http://localhost:4000/payments/me?status=UNPAID');
  });

  it('teamMyPayments and adminPayments: team-scoped paths with their queries', async () => {
    const mine = stubJson(200, { payments: [], nextCursor: null });
    await apiClient.teamMyPayments(TEAM, { cursor: 'c2' }, OPTIONS);
    expect(call(mine).url).toBe(`http://localhost:4000/teams/${TEAM}/payments/me?cursor=c2`);

    const admin = stubJson(200, { payments: [], nextCursor: null, payoutBlocked: false });
    const result = await apiClient.adminPayments(TEAM, { status: 'PAID', cursor: 'c3' }, OPTIONS);
    expect(call(admin).url).toBe(
      `http://localhost:4000/teams/${TEAM}/payments?status=PAID&cursor=c3`,
    );
    expect(result.ok && result.data.payoutBlocked).toBe(false);
  });
});

describe('apiClient billing writes', () => {
  it('startTopUp posts { amount, idempotencyKey } and parses the redirect URL', async () => {
    const fetchMock = stubJson(201, {
      topUp: { id: PAYMENT, amount: '20.00', status: 'OPEN' },
      redirectUrl: 'https://api.akahu.example/c/1',
    });
    const result = await apiClient.startTopUp(
      TEAM,
      { amount: '20.00', idempotencyKey: KEY },
      OPTIONS,
    );
    expect(call(fetchMock).url).toBe(`http://localhost:4000/teams/${TEAM}/wallet/top-ups`);
    expect(call(fetchMock).method).toBe('POST');
    expect(JSON.parse(call(fetchMock).body ?? '{}')).toEqual({
      amount: '20.00',
      idempotencyKey: KEY,
    });
    expect(result.ok && result.data.redirectUrl).toBe('https://api.akahu.example/c/1');
  });

  it('startAttempt, sendReminder, resolveHold and blockPayout use the openapi paths', async () => {
    const attempt = stubJson(201, { redirectUrl: 'https://api.akahu.example/c/2' });
    await apiClient.startAttempt(PAYMENT, { idempotencyKey: KEY }, OPTIONS);
    expect(call(attempt).url).toBe(`http://localhost:4000/payments/${PAYMENT}/attempts`);

    const reminder = stubJson(202, { sent: true, lastReminderAt: '2026-10-29T01:14:00.000Z' });
    await apiClient.sendReminder(TEAM, PAYMENT, { changeKey: KEY }, OPTIONS);
    expect(call(reminder).url).toBe(
      `http://localhost:4000/teams/${TEAM}/payments/${PAYMENT}/reminders`,
    );

    const hold = stubJson(200, {
      intentStatus: 'CLOSED',
      resolutionReason: 'NOT_RECEIVED_INDETERMINATE',
      resolvedAt: '2026-10-29T01:14:00.000Z',
    });
    await apiClient.resolveHold(PAYMENT, { outcome: 'NOT_RECEIVED', changeKey: KEY }, OPTIONS);
    expect(call(hold).url).toBe(`http://localhost:4000/payments/${PAYMENT}/hold-resolution`);

    const block = stubJson(200, {
      payoutBlockedAt: '2026-10-29T01:14:00.000Z',
      alreadyBlocked: false,
    });
    await apiClient.blockPayout(TEAM, { reason: 'OTHER', changeKey: KEY }, OPTIONS);
    expect(call(block).url).toBe(`http://localhost:4000/teams/${TEAM}/payout-block`);
  });
});

describe('apiClient: the intent start routes keep what only they add to an error body', () => {
  it('exposes the resume link on a 409 and the stable refusal reason on a 422', async () => {
    stubJson(409, {
      error: {
        code: 'payment_in_progress',
        message: 'x',
        resume: { redirectUrl: 'https://api.akahu.example/c/9', topUp: null },
      },
    });
    const conflict = await apiClient.startAttempt(PAYMENT, { idempotencyKey: KEY }, OPTIONS);
    expect(!conflict.ok && conflict.resume).toEqual({
      redirectUrl: 'https://api.akahu.example/c/9',
      topUp: null,
    });

    stubJson(422, {
      error: { code: 'payment_provider_refused', message: 'x', reason: 'payee_unusable' },
    });
    const refused = await apiClient.startAttempt(PAYMENT, { idempotencyKey: KEY }, OPTIONS);
    expect(!refused.ok && refused.refusalReason).toBe('payee_unusable');
  });

  it('drops a malformed extra without hiding the error code', async () => {
    stubJson(409, {
      error: { code: 'payment_in_progress', message: 'x', resume: { redirectUrl: 42 } },
    });
    const result = await apiClient.startAttempt(PAYMENT, { idempotencyKey: KEY }, OPTIONS);
    expect(!result.ok && result.error.code).toBe('payment_in_progress');
    expect(!result.ok && result.resume).toBeUndefined();
  });
});
