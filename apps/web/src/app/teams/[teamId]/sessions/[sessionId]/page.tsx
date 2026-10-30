import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { RedirectType, notFound, redirect } from 'next/navigation';
import { instantToLocal } from '@sgm/shared';
import { z } from 'zod';
import { NotMember } from '../../../../../components/registrations/not-member.tsx';
import { PlayerSessionSummary } from '../../../../../components/registrations/player-session-summary.tsx';
import { RegistrationPanel } from '../../../../../components/registrations/registration-panel.tsx';
import { TeamShell } from '../../../../../components/teams/team-shell.tsx';
import { apiClient } from '../../../../../lib/api-client.ts';
import { readCookie } from '../../../../../lib/auth/cookies.ts';
import { loginUrl, sessionExpiredUrl } from '../../../../../lib/auth/landing.ts';
import { requireUser } from '../../../../../lib/auth/session.ts';
import { log } from '../../../../../lib/log.ts';
import { playerSessionPath } from '../../../../../lib/registrations/paths.ts';
import { formatDayShort } from '../../../../../lib/teams/sessions-view.ts';

export const metadata: Metadata = { robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * The player session page: registration-and-waitlist's, not session-scheduling-engine's (R23; the admin pages live in the
 * team's manage area). One server read, `GET .../registration`, feeds both the summary and the panel; the page
 * renders only what the API answered. 401 sends the caller to sign-in (returning here), 403 is the not-a-member state (AC-ENTRY-2),
 * and 404 (another team's session, a DRAFT, an unknown or malformed id) is one identical not-found. Any other failure throws to
 * the segment's `error.tsx`, never signing anyone out. `proxy.ts` also protects this path and marks it `no-store`: the page
 * shows the caller's own guests.
 */
export default async function PlayerSessionPage({
  params,
}: {
  params: Promise<{ teamId: string; sessionId: string }>;
}) {
  const { teamId, sessionId } = await params;
  if (!z.uuid().safeParse(teamId).success || !z.uuid().safeParse(sessionId).success) notFound();

  const here = playerSessionPath(teamId, sessionId);
  await requireUser(here);
  const token = await readCookie('session');
  if (token === null) return redirect(loginUrl({ returnTo: here }), RedirectType.replace);

  const options = { session: token, incoming: await headers() };
  const [read, team] = await Promise.all([
    apiClient.sessionRegistration(teamId, sessionId, options),
    apiClient.teamDetail(teamId, options),
  ]);

  if (!read.ok) {
    if (read.status === 401) return redirect(sessionExpiredUrl(here), RedirectType.replace);
    if (read.status === 403) {
      return (
        <TeamShell>
          <NotMember teamId={teamId} />
        </TeamShell>
      );
    }
    if (read.status === 404 || read.status === 422) notFound();
    log.warn('web.registrations.api_failure', {
      action: 'session_page',
      status: read.status,
      code: read.error.code,
    });
    throw new Error('The session could not be loaded because the API is unavailable.');
  }

  const { session } = read.data;
  const day = formatDayShort(instantToLocal(new Date(session.startsAt)).date);

  return (
    <TeamShell>
      <title>{`${session.location}, ${day} – Shared Game Management`}</title>
      <PlayerSessionSummary
        teamId={teamId}
        teamName={team.ok ? team.data.team.name : null}
        session={session}
      />
      <RegistrationPanel teamId={teamId} data={read.data} now={new Date()} />
    </TeamShell>
  );
}
