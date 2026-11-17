import type {
  DashboardRegistrationRow,
  MyPaymentRow,
  OpenSessionRow,
  UnpaidPaymentsResponse,
  WalletResponse,
} from '@sgm/shared';
import {
  HOLD_ROW_PLAYER,
  PAYOUT_BLOCKED_PLAYER,
  balanceLine,
  paymentTag,
  type TagTone,
} from '../billing/labels.ts';
import { walletPath, paymentPath } from '../billing/paths.ts';
import { groupPayments, walletState } from '../billing/wallet-view.ts';
import { formatWhen, groupLine } from '../registrations/labels.ts';
import { playerSessionPath, teamPagePath } from '../registrations/paths.ts';
import {
  FEE_NOT_SET,
  JOIN_WAITLIST,
  LATE_WITHDRAWAL,
  NOTHING_OVERDUE,
  NOTHING_PENDING,
  NOT_BILLED_YET,
  NO_PAID_GAMES,
  REGISTER,
  SESSION_CANCELLED,
  TOP_UP_CREDIT,
  VIEW_REGISTRATION,
  VIEW_SESSION,
  VIEW_WALLET,
  WAITLIST_NOT_CHARGED,
  YOURE_IN,
  accordionTitle,
  estimatedTotalLine,
  forSession,
  forTeam,
  openFeeText,
  totalFeeLine,
  waitlistTag,
  whenRange,
} from './labels.ts';
import { paymentsPagePath, type DashboardTab } from './paths.ts';

/**
 * The pure view models of the player dashboard: what each API read model means for the screen. Nothing here adds up, derives
 * or guesses an amount or a place count; every figure shown is a field the API returned, formatted (P2). Kept free of React so
 * every rule is table-tested once.
 */

const TABS: readonly DashboardTab[] = ['opening', 'registrations', 'payments'];

/** `?tab=`: anything but the two named tabs is the default, Currently Opening (never a 404). */
export function parseTab(raw: string | undefined): DashboardTab {
  return TABS.find((tab) => tab === raw) ?? 'opening';
}

/** The API's own cap on a cursor; an empty or longer parameter is ignored rather than forwarded. */
const CURSOR_MAX_LENGTH = 512;

export function cursorParam(raw: string | undefined): string | undefined {
  return raw === undefined || raw === '' || raw.length > CURSOR_MAX_LENGTH ? undefined : raw;
}

// ---------------------------------------------------------------------------------------------
// Currently Opening
// ---------------------------------------------------------------------------------------------

export type SessionButtonKind = 'register' | 'waitlist' | 'view_registration' | 'view_session';

export interface SessionButton {
  kind: SessionButtonKind;
  /** The visible text, which starts the accessible name. */
  text: string;
  /** Visually hidden words that name the session after the visible text. */
  srSuffix: string;
  href: string;
  secondary: boolean;
  /** `You're in` or `Waitlist #n` beside `View registration`; otherwise null. */
  tag: string | null;
}

export interface OpenSessionCard {
  key: string;
  teamName: string;
  teamHref: string;
  heading: string;
  when: string;
  address: string;
  feeText: string;
  seatsText: string;
  button: SessionButton;
}

function sessionButton(row: OpenSessionRow, when: string): SessionButton {
  const base = {
    srSuffix: forSession(row.location, when),
    href: playerSessionPath(row.teamId, row.sessionId),
  };
  if (row.me !== null) {
    return {
      ...base,
      kind: 'view_registration',
      text: VIEW_REGISTRATION,
      secondary: false,
      tag: row.me.status === 'CONFIRMED' ? YOURE_IN : waitlistTag(row.me.waitlistRank),
    };
  }
  if (!row.canRegister) {
    return { ...base, kind: 'view_session', text: VIEW_SESSION, secondary: true, tag: null };
  }
  return row.seatsLeft > 0
    ? { ...base, kind: 'register', text: REGISTER, secondary: false, tag: null }
    : { ...base, kind: 'waitlist', text: JOIN_WAITLIST, secondary: false, tag: null };
}

export function openSessionCard(row: OpenSessionRow): OpenSessionCard {
  const when = whenRange(row.startsAt, row.endsAt);
  return {
    key: `${row.teamId}:${row.sessionId}`,
    teamName: row.teamName,
    teamHref: teamPagePath(row.teamId),
    heading: row.location,
    when,
    address: row.address,
    feeText: openFeeText(row.pricingStructure, row.unitFee, row.feeLevel),
    seatsText: seatsLineOf(row),
    button: sessionButton(row, when),
  };
}

