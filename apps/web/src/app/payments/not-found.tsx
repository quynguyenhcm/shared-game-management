import { LINK_CLASS } from '../../components/auth/styles.ts';
import { TeamShell } from '../../components/teams/team-shell.tsx';

/** The same page for an unknown, malformed or someone else's payment id: nothing reveals whether it exists. */
export default function PaymentNotFound() {
  return (
    <TeamShell>
      <title>Payment not found – Shared Game Management</title>
      <h1 className="text-2xl font-semibold">We couldn&apos;t find that payment.</h1>
      <p className="text-base">
        If you were sent this link, sign in with the account you registered with.
      </p>
      <a href="/teams" className={`${LINK_CLASS} self-start`}>
        My teams
      </a>
    </TeamShell>
  );
}
