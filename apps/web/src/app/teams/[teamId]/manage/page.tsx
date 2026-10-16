import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { RedirectType, notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { FormBanner } from '../../../../components/auth/form-banner.tsx';
import { StripAuthParams } from '../../../../components/flash-notice.tsx';
import { BannedList } from '../../../../components/teams/banned-list.tsx';
import { InviteLinkPanel } from '../../../../components/teams/invite-link-panel.tsx';
import { JoinRequestList } from '../../../../components/teams/join-request-list.tsx';
import { ManageAreaNav } from '../../../../components/teams/manage-area-nav.tsx';
import { ManageJumpNav } from '../../../../components/teams/manage-jump-nav.tsx';
import { ManageProvider } from '../../../../components/teams/manage-context.tsx';
import { ManageSection } from '../../../../components/teams/manage-section.tsx';
import { MemberList } from '../../../../components/teams/member-list.tsx';
import { NoAccess } from '../../../../components/teams/no-access.tsx';
import { SectionPager } from '../../../../components/teams/section-pager.tsx';
import { apiClient } from '../../../../lib/api-client.ts';
import { readCookie } from '../../../../lib/auth/cookies.ts';
import { loginUrl, sessionExpiredUrl } from '../../../../lib/auth/landing.ts';
import { firstParam, type SearchParams } from '../../../../lib/auth/page-params.ts';
import { requireUser } from '../../../../lib/auth/session.ts';
import { loadWebConfig } from '../../../../lib/config.ts';
import { log } from '../../../../lib/log.ts';
import { BANNED_INTRO, manageSubtitle, noticeText } from '../../../../lib/teams/labels.ts';
import { cursorParam, inviteUrl, pagerHrefs } from '../../../../lib/teams/manage-view.ts';

export const metadata: Metadata = { robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * The "People" area (UI/UX Option 3): join requests, members, the invite link and banned members on one
 * server-rendered page. One parallel load; a 403 from any admin read renders the no-access page and never
 * the lists (AC-ENTRY-5). The API is the authority: this page only shows what it answered.
 */
export default async function ManagePage({
  params,
  searchParams,
}: {
  params: Promise<{ teamId: string }>;
  searchParams: SearchParams;
}) {
  const { teamId } = await params;
  if (!z.uuid().safeParse(teamId).success) notFound();
  const here = `/teams/${teamId}/manage`;
  const me = await requireUser(here);
  const token = await readCookie('session');
  if (token === null) return redirect(loginUrl({ returnTo: here }), RedirectType.replace);

  const query = await searchParams;
  const cursors = {
    requestsAfter: firstParam(query, cursorParam('requests')),
    membersAfter: firstParam(query, cursorParam('members')),
    bannedAfter: firstParam(query, cursorParam('banned')),
  };
  const options = { session: token, incoming: await headers() };
  const [detail, requests, members, banned, invite] = await Promise.all([
    apiClient.teamDetail(teamId, options),
    apiClient.teamMembers(teamId, { status: 'PENDING', after: cursors.requestsAfter }, options),
    apiClient.teamMembers(teamId, { status: 'APPROVED', after: cursors.membersAfter }, options),
    apiClient.teamMembers(teamId, { status: 'BANNED', after: cursors.bannedAfter }, options),
    apiClient.teamInviteCode(teamId, options),
  ]);

  const guarded = [requests, members, banned, invite];
  if (guarded.some((result) => !result.ok && result.status === 401)) {
    return redirect(sessionExpiredUrl(here), RedirectType.replace);
  }
  // Not an approved admin (or no such team: the API answers both with the same 403).
  if (guarded.some((result) => !result.ok && result.status === 403)) return <NoAccess />;
  if (guarded.some((result) => !result.ok && result.status === 422)) notFound();
  if (!detail.ok || !requests.ok || !members.ok || !banned.ok || !invite.ok) {
    const failed = [detail, requests, members, banned, invite].find((result) => !result.ok);
    log.warn('web.teams.api_failure', {
      action: 'manage_load',
      status: failed?.ok === false ? failed.status : 0,
      code: failed?.ok === false ? failed.error.code : 'unknown',
    });
    throw new Error('The team admin area could not be loaded because the API is unavailable.');
  }

  const { team } = detail.data;
  const notice = noticeText(firstParam(query, 'notice'), { teamName: team.name });
  const current: Record<string, string | undefined> = cursors;
  const pager = (
    section: 'requests' | 'members' | 'banned',
    nextCursor: string | null,
  ): { next: string | null; start: string | null } =>
    pagerHrefs({ teamId, section, current, nextCursor });
  const requestsPager = pager('requests', requests.data.nextCursor);
  const membersPager = pager('members', members.data.nextCursor);
  const bannedPager = pager('banned', banned.data.nextCursor);

  return (
    <ManageProvider>
      <title>{`Manage ${team.name} – Shared Game Management`}</title>
      <StripAuthParams />
      <ManageAreaNav teamId={teamId} current="people" />
      {notice === null ? null : <FormBanner kind="notice" lines={[notice]} focusOnMount />}
      <header className="flex flex-col gap-1">
        <h1 className="min-w-0 break-words text-2xl font-semibold">Manage {team.name}</h1>
        <p className="text-base">{manageSubtitle(team.visibility, team.memberCount)}</p>
      </header>
      <ManageJumpNav
        pendingCount={requests.data.members.length}
        pendingHasMore={requests.data.nextCursor !== null}
      />

      <ManageSection id="requests" title="Join requests">
        <JoinRequestList teamId={teamId} requests={requests.data.members} />
        <SectionPager label="join requests" {...requestsPager} />
      </ManageSection>

      <ManageSection id="members" title="Members">
        <MemberList
          teamId={teamId}
          members={members.data.members}
          selfUserId={me.id}
          adminCount={members.data.adminCount}
        />
        <SectionPager label="members" {...membersPager} />
      </ManageSection>

      <ManageSection id="invite" title="Invite link">
        <InviteLinkPanel
          teamId={teamId}
          url={inviteUrl(loadWebConfig().webBaseUrl, invite.data.inviteCode)}
          visibility={team.visibility}
        />
      </ManageSection>

      <ManageSection id="banned" title="Banned members">
        <p className="text-base">{BANNED_INTRO}</p>
        <BannedList members={banned.data.members} />
        <SectionPager label="banned members" {...bannedPager} />
      </ManageSection>
    </ManageProvider>
  );
}
