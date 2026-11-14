/**
 * Row shaping for the income export (tax-invoices-and-exports algorithm "Export columns", D4; AC-HAPPY-6, AC-ERROR-5,
 * AC-ERROR-6, AC-VERIFY-1, AC-VERIFY-2). Pure: no clock, no database.
 *
 * - `toExportRow` turns one read row into the 11 cells of `INCOME_EXPORT_COLUMNS`, in order. Money cells are the STORED
 *   `subtotal_amount`, `gst_amount` and `amount`, never recomputed. Dates are Pacific/Auckland local (P3). A $0.00 payment
 *   has an empty number and an empty "Paid by". The repo has already applied the snapshot precedence (an issued payment
 *   shows its issue-time buyer name and game, like its PDF).
 * - `Reconciler` re-proves that the rows add up to the preflight's count and three sums (`Money`, exact); a mismatch is a bug
 *   and the file is discarded.
 * - `summaryRows` is the XLSX Summary sheet: labelled values only, no formula.
 * - `exportFilename` is `income_<team-slug>_<period stem>.<csv|xlsx>`, ASCII only.
 */
import {
  INCOME_EXPORT_NO_GAME_DESCRIPTION,
  INCOME_EXPORT_SUMMARY_LABELS as L,
  PAID_BY_LABELS,
  YES_NO,
  add,
  formatIrdNumber,
  formatNzDateLong,
  formatNzDateTime,
  incomeExportDescription,
  instantToLocal,
  isZero,
  parseMoney,
  type BillingType,
  type Money,
  type MoneyString,
  type PeriodDescriptor,
} from '@sgm/shared';
import { integerCell, moneyCell, type TabularRow } from '../../lib/tabular/cells.ts';

/** One payment as the export reads it (`repo.ts`), snapshot precedence already applied. */
export interface ExportSourceRow {
  readonly id: string;
  /** The frozen printed number (`INV-000001` / `RCT-000001`), null when no document was issued. */
  readonly numberDisplay: string | null;
  readonly paidAt: Date;
  /** The game's start (snapshot, else live); null for a payment with no registration. */
  readonly gameStartsAt: Date | null;
  readonly payerName: string;
  readonly location: string | null;
  readonly chargeReason: 'GAME_FEE' | 'LATE_WITHDRAWAL';
  readonly guests: number;
  readonly amount: MoneyString;
  readonly subtotalAmount: MoneyString;
  readonly gstAmount: MoneyString;
  readonly gstRegistered: boolean;
  readonly billingType: BillingType;
  readonly paymentReference: string;
}

/** The preflight's facts (one snapshot with the rows), shown in the Summary sheet. */
export interface ExportSummary {
  readonly rows: number;
  /** Rows with an issued document number. */
  readonly numbered: number;
  /** $0.00 rows (they get no document). */
  readonly zero: number;
  /** Rows above $0.00 still waiting for their number. */
  readonly awaiting: number;
  readonly total: MoneyString;
  readonly subtotal: MoneyString;
  readonly gst: MoneyString;
  /** Distinct charge-time GST numbers in the range. */
  readonly gstNumbers: readonly string[];
}

function paidBy(row: ExportSourceRow): string {
  if (row.billingType === 'PREPAID_CREDIT') return PAID_BY_LABELS.WALLET;
  return isZero(parseMoney(row.amount)) ? '' : PAID_BY_LABELS.BANK;
}

function describe(row: ExportSourceRow): string {
  if (row.gameStartsAt === null || row.location === null) return INCOME_EXPORT_NO_GAME_DESCRIPTION;
  return incomeExportDescription({
    reason: row.chargeReason,
    location: row.location,
    gameDay: formatNzDateLong(row.gameStartsAt),
    guests: row.guests,
  });
}

export function toExportRow(row: ExportSourceRow): TabularRow {
  return [
    row.numberDisplay ?? '',
    instantToLocal(row.paidAt).date,
    row.gameStartsAt === null ? '' : instantToLocal(row.gameStartsAt).date,
    row.payerName,
    describe(row),
    moneyCell(row.subtotalAmount),
    moneyCell(row.gstAmount),
    moneyCell(row.amount),
    row.gstRegistered ? YES_NO.yes : YES_NO.no,
    paidBy(row),
    row.paymentReference,
  ];
}

/** Count and the three sums of the rows written, compared with the preflight at the end. */
export class Reconciler {
  private rows = 0;
  private total: Money = parseMoney('0.00');
  private subtotal: Money = parseMoney('0.00');
  private gst: Money = parseMoney('0.00');

  add(row: Pick<ExportSourceRow, 'amount' | 'subtotalAmount' | 'gstAmount'>): void {
    this.rows += 1;
    this.total = add(this.total, parseMoney(row.amount));
    this.subtotal = add(this.subtotal, parseMoney(row.subtotalAmount));
    this.gst = add(this.gst, parseMoney(row.gstAmount));
  }

  /** Throws when the rows do not add up to `summary` (a bug: the caller discards the file). Logs nothing itself. */
  assertEquals(summary: Pick<ExportSummary, 'rows' | 'total' | 'subtotal' | 'gst'>): void {
    const matches =
      this.rows === summary.rows &&
      this.total === parseMoney(summary.total) &&
      this.subtotal === parseMoney(summary.subtotal) &&
      this.gst === parseMoney(summary.gst) &&
      add(this.subtotal, this.gst) === this.total;
    if (!matches) throw new Error('The export rows do not reconcile with the preflight totals.');
  }
}

export interface SummaryInput {
  /** The team's current name (labelled as such). */
  readonly teamName: string;
  readonly period: PeriodDescriptor;
  readonly summary: ExportSummary;
  readonly generatedAt: Date;
}

/** The Summary sheet: two columns of labelled values (team, GST number, period, basis, counts, totals). */
export function summaryRows(input: SummaryInput): TabularRow[] {
  const { summary } = input;
  return [
    [L.team, input.teamName],
    [
      L.gstNumber,
      summary.gstNumbers.length === 0
        ? L.notRegistered
        : summary.gstNumbers.map((number) => formatIrdNumber(number)).join(', '),
    ],
    [L.period, input.period.label],
    [L.basis, L.basisText],
    [L.generated, formatNzDateTime(input.generatedAt)],
    [L.rows, integerCell(summary.rows)],
    [L.numbered, integerCell(summary.numbered)],
    [L.zero, integerCell(summary.zero)],
    [L.awaiting, integerCell(summary.awaiting)],
    [L.subtotal, moneyCell(summary.subtotal)],
    [L.gst, moneyCell(summary.gst)],
    [L.total, moneyCell(summary.total)],
  ];
}

const SLUG_MAX = 40;

/** `hokio-badminton-club`: diacritics stripped, `[a-z0-9-]`, at most 40 characters, `team` when nothing is left. */
function teamSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return slug === '' ? 'team' : slug;
}

export function exportFilename(
  teamName: string,
  period: PeriodDescriptor,
  extension: 'csv' | 'xlsx',
): string {
  return `income_${teamSlug(teamName)}_${period.fileStem}.${extension}`;
}
