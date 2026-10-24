import { instantToLocal, type RegistrationReadResponse } from '@sgm/shared';
import { LINK_CLASS } from '../auth/styles.ts';
import { teamPagePath } from '../../lib/registrations/paths.ts';
import { formatDay, formatTimeRange } from '../../lib/teams/sessions-view.ts';

/**
 * The player's view of the session (heading, date and time range, location, address, link back to the team). Named apart from
 * the admin `SessionSummary` in `components/teams` (R23): that one is an admin view over `SessionResponse` from a TEAM_ADMIN
 * route; this one renders the `session` block of `GET .../registration`, which any approved member may read. Dates are shown in
 * Pacific/Auckland from the server's instants (P3).
 */
export function PlayerSessionSummary({
  teamId,
  teamName,
  session,
}: {
  teamId: string;
  teamName: string | null;
  session: RegistrationReadResponse['session'];
}) {
  const start = instantToLocal(new Date(session.startsAt));
  const end = session.endsAt === null ? null : instantToLocal(new Date(session.endsAt));
  const when =
    end === null
      ? `${formatDay(start.date)}`
      : `${formatDay(start.date)}, ${formatTimeRange(start.time, end.time, 'full')}`;
  const label = teamName === null ? 'Back to the team' : `Back to ${teamName}`;

  return (
    <header className="flex flex-col gap-2">
      <a href={teamPagePath(teamId)} aria-label={label} className={`${LINK_CLASS} self-start`}>
        {teamName === null ? '‹ Team' : `‹ ${teamName}`}
      </a>
      <h1 className="min-w-0 break-words text-2xl font-semibold">{session.location}</h1>
      <p className="text-base">{when}</p>
      <p className="min-w-0 break-words text-base">{session.address}</p>
    </header>
  );
}
