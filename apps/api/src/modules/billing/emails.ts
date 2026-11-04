/**
 * The billing emails enqueued in the transaction that causes them (P5): payment due (journey email 1), low credit (email 2) and
 * billing paused (email 11, B8) by `bill-session`; overdue (email 3) by `daily-overdue`; the manual reminder (email 4) by the
 * reminder route. Plain text; the copy is the user-journey doc's. Rules shared by all of them:
 *
 * - Every link is our own web origin plus a path, never an Akahu URL (A5); the payment link is the authenticated, payer-only
 *   `/payments/<id>` page (CR-7).
 * - No bank account name or digits, no other player's name, no email address in the body.
 * - User-entered text (team name, location, names) is folded onto one line so it cannot forge extra lines or subject text.
 * - The idempotency key comes from the cause (payment, deduction, session and admin), so a redelivered job enqueues the same
 *   key and sends once. The caller seals the message with FieldCrypto: it carries a link.
 */
import { formatNZD, formatNzTime, type Money } from '@sgm/shared';
import type { EmailMessage } from '../../lib/notifications/notifier.ts';
import { formatNzDay } from '../registrations/emails.ts';

const fold = (text: string): string => text.replace(/\s+/g, ' ').trim();

const SIGN_OFF = 'Shared Game Management';

interface SessionFacts {
  readonly teamName: string;
  readonly teamId: string;
  readonly location: string;
  readonly startsAt: Date;
  /** `config.auth.webBaseUrl`: origin of the web app, no trailing slash. */
  readonly webBaseUrl: string;
}

const walletLink = (input: SessionFacts): string =>
  `${input.webBaseUrl}/teams/${input.teamId}/wallet`;

export interface PaymentDueEmailInput extends SessionFacts {
  readonly to: string;
  readonly firstName: string;
  readonly paymentId: string;
  readonly amount: Money;
  readonly dueDate: Date;
  /** Guests in the party (the registrant is not counted). */
  readonly guestCount: number;
  readonly reason: 'CONFIRMED' | 'LATE_WITHDRAWAL';
  /** The wallet balance when it did not cover the charge; null when the player has no wallet row. */
  readonly walletBalance: Money | null;
}

/** Journey email 1: a pay-by-bank charge, due 72 hours after billing. */
export function buildPaymentDueEmail(input: PaymentDueEmailInput): EmailMessage {
  const team = fold(input.teamName);
  const location = fold(input.location);
  const day = formatNzDay(input.startsAt);
  const amount = formatNZD(input.amount);
  const intro =
    input.reason === 'LATE_WITHDRAWAL'
      ? `Late withdrawal fee for ${location} on ${day}. You withdrew after the free cancellation deadline and nobody from the waitlist took your place.`
      : `Thanks for playing with ${team} at ${location} on ${day}.`;
  const walletLine =
    input.reason === 'LATE_WITHDRAWAL'
      ? []
      : [
          input.walletBalance === null
            ? `This game wasn't paid from a wallet, because you don't have credit with ${team}.`
            : `Your ${team} wallet (${formatNZD(input.walletBalance)}) didn't cover this game, so we haven't taken anything from it.`,
        ];
  const party =
    input.guestCount === 0
      ? ''
      : ` (you and ${input.guestCount} ${input.guestCount === 1 ? 'guest' : 'guests'})`;
  const text = [
    `Hi ${fold(input.firstName)},`,
    '',
    intro,
    ...walletLine,
    '',
    `Amount: ${amount}${party}`,
    `Due by: ${formatNzDay(input.dueDate)}, ${formatNzTime(input.dueDate)}`,
    '',
    "Pay now (you'll sign in, then pay by bank transfer with Akahu):",
    `${input.webBaseUrl}/payments/${input.paymentId}`,
    '',
    `Top up your ${team} wallet to have future games paid automatically:`,
    walletLink(input),
    '',
    SIGN_OFF,
    '',
  ].join('\n');
  return {
    to: input.to,
    subject: `Payment due: ${team}, ${day}, ${amount}, due ${formatNzDay(input.dueDate)}`,
    text,
    idempotencyKey: `payment-due:${input.paymentId}`,
    tags: { template: 'payment-due' },
  };
}

