/**
 * Document kind and lines (tax-invoices-and-exports Phase 3; AC-HAPPY-1, 2, 3, AC-ERROR-6, AC-VERIFY-1): the pure model a layout
 * prints. Facts come from the issue-time snapshot and the payment's stored columns; nothing here is computed.
 */
import { describe, expect, it } from 'vitest';
import { toMoneyString, parseMoney } from '@sgm/shared';
import { taxInvoiceFacts } from '../../../test/helpers/invoice-facts.ts';
import { buildDocumentModel } from './document.ts';

const money = (text: string) => toMoneyString(parseMoney(text));

describe('document model', () => {
  it('builds a tax invoice from the stored figures: IRD-grouped GST number, long NZ dates, GST once (AC-HAPPY-1)', () => {
    const model = buildDocumentModel(taxInvoiceFacts());
    expect(model).toMatchObject({
      title: 'Tax invoice',
      numberLabel: 'Invoice number',
      number: 'INV-000001',
      pdfTitle: 'Tax invoice INV-000001',
      dateOfIssue: '3 June 2027',
      // paid 2027-06-02T22:00Z is 3 June 10 am in NZ, not the UTC date.
      paidOn: '3 June 2027',
      agentLine: 'Issued by Shared Game Management on behalf of Hōkio Badminton Club.',
      supplierName: 'Hōkio Badminton Club',
      gstNumberLine: 'GST number 49-091-850',
      buyerName: 'Aroha Ngata',
      gameLocation: 'Hōkio Sports Hall',
      gameWhen: 'Thursday 3 June 2027, 7:30 pm',
      amountColumnLabel: 'Amount (including GST)',
      lines: [{ description: 'Game fee, player', amount: '$23.00' }],
      totals: {
        kind: 'TAX_INVOICE',
        subtotalLabel: 'Subtotal (excluding GST)',
        subtotal: '$20.00',
        gstLabel: 'GST (15%)',
        gst: '$3.00',
        totalLabel: 'Total (including GST)',
        total: '$23.00',
        sentence: 'The total includes GST of $3.00.',
      },
    });
  });

  it('prints GST once for the whole payment and a line per guest, in position order (AC-HAPPY-2: $37.00 = $32.17 + $4.83)', () => {
    const model = buildDocumentModel(
      taxInvoiceFacts({
        lines: [
          { position: 1, unitFee: money('20.00') },
          { position: 0, unitFee: money('17.00') },
        ],
        subtotalAmount: money('32.17'),
        gstAmount: money('4.83'),
        amount: money('37.00'),
      }),
    );
    expect(model.lines).toEqual([
      { description: 'Game fee, player', amount: '$17.00' },
      { description: 'Game fee, guest 1', amount: '$20.00' },
    ]);
    expect(model.totals).toMatchObject({ subtotal: '$32.17', gst: '$4.83', total: '$37.00' });
  });

  it('prints the STORED figures even when they would not recompute from the lines (AC-VERIFY-1: never re-split)', () => {
    // A rate or rule change must not alter a printed document: the model has no arithmetic, only the stored columns.
    const model = buildDocumentModel(
      taxInvoiceFacts({
        subtotalAmount: money('19.99'),
        gstAmount: money('3.01'),
        amount: money('23.00'),
        rateBps: 1250,
      }),
    );
    expect(model.totals).toMatchObject({
      subtotal: '$19.99',
      gst: '$3.01',
      gstLabel: 'GST (12.5%)',
    });
  });

  it('makes a receipt for a non-registered snapshot: no GST number, no GST row, no tax wording anywhere (AC-HAPPY-3)', () => {
    const model = buildDocumentModel(
      taxInvoiceFacts({
        kind: 'RECEIPT',
        numberDisplay: 'RCT-000004',
        gstNumber: null,
        rateBps: 0,
        subtotalAmount: money('23.00'),
        gstAmount: money('0.00'),
      }),
    );
    expect(model.title).toBe('Receipt');
    expect(model.numberLabel).toBe('Receipt number');
    expect(model.gstNumberLine).toBeNull();
    expect(model.amountColumnLabel).toBe('Amount');
    expect(model.totals).toEqual({ kind: 'RECEIPT', totalLabel: 'Total paid', total: '$23.00' });
    const printed = [
      model.title,
      model.numberLabel,
      model.amountColumnLabel,
      model.totals.totalLabel,
      ...model.lines.map((line) => line.description),
    ].join(' ');
    expect(printed).not.toMatch(/tax|gst/i);
  });

  it('words a late-withdrawal fee as what it is, for the registrant and a guest (AC-ERROR-6)', () => {
    const model = buildDocumentModel(
      taxInvoiceFacts({
        chargeReason: 'LATE_WITHDRAWAL',
        lines: [
          { position: 0, unitFee: money('10.00') },
          { position: 1, unitFee: money('10.00') },
        ],
        amount: money('20.00'),
        subtotalAmount: money('17.39'),
        gstAmount: money('2.61'),
      }),
    );
    expect(model.lines.map((line) => line.description)).toEqual([
      'Late withdrawal fee, Hōkio Sports Hall, 3 June 2027',
      'Late withdrawal fee, guest 1, Hōkio Sports Hall, 3 June 2027',
    ]);
  });

  it('is a pure function: the same facts give an equal model (no clock, no randomness)', () => {
    expect(buildDocumentModel(taxInvoiceFacts())).toEqual(buildDocumentModel(taxInvoiceFacts()));
  });
});