function seatsLineOf(row: OpenSessionRow): string {
  const { seatsLeft, publicCapacity, waitlistLength } = row;
  if (seatsLeft === 0) return `Full · ${waitlistLength} on the waitlist`;
  const places = `${seatsLeft} of ${publicCapacity} places left`;
  return waitlistLength > 0 ? `${places} · ${waitlistLength} on the waitlist` : places;
}

// ---------------------------------------------------------------------------------------------
// My Registration
// ---------------------------------------------------------------------------------------------

export interface RegistrationCard {
  key: string;
  heading: string;
  teamName: string;
  teamHref: string;
  when: string;
  address: string;
  group: string;
  /** `You're in`, `Waitlist #n`, `Late withdrawal` or `Session cancelled`. */
  state: string;
  tag: { text: string; tone: TagTone } | null;
  total: string | null;
  /** Why a held or payout-blocked payment is not payable; null otherwise. */
  note: string | null;
  /** `View payment`, only once billing produced a payment. */
  paymentHref: string | null;
  sessionHref: string;
}

function registrationState(row: DashboardRegistrationRow): string {
  if (row.sessionStatus === 'CANCELLED') return SESSION_CANCELLED;
  if (row.status === 'WAITLISTED') return waitlistTag(row.waitlistRank);
  if (row.status === 'WITHDRAWN') return LATE_WITHDRAWAL;
  return YOURE_IN;
}

function registrationTag(row: DashboardRegistrationRow): RegistrationCard['tag'] {
  const payment = row.payment;
  if (payment !== null) return paymentTag(payment);
  if (row.sessionStatus === 'CANCELLED') return null;
  if (row.status === 'WAITLISTED') return { text: WAITLIST_NOT_CHARGED, tone: 'slate' };
  return { text: NOT_BILLED_YET, tone: 'slate' };
}

function registrationTotal(row: DashboardRegistrationRow): string | null {
  if (row.payment !== null) return totalFeeLine(row.payment.amount);
  if (row.sessionStatus === 'CANCELLED') return null;
  return row.estimatedTotal === null ? FEE_NOT_SET : estimatedTotalLine(row.estimatedTotal);
}

function registrationNote(payment: DashboardRegistrationRow['payment']): string | null {
  if (payment === null || payment.status === 'PAID') return null;
  if (payment.onHold) return HOLD_ROW_PLAYER;
  return payment.payoutBlocked ? PAYOUT_BLOCKED_PLAYER : null;
}

export function registrationCard(row: DashboardRegistrationRow): RegistrationCard {
  return {
    key: row.registrationId,
    heading: row.location,
    teamName: row.teamName,
    teamHref: teamPagePath(row.teamId),
    when: formatWhen(row.startsAt),
    address: row.address,
    group: groupLine(row.guestCount),
    state: registrationState(row),
    tag: registrationTag(row),
    total: registrationTotal(row),
    note: registrationNote(row.payment),
    paymentHref: row.payment === null ? null : paymentPath(row.payment.id),
    sessionHref: playerSessionPath(row.teamId, row.sessionId),
  };
}

// ---------------------------------------------------------------------------------------------
// Payments & Wallet
// ---------------------------------------------------------------------------------------------

export interface WalletCardAction {
  text: string;
  href: string;
  /** Visually hidden words that name the team after the visible text. */
  srSuffix: string;
}

export interface WalletCardView {
  teamId: string;
  name: string;
  /** The team name links here. */
  href: string;
  /** The wallet read failed: the card body is replaced by one line and no amount is shown. */
  failed: boolean;
  balance: string | null;
  /** Exactly one state line from `walletState`, or null. */
  line: string | null;
  action: WalletCardAction | null;
}

/** One approved team's wallet card from its `GET /teams/:teamId/wallet` read model (`null` when that read failed). */
export function walletCard(
  team: { id: string; name: string },
  wallet: WalletResponse['wallet'] | null,
): WalletCardView {
  const base = { teamId: team.id, name: team.name, href: walletPath(team.id) };
  if (wallet === null) {
    return { ...base, failed: true, balance: null, line: null, action: null };
  }
  const state = walletState(wallet, {});
  const viewWallet: WalletCardAction = {
    text: VIEW_WALLET,
    href: base.href,
    srSuffix: forTeam(team.name),
  };
  const common = { ...base, failed: false, balance: balanceLine(wallet.balance) };
  switch (state.kind) {
    case 'form':
      return {
        ...common,
        line: state.headroomLine,
        action: { text: TOP_UP_CREDIT, href: `${base.href}#wallet`, srSuffix: forTeam(team.name) },
      };
    case 'full':
      return { ...common, line: state.line, action: null };
    case 'processing':
      return { ...common, line: state.startedLine, action: viewWallet };
    case 'held':
      return { ...common, line: state.heading, action: viewWallet };
  }
}

