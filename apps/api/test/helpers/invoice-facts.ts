import { parseMoney, toMoneyString } from '@sgm/shared';
import type { DocumentFacts } from '../../src/modules/invoices/document.ts';

const money = (text: string) => toMoneyString(parseMoney(text));

/** AC-HAPPY-1: Hōkio Badminton Club, GST 49091850, Aroha Ngata's $23.00 game fee, issued 3 June 2027. */
export function taxInvoiceFacts(overrides: Partial<DocumentFacts> = {}): DocumentFacts {
  return {
    kind: 'TAX_INVOICE',
    numberDisplay: 'INV-000001',
    issuedAt: new Date('2027-06-03T01:00:00Z'),
    paidAt: new Date('2027-06-02T22:00:00Z'),
    layoutVersion: 1,
    supplierName: 'Hōkio Badminton Club',
    gstNumber: '49091850',
    rateBps: 1500,
    buyerName: 'Aroha Ngata',
    sessionLocation: 'Hōkio Sports Hall',
    sessionStartsAt: new Date('2027-06-03T07:30:00Z'),
    chargeReason: 'GAME_FEE',
    lines: [{ position: 0, unitFee: money('23.00') }],
    subtotalAmount: money('20.00'),
    gstAmount: money('3.00'),
    amount: money('23.00'),
    ...overrides,
  };
}
