import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { RedirectType, redirect } from 'next/navigation';
import { BUTTON_CLASS, LINK_CLASS, SECONDARY_BUTTON_CLASS } from '../../components/auth/styles.ts';
import { Tag, TeamShell } from '../../components/teams/team-shell.tsx';
import { apiClient } from '../../lib/api-client.ts';
import { readCookie } from '../../lib/auth/cookies.ts';
import { loginUrl, sessionExpiredUrl } from '../../lib/auth/landing.ts';
import { SessionUnavailableError, requireUser } from '../../lib/auth/session.ts';
import { pendingRequestsLabel, sortMyTeams, statusLabel } from '../../lib/teams/labels.ts';

export const metadata: Metadata = { title: 'My teams' };
export const dynamic = 'force-dynamic';

/** My teams: the status hub that stands in for notifications (journey J7). Banned rows never arrive. */
export default async function MyTeamsPage() {
  await requireUser('/teams');
  const token = await readCookie('session');
  if (token === null) return redirect(loginUrl({ returnTo: '/teams' }), RedirectType.replace);
  const result = await apiClient.mineTeams(token, { incoming: await headers() });
  if (!result.ok) {
    if (result.status === 401) return redirect(sessionExpiredUrl('/teams'), RedirectType.replace);
    throw new SessionUnavailableError();
  }
  const teams = sortMyTeams(result.data.teams);

  return (
    <TeamShell>
      <h1 className="text-2xl font-semibold">My teams</h1>
      <div className="flex flex-col gap-3 sm:flex-row">
        <a href="/teams/new" className={`${BUTTON_CLASS} sm:w-auto`}>
          Create a team
        </a>
        <a href="/teams/find" className={`${SECONDARY_BUTTON_CLASS} sm:w-auto`}>
          Find a team
        </a>
      </div>
      {teams.length === 0 ? (
        <p className="text-base">You&apos;re not in any teams yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {teams.map((team) => {
            const isAdmin = team.status === 'APPROVED' && team.role === 'TEAM_ADMIN';
            const waiting = isAdmin ? (team.pendingRequestCount ?? 0) : 0;
            return (
              <li
                key={team.id}
                className="flex flex-col gap-1 rounded-md border border-slate-300 p-4"
              >
                <h2 className="min-w-0 break-words text-lg font-semibold">
                  <a href={`/teams/${team.id}`} className={LINK_CLASS}>
                    {team.name}
                  </a>
                </h2>
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-base">
                  <strong>{statusLabel(team.status, team.role)}</strong>
                  <Tag>{team.visibility === 'PRIVATE' ? 'Private team' : 'Public team'}</Tag>
                </p>
                {isAdmin ? (
                  <p className="flex flex-wrap gap-x-4">
                    <a href={`/teams/${team.id}/manage`} className={LINK_CLASS}>
                      Manage<span className="sr-only"> {team.name}</span>
                    </a>
                    {waiting > 0 ? (
                      <a href={`/teams/${team.id}/manage#requests`} className={LINK_CLASS}>
                        {pendingRequestsLabel(waiting)}
                      </a>
                    ) : null}
                  </p>
                ) : null}
                {team.status === 'REJECTED' ? (
                  team.visibility === 'PUBLIC' ? (
                    <a href={`/teams/${team.id}`} className={LINK_CLASS}>
                      Ask again<span className="sr-only"> to join {team.name}</span>
                    </a>
                  ) : (
                    <p className="text-base">Ask a team admin for the invite link.</p>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </TeamShell>
  );
}
