import { describe, expect, it } from 'vitest';
import {
  AdminPaymentsQuery,
  AdminPaymentsResponse,
  AttemptResponse,
  BILLING_FIELD_MESSAGES,
  HoldResolutionRequest,
  IntentErrorResponse,
  MyPaymentsResponse,
  PaymentIdParams,
  PaymentResponse,
  PayoutBlockRequest,
  ReminderResponse,
  SendReminderRequest,
  StartAttemptRequest,
  TopUpRequest,
  TopUpResponse,
  UnpaidPaymentsResponse,
  WalletQuery,
  WalletResponse,
  topUpHeadroomMessage,
} from './billing.ts';
import { ErrorCode } from './errors.ts';
import { parseMoney } from '../money/money.ts';

const KEY = '3b241101-e2bb-4255-8caf-4136c566a962';
const ID = '0b5f1c3e-9d3a-4f7b-8a55-6f2f4d5e6a7b';
const AT = '2026-10-07T09:30:00.000Z';

function failure(schema: { safeParse(v: unknown): unknown }, value: unknown) {
  const result = schema.safeParse(value) as {
    success: boolean;
    error?: { issues: { path: PropertyKey[]; message: string; code: string }[] };
  };
  if (result.success) throw new Error('expected a failure');
  return result.error?.issues ?? [];
}

describe('TopUpRequest (AC-ERROR-1, B1, AC-VERIFY-1)', () => {
  it('parses a 0-2 dp amount to exact Money and keeps the idempotency key', () => {
    expect(TopUpRequest.parse({ amount: '30.00', idempotencyKey: KEY })).toEqual({
      amount: 3000n,
      idempotencyKey: KEY,
    });
    expect(TopUpRequest.parse({ amount: '1', idempotencyKey: KEY }).amount).toBe(100n);
  });

  it.each([
    ['0.50', BILLING_FIELD_MESSAGES.amountBelowMinimum],
    ['0', BILLING_FIELD_MESSAGES.amountBelowMinimum],
    ['-5', BILLING_FIELD_MESSAGES.amountBelowMinimum],
    ['12.345', BILLING_FIELD_MESSAGES.amountFormat],
    ['abc', BILLING_FIELD_MESSAGES.amountFormat],
    ['', BILLING_FIELD_MESSAGES.amountFormat],
  ])('refuses the amount %j with the copy-deck message on the amount field', (amount, message) => {
    const found = failure(TopUpRequest, { amount, idempotencyKey: KEY });
    expect(found[0]?.path).toEqual(['amount']);
    expect(found[0]?.message).toBe(message);
  });

  it('is strict: a client can never send status, userId, teamId or balance, and the key must be a uuid', () => {
    for (const extra of ['status', 'userId', 'teamId', 'balance'] as const) {
      expect(
        failure(TopUpRequest, { amount: '30.00', idempotencyKey: KEY, [extra]: 'x' })[0]?.code,
      ).toBe('unrecognized_keys');
    }
    expect(failure(TopUpRequest, { amount: '30.00', idempotencyKey: 'nope' })[0]?.path).toEqual([
      'idempotencyKey',
    ]);
    expect(failure(TopUpRequest, { amount: '30.00' })[0]?.path).toEqual(['idempotencyKey']);
    expect(failure(TopUpRequest, { amount: 30, idempotencyKey: KEY })[0]?.path).toEqual(['amount']);
  });
});

describe('top-up headroom copy and the start-path contracts (Phase 4a)', () => {
  it('states the most a member can top up, or that the wallet is full', () => {
    expect(topUpHeadroomMessage(parseMoney('10.00'))).toBe('You can top up at most $10.00.');
    expect(topUpHeadroomMessage(parseMoney('0.00'))).toBe('Your wallet is full.');
  });

  it('WalletQuery takes the return-page topUp id (a uuid) next to the cursor, and nothing else', () => {
    expect(WalletQuery.parse({ topUp: ID })).toEqual({ topUp: ID });
    expect(failure(WalletQuery, { topUp: 'nope' })[0]?.path).toEqual(['topUp']);
    expect(failure(WalletQuery, { other: '1' })[0]?.code).toBe('unrecognized_keys');
  });

  it('PaymentIdParams needs a uuid payment id', () => {
    expect(PaymentIdParams.parse({ paymentId: ID })).toEqual({ paymentId: ID });
    expect(failure(PaymentIdParams, { paymentId: 'x' })[0]?.path).toEqual(['paymentId']);
  });

  it('IntentErrorResponse carries the resume block of an in-progress 409 and the reason of a refused start', () => {
    const inProgress = {
      error: {
        code: 'top_up_in_progress',
        message: 'm',
        resume: {
          redirectUrl: 'https://pay.example/consent',
          topUp: { id: ID, amount: '20.00', status: 'OPEN' },
        },
      },
    };
    expect(IntentErrorResponse.parse(inProgress)).toEqual(inProgress);
    const refused = {
      error: { code: 'payment_provider_refused', message: 'm', reason: 'payee_unusable' },
    };
    expect(IntentErrorResponse.parse(refused)).toEqual(refused);
    expect(
      IntentErrorResponse.parse({
        error: {
          code: 'payment_in_progress',
          message: 'm',
          resume: { redirectUrl: null, topUp: null },
        },
      }).error.resume,
    ).toEqual({ redirectUrl: null, topUp: null });
  });
});

