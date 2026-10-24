/**
 * Recurrence date generation (algorithm doc A1-4, Decision "Algorithm Steps"). Pure calendar arithmetic on
 * `LocalDate` strings via integer epoch days: no clock, no I/O, and only `getUTC*` accessors, so the result
 * never depends on the host `TZ`. Weekday convention: 0 = Sunday (PostgreSQL `extract(dow)`, JS `getUTCDay()`).
 * The DB CHECKs on `recurring_session_rules` (D-70) mirror `assertRecurrenceRule`.
 */
import { parseLocalDate, type LocalDate } from '../time/time.ts';
import type { RecurrenceFrequency } from '../types/enums.ts';

/** 1st to 4th weekday of the month, or -1 for the last. A 5th-weekday anchor is stored as -1. */
export type MonthlyWeek = 1 | 2 | 3 | 4 | -1;

export interface RecurrenceRule {
  readonly frequency: RecurrenceFrequency;
  /** 0 = Sunday .. 6 = Saturday. */
  readonly dayOfWeek: number;
  /** The series' first date and recurrence anchor; it must fall on `dayOfWeek`. */
  readonly startsOn: LocalDate;
  /** Required for MONTHLY, null otherwise. */
  readonly monthlyWeek: MonthlyWeek | null;
  /** Inclusive last date, or null for an open-ended series. */
  readonly recurUntil: LocalDate | null;
}

/** An inclusive date window. */
export interface DateWindow {
  readonly from: LocalDate;
  readonly to: LocalDate;
}

export type RecurrenceRuleField = 'dayOfWeek' | 'startsOn' | 'monthlyWeek' | 'recurUntil';

/** The rule is internally inconsistent. `field` is the input the admin can fix. */
export class RecurrenceRuleError extends Error {
  readonly field: RecurrenceRuleField;

  constructor(field: RecurrenceRuleField, message: string) {
    super(message);
    this.name = 'RecurrenceRuleError';
    this.field = field;
  }
}

const DAY_MS = 86_400_000;

function parts(date: LocalDate): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return [y, m, d];
}

/** Days since 1970-01-01 (UTC) of a calendar date. */
export function epochDay(date: LocalDate): number {
  const [y, m, d] = parts(date);
  const moved = new Date(0);
  moved.setUTCFullYear(y, m - 1, d);
  return Math.round(moved.getTime() / DAY_MS);
}

