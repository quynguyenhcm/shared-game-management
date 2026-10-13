import type { FindTeamsResponse } from '@sgm/shared';
import { buildUrl } from '../../lib/auth/landing.ts';
import { memberCountLabel, statusLabel, truncateDescription } from '../../lib/teams/labels.ts';
import { BUTTON_CLASS, INPUT_CLASS, LINK_CLASS } from '../auth/styles.ts';

/** `GET /teams/find`: a plain GET form, so a search is a shareable URL and Back restores the results. */
export function TeamSearchForm({ q }: { q: string }) {
  return (
    <form
      action="/teams/find"
      method="get"
      role="search"
      className="flex flex-col gap-3 sm:flex-row sm:items-end"
    >
      <div className="flex flex-1 flex-col gap-1">
        <label htmlFor="field-q" className="text-base font-medium">
          Search teams
        </label>
        <input id="field-q" name="q" type="search" defaultValue={q} className={INPUT_CLASS} />
      </div>
      <button type="submit" className={`${BUTTON_CLASS} sm:w-auto`}>
        Search
      </button>
    </form>
  );
}

function pageLink(q: string, after: string): string {
  return buildUrl('/teams/find', { q, after });
}

/** The result list, its live heading, the empty states and Previous/Next (cursors are opaque). */
export function FindResults({
  q,
  teams,
  nextCursor,
  prevCursor,
}: { q: string } & FindTeamsResponse) {
  return (
    <section aria-labelledby="results-heading" className="flex flex-col gap-4">
      <h2 id="results-heading" aria-live="polite" className="text-lg font-semibold">
        {q === '' ? 'All public teams' : `Teams matching "${q}"`}
      </h2>
      {teams.length === 0 ? (
        q === '' ? (
          <p className="text-base">
            No public teams yet.{' '}
            <a href="/teams/new" className={LINK_CLASS}>
              Create the first one.
            </a>
          </p>
        ) : (
          <p className="text-base">
            {`No teams match "${q}". Try a different word, or `}
            <a href="/teams/new" className={LINK_CLASS}>
              create your own team
            </a>
            .
          </p>
        )
      ) : (
        <ul className="flex flex-col gap-3">
          {teams.map((team) => (
            <li
              key={team.id}
              className="flex flex-col gap-1 rounded-md border border-slate-300 p-4"
            >
              <h3 className="min-w-0 break-words text-lg font-semibold">{team.name}</h3>
              {team.description ? (
                <p className="min-w-0 break-words text-base">
                  {truncateDescription(team.description)}
                </p>
              ) : null}
              <p className="flex flex-wrap items-center gap-x-3 text-base">
                <span>{memberCountLabel(team.memberCount)}</span>
                {team.myStatus === null || team.myStatus === 'REJECTED' ? null : (
                  <strong>{statusLabel(team.myStatus)}</strong>
                )}
              </p>
              <a href={`/teams/${team.id}`} className={LINK_CLASS}>
                View team<span className="sr-only"> {team.name}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {prevCursor === null && nextCursor === null ? null : (
        <nav aria-label="Pagination" className="flex gap-6">
          {prevCursor === null ? null : (
            <a href={pageLink(q, prevCursor)} className={LINK_CLASS}>
              Previous
            </a>
          )}
          {nextCursor === null ? null : (
            <a href={pageLink(q, nextCursor)} className={LINK_CLASS}>
              Next
            </a>
          )}
        </nav>
      )}
    </section>
  );
}