describe('action request bodies are strict and carry no money or ownership', () => {
  it('attempt and reminder bodies take only their key; an amount, status or id is refused', () => {
    expect(StartAttemptRequest.parse({ idempotencyKey: KEY })).toEqual({ idempotencyKey: KEY });
    expect(SendReminderRequest.parse({ changeKey: KEY })).toEqual({ changeKey: KEY });
    for (const extra of ['amount', 'status', 'userId', 'teamId', 'paymentId'] as const) {
      expect(failure(StartAttemptRequest, { idempotencyKey: KEY, [extra]: '1.00' })[0]?.code).toBe(
        'unrecognized_keys',
      );
      expect(failure(SendReminderRequest, { changeKey: KEY, [extra]: '1.00' })[0]?.code).toBe(
        'unrecognized_keys',
      );
    }
  });

  it('hold resolution and payout block use enums and no free text; observedAmount only with RECEIVED (CR-14, CR-15, CR-26)', () => {
    expect(HoldResolutionRequest.parse({ outcome: 'NOT_RECEIVED', changeKey: KEY })).toEqual({
      outcome: 'NOT_RECEIVED',
      changeKey: KEY,
    });
    expect(
      HoldResolutionRequest.parse({ outcome: 'RECEIVED', changeKey: KEY, observedAmount: '17.00' }),
    ).toEqual({ outcome: 'RECEIVED', changeKey: KEY, observedAmount: 1700n });
    expect(
      failure(HoldResolutionRequest, {
        outcome: 'NOT_RECEIVED',
        changeKey: KEY,
        observedAmount: '17.00',
      })[0]?.path,
    ).toEqual(['observedAmount']);
    expect(failure(HoldResolutionRequest, { outcome: 'MAYBE', changeKey: KEY })[0]?.path).toEqual([
      'outcome',
    ]);
    expect(
      failure(HoldResolutionRequest, { outcome: 'RECEIVED', changeKey: KEY, note: 'x' })[0]?.code,
    ).toBe('unrecognized_keys');

    expect(
      PayoutBlockRequest.parse({
        reason: 'TEAM_REQUESTED',
        akahuPaymentId: 'pmt_123',
        changeKey: KEY,
      }),
    ).toEqual({ reason: 'TEAM_REQUESTED', akahuPaymentId: 'pmt_123', changeKey: KEY });
    expect(failure(PayoutBlockRequest, { reason: 'because', changeKey: KEY })[0]?.path).toEqual([
      'reason',
    ]);
    expect(
      failure(PayoutBlockRequest, {
        reason: 'OTHER',
        changeKey: KEY,
        note: '12-3456-7890123-00',
      })[0]?.code,
    ).toBe('unrecognized_keys');
  });

  it('the admin list query defaults to UNPAID and refuses an unknown status', () => {
    expect(AdminPaymentsQuery.parse({})).toEqual({ status: 'UNPAID' });
    expect(AdminPaymentsQuery.parse({ status: 'PAID', cursor: 'abc' })).toEqual({
      status: 'PAID',
      cursor: 'abc',
    });
    expect(failure(AdminPaymentsQuery, { status: 'LATE' })[0]?.path).toEqual(['status']);
    expect(AdminPaymentsQuery.parse({ status: 'ALL' })).toEqual({ status: 'ALL' });
  });
});

