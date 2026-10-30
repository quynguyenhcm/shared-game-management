import { TeamShell } from '../../../../../components/teams/team-shell.tsx';
import { LOADING_MESSAGE } from '../../../../../lib/registrations/labels.ts';

/** The panel's loading state: one persistent status line while the single read model loads. */
export default function Loading() {
  return (
    <TeamShell>
      <p role="status" className="text-base">
        {LOADING_MESSAGE}
      </p>
    </TeamShell>
  );
}
