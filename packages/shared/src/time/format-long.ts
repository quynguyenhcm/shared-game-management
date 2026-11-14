import { formatNzTime, instantToLocal, parseLocalDate, type LocalDate } from './time.ts';

/**
 * Long NZ date forms for printed documents (tax-invoices-and-exports UI/UX doc, "Rules"): `3 June 2027` and
 * `Tuesday 3 June 2027`. Built from fields, never from ICU locale strings, so the output has no narrow no-break space and
 * does not depend on the host's ICU or time zone (P3). A bare `03/06/2027` is ambiguous to an overseas accountant, so the
 * documents print the month name; the numeric form stays `formatNzDate`.
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const localDateOf = (x: Date | LocalDate): LocalDate =>
  typeof x === 'string' ? x : instantToLocal(x).date;

function partsOf(date: LocalDate): { year: string; month: string; day: string } {
  const [year = '', month = '', day = ''] = date.split('-');
  return { year, month: MONTHS[parseInt(month, 10) - 1] ?? '', day: String(parseInt(day, 10)) };
}

/** `3 June 2027` (the NZ calendar day of an instant, or a local date as given). */
export function formatNzDateLong(x: Date | LocalDate): string {
  const { year, month, day } = partsOf(localDateOf(x));
  return `${day} ${month} ${year}`;
}

/** `Tuesday 3 June 2027`. */
export function formatNzWeekdayDate(x: Date | LocalDate): string {
  const date = parseLocalDate(localDateOf(x));
  const [y = '', m = '', d = ''] = date.split('-');
  const weekday =
    WEEKDAYS[new Date(Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10))).getUTCDay()];
  return `${weekday ?? ''} ${formatNzDateLong(date)}`;
}

/** `Tuesday 3 June 2027, 7:30 pm` (NZ local time of the instant). */
export function formatNzWeekdayDateTime(instant: Date): string {
  return `${formatNzWeekdayDate(instant)}, ${formatNzTime(instant)}`;
}
