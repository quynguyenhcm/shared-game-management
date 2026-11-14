/**
 * The income export use cases (tax-invoices-and-exports Phase 4; AC-HAPPY-6, 7, 8, 9, AC-ERROR-3, 4, AC-VERIFY-2, 3, 5;
 * algorithm "Algorithm Steps"; CR-3). The team-admin guard has already run (`routes.ts`).
 *
 * `exportIncome`:
 *   1. reads the clock ONCE and validates the resolved period against today (end before start, a start in the future, more than
 *      2,557 days, a preset period that has not started): 422 `validation_failed` with the field, before any query;
 *   2. takes a slot of the export semaphore (one per team, `maxConcurrent` per process) or answers 429 `export_busy`;
 *   3. converts the NZ-local range with `toInstantRange` (the one P3 conversion) and reads preflight + rows in one snapshot
 *      (`repo.ts`): over `maxRows` (or a sum outside the `Money` range) is 422 `export_too_large` before any row is read; the
 *      file is built page by page under `maxBytes` (past it: 422 `export_too_large`, never a truncated file);
 *   4. re-proves the rows against the preflight (`Reconciler`) and returns the complete buffered file, so a failure is a clean
 *      error and never a partial download.
 * The client going away aborts `signal`, which cancels the Postgres statement and frees the slot (`ExportCancelledError`).
 * Logs carry the team id, the period type, the format, a count or a refusal reason only: never a name or an amount.
 */
import { trace } from '@opentelemetry/api';
import {
  INCOME_EXPORT_COLUMNS,
  INCOME_EXPORT_SUMMARY_LABELS,
  MAX_RANGE_DAYS,
  MoneyValidationError,
  describePeriod,
  financialYearOf,
  financialYear,
  futurePeriodIssue,
  instantToLocal,
  parseMoney,
  toInstantRange,
  validateExportRange,
  type IncomeExportPeriodsResponse,
  type IncomeExportRequest,
  type PeriodDescriptor,
} from '@sgm/shared';
import type { Clock } from '../../lib/clock.ts';
import type { IncomeExportsConfig } from '../../lib/config/config.ts';
import type { BackendCanceller } from '../../lib/db/cancel.ts';
import type { Database } from '../../lib/db/kysely.ts';
import { AppError } from '../../lib/http/errors.ts';
import type { Logger } from '../../lib/logger/logger.ts';
import { TabularTooLargeError, type TabularRow } from '../../lib/tabular/cells.ts';
import { createCsvWriter } from '../../lib/tabular/csv.ts';
import { createXlsxWriter } from '../../lib/tabular/xlsx.ts';
import {
  ExportCancelledError,
  rangesWithPayments,
  readFirstPaidAt,
  readIncomeRows,
  readTeamGstNumber,
  readTeamName,
} from './repo.ts';
import {
  Reconciler,
  exportFilename,
  summaryRows,
  toExportRow,
  type ExportSummary,
} from './rows.ts';
import type { ExportSemaphore } from './semaphore.ts';

export { ExportCancelledError } from './repo.ts';

export type ExportLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

/** Seconds a refused (busy) caller is told to wait before trying again. */
export const EXPORT_BUSY_RETRY_SECONDS = 10;

export interface IncomeExportServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly limits: IncomeExportsConfig;
  readonly semaphore: ExportSemaphore;
  /** Cancels a running export statement on its own connection, never the app pool (`createBackendCanceller`). */
  readonly cancelBackend: BackendCanceller;
  /** Test seam: runs after the preflight and before the cursor (proves the one-snapshot rule). `buildApp` never passes it. */
  readonly afterPreflight?: () => Promise<void>;
}

export interface IncomeExportFile {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly contentType: string;
  /** Data rows in the file. */
  readonly rows: number;
}

export interface ExportContext {
  readonly log: ExportLogger;
  /** Aborted when the client goes away. */
  readonly signal: AbortSignal;
}

export interface IncomeExportService {
  exportIncome(
    teamId: string,
    request: IncomeExportRequest,
    context: ExportContext,
  ): Promise<IncomeExportFile>;
  listPeriods(teamId: string): Promise<IncomeExportPeriodsResponse>;
}

/** Why an export was refused as too large: the row cap, the byte cap, or a sum outside the `Money` range. */
type RefusalReason = 'rows' | 'bytes' | 'money_range';

class ExportTooLargeError extends Error {
  readonly reason: RefusalReason;

  constructor(reason: RefusalReason) {
    super('The export is too large.');
    this.name = 'ExportTooLargeError';
    this.reason = reason;
  }
}

/** One file being built: CSV, or XLSX with a "Payments" sheet now and a "Summary" sheet at the end. */
interface FileBuilder {
  readonly contentType: string;
  readonly extension: 'csv' | 'xlsx';
  writeRows(rows: readonly TabularRow[]): void;
  finish(summary: readonly TabularRow[]): Uint8Array;
}

const HEADER = INCOME_EXPORT_COLUMNS.map((column) => column.header);

function createFileBuilder(format: 'csv' | 'xlsx', maxBytes: number): FileBuilder {
  if (format === 'csv') {
    const csv = createCsvWriter({ header: HEADER, maxBytes });
    return {
      contentType: csv.contentType,
      extension: csv.extension,
      writeRows: (rows) => csv.writeRows(rows),
      // A CSV is a pure table: the totals live in the XLSX Summary sheet only (algorithm D4).
      finish: () => csv.finish(),
    };
  }
  const xlsx = createXlsxWriter({ maxBytes });
  xlsx.startSheet(INCOME_EXPORT_SUMMARY_LABELS.paymentsSheet, HEADER);
  return {
    contentType: xlsx.contentType,
    extension: xlsx.extension,
    writeRows: (rows) => xlsx.writeRows(rows),
    finish(summary) {
      xlsx.startSheet(INCOME_EXPORT_SUMMARY_LABELS.summarySheet, [
        INCOME_EXPORT_SUMMARY_LABELS.item,
        INCOME_EXPORT_SUMMARY_LABELS.value,
      ]);
      xlsx.writeRows(summary);
      return xlsx.finish();
    },
  };
}

