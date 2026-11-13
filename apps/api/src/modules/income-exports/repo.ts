/**
 * The income export's READ queries (tax-invoices-and-exports algorithm D3, option 3C; AC-VERIFY-2; CR-3). Nothing here writes.
 *
 * `readIncomeRows` opens ONE `REPEATABLE READ READ ONLY` transaction, so the preflight and the rows see the same snapshot:
 *   1. a preflight aggregate (count, the three sums, the per-kind counts, the distinct GST numbers), handed to `onPreflight`,
 *      which refuses an export over the row cap before any row is read;
 *   2. `DECLARE income_export NO SCROLL CURSOR` over the ordered select, then `FETCH FORWARD 1000` until a short page, each page
 *      handed to `onPage` (the caller encodes it at once, so at most one page of rows is held).
 * The filter is exactly `team_id = $team AND status = 'PAID' AND paid_at >= from AND paid_at < to` (the half-open instant range
 * of the NZ-local inclusive dates, from `toInstantRange`), ordered by `paid_at`, invoice number (nulls last), id.
 *
 * Cancellation (CR-3): when `signal` aborts, the backend running this transaction is sent `pg_cancel_backend` through
 * `input.cancel`, which opens its OWN short-lived connection (`lib/db/cancel.ts`) and never draws from the app pool: with
 * `DATABASE_POOL_MAX` at or below the active exports, the pool's connections are all held by the exports being cancelled.
 * A waiting or running statement stops at once (SQLSTATE 57014) and the transaction rolls back. The cancel is fired, never
 * awaited, so this connection is released at once; it names this transaction (pid plus `xact_start`), so a cancel that lands
 * after the connection went back to the pool matches nothing and can never reach another request's statement.
 * `statement_timeout` and `idle_in_transaction_session_timeout` are a backstop.
 *
 * Snapshot precedence: an issued payment's number, buyer name and game come from its `payment_documents` snapshot (so the
 * export matches its PDF); otherwise from the live user and game. Never selected: any contact detail, bank detail, provider id
 * or secret (see `boundaries.test.ts`).
 */
import { sql } from 'kysely';
import type { BillingType, InstantRange, MoneyString } from '@sgm/shared';
import type { BackendCanceller } from '../../lib/db/cancel.ts';
import type { Database } from '../../lib/db/kysely.ts';
import type { ExportSourceRow, ExportSummary } from './rows.ts';

/** Rows per FETCH: the most rows the API holds at once. */
export const EXPORT_PAGE_SIZE = 1000;
/** Backstop for one statement, and for the idle gaps while a page is encoded (below the web proxy's 30 s timeout). */
const EXPORT_STATEMENT_TIMEOUT_MS = 25_000;
const CURSOR = 'income_export';

/** The export was cancelled (the client went away). Nothing was produced. */
export class ExportCancelledError extends Error {
  constructor() {
    super('The export was cancelled.');
    this.name = 'ExportCancelledError';
  }
}

interface PreflightRow {
  readonly rows: number;
  readonly numbered: number;
  readonly zero: number;
  readonly awaiting: number;
  readonly total: MoneyString;
  readonly subtotal: MoneyString;
  readonly gst: MoneyString;
  readonly gst_numbers: string[] | null;
}

interface CursorRow {
  readonly id: string;
  readonly number_display: string | null;
  readonly paid_at: Date;
  readonly game_starts_at: Date | null;
  readonly payer_name: string;
  readonly location: string | null;
  readonly charge_reason: string;
  readonly guests: number;
  readonly amount: MoneyString;
  readonly subtotal_amount: MoneyString;
  readonly gst_amount: MoneyString;
  readonly gst_registered: boolean;
  readonly billing_type: BillingType;
  readonly payment_reference: string;
}

export interface IncomeRowsInput {
  readonly teamId: string;
  readonly range: InstantRange;
  readonly signal: AbortSignal;
  /** Cancels this transaction's statement on a connection outside the app pool (`createBackendCanceller`). */
  readonly cancel: BackendCanceller;
}

export interface IncomeRowsHandlers {
  /** The preflight, before any row is read. Throw to refuse (nothing has been read or produced). */
  onPreflight(summary: ExportSummary): Promise<void> | void;
  /** One ordered page of at most `EXPORT_PAGE_SIZE` rows. */
  onPage(rows: readonly ExportSourceRow[]): void;
}

