import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { RedirectType, notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { LINK_CLASS } from '../../../../../components/auth/styles.ts';
import { AdminPaymentsTable } from '../../../../../components/billing/admin-payments-table.tsx';
import { PayoutBlockConfirm } from '../../../../../components/billing/payout-block-confirm.tsx';
import { ManageAreaNav } from '../../../../../components/teams/manage-area-nav.tsx';
import { ManageProvider, SectionStatus } from '../../../../../components/teams/manage-context.tsx';
import { NoAccess } from '../../../../../components/teams/no-access.tsx';
import { apiClient } from '../../../../../lib/api-client.ts';
import { readCookie } from '../../../../../lib/auth/cookies.ts';
import { loginUrl } from '../../../../../lib/auth/landing.ts';
import { firstParam, type SearchParams } from '../../../../../lib/auth/page-params.ts';
import { requireUser } from '../../../../../lib/auth/session.ts';
import { ADMIN_INTRO, SHOW_MORE, paymentsAdminHeading } from '../../../../../lib/billing/labels.ts';
import { adminPaymentsPath } from '../../../../../lib/billing/paths.ts';
import {
  ADMIN_FILTERS,
  adminFilterOf,
  type AdminFilter,
} from '../../../../../lib/billing/wallet-view.ts';
import { guardResults } from '../../../../../lib/teams/sessions-guard.ts';

export const metadata: Metadata = { robots: { index: false } };
export const dynamic = 'force-dynamic';

/** `?status=` and `?cursor=` of the Payments page, without the empty or default ones. */
function pageUrl(teamId: string, filter: AdminFilter, cursor?: string): string {
  const search = new URLSearchParams();
  if (filter.param !== null) search.set('status', filter.param);
  if (cursor !== undefined) search.set('cursor', cursor);
  const text = search.toString();
  return text === '' ? adminPaymentsPath(teamId) : `${adminPaymentsPath(teamId)}?${text}`;
}

/**
 * The "Payments" manage area (AC-ENTRY-3): who owes a game fee, with a per-row reminder and, for a held payment, the record of
 * what happened (ruling H2: team admins of the payee team and GLOBAL_ADMIN). The API is the guard (a TEAM_ADMIN of this team or
 * a GLOBAL_ADMIN; anyone else is a 403, which renders the no-access page and none of the area's content). A GLOBAL_ADMIN who
 * is not an approved team admin gets only the Payments link in the nav (CR-21), and is the only role offered "Block payments
 * to this team" (A3). The team detail is optional: without it the page is headed "Payments" (a support user may not be able
 * to read a private team).
 */
export default async function PaymentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ teamId: string }>;
  searchParams: SearchParams;
}) {
  const { teamId } = await params;
  if (!z.uuid().safeParse(teamId).success) notFound();

  const query = await searchParams;
  const filter = adminFilterOf(firstParam(query, 'status'));
  const cursor = firstParam(query, 'cursor');
  const here = pageUrl(teamId, filter);
  const user = await requireUser(here);
  const token = await readCookie('session');
  if (token === null) return redirect(loginUrl({ returnTo: here }), RedirectType.replace);

  const options = { session: token, incoming: await headers() };
  const [detail, payments] = await Promise.all([
    apiClient.teamDetail(teamId, options),
    apiClient.adminPayments(
      teamId,
      cursor === undefined || cursor === ''
        ? { status: filter.api }
        : { status: filter.api, cursor },
      options,
    ),
  ]);
  if (
    guardResults([payments], { here, action: 'admin_payments_load', optional: [detail] }) ===
    'no_access'
  ) {
    return <NoAccess />;
  }
  if (!payments.ok) throw new Error('unavailable');

  const team = detail.ok ? detail.data.team : null;
  const isGlobalAdmin = user.role === 'GLOBAL_ADMIN';
  const isTeamAdmin =
    detail.ok && detail.data.myStatus === 'APPROVED' && detail.data.myRole === 'TEAM_ADMIN';
  const { payoutBlocked, nextCursor } = payments.data;

  return (
    <ManageProvider>
      <title>{`Payments – ${team?.name ?? 'Team'} – Shared Game Management`}</title>
      <ManageAreaNav
        teamId={teamId}
        current="payments"
        globalAdminOnly={isGlobalAdmin && !isTeamAdmin}
      />
      <header className="flex flex-col gap-1">
        <h1
          id="payments-heading"
          tabIndex={-1}
          className="min-w-0 break-words text-2xl font-semibold outline-none"
        >
          {paymentsAdminHeading(team?.name ?? null)}
        </h1>
        <p className="text-base">{ADMIN_INTRO}</p>
      </header>
      <nav aria-label="Filter payments">
        <ul className="flex flex-wrap gap-x-4">
          {ADMIN_FILTERS.map((item) => (
            <li key={item.id}>
              <a
                href={pageUrl(teamId, item)}
                aria-current={item.id === filter.id ? 'true' : undefined}
                className={`${LINK_CLASS}${item.id === filter.id ? ' font-semibold decoration-2' : ''}`}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <SectionStatus section="payments" />
      <AdminPaymentsTable
        teamId={teamId}
        payments={payments.data.payments}
        payoutBlocked={payoutBlocked}
        now={new Date().toISOString()}
        emptyText={filter.empty}
      />
      {nextCursor === null ? null : (
        <a href={pageUrl(teamId, filter, nextCursor)} className={`${LINK_CLASS} self-start`}>
          {SHOW_MORE}
        </a>
      )}
      {isGlobalAdmin && !payoutBlocked ? <PayoutBlockConfirm teamId={teamId} /> : null}
    </ManageProvider>
  );
}
