import type { Metadata } from 'next';
import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { RedirectType, notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { StripAuthParams } from '../../../../../../components/flash-notice.tsx';
import { ManageAreaNav } from '../../../../../../components/teams/manage-area-nav.tsx';
import { ManageProvider } from '../../../../../../components/teams/manage-context.tsx';
import { NoAccess } from '../../../../../../components/teams/no-access.tsx';
import { SessionForm } from '../../../../../../components/teams/session-form.tsx';
import { apiClient } from '../../../../../../lib/api-client.ts';
import { readCookie } from '../../../../../../lib/auth/cookies.ts';
import { loginUrl } from '../../../../../../lib/auth/landing.ts';
import { requireUser } from '../../../../../../lib/auth/session.ts';
import { guardResults } from '../../../../../../lib/teams/sessions-guard.ts';
import { bankingHandoff, newSessionPath } from '../../../../../../lib/teams/sessions-paths.ts';
import { sessionHeading, sessionScopeLine } from '../../../../../../lib/teams/sessions-view.ts';

export const metadata: Metadata = { robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * A new one-off session (N1). Nothing is written until a save. The banking read is the admin guard (a team
 * admin route), so a non-admin gets the no-access page and never the form. The create key is new per render: a
 * retry of the same render replays, a fresh visit creates a new session.
 */
export default async function NewSessionPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { teamId } = await params;
  if (!z.uuid().safeParse(teamId).success) notFound();

  const here = newSessionPath(teamId);
  await requireUser(here);
  const token = await readCookie('session');
  if (token === null) return redirect(loginUrl({ returnTo: here }), RedirectType.replace);

  const options = { session: token, incoming: await headers() };
  const [detail, banking] = await Promise.all([
    apiClient.teamDetail(teamId, options),
    apiClient.teamBanking(teamId, options),
  ]);
  if (guardResults([detail, banking], { here, action: 'new_session_load' }) === 'no_access') {
    return <NoAccess />;
  }
  if (!detail.ok || !banking.ok) {
    throw new Error('The new session page could not be loaded because the API is unavailable.');
  }

  const { team } = detail.data;
  const heading = sessionHeading(null);
  return (
    <ManageProvider>
      <title>{`${heading} – ${team.name} – Shared Game Management`}</title>
      <StripAuthParams />
      <ManageAreaNav teamId={teamId} current="sessions" />
      <header className="flex flex-col gap-2">
        <h1 className="min-w-0 break-words text-2xl font-semibold">{heading}</h1>
        <p className="text-base text-slate-900">
          {sessionScopeLine({ seriesName: null, date: '', edited: false })}
        </p>
      </header>
      <SessionForm
        teamId={teamId}
        mode="create"
        createKey={randomUUID()}
        bankingHref={bankingHandoff(teamId, here)}
      />
    </ManageProvider>
  );
}
