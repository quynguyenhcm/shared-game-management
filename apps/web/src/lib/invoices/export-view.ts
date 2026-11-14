/**
 * The pure half of the Income exports form (tax-invoices-and-exports Phase 4; AC-HAPPY-6..8, AC-ERROR-3, R2; architecture
 * Decision D1). The form is a plain GET form that works with no JavaScript, so it submits EVERY period group's fields; the
 * route handler consumes only the selected type's (`exportApiQuery`) because the API's query is strict. A refusal lands back on
 * the exports page with the selected values, the code and the 422 field NAMES (`exportLandingPath`); the page re-derives the
 * messages with the same shared rules the API runs (`exportFieldErrors`), so no message text is ever read out of a URL.
 */
import {
  GST_CADENCES,
  GST_CADENCE_WIRE,
  IncomeExportQueryString,
  financialYear,
  financialYearOf,
  formatFinancialYear,
  formatNzDateLong,
  futurePeriodIssue,
  listFinancialYears,
  listGstPeriods,
  parseLocalDate,
  validateExportRange,
  type IncomeExportPeriodsResponse,
  type LocalDate,
  type LocalDateRange,
} from '@sgm/shared';
import type { FieldErrors } from '../auth/validation.ts';
import type { DownloadErrorCode } from './paths.ts';
import { DOWNLOAD_ERROR_PARAM } from './paths.ts';

export const EXPORT_PERIOD_TYPES = ['custom', 'gst', 'fy'] as const;
export type ExportPeriodType = (typeof EXPORT_PERIOD_TYPES)[number];

/** What the form submits (and what a landing carries back). Values are raw strings; the API validates them. */
export interface ExportFormValues {
  readonly period: ExportPeriodType | null;
  readonly format: string;
  /** `period=custom`. */
  readonly from: string;
  readonly to: string;
  /** `period=gst`: `<cadence>/<YYYY-MM end month>`, e.g. `2m-odd/2027-05` (one select covers both API parameters). */
  readonly gst: string;
  /** `period=fy`: `2026-27`. */
  readonly year: string;
}

/** The query key carrying the 422 field names on a landing. */
export const EXPORT_FIELD_PARAM = 'field';

/** A field the API refused that the shared rules accept now (a date crossed midnight between the two checks). */
export const EXPORT_FIELD_FALLBACK = 'Check this answer and try again.';

/** The longest value echoed back into a URL or the form (dates, `2026-27`, `6m-mar-sep/2027-09` are all shorter). */
const MAX_VALUE_LENGTH = 32;

export const exportsPagePath = (teamId: string): string => `/teams/${teamId}/manage/exports`;
export const incomeExportAction = (teamId: string): string => `${exportsPagePath(teamId)}/income`;

const isPeriodType = (value: string | undefined): value is ExportPeriodType =>
  EXPORT_PERIOD_TYPES.some((type) => type === value);

/** Reads the form's fields (from the route's query or the landing page's search params). */
export function readExportForm(get: (name: string) => string | null | undefined): ExportFormValues {
  const text = (name: string): string => (get(name) ?? '').slice(0, MAX_VALUE_LENGTH);
  const period = text('period');
  return {
    period: isPeriodType(period) ? period : null,
    format: text('format'),
    from: text('from'),
    to: text('to'),
    gst: text('gst'),
    year: text('year'),
  };
}

/** The selected type's own fields, in the order they are sent. */
function selectedFields(values: ExportFormValues): [string, string][] {
  switch (values.period) {
    case 'custom':
      return [
        ['from', values.from],
        ['to', values.to],
      ];
    case 'gst':
      return [['gst', values.gst]];
    case 'fy':
      return [['year', values.year]];
    case null:
      return [];
  }
}

/** `<cadence>/<end>` split for the API; a malformed value is sent as is so the API's message is the one shown. */
function splitGst(value: string): { cadence: string; end: string } {
  const [cadence = '', end = ''] = value.split('/', 2);
  return { cadence, end };
}

/** The API query of the selected period type only, or null when no known type was chosen (refused without an API call). */
export function exportApiQuery(values: ExportFormValues): string | null {
  if (values.period === null) return null;
  const query = new URLSearchParams({ format: values.format, period: values.period });
  if (values.period === 'gst') {
    const { cadence, end } = splitGst(values.gst);
    query.set('cadence', cadence);
    query.set('end', end);
  } else {
    for (const [name, value] of selectedFields(values)) query.set(name, value);
  }
  return query.toString();
}

/** API field names to the form field that shows them; anything else is dropped. */
const FORM_FIELD_OF: Readonly<Record<string, string>> = {
  period: 'period',
  format: 'format',
  from: 'from',
  to: 'to',
  cadence: 'gst',
  end: 'gst',
  year: 'year',
};

/** The exports page with the selected values, `download_error=<code>` and (for a 422) the refused form fields. */
export function exportLandingPath(
  teamId: string,
  values: ExportFormValues,
  code: DownloadErrorCode,
  apiFields: readonly string[],
): string {
  const query = new URLSearchParams();
  if (values.period !== null) query.set('period', values.period);
  for (const [name, value] of selectedFields(values)) query.set(name, value);
  if (values.format !== '') query.set('format', values.format);
  query.set(DOWNLOAD_ERROR_PARAM, code);
  const fields = new Set(
    apiFields.flatMap((name) => {
      const field = FORM_FIELD_OF[name];
      return field === undefined ? [] : [field];
    }),
  );
  for (const field of fields) query.append(EXPORT_FIELD_PARAM, field);
  return `${exportsPagePath(teamId)}?${query.toString()}`;
}

