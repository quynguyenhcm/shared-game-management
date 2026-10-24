import { LINK_CLASS } from '../../../../../components/auth/styles.ts';
import { TeamShell } from '../../../../../components/teams/team-shell.tsx';
import { NOT_FOUND_BODY, NOT_FOUND_HEADING } from '../../../../../lib/registrations/labels.ts';

/** AC-ENTRY-2: one identical page for an unknown id, a malformed id, a DRAFT and another team's session. */
export default function SessionNotFound() {
  return (
    <TeamShell>
      <title>Session not found – Shared Game Management</title>
      <h1 className="text-2xl font-semibold">{NOT_FOUND_HEADING}</h1>
      <p className="text-base">{NOT_FOUND_BODY}</p>
      <a href="/teams" className={`${LINK_CLASS} self-start`}>
        My teams
      </a>
    </TeamShell>
  );
}
