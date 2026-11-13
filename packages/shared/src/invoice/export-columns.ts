import { lateWithdrawalLine } from './document-copy.ts';

/**
 * The income export's columns and words, in ONE place (tax-invoices-and-exports UI/UX A6, algorithm "Export columns", R4): the
 * API writes the CSV header and the XLSX "Payments" sheet from `INCOME_EXPORT_COLUMNS`, and the web's "What's in the file" help
 * lists the same entries, so the help text cannot drift from the file. Like `document-copy.ts`, all of it is provisional until
 * the accountant has reviewed the specimens (AC-VERIFY-9).
 */
export const INCOME_EXPORT_COLUMNS = [
  {
    key: 'invoiceNumber',
    header: 'Invoice number',
    help: 'The number on the tax invoice or receipt, blank when no document was issued (a $0.00 game) or the number is still being assigned.',
  },
  {
    key: 'paidDate',
    header: 'Paid date',
    help: 'The day the payment was paid (New Zealand time).',
  },
  { key: 'gameDate', header: 'Game date', help: 'The day of the game (New Zealand time).' },
  { key: 'player', header: 'Player', help: "The player's name." },
  { key: 'description', header: 'Description', help: 'What was paid for.' },
  { key: 'subtotal', header: 'Subtotal', help: 'The amount before GST.' },
  { key: 'gst', header: 'GST', help: 'The GST in the payment.' },
  { key: 'total', header: 'Total', help: 'The amount paid, including GST.' },
  {
    key: 'gstRegistered',
    header: 'GST registered',
    help: 'Yes or No: whether the team was registered for GST when the payment was charged.',
  },
  {
    key: 'paidBy',
    header: 'Paid by',
    help: 'Wallet or Bank, blank for a $0.00 game.',
  },
  {
    key: 'reference',
    header: 'Reference',
    help: 'The payment reference shown on the bank statement, so you can match bank lines.',
  },
] as const;

export type IncomeExportColumnKey = (typeof INCOME_EXPORT_COLUMNS)[number]['key'];

/** The neutral "Paid by" values (H11): wallet credit or a bank payment. */
export const PAID_BY_LABELS = { WALLET: 'Wallet', BANK: 'Bank' } as const;

/** The description of a payment with no game (a subscription row; none exist in v1). */
export const INCOME_EXPORT_NO_GAME_DESCRIPTION = 'Payment';

/** `Yes` / `No` in the "GST registered" column. */
export const YES_NO = { yes: 'Yes', no: 'No' } as const;

export interface IncomeExportDescriptionInput {
  readonly reason: 'GAME_FEE' | 'LATE_WITHDRAWAL';
  readonly location: string;
  /** The already formatted game day (`3 June 2027`). */
  readonly gameDay: string;
  /** Guest lines on the payment (0 to 2). */
  readonly guests: number;
}

/**
 * `Game fee, {location}, {date}` or `Late withdrawal fee, {location}, {date}` (the invoice wording, AC-ERROR-6), plus
 * `, with 1 guest` / `, with 2 guests` when the payment covers guests.
 */
export function incomeExportDescription(input: IncomeExportDescriptionInput): string {
  const base =
    input.reason === 'LATE_WITHDRAWAL'
      ? lateWithdrawalLine(0, input.location, input.gameDay)
      : `Game fee, ${input.location}, ${input.gameDay}`;
  if (input.guests <= 0) return base;
  return `${base}, with ${input.guests} ${input.guests === 1 ? 'guest' : 'guests'}`;
}

/** The two sheet names and the Summary sheet's labels (XLSX only; every Summary cell is a value, never a formula). */
export const INCOME_EXPORT_SUMMARY_LABELS = {
  paymentsSheet: 'Payments',
  summarySheet: 'Summary',
  item: 'Item',
  value: 'Value',
  team: 'Team',
  gstNumber: 'GST number',
  notRegistered: 'Not registered',
  period: 'Period',
  basis: 'Basis',
  basisText: 'Payments received, by paid date. Wallet top-ups are not included.',
  generated: 'Generated',
  rows: 'Payments',
  numbered: 'With an invoice or receipt number',
  zero: '$0.00 payments (no document)',
  awaiting: 'Awaiting an invoice or receipt number',
  subtotal: 'Subtotal (excluding GST)',
  gst: 'GST',
  total: 'Total (including GST)',
} as const;
