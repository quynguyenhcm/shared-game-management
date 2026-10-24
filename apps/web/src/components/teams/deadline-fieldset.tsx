'use client';

import type { DstOptionsEntry } from '@sgm/shared';
import type { Dispatch } from 'react';
import type { FieldErrors } from '../../lib/auth/validation.ts';
import {
  parseDstField,
  type SessionFormAction,
  type SessionFormState,
} from '../../lib/teams/session-form-state.ts';
import { DEADLINE_COPY, deadlineCurrently } from '../../lib/teams/sessions-view.ts';
import { FOCUS_RING } from '../auth/styles.ts';
import { DstChoice, dstMessageId } from './dst-choice.tsx';
import { SessionField } from './session-field.tsx';

/**
 * The cancellation deadline (T-8): "Default: 48 hours before the first court starts" (posts nothing but the
 * mode, and the API stores `deadline_is_default`) or "A specific date and time". A series shows only the
 * static line, because every instance follows its own start. The readout is not a live region.
 */
export function DeadlineFieldset({
  kind,
  state,
  errors,
  dst,
  readout,
  dispatch,
}: {
  kind: 'session' | 'series';
  state: SessionFormState;
  errors: FieldErrors;
  dst: readonly DstOptionsEntry[];
  /** `Mon 2 Nov, 8:00 am`, the default deadline of the saved start (null on a new session). */
  readout: string | null;
  dispatch: Dispatch<SessionFormAction>;
}) {
  const { deadline } = state;
  if (kind === 'series') {
    return (
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="text-lg font-semibold">{DEADLINE_COPY.legend}</legend>
        <p className="text-base text-slate-900">{DEADLINE_COPY.seriesLine}</p>
      </fieldset>
    );
  }
  const timeDst = dst.find((entry) => parseDstField(entry.field)?.kind === 'deadline');
  const options = [
    { value: 'default', label: DEADLINE_COPY.defaultOption },
    { value: 'specific', label: DEADLINE_COPY.specificOption },
  ] as const;
  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="text-lg font-semibold">{DEADLINE_COPY.legend}</legend>
      <div className="flex flex-col">
        {options.map((option) => (
          <label key={option.value} className="flex min-h-11 items-center gap-3 text-base">
            <input
              type="radio"
              name="deadlineMode"
              value={option.value}
              checked={deadline.mode === option.value}
              onChange={() => {
                dispatch({ type: 'set_deadline_mode', mode: option.value });
              }}
              className={`size-5 ${FOCUS_RING}`}
            />
            {option.label}
          </label>
        ))}
      </div>
      {deadline.mode === 'default' && readout !== null ? (
        <p className="text-sm text-slate-700">{deadlineCurrently(readout)}</p>
      ) : null}
      {deadline.mode === 'specific' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <SessionField
            name="deadlineDate"
            type="date"
            label="Date"
            value={deadline.date}
            error={errors.deadlineDate?.[0]}
            onChange={(value) => {
              dispatch({ type: 'set_deadline_date', value });
            }}
          />
          <div className="flex min-w-0 flex-col gap-2">
            <SessionField
              name="deadlineTime"
              type="time"
              label="Time"
              value={deadline.time}
              error={errors.deadlineTime?.[0]}
              describedBy={timeDst === undefined ? undefined : dstMessageId('deadline-dst')}
              onChange={(value) => {
                dispatch({ type: 'set_deadline_time', value });
              }}
            />
            {timeDst === undefined ? null : (
              <DstChoice
                id="deadline-dst"
                entry={timeDst}
                kind="deadline"
                onChoose={(choice) => {
                  dispatch({ type: 'dst_choose', field: timeDst.field, choice });
                }}
              />
            )}
          </div>
          {deadline.disambiguation === null ? null : (
            <input type="hidden" name="deadlineDisambiguation" value={deadline.disambiguation} />
          )}
        </div>
      ) : null}
    </fieldset>
  );
}
