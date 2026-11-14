import type { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { adminPaymentsPath } from '../../../../../../../lib/billing/paths.ts';
import { proxyDownload, refuseDownload } from '../../../../../../../lib/invoices/download.ts';

export const dynamic = 'force-dynamic';

/**
 * A team admin's invoice download for any payment of the team (`GET /teams/:teamId/payments/:paymentId/invoice`), from the
 * Payments area. Same behaviour as the payer's route: the bytes, or `303` back to the Payments page with `?download_error=<code>`.
 * The API guard (TEAM_ADMIN of this team only) decides; a malformed id lands on the Payments page as "not found".
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ teamId: string; paymentId: string }> },
): Promise<NextResponse> {
  const { teamId, paymentId } = await context.params;
  if (!z.uuid().safeParse(teamId).success) {
    return refuseDownload(request, '/teams', 'not_found');
  }
  const fallback = adminPaymentsPath(teamId);
  if (!z.uuid().safeParse(paymentId).success) return refuseDownload(request, fallback, 'not_found');
  return proxyDownload({
    apiPath: `/teams/${teamId}/payments/${paymentId}/invoice`,
    request,
    fallbackReturnTo: fallback,
  });
}
