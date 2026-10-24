import {
  defaultCancellationDeadline,
  epochDay,
  formatNZD,
  fromEpochDay,
  instantToLocal,
  isZero,
  parseLocalDate,
  parseMoney,
  recurrenceDates,
  type DstOptionsEntry,
  type Money,
  type SeriesInstanceResponse,
  type SeriesListItem,
  type SeriesResponse,
  type SessionResponse,
} from '@sgm/shared';
import type { ErrorLink } from '../auth/landing.ts';
import {
  NO_ACCESS_HEADING,
  OUTAGE_MESSAGE,
  SAVE_FAILED_MESSAGE,
  UNCONFIRMED_MESSAGE,
} from './labels.ts';

/**
 * Pure view rules and copy of the Sessions area (UI/UX "Copy deck (final)", as amended by the binding
 * reconciliation: P-1 Auto Enroll for every session, P-2 registered-player counts and no emails, P-3 fixed
 * pattern, T-5 series-save counts, T-6 End series, T-7 fee lock, T-10 DST, T-11 phase labels, T-12 stale
 * copy). Kept free of React so every label, notice and prompt is table-tested once; the components only
 * render what these return. Dates are "Wed 4 Nov 2026" and times "8:00 am"; both are built from fields,
 * never from ICU locale data.
 */

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ORDINAL_WORDS: Readonly<Record<number, string>> = {
  1: 'first',
  2: 'second',
  3: 'third',
  4: 'fourth',
  [-1]: 'last',
};

/** `1 player`, `2 players`; pass `many` for irregular plurals. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The year, month and day of a `YYYY-MM-DD` string, or null when it is not a real date. */
export function parseYmd(date: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return { y, m, d };
}

/** The weekday index (0 = Sunday) of a valid `YYYY-MM-DD` string. */
export function weekdayIndex(date: string): number | null {
  const parts = parseYmd(date);
  return parts === null ? null : new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay();
}

export function weekdayName(index: number): string {
  return WEEKDAYS[index] ?? 'Day';
}

/** `Wed 4 Nov 2026`. */
export function formatDay(date: string): string {
  const parts = parseYmd(date);
  const weekday = weekdayIndex(date);
  if (parts === null || weekday === null) return date;
  return `${weekdayName(weekday).slice(0, 3)} ${parts.d} ${MONTHS[parts.m - 1]} ${parts.y}`;
}

/** `Wed 4 Nov`. */
export function formatDayShort(date: string): string {
  const parts = parseYmd(date);
  const weekday = weekdayIndex(date);
  if (parts === null || weekday === null) return date;
  return `${weekdayName(weekday).slice(0, 3)} ${parts.d} ${MONTHS[parts.m - 1]}`;
}

/** `4 Nov 2026`. */
export function formatDateLong(date: string): string {
  const parts = parseYmd(date);
  return parts === null ? date : `${parts.d} ${MONTHS[parts.m - 1]} ${parts.y}`;
}

/** `8:00 am` from `HH:MM` (`24:00`, the end-of-day marker, reads as midnight). */
export function formatClock(time: string): string {
  const [hh = '0', mm = '00'] = time.split(':');
  const hour = Number(hh) % 24;
  return `${hour % 12 === 0 ? 12 : hour % 12}:${mm.slice(0, 2)} ${hour < 12 ? 'am' : 'pm'}`;
}

const meridiem = (time: string): 'am' | 'pm' =>
  Number(time.split(':')[0]) % 24 < 12 ? 'am' : 'pm';

/** `8:00-10:00 am` (compact, list rows) or `8:00 am-10:00 am` (full, summaries). */
export function formatTimeRange(start: string, end: string, style: 'compact' | 'full'): string {
  if (style === 'compact' && meridiem(start) === meridiem(end)) {
    return `${formatClock(start).replace(/ [ap]m$/, '')}-${formatClock(end)}`;
  }
  return `${formatClock(start)}-${formatClock(end)}`;
}

/** The NZ day and court time range of a session, from its instants. */
export function sessionWhen(session: Pick<SessionResponse, 'date' | 'startsAt' | 'endsAt'>): {
  day: string;
  range: string | null;
  text: string;
} {
  const day = formatDay(session.date);
  if (session.startsAt === null || session.endsAt === null) {
    return { day, range: null, text: day };
  }
  const start = instantToLocal(new Date(session.startsAt)).time;
  const end = instantToLocal(new Date(session.endsAt)).time;
  const range = formatTimeRange(start, end, 'compact');
  return { day, range, text: `${day}, ${range}` };
}

/** `Mon 2 Nov, 8:00 am`: the default cancellation deadline of a session that starts at `startsAt`. */
export function deadlineReadout(startsAt: string | null): string | null {
  if (startsAt === null) return null;
  const local = instantToLocal(defaultCancellationDeadline(new Date(startsAt)));
  return `${formatDayShort(local.date)}, ${formatClock(local.time)}`;
}

// ---------------------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------------------

export const PRICING_MODEL_LABELS = {
  FLAT: 'Flat rate',
  BY_SEX: 'By sex',
  BY_SKILL_LEVEL: 'By skill level',
} as const;

/** The fee fields a session or a series carries; `feeFlat` falls back to the rate it follows. */
export interface FeeFields {
  pricingStructure: SessionResponse['pricingStructure'];
  feeFlat?: string | null;
  customPlayerRate?: string | null;
  calculatedRatePerPlayer?: string | null;
  feeMale?: string | null;
  feeFemale?: string | null;
  feeOther?: string | null;
  feeBeginner?: string | null;
  feeIntermediate?: string | null;
  feeAdvanced?: string | null;
}

function money(value: string | null | undefined): Money | null {
  if (value === null || value === undefined) return null;
  try {
    return parseMoney(value);
  } catch {
    return null;
  }
}

/**
 * `$12.00 each`, `$17.00 male, $16.00 female, $16.00 other` or the three skill fees; null when every
 * fee of the model is zero or missing (a free session: nothing is charged).
 */
