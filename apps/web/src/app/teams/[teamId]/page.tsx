import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { FormBanner } from '../../../components/auth/form-banner.tsx';
import { LINK_CLASS } from '../../../components/auth/styles.ts';
import { StripAuthParams } from '../../../components/flash-notice.tsx';
import { JoinTeamForm } from '../../../components/teams/join-team-form.tsx';
import { Tag, TeamShell } from '../../../components/teams/team-shell.tsx';
import { apiClient } from '../../../lib/api-client.ts';
import { loginUrl, registerUrl } from '../../../lib/auth/landing.ts';
import { firstParam, type SearchParams } from '../../../lib/auth/page-params.ts';
import { getSessionState } from '../../../lib/auth/session.ts';
import { log } from '../../../lib/log.ts';
import {
  BANNED_HEADING,
  memberCountLabel,
  noticeText,
  teamPageView,
} from '../../../lib/teams/labels.ts';
import { optionalSessionToken } from '../_session.ts';

export const metadata: Metadata = { robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * The status-driven team page (user journey table): a public team to anyone, a private team only to a
 * caller with a non-banned row. An unknown or malformed id and a private team the caller cannot see are
 * the same "We couldn't find that team." page (AC-ERROR-10).
 */
export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ teamId: string }>;
  searchParams: SearchParams;
}) {
  const { teamId } = await params;
  if (!z.uuid().safeParse(teamId).success) notFound();

  const token = await optionalSessionToken();
  const result = await apiClient.teamDetail(teamId, {
    session: token,
    incoming: await headers(),
  });
  if (!result.ok) {
    if (result.status === 404 || result.status === 422) notFound();
    log.warn('web.teams.api_failure', {
      action: 'team_detail',
      status: result.status,
      code: result.error.code,
    });
    throw new Error('The team could not be loaded because the API is unavailable.');
  }

  const { team, myStatus, myRole } = result.data;
  const signedIn = (await getSessionState()).kind === 'signed_in';
  const view = teamPageView({ signedIn, visibility: team.visibility, myStatus, myRole });
  if (view.kind === 'not_found') notFound();

  const here = `/teams/${team.id}`;
  const notice = noticeText(firstParam(await searchParams, 'notice'), { teamName: team.name });

  return (
    <TeamShell>
      <title>{`${team.name} – Shared Game Management`}</title>
      <StripAuthParams />
      {notice === null ? null : <FormBanner kind="notice" lines={[notice]} />}
      <h1 className="min-w-0 break-words text-2xl font-semibold">{team.name}</h1>
      <p className="flex flex-wrap items-center gap-x-3 text-base">
        <Tag>{team.visibility === 'PRIVATE' ? 'Private team' : 'Public team'}</Tag>
        <span>{memberCountLabel(team.memberCount)}</span>
      </p>
      {team.description ? (
        <p className="min-w-0 whitespace-pre-line break-words text-base">{team.description}</p>
      ) : null}

      {view.kind === 'banned' ? <h2 className="text-lg font-semibold">{BANNED_HEADING}</h2> : null}
      {view.label === null ? null : (
        <p className="text-base">
          <span className="sr-only">Your status: </span>
          <strong>{view.label}</strong>
        </p>
      )}
      {view.body === null ? null : <p className="text-base">{view.body}</p>}

      {view.action === 'sign_in' ? (
        <p className="flex flex-wrap gap-x-4">
          <a href={loginUrl({ returnTo: here })} className={LINK_CLASS}>
            Sign in to ask to join
          </a>
          <a href={registerUrl({ returnTo: here })} className={LINK_CLASS}>
            New here? Create an account
          </a>
        </p>
      ) : null}
      {view.action === 'join_form' ? (
        <JoinTeamForm teamId={team.id} teamName={team.name} returnTo={here} />
      ) : null}
      {view.action === 'my_teams' ? (
        <a href="/teams" className={LINK_CLASS}>
          Go to My teams
        </a>
      ) : null}
      {view.action === 'manage' ? (
        <a href={`${here}/manage`} className={LINK_CLASS}>
          Manage team
        </a>
      ) : null}
    </TeamShell>
  );
}