function isQueryCanceled(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: unknown }).code === '57014';
}

function toSourceRow(row: CursorRow): ExportSourceRow {
  return {
    id: row.id,
    numberDisplay: row.number_display,
    paidAt: row.paid_at,
    gameStartsAt: row.game_starts_at,
    payerName: row.payer_name,
    location: row.location,
    chargeReason: row.charge_reason === 'LATE_WITHDRAWAL' ? 'LATE_WITHDRAWAL' : 'GAME_FEE',
    guests: row.guests,
    amount: row.amount,
    subtotalAmount: row.subtotal_amount,
    gstAmount: row.gst_amount,
    gstRegistered: row.gst_registered,
    billingType: row.billing_type,
    paymentReference: row.payment_reference,
  };
}

function paidInRange(db: Database, teamId: string, range: InstantRange) {
  return db
    .selectFrom('payments as p')
    .where('p.team_id', '=', teamId)
    .where('p.status', '=', 'PAID')
    .where('p.paid_at', '>=', range.from)
    .where('p.paid_at', '<', range.to);
}

/** Streams the team's PAID payments in `range` through `handlers`, inside one read-only snapshot. */
export async function readIncomeRows(
  db: Database,
  input: IncomeRowsInput,
  handlers: IncomeRowsHandlers,
): Promise<void> {
  const { signal } = input;
  if (signal.aborted) throw new ExportCancelledError();
  try {
    await db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        await sql`SELECT set_config('statement_timeout', ${String(EXPORT_STATEMENT_TIMEOUT_MS)}, true),
                         set_config('idle_in_transaction_session_timeout', ${String(EXPORT_STATEMENT_TIMEOUT_MS)}, true)`.execute(
          trx,
        );
        // `now()` is the transaction start (pg_stat_activity.xact_start), kept as text so no microsecond is lost.
        const self = (
          await sql<{
            pid: number;
            xact_start: string;
          }>`SELECT pg_backend_pid() AS pid, now()::text AS xact_start`.execute(trx)
        ).rows[0];
        let holding = true;
        const cancel = (): void => {
          if (!holding || self === undefined) return;
          // Fired, not awaited: the canceller never rejects and uses its own connection, so nothing waits on the pool.
          void input.cancel({ pid: self.pid, xactStart: self.xact_start });
        };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          if (signal.aborted) throw new ExportCancelledError();
          const pre = (await paidInRange(trx, input.teamId, input.range)
            .select([
              sql<number>`count(*)::int`.as('rows'),
              sql<number>`count(*) FILTER (WHERE p.invoice_number IS NOT NULL)::int`.as('numbered'),
              sql<number>`count(*) FILTER (WHERE p.amount = 0)::int`.as('zero'),
              sql<number>`count(*) FILTER (WHERE p.invoice_number IS NULL AND p.amount > 0)::int`.as(
                'awaiting',
              ),
              sql<MoneyString>`coalesce(sum(p.amount), 0)::numeric(20,2)::text`.as('total'),
              sql<MoneyString>`coalesce(sum(p.subtotal_amount), 0)::numeric(20,2)::text`.as(
                'subtotal',
              ),
              sql<MoneyString>`coalesce(sum(p.gst_amount), 0)::numeric(20,2)::text`.as('gst'),
              sql<
                string[] | null
              >`array_agg(DISTINCT p.gst_number ORDER BY p.gst_number) FILTER (WHERE p.gst_number IS NOT NULL)`.as(
                'gst_numbers',
              ),
            ])
            .executeTakeFirstOrThrow()) as PreflightRow;
          await handlers.onPreflight({
            rows: pre.rows,
            numbered: pre.numbered,
            zero: pre.zero,
            awaiting: pre.awaiting,
            total: pre.total,
            subtotal: pre.subtotal,
            gst: pre.gst,
            gstNumbers: pre.gst_numbers ?? [],
          });
          const query = paidInRange(trx, input.teamId, input.range)
            .leftJoin('payment_documents as d', 'd.payment_id', 'p.id')
            .innerJoin('users as u', 'u.id', 'p.user_id')
            .leftJoin('registrations as r', 'r.id', 'p.registration_id')
            .leftJoin('game_sessions as s', 's.id', 'r.session_id')
            .select([
              'p.id',
              'd.number_display',
              'p.paid_at',
              sql<Date | null>`coalesce(d.session_starts_at, s.starts_at)`.as('game_starts_at'),
              sql<string>`coalesce(d.buyer_name, u.full_name)`.as('payer_name'),
              sql<string | null>`coalesce(d.session_location, s.location)`.as('location'),
              sql<string>`coalesce(d.charge_reason, CASE WHEN r.status = 'WITHDRAWN' THEN 'LATE_WITHDRAWAL' ELSE 'GAME_FEE' END)`.as(
                'charge_reason',
              ),
              sql<number>`(SELECT count(*) FROM payment_line_items li WHERE li.payment_id = p.id AND li.party_position > 0)::int`.as(
                'guests',
              ),
              'p.amount',
              'p.subtotal_amount',
              'p.gst_amount',
              'p.gst_registered',
              'p.billing_type',
              'p.payment_reference',
            ])
            .orderBy('p.paid_at')
            .orderBy(sql`p.invoice_number ASC NULLS LAST`)
            .orderBy('p.id');
          await sql`DECLARE ${sql.raw(CURSOR)} NO SCROLL CURSOR FOR ${query}`.execute(trx);
          for (;;) {
            if (signal.aborted) throw new ExportCancelledError();
            const page =
              await sql<CursorRow>`FETCH FORWARD ${sql.raw(String(EXPORT_PAGE_SIZE))} FROM ${sql.raw(CURSOR)}`.execute(
                trx,
              );
            if (page.rows.length > 0) handlers.onPage(page.rows.map(toSourceRow));
            if (page.rows.length < EXPORT_PAGE_SIZE) break;
          }
          await sql`CLOSE ${sql.raw(CURSOR)}`.execute(trx);
        } finally {
          holding = false;
          signal.removeEventListener('abort', cancel);
        }
      });
  } catch (error) {
    if (signal.aborted && (isQueryCanceled(error) || error instanceof ExportCancelledError)) {
      throw new ExportCancelledError();
    }
    throw error;
  }
}

