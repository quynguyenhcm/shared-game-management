import type { Metadata } from 'next';
import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { RedirectType, notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { LedgerList } from '../../../../components/billing/ledger-list.tsx';
import { BillingSection } from '../../../../components/billing/billing-section.tsx';
import { PaymentsList } from '../../../../components/billing/payments-list.tsx';
import { WalletSummary } from '../../../../components/billing/wallet-summary.tsx';
import { LINK_CLASS } from '../../../../components/auth/styles.ts';
import { TeamShell } from '../../../../components/teams/team-shell.tsx';
import { apiClient } from '../../../../lib/api-client.ts';
import { readCookie } from '../../../../lib/auth/cookies.ts';
import { loginUrl } from '../../../../lib/auth/landing.ts';
import { firstParam, type SearchParams } from '../../../../lib/auth/page-params.ts';
import { requireUser } from '../../../../lib/auth/session.ts';
import {
  PAYMENTS_LOAD_FAILED,
  backToTeam,
  billingErrorLines,
  walletHeading,
} from '../../../../lib/billing/labels.ts';
import { walletPath } from '../../../../lib/billing/paths.ts';
import { groupPayments } from '../../../../lib/billing/wallet-view.ts';
import { guardResults } from '../../../../lib/teams/sessions-guard.ts';

export const metadata: Metadata = { robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * The player's wallet in one team (AC-ENTRY-1): balance and the one allowed next step (top up, continue, wait, or "full"), what
 * the player owes and has paid in this team, and the wallet activity. One parallel load (team, wallet, payments); the wallet
 * and the team are required, the payments list degrades to a line. Only an APPROVED member has a wallet here: a non-member, pending,
 * rejected or banned caller sees the member-only sentence (AC-ENTRY-1); an unknown team or malformed id gets the uniform not-found. `?topUp=<id>` is where
 * Akahu's return lands and `?cursor=` pages the activity; both are passed to the API, which is the authority.
 */
export default async function WalletPage({
  params,
  searchParams,
}: {
  params: Promise<{ teamId: string }>;
  searchParams: SearchParams;
}) {
  const { teamId } = await params;
  if (!z.uuid().safeParse(teamId).success) notFound();

  const query = await searchParams;
  const topUpParam = firstParam(query, 'topUp');
  const topUp = z.uuid().safeParse(topUpParam).success ? topUpParam : undefined;
  const cursor = firstParam(query, 'cursor');
  const here = topUp === undefined ? walletPath(teamId) : `${walletPath(teamId)}?topUp=${topUp}`;
  await requireUser(here);
  const token = await readCookie('session');
  if (token === null) return redirect(loginUrl({ returnTo: here }), RedirectType.replace);

  const options = { session: token, incoming: await headers() };
  const [detail, wallet, payments] = await Promise.all([
    apiClient.teamDetail(teamId, options),
    apiClient.wallet(
      teamId,
      {
        ...(cursor === undefined || cursor === '' ? {} : { cursor }),
        ...(topUp === undefined ? {} : { topUp }),
      },
      options,
    ),
    apiClient.teamMyPayments(teamId, {}, options),
  ]);
  const guard = guardResults([detail, wallet], {
    here,
    action: 'wallet_load',
    optional: [payments],
  });
  // An unknown team: the team read says 404 while the membership-gated reads say 403; the 404 wins.
  if (!detail.ok && (detail.status === 404 || detail.status === 422)) notFound();
  const notApproved = detail.ok && detail.data.myStatus !== 'APPROVED';
  if (guard === 'no_access' || notApproved) {
    // AC-ENTRY-1: a non-member, pending, rejected or banned caller is told what the wallet needs; no wallet data is shown.
    return (
      <TeamShell>
        <title>{`Wallet and payments – Shared Game Management`}</title>
        <p role="status" className="text-base">
          {billingErrorLines('forbidden')[0]}
        </p>
        <a href={`/teams/${teamId}`} className={`${LINK_CLASS} self-start`}>
          {detail.ok ? backToTeam(detail.data.team.name) : 'Back to the team'}
        </a>
      </TeamShell>
    );
  }
  if (!detail.ok || !wallet.ok) throw new Error('unavailable');

  const { team } = detail.data;
  const groups = payments.ok ? groupPayments(payments.data.payments) : null;
  const walletUrl = walletPath(teamId);

  return (
    <TeamShell>
      <title>{`Wallet and payments – ${team.name} – Shared Game Management`}</title>
      <header className="flex flex-col gap-1">
        <h1 className="min-w-0 break-words text-2xl font-semibold">{walletHeading(team.name)}</h1>
        <a href={`/teams/${team.id}`} className={`${LINK_CLASS} self-start`}>
          {backToTeam(team.name)}
        </a>
      </header>
      {/* A new key per render: a retry of the same render reuses it, a fresh visit gets a new one. */}
      <WalletSummary
        teamId={team.id}
        teamName={team.name}
        wallet={wallet.data.wallet}
        search={{ topUp }}
        idempotencyKey={randomUUID()}
      />
      <BillingSection id="payments" title="Payments">
        {groups === null ? (
          <p role="status" className="text-base">
            {PAYMENTS_LOAD_FAILED}
          </p>
        ) : (
          <PaymentsList groups={groups} />
        )}
      </BillingSection>
      <LedgerList
        transactions={wallet.data.transactions}
        nextCursor={wallet.data.nextCursor}
        walletPath={walletUrl}
        cursor={cursor === undefined || cursor === '' ? null : cursor}
      />
    </TeamShell>
  );
}
