import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  DUE_AT,
  SESSION_AT,
  TEAM_ID,
  paymentRow,
  unpaidBody,
  wallet,
} from '../../lib/billing/fixtures.ts';
import {
  PAYMENT_1,
  SESSION_1,
  SESSION_2,
  TEAM_A,
  TEAM_B,
  openBody,
  openRow,
  paymentOf,
  registrationRow,
  registrationsBody,
} from '../../lib/dashboard/fixtures.ts';
import { walletCard } from '../../lib/dashboard/view.ts';

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined }),
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock('next/navigation', () => ({
  redirect: () => undefined,
  RedirectType: { replace: 'replace' },
  useRouter: () => ({ refresh: () => undefined }),
}));

const { DashboardTabs } = await import('./dashboard-tabs.tsx');
const { OpenSessionsTab } = await import('./open-sessions-tab.tsx');
const { RegistrationsTab } = await import('./registrations-tab.tsx');
const { PaymentsTab } = await import('./payments-tab.tsx');

const html = (element: React.ReactElement) => renderToStaticMarkup(element);

describe('DashboardTabs (AC-ENTRY-1, AC-ENTRY-2)', () => {
  it('renders three plain links in a labelled nav, with exactly the current one aria-current="page"', () => {
    for (const [current, label] of [
      ['opening', 'Currently Opening'],
      ['registrations', 'My Registration'],
      ['payments', 'Payments &amp; Wallet'],
    ] as const) {
      const out = html(<DashboardTabs current={current} />);
      expect(out).toContain('<nav aria-label="Dashboard">');
      expect(out.match(/aria-current="page"/g)).toHaveLength(1);
      expect(out).toMatch(new RegExp(`aria-current="page"[^>]*>${label}<`));
      expect(out).toContain('font-semibold decoration-2');
      expect(out).not.toContain('role="tab"');
    }
    const out = html(<DashboardTabs current="opening" />);
    expect(out).toContain('href="/dashboard"');
    expect(out).toContain('href="/dashboard?tab=registrations"');
    expect(out).toContain('href="/dashboard?tab=payments"');
  });
});

describe('OpenSessionsTab (AC-HAPPY-1, AC-HAPPY-2, AC-ERROR-1, AC-ERROR-4)', () => {
  const ok = (body: ReturnType<typeof openBody>, hasTeam = true) =>
    html(<OpenSessionsTab state={{ kind: 'ok', data: body, hasTeam }} />);

  it('renders the cards in the order the API returned, each value as its own string', () => {
    const out = ok(
      openBody([
        openRow({ sessionId: SESSION_1, location: 'Rosedale Hall', unitFee: '12.00' }),
        openRow({
          sessionId: SESSION_2,
          teamId: TEAM_B,
          teamName: 'Albany Smashers',
          location: 'Bays Courts',
          address: '9 Lake Road, Takapuna',
          unitFee: '15.50',
          seatsLeft: 0,
        }),
      ]),
    );
    expect(out.indexOf('Rosedale Hall')).toBeLessThan(out.indexOf('Bays Courts'));
    expect(out).toContain('9 Lake Road, Takapuna');
    expect(out).toContain('$12.00 per person');
    expect(out).toContain('$15.50 per person');
    expect(out).toContain('Full · 2 on the waitlist');
    expect(out).toContain(`href="/teams/${TEAM_B}"`);
    expect(out).toContain('<h3');
  });

  it('the button is an anchor to the session page with a visible label and an sr-only suffix', () => {
    const out = ok(openBody([openRow()]));
    expect(out).toContain(`href="/teams/${TEAM_A}/sessions/${SESSION_1}"`);
    expect(out).toContain(
      'Register<span class="sr-only"> for Rosedale Hall, Wed 7 Oct, 8:00 pm to 10:00 pm</span>',
    );
    expect(out).toContain('min-h-11');
  });

  it('shows the tag beside View registration and View session for a blocked session', () => {
    const out = ok(
      openBody([
        openRow({ me: { status: 'WAITLISTED', waitlistRank: 2 } }),
        openRow({ sessionId: SESSION_2, canRegister: false, blockedReason: 'overdue_payments' }),
      ]),
    );
    expect(out).toContain('Waitlist #2');
    expect(out).toContain('View registration');
    expect(out).toContain('View session');
  });

  it('shows the debt banner with a link to Payments & Wallet only when payments are overdue', () => {
    const banner = ok(openBody([openRow()], 3));
    expect(banner).toContain('You have 3 overdue payments across your teams.');
    expect(banner).toMatch(/href="\/dashboard\?tab=payments"[^>]*>Go to Payments &amp; Wallet</);
    expect(ok(openBody([openRow()], 0))).not.toContain('Go to Payments');
  });

  it('has no Show more (the API caps the list and has no cursor)', () => {
    expect(ok(openBody([openRow()], 0, true))).not.toContain('Show more');
  });

  it('says what to do next in each empty state, and names the failure without guessing', () => {
    const noTeam = ok(openBody([]), false);
    expect(noTeam).toContain('Join a team to see its open sessions here.');
    expect(noTeam).toMatch(/href="\/teams\/find"[^>]*>Find a team</);
    expect(ok(openBody([]), true)).toContain('No sessions are open for registration right now.');
    const failed = html(<OpenSessionsTab state={{ kind: 'failed' }} />);
    expect(failed).toContain('We can&#x27;t load sessions right now. Try again in a minute.');
    expect(failed).not.toContain('$');
  });
});

