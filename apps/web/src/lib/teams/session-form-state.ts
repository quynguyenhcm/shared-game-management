import {
  MAX_COURTS,
  MAX_PLAYERS_LIMIT,
  SESSION_ADDRESS_MAX_LENGTH,
  SESSION_FIELD_MESSAGES,
  SESSION_LOCATION_MAX_LENGTH,
  COURT_IDENTIFIER_MAX_LENGTH,
  defaultMonthlyWeek,
  formatNZD,
  instantToLocal,
  isNegative,
  min as minMoney,
  parseLocalDate,
  parseMoney,
  suggestedRate,
  toMoneyString,
  type DstOptionsEntry,
  type Money,
  type PricingType,
  type RecurrenceFrequency,
  type SeriesResponse,
  type SessionResponse,
} from '@sgm/shared';
import type { FieldErrors } from '../auth/validation.ts';
import type { FormState } from '../auth/form-state.ts';
import {
  FEE_OVER_LIMIT_MESSAGE,
  feeSummary,
  formatClock,
  formatDateLong,
  parseYmd,
  plural,
  weekdayIndex,
  weekdayName,
} from './sessions-view.ts';

/**
 * The pure state of the Sessions forms (UI/UX D1 and D2, "Interactions"): one reducer for the whole form,
 * held in controlled state because React 19 resets uncontrolled fields after a form action. Kept free of
 * React so the court table, the rate follow and pin rule, the pricing reveal, the deadline and DST choices
 * and the series pattern are unit-tested once. The API stays the authority: this state only avoids
 * offering what it would refuse, and validation reuses the shared copy.
 */

const M = SESSION_FIELD_MESSAGES;

/** A polite live-region announcement. `seq` changes on every announcement so a repeat is read again. */
export interface Live {
  text: string;
  seq: number;
}

/** A one-shot request to focus the element with this id. `seq` makes a repeat request fire again. */
export interface Focus {
  id: string;
  seq: number;
}

const live = (previous: Live | null, text: string): Live => ({
  text,
  seq: (previous?.seq ?? 0) + 1,
});
const focusOn = (previous: Focus | null, id: string): Focus => ({
  id,
  seq: (previous?.seq ?? 0) + 1,
});

// ---------------------------------------------------------------------------------------------
// Court table (D1)
// ---------------------------------------------------------------------------------------------

export const COURT_COUNT_ID = 'court-count';
export const COURT_APPLY_ID = 'court-apply';
export const RATE_FIELD_ID = 'field-customPlayerRate';
export const DEADLINE_TIME_ID = 'field-deadlineTime';

export type CourtField = 'name' | 'start' | 'end';

/** The DOM id of a court input; the error summary links to it (`court-<key>-<field>` under `field-`). */
export function courtFieldId(key: string, field: CourtField): string {
  return `field-court-${key}-${field}`;
}

export interface CourtRow {
  /** Stable client key, so removing a row keeps every other row's state. */
  key: string;
  identifier: string;
  startTime: string;
  endTime: string;
  /** DST overlap choice, posted as `courts.{i}.startDisambiguation` (transient, never stored). */
  startDisambiguation?: 'earlier';
  endDisambiguation?: 'earlier';
}

export interface CourtTableState {
  /** The "Number of courts" box; applied on blur or Enter, never per keystroke. */
  countText: string;
  defaultStart: string;
  defaultEnd: string;
  rows: CourtRow[];
  nextKey: number;
  /** A default moved since the last "Apply to all courts". */
  defaultsChanged: boolean;
  live: Live | null;
  focus: Focus | null;
}

export type CourtAction =
  | { type: 'set_count_text'; value: string }
  | { type: 'commit_count' }
  | { type: 'set_default'; which: 'start' | 'end'; value: string }
  | { type: 'apply_all' }
  | { type: 'add' }
  | { type: 'remove'; key: string }
  | { type: 'set_row'; key: string; field: 'identifier' | 'startTime' | 'endTime'; value: string };

interface CourtSeed {
  identifier: string;
  startTime: string;
  endTime: string;
}

const hhmm = (time: string): string => time.slice(0, 5);

function modeOf(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = values[0] ?? '';
  for (const [value, count] of counts) if (count > (counts.get(best) ?? 0)) best = value;
  return best;
}

/** One blank "Court 1" for a new session, or the saved courts with the most common times as the defaults. */
export function initialCourtTable(courts: readonly CourtSeed[] = []): CourtTableState {
  const rows: CourtRow[] =
    courts.length === 0
      ? [{ key: 'c1', identifier: 'Court 1', startTime: '', endTime: '' }]
      : courts.map((court, index) => ({
          key: `c${index + 1}`,
          identifier: court.identifier,
          startTime: hhmm(court.startTime),
          endTime: hhmm(court.endTime),
        }));
  return {
    countText: String(rows.length),
    defaultStart: modeOf(rows.map((row) => row.startTime)),
    defaultEnd: modeOf(rows.map((row) => row.endTime)),
    rows,
    nextKey: rows.length + 1,
    defaultsChanged: false,
    live: null,
    focus: null,
  };
}

