/**
 * Cells shared by the tabular writers (`csv.ts`, `xlsx.ts`; tax-invoices-and-exports architecture E4, algorithm "Text-cell
 * neutralisation"). Generic: nothing here knows about payments.
 *
 * - A cell is either text (a plain string) or a number written from its exact decimal TEXT (`moneyCell` from a `MoneyString`,
 *   `integerCell` from a safe integer). No JS number ever carries money (P2): the writers copy the text into the file.
 * - Every text cell is neutralised by `neutraliseText` in both formats (OWASP CSV injection plus the full-width forms some
 *   spreadsheet locales evaluate), so a spreadsheet never evaluates a cell that came from user data. A number cell is never
 *   prefixed, so `-0.05` stays a number.
 * - `TabularTooLargeError` is how a writer refuses to grow past its encoded-byte cap while building (CR-3): it never
 *   truncates, and a refused writer never produces a file.
 */
import type { MoneyString } from '@sgm/shared';

export interface TabularNumber {
  /** The exact decimal text written into the file (`23.00`, `-0.05`, `3`). */
  readonly number: string;
  /** `money` is shown with two decimals (`0.00`), `integer` as a whole number. */
  readonly format: 'money' | 'integer';
}

export type TabularCell = string | TabularNumber;
export type TabularRow = readonly TabularCell[];

const MONEY_TEXT = /^-?\d{1,13}\.\d{2}$/;
const INTEGER_TEXT = /^-?\d{1,15}$/;

/** A money cell from a stored `MoneyString` (validated again when written). */
export function moneyCell(value: MoneyString): TabularNumber {
  return { number: value, format: 'money' };
}

/** A whole-number cell (a count). */
export function integerCell(value: number): TabularNumber {
  if (!Number.isSafeInteger(value)) throw new RangeError('An integer cell needs a safe integer.');
  return { number: String(value), format: 'integer' };
}

/** The decimal text of a number cell, or a thrown error: a malformed value is never written. */
export function numberText(cell: TabularNumber): string {
  const pattern = cell.format === 'money' ? MONEY_TEXT : INTEGER_TEXT;
  if (!pattern.test(cell.number)) {
    throw new RangeError(
      cell.format === 'money'
        ? 'A money cell must be a decimal with exactly two places.'
        : 'An integer cell must be a whole number.',
    );
  }
  return cell.number;
}

/** First characters a spreadsheet may evaluate: = + - @ tab CR, and the full-width = + - @. */
const FORMULA_TRIGGERS: ReadonlySet<string> = new Set([
  '=',
  '+',
  '-',
  '@',
  '\t',
  '\r',
  '\uFF1D',
  '\uFF0B',
  '\uFF0D',
  '\uFF20',
]);

/** Prefixes `'` to a text that starts with a formula trigger; anything else is returned unchanged. */
export function neutraliseText(text: string): string {
  return text.length > 0 && FORMULA_TRIGGERS.has(text.charAt(0)) ? `'${text}` : text;
}

/** A writer was asked to grow past its encoded-byte cap. Nothing was produced. */
export class TabularTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super('The file would be larger than the configured maximum.');
    this.name = 'TabularTooLargeError';
    this.maxBytes = maxBytes;
  }
}

/** The byte budget every writer counts against while it builds (CR-3). Once exceeded it stays refused. */
export class ByteBudget {
  readonly maxBytes: number;
  private used = 0;
  private refused = false;

  constructor(maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError('A byte cap must be a positive integer.');
    }
    this.maxBytes = maxBytes;
  }

  /** Adds `bytes`, or throws `TabularTooLargeError` (and stays refused) when the total would pass the cap. */
  take(bytes: number): void {
    this.assertOpen();
    if (this.used + bytes > this.maxBytes) {
      this.refused = true;
      throw new TabularTooLargeError(this.maxBytes);
    }
    this.used += bytes;
  }

  assertOpen(): void {
    if (this.refused) throw new TabularTooLargeError(this.maxBytes);
  }

  get bytes(): number {
    return this.used;
  }
}

/** What both writers expose to a caller that builds a file page by page. */
export interface TabularWriter {
  readonly contentType: string;
  readonly extension: 'csv' | 'xlsx';
  /** Encoded bytes counted so far against the cap. */
  bytesWritten(): number;
}
