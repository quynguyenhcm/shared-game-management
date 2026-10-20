import type { Metadata } from 'next';
import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { RedirectType, notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { StripAuthParams } from '../../../../../../../components/flash-notice.tsx';
import { ManageAreaNav } from '../../../../../../../components/teams/manage-area-nav.tsx';
import { ManageProvider } from '../../../../../../../components/teams/manage-context.tsx';
import { NoAccess } from '../../../../../../../components/teams/no-access.tsx';
import { SeriesForm } from '../../../../../../../components/teams/series-form.tsx';
import { apiClient } from '../../../../../../../lib/api-client.ts';
import { readCookie } from '../../../../../../../lib/auth/cookies.ts';
import { loginUrl } from '../../../../../../../lib/auth/landing.ts';
import { requireUser } from '../../../../../../../lib/auth/session.ts';
import { guardResults } from '../../../../../../../lib/teams/sessions-guard.ts';
import { bankingHandoff, newSeriesPath } from '../../../../../../../lib/teams/sessions-paths.ts';
import { SERIES_COPY } from '../../../../../../../lib/teams/sessions-view.ts';

export const metadata: Metadata = { robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * A new recurring series (S0). The banking read is both the admin guard and the source of `isPayoutConfigured`,
 * so the create confirm can warn that the sessions will be saved as drafts until banking is set up (a
 * heads-up, never a block).
 */
export default async function NewSeriesPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { teamId } = await params;
  if (!z.uuid().safeParse(teamId).success) notFound();

  const here = newSeriesPath(teamId);
  await requireUser(here);
  const token = await readCookie('session');
  if (token === null) return redirect(loginUrl({ returnTo: here }), RedirectType.replace);

  const options = { session: token, incoming: await headers() };
  const [detail, banking] = await Promise.all([
    apiClient.teamDetail(teamId, options),
    apiClient.teamBanking(teamId, options),
  ]);
  if (guardResults([detail, banking], { here, action: 'new_series_load' }) === 'no_access') {
    return <NoAccess />;
  }
  if (!detail.ok || !banking.ok) {
    throw new Error('The new series page could not be loaded because the API is unavailable.');
  }

  const { team } = detail.data;
  return (
    <ManageProvider>
      <title>{`${SERIES_COPY.newHeading} – ${team.name} – Shared Game Management`}</title>
      <StripAuthParams />
      <ManageAreaNav teamId={teamId} current="sessions" />
      <h1 className="min-w-0 break-words text-2xl font-semibold">{SERIES_COPY.newHeading}</h1>
      <SeriesForm
        teamId={teamId}
        mode="create"
        createKey={randomUUID()}
        bankingHref={bankingHandoff(teamId, here)}
        isPayoutConfigured={banking.data.banking.isPayoutConfigured}
      />
    </ManageProvider>
  );
}
