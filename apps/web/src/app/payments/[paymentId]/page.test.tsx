import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PAYMENT_ID, payment, paymentRow, unpaidBody } from '../../../lib/billing/fixtures.ts';

const mocks = vi.hoisted(() => ({ payment: vi.fn(), myUnpaidPayments: vi.fn(), warn: vi.fn() }));

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
vi.mock('../../../lib/auth/session.ts', () => ({
  requireUser: () => Promise.resolve({ id: 'user-1' }),
}));
vi.mock('../../../lib/auth/cookies.ts', () => ({
  readCookie: () => Promise.resolve('session-token'),
}));
vi.mock('../../../lib/log.ts', () => ({
  log: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));
vi.mock('../../../lib/api-client.ts', () => ({
  apiClient: { payment: mocks.payment, myUnpaidPayments: mocks.myUnpaidPayments },
}));

const page = await import('./page.tsx');
const PaymentPage = page.default;

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (status: number, code = 'internal_error') => ({
  ok: false as const,
  status,
  error: { code, message: 'x' },
});
const open = (outcome: string) => ({
  status: 'OPEN',
  startedAt: '2026-10-08T01:00:00.000Z',
  outcome,
});

async function render(
  result: unknown,
  query: Record<string, string> = {},
  paymentId = PAYMENT_ID,
): Promise<string> {
  mocks.payment.mockResolvedValue(result);
  const element = await PaymentPage({
    params: Promise.resolve({ paymentId }),
    searchParams: Promise.resolve(query),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  mocks.payment.mockReset();
  mocks.myUnpaidPayments.mockReset().mockResolvedValue(ok(unpaidBody([])));
  mocks.warn.mockReset();
});

describe('payment page: shell', () => {
  it('is noindex and dynamic, titled and headed by the game, with a per-render idempotency key', async () => {
    expect(page.metadata).toMatchObject({ robots: { index: false } });
    expect(page.dynamic).toBe('force-dynamic');
    const html = await render(ok({ payment: payment() }));
    expect(html).toContain(
      '<title>Payment for Rosedale Hall, Wed 7 Oct – Shared Game Management</title>',
    );
    expect(html).toContain('Payment for Rosedale Hall, Wed 7 Oct</h1>');
    expect(html).toMatch(
      /name="idempotencyKey"[^>]*value="[0-9a-f-]{36}"|value="[0-9a-f-]{36}"[^>]*name="idempotencyKey"/,
    );
    expect(mocks.payment).toHaveBeenCalledWith(
      PAYMENT_ID,
      expect.objectContaining({ session: 'session-token' }),
    );
  });
});

describe('payment page: states (AC-ENTRY-2, AC-ASYNC-2, AC-ERROR-3, AC-ERROR-4)', () => {
  it('pending: due line and "Pay $17.00 with Akahu"', async () => {
    const html = await render(ok({ payment: payment() }));
    expect(html).toContain('Due Sat 10 Oct.');
    expect(html).toContain('Pay $17.00 with Akahu');
  });

  it('overdue: overdue line and the pay button', async () => {
    const html = await render(ok({ payment: payment({ status: 'OVERDUE' }) }));
    expect(html).toContain('Overdue since Sat 10 Oct');
    expect(html).toContain('Pay $17.00 with Akahu');
  });

  it('overdue with 3 or more overdue payments adds the register-for-more-games sentence', async () => {
    mocks.myUnpaidPayments.mockResolvedValue(
      ok(
        unpaidBody([
          {
            teamId: '7f3c2b1a-1111-4222-8333-444455556666',
            teamName: 'Rosedale',
            payments: [
              paymentRow({ id: '1a1a1a1a-1111-4111-8111-111111111111', status: 'OVERDUE' }),
              paymentRow({ id: '2b2b2b2b-2222-4222-8222-222222222222', status: 'OVERDUE' }),
              paymentRow({ status: 'OVERDUE' }),
            ],
          },
        ]),
      ),
    );
    const html = await render(ok({ payment: payment({ status: 'OVERDUE' }) }));
    expect(html).toContain('Pay it to register for more games.');
  });

  it('processing after return (?return=1, attempt open): refresh notice, no pay button', async () => {
    const html = await render(ok({ payment: payment({ attempt: open('processing') }) }), {
      return: '1',
    });
    expect(html).toContain('Processing your payment. This usually takes under a minute.');
    expect(html).toContain('Refresh');
    expect(html).not.toContain('with Akahu');
  });

  it('open attempt without a return: "Continue with Akahu"', async () => {
    const html = await render(ok({ payment: payment({ attempt: open('processing') }) }));
    expect(html).toContain('Continue with Akahu');
  });

  it('declined: "You haven\'t been charged" and "Try again"', async () => {
    const html = await render(ok({ payment: payment({ attempt: open('failed') }) }));
    expect(html).toContain('Your payment didn&#x27;t go through. You haven&#x27;t been charged.');
    expect(html).toContain('Try again');
  });

  it('paid: "Paid on ..." and no button', async () => {
    const html = await render(
      ok({ payment: payment({ status: 'PAID', paidAt: '2026-10-08T01:00:00.000Z' }) }),
    );
    expect(html).toContain('Paid on Thu 8 Oct.');
    expect(html).not.toContain('with Akahu');
  });

  it('hold: "Under review", no button anywhere, and never "haven\'t been charged"', async () => {
    const html = await render(ok({ payment: payment({ onHold: true, attempt: open('held') }) }));
    expect(html).toContain('We&#x27;re checking this payment with your bank.');
    expect(html).toContain('Under review');
    expect(html).not.toContain('<button');
    expect(html).not.toMatch(/haven(&#x27;|')t been charged/);
  });

  it('payout blocked: the team-cannot-receive-payments line and no button', async () => {
    const html = await render(ok({ payment: payment({ payoutBlocked: true }) }));
    expect(html).toContain('This team can&#x27;t receive payments right now.');
    expect(html).not.toContain('with Akahu');
  });

  it('never renders a payment link, token or email address', async () => {
    const html = await render(ok({ payment: payment() }));
    expect(html).not.toMatch(/https?:\/\/|@/);
  });
});

describe('payment page: payer only, access and errors (AC-ERROR-10 style uniformity)', () => {
  it.each([[404], [403], [422]])('API %i is the uniform not-found', async (status) => {
    await expect(render(fail(status, 'not_found'))).rejects.toThrow('NOT_FOUND');
  });

  it('a malformed id is not found without calling the API', async () => {
    await expect(render(ok({ payment: payment() }), {}, 'nope')).rejects.toThrow('NOT_FOUND');
    expect(mocks.payment).not.toHaveBeenCalled();
  });

  it('401 returns to this payment after sign-in; a 5xx throws and logs status and code only', async () => {
    await expect(render(fail(401, 'unauthorized'))).rejects.toThrow(/REDIRECT:.*session-expired/);
    await expect(render(fail(503))).rejects.toThrow(/unavailable/);
    expect(mocks.warn).toHaveBeenCalledWith('web.billing.api_failure', {
      action: 'payment_load',
      status: 503,
      code: 'internal_error',
    });
  });
});

describe('payment page: the invoice download (AC-ENTRY-1)', () => {
  const paidDoc = (document: Record<string, unknown>) =>
    payment({ status: 'PAID', paidAt: '2026-10-08T01:00:00.000Z', document });

  it('shows the download link for a paid payment with its kind and number, and a failed download sentence from ?download_error=', async () => {
    const html = await render(
      ok({
        payment: paidDoc({ kind: 'RECEIPT', available: true, number: 'RCT-000005' }),
      }),
      { download_error: 'invoice_pending' },
    );
    expect(html).toContain(`href="/payments/${PAYMENT_ID}/invoice"`);
    expect(html).toContain('Download receipt');
    expect(html).toContain('RCT-000005');
    expect(html).toContain('Your receipt is being prepared. Try again in a moment.');
  });

  it('shows no link while the payment is not paid', async () => {
    expect(await render(ok({ payment: payment() }))).not.toContain('/invoice');
  });
});
