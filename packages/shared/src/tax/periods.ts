/**
 * Tax periods for income exports (tax-invoices-and-exports, algorithm D1): the NZ financial year (1 April to 31 March), GST
 * returns of 2 or 6 months in either alignment, and a custom range. Every period is a Pacific/Auckland wall-clock
 * `LocalDateRange` (inclusive), and `toInstantRange` is the ONE place a range becomes the half-open UTC instant pair
 * `[start 00:00 NZ, end + 1 day 00:00 NZ)` the SQL filter uses. A payment therefore falls in exactly one period of each kind,
 * and its NZ-local paid date is within `[from, to]` exactly when its instant is within `[from, to)` (AC-VERIFY-3).
 */
import {
  APP_TIME_ZONE,
  DST_POLICY,
  addLocalDays,
  diffLocalDays,
  formatNzDate,
  localToInstant,
  parseLocalDate,
  parseLocalTime,
  type LocalDate,
} from '../time/time.ts';

/** An inclusive range of Pacific/Auckland calendar dates. */
export interface LocalDateRange {
  readonly from: LocalDate;
  readonly to: LocalDate;
}

/** A half-open UTC instant range `[from, to)`. */
export interface InstantRange {
  readonly from: Date;
  readonly to: Date;
}

export type PeriodErrorCode = 'INVALID_PERIOD_END' | 'INVALID_FINANCIAL_YEAR';

export class PeriodError extends Error {
  readonly code: PeriodErrorCode;

  constructor(code: PeriodErrorCode, message: string) {
    super(message);
    this.name = 'PeriodError';
    this.code = code;
  }
}

/** The longest custom range an export accepts: 7 years inclusive (R3), matching the 7-year retention. */
export const MAX_RANGE_DAYS = 2557;
/**
 * The calendar years a preset export period may start or end in. Bounded well inside `LocalDate` (whose last day is
 * 9999-12-31), so a financial year or GST period built from a well-formed label never needs a five-digit date.
 */
export const EXPORT_YEARS = { first: 2000, last: 2099 } as const;
/** The most GST periods one selector lists (7 years of two-monthly periods). */
const MAX_LISTED_PERIODS = 42;

export interface GstCadence {
  /** Months in one GST return period. */
  readonly months: 1 | 2 | 6;
  /** The calendar month (1..12) in which a period ends; the others follow every `months` months. */
  readonly anchorEndMonth: number;
}

export const GST_CADENCES = {
  /** Periods ending Jan, Mar, May, Jul, Sep, Nov. */
  TWO_MONTHLY_ODD: { months: 2, anchorEndMonth: 1 },
  /** Periods ending Feb, Apr, Jun, Aug, Oct, Dec. */
  TWO_MONTHLY_EVEN: { months: 2, anchorEndMonth: 2 },
  /** Periods ending March and September (R2). Monthly is not offered: a custom range covers it. */
  SIX_MONTHLY_MAR_SEP: { months: 6, anchorEndMonth: 3 },
} as const satisfies Record<string, GstCadence>;
export type GstCadenceId = keyof typeof GST_CADENCES;

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
const MIDNIGHT = parseLocalTime('00:00');

/** Months since year 0 (January of year 0 = 0), so period arithmetic is plain integer maths. */
function monthIndexOf(date: LocalDate): number {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return y * 12 + (m - 1);
}

function firstOfMonth(monthIndex: number): LocalDate {
  const year = (monthIndex - (monthIndex % 12)) / 12;
  return parseLocalDate(`${pad(year, 4)}-${pad((monthIndex % 12) + 1)}-01`);
}

function lastOfMonth(monthIndex: number): LocalDate {
  return addLocalDays(firstOfMonth(monthIndex + 1), -1);
}

function periodEndingAt(endMonthIndex: number, months: number): LocalDateRange {
  return { from: firstOfMonth(endMonthIndex - months + 1), to: lastOfMonth(endMonthIndex) };
}

