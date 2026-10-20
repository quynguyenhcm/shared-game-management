'use client';

import type { SeriesResponse } from '@sgm/shared';
import type { Dispatch } from 'react';
import type { FieldErrors } from '../../lib/auth/validation.ts';
import {
  derivePattern,
  type PatternState,
  type SessionFormAction,
} from '../../lib/teams/session-form-state.ts';
import {
  FREQUENCY_OPTIONS,
  SERIES_COPY,
  publishHint,
  seriesDetailsRows,
  weekdayName,
} from '../../lib/teams/sessions-view.ts';
import { FieldError } from '../auth/field-message.tsx';
import { FOCUS_RING } from '../auth/styles.ts';
import { SessionField } from './session-field.tsx';

type SavedPattern = Pick<
  SeriesResponse,
  'frequency' | 'dayOfWeek' | 'startsOn' | 'monthlyWeek' | 'recurUntil'
>;

/**
 * The series pattern (P-3). Create: "Repeats" (Weekly, Every 2 weeks, Monthly), "First session" and "Repeat
 * until"; the weekday and the monthly ordinal are derived from the first date, so there is no weekday field
 * (the action derives `dayOfWeek` from `startsOn`). A Monthly first date that is both the 4th and the last of
 * its weekday adds the "Which one?" pair. Edit: the pattern is read-only rows with the fixed-pattern
 * sentence and is posted unchanged as hidden fields; "Repeat until" can only be extended or cleared (its `min`
 * is the saved value), because shortening is End series.
 */
export function PatternFieldset({
  mode,
  pattern,
  saved,
  errors,
  dispatch,
  horizonDays,
}: {
  mode: 'create' | 'edit';
  pattern: PatternState;
  saved?: SavedPattern;
  errors: FieldErrors;
  dispatch: Dispatch<SessionFormAction>;
  horizonDays: number;
}) {
  const view = derivePattern(pattern);
  const day = view.dayOfWeek === null ? '' : weekdayName(view.dayOfWeek);
  const untilField = (
    <SessionField
      name="recurUntil"
      type="date"
      label={SERIES_COPY.repeatUntil}
      hint={mode === 'edit' ? SERIES_COPY.repeatUntilHint : undefined}
      min={mode === 'edit' && saved?.recurUntil != null ? saved.recurUntil : undefined}
      value={pattern.recurUntil}
      error={errors.recurUntil?.[0]}
      onChange={(value) => {
        dispatch({ type: 'set_recur_until', value });
      }}
    />
  );

  if (mode === 'edit' && saved !== undefined) {
    const rows = seriesDetailsRows(saved).slice(0, 2);
    return (
      <fieldset className="flex min-w-0 flex-col gap-4">
        <legend className="text-lg font-semibold">{SERIES_COPY.repeatsLegend}</legend>
        <dl className="flex flex-col gap-2">
          {rows.map((row) => (
            <div key={row.term} className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
              <dt className="text-base font-medium sm:w-40">{row.term}</dt>
              <dd className="text-base text-slate-900">{row.value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-sm text-slate-700">{SERIES_COPY.fixedPattern}</p>
        <input type="hidden" name="frequency" value={saved.frequency} />
        <input type="hidden" name="startsOn" value={saved.startsOn} />
        {saved.monthlyWeek === null ? null : (
          <input type="hidden" name="monthlyWeek" value={String(saved.monthlyWeek)} />
        )}
        {untilField}
      </fieldset>
    );
  }

  const frequencyError = errors.frequency?.[0];
  return (
    <fieldset className="flex min-w-0 flex-col gap-4">
      <legend className="text-lg font-semibold">{SERIES_COPY.repeatsLegend}</legend>
      {frequencyError === undefined ? null : (
        <FieldError id="field-frequency-error" message={frequencyError} />
      )}
      <div className="flex flex-col">
        {FREQUENCY_OPTIONS.map((option, index) => {
          const helpId = `frequency-${option.value.toLowerCase()}-help`;
          return (
            <div key={option.value}>
              <label className="flex min-h-11 items-center gap-3 text-base">
                <input
                  type="radio"
                  name="frequency"
                  value={option.value}
                  id={index === 0 ? 'field-frequency' : undefined}
                  checked={pattern.frequency === option.value}
                  aria-describedby={helpId}
                  onChange={() => {
                    dispatch({ type: 'set_frequency', value: option.value });
                  }}
                  className={`size-5 ${FOCUS_RING}`}
                />
                {option.label}
              </label>
              <p id={helpId} className="pb-1 pl-8 text-sm text-slate-700">
                {option.help}
              </p>
            </div>
          );
        })}
      </div>
      <SessionField
        name="startsOn"
        type="date"
        label={SERIES_COPY.firstSession}
        value={pattern.startsOn}
        error={errors.startsOn?.[0]}
        onChange={(value) => {
          dispatch({ type: 'set_starts_on', value });
        }}
      />
      {pattern.frequency === 'MONTHLY' && view.picker ? (
        <fieldset className="flex flex-col">
          <legend className="text-base font-medium">{SERIES_COPY.monthlyWhich}</legend>
          {(
            [
              [4, `4th ${day}`],
              [-1, `Last ${day}`],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex min-h-11 items-center gap-3 text-base">
              <input
                type="radio"
                name="monthlyWeek"
                value={String(value)}
                checked={view.monthlyWeek === value}
                onChange={() => {
                  dispatch({ type: 'set_monthly_week', value });
                }}
                className={`size-5 ${FOCUS_RING}`}
              />
              {label}
            </label>
          ))}
        </fieldset>
      ) : null}
      {pattern.frequency === 'MONTHLY' && !view.picker && view.monthlyWeek !== null ? (
        <input type="hidden" name="monthlyWeek" value={String(view.monthlyWeek)} />
      ) : null}
      {untilField}
      {view.fifthNote === null ? null : (
        <p className="text-base text-slate-900">{view.fifthNote}</p>
      )}
      {view.line === null ? null : (
        <p className="text-base font-medium text-slate-900">{view.line}</p>
      )}
      <p className="text-sm text-slate-700">{publishHint(horizonDays)}</p>
    </fieldset>
  );
}
