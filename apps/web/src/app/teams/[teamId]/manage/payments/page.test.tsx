import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEAM_ID, adminBody, adminRow } from '../../../../../lib/billing/fixtures.ts';

const mocks = vi.hoisted(() => ({
  teamDetail: vi.fn(),
  adminPayments: vi.fn(),
  user: vi.fn(),
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
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('../../../../../lib/auth/session.ts', () => ({
  requireUser: () => Promise.resolve(mocks.user() as unknown),
}));
vi.mock('../../../../../lib/auth/cookies.ts', () => ({
  readCookie: () => Promise.resolve('session-token'),
}));
vi.mock('../../../../../lib/log.ts', () => ({
  log: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));
vi.mock('../../../../../lib/api-client.ts', () => ({
  apiClient: { teamDetail: mocks.teamDetail, adminPayments: mocks.adminPayments },
}));

const page = await import('./page.tsx');
const PaymentsPage = page.default;

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (status: number, code = 'internal_error') => ({
  ok: false as const,
  status,
  error: { code, message: 'x' },
});
const team = (myStatus: string | null, myRole: string | null) =>
  ok({
    team: { id: TEAM_ID, name: 'Rosedale Badminton', memberCount: 12 },
    myStatus,
    myRole,
  });
const TEAM_ADMIN = team('APPROVED', 'TEAM_ADMIN');

async function render(
  query: Record<string, string> = {},
  results: { detail?: unknown; payments?: unknown; role?: string } = {},
  teamId = TEAM_ID,
): Promise<string> {
  mocks.user.mockResolvedValue({ id: 'user-1', role: results.role ?? 'PLAYER' });
  mocks.teamDetail.mockResolvedValue(results.detail ?? TEAM_ADMIN);
  mocks.adminPayments.mockResolvedValue(results.payments ?? ok(adminBody([adminRow()])));
  const element = await PaymentsPage({
    params: Promise.resolve({ teamId }),
    searchParams: Promise.resolve(query),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  mocks.teamDetail.mockReset();
  mocks.adminPayments.mockReset();
  mocks.user.mockReset();
  mocks.warn.mockReset();
});

describe('Payments manage area: shell, nav and filter (AC-ENTRY-3)', () => {
  it('is noindex and dynamic; h1, intro, nav with Payments current, the status region', async () => {
    expect(page.metadata).toMatchObject({ robots: { index: false } });
    expect(page.dynamic).toBe('force-dynamic');
    const html = await render();
    expect(html).toContain('<title>Payments – Rosedale Badminton – Shared Game Management</title>');
    expect(html).toContain('Payments for Rosedale Badminton</h1>');
    expect(html).toContain('People who still owe a game fee are listed here. We show names only.');
    expect(/<a[^>]*aria-current="page"[^>]*>([^<]*)</.exec(html)?.[1]).toBe('Payments');
    expect(html).toContain('People');
    expect(html).toContain('id="payments-status"');
  });

  it('defaults to Unpaid; the filter links mark the current one and ?status= maps to the API', async () => {
    const html = await render();
    expect(mocks.adminPayments).toHaveBeenCalledWith(
      TEAM_ID,
      { status: 'UNPAID' },
      expect.objectContaining({ session: 'session-token' }),
    );
    expect(html).toContain('aria-label="Filter payments"');
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(/<a[^>]*aria-current="true"[^>]*>([^<]*)</.exec(html)?.[1]).toBe('Unpaid');
    expect(html).toContain('?status=paid');
    expect(html).toContain('?status=all');
    await render({ status: 'paid', cursor: 'c1' });
    expect(mocks.adminPayments).toHaveBeenLastCalledWith(
      TEAM_ID,
      { status: 'PAID', cursor: 'c1' },
      expect.anything(),
    );
    await render({ status: 'all' });
    expect(mocks.adminPayments).toHaveBeenLastCalledWith(
      TEAM_ID,
      { status: 'ALL' },
      expect.anything(),
    );
  });
});

describe('Payments manage area: table, reminders, holds, payout block, empty, paging', () => {
  it('lists names only with a "Send reminder" per unpaid row', async () => {
    const html = await render();
    expect(html).toContain('Priya Shah');
    expect(html).toContain('Send reminder');
    expect(html).toContain('No reminder yet');
    expect(html).not.toContain('@');
  });

  it('a held row gets the hold resolution (team admins, H2) and no reminder', async () => {
    const html = await render({}, { payments: ok(adminBody([adminRow({ onHold: true })])) });
    expect(html).toContain('Under review');
    expect(html).toContain('Record what happened');
    expect(html).not.toContain('Send reminder');
  });

  it('PayoutBlockConfirm is for GLOBAL_ADMIN only', async () => {
    expect(await render({}, { role: 'PLAYER' })).not.toContain('Block payments to this team');
    expect(await render({}, { role: 'GLOBAL_ADMIN' })).toContain('Block payments to this team');
  });

  it('a payout-blocked team shows the banking notice and no reminders', async () => {
    const html = await render(
      {},
      { payments: ok(adminBody([adminRow()], { payoutBlocked: true })), role: 'GLOBAL_ADMIN' },
    );
    expect(html).toContain('Go to Banking and GST');
    expect(html).not.toContain('Send reminder');
    expect(html).not.toContain('Block payments to this team');
  });

  it.each([
    ['', 'No unpaid payments. Everyone is up to date.'],
    ['paid', 'No paid payments yet.'],
    ['all', 'No payments yet. They appear here after a session ends.'],
  ])('empty state for ?status=%s', async (status, text) => {
    const html = await render(status === '' ? {} : { status }, {
      payments: ok(adminBody([])),
    });
    expect(html).toContain(text);
  });

  it('"Show more" keeps the filter and carries the cursor', async () => {
    const html = await render(
      { status: 'paid' },
      { payments: ok(adminBody([adminRow()], { nextCursor: 'n2' })) },
    );
    expect(html).toContain('?status=paid&amp;cursor=n2');
    expect(html).toContain('Show more');
  });
});

describe('Payments manage area: access (CR-21, ruling H2)', () => {
  it('a team admin gets the full nav and no "Viewing as a global admin" line', async () => {
    const html = await render();
    expect(html).not.toContain('Viewing as a global admin');
    expect(html).toContain('Banking and GST');
  });

  it('a GLOBAL_ADMIN who is not a member sees only Payments and the viewing-as line', async () => {
    const html = await render({}, { role: 'GLOBAL_ADMIN', detail: team(null, null) });
    expect(html).toContain('Viewing as a global admin');
    expect(html).not.toContain('Banking and GST');
  });

  it('a GLOBAL_ADMIN with no readable team detail still sees the list under a plain heading', async () => {
    const html = await render({}, { role: 'GLOBAL_ADMIN', detail: fail(404, 'not_found') });
    expect(html).toContain('Payments</h1>');
    expect(html).toContain('Priya Shah');
  });

  it('a plain member (403) gets NoAccess and no payments content', async () => {
    const html = await render({}, { payments: fail(403, 'forbidden') });
    expect(html).not.toContain('Priya');
    expect(html).not.toContain('Send reminder');
    expect(html).not.toContain('Team admin areas');
  });

  it('a malformed id is not found; 401 expires the session; 5xx throws', async () => {
    await expect(render({}, {}, 'nope')).rejects.toThrow('NOT_FOUND');
    await expect(render({}, { payments: fail(401, 'unauthorized') })).rejects.toThrow(
      /REDIRECT:.*session-expired/,
    );
    await expect(render({}, { payments: fail(503) })).rejects.toThrow(/unavailable/);
    expect(mocks.warn).toHaveBeenCalledWith('web.teams.api_failure', {
      action: 'admin_payments_load',
      status: 503,
      code: 'internal_error',
    });
  });
});

describe('Payments manage area: the Invoice action (AC-ENTRY-3, H9)', () => {
  const paidRow = adminRow({
    status: 'PAID',
    paidAt: '2026-10-08T01:00:00.000Z',
    document: { kind: 'TAX_INVOICE', available: true, number: 'INV-000003' },
  });

  it('gives a team admin an Invoice action on a paid row that returns to the same filtered page, and shows a failed download', async () => {
    const html = await render(
      { status: 'paid', download_error: 'invoice_not_available' },
      { payments: ok(adminBody([paidRow])) },
    );
    expect(html).toContain('aria-label="Invoice for Priya Shah, Wed 7 Oct, $17.00 (PDF)"');
    expect(html).toContain(
      `returnTo=${encodeURIComponent(`/teams/${TEAM_ID}/manage/payments?status=paid`)}`,
    );
    expect(html).toContain('An invoice is available once the payment is paid.');
  });

  it('hides the action from a GLOBAL_ADMIN who is not an approved team admin (no invoice access, H9)', async () => {
    const html = await render(
      { status: 'paid' },
      { role: 'GLOBAL_ADMIN', detail: team(null, null), payments: ok(adminBody([paidRow])) },
    );
    expect(html).not.toContain('/invoice');
  });
});