function addError(errors: FieldErrors, field: string, message: string): void {
  const list = (errors[field] ??= []);
  if (!list.includes(message)) list.push(message);
}

/**
 * The field messages of a refused export, re-derived with the shared rules the API runs (schema, then the date checks that need
 * today). `flagged` are the form fields the landing named; one the rules now accept still gets `EXPORT_FIELD_FALLBACK`.
 */
export function exportFieldErrors(
  values: ExportFormValues,
  flagged: readonly string[],
  today: string,
): FieldErrors {
  const errors: FieldErrors = {};
  const query = exportApiQuery(values);
  if (query === null) {
    addError(errors, 'period', 'Choose a custom range, a GST period or a financial year.');
  } else {
    const parsed = IncomeExportQueryString.safeParse(
      Object.fromEntries(new URLSearchParams(query)),
    );
    if (parsed.success) {
      const todayDate: LocalDate = parseLocalDate(today);
      const period = parsed.data.period;
      const issue =
        period.kind === 'custom'
          ? validateExportRange(period.range, todayDate)
          : futurePeriodIssue(period, todayDate);
      if (issue !== null) addError(errors, FORM_FIELD_OF[issue.field] ?? 'period', issue.message);
    } else {
      for (const issue of parsed.error.issues) {
        const name = String(issue.path[0] ?? 'period');
        addError(errors, FORM_FIELD_OF[name] ?? 'period', issue.message);
      }
    }
  }
  for (const field of flagged) {
    if (Object.values(FORM_FIELD_OF).includes(field) && errors[field] === undefined) {
      addError(errors, field, EXPORT_FIELD_FALLBACK);
    }
  }
  return errors;
}

export interface ExportOption {
  readonly value: string;
  readonly label: string;
}

export interface ExportOptionGroup {
  readonly label: string;
  readonly options: readonly ExportOption[];
}

const NOT_FINISHED = ' (not finished)';
const rangeLabel = (range: LocalDateRange): string =>
  `${formatNzDateLong(range.from)} to ${formatNzDateLong(range.to)}`;

/** Financial years with a paid payment plus the current one, newest first: `2026-27 (1 April 2026 to 31 March 2027)`. */
export function financialYearOptions(periods: IncomeExportPeriodsResponse): ExportOption[] {
  const today = parseLocalDate(periods.today);
  return listFinancialYears({
    today,
    yearsWithPayments: periods.financialYearsWithPayments,
  }).map((startYear) => {
    const range = financialYear(startYear);
    const name = formatFinancialYear(startYear);
    return {
      value: name,
      label: `${name} (${rangeLabel(range)})${range.to >= today ? NOT_FINISHED : ''}`,
    };
  });
}

/** The GST selector's groups (R2): two-monthly ending odd months, two-monthly ending even months, six-monthly Mar/Sep. */
const GST_GROUPS = [
  {
    wire: '2m-odd',
    label: 'Two-monthly, ending January, March, May, July, September and November',
  },
  {
    wire: '2m-even',
    label: 'Two-monthly, ending February, April, June, August, October and December',
  },
  { wire: '6m-mar-sep', label: 'Six-monthly, ending March and September' },
] as const satisfies readonly { wire: keyof typeof GST_CADENCE_WIRE; label: string }[];

/** Every GST period of each cadence from the first paid payment to today, newest first, the open one marked. */
export function gstPeriodGroups(periods: IncomeExportPeriodsResponse): ExportOptionGroup[] {
  const today = parseLocalDate(periods.today);
  const firstPaidDate =
    periods.firstPaidDate === null ? null : parseLocalDate(periods.firstPaidDate);
  return GST_GROUPS.map((group) => ({
    label: group.label,
    options: listGstPeriods({
      today,
      firstPaidDate,
      cadence: GST_CADENCES[GST_CADENCE_WIRE[group.wire]],
      maxRangeDays: periods.maxRangeDays,
    }).map((range) => ({
      value: `${group.wire}/${range.to.slice(0, 7)}`,
      label: `${rangeLabel(range)}${range.to >= today ? NOT_FINISHED : ''}`,
    })),
  }));
}

/**
 * The form's first view: Financial year (offered to every team, registered or not), the current year, the latest finished
 * two-monthly GST period (the current one when none has finished), Excel, and empty custom dates (a pre-filled range risks an
 * unreviewed wrong file).
 */
export function defaultExportValues(periods: IncomeExportPeriodsResponse): ExportFormValues {
  const today = parseLocalDate(periods.today);
  const [firstGroup] = gstPeriodGroups(periods);
  const gstOptions = firstGroup?.options ?? [];
  const finished = gstOptions.find((option) => !option.label.endsWith(NOT_FINISHED));
  return {
    period: 'fy',
    format: 'xlsx',
    from: '',
    to: '',
    gst: (finished ?? gstOptions[0])?.value ?? '',
    year: formatFinancialYear(financialYearOf(today)),
  };
}

/** The landing's values over the defaults: a key the landing carries wins, the rest keep their default. */
export function mergeExportValues(
  defaults: ExportFormValues,
  landed: ExportFormValues,
): ExportFormValues {
  return {
    period: landed.period ?? defaults.period,
    format: landed.format === '' ? defaults.format : landed.format,
    from: landed.from === '' ? defaults.from : landed.from,
    to: landed.to === '' ? defaults.to : landed.to,
    gst: landed.gst === '' ? defaults.gst : landed.gst,
    year: landed.year === '' ? defaults.year : landed.year,
  };
}
