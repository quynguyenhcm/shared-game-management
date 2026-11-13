/**
 * The accountant's specimens (tax-invoices-and-exports Phase 5; AC-VERIFY-9): the four document variants rendered from the real
 * document model and renderer. The test always asserts each is a real one-page PDF; when `SPECIMEN_DIR` is set it also writes the
 * files there for the review:
 *
 *   SPECIMEN_DIR=/some/dir pnpm exec vitest run apps/api/src/modules/invoices/specimens.test.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractText, getDocumentProxy } from 'unpdf';
import { parseMoney, toMoneyString } from '@sgm/shared';
import { taxInvoiceFacts } from '../../../test/helpers/invoice-facts.ts';
import { buildDocumentModel, type DocumentFacts } from './document.ts';
import { loadInvoiceFonts, renderDocumentPdf, type InvoiceFonts } from './render-pdf.ts';

const money = (text: string) => toMoneyString(parseMoney(text));
let fonts: InvoiceFonts;
beforeAll(async () => {
  fonts = await loadInvoiceFonts();
});

const SPECIMENS: readonly { file: string; facts: Partial<DocumentFacts>; contains: string }[] = [
  { file: 'tax-invoice-one-player.pdf', facts: {}, contains: 'INV-000001' },
  {
    file: 'tax-invoice-with-guests.pdf',
    facts: {
      numberDisplay: 'INV-000002',
      lines: [
        { position: 0, unitFee: money('23.00') },
        { position: 1, unitFee: money('23.00') },
        { position: 2, unitFee: money('23.00') },
      ],
      subtotalAmount: money('60.00'),
      gstAmount: money('9.00'),
      amount: money('69.00'),
    },
    contains: 'INV-000002',
  },
  {
    file: 'receipt-non-gst-team.pdf',
    facts: {
      kind: 'RECEIPT',
      numberDisplay: 'RCT-000001',
      gstNumber: null,
      rateBps: 0,
      subtotalAmount: money('23.00'),
      gstAmount: money('0.00'),
    },
    contains: 'RCT-000001',
  },
  {
    file: 'tax-invoice-late-withdrawal-fee.pdf',
    facts: { numberDisplay: 'INV-000003', chargeReason: 'LATE_WITHDRAWAL' },
    contains: 'INV-000003',
  },
];

describe('accountant specimens (AC-VERIFY-9)', () => {
  it.each(SPECIMENS)('$file is a real one-page PDF', async ({ file, facts, contains }) => {
    const bytes = await renderDocumentPdf(buildDocumentModel(taxInvoiceFacts(facts)), fonts);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    expect(totalPages).toBe(1);
    expect(text).toContain(contains);
    const directory = process.env.SPECIMEN_DIR;
    if (directory !== undefined && directory !== '') {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, file), bytes);
    }
  });
});
