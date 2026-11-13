import {
  BILLING_FIELD_MESSAGES,
  TOP_UP_MINIMUM,
  gt,
  lt,
  parseMoney,
  topUpHeadroomMessage,
  isZero,
  type AdminPaymentsResponse,
  type MyPaymentRow,
  type PaymentResponse,
  type UnpaidPaymentsResponse,
  type WalletResponse,
} from '@sgm/shared';
import type { FieldErrors } from '../auth/validation.ts';
import { OVERDUE_BLOCK_COUNT, PAID_SHOWN, REMINDER_COOLDOWN_MS } from './constants.ts';
import {
  BANK_SLOW,
  HOLD_BODY,
  HOLD_HEADING,
  NO_CHARGE_LINE,
  OVERDUE_REGISTER_HINT,
  PAYOUT_BLOCKED_PLAYER,
  PROCESSING_PAYMENT,
  TOP_UP_HOLD_BODY,
  TOP_UP_HOLD_HEADING,
  attemptStartedLine,
  declinedText,
  dueLine,
  headroomLine,
  money,
  overflowNotice,
  settledLine,
  topUpHint,
  topUpStartedLine,
  unappliedNotice,
  walletFullLine,
  type PayKind,
} from './labels.ts';

export { REMINDER_COOLDOWN_MS };

/**
 * The pure view models of the wallet page, payment page and Payments area: what the API read model means for the screen.
 * Nothing here adds up, derives or guesses an amount: every figure shown is a field the API returned, formatted, and the only
 * comparisons are the shared money functions on those fields. Kept free of React so every rule is table-tested once.
 */

// ---------------------------------------------------------------------------------------------
// Wallet page
// ---------------------------------------------------------------------------------------------

type Wallet = WalletResponse['wallet'];

export interface WalletNotice {
  tone: 'notice';
  text: string;
}

export type WalletState =
  | {
      kind: 'form';
      balanceText: string;
      headroomLine: string;
      hint: string;
      notice: WalletNotice | null;
    }
  | { kind: 'full'; balanceText: string; line: string; notice: WalletNotice | null }
  | {
      kind: 'processing';
      balanceText: string;
      amountText: string;
      /** Akahu's return landed here (`?topUp=<id>` is this top-up): refresh quietly. */
      returned: boolean;
      startedLine: string;
    }
  | { kind: 'held'; balanceText: string; heading: string; body: string };

function closedNotice(wallet: Wallet, search: { topUp?: string }): WalletNotice | null {
  const closed = wallet.lastClosedTopUp;
  if (closed === null) return null;
  if (closed.status === 'UNAPPLIED') {
    return {
      tone: 'notice',
      text:
        closed.unappliedReason === 'OVER_CAP'
          ? overflowNotice(closed.amount, wallet.cap)
          : unappliedNotice(closed.amount),
    };
  }
  // A closed, uncredited top-up is "didn't go through" only on the return that landed on it: an old one is history.
  return search.topUp === closed.id ? { tone: 'notice', text: declinedText('top-up') } : null;
}

/** Exactly one Wallet-section state (UI/UX "Wallet section states"). */
export function walletState(wallet: Wallet, search: { topUp?: string }): WalletState {
  const balanceText = money(wallet.balance);
  const pending = wallet.pendingTopUp;
  if (pending !== null) {
    if (pending.outcome === 'held') {
      return { kind: 'held', balanceText, heading: TOP_UP_HOLD_HEADING, body: TOP_UP_HOLD_BODY };
    }
    return {
      kind: 'processing',
      balanceText,
      amountText: money(pending.amount),
      returned: search.topUp === pending.id,
      startedLine: topUpStartedLine(pending.amount, pending.createdAt),
    };
  }
  const notice = closedNotice(wallet, search);
  if (isZero(parseMoney(wallet.headroom))) {
    return { kind: 'full', balanceText, line: walletFullLine, notice };
  }
  return {
    kind: 'form',
    balanceText,
    headroomLine: headroomLine(wallet.headroom, wallet.cap),
    hint: topUpHint(wallet.headroom),
    notice,
  };
}

const M = BILLING_FIELD_MESSAGES;

/**
 * Client validation of the top-up amount with the same functions (and messages) the API schema uses, plus the headroom the
 * page loaded. The server re-checks against the balance it reads, so this is only the quick answer (AC-ERROR-1).
 */
export function validateTopUp(
  values: { amount?: string | undefined },
  headroom: string,
): FieldErrors {
  const raw = (values.amount ?? '').trim();
  if (raw === '') return { amount: ['Enter an amount, for example 20.00.'] };
  let amount;
  try {
    amount = parseMoney(raw);
  } catch {
    return { amount: [M.amountFormat] };
  }
  if (lt(amount, TOP_UP_MINIMUM)) return { amount: [M.amountBelowMinimum] };
  const limit = parseMoney(headroom);
  if (gt(amount, limit)) return { amount: [topUpHeadroomMessage(limit)] };
  return {};
}

