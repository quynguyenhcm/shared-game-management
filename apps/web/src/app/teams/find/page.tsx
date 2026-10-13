import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { FormBanner } from '../../../components/auth/form-banner.tsx';
import { LINK_CLASS } from '../../../components/auth/styles.ts';
import { FindResults, TeamSearchForm } from '../../../components/teams/team-search.tsx';
import { TeamShell } from '../../../components/teams/team-shell.tsx';
import { apiClient } from '../../../lib/api-client.ts';
import { buildUrl } from '../../../lib/auth/landing.ts';
import { firstParam, type SearchParams } from '../../../lib/auth/page-params.ts';
import { FIND_LOAD_ERROR } from '../../../lib/teams/labels.ts';
import { optionalSessionToken } from '../_session.ts';

export const metadata: Metadata = { title: 'Find a team' };
export const dynamic = 'force-dynamic';

/** Public: anonymous visitors search; signed-in users also see their own status per team (A5). */
export default async function FindTeamPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const q = (firstParam(params, 'q') ?? '').trim();
  const after = firstParam(params, 'after');
  const result = await apiClient.findTeams(
    { q, after },
    { session: await optionalSessionToken(), incoming: await headers() },
  );

  return (
    <TeamShell>
      <h1 className="text-2xl font-semibold">Find a team</h1>
      <p className="text-base">
        Public teams you can ask to join. Private teams share an invite link instead.
      </p>
      <TeamSearchForm q={q} />
      {result.ok ? (
        <FindResults q={q} {...result.data} />
      ) : (
        <div className="flex flex-col gap-3">
          <FormBanner
            kind="error"
            lines={[
              result.status === 422
                ? (Object.values(result.error.fieldErrors ?? {})[0]?.[0] ?? FIND_LOAD_ERROR)
                : FIND_LOAD_ERROR,
            ]}
          />
          <a href={buildUrl('/teams/find', { q, after })} className={LINK_CLASS}>
            Try again
          </a>
        </div>
      )}
    </TeamShell>
  );
}
