/**
 * The income export routes (tax-invoices-and-exports Phase 4; AC-ENTRY-2, AC-HAPPY-6..9, AC-ERROR-2, 3, 4, AC-VERIFY-6; CR-3):
 *
 *   GET /teams/:teamId/exports/income ............ requireTeamRole('TEAM_ADMIN'), no GLOBAL_ADMIN (H9)
 *   GET /teams/:teamId/exports/income/periods .... same
 *
 * The guard answers 401 and 403 in `onRequest`, before the query is parsed or any row is read, so a plain member, another
 * team's admin and a global admin who is not this team's admin learn nothing about the input or the data. Every answer, errors
 * included, carries `cache-control: no-store`. The file is sent complete (buffered) with an exact `content-length`, an ASCII
 * `attachment` file name and `x-content-type-options: nosniff`, plus `x-export-row-count` for the page's status line.
 *
 * Cancellation: when the client disconnects before the answer is sent, the export's `AbortSignal` fires, which cancels the
 * Postgres statement and frees the export slot; the request then ends with 499 (nobody is listening) and is logged as
 * `income_export.cancelled`.
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ErrorResponse,
  INCOME_EXPORT_ROW_COUNT_HEADER,
  IncomeExportPeriodsResponse,
  IncomeExportQueryString,
  TeamIdParams,
} from '@sgm/shared';
import { requireTeamRole } from '../../lib/auth/policy.ts';
import { attachmentDisposition } from '../../lib/http/content-disposition.ts';
import {
  ExportCancelledError,
  type IncomeExportFile,
  type IncomeExportService,
} from './service.ts';

export interface IncomeExportRoutesOptions {
  readonly service: IncomeExportService;
}

/** nginx's "client closed request": the answer of an export whose client went away (never read by anyone). */
const CLIENT_CLOSED_REQUEST = 499;

/** The 200 answer, for OpenAPI only: the bytes are sent as a Buffer, which bypasses the JSON serializer. */
const FILE_OK = {
  description:
    'The income export as an attachment: `text/csv; charset=utf-8` (UTF-8 with a byte-order mark, CRLF, RFC 4180) or an `.xlsx` workbook with a "Payments" sheet and a "Summary" sheet. `content-disposition: attachment; filename="income_<team>_<period>.<csv|xlsx>"`, an exact `content-length`, `x-export-row-count` (data rows), `cache-control: no-store`.',
  content: {
    'text/csv': { schema: z.string().meta({ format: 'binary' }) },
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
      schema: z.string().meta({ format: 'binary' }),
    },
  },
} as const;

/** Sends the complete file. A plain `FastifyReply`: the bytes bypass the JSON serializer (the 200 schema is OpenAPI-only). */
function sendFile(reply: FastifyReply, file: IncomeExportFile): FastifyReply {
  return reply
    .type(file.contentType)
    .header('content-disposition', attachmentDisposition(file.filename))
    .header('content-length', file.bytes.length)
    .header('x-content-type-options', 'nosniff')
    .header(INCOME_EXPORT_ROW_COUNT_HEADER, String(file.rows))
    .send(Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength));
}

/** Ends an export whose client went away; nobody reads this answer. */
function sendClientClosed(reply: FastifyReply): FastifyReply {
  return reply.code(CLIENT_CLOSED_REQUEST).send();
}

const GUARDED = { 401: ErrorResponse, 403: ErrorResponse } as const;

const ACCESS =
  'TEAM_ADMIN of this team only (`allowGlobalAdmin` is off, H9): a plain member, an admin of another team and a GLOBAL_ADMIN who is not an admin of this team get 403 before the query is read.';

export const incomeExportRoutes: FastifyPluginAsync<IncomeExportRoutesOptions> = (app, options) => {
  const { service } = options;
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const policy = requireTeamRole('TEAM_ADMIN');

  // Who paid the team what is personal and financial information: nothing here is cacheable, whatever the status.
  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  typed.get(
    '/:teamId/exports/income',
    {
      config: { policy },
      schema: {
        summary: "Export the team's income (PAID payments) as CSV or Excel (team admin)",
        description: `The team's PAID payments whose paid date (Pacific/Auckland) falls in the period, both ends included, ordered by paid time, then invoice number (blank last), then id. \`period=custom&from=YYYY-MM-DD&to=YYYY-MM-DD\`, \`period=gst&cadence=2m-odd|2m-even|6m-mar-sep&end=YYYY-MM\` (the month the GST period ends) or \`period=fy&year=2026-27\` (1 April to 31 March), with \`format=csv|xlsx\`. Columns: invoice number, paid date, game date, player, description, subtotal, GST, total, GST registered, paid by, reference (stored amounts, never recomputed; no contact detail, bank detail or payment-provider id). A $0.00 payment is listed with a blank number. The Excel file adds a Summary sheet whose totals equal the rows. 422 \`validation_failed\` with \`fieldErrors\` for an end before the start, an impossible date, a range over 2,557 days, a start in the future, a period that has not started, an unknown format, cadence, period end or financial year, or an unknown key; a valid range with nothing paid is a file with only the header (and a zero Summary). 422 \`export_too_large\` ("Choose a shorter range.") when the range holds more rows than \`INCOME_EXPORT_MAX_ROWS\` or the file would pass \`INCOME_EXPORT_MAX_BYTES\`: never a truncated file. 429 \`export_busy\` (with \`retry-after\`) while this team already has an export running or the server's export limit is reached. ${ACCESS}`,
        operationId: 'exportTeamIncome',
        params: TeamIdParams,
        querystring: IncomeExportQueryString,
        response: {
          200: FILE_OK,
          ...GUARDED,
          422: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const controller = new AbortController();
      const onClose = (): void => {
        if (!reply.raw.writableFinished) controller.abort();
      };
      reply.raw.once('close', onClose);
      try {
        const file = await service.exportIncome(request.params.teamId, request.query, {
          log: request.log,
          signal: controller.signal,
        });
        return await sendFile(reply, file);
      } catch (error) {
        if (error instanceof ExportCancelledError) return await sendClientClosed(reply);
        throw error;
      } finally {
        reply.raw.off('close', onClose);
      }
    },
  );

  typed.get(
    '/:teamId/exports/income/periods',
    {
      config: { policy },
      schema: {
        summary: 'What the income export form can offer (team admin)',
        description: `\`today\` (the API clock's New Zealand date), \`firstPaidDate\` (the New Zealand date of the team's first PAID payment, or null), \`financialYearsWithPayments\` (start years of the financial years holding at least one PAID payment, oldest first; the form adds the current year), \`maxRows\` (\`INCOME_EXPORT_MAX_ROWS\`) and \`maxRangeDays\` (2,557). The GST period lists are built from these by the shared \`tax/\` helpers, so the form and the API cannot disagree. ${ACCESS}`,
        operationId: 'listIncomeExportPeriods',
        params: TeamIdParams,
        response: { 200: IncomeExportPeriodsResponse, ...GUARDED },
      },
    },
    async (request) => service.listPeriods(request.params.teamId),
  );

  return Promise.resolve();
};
