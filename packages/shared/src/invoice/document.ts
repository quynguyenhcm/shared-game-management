import { isZero, parseMoney, type MoneyString } from '../money/money.ts';
import type { PaymentDocumentKind, PaymentStatus } from '../types/enums.ts';

/**
 * The kind of document a payment gets (H2, ADR 0021): a tax invoice when the charge-time snapshot says the team was
 * GST-registered, otherwise a receipt. It follows `payments.gst_registered`, which is immutable, so the kind can never
 * disagree with the GST lines. SQL twin: `payment_document_kind_of`.
 */
export function documentKindOf(gstRegistered: boolean): PaymentDocumentKind {
  return gstRegistered ? 'TAX_INVOICE' : 'RECEIPT';
}

const PREFIX: Readonly<Record<PaymentDocumentKind, string>> = {
  TAX_INVOICE: 'INV',
  RECEIPT: 'RCT',
};

/**
 * The printed number of a document: the per-team counter value of its series, zero-padded to six digits with the series
 * prefix (`INV-000123`, `RCT-000123`); a wider number is printed in full. SQL twin: `format_document_number`.
 */
export function formatDocumentNumber(kind: PaymentDocumentKind, documentNumber: number): string {
  if (!Number.isInteger(documentNumber) || documentNumber < 1) {
    throw new RangeError('document number must be a positive integer');
  }
  return `${PREFIX[kind]}-${String(documentNumber).padStart(6, '0')}`;
}

/**
 * Whether a document exists, or can be issued on demand, for a payment: only a PAID payment above $0.00 (AC-ERROR-1,
 * AC-ERROR-5). The same rule the database enforces with `payments_invoice_requires_paid`.
 */
export function isDocumentAvailable(status: PaymentStatus, amount: MoneyString): boolean {
  return status === 'PAID' && !isZero(parseMoney(amount));
}
