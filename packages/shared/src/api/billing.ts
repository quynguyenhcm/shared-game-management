/**
 * Request and response contracts for the wallet, payment, reminder, hold-resolution and payout-block routes,
 * shared by the Fastify routes and the web api-client (wallet-and-akahu-billing AC-VERIFY-1; Invocation Method, with
 * the read-model additions of CR-15, CR-16 and CR-17). Phase 1 defines the shapes only: no route is registered here.
 *
 * Requests are strict, so a client can never set what the server owns: no `status`, `userId`, `teamId`, `balance` and
 * no payment `amount` (an attempt pays the stored amount). The one amount a client sends is the top-up amount.
 * Money crosses the wire as a 2-dp `MoneyString` and is parsed to exact `Money` on the way in, instants as ISO-8601
 * UTC strings. Responses carry names, never an email address or a bank detail; reasons and outcomes are enums.
 * Validation messages are the copy deck of the UI/UX document and never echo input.
 */
import { z } from 'zod';
import { lt, isNegative, isZero, parseMoney, type Money } from '../money/money.ts';
import { moneyStringSchema } from '../money/zod.ts';
import { TOP_UP_MINIMUM } from '../billing/wallet-limits.ts';
import {
  BillingType,
  CreditTransactionType,
  FeeBasis,
  PaymentIntentStatus,
  PaymentResolutionReason,
  PaymentStatus,
  PaymentUnappliedReason,
  PayoutBlockReason,
} from '../types/enums.ts';

export const BILLING_FIELD_MESSAGES = {
  amountFormat: 'Enter an amount in dollars, like 20.00.',
  amountBelowMinimum: 'Enter at least $1.00.',
  amountNotPositive: 'Enter an amount above $0.00.',
  keyInvalid: 'Reload the page and try again.',
  observedAmountNotAllowed: 'Only a received payment has an observed amount.',
  akahuPaymentIdFormat: 'Use the payment id exactly as Akahu shows it.',
} as const;

const M = BILLING_FIELD_MESSAGES;

const isoInstant = z.iso.datetime();
const key = z.uuidv4({ error: M.keyInvalid });

/** A 0-2 dp amount of at least the minimum top-up, parsed to exact `Money` (B1). The headroom check is the server's. */
const topUpAmount = z.string({ error: M.amountFormat }).transform((raw, ctx): Money => {
  let parsed: Money;
  try {
    parsed = parseMoney(raw.trim());
  } catch {
    ctx.addIssue({ code: 'custom', message: M.amountFormat });
    return z.NEVER;
  }
  if (lt(parsed, TOP_UP_MINIMUM)) {
    ctx.addIssue({ code: 'custom', message: M.amountBelowMinimum });
    return z.NEVER;
  }
  return parsed;
});

/** A 0-2 dp amount above $0.00 (an observed bank amount in a hold resolution). */
const positiveAmount = z.string({ error: M.amountFormat }).transform((raw, ctx): Money => {
  let parsed: Money;
  try {
    parsed = parseMoney(raw.trim());
  } catch {
    ctx.addIssue({ code: 'custom', message: M.amountFormat });
    return z.NEVER;
  }
  if (isNegative(parsed) || isZero(parsed)) {
    ctx.addIssue({ code: 'custom', message: M.amountNotPositive });
    return z.NEVER;
  }
  return parsed;
});

// ---------------------------------------------------------------------------------------------
// Requests (strict)
// ---------------------------------------------------------------------------------------------

/** `POST /teams/:teamId/wallet/top-ups`. A repeat with the same key returns the same top-up. */
export const TopUpRequest = z.strictObject({
  amount: topUpAmount,
  idempotencyKey: key,
});
export type TopUpRequest = z.infer<typeof TopUpRequest>;

/** `POST /payments/:paymentId/attempts`. The amount is the payment's own; the client sends only its key. */
export const StartAttemptRequest = z.strictObject({ idempotencyKey: key });
export type StartAttemptRequest = z.infer<typeof StartAttemptRequest>;

/** `POST /teams/:teamId/payments/:paymentId/reminders`. A replay by `changeKey` sends nothing more. */
export const SendReminderRequest = z.strictObject({ changeKey: key });
export type SendReminderRequest = z.infer<typeof SendReminderRequest>;

/**
 * `POST /payments/:paymentId/hold-resolution` and `POST /teams/:teamId/wallet/top-ups/:topUpId/hold-resolution`
 * (GLOBAL_ADMIN only; CR-15, CR-26). `observedAmount` accompanies RECEIVED: for an AMOUNT_MISMATCH hold the server
 * applies it only when it equals the intent amount.
 */
