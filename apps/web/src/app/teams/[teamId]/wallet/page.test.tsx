import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEAM_ID, paymentRow, walletBody, PAYMENT_ID } from '../../../../lib/billing/fixtures.ts';

const mocks = vi.hoisted(() => ({
  teamDetail: vi.fn(),
  wallet: vi.fn(),
  teamMyPayments: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined }),
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  RedirectType: { replace: 'replace' },
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('../../../../lib/auth/session.ts', () => ({
  requireUser: () => Promise.resolve({ id: 'user-1' }),
}));
vi.mock('../../../../lib/auth/cookies.ts', () => ({
  readCookie: () => Promise.resolve('session-token'),
}));
vi.mock('../../../../lib/log.ts', () => ({
  log: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));
vi.mock('../../../../lib/api-client.ts', () => ({
  apiClient: {
    teamDetail: mocks.teamDetail,
    wallet: mocks.wallet,
    teamMyPayments: mocks.teamMyPayments,
  },
}));

const page = await import('./page.tsx');
const WalletPage = page.default;

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (status: number, code = 'internal_error') => ({
  ok: false as const,
  status,
  error: { code, message: 'x' },
});
const TEAM = ok({
  team: { id: TEAM_ID, name: 'Rosedale Badminton', memberCount: 12 },
  myStatus: 'APPROVED',
  myRole: 'MEMBER',
});
const payments = (rows: unknown[] = [], nextCursor: string | null = null) =>
  ok({ payments: rows, nextCursor });

async function render(
  query: Record<string, string> = {},
  results: { detail?: unknown; wallet?: unknown; payments?: unknown } = {},
  teamId = TEAM_ID,
): Promise<string> {
  mocks.teamDetail.mockResolvedValue(results.detail ?? TEAM);
  mocks.wallet.mockResolvedValue(results.wallet ?? ok(walletBody()));
  mocks.teamMyPayments.mockResolvedValue(results.payments ?? payments());
  const element = await WalletPage({
    params: Promise.resolve({ teamId }),
    searchParams: Promise.resolve(query),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  mocks.teamDetail.mockReset();
  mocks.wallet.mockReset();
  mocks.teamMyPayments.mockReset();
  mocks.warn.mockReset();
});

describe('wallet page: shell and sections (AC-ENTRY-1)', () => {
  it('is noindex and dynamic, with a team-named title, h1, back link and the three sections', async () => {
    expect(page.metadata).toMatchObject({ robots: { index: false } });
    expect(page.dynamic).toBe('force-dynamic');
    const html = await render();
    expect(html).toContain(
      '<title>Wallet and payments – Rosedale Badminton – Shared Game Management</title>',
    );
    expect(html).toContain('Wallet and payments for Rosedale Badminton</h1>');
    expect(html).toContain(`href="/teams/${TEAM_ID}"`);
    expect(html).toContain('Back to Rosedale Badminton');
    expect(html).toContain('id="wallet"');
    expect(html).toContain('id="payments"');
    expect(html).toContain('id="activity"');
  });

  it('empty: balance and the form, "No payments yet" and "No wallet activity yet"; the policy copy is shown (H3)', async () => {
    const html = await render();
    expect(html).toContain('Balance: $12.50');
    expect(html).toContain('Top up with Akahu');
    expect(html).toContain('No payments yet. Charges appear here after a game.');
    expect(html).toContain('No wallet activity yet.');
    expect(html).toContain(
      'Wallet credit can only be used for Rosedale Badminton&#x27;s game fees.',
    );
    expect(html).toContain('The money goes to Rosedale Badminton&#x27;s bank account.');
    expect(html).toMatch(
      /name="idempotencyKey"[^>]*value="[0-9a-f-]{36}"|value="[0-9a-f-]{36}"[^>]*name="idempotencyKey"/,
    );
  });

  it('asks the API for the cursor and the top-up id, and the team payments for this caller', async () => {
    const topUp = '44444444-4444-4444-8444-444444444444';
    await render({ cursor: 'abc', topUp });
    expect(mocks.wallet).toHaveBeenCalledWith(
      TEAM_ID,
      { cursor: 'abc', topUp },
      expect.objectContaining({ session: 'session-token' }),
    );
    expect(mocks.teamMyPayments).toHaveBeenCalledWith(
      TEAM_ID,
      {},
      expect.objectContaining({ session: 'session-token' }),
    );
  });

  it('ignores a malformed ?topUp= rather than sending it to the API', async () => {
    await render({ topUp: 'not-a-uuid' });
    expect(mocks.wallet).toHaveBeenCalledWith(TEAM_ID, {}, expect.anything());
  });
});

describe('wallet page: wallet states', () => {
  it('full: "Your wallet is full." and no form', async () => {
    const html = await render(
      {},
      { wallet: ok(walletBody({ balance: '100.00', headroom: '0.00' })) },
    );
    expect(html).toContain('Your wallet is full.');
    expect(html).not.toContain('Top up with Akahu');
  });

  it('pending top-up, player left Akahu: started line and "Continue with Akahu"', async () => {
    const pendingTopUp = {
      id: '44444444-4444-4444-8444-444444444444',
      amount: '30.00',
      status: 'OPEN',
      outcome: 'processing',
      createdAt: '2026-10-08T01:00:00.000Z',
    };
    const html = await render({}, { wallet: ok(walletBody({ pendingTopUp })) });
    expect(html).toContain('Continue with Akahu');
    expect(html).toContain('$30.00');
    expect(html).not.toContain('Top-up amount (NZD)');
  });

  it('processing after return (?topUp=<id>): the quiet refresh notice, no form', async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    const pendingTopUp = {
      id,
      amount: '30.00',
      status: 'OPEN',
      outcome: 'processing',
      createdAt: '2026-10-08T01:00:00.000Z',
    };
    const html = await render({ topUp: id }, { wallet: ok(walletBody({ pendingTopUp })) });
    expect(html).toContain('Processing your top-up. This usually takes under a minute.');
    expect(html).toContain(`href="/teams/${TEAM_ID}/wallet?topUp=${id}"`);
    expect(html).toContain('Refresh');
    expect(html).not.toContain('Top-up amount (NZD)');
  });

  it('B3: a top-up that arrived over the cap shows the overflow notice above the form', async () => {
    const lastClosedTopUp = {
      id: '44444444-4444-4444-8444-444444444444',
      amount: '30.00',
      status: 'UNAPPLIED',
      unappliedReason: 'OVER_CAP',
      closedAt: '2026-10-08T01:00:00.000Z',
    };
    const html = await render({}, { wallet: ok(walletBody({ lastClosedTopUp })) });
    expect(html).toContain(
      'Your top-up of $30.00 arrived but would have taken your wallet over $100.00',
    );
    expect(html).toContain('Top up with Akahu');
  });
});

describe('wallet page: payments and ledger', () => {
  it('groups payments Overdue / Pending / Paid with "Pay now" linking to the payment page', async () => {
    const html = await render(
      {},
      {
        payments: payments([
          paymentRow({ id: PAYMENT_ID, status: 'OVERDUE' }),
          paymentRow({
            id: '55555555-5555-4555-8555-555555555555',
            status: 'PAID',
            paidAt: '2026-10-08T01:00:00.000Z',
          }),
        ]),
      },
    );
    expect(html).toContain('>Overdue<');
    expect(html).toContain('>Paid<');
    expect(html).toContain(`href="/payments/${PAYMENT_ID}"`);
    expect(html).toContain('Overdue since Sat 10 Oct');
  });

  it('a failing payments read is contained: the wallet still renders with a line saying so', async () => {
    const html = await render({}, { payments: fail(503) });
    expect(html).toContain('Balance: $12.50');
    expect(html).toContain('We can&#x27;t load your payments right now.');
  });

  it('ledger rows with signed amounts and a "Show older activity" cursor link', async () => {
    const html = await render(
      {},
      {
        wallet: ok(
          walletBody(
            {},
            [
              {
                id: '66666666-6666-4666-8666-666666666666',
                type: 'TOPUP',
                amount: '30.00',
                resultingBalance: '30.00',
                createdAt: '2026-10-04T01:00:00.000Z',
                session: null,
              },
            ],
            'next-1',
          ),
        ),
      },
    );
    expect(html).toContain('+$30.00');
    expect(html).toContain('href="/teams/' + TEAM_ID + '/wallet?cursor=next-1"');
    expect(html).toContain('Show older activity');
  });
});

describe('wallet page: access and errors', () => {
  it.each([
    ['a non-member (403)', { wallet: fail(403, 'forbidden') }],
    ['an unknown team (404)', { wallet: fail(404, 'not_found') }],
    ['a malformed query (422)', { wallet: fail(422, 'validation_failed') }],
    [
      'a PENDING member',
      {
        detail: ok({
          team: { id: TEAM_ID, name: 'Rosedale Badminton', memberCount: 12 },
          myStatus: 'PENDING',
          myRole: null,
        }),
      },
    ],
  ])('%s gets the uniform not-found', async (_name, results) => {
    await expect(render({}, results)).rejects.toThrow('NOT_FOUND');
  });

  it('a malformed team id is not found without calling the API', async () => {
    await expect(render({}, {}, 'nope')).rejects.toThrow('NOT_FOUND');
    expect(mocks.wallet).not.toHaveBeenCalled();
  });

  it('401 sends the caller to session expiry, returning here', async () => {
    await expect(render({}, { wallet: fail(401, 'unauthorized') })).rejects.toThrow(
      /REDIRECT:.*session-expired/,
    );
  });

  it('a 5xx throws to the error boundary and logs status and code only', async () => {
    await expect(render({}, { wallet: fail(503) })).rejects.toThrow(/unavailable/);
    expect(mocks.warn).toHaveBeenCalledWith('web.teams.api_failure', {
      action: 'wallet_load',
      status: 503,
      code: 'internal_error',
    });
  });
});
