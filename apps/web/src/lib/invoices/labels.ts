import {
  ADMIN_DOCUMENT_ACTION_LABEL,
  DOCUMENT_ACTION_LABELS,
  DOCUMENT_FILE_TYPE_SUFFIX,
  DOCUMENT_NAMES,
  type PaymentDocumentKind,
} from '@sgm/shared';
import type { DownloadErrorCode } from './paths.ts';

/**
 * The web copy of the invoice download actions (UI/UX "Copy table"). The document kind names (`tax invoice`, `receipt`) and the
 * action labels come from the shared `document-copy.ts`, so an accountant's wording change is one edit there. The visible label is
 * always the start of the accessible name (WCAG 2.5.3), and the file type is stated in the name (`(PDF)`).
 */

export const INVOICE_NUMBER_LABEL: Readonly<Record<PaymentDocumentKind, string>> = {
  TAX_INVOICE: 'Invoice number',
  RECEIPT: 'Receipt number',
};

export const INVOICE_NOT_AVAILABLE = 'An invoice is available once the payment is paid.';
export const INVOICE_NOT_FOUND = "We couldn't find this payment.";
export const INVOICE_FORBIDDEN = "You don't have access to this invoice.";

/** The visible text of the player's action: `Download tax invoice` or `Download receipt`. */
export const actionText = (kind: PaymentDocumentKind): string => DOCUMENT_ACTION_LABELS[kind];

/** The visible text of the admin's row action. */
export const ADMIN_ACTION_TEXT = ADMIN_DOCUMENT_ACTION_LABEL;

/** The visible file-type suffix. */
export const FILE_TYPE_SUFFIX = DOCUMENT_FILE_TYPE_SUFFIX;

/** `Download tax invoice for Rosedale Hall, Wed 7 Oct, $17.00 (PDF)`. */
export function playerActionName(
  kind: PaymentDocumentKind,
  context: { location: string; day: string; amount: string },
): string {
  return `${DOCUMENT_ACTION_LABELS[kind]} for ${context.location}, ${context.day}, ${context.amount}${DOCUMENT_FILE_TYPE_SUFFIX}`;
}

/** `Invoice for Priya Shah, Wed 7 Oct, $17.00 (PDF)`. */
export function adminActionName(context: { player: string; day: string; amount: string }): string {
  return `${ADMIN_DOCUMENT_ACTION_LABEL} for ${context.player}, ${context.day}, ${context.amount}${DOCUMENT_FILE_TYPE_SUFFIX}`;
}

export const EXPORT_BUSY = 'Another export is being prepared. Try again in a moment.';
export const EXPORT_FORBIDDEN = "You no longer have access to this team's exports.";
export const EXPORT_FAILED = "We couldn't make your file. Try again in a minute.";
export const EXPORT_CHECK_FIELDS = 'Check the highlighted fields and try again.';

/**
 * `export_too_large` (AC-ERROR-4, CR-3): generic on purpose. The API refuses for the row cap (`INCOME_EXPORT_MAX_ROWS`) OR the
 * encoded-byte cap (`INCOME_EXPORT_MAX_BYTES`) and does not say which, so the sentence never names a row count.
 */
export const EXPORT_TOO_LARGE = 'That export is too large to prepare. Choose a shorter range.';

/**
 * The sentence a landing page shows for a `download_error` code. `kind` words the player's retry sentences (`tax invoice` or
 * `receipt`); an admin landing passes `admin` for the neutral wording; the Income exports page passes `export: true` for the
 * export wording.
 */
export function downloadErrorMessage(
  code: DownloadErrorCode,
  options: { kind?: PaymentDocumentKind; admin?: boolean; export?: boolean } = {},
): string {
  const name = options.kind === undefined ? 'invoice' : DOCUMENT_NAMES[options.kind];
  const exporting = options.export === true;
  switch (code) {
    case 'export_too_large':
      return EXPORT_TOO_LARGE;
    case 'export_busy':
      return EXPORT_BUSY;
    case 'validation_failed':
      return EXPORT_CHECK_FIELDS;
    case 'invoice_not_available':
      return INVOICE_NOT_AVAILABLE;
    case 'not_found':
      return INVOICE_NOT_FOUND;
    case 'forbidden':
      return exporting ? EXPORT_FORBIDDEN : INVOICE_FORBIDDEN;
    case 'invoice_pending':
      return `Your ${name} is being prepared. Try again in a moment.`;
    case 'service_unavailable':
      if (exporting) return EXPORT_FAILED;
      return options.admin === true
        ? "We couldn't download this invoice. Try again in a minute."
        : `We couldn't download your ${name}. Try again in a minute.`;
  }
}

/** The Income exports page and form (UI/UX "Copy table: Income exports page"). */
export const EXPORT_COPY = {
  navLabel: 'Income exports',
  heading: (team: string) => `Income exports for ${team}`,
  title: (team: string) => `Income exports – ${team} – Shared Game Management`,
  intro:
    'Download the payments your team has received, for a GST return or your accounts. Only paid payments are included, counted by the date they were paid (New Zealand time).',
  topUps: "Wallet top-ups aren't included. A top-up is counted when it is used to pay for a game.",
  noPayments: 'Your team has no paid payments yet. A file will only have headings.',
  detailsSummary: "What's in the file",
  detailsIntro:
    'One row for each paid payment, oldest first. Amounts are in New Zealand dollars and the totals add up exactly to the rows.',
  excelSummary:
    'Excel files also have a Summary sheet with the team, period, number of payments and totals.',
  periodLegend: 'Period',
  periodTypes: { custom: 'Custom range', gst: 'GST period', fy: 'Financial year' },
  customHint: 'Both days are included.',
  startDate: 'Start date',
  endDate: 'End date',
  gstLabel: 'GST return period',
  gstHint:
    "Pick a period in the pattern your team uses to file with Inland Revenue. If you're not sure, ask your accountant.",
  fyLabel: 'Financial year',
  fyHint: 'New Zealand financial years run from 1 April to 31 March.',
  formatLegend: 'File format',
  formats: {
    xlsx: { label: 'Excel (.xlsx)', hint: 'A Payments sheet and a Summary sheet with totals.' },
    csv: { label: 'CSV (.csv)', hint: 'One row for each payment. Opens in any spreadsheet.' },
  },
  download: 'Download',
  downloadHint: "Your file downloads when it's ready, and this page stays open.",
} as const;