// ---------------------------------------------------------------------------------------------
// Financial year
// ---------------------------------------------------------------------------------------------

/** 1 April `startYear` to 31 March `startYear + 1`. */
export function financialYear(startYear: number): LocalDateRange {
  return {
    from: parseLocalDate(`${pad(startYear, 4)}-04-01`),
    to: parseLocalDate(`${pad(startYear + 1, 4)}-03-31`),
  };
}

/** The start year of the financial year a date falls in. */
export function financialYearOf(date: LocalDate): number {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return m >= 4 ? y : y - 1;
}

/** `2026-27`. */
export function formatFinancialYear(startYear: number): string {
  return `${startYear}-${pad((startYear + 1) % 100)}`;
}

const FINANCIAL_YEAR_PATTERN = /^(\d{4})-(\d{2})$/;

/** `2026-27` to 2026. Rejects a label whose second half is not the next year, and a start outside `EXPORT_YEARS`. */
export function parseFinancialYear(label: string): number {
  const match = FINANCIAL_YEAR_PATTERN.exec(label);
  const start = match === null ? Number.NaN : Number(match[1]);
  if (
    match === null ||
    start < EXPORT_YEARS.first ||
    start > EXPORT_YEARS.last ||
    (start + 1) % 100 !== Number(match[2])
  ) {
    throw new PeriodError(
      'INVALID_FINANCIAL_YEAR',
      'a financial year looks like 2026-27 (two consecutive years, from 2000-01 to 2099-00)',
    );
  }
  return start;
}

// ---------------------------------------------------------------------------------------------
// GST periods
// ---------------------------------------------------------------------------------------------

/** The GST period of `cadence` that contains `date`. */
export function gstPeriodContaining(date: LocalDate, cadence: GstCadence): LocalDateRange {
  const index = monthIndexOf(date);
  const month = (index % 12) + 1;
  const stepsToEnd =
    (((cadence.anchorEndMonth - month) % cadence.months) + cadence.months) % cadence.months;
  return periodEndingAt(index + stepsToEnd, cadence.months);
}

const YEAR_MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The GST period that ends in `yearMonth` (`YYYY-MM`); throws `INVALID_PERIOD_END` when no period ends in that month. */
export function gstPeriodEndingIn(yearMonth: string, cadence: GstCadence): LocalDateRange {
  const match = YEAR_MONTH_PATTERN.exec(yearMonth);
  const month = match === null ? 0 : Number(match[2]);
  const aligned = match !== null && (month - cadence.anchorEndMonth) % cadence.months === 0;
  if (!aligned) {
    throw new PeriodError(
      'INVALID_PERIOD_END',
      `${yearMonth} does not end a ${cadence.months}-month GST period of this alignment`,
    );
  }
  return periodEndingAt(monthIndexOf(parseLocalDate(`${yearMonth}-01`)), cadence.months);
}

/** The period just before `period` (the one most recently filed once `period` is current). */
export function previousGstPeriod(period: LocalDateRange, cadence: GstCadence): LocalDateRange {
  return periodEndingAt(monthIndexOf(period.from) - 1, cadence.months);
}

// ---------------------------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------------------------

/**
 * The one local-to-instant conversion: `[from 00:00, to + 1 day 00:00)` in `timeZone` (default Pacific/Auckland). Midnight
 * is never in a Pacific/Auckland gap, and `DST_POLICY.DERIVED` resolves any other zone's gap deterministically.
 */
export function toInstantRange(
  range: LocalDateRange,
  timeZone: string = APP_TIME_ZONE,
): InstantRange {
  return {
    from: localToInstant(range.from, MIDNIGHT, DST_POLICY.DERIVED, timeZone),
    to: localToInstant(addLocalDays(range.to, 1), MIDNIGHT, DST_POLICY.DERIVED, timeZone),
  };
}

/** Calendar days in the range, both ends included. */
export function inclusiveDays(range: LocalDateRange): number {
  return diffLocalDays(range.from, range.to) + 1;
}

