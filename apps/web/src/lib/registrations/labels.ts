import {
  instantToLocal,
  type MyRegistration,
  type RegistrationReadResponse,
  type SessionStatus,
  type SkillTier,
  type UserSex,
  type WithdrawalKind,
} from '@sgm/shared';
import { SKILL_OPTIONS } from '../teams/labels.ts';
import { formatClock, formatDayShort, formatMoneyText, plural } from '../teams/sessions-view.ts';

/**
 * The copy deck of the registration panel (UI/UX "Copy", as amended by R2, R9, R10, R11, R15, R17 and R27) and the small
 * pure formatters behind it. Every number, rank, fee and count passed in here is a field the API read model returned: nothing
 * in this file adds, subtracts or compares seats, fees or queue positions. Dates are formatted at the edge, in
 * Pacific/Auckland, from the server's UTC instant (P3).
 */

type Pricing = RegistrationReadResponse['session']['pricingStructure'];
type Fees = RegistrationReadResponse['session']['fees'];
type Registration = NonNullable<MyRegistration>;

export const PANEL_HEADING = 'Registration';
export const AUTO_ENROL_LABEL = 'Added automatically (Auto Enroll)';
export const NOT_MEMBER_MESSAGE = 'You need to be a member of this team to register.';
export const NOT_MEMBER_LINK = 'View team page';
export const NOT_FOUND_HEADING = "We couldn't find that session.";
export const NOT_FOUND_BODY = 'It may have been removed, or the link may be wrong.';
export const LOAD_ERROR_MESSAGE = "We can't load registration right now. Try again in a minute.";
export const LOADING_MESSAGE = 'Loading registration...';
export const CANCELLED_MESSAGE = 'This session has been cancelled.';
export const NO_PUBLIC_PLACES_MESSAGE = 'This session has no public places.';
export const LATE_REGISTRATION_HINT =
  'The free cancellation deadline has passed. If you withdraw later you may be charged.';
export const PROMOTED_AFTER_DEADLINE =
  "The free cancellation deadline has passed. If you can't play, withdraw here: you won't be charged if someone from the waitlist takes your place, otherwise the fee applies.";
export const DEADLINE_CHANGED_MESSAGE =
  'The free cancellation deadline passed while you were reading. Check the details below and confirm again.';

// Errors an action can end with (the API's own safe messages are used where they carry a server-computed number).
export const ALREADY_REGISTERED_MESSAGE = "You're already registered for this session.";
export const NOT_REGISTERED_MESSAGE = "You're not registered for this session.";
export const SESSION_CLOSED_MESSAGE = 'Registration for this session is closed.';
export const FEE_DUE_MESSAGE =
  "You owe the late-withdrawal fee for this session. You can register again only if there's a place for your whole group right now.";
export const OVERDUE_HELP = 'If you think this is wrong, ask your team admin.';
export const SESSION_NOT_FOUND_MESSAGE = "We couldn't find that session. It may have been removed.";
export const CAPACITY_FALLBACK_MESSAGE = "This session doesn't have room for a group that size.";

// Register form
export const PARTY_LEGEND = 'Bringing guests?';
export const PARTY_HINT =
  'Everyone needs a place. Your whole group is confirmed or waitlisted together.';
export const PARTY_OPTIONS = [
  { value: '0', label: 'Just me', guests: 0 },
  { value: '1', label: 'Me + 1 guest', guests: 1 },
  { value: '2', label: 'Me + 2 guests', guests: 2 },
] as const;
export const GUEST_GROUP_HINT =
  'Sex and skill level are needed for every guest, even when the price is the same for everyone.';
export const GUEST_SKILL_HINT =
  'Beginner is still learning the basics, Intermediate plays regularly, Advanced is experienced and competitive.';
export const GUEST_NAME_HINT = 'Only you and team admins see this name.';
export const WAITLIST_PREDICTION =
  "This group goes on the waitlist. You're only charged if you get a place.";

export const SEX_OPTIONS: readonly { value: UserSex; label: string }[] = [
  { value: 'MALE', label: 'Male' },
  { value: 'FEMALE', label: 'Female' },
  { value: 'OTHER', label: 'Other' },
];

const SEX_LABEL: Record<UserSex, string> = { MALE: 'Male', FEMALE: 'Female', OTHER: 'Other' };

export const skillLabel = (tier: SkillTier): string =>
  SKILL_OPTIONS.find((option) => option.value === tier)?.label ?? tier;

export const sexLabel = (sex: UserSex): string => SEX_LABEL[sex];

export function partyOptionHint(capacity: number, partySize: number): string {
  return `This session has ${capacity} public places, so a group of ${partySize} can't register.`;
}

export const submitLabel = (waitlist: boolean): string => (waitlist ? 'Join waitlist' : 'Register');
export const submitPendingLabel = (waitlist: boolean): string =>
  waitlist ? 'Joining waitlist...' : 'Registering...';

