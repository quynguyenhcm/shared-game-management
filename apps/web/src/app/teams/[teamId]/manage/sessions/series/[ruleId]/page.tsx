import { instantToLocal, type SeriesInstanceResponse } from '@sgm/shared';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { RedirectType, notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { FormBanner } from '../../../../../../../components/auth/form-banner.tsx';
import { LINK_CLASS } from '../../../../../../../components/auth/styles.ts';
import { StripAuthParams } from '../../../../../../../components/flash-notice.tsx';
import { EndSeriesConfirm } from '../../../../../../../components/teams/end-series-confirm.tsx';
import { ManageAreaNav } from '../../../../../../../components/teams/manage-area-nav.tsx';
import { ManageProvider } from '../../../../../../../components/teams/manage-context.tsx';
import { ManageSection } from '../../../../../../../components/teams/manage-section.tsx';
import { NoAccess } from '../../../../../../../components/teams/no-access.tsx';
import { PublishDraftsButton } from '../../../../../../../components/teams/publish-drafts-button.tsx';
import { RefreshWhilePending } from '../../../../../../../components/teams/refresh-while-pending.tsx';
import { SeriesForm } from '../../../../../../../components/teams/series-form.tsx';
import { SeriesSummary } from '../../../../../../../components/teams/series-summary.tsx';
import { apiClient } from '../../../../../../../lib/api-client.ts';
import { readCookie } from '../../../../../../../lib/auth/cookies.ts';
import { loginUrl } from '../../../../../../../lib/auth/landing.ts';
import { firstParam, type SearchParams } from '../../../../../../../lib/auth/page-params.ts';
import { requireUser } from '../../../../../../../lib/auth/session.ts';
import { endSeriesAction } from '../../../../../../../lib/teams/sessions-actions.ts';
import { guardResults } from '../../../../../../../lib/teams/sessions-guard.ts';
import {
  bankingHandoff,
  seriesEditPath,
  seriesPath,
  sessionPath,
} from '../../../../../../../lib/teams/sessions-paths.ts';
import {
  NOTICE_COUNT_KEYS,
  SERIES_COPY,
  editDateLink,
  formatDayShort,
  horizonLine,
  nextSeriesDate,
  noSessionsYetLine,
  noticeBanner,
  parseNotice,
  pastDisclosure,
  seriesBankingNotice,
  sessionLabel,
  sessionWhen,
  splitSeriesInstances,
} from '../../../../../../../lib/teams/sessions-view.ts';

export const metadata: Metadata = { robots: { index: false } };
export const dynamic = 'force-dynamic';

const CHIP = 'rounded-md border border-slate-500 px-2 py-1 text-sm text-slate-900';

/** One dated row of the series: the date and times, label chips, and a link whose text names the date. */
function InstanceRow({
  teamId,
  instance,
  isPayoutConfigured,
}: {
  teamId: string;
  instance: SeriesInstanceResponse;
  isPayoutConfigured: boolean;
}) {
  const when = sessionWhen(instance);
  const { label, tags } = sessionLabel({ ...instance, seriesName: null }, { isPayoutConfigured });
  return (
    <li className="flex flex-col gap-1 rounded-md border border-slate-300 p-3">
      <p className="text-base font-medium text-slate-900">
        {when.range === null
          ? formatDayShort(instance.date)
          : `${formatDayShort(instance.date)}, ${when.range}`}
      </p>
      <ul className="flex flex-wrap gap-2">
        {[label, ...tags].map((text) => (
          <li key={text} className={CHIP}>
            {text}
          </li>
        ))}
      </ul>
      <a href={sessionPath(teamId, instance.id)} className={`${LINK_CLASS} self-start`}>
        {editDateLink(instance.date)}
      </a>
    </li>
  );
}

/**
 * One series, summary-first (UI/UX D3 option 1): the name and one-line summary, the banking notice, the sessions
 * (with the waiting state and the horizon line), the details with "Change series details", and End series.
 * `?edit=details` is form-first: the form and its effect line replace the sessions list, so there is no way to
 * click into a date with an unsaved form. An ended series ignores edit mode. A 403 renders the no-access page
 * and never any series data (AC-ERROR-8).
 */
export default async function SeriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ teamId: string; ruleId: string }>;
  searchParams: SearchParams;
}) {
  const { teamId, ruleId } = await params;
  if (!z.uuid().safeParse(teamId).success || !z.uuid().safeParse(ruleId).success) notFound();

  const query = await searchParams;
  const wantsEdit = firstParam(query, 'edit') === 'details';
  // Where a sign-in returns to: edit mode is kept, the one-shot notice is not.
  const here = wantsEdit ? seriesEditPath(teamId, ruleId) : seriesPath(teamId, ruleId);
  await requireUser(here);
  const token = await readCookie('session');
  if (token === null) return redirect(loginUrl({ returnTo: here }), RedirectType.replace);

  const options = { session: token, incoming: await headers() };
  const [detail, result] = await Promise.all([
    apiClient.teamDetail(teamId, options),
    apiClient.getSeries(teamId, ruleId, options),
  ]);
  if (guardResults([detail, result], { here, action: 'series_load' }) === 'no_access') {
    return <NoAccess />;
  }
  if (!detail.ok || !result.ok) {
    throw new Error('The series could not be loaded because the API is unavailable.');
  }

  const { team } = detail.data;
  const { series } = result.data;
  const viewPath = seriesPath(teamId, ruleId);
  const bankingHref = bankingHandoff(
    teamId,
    wantsEdit && series.isActive ? seriesEditPath(teamId, ruleId) : viewPath,
  );
  const notice = parseNotice(query);
  const banner = notice === null ? null : noticeBanner(notice, { bankingHref });
  const top = (
    <>
      <StripAuthParams also={[...NOTICE_COUNT_KEYS, 'date']} />
      <ManageAreaNav teamId={teamId} current="sessions" />
      {banner === null ? null : (
        <FormBanner kind={banner.kind} lines={banner.lines} links={banner.links} focusOnMount />
      )}
    </>
  );

  if (wantsEdit && series.isActive) {
    return (
      <ManageProvider>
        <title>{`${SERIES_COPY.editHeading} – ${team.name} – Shared Game Management`}</title>
        {top}
        <a href={viewPath} className={`${LINK_CLASS} self-start`}>
          ‹ Back to series
        </a>
        <header className="flex flex-col gap-1">
          <h1 className="min-w-0 break-words text-2xl font-semibold">{SERIES_COPY.editHeading}</h1>
          <p className="text-base text-slate-900">{series.name}</p>
        </header>
        <SeriesForm
          teamId={teamId}
          mode="edit"
          series={series}
          bankingHref={bankingHref}
          isPayoutConfigured={series.isPayoutConfigured}
          cancelHref={viewPath}
        />
      </ManageProvider>
    );
  }

  // "Today" for the horizon line and the End series default is the Pacific/Auckland calendar date.
  const todayNz = instantToLocal(new Date()).date;
  const { listed, past } = splitSeriesInstances(series.instances);
  const bankingNotice = series.isActive ? seriesBankingNotice(series) : null;
  const next = series.isActive ? nextSeriesDate(series, todayNz) : null;
  return (
    <ManageProvider>
      <title>{`${series.name} – ${team.name} – Shared Game Management`}</title>
      {top}
      <SeriesSummary series={series} editHref={seriesEditPath(teamId, ruleId)} part="header" />
      <ManageSection id="series" title={SERIES_COPY.sessionsHeading}>
        {bankingNotice === null ? null : (
          <aside
            aria-labelledby="series-banking-notice"
            className="flex flex-col gap-2 rounded-md border-2 border-slate-900 p-4"
          >
            <p id="series-banking-notice" className="text-base">
              {bankingNotice.text}
            </p>
            {bankingNotice.link === null ? null : (
              <a href={bankingHref} className={`${LINK_CLASS} self-start`}>
                {bankingNotice.link}
              </a>
            )}
            {bankingNotice.button === null ? null : (
              <PublishDraftsButton teamId={teamId} ruleId={ruleId} />
            )}
          </aside>
        )}
        <RefreshWhilePending
          pending={series.materialising}
          href={viewPath}
          sessionCount={listed.length}
        />
        {listed.length === 0 ? null : (
          <ul className="flex flex-col gap-2">
            {listed.map((instance) => (
              <InstanceRow
                key={instance.id}
                teamId={teamId}
                instance={instance}
                isPayoutConfigured={series.isPayoutConfigured}
              />
            ))}
          </ul>
        )}
        {next === null || series.materialising ? null : (
          <p className="text-base text-slate-900">
            {listed.length === 0 ? noSessionsYetLine(next) : horizonLine(next)}
          </p>
        )}
        {past.length === 0 ? null : (
          <details className="flex flex-col gap-2">
            <summary className="min-h-11 cursor-pointer py-2 text-base text-blue-800 underline">
              {pastDisclosure(past.length)}
            </summary>
            <ul className="flex flex-col gap-2">
              {past.map((instance) => (
                <InstanceRow
                  key={instance.id}
                  teamId={teamId}
                  instance={instance}
                  isPayoutConfigured={series.isPayoutConfigured}
                />
              ))}
            </ul>
          </details>
        )}
      </ManageSection>
      <SeriesSummary
        series={series}
        editHref={seriesEditPath(teamId, ruleId)}
        part="details"
        endSeries={
          <EndSeriesConfirm
            id="end-series"
            action={endSeriesAction}
            fields={{ teamId, ruleId, expectedVersion: String(series.version) }}
            instances={series.instances}
            defaultLastDate={todayNz}
          />
        }
      />
    </ManageProvider>
  );
}
