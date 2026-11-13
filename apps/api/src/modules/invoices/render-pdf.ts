/**
 * The PDF renderer (tax-invoices-and-exports Phase 3; AC-HAPPY-1, 2, 3, AC-INTEGRATION-1; architecture section 3, UI/UX
 * "PDF layout"): pdfkit with embedded Noto Sans, rendered ON DEMAND from the document model, by `layout_version`.
 *
 * - One single-column A4 layout (48 pt margins, black on white, no fills, nothing below 9 pt) with a tax-invoice and a receipt
 *   variant inside the model, so the two never drift. `LAYOUTS` is keyed by the stored `layout_version`: until the first real
 *   document exists layout 1 is edited in place; after that any change to printed output adds layout N+1 and old documents keep
 *   rendering with their own (ADR 0021 "layout versioning rule").
 * - Noto Sans (OFL) is embedded: macrons (ā ē ī ō ū) need a Unicode font, a built-in WinAnsi font cannot draw them and would
 *   corrupt names. The two font files are read once at boot (`loadInvoiceFonts`); a missing file fails the API at start
 *   (P7), and there is no fallback to a built-in font.
 * - Deterministic: the PDF info dates are the document's own issue time and there is no `Date.now()` here, so the same model
 *   renders to the same bytes (AC-HAPPY-4).
 * - Pure: no database, network or clock. The model holds no email address, bank detail or Akahu reference to print.
 */
import { readFile } from 'node:fs/promises';
import PDFDocument from 'pdfkit';
import { PLATFORM_NAME, DOCUMENT_LABELS } from '@sgm/shared';
import type { DocumentModel } from './document.ts';

export interface InvoiceFonts {
  readonly regular: Buffer;
  readonly bold: Buffer;
}

const FONT_DIR = new URL('./fonts/', import.meta.url);

