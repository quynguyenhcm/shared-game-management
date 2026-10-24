'use client';

import type { DstOptionsEntry } from '@sgm/shared';
import { dstView } from '../../lib/teams/sessions-view.ts';
import { SECONDARY_BUTTON_CLASS } from '../auth/styles.ts';

/**
 * The choice shown directly under a court or deadline time that does not exist (a clock-forward gap) or
 * happens twice (a clock-back overlap), T-10. A `role="group"` labelled by its message, never a fieldset;
 * the input it follows names the message in `aria-describedby` (see `dstMessageId`). The buttons come from
 * the API's `dstOptions`; the zone name is read from each option's instant, never hard-coded to a date.
 */
export function DstChoice({
  id,
  entry,
  kind,
  onChoose,
}: {
  id: string;
  entry: DstOptionsEntry;
  kind: 'court' | 'deadline';
  onChoose: (choice: DstOptionsEntry['options'][number]['choice']) => void;
}) {
  const view = dstView(entry, kind);
  return (
    <div
      role="group"
      aria-labelledby={dstMessageId(id)}
      className="flex flex-col gap-2 rounded-md border border-slate-500 bg-slate-50 p-3"
    >
      <p id={dstMessageId(id)} className="text-base text-slate-900">
        {view.message}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        {view.buttons.map((button) => (
          <button
            key={button.choice}
            type="button"
            onClick={() => {
              onChoose(button.choice);
            }}
            className={`${SECONDARY_BUTTON_CLASS} sm:w-auto`}
          >
            {button.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The id of a DST message, for the input's `aria-describedby`. */
export function dstMessageId(id: string): string {
  return `${id}-message`;
}