describe('RegistrationsTab (AC-HAPPY-3, AC-ASYNC-2, AC-ERROR-4, AC-ERROR-5)', () => {
  const render = (body: ReturnType<typeof registrationsBody>, firstPage = true) =>
    html(<RegistrationsTab state={{ kind: 'ok', data: body, firstPage }} />);

  it('lists Upcoming then Past, with the payment tags, totals, View payment and View session', () => {
    const out = render(
      registrationsBody(
        [
          registrationRow({ guestCount: 1 }),
          registrationRow({ status: 'WAITLISTED', waitlistRank: 2 }),
        ],
        [
          registrationRow({
            location: 'Bays Courts',
            payment: paymentOf({ status: 'OVERDUE' }),
            estimatedTotal: null,
          }),
        ],
        'NEXT',
      ),
    );
    expect(out.indexOf('>Upcoming<')).toBeLessThan(out.indexOf('>Past<'));
    expect(out).toContain('You&#x27;re in');
    expect(out).toContain('Waitlist #2');
    expect(out).toContain('Not billed yet');
    expect(out).toContain('Estimated total: $24.00');
    expect(out).toContain('Overdue since Sat 10 Oct');
    expect(out).toContain('Total fee: $24.00');
    expect(out).toContain(`href="/payments/${PAYMENT_1}"`);
    expect(out).toContain(`href="/teams/${TEAM_A}/sessions/${SESSION_1}"`);
    expect(out).toContain('View session');
    expect(out).toMatch(/href="\/dashboard\?tab=registrations&amp;cursor=NEXT"[^>]*>Show more</);
  });

  it('a held and a payout-blocked card give the reason and no Pay now', () => {
    const out = render(
      registrationsBody([
        registrationRow({ payment: paymentOf({ onHold: true }) }),
        registrationRow({ payment: paymentOf({ payoutBlocked: true }) }),
      ]),
    );
    expect(out).toContain('Under review');
    expect(out).toContain('We&#x27;re checking this payment with your bank.');
    expect(out).toContain('This team can&#x27;t receive payments right now.');
    expect(out).not.toContain('Pay now');
  });

  it('a later page shows only Past, and an empty list points to the open sessions', () => {
    const later = render(registrationsBody([], [registrationRow()]), false);
    expect(later).not.toContain('>Upcoming<');
    expect(later).toContain('>Past<');
    const empty = render(registrationsBody([], []));
    expect(empty).toContain('You haven&#x27;t registered for any sessions yet.');
    expect(empty).toMatch(/href="\/dashboard"[^>]*>See open sessions</);
    expect(html(<RegistrationsTab state={{ kind: 'failed' }} />)).toContain(
      'We can&#x27;t load your registrations right now. Try again in a minute.',
    );
  });
});