export interface LowCreditEmailInput extends SessionFacts {
  readonly to: string;
  readonly firstName: string;
  /** What this game's deduction took. */
  readonly deducted: Money;
  /** The balance after the deduction (below $20.00). */
  readonly balance: Money;
  /** The deduction's ledger row: one key per deduction (B5). */
  readonly creditTransactionId: string;
}

/** Journey email 2: a wallet deduction left the balance under $20.00. */
export function buildLowCreditEmail(input: LowCreditEmailInput): EmailMessage {
  const team = fold(input.teamName);
  const text = [
    `Hi ${fold(input.firstName)},`,
    '',
    `We took ${formatNZD(input.deducted)} from your ${team} wallet for ${fold(input.location)} on ${formatNzDay(input.startsAt)}. Your balance is now ${formatNZD(input.balance)}.`,
    '',
    "If your balance doesn't cover a game, we won't take anything from it. You'll get a payment link instead, due 3 days after the game.",
    '',
    'Top up your wallet:',
    walletLink(input),
    '',
    SIGN_OFF,
    '',
  ].join('\n');
  return {
    to: input.to,
    subject: `Your ${team} wallet is running low (${formatNZD(input.balance)})`,
    text,
    idempotencyKey: `low-credit:${input.creditTransactionId}`,
    tags: { template: 'low-credit' },
  };
}

export interface BillingPausedEmailInput extends SessionFacts {
  readonly to: string;
  readonly adminFirstName: string;
  readonly adminId: string;
  readonly sessionId: string;
}

/** Journey email 11 (B8): the session ended but its team cannot take payments, so it is held, not billed. */
export function buildBillingPausedEmail(input: BillingPausedEmailInput): EmailMessage {
  const team = fold(input.teamName);
  const day = formatNzDay(input.startsAt);
  const text = [
    `Hi ${fold(input.adminFirstName)},`,
    '',
    `The session at ${fold(input.location)} on ${day} has ended, but we can't bill it because payments to ${team}'s bank account are failing. Nobody has been charged for it yet.`,
    '',
    'Fix the bank account:',
    `${input.webBaseUrl}/teams/${input.teamId}/manage/banking`,
    '',
    'After you save it, this session is billed automatically within about 10 minutes.',
    '',
    SIGN_OFF,
    '',
  ].join('\n');
  return {
    to: input.to,
    subject: `Billing is paused: ${team}, ${day}`,
    text,
    idempotencyKey: `billing-paused:${input.sessionId}:${input.adminId}`,
    tags: { template: 'billing-paused' },
  };
}

export interface OverdueEmailInput extends SessionFacts {
  readonly to: string;
  readonly firstName: string;
  readonly paymentId: string;
  readonly amount: Money;
  readonly dueDate: Date;
  /** The payer's OVERDUE payments across every team after this transition (3 or more blocks registering). */
  readonly overdueCount: number;
}

/** The "due by" instant as the player reads it: `Sat 10 Oct, 7:12 pm` (Pacific/Auckland). */
const dueText = (dueDate: Date): string => `${formatNzDay(dueDate)}, ${formatNzTime(dueDate)}`;

