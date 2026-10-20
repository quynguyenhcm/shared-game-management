'use client';

import type { DstOptionsEntry } from '@sgm/shared';
import type { Dispatch } from 'react';
import type { FieldErrors } from '../../lib/auth/validation.ts';
import {
  COURT_APPLY_ID,
  COURT_COUNT_ID,
  courtCountKeyAction,
  courtFieldId,
  courtSummary,
  isNotDefault,
  parseDstField,
  type CourtRow,
  type CourtTableState,
  type Live,
  type SessionFormAction,
} from '../../lib/teams/session-form-state.ts';
import { COURT_COPY, defaultsChangedHint } from '../../lib/teams/sessions-view.ts';
import { SECONDARY_BUTTON_CLASS } from '../auth/styles.ts';
import { DstChoice, dstMessageId } from './dst-choice.tsx';
import { SessionField } from './session-field.tsx';

/**
 * The court table (UI/UX D1 option 1): a defaults block ("Number of courts", default start and end, "Apply to
 * all courts") then one labelled row per court. Every court is visible, so what is saved is what is shown.
 * "Number of courts" is not a posted field (no `name`) and commits on blur or Enter without submitting the
 * form. The table owns the form's one persistent polite live region (present from first render); the
 * rows post as `courts.{i}.identifier|startTime|endTime`.
 */
