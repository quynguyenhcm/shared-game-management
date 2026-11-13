/**
 * Contracts for payment documents (tax invoices and receipts) and the income exports (tax-invoices-and-exports,
 * architecture Decision 4 and algorithm "Export request and resolution"), shared by the Fastify routes and the web.
 *
 * The routes are `modules/invoices/routes.ts` (Phase 3) and `modules/income-exports/routes.ts` (Phase 4). The export query
 * is a strict discriminated union on `period` that the SERVER resolves with the shared `tax/` helpers, so there is one range
 * semantics, an unknown financial year is an API 422 and the label in a file is always true. Checks that need today's date
 * (a start in the future, the 7-year limit, a preset period that has not started) are `validateExportRange` and
 * `futurePeriodIssue`, run by the service with its one clock read. Messages never echo input.
 */
import { z } from 'zod';
import {
  EXPORT_YEARS,
  GST_CADENCES,
  financialYear,
  gstPeriodEndingIn,
  parseFinancialYear,
  type GstCadenceId,
  type ResolvedPeriodRequest,
} from '../tax/periods.ts';
import { parseLocalDate, type LocalDate } from '../time/time.ts';
import { PaymentDocumentKind } from '../types/enums.ts';

export const INVOICE_FIELD_MESSAGES = {
  formatInvalid: 'Choose CSV or Excel.',
  periodTypeInvalid: 'Choose a custom range, a GST period or a financial year.',
  startDateInvalid: 'Enter a valid start date as YYYY-MM-DD.',
  endDateInvalid: 'Enter a valid end date as YYYY-MM-DD.',
  cadenceInvalid: 'Choose how often you file GST.',
  periodEndInvalid: 'Choose a month that ends a GST period.',
  financialYearInvalid: 'Choose a financial year like 2026-27.',
  financialYearNotStarted: 'Choose a financial year that has started.',
  periodNotStarted: 'Choose a GST period that has started.',
} as const;

const M = INVOICE_FIELD_MESSAGES;

/** The `cadence` query values, mapped to the shared GST cadences. */
export const GST_CADENCE_WIRE = {
  '2m-odd': 'TWO_MONTHLY_ODD',
  '2m-even': 'TWO_MONTHLY_EVEN',
  '6m-mar-sep': 'SIX_MONTHLY_MAR_SEP',
} as const satisfies Record<string, GstCadenceId>;

export const ExportFormat = z.enum(['csv', 'xlsx'], { error: M.formatInvalid });
export type ExportFormat = z.infer<typeof ExportFormat>;

const format = ExportFormat;
const CustomPeriod = z
  .object({
    format,
    period: z.literal('custom'),
    from: z.string({ error: M.startDateInvalid }),
    to: z.string({ error: M.endDateInvalid }),
  })
  .strict();
const GstPeriod = z
  .object({
    format,
    period: z.literal('gst'),
    cadence: z.enum(['2m-odd', '2m-even', '6m-mar-sep'], { error: M.cadenceInvalid }),
    end: z.string({ error: M.periodEndInvalid }),
  })
  .strict();
const FinancialYearPeriod = z
  .object({
    format,
    period: z.literal('fy'),
    year: z.string({ error: M.financialYearInvalid }),
  })
  .strict();

export interface IncomeExportRequest {
  readonly format: ExportFormat;
  readonly period: ResolvedPeriodRequest;
}

/** `?format=csv|xlsx&period=custom&from=&to=` | `&period=gst&cadence=&end=YYYY-MM` | `&period=fy&year=2026-27`. */
export const IncomeExportQuery = z
  .discriminatedUnion('period', [CustomPeriod, GstPeriod, FinancialYearPeriod])
  .transform((query, ctx): IncomeExportRequest => {
    switch (query.period) {
      case 'custom': {
        const issues: { path: string; message: string }[] = [];
        let from: ReturnType<typeof parseLocalDate> | undefined;
        let to: ReturnType<typeof parseLocalDate> | undefined;
        try {
          from = parseLocalDate(query.from);
        } catch {
          issues.push({ path: 'from', message: M.startDateInvalid });
        }
        try {
          to = parseLocalDate(query.to);
        } catch {
          issues.push({ path: 'to', message: M.endDateInvalid });
        }
        for (const issue of issues) {
          ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
        }
        if (from === undefined || to === undefined) return z.NEVER;
        return { format: query.format, period: { kind: 'custom', range: { from, to } } };
      }
      case 'gst': {
        const cadence = GST_CADENCE_WIRE[query.cadence];
        try {
          const range = gstPeriodEndingIn(query.end, GST_CADENCES[cadence]);
          // A period ending outside `EXPORT_YEARS` is unknown, like a financial year outside it.
          const endYear = Number(query.end.slice(0, 4));
          if (endYear < EXPORT_YEARS.first || endYear > EXPORT_YEARS.last)
            throw new RangeError(query.end);
          return { format: query.format, period: { kind: 'gst', cadence, range } };
        } catch {
          ctx.addIssue({ code: 'custom', path: ['end'], message: M.periodEndInvalid });
          return z.NEVER;
        }
      }
      case 'fy': {
        try {
          return {
            format: query.format,
            period: { kind: 'fy', startYear: parseFinancialYear(query.year) },
          };
        } catch {
          ctx.addIssue({ code: 'custom', path: ['year'], message: M.financialYearInvalid });
          return z.NEVER;
        }
      }
    }
  });

