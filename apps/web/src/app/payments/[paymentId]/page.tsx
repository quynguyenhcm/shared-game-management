import type { Metadata } from 'next';
import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { RedirectType, notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { PaymentDetail } from '../../../components/billing/payment-detail.tsx';
import { TeamShell } from '../../../components/teams/team-shell.tsx';
import { apiClient } from '../../../lib/api-client.ts';
import { readCookie } from '../../../lib/auth/cookies.ts';
import { loginUrl, sessionExpiredUrl } from '../../../lib/auth/landing.ts';
import { firstParam, type SearchParams } from '../../../lib/auth/page-params.ts';
import { requireUser } from '../../../lib/auth/session.ts';
import { formatDay } from '../../../lib/billing/labels.ts';
import { paymentPath } from '../../../lib/billing/paths.ts';
import { log } from '../../../lib/log.ts';

export const metadata: Metadata = { robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * One payment of the caller (the email's "Pay now" lands here, after sign-in). The API answers 404 to every caller who is not
 * the payer and for an unknown id, and this page turns that, a 403, a 422 and a malformed id into the one identical not-found
 * (nothing reveals whether the payment exists). `?return=1` is where Akahu's return lands: the page then renders what the API
 * says now, never an assumed success. The overdue count (only for an overdue payment) feeds the "register for more games"
 * sentence and its failure is ignored.
 */
export default async function PaymentPage({
  params,
  searchParams,
}: {
  params: Promise<{ paymentId: string }>;
  searchParams: SearchParams;
}) {
  const { paymentId } = await params;
  if (!z.uuid().safeParse(paymentId).success) notFound();

  const returned = firstParam(await searchParams, 'return');
  const here = paymentPath(paymentId);
  await requireUser(here);
  const token = await readCookie('session');
  if (token === null) return redirect(loginUrl({ returnTo: here }), RedirectType.replace);

  const options = { session: token, incoming: await headers() };
  const result = await apiClient.payment(paymentId, options);
  if (!result.ok) {
    if (result.status === 401) return redirect(sessionExpiredUrl(here), RedirectType.replace);
    if (result.status === 404 || result.status === 403 || result.status === 422) notFound();
    log.warn('web.billing.api_failure', {
      action: 'payment_load',
      status: result.status,
      code: result.error.code,
    });
    throw new Error('The payment could not be loaded because the API is unavailable.');
  }

  const { payment } = result.data;
  let overdueCount: number | undefined;
  if (payment.status === 'OVERDUE') {
    const unpaid = await apiClient.myUnpaidPayments({}, options);
    if (unpaid.ok) {
      overdueCount = unpaid.data.teams
        .flatMap((team) => team.payments)
        .filter((row) => row.status === 'OVERDUE').length;
    }
  }

  return (
    <TeamShell>
      <title>{`Payment for ${payment.session.location}, ${formatDay(payment.session.startsAt)} – Shared Game Management`}</title>
      {/* A new key per render: a double submit of the same render reuses it, a fresh visit gets a new one. */}
      <PaymentDetail
        payment={payment}
        search={{ return: returned }}
        idempotencyKey={randomUUID()}
        overdueCount={overdueCount}
      />
    </TeamShell>
  );
}
