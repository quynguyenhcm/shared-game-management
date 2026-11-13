import type {
  AdminPaymentsResponse,
  MyPaymentRow,
  PaymentResponse,
  WalletResponse,
} from '@sgm/shared';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_FILTERS,
  REMINDER_COOLDOWN_MS,
  adminFilterOf,
  adminRowAction,
  canDownloadInvoice,
  canPayRow,
  groupPayments,
  groupPaymentsByTeam,
  olderPaidHref,
  paymentState,
  reminderCooldown,
  validateTopUp,
  walletState,
} from './wallet-view.ts';

const ID = '7f3c2b1a-1111-4222-8333-444455556666';
type Wallet = WalletResponse['wallet'];
type Payment = PaymentResponse['payment'];
type AdminRow = AdminPaymentsResponse['payments'][number];

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

describe('walletState (UI/UX Wallet section states)', () => {
  it('form: the headroom sentence, the hint and the minimum come from the read model', () => {
    const state = walletState(wallet(), {});
    expect(state).toMatchObject({
      kind: 'form',
      balanceText: '$12.50',
      headroomLine: 'You can top up to $87.50 more (wallet limit $100.00).',
      hint: 'Between $1.00 and $87.50.',
      notice: null,
    });
  });

  it('full: headroom 0.00 removes the form', () => {
    expect(walletState(wallet({ balance: '100.00', headroom: '0.00' }), {})).toMatchObject({
      kind: 'full',
      balanceText: '$100.00',
      line: 'Your wallet is full.',
    });
  });

  it('processing: an open top-up hides the form; ?topUp= matching it means the player came back from Akahu', () => {
    const pendingTopUp = {
      id: ID,
      amount: '30.00',
      status: 'OPEN' as const,
      outcome: 'processing' as const,
      createdAt: '2026-10-07T07:00:00.000Z',
    };
    expect(walletState(wallet({ pendingTopUp }), { topUp: ID })).toMatchObject({
      kind: 'processing',
      returned: true,
      amountText: '$30.00',
    });
    const left = walletState(wallet({ pendingTopUp }), {});
    expect(left).toMatchObject({ kind: 'processing', returned: false });
    expect(left.kind === 'processing' && left.startedLine).toBe(
      'Top-up of $30.00 started Wed 7 Oct, 8:00 pm. Finish it at Akahu, or it will close by itself.',
    );
  });

  it('held top-up: no form and no claim that nothing was charged', () => {
    const state = walletState(
      wallet({
        pendingTopUp: {
          id: ID,
          amount: '30.00',
          status: 'HELD',
          outcome: 'held',
          createdAt: '2026-10-07T07:00:00.000Z',
        },
      }),
      {},
    );
    expect(state.kind).toBe('held');
    expect(JSON.stringify(state)).not.toContain("haven't been charged");
  });

  it('overflow notice (B3): a closed over-cap top-up explains it and names the cap', () => {
    const state = walletState(
      wallet({
        lastClosedTopUp: {
          id: ID,
          amount: '30.00',
          status: 'UNAPPLIED',
          unappliedReason: 'OVER_CAP',
          closedAt: '2026-10-07T07:00:00.000Z',
        },
      }),
      {},
    );
    expect(state).toMatchObject({
      kind: 'form',
      notice: {
        tone: 'notice',
        text: "Your top-up of $30.00 arrived but would have taken your wallet over $100.00, so it wasn't added. The team admins have been told. Ask them about a refund.",
      },
    });
  });

  it('declined notice only when the return lands on that closed top-up', () => {
    const closed = {
      id: ID,
      amount: '30.00',
      status: 'CLOSED' as const,
      unappliedReason: null,
      closedAt: '2026-10-07T07:00:00.000Z',
    };
    expect(walletState(wallet({ lastClosedTopUp: closed }), { topUp: ID })).toMatchObject({
      notice: { text: "Your top-up didn't go through. You haven't been charged." },
    });
    expect(walletState(wallet({ lastClosedTopUp: closed }), {})).toMatchObject({ notice: null });
  });
});

