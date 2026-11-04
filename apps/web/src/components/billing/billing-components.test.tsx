import type {
  AdminPaymentsResponse,
  MyPaymentRow,
  PaymentResponse,
  WalletResponse,
} from '@sgm/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
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

const { PaymentStatusTag } = await import('./payment-status-tag.tsx');
const { WalletLine, WalletSummary } = await import('./wallet-summary.tsx');
const { TopUpForm } = await import('./top-up-form.tsx');
const { PaymentsList } = await import('./payments-list.tsx');
const { PayButton } = await import('./pay-button.tsx');
const { ReminderConfirm } = await import('./reminder-confirm.tsx');
const { LedgerList } = await import('./ledger-list.tsx');
const { PaymentDetail } = await import('./payment-detail.tsx');
const { AdminPaymentsTable } = await import('./admin-payments-table.tsx');
const { HoldResolution } = await import('./hold-resolution.tsx');
const { PayoutBlockConfirm } = await import('./payout-block-confirm.tsx');
const { ManageAreaNav } = await import('../teams/manage-area-nav.tsx');

const TEAM = '7f3c2b1a-1111-4222-8333-444455556666';
const ID = '22222222-2222-4222-8222-222222222222';
const KEY = '2f6c1c1e-7a64-4c0e-9d61-3c1f0c1f0a11';
const SESSION_AT = '2026-10-07T07:00:00.000Z'; // Wed 7 Oct, 8:00 pm NZDT
const DUE = '2026-10-09T22:00:00.000Z'; // Sat 10 Oct
const NOW = '2026-10-29T03:30:00.000Z';

type Wallet = WalletResponse['wallet'];
/** Fixtures are wire-shaped JSON (money as plain text), so they are asserted into the branded response types. */
const wallet = (change: Record<string, unknown> = {}): Wallet =>
  ({
    balance: '12.50',
    cap: '100.00',
    headroom: '87.50',
    lowCreditThreshold: '20.00',
    pendingTopUp: null,
    lastClosedTopUp: null,
    ...change,
  }) as Wallet;

type Payment = PaymentResponse['payment'];
const payment = (change: Record<string, unknown> = {}): Payment =>
  ({
    id: ID,
    reference: 'P-1',
    teamName: 'Rosedale',
    session: { id: ID, location: 'Rosedale Hall', startsAt: SESSION_AT },
    amount: '17.00',
    gstAmount: '0.00',
    lines: [],
    status: 'PENDING',
    billingType: 'PER_GAME',
    dueDate: DUE,
    paidAt: null,
    reason: 'CONFIRMED',
    attempt: null,
    onHold: false,
    payoutBlocked: false,
    ...change,
  }) as unknown as Payment;
const attempt = (outcome: 'processing' | 'cancelled' | 'failed' | 'held') => ({
  status: 'OPEN' as const,
  startedAt: '2026-10-08T01:00:00.000Z',
  outcome,
});

const detail = (p: Payment, search: { return?: string } = {}, overdueCount?: number) =>
  renderToStaticMarkup(
    <PaymentDetail payment={p} search={search} idempotencyKey={KEY} overdueCount={overdueCount} />,
  );

describe('PaymentStatusTag: text carries the state, colour only reinforces', () => {
  it('renders the status words, including the due date, and the hold tag', () => {
    const base = { billingType: 'PER_GAME' as const, amount: '17.00', dueDate: DUE, onHold: false };
    expect(renderToStaticMarkup(<PaymentStatusTag {...base} status="OVERDUE" />)).toContain(
      'Overdue since Sat 10 Oct',
    );
    expect(renderToStaticMarkup(<PaymentStatusTag {...base} status="PENDING" />)).toContain(
      'Due Sat 10 Oct',
    );
    expect(renderToStaticMarkup(<PaymentStatusTag {...base} status="PENDING" onHold />)).toContain(
      'Under review',
    );
    expect(
      renderToStaticMarkup(
        <PaymentStatusTag {...base} status="PAID" billingType="PREPAID_CREDIT" />,
      ),
    ).toContain('Paid from wallet');
  });
});

