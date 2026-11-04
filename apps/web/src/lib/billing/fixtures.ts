import type {
  AdminPaymentsResponse,
  MyPaymentRow,
  PaymentResponse,
  UnpaidPaymentsResponse,
  WalletResponse,
} from '@sgm/shared';

/**
 * Wire-shaped fixtures of the billing read models for the page tests. They are JSON (money as plain text), so they are
 * asserted into the branded response types, the way the API client delivers them.
 */

export const TEAM_ID = '7f3c2b1a-1111-4222-8333-444455556666';
export const PAYMENT_ID = '22222222-2222-4222-8222-222222222222';
export const SESSION_AT = '2026-10-07T07:00:00.000Z'; // Wed 7 Oct, 8:00 pm NZDT
export const DUE_AT = '2026-10-09T22:00:00.000Z'; // Sat 10 Oct

export const wallet = (change: Record<string, unknown> = {}): WalletResponse['wallet'] =>
  ({
    balance: '12.50',
    cap: '100.00',
    headroom: '87.50',
    lowCreditThreshold: '20.00',
    pendingTopUp: null,
    lastClosedTopUp: null,
    ...change,
  }) as WalletResponse['wallet'];

export const walletBody = (
  change: Record<string, unknown> = {},
  transactions: unknown[] = [],
  nextCursor: string | null = null,
): WalletResponse => ({ wallet: wallet(change), transactions, nextCursor }) as WalletResponse;

export const paymentRow = (change: Record<string, unknown> = {}): MyPaymentRow =>
  ({
    id: PAYMENT_ID,
    reference: 'P-1',
    sessionId: PAYMENT_ID,
    sessionStartsAt: SESSION_AT,
    location: 'Rosedale Hall',
    amount: '17.00',
    status: 'PENDING',
    billingType: 'PER_GAME',
    dueDate: DUE_AT,
    paidAt: null,
    reason: 'CONFIRMED',
    outcome: 'none',
    onHold: false,
    payoutBlocked: false,
    ...change,
  }) as MyPaymentRow;

export const payment = (change: Record<string, unknown> = {}): PaymentResponse['payment'] =>
  ({
    id: PAYMENT_ID,
    reference: 'P-1',
    teamName: 'Rosedale Badminton',
    session: { id: PAYMENT_ID, location: 'Rosedale Hall', startsAt: SESSION_AT },
    amount: '17.00',
    gstAmount: '0.00',
    lines: [{ position: 0, basis: 'FLAT', unitFee: '17.00' }],
    status: 'PENDING',
    billingType: 'PER_GAME',
    dueDate: DUE_AT,
    paidAt: null,
    reason: 'CONFIRMED',
    attempt: null,
    onHold: false,
    payoutBlocked: false,
    ...change,
  }) as unknown as PaymentResponse['payment'];

export const unpaidBody = (
  teams: { teamId: string; teamName: string; payments: MyPaymentRow[] }[],
  nextCursor: string | null = null,
): UnpaidPaymentsResponse => ({ teams, nextCursor });

export const adminRow = (
  change: Record<string, unknown> = {},
): AdminPaymentsResponse['payments'][number] =>
  ({
    id: PAYMENT_ID,
    reference: 'P-1',
    player: { userId: '33333333-3333-4333-8333-333333333333', fullName: 'Priya Shah' },
    sessionStartsAt: SESSION_AT,
    amount: '17.00',
    status: 'PENDING',
    dueDate: DUE_AT,
    paidAt: null,
    lastReminderAt: null,
    onHold: false,
    ...change,
  }) as AdminPaymentsResponse['payments'][number];

export const adminBody = (
  payments: AdminPaymentsResponse['payments'],
  change: { nextCursor?: string | null; payoutBlocked?: boolean } = {},
): AdminPaymentsResponse => ({
  payments,
  nextCursor: change.nextCursor ?? null,
  payoutBlocked: change.payoutBlocked ?? false,
});