function lowestUnusedName(rows: readonly CourtRow[], reserved: readonly string[] = []): string {
  const used = new Set([...rows.map((row) => row.identifier), ...reserved]);
  for (let n = 1; ; n += 1) if (!used.has(`Court ${n}`)) return `Court ${n}`;
}

function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function isNotDefault(state: CourtTableState, row: CourtRow): boolean {
  return row.startTime !== state.defaultStart || row.endTime !== state.defaultEnd;
}

/** `9 courts. 8 use the default times.` / `9 courts. All use the default times.` */
export function courtSummary(state: CourtTableState): string {
  const total = state.rows.length;
  const usingDefault = state.rows.filter((row) => !isNotDefault(state, row)).length;
  return `${plural(total, 'court')}. ${
    usingDefault === total
      ? 'All use the default times.'
      : `${usingDefault} ${usingDefault === 1 ? 'uses' : 'use'} the default times.`
  }`;
}

export function courtTableReducer(state: CourtTableState, action: CourtAction): CourtTableState {
  switch (action.type) {
    case 'set_count_text':
      return { ...state, countText: action.value };
    case 'commit_count': {
      const text = state.countText.trim();
      const target = /^\d+$/.test(text) ? Number(text) : 0;
      if (target < 1 || target > MAX_COURTS)
        return { ...state, countText: String(state.rows.length) };
      const current = state.rows.length;
      if (target === current) return { ...state, countText: String(current) };
      if (target > current) {
        const rows = [...state.rows];
        let nextKey = state.nextKey;
        while (rows.length < target) {
          rows.push({
            key: `c${nextKey}`,
            identifier: lowestUnusedName(rows),
            startTime: state.defaultStart,
            endTime: state.defaultEnd,
          });
          nextKey += 1;
        }
        return {
          ...state,
          rows,
          nextKey,
          countText: String(target),
          live: live(state.live, `Court table has ${plural(target, 'court')}.`),
        };
      }
      const removed = state.rows
        .slice(target)
        .map((row) => row.identifier)
        .reverse();
      return {
        ...state,
        rows: state.rows.slice(0, target),
        countText: String(target),
        live: live(state.live, `Removed ${nameList(removed)}. ${plural(target, 'court')}.`),
      };
    }
    case 'set_default':
      return {
        ...state,
        defaultStart: action.which === 'start' ? action.value : state.defaultStart,
        defaultEnd: action.which === 'end' ? action.value : state.defaultEnd,
        defaultsChanged:
          state.defaultsChanged ||
          (state.rows.length > 0 &&
            (action.which === 'start' ? state.defaultStart : state.defaultEnd) !== action.value),
      };
    case 'apply_all':
      return {
        ...state,
        rows: state.rows.map((row) => ({
          key: row.key,
          identifier: row.identifier,
          startTime: state.defaultStart,
          endTime: state.defaultEnd,
        })),
        defaultsChanged: false,
        live: live(state.live, `Times applied to ${plural(state.rows.length, 'court')}.`),
      };
    case 'add': {
      if (state.rows.length >= MAX_COURTS) return state;
      const row: CourtRow = {
        key: `c${state.nextKey}`,
        identifier: lowestUnusedName(state.rows),
        startTime: state.defaultStart,
        endTime: state.defaultEnd,
      };
      return {
        ...state,
        rows: [...state.rows, row],
        nextKey: state.nextKey + 1,
        countText: String(state.rows.length + 1),
        live: live(state.live, `${row.identifier} added.`),
        focus: focusOn(state.focus, courtFieldId(row.key, 'name')),
      };
    }
    case 'remove': {
      if (state.rows.length <= 1) return state;
      const index = state.rows.findIndex((row) => row.key === action.key);
      if (index === -1) return state;
      const removed = state.rows[index] as CourtRow;
      const rows = state.rows.filter((row) => row.key !== action.key);
      const neighbour = state.rows[index > 0 ? index - 1 : 1] as CourtRow;
      return {
        ...state,
        rows,
        countText: String(rows.length),
        live: live(state.live, `${removed.identifier} removed. ${plural(rows.length, 'court')}.`),
        focus: focusOn(state.focus, courtFieldId(neighbour.key, 'name')),
      };
    }
    case 'set_row':
      return {
        ...state,
        rows: state.rows.map((row) => {
          if (row.key !== action.key) return row;
          const next: CourtRow = { ...row, [action.field]: action.value };
          if (action.field === 'startTime') delete next.startDisambiguation;
          if (action.field === 'endTime') delete next.endDisambiguation;
          return next;
        }),
      };
  }
}

/**
 * "Number of courts" commits on Enter and never submits the form: the key is claimed with
 * `preventDefault`. Returns what the caller should do (`commit`), or null for any other key.
 */
export function courtCountKeyAction(event: {
  key: string;
  preventDefault: () => void;
}): 'commit' | null {
  if (event.key !== 'Enter') return null;
  event.preventDefault();
  return 'commit';
}