// ---------------------------------------------------------------------------------------------
// Payment page
// ---------------------------------------------------------------------------------------------

type Payment = PaymentResponse['payment'];

export type PaymentStateKind =
  | 'paid_wallet'
  | 'paid_akahu'
  | 'no_charge'
  | 'hold'
  | 'payout_blocked'
  | 'processing'
  | 'attempt_open'
  | 'declined'
  | 'overdue'
  | 'pending';

export interface PaymentState {
  kind: PaymentStateKind;
  /** The one primary action, or null: absent from the page (never merely disabled). */
  action: PayKind | null;
  /** The sentence the state is announced with (hold and processing carry more in `heading`, `body`, `slowText`). */
  message: string;
  heading?: string;
  body?: string;
  slowText?: string;
}

/**
 * Exactly one state, in the documented priority: (not found is the page's) paid > hold > payout blocked > processing
 * (`?return=1` with an open attempt) > open attempt > declined > overdue > pending. Hold outranks a payout block because it
 * is the state that forbids a second payment.
 */
export function paymentState(
  payment: Payment,
  search: { return?: string | undefined },
  options: { overdueCount?: number } = {},
): PaymentState {
  const attempt = payment.attempt;
  if (payment.status === 'PAID') {
    if (isZero(parseMoney(payment.amount))) {
      return { kind: 'no_charge', action: null, message: NO_CHARGE_LINE };
    }
    return {
      kind: payment.billingType === 'PREPAID_CREDIT' ? 'paid_wallet' : 'paid_akahu',
      action: null,
      message: settledLine(payment.billingType, payment.paidAt),
    };
  }
  if (payment.onHold || attempt?.outcome === 'held') {
    return {
      kind: 'hold',
      action: null,
      message: `${HOLD_HEADING} ${HOLD_BODY}`,
      heading: HOLD_HEADING,
      body: HOLD_BODY,
    };
  }
  if (payment.payoutBlocked) {
    return { kind: 'payout_blocked', action: null, message: PAYOUT_BLOCKED_PLAYER };
  }
  const open = attempt?.outcome === 'processing';
  if (open && search.return === '1') {
    return {
      kind: 'processing',
      action: null,
      message: PROCESSING_PAYMENT,
      slowText: BANK_SLOW,
    };
  }
  if (open && attempt !== null) {
    return {
      kind: 'attempt_open',
      action: 'continue',
      message: attemptStartedLine(attempt.startedAt),
    };
  }
  if (attempt?.outcome === 'cancelled' || attempt?.outcome === 'failed') {
    return { kind: 'declined', action: 'retry', message: declinedText('payment') };
  }
  if (payment.status === 'OVERDUE') {
    const hint =
      (options.overdueCount ?? 0) >= OVERDUE_BLOCK_COUNT ? ` ${OVERDUE_REGISTER_HINT}` : '';
    return {
      kind: 'overdue',
      action: 'pay',
      message: `${dueLine('OVERDUE', payment.dueDate)}.${hint}`,
    };
  }
  return { kind: 'pending', action: 'pay', message: `${dueLine('PENDING', payment.dueDate)}.` };
}

// ---------------------------------------------------------------------------------------------
// Payment lists
// ---------------------------------------------------------------------------------------------

export interface PaymentGroups {
  overdue: MyPaymentRow[];
  pending: MyPaymentRow[];
  paid: MyPaymentRow[];
  /** More paid rows existed than are shown. */
  paidTruncated: boolean;
}

const time = (instant: string | null): number => (instant === null ? 0 : Date.parse(instant));

/**
 * Overdue and pending oldest-due first, paid newest first and capped (UI/UX Payments section); empty groups stay empty.
 * `paidLimit: null` shows every paid row loaded (the "Show older paid games" view, R5).
 */
export function groupPayments(
  rows: readonly MyPaymentRow[],
  options: { paidLimit?: number | null } = {},
): PaymentGroups {
  const paidLimit = options.paidLimit === undefined ? PAID_SHOWN : options.paidLimit;
  const byDue = (a: MyPaymentRow, b: MyPaymentRow): number => time(a.dueDate) - time(b.dueDate);
  const overdue = rows.filter((row) => row.status === 'OVERDUE').sort(byDue);
  const pending = rows
    .filter((row) => row.status === 'PENDING' || row.status === 'FAILED')
    .sort(byDue);
  const allPaid = rows
    .filter((row) => row.status === 'PAID')
    .sort((a, b) => time(b.paidAt) - time(a.paidAt));
  return {
    overdue,
    pending,
    paid: paidLimit === null ? allPaid : allPaid.slice(0, paidLimit),
    paidTruncated: paidLimit !== null && allPaid.length > paidLimit,
  };
}

