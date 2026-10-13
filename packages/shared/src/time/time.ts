/**
 * Wall-clock <-> instant conversion for Pacific/Auckland (algorithm doc §Q7).
 *
 * Hand-rolled Intl offset probe: no dependencies, no native Temporal. The module never calls a
 * local-zone `Date` getter/setter (see the ESLint rule for this directory), so results are
 * independent of the host `TZ`. `nz_local_to_utc` in SQL is the parity-tested mirror of this file.
 */
declare const localDateBrand: unique symbol;
declare const localTimeBrand: unique symbol;

/** 'YYYY-MM-DD', calendar-valid (Pacific/Auckland wall-clock date). */
export type LocalDate = string & { readonly [localDateBrand]: true };
/** 'HH:MM' | 'HH:MM:SS'; '24:00' allowed only as an end-of-day marker. */
export type LocalTime = string & { readonly [localTimeBrand]: true };

export const APP_TIME_ZONE = 'Pacific/Auckland' as const;

export type Disambiguation = 'compatible' | 'earlier' | 'later' | 'reject';
export const DST_POLICY = { USER_INPUT: 'reject', DERIVED: 'compatible' } as const satisfies Record<
  string,
  Disambiguation
>;

export type LocalResolution =
  | { kind: 'unique'; instant: Date }
  | { kind: 'nonexistent'; shiftedForward: Date; shiftedBackward: Date; gapMinutes: number }
  | { kind: 'ambiguous'; earlier: Date; later: Date };

export type TimeErrorCode =
  | 'INVALID_LOCAL_DATE'
  | 'INVALID_LOCAL_TIME'
  | 'INVALID_TIME_ZONE'
  | 'INVALID_INSTANT'
  | 'NONEXISTENT_LOCAL_TIME'
  | 'AMBIGUOUS_LOCAL_TIME';

export class TimeValidationError extends Error {
  readonly code: TimeErrorCode;

  constructor(code: TimeErrorCode, message: string) {
    super(message);
    this.name = 'TimeValidationError';
    this.code = code;
  }
}

/** The wall-clock time falls in a spring-forward gap. */
export class NonexistentLocalTimeError extends TimeValidationError {
  readonly shiftedForward: Date;
  readonly shiftedBackward: Date;

  constructor(label: string, shiftedForward: Date, shiftedBackward: Date) {
    super('NONEXISTENT_LOCAL_TIME', `${label} does not exist (daylight-saving gap)`);
    this.name = 'NonexistentLocalTimeError';
    this.shiftedForward = shiftedForward;
    this.shiftedBackward = shiftedBackward;
  }
}

/** The wall-clock time occurs twice (fall-back overlap). */
export class AmbiguousLocalTimeError extends TimeValidationError {
  readonly earlier: Date;
  readonly later: Date;

  constructor(label: string, earlier: Date, later: Date) {
    super('AMBIGUOUS_LOCAL_TIME', `${label} is ambiguous (daylight-saving overlap)`);
    this.name = 'AmbiguousLocalTimeError';
    this.earlier = earlier;
    this.later = later;
  }
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------------------------
// Parsing / validation
// ---------------------------------------------------------------------------------------------

/** UTC epoch ms for the given fields (fields may overflow and roll; years < 100 are not remapped). */
function utcMs(year: number, month: number, day: number, h = 0, mi = 0, s = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(h, mi, s, 0);
  return date.getTime();
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const rolled = new Date(utcMs(year, month, day));
  return (
    rolled.getUTCFullYear() === year &&
    rolled.getUTCMonth() === month - 1 &&
    rolled.getUTCDate() === day
  );
}

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseLocalDate(input: unknown): LocalDate {
  const match = typeof input === 'string' ? LOCAL_DATE_PATTERN.exec(input) : null;
  if (
    match === null ||
    !isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))
  ) {
    throw new TimeValidationError(
      'INVALID_LOCAL_DATE',
      'local date must be a real date as YYYY-MM-DD',
    );
  }
  return input as LocalDate;
}

