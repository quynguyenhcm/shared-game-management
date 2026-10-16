import type { Metadata } from 'next';
import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { RedirectType, notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { FormBanner } from '../../../../../components/auth/form-banner.tsx';
import { StripAuthParams } from '../../../../../components/flash-notice.tsx';
import { BankingSection } from '../../../../../components/teams/banking-section.tsx';
import { GstSection } from '../../../../../components/teams/gst-section.tsx';
import { ManageAreaNav } from '../../../../../components/teams/manage-area-nav.tsx';
import { ManageProvider } from '../../../../../components/teams/manage-context.tsx';
import { NoAccess } from '../../../../../components/teams/no-access.tsx';
import { apiClient } from '../../../../../lib/api-client.ts';
import { readCookie } from '../../../../../lib/auth/cookies.ts';
import { loginUrl, sessionExpiredUrl } from '../../../../../lib/auth/landing.ts';
import { firstParam, type SearchParams } from '../../../../../lib/auth/page-params.ts';
import { requireUser } from '../../../../../lib/auth/session.ts';
import { log } from '../../../../../lib/log.ts';
import {
  BACK_TO_SESSION,
  BANKING_INTRO,
  bankingNotice,
  bankingPageUrl,
  bankingReturnTo,
  bankingStatus,
  parseEditParam,
} from '../../../../../lib/teams/banking-view.ts';

export const metadata: Metadata = { robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * The "Banking and GST" area: where the team's payouts go and whether it charges GST. One parallel load
 * (team, banking, GST); a 403 renders the no-access page and never any banking content (AC-ENTRY-2). The
 * API is the authority: this page only shows what it answered, masked (`ending {last4}`).
 */
export default async function BankingPage({
  params,
  searchParams,
}: {
  params: Promise<{ teamId: string }>;
  searchParams: SearchParams;
}) {
  const { teamId } = await params;
  if (!z.uuid().safeParse(teamId).success) notFound();

  const query = await searchParams;
  const edit = parseEditParam(firstParam(query, 'edit'));
  const returnTo = bankingReturnTo(teamId, firstParam(query, 'returnTo'));
  // Where a sign-in returns to: edit mode and the hand-off are kept; the one-shot notice is not.
  const here = bankingPageUrl({ teamId, edit, returnTo });
  await requireUser(here);
  const token = await readCookie('session');
  if (token === null) return redirect(loginUrl({ returnTo: here }), RedirectType.replace);

  const options = { session: token, incoming: await headers() };
  const [detail, banking, gst] = await Promise.all([
    apiClient.teamDetail(teamId, options),
    apiClient.teamBanking(teamId, options),
    apiClient.teamGst(teamId, options),
  ]);

  const guarded = [banking, gst];
  if (guarded.some((result) => !result.ok && result.status === 401)) {
    return redirect(sessionExpiredUrl(here), RedirectType.replace);
  }
  // Not an approved admin (or no such team: the API answers both with the same 403).
  if (guarded.some((result) => !result.ok && result.status === 403)) return <NoAccess />;
  if (guarded.some((result) => !result.ok && result.status === 422)) notFound();
  if (!detail.ok || !banking.ok || !gst.ok) {
    const failed = [detail, banking, gst].find((result) => !result.ok);
    log.warn('web.teams.api_failure', {
      action: 'banking_load',
      status: failed?.ok === false ? failed.status : 0,
      code: failed?.ok === false ? failed.error.code : 'unknown',
    });
    throw new Error('The banking page could not be loaded because the API is unavailable.');
  }

  const { team } = detail.data;
  const view = banking.data.banking;
  const status = bankingStatus(view);
  const noticeCode = firstParam(query, 'notice');
  const notice = bankingNotice(noticeCode, { last4: view.accountNumberLast4 });
  const backLinks =
    noticeCode === 'banking_saved' && returnTo !== undefined
      ? [{ label: BACK_TO_SESSION, href: returnTo }]
      : [];

  return (
    <ManageProvider>
      <title>{`Banking and GST – ${team.name} – Shared Game Management`}</title>
      <StripAuthParams />
      <ManageAreaNav teamId={teamId} current="banking" />
      {notice === null ? null : (
        <FormBanner kind="notice" lines={notice.lines} links={backLinks} focusOnMount />
      )}
      <header className="flex flex-col gap-1">
        <h1 className="min-w-0 break-words text-2xl font-semibold">
          Banking and GST for {team.name}
        </h1>
        <p className="text-base">{BANKING_INTRO}</p>
      </header>
      <p className="rounded-md border-2 border-slate-900 p-4 text-base">
        <strong>{status.lead}</strong> {status.body}
      </p>
      {/* A new key per render: a retry of the form (same render) reuses it, a fresh visit gets a new one (R8). */}
      <BankingSection
        teamId={teamId}
        banking={view}
        editing={edit === 'banking'}
        changeKey={randomUUID()}
        returnTo={returnTo}
      />
      <GstSection teamId={teamId} gst={gst.data.gst} editing={edit === 'gst'} returnTo={returnTo} />
    </ManageProvider>
  );
}