describe('PaymentsTab (AC-HAPPY-4, AC-HAPPY-5, AC-ERROR-1, AC-ERROR-3, AC-ERROR-4, AC-ASYNC-1)', () => {
  const A = { id: TEAM_A, name: 'Rosedale Badminton' };
  const cards = [
    walletCard(A, wallet()),
    walletCard(
      { id: TEAM_B, name: 'Albany Smashers' },
      wallet({ balance: '100.00', headroom: '0.00' }),
    ),
    walletCard(
      { id: TEAM_ID, name: 'Henderson Birds' },
      wallet({
        pendingTopUp: {
          id: PAYMENT_1,
          amount: '20.00',
          outcome: 'processing',
          createdAt: SESSION_AT,
        },
      }),
    ),
    walletCard({ id: '99999999-9999-4999-8999-999999999999', name: 'Orewa Shuttlers' }, null),
  ];
  const team = { teamId: TEAM_A, teamName: 'Rosedale Badminton' };
  const unpaid = unpaidBody([
    {
      ...team,
      payments: [
        paymentRow({ id: PAYMENT_1, status: 'OVERDUE', location: 'Overdue Hall' }),
        paymentRow({
          id: '55555555-5555-4555-8555-555555555555',
          onHold: true,
          location: 'Held Hall',
        }),
        paymentRow({ id: '66666666-6666-4666-8666-666666666666', payoutBlocked: true }),
      ],
    },
  ]);
  const paid = unpaidBody([
    {
      ...team,
      payments: [
        paymentRow({
          id: '77777777-7777-4777-8777-777777777777',
          status: 'PAID',
          paidAt: DUE_AT,
          document: { kind: 'TAX_INVOICE', available: true, number: 'INV-1' },
        }),
        paymentRow({
          id: '88888888-8888-4888-8888-888888888888',
          status: 'PAID',
          amount: '0.00',
          paidAt: DUE_AT,
        }),
      ],
    },
  ]);
  const render = (change: Partial<Parameters<typeof PaymentsTab>[0]['state']> = {}) =>
    html(
      <PaymentsTab
        state={{
          teams: { kind: 'ok', cards },
          payments: { kind: 'ok', unpaid, paid },
          downloadError: undefined,
          ...change,
        }}
      />,
    );

  it('one wallet card per team: balance, the one state line and the one next step; no cap computed here', () => {
    const out = render();
    expect(out).toContain('>Wallet<');
    expect(out).toContain('Balance: $12.50');
    expect(out).toContain('You can top up to $87.50 more (wallet limit $100.00).');
    expect(out).toContain(`href="/teams/${TEAM_A}/wallet#wallet"`);
    expect(out).toContain('Top up credit<span class="sr-only"> for Rosedale Badminton</span>');
    expect(out).toContain('Your wallet is full.');
    expect(out).toContain('Top-up of $20.00 started Wed 7 Oct, 8:00 pm.');
    expect(out.match(/Top up credit/g)).toHaveLength(1);
    expect(out.match(/View wallet/g)).toHaveLength(1);
    expect(out).toContain(`href="/teams/${TEAM_A}/wallet"`);
  });

  it('a failed wallet replaces only that card body; the other cards still render', () => {
    const out = render();
    expect(out).toContain('We can&#x27;t load this wallet right now. Try again in a minute.');
    expect(out).toContain('Orewa Shuttlers');
    expect(out.match(/Balance:/g)).toHaveLength(3);
  });

  it('three native details in order with counts, defaults and 44 px summaries', () => {
    const out = render();
    const overdue = out.indexOf('Overdue (1)');
    const pending = out.indexOf('Pending (2)');
    const paidAt = out.indexOf('Paid (2)');
    expect(overdue).toBeGreaterThan(0);
    expect(overdue).toBeLessThan(pending);
    expect(pending).toBeLessThan(paidAt);
    const details = out.match(/<details[^>]*>/g) ?? [];
    expect(details).toHaveLength(3);
    expect(details[0]).toContain(' open');
    expect(details[1]).toContain(' open');
    expect(details[2]).not.toContain(' open');
    expect(out.match(/<summary[^>]*min-h-11/g)).toHaveLength(3);
    expect(out).toContain('<h4');
    expect(out).not.toContain('role="tab"');
  });

  it('Pay now only on a payable row; held and payout-blocked rows say why instead', () => {
    const out = render();
    expect(out.match(/Pay now,/g)).toHaveLength(1);
    expect(out).toContain(`href="/payments/${PAYMENT_1}"`);
    expect(out).toContain('We&#x27;re checking this payment with your bank.');
    expect(out).toContain('This team can&#x27;t receive payments right now.');
  });

  it('the download link appears exactly when the document is available, with the dashboard return path', () => {
    const out = render();
    const id = '77777777-7777-4777-8777-777777777777';
    expect(out).toContain(`href="/payments/${id}/invoice?returnTo=%2Fdashboard%3Ftab%3Dpayments"`);
    expect(out.match(/\/invoice\?returnTo/g)).toHaveLength(1);
  });

  it('renders the download error notice above the accordions, intact', () => {
    const out = render({ downloadError: 'invoice_not_available' });
    expect(out).toContain('role="alert"');
    expect(out.indexOf('role="alert"')).toBeLessThan(out.indexOf('Overdue (1)'));
    expect(out).toContain('Paid (2)');
    expect(render({ downloadError: 'bogus' })).not.toContain('role="alert"');
  });

  it('Show more appears while a cursor exists and keeps the other list’s cursor', () => {
    const out = render({
      payments: {
        kind: 'ok',
        unpaid,
        paid: { ...paid, nextCursor: 'PNEXT' },
        unpaidCursor: 'UCUR',
      },
    });
    expect(out).toContain('/dashboard?tab=payments&amp;paidCursor=PNEXT&amp;unpaidCursor=UCUR');
    expect(render()).not.toContain('Show more');
  });

  it('a failed payments read replaces the accordions with the existing line, wallet cards stay', () => {
    const out = render({ payments: { kind: 'failed' } });
    expect(out).toContain('We can&#x27;t load your payments right now. Try again in a minute.');
    expect(out).not.toContain('<details');
    expect(out).toContain('Balance: $12.50');
  });

  it('empty states: no team, no payments, and empty accordions each say what is next', () => {
    const noTeam = render({
      teams: { kind: 'ok', cards: [] },
      payments: { kind: 'ok', unpaid: unpaidBody([]), paid: unpaidBody([]) },
    });
    expect(noTeam).toContain('Join a team to get a wallet.');
    expect(noTeam).toMatch(/href="\/teams\/find"[^>]*>Find a team</);
    const none = render({ payments: { kind: 'ok', unpaid: unpaidBody([]), paid: unpaidBody([]) } });
    expect(none).toContain('No payments yet. Charges appear here after a game.');
    expect(none).not.toContain('<details');
    expect(none).toContain('Balance: $12.50');
    const onlyPaid = render({ payments: { kind: 'ok', unpaid: unpaidBody([]), paid } });
    expect(onlyPaid).toContain('Nothing overdue.');
    expect(onlyPaid).toContain('Nothing pending.');
    const onlyUnpaid = render({ payments: { kind: 'ok', unpaid, paid: unpaidBody([]) } });
    expect(onlyUnpaid).toContain('No paid games yet.');
  });

  it('says nothing about Akahu being live or not, and starts no payment (no form, no POST)', () => {
    const out = render();
    expect(out).not.toMatch(/<form|method="post"/i);
    expect(out).not.toMatch(/Akahu (is|isn|not)/);
  });
});
