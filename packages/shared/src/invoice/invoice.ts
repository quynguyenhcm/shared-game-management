import { formatDocumentNumber } from './document.ts';

/** Tax-invoice numbering display form (algorithm doc §Q9): the per-team counter value as INV-000123. */
export function formatInvoiceNumber(invoiceNumber: number): string {
  return formatDocumentNumber('TAX_INVOICE', invoiceNumber);
}