// ---------------------------------------------------------------------------------------------
// Lines of the panel
// ---------------------------------------------------------------------------------------------

/** `Wed 4 Nov, 8:00 am` in Pacific/Auckland. */
export function formatWhen(instant: string): string {
  const local = instantToLocal(new Date(instant));
  return `${formatDayShort(local.date)}, ${formatClock(local.time)}`;
}

export function seatsLine(input: {
  seatsLeft: number;
  publicCapacity: number;
  waitlistLength: number;
}): string {
  const { seatsLeft, publicCapacity, waitlistLength } = input;
  if (seatsLeft === 0) return `Full · ${waitlistLength} on the waitlist`;
  const places = `${seatsLeft} of ${publicCapacity} places left`;
  return waitlistLength > 0 ? `${places} · ${waitlistLength} on the waitlist` : places;
}

export function deadlineLine(deadline: string | null, passed: boolean): string | null {
  if (deadline === null) return null;
  return passed
    ? 'The free cancellation deadline has passed.'
    : `Free cancellation until ${formatWhen(deadline)}.`;
}

const guestsFor = (guestCount: number): string => `you and ${plural(guestCount, 'guest')}`;

/**
 * The fee line. `unitFee` and `estimatedTotal` are the server's (`me.unitFee`, `me.estimatedTotal`); `level` is the tier the
 * server priced the caller at (`me.feeLevel`, R15: the snapshot for a confirmed row, otherwise the current level), already
 * null off a skill-level session. It is named for a never-registered, waitlisted and confirmed caller alike.
 */
export function feeLine(input: {
  pricing: Pricing;
  unitFee: string | null;
  estimatedTotal: string | null;
  guestCount: number;
  registered: boolean;
  waitlisted: boolean;
  level: SkillTier | null;
}): string {
  const { pricing, unitFee, estimatedTotal, guestCount, registered, waitlisted, level } = input;
  const amount = formatMoneyText(registered ? estimatedTotal : unitFee);
  if (amount === '') return "The fee isn't set for this session yet.";
  const lead =
    pricing === 'FLAT'
      ? 'Fee'
      : `Your fee${pricing === 'BY_SKILL_LEVEL' && level !== null ? ` (${skillLabel(level)})` : ''}`;
  if (!registered) {
    return pricing === 'FLAT'
      ? `${lead}: ${amount} per person, charged after the game.`
      : `${lead}: ${amount}, charged after the game.`;
  }
  const forWhom = guestCount > 0 ? ` for ${guestsFor(guestCount)}` : '';
  const line = `${lead}: ${amount}${forWhom}, charged after the game.`;
  return waitlisted ? `${line} Charged only if you get a place.` : line;
}