export function parseLocalTime(input: unknown): LocalTime {
  const match = typeof input === 'string' ? LOCAL_TIME_PATTERN.exec(input) : null;
  const [h, m, s] =
    match === null ? [-1, -1, -1] : [Number(match[1]), Number(match[2]), Number(match[3] ?? '0')];
  const ordinary = h >= 0 && h <= 23 && m >= 0 && m <= 59 && s >= 0 && s <= 59;
  const endOfDay = h === 24 && m === 0 && s === 0;
  if (match === null || !(ordinary || endOfDay)) {
    throw new TimeValidationError(
      'INVALID_LOCAL_TIME',
      'local time must be HH:MM or HH:MM:SS (24:00 = end of day)',
    );
  }
  return input as LocalTime;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      throw new TimeValidationError('INVALID_TIME_ZONE', 'unknown IANA time zone name');
    }
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function assertTimeZone(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TimeValidationError('INVALID_TIME_ZONE', 'time zone must be an IANA name');
  }
  formatterFor(name);
  return name;
}

export function parseIsoInstant(input: unknown): Date {
  const match = typeof input === 'string' ? ISO_INSTANT_PATTERN.exec(input) : null;
  if (
    match === null ||
    !isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))
  ) {
    throw new TimeValidationError(
      'INVALID_INSTANT',
      'instant must be ISO-8601 with Z or a +/-HH:MM offset',
    );
  }
  const date = new Date(input as string);
  if (Number.isNaN(date.getTime())) {
    throw new TimeValidationError('INVALID_INSTANT', 'instant is not a valid date-time');
  }
  return date;
}

function assertValidInstant(instant: Date): void {
  if (Number.isNaN(instant.getTime())) {
    throw new TimeValidationError('INVALID_INSTANT', 'instant is not a valid date-time');
  }
}

export function toIsoInstant(d: Date): string {
  assertValidInstant(d);
  return d.toISOString();
}

// ---------------------------------------------------------------------------------------------
// Offset probe
// ---------------------------------------------------------------------------------------------

/** Wall-clock fields of `ms` in `timeZone`, read back "as if UTC". */
function wallMs(ms: number, timeZone: string): number {
  const fields: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  return utcMs(
    fields.year ?? 0,
    fields.month ?? 1,
    fields.day ?? 1,
    (fields.hour ?? 0) % 24, // some engines render midnight as 24
    fields.minute ?? 0,
    fields.second ?? 0,
  );
}

function offsetMs(ms: number, timeZone: string): number {
  const wholeSeconds = Math.floor(ms / 1000) * 1000;
  return wallMs(wholeSeconds, timeZone) - wholeSeconds;
}

// ---------------------------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------------------------

export function resolveLocal(
  date: LocalDate,
  time: LocalTime,
  timeZone: string = APP_TIME_ZONE,
): LocalResolution {
  assertTimeZone(timeZone);
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi, s = 0] = time.split(':').map(Number) as [number, number, number?];
  const local = utcMs(y, mo, d, h, mi, s); // '24:00' rolls into the next day
  const before = offsetMs(local - DAY_MS, timeZone);
  const after = offsetMs(local + DAY_MS, timeZone);
  const candidates = [...new Set([local - before, local - after])]
    .filter((candidate) => offsetMs(candidate, timeZone) === local - candidate)
    .sort((a, b) => a - b);
  if (candidates.length === 1)
    return { kind: 'unique', instant: new Date(candidates[0] as number) };
  if (candidates.length === 2) {
    return {
      kind: 'ambiguous',
      earlier: new Date(candidates[0] as number),
      later: new Date(candidates[1] as number),
    };
  }
  return {
    kind: 'nonexistent',
    shiftedForward: new Date(local - before),
    shiftedBackward: new Date(local - after),
    gapMinutes: (after - before) / MINUTE_MS,
  };
}

