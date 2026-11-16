import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PAYMENT_ID,
  SESSION_AT,
  TEAM_ID,
  paymentRow,
  unpaidBody,
  walletBody,
} from '../../lib/billing/fixtures.ts';
import {
  TEAM_A,
  TEAM_B,
  openBody,
  openRow,
  registrationRow,
  registrationsBody,
} from '../../lib/dashboard/fixtures.ts';

const mocks = vi.hoisted(() => ({
  openSessions: vi.fn(),
  myRegistrations: vi.fn(),
  myUnpaidPayments: vi.fn(),
  myPaidPayments: vi.fn(),
  mineTeams: vi.fn(),
  wallet: vi.fn(),
  startTopUp: vi.fn(),
  startAttempt: vi.fn(),
  warn: vi.fn(),
  requireUser: vi.fn(),
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
vi.mock('../../lib/auth/session.ts', () => ({ requireUser: mocks.requireUser }));
vi.mock('../../lib/auth/cookies.ts', () => ({
  readCookie: () => Promise.resolve('session-token'),
}));
vi.mock('../../lib/log.ts', () => ({ log: { info: vi.fn(), warn: mocks.warn, error: vi.fn() } }));
vi.mock('../../lib/api-client.ts', () => ({
  apiClient: {
    openSessions: mocks.openSessions,
    myRegistrations: mocks.myRegistrations,
    myUnpaidPayments: mocks.myUnpaidPayments,
    myPaidPayments: mocks.myPaidPayments,
    mineTeams: mocks.mineTeams,
    wallet: mocks.wallet,
    startTopUp: mocks.startTopUp,
    startAttempt: mocks.startAttempt,
  },
}));

const page = await import('./page.tsx');
const DashboardPage = page.default;

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (status: number, code = 'internal_error') => ({
  ok: false as const,
  status,
  error: { code, message: 'secret detail' },
});
const mine = (...teams: { id: string; name: string; status: string }[]) =>
  ok({ teams: teams.map((team) => ({ ...team, visibility: 'PUBLIC', role: 'PLAYER' })) });

async function render(query: Record<string, string | string[]> = {}): Promise<string> {
  return renderToStaticMarkup(await DashboardPage({ searchParams: Promise.resolve(query) }));
}
const redirectOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: Error) => error.message,
  );

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireUser.mockResolvedValue({ id: 'user-1' });
  mocks.openSessions.mockResolvedValue(ok(openBody([openRow()])));
  mocks.myRegistrations.mockResolvedValue(ok(registrationsBody([registrationRow()])));
  mocks.myUnpaidPayments.mockResolvedValue(ok(unpaidBody([])));
  mocks.myPaidPayments.mockResolvedValue(ok(unpaidBody([])));
  mocks.mineTeams.mockResolvedValue(
    mine({ id: TEAM_A, name: 'Rosedale Badminton', status: 'APPROVED' }),
  );
  mocks.wallet.mockResolvedValue(ok(walletBody()));
});

describe('/dashboard shell (AC-ENTRY-1, AC-ENTRY-2)', () => {
  it('is noindex, dynamic, titled and has the h1 Dashboard with the nav, on Currently Opening by default', async () => {
    expect(page.metadata).toMatchObject({ robots: { index: false } });
    expect(page.dynamic).toBe('force-dynamic');
    const out = await render();
    expect(out).toContain('<title>Dashboard – Shared Game Management</title>');
    expect(out).toContain('Dashboard</h1>');
    expect(out).toMatch(/aria-current="page"[^>]*>Currently Opening</);
    expect(out).toContain('Rosedale Hall');
  });

  it('an unknown or array tab renders Currently Opening and loads only that tab’s data', async () => {
    for (const tab of ['bogus', ['bogus', 'payments']]) {
      const out = await render({ tab });
      expect(out).toMatch(/aria-current="page"[^>]*>Currently Opening</);
    }
    expect(mocks.myRegistrations).not.toHaveBeenCalled();
    expect(mocks.myUnpaidPayments).not.toHaveBeenCalled();
    expect(mocks.wallet).not.toHaveBeenCalled();
  });

  it('the registrations tab loads only registrations; the payments tab never starts a payment', async () => {
    const regs = await render({ tab: 'registrations' });
    expect(regs).toMatch(/aria-current="page"[^>]*>My Registration</);
    expect(mocks.openSessions).not.toHaveBeenCalled();
    mocks.wallet.mockResolvedValue(ok(walletBody()));
    const pay = await render({ tab: 'payments' });
    expect(pay).toMatch(/aria-current="page"[^>]*>Payments &amp; Wallet</);
    expect(mocks.wallet).toHaveBeenCalledWith(TEAM_A, {}, expect.anything());
    expect(mocks.startTopUp).not.toHaveBeenCalled();
    expect(mocks.startAttempt).not.toHaveBeenCalled();
  });
});

