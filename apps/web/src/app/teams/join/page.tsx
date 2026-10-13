import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { RedirectType, redirect } from 'next/navigation';
import { LINK_CLASS } from '../../../components/auth/styles.ts';
import { JoinTeamForm } from '../../../components/teams/join-team-form.tsx';
import { Tag, TeamShell } from '../../../components/teams/team-shell.tsx';
import { apiClient } from '../../../lib/api-client.ts';
import { readCookie } from '../../../lib/auth/cookies.ts';
import { buildUrl, loginUrl, sessionExpiredUrl } from '../../../lib/auth/landing.ts';
import { firstParam, type SearchParams } from '../../../lib/auth/page-params.ts';
import { requireUser } from '../../../lib/auth/session.ts';
import { log } from '../../../lib/log.ts';
import {
  BANNED_HEADING,
  INVITE_INVALID_HEADING,
  inviteView,
  memberCountLabel,
  teamErrorLines,
} from '../../../lib/teams/labels.ts';

export const metadata: Metadata = { title: 'Team invite', robots: { index: false } };
export const dynamic = 'force-dynamic';

function InviteInvalid() {
  return (
    <TeamShell>
      <title>Invite link not valid – Shared Game Management</title>
      <h1 className="text-2xl font-semibold">{INVITE_INVALID_HEADING}</h1>
      <p className="text-base">{teamErrorLines('invite_invalid')?.[0]}</p>
      <p className="flex flex-wrap gap-x-4">
        <a href="/teams/find" className={LINK_CLASS}>
          Find a team
        </a>
        <a href="/teams" className={LINK_CLASS}>
          My teams
        </a>
      </p>
    </TeamShell>
  );
}

/**
 * The invite landing (`no-store` and `no-referrer` come from proxy.ts). The code is looked up by POST so
 * it never reaches an API log, and the join redirect swaps this URL out of history (A1).
 */
export default async function InvitePage({ searchParams }: { searchParams: SearchParams }) {
  const code = firstParam(await searchParams, 'code');
  const returnTo = buildUrl('/teams/join', { code });
  await requireUser(returnTo);
  if (code === undefined || code === '') return <InviteInvalid />;

  const token = await readCookie('session');
  if (token === null) return redirect(loginUrl({ returnTo }), RedirectType.replace);
  const result = await apiClient.inviteLookup(
    { code },
    { session: token, incoming: await headers() },
  );

  if (!result.ok) {
    if (result.status === 401) return redirect(sessionExpiredUrl(returnTo), RedirectType.replace);
    if (result.error.code === 'banned_from_team') {
      return (
        <TeamShell>
          <title>Team – Shared Game Management</title>
          <h1 className="text-2xl font-semibold">{BANNED_HEADING}</h1>
        </TeamShell>
      );
    }
    if (result.error.code === 'invite_invalid' || result.status === 422) return <InviteInvalid />;
    log.warn('web.teams.api_failure', {
      action: 'invite_lookup',
      status: result.status,
      code: result.error.code,
    });
    // An outage is not an invalid link: the page error keeps the URL (and the code) for "Try again".
    throw new Error('The invite could not be loaded because the API is unavailable.');
  }

  const { team, myStatus } = result.data;
  const view = inviteView(myStatus);
  return (
    <TeamShell>
      <title>Team invite – Shared Game Management</title>
      <p className="text-base">You&apos;ve been invited to join</p>
      <h1 className="min-w-0 break-words text-2xl font-semibold">{team.name}</h1>
      <p className="flex flex-wrap items-center gap-x-3 text-base">
        <Tag>{team.visibility === 'PRIVATE' ? 'Private team' : 'Public team'}</Tag>
        <span>{memberCountLabel(team.memberCount)}</span>
      </p>
      {team.description ? (
        <p className="min-w-0 whitespace-pre-line break-words text-base">{team.description}</p>
      ) : null}
      {view.label !== null ? (
        <p className="text-base">
          <span className="sr-only">Your status: </span>
          <strong>{view.label}</strong>
        </p>
      ) : null}
      {view.body !== null ? <p className="text-base">{view.body}</p> : null}
      {view.action === 'team_page' ? (
        <a href={`/teams/${team.id}`} className={LINK_CLASS}>
          Go to team page
        </a>
      ) : null}
      {view.action === 'join_form' ? (
        <JoinTeamForm teamId={team.id} teamName={team.name} inviteCode={code} returnTo={returnTo} />
      ) : null}
    </TeamShell>
  );
}
