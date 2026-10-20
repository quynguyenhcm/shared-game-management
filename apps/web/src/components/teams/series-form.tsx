'use client';

import type { SeriesResponse } from '@sgm/shared';
import { useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorSummary } from '../auth/error-summary.tsx';
import { FormBanner } from '../auth/form-banner.tsx';
import { BUTTON_CLASS, LINK_CLASS } from '../auth/styles.ts';
import { SubmitButton } from '../auth/submit-button.tsx';
import { createSeriesAction, saveSeriesAction } from '../../lib/teams/sessions-actions.ts';
import { formFeeSummary, initialSessionForm } from '../../lib/teams/session-form-state.ts';
import {
  CREATE_SERIES_CONFIRM,
  SERIES_COPY,
  createSeriesPrompt,
  seriesEffect,
  sessionErrorBanner,
} from '../../lib/teams/sessions-view.ts';
import { CostingFieldset } from './costing-fieldset.tsx';
import { CourtTable } from './court-table.tsx';
import { DeadlineFieldset } from './deadline-fieldset.tsx';
import { DetailsFieldset, PlacesFieldset } from './details-fieldset.tsx';
import { ConfirmPanel } from './inline-confirm.tsx';
import { PatternFieldset } from './pattern-fieldset.tsx';
import { PricingFieldset } from './pricing-fieldset.tsx';
import { useSessionForm } from './use-session-form.ts';

/** The create confirm: part of the main form, so confirming submits every field. */
function CreatePanel({ prompt, onDismiss }: { prompt: string; onDismiss: () => void }) {
  const { pending } = useFormStatus();
  return (
    <ConfirmPanel
      id="create-series"
      prompt={prompt}
      confirmLabel={CREATE_SERIES_CONFIRM.confirmLabel}
      pendingLabel={CREATE_SERIES_CONFIRM.pendingLabel}
      dismissLabel={CREATE_SERIES_CONFIRM.dismissLabel}
      onDismiss={onDismiss}
      pending={pending}
    />
  );
}

/**
 * The series editor (UI/UX "Series form"): Repeats, Details, Courts, Places, Costing, Pricing and a static
 * deadline line. Creating a series always confirms first, because saving it publishes every date inside the
 * horizon within seconds. After creation the pattern is read-only (P-3) and "Repeat until" can only be
 * extended or cleared; the effect line says what a save will do, in numbers, before it is pressed (T-5).
 */
export function SeriesForm({
  teamId,
  mode,
  series,
  createKey,
  bankingHref,
  isPayoutConfigured,
  horizonDays,
  cancelHref,
  defaultConfirmOpen = false,
}: {
  teamId: string;
  mode: 'create' | 'edit';
  series?: SeriesResponse;
  createKey?: string;
  bankingHref: string;
  isPayoutConfigured: boolean;
  /** `horizonDays` from the API (`RECURRENCE_HORIZON_DAYS`): how far ahead sessions are added. */
  horizonDays: number;
  /** Edit mode: the series page without `?edit=`. */
  cancelHref?: string;
  /** Render the create confirm open on first render (tests). */
  defaultConfirmOpen?: boolean;
}) {
  const form = useSessionForm({
    initial: initialSessionForm(series),
    kind: 'series',
    action: mode === 'create' ? createSeriesAction : saveSeriesAction,
  });
  const { state, dispatch, fieldErrors, serverState } = form;
  const [confirmOpen, setConfirmOpen] = useState(defaultConfirmOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const banner =
    serverState.error === undefined
      ? null
      : sessionErrorBanner(serverState.error.code, { bankingHref });
  const dismissConfirm = (): void => {
    setConfirmOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <form action={form.submit} noValidate className="flex flex-col gap-6">
      <ErrorSummary
        errors={fieldErrors}
        order={form.errorOrder}
        focusToken={form.clientFailure ?? serverState}
      />
      {banner === null ? null : (
        <FormBanner
          kind="error"
          lines={banner.lines}
          links={banner.links}
          focusToken={serverState}
        />
      )}
      <input type="hidden" name="teamId" value={teamId} />
      {mode === 'create' && createKey !== undefined ? (
        <input type="hidden" name="createKey" value={createKey} />
      ) : null}
      {mode === 'edit' && series !== undefined ? (
        <>
          <input type="hidden" name="ruleId" value={series.id} />
          <input type="hidden" name="expectedVersion" value={String(series.version)} />
        </>
      ) : null}

      <PatternFieldset
        mode={mode}
        pattern={state.pattern}
        {...(series === undefined ? {} : { saved: series })}
        errors={fieldErrors}
        dispatch={dispatch}
        horizonDays={horizonDays}
      />
      <DetailsFieldset state={state} errors={fieldErrors} dispatch={dispatch} date="none" />
      <CourtTable
        state={state.courts}
        errors={fieldErrors}
        dst={state.dst}
        live={state.live}
        dispatch={dispatch}
      />
      <PlacesFieldset state={state} errors={fieldErrors} dispatch={dispatch} published={false} />
      <CostingFieldset state={state} errors={fieldErrors} dispatch={dispatch} />
      <PricingFieldset state={state} errors={fieldErrors} dispatch={dispatch} />
      <DeadlineFieldset
        kind="series"
        state={state}
        errors={fieldErrors}
        dst={state.dst}
        readout={null}
        dispatch={dispatch}
      />

      {mode === 'edit' && series !== undefined ? (
        <>
          <p className="rounded-md border-2 border-slate-900 p-4 text-base">
            {seriesEffect(series.instances).line}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="sm:w-auto">
              <SubmitButton label={SERIES_COPY.saveButton} pendingLabel={SERIES_COPY.savePending} />
            </div>
            {cancelHref === undefined ? null : (
              <a href={cancelHref} className={LINK_CLASS}>
                Cancel
              </a>
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <button
            ref={triggerRef}
            type="button"
            aria-expanded={confirmOpen}
            aria-controls="create-series-panel"
            onClick={() => {
              setConfirmOpen((open) => !open);
            }}
            className={`${BUTTON_CLASS} sm:w-auto sm:self-start`}
          >
            {SERIES_COPY.createButton}
          </button>
          {confirmOpen ? (
            <CreatePanel
              prompt={createSeriesPrompt({
                firstDate: state.pattern.startsOn,
                feeSummary: formFeeSummary(state),
                bankingMissing: !isPayoutConfigured,
              })}
              onDismiss={dismissConfirm}
            />
          ) : null}
        </div>
      )}
    </form>
  );
}
