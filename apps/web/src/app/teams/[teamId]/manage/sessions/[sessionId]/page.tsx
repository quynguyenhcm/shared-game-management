import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { RedirectType, notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { FormBanner } from '../../../../../../components/auth/form-banner.tsx';
import { LINK_CLASS } from '../../../../../../components/auth/styles.ts';
import { StripAuthParams } from '../../../../../../components/flash-notice.tsx';
import { CancelSessionConfirm } from '../../../../../../components/teams/cancel-session-confirm.tsx';
import { ManageAreaNav } from '../../../../../../components/teams/manage-area-nav.tsx';
import { ManageProvider } from '../../../../../../components/teams/manage-context.tsx';
import { ManageSection } from '../../../../../../components/teams/manage-section.tsx';
import { NoAccess } from '../../../../../../components/teams/no-access.tsx';
import { SessionForm } from '../../../../../../components/teams/session-form.tsx';
import { SessionSummary } from '../../../../../../components/teams/session-summary.tsx';
import { apiClient } from '../../../../../../lib/api-client.ts';
import { readCookie } from '../../../../../../lib/auth/cookies.ts';
import { loginUrl } from '../../../../../../lib/auth/landing.ts';
import type { SearchParams } from '../../../../../../lib/auth/page-params.ts';
import { requireUser } from '../../../../../../lib/auth/session.ts';
import { guardResults } from '../../../../../../lib/teams/sessions-guard.ts';
import {
  bankingHandoff,
  seriesPath,
  sessionPath,
  sessionsPath,
} from '../../../../../../lib/teams/sessions-paths.ts';
import {
  NOTICE_COUNT_KEYS,
  changeNoticeLine,
  noticeBanner,
  parseNotice,
  readOnlyReason,
  registeredLine,
  sessionHeading,
  sessionScopeLine,
  sessionStatusLine,
} from '../../../../../../lib/teams/sessions-view.ts';

export const metadata: Metadata = { robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * One session: the editor while it is a draft or a published session that has not started, and a read-only
 * summary once it has started, ended, completed, been cancelled or expired as a draft (AC-ERROR-11). A series
 * date is the same editor with its own scope line and a fixed date. `isPayoutConfigured` comes from the banking
 * read so "still a draft, publishes overnight" is true; a failed banking read alone does not stop the page.
 */
export default async function SessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ teamId: string; sessionId: string }>;
  searchParams: SearchParams;
}) {
  const { teamId, sessionId } = await params;
  if (!z.uuid().safeParse(teamId).success || !z.uuid().safeParse(sessionId).success) notFound();

  const query = await searchParams;
  const here = sessionPath(teamId, sessionId);
  await requireUser(here);
  const token = await readCookie('session');
  if (token === null) return redirect(loginUrl({ returnTo: here }), RedirectType.replace);

  const options = { session: token, incoming: await headers() };
  const [detail, result, banking] = await Promise.all([
    apiClient.teamDetail(teamId, options),
    apiClient.getSession(teamId, sessionId, options),
    apiClient.teamBanking(teamId, options),
  ]);
  if (
    guardResults([detail, result], { here, action: 'session_load', optional: [banking] }) ===
    'no_access'
  ) {
    return <NoAccess />;
  }
  if (!detail.ok || !result.ok) {
    throw new Error('The session could not be loaded because the API is unavailable.');
  }

  const { team } = detail.data;
  const { session } = result.data;
  const isPayoutConfigured = banking.ok ? banking.data.banking.isPayoutConfigured : false;
  const bankingHref = bankingHandoff(teamId, here);
  const notice = parseNotice(query);
  const banner = notice === null ? null : noticeBanner(notice, { bankingHref });
  const heading = sessionHeading(session);
  const seriesLink =
    session.recurringRuleId === null
      ? null
      : {
          href: seriesPath(teamId, session.recurringRuleId),
          label: `Back to ${session.seriesName ?? 'the series'}`,
        };

  const top = (
    <>
      <title>{`${heading} – ${team.name} – Shared Game Management`}</title>
      <StripAuthParams also={[...NOTICE_COUNT_KEYS, 'date']} />
      <ManageAreaNav teamId={teamId} current="sessions" />
      {banner === null ? null : (
        <FormBanner kind={banner.kind} lines={banner.lines} links={banner.links} focusOnMount />
      )}
    </>
  );

  // Started, ended, completed, cancelled or an expired draft: a summary with the reason, never disabled inputs.
  if (readOnlyReason(session) !== null) {
    return (
      <ManageProvider>
        {top}
        <h1 className="min-w-0 break-words text-2xl font-semibold">{heading}</h1>
        <SessionSummary
          session={session}
          isPayoutConfigured={isPayoutConfigured}
          backLinks={[
            { href: sessionsPath(teamId), label: 'Back to Sessions' },
            ...(seriesLink === null ? [] : [seriesLink]),
          ]}
        />
      </ManageProvider>
    );
  }

  const status = sessionStatusLine(session, {
    isPayoutConfigured,
    justPublished: notice?.code === 'published',
  });
  const published = session.status === 'PUBLISHED';
  const changeNotice = published ? changeNoticeLine(session.activeRegistrationCount) : null;
  return (
    <ManageProvider>
      {top}
      {seriesLink === null ? null : (
        <a href={seriesLink.href} className={`${LINK_CLASS} self-start`}>
          {`‹ ${seriesLink.label}`}
        </a>
      )}
      <header className="flex flex-col gap-2">
        <h1 className="min-w-0 break-words text-2xl font-semibold">{heading}</h1>
        <p className="text-base text-slate-900">
          {sessionScopeLine({
            seriesName: session.seriesName,
            date: session.date,
            edited: session.isInstanceOverridden,
          })}
        </p>
        <p className="text-base text-slate-900">
          {status.text}{' '}
          {status.link === null ? null : (
            <a href={bankingHref} className={LINK_CLASS}>
              {status.link}
            </a>
          )}
        </p>
        {published ? (
          <p className="text-base text-slate-900">
            {registeredLine(session.activeRegistrationCount)}
          </p>
        ) : null}
        {changeNotice === null ? null : (
          <p className="rounded-md border border-slate-500 p-3 text-base text-slate-900">
            {changeNotice}
          </p>
        )}
      </header>
      <SessionForm teamId={teamId} mode="edit" session={session} bankingHref={bankingHref} />
      <hr className="border-slate-300" />
      <ManageSection id="session" title="Other actions">
        <CancelSessionConfirm teamId={teamId} session={session} />
      </ManageSection>
    </ManageProvider>
  );
}
