'use client';

import type { SeriesInstanceResponse } from '@sgm/shared';
import { useState } from 'react';
import type { ModerationAction } from '../../lib/teams/moderation.ts';
import { END_SERIES_COPY, endSeriesImpact } from '../../lib/teams/sessions-view.ts';
import { FOCUS_RING, INPUT_CLASS } from '../auth/styles.ts';
import { InlineConfirm } from './inline-confirm.tsx';

/**
 * End series (T-6): an `InlineConfirm` whose form carries the last date and the "Also cancel the published
 * sessions" checkbox. The impact text is computed in the browser from the instances the page loaded and
 * updates on the date's `change` event only, in a polite status (never per keystroke). Unticked, published
 * sessions after the date are kept. There is no partial-failure state: ending is one transaction.
 */
export function EndSeriesConfirm({
  id,
  action,
  fields,
  instances,
  defaultLastDate,
  defaultOpen = false,
}: {
  id: string;
  action: ModerationAction;
  /** Hidden fields posted with the action: `teamId`, `ruleId`, `expectedVersion`. */
  fields: Record<string, string>;
  instances: readonly Pick<
    SeriesInstanceResponse,
    'date' | 'status' | 'isInstanceOverridden' | 'activeRegistrationCount'
  >[];
  defaultLastDate: string;
  defaultOpen?: boolean;
}) {
  const [lastDate, setLastDate] = useState(defaultLastDate);
  const [alsoCancel, setAlsoCancel] = useState(false);
  const impact = endSeriesImpact(instances, lastDate, alsoCancel);
  const dateId = `${id}-last-date`;
  return (
    <InlineConfirm
      id={id}
      section="series"
      action={action}
      fields={fields}
      triggerLabel={END_SERIES_COPY.trigger}
      prompt={END_SERIES_COPY.prompt}
      confirmLabel={END_SERIES_COPY.confirmLabel}
      pendingLabel={END_SERIES_COPY.pendingLabel}
      dismissLabel={END_SERIES_COPY.dismissLabel}
      destructive
      defaultOpen={defaultOpen}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={dateId} className="text-base font-medium">
          {END_SERIES_COPY.lastDate}
        </label>
        <input
          id={dateId}
          name="lastDate"
          type="date"
          value={lastDate}
          autoComplete="off"
          onChange={(event) => {
            setLastDate(event.target.value);
          }}
          className={INPUT_CLASS}
        />
      </div>
      <div role="status" aria-live="polite" className="flex flex-col gap-1 text-base">
        {impact.lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {impact.checkboxLabel === null ? null : (
        <label className="flex min-h-11 items-center gap-3 text-base">
          <input
            type="checkbox"
            name="alsoCancelPublished"
            value="true"
            checked={alsoCancel}
            onChange={(event) => {
              setAlsoCancel(event.target.checked);
            }}
            className={`size-5 ${FOCUS_RING}`}
          />
          {impact.checkboxLabel}
        </label>
      )}
    </InlineConfirm>
  );
}
