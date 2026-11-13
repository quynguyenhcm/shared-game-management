import type { PaymentDocumentKind } from '@sgm/shared';
import { downloadErrorMessage } from '../../lib/invoices/labels.ts';
import { parseDownloadError } from '../../lib/invoices/paths.ts';

/**
 * The sentence a landing page shows after a download did not happen (`?download_error=<code>`, set by the route handler's 303).
 * An unknown or absent code renders nothing. `role="alert"` so a screen reader announces it on arrival: the person just pressed
 * a link and is waiting for the file.
 */
export function DownloadErrorNotice({
  code,
  kind,
  admin,
}: {
  code: string | null | undefined;
  kind?: PaymentDocumentKind;
  admin?: boolean;
}) {
  const parsed = parseDownloadError(code);
  if (parsed === null) return null;
  return (
    <p role="alert" className="rounded-md border-2 border-slate-900 p-3 text-base">
      {downloadErrorMessage(parsed, {
        ...(kind === undefined ? {} : { kind }),
        ...(admin === true ? { admin: true } : {}),
      })}
    </p>
  );
}
