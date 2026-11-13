import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { adminRow, payment, paymentRow, TEAM_ID, PAYMENT_ID } from '../../lib/billing/fixtures.ts';
import { groupPayments } from '../../lib/billing/wallet-view.ts';

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined }),
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock('next/navigation', () => ({
  redirect: () => undefined,
  RedirectType: { replace: 'replace' },
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const { DownloadInvoiceLink } = await import('./download-invoice-link.tsx');
const { DownloadErrorNotice } = await import('./download-error-notice.tsx');
const { PaymentDetail } = await import('../billing/payment-detail.tsx');
const { PaymentsList } = await import('../billing/payments-list.tsx');
const { AdminPaymentsTable } = await import('../billing/admin-payments-table.tsx');

const NOW = '2026-10-29T03:30:00.000Z';
const AVAILABLE = { kind: 'TAX_INVOICE', available: true, number: null } as const;
const paid = { status: 'PAID', paidAt: '2026-10-08T01:00:00.000Z' };

describe('DownloadInvoiceLink (AC-ENTRY-1)', () => {
  it('is a plain anchor with no download attribute, labelled from the document kind, naming the file type, game and amount', () => {
    const html = renderToStaticMarkup(
      <DownloadInvoiceLink
        href="/payments/p/invoice"
        kind="TAX_INVOICE"
        context={{ location: 'Rosedale Hall', day: 'Wed 7 Oct', amount: '$17.00' }}
        variant="primary"
      />,
    );
    expect(html).toContain('href="/payments/p/invoice"');
    expect(html).not.toMatch(/\sdownload[=\s>]/);
    expect(html).toContain(
      'aria-label="Download tax invoice for Rosedale Hall, Wed 7 Oct, $17.00 (PDF)"',
    );
    expect(html).toContain('Download tax invoice');
    expect(html).toContain('min-h-11');
  });

  it('says Download receipt for a receipt, and Invoice with the player for the admin row action', () => {
    const receipt = renderToStaticMarkup(
      <DownloadInvoiceLink
        href="/x"
        kind="RECEIPT"
        context={{ location: 'Hall', day: 'Wed 7 Oct', amount: '$5.00' }}
        variant="link"
      />,
    );
    expect(receipt).toContain('Download receipt');
    expect(receipt).not.toContain('tax invoice');
    const admin = renderToStaticMarkup(
      <DownloadInvoiceLink
        href="/x"
        kind="ADMIN"
        context={{ player: 'Priya Shah', day: 'Wed 7 Oct', amount: '$17.00' }}
        variant="link"
      />,
    );
    expect(admin).toContain('aria-label="Invoice for Priya Shah, Wed 7 Oct, $17.00 (PDF)"');
    expect(admin).toContain('>Invoice<');
  });
});

describe('DownloadErrorNotice', () => {
  it('announces the sentence for a known code and renders nothing for an unknown or absent one', () => {
    const html = renderToStaticMarkup(<DownloadErrorNotice code="invoice_not_available" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('An invoice is available once the payment is paid.');
    expect(renderToStaticMarkup(<DownloadErrorNotice code="<img onerror=x>" />)).toBe('');
    expect(renderToStaticMarkup(<DownloadErrorNotice code={undefined} />)).toBe('');
  });

  it('words a retry for the document kind, and neutrally for an admin', () => {
    expect(
      renderToStaticMarkup(<DownloadErrorNotice code="service_unavailable" kind="RECEIPT" />),
    ).toContain('We couldn&#x27;t download your receipt. Try again in a minute.');
    expect(
      renderToStaticMarkup(<DownloadErrorNotice code="service_unavailable" admin />),
    ).toContain('download this invoice');
  });
});

describe('payment page: the download action follows the API document reference (AC-ENTRY-1)', () => {
  const detail = (p: ReturnType<typeof payment>, downloadError?: string) =>
    renderToStaticMarkup(
      <PaymentDetail payment={p} search={{}} idempotencyKey="k" downloadError={downloadError} />,
    );

  it('offers the link only while a document is available, labelled from its kind, and shows the number once issued', () => {
    const html = detail(payment({ ...paid, document: { ...AVAILABLE, number: 'INV-000007' } }));
    expect(html).toContain(`href="/payments/${PAYMENT_ID}/invoice"`);
    expect(html).toContain('Download tax invoice');
    expect(html).toContain('Invoice number');
    expect(html).toContain('INV-000007');

    const receipt = detail(
      payment({ ...paid, document: { kind: 'RECEIPT', available: true, number: 'RCT-000002' } }),
    );
    expect(receipt).toContain('Download receipt');
    expect(receipt).toContain('Receipt number');
  });

  it('labels a registered team $0.01 payment (GST $0.00) as a tax invoice, never from the GST amount', () => {
    const html = detail(
      payment({ ...paid, amount: '0.01', gstAmount: '0.00', document: { ...AVAILABLE } }),
    );
    expect(html).toContain('Download tax invoice');
  });

  it('shows no link for a pending, held or $0.00 payment, and no number row without a number', () => {
    for (const change of [
      { status: 'PENDING' },
      { status: 'OVERDUE' },
      { ...paid, amount: '0.00' },
      { status: 'PENDING', onHold: true },
    ]) {
      const html = detail(payment(change));
      expect(html).not.toContain('/invoice');
      expect(html).not.toContain('Download');
      expect(html).not.toContain('Invoice number');
    }
  });

  it('renders the landing sentence of a failed download above the action', () => {
    const html = detail(payment({ ...paid, document: AVAILABLE }), 'invoice_pending');
    expect(html).toContain('Your tax invoice is being prepared. Try again in a moment.');
  });
});

describe('wallet payment list: a download action on each available paid row, and a way to older games (AC-ENTRY-1, R5)', () => {
  it('links each PAID row with an available document to the payer route, returning to the wallet page; none elsewhere', () => {
    const rows = [
      paymentRow({ id: 'a', ...paid, document: AVAILABLE }),
      paymentRow({ id: 'b', ...paid, amount: '0.00' }),
      paymentRow({ id: 'c', status: 'PENDING' }),
    ];
    const html = renderToStaticMarkup(
      <PaymentsList groups={groupPayments(rows)} returnTo={`/teams/${TEAM_ID}/wallet`} />,
    );
    expect(html).toContain(
      `href="/payments/a/invoice?returnTo=${encodeURIComponent(`/teams/${TEAM_ID}/wallet`).replace(/&/g, '&amp;')}"`,
    );
    expect(html.match(/\/invoice/g)).toHaveLength(1);
    expect(html).toContain('Download tax invoice for Rosedale Hall');
  });

  it('shows Show older paid games when a link is given, and no link otherwise', () => {
    const groups = groupPayments([paymentRow({ ...paid })]);
    expect(
      renderToStaticMarkup(
        <PaymentsList groups={groups} olderHref="/teams/x/wallet?payments=all#payments" />,
      ),
    ).toContain('href="/teams/x/wallet?payments=all#payments"');
    expect(renderToStaticMarkup(<PaymentsList groups={groups} />)).not.toContain(
      'Show older paid games',
    );
  });
});

describe('admin Payments table: an Invoice action on PAID rows above $0.00, for team admins only (AC-ENTRY-3)', () => {
  const table = (rows: ReturnType<typeof adminRow>[], invoiceReturnTo?: string) =>
    renderToStaticMarkup(
      <AdminPaymentsTable
        teamId={TEAM_ID}
        payments={rows}
        payoutBlocked={false}
        now={NOW}
        invoiceReturnTo={invoiceReturnTo}
      />,
    );
  const back = `/teams/${TEAM_ID}/manage/payments?status=paid`;

  it('names the player, game day and amount, links the team route and carries the Payments page as returnTo', () => {
    const html = table([adminRow({ ...paid, document: AVAILABLE })], back);
    expect(html).toContain('aria-label="Invoice for Priya Shah, Wed 7 Oct, $17.00 (PDF)"');
    expect(html).toContain(`/teams/${TEAM_ID}/manage/payments/${PAYMENT_ID}/invoice?returnTo=`);
    // The admin never sees the payer's email.
    expect(html).not.toContain('@');
  });

  it('hides the action on PENDING, OVERDUE, held and $0.00 rows, and from anyone who is not a team admin', () => {
    const none = [
      adminRow({ status: 'PENDING' }),
      adminRow({ status: 'OVERDUE' }),
      adminRow({ status: 'PENDING', onHold: true }),
      adminRow({ ...paid, amount: '0.00' }),
    ];
    expect(table(none, back)).not.toContain('/invoice');
    // A GLOBAL_ADMIN who is not a team admin: the page passes no returnTo, so no row gets the action (H9).
    expect(table([adminRow({ ...paid, document: AVAILABLE })], undefined)).not.toContain(
      '/invoice',
    );
  });
});
