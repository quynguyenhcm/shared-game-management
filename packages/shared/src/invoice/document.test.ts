import { describe, expect, it } from 'vitest';
import { parseMoney, toMoneyString } from '../money/money.ts';
import { PaymentDocumentKind } from '../types/enums.ts';
import { documentKindOf, formatDocumentNumber, isDocumentAvailable } from './document.ts';
import { formatInvoiceNumber } from './invoice.ts';

describe('payment documents (H2: tax invoice or receipt, separate series)', () => {
  it('derives the kind from the charge-time GST snapshot and prints a prefixed six-digit number per series', () => {
    expect([...PaymentDocumentKind]).toEqual(['TAX_INVOICE', 'RECEIPT']);
    expect(documentKindOf(true)).toBe('TAX_INVOICE');
    expect(documentKindOf(false)).toBe('RECEIPT');
    expect(formatDocumentNumber('TAX_INVOICE', 1)).toBe('INV-000001');
    expect(formatDocumentNumber('RECEIPT', 1)).toBe('RCT-000001');
    expect(formatDocumentNumber('RECEIPT', 1_234_567)).toBe('RCT-1234567');
    // The tax-invoice formatter stays the same function behind the older name.
    expect(formatInvoiceNumber(123)).toBe(formatDocumentNumber('TAX_INVOICE', 123));
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => formatDocumentNumber('RECEIPT', bad), String(bad)).toThrow(RangeError);
    }
  });

  it('is available only for a PAID payment above $0.00 (AC-ERROR-1, AC-ERROR-5), whichever way it was paid', () => {
    const paid = toMoneyString(parseMoney('23.00'));
    expect(isDocumentAvailable('PAID', paid)).toBe(true);
    for (const status of ['PENDING', 'OVERDUE', 'FAILED'] as const) {
      expect(isDocumentAvailable(status, paid), status).toBe(false);
    }
    expect(isDocumentAvailable('PAID', toMoneyString(parseMoney('0.00')))).toBe(false);
  });
});