export function fromEpochDay(day: number): LocalDate {
  const moved = new Date(day * DAY_MS);
  const y = String(moved.getUTCFullYear()).padStart(4, '0');
  const m = String(moved.getUTCMonth() + 1).padStart(2, '0');
  const d = String(moved.getUTCDate()).padStart(2, '0');
  return parseLocalDate(`${y}-${m}-${d}`);
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** 0 = Sunday. 1970-01-01 was a Thursday, so the weekday is `(epochDay + 4) mod 7`. */
export function weekdayOf(date: LocalDate): number {
  return mod(epochDay(date) + 4, 7);
}

function daysInMonth(year: number, month: number): number {
  const probe = new Date(0);
  probe.setUTCFullYear(year, month, 0); // day 0 of the next month = last day of `month`
  return probe.getUTCDate();
}

function makeDate(year: number, month: number, day: number): LocalDate {
  const y = String(year).padStart(4, '0');
  return parseLocalDate(`${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
}

/** The `k`-th (1-4) or last (-1) `weekday` of a month. A 1-4 ordinal always exists (day <= 28). */
export function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  k: MonthlyWeek,
): LocalDate {
  if (k > 0) {
    const first = weekdayOf(makeDate(year, month, 1));
    return makeDate(year, month, 1 + mod(weekday - first, 7) + 7 * (k - 1));
  }
  const last = daysInMonth(year, month);
  const lastWeekday = weekdayOf(makeDate(year, month, last));
  return makeDate(year, month, last - mod(lastWeekday - weekday, 7));
}

/**
 * The ordinal an anchor date implies: `ceil(day / 7)`, with a 5th weekday stored as "last". `alsoLast` is true
 * when the anchor is both the 4th and the last such weekday, so the admin chooses (they differ in months with
 * five of that weekday).
 */
export function defaultMonthlyWeek(anchor: LocalDate): { week: MonthlyWeek; alsoLast: boolean } {
  const [y, m, d] = parts(anchor);
  const ordinal = Math.ceil(d / 7);
  const isLast = d + 7 > daysInMonth(y, m);
  return ordinal === 5
    ? { week: -1, alsoLast: false }
    : { week: ordinal as MonthlyWeek, alsoLast: isLast };
}

const MONTHLY_WEEKS: readonly number[] = [1, 2, 3, 4, -1];

/** Throws `RecurrenceRuleError` when the rule is inconsistent. */
export function assertRecurrenceRule(rule: RecurrenceRule): void {
  if (!Number.isInteger(rule.dayOfWeek) || rule.dayOfWeek < 0 || rule.dayOfWeek > 6) {
    throw new RecurrenceRuleError('dayOfWeek', 'day of week must be 0 (Sunday) to 6 (Saturday)');
  }
  if (rule.frequency === 'MONTHLY') {
    if (rule.monthlyWeek === null || !MONTHLY_WEEKS.includes(rule.monthlyWeek)) {
      throw new RecurrenceRuleError('monthlyWeek', 'a monthly rule needs 1, 2, 3, 4 or -1 (last)');
    }
  } else if (rule.monthlyWeek !== null) {
    throw new RecurrenceRuleError('monthlyWeek', 'only a monthly rule has a monthly week');
  }
  if (weekdayOf(rule.startsOn) !== rule.dayOfWeek) {
    throw new RecurrenceRuleError('startsOn', 'the first date must fall on the chosen weekday');
  }
  if (rule.frequency === 'MONTHLY') {
    const [y, m] = parts(rule.startsOn);
    const expected = nthWeekdayOfMonth(y, m, rule.dayOfWeek, rule.monthlyWeek as MonthlyWeek);
    if (expected !== rule.startsOn) {
      throw new RecurrenceRuleError(
        'startsOn',
        'the first date must be the chosen week of its month',
      );
    }
  }
  if (rule.recurUntil !== null && rule.recurUntil < rule.startsOn) {
    throw new RecurrenceRuleError('recurUntil', 'the last date cannot be before the first date');
  }
}

/** Calendar dates of the series inside an inclusive window, ascending and without duplicates. */
export function recurrenceDates(rule: RecurrenceRule, window: DateWindow): LocalDate[] {
  assertRecurrenceRule(rule);
  const start = window.from > rule.startsOn ? window.from : rule.startsOn;
  const end = rule.recurUntil !== null && rule.recurUntil < window.to ? rule.recurUntil : window.to;
  if (start > end) return [];

  const out: LocalDate[] = [];
  if (rule.frequency !== 'MONTHLY') {
    const step = rule.frequency === 'WEEKLY' ? 7 : 14;
    const anchor = epochDay(rule.startsOn);
    const last = epochDay(end);
    const skipped = Math.ceil((epochDay(start) - anchor) / step); // >= 0 because start >= startsOn
    for (let day = anchor + skipped * step; day <= last; day += step) out.push(fromEpochDay(day));
    return out;
  }

  const [startYear, startMonth] = parts(start);
  const [endYear, endMonth] = parts(end);
  for (
    let index = startYear * 12 + startMonth - 1;
    index <= endYear * 12 + endMonth - 1;
    index += 1
  ) {
    const date = nthWeekdayOfMonth(
      Math.floor(index / 12),
      (index % 12) + 1,
      rule.dayOfWeek,
      rule.monthlyWeek as MonthlyWeek,
    );
    if (date >= start && date <= end) out.push(date);
  }
  return out;
}

/** The Monday of the (NZ local) week containing `date`: the banking-email window key (T-4). */
export function isoWeekStart(date: LocalDate): LocalDate {
  return fromEpochDay(epochDay(date) - mod(weekdayOf(date) - 1, 7));
}
