import { describe, expect, it } from 'vitest';
import { formatInvoiceNumber } from './invoice.ts';

describe('formatInvoiceNumber', () => {
  it('zero-pads to six digits with the INV- prefix', () => {
    expect(formatInvoiceNumber(123)).toBe('INV-000123');
    expect(formatInvoiceNumber(1)).toBe('INV-000001');
    expect(formatInvoiceNumber(999_999)).toBe('INV-999999');
    expect(formatInvoiceNumber(1_234_567)).toBe('INV-1234567');
  });

  it('rejects non-positive or non-integer numbers', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => formatInvoiceNumber(bad), String(bad)).toThrow(RangeError);
    }
  });
});
