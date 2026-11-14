/**
 * The invoices module's database access (tax-invoices-and-exports; ADR 0021 section 9). This is the ONLY TypeScript file that
 * calls the SQL issuer; `modules/invoices/boundaries.test.ts` proves it, and proves nothing else writes the numbering tables or
 * the invoice columns of `payments`. Everything else here is a read.
 *
 * Issuing one payment is one short transaction: `SET LOCAL lock_timeout`, one call of the SQL function (which locks the payment
 * row, then the team's counter row of the document's series, snapshots the facts and writes the immutable document), COMMIT. The
 * allocation is therefore the last locking step before COMMIT (ADR 0011), and a crash before COMMIT rolls the counter back.
 * Money stays a `MoneyString`; nothing here computes with it.
 */
import { sql } from 'kysely';
import type { MoneyString, PaymentStatus } from '@sgm/shared';
import type { Database } from '../../lib/db/kysely.ts';

/** How long one issuing transaction waits for a lock before SQLSTATE 55P03 (a longer wait would stall a whole team's series). */
export const ISSUE_LOCK_TIMEOUT_MS = 5000;

export interface IssuedDocument {
  /** The printed number (`INV-000123` / `RCT-000123`). Never logged. */
  readonly numberDisplay: string;
  /** False when the document already existed (the losing racer, a redelivered job, a repeat request). */
  readonly issued: boolean;
}

export interface IssueOptions {
  readonly lockTimeoutMs?: number;
}

/** Issues the payment's document in its own transaction. Idempotent: an existing document is returned with `issued = false`. */
export async function issuePaymentDocument(
  db: Database,
  paymentId: string,
  options: IssueOptions = {},
): Promise<IssuedDocument> {
  const lockTimeoutMs = options.lockTimeoutMs ?? ISSUE_LOCK_TIMEOUT_MS;
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
    throw new RangeError('lockTimeoutMs must be a positive integer');
  }
  return db.transaction().execute(async (trx) => {
    // The value is a checked integer, so inlining it is safe (SET cannot take a bind parameter).
    await sql.raw(`SET LOCAL lock_timeout = ${lockTimeoutMs}`).execute(trx);
    const { rows } = await sql<{ number_display: string; issued: boolean }>`
      SELECT number_display, issued FROM issue_payment_document(${paymentId}::uuid)`.execute(trx);
    const row = rows[0];
    if (row === undefined) throw new Error('issue_payment_document returned no row');
    return { numberDisplay: row.number_display, issued: row.issued };
  });
}

/** What the service needs to decide whether, and how, a payment is issued. */
export interface PaymentForIssue {
  readonly id: string;
  readonly teamId: string;
  readonly status: PaymentStatus;
  readonly amount: MoneyString;
  /** The charge-time snapshot: it decides the document kind. */
  readonly gstRegistered: boolean;
  /** The frozen printed number when a document exists, else null. */
  readonly numberDisplay: string | null;
}

/** A plain read (no lock): the payment's issuing facts and its document number, if any. */
export async function readPaymentForIssue(
  db: Database,
  paymentId: string,
): Promise<PaymentForIssue | undefined> {
  const row = await db
    .selectFrom('payments as p')
    .leftJoin('payment_documents as d', 'd.payment_id', 'p.id')
    .select(['p.id', 'p.team_id', 'p.status', 'p.amount', 'p.gst_registered', 'd.number_display'])
    .where('p.id', '=', paymentId)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : {
        id: row.id,
        teamId: row.team_id,
        status: row.status,
        amount: row.amount,
        gstRegistered: row.gst_registered,
        numberDisplay: row.number_display,
      };
}

export interface UnissuedPayment {
  readonly id: string;
  readonly gstRegistered: boolean;
}

/**
 * The team's next payment that needs a document, in `(paid_at, id)` order, skipping the ids that failed in this run: PAID, above
 * $0.00 and unnumbered (the predicate of `idx_payments_unissued`, which serves this query). Paid order is what makes a backfill
 * number the oldest payment first.
 */
export async function nextUnissuedPayment(
  db: Database,
  teamId: string,
  skipIds: readonly string[],
): Promise<UnissuedPayment | undefined> {
  let query = db
    .selectFrom('payments')
    .select(['id', 'gst_registered'])
    .where('team_id', '=', teamId)
    .where('status', '=', 'PAID')
    .where('invoice_number', 'is', null)
    .where(sql<boolean>`amount > 0.00`);
  if (skipIds.length > 0) query = query.where('id', 'not in', [...skipIds]);
  const row = await query.orderBy('paid_at').orderBy('id').limit(1).executeTakeFirst();
  return row === undefined ? undefined : { id: row.id, gstRegistered: row.gst_registered };
}

/** Teams that have at least one unissued payment, ordered by id, `limit` at a time after `after` (the sweep's keyset page). */
export async function listTeamsWithUnissuedPayments(
  db: Database,
  page: { readonly after?: string; readonly limit: number },
): Promise<string[]> {
  let query = db
    .selectFrom('payments')
    .select('team_id')
    .distinct()
    .where('status', '=', 'PAID')
    .where('invoice_number', 'is', null)
    .where(sql<boolean>`amount > 0.00`);
  if (page.after !== undefined) query = query.where('team_id', '>', page.after);
  const rows = await query.orderBy('team_id').limit(page.limit).execute();
  return rows.map((row) => row.team_id);
}
