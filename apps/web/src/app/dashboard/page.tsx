import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { RedirectType, redirect } from 'next/navigation';
import { DashboardTabs } from '../../components/dashboard/dashboard-tabs.tsx';
import {
  OpenSessionsTab,
  type OpenSessionsState,
} from '../../components/dashboard/open-sessions-tab.tsx';
import { PaymentsTab, type PaymentsState } from '../../components/dashboard/payments-tab.tsx';
import {
  RegistrationsTab,
  type RegistrationsState,
} from '../../components/dashboard/registrations-tab.tsx';
import { TeamShell } from '../../components/teams/team-shell.tsx';
import { apiClient, type ApiResult, type IncomingHeaders } from '../../lib/api-client.ts';
import { readCookie } from '../../lib/auth/cookies.ts';
import { loginUrl, sessionExpiredUrl } from '../../lib/auth/landing.ts';
import { firstParam, type SearchParams } from '../../lib/auth/page-params.ts';
import { requireUser } from '../../lib/auth/session.ts';
import { PAGE_HEADING, PAGE_TITLE } from '../../lib/dashboard/labels.ts';
import { tabPath } from '../../lib/dashboard/paths.ts';
import { cursorParam, parseTab, walletCard } from '../../lib/dashboard/view.ts';
import { DOWNLOAD_ERROR_PARAM } from '../../lib/invoices/paths.ts';
import { log } from '../../lib/log.ts';

export const metadata: Metadata = { robots: { index: false } };
export const dynamic = 'force-dynamic';

type Options = { session: string; incoming: IncomingHeaders };

/**
 * A read's result after the dashboard's two rules: a 401 sends the person to sign in again (returning to this tab), and any
 * other failure is logged by action, status and code only (never an amount, an id list or a token) and handed back so the one
 * section it belongs to can say so.
 */
function checked<T>(result: ApiResult<T>, action: string, here: string): ApiResult<T> {
  if (result.ok) return result;
  if (result.status === 401) return redirect(sessionExpiredUrl(here), RedirectType.replace);
  log.warn('web.dashboard.api_failure', {
    action,
    status: result.status,
    code: result.error.code,
  });
  return result;
}

/** A paged read; a cursor the API refuses (422, stale or tampered) falls back to the first page, never an error page. */
async function paged<T>(
  read: (cursor: string | undefined) => Promise<ApiResult<T>>,
  cursor: string | undefined,
): Promise<ApiResult<T>> {
  const result = await read(cursor);
  return !result.ok && result.status === 422 && cursor !== undefined ? read(undefined) : result;
}

async function loadOpening(options: Options, here: string): Promise<OpenSessionsState> {
  const sessions = checked(await apiClient.openSessions(options), 'open_sessions', here);
  if (!sessions.ok) return { kind: 'failed' };
  if (sessions.data.sessions.length > 0) return { kind: 'ok', data: sessions.data, hasTeam: true };
  // Only an empty list needs to know why: no approved team, or nothing open.
  const { session, ...rest } = options;
  const mine = checked(await apiClient.mineTeams(session, rest), 'mine_teams', here);
  if (!mine.ok) return { kind: 'failed' };
  return {
    kind: 'ok',
    data: sessions.data,
    hasTeam: mine.data.teams.some((team) => team.status === 'APPROVED'),
  };
}

async function loadRegistrations(
  options: Options,
  here: string,
  cursor: string | undefined,
): Promise<RegistrationsState> {
  const result = checked(
    await paged(
      (c) => apiClient.myRegistrations(c === undefined ? {} : { cursor: c }, options),
      cursor,
    ),
    'my_registrations',
    here,
  );
  if (!result.ok) return { kind: 'failed' };
  return {
    kind: 'ok',
    data: result.data,
    firstPage: cursor === undefined || result.data.upcoming.length > 0,
  };
}

async function loadPayments(
  options: Options,
  here: string,
  cursors: { paidCursor: string | undefined; unpaidCursor: string | undefined },
  downloadError: string | undefined,
): Promise<PaymentsState> {
  const { session, ...rest } = options;
  const [mine, unpaid, paid] = await Promise.all([
    apiClient.mineTeams(session, rest),
    paged(
      (cursor) => apiClient.myUnpaidPayments(cursor === undefined ? {} : { cursor }, options),
      cursors.unpaidCursor,
    ),
    paged(
      (cursor) => apiClient.myPaidPayments(cursor === undefined ? {} : { cursor }, options),
      cursors.paidCursor,
    ),
  ]);
  const checkedMine = checked(mine, 'mine_teams', here);
  const checkedUnpaid = checked(unpaid, 'unpaid_payments', here);
  const checkedPaid = checked(paid, 'paid_payments', here);

  const payments: PaymentsState['payments'] =
    checkedUnpaid.ok && checkedPaid.ok
      ? {
          kind: 'ok',
          unpaid: checkedUnpaid.data,
          paid: checkedPaid.data,
          paidCursor: cursors.paidCursor,
          unpaidCursor: cursors.unpaidCursor,
        }
      : { kind: 'failed' };
  if (!checkedMine.ok) return { teams: { kind: 'failed' }, payments, downloadError };

  const approved = checkedMine.data.teams.filter((team) => team.status === 'APPROVED');
  // One wallet read per approved team, in parallel, in `mineTeams` order; the ledger page in each response is ignored.
  const wallets = await Promise.all(approved.map((team) => apiClient.wallet(team.id, {}, options)));
  const cards = approved.map((team, index) => {
    const result = wallets[index];
    const wallet = result === undefined ? null : checked(result, 'wallet', here);
    return walletCard(team, wallet?.ok === true ? wallet.data.wallet : null);
  });
  return { teams: { kind: 'ok', cards }, payments, downloadError };
}

/**
 * The player dashboard: Currently Opening, My Registration and Payments & Wallet as three URL-driven tabs. Only the active tab's
 * data is loaded; each read fails on its own and says so in its own section. Read-only: registering, topping up and paying all
 * happen on the existing session, wallet and payment pages this page links to. `proxy.ts` protects the path and marks it
 * `no-store`; `requireUser` does the real check.
 */
export default async function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const tab = parseTab(firstParam(query, 'tab'));
  const here = tabPath(tab);
  await requireUser(here);
  const session = await readCookie('session');
  if (session === null) return redirect(loginUrl({ returnTo: here }), RedirectType.replace);
  const options: Options = { session, incoming: await headers() };

  return (
    <TeamShell>
      <title>{PAGE_TITLE}</title>
      <h1 className="min-w-0 break-words text-2xl font-semibold">{PAGE_HEADING}</h1>
      <DashboardTabs current={tab} />
      {tab === 'opening' ? <OpenSessionsTab state={await loadOpening(options, here)} /> : null}
      {tab === 'registrations' ? (
        <RegistrationsTab
          state={await loadRegistrations(options, here, cursorParam(firstParam(query, 'cursor')))}
        />
      ) : null}
      {tab === 'payments' ? (
        <PaymentsTab
          state={await loadPayments(
            options,
            here,
            {
              paidCursor: cursorParam(firstParam(query, 'paidCursor')),
              unpaidCursor: cursorParam(firstParam(query, 'unpaidCursor')),
            },
            firstParam(query, DOWNLOAD_ERROR_PARAM),
          )}
        />
      ) : null}
    </TeamShell>
  );
}
