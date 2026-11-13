/**
 * The PDF is real, specific to the payment and renders New Zealand names (tax-invoices-and-exports Phase 3; AC-HAPPY-1, 2, 3,
 * AC-VERIFY-1, AC-INTEGRATION-1). The file is parsed back to text with `unpdf` (no image snapshots): we assert what is printed,
 * not pixels. pdfkit's own layout engine is third-party and not tested.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractText, getDocumentProxy } from 'unpdf';
import { parseMoney, toMoneyString } from '@sgm/shared';
import { taxInvoiceFacts } from '../../../test/helpers/invoice-facts.ts';
import { buildDocumentModel } from './document.ts';
import {
  UnknownLayoutError,
  loadInvoiceFonts,
  renderDocumentPdf,
  type InvoiceFonts,
} from './render-pdf.ts';

const money = (text: string) => toMoneyString(parseMoney(text));
let fonts: InvoiceFonts;
beforeAll(async () => {
  fonts = await loadInvoiceFonts();
});

async function pdfText(bytes: Buffer): Promise<{ text: string; pages: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  return { text: text.replace(/\s+/g, ' ').trim(), pages: totalPages };
}

const render = (overrides: Parameters<typeof taxInvoiceFacts>[0] = {}): Promise<Buffer> =>
  renderDocumentPdf(buildDocumentModel(taxInvoiceFacts(overrides)), fonts);

describe('tax invoice PDF', () => {
  it('prints the number, supplier, GST number, buyer, game and the stored totals on one page (AC-HAPPY-1)', async () => {
    const bytes = await render();
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const { text, pages } = await pdfText(bytes);
    expect(pages).toBe(1);
    for (const expected of [
      'Tax invoice',
      'Invoice number',
      'INV-000001',
      'Date of issue',
      '3 June 2027',
      'Issued by Shared Game Management on behalf of Hōkio Badminton Club.',
      'Hōkio Badminton Club',
      'GST number 49-091-850',
      'Billed to',
      'Aroha Ngata',
      'Hōkio Sports Hall',
      'Thursday 3 June 2027, 7:30 pm',
      'Game fee, player',
      'Subtotal (excluding GST)',
      '$20.00',
      'GST (15%)',
      '$3.00',
      'Total (including GST)',
      '$23.00',
      'The total includes GST of $3.00.',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('lists a guest line and prints GST once for the whole payment (AC-HAPPY-2: $37.00 = $32.17 + $4.83)', async () => {
    const { text } = await pdfText(
      await render({
        lines: [
          { position: 0, unitFee: money('17.00') },
          { position: 1, unitFee: money('20.00') },
        ],
        subtotalAmount: money('32.17'),
        gstAmount: money('4.83'),
        amount: money('37.00'),
      }),
    );
    for (const expected of [
      'Game fee, player',
      '$17.00',
      'Game fee, guest 1',
      '$20.00',
      '$32.17',
      '$4.83',
      '$37.00',
    ]) {
      expect(text).toContain(expected);
    }
    // GST appears in one row, not once per line: "$4.83" is printed in the GST row and the closing sentence only.
    expect(text.match(/\$4\.83/g)).toHaveLength(2);
  });

  it('describes a late-withdrawal fee as such (AC-ERROR-6)', async () => {
    const { text } = await pdfText(await render({ chargeReason: 'LATE_WITHDRAWAL' }));
    expect(text).toContain('Late withdrawal fee, Hōkio Sports Hall, 3 June 2027');
  });
});

describe('receipt PDF (H2)', () => {
  it('is titled Receipt and says nothing about tax, GST or a GST number (AC-HAPPY-3)', async () => {
    const { text } = await pdfText(
      await render({
        kind: 'RECEIPT',
        numberDisplay: 'RCT-000007',
        gstNumber: null,
        rateBps: 0,
        subtotalAmount: money('23.00'),
        gstAmount: money('0.00'),
      }),
    );
    expect(text).toContain('Receipt');
    expect(text).toContain('RCT-000007');
    expect(text).toContain('Receipt number');
    expect(text).toContain('Total paid');
    expect(text).toContain('$23.00');
    expect(text).not.toMatch(/tax|gst|including|excluding/i);
  });
});

describe('real, specific and honest (AC-INTEGRATION-1)', () => {
  it('draws macrons in names from an embedded Unicode font, not a WinAnsi built-in', async () => {
    const bytes = await render({
      supplierName: 'Whangārei Shuttlers',
      buyerName: 'Tāne Wīremu',
      sessionLocation: 'Ōtāhuhu Ū Ē Ī Hall',
    });
    const { text } = await pdfText(bytes);
    expect(text).toContain('Whangārei Shuttlers');
    expect(text).toContain('Tāne Wīremu');
    expect(text).toContain('Ōtāhuhu Ū Ē Ī Hall');
    // Embedded TrueType, no Helvetica fallback.
    const raw = bytes.toString('latin1');
    expect(raw).toMatch(/NotoSans/);
    expect(raw).not.toMatch(/\/BaseFont\s*\/Helvetica/);
  });

  it('gives two different payments different documents, with no placeholder text', async () => {
    const first = await render();
    const second = await render({
      numberDisplay: 'INV-000042',
      supplierName: 'Whangārei Shuttlers',
      gstNumber: '136410132',
      buyerName: 'Tāne Wīremu',
      sessionLocation: 'Kensington Park Hall',
      lines: [{ position: 0, unitFee: money('12.00') }],
      subtotalAmount: money('10.43'),
      gstAmount: money('1.57'),
      amount: money('12.00'),
    });
    const a = await pdfText(first);
    const b = await pdfText(second);
    expect(a.text).not.toBe(b.text);
    expect(b.text).toContain('INV-000042');
    expect(b.text).toContain('GST number 136-410-132');
    expect(b.text).toContain('$1.57');
    expect(first.length).toBeGreaterThan(5_000);
    for (const text of [a.text, b.text]) {
      expect(text).not.toMatch(/TODO|placeholder|undefined|NaN|\[object|null/i);
    }
  });

  it('re-renders the same document to identical bytes (AC-HAPPY-4)', async () => {
    const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
    expect(hash(await render())).toBe(hash(await render()));
  });

  it('survives long names and a long location on one page, and a thousands separator', async () => {
    const long =
      'Wairarapa Mid-Week Social Badminton and Racquets Association Incorporated of Greytown';
    const { text, pages } = await pdfText(
      await render({
        supplierName: long,
        buyerName: 'Te Awanuiārangi Kaumātua-Whānau Hōhepa-Pāora',
        sessionLocation: `${long} Community Sports Centre`,
        lines: [
          { position: 0, unitFee: money('1234.50') },
          { position: 1, unitFee: money('1234.50') },
          { position: 2, unitFee: money('1234.50') },
        ],
        subtotalAmount: money('3220.43'),
        gstAmount: money('482.07'),
        amount: money('3702.50'),
      }),
    );
    expect(pages).toBe(1);
    expect(text).toContain('$3,702.50');
  });

  it('refuses an unknown layout version instead of guessing one', async () => {
    const model = buildDocumentModel(taxInvoiceFacts({ layoutVersion: 99 }));
    await expect(renderDocumentPdf(model, fonts)).rejects.toBeInstanceOf(UnknownLayoutError);
  });
});

describe('the embedded fonts', () => {
  it('are the exact Noto Sans files ADR 0021 records (SHA-256), with the OFL text beside them', async () => {
    const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
    expect(sha(fonts.regular)).toBe(
      'fe8c022f48d8dd29f17b744d16f9346f4357e16f7d4f7be58b000ae7c291b614',
    );
    expect(sha(fonts.bold)).toBe(
      '13a813c49624ae3ba3c5c6e72c5ebffc4b9e1e6ea32f421c04069b037c6ad431',
    );
    const licence = await readFile(new URL('./fonts/OFL.txt', import.meta.url), 'utf8');
    expect(licence).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  it('cover the macron vowels in both weights', async () => {
    const { default: PDFDocument } = await import('pdfkit');
    const doc = new PDFDocument({ font: '' });
    doc.registerFont('r', fonts.regular);
    doc.registerFont('b', fonts.bold);
    for (const face of ['r', 'b']) {
      doc.font(face);
      const font = (
        doc as unknown as { _font: { font: { hasGlyphForCodePoint(cp: number): boolean } } }
      )._font;
      for (const vowel of 'āēīōūĀĒĪŌŪ') {
        expect(font.font.hasGlyphForCodePoint(vowel.codePointAt(0) ?? 0), `${face} ${vowel}`).toBe(
          true,
        );
      }
    }
  });

  it('fail loudly when a font cannot be read (the API refuses to start without them)', async () => {
    await expect(loadInvoiceFonts(new URL('./no-such-fonts/', import.meta.url))).rejects.toThrow(
      /invoice fonts/,
    );
  });
});