export interface PaymentGroupView {
  teamId: string;
  teamName: string;
  rows: MyPaymentRow[];
}

export interface AccordionView {
  id: 'overdue' | 'pending' | 'paid';
  /** `Overdue (1)`: the payer's total from the API, whatever page is loaded. */
  title: string;
  /** Overdue and Pending open by default when their total is not zero; Paid is closed until its own `Show more` is followed. */
  open: boolean;
  empty: string;
  groups: PaymentGroupView[];
  showMoreHref: string | null;
}

type TeamPayments = UnpaidPaymentsResponse['teams'];

function groupsOf(
  teams: TeamPayments,
  pick: (rows: MyPaymentRow[]) => MyPaymentRow[],
): PaymentGroupView[] {
  return teams
    .map((team) => ({ teamId: team.teamId, teamName: team.teamName, rows: pick(team.payments) }))
    .filter((group) => group.rows.length > 0);
}

/**
 * The three accordions in order Overdue, Pending, Paid. Titles carry the API's totals (`counts`), never the loaded rows. The
 * unpaid list feeds the first two and is one list in due order paged by `unpaidCursor`, so its `Show more` appears once: under
 * Pending, where the next page continues, or under Overdue when nothing is pending at all. The paid list is paged by
 * `paidCursor`; each `Show more` keeps the other list's cursor in the URL. Every loaded paid row is shown (an invoice must stay
 * reachable), so `paidLimit` is off.
 */
export function paymentAccordions(input: {
  unpaid: UnpaidPaymentsResponse;
  paid: UnpaidPaymentsResponse;
  paidCursor?: string;
  unpaidCursor?: string;
}): AccordionView[] {
  const { unpaid, paid } = input;
  const unpaidMore =
    unpaid.nextCursor === null
      ? null
      : paymentsPagePath({
          ...(input.paidCursor === undefined ? {} : { paidCursor: input.paidCursor }),
          unpaidCursor: unpaid.nextCursor,
        });
  const paidMore =
    paid.nextCursor === null
      ? null
      : paymentsPagePath({
          paidCursor: paid.nextCursor,
          ...(input.unpaidCursor === undefined ? {} : { unpaidCursor: input.unpaidCursor }),
        });
  const options = { paidLimit: null } as const;
  const overdue = groupsOf(unpaid.teams, (rows) => groupPayments(rows, options).overdue);
  const pending = groupsOf(unpaid.teams, (rows) => groupPayments(rows, options).pending);
  const paidGroups = groupsOf(paid.teams, (rows) => groupPayments(rows, options).paid);
  const build = (
    id: AccordionView['id'],
    label: string,
    empty: string,
    groups: PaymentGroupView[],
    total: number,
    showMoreHref: string | null,
    openByDefault: boolean,
  ): AccordionView => ({
    id,
    title: accordionTitle(label, total),
    open: openByDefault && total > 0,
    empty,
    groups,
    showMoreHref,
  });
  const { overdue: overdueTotal, pending: pendingTotal } = unpaid.counts;
  const unpaidMoreUnderPending = pendingTotal > 0;
  return [
    build(
      'overdue',
      'Overdue',
      NOTHING_OVERDUE,
      overdue,
      overdueTotal,
      unpaidMoreUnderPending ? null : unpaidMore,
      true,
    ),
    build(
      'pending',
      'Pending',
      NOTHING_PENDING,
      pending,
      pendingTotal,
      unpaidMoreUnderPending ? unpaidMore : null,
      true,
    ),
    build(
      'paid',
      'Paid',
      NO_PAID_GAMES,
      paidGroups,
      paid.counts.paid,
      paidMore,
      input.paidCursor !== undefined,
    ),
  ];
}

/** True when neither payments read returned a row: the accordions give way to `NO_PAYMENTS`. */
export function paymentsEmpty(
  unpaid: UnpaidPaymentsResponse,
  paid: UnpaidPaymentsResponse,
): boolean {
  const rows = (teams: TeamPayments): number =>
    teams.reduce((total, team) => total + team.payments.length, 0);
  return rows(unpaid.teams) + rows(paid.teams) === 0;
}