export const HoldResolutionRequest = z
  .strictObject({
    outcome: z.enum(['RECEIVED', 'NOT_RECEIVED']),
    changeKey: key,
    observedAmount: positiveAmount.optional(),
  })
  .refine((body) => body.outcome === 'RECEIVED' || body.observedAmount === undefined, {
    path: ['observedAmount'],
    message: M.observedAmountNotAllowed,
  });
export type HoldResolutionRequest = z.infer<typeof HoldResolutionRequest>;

/** `POST /teams/:teamId/payout-block` (GLOBAL_ADMIN only; A3, CR-14): an enum reason, no free text. */
export const PayoutBlockRequest = z.strictObject({
  reason: z.enum(PayoutBlockReason),
  akahuPaymentId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, { error: M.akahuPaymentIdFormat })
    .optional(),
  changeKey: key,
});
export type PayoutBlockRequest = z.infer<typeof PayoutBlockRequest>;

const cursor = z.string().min(1).max(512);

/** `GET /teams/:teamId/payments?status=&cursor=`: "UNPAID" is PENDING and OVERDUE (the default). */
export const AdminPaymentsQuery = z.strictObject({
  status: z.enum(['UNPAID', 'PENDING', 'OVERDUE', 'PAID', 'FAILED']).default('UNPAID'),
  cursor: cursor.optional(),
});
export type AdminPaymentsQuery = z.infer<typeof AdminPaymentsQuery>;

/** `GET /payments/me?status=UNPAID` and `GET /teams/:teamId/payments/me` (CR-16, CR-17). */
export const MyPaymentsQuery = z.strictObject({
  status: z.enum(['UNPAID']).optional(),
  cursor: cursor.optional(),
});
export type MyPaymentsQuery = z.infer<typeof MyPaymentsQuery>;

/** `GET /teams/:teamId/wallet?cursor=`: the ledger is cursor-paginated. */
export const WalletQuery = z.strictObject({ cursor: cursor.optional() });
export type WalletQuery = z.infer<typeof WalletQuery>;

// ---------------------------------------------------------------------------------------------
// Responses (strict)
// ---------------------------------------------------------------------------------------------

/** What the page says about the latest attempt or top-up (CR-17). */
export const IntentOutcome = z.enum(['processing', 'cancelled', 'failed', 'held', 'none']);
export type IntentOutcome = z.infer<typeof IntentOutcome>;

export const PaymentReason = z.enum(['CONFIRMED', 'LATE_WITHDRAWAL']);
export type PaymentReason = z.infer<typeof PaymentReason>;

const SessionRef = z.strictObject({
  id: z.uuid(),
  location: z.string(),
  startsAt: isoInstant,
});

