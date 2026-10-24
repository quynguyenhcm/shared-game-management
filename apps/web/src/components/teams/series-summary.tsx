import type { SeriesResponse } from '@sgm/shared';
import type { ReactNode } from 'react';
import {
  SERIES_COPY,
  seriesDetailsRows,
  seriesEndedState,
  seriesSummaryLine,
} from '../../lib/teams/sessions-view.ts';
import { LINK_CLASS } from '../auth/styles.ts';

/**
 * The series page's read-only parts (UI/UX D3 option 1, summary-first). `header` is the name and the one-line
 * summary; `details` is the details list, "Change series details" (a link to `?edit=details`), then the
 * "Publish drafts now" and "End series" slots (the page supplies those forms). The page puts the sessions
 * list between the two; `all` renders both for a page that does not. An ended series offers neither Change
 * nor End, and says how to run it again.
 */
export function SeriesSummary({
  series,
  editHref,
  endSeries,
  publishDrafts,
  part = 'all',
}: {
  series: SeriesResponse;
  editHref: string;
  endSeries?: ReactNode;
  publishDrafts?: ReactNode;
  part?: 'header' | 'details' | 'all';
}) {
  return (
    <>
      {part === 'details' ? null : (
        <div className="flex flex-col gap-1">
          <h1 className="min-w-0 break-words text-2xl font-semibold">{series.name}</h1>
          <p className="text-base text-slate-900">{seriesSummaryLine(series)}</p>
        </div>
      )}
      {part === 'header' ? null : (
        <section aria-labelledby="series-details-heading" className="flex flex-col gap-3">
          <h2 id="series-details-heading" className="text-lg font-semibold">
            {SERIES_COPY.detailsHeading}
          </h2>
          <dl className="flex flex-col gap-1">
            {seriesDetailsRows(series).map((row) => (
              <div key={row.term} className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
                <dt className="text-base font-medium sm:w-40">{row.term}</dt>
                <dd className="text-base text-slate-900">{row.value}</dd>
              </div>
            ))}
          </dl>
          {series.isActive ? (
            <>
              <a href={editHref} className={`${LINK_CLASS} self-start`}>
                {SERIES_COPY.changeDetails}
              </a>
              {publishDrafts}
              <hr className="border-slate-300" />
              {endSeries}
            </>
          ) : (
            <p className="rounded-md border-2 border-slate-900 p-4 text-base">
              {seriesEndedState(series.recurUntil)}
            </p>
          )}
        </section>
      )}
    </>
  );
}