describe('WalletLine and WalletSummary (AC-ENTRY-1, AC-ASYNC-2, AC-ERROR-1)', () => {
  it('the team-page line shows the balance, or degrades to the plain link when the call failed', () => {
    const withBalance = renderToStaticMarkup(<WalletLine teamId={TEAM} balance="12.50" />);
    expect(withBalance).toContain(`href="/teams/${TEAM}/wallet"`);
    expect(withBalance).toContain('Wallet: $12.50');
    expect(withBalance).toContain('Top up or pay');
    expect(withBalance).toContain('min-h-11');
    const failed = renderToStaticMarkup(<WalletLine teamId={TEAM} balance={null} />);
    expect(failed).toContain('Wallet and payments');
    expect(failed).not.toContain('$');
  });

  it('form state: balance, headroom sentence, labelled amount field, hint, trust lines with the team name (H3)', () => {
    const html = renderToStaticMarkup(
      <WalletSummary
        teamId={TEAM}
        teamName="Rosedale"
        wallet={wallet()}
        search={{}}
        idempotencyKey={KEY}
      />,
    );
    expect(html).toContain('Balance: $12.50');
    expect(html).toContain('You can top up to $87.50 more (wallet limit $100.00).');
    expect(html).toContain('>Top-up amount (NZD)<');
    expect(html).toContain('Between $1.00 and $87.50.');
    expect(html).toMatch(/inputMode="decimal"|inputmode="decimal"/i);
    expect(html).toContain('Top up with Akahu');
    expect(html).toContain('Wallet credit can only be used for Rosedale&#x27;s game fees.');
    expect(html).toContain('The money goes to Rosedale&#x27;s bank account.');
    expect(html).toContain(`name="idempotencyKey" value="${KEY}"`);
    expect(html).toContain(`name="teamId" value="${TEAM}"`);
  });

  it('full state removes the form', () => {
    const html = renderToStaticMarkup(
      <WalletSummary
        teamId={TEAM}
        teamName="Rosedale"
        wallet={wallet({ balance: '100.00', headroom: '0.00' })}
        search={{}}
        idempotencyKey={KEY}
      />,
    );
    expect(html).toContain('Balance: $100.00');
    expect(html).toContain('Your wallet is full.');
    expect(html).not.toContain('Top up with Akahu');
    expect(html).not.toContain('<form');
  });

  it('processing state replaces the form with a polite status and a Refresh link, never moves focus', () => {
    const pendingTopUp = {
      id: ID,
      amount: '30.00',
      status: 'OPEN' as const,
      outcome: 'processing' as const,
      createdAt: '2026-10-07T07:00:00.000Z',
    };
    const returned = renderToStaticMarkup(
      <WalletSummary
        teamId={TEAM}
        teamName="Rosedale"
        wallet={wallet({ pendingTopUp })}
        search={{ topUp: ID }}
        idempotencyKey={KEY}
      />,
    );
    expect(returned).toContain('Processing your top-up. This usually takes under a minute.');
    expect(returned).toMatch(/role="status"[^>]*aria-live="polite"/);
    expect(returned).toContain('>Refresh<');
    expect(returned).not.toContain('Top-up amount (NZD)');
    expect(returned).not.toContain('autofocus');

    const left = renderToStaticMarkup(
      <WalletSummary
        teamId={TEAM}
        teamName="Rosedale"
        wallet={wallet({ pendingTopUp })}
        search={{}}
        idempotencyKey={KEY}
      />,
    );
    expect(left).toContain('Top-up of $30.00 started');
    expect(left).toContain('Continue with Akahu');
  });

  it('overflow notice (B3) shows above the form', () => {
    const html = renderToStaticMarkup(
      <WalletSummary
        teamId={TEAM}
        teamName="Rosedale"
        wallet={wallet({
          lastClosedTopUp: {
            id: ID,
            amount: '30.00',
            status: 'UNAPPLIED',
            unappliedReason: 'OVER_CAP',
            closedAt: SESSION_AT,
          },
        })}
        search={{}}
        idempotencyKey={KEY}
      />,
    );
    expect(html).toContain('would have taken your wallet over $100.00');
    expect(html).toContain('Top up with Akahu');
  });

  it('TopUpForm directly: hidden fields, error-free first render, 16px-friendly decimal input', () => {
    const html = renderToStaticMarkup(
      <TopUpForm teamId={TEAM} teamName="Rosedale" headroom="87.50" idempotencyKey={KEY} />,
    );
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain(`name="teamId" value="${TEAM}"`);
  });
});

