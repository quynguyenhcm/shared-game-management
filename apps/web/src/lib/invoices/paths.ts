/**
 * The invoice download URLs and the `download_error` landing contract, in one place (tax-invoices-and-exports architecture
 * section 5). The download actions are plain anchors to the Next route handlers; a handler streams the file, or answers `303` back
 * to a validated `returnTo` page with `?download_error=<code>` and that page renders the sentence. Ids are UUIDs the caller
 * validated. The player-dashboard's "Payments & Wallet" tab reuses exactly these two paths plus `MyPaymentRow.document`.
 */

/** The query key an error landing carries; its value is one of `DOWNLOAD_ERROR_CODES`. */
export const DOWNLOAD_ERROR_PARAM = 'download_error';

/** Why a download did not happen. A code only, never a name, an amount or a file name. */
export const DOWNLOAD_ERROR_CODES = [
  'invoice_not_available',
  'invoice_pending',
  'not_found',
  'forbidden',
  'service_unavailable',
  // income exports (Phase 4): the row/byte cap (AC-ERROR-4), the export semaphore (CR-3) and a 422 field error (AC-ERROR-3)
  'export_too_large',
  'export_busy',
  'validation_failed',
] as const;
export type DownloadErrorCode = (typeof DOWNLOAD_ERROR_CODES)[number];

export function parseDownloadError(value: string | null | undefined): DownloadErrorCode | null {
  return DOWNLOAD_ERROR_CODES.find((code) => code === value) ?? null;
}

function withReturnTo(path: string, returnTo: string | undefined): string {
  return returnTo === undefined ? path : `${path}?returnTo=${encodeURIComponent(returnTo)}`;
}

/** The payer's download link (`GET /payments/:paymentId/invoice`); `returnTo` is the page the link lives on. */
export const myDocumentPath = (paymentId: string, returnTo?: string): string =>
  withReturnTo(`/payments/${paymentId}/invoice`, returnTo);

/** The team admin's download link for any payment of the team. */
export const teamDocumentPath = (teamId: string, paymentId: string, returnTo?: string): string =>
  withReturnTo(`/teams/${teamId}/manage/payments/${paymentId}/invoice`, returnTo);

/** `path` with `download_error=<code>` set (an older value replaced, other parameters kept). */
export function withDownloadError(path: string, code: DownloadErrorCode): string {
  const [base = '', query = ''] = path.split('?', 2);
  const params = new URLSearchParams(query);
  params.set(DOWNLOAD_ERROR_PARAM, code);
  return `${base}?${params.toString()}`;
}
