import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { RedirectType, notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { FormBanner } from '../../../../../components/auth/form-banner.tsx';
import {
  BUTTON_CLASS,
  LINK_CLASS,
  SECONDARY_BUTTON_CLASS,
} from '../../../../../components/auth/styles.ts';
import { StripAuthParams } from '../../../../../components/flash-notice.tsx';
import { ManageAreaNav } from '../../../../../components/teams/manage-area-nav.tsx';
import { ManageProvider } from '../../../../../components/teams/manage-context.tsx';
import { NoAccess } from '../../../../../components/teams/no-access.tsx';
import { SessionList } from '../../../../../components/teams/session-list.tsx';
import { apiClient } from '../../../../../lib/api-client.ts';
import { readCookie } from '../../../../../lib/auth/cookies.ts';
import { loginUrl } from '../../../../../lib/auth/landing.ts';
import { firstParam, type SearchParams } from '../../../../../lib/auth/page-params.ts';
import { requireUser } from '../../../../../lib/auth/session.ts';
import { guardResults } from '../../../../../lib/teams/sessions-guard.ts';
import {
  bankingHandoff,
  newSeriesPath,
  newSessionPath,
  sessionsPath,
} from '../../../../../lib/teams/sessions-paths.ts';
import {
  LIST_COPY,
  NOTICE_COUNT_KEYS,
  listHeading,
  noticeBanner,
  parseNotice,
  seriesRows,
  showListBankingNotice,
} from '../../../../../lib/teams/sessions-view.ts';

export const metadata: Metadata = { robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * The "Sessions" area (UI/UX D4): Upcoming, Drafts, Series, Past and cancelled, each paged on its own keyset
 * cursor, with one page-level banking notice. One parallel load (team, the three list views and the series list); a 403 renders
 * the no-access page and never any session data (AC-ERROR-8). The API is the authority: this page only shows
 * what it answered, and labels come from the API's `phase` and `draftReason` (the web never reads the clock).
 */
export default async function SessionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ teamId: string }>;
  searchParams: SearchParams;
}) {
  const { teamId } = await params;
  if (!z.uuid().safeParse(teamId).success) notFound();

  const query = await searchParams;
  const cursors = {
    upcoming: firstParam(query, 'upcoming'),
    drafts: firstParam(query, 'drafts'),
    past: firstParam(query, 'past'),
  };
  // Where a sign-in returns to: the list itself (cursors and the one-shot notice are not kept).
  const here = sessionsPath(teamId);
  await requireUser(here);
  const token = await readCookie('session');
  if (token === null) return redirect(loginUrl({ returnTo: here }), RedirectType.replace);

  const options = { session: token, incoming: await headers() };
  const view = (name: 'upcoming' | 'drafts' | 'past') =>
    apiClient.listSessions(
      teamId,
      cursors[name] === undefined ? { view: name } : { view: name, cursor: cursors[name] },
      options,
    );
  const [detail, upcoming, drafts, past, seriesList] = await Promise.all([
    apiClient.teamDetail(teamId, options),
    view('upcoming'),
    view('drafts'),
    view('past'),
    apiClient.listSeries(teamId, options),
  ]);
  if (
    guardResults([detail, upcoming, drafts, past, seriesList], {
      here,
      action: 'sessions_list_load',
    }) === 'no_access'
  ) {
    return <NoAccess />;
  }
  if (!detail.ok || !upcoming.ok || !drafts.ok || !past.ok || !seriesList.ok) {
    throw new Error('The sessions page could not be loaded because the API is unavailable.');
  }

  const { team } = detail.data;
  const isPayoutConfigured = upcoming.data.isPayoutConfigured;
  const loaded = [...upcoming.data.sessions, ...drafts.data.sessions, ...past.data.sessions];
  const bankingHref = bankingHandoff(teamId, here);
  const notice = parseNotice(query);
  const banner = notice === null ? null : noticeBanner(notice, { bankingHref });

  return (
    <ManageProvider>
      <title>{`Sessions – ${team.name} – Shared Game Management`}</title>
      <StripAuthParams also={[...NOTICE_COUNT_KEYS, 'date']} />
      <ManageAreaNav teamId={teamId} current="sessions" />
      {banner === null ? null : (
        <FormBanner kind={banner.kind} lines={banner.lines} links={banner.links} focusOnMount />
      )}
      <header className="flex flex-col gap-1">
        <h1 className="min-w-0 break-words text-2xl font-semibold">{listHeading(team.name)}</h1>
        <p className="text-base">{LIST_COPY.intro}</p>
      </header>
      <div className="flex flex-col gap-2 sm:flex-row">
        <a href={newSessionPath(teamId)} className={`${BUTTON_CLASS} sm:w-auto`}>
          {LIST_COPY.newSession}
        </a>
        <a href={newSeriesPath(teamId)} className={`${SECONDARY_BUTTON_CLASS} sm:w-auto`}>
          {LIST_COPY.newSeries}
        </a>
      </div>
      <p className="text-base">{LIST_COPY.createHint}</p>
      {showListBankingNotice(loaded, isPayoutConfigured) ? (
        <aside
          aria-labelledby="banking-notice"
          className="flex flex-col gap-1 rounded-md border-2 border-slate-900 p-4"
        >
          <p id="banking-notice" className="text-base">
            {LIST_COPY.bankingNotice}
          </p>
          <a href={bankingHref} className={`${LINK_CLASS} self-start`}>
            {LIST_COPY.bankingLink}
          </a>
        </aside>
      ) : null}
      <SessionList
        teamId={teamId}
        isPayoutConfigured={isPayoutConfigured}
        upcoming={upcoming.data}
        drafts={drafts.data}
        past={past.data}
        series={seriesRows(seriesList.data.series, loaded)}
        current={cursors}
      />
    </ManageProvider>
  );
}
