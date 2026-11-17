import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DUE_AT,
  SESSION_AT,
  TEAM_ID,
  paymentRow,
  unpaidBody,
  wallet,
} from '../billing/fixtures.ts';
import {
  PAYMENT_1,
  SESSION_1,
  TEAM_A,
  TEAM_B,
  openRow,
  paymentOf,
  registrationRow,
} from './fixtures.ts';
import {
  DASHBOARD_PATH,
  PAYMENTS_RETURN_TO,
  paymentsPagePath,
  registrationsPagePath,
  tabPath,
} from './paths.ts';
import {
  cursorParam,
  openSessionCard,
  parseTab,
  paymentAccordions,
  paymentsEmpty,
  registrationCard,
  walletCard,
} from './view.ts';

describe('tab parsing and URLs (AC-ENTRY-2, AC-ERROR-6)', () => {
  it('maps the three tabs, defaults the unknown and absent to Currently Opening', () => {
    expect(parseTab('registrations')).toBe('registrations');
    expect(parseTab('payments')).toBe('payments');
    expect(parseTab('opening')).toBe('opening');
    expect(parseTab('bogus')).toBe('opening');
    expect(parseTab(undefined)).toBe('opening');
    expect(parseTab('PAYMENTS')).toBe('opening');
  });

  it('builds plain, URL-driven tab links and keeps each cursor in its own parameter', () => {
    expect(DASHBOARD_PATH).toBe('/dashboard');
    expect(tabPath('opening')).toBe('/dashboard');
    expect(tabPath('registrations')).toBe('/dashboard?tab=registrations');
    expect(tabPath('payments')).toBe('/dashboard?tab=payments');
    expect(PAYMENTS_RETURN_TO).toBe('/dashboard?tab=payments');
    expect(registrationsPagePath('c 1')).toBe('/dashboard?tab=registrations&cursor=c+1');
    expect(paymentsPagePath({ paidCursor: 'P', unpaidCursor: 'U' })).toBe(
      '/dashboard?tab=payments&paidCursor=P&unpaidCursor=U',
    );
    expect(paymentsPagePath({ unpaidCursor: 'U' })).toBe('/dashboard?tab=payments&unpaidCursor=U');
  });

  it('ignores an empty or overlong cursor parameter', () => {
    expect(cursorParam('abc')).toBe('abc');
    expect(cursorParam('')).toBeUndefined();
    expect(cursorParam(undefined)).toBeUndefined();
    expect(cursorParam('x'.repeat(513))).toBeUndefined();
  });
});

describe('open session card (AC-HAPPY-1)', () => {
  it('shows each API field as its own string, with distinct values per session', () => {
    const card = openSessionCard(
      openRow({
        teamName: 'Albany Smashers',
        location: 'Bays Courts',
        address: '9 Lake Road, Takapuna',
        seatsLeft: 0,
        publicCapacity: 8,
        waitlistLength: 2,
      }),
    );
    expect(card.teamName).toBe('Albany Smashers');
    expect(card.teamHref).toBe(`/teams/${TEAM_A}`);
    expect(card.heading).toBe('Bays Courts');
    expect(card.when).toBe('Wed 7 Oct, 8:00 pm to 10:00 pm');
    expect(card.address).toBe('9 Lake Road, Takapuna');
    expect(card.seatsText).toBe('Full · 2 on the waitlist');
    expect(openSessionCard(openRow()).seatsText).toBe('3 of 8 places left · 2 on the waitlist');
  });

  it('shows the day and start time only when the session has no end', () => {
    expect(openSessionCard(openRow({ endsAt: null })).when).toBe('Wed 7 Oct, 8:00 pm');
  });

  it('prints the caller’s own fee for each pricing mode, and the unpriced line', () => {
    expect(openSessionCard(openRow()).feeText).toBe('$12.00 per person');
    expect(openSessionCard(openRow({ pricingStructure: 'BY_SEX', unitFee: '14.50' })).feeText).toBe(
      'Your fee: $14.50',
    );
    expect(
      openSessionCard(
        openRow({ pricingStructure: 'BY_SKILL_LEVEL', unitFee: '12.00', feeLevel: 'INTERMEDIATE' }),
      ).feeText,
    ).toBe('Your fee: $12.00 (Intermediate)');
    expect(openSessionCard(openRow({ unitFee: null })).feeText).toBe(
      "The fee isn't set for this session yet.",
    );
  });
});