const row = (change: Record<string, unknown>): MyPaymentRow =>
  ({
    id: ID,
    reference: 'P',
    sessionId: ID,
    sessionStartsAt: SESSION_AT,
    location: 'Rosedale Hall',
    amount: '17.00',
    status: 'PENDING',
    billingType: 'PER_GAME',
    dueDate: DUE,
    paidAt: null,
    reason: 'CONFIRMED',
    outcome: 'none',
    onHold: false,
    payoutBlocked: false,
    ...change,
  }) as MyPaymentRow;

describe('PaymentsList (wallet page and /payments)', () => {
  it('shows Overdue, Pending, Paid groups under h3, with a 44px Pay now link to the payment page', () => {
    const html = renderToStaticMarkup(
      <PaymentsList
        groups={groupPayments([
          row({ id: 'a1', status: 'OVERDUE' }),
          row({ id: 'b2' }),
          row({
            id: 'c3',
            status: 'PAID',
            paidAt: '2026-10-08T00:00:00.000Z',
            billingType: 'PREPAID_CREDIT',
          }),
        ])}
      />,
    );
    expect(html.indexOf('>Overdue<')).toBeLessThan(html.indexOf('>Pending<'));
    expect(html.indexOf('>Pending<')).toBeLessThan(html.indexOf('>Paid<'));
    expect(html).toMatch(/<h3[^>]*>Overdue<\/h3>/);
    expect(html).toContain('Rosedale Hall, Wed 7 Oct');
    expect(html).toContain('$17.00');
    expect(html).toContain('href="/payments/a1"');
    expect(html).toContain('Pay now');
    expect(html).toContain('Paid from wallet');
    expect(html).not.toContain('href="/payments/c3"');
  });

  it('a held row shows Under review and no Pay now; a payout-blocked row says the team cannot receive payments', () => {
    const html = renderToStaticMarkup(
      <PaymentsList
        groups={groupPayments([
          row({ id: 'h1', onHold: true, outcome: 'held' }),
          row({ id: 'k1', status: 'OVERDUE', payoutBlocked: true }),
        ])}
      />,
    );
    expect(html).toContain('Under review');
    expect(html).not.toContain('href="/payments/h1"');
    expect(html).not.toContain('href="/payments/k1"');
    expect(html).not.toContain('Pay now');
    expect(html).toContain('This team can&#x27;t receive payments right now.');
    expect(html).not.toContain('haven&#x27;t been charged');
  });

  it('a late-withdrawal charge says why; an empty list shows the supplied empty text', () => {
    expect(
      renderToStaticMarkup(
        <PaymentsList groups={groupPayments([row({ reason: 'LATE_WITHDRAWAL' })])} />,
      ),
    ).toContain('Late withdrawal fee');
    expect(
      renderToStaticMarkup(
        <PaymentsList groups={groupPayments([])} emptyText="You have no unpaid payments." />,
      ),
    ).toContain('You have no unpaid payments.');
  });

  it('caps paid rows and says so', () => {
    const paid = Array.from({ length: 11 }, (_, index) =>
      row({
        id: `p${index}`,
        status: 'PAID',
        paidAt: `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      }),
    );
    expect(renderToStaticMarkup(<PaymentsList groups={groupPayments(paid)} />)).toContain(
      'Showing your latest 10 paid games.',
    );
  });
});

describe('PayButton', () => {
  it('is a form with the key and payment id, the amount in the label, and the leave-site line', () => {
    const html = renderToStaticMarkup(
      <PayButton paymentId={ID} idempotencyKey={KEY} kind="pay" amount="17.00" />,
    );
    expect(html).toContain('Pay $17.00 with Akahu');
    expect(html).toContain(`name="paymentId" value="${ID}"`);
    expect(html).toContain(`name="idempotencyKey" value="${KEY}"`);
    expect(html).toContain(
      'You&#x27;ll leave this site to approve the payment with your bank through Akahu.',
    );
    expect(html).not.toContain(' disabled');
  });

  it('retry and continue labels', () => {
    expect(
      renderToStaticMarkup(
        <PayButton paymentId={ID} idempotencyKey={KEY} kind="retry" amount="17.00" />,
      ),
    ).toContain('>Try again<');
    expect(
      renderToStaticMarkup(
        <PayButton paymentId={ID} idempotencyKey={KEY} kind="continue" amount="17.00" />,
      ),
    ).toContain('Continue with Akahu');
  });
});

describe('PaymentDetail: the state matrix (AC-HAPPY-4, AC-ERROR-3, AC-ERROR-4, AC-ASYNC-2)', () => {
  it('pending: summary list, due line and one primary Pay button', () => {
    const html = detail(payment());
    expect(html).toMatch(/<h1[^>]*>Payment for Rosedale Hall, Wed 7 Oct<\/h1>/);
    expect(html).toContain('<dl');
    expect(html).toContain('Rosedale');
    expect(html).toContain('Due Sat 10 Oct');
    expect(html).toContain('Pay $17.00 with Akahu');
    expect(html).not.toContain('Includes GST');
  });

  it('GST line only when there is GST; line items name You and guests with their basis', () => {
    const html = detail(
      payment({
        amount: '17.00',
        gstAmount: '2.22',
        lines: [
          { position: 0, basis: 'SEX_FEMALE', unitFee: '8.50' },
          { position: 1, basis: 'SKILL_BEGINNER', unitFee: '8.50' },
        ],
      }),
    );
    expect(html).toContain('Includes GST of $2.22');
    expect(html).toContain('What you&#x27;re paying for');
    expect(html).toContain('>You<');
    expect(html).toContain('>Guest 1<');
    expect(html).toContain('Women&#x27;s rate');
    expect(html).toContain('Beginner level');
    expect(html).toContain('Total');
  });

  it('late withdrawal explains the fee', () => {
    expect(detail(payment({ reason: 'LATE_WITHDRAWAL' }))).toContain(
      'Late withdrawal fee: you withdrew after the deadline and the place wasn&#x27;t filled.',
    );
  });

  it('overdue: the register hint only with 3 or more overdue payments', () => {
    expect(detail(payment({ status: 'OVERDUE' }), {}, 3)).toContain(
      'Overdue since Sat 10 Oct. Pay it to register for more games.',
    );
    const two = detail(payment({ status: 'OVERDUE' }), {}, 2);
    expect(two).toContain('Overdue since Sat 10 Oct.');
    expect(two).not.toContain('register for more games');
  });

  it('attempt open and the player left Akahu: Continue with Akahu', () => {
    const html = detail(payment({ attempt: attempt('processing') }));
    expect(html).toContain('You started a payment at');
    expect(html).toContain('Continue with Akahu');
  });

  it('?return=1 with an open attempt: processing status, Refresh link, no pay button', () => {
    const html = detail(payment({ attempt: attempt('processing') }), { return: '1' });
    expect(html).toContain('Processing your payment. This usually takes under a minute.');
    expect(html).toMatch(/role="status"[^>]*aria-live="polite"/);
    expect(html).toContain('>Refresh<');
    expect(html).not.toContain('<button');
  });

  it('declined: the honest "haven\'t been charged" line and Try again', () => {
    const html = detail(payment({ attempt: attempt('failed') }));
    expect(html).toContain('Your payment didn&#x27;t go through. You haven&#x27;t been charged.');
    expect(html).toContain('>Try again<');
  });

  it('HOLD (CR-18): heading and body, no button at all, and "haven\'t been charged" appears nowhere on the page', () => {
    const html = detail(payment({ onHold: true, attempt: attempt('held') }));
    expect(html).toContain('We&#x27;re checking this payment with your bank.');
    expect(html).toContain('Please don&#x27;t pay again.');
    expect(html).toContain('Under review');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Pay $17.00');
    expect(html).not.toContain('Try again');
    expect(html).not.toContain('haven&#x27;t been charged');
    expect(html).not.toContain("haven't been charged");
  });

  it('hold also wins over a payout block and over an open attempt (it forbids a second payment)', () => {
    const html = detail(
      payment({ onHold: true, payoutBlocked: true, attempt: attempt('processing') }),
      { return: '1' },
    );
    expect(html).toContain('Please don&#x27;t pay again.');
    expect(html).not.toContain('can&#x27;t receive payments');
    expect(html).not.toContain('<button');
  });

  it('payout blocked: the team message and no button', () => {
    const html = detail(payment({ payoutBlocked: true }));
    expect(html).toContain(
      'This team can&#x27;t receive payments right now. We&#x27;ve told the team admins.',
    );
    expect(html).not.toContain('<button');
  });

  it('paid states: no button; wallet, Akahu and no-charge wording', () => {
    const paidAt = '2026-10-08T01:00:00.000Z';
    const wallet_ = detail(payment({ status: 'PAID', billingType: 'PREPAID_CREDIT', paidAt }));
    expect(wallet_).toContain('Paid from your wallet on Thu 8 Oct.');
    expect(wallet_).not.toContain('<button');
    expect(detail(payment({ status: 'PAID', paidAt }))).toContain('Paid on Thu 8 Oct.');
    expect(detail(payment({ status: 'PAID', amount: '0.00', paidAt }))).toContain(
      'There&#x27;s no charge for this game.',
    );
  });

  it('never renders a payment link, token, bank detail or email address', () => {
    const html = detail(payment({ attempt: attempt('processing') }));
    expect(html).not.toMatch(/akahu\.example|token|@|account number/i);
  });
});

describe('LedgerList', () => {
  const tx = [
    {
      id: 'a',
      type: 'AUTO_DEDUCTION',
      amount: '-17.00',
      resultingBalance: '13.00',
      createdAt: '2026-10-07T20:00:00.000Z',
      session: { id: ID, location: 'Rosedale Hall', startsAt: SESSION_AT },
    },
    {
      id: 'b',
      type: 'TOPUP',
      amount: '30.00',
      resultingBalance: '30.00',
      createdAt: '2026-10-04T20:00:00.000Z',
      session: null,
    },
  ] as WalletResponse['transactions'];

  it('lists signed amounts with the running balance and an older-activity link', () => {
    const html = renderToStaticMarkup(
      <LedgerList
        transactions={tx}
        nextCursor="next1"
        walletPath={`/teams/${TEAM}/wallet`}
        cursor={null}
      />,
    );
    expect(html).toContain('Game fee, Rosedale Hall, Wed 7 Oct');
    expect(html).toContain('−$17.00');
    expect(html).toContain('+$30.00');
    expect(html).toContain('Balance $13.00');
    expect(html).toContain(`href="/teams/${TEAM}/wallet?cursor=next1"`);
    expect(html).toContain('Show older activity');
    expect(html).not.toContain('Back to newest');
  });

  it('on a later page offers Back to newest; empty says so', () => {
    expect(
      renderToStaticMarkup(
        <LedgerList
          transactions={tx}
          nextCursor={null}
          walletPath={`/teams/${TEAM}/wallet`}
          cursor="c"
        />,
      ),
    ).toContain('Back to newest');
    expect(
      renderToStaticMarkup(
        <LedgerList
          transactions={[]}
          nextCursor={null}
          walletPath={`/teams/${TEAM}/wallet`}
          cursor={null}
        />,
      ),
    ).toContain('No wallet activity yet.');
  });
});

type AdminRow = AdminPaymentsResponse['payments'][number];
const adminRow = (change: Record<string, unknown> = {}): AdminRow =>
  ({
    id: ID,
    reference: 'P',
    player: { userId: ID, fullName: 'Priya Shah' },
    sessionStartsAt: SESSION_AT,
    amount: '17.00',
    status: 'OVERDUE',
    dueDate: DUE,
    paidAt: null,
    lastReminderAt: null,
    onHold: false,
    ...change,
  }) as AdminRow;
const table = (rows: AdminRow[], payoutBlocked = false) =>
  renderToStaticMarkup(
    <AdminPaymentsTable teamId={TEAM} payments={rows} payoutBlocked={payoutBlocked} now={NOW} />,
  );

describe('AdminPaymentsTable (AC-ENTRY-3, AC-HAPPY-7; variant C reflowing table)', () => {
  it('is a native table with explicit roles, labelled cells for the stacked layout, and names only', () => {
    const html = table([adminRow()]);
    expect(html).toContain('<table');
    for (const role of ['table', 'rowgroup', 'row', 'columnheader', 'cell']) {
      expect(html).toContain(`role="${role}"`);
    }
    for (const label of ['Player', 'Session', 'Amount', 'Status', 'Last reminder']) {
      expect(html).toContain(`data-label="${label}"`);
    }
    expect(html).toContain('Priya Shah');
    expect(html).toContain('Wed 7 Oct');
    expect(html).toContain('$17.00');
    expect(html).toContain('Overdue since Sat 10 Oct');
    expect(html).toContain('No reminder yet');
    expect(html).not.toContain('@');
  });

  it('an unpaid row offers Send reminder with a longer accessible name that starts with the visible label', () => {
    const html = table([adminRow()]);
    expect(html).toContain('>Send reminder<');
    expect(html).toContain('aria-label="Send reminder to Priya Shah for $17.00, Wed 7 Oct"');
  });

  it('within the cooldown the trigger is aria-disabled and points at the "sent / send another after" text', () => {
    const html = table([adminRow({ lastReminderAt: '2026-10-29T01:14:00.000Z' })]);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain(
      'Reminder sent 2:14 pm. You can send another after Fri 30 Oct, 2:14 pm.',
    );
    expect(html).toMatch(/aria-describedby="[^"]+"/);
  });

  it('a held row: Under review, the waiting line, a hold-resolution control, and NO Send reminder', () => {
    const html = table([adminRow({ onHold: true })]);
    expect(html).toContain('Under review');
    expect(html).toContain('Waiting on the bank. Nothing to do yet.');
    expect(html).not.toContain('Send reminder');
    expect(html).toContain('Record what happened');
  });

  it('payout blocked: a notice linking to Banking and GST and no Send reminder on any row', () => {
    const html = table([adminRow(), adminRow({ id: 'x2', status: 'PENDING' })], true);
    expect(html).toContain(
      'Payments to your bank account are failing. Update your banking details.',
    );
    expect(html).toContain(`href="/teams/${TEAM}/manage/banking"`);
    expect(html).not.toContain('Send reminder');
  });

  it('a paid row has no action', () => {
    const html = table([adminRow({ status: 'PAID', paidAt: '2026-10-10T00:00:00.000Z' })]);
    expect(html).toContain('>Paid<');
    expect(html).not.toContain('Send reminder');
  });

  it('shows the empty message when there are no rows', () => {
    expect(
      renderToStaticMarkup(
        <AdminPaymentsTable
          teamId={TEAM}
          payments={[]}
          payoutBlocked={false}
          now={NOW}
          emptyText="No unpaid payments. Everyone is up to date."
        />,
      ),
    ).toContain('No unpaid payments. Everyone is up to date.');
  });
});

describe('ReminderConfirm (B6, CR-18)', () => {
  const props = {
    teamId: TEAM,
    paymentId: ID,
    playerName: 'Priya Shah',
    amount: '17.00',
    sessionStartsAt: SESSION_AT,
    status: 'OVERDUE' as const,
    lastReminderAt: null,
    now: NOW,
    held: false,
    payoutBlocked: false,
  };

  it('closed: the trigger only; open: the first-name prompt, Send reminder confirm and an explicit Cancel', () => {
    const closed = renderToStaticMarkup(<ReminderConfirm {...props} />);
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('Email Priya');
    const open = renderToStaticMarkup(<ReminderConfirm {...props} defaultOpen />);
    expect(open).toContain('Email Priya a reminder for $17.00?');
    expect(open.match(/>Send reminder</g)).toHaveLength(2); // trigger and confirm
    expect(open).toContain('>Cancel<');
    expect(open).toContain('role="group"');
  });

  it('renders nothing when the payment is held, the team payout is blocked, or it is paid', () => {
    expect(renderToStaticMarkup(<ReminderConfirm {...props} held />)).toBe('');
    expect(renderToStaticMarkup(<ReminderConfirm {...props} payoutBlocked />)).toBe('');
    expect(renderToStaticMarkup(<ReminderConfirm {...props} status="PAID" />)).toBe('');
  });
});

describe('HoldResolution and PayoutBlockConfirm', () => {
  it('hold resolution: both outcomes, and RECEIVED reveals an observed amount field with a visible label', () => {
    const html = renderToStaticMarkup(
      <HoldResolution teamId={TEAM} paymentId={ID} playerName="Priya Shah" defaultOpen />,
    );
    expect(html).toContain('>Record what happened<');
    expect(html).toContain('value="RECEIVED"');
    expect(html).toContain('value="NOT_RECEIVED"');
    expect(html).toContain('Yes, the money arrived');
    expect(html).toContain('No, it didn&#x27;t arrive');
    expect(html).toContain('name="observedAmount"');
    expect(html).toContain('>Amount that arrived (NZD)<');
    expect(html).toContain('name="teamId"');
    expect(html).toContain('name="paymentId"');
  });

  it('payout block: an enum reason list, an optional Akahu payment id, explicit Cancel; never free text', () => {
    const html = renderToStaticMarkup(<PayoutBlockConfirm teamId={TEAM} defaultOpen />);
    expect(html).toContain('Block payments to this team');
    for (const value of [
      'AKAHU_REPORTED_ACCOUNT_PROBLEM',
      'FUNDS_RETURNED',
      'TEAM_REQUESTED',
      'OTHER',
    ]) {
      expect(html).toContain(`value="${value}"`);
    }
    expect(html).toContain('name="akahuPaymentId"');
    expect(html).not.toContain('<textarea');
    expect(html).toContain('>Cancel<');
  });
});

describe('ManageAreaNav for a global admin who is not a team admin (CR-21)', () => {
  it('shows only Payments and the "Viewing as a global admin" line', () => {
    const html = renderToStaticMarkup(
      <ManageAreaNav teamId={TEAM} current="payments" globalAdminOnly />,
    );
    expect(html).toContain('Viewing as a global admin');
    expect(html).toContain(`href="/teams/${TEAM}/manage/payments"`);
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain('People');
    expect(html).not.toContain('Banking and GST');
    expect(html).not.toContain('Sessions');
  });

  it('a team admin sees Payments as the fourth area, and no global-admin line', () => {
    const html = renderToStaticMarkup(<ManageAreaNav teamId={TEAM} current="payments" />);
    expect(html).toContain('>Payments<');
    expect(html).toContain('>People<');
    expect(html).not.toContain('Viewing as a global admin');
  });
});
