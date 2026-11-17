import { instantToLocal, type PricingType, type SkillTier } from '@sgm/shared';
import { money } from '../billing/labels.ts';
import { formatWhen, skillLabel } from '../registrations/labels.ts';
import { formatClock } from '../teams/sessions-view.ts';
import type { DashboardTab } from './paths.ts';

/**
 * The copy deck of the player dashboard (player-dashboard spec) and the small pure formatters behind it: every string a
 * dashboard component prints that is not an existing billing or registration line lives here. Amounts are 2-dp strings the
 * API returned, formatted with `money` (`formatNZD`); nothing here parses, adds or compares money. Dates are shown in
 * Pacific/Auckland from the server's UTC instant (P3). No line says whether Akahu is, or is not, live.
 */

export const PAGE_TITLE = 'Dashboard – Shared Game Management';
export const PAGE_HEADING = 'Dashboard';
export const NAV_LABEL = 'Dashboard';
export const HEADER_LINK = 'Dashboard';

export const TAB_LABELS: Readonly<Record<DashboardTab, string>> = {
  opening: 'Currently Opening',
  registrations: 'My Registration',
  payments: 'Payments & Wallet',
};

// Section failures (AC-ERROR-1): nothing is guessed, no amount is shown.
export const OPEN_LOAD_FAILED = "We can't load sessions right now. Try again in a minute.";
export const REGISTRATIONS_LOAD_FAILED =
  "We can't load your registrations right now. Try again in a minute.";
export const WALLET_LOAD_FAILED = "We can't load this wallet right now. Try again in a minute.";
export const WALLETS_LOAD_FAILED = "We can't load your wallets right now. Try again in a minute.";

// Empty states (AC-ERROR-4).
export const NO_TEAM_OPEN = 'Join a team to see its open sessions here.';
export const NO_OPEN_SESSIONS = 'No sessions are open for registration right now.';
export const NO_REGISTRATIONS = "You haven't registered for any sessions yet.";
export const NO_TEAM_WALLET = 'Join a team to get a wallet.';
export const FIND_A_TEAM = 'Find a team';
export const SEE_OPEN_SESSIONS = 'See open sessions';
export const NOTHING_OVERDUE = 'Nothing overdue.';
export const NOTHING_PENDING = 'Nothing pending.';
export const NO_PAID_GAMES = 'No paid games yet.';

// Headings and actions.
export const UPCOMING_HEADING = 'Upcoming';
export const PAST_HEADING = 'Past';
export const WALLET_HEADING = 'Wallet';
export const PAYMENTS_HEADING = 'Payments';
export const REGISTER = 'Register';
export const JOIN_WAITLIST = 'Join waitlist';
export const VIEW_REGISTRATION = 'View registration';
export const VIEW_SESSION = 'View session';
export const VIEW_PAYMENT = 'View payment';
export const GO_TO_PAYMENTS = 'Go to Payments & Wallet';
export const TOP_UP_CREDIT = 'Top up credit';
export const VIEW_WALLET = 'View wallet';

// Registration state and tags.
export const YOURE_IN = "You're in";
export const LATE_WITHDRAWAL = 'Late withdrawal';
export const SESSION_CANCELLED = 'Session cancelled';
export const NOT_BILLED_YET = 'Not billed yet';
export const WAITLIST_NOT_CHARGED = 'Charged only if you get a place.';
export const FEE_NOT_SET = "The fee isn't set for this session yet.";

export const waitlistTag = (rank: number | null): string =>
  rank === null ? 'On the waitlist' : `Waitlist #${rank}`;

/** The accessible-name suffix that tells a list of identical buttons apart: `for Rosedale Hall, Wed 7 Oct, 8:00 pm`. */
export const forSession = (location: string, when: string): string => ` for ${location}, ${when}`;
export const forTeam = (team: string): string => ` for ${team}`;

/** `Wed 7 Oct, 8:00 pm to 10:00 pm`; day and start time only when the session has no end. */
export function whenRange(startsAt: string, endsAt: string | null): string {
  if (endsAt === null) return formatWhen(startsAt);
  return `${formatWhen(startsAt)} to ${formatClock(instantToLocal(new Date(endsAt)).time)}`;
}

/** The caller's own fee as the API priced it (`FLAT` per person; the other modes name the tier). */
export function openFeeText(
  pricing: PricingType,
  unitFee: string | null,
  level: SkillTier | null,
): string {
  if (unitFee === null) return FEE_NOT_SET;
  if (pricing === 'FLAT') return `${money(unitFee)} per person`;
  const tier = pricing === 'BY_SKILL_LEVEL' && level !== null ? ` (${skillLabel(level)})` : '';
  return `Your fee: ${money(unitFee)}${tier}`;
}

export const totalFeeLine = (amount: string): string => `Total fee: ${money(amount)}`;
export const estimatedTotalLine = (amount: string): string => `Estimated total: ${money(amount)}`;

export const accordionTitle = (label: string, count: number): string => `${label} (${count})`;