/**
 * R5: where "Show older paid games" leads, or null when every paid game is already shown. The first view caps the paid list at
 * `PAID_SHOWN`; the link then shows every paid row of the loaded page (`?payments=all`) and, past that page, follows the API's
 * opaque cursor (`pcursor`). `walletUrl` is the wallet page without a query.
 */
export function olderPaidHref(
  walletUrl: string,
  view: { showAll: boolean; truncated: boolean; nextCursor: string | null },
): string | null {
  if (!view.showAll && view.truncated) return `${walletUrl}?payments=all#payments`;
  if (view.nextCursor !== null) {
    return `${walletUrl}?${new URLSearchParams({ payments: 'all', pcursor: view.nextCursor }).toString()}#payments`;
  }
  return null;
}

/** The download action is offered exactly when the API says a document is available (PAID above $0.00); the UI never decides it. */
export function canDownloadInvoice(row: { document: { available: boolean } }): boolean {
  return row.document.available;
}

export interface TeamPaymentGroups {
  teamId: string;
  teamName: string;
  groups: PaymentGroups;
}

/** The cross-team unpaid list: one block per team, Overdue before Pending inside it. */
export function groupPaymentsByTeam(teams: UnpaidPaymentsResponse['teams']): TeamPaymentGroups[] {
  return teams.map((team) => ({
    teamId: team.teamId,
    teamName: team.teamName,
    groups: groupPayments(team.payments),
  }));
}

/** Pay now is a link on a payable row only: never on a paid, held or payout-blocked one. */
export function canPayRow(row: Pick<MyPaymentRow, 'status' | 'onHold' | 'payoutBlocked'>): boolean {
  return row.status !== 'PAID' && !row.onHold && !row.payoutBlocked;
}

// ---------------------------------------------------------------------------------------------
// Payments area (admin)
// ---------------------------------------------------------------------------------------------

export interface ReminderCooldown {
  active: boolean;
  /** When another reminder may be sent (ISO), while the cooldown is active. */
  availableAt: string | null;
}

/** B6: a reminder within the cooldown of the last one is refused by the API; the UI says so before it is pressed. */
export function reminderCooldown(lastReminderAt: string | null, now: Date): ReminderCooldown {
  if (lastReminderAt === null) return { active: false, availableAt: null };
  const available = Date.parse(lastReminderAt) + REMINDER_COOLDOWN_MS;
  return now.getTime() < available
    ? { active: true, availableAt: new Date(available).toISOString() }
    : { active: false, availableAt: null };
}

type AdminRow = AdminPaymentsResponse['payments'][number];

export type AdminRowAction = 'none' | 'reminder' | 'cooldown' | 'hold';

/**
 * What the action cell of an admin row offers. A held payment gets the hold resolution (and never a reminder); a payout-blocked
 * team and a paid payment get no reminder (the API would refuse it: CR-18, Phase 3 notes).
 */
export function adminRowAction(
  row: Pick<AdminRow, 'status' | 'onHold' | 'lastReminderAt'>,
  context: { payoutBlocked: boolean; now: Date },
): AdminRowAction {
  if (row.status === 'PAID') return 'none';
  if (row.onHold) return 'hold';
  if (context.payoutBlocked) return 'none';
  return reminderCooldown(row.lastReminderAt, context.now).active ? 'cooldown' : 'reminder';
}

export type AdminFilterId = 'unpaid' | 'paid' | 'all';

export interface AdminFilter {
  id: AdminFilterId;
  label: string;
  /** `status` query of `GET /teams/:teamId/payments`. */
  api: 'UNPAID' | 'PAID' | 'ALL';
  /** The `?status=` value in the page URL (absent for the default). */
  param: string | null;
  empty: string;
}

export const ADMIN_FILTERS: readonly AdminFilter[] = [
  {
    id: 'unpaid',
    label: 'Unpaid',
    api: 'UNPAID',
    param: null,
    empty: 'No unpaid payments. Everyone is up to date.',
  },
  { id: 'paid', label: 'Paid', api: 'PAID', param: 'paid', empty: 'No paid payments yet.' },
  {
    id: 'all',
    label: 'All',
    api: 'ALL',
    param: 'all',
    empty: 'No payments yet. They appear here after a session ends.',
  },
];

/** `?status=` of the Payments page: anything but `paid` or `all` is the default (Unpaid). */
export function adminFilterOf(param: string | null | undefined): AdminFilter {
  return (
    ADMIN_FILTERS.find((filter) => filter.param !== null && filter.param === param) ??
    (ADMIN_FILTERS[0] as AdminFilter)
  );
}