/** Journey email 3: sent once, in the transaction that moves the payment PENDING -> OVERDUE. */
export function buildOverdueEmail(input: OverdueEmailInput): EmailMessage {
  const team = fold(input.teamName);
  const amount = formatNZD(input.amount);
  const blockedLines =
    input.overdueCount >= 3
      ? [
          `You have ${input.overdueCount} overdue payments, so you can't register for new sessions right now. See them all:`,
          `${input.webBaseUrl}/payments`,
        ]
      : [];
  const text = [
    `Hi ${fold(input.firstName)},`,
    '',
    `Your payment of ${amount} for ${fold(input.location)} on ${formatNzDay(input.startsAt)} was due by ${dueText(input.dueDate)} and hasn't been paid.`,
    '',
    'Pay now:',
    `${input.webBaseUrl}/payments/${input.paymentId}`,
    '',
    "Players with 3 or more overdue payments, across all their teams, can't register for new sessions until they pay.",
    ...blockedLines,
    '',
    SIGN_OFF,
    '',
  ].join('\n');
  return {
    to: input.to,
    subject: `Overdue: ${team}, ${amount}`,
    text,
    idempotencyKey: `payment-overdue:${input.paymentId}`,
    tags: { template: 'payment-overdue' },
  };
}

export interface ReminderEmailInput extends SessionFacts {
  readonly to: string;
  readonly firstName: string;
  readonly paymentId: string;
  /** The request's `changeKey`: one reminder per key, so a replay enqueues the same idempotency key. */
  readonly changeKey: string;
  readonly amount: Money;
  readonly dueDate: Date;
  /** True when the payment is OVERDUE or its due instant has passed. */
  readonly overdue: boolean;
}