/**
 * A preset period that has not started yet is "unknown" for its field (algorithm validation step 4): a financial year whose
 * 1 April is after `today` on `year`, a GST period whose first day is after `today` on `end`. A custom range is checked by
 * `validateExportRange` instead (a start in the future, with its own message), so it is never refused here.
 */
export function futurePeriodIssue(
  period: ResolvedPeriodRequest,
  today: LocalDate,
): { readonly field: 'year' | 'end'; readonly message: string } | null {
  if (period.kind === 'fy' && financialYear(period.startYear).from > today) {
    return { field: 'year', message: M.financialYearNotStarted };
  }
  if (period.kind === 'gst' && period.range.from > today) {
    return { field: 'end', message: M.periodNotStarted };
  }
  return null;
}

/** The export's 200 answer carries the number of data rows, so the page can say "No paid payments in this period" (UI/UX A4). */
export const INCOME_EXPORT_ROW_COUNT_HEADER = 'x-export-row-count';

/**
 * The export route's querystring: a FLAT object (every period's keys optional) piped into `IncomeExportQuery`. Validation and
 * the resolved output are exactly the union's; the flat input side exists so the generated OpenAPI lists each parameter with
 * its real type and optionality (a union querystring is flattened wrongly by the OpenAPI generator).
 */
export const IncomeExportQueryString = z
  .strictObject({
    format: ExportFormat,
    period: z.enum(['custom', 'gst', 'fy'], { error: M.periodTypeInvalid }),
    /** `period=custom`: the first day, `YYYY-MM-DD` (NZ). */
    from: z.string().optional(),
    /** `period=custom`: the last day, `YYYY-MM-DD` (NZ), included. */
    to: z.string().optional(),
    /** `period=gst`: how often the team files GST. */
    cadence: z.enum(['2m-odd', '2m-even', '6m-mar-sep']).optional(),
    /** `period=gst`: the month the GST period ends, `YYYY-MM`. */
    end: z.string().optional(),
    /** `period=fy`: the financial year, `2026-27` (1 April 2026 to 31 March 2027). */
    year: z.string().optional(),
  })
  .pipe(IncomeExportQuery);

const localDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** `GET /teams/:teamId/exports/income/periods`: what the form needs to list its options (the lists are built by `tax/`). */
export const IncomeExportPeriodsResponse = z.object({
  /** The API clock's NZ local date, so the form and the E2E clock agree. */
  today: localDateString,
  /** The NZ date of the team's first PAID payment, or null when it has none. */
  firstPaidDate: localDateString.nullable(),
  /** Financial-year start years that contain at least one PAID payment. */
  financialYearsWithPayments: z.array(z.number().int()),
  /** `INCOME_EXPORT_MAX_ROWS`: a range with more PAID payments is refused with 422 `export_too_large`. */
  maxRows: z.number().int().positive(),
  /** The longest custom range in days, both ends included (R3: 2,557, 7 years). */
  maxRangeDays: z.number().int().positive(),
});
export type IncomeExportPeriodsResponse = z.infer<typeof IncomeExportPeriodsResponse>;

/**
 * The `document` field billing responses will carry (Phase 3 adds it to `PaymentResponse`, `MyPaymentRow` and the admin
 * payments row; shared with the player-dashboard). `kind` picks the button label, `available` is true for a PAID payment
 * above $0.00 (on demand covers the gap before issuance), `number` is the frozen printed number once issued.
 */
export const PaymentDocumentRef = z.strictObject({
  kind: z.enum(PaymentDocumentKind),
  available: z.boolean(),
  number: z.string().nullable(),
});
export type PaymentDocumentRef = z.infer<typeof PaymentDocumentRef>;