const MINUTES = (time: string): number => {
  const [h = '0', m = '0'] = time.split(':');
  return Number(h) * 60 + Number(m);
};
const TIME_SHAPE = /^\d{2}:\d{2}$/;

/** Per-court messages (copy deck "Court errors"), keyed `court-<key>-name|start|end`. */
export function validateCourts(rows: readonly CourtRow[]): FieldErrors {
  const errors: FieldErrors = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.identifier.trim();
    if (name === '') errors[`court-${row.key}-name`] = [M.courtNameRequired];
    else if (name.length > COURT_IDENTIFIER_MAX_LENGTH) {
      errors[`court-${row.key}-name`] = [M.courtNameTooLong];
    } else if (seen.has(name)) errors[`court-${row.key}-name`] = [M.courtNamesDuplicate];
    seen.add(name);
    const hasStart = TIME_SHAPE.test(row.startTime);
    const hasEnd = TIME_SHAPE.test(row.endTime);
    if (!hasStart) errors[`court-${row.key}-start`] = ['Enter a start time.'];
    if (!hasEnd) errors[`court-${row.key}-end`] = ['Enter an end time.'];
    else if (hasStart && MINUTES(row.endTime) <= MINUTES(row.startTime)) {
      errors[`court-${row.key}-end`] = [M.courtEndBeforeStart];
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------
// Costing, pricing and the rate follow/pin rule (D2 option A, T-9)
// ---------------------------------------------------------------------------------------------

export type FeeField =
  'feeMale' | 'feeFemale' | 'feeOther' | 'feeBeginner' | 'feeIntermediate' | 'feeAdvanced';

const SEX_FEES: readonly FeeField[] = ['feeMale', 'feeFemale', 'feeOther'];
const SKILL_FEES: readonly FeeField[] = ['feeBeginner', 'feeIntermediate', 'feeAdvanced'];

export function feeFieldsOf(model: PricingType): readonly FeeField[] {
  return model === 'BY_SEX' ? SEX_FEES : model === 'BY_SKILL_LEVEL' ? SKILL_FEES : [];
}

export interface PricingState {
  model: PricingType;
  /** `follow`: the rate is the suggestion and is sent as null. `pinned`: the typed rate is sent. */
  rateMode: 'follow' | 'pinned';
  rate: string;
  feeMale: string;
  feeFemale: string;
  feeOther: string;
  /** The admin typed an "Other" fee; until then it tracks the lower of male and female. */
  feeOtherTouched: boolean;
  feeBeginner: string;
  feeIntermediate: string;
  feeAdvanced: string;
  /** `feesLocked === 'raise_only_blocked'`: the model cannot change and no fee may go up (T-7). */
  locked: boolean;
  /** The saved fees of a locked session, to compare against. */
  initial: Partial<Record<FeeField | 'rate', string>> | null;
}

type MoneyParse = { kind: 'blank' } | { kind: 'ok'; value: Money } | { kind: 'invalid' };

function parseAmount(text: string): MoneyParse {
  const trimmed = text.trim();
  if (trimmed === '') return { kind: 'blank' };
  try {
    return { kind: 'ok', value: parseMoney(trimmed) };
  } catch {
    return { kind: 'invalid' };
  }
}

function moneyOrNull(text: string): Money | null {
  const parsed = parseAmount(text);
  return parsed.kind === 'ok' ? parsed.value : null;
}

/** A whole number of 1 or more, or null. */
function wholeNumber(text: string, minimum: number): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= minimum ? value : null;
}

/** The suggested rate from the shared formula; null until max players is valid and the costs parse. */
export function suggestionOf(state: Pick<SessionFormState, 'places' | 'costing'>): Money | null {
  const maxPlayers = wholeNumber(state.places.maxPlayers, 1);
  if (maxPlayers === null) return null;
  const hire = parseAmount(state.costing.courtCost);
  const extras = parseAmount(state.costing.extraExpenses);
  if (hire.kind === 'invalid' || extras.kind === 'invalid') return null;
  const zero = parseMoney('0');
  try {
    return suggestedRate(
      hire.kind === 'ok' ? hire.value : zero,
      extras.kind === 'ok' ? extras.value : zero,
      maxPlayers,
    );
  } catch {
    return null;
  }
}

/** The rate a FLAT session would be saved with: the pinned rate, or else the suggestion. */
export function finalRate(state: SessionFormState): Money | null {
  if (state.pricing.rateMode === 'pinned') {
    return moneyOrNull(state.pricing.rate) ?? suggestionOf(state);
  }
  return suggestionOf(state);
}

/**
 * The fee sentence of the publish and create confirms: `$12.00 each`, the by-sex or by-skill fees, or null for
 * a free session (nothing is charged, so no confirm is needed to publish it).
 */
export function formFeeSummary(state: SessionFormState): string | null {
  const { pricing } = state;
  const text = (value: string): string | null => (moneyOrNull(value) === null ? null : value);
  const rate = finalRate(state);
  return feeSummary({
    pricingStructure: pricing.model,
    feeFlat: rate === null ? null : toMoneyString(rate),
    feeMale: text(pricing.feeMale),
    feeFemale: text(pricing.feeFemale),
    feeOther: text(feeOtherText(state)),
    feeBeginner: text(pricing.feeBeginner),
    feeIntermediate: text(pricing.feeIntermediate),
    feeAdvanced: text(pricing.feeAdvanced),
  });
}

/** What the "Rate per player" box shows: the suggestion while following, the typed text once pinned. */
export function rateFieldText(state: SessionFormState): string {
  if (state.pricing.rateMode === 'pinned') return state.pricing.rate;
  const suggestion = suggestionOf(state);
  return suggestion === null ? '' : toMoneyString(suggestion);
}

/** What the "Other" fee box shows: the typed value, or the lower of male and female until typed. */
export function feeOtherText(state: SessionFormState): string {
  if (state.pricing.feeOtherTouched) return state.pricing.feeOther;
  const male = moneyOrNull(state.pricing.feeMale);
  const female = moneyOrNull(state.pricing.feeFemale);
  return male === null || female === null ? '' : toMoneyString(minMoney(male, female));
}

/** Fees at or above their saved values only matter on a locked session; each raise gets the shared message. */
export function lockedFeeErrors(state: SessionFormState): FieldErrors {
  const { pricing } = state;
  if (!pricing.locked || pricing.initial === null) return {};
  const errors: FieldErrors = {};
  const raised = (now: Money | null, was: string | undefined): boolean => {
    const before = was === undefined ? null : moneyOrNull(was);
    return now !== null && before !== null && now > before;
  };
  if (pricing.model === 'FLAT') {
    if (raised(finalRate(state), pricing.initial.rate))
      errors.customPlayerRate = [FEE_OVER_LIMIT_MESSAGE];
    return errors;
  }
  for (const field of feeFieldsOf(pricing.model)) {
    const text = field === 'feeOther' ? feeOtherText(state) : pricing[field];
    if (raised(moneyOrNull(text), pricing.initial[field])) errors[field] = [FEE_OVER_LIMIT_MESSAGE];
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------
// Cancellation deadline (T-8)
// ---------------------------------------------------------------------------------------------

export interface DeadlineState {
  mode: 'default' | 'specific';
  date: string;
  time: string;
  /** DST overlap choice for the deadline time (both options are storable). */
  disambiguation: 'earlier' | 'later' | null;
}

/** `null` means "use the default" (T-8); otherwise the specific date and time. */
export function deadlineRequest(
  deadline: DeadlineState,
): { date: string; time: string; disambiguation?: 'earlier' | 'later' } | null {
  if (deadline.mode === 'default') return null;
  return {
    date: deadline.date,
    time: deadline.time,
    ...(deadline.disambiguation === null ? {} : { disambiguation: deadline.disambiguation }),
  };
}

// ---------------------------------------------------------------------------------------------
// Series pattern (P-3)
// ---------------------------------------------------------------------------------------------

export interface PatternState {
  frequency: RecurrenceFrequency | '';
  startsOn: string;
  recurUntil: string;
  /** The "4th or last" choice, or the saved week of an existing series. */
  monthlyWeek: number | null;
}

export interface PatternView {
  dayOfWeek: number | null;
  /** The week sent for a monthly series (1..4 or -1), derived from the first date. */
  monthlyWeek: number | null;
  /** True only when the first date is both the 4th and the last of its weekday. */
  picker: boolean;
  /** Explains a 5th weekday being stored as "last". */
  fifthNote: string | null;
  line: string | null;
}

const ORDINAL_WORD: Readonly<Record<number, string>> = {
  1: 'first',
  2: 'second',
  3: 'third',
  4: 'fourth',
  [-1]: 'last',
};

/** The weekday, the monthly ordinal and the plain-language line, all derived from the first date. */
export function derivePattern(pattern: PatternState): PatternView {
  const dayOfWeek = weekdayIndex(pattern.startsOn);
  const parts = parseYmd(pattern.startsOn);
  const none: PatternView = {
    dayOfWeek,
    monthlyWeek: null,
    picker: false,
    fifthNote: null,
    line: null,
  };
  if (dayOfWeek === null || parts === null) return none;
  const day = weekdayName(dayOfWeek);
  let monthlyWeek: number | null = null;
  let picker = false;
  let fifthNote: string | null = null;
  if (pattern.frequency === 'MONTHLY') {
    const derived = defaultMonthlyWeek(parseLocalDate(pattern.startsOn));
    picker = derived.alsoLast;
    monthlyWeek = picker ? (pattern.monthlyWeek === -1 ? -1 : 4) : derived.week;
    if (Math.ceil(parts.d / 7) === 5) {
      fifthNote = `${formatDateLong(pattern.startsOn)} is the 5th ${day}, so it repeats on the last ${day} of each month.`;
    }
  }
  const from = formatDateLong(pattern.startsOn);
  const until =
    parseYmd(pattern.recurUntil) === null ? '' : ` until ${formatDateLong(pattern.recurUntil)}`;
  let line: string | null = null;
  if (pattern.frequency === 'WEEKLY') line = `Every ${day} from ${from}${until}`;
  else if (pattern.frequency === 'FORTNIGHTLY') line = `Every second ${day} from ${from}${until}`;
  else if (pattern.frequency === 'MONTHLY') {
    line = `On the ${ORDINAL_WORD[monthlyWeek ?? 1] ?? 'first'} ${day} of each month from ${from}${until}`;
  }
  return { dayOfWeek, monthlyWeek, picker, fifthNote, line };
}

// ---------------------------------------------------------------------------------------------
// The whole form
// ---------------------------------------------------------------------------------------------

export interface SessionFormState {
  details: { location: string; address: string; date: string };
  courts: CourtTableState;
  places: { maxPlayers: string; reservedSeats: string };
  costing: { courtCost: string; extraExpenses: string };
  pricing: PricingState;
  deadline: DeadlineState;
  pattern: PatternState;
  /** Court and deadline times the last save refused (a DST gap or overlap), with the choices offered. */
  dst: DstOptionsEntry[];
  /** The one polite live region of the form. */
  live: Live;
  /** The one-shot focus request (after add, remove, a DST choice or "Use suggested rate"). */
  focus: Focus | null;
}

/** What the sessions Server Actions return in place: the shared form state plus any DST choices. */
export type SessionActionState = FormState & { dstOptions?: DstOptionsEntry[] };

export type SessionFormAction =
  | { type: 'court'; action: CourtAction }
  | { type: 'set_details'; field: 'location' | 'address' | 'date'; value: string }
  | { type: 'set_places'; field: 'maxPlayers' | 'reservedSeats'; value: string }
  | { type: 'set_costing'; field: 'courtCost' | 'extraExpenses'; value: string }
  | { type: 'set_model'; model: PricingType }
  | { type: 'type_rate'; value: string }
  | { type: 'use_suggested_rate' }
  | { type: 'set_fee'; field: FeeField; value: string }
  | { type: 'fill_all' }
  | { type: 'set_deadline_mode'; mode: 'default' | 'specific' }
  | { type: 'set_deadline_date'; value: string }
  | { type: 'set_deadline_time'; value: string }
  | { type: 'set_frequency'; value: string }
  | { type: 'set_starts_on'; value: string }
  | { type: 'set_recur_until'; value: string }
  | { type: 'set_monthly_week'; value: number }
  | { type: 'dst_errors'; entries: DstOptionsEntry[] }
  | { type: 'dst_choose'; field: string; choice: DstOptionsEntry['options'][number]['choice'] };

type FeeSource = Pick<SessionResponse, FeeField | 'pricingStructure' | 'customPlayerRate'> & {
  feeFlat: string | null;
  calculatedRatePerPlayer: string | null;
};

function pricingFrom(source: FeeSource, locked: boolean): PricingState {
  const fee = (value: string | null): string => value ?? '';
  const male = moneyOrNull(fee(source.feeMale));
  const female = moneyOrNull(fee(source.feeFemale));
  const other = moneyOrNull(fee(source.feeOther));
  const tracking = male !== null && female !== null ? minMoney(male, female) : null;
  const flat = source.feeFlat ?? source.customPlayerRate ?? source.calculatedRatePerPlayer;
  const initial: PricingState['initial'] = locked
    ? {
        rate: flat ?? undefined,
        feeMale: fee(source.feeMale),
        feeFemale: fee(source.feeFemale),
        feeOther: fee(source.feeOther),
        feeBeginner: fee(source.feeBeginner),
        feeIntermediate: fee(source.feeIntermediate),
        feeAdvanced: fee(source.feeAdvanced),
      }
    : null;
  return {
    model: source.pricingStructure,
    rateMode: source.customPlayerRate === null ? 'follow' : 'pinned',
    rate: fee(source.customPlayerRate),
    feeMale: fee(source.feeMale),
    feeFemale: fee(source.feeFemale),
    feeOther: fee(source.feeOther),
    feeOtherTouched: other !== null && (tracking === null || other !== tracking),
    feeBeginner: fee(source.feeBeginner),
    feeIntermediate: fee(source.feeIntermediate),
    feeAdvanced: fee(source.feeAdvanced),
    locked,
    initial,
  };
}

function blankPricing(): PricingState {
  return {
    model: 'FLAT',
    rateMode: 'follow',
    rate: '',
    feeMale: '',
    feeFemale: '',
    feeOther: '',
    feeOtherTouched: false,
    feeBeginner: '',
    feeIntermediate: '',
    feeAdvanced: '',
    locked: false,
    initial: null,
  };
}

const isSeries = (source: SessionResponse | SeriesResponse): source is SeriesResponse =>
  'instances' in source;

/** A blank form, or one seeded from a saved session or series. */
export function initialSessionForm(source?: SessionResponse | SeriesResponse): SessionFormState {
  const base: SessionFormState = {
    details: { location: '', address: '', date: '' },
    courts: initialCourtTable(),
    places: { maxPlayers: '', reservedSeats: '0' },
    costing: { courtCost: '', extraExpenses: '' },
    pricing: blankPricing(),
    deadline: { mode: 'default', date: '', time: '', disambiguation: null },
    pattern: { frequency: '', startsOn: '', recurUntil: '', monthlyWeek: null },
    dst: [],
    live: { text: '', seq: 0 },
    focus: null,
  };
  if (source === undefined) return base;
  const common = {
    ...base,
    details: {
      location: source.location,
      address: source.address,
      date: isSeries(source) ? '' : source.date,
    },
    courts: initialCourtTable(source.courts),
    places: { maxPlayers: String(source.maxPlayers), reservedSeats: String(source.reservedSeats) },
    costing: { courtCost: source.courtCost, extraExpenses: source.extraExpenses },
  };
  if (isSeries(source)) {
    return {
      ...common,
      pricing: pricingFrom(source, false),
      pattern: {
        frequency: source.frequency,
        startsOn: source.startsOn,
        recurUntil: source.recurUntil ?? '',
        monthlyWeek: source.monthlyWeek,
      },
    };
  }
  const specific = !source.deadlineIsDefault && source.cancellationDeadline !== null;
  const local = specific ? instantToLocal(new Date(source.cancellationDeadline as string)) : null;
  return {
    ...common,
    pricing: pricingFrom(source, source.feesLocked === 'raise_only_blocked'),
    deadline: {
      mode: specific ? 'specific' : 'default',
      date: local?.date ?? '',
      time: local?.time ?? '',
      disambiguation: null,
    },
  };
}

/** Where an API `dstOptions.field` path points: a court time (by row index) or the deadline. */
export function parseDstField(
  field: string,
): { kind: 'court'; index: number; which: 'start' | 'end' } | { kind: 'deadline' } | null {
  const court = /^courts\.(\d+)\.(startTime|endTime)$/.exec(field);
  if (court !== null) {
    return {
      kind: 'court',
      index: Number(court[1]),
      which: court[2] === 'startTime' ? 'start' : 'end',
    };
  }
  return field.startsWith('cancellationDeadline') ? { kind: 'deadline' } : null;
}

function withSlice(
  state: SessionFormState,
  courts: CourtTableState,
  extra: Partial<SessionFormState> = {},
): SessionFormState {
  return {
    ...state,
    ...extra,
    courts,
    live: courts.live !== state.courts.live && courts.live !== null ? courts.live : state.live,
    focus: courts.focus !== state.courts.focus ? courts.focus : state.focus,
  };
}

function announce(
  state: SessionFormState,
  text: string,
  focusId?: string,
): Partial<SessionFormState> {
  return {
    live: live(state.live, text),
    focus: focusId === undefined ? state.focus : focusOn(state.focus, focusId),
  };
}

function setFee(pricing: PricingState, field: FeeField, value: string): PricingState {
  const next: PricingState = { ...pricing, [field]: value };
  if (field === 'feeOther') next.feeOtherTouched = value !== '';
  return next;
}

export function sessionFormReducer(
  state: SessionFormState,
  action: SessionFormAction,
): SessionFormState {
  switch (action.type) {
    case 'court': {
      const courts = courtTableReducer(state.courts, action.action);
      return withSlice(state, courts, courtDstEffect(state, action.action));
    }
    case 'set_details':
      return { ...state, details: { ...state.details, [action.field]: action.value } };
    case 'set_places':
      return { ...state, places: { ...state.places, [action.field]: action.value } };
    case 'set_costing':
      return { ...state, costing: { ...state.costing, [action.field]: action.value } };
    case 'set_model': {
      if (state.pricing.locked || action.model === state.pricing.model) return state;
      let pricing: PricingState = { ...state.pricing, model: action.model };
      const rate = finalRate({ ...state, pricing });
      const fields = feeFieldsOf(action.model);
      const empty = fields.every((field) =>
        field === 'feeOther' ? feeOtherText({ ...state, pricing }) === '' : pricing[field] === '',
      );
      if (rate !== null && empty) {
        const text = toMoneyString(rate);
        for (const field of fields) {
          if (field !== 'feeOther') pricing = setFee(pricing, field, text);
        }
      }
      return { ...state, pricing };
    }
    case 'type_rate':
      return {
        ...state,
        pricing:
          action.value.trim() === ''
            ? { ...state.pricing, rateMode: 'follow', rate: '' }
            : { ...state.pricing, rateMode: 'pinned', rate: action.value },
      };
    case 'use_suggested_rate':
      return {
        ...state,
        pricing: { ...state.pricing, rateMode: 'follow', rate: '' },
        ...announce(state, 'Following the suggested rate.', RATE_FIELD_ID),
      };
    case 'set_fee':
      return { ...state, pricing: setFee(state.pricing, action.field, action.value) };
    case 'fill_all': {
      const suggestion = suggestionOf(state);
      const fields = feeFieldsOf(state.pricing.model);
      if (suggestion === null || fields.length === 0) return state;
      let pricing = state.pricing;
      const text = toMoneyString(suggestion);
      for (const field of fields)
        pricing = setFee(pricing, field, field === 'feeOther' ? '' : text);
      return {
        ...state,
        pricing,
        ...announce(state, `All fees set to ${formatNZD(suggestion)}.`),
      };
    }
    case 'set_deadline_mode':
      return { ...state, deadline: { ...state.deadline, mode: action.mode } };
    case 'set_deadline_date':
      return { ...state, deadline: { ...state.deadline, date: action.value } };
    case 'set_deadline_time':
      return {
        ...state,
        deadline: { ...state.deadline, time: action.value, disambiguation: null },
        dst: state.dst.filter((entry) => parseDstField(entry.field)?.kind !== 'deadline'),
      };
    case 'set_frequency':
      return {
        ...state,
        pattern: {
          ...state.pattern,
          frequency: action.value === '' ? '' : (action.value as RecurrenceFrequency),
        },
      };
    case 'set_starts_on':
      return { ...state, pattern: { ...state.pattern, startsOn: action.value, monthlyWeek: null } };
    case 'set_recur_until':
      return { ...state, pattern: { ...state.pattern, recurUntil: action.value } };
    case 'set_monthly_week':
      return { ...state, pattern: { ...state.pattern, monthlyWeek: action.value } };
    case 'dst_errors':
      return { ...state, dst: action.entries };
    case 'dst_choose':
      return chooseDst(state, action.field, action.choice);
  }
}

/** A flagged court time that is edited, or rows that move, drop their stale DST prompts. */
function courtDstEffect(state: SessionFormState, action: CourtAction): Partial<SessionFormState> {
  if (state.dst.length === 0) return {};
  if (action.type === 'remove' || action.type === 'commit_count') return { dst: [] };
  if (action.type === 'set_row' && action.field !== 'identifier') {
    const index = state.courts.rows.findIndex((row) => row.key === action.key);
    const which = action.field === 'startTime' ? 'start' : 'end';
    return {
      dst: state.dst.filter((entry) => {
        const target = parseDstField(entry.field);
        return !(target?.kind === 'court' && target.index === index && target.which === which);
      }),
    };
  }
  return {};
}

function chooseDst(
  state: SessionFormState,
  field: string,
  choice: DstOptionsEntry['options'][number]['choice'],
): SessionFormState {
  const entry = state.dst.find((candidate) => candidate.field === field);
  const option = entry?.options.find((candidate) => candidate.choice === choice);
  const target = parseDstField(field);
  if (entry === undefined || option === undefined || target === null) return state;
  const remaining = state.dst.filter((candidate) => candidate.field !== field);
  const clock = formatClock(option.localTime);
  const ordinal = choice === 'later' ? 'second' : 'first';
  const gap = entry.kind === 'nonexistent';
  if (target.kind === 'court') {
    const row = state.courts.rows[target.index];
    if (row === undefined) return state;
    const time = target.which === 'start' ? 'startTime' : 'endTime';
    const disambiguation = target.which === 'start' ? 'startDisambiguation' : 'endDisambiguation';
    const nextRow: CourtRow = { ...row };
    delete nextRow[disambiguation];
    if (gap) nextRow[time] = option.localTime;
    else nextRow[disambiguation] = 'earlier';
    const courts: CourtTableState = {
      ...state.courts,
      rows: state.courts.rows.map((candidate) => (candidate.key === row.key ? nextRow : candidate)),
    };
    const text = gap
      ? `${row.identifier} ${target.which} set to ${clock}. Save again to apply.`
      : `${row.identifier} ${target.which} will use the ${ordinal} ${clock}.`;
    return {
      ...state,
      courts,
      dst: remaining,
      ...announce(state, text, courtFieldId(row.key, target.which)),
    };
  }
  const deadline: DeadlineState = {
    ...state.deadline,
    mode: 'specific',
    time: gap ? option.localTime : state.deadline.time,
    disambiguation: gap ? null : choice === 'later' ? 'later' : 'earlier',
  };
  const text = gap
    ? `Cancellation deadline set to ${clock}. Save again to apply.`
    : `Cancellation deadline will use the ${ordinal} ${clock}.`;
  return { ...state, deadline, dst: remaining, ...announce(state, text, DEADLINE_TIME_ID) };
}

// ---------------------------------------------------------------------------------------------
// Validation (shared copy; the API stays the authority)
// ---------------------------------------------------------------------------------------------

function moneyErrors(text: string, allowBlank: boolean): string[] | null {
  const parsed = parseAmount(text);
  if (parsed.kind === 'blank') return allowBlank ? null : [M.amountFormat];
  if (parsed.kind === 'invalid') return [M.amountFormat];
  return isNegative(parsed.value) ? [M.amountNegative] : null;
}

/** Client-side checks that mirror the shared zod messages; a failure keeps the typed values. */
export function validateSessionForm(
  state: SessionFormState,
  kind: 'session' | 'series',
  intent?: 'draft' | 'publish' | 'save',
): FieldErrors {
  const errors: FieldErrors = { ...validateCourts(state.courts.rows) };
  const { details, places, costing, pricing } = state;
  const location = details.location.trim();
  if (location === '') errors.location = [M.locationRequired];
  else if (location.length > SESSION_LOCATION_MAX_LENGTH) errors.location = [M.locationTooLong];
  const address = details.address.trim();
  if (address === '') errors.address = [M.addressRequired];
  else if (address.length > SESSION_ADDRESS_MAX_LENGTH) errors.address = [M.addressTooLong];
  if (kind === 'session' && parseYmd(details.date) === null) errors.date = [M.dateInvalid];

  const max = wholeNumber(places.maxPlayers, 1);
  if (max === null || max > MAX_PLAYERS_LIMIT) errors.maxPlayers = [M.maxPlayersInvalid];
  const reserved = wholeNumber(places.reservedSeats, 0);
  if (reserved === null) errors.reservedSeats = [M.reservedSeatsInvalid];
  else if (max !== null && reserved > max) errors.reservedSeats = [M.reservedAboveMax];

  for (const field of ['courtCost', 'extraExpenses'] as const) {
    const problem = moneyErrors(costing[field], true);
    if (problem !== null) errors[field] = problem;
  }
  if (pricing.model === 'FLAT') {
    if (pricing.rateMode === 'pinned') {
      const problem = moneyErrors(pricing.rate, false);
      if (problem !== null) errors.customPlayerRate = problem;
    }
  } else {
    for (const field of feeFieldsOf(pricing.model)) {
      const text = field === 'feeOther' ? feeOtherText(state) : pricing[field];
      // A series needs every fee, and so does publishing a one-off (the API's gate would refuse a missing one).
      const required = (kind === 'series' || intent === 'publish') && field !== 'feeOther';
      const problem = moneyErrors(text, !required);
      if (problem !== null) errors[field] = problem;
    }
  }
  Object.assign(errors, lockedFeeErrors(state));

  if (kind === 'session' && state.deadline.mode === 'specific') {
    if (parseYmd(state.deadline.date) === null) errors.deadlineDate = [M.dateInvalid];
    if (!TIME_SHAPE.test(state.deadline.time)) errors.deadlineTime = [M.timeInvalid];
  }
  if (kind === 'series') {
    const { frequency, startsOn, recurUntil } = state.pattern;
    if (frequency === '') errors.frequency = ['Choose how often it repeats.'];
    if (parseYmd(startsOn) === null) errors.startsOn = [M.dateInvalid];
    if (recurUntil.trim() !== '') {
      if (parseYmd(recurUntil) === null) errors.recurUntil = [M.dateInvalid];
      else if (parseYmd(startsOn) !== null && recurUntil < startsOn) {
        errors.recurUntil = [M.recurUntilBeforeStart];
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------
// Mapping what the API answered back onto the form
// ---------------------------------------------------------------------------------------------

/** The API's `fieldErrors` codes for a DST gap or overlap: the DST choice explains these, so they are not shown as text. */
const DST_CODES: ReadonlySet<string> = new Set(['local_time_nonexistent', 'local_time_ambiguous']);

/**
 * Re-keys the API's field errors (`courts.0.startTime`, `cancellationDeadline.time`, ...) to the keys the form
 * renders (`court-<key>-start`, `deadlineTime`, ...) and drops the DST codes. Other fields keep their name.
 */
export function mapServerFieldErrors(
  errors: FieldErrors | undefined,
  rows: readonly CourtRow[],
): FieldErrors {
  const mapped: FieldErrors = {};
  for (const [field, messages] of Object.entries(errors ?? {})) {
    const shown = messages.filter((message) => !DST_CODES.has(message));
    if (shown.length === 0) continue;
    let key = field;
    const court = /^courts\.(\d+)\.(identifier|startTime|endTime)$/.exec(field);
    if (court !== null) {
      const row = rows[Number(court[1])];
      const part = court[2] === 'identifier' ? 'name' : court[2] === 'startTime' ? 'start' : 'end';
      key = row === undefined ? field : `court-${row.key}-${part}`;
    } else if (field === 'cancellationDeadline.date' || field === 'cancellationDeadline') {
      key = 'deadlineDate';
    } else if (field === 'cancellationDeadline.time') {
      key = 'deadlineTime';
    }
    mapped[key] = [...(mapped[key] ?? []), ...shown];
  }
  return mapped;
}

/** Field names in page order, for the error summary (court rows in row order, between Details and Places). */
export function errorOrder(state: SessionFormState): string[] {
  return [
    'frequency',
    'startsOn',
    'recurUntil',
    'location',
    'address',
    'date',
    'courts',
    ...state.courts.rows.flatMap((row) => [
      `court-${row.key}-name`,
      `court-${row.key}-start`,
      `court-${row.key}-end`,
    ]),
    'maxPlayers',
    'reservedSeats',
    'courtCost',
    'extraExpenses',
    'customPlayerRate',
    'feeMale',
    'feeFemale',
    'feeOther',
    'feeBeginner',
    'feeIntermediate',
    'feeAdvanced',
    'deadlineDate',
    'deadlineTime',
  ];
}