describe('response contracts', () => {
  const wallet = {
    wallet: {
      balance: '12.50',
      cap: '100.00',
      headroom: '87.50',
      lowCreditThreshold: '20.00',
      pendingTopUp: null,
      lastClosedTopUp: null,
    },
    transactions: [
      {
        id: ID,
        type: 'AUTO_DEDUCTION',
        amount: '-17.00',
        resultingBalance: '13.00',
        createdAt: AT,
        session: { id: ID, location: 'Test Hall', startsAt: AT },
      },
      {
        id: KEY,
        type: 'TOPUP',
        amount: '30.00',
        resultingBalance: '30.00',
        createdAt: AT,
        session: null,
      },
    ],
    nextCursor: null,
  };

  it('parses the wallet read model and keeps money as strings (a JSON number or a 1-dp amount is refused)', () => {
    expect(WalletResponse.parse(wallet)).toEqual(wallet);
    expect(
      failure(WalletResponse, { ...wallet, wallet: { ...wallet.wallet, balance: 12.5 } }).length,
    ).toBeGreaterThan(0);
    expect(
      failure(WalletResponse, { ...wallet, wallet: { ...wallet.wallet, headroom: '87.5' } }).length,
    ).toBeGreaterThan(0);
    expect(failure(WalletResponse, { ...wallet, extra: true })[0]?.code).toBe('unrecognized_keys');
    const open = {
      ...wallet,
      wallet: {
        ...wallet.wallet,
        pendingTopUp: {
          id: ID,
          amount: '30.00',
          status: 'OPEN',
          outcome: 'processing',
          createdAt: AT,
        },
        lastClosedTopUp: {
          id: KEY,
          amount: '20.00',
          status: 'UNAPPLIED',
          unappliedReason: 'OVER_CAP',
          closedAt: AT,
        },
      },
    };
    expect(WalletResponse.parse(open).wallet.pendingTopUp?.outcome).toBe('processing');
  });

  it('parses the top-up and attempt creation answers, and the reminder answer', () => {
    const topUp = {
      topUp: { id: ID, amount: '30.00', status: 'OPEN' },
      redirectUrl: 'https://example.test/a',
    };
    expect(TopUpResponse.parse(topUp)).toEqual(topUp);
    expect(AttemptResponse.parse({ redirectUrl: 'https://example.test/a' })).toEqual({
      redirectUrl: 'https://example.test/a',
    });
    expect(failure(TopUpResponse, { ...topUp, redirectUrl: 'not a url' }).length).toBeGreaterThan(
      0,
    );
    expect(ReminderResponse.parse({ sent: true, lastReminderAt: AT })).toEqual({
      sent: true,
      lastReminderAt: AT,
    });
  });

  const payment = {
    id: ID,
    reference: 'SGM7K2QH4X9',
    teamName: 'Tuesday Hoops',
    session: { id: KEY, location: 'Test Hall', startsAt: AT },
    amount: '17.00',
    gstAmount: '2.22',
    lines: [{ position: 0, basis: 'FLAT', unitFee: '17.00' }],
    status: 'PENDING',
    billingType: 'PER_GAME',
    dueDate: AT,
    paidAt: null,
    reason: 'CONFIRMED',
    attempt: null,
    onHold: false,
    payoutBlocked: false,
  };

  it('parses the payer payment read, the per-team list and the cross-team unpaid list (CR-16, CR-17)', () => {
    expect(PaymentResponse.parse({ payment })).toEqual({ payment });
    expect(
      PaymentResponse.parse({
        payment: { ...payment, attempt: { status: 'OPEN', startedAt: AT, outcome: 'processing' } },
      }).payment.attempt?.outcome,
    ).toBe('processing');
    const row = {
      id: ID,
      reference: 'SGM7K2QH4X9',
      sessionId: KEY,
      sessionStartsAt: AT,
      location: 'Test Hall',
      amount: '17.00',
      status: 'OVERDUE',
      billingType: 'PER_GAME',
      dueDate: AT,
      paidAt: null,
      reason: 'LATE_WITHDRAWAL',
      outcome: 'none',
      onHold: false,
      payoutBlocked: true,
    };
    expect(MyPaymentsResponse.parse({ payments: [row], nextCursor: 'c1' }).nextCursor).toBe('c1');
    expect(
      UnpaidPaymentsResponse.parse({
        teams: [{ teamId: ID, teamName: 'Tuesday Hoops', payments: [row] }],
        nextCursor: null,
      }).teams,
    ).toHaveLength(1);
    expect(failure(PaymentResponse, { payment: { ...payment, userId: ID } })[0]?.code).toBe(
      'unrecognized_keys',
    );
  });

  it('the admin list shows names, never an email or a bank detail, and derives lastReminderAt', () => {
    const item = {
      id: ID,
      reference: 'SGM7K2QH4X9',
      player: { userId: KEY, fullName: 'Sam Player' },
      sessionStartsAt: AT,
      amount: '17.00',
      status: 'PENDING',
      dueDate: AT,
      paidAt: null,
      lastReminderAt: null,
      onHold: false,
    };
    const body = { payments: [item], nextCursor: null, payoutBlocked: false };
    expect(AdminPaymentsResponse.parse(body)).toEqual(body);
    expect(
      failure(AdminPaymentsResponse, {
        ...body,
        payments: [{ ...item, player: { ...item.player, email: 'a@b.test' } }],
      })[0]?.code,
    ).toBe('unrecognized_keys');
  });
});

describe('billing error codes (Q1c, CR-15)', () => {
  it('adds the eight billing codes and reuses payout_not_configured and not_found', () => {
    for (const code of [
      'payment_settled',
      'payment_in_progress',
      'payment_on_hold',
      'top_up_in_progress',
      'payment_provider_unavailable',
      'payment_provider_refused',
      'reminder_too_soon',
      'hold_resolved_by_provider',
      'payout_not_configured',
      'not_found',
    ]) {
      expect(ErrorCode, code).toContain(code);
    }
    expect(new Set(ErrorCode).size).toBe(ErrorCode.length);
  });
});