export function feeSummary(fees: FeeFields): string | null {
  const pairs: [string, string | null | undefined][] =
    fees.pricingStructure === 'FLAT'
      ? [['each', fees.feeFlat ?? fees.customPlayerRate ?? fees.calculatedRatePerPlayer]]
      : fees.pricingStructure === 'BY_SEX'
        ? [
            ['male', fees.feeMale],
            ['female', fees.feeFemale],
            ['other', fees.feeOther],
          ]
        : [
            ['beginner', fees.feeBeginner],
            ['intermediate', fees.feeIntermediate],
            ['advanced', fees.feeAdvanced],
          ];
  const amounts = pairs.map(([label, value]) => [label, money(value)] as const);
  if (amounts.every(([, amount]) => amount === null || isZero(amount))) return null;
  return amounts
    .filter((entry): entry is readonly [string, Money] => entry[1] !== null)
    .map(([label, amount]) => `${formatNZD(amount)} ${label}`)
    .join(', ');
}

/** `Flat rate · $12.00 each` for the read-only summary (`Free` when nothing is charged). */
export function pricingLine(fees: FeeFields): string {
  return `${PRICING_MODEL_LABELS[fees.pricingStructure]} · ${feeSummary(fees) ?? 'Free'}`;
}

export function formatMoneyText(value: string | null | undefined): string {
  const amount = money(value);
  return amount === null ? '' : formatNZD(amount);
}

// ---------------------------------------------------------------------------------------------
// Sessions list
// ---------------------------------------------------------------------------------------------

export const LIST_COPY = {
  intro:
    'Set up one-off sessions or a series that repeats. Members can register once a session is published.',
  createHint: "Members on Auto Enroll are added to every session when it's published.",
  newSession: 'New session',
  newSeries: 'New recurring series',
  bankingNotice: "Some sessions weren't published because your team's bank account isn't set up.",
  bankingLink: 'Set up banking and GST',
} as const;

export function listHeading(teamName: string): string {
  return `Sessions for ${teamName}`;
}

export type ListSectionId = 'upcoming' | 'drafts' | 'series' | 'past';

export const LIST_SECTIONS: readonly { id: ListSectionId; title: string; empty: string }[] = [
  {
    id: 'upcoming',
    title: 'Upcoming',
    empty: 'No upcoming sessions. Published sessions appear here.',
  },
  { id: 'drafts', title: 'Drafts', empty: 'No drafts.' },
  { id: 'series', title: 'Series', empty: 'No recurring series yet.' },
  { id: 'past', title: 'Past and cancelled', empty: 'Nothing here yet.' },
];

type LabelSession = Pick<
  SessionResponse,
  'status' | 'phase' | 'draftReason' | 'isInstanceOverridden' | 'seriesName'
>;

export interface SessionLabel {
  label: string;
  /** Bordered text chips after the label: `Edited`, `Series: {name}`. */
  tags: string[];
}

/** The status label and tags of a row (T-11): the API supplies `phase`, the web never reads the clock. */
export function sessionLabel(
  session: LabelSession,
  context: { isPayoutConfigured: boolean },
): SessionLabel {
  let label: string;
  switch (session.status) {
    case 'PUBLISHED':
      label =
        session.phase === 'started' ? 'Started' : session.phase === 'ended' ? 'Ended' : 'Published';
      break;
    case 'COMPLETED':
      label = 'Completed';
      break;
    case 'CANCELLED':
      label = 'Cancelled';
      break;
    case 'DRAFT':
      if (session.phase !== 'upcoming') label = 'Not published · date passed';
      else if (session.draftReason === 'banking') {
        label = context.isPayoutConfigured
          ? 'Draft · publishes overnight'
          : 'Draft · bank account needed';
      } else if (session.draftReason === 'edited') label = 'Draft · Edited';
      else label = 'Draft';
      break;
  }
  const tags: string[] = [];
  if (session.isInstanceOverridden && label !== 'Draft · Edited') tags.push('Edited');
  if (session.seriesName !== null) tags.push(`Series: ${session.seriesName}`);
  return { label, tags };
}

/**
 * One page-level notice above the sections, only while a banking draft waits and banking is missing. `bankingDrafts` is the
 * API's team-wide count (`GET /sessions`), never a count of the rows one page loaded (AC-ENTRY-2).
 */
export function showListBankingNotice(bankingDrafts: number, isPayoutConfigured: boolean): boolean {
  return !isPayoutConfigured && bankingDrafts > 0;
}

export interface SeriesRow {
  ruleId: string;
  name: string;
  /** `Active`, `Adding sessions…` or `Ended 16 Dec 2026`. */
  statusText: string;
  /** Null when no loaded date is upcoming: the list cannot know a count past the pages it loaded. */
  upcomingText: string | null;
}

/**
 * The Series section's rows, one per series from the series list read (`GET /session-series`), so a series that is
 * still being created, has ended, or has no date on the loaded pages still has its row. The upcoming count can only
 * come from the sessions the page loaded, so it is shown only when it is above zero.
 */
export function seriesRows(
  series: readonly SeriesListItem[],
  sessions: readonly Pick<SessionResponse, 'recurringRuleId' | 'status' | 'phase'>[],
): SeriesRow[] {
  const upcoming = new Map<string, number>();
  for (const session of sessions) {
    if (session.recurringRuleId === null) continue;
    if (
      (session.status === 'PUBLISHED' || session.status === 'DRAFT') &&
      session.phase === 'upcoming'
    ) {
      upcoming.set(session.recurringRuleId, (upcoming.get(session.recurringRuleId) ?? 0) + 1);
    }
  }
  return series.map((item) => {
    const count = upcoming.get(item.id) ?? 0;
    return {
      ruleId: item.id,
      name: item.name,
      statusText: seriesStatusLabel(item),
      upcomingText: count === 0 ? null : `${count} upcoming`,
    };
  });
}