describe('validateTopUp (client validation with the shared money functions)', () => {
  const headroom = '15.00';

  it.each([
    ['', 'Enter an amount, for example 20.00.'],
    ['   ', 'Enter an amount, for example 20.00.'],
    ['abc', 'Enter an amount in dollars, like 20.00.'],
    ['12.345', 'Enter an amount in dollars, like 20.00.'],
    ['-5', 'Enter at least $1.00.'],
    ['0.50', 'Enter at least $1.00.'],
    ['15.01', 'You can top up at most $15.00.'],
  ])('rejects %j', (amount, message) => {
    expect(validateTopUp({ amount }, headroom)).toEqual({ amount: [message] });
  });

  it('accepts the bounds exactly, with or without cents', () => {
    expect(validateTopUp({ amount: '1' }, headroom)).toEqual({});
    expect(validateTopUp({ amount: '15.00' }, headroom)).toEqual({});
    expect(validateTopUp({ amount: ' 20 ' }, '87.50')).toEqual({});
  });

  it('a full wallet says so', () => {
    expect(validateTopUp({ amount: '5' }, '0.00')).toEqual({ amount: ['Your wallet is full.'] });
  });
});

const payment = (change: Record<string, unknown> = {}): Payment =>
  ({
    id: ID,
    reference: 'P-1',
    teamName: 'Rosedale',
    session: { id: ID, location: 'Rosedale Hall', startsAt: '2026-10-07T07:00:00.000Z' },
    amount: '17.00',
    gstAmount: '0.00',
    lines: [],
    status: 'PENDING',
    billingType: 'PER_GAME',
    dueDate: '2026-10-09T22:00:00.000Z',
    paidAt: null,
    reason: 'CONFIRMED',
    attempt: null,
    onHold: false,
    payoutBlocked: false,
    ...change,
  }) as unknown as Payment;
const attempt = (outcome: 'processing' | 'cancelled' | 'failed' | 'held' | 'none') => ({
  status: 'OPEN' as const,
  startedAt: '2026-10-08T01:00:00.000Z',
  outcome,
});

describe('paymentState: the documented priority (paid > hold > payout blocked > processing > open attempt > declined > overdue > pending)', () => {
  it.each([
    ['pending', payment(), {}, 'pending', 'pay'],
    ['overdue', payment({ status: 'OVERDUE' }), {}, 'overdue', 'pay'],
    [
      'attempt open, left Akahu',
      payment({ attempt: attempt('processing') }),
      {},
      'attempt_open',
      'continue',
    ],
    [
      'processing after return',
      payment({ attempt: attempt('processing') }),
      { return: '1' },
      'processing',
      null,
    ],
    [
      'return flag but no open attempt falls through to pending',
      payment(),
      { return: '1' },
      'pending',
      'pay',
    ],
    ['declined', payment({ attempt: attempt('failed') }), {}, 'declined', 'retry'],
    ['cancelled', payment({ attempt: attempt('cancelled') }), {}, 'declined', 'retry'],
    ['hold via onHold', payment({ onHold: true, attempt: attempt('held') }), {}, 'hold', null],
    ['payout blocked', payment({ payoutBlocked: true }), {}, 'payout_blocked', null],
    ['hold beats payout blocked', payment({ onHold: true, payoutBlocked: true }), {}, 'hold', null],
    [
      'hold beats processing',
      payment({ onHold: true, attempt: attempt('processing') }),
      { return: '1' },
      'hold',
      null,
    ],
    [
      'payout blocked beats an open attempt',
      payment({ payoutBlocked: true, attempt: attempt('processing') }),
      {},
      'payout_blocked',
      null,
    ],
    [
      'paid wins over everything',
      payment({ status: 'PAID', onHold: true, payoutBlocked: true, attempt: attempt('held') }),
      { return: '1' },
      'paid_akahu',
      null,
    ],
    [
      'paid from wallet',
      payment({
        status: 'PAID',
        billingType: 'PREPAID_CREDIT',
        paidAt: '2026-10-08T01:00:00.000Z',
      }),
      {},
      'paid_wallet',
      null,
    ],
    [
      'no charge (B7)',
      payment({ status: 'PAID', amount: '0.00', billingType: 'PREPAID_CREDIT' }),
      {},
      'no_charge',
      null,
    ],
  ] as const)('%s', (_name, input, search, kind, action) => {
    const state = paymentState(input, search);
    expect(state.kind).toBe(kind);
    expect(state.action).toBe(action);
  });

  it('the hold state offers no pay action and no "haven\'t been charged" wording anywhere in its model', () => {
    const state = paymentState(payment({ onHold: true, attempt: attempt('held') }), {});
    expect(state.action).toBeNull();
    expect(JSON.stringify(state)).not.toContain("haven't been charged");
  });

  it('overdue adds the register-for-more-games sentence only when the player has 3 or more overdue', () => {
    const overdue = payment({ status: 'OVERDUE' });
    expect(paymentState(overdue, {}, { overdueCount: 3 }).message).toBe(
      'Overdue since Sat 10 Oct. Pay it to register for more games.',
    );
    expect(paymentState(overdue, {}, { overdueCount: 2 }).message).toBe(
      'Overdue since Sat 10 Oct.',
    );
    expect(paymentState(overdue, {}).message).toBe('Overdue since Sat 10 Oct.');
  });

  it('settled copy names the date', () => {
    expect(
      paymentState(
        payment({
          status: 'PAID',
          paidAt: '2026-10-08T01:00:00.000Z',
          billingType: 'PREPAID_CREDIT',
        }),
        {},
      ).message,
    ).toBe('Paid from your wallet on Thu 8 Oct.');
    expect(
      paymentState(payment({ status: 'PAID', paidAt: '2026-10-08T01:00:00.000Z' }), {}).message,
    ).toBe('Paid on Thu 8 Oct.');
    expect(paymentState(payment({ status: 'PAID', amount: '0.00' }), {}).message).toBe(
      "There's no charge for this game.",
    );
  });
});

