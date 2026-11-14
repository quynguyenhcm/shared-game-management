/**
 * The invoices module's READ queries for downloads (tax-invoices-and-exports Phase 3). Nothing here writes, locks or reads a
 * clock; the only writer of a document is the SQL issuer behind `repo.ts`.
 *
 * - A payment is always resolved TOGETHER with its caller: `findPayerPayment` by `(id, user_id)` (the payer's route) and
 *   `findTeamPayment` by `(id, team_id)` (the team admin's route), so another caller's payment and an unknown id are simply
 *   absent and the route answers the uniform 404 (AC-ERROR-2, AC-VERIFY-6).
 * - `readDocumentFacts` joins the issue-time snapshot (`payment_documents`) with the payment's immutable columns and lines. It
 *   selects no email address, bank detail, payment reference or Akahu column, so none can reach a document (AC-HAPPY-1).
 */
import type { Database } from '../../lib/db/kysely.ts';
import type { DocumentChargeReason, DocumentFacts } from './document.ts';

export interface ResolvedPayment {
  readonly id: string;
  readonly teamId: string;
}

/** The payer's own payment, or undefined (anyone else's payment and an unknown id look the same). */
export async function findPayerPayment(
  db: Database,
  payerId: string,
  paymentId: string,
): Promise<ResolvedPayment | undefined> {
  const row = await db
    .selectFrom('payments')
    .select(['id', 'team_id'])
    .where('id', '=', paymentId)
    .where('user_id', '=', payerId)
    .executeTakeFirst();
  return row === undefined ? undefined : { id: row.id, teamId: row.team_id };
}

/** A payment of this team, or undefined (another team's payment and an unknown id look the same). */
export async function findTeamPayment(
  db: Database,
  teamId: string,
  paymentId: string,
): Promise<ResolvedPayment | undefined> {
  const row = await db
    .selectFrom('payments')
    .select(['id', 'team_id'])
    .where('id', '=', paymentId)
    .where('team_id', '=', teamId)
    .executeTakeFirst();
  return row === undefined ? undefined : { id: row.id, teamId: row.team_id };
}

const CHARGE_REASONS: ReadonlySet<string> = new Set<DocumentChargeReason>([
  'GAME_FEE',
  'LATE_WITHDRAWAL',
]);

/** The facts an issued document is printed from, or undefined when the payment has no document yet. */
export async function readDocumentFacts(
  db: Database,
  paymentId: string,
): Promise<DocumentFacts | undefined> {
  const row = await db
    .selectFrom('payment_documents as d')
    .innerJoin('payments as p', 'p.id', 'd.payment_id')
    .select([
      'd.document_kind',
      'd.number_display',
      'd.issued_at',
      'd.layout_version',
      'd.supplier_name',
      'd.buyer_name',
      'd.session_location',
      'd.session_starts_at',
      'd.charge_reason',
      'p.gst_number',
      'p.gst_rate_bps',
      'p.paid_at',
      'p.amount',
      'p.subtotal_amount',
      'p.gst_amount',
    ])
    .where('d.payment_id', '=', paymentId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  if (row.paid_at === null) {
    // `payments_invoice_requires_paid` makes a document of an unpaid payment impossible; this is a loud backstop.
    throw new Error('A payment document exists for a payment with no paid_at.');
  }
  if (!CHARGE_REASONS.has(row.charge_reason)) {
    throw new Error('A payment document has an unknown charge reason.');
  }
  const lines = await db
    .selectFrom('payment_line_items')
    .select(['party_position', 'unit_fee'])
    .where('payment_id', '=', paymentId)
    .orderBy('party_position')
    .execute();
  return {
    kind: row.document_kind,
    numberDisplay: row.number_display,
    issuedAt: row.issued_at,
    paidAt: row.paid_at,
    layoutVersion: row.layout_version,
    supplierName: row.supplier_name,
    gstNumber: row.gst_number,
    rateBps: row.gst_rate_bps,
    buyerName: row.buyer_name,
    sessionLocation: row.session_location,
    sessionStartsAt: row.session_starts_at,
    chargeReason: row.charge_reason as DocumentChargeReason,
    lines: lines.map((line) => ({ position: line.party_position, unitFee: line.unit_fee })),
    subtotalAmount: row.subtotal_amount,
    gstAmount: row.gst_amount,
    amount: row.amount,
  };
}