/** Journey email 4: an admin asked for a reminder. Never names the admin, and carries no bank detail. */
export function buildReminderEmail(input: ReminderEmailInput): EmailMessage {
  const team = fold(input.teamName);
  const amount = formatNZD(input.amount);
  const day = formatNzDay(input.startsAt);
  const text = [
    `Hi ${fold(input.firstName)},`,
    '',
    `${team} asked us to remind you about your payment of ${amount} for ${fold(input.location)} on ${day}.`,
    input.overdue
      ? `It was due by ${dueText(input.dueDate)} and is now overdue.`
      : `It's due by ${dueText(input.dueDate)}.`,
    '',
    'Pay now:',
    `${input.webBaseUrl}/payments/${input.paymentId}`,
    '',
    'If you paid in the last few minutes, you can ignore this email.',
    '',
    SIGN_OFF,
    '',
  ].join('\n');
  return {
    to: input.to,
    subject: `Reminder: ${amount} for ${team}, ${day}`,
    text,
    idempotencyKey: `payment-reminder:${input.paymentId}:${input.changeKey}`,
    tags: { template: 'payment-reminder' },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Akahu results (journey emails 5-10; CR-20 numbering 5-9), enqueued by the apply funnel `apply-akahu-result.ts` in the transaction
// that records the result. Keys come from the intent or payment, so a replayed result can never send twice.
// ---------------------------------------------------------------------------------------------------------------------------------

interface WalletFacts {
  readonly to: string;
  readonly firstName: string;
  readonly teamName: string;
  readonly teamId: string;
  /** `config.auth.webBaseUrl`: origin of the web app, no trailing slash. */
  readonly webBaseUrl: string;
}

const walletUrl = (input: WalletFacts): string =>
  `${input.webBaseUrl}/teams/${input.teamId}/wallet`;

export interface PaymentReceivedEmailInput extends SessionFacts {
  readonly to: string;
  readonly firstName: string;
  readonly paymentId: string;
  readonly amount: Money;
  readonly paidAt: Date;
  /** The money arrived after the attempt was held (CR-25): the player is told the check is over. */
  readonly afterHold: boolean;
}

/** Journey email 5: a pay-by-bank charge was received (never sent for a wallet deduction or a $0.00 row). */
export function buildPaymentReceivedEmail(input: PaymentReceivedEmailInput): EmailMessage {
  const team = fold(input.teamName);
  const amount = formatNZD(input.amount);
  const text = [
    `Hi ${fold(input.firstName)},`,
    '',
    `We received your payment of ${amount} for ${fold(input.location)} on ${formatNzDay(input.startsAt)}. It was paid to ${team} by bank transfer on ${dueText(input.paidAt)}.`,
    ...(input.afterHold ? ['We checked with your bank and your payment went through.'] : []),
    '',
    'View the payment:',
    `${input.webBaseUrl}/payments/${input.paymentId}`,
    '',
    SIGN_OFF,
    '',
  ].join('\n');
  return {
    to: input.to,
    subject: `Payment received: ${team}, ${amount}`,
    text,
    idempotencyKey: `payment-received:${input.paymentId}`,
    tags: { template: 'payment-received' },
  };
}

export interface TopUpReceivedEmailInput extends WalletFacts {
  readonly topUpId: string;
  readonly amount: Money;
  /** The wallet balance right after this credit. */
  readonly balance: Money;
}

/** Journey email 5 (top-up variant; CR-20 email 6): the top-up was credited to the wallet. */
export function buildTopUpReceivedEmail(input: TopUpReceivedEmailInput): EmailMessage {
  const team = fold(input.teamName);
  const amount = formatNZD(input.amount);
  const text = [
    `Hi ${fold(input.firstName)},`,
    '',
    `Your top-up of ${amount} to your ${team} wallet went through. Your balance is now ${formatNZD(input.balance)}.`,
    `Your wallet pays for your ${team} games automatically after each game.`,
    '',
    'View your wallet:',
    walletUrl(input),
    '',
    SIGN_OFF,
    '',
  ].join('\n');
  return {
    to: input.to,
    subject: `Top-up received: ${team} wallet, ${amount}`,
    text,
    idempotencyKey: `top-up-received:${input.topUpId}`,
    tags: { template: 'top-up-received' },
  };
}

export interface PaymentNotCompletedEmailInput extends SessionFacts {
  readonly to: string;
  readonly firstName: string;
  readonly attemptId: string;
  readonly paymentId: string;
  readonly amount: Money;
  /** The due date after any CR-27 grace write. */
  readonly dueDate: Date;
  readonly overdue: boolean;
  /** A held attempt was released as not received (CR-26). */
  readonly afterHold: boolean;
}

/** Journey email 8 (CR-20 email 7): sent only when the payer had authorised the payment at the bank and it then failed. */
export function buildPaymentNotCompletedEmail(input: PaymentNotCompletedEmailInput): EmailMessage {
  const team = fold(input.teamName);
  const text = [
    `Hi ${fold(input.firstName)},`,
    '',
    `Your bank didn't complete your payment of ${formatNZD(input.amount)} for ${fold(input.location)} on ${formatNzDay(input.startsAt)}. You haven't been charged.`,
    ...(input.afterHold ? ["We checked with your bank: the payment didn't go through."] : []),
    input.overdue
      ? `It was due by ${dueText(input.dueDate)} and is now overdue.`
      : `The payment is still due by ${dueText(input.dueDate)}.`,
    '',
    'Try again:',
    `${input.webBaseUrl}/payments/${input.paymentId}`,
    '',
    SIGN_OFF,
    '',
  ].join('\n');
  return {
    to: input.to,
    subject: `Your payment to ${team} didn't go through`,
    text,
    idempotencyKey: `payment-not-completed:${input.attemptId}`,
    tags: { template: 'payment-not-completed' },
  };
}

export interface TopUpNotCompletedEmailInput extends WalletFacts {
  readonly topUpId: string;
  readonly amount: Money;
  readonly afterHold: boolean;
}

/** Journey email 8, top-up variant: the payer authorised the top-up and the bank then failed it. */
export function buildTopUpNotCompletedEmail(input: TopUpNotCompletedEmailInput): EmailMessage {
  const team = fold(input.teamName);
  const text = [
    `Hi ${fold(input.firstName)},`,
    '',
    `Your bank didn't complete your top-up of ${formatNZD(input.amount)} to your ${team} wallet. You haven't been charged.`,
    ...(input.afterHold ? ["We checked with your bank: the top-up didn't go through."] : []),
    '',
    'Try again:',
    walletUrl(input),
    '',
    SIGN_OFF,
    '',
  ].join('\n');
  return {
    to: input.to,
    subject: `Your top-up to your ${team} wallet didn't go through`,
    text,
    idempotencyKey: `top-up-not-completed:${input.topUpId}`,
    tags: { template: 'top-up-not-completed' },
  };
}

export interface PaymentHeldEmailInput extends SessionFacts {
  readonly to: string;
  readonly firstName: string;
  readonly attemptId: string;
  readonly paymentId: string;
  readonly amount: Money;
  /** Already OVERDUE when held: the "won't become overdue" promise would be false. */
  readonly overdue: boolean;
}

/** Journey email 9 (CR-20 email 8): the bank could not confirm the payment. Never says "you haven't been charged" (A2). */
export function buildPaymentHeldEmail(input: PaymentHeldEmailInput): EmailMessage {
  const team = fold(input.teamName);
  const text = [
    `Hi ${fold(input.firstName)},`,
    '',
    `Your bank couldn't confirm whether your payment of ${formatNZD(input.amount)} for ${fold(input.location)} on ${formatNzDay(input.startsAt)} went through.`,
    '',
    [
      "Please don't pay it again. We're checking with the bank and will email you when it's sorted, usually within 2 working days.",
      ...(input.overdue ? [] : ["This payment won't become overdue while we check."]),
    ].join(' '),
    '',
    'See the payment:',
    `${input.webBaseUrl}/payments/${input.paymentId}`,
    '',
    SIGN_OFF,
    '',
  ].join('\n');
  return {
    to: input.to,
    subject: `We're checking your payment to ${team}`,
    text,
    idempotencyKey: `payment-held:${input.attemptId}`,
    tags: { template: 'payment-held' },
  };
}

export interface TopUpHeldEmailInput extends WalletFacts {
  readonly topUpId: string;
  readonly amount: Money;
}

/** Journey J7 (top-up): the bank could not confirm the top-up; no new top-up can start until it is sorted. */
export function buildTopUpHeldEmail(input: TopUpHeldEmailInput): EmailMessage {
  const team = fold(input.teamName);
  const text = [
    `Hi ${fold(input.firstName)},`,
    '',
    `Your bank couldn't confirm whether your top-up of ${formatNZD(input.amount)} to your ${team} wallet went through.`,
    '',
    "Please don't top up again. We're checking with the bank and will email you when it's sorted, usually within 2 working days. You can't start another top-up until this is sorted.",
    '',
    'See your wallet:',
    walletUrl(input),
    '',
    SIGN_OFF,
    '',
  ].join('\n');
  return {
    to: input.to,
    subject: `We're checking your top-up to your ${team} wallet`,
    text,
    idempotencyKey: `top-up-held:${input.topUpId}`,
    tags: { template: 'top-up-held' },
  };
}

/** Why money Akahu reports as SENT was not applied (B3; `payment_unapplied_reason`). */
export type ExtraPaymentReason = 'OVER_CAP' | 'DUPLICATE' | 'LATE' | 'AMOUNT_MISMATCH';

interface ExtraPaymentFacts {
  readonly intentId: string;
  /** What Akahu reports as sent. */
  readonly amount: Money;
  readonly reason: ExtraPaymentReason;
  /** The session a DUPLICATE was paid for; null for a top-up. */
  readonly location: string | null;
  readonly startsAt: Date | null;
}

export interface ExtraPaymentPlayerEmailInput extends WalletFacts, ExtraPaymentFacts {}

/** Journey email 10 (player; CR-20 email 9): money reached the team's account but could not be used. */
export function buildExtraPaymentPlayerEmail(input: ExtraPaymentPlayerEmailInput): EmailMessage {
  const team = fold(input.teamName);
  const what =
    input.location !== null && input.startsAt !== null
      ? `${fold(input.location)} on ${formatNzDay(input.startsAt)}`
      : `your ${team} wallet`;
  const text = [
    `Hi ${fold(input.firstName)},`,
    '',
    `We received ${formatNZD(input.amount)} more than you owed for ${what}. The money is in ${team}'s bank account, and we've asked the team admins to refund you.`,
    '',
    SIGN_OFF,
    '',
  ].join('\n');
  return {
    to: input.to,
    subject: 'We received an extra payment from you',
    text,
    idempotencyKey: `extra-payment:${input.intentId}:player`,
    tags: { template: 'extra-payment-player' },
  };
}

export interface ExtraPaymentAdminEmailInput extends ExtraPaymentFacts {
  readonly to: string;
  readonly adminFirstName: string;
  readonly adminId: string;
  readonly playerFullName: string;
  readonly teamName: string;
  readonly teamId: string;
  readonly webBaseUrl: string;
}

const extraReasonText = (input: ExtraPaymentFacts): string => {
  switch (input.reason) {
    case 'DUPLICATE':
      return input.startsAt === null
        ? 'paid twice for the same game'
        : `paid twice for ${formatNzDay(input.startsAt)}`;
    case 'OVER_CAP':
      return 'a top-up over the $100.00 wallet limit';
    case 'LATE':
      return 'a top-up that arrived after it was closed and no longer fit under the $100.00 wallet limit';
    case 'AMOUNT_MISMATCH':
      return 'a payment for a different amount than we asked for';
  }
};

/** Journey email 10 (each approved team admin): who paid what that we could not use, and that they should refund it. */
export function buildExtraPaymentAdminEmail(input: ExtraPaymentAdminEmailInput): EmailMessage {
  const team = fold(input.teamName);
  const text = [
    `Hi ${fold(input.adminFirstName)},`,
    '',
    `${fold(input.playerFullName)} paid ${formatNZD(input.amount)} that we couldn't use: ${extraReasonText(input)}.`,
    `The money is in ${team}'s bank account. Please refund it to them directly. We haven't added it to their wallet.`,
    '',
    'See the team payments:',
    `${input.webBaseUrl}/teams/${input.teamId}/manage/payments`,
    '',
    SIGN_OFF,
    '',
  ].join('\n');
  return {
    to: input.to,
    subject: `A payment to ${team} needs a refund`,
    text,
    idempotencyKey: `extra-payment:${input.intentId}:${input.adminId}`,
    tags: { template: 'extra-payment-admin' },
  };
}

export interface PayoutBlockedEmailInput {
  readonly to: string;
  readonly adminFirstName: string;
  readonly adminId: string;
  readonly teamName: string;
  readonly teamId: string;
  /** The block's instant: one email per admin per block episode. */
  readonly payoutBlockedAt: Date;
  /** `config.auth.webBaseUrl`: origin of the web app, no trailing slash. */
  readonly webBaseUrl: string;
}

/**
 * CR-20 email 10 (journey email 6; A3): ops marked the team's payout account as failing. Names no account detail (the input carries
 * none); the fix is the team admin's banking re-save, which clears the block (ADR 0016 R3).
 */
export function buildPayoutBlockedEmail(input: PayoutBlockedEmailInput): EmailMessage {
  const team = fold(input.teamName);
  const text = [
    `Hi ${fold(input.adminFirstName)},`,
    '',
    `Payments to ${team}'s bank account aren't going through.`,
    '',
    'Until this is fixed:',
    "- new paid sessions can't be published,",
    "- sessions that have ended aren't billed, so players aren't charged for them yet,",
    `- players can't pay ${team} or top up their ${team} wallets.`,
    '',
    'Check the bank account name and number and save them again:',
    `${input.webBaseUrl}/teams/${input.teamId}/manage/banking`,
    '',
    'Saving the bank details lifts the block. Sessions that ended in the meantime are billed automatically within about 10 minutes.',
    '',
    SIGN_OFF,
    '',
  ].join('\n');
  return {
    to: input.to,
    subject: `Payments to ${team}'s bank account are failing`,
    text,
    idempotencyKey: `payout-blocked:${input.teamId}:${input.payoutBlockedAt.getTime()}:${input.adminId}`,
    tags: { template: 'payout-blocked' },
  };
}
