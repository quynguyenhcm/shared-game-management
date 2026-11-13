/**
 * A CSV writer (RFC 4180; tax-invoices-and-exports architecture "CSV", AC-VERIFY-5): UTF-8 with a byte-order mark by default
 * (Excel for Windows otherwise garbles macrons; Sheets ignores it), CRLF line endings and one header row. A field is quoted
 * when it holds `,`, `"`, CR or LF or has leading or trailing whitespace, with `"` doubled inside quotes. Every text cell (the
 * header included) is neutralised against formula injection; a number cell is written as its exact decimal text.
 *
 * Rows are encoded as they arrive and counted against `maxBytes`; a row that would pass the cap throws
 * `TabularTooLargeError` and the writer never produces a file (CR-3: refuse, never truncate).
 */
import {
  ByteBudget,
  neutraliseText,
  numberText,
  type TabularCell,
  type TabularRow,
  type TabularWriter,
} from './cells.ts';

export interface CsvWriterOptions {
  readonly header: readonly string[];
  readonly maxBytes: number;
  /** Default true. */
  readonly bom?: boolean;
}

export interface CsvWriter extends TabularWriter {
  readonly extension: 'csv';
  writeRows(rows: readonly TabularRow[]): void;
  /** The complete file. Throws if the cap was ever exceeded. */
  finish(): Uint8Array;
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;

function field(cell: TabularCell): string {
  if (typeof cell !== 'string') return numberText(cell);
  const text = neutraliseText(cell);
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const line = (row: TabularRow): string => `${row.map(field).join(',')}\r\n`;

export function createCsvWriter(options: CsvWriterOptions): CsvWriter {
  const budget = new ByteBudget(options.maxBytes);
  const chunks: Buffer[] = [];
  const push = (chunk: Buffer): void => {
    budget.take(chunk.length);
    chunks.push(chunk);
  };
  if (options.bom ?? true) push(BOM);
  push(Buffer.from(line(options.header), 'utf8'));

  return {
    contentType: 'text/csv; charset=utf-8',
    extension: 'csv',
    bytesWritten: () => budget.bytes,
    writeRows(rows) {
      budget.assertOpen();
      if (rows.length === 0) return;
      push(Buffer.from(rows.map(line).join(''), 'utf8'));
    },
    finish() {
      budget.assertOpen();
      return Buffer.concat(chunks);
    },
  };
}
