import {
  formatNZD,
  instantToLocal,
  isZero,
  negate,
  parseMoney,
  type CreditTransactionType,
  type FeeBasis,
  type BillingType,
  type PaymentIntentStatus,
  type PaymentStatus,
} from '@sgm/shared';
import { minutesLabel } from '../auth/messages.ts';
import { formatWhen } from '../registrations/labels.ts';
import { formatClock, formatDayShort } from '../teams/sessions-view.ts';
import { REMINDER_COOLDOWN_MS } from './constants.ts';

/**
 * The copy deck of the wallet, payment page and Payments area (UI/UX "Copy table", "Status tags", CR-18, CR-19, rulings H2 and
 * H3) and the small pure formatters behind it. Money is only ever formatted with `formatNZD` from a 2-dp string the API
 * returned; dates are shown in Pacific/Auckland from the server's UTC instant. Components hold no status or error literals.
 */

// ---------------------------------------------------------------------------------------------
// Dates (NZ edge formatting)
// ---------------------------------------------------------------------------------------------

/** `Wed 7 Oct`. */
export function formatDay(instant: string): string {
  return formatDayShort(instantToLocal(new Date(instant)).date);
}

/** `Wed 7 Oct, 8:00 pm`. */
export const formatDateTime = formatWhen;

/** `Due Sat 10 Oct` before the due date has passed, `Overdue since Sat 10 Oct` once the payment is overdue. */
export function dueLine(status: PaymentStatus, dueDate: string): string {
  return status === 'OVERDUE' ? `Overdue since ${formatDay(dueDate)}` : `Due ${formatDay(dueDate)}`;
}

export const money = (amount: string): string => formatNZD(parseMoney(amount));

// ---------------------------------------------------------------------------------------------
// Status tags
// ---------------------------------------------------------------------------------------------

export type TagTone = 'green' | 'slate' | 'amber' | 'red';

export interface PaymentTagInput {
  status: PaymentStatus;
  billingType: BillingType;
  amount: string;
  dueDate: string;
  onHold: boolean;
}

/** The tag text and tint. The text carries the state (and the date); the tint only reinforces it. */
export function paymentTag(input: PaymentTagInput): { text: string; tone: TagTone } {
  if (input.status === 'PAID') {
    if (isZero(parseMoney(input.amount))) return { text: 'No charge', tone: 'slate' };
    return input.billingType === 'PREPAID_CREDIT'
      ? { text: 'Paid from wallet', tone: 'green' }
      : { text: 'Paid', tone: 'green' };
  }
  if (input.onHold) return { text: 'Under review', tone: 'slate' };
  return {
    text: dueLine(input.status, input.dueDate),
    tone: input.status === 'OVERDUE' ? 'red' : 'amber',
  };
}

// ---------------------------------------------------------------------------------------------
// Policy, trust and state copy
// ---------------------------------------------------------------------------------------------

export const AKAHU_LEAVE_LINE =
  "You'll leave this site to approve the payment with your bank through Akahu.";

/** Ruling H3: the wording is final. */
export const payeeLine = (team: string): string => `The money goes to ${team}'s bank account.`;
export const creditUseLine = (team: string): string =>
  `Wallet credit can only be used for ${team}'s game fees.`;

export const topUpTrustLines = (team: string): string[] => [
  AKAHU_LEAVE_LINE,
  payeeLine(team),
  creditUseLine(team),
];

export const topUpHint = (headroom: string): string => `Between $1.00 and ${money(headroom)}.`;

export const HOLD_HEADING = "We're checking this payment with your bank.";
export const HOLD_BODY =
  "We can't tell yet whether it went through. Please don't pay again. We'll email you as soon as we know.";
export const TOP_UP_HOLD_HEADING = "We're checking your top-up with your bank.";
export const TOP_UP_HOLD_BODY =
  "We can't tell yet whether it arrived. Please don't top up again. We'll email you as soon as we know.";

export const PAYOUT_BLOCKED_PLAYER =
  "This team can't receive payments right now. We've told the team admins.";

export const declinedText = (what: 'payment' | 'top-up'): string =>
  `Your ${what} didn't go through. You haven't been charged.`;

export const PROCESSING_PAYMENT = 'Processing your payment. This usually takes under a minute.';
export const PROCESSING_TOP_UP = 'Processing your top-up. This usually takes under a minute.';
export const BANK_SLOW = "Your bank hasn't confirmed yet. We'll email you when it does.";
export const PAYMENT_DONE_ANNOUNCEMENT =
  'Your payment is no longer processing. The status is shown below.';
export const TOP_UP_DONE_ANNOUNCEMENT = 'Your top-up is no longer processing. Check your balance.';

export const LATE_WITHDRAWAL_NOTE =
  "Late withdrawal fee: you withdrew after the deadline and the place wasn't filled.";