/** `GET /teams/:teamId/wallet`: a member with no wallet row reads 0.00 (a read never creates one). */
export const WalletResponse = z.strictObject({
  wallet: z.strictObject({
    balance: moneyStringSchema,
    cap: moneyStringSchema,
    headroom: moneyStringSchema,
    lowCreditThreshold: moneyStringSchema,
    pendingTopUp: z
      .strictObject({
        id: z.uuid(),
        amount: moneyStringSchema,
        status: z.enum(PaymentIntentStatus),
        outcome: IntentOutcome,
        createdAt: isoInstant,
      })
      .nullable(),
    /** The last finished top-up that was not credited, for the "received but not applied" notice (B3). */
    lastClosedTopUp: z
      .strictObject({
        id: z.uuid(),
        amount: moneyStringSchema,
        status: z.enum(['UNAPPLIED', 'CLOSED']),
        unappliedReason: z.enum(PaymentUnappliedReason).nullable(),
        closedAt: isoInstant,
      })
      .nullable(),
  }),
  transactions: z.array(
    z.strictObject({
      id: z.uuid(),
      type: z.enum(CreditTransactionType),
      amount: moneyStringSchema,
      resultingBalance: moneyStringSchema,
      createdAt: isoInstant,
      session: SessionRef.nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type WalletResponse = z.infer<typeof WalletResponse>;

/** 201 from `POST /teams/:teamId/wallet/top-ups`: the Akahu URL the browser follows. */
export const TopUpResponse = z.strictObject({
  topUp: z.strictObject({
    id: z.uuid(),
    amount: moneyStringSchema,
    status: z.enum(PaymentIntentStatus),
  }),
  redirectUrl: z.url(),
});
export type TopUpResponse = z.infer<typeof TopUpResponse>;

/** 201 from `POST /payments/:paymentId/attempts`. */
export const AttemptResponse = z.strictObject({ redirectUrl: z.url() });
export type AttemptResponse = z.infer<typeof AttemptResponse>;

/** One payment of the caller, in a per-team list (`GET /teams/:teamId/payments/me`) or the cross-team unpaid list. */
export const MyPaymentRow = z.strictObject({
  id: z.uuid(),
  reference: z.string(),
  sessionId: z.uuid(),
  sessionStartsAt: isoInstant,
  location: z.string(),
  amount: moneyStringSchema,
  status: z.enum(PaymentStatus),
  billingType: z.enum(BillingType),
  dueDate: isoInstant,
  paidAt: isoInstant.nullable(),
  reason: PaymentReason,
  outcome: IntentOutcome,
  onHold: z.boolean(),
  payoutBlocked: z.boolean(),
});
export type MyPaymentRow = z.infer<typeof MyPaymentRow>;

export const MyPaymentsResponse = z.strictObject({
  payments: z.array(MyPaymentRow),
  nextCursor: z.string().nullable(),
});
export type MyPaymentsResponse = z.infer<typeof MyPaymentsResponse>;

/** `GET /payments/me?status=UNPAID` (CR-16): the caller's payable and held payments across teams, grouped by team. */
export const UnpaidPaymentsResponse = z.strictObject({
  teams: z.array(
    z.strictObject({
      teamId: z.uuid(),
      teamName: z.string(),
      payments: z.array(MyPaymentRow),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type UnpaidPaymentsResponse = z.infer<typeof UnpaidPaymentsResponse>;

/** `GET /payments/:paymentId` (payer only; every other caller and an unknown id get the same 404). */
export const PaymentResponse = z.strictObject({
  payment: z.strictObject({
    id: z.uuid(),
    reference: z.string(),
    teamName: z.string(),
    session: SessionRef,
    amount: moneyStringSchema,
    gstAmount: moneyStringSchema,
    lines: z.array(
      z.strictObject({
        position: z.number().int().min(0).max(2),
        basis: z.enum(FeeBasis),
        unitFee: moneyStringSchema,
      }),
    ),
    status: z.enum(PaymentStatus),
    billingType: z.enum(BillingType),
    dueDate: isoInstant,
    paidAt: isoInstant.nullable(),
    reason: PaymentReason,
    attempt: z
      .strictObject({
        status: z.enum(PaymentIntentStatus),
        startedAt: isoInstant,
        outcome: IntentOutcome,
      })
      .nullable(),
    onHold: z.boolean(),
    payoutBlocked: z.boolean(),
  }),
});
export type PaymentResponse = z.infer<typeof PaymentResponse>;

/** `GET /teams/:teamId/payments`: names only, never an email address or a bank detail. */
export const AdminPaymentsResponse = z.strictObject({
  payments: z.array(
    z.strictObject({
      id: z.uuid(),
      reference: z.string(),
      player: z.strictObject({ userId: z.uuid(), fullName: z.string() }),
      sessionStartsAt: isoInstant,
      amount: moneyStringSchema,
      status: z.enum(PaymentStatus),
      dueDate: isoInstant,
      paidAt: isoInstant.nullable(),
      lastReminderAt: isoInstant.nullable(),
      onHold: z.boolean(),
    }),
  ),
  nextCursor: z.string().nullable(),
  payoutBlocked: z.boolean(),
});
export type AdminPaymentsResponse = z.infer<typeof AdminPaymentsResponse>;

/** 202 from the reminder route. */
export const ReminderResponse = z.strictObject({
  sent: z.literal(true),
  lastReminderAt: isoInstant,
});
export type ReminderResponse = z.infer<typeof ReminderResponse>;

/** 200 from either hold-resolution route. */
export const HoldResolutionResponse = z.strictObject({
  intentStatus: z.enum(PaymentIntentStatus),
  resolutionReason: z.enum(PaymentResolutionReason),
  resolvedAt: isoInstant,
});
export type HoldResolutionResponse = z.infer<typeof HoldResolutionResponse>;

/** 200 from `POST /teams/:teamId/payout-block`. */
export const PayoutBlockResponse = z.strictObject({
  payoutBlockedAt: isoInstant,
  alreadyBlocked: z.boolean(),
});
export type PayoutBlockResponse = z.infer<typeof PayoutBlockResponse>;
