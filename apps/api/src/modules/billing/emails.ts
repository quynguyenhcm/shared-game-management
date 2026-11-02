/**
 * The billing emails `bill-session` enqueues in its own transaction (P5): payment due (journey email 1), low credit (email 2)
 * and billing paused (email 11, B8). Plain text; the copy is the user-journey doc's. Rules shared by all of them:
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
