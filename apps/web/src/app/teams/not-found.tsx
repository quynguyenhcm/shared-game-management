import { LINK_CLASS } from '../../components/auth/styles.ts';
import { TeamShell } from '../../components/teams/team-shell.tsx';
import { getSessionState } from '../../lib/auth/session.ts';
import { NOT_FOUND_BODY, NOT_FOUND_HEADING } from '../../lib/teams/labels.ts';

/** AC-ERROR-10: the same page for an unknown id, a malformed id and a private team the caller cannot see. */
export default async function TeamNotFound() {
  const session = await getSessionState();
  return (
    <TeamShell>
      <title>Team not found – Shared Game Management</title>
      <h1 className="text-2xl font-semibold">{NOT_FOUND_HEADING}</h1>
      <p className="text-base">{NOT_FOUND_BODY}</p>
      <p className="flex flex-wrap gap-x-4">
        <a href="/teams/find" className={LINK_CLASS}>
          Find a team
        </a>
        {session.kind === 'signed_in' ? (
          <a href="/teams" className={LINK_CLASS}>
            My teams
          </a>
        ) : null}
      </p>
    </TeamShell>
  );
}