/** Reads both embedded fonts. Throws when either is missing, so the API refuses to start without them (P7). */
export async function loadInvoiceFonts(directory: URL = FONT_DIR): Promise<InvoiceFonts> {
  try {
    const [regular, bold] = await Promise.all([
      readFile(new URL('NotoSans-Regular.ttf', directory)),
      readFile(new URL('NotoSans-Bold.ttf', directory)),
    ]);
    return { regular, bold };
  } catch (cause) {
    throw new Error(
      'The invoice fonts (Noto Sans) could not be read from modules/invoices/fonts.',
      {
        cause,
      },
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Layout 1 (A4, points; y measured from the top of the page)
// ---------------------------------------------------------------------------------------------

const MARGIN = 48;
const PAGE_WIDTH = 595.28;
const LEFT = MARGIN;
const RIGHT = PAGE_WIDTH - MARGIN;
const CONTENT_WIDTH = RIGHT - LEFT;

const META_X = 347;
const META_WIDTH = RIGHT - META_X;
const AMOUNT_COLUMN_X = 407;
const AMOUNT_COLUMN_WIDTH = RIGHT - AMOUNT_COLUMN_X;
const DESCRIPTION_WIDTH = AMOUNT_COLUMN_X - LEFT - 12;
const TOTALS_X = 327;
const TOTALS_WIDTH = RIGHT - TOTALS_X;
const TOTALS_LABEL_WIDTH = 130;

const SIZE = { title: 22, label: 9, name: 12, body: 10, small: 9, total: 12 } as const;
const BLACK = '#000000';

type Doc = InstanceType<typeof PDFDocument>;
type Layout = (doc: Doc, model: DocumentModel) => void;

function rule(doc: Doc, y: number, weight: number): void {
  doc.moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(weight).strokeColor(BLACK).stroke();
}

function layoutOne(doc: Doc, model: DocumentModel): void {
  doc.fillColor(BLACK);

  // Header: title left, number and dates right.
  doc.font('bold').fontSize(SIZE.title).text(model.title, LEFT, MARGIN, { width: 290 });
  const meta: readonly (readonly [string, string])[] = [
    [model.numberLabel, model.number],
    [DOCUMENT_LABELS.dateOfIssue, model.dateOfIssue],
    [DOCUMENT_LABELS.paidOn, model.paidOn],
  ];
  meta.forEach(([label, value], index) => {
    const y = MARGIN + index * 16;
    doc
      .font('regular')
      .fontSize(SIZE.label)
      .text(label, META_X, y + 1, { width: 95, lineBreak: false });
    doc.font('bold').fontSize(SIZE.body).text(value, META_X, y, {
      width: META_WIDTH,
      align: 'right',
      lineBreak: false,
    });
  });

  // The agent statement (H1).
  doc.font('regular').fontSize(SIZE.small).text(model.agentLine, LEFT, 82, {
    width: 290,
    height: 30,
    ellipsis: true,
    lineGap: 2,
  });
  rule(doc, 112, 0.75);

  // Parties.
  const partiesY = 124;
  const party = (x: number, label: string, name: string, extra: string | null): number => {
    doc.font('bold').fontSize(SIZE.label).text(label, x, partiesY, { width: 235 });
    doc
      .font('bold')
      .fontSize(SIZE.name)
      .text(name, x, partiesY + 13, {
        width: 235,
        height: 30,
        ellipsis: true,
        lineGap: 2,
      });
    if (extra !== null) {
      doc
        .font('regular')
        .fontSize(SIZE.body)
        .text(extra, x, doc.y + 4, { width: 235 });
    }
    return doc.y;
  };
  const supplierBottom = party(
    LEFT,
    DOCUMENT_LABELS.supplier,
    model.supplierName,
    model.gstNumberLine,
  );
  const buyerBottom = party(312, DOCUMENT_LABELS.billedTo, model.buyerName, null);
  const partiesBottom = supplierBottom > buyerBottom ? supplierBottom : buyerBottom;

  // The game.
  const gameY = partiesBottom + 20;
  doc
    .font('bold')
    .fontSize(SIZE.label)
    .text(DOCUMENT_LABELS.game, LEFT, gameY, { width: CONTENT_WIDTH });
  doc
    .font('regular')
    .fontSize(SIZE.body)
    .text(model.gameLocation, LEFT, gameY + 13, {
      width: CONTENT_WIDTH,
      height: 28,
      ellipsis: true,
      lineGap: 3,
    });
  doc
    .font('regular')
    .fontSize(SIZE.body)
    .text(model.gameWhen, LEFT, doc.y + 1, { width: CONTENT_WIDTH });

  // The table.
  const headerY = doc.y + 22;
  doc.font('bold').fontSize(SIZE.label);
  doc.text(DOCUMENT_LABELS.description, LEFT, headerY, { width: DESCRIPTION_WIDTH });
  doc.text(model.amountColumnLabel, AMOUNT_COLUMN_X, headerY, {
    width: AMOUNT_COLUMN_WIDTH,
    align: 'right',
  });
  let y = headerY + 14;
  rule(doc, y, 1);
  for (const line of model.lines) {
    const top = y + 6;
    doc.font('regular').fontSize(SIZE.body);
    doc.text(line.description, LEFT, top, { width: DESCRIPTION_WIDTH, lineGap: 3 });
    const descriptionBottom = doc.y;
    doc.text(line.amount, AMOUNT_COLUMN_X, top, { width: AMOUNT_COLUMN_WIDTH, align: 'right' });
    y = (descriptionBottom > top + 12 ? descriptionBottom : top + 12) + 6;
    rule(doc, y, 0.25);
  }

  // Totals: the stored figures, printed as they are.
  y += 16;
  const totalsRow = (
    label: string,
    value: string,
    font: 'regular' | 'bold',
    size: number,
    at: number,
  ): void => {
    doc.font(font).fontSize(size);
    doc.text(label, TOTALS_X, at, { width: TOTALS_LABEL_WIDTH, lineBreak: false });
    doc.text(value, TOTALS_X, at, { width: TOTALS_WIDTH, align: 'right', lineBreak: false });
  };
  const { totals } = model;
  if (totals.kind === 'TAX_INVOICE') {
    totalsRow(totals.subtotalLabel, totals.subtotal, 'regular', SIZE.body, y);
    totalsRow(totals.gstLabel, totals.gst, 'regular', SIZE.body, y + 16);
    doc
      .moveTo(TOTALS_X, y + 34)
      .lineTo(RIGHT, y + 34)
      .lineWidth(1)
      .strokeColor(BLACK)
      .stroke();
    totalsRow(totals.totalLabel, totals.total, 'bold', SIZE.total, y + 40);
    doc
      .font('regular')
      .fontSize(SIZE.small)
      .text(totals.sentence, TOTALS_X, y + 60, {
        width: TOTALS_WIDTH,
        align: 'right',
      });
  } else {
    doc
      .moveTo(TOTALS_X, y - 4)
      .lineTo(RIGHT, y - 4)
      .lineWidth(1)
      .strokeColor(BLACK)
      .stroke();
    totalsRow(totals.totalLabel, totals.total, 'bold', SIZE.total, y + 2);
  }
}

/** The layouts by stored `layout_version`. Only 1 exists; a later one is added beside it, never in place (ADR 0021). */
export const LAYOUTS: Readonly<Record<number, Layout>> = { 1: layoutOne };

export class UnknownLayoutError extends Error {
  constructor(readonly layoutVersion: number) {
    super(`No invoice layout ${layoutVersion} is installed.`);
    this.name = 'UnknownLayoutError';
  }
}

/** Renders one document to PDF bytes. Throws for an unknown layout version or a layout that spills to a second page. */
export function renderDocumentPdf(model: DocumentModel, fonts: InvoiceFonts): Promise<Buffer> {
  const layout = LAYOUTS[model.layoutVersion];
  if (layout === undefined) return Promise.reject(new UnknownLayoutError(model.layoutVersion));
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: MARGIN, left: MARGIN, right: MARGIN, bottom: MARGIN },
      bufferPages: true,
      // No default font: Helvetica (WinAnsi) cannot draw macrons, so every text call selects an embedded face first.
      font: '',
      lang: 'en-NZ',
      displayTitle: true,
      info: {
        Title: model.pdfTitle,
        Author: PLATFORM_NAME,
        Subject: model.supplierName,
        Creator: PLATFORM_NAME,
        CreationDate: model.issuedAt,
        ModDate: model.issuedAt,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    try {
      doc.registerFont('regular', fonts.regular);
      doc.registerFont('bold', fonts.bold);
      layout(doc, model);
      if (doc.bufferedPageRange().count !== 1) {
        throw new Error('The document layout spilled onto a second page.');
      }
      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error('The invoice could not be rendered.'));
    }
  });
}