describe('open session button matrix (AC-HAPPY-2)', () => {
  const button = (change: Record<string, unknown>) => openSessionCard(openRow(change)).button;
  const PATH = `/teams/${TEAM_A}/sessions/${SESSION_1}`;

  it('Register when there are places, Join waitlist when full, both to the existing session page', () => {
    expect(button({})).toMatchObject({ text: 'Register', href: PATH, secondary: false, tag: null });
    expect(button({ seatsLeft: 0 })).toMatchObject({
      text: 'Join waitlist',
      href: PATH,
      secondary: false,
    });
  });

  it('View registration with the tag when the caller already has a place or a waitlist rank', () => {
    expect(button({ me: { status: 'CONFIRMED', waitlistRank: null } })).toMatchObject({
      text: 'View registration',
      tag: "You're in",
      href: PATH,
    });
    expect(button({ me: { status: 'WAITLISTED', waitlistRank: 3 } })).toMatchObject({
      text: 'View registration',
      tag: 'Waitlist #3',
    });
  });

  it('View session in secondary style for every blocked reason, and the sr-only suffix names the session', () => {
    for (const blockedReason of [
      'overdue_payments',
      'party_exceeds_capacity',
      'session_not_open',
    ]) {
      expect(button({ canRegister: false, blockedReason })).toMatchObject({
        text: 'View session',
        secondary: true,
      });
    }
    expect(button({}).srSuffix).toBe(' for Rosedale Hall, Wed 7 Oct, 8:00 pm to 10:00 pm');
  });
});

describe('registration card (AC-HAPPY-3, AC-ASYNC-2, AC-ERROR-5)', () => {
  it('an unbilled CONFIRMED row: Not billed yet, the server estimate, no payment link', () => {
    const card = registrationCard(registrationRow({ guestCount: 1 }));
    expect(card.heading).toBe('Rosedale Hall');
    expect(card.teamName).toBe('Rosedale Badminton');
    expect(card.when).toBe('Wed 7 Oct, 8:00 pm');
    expect(card.group).toBe('Your group: you + 1 guest');
    expect(card.state).toBe("You're in");
    expect(card.tag).toMatchObject({ text: 'Not billed yet' });
    expect(card.total).toBe('Estimated total: $24.00');
    expect(card.paymentHref).toBeNull();
    expect(card.sessionHref).toBe(`/teams/${TEAM_A}/sessions/${SESSION_1}`);
  });

  it('a WAITLISTED row says it is charged only with a place; an unpriced row says the fee is not set', () => {
    const card = registrationCard(
      registrationRow({ status: 'WAITLISTED', waitlistRank: 2, estimatedTotal: null }),
    );
    expect(card.state).toBe('Waitlist #2');
    expect(card.tag).toMatchObject({ text: 'Charged only if you get a place.' });
    expect(card.total).toBe("The fee isn't set for this session yet.");
  });

  it('a billed row takes its tag and total from the payment, FAILED reads as pending, and links View payment', () => {
    const overdue = registrationCard(
      registrationRow({ payment: paymentOf({ status: 'OVERDUE' }), estimatedTotal: null }),
    );
    expect(overdue.tag).toMatchObject({ text: 'Overdue since Sat 10 Oct', tone: 'red' });
    expect(overdue.total).toBe('Total fee: $24.00');
    expect(overdue.paymentHref).toBe(`/payments/${PAYMENT_1}`);
    expect(
      registrationCard(registrationRow({ payment: paymentOf({ status: 'FAILED' }) })).tag,
    ).toMatchObject({
      text: 'Due Sat 10 Oct',
    });
    const paid = registrationCard(
      registrationRow({
        payment: paymentOf({ status: 'PAID', billingType: 'PREPAID_CREDIT', paidAt: DUE_AT }),
      }),
    );
    expect(paid.tag).toMatchObject({ text: 'Paid from wallet' });
  });

  it('a late withdrawal and a cancelled session carry their own state', () => {
    const late = registrationCard(
      registrationRow({
        status: 'WITHDRAWN',
        withdrawalFeeDue: true,
        payment: paymentOf(),
        estimatedTotal: null,
      }),
    );
    expect(late.state).toBe('Late withdrawal');
    expect(late.tag).toMatchObject({ text: 'Due Sat 10 Oct' });
    const cancelled = registrationCard(registrationRow({ sessionStatus: 'CANCELLED' }));
    expect(cancelled.state).toBe('Session cancelled');
    expect(cancelled.tag).toBeNull();
    expect(cancelled.total).toBeNull();
  });

  it('a held payment shows Under review and why; a payout-blocked one says so; neither offers payment', () => {
    const held = registrationCard(registrationRow({ payment: paymentOf({ onHold: true }) }));
    expect(held.tag).toMatchObject({ text: 'Under review' });
    expect(held.note).toBe("We're checking this payment with your bank.");
    const blocked = registrationCard(
      registrationRow({ payment: paymentOf({ payoutBlocked: true }) }),
    );
    expect(blocked.note).toBe(
      "This team can't receive payments right now. We've told the team admins.",
    );
    expect(JSON.stringify([held, blocked])).not.toContain('Pay now');
    expect(
      registrationCard(registrationRow({ payment: paymentOf({ status: 'PAID' }) })).note,
    ).toBeNull();
  });
});

