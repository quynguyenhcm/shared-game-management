/**
 * The document model (tax-invoices-and-exports Phase 3; AC-HAPPY-1, 2, 3, AC-ERROR-6, AC-VERIFY-1; architecture section 3): a
 * PURE function from the issue-time snapshot, the payment's immutable columns and its lines to the text a layout prints.
 *
 * - The kind (tax invoice or receipt) is the snapshot's `document_kind`, which the database ties to the charge-time
 *   `gst_registered`. A receipt carries no GST number, no GST row and no "tax" word at all (H2).
 * - Printed subtotal, GST and total are the STORED `subtotal_amount`, `gst_amount` and `amount` columns, formatted. Nothing here
 *   adds, splits or re-rounds money, so the printed figures can never differ from the row (AC-VERIFY-1); a guest case prints
 *   GST once for the whole payment, never per line.
 * - Dates are printed in Pacific/Auckland from the stored instants (P3). There is no clock: the same facts always give the same
 *   model, and so the same PDF.
 * - Guest names are never printed (they are mutable): guest lines are "Game fee, guest 1".
 * - No email address, bank detail, payment reference or Akahu id is part of the facts, so none can reach the page.
 * All words come from the shared `document-copy.ts`.
 */
import {
  AMOUNT_COLUMN_LABELS,
  DOCUMENT_LABELS,
  DOCUMENT_NUMBER_LABELS,
  DOCUMENT_TITLES,
  agentLine,
  formatNZD,
  formatNzDateLong,
  formatNzWeekdayDateTime,
  gameFeeLine,
  gstLabel,
  gstNumberLine,
  gstSentence,
  lateWithdrawalLine,
  parseMoney,
  type MoneyString,
  type PaymentDocumentKind,
} from '@sgm/shared';

/** Why the payment was charged: the snapshot's `charge_reason`. */
export type DocumentChargeReason = 'GAME_FEE' | 'LATE_WITHDRAWAL';

/** One payment line (`payment_line_items`): position 0 is the registrant, 1 and 2 are guests; the fee is GST-inclusive. */
export interface DocumentFactLine {
  readonly position: number;
  readonly unitFee: MoneyString;
}

/** Everything a document is printed from. Built by `read.ts` from `payment_documents` and `payments`; never from a clock. */
export interface DocumentFacts {
  readonly kind: PaymentDocumentKind;
  /** The frozen printed number (`INV-000001`). */
  readonly numberDisplay: string;
  readonly issuedAt: Date;
  readonly paidAt: Date;
  readonly layoutVersion: number;
  readonly supplierName: string;
  /** The charge-time GST number snapshot (digits), null on a receipt. */
  readonly gstNumber: string | null;
  readonly rateBps: number;
  readonly buyerName: string;
  readonly sessionLocation: string;
  readonly sessionStartsAt: Date;
  readonly chargeReason: DocumentChargeReason;
  readonly lines: readonly DocumentFactLine[];
  /** The stored `payments` columns, printed as they are. */
  readonly subtotalAmount: MoneyString;
  readonly gstAmount: MoneyString;
  readonly amount: MoneyString;
}

export interface DocumentModelLine {
  readonly description: string;
  readonly amount: string;
}

/** What a layout prints: text only, already formatted. */
export interface DocumentModel {
  readonly kind: PaymentDocumentKind;
  readonly layoutVersion: number;
  /** The PDF `Title` metadata: `Tax invoice INV-000001`. */
  readonly pdfTitle: string;
  readonly title: string;
  readonly numberLabel: string;
  readonly number: string;
  readonly issuedAt: Date;
  readonly dateOfIssue: string;
  readonly paidOn: string;
  readonly agentLine: string;
  readonly supplierName: string;
  /** `GST number 49-091-850`, null on a receipt. */
  readonly gstNumberLine: string | null;
  readonly buyerName: string;
  readonly gameLocation: string;
  readonly gameWhen: string;
  readonly amountColumnLabel: string;
  readonly lines: readonly DocumentModelLine[];
  /** Tax invoice only: the subtotal, GST and total rows and the closing sentence. */
  readonly totals: DocumentTotals;
}

export type DocumentTotals =
  | {
      readonly kind: 'TAX_INVOICE';
      readonly subtotalLabel: string;
      readonly subtotal: string;
      readonly gstLabel: string;
      readonly gst: string;
      readonly totalLabel: string;
      readonly total: string;
      readonly sentence: string;
    }
  | { readonly kind: 'RECEIPT'; readonly totalLabel: string; readonly total: string };

const printMoney = (value: MoneyString): string => formatNZD(parseMoney(value));

export function buildDocumentModel(facts: DocumentFacts): DocumentModel {
  const gameDay = formatNzDateLong(facts.sessionStartsAt);
  const taxInvoice = facts.kind === 'TAX_INVOICE';
  const lines = [...facts.lines]
    .sort((a, b) => a.position - b.position)
    .map<DocumentModelLine>((line) => ({
      description:
        facts.chargeReason === 'LATE_WITHDRAWAL'
          ? lateWithdrawalLine(line.position, facts.sessionLocation, gameDay)
          : gameFeeLine(line.position),
      amount: printMoney(line.unitFee),
    }));
  const title = DOCUMENT_TITLES[facts.kind];
  return {
    kind: facts.kind,
    layoutVersion: facts.layoutVersion,
    pdfTitle: `${title} ${facts.numberDisplay}`,
    title,
    numberLabel: DOCUMENT_NUMBER_LABELS[facts.kind],
    number: facts.numberDisplay,
    issuedAt: facts.issuedAt,
    dateOfIssue: formatNzDateLong(facts.issuedAt),
    paidOn: formatNzDateLong(facts.paidAt),
    agentLine: agentLine(facts.supplierName),
    supplierName: facts.supplierName,
    gstNumberLine: taxInvoice && facts.gstNumber !== null ? gstNumberLine(facts.gstNumber) : null,
    buyerName: facts.buyerName,
    gameLocation: facts.sessionLocation,
    gameWhen: formatNzWeekdayDateTime(facts.sessionStartsAt),
    amountColumnLabel: AMOUNT_COLUMN_LABELS[facts.kind],
    lines,
    totals: taxInvoice
      ? {
          kind: 'TAX_INVOICE',
          subtotalLabel: DOCUMENT_LABELS.subtotal,
          subtotal: printMoney(facts.subtotalAmount),
          gstLabel: gstLabel(facts.rateBps),
          gst: printMoney(facts.gstAmount),
          totalLabel: DOCUMENT_LABELS.total,
          total: printMoney(facts.amount),
          sentence: gstSentence(facts.gstAmount),
        }
      : { kind: 'RECEIPT', totalLabel: DOCUMENT_LABELS.totalPaid, total: printMoney(facts.amount) },
  };
}
