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

/**
 * The sentence a landing page shows for a `download_error` code. `kind` words the player's retry sentences (`tax invoice` or
 * `receipt`); an admin landing passes `admin` for the neutral wording.
 */
export function downloadErrorMessage(
  code: DownloadErrorCode,
  options: { kind?: PaymentDocumentKind; admin?: boolean } = {},
): string {
  const name = options.kind === undefined ? 'invoice' : DOCUMENT_NAMES[options.kind];
  switch (code) {
    case 'invoice_not_available':
      return INVOICE_NOT_AVAILABLE;
    case 'not_found':
      return INVOICE_NOT_FOUND;
    case 'forbidden':
      return INVOICE_FORBIDDEN;
    case 'invoice_pending':
      return `Your ${name} is being prepared. Try again in a moment.`;
    case 'service_unavailable':
      return options.admin === true
        ? "We couldn't download this invoice. Try again in a minute."
        : `We couldn't download your ${name}. Try again in a minute.`;
  }
}