export const LATE_WITHDRAWAL_REASON = 'Late withdrawal fee';
export const HOLD_ROW_PLAYER = "We're checking this payment with your bank.";
export const HOLD_ROW_ADMIN = 'Waiting on the bank. Nothing to do yet.';
export const OVERDUE_REGISTER_HINT = 'Pay it to register for more games.';
export const NO_PAYMENTS = 'No payments yet. Charges appear here after a game.';
export const NO_UNPAID = 'You have no unpaid payments.';
export const NO_LEDGER = 'No wallet activity yet.';
export const PAID_CAPPED_NOTE = 'Showing your latest 10 paid games.';

/** R5: the wallet's paid list pages back so every paid game's invoice is reachable. */
export const OLDER_PAID_GAMES = 'Show older paid games';
export const NO_CHARGE_LINE = "There's no charge for this game.";

export const walletFullLine = 'Your wallet is full.';
export const balanceLine = (balance: string): string => `Balance: ${money(balance)}`;
export const headroomLine = (headroom: string, cap: string): string =>
  `You can top up to ${money(headroom)} more (wallet limit ${money(cap)}).`;

export const overflowNotice = (amount: string, cap: string): string =>
  `Your top-up of ${money(amount)} arrived but would have taken your wallet over ${money(cap)}, so it wasn't added. The team admins have been told. Ask them about a refund.`;
export const unappliedNotice = (amount: string): string =>
  `Your top-up of ${money(amount)} arrived but couldn't be added to your wallet. The team admins have been told. Ask them about a refund.`;
export const topUpStartedLine = (amount: string, startedAt: string): string =>
  `Top-up of ${money(amount)} started ${formatDateTime(startedAt)}. Finish it at Akahu, or it will close by itself.`;
export const attemptStartedLine = (startedAt: string): string =>
  `You started a payment at ${formatDateTime(startedAt)}. If you finished it at your bank, it can take a minute to show here.`;

export type PayKind = 'pay' | 'retry' | 'continue';

export function payButtonLabel(kind: PayKind, amount: string): string {
  switch (kind) {
    case 'pay':
      return `Pay ${money(amount)} with Akahu`;
    case 'retry':
      return 'Try again';
    case 'continue':
      return 'Continue with Akahu';
  }
}

export const settledLine = (billingType: BillingType, paidAt: string | null): string => {
  const date = paidAt === null ? '' : ` on ${formatDay(paidAt)}`;
  return billingType === 'PREPAID_CREDIT' ? `Paid from your wallet${date}.` : `Paid${date}.`;
};

// ---------------------------------------------------------------------------------------------
// Line items and the ledger
// ---------------------------------------------------------------------------------------------

const BASIS_LABELS: Record<FeeBasis, string> = {
  FLAT: 'Flat fee',
  SEX_MALE: "Men's rate",
  SEX_FEMALE: "Women's rate",
  SEX_OTHER: 'Other rate',
  SKILL_BEGINNER: 'Beginner level',
  SKILL_INTERMEDIATE: 'Intermediate level',
  SKILL_ADVANCED: 'Advanced level',
};

export const basisLabel = (basis: FeeBasis): string => BASIS_LABELS[basis];

/** `Guest 1`, `Guest 2`; position 0 is the player. */
export const lineWho = (position: number): string => (position === 0 ? 'You' : `Guest ${position}`);

/** `+$30.00`, `−$17.00` (a true minus sign) and `$0.00`: the sign is read from the stored amount, never from the type. */
export function signedAmountText(amount: string): string {
  const value = parseMoney(amount);
  if (isZero(value)) return formatNZD(value);
  return value < 0n ? `−${formatNZD(negate(value))}` : `+${formatNZD(value)}`;
}

