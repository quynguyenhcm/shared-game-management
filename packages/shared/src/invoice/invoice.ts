/** Tax-invoice numbering display form (algorithm doc §Q9): the per-team counter value as INV-000123. */
export function formatInvoiceNumber(invoiceNumber: number): string {
  if (!Number.isInteger(invoiceNumber) || invoiceNumber < 1) {
    throw new RangeError('invoice number must be a positive integer');
  }
  return `INV-${String(invoiceNumber).padStart(6, '0')}`;
}
