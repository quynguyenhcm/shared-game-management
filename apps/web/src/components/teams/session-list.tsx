import type { SessionResponse } from '@sgm/shared';
import {
  LIST_SECTIONS,
  plural,
  sessionLabel,
  sessionWhen,
  type ListSectionId,
  type SeriesGroup,
} from '../../lib/teams/sessions-view.ts';
import {
  listPagerHrefs,
  seriesPath,
  sessionPath,
  type ListCursorSection,
} from '../../lib/teams/sessions-paths.ts';
import { FOCUS_RING, LINK_CLASS } from '../auth/styles.ts';
import { SectionPager } from './section-pager.tsx';

export interface SessionPage {
  sessions: readonly SessionResponse[];
  nextCursor: string | null;
}

/** What the pager links name, for their accessible names ("Next upcoming sessions"). */
const PAGER_LABEL: Record<ListCursorSection, string> = {
  upcoming: 'upcoming sessions',
  drafts: 'drafts',
  past: 'past sessions',
};

const CHIP = 'rounded-md border border-slate-500 px-2 py-1 text-sm text-slate-900';

/** One session row: a single link (date and times), then place and courts, then label chips and the series tag. */
function SessionRow({
  teamId,
  session,
  isPayoutConfigured,
}: {
  teamId: string;
  session: SessionResponse;
  isPayoutConfigured: boolean;
}) {
  const when = sessionWhen(session);
  const { label, tags } = sessionLabel(session, { isPayoutConfigured });
  return (
    <li className="flex flex-col gap-1 rounded-md border border-slate-300 p-3">
      <a
        href={sessionPath(teamId, session.id)}
        className={`${LINK_CLASS} min-w-0 break-words font-medium`}
      >
        {when.text}
      </a>
      <p className="min-w-0 break-words text-base text-slate-900">
        {session.location} · {plural(session.courts.length, 'court')}
      </p>
      <ul className="flex flex-wrap gap-2">
        {[label, ...tags].map((text) => (
          <li key={text} className={CHIP}>
            {text}
          </li>
        ))}
      </ul>
    </li>
  );
}

/**
 * The four sections of the Sessions list (UI/UX D4): Upcoming, Drafts, Series, then Past and cancelled. Rows are
 * flat cards with one tab stop each. Each paged section keeps its own keyset cursor (`?upcoming=`, `?drafts=`,
 * `?past=`) and offers plain "Next" and "Back to start" links. A server component: no script is needed.
 */
export function SessionList({
  teamId,
  isPayoutConfigured,
  upcoming,
  drafts,
  past,
  series,
  current,
}: {
  teamId: string;
  isPayoutConfigured: boolean;
  upcoming: SessionPage;
  drafts: SessionPage;
  past: SessionPage;
  series: readonly SeriesGroup[];
  /** The cursors in the URL now, so each section's links keep the others'. */
  current: Record<string, string | undefined>;
}) {
  const pages: Record<Exclude<ListSectionId, 'series'>, SessionPage> = { upcoming, drafts, past };
  return (
    <>
      {LIST_SECTIONS.map((section) => {
        const headingId = `${section.id}-heading`;
        const page = section.id === 'series' ? null : pages[section.id];
        const empty = section.id === 'series' ? series.length === 0 : page?.sessions.length === 0;
        return (
          <section
            key={section.id}
            id={section.id}
            aria-labelledby={headingId}
            className="flex scroll-mt-4 flex-col gap-3"
          >
            <h2
              id={headingId}
              className={`min-w-0 break-words text-lg font-semibold outline-none ${FOCUS_RING}`}
            >
              {section.title}
            </h2>
            {empty ? <p className="text-base text-slate-900">{section.empty}</p> : null}
            {section.id === 'series' ? (
              <ul className="flex flex-col gap-2">
                {series.map((group) => (
                  <li
                    key={group.ruleId}
                    className="flex flex-col gap-1 rounded-md border border-slate-300 p-3"
                  >
                    <a
                      href={seriesPath(teamId, group.ruleId)}
                      className={`${LINK_CLASS} min-w-0 break-words font-medium`}
                    >
                      {group.name}
                    </a>
                    <p className="text-base text-slate-900">{group.upcomingText}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <>
                <ul className="flex flex-col gap-2">
                  {page?.sessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      teamId={teamId}
                      session={session}
                      isPayoutConfigured={isPayoutConfigured}
                    />
                  ))}
                </ul>
                <SectionPager
                  label={PAGER_LABEL[section.id]}
                  {...listPagerHrefs({
                    teamId,
                    section: section.id,
                    current,
                    nextCursor: page?.nextCursor ?? null,
                  })}
                />
              </>
            )}
          </section>
        );
      })}
    </>
  );
}
