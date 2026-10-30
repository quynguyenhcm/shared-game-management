import type { UpcomingSessionsResponse } from '@sgm/shared';
import { formatWhen, seatsLine } from '../../lib/registrations/labels.ts';
import { playerSessionPath } from '../../lib/registrations/paths.ts';
import { FOCUS_RING } from '../auth/styles.ts';
import { Tag } from '../teams/team-shell.tsx';

const EMPTY = 'No sessions are open for registration right now.';
const MORE = 'Showing the next 10 sessions.';
const LOAD_ERROR = "We can't load sessions right now. Try again in a minute.";

/**
 * "Upcoming sessions" on the team page, for APPROVED members only (R8, AC-ENTRY-4). Each row is one link (44 px tall) to the
 * player session page and renders the places line and the caller's own status exactly as `GET /teams/:teamId/sessions/upcoming`
 * returned them (`seatsLeft`, `publicCapacity`, `waitlistLength`, `me.status`, `me.waitlistRank`). A failed read is contained to
 * this section: the rest of the team page still renders.
 */
export function UpcomingSessions({
  teamId,
  result,
}: {
  teamId: string;
  result: { ok: true; data: UpcomingSessionsResponse } | { ok: false };
}) {
  return (
    <section aria-labelledby="upcoming-sessions-heading" className="flex flex-col gap-3">
      <h2 id="upcoming-sessions-heading" className="text-lg font-semibold">
        Upcoming sessions
      </h2>
      {!result.ok ? <p className="text-base">{LOAD_ERROR}</p> : null}
      {result.ok && result.data.sessions.length === 0 ? <p className="text-base">{EMPTY}</p> : null}
      {result.ok && result.data.sessions.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {result.data.sessions.map((session) => (
            <li key={session.id}>
              <a
                href={playerSessionPath(teamId, session.id)}
                className={`flex min-h-11 flex-col gap-1 rounded-md border border-slate-500 p-3 text-base text-slate-900 ${FOCUS_RING}`}
              >
                <span className="min-w-0 break-words font-medium">{`${formatWhen(session.startsAt)} · ${session.location}`}</span>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span>
                    {seatsLine({
                      seatsLeft: session.seatsLeft,
                      publicCapacity: session.publicCapacity,
                      waitlistLength: session.waitlistLength,
                    })}
                  </span>
                  {session.me === null ? null : (
                    <Tag>
                      {session.me.status === 'CONFIRMED'
                        ? "You're in"
                        : `Waitlist #${session.me.waitlistRank ?? ''}`.trim()}
                    </Tag>
                  )}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {result.ok && result.data.hasMore ? <p className="text-base">{MORE}</p> : null}
    </section>
  );
}