export function ledgerDescription(item: {
  type: CreditTransactionType;
  session: { location: string; startsAt: string } | null;
}): string {
  switch (item.type) {
    case 'TOPUP':
      return 'Top-up';
    case 'REFUND':
      return 'Refund';
    case 'AUTO_DEDUCTION':
      return item.session === null
        ? 'Game fee'
        : `Game fee, ${item.session.location}, ${formatDay(item.session.startsAt)}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Payments area (admin)
// ---------------------------------------------------------------------------------------------

export const reminderPrompt = (firstName: string, amount: string): string =>
  `Email ${firstName} a reminder for ${money(amount)}?`;
export const reminderSuccess = (firstName: string, amount: string): string =>
  `Reminder sent to ${firstName} for ${money(amount)}.`;
export const reminderTriggerLabel = (player: string, amount: string, sessionAt: string): string =>
  `Send reminder to ${player} for ${money(amount)}, ${formatDay(sessionAt)}`;

function sameNzDay(a: Date, b: Date): boolean {
  return instantToLocal(a).date === instantToLocal(b).date;
}

/** `Reminder sent 2:14 pm` for today, `Reminder sent Tue 27 Oct, 2:14 pm` otherwise; `No reminder yet` for none. */
export function reminderCell(lastReminderAt: string | null, now: Date): string {
  if (lastReminderAt === null) return 'No reminder yet';
  const sent = new Date(lastReminderAt);
  return sameNzDay(sent, now)
    ? `Reminder sent ${formatClock(instantToLocal(sent).time)}`
    : `Reminder sent ${formatDateTime(lastReminderAt)}`;
}

/** `Reminder sent 2:14 pm. You can send another after Fri 30 Oct, 2:14 pm.` */
export function cooldownText(lastReminderAt: string, now: Date): string {
  const next = new Date(new Date(lastReminderAt).getTime() + REMINDER_COOLDOWN_MS).toISOString();
  return `${reminderCell(lastReminderAt, now)}. You can send another after ${formatDateTime(next)}.`;
}

export const ADMIN_BANKING_NOTICE =
  'Payments to your bank account are failing. Update your banking details.';
export const ADMIN_INTRO = 'People who still owe a game fee are listed here. We show names only.';

export function holdResolutionResultMessage(status: PaymentIntentStatus): string {
  switch (status) {
    case 'APPLIED':
      return 'Recorded. The payment is now marked as paid.';
    case 'UNAPPLIED':
      return 'Recorded, not applied. The amount that arrived did not match what was due, so the payment stays unpaid and the player has been told.';
    case 'CLOSED':
      return 'Recorded. The payment can be paid again.';
    default:
      return 'Recorded.';
  }
}

export function payoutBlockResultMessage(alreadyBlocked: boolean): string {
  return alreadyBlocked
    ? 'Payments to this team were already blocked.'
    : 'Payments to this team are now blocked. The team admins have been told.';
}

export const PAYOUT_BLOCK_REASONS: readonly { value: string; label: string }[] = [
  { value: 'AKAHU_REPORTED_ACCOUNT_PROBLEM', label: 'Akahu reported a problem with the account' },
  { value: 'FUNDS_RETURNED', label: 'Funds were returned' },
  { value: 'TEAM_REQUESTED', label: 'The team asked us to' },
  { value: 'OTHER', label: 'Another reason' },
];

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

const PLAYER_OUTAGE =
  'Something went wrong on our side. Nothing has been charged. Try again in a few minutes.';
const ADMIN_OUTAGE =
  'Something went wrong on our side. Nothing was changed. Try again in a few minutes.';

export interface ErrorContext {
  /** Where the error landed: the player pages (default) or the Payments area. */
  scope?: 'wallet' | 'admin';
  retryAfterSeconds?: number;
}

/**
 * Message lines (the first is the headline) for an action error code, on the player pages or in the Payments area. Unknown
 * codes get the generic outage line: nothing here ever echoes server text, a link, a token or a bank detail.
 */
export function billingErrorLines(code: string, context: ErrorContext = {}): string[] {
  const admin = context.scope === 'admin';
  switch (code) {
    case 'top_up_in_progress':
      return [
        'You already have a top-up in progress. It will show here once your bank confirms it.',
      ];
    case 'payment_in_progress':
      return ["You've already started this payment. It can take a minute to show here."];
    case 'payment_settled':
      return ['That payment has already been paid.'];
    case 'payment_on_hold':
      return admin
        ? ['This payment is under review, so no reminder can be sent.']
        : [HOLD_HEADING, "Please don't pay again. We'll email you as soon as we know."];
    case 'payout_not_configured':
    case 'refused_payee_unusable':
      return [PAYOUT_BLOCKED_PLAYER];
    case 'payment_provider_unavailable':
      return ["We couldn't reach Akahu. Nothing has been charged. Try again in a few minutes."];
    case 'refused_amount_over_bank_limit':
      return [
        "Your bank won't allow a payment this large through Akahu. Nothing has been charged.",
      ];
    case 'refused_payer_bank_unavailable':
      return [
        "Your bank isn't available through Akahu right now. Nothing has been charged. Try again later.",
      ];
    case 'payment_provider_refused':
      return ["We couldn't start this payment. Nothing has been charged. Try again later."];
    case 'forbidden':
      return admin
        ? ["You don't have access to manage this team."]
        : ['You need to be a member of this team to use its wallet.'];
    case 'not_found':
      return ["We couldn't find that payment."];
    case 'key_invalid':
      return ['Reload the page and try again.'];
    case 'too_many_requests':
      return [`Too many requests. Try again in ${minutesLabel(context.retryAfterSeconds)}.`];
    case 'reminder_too_soon':
      return ['A reminder was already sent recently. The row now shows when you can send another.'];
    case 'hold_resolved_by_provider':
      return [
        "The bank has since confirmed what happened, so your choice wasn't applied. The page now shows the result.",
      ];
    case 'conflict':
      return ['This payment changed while you were looking at it. The page has been refreshed.'];
    default:
      return [admin ? ADMIN_OUTAGE : PLAYER_OUTAGE];
  }
}

// ---------------------------------------------------------------------------------------------
// Page chrome
// ---------------------------------------------------------------------------------------------

export const walletHeading = (team: string): string => `Wallet and payments for ${team}`;
export const backToTeam = (team: string): string => `Back to ${team}`;
export const PAYMENTS_LOAD_FAILED = "We can't load your payments right now. Try again in a minute.";
export const UNPAID_HEADING = 'Your payments';
export const SHOW_MORE = 'Show more';
export const paymentsAdminHeading = (team: string | null): string =>
  team === null ? 'Payments' : `Payments for ${team}`;