describe('/dashboard guards (AC-ENTRY-3, AC-ERROR-1)', () => {
  it('a dead cookie redirects through sessionExpiredUrl with the tab preserved', async () => {
    mocks.requireUser.mockRejectedValue(
      new Error('REDIRECT:/auth/session-expired?returnTo=%2Fdashboard%3Ftab%3Dpayments'),
    );
    expect(await redirectOf(render({ tab: 'payments' }))).toContain('session-expired');
    expect(mocks.requireUser).toHaveBeenCalledWith('/dashboard?tab=payments');
  });

  it('a 401 from any read redirects to sessionExpiredUrl(here), keeping the tab', async () => {
    mocks.myRegistrations.mockResolvedValue(fail(401, 'unauthorized'));
    expect(await redirectOf(render({ tab: 'registrations' }))).toBe(
      'REDIRECT:/auth/session-expired?returnTo=%2Fdashboard%3Ftab%3Dregistrations',
    );
    mocks.wallet.mockResolvedValue(fail(401, 'unauthorized'));
    expect(await redirectOf(render({ tab: 'payments' }))).toBe(
      'REDIRECT:/auth/session-expired?returnTo=%2Fdashboard%3Ftab%3Dpayments',
    );
  });

  it('a 5xx or unreachable read degrades only its section and logs action, status and code only', async () => {
    mocks.openSessions.mockResolvedValue(fail(503, 'service_unavailable'));
    const open = await render();
    expect(open).toContain('We can&#x27;t load sessions right now. Try again in a minute.');
    expect(open).toContain('<nav aria-label="Dashboard">');
    mocks.myRegistrations.mockResolvedValue(fail(0, 'service_unavailable'));
    expect(await render({ tab: 'registrations' })).toContain('load your registrations right now');
    expect(mocks.warn).toHaveBeenCalledWith('web.dashboard.api_failure', {
      action: 'open_sessions',
      status: 503,
      code: 'service_unavailable',
    });
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('secret detail');
  });

  it('Payments: a failed wallet fails one card, a failed payments read replaces the accordions', async () => {
    mocks.mineTeams.mockResolvedValue(
      mine(
        { id: TEAM_A, name: 'Rosedale Badminton', status: 'APPROVED' },
        { id: TEAM_B, name: 'Albany Smashers', status: 'APPROVED' },
        { id: TEAM_ID, name: 'Pending Team', status: 'PENDING' },
      ),
    );
    mocks.wallet.mockImplementation((teamId: string) =>
      Promise.resolve(teamId === TEAM_B ? fail(500) : ok(walletBody())),
    );
    mocks.myPaidPayments.mockResolvedValue(fail(500));
    const out = await render({ tab: 'payments' });
    expect(out).toContain('We can&#x27;t load this wallet right now. Try again in a minute.');
    expect(out).toContain('Balance: $12.50');
    expect(out).toContain('We can&#x27;t load your payments right now.');
    expect(out).not.toContain('Pending Team');
    expect(mocks.wallet).toHaveBeenCalledTimes(2);
  });
});

describe('/dashboard empty and query handling (AC-ERROR-4, AC-ERROR-6)', () => {
  it('Currently Opening: no approved team versus no open session', async () => {
    mocks.openSessions.mockResolvedValue(ok(openBody([])));
    mocks.mineTeams.mockResolvedValue(mine({ id: TEAM_A, name: 'X', status: 'PENDING' }));
    expect(await render()).toContain('Join a team to see its open sessions here.');
    mocks.mineTeams.mockResolvedValue(mine({ id: TEAM_A, name: 'X', status: 'APPROVED' }));
    expect(await render()).toContain('No sessions are open for registration right now.');
  });

  it('a registrations cursor the API refuses (422) falls back to the first page, no 500', async () => {
    mocks.myRegistrations.mockImplementation((query: { cursor?: string }) =>
      Promise.resolve(
        query.cursor === undefined
          ? ok(registrationsBody([registrationRow()]))
          : fail(422, 'invalid_cursor'),
      ),
    );
    const out = await render({ tab: 'registrations', cursor: 'garbage' });
    expect(out).toContain('Rosedale Hall');
    expect(mocks.myRegistrations).toHaveBeenCalledTimes(2);
  });

  it('paidCursor and unpaidCursor go to their own reads; a refused one is retried without it', async () => {
    mocks.myPaidPayments.mockImplementation((query: { cursor?: string }) =>
      Promise.resolve(
        query.cursor === undefined ? ok(unpaidBody([])) : fail(422, 'invalid_cursor'),
      ),
    );
    mocks.myUnpaidPayments.mockResolvedValue(
      ok(
        unpaidBody([
          { teamId: TEAM_ID, teamName: 'Rosedale', payments: [paymentRow({ id: PAYMENT_ID })] },
        ]),
      ),
    );
    const out = await render({ tab: 'payments', paidCursor: 'bad', unpaidCursor: 'U1' });
    expect(mocks.myUnpaidPayments).toHaveBeenCalledWith({ cursor: 'U1' }, expect.anything());
    expect(mocks.myPaidPayments).toHaveBeenCalledTimes(2);
    expect(out).toContain('Pending (1)');
  });

  it('an overlong cursor parameter is ignored and never sent', async () => {
    await render({ tab: 'registrations', cursor: 'x'.repeat(600) });
    expect(mocks.myRegistrations).toHaveBeenCalledWith({}, expect.anything());
  });
});

describe('/dashboard Payments & Wallet notice and async states (AC-ERROR-3, AC-ASYNC-1)', () => {
  it('renders the download error notice for the code in the URL, accordions intact', async () => {
    mocks.myUnpaidPayments.mockResolvedValue(
      ok(
        unpaidBody([
          { teamId: TEAM_A, teamName: 'Rosedale', payments: [paymentRow({ status: 'OVERDUE' })] },
        ]),
      ),
    );
    const out = await render({ tab: 'payments', download_error: 'invoice_pending' });
    expect(out).toContain('role="alert"');
    expect(out).toContain('Overdue (1)');
  });

  it('shows an open top-up honestly and does not poll or refresh', async () => {
    mocks.wallet.mockResolvedValue(
      ok(
        walletBody({
          pendingTopUp: {
            id: PAYMENT_ID,
            amount: '20.00',
            outcome: 'processing',
            createdAt: SESSION_AT,
          },
        }),
      ),
    );
    const out = await render({ tab: 'payments' });
    expect(out).toContain('Top-up of $20.00 started Wed 7 Oct, 8:00 pm.');
    expect(out).not.toMatch(/http-equiv="refresh"|RefreshWhilePending/);
  });
});