/** `Active`, `Adding sessions…` or `Ended 16 Dec 2026`. */
export function seriesStatusLabel(
  series: Pick<SeriesResponse, 'isActive' | 'materialising' | 'recurUntil'>,
): string {
  if (!series.isActive) {
    return series.recurUntil === null ? 'Ended' : `Ended ${formatDateLong(series.recurUntil)}`;
  }
  return series.materialising ? 'Adding sessions…' : 'Active';
}

// ---------------------------------------------------------------------------------------------
// Session editor
// ---------------------------------------------------------------------------------------------

export function sessionHeading(session: Pick<SessionResponse, 'location' | 'date'> | null): string {
  return session === null ? 'New session' : `${session.location}, ${formatDay(session.date)}`;
}

export function sessionScopeLine(input: {
  seriesName: string | null;
  date: string;
  edited: boolean;
}): string {
  if (input.seriesName === null) {
    return 'One-off session. When you publish it, members on Auto Enroll are added to it.';
  }
  if (input.edited) {
    return `Edited. This date has its own details, so changes to ${input.seriesName} don't apply to it.`;
  }
  return `One date in ${input.seriesName}. Changes here apply to ${formatDayShort(input.date)} only. Once you save a change, this date is marked Edited and changes to the series won't overwrite it.`;
}

export const BANKING_LINK_LABEL = 'Set up banking and GST';

/** The status line under the scope line; `link` is the label of the banking link when one belongs under it. */
export function sessionStatusLine(
  session: Pick<SessionResponse, 'status' | 'draftReason'>,
  context: { isPayoutConfigured: boolean; justPublished: boolean },
): { text: string; link: string | null } {
  if (session.status === 'PUBLISHED') {
    return {
      text: context.justPublished
        ? 'Published. Members can register. Members on Auto Enroll are being added.'
        : 'Published. Members can register.',
      link: null,
    };
  }
  if (session.draftReason === 'banking') {
    return context.isPayoutConfigured
      ? {
          text: 'This session is still a draft. It will be published overnight, or you can publish it now.',
          link: null,
        }
      : {
          text: "This session wasn't published because your team's bank account isn't set up.",
          link: BANKING_LINK_LABEL,
        };
  }
  if (session.draftReason === 'edited') {
    return {
      text: "This date has been edited, so it won't be published automatically. Publish it when it's ready.",
      link: null,
    };
  }
  return { text: "Draft. Members can't see it until you publish it.", link: null };
}

export function registeredAre(count: number): string {
  return `${plural(count, 'player')} ${count === 1 ? 'is' : 'are'} registered`;
}

export function registeredWere(count: number): string {
  return `${plural(count, 'player')} ${count === 1 ? 'was' : 'were'} registered`;
}

export function registeredLine(count: number): string {
  return count === 0 ? 'No one has registered yet.' : `${registeredAre(count)}.`;
}

/** The "let them know" line shown on a published session with registrations (P-2: we do not email). */
export function changeNoticeLine(count: number): string | null {
  if (count <= 0) return null;
  return `${registeredAre(count)}. We don't email them about changes, so let them know if you change the date, times, place, cancellation deadline or fees.`;
}

export const FEES_LOCKED_MESSAGE =
  'Fees can only be lowered: a player has registered or still owes a late-withdrawal fee.';
export const FEE_OVER_LIMIT_MESSAGE =
  'This is higher than the current fee. Fees can only be lowered once a player has registered or still owes a late-withdrawal fee.';
export const CAPACITY_HINT = "Lowering this won't remove anyone who's already in.";
export const FIXED_DATE_HINT = 'To move this night, cancel it and create a one-off session.';

/** Why a session cannot be edited, or null while it can (DRAFT or PUBLISHED and not yet started). */
export function readOnlyReason(session: Pick<SessionResponse, 'status' | 'phase'>): string | null {
  switch (session.status) {
    case 'COMPLETED':
      return "This session is complete, so it can't be changed.";
    case 'CANCELLED':
      return "This session was cancelled, so it can't be changed.";
    case 'DRAFT':
      return session.phase === 'upcoming'
        ? null
        : "This draft's start time passed before it was published, so it can't be published or changed.";
    case 'PUBLISHED':
      if (session.phase === 'started') {
        return "This session has started, so it can't be changed or cancelled.";
      }
      return session.phase === 'ended' ? "This session has ended, so it can't be changed." : null;
  }
}

export interface ConfirmCopy {
  triggerLabel: string;
  prompt: string;
  confirmLabel: string;
  dismissLabel: string;
}

/** The cancel confirm for a draft or a published session, one-off or a series date. */
export function cancelPrompt(input: {
  status: 'DRAFT' | 'PUBLISHED';
  seriesDate: string | null;
  activeRegistrationCount: number;
}): ConfirmCopy {
  const triggerLabel = 'Cancel session';
  if (input.status === 'DRAFT') {
    return input.seriesDate === null
      ? {
          triggerLabel,
          prompt: "Cancel this draft? It won't be published, and you can't undo this.",
          confirmLabel: 'Cancel draft',
          dismissLabel: 'Keep draft',
        }
      : {
          triggerLabel,
          prompt: `Cancel ${formatDayShort(input.seriesDate)}? The series won't add this date again, and you can't undo this.`,
          confirmLabel: 'Cancel this date',
          dismissLabel: 'Keep draft',
        };
  }
  const registered =
    input.activeRegistrationCount === 0
      ? 'No one has registered yet.'
      : `${registeredAre(input.activeRegistrationCount)}. We won't email them, so let them know. No one is charged for it.`;
  const series = input.seriesDate === null ? '' : " The series won't add this date again.";
  return {
    triggerLabel,
    prompt: `Cancel this session? ${registered} You can't undo this.${series}`,
    confirmLabel: 'Cancel session',
    dismissLabel: 'Keep session',
  };
}

export const PUBLISH_CONFIRM = {
  confirmLabel: 'Publish session',
  pendingLabel: 'Publishing…',
  dismissLabel: 'Keep editing',
} as const;