/** Every fee the session set for BY_SEX and BY_SKILL_LEVEL (`session.fees`), so the player sees what each person pays. */
export function feeListLines(
  pricing: Pricing,
  fees: Fees,
): { intro: string; rows: string[] } | null {
  const money = (value: string | null): string => formatMoneyText(value) || 'not set';
  if (pricing === 'BY_SEX') {
    return {
      intro: 'Fees depend on sex. Guests are charged by their own sex.',
      rows: [
        `Male: ${money(fees.male)}`,
        `Female: ${money(fees.female)}`,
        `Other: ${money(fees.other)}`,
      ],
    };
  }
  if (pricing === 'BY_SKILL_LEVEL') {
    return {
      intro: 'Fees depend on skill level. Guests are charged by their own skill level.',
      rows: [
        `Beginner: ${money(fees.beginner)}`,
        `Intermediate: ${money(fees.intermediate)}`,
        `Advanced: ${money(fees.advanced)}`,
      ],
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The caller's registration
// ---------------------------------------------------------------------------------------------

export const groupLine = (guestCount: number): string =>
  guestCount === 0 ? 'Just you' : `Your group: you + ${plural(guestCount, 'guest')}`;

export function guestLine(guest: Registration['guests'][number]): string {
  const name =
    guest.displayName === null || guest.displayName === '' ? '' : `${guest.displayName}, `;
  return `Guest ${guest.position}: ${name}${sexLabel(guest.sex)}, ${skillLabel(guest.skillLevel)}`;
}

export const registeredHeadline = "You're in.";
export const waitlistHeadline = (rank: number | null): string =>
  `You're on the waitlist${rank === null ? '' : ` (#${rank})`}. We'll email you if a place opens up.`;
export const FIRST_IN_LINE = "You're first in line.";
export const promotedLine = (promotedAt: string): string =>
  `You were moved off the waitlist on ${formatWhen(promotedAt)}.`;

/** No numbers: the page cannot know which groups behind fit, so it says what is true without counting. */
export function passedOverLine(): string {
  return 'Places are free, but your group needs them together. Smaller groups behind you may get places first; you keep your spot at the front.';
}

export function debtMessage(overdueCount: number): string {
  return `You have ${overdueCount} overdue payments across your teams. Pay them before registering for more sessions. ${OVERDUE_HELP}`;
}

export function withdrawnText(input: {
  kind: WithdrawalKind | null;
  feeDue: boolean;
  fee: string | null;
  guestCount: number;
}): string {
  if (input.kind !== 'LATE' || !input.feeDue) {
    return "You withdrew from this session. You won't be charged.";
  }
  const amount = formatMoneyText(input.fee) || 'late-withdrawal';
  const forWhom = input.guestCount > 0 ? ` for ${guestsFor(input.guestCount)}` : '';
  return `You withdrew from this session after the free cancellation deadline. No one has taken your place yet, so the ${amount} fee${forWhom} applies unless someone takes your place before the game.`;
}

export function closedText(input: {
  status: SessionStatus;
  registration: Registration['status'] | null;
}): string[] {
  const lines: string[] = [];
  if (input.status === 'COMPLETED') lines.push('This session has finished.');
  if (input.registration === 'CONFIRMED') lines.push('You were registered.');
  if (input.registration === 'WAITLISTED' && input.status !== 'COMPLETED') {
    lines.push("The session has started and you didn't get a place.");
  }
  lines.push('Registration is closed.');
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Confirmations
// ---------------------------------------------------------------------------------------------

export const WITHDRAW_TRIGGER = 'Withdraw';
export const WITHDRAW_TRIGGER_ARIA = 'Withdraw from this session';
export const WITHDRAW_CONFIRM = 'Withdraw';
export const WITHDRAW_PENDING = 'Withdrawing...';
export const LEAVE_TRIGGER = 'Leave waitlist';
export const LEAVE_PENDING = 'Leaving...';
export const CONFIRM_DISMISS = 'Cancel';
const LEAVE_PROMPT =
  "Leave the waitlist? You won't be charged. If you change your mind you can join again, but you'll go to the back of the line.";

export function withdrawPrompt(input: {
  kind: 'withdraw' | 'leave';
  late: boolean;
  /** `session.waitlistLength`. */
  waitlistLength: number;
  /** `me.estimatedTotal`: the party's fee as the server estimates it. */
  fee: string | null;
  /** `me.registration.guestCount`. */
  guestCount: number;
}): string {
  if (input.kind === 'leave') return LEAVE_PROMPT;
  const { late, waitlistLength, guestCount } = input;
  const grouped = guestCount > 0;
  const wholeGroup = `This withdraws your whole group (you and ${plural(guestCount, 'guest')}).`;
  if (!late) {
    return grouped
      ? `Withdraw from this session? ${wholeGroup} You won't be charged.`
      : "Withdraw from this session? You won't be charged.";
  }
  const amount = formatMoneyText(input.fee) || 'the session fee';
  const forWhom = grouped ? ` for ${guestsFor(guestCount)}` : '';
  if (waitlistLength === 0) {
    return `The free cancellation deadline has passed and no one is waiting for a place, so you'll be charged ${amount}${forWhom} unless someone takes your place before the game. Withdraw anyway?${grouped ? ` ${wholeGroup}` : ''}`;
  }
  return `The free cancellation deadline has passed. If a waitlisted player takes your place you won't be charged. Otherwise you'll be charged ${amount}${forWhom}.${grouped ? ' This withdraws your whole group.' : ''}`;
}

// ---------------------------------------------------------------------------------------------
// Results of an action
// ---------------------------------------------------------------------------------------------

export type RegisterIntent = 'register' | 'waitlist';
export type WithdrawIntent = 'withdraw' | 'leave';

export function registerResultMessage(input: {
  status: 'CONFIRMED' | 'WAITLISTED';
  /** `registration.waitlistRank` from the response. */
  rank: number | null;
  intent: RegisterIntent;
}): string {
  if (input.status === 'CONFIRMED') {
    return input.intent === 'waitlist' ? "A place opened up, so you're in." : registeredHeadline;
  }
  return input.intent === 'register'
    ? `There weren't enough places for your whole group, so you're on the waitlist${input.rank === null ? '' : ` (#${input.rank})`}. We'll email you if a place opens up.`
    : waitlistHeadline(input.rank);
}

export function withdrawResultMessage(input: {
  intent: WithdrawIntent;
  kind: WithdrawalKind;
  replacedBy: 'waitlist' | 'nobody';
  /** `feeEstimate` from the response. */
  feeEstimate: string;
  /** The page showed a registration with guests. */
  grouped: boolean;
}): string {
  if (input.intent === 'leave') return "You've left the waitlist.";
  if (input.kind !== 'LATE') return "You've withdrawn. You won't be charged.";
  if (input.replacedBy === 'waitlist') {
    return "You've withdrawn. A player from the waitlist took your place, so you won't be charged.";
  }
  const amount = formatMoneyText(input.feeEstimate) || 'late-withdrawal';
  return `You've withdrawn. No one could take your place yet, so the ${amount} fee${input.grouped ? ' for your group' : ''} applies unless someone takes your place before the game.`;
}
