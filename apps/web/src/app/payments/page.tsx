import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { RedirectType, redirect } from 'next/navigation';
import { PaymentsList } from '../../components/billing/payments-list.tsx';
import { LINK_CLASS } from '../../components/auth/styles.ts';
import { TeamShell } from '../../components/teams/team-shell.tsx';
import { apiClient } from '../../lib/api-client.ts';
import { readCookie } from '../../lib/auth/cookies.ts';
import { loginUrl, sessionExpiredUrl } from '../../lib/auth/landing.ts';
import { firstParam, type SearchParams } from '../../lib/auth/page-params.ts';
import { requireUser } from '../../lib/auth/session.ts';
import { NO_UNPAID, SHOW_MORE, UNPAID_HEADING } from '../../lib/billing/labels.ts';
import { UNPAID_PAYMENTS_PATH } from '../../lib/billing/paths.ts';
import { groupPaymentsByTeam } from '../../lib/billing/wallet-view.ts';
import { log } from '../../lib/log.ts';

export const metadata: Metadata = { robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * The cross-team list of what the caller still owes (CR-16): the target of the registration debt-block link (AC-ENTRY-4). One
 * block per team, Overdue before Pending, "Pay now" on every payable row; a held row says it is under review. Intentionally
 * plain, so the player dashboard can later wrap or replace it. `proxy.ts` protects this path and marks it `no-store`.
 */
export default async function UnpaidPaymentsPage({ searchParams }: { searchParams: SearchParams }) {
  const cursor = firstParam(await searchParams, 'cursor');
  await requireUser(UNPAID_PAYMENTS_PATH);
  const token = await readCookie('session');
  if (token === null) {
    return redirect(loginUrl({ returnTo: UNPAID_PAYMENTS_PATH }), RedirectType.replace);
  }

  const result = await apiClient.myUnpaidPayments(
    cursor === undefined || cursor === '' ? {} : { cursor },
    { session: token, incoming: await headers() },
  );
  if (!result.ok) {
    if (result.status === 401) {
      return redirect(sessionExpiredUrl(UNPAID_PAYMENTS_PATH), RedirectType.replace);
    }
    log.warn('web.billing.api_failure', {
      action: 'unpaid_payments',
      status: result.status,
      code: result.error.code,
    });
    throw new Error('Your payments could not be loaded because the API is unavailable.');
  }

  const teams = groupPaymentsByTeam(result.data.teams);
  const nextCursor = result.data.nextCursor;
  return (
    <TeamShell>
      <title>Your payments – Shared Game Management</title>
      <h1 className="min-w-0 break-words text-2xl font-semibold">{UNPAID_HEADING}</h1>
      {teams.length === 0 ? (
        <>
          <p className="text-base">{NO_UNPAID}</p>
          <a href="/teams" className={`${LINK_CLASS} self-start`}>
            My teams
          </a>
        </>
      ) : (
        teams.map((team) => (
          <section
            key={team.teamId}
            aria-labelledby={`team-${team.teamId}`}
            className="flex flex-col gap-3"
          >
            <h2 id={`team-${team.teamId}`} className="min-w-0 break-words text-lg font-semibold">
              {team.teamName}
            </h2>
            <PaymentsList groups={team.groups} />
          </section>
        ))
      )}
      {nextCursor === null ? null : (
        <a
          href={`${UNPAID_PAYMENTS_PATH}?cursor=${encodeURIComponent(nextCursor)}`}
          className={`${LINK_CLASS} self-start`}
        >
          {SHOW_MORE}
        </a>
      )}
    </TeamShell>
  );
}