describe('wallet card (AC-HAPPY-4, AC-ASYNC-1, AC-ERROR-1)', () => {
  const team = { id: TEAM_A, name: 'Rosedale Badminton' };

  it('form state: balance, the API headroom line and Top up credit to the wallet section', () => {
    expect(walletCard(team, wallet())).toMatchObject({
      name: 'Rosedale Badminton',
      href: `/teams/${TEAM_A}/wallet`,
      failed: false,
      balance: 'Balance: $12.50',
      line: 'You can top up to $87.50 more (wallet limit $100.00).',
      action: {
        text: 'Top up credit',
        href: `/teams/${TEAM_A}/wallet#wallet`,
        srSuffix: ' for Rosedale Badminton',
      },
    });
  });

  it('full wallet: the full line and no top-up link', () => {
    const card = walletCard(team, wallet({ balance: '100.00', headroom: '0.00' }));
    expect(card.balance).toBe('Balance: $100.00');
    expect(card.line).toBe('Your wallet is full.');
    expect(card.action).toBeNull();
  });

  it('an open top-up shows the started line, a held one the held heading, each with View wallet', () => {
    const open = walletCard(
      team,
      wallet({
        pendingTopUp: {
          id: PAYMENT_1,
          amount: '20.00',
          outcome: 'processing',
          createdAt: SESSION_AT,
        },
      }),
    );
    expect(open.line).toBe(
      'Top-up of $20.00 started Wed 7 Oct, 8:00 pm. Finish it at Akahu, or it will close by itself.',
    );
    expect(open.action).toMatchObject({ text: 'View wallet', href: `/teams/${TEAM_A}/wallet` });
    const held = walletCard(
      team,
      wallet({
        pendingTopUp: { id: PAYMENT_1, amount: '20.00', outcome: 'held', createdAt: SESSION_AT },
      }),
    );
    expect(held.line).toBe("We're checking your top-up with your bank.");
    expect(held.action).toMatchObject({ text: 'View wallet' });
  });

  it('a failed wallet read shows no balance and no amount, never $0.00', () => {
    const card = walletCard(team, null);
    expect(card).toMatchObject({ failed: true, balance: null, line: null, action: null });
  });
});