export interface RangeIssue {
  readonly field: 'from' | 'to';
  readonly message: string;
}

/**
 * The checks a custom export range must pass, in the order the API reports them (AC-ERROR-3): end before start, a start in
 * the future, then more than `MAX_RANGE_DAYS`. `today` is the NZ local date of the request's one clock read.
 */
export function validateExportRange(range: LocalDateRange, today: LocalDate): RangeIssue | null {
  if (range.to < range.from) {
    return { field: 'to', message: "The end date can't be before the start date" };
  }
  if (range.from > today) {
    return { field: 'from', message: "The start date can't be in the future" };
  }
  if (inclusiveDays(range) > MAX_RANGE_DAYS) {
    return { field: 'to', message: 'Choose a range of 7 years or less' };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Option lists for the export form
// ---------------------------------------------------------------------------------------------

/** Financial years with at least one PAID payment, plus the current one, newest first. */
export function listFinancialYears(input: {
  readonly today: LocalDate;
  readonly yearsWithPayments: readonly number[];
}): number[] {
  const years = new Set([...input.yearsWithPayments, financialYearOf(input.today)]);
  return [...years].sort((a, b) => b - a);
}

/**
 * GST periods of `cadence`, newest first and contiguous, from the current period back to the one holding the first paid
 * date (or just the current one when nothing is paid), within `maxRangeDays` of today and at most 42 entries. Empty periods
 * are listed on purpose: a nil return is still a return.
 */
export function listGstPeriods(input: {
  readonly today: LocalDate;
  readonly firstPaidDate: LocalDate | null;
  readonly cadence: GstCadence;
  readonly maxRangeDays: number;
}): LocalDateRange[] {
  const current = gstPeriodContaining(input.today, input.cadence);
  const earliest =
    input.firstPaidDate === null
      ? current
      : gstPeriodContaining(input.firstPaidDate, input.cadence);
  const periods: LocalDateRange[] = [];
  let cursor = current;
  while (periods.length < MAX_LISTED_PERIODS) {
    if (diffLocalDays(cursor.from, input.today) > input.maxRangeDays) break;
    periods.push(cursor);
    if (cursor.from <= earliest.from) break;
    cursor = previousGstPeriod(cursor, input.cadence);
  }
  return periods;
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

/** A period request after the server has resolved it to dates (the export query's output). */
export type ResolvedPeriodRequest =
  | { readonly kind: 'custom'; readonly range: LocalDateRange }
  | { readonly kind: 'gst'; readonly cadence: GstCadenceId; readonly range: LocalDateRange }
  | { readonly kind: 'fy'; readonly startYear: number };

export interface PeriodDescriptor {
  readonly kind: ResolvedPeriodRequest['kind'];
  readonly range: LocalDateRange;
  /** Shown in the Summary sheet. */
  readonly label: string;
  /** The period part of the export file name. */
  readonly fileStem: string;
}

export function describePeriod(request: ResolvedPeriodRequest): PeriodDescriptor {
  switch (request.kind) {
    case 'custom':
      return {
        kind: 'custom',
        range: request.range,
        label: `${formatNzDate(request.range.from)} to ${formatNzDate(request.range.to)}`,
        fileStem: `${request.range.from}_to_${request.range.to}`,
      };
    case 'gst':
      return {
        kind: 'gst',
        range: request.range,
        label: `GST period ${formatNzDate(request.range.from)} to ${formatNzDate(request.range.to)}`,
        fileStem: `gst_${request.range.from.slice(0, 7)}_to_${request.range.to.slice(0, 7)}`,
      };
    case 'fy': {
      const range = financialYear(request.startYear);
      const name = formatFinancialYear(request.startYear);
      return {
        kind: 'fy',
        range,
        label: `Financial year ${name} (${formatNzDate(range.from)} to ${formatNzDate(range.to)})`,
        fileStem: `fy_${name}`,
      };
    }
  }
}
