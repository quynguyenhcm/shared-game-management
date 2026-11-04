import { TeamShell } from '../../../../components/teams/team-shell.tsx';

/** One persistent status line while the wallet, payments and ledger load. */
export default function WalletLoading() {
  return (
    <TeamShell>
      <p role="status" className="text-base">
        Loading your wallet...
      </p>
    </TeamShell>
  );
}