/** The publish confirm (P-1: Auto Enroll applies to every session); the charge sentence only for paid ones. */
export function publishPrompt(summary: string | null): string {
  const charge = summary === null ? '' : `, and each player is charged after the game: ${summary}`;
  return `Publish this session? Members can register straight away${charge}. Members on Auto Enroll will be added to it.`;
}

export const CREATE_SERIES_CONFIRM = {
  confirmLabel: 'Create series',
  pendingLabel: 'Creating…',
  dismissLabel: 'Keep editing',
} as const;

export function createSeriesPrompt(input: {
  firstDate: string;
  feeSummary: string | null;
  bankingMissing: boolean;
}): string {
  const parts = [
    `Create this series? Sessions from ${formatDayShort(input.firstDate)} are added now and published for registration.`,
    'Members on Auto Enroll are added to each one.',
  ];
  if (input.feeSummary !== null) {
    parts.push(`Each player is charged after the game: ${input.feeSummary}.`);
  }
  if (input.bankingMissing) {
    parts.push(
      "Your team's bank account isn't set up, so the sessions will be saved as drafts until it is.",
    );
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------------------------
// Courts, costing, pricing and deadline copy
// ---------------------------------------------------------------------------------------------

export const COURT_COPY = {
  legend: 'Courts',
  hint: 'Times are New Zealand time.',
  count: 'Number of courts',
  defaultStart: 'Default start',
  defaultEnd: 'Default end',
  apply: 'Apply to all courts',
  defaultsHint: 'Default times are used for new courts.',
  add: 'Add court',
  remove: 'Remove',
  notDefault: 'Not default',
} as const;

export function defaultsChangedHint(rows: number): string {
  return `Default times changed. Apply to all courts to update the ${rows} rows.`;
}

export const COSTING_COPY = {
  legend: 'Costing',
  courtHire: 'Court hire (total)',
  courtHireHint: 'Optional. Leave blank for a free session.',
  extras: 'Extra expenses',
  incomplete: 'Enter max players to see a suggested rate.',
  hostSeatCaveat:
    "Reserved host seats aren't charged, so this rate won't quite cover the full cost.",
  locked:
    'Raising court hire or extras would raise a rate that follows the suggestion. Set a custom rate to keep the current fee.',
} as const;

export function suggestionLine(rate: string, maxPlayers: number): string {
  return `Suggested rate: ${rate} per player. Court hire plus extras, divided by max players (${maxPlayers}), rounded up to the next dollar.`;
}

export const PRICING_COPY = {
  legend: 'Pricing',
  flatRate: 'Rate per player',
  following: 'Following the suggested rate. It changes when costs or max players change.',
  pinned: "Custom rate. It won't change when costs change.",
  useSuggested: 'Use suggested rate',
  fillAll: 'Fill all with the suggested rate',
  otherHint: 'Starts as the lower of the other two until you change it.',
} as const;

export const PRICING_OPTIONS = [
  { value: 'FLAT', label: 'Flat rate', help: 'Everyone pays the same.' },
  { value: 'BY_SEX', label: 'By sex', help: 'One fee for men, one for women, one for other.' },
  { value: 'BY_SKILL_LEVEL', label: 'By skill level', help: 'One fee per skill level.' },
] as const;

export const DEADLINE_COPY = {
  legend: 'Cancellation deadline',
  defaultOption: 'Default: 48 hours before the first court starts',
  specificOption: 'A specific date and time',
  seriesLine: '48 hours before the first court starts, for every session in the series.',
} as const;

export const deadlineCurrently = (readout: string): string => `Currently ${readout}.`;

// ---------------------------------------------------------------------------------------------
// DST choice (T-10)
// ---------------------------------------------------------------------------------------------

export interface DstButton {
  choice: DstOptionsEntry['options'][number]['choice'];
  label: string;
}

const zoneAbbreviation = (instant: string): 'NZDT' | 'NZST' =>
  instantToLocal(new Date(instant)).utcOffsetMinutes === 780 ? 'NZDT' : 'NZST';

/**
 * The message and buttons under a court or deadline time that does not exist or happens twice. A court can only
 * take the first of an ambiguous time; a deadline can take either. The zone name comes from the option's instant.
 */
export function dstView(
  entry: DstOptionsEntry,
  kind: 'court' | 'deadline',
): { message: string; buttons: DstButton[] } {
  const clock = formatClock(entry.time);
  const day = formatDay(entry.date);
  if (entry.kind === 'nonexistent') {
    return {
      message: `${clock} doesn't happen on ${day}, because clocks go forward an hour at 2 am.`,
      buttons: entry.options.map((option) => ({
        choice: option.choice,
        label: `Use ${formatClock(option.localTime)}`,
      })),
    };
  }
  const buttons = entry.options
    .filter((option) => kind === 'deadline' || option.choice === 'earlier')
    .map((option) => ({
      choice: option.choice,
      label: `Use the ${option.choice === 'later' ? 'second' : 'first'} ${formatClock(option.localTime)} (${zoneAbbreviation(option.instant)})`,
    }));
  return {
    message: `${clock} happens twice on ${day}, because clocks go back an hour at 3 am. ${
      kind === 'court' ? "We'll use the first one." : 'Choose which one you mean.'
    }`,
    buttons,
  };
}

// ---------------------------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------------------------

export const SERIES_COPY = {
  newHeading: 'New recurring series',
  editHeading: 'Change series details',
  repeatsLegend: 'Repeats',
  firstSession: 'First session',
  repeatUntil: 'Repeat until (optional)',
  repeatUntilHint: 'You can extend or clear this date. To stop the series sooner, use End series.',
  fixedPattern: 'To change the day or how often it repeats, end this series and start a new one.',
  sessionsHeading: 'Sessions in this series',
  detailsHeading: 'Series details',
  changeDetails: 'Change series details',
  noSessionsYet: 'No sessions yet.',
  addingNewDates: "We're adding the new dates. Refresh in a moment.",
  saveButton: 'Save series',
  savePending: 'Saving…',
  createButton: 'Create series',
  monthlyWhich: 'Which one?',
} as const;

export const FREQUENCY_OPTIONS = [
  {
    value: 'WEEKLY',
    label: 'Weekly',
    help: 'Every week on the same day as the first session.',
  },
  {
    value: 'FORTNIGHTLY',
    label: 'Every 2 weeks',
    help: 'Every second week on the same day.',
  },
  {
    value: 'MONTHLY',
    label: 'Monthly',
    help: 'The same weekday each month, for example the 2nd Wednesday.',
  },
] as const;

export function publishHint(days: number): string {
  return `Sessions are added ${days} days ahead and published automatically, so members can register as soon as each one appears.`;
}

export function pastDisclosure(count: number): string {
  return `Past and cancelled sessions in this series (${count})`;
}

export function editDateLink(date: string): string {
  return `Edit ${formatDayShort(date)}`;
}

export function seriesEndedState(recurUntil: string | null): string {
  return `Ended. Last session ${recurUntil === null ? 'date unknown' : formatDateLong(recurUntil)}. To run it again, create a new series.`;
}

type PatternFields = Pick<SeriesResponse, 'frequency' | 'dayOfWeek' | 'monthlyWeek'>;

/** `Weekly on Wednesdays`, `Every 2 weeks on Sundays`, `Monthly on the second Wednesday`. */
export function seriesPatternLabel(series: PatternFields): string {
  const day = weekdayName(series.dayOfWeek);
  switch (series.frequency) {
    case 'WEEKLY':
      return `Weekly on ${day}s`;
    case 'FORTNIGHTLY':
      return `Every 2 weeks on ${day}s`;
    case 'MONTHLY':
      return `Monthly on the ${ORDINAL_WORDS[series.monthlyWeek ?? 1] ?? 'first'} ${day}`;
  }
}

/** The one-line summary under a series name. */
export function seriesSummaryLine(
  series: PatternFields & FeeFields & Pick<SeriesResponse, 'courts' | 'startsOn' | 'recurUntil'>,
): string {
  const starts = series.courts.map((court) => court.startTime).sort();
  const ends = series.courts.map((court) => court.endTime).sort();
  const parts = [seriesPatternLabel(series)];
  if (starts.length > 0 && ends.length > 0) {
    parts.push(formatTimeRange(starts[0] ?? '', ends[ends.length - 1] ?? '', 'full'));
  }
  parts.push(plural(series.courts.length, 'court'));
  parts.push(feeSummary(series) ?? 'Free');
  parts.push(`from ${formatDateLong(series.startsOn)}`);
  parts.push(
    series.recurUntil === null ? 'no end date' : `until ${formatDateLong(series.recurUntil)}`,
  );
  return parts.join(' · ');
}

export function seriesDetailsRows(
  series: PatternFields & Pick<SeriesResponse, 'startsOn' | 'recurUntil'>,
): { term: string; value: string }[] {
  return [
    { term: 'Repeats', value: seriesPatternLabel(series) },
    { term: 'First session', value: formatDateLong(series.startsOn) },
    {
      term: 'Repeat until',
      value: series.recurUntil === null ? 'No end date' : formatDateLong(series.recurUntil),
    },
  ];
}

/** What a series save would do to the instances listed (T-5), before the admin presses Save. */
export function seriesEffect(
  instances: readonly Pick<SeriesInstanceResponse, 'seriesChangeEffect'>[],
): {
  updated: number;
  edited: number;
  registered: number;
  line: string;
} {
  const count = (effect: SeriesInstanceResponse['seriesChangeEffect']): number =>
    instances.filter((instance) => instance.seriesChangeEffect === effect).length;
  const registered = count('has_registrations');
  const updated = count('will_update') + registered;
  const edited = count('edited');
  const parts = [
    updated > 0
      ? `Your changes will apply to ${plural(updated, 'upcoming session')} and to sessions added later.`
      : 'Your changes will apply to sessions added later.',
  ];
  if (edited > 0) {
    parts.push(
      `${plural(edited, 'edited session')} ${edited === 1 ? 'keeps its' : 'keep their'} own details.`,
    );
  }
  if (registered > 0) {
    parts.push(
      `${plural(registered, 'published session')} ${registered === 1 ? 'has' : 'have'} registered players, so fees on ${registered === 1 ? 'it' : 'them'} can only be lowered.`,
    );
  }
  if (updated + edited > 0) parts.push("Started, past and cancelled sessions don't change.");
  return { updated, edited, registered, line: parts.join(' ') };
}

export interface SeriesSaveCounts {
  updated: number;
  unchanged: number;
  skipped: {
    edited: number;
    started: number;
    closed: number;
    deadlinePassed: number;
    feeLocked: number;
  };
}

/** The banner lines after a series save: the first is the headline, the rest explain what was left alone. */
export function seriesSavedLines(outcome: SeriesSaveCounts): string[] {
  const { updated, skipped } = outcome;
  const closedCount = skipped.started + skipped.closed;
  const nothing =
    updated === 0 &&
    outcome.unchanged === 0 &&
    closedCount + skipped.edited + skipped.deadlinePassed + skipped.feeLocked === 0;
  const lines = [
    updated > 0
      ? `Series saved. ${plural(updated, 'upcoming session')} updated.`
      : nothing
        ? 'Series saved. Sessions added later will use the new details.'
        : 'Series saved.',
  ];
  if (skipped.edited > 0) {
    lines.push(
      `${plural(skipped.edited, 'edited session')} kept ${skipped.edited === 1 ? 'its' : 'their'} own details.`,
    );
  }
  if (closedCount > 0) {
    lines.push(
      closedCount === 1
        ? '1 session was left as it is because it has started or closed.'
        : `${closedCount} sessions were left as they are because they have started or closed.`,
    );
  }
  if (skipped.deadlinePassed > 0) {
    lines.push(
      skipped.deadlinePassed === 1
        ? '1 published session was left as it is because its cancellation deadline has passed.'
        : `${skipped.deadlinePassed} published sessions were left as they are because their cancellation deadline has passed.`,
    );
  }
  if (skipped.feeLocked > 0) {
    lines.push(
      `${plural(skipped.feeLocked, 'published session')} kept ${skipped.feeLocked === 1 ? 'its' : 'their'} current fees because players have registered and fees can only be lowered.`,
    );
  }
  return lines;
}

export interface SeriesBankingNotice {
  kind: 'needed' | 'ready';
  text: string;
  /** The label of the link to banking, when one belongs under the text. */
  link: string | null;
  /** The label of the "Publish drafts now" button, when it is offered. */
  button: string | null;
}

/** S2b (banking missing) and S2r (banking set up, drafts waiting); null when nothing waits on banking. */
export function seriesBankingNotice(
  series: Pick<SeriesResponse, 'bankingDrafts' | 'editedDrafts' | 'isPayoutConfigured'>,
): SeriesBankingNotice | null {
  const n = series.bankingDrafts;
  if (n <= 0) return null;
  if (!series.isPayoutConfigured) {
    const subject =
      n === 1
        ? '1 session in this series was saved as a draft'
        : `${n} sessions in this series were saved as drafts`;
    return {
      kind: 'needed',
      text: `${subject} because your team's bank account isn't set up. Members can't register for ${n === 1 ? 'it' : 'them'} yet.`,
      link: BANKING_LINK_LABEL,
      button: null,
    };
  }
  const state =
    n === 1
      ? "1 session in this series is still a draft. It'll be published automatically overnight, or you can publish it now."
      : `${n} sessions in this series are still drafts. They'll be published automatically overnight, or you can publish them now.`;
  const edited =
    series.editedDrafts > 0
      ? ` ${plural(series.editedDrafts, 'edited draft')} ${series.editedDrafts === 1 ? 'needs you to publish it yourself.' : 'need you to publish them yourself.'}`
      : '';
  return {
    kind: 'ready',
    text: `Your bank account is set up. ${state}${edited}`,
    link: null,
    button: 'Publish drafts now',
  };
}

// ---------------------------------------------------------------------------------------------
// Series page: the horizon, the empty state and which dates are listed
// ---------------------------------------------------------------------------------------------

export interface NextSeriesDate {
  /** The next date the series will add (`YYYY-MM-DD`). */
  date: string;
  /** The day it comes inside the horizon, so it is added that day (`date` minus the horizon). */
  addedOn: string;
}

/**
 * The first date after today plus the horizon (the window is inclusive), computed with the shared pure
 * recurrence so it follows the pattern exactly; null once the end date has been reached.
 */
export function nextSeriesDate(
  series: PatternFields & Pick<SeriesResponse, 'startsOn' | 'recurUntil'>,
  today: string,
  /** The API's `horizonDays` (`RECURRENCE_HORIZON_DAYS`): the web keeps no copy of it. */
  horizonDays: number,
): NextSeriesDate | null {
  const from = fromEpochDay(epochDay(parseLocalDate(today)) + horizonDays + 1);
  const to = fromEpochDay(epochDay(from) + 400);
  const dates = recurrenceDates(
    {
      frequency: series.frequency,
      dayOfWeek: series.dayOfWeek,
      startsOn: parseLocalDate(series.startsOn),
      monthlyWeek: series.monthlyWeek as 1 | 2 | 3 | 4 | -1 | null,
      recurUntil: series.recurUntil === null ? null : parseLocalDate(series.recurUntil),
    },
    { from, to },
  );
  const date = dates[0];
  if (date === undefined) return null;
  return { date, addedOn: fromEpochDay(epochDay(date) - horizonDays) };
}

export function horizonLine(next: NextSeriesDate, horizonDays: number): string {
  return `Sessions are added ${horizonDays} days ahead. The next one, ${formatDayShort(next.date)}, will be added on ${formatDayShort(next.addedOn)}.`;
}

export function noSessionsYetLine(next: NextSeriesDate): string {
  return `${SERIES_COPY.noSessionsYet} The first one, ${formatDay(next.date)}, will be added on ${formatDay(next.addedOn)}.`;
}

/**
 * The dates the series page lists: published and draft dates that are upcoming or started. Cancelled,
 * completed, ended and expired-draft dates go to the "Past and cancelled sessions in this series" disclosure.
 */
export function splitSeriesInstances<T extends Pick<SeriesInstanceResponse, 'status' | 'phase'>>(
  instances: readonly T[],
): { listed: T[]; past: T[] } {
  const listed: T[] = [];
  const past: T[] = [];
  for (const instance of instances) {
    const live =
      (instance.status === 'PUBLISHED' || instance.status === 'DRAFT') &&
      (instance.phase === 'upcoming' ||
        (instance.status === 'PUBLISHED' && instance.phase === 'started'));
    (live ? listed : past).push(instance);
  }
  return { listed, past };
}

// ---------------------------------------------------------------------------------------------
// Waiting state (bounded refresh)
// ---------------------------------------------------------------------------------------------

/** Absolute delays, from mount, of the three bounded refreshes (UI/UX "Waiting state"). */
export const REFRESH_DELAYS_MS: readonly number[] = [2000, 5000, 10000];

export type PendingView =
  { kind: 'waiting'; text: string } | { kind: 'slow'; text: string } | { kind: 'done'; text: '' };

export function pendingView(input: { pending: boolean; refreshesDone: number }): PendingView {
  if (!input.pending) return { kind: 'done', text: '' };
  if (input.refreshesDone < REFRESH_DELAYS_MS.length) {
    return {
      kind: 'waiting',
      text: "We're adding the sessions in this series. Refresh in a moment.",
    };
  }
  return {
    kind: 'slow',
    text: 'This is taking longer than usual. Your series is saved and its sessions will appear here. Refresh in a minute.',
  };
}

export function sessionsAddedLine(count: number): string {
  return `${plural(count, 'session')} added.`;
}

// ---------------------------------------------------------------------------------------------
// End series (T-6): the impact is computed in the browser from the instances the page loaded
// ---------------------------------------------------------------------------------------------

export const END_SERIES_COPY = {
  trigger: 'End series',
  prompt: 'End this series? No sessions will be added after the last date.',
  lastDate: 'Last date',
  confirmLabel: 'End series',
  pendingLabel: 'Ending…',
  dismissLabel: 'Keep series',
} as const;

export interface EndSeriesImpact {
  /** Unedited drafts after the date: deleted. */
  deleted: number;
  /** Edited drafts after the date: kept. */
  keptEdited: number;
  /** Published sessions after the date: kept, or cancelled when the box is ticked. */
  published: number;
  /** Players registered across those published sessions. */
  players: number;
  lines: string[];
  /** The label of the cancel checkbox, or null when no published session follows the date. */
  checkboxLabel: string | null;
}

/**
 * The "Last date" an End series confirm starts with: today, or the first session's date while the series has not
 * started yet (the API refuses a last date before the first date, so today would open a confirm that cannot succeed).
 */
export function defaultEndDate(today: string, startsOn: string): string {
  return today < startsOn ? startsOn : today;
}

export function endSeriesImpact(
  instances: readonly Pick<
    SeriesInstanceResponse,
    'date' | 'status' | 'isInstanceOverridden' | 'activeRegistrationCount'
  >[],
  lastDate: string,
  alsoCancel: boolean,
): EndSeriesImpact {
  if (parseYmd(lastDate) === null) {
    return { deleted: 0, keptEdited: 0, published: 0, players: 0, lines: [], checkboxLabel: null };
  }
  const after = instances.filter((instance) => instance.date > lastDate);
  const drafts = after.filter((instance) => instance.status === 'DRAFT');
  const published = after.filter((instance) => instance.status === 'PUBLISHED');
  const deleted = drafts.filter((instance) => !instance.isInstanceOverridden).length;
  const keptEdited = drafts.length - deleted;
  const players = published.reduce((sum, instance) => sum + instance.activeRegistrationCount, 0);
  const p = published.length;
  const lines: string[] = [];
  if (deleted > 0) {
    lines.push(`${plural(deleted, 'unedited draft session')} after this date will be deleted.`);
  }
  const editedText = plural(keptEdited, 'edited draft');
  const publishedText = plural(p, 'published session');
  if (alsoCancel && p > 0) {
    lines.push(
      keptEdited > 0
        ? `${editedText} after this date will be kept, and the ${publishedText} will be cancelled.`
        : `The ${publishedText} will be cancelled.`,
    );
    if (players > 0) {
      lines.push(`${registeredAre(players)} for them. We won't email them, so let them know.`);
    }
  } else if (keptEdited > 0 && p > 0) {
    lines.push(`${editedText} and ${publishedText} after this date will be kept.`);
  } else if (keptEdited > 0) {
    lines.push(`${editedText} after this date will be kept.`);
  } else if (p > 0) {
    lines.push(`${publishedText} after this date will be kept.`);
  }
  if (lines.length === 0) lines.push('No sessions come after this date.');
  return {
    deleted,
    keptEdited,
    published: p,
    players,
    lines,
    checkboxLabel: p > 0 ? `Also cancel the ${publishedText} after this date` : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Notices: `?notice=<code>` plus a few display-only integers, text from the copy deck
// ---------------------------------------------------------------------------------------------

export const NOTICE_KINDS = {
  draft_saved: 'notice',
  published: 'notice',
  publish_refused_banking: 'error',
  changes_saved: 'notice',
  instance_saved_first: 'notice',
  nothing_changed: 'notice',
  cancelled_draft: 'notice',
  cancelled: 'notice',
  series_created: 'notice',
  series_saved: 'notice',
  series_nothing_changed: 'notice',
  series_ended: 'notice',
  series_banking_refused: 'error',
  publishing_drafts: 'notice',
  session_stale: 'error',
  series_stale: 'error',
  session_started: 'error',
  session_not_editable: 'error',
  // Added by 5C: a publish refused as incomplete after the create or save committed; an edit of an ended series.
  publish_incomplete: 'error',
  series_already_ended: 'error',
} as const satisfies Record<string, 'notice' | 'error'>;

export type NoticeCode = keyof typeof NOTICE_KINDS;

/** Display-only counts a redirect may carry; each is an integer 0..999 and nothing else is trusted. */
export const NOTICE_COUNT_KEYS = [
  'count',
  'edited',
  'started',
  'closed',
  'deadlinePassed',
  'feeLocked',
  'registered',
  'cancelled',
  'promoted',
  'material',
] as const;

export type NoticeCountKey = (typeof NOTICE_COUNT_KEYS)[number];

export interface ParsedNotice {
  code: NoticeCode;
  counts: Partial<Record<NoticeCountKey, number>>;
  /** A `YYYY-MM-DD` the banner names (the first edited date, or the series' last date). */
  date: string | null;
}

type Params = Readonly<Record<string, string | string[] | undefined>>;

const isNoticeCode = (value: string): value is NoticeCode =>
  Object.prototype.hasOwnProperty.call(NOTICE_KINDS, value);

/** Reads a notice from the query: a code from the closed list, small integers, and a valid date. */
export function parseNotice(params: Params): ParsedNotice | null {
  const code = params.notice;
  if (typeof code !== 'string' || !isNoticeCode(code)) return null;
  const counts: Partial<Record<NoticeCountKey, number>> = {};
  for (const key of NOTICE_COUNT_KEYS) {
    const raw = params[key];
    if (typeof raw === 'string' && /^\d{1,3}$/.test(raw)) counts[key] = Number(raw);
  }
  const rawDate = params.date;
  const date = typeof rawDate === 'string' && parseYmd(rawDate) !== null ? rawDate : null;
  return { code, counts, date };
}

/** The query string an action redirects with (inverse of `parseNotice`; invalid counts are dropped). */
export function noticeQuery(
  code: NoticeCode,
  counts: Partial<Record<NoticeCountKey, number>> = {},
  date?: string,
): string {
  const query = new URLSearchParams({ notice: code });
  for (const key of NOTICE_COUNT_KEYS) {
    const value = counts[key];
    if (value !== undefined && Number.isInteger(value) && value >= 0 && value <= 999) {
      query.set(key, String(value));
    }
  }
  if (date !== undefined && parseYmd(date) !== null) query.set('date', date);
  return query.toString();
}

export interface NoticeBanner {
  kind: 'notice' | 'error';
  lines: string[];
  links: ErrorLink[];
}

export const BANKING_REFUSAL_MESSAGE =
  "Add your team's bank account details before publishing a paid session.";

/** The banner text for a parsed notice. The first line is the headline; links carry the banking hand-off. */
export function noticeBanner(notice: ParsedNotice, context: { bankingHref: string }): NoticeBanner {
  const { counts } = notice;
  const n = (key: NoticeCountKey): number => counts[key] ?? 0;
  const kind = NOTICE_KINDS[notice.code];
  const bankingLink: ErrorLink[] = [{ label: BANKING_LINK_LABEL, href: context.bankingHref }];
  const result = (lines: string[], links: ErrorLink[] = []): NoticeBanner => ({
    kind,
    lines,
    links,
  });
  switch (notice.code) {
    case 'draft_saved':
      return result(['Draft saved.']);
    case 'published':
      return result(['Session published. Members can now register.']);
    case 'publish_refused_banking':
      return result([BANKING_REFUSAL_MESSAGE, 'Your changes are saved as a draft.'], bankingLink);
    case 'changes_saved': {
      const lines = ['Changes saved.'];
      if (n('material') > 0 && counts.registered !== undefined) {
        lines.push(
          counts.registered === 0
            ? 'No one had registered.'
            : `${registeredWere(counts.registered)}. Let them know about the change.`,
        );
      }
      if (n('promoted') > 0)
        lines.push(`${plural(n('promoted'), 'player')} moved off the waitlist.`);
      return result(lines);
    }
    case 'instance_saved_first':
      return result([
        notice.date === null
          ? 'Changes saved. This date is now marked Edited.'
          : `Changes saved for ${formatDayShort(notice.date)}. This date is now marked Edited.`,
      ]);
    case 'nothing_changed':
    case 'series_nothing_changed':
      return result(['Nothing to change.']);
    case 'cancelled_draft':
      return result(['Draft cancelled.']);
    case 'cancelled': {
      const lines = ['Session cancelled.'];
      if (counts.registered !== undefined) {
        lines.push(
          counts.registered === 0
            ? 'No one had registered.'
            : `${registeredWere(counts.registered)}. Let them know it's cancelled.`,
        );
      }
      return result(lines);
    }
    case 'series_created':
      return result(['Series created.']);
    case 'series_saved':
      return result(
        seriesSavedLines({
          updated: n('count'),
          unchanged: 0,
          skipped: {
            edited: n('edited'),
            started: n('started'),
            closed: n('closed'),
            deadlinePassed: n('deadlinePassed'),
            feeLocked: n('feeLocked'),
          },
        }),
      );
    case 'series_ended': {
      const lines = [
        notice.date === null
          ? 'Series ended. No new sessions will be added.'
          : `Series ended. No new sessions will be added after ${formatDateLong(notice.date)}.`,
      ];
      if (n('cancelled') > 0) {
        lines.push(
          `${plural(n('cancelled'), 'session')} after that date ${n('cancelled') === 1 ? 'was' : 'were'} cancelled.`,
        );
      }
      if (n('registered') > 0) {
        lines.push(`${registeredWere(n('registered'))} for them. Let them know.`);
      }
      return result(lines);
    }
    case 'series_banking_refused':
      return result([BANKING_REFUSAL_MESSAGE, 'Nothing was saved.'], bankingLink);
    case 'publishing_drafts':
      return result(["We're publishing the drafts in this series. Refresh in a moment."]);
    case 'session_stale':
      return result([
        'This session changed since you opened it. Review the latest version and save again. Your unsaved changes were not kept.',
      ]);
    case 'series_stale':
      return result([
        'This series changed since you opened it. Review the latest version and save again. Your unsaved changes were not kept.',
      ]);
    case 'session_started':
      return result(["This session has started, so it can't be changed or cancelled."]);
    case 'session_not_editable':
      return result(["This session can't be changed any more."]);
    case 'publish_incomplete':
      return result([
        'Your other changes are saved as a draft.',
        "It couldn't be published yet. Check the pricing and courts, then publish again.",
      ]);
    case 'series_already_ended':
      return result(["This series has ended, so it can't be changed."]);
  }
}

/**
 * The in-place page error of a Sessions form (a Server Action answered `error.code`): the lines and, for a
 * banking refusal, the link that hands the admin to banking and back to this page. Never a raw code.
 */
export function sessionErrorBanner(
  code: string,
  context: { bankingHref: string },
): NoticeBanner | null {
  const error = (lines: string[], links: ErrorLink[] = []): NoticeBanner => ({
    kind: 'error',
    lines,
    links,
  });
  switch (code) {
    case 'forbidden':
      return error([NO_ACCESS_HEADING]);
    case 'not_found':
      return error(["We couldn't find that session. It may have been removed."]);
    case 'save_failed':
      return error([SAVE_FAILED_MESSAGE]);
    case 'unconfirmed':
      return error([UNCONFIRMED_MESSAGE]);
    case 'session_fee_locked':
      return error([FEES_LOCKED_MESSAGE]);
    case 'publish_incomplete':
      return error(['Your other changes are saved as a draft.']);
    case 'payout_not_configured':
      return error(
        [BANKING_REFUSAL_MESSAGE, 'Nothing was saved.'],
        [{ label: BANKING_LINK_LABEL, href: context.bankingHref }],
      );
    default:
      return error([OUTAGE_MESSAGE]);
  }
}
