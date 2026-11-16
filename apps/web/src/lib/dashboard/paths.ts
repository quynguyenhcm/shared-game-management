/**
 * The player dashboard's URLs, in one place. The tabs are plain links (no client state), so reload and back/forward return to the
 * same tab; each paged list keeps its own cursor parameter so following one `Show more` keeps the others where they were.
 */

export const DASHBOARD_PATH = '/dashboard';

export type DashboardTab = 'opening' | 'registrations' | 'payments';

/** The default tab is the bare path; the others are `?tab=`. */
export const tabPath = (tab: DashboardTab): string =>
  tab === 'opening' ? DASHBOARD_PATH : `${DASHBOARD_PATH}?tab=${tab}`;

/** Where an invoice link on the Payments & Wallet tab lands again after a failed download (`?download_error=<code>`). */
export const PAYMENTS_RETURN_TO = tabPath('payments');

/** The next page of `Past` registrations. */
export const registrationsPagePath = (cursor: string): string =>
  `${tabPath('registrations')}&${new URLSearchParams({ cursor }).toString()}`;

/** The Payments & Wallet tab with the cursor of each paged list kept in its own parameter. */
export function paymentsPagePath(cursors: { paidCursor?: string; unpaidCursor?: string }): string {
  const params = new URLSearchParams();
  if (cursors.paidCursor !== undefined) params.set('paidCursor', cursors.paidCursor);
  if (cursors.unpaidCursor !== undefined) params.set('unpaidCursor', cursors.unpaidCursor);
  const query = params.toString();
  return query === '' ? PAYMENTS_RETURN_TO : `${PAYMENTS_RETURN_TO}&${query}`;
}