describe('payment accordions (AC-HAPPY-5, AC-HAPPY-6)', () => {
  const row = (id: string, change: Record<string, unknown> = {}) => paymentRow({ id, ...change });
  const A = { teamId: TEAM_ID, teamName: 'Rosedale Badminton' };
  const B = { teamId: TEAM_B, teamName: 'Albany Smashers' };
  const unpaid = unpaidBody([
    {
      ...A,
      payments: [
        row('00000000-0000-4000-8000-000000000001', { status: 'OVERDUE' }),
        row('00000000-0000-4000-8000-000000000002'),
        row('00000000-0000-4000-8000-000000000003', { onHold: true }),
      ],
    },
    { ...B, payments: [row('00000000-0000-4000-8000-000000000004')] },
  ]);
  const paid = unpaidBody([
    {
      ...A,
      payments: [
        row('00000000-0000-4000-8000-000000000005', { status: 'PAID', paidAt: SESSION_AT }),
        row('00000000-0000-4000-8000-000000000006', { status: 'PAID', paidAt: DUE_AT }),
        row('00000000-0000-4000-8000-000000000007', { status: 'PAID', amount: '0.00' }),
      ],
    },
  ]);

  it('orders Overdue, Pending, Paid with counts in the title and the right open defaults', () => {
    const views = paymentAccordions({ unpaid, paid });
    expect(views.map((v) => v.title)).toEqual(['Overdue (1)', 'Pending (3)', 'Paid (3)']);
    expect(views.map((v) => v.open)).toEqual([true, true, false]);
  });

  it('groups the rows of an accordion by team, in API order, and shows every loaded paid row', () => {
    const [overdue, pending, paidView] = paymentAccordions({ unpaid, paid });
    expect(overdue?.groups.map((g) => [g.teamName, g.rows.length])).toEqual([
      ['Rosedale Badminton', 1],
    ]);
    expect(pending?.groups.map((g) => [g.teamName, g.rows.length])).toEqual([
      ['Rosedale Badminton', 2],
      ['Albany Smashers', 1],
    ]);
    expect(paidView?.groups[0]?.rows).toHaveLength(3);
  });

  it('an empty accordion is closed and carries its own empty line', () => {
    const views = paymentAccordions({ unpaid: unpaidBody([]), paid: unpaidBody([]) });
    expect(views.map((v) => [v.title, v.open, v.empty])).toEqual([
      ['Overdue (0)', false, 'Nothing overdue.'],
      ['Pending (0)', false, 'Nothing pending.'],
      ['Paid (0)', false, 'No paid games yet.'],
    ]);
  });

  it('Show more follows nextCursor per list, once per list, and keeps the other list’s cursor in the URL', () => {
    const views = paymentAccordions({
      unpaid: { ...unpaid, nextCursor: 'UNEXT' },
      paid: { ...paid, nextCursor: 'PNEXT' },
      paidCursor: 'PCUR',
      unpaidCursor: 'UCUR',
    });
    const hrefs = views.map((v) => v.showMoreHref);
    // The unpaid list is one list in due order: its Show more sits once, under Pending, where the next page continues.
    expect(hrefs[0]).toBeNull();
    expect(hrefs[1]).toBe('/dashboard?tab=payments&paidCursor=PCUR&unpaidCursor=UNEXT');
    expect(hrefs[2]).toBe('/dashboard?tab=payments&paidCursor=PNEXT&unpaidCursor=UCUR');
    const last = paymentAccordions({ unpaid, paid });
    expect(last.every((v) => v.showMoreHref === null)).toBe(true);
  });

  it('puts the unpaid Show more under Overdue when the payer has nothing pending at all', () => {
    const onlyOverdue = unpaidBody(
      [{ ...A, payments: [row('00000000-0000-4000-8000-000000000001', { status: 'OVERDUE' })] }],
      'UNEXT',
      { overdue: 51, pending: 0, paid: 0 },
    );
    const hrefs = paymentAccordions({ unpaid: onlyOverdue, paid: unpaidBody([]) }).map(
      (v) => v.showMoreHref,
    );
    expect(hrefs).toEqual(['/dashboard?tab=payments&unpaidCursor=UNEXT', null, null]);
  });

  it('titles carry the API totals, not the rows of the loaded page', () => {
    const counts = { overdue: 7, pending: 63, paid: 120 };
    const views = paymentAccordions({
      unpaid: { ...unpaid, nextCursor: 'UNEXT', counts },
      paid: { ...paid, nextCursor: 'PNEXT', counts },
    });
    expect(views.map((v) => v.title)).toEqual(['Overdue (7)', 'Pending (63)', 'Paid (120)']);
  });

  it('a later unpaid page with no pending rows of its own still opens Pending by its total', () => {
    const pageTwo = unpaidBody([], null, { overdue: 0, pending: 60, paid: 0 });
    const [overdue, pending] = paymentAccordions({
      unpaid: pageTwo,
      paid: unpaidBody([]),
      unpaidCursor: 'UCUR',
    });
    expect([overdue?.open, pending?.open]).toEqual([false, true]);
    expect(pending?.title).toBe('Pending (60)');
  });

  it('keeps Paid open after its own Show more', () => {
    const views = paymentAccordions({ unpaid, paid, paidCursor: 'PCUR' });
    expect(views.map((v) => v.open)).toEqual([true, true, true]);
  });

  it('decides emptiness of the whole payments area from both reads', () => {
    expect(paymentsEmpty(unpaidBody([]), unpaidBody([]))).toBe(true);
    expect(paymentsEmpty(unpaid, unpaidBody([]))).toBe(false);
    expect(paymentsEmpty(unpaidBody([]), paid)).toBe(false);
  });
});

describe('money stays exact in lib/dashboard (P2)', () => {
  it('no source file parses, rounds or formats money as a JavaScript number', () => {
    const dir = __dirname;
    const sources = readdirSync(dir).filter(
      (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'fixtures.ts',
    );
    expect(sources).toEqual(expect.arrayContaining(['labels.ts', 'paths.ts', 'view.ts']));
    for (const name of sources) {
      const text = readFileSync(join(dir, name), 'utf8');
      expect(text, name).not.toMatch(
        /parseFloat|parseInt|toFixed|Math\.(round|floor|ceil)|Number\(|console\./,
      );
    }
  });
});
