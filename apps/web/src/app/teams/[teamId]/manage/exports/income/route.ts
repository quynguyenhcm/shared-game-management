import type { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  proxyDownload,
  refuseDownload,
  seeOther,
} from '../../../../../../lib/invoices/download.ts';
import {
  exportApiQuery,
  exportLandingPath,
  exportsPagePath,
  readExportForm,
} from '../../../../../../lib/invoices/export-view.ts';

export const dynamic = 'force-dynamic';

/**
 * The Income exports download (`GET /teams/:teamId/exports/income`; tax-invoices-and-exports Phase 4, architecture D1, CR-3).
 * The page's plain GET form submits every period group's fields; only the selected type's are sent to the API (its query is
 * strict). The file streams back with the API's `content-disposition`, `cache-control: no-store` and `nosniff`; every refusal
 * (403, a 422 field error or `export_too_large`, 429 `export_busy`, a failure) is a `303` back to the exports page with the
 * entered values, so the form re-renders with them. The landing is always this team's exports page, built from the validated
 * id (a `returnTo` in the query is ignored). Closing the tab aborts the API call (`request.signal` in `proxyDownload`), which
 * cancels the export's Postgres statement and frees its slot.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ teamId: string }> },
): Promise<NextResponse> {
  const { teamId } = await context.params;
  if (!z.uuid().safeParse(teamId).success) return refuseDownload(request, '/teams', 'not_found');

  const values = readExportForm((name) => request.nextUrl.searchParams.get(name));
  const query = exportApiQuery(values);
  if (query === null) {
    return seeOther(exportLandingPath(teamId, values, 'validation_failed', ['period']));
  }
  return proxyDownload({
    apiPath: `/teams/${teamId}/exports/income?${query}`,
    request,
    fallbackReturnTo: exportsPagePath(teamId),
    ignoreReturnTo: true,
    landing: (failure) =>
      failure.apiCode === 'validation_failed'
        ? exportLandingPath(teamId, values, 'validation_failed', failure.fields)
        : exportLandingPath(teamId, values, failure.code, []),
  });
}