/** The only place wall-clock becomes an instant in TS. `disambiguation` is deliberately required. */
export function localToInstant(
  date: LocalDate,
  time: LocalTime,
  disambiguation: Disambiguation,
  timeZone: string = APP_TIME_ZONE,
): Date {
  const resolution = resolveLocal(date, time, timeZone);
  const label = `${date} ${time} in ${timeZone}`;
  switch (resolution.kind) {
    case 'unique':
      return resolution.instant;
    case 'ambiguous':
      if (disambiguation === 'reject') {
        throw new AmbiguousLocalTimeError(label, resolution.earlier, resolution.later);
      }
      return disambiguation === 'later' ? resolution.later : resolution.earlier;
    case 'nonexistent':
      if (disambiguation === 'reject') {
        throw new NonexistentLocalTimeError(
          label,
          resolution.shiftedForward,
          resolution.shiftedBackward,
        );
      }
      return disambiguation === 'earlier' ? resolution.shiftedBackward : resolution.shiftedForward;
  }
}

export function instantToLocal(
  instant: Date,
  timeZone: string = APP_TIME_ZONE,
): { date: LocalDate; time: LocalTime; utcOffsetMinutes: number } {
  assertValidInstant(instant);
  assertTimeZone(timeZone);
  const offset = offsetMs(instant.getTime(), timeZone);
  const wall = new Date(instant.getTime() + offset);
  const seconds = wall.getUTCSeconds();
  const hhmm = `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`;
  return {
    date: `${pad(wall.getUTCFullYear(), 4)}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}` as LocalDate,
    time: (seconds === 0 ? hhmm : `${hhmm}:${pad(seconds)}`) as LocalTime,
    utcOffsetMinutes: offset / MINUTE_MS,
  };
}

// ---------------------------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------------------------

function assertInteger(value: number, what: string): void {
  if (!Number.isInteger(value)) {
    throw new TimeValidationError('INVALID_INSTANT', `${what} must be an integer`);
  }
}

/** Absolute (elapsed-time) arithmetic: 24 h is always 24 h, across DST changes. */
export function addHours(instant: Date, hours: number): Date {
  assertInteger(hours, 'hours');
  assertValidInstant(instant);
  return new Date(instant.getTime() + hours * HOUR_MS);
}

export const CANCELLATION_DEADLINE_DEFAULT_HOURS = 48;

export function defaultCancellationDeadline(startsAt: Date): Date {
  return addHours(startsAt, -CANCELLATION_DEADLINE_DEFAULT_HOURS);
}

/** Calendar-day arithmetic on a wall-clock date (weekly recurrence = +7). */
export function addLocalDays(date: LocalDate, days: number): LocalDate {
  assertInteger(days, 'days');
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const moved = new Date(utcMs(y, mo, d) + days * DAY_MS);
  return `${pad(moved.getUTCFullYear(), 4)}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}` as LocalDate;
}

/** The same Pacific/Auckland wall-clock time `days` calendar days earlier (may differ from `days * 24 h`). */
export function sameWallClockDaysBefore(
  instant: Date,
  days: number,
  disambiguation: Disambiguation,
): Date {
  const local = instantToLocal(instant);
  return localToInstant(addLocalDays(local.date, -days), local.time, disambiguation);
}

// ---------------------------------------------------------------------------------------------
// Display (NZ edge formatting, built from fields so it never depends on ICU locale strings)
// ---------------------------------------------------------------------------------------------

function ddmmyyyy(date: LocalDate): string {
  const [y, m, d] = date.split('-') as [string, string, string];
  return `${d}/${m}/${y}`;
}

export function formatNzDate(x: Date | LocalDate): string {
  return ddmmyyyy(typeof x === 'string' ? x : instantToLocal(x).date);
}

export function formatNzTime(instant: Date): string {
  const [hh = '0', mm = '00'] = instantToLocal(instant).time.split(':');
  const hour = Number(hh);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${mm} ${hour < 12 ? 'am' : 'pm'}`;
}

export function formatNzDateTime(instant: Date): string {
  return `${formatNzDate(instant)} ${formatNzTime(instant)}`;
}
