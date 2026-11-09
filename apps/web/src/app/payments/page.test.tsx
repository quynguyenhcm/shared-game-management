import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PAYMENT_ID, TEAM_ID, paymentRow, unpaidBody } from '../../lib/billing/fixtures.ts';

const mocks = vi.hoisted(() => ({ myUnpaidPayments: vi.fn(), warn: vi.fn() }));

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
vi.mock('../../lib/auth/session.ts', () => ({
  requireUser: () => Promise.resolve({ id: 'user-1' }),
}));
vi.mock('../../lib/auth/cookies.ts', () => ({
  readCookie: () => Promise.resolve('session-token'),
}));
vi.mock('../../lib/log.ts', () => ({ log: { info: vi.fn(), warn: mocks.warn, error: vi.fn() } }));
vi.mock('../../lib/api-client.ts', () => ({
  apiClient: { myUnpaidPayments: mocks.myUnpaidPayments },
}));

const page = await import('./page.tsx');
const PaymentsPage = page.default;

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (status: number) => ({
  ok: false as const,
  status,
  error: { code: 'internal_error', message: 'x' },
});

async function render(result: unknown, query: Record<string, string> = {}): Promise<string> {
  mocks.myUnpaidPayments.mockResolvedValue(result);
  const element = await PaymentsPage({ searchParams: Promise.resolve(query) });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  mocks.myUnpaidPayments.mockReset();
  mocks.warn.mockReset();
});

describe('/payments: the cross-team unpaid list (CR-16, AC-ENTRY-4)', () => {
  it('is noindex and dynamic with an h1 "Your payments"', async () => {
    expect(page.metadata).toMatchObject({ robots: { index: false } });
    expect(page.dynamic).toBe('force-dynamic');
    const html = await render(ok(unpaidBody([])));
    expect(html).toContain('Your payments</h1>');
  });

  it('groups by team (h2 per team), Overdue before Pending, with "Pay now" to each payment', async () => {
    const other = '88888888-8888-4888-8888-888888888888';
    const html = await render(
      ok(
        unpaidBody([
          {
            teamId: TEAM_ID,
            teamName: 'Rosedale Badminton',
            payments: [
              paymentRow({ id: other, status: 'PENDING' }),
              paymentRow({ id: PAYMENT_ID, status: 'OVERDUE' }),
            ],
          },
          {
            teamId: '99999999-9999-4999-8999-999999999999',
            teamName: 'Albany Smashers',
            payments: [paymentRow({ id: '12121212-1212-4212-8212-121212121212' })],
          },
        ]),
      ),
    );
    expect(html).toContain('>Rosedale Badminton</h2>');
    expect(html).toContain('>Albany Smashers</h2>');
    expect(html.indexOf('>Overdue<')).toBeLessThan(html.indexOf('>Pending<'));
    expect(html).toContain(`href="/payments/${PAYMENT_ID}"`);
    expect(html).toContain('Pay now');
  });

  it('a held row says why instead of offering "Pay now"', async () => {
    const html = await render(
      ok(
        unpaidBody([
          {
            teamId: TEAM_ID,
            teamName: 'Rosedale Badminton',
            payments: [paymentRow({ onHold: true, outcome: 'held' })],
          },
        ]),
      ),
    );
    expect(html).toContain('Under review');
    expect(html).not.toContain('Pay now');
    expect(html).not.toContain(`href="/payments/${PAYMENT_ID}"`);
  });

  it('empty: "You have no unpaid payments." with a link to My teams', async () => {
    const html = await render(ok(unpaidBody([])));
    expect(html).toContain('You have no unpaid payments.');
    expect(html).toContain('href="/teams"');
  });

  it('pages with ?cursor= and offers "Show more" from nextCursor', async () => {
    const html = await render(
      ok(
        unpaidBody(
          [{ teamId: TEAM_ID, teamName: 'Rosedale Badminton', payments: [paymentRow()] }],
          'c2',
        ),
      ),
      { cursor: 'c1' },
    );
    expect(mocks.myUnpaidPayments).toHaveBeenCalledWith(
      { cursor: 'c1' },
      expect.objectContaining({ session: 'session-token' }),
    );
    expect(html).toContain('href="/payments?cursor=c2"');
    expect(html).toContain('Show more');
  });

  it('401 goes to session expiry; a 5xx throws to the error boundary', async () => {
    await expect(render(fail(401))).rejects.toThrow(/REDIRECT:.*session-expired/);
    await expect(render(fail(503))).rejects.toThrow(/unavailable/);
    expect(mocks.warn).toHaveBeenCalledWith('web.billing.api_failure', {
      action: 'unpaid_payments',
      status: 503,
      code: 'internal_error',
    });
  });
});
