import { TeamShell } from '../../components/teams/team-shell.tsx';

/** One persistent status line while the payment read model loads. */
export default function PaymentsLoading() {
  return (
    <TeamShell>
      <p role="status" className="text-base">
        Loading your payments...
      </p>
    </TeamShell>
  );
}