const row = (change: Record<string, unknown>): MyPaymentRow =>
  ({
    id: ID,
    reference: 'P',
    sessionId: ID,
    sessionStartsAt: '2026-10-07T07:00:00.000Z',
    location: 'Rosedale Hall',
    amount: '17.00',
    status: 'PENDING',
    billingType: 'PER_GAME',
    dueDate: '2026-10-09T22:00:00.000Z',
    paidAt: null,
    reason: 'CONFIRMED',
    outcome: 'none',
    onHold: false,
    payoutBlocked: false,
    ...change,
  }) as MyPaymentRow;

describe('groupPayments / groupPaymentsByTeam', () => {
  it('orders overdue and pending oldest-due first and paid newest first, caps paid at 10, and omits empty groups', () => {
    const rows = [
      row({ id: 'p2', status: 'PENDING', dueDate: '2026-10-20T00:00:00.000Z' }),
      row({ id: 'p1', status: 'PENDING', dueDate: '2026-10-15T00:00:00.000Z' }),
      row({ id: 'o2', status: 'OVERDUE', dueDate: '2026-10-05T00:00:00.000Z' }),
      row({ id: 'o1', status: 'OVERDUE', dueDate: '2026-10-01T00:00:00.000Z' }),
      ...Array.from({ length: 12 }, (_, index) =>
        row({
          id: `paid${index}`,
          status: 'PAID',
          paidAt: `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        }),
      ),
    ];
    const groups = groupPayments(rows);
    expect(groups.overdue.map((r) => r.id)).toEqual(['o1', 'o2']);
    expect(groups.pending.map((r) => r.id)).toEqual(['p1', 'p2']);
    expect(groups.paid).toHaveLength(10);
    expect(groups.paid[0]?.id).toBe('paid11');
    expect(groups.paidTruncated).toBe(true);
    expect(groupPayments([]).overdue).toEqual([]);
    expect(groupPayments([]).paidTruncated).toBe(false);
  });

  it('keeps a held payment in its own status group', () => {
    const groups = groupPayments([row({ id: 'h', status: 'OVERDUE', onHold: true })]);
    expect(groups.overdue.map((r) => r.id)).toEqual(['h']);
  });

  it('groups the cross-team list per team, overdue before pending within a team', () => {
    const teams = groupPaymentsByTeam([
      {
        teamId: 'T1',
        teamName: 'Rosedale',
        payments: [row({ id: 'a' }), row({ id: 'b', status: 'OVERDUE' })],
      },
    ]);
    expect(teams).toHaveLength(1);
    expect(teams[0]?.teamName).toBe('Rosedale');
    expect(teams[0]?.groups.overdue.map((r) => r.id)).toEqual(['b']);
    expect(teams[0]?.groups.pending.map((r) => r.id)).toEqual(['a']);
  });
});

describe('reminderCooldown (B6): the cooldown length is one shared constant', () => {
  const sent = '2026-10-29T01:14:00.000Z';

  it('is active inside the window and reports when another can be sent', () => {
    const now = new Date(Date.parse(sent) + REMINDER_COOLDOWN_MS - 1);
    const state = reminderCooldown(sent, now);
    expect(state.active).toBe(true);
    expect(state.availableAt).toBe(new Date(Date.parse(sent) + REMINDER_COOLDOWN_MS).toISOString());
  });

  it('is over exactly at the window end, and never active for no reminder', () => {
    expect(reminderCooldown(sent, new Date(Date.parse(sent) + REMINDER_COOLDOWN_MS)).active).toBe(
      false,
    );
    expect(reminderCooldown(null, new Date())).toEqual({ active: false, availableAt: null });
    expect(REMINDER_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
  });
});

const adminRow = (change: Record<string, unknown> = {}): AdminRow =>
  ({
    id: ID,
    reference: 'P',
    player: { userId: ID, fullName: 'Priya Shah' },
    sessionStartsAt: '2026-10-07T07:00:00.000Z',
    amount: '17.00',
    status: 'OVERDUE',
    dueDate: '2026-10-09T22:00:00.000Z',
    paidAt: null,
    lastReminderAt: null,
    onHold: false,
    ...change,
  }) as AdminRow;

describe('adminRowAction: reminder visible only when it can work (CR-18, Phase 3 notes)', () => {
  const now = new Date('2026-10-29T03:30:00.000Z');
  it.each([
    ['unpaid', adminRow(), false, 'reminder'],
    ['pending', adminRow({ status: 'PENDING' }), false, 'reminder'],
    ['paid', adminRow({ status: 'PAID', paidAt: '2026-10-10T00:00:00.000Z' }), false, 'none'],
    ['held', adminRow({ onHold: true }), false, 'hold'],
    ['held and payout blocked still shows the hold', adminRow({ onHold: true }), true, 'hold'],
    ['payout blocked hides the reminder', adminRow(), true, 'none'],
    [
      'within the cooldown',
      adminRow({ lastReminderAt: '2026-10-29T01:14:00.000Z' }),
      false,
      'cooldown',
    ],
  ] as const)('%s', (_name, input, payoutBlocked, expected) => {
    expect(adminRowAction(input, { payoutBlocked, now })).toBe(expected);
  });
});

describe('admin filter (?status=) and canPayRow', () => {
  it('Unpaid is the default and maps to the API filter; Paid and All come from the URL; junk is Unpaid', () => {
    expect(adminFilterOf(undefined).api).toBe('UNPAID');
    expect(adminFilterOf(null).id).toBe('unpaid');
    expect(adminFilterOf('paid').api).toBe('PAID');
    expect(adminFilterOf('all').api).toBe('ALL');
    expect(adminFilterOf('PAID; drop table').id).toBe('unpaid');
    expect(ADMIN_FILTERS.map((filter) => filter.label)).toEqual(['Unpaid', 'Paid', 'All']);
  });

  it('only an unpaid, not-held, not-blocked row can be paid', () => {
    expect(canPayRow({ status: 'OVERDUE', onHold: false, payoutBlocked: false })).toBe(true);
    expect(canPayRow({ status: 'PAID', onHold: false, payoutBlocked: false })).toBe(false);
    expect(canPayRow({ status: 'PENDING', onHold: true, payoutBlocked: false })).toBe(false);
    expect(canPayRow({ status: 'PENDING', onHold: false, payoutBlocked: true })).toBe(false);
  });
});

describe('invoice download rules (AC-ENTRY-1, R5)', () => {
  it('offers the download exactly when the API says a document is available, whatever the status or GST amount', () => {
    expect(canDownloadInvoice({ document: { available: true } })).toBe(true);
    expect(canDownloadInvoice({ document: { available: false } })).toBe(false);
  });

  const paidRows = (count: number): MyPaymentRow[] =>
    Array.from(
      { length: count },
      (_, index) =>
        ({
          id: `id-${index}`,
          status: 'PAID',
          paidAt: `2026-10-${String(index + 1).padStart(2, '0')}T01:00:00.000Z`,
          dueDate: '2026-10-01T00:00:00.000Z',
        }) as MyPaymentRow,
    );

  it('caps the paid list at ten by default and shows every loaded paid row with paidLimit null, newest first', () => {
    const capped = groupPayments(paidRows(12));
    expect(capped.paid).toHaveLength(10);
    expect(capped.paidTruncated).toBe(true);
    const all = groupPayments(paidRows(12), { paidLimit: null });
    expect(all.paid).toHaveLength(12);
    expect(all.paidTruncated).toBe(false);
    expect(all.paid[0]?.id).toBe('id-11');
  });

  it('leads Show older paid games to the full view, then through the API cursor, and to nothing at the end', () => {
    const wallet = '/teams/t/wallet';
    expect(olderPaidHref(wallet, { showAll: false, truncated: true, nextCursor: null })).toBe(
      '/teams/t/wallet?payments=all#payments',
    );
    expect(olderPaidHref(wallet, { showAll: true, truncated: false, nextCursor: 'a b' })).toBe(
      '/teams/t/wallet?payments=all&pcursor=a+b#payments',
    );
    expect(olderPaidHref(wallet, { showAll: false, truncated: false, nextCursor: 'c' })).toBe(
      '/teams/t/wallet?payments=all&pcursor=c#payments',
    );
    expect(olderPaidHref(wallet, { showAll: true, truncated: false, nextCursor: null })).toBeNull();
  });
});