/** The team's current name (the Summary sheet and the file name), or undefined for an unknown team. */
export async function readTeamName(db: Database, teamId: string): Promise<string | undefined> {
  const row = await db
    .selectFrom('teams')
    .select('name')
    .where('id', '=', teamId)
    .executeTakeFirst();
  return row?.name;
}

/** The team's current GST number when it is GST-registered, else null (used only when no row names one). */
export async function readTeamGstNumber(db: Database, teamId: string): Promise<string | null> {
  const row = await db
    .selectFrom('teams')
    .select(['gst_registered', 'gst_number'])
    .where('id', '=', teamId)
    .executeTakeFirst();
  return row?.gst_registered === true ? (row.gst_number ?? null) : null;
}

/** The instant of the team's first PAID payment (an index probe on `idx_payments_team_paid_status`), or null. */
export async function readFirstPaidAt(db: Database, teamId: string): Promise<Date | null> {
  const row = await db
    .selectFrom('payments')
    .select(sql<Date | null>`min(paid_at)`.as('first'))
    .where('team_id', '=', teamId)
    .where('status', '=', 'PAID')
    .executeTakeFirst();
  return row?.first ?? null;
}

/** Which of `candidates` (each an instant range with an id) contain at least one PAID payment of the team: one query. */
export async function rangesWithPayments(
  db: Database,
  teamId: string,
  candidates: readonly { readonly id: number; readonly range: InstantRange }[],
): Promise<number[]> {
  if (candidates.length === 0) return [];
  const result = await sql<{ id: number }>`
    SELECT c.id FROM unnest(${candidates.map((c) => c.id)}::int[],
                            ${candidates.map((c) => c.range.from)}::timestamptz[],
                            ${candidates.map((c) => c.range.to)}::timestamptz[]) AS c(id, s, e)
     WHERE EXISTS (SELECT 1 FROM payments p
                    WHERE p.team_id = ${teamId} AND p.status = 'PAID' AND p.paid_at >= c.s AND p.paid_at < c.e)
     ORDER BY c.id`.execute(db);
  return result.rows.map((row) => row.id);
}