export function CourtTable({
  state,
  errors,
  dst,
  live,
  dispatch,
}: {
  state: CourtTableState;
  errors: FieldErrors;
  dst: readonly DstOptionsEntry[];
  live: Live;
  dispatch: Dispatch<SessionFormAction>;
}) {
  const send = (action: Parameters<typeof courtAction>[0]): void => {
    dispatch(courtAction(action));
  };
  const commit = (): void => {
    send({ type: 'commit_count' });
  };
  const dstFor = (index: number, which: 'start' | 'end'): DstOptionsEntry | undefined =>
    dst.find((entry) => {
      const target = parseDstField(entry.field);
      return target?.kind === 'court' && target.index === index && target.which === which;
    });
  const courtsError = errors.courts?.[0];

  return (
    <fieldset
      id="field-courts"
      tabIndex={-1}
      className="flex min-w-0 flex-col gap-4 outline-none"
      aria-describedby={courtsError === undefined ? undefined : 'field-courts-error'}
    >
      <legend className="text-lg font-semibold">{COURT_COPY.legend}</legend>
      <p className="text-sm text-slate-700">{COURT_COPY.hint}</p>
      {courtsError === undefined ? null : (
        <p id="field-courts-error" className="text-sm text-red-800">
          <span className="sr-only">Error:</span> {courtsError}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <SessionField
          id={COURT_COUNT_ID}
          label={COURT_COPY.count}
          value={state.countText}
          inputMode="numeric"
          onChange={(value) => {
            send({ type: 'set_count_text', value });
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (courtCountKeyAction(event) === 'commit') commit();
          }}
        />
        <SessionField
          id="court-default-start"
          type="time"
          label={COURT_COPY.defaultStart}
          value={state.defaultStart}
          onChange={(value) => {
            send({ type: 'set_default', which: 'start', value });
          }}
        />
        <SessionField
          id="court-default-end"
          type="time"
          label={COURT_COPY.defaultEnd}
          value={state.defaultEnd}
          onChange={(value) => {
            send({ type: 'set_default', which: 'end', value });
          }}
        />
      </div>
      <div className="flex flex-col gap-1">
        <button
          id={COURT_APPLY_ID}
          type="button"
          onClick={() => {
            send({ type: 'apply_all' });
          }}
          className={`${SECONDARY_BUTTON_CLASS} sm:w-auto sm:self-start`}
        >
          {COURT_COPY.apply}
        </button>
        <p className="text-sm text-slate-700">
          {state.defaultsChanged ? defaultsChangedHint(state.rows.length) : COURT_COPY.defaultsHint}
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <div
          aria-hidden="true"
          className="hidden gap-3 text-sm font-medium text-slate-700 sm:grid sm:grid-cols-[1fr_9rem_9rem_auto]"
        >
          <span>Court name</span>
          <span>Start</span>
          <span>End</span>
          <span className="w-20" />
        </div>
        {state.rows.map((row, index) => (
          <CourtRowView
            key={row.key}
            row={row}
            index={index}
            canRemove={state.rows.length > 1}
            notDefault={isNotDefault(state, row)}
            errors={errors}
            startDst={dstFor(index, 'start')}
            endDst={dstFor(index, 'end')}
            dispatch={dispatch}
          />
        ))}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={() => {
            send({ type: 'add' });
          }}
          className={`${SECONDARY_BUTTON_CLASS} sm:w-auto`}
        >
          {COURT_COPY.add}
        </button>
        <p className="text-base text-slate-900">{courtSummary(state)}</p>
      </div>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        <span key={live.seq}>{live.text}</span>
      </div>
    </fieldset>
  );
}

function courtAction(
  action: Extract<SessionFormAction, { type: 'court' }>['action'],
): SessionFormAction {
  return { type: 'court', action };
}

function CourtRowView({
  row,
  index,
  canRemove,
  notDefault,
  errors,
  startDst,
  endDst,
  dispatch,
}: {
  row: CourtRow;
  index: number;
  canRemove: boolean;
  notDefault: boolean;
  errors: FieldErrors;
  startDst: DstOptionsEntry | undefined;
  endDst: DstOptionsEntry | undefined;
  dispatch: Dispatch<SessionFormAction>;
}) {
  const set = (field: 'identifier' | 'startTime' | 'endTime', value: string): void => {
    dispatch(courtAction({ type: 'set_row', key: row.key, field, value }));
  };
  const choose =
    (entry: DstOptionsEntry) =>
    (choice: DstOptionsEntry['options'][number]['choice']): void => {
      dispatch({ type: 'dst_choose', field: entry.field, choice });
    };
  const startId = courtFieldId(row.key, 'start');
  const endId = courtFieldId(row.key, 'end');
  return (
    <div
      role="group"
      aria-label={row.identifier || `Court ${index + 1}`}
      className="grid min-w-0 gap-3 rounded-md border border-slate-300 p-3 sm:grid-cols-[1fr_9rem_9rem_auto] sm:items-start sm:border-0 sm:p-0"
    >
      <SessionField
        id={courtFieldId(row.key, 'name')}
        name={`courts.${index}.identifier`}
        label="Court name"
        labelSrOnlyFromSm
        value={row.identifier}
        error={errors[`court-${row.key}-name`]?.[0]}
        onChange={(value) => {
          set('identifier', value);
        }}
      />
      <div className="flex min-w-0 flex-col gap-2">
        <SessionField
          id={startId}
          name={`courts.${index}.startTime`}
          type="time"
          label="Start"
          labelSrOnlyFromSm
          ariaLabel={`${row.identifier} start`}
          value={row.startTime}
          error={errors[`court-${row.key}-start`]?.[0]}
          describedBy={startDst === undefined ? undefined : dstMessageId(`${startId}-dst`)}
          onChange={(value) => {
            set('startTime', value);
          }}
        />
        {startDst === undefined ? null : (
          <DstChoice
            id={`${startId}-dst`}
            entry={startDst}
            kind="court"
            onChoose={choose(startDst)}
          />
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <SessionField
          id={endId}
          name={`courts.${index}.endTime`}
          type="time"
          label="End"
          labelSrOnlyFromSm
          ariaLabel={`${row.identifier} end`}
          value={row.endTime}
          error={errors[`court-${row.key}-end`]?.[0]}
          describedBy={endDst === undefined ? undefined : dstMessageId(`${endId}-dst`)}
          onChange={(value) => {
            set('endTime', value);
          }}
        />
        {endDst === undefined ? null : (
          <DstChoice id={`${endId}-dst`} entry={endDst} kind="court" onChoose={choose(endDst)} />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:pt-7">
        {notDefault ? (
          <span className="rounded-md border border-slate-500 px-2 py-1 text-sm text-slate-900">
            {COURT_COPY.notDefault}
          </span>
        ) : null}
        {canRemove ? (
          <button
            type="button"
            aria-label={`${COURT_COPY.remove} ${row.identifier}`}
            onClick={() => {
              dispatch(courtAction({ type: 'remove', key: row.key }));
            }}
            className={`${SECONDARY_BUTTON_CLASS} sm:w-auto`}
          >
            {COURT_COPY.remove}
          </button>
        ) : null}
      </div>
      {row.startDisambiguation === undefined ? null : (
        <input type="hidden" name={`courts.${index}.startDisambiguation`} value="earlier" />
      )}
      {row.endDisambiguation === undefined ? null : (
        <input type="hidden" name={`courts.${index}.endDisambiguation`} value="earlier" />
      )}
    </div>
  );
}
