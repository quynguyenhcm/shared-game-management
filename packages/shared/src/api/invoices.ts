/**
 * Contracts for payment documents (tax invoices and receipts) and the income exports (tax-invoices-and-exports,
 * architecture Decision 4 and algorithm "Export request and resolution"), shared by the Fastify routes and the web.
 *
 * Phase 1 defines the shapes only: no route is registered here. The export query is a strict discriminated union on `period`
 * that the SERVER resolves with the shared `tax/` helpers, so there is one range semantics, an unknown financial year is an
 * API 422 and the label in a file is always true. Checks that need today's date (a start in the future, the 7-year limit)
 * are `validateExportRange`, run by the route with its one clock read. Messages never echo input.
 */
import { z } from 'zod';
import {
  GST_CADENCES,
  gstPeriodEndingIn,
  parseFinancialYear,
  type GstCadenceId,
  type ResolvedPeriodRequest,
} from '../tax/periods.ts';
import { parseLocalDate } from '../time/time.ts';
import { PaymentDocumentKind } from '../types/enums.ts';

export const INVOICE_FIELD_MESSAGES = {
  formatInvalid: 'Choose CSV or Excel.',
  startDateInvalid: 'Enter a valid start date as YYYY-MM-DD.',
  endDateInvalid: 'Enter a valid end date as YYYY-MM-DD.',
  cadenceInvalid: 'Choose how often you file GST.',
  periodEndInvalid: 'Choose a month that ends a GST period.',
  financialYearInvalid: 'Choose a financial year like 2026-27.',
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

const localDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** `GET /teams/:teamId/exports/income/periods`: what the form needs to list its options (the lists are built by `tax/`). */
export const IncomeExportPeriodsResponse = z.object({
  /** The API clock's NZ local date, so the form and the E2E clock agree. */
  today: localDateString,
  /** The NZ date of the team's first PAID payment, or null when it has none. */
  firstPaidDate: localDateString.nullable(),
  /** Financial-year start years that contain at least one PAID payment. */
  financialYearsWithPayments: z.array(z.number().int()),
});
export type IncomeExportPeriodsResponse = z.infer<typeof IncomeExportPeriodsResponse>;

/**
 * The `document` field billing responses will carry (Phase 3 adds it to `PaymentResponse`, `MyPaymentRow` and the admin
 * payments row; shared with the player-dashboard). `kind` picks the button label, `available` is true for a PAID payment
 * above $0.00 (on demand covers the gap before issuance), `number` is the frozen printed number once issued.
 */
export const PaymentDocumentRef = z.object({
  kind: z.enum(PaymentDocumentKind),
  available: z.boolean(),
  number: z.string().nullable(),
});
export type PaymentDocumentRef = z.infer<typeof PaymentDocumentRef>;