/** 422 `validation_failed` on one field, or nothing. Uses `today` from the request's one clock read. */
function validatePeriod(
  request: IncomeExportRequest,
  today: ReturnType<typeof instantToLocal>['date'],
): void {
  const issue =
    request.period.kind === 'custom'
      ? validateExportRange(request.period.range, today)
      : futurePeriodIssue(request.period, today);
  if (issue !== null) {
    throw new AppError('validation_failed', { fieldErrors: { [issue.field]: [issue.message] } });
  }
}

/** Every `Money` sum must parse (a team cannot exceed the `Money` range in practice; refuse rather than misprint). */
function assertSummaryInRange(summary: ExportSummary): void {
  try {
    parseMoney(summary.total);
    parseMoney(summary.subtotal);
    parseMoney(summary.gst);
  } catch (error) {
    if (error instanceof MoneyValidationError) throw new ExportTooLargeError('money_range');
    throw error;
  }
}

const tracer = trace.getTracer('sgm-api');

export function createIncomeExportService(deps: IncomeExportServiceDeps): IncomeExportService {
  /** Builds the file; any growth past the byte cap (the XLSX header included) becomes `ExportTooLargeError('bytes')`. */
  async function build(
    teamId: string,
    teamName: string,
    request: IncomeExportRequest,
    period: PeriodDescriptor,
    generatedAt: Date,
    signal: AbortSignal,
  ): Promise<IncomeExportFile> {
    try {
      const file = createFileBuilder(request.format, deps.limits.maxBytes);
      const reconciler = new Reconciler();
      let summary: ExportSummary | undefined;
      await readIncomeRows(
        deps.db,
        { teamId, range: toInstantRange(period.range), signal, cancel: deps.cancelBackend },
        {
          async onPreflight(pre) {
            if (pre.rows > deps.limits.maxRows) throw new ExportTooLargeError('rows');
            assertSummaryInRange(pre);
            summary = pre;
            await deps.afterPreflight?.();
          },
          onPage(rows) {
            for (const row of rows) reconciler.add(row);
            file.writeRows(rows.map(toExportRow));
          },
        },
      );
      if (summary === undefined) throw new Error('The export preflight did not run.');
      reconciler.assertEquals(summary);
      // An empty period names no GST number; fall back to the team's current registration. A period
      // with payments keeps what they recorded, so receipts from before registration print none.
      const currentGst = summary.rows === 0 ? await readTeamGstNumber(deps.db, teamId) : null;
      if (currentGst !== null) summary = { ...summary, gstNumbers: [currentGst] };
      const bytes = file.finish(summaryRows({ teamName, period, summary, generatedAt }));
      return {
        bytes,
        filename: exportFilename(teamName, period, file.extension),
        contentType: file.contentType,
        rows: summary.rows,
      };
    } catch (error) {
      if (error instanceof TabularTooLargeError) throw new ExportTooLargeError('bytes');
      throw error;
    }
  }

  return {
    async exportIncome(teamId, request, { log, signal }) {
      const now = deps.clock.now();
      validatePeriod(request, instantToLocal(now).date);
      const period = describePeriod(request.period);
      const release = deps.semaphore.tryAcquire(teamId);
      if (release === null) {
        log.info({ event: 'income_export.refused', teamId, reason: 'busy' }, 'income export busy');
        throw new AppError('export_busy', { retryAfterSeconds: EXPORT_BUSY_RETRY_SECONDS });
      }
      try {
        // The guard proved the caller is this team's admin, so the team exists.
        const teamName = (await readTeamName(deps.db, teamId)) ?? '';
        const file = await tracer.startActiveSpan('income_export.generate', async (span) => {
          span.setAttribute('format', request.format);
          try {
            const built = await build(teamId, teamName, request, period, now, signal);
            span.setAttribute('rows', built.rows);
            return built;
          } finally {
            span.end();
          }
        });
        log.info(
          {
            event: 'income_export.generated',
            teamId,
            periodType: period.kind,
            format: request.format,
            rows: file.rows,
          },
          'income export generated',
        );
        return file;
      } catch (error) {
        if (error instanceof ExportTooLargeError) {
          log.info(
            { event: 'income_export.refused', teamId, reason: error.reason },
            'income export refused',
          );
          throw new AppError('export_too_large');
        }
        if (error instanceof ExportCancelledError) {
          log.info({ event: 'income_export.cancelled', teamId }, 'income export cancelled');
        }
        throw error;
      } finally {
        release();
      }
    },

    async listPeriods(teamId) {
      const today = instantToLocal(deps.clock.now()).date;
      const firstPaidAt = await readFirstPaidAt(deps.db, teamId);
      const firstPaidDate = firstPaidAt === null ? null : instantToLocal(firstPaidAt).date;
      const years: { id: number; range: ReturnType<typeof toInstantRange> }[] = [];
      if (firstPaidDate !== null) {
        for (let year = financialYearOf(firstPaidDate); year <= financialYearOf(today); year += 1) {
          years.push({ id: year, range: toInstantRange(financialYear(year)) });
        }
      }
      return {
        today,
        firstPaidDate,
        financialYearsWithPayments: await rangesWithPayments(deps.db, teamId, years),
        maxRows: deps.limits.maxRows,
        maxRangeDays: MAX_RANGE_DAYS,
      };
    },
  };
}
