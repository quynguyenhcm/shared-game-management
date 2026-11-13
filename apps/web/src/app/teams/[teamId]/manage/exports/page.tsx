import { INCOME_EXPORT_COLUMNS } from '@sgm/shared';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { RedirectType, notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { IncomeExportForm } from '../../../../../components/invoices/income-export-form.tsx';
import { ManageAreaNav } from '../../../../../components/teams/manage-area-nav.tsx';
import { ManageProvider } from '../../../../../components/teams/manage-context.tsx';
import { NoAccess } from '../../../../../components/teams/no-access.tsx';
import { apiClient } from '../../../../../lib/api-client.ts';
import { readCookie } from '../../../../../lib/auth/cookies.ts';
import { loginUrl } from '../../../../../lib/auth/landing.ts';
import { firstParam, type SearchParams } from '../../../../../lib/auth/page-params.ts';
import { requireUser } from '../../../../../lib/auth/session.ts';
import type { FieldErrors } from '../../../../../lib/auth/validation.ts';
import {
  EXPORT_FIELD_PARAM,
  defaultExportValues,
  exportFieldErrors,
  exportsPagePath,
  financialYearOptions,
  gstPeriodGroups,
  mergeExportValues,
  readExportForm,
} from '../../../../../lib/invoices/export-view.ts';
import {
  EXPORT_CHECK_FIELDS,
  EXPORT_COPY,
  downloadErrorMessage,
} from '../../../../../lib/invoices/labels.ts';
import { DOWNLOAD_ERROR_PARAM, parseDownloadError } from '../../../../../lib/invoices/paths.ts';
import { guardResults } from '../../../../../lib/teams/sessions-guard.ts';

export const metadata: Metadata = { robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * The "Income exports" manage area (tax-invoices-and-exports AC-ENTRY-2, AC-HAPPY-6..9, AC-ERROR-3, 4). The API is the guard:
 * its periods route answers 403 to a plain MEMBER, another team's admin and a GLOBAL_ADMIN who is not an approved admin of this
 * team (H9), which renders the no-access page with none of the area. The page loads the option lists server-side with the
 * session bearer; the download itself is the form's GET to `./income` (a route handler), whose refusals land back here with
 * `?download_error=<code>`, the entered values and, for a 422, the refused field names (messages re-derived, never read from
 * the URL).
 */
export default async function IncomeExportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ teamId: string }>;
  searchParams: SearchParams;
}) {
  const { teamId } = await params;
  if (!z.uuid().safeParse(teamId).success) notFound();

  const query = await searchParams;
  const here = exportsPagePath(teamId);
  await requireUser(here);
  const token = await readCookie('session');
  if (token === null) return redirect(loginUrl({ returnTo: here }), RedirectType.replace);

  const options = { session: token, incoming: await headers() };
  const [detail, periods] = await Promise.all([
    apiClient.teamDetail(teamId, options),
    apiClient.incomeExportPeriods(teamId, options),
  ]);
  if (
    guardResults([periods], { here, action: 'income_exports_load', optional: [detail] }) ===
    'no_access'
  ) {
    return <NoAccess />;
  }
  if (!periods.ok) throw new Error('unavailable');

  const teamName = detail.ok ? detail.data.team.name : 'your team';
  const code = parseDownloadError(firstParam(query, DOWNLOAD_ERROR_PARAM));
  const values = mergeExportValues(
    defaultExportValues(periods.data),
    readExportForm((name) => firstParam(query, name)),
  );
  let errors: FieldErrors = {};
  let formError: string | null = null;
  if (code === 'validation_failed') {
    const flagged = query[EXPORT_FIELD_PARAM];
    errors = exportFieldErrors(
      values,
      flagged === undefined ? [] : [flagged].flat(),
      periods.data.today,
    );
    if (Object.keys(errors).length === 0) formError = EXPORT_CHECK_FIELDS;
  } else if (code !== null) {
    formError = downloadErrorMessage(code, { export: true });
  }

  return (
    <ManageProvider>
      <title>{EXPORT_COPY.title(teamName)}</title>
      <ManageAreaNav teamId={teamId} current="exports" />
      <header className="flex flex-col gap-2">
        <h1 className="min-w-0 break-words text-2xl font-semibold">
          {EXPORT_COPY.heading(teamName)}
        </h1>
        <p className="text-base">{EXPORT_COPY.intro}</p>
        <p className="text-base">{EXPORT_COPY.topUps}</p>
        {periods.data.firstPaidDate === null ? (
          <p className="text-base">{EXPORT_COPY.noPayments}</p>
        ) : null}
      </header>
      <details className="max-w-xl rounded-md border border-slate-500 px-3">
        <summary className="flex min-h-11 cursor-pointer items-center text-base font-medium">
          {EXPORT_COPY.detailsSummary}
        </summary>
        <div className="flex flex-col gap-2 pb-3">
          <p className="text-base">{EXPORT_COPY.detailsIntro}</p>
          <dl className="flex flex-col gap-1">
            {INCOME_EXPORT_COLUMNS.map((column) => (
              <div key={column.key} className="break-words">
                <dt className="inline font-medium">{column.header}: </dt>
                <dd className="inline">{column.help}</dd>
              </div>
            ))}
          </dl>
          <p className="text-base">{EXPORT_COPY.excelSummary}</p>
        </div>
      </details>
      <div className="w-full max-w-xl">
        <IncomeExportForm
          teamId={teamId}
          values={values}
          errors={errors}
          formError={formError}
          financialYears={financialYearOptions(periods.data)}
          gstGroups={gstPeriodGroups(periods.data)}
        />
      </div>
    </ManageProvider>
  );
}
