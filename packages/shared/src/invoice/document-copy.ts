import { formatNZD, parseMoney, type MoneyString } from '../money/money.ts';
import { formatIrdNumber } from '../nz/ird-number.ts';
import type { PaymentDocumentKind } from '../types/enums.ts';

/**
 * Every word a printed document or its download link can say, in ONE place (tax-invoices-and-exports UI/UX doc, "Wording in
 * one place"; ADR 0021). The accountant's review (AC-VERIFY-9) may change any of this (H1 agent line, H2 receipt wording,
 * H6 content, H10 late-withdrawal wording, H12 dates). A change is one edit here and one test: no stored record holds these
 * words (the snapshot stores facts, the renderer owns the words), so no migration is ever needed for a wording change.
 *
 * All of it is provisional until the accountant has signed off the specimens.
 */

/** The platform's name on the agent line (H1: the team is the supplier; the platform issues on the team's behalf). */
export const PLATFORM_NAME = 'Shared Game Management';

export const DOCUMENT_TITLES: Readonly<Record<PaymentDocumentKind, string>> = {
  TAX_INVOICE: 'Tax invoice',
  RECEIPT: 'Receipt',
};

export const DOCUMENT_NUMBER_LABELS: Readonly<Record<PaymentDocumentKind, string>> = {
  TAX_INVOICE: 'Invoice number',
  RECEIPT: 'Receipt number',
};

export const DOCUMENT_LABELS = {
  dateOfIssue: 'Date of issue',
  paidOn: 'Paid on',
  supplier: 'Supplier',
  billedTo: 'Billed to',
  game: 'Game',
  description: 'Description',
  subtotal: 'Subtotal (excluding GST)',
  total: 'Total (including GST)',
  totalPaid: 'Total paid',
} as const;

/** The column heading of the amount column: GST-inclusive on a tax invoice, plain on a receipt. */
export const AMOUNT_COLUMN_LABELS: Readonly<Record<PaymentDocumentKind, string>> = {
  TAX_INVOICE: 'Amount (including GST)',
  RECEIPT: 'Amount',
};

/** `Issued by Shared Game Management on behalf of {team}.` (H1; OQ3 asks the accountant whether this is the wanted form). */
export function agentLine(supplierName: string): string {
  return `Issued by ${PLATFORM_NAME} on behalf of ${supplierName}.`;
}

/** `GST number 49-091-850`: the stored digits grouped the IRD way (8 digits `NN-NNN-NNN`, 9 digits `NNN-NNN-NNN`). */
export function gstNumberLine(gstNumber: string): string {
  return `GST number ${formatIrdNumber(gstNumber)}`;
}

/**
 * A rate in basis points as a percent label: `1500` is `15`, `1250` is `12.5`. Integer arithmetic on the rate only (it is not
 * money); the document prints it in `GST (15%)`.
 */
export function gstRatePercent(rateBps: number): string {
  const whole = (rateBps - (rateBps % 100)) / 100;
  const fraction = rateBps % 100;
  if (fraction === 0) return String(whole);
  const tenths = String(fraction).padStart(2, '0').replace(/0$/, '');
  return `${whole}.${tenths}`;
}

export const gstLabel = (rateBps: number): string => `GST (${gstRatePercent(rateBps)}%)`;

/** `The total includes GST of $4.83.` (a tax invoice only). */
export function gstSentence(gstAmount: MoneyString): string {
  return `The total includes GST of ${formatNZD(parseMoney(gstAmount))}.`;
}

/** A registrant is position 0, a guest is position 1 or 2. */
const isGuest = (position: number): boolean => position > 0;

/** `Game fee, player` / `Game fee, guest 1`. */
export function gameFeeLine(position: number): string {
  return isGuest(position) ? `Game fee, guest ${position}` : 'Game fee, player';
}

/**
 * `Late withdrawal fee, {location}, {date}` (AC-ERROR-6, H10) and, for a guest line, `Late withdrawal fee, guest 1, ...`.
 * `date` is the caller's already formatted game day.
 */
export function lateWithdrawalLine(position: number, location: string, date: string): string {
  return isGuest(position)
    ? `Late withdrawal fee, guest ${position}, ${location}, ${date}`
    : `Late withdrawal fee, ${location}, ${date}`;
}

/** The player-facing action: `Download tax invoice` or `Download receipt` (never chosen from a GST amount: $0.01 pays $0.00 GST). */
export const DOCUMENT_ACTION_LABELS: Readonly<Record<PaymentDocumentKind, string>> = {
  TAX_INVOICE: 'Download tax invoice',
  RECEIPT: 'Download receipt',
};

/** The team admin's neutral per-row action label. */
export const ADMIN_DOCUMENT_ACTION_LABEL = 'Invoice';

/** The file type, shown beside every download action. */
export const DOCUMENT_FILE_TYPE_SUFFIX = ' (PDF)';

/** The document kind spelled for a sentence (`tax invoice`, `receipt`). */
export const DOCUMENT_NAMES: Readonly<Record<PaymentDocumentKind, string>> = {
  TAX_INVOICE: 'tax invoice',
  RECEIPT: 'receipt',
};
