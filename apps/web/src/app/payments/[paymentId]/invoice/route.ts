import type { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { UNPAID_PAYMENTS_PATH, paymentPath } from '../../../../lib/billing/paths.ts';
import { proxyDownload, refuseDownload } from '../../../../lib/invoices/download.ts';

export const dynamic = 'force-dynamic';

/**
 * The payer's invoice download (`GET /payments/:paymentId/invoice`): streams the API's PDF as an attachment, or answers `303` back
 * to the page the link lives on (`?returnTo=`, default the payment page) with `?download_error=<code>`. A plain link, so it works
 * without JavaScript, and a failed download never shows a raw JSON body.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ paymentId: string }> },
): Promise<NextResponse> {
  const { paymentId } = await context.params;
  if (!z.uuid().safeParse(paymentId).success) {
    return refuseDownload(request, UNPAID_PAYMENTS_PATH, 'not_found');
  }
  return proxyDownload({
    apiPath: `/payments/${paymentId}/invoice`,
    request,
    fallbackReturnTo: paymentPath(paymentId),
  });
}
