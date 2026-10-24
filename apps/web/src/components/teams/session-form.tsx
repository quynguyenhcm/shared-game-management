'use client';

import type { SessionResponse } from '@sgm/shared';
import { useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorSummary } from '../auth/error-summary.tsx';
import { FormBanner } from '../auth/form-banner.tsx';
import { BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from '../auth/styles.ts';
import { createSessionAction, saveSessionAction } from '../../lib/teams/sessions-actions.ts';
import { formFeeSummary, initialSessionForm } from '../../lib/teams/session-form-state.ts';
import {
  PUBLISH_CONFIRM,
  deadlineReadout,
  publishPrompt,
  sessionErrorBanner,
} from '../../lib/teams/sessions-view.ts';
import { CostingFieldset } from './costing-fieldset.tsx';
import { CourtTable } from './court-table.tsx';
import { DeadlineFieldset } from './deadline-fieldset.tsx';
import { DetailsFieldset, PlacesFieldset } from './details-fieldset.tsx';
import { ConfirmPanel } from './inline-confirm.tsx';
import { PricingFieldset } from './pricing-fieldset.tsx';
import { useSessionForm } from './use-session-form.ts';

/** A submit button that carries the form's intent; only the button that was pressed shows its pending label. */
function IntentButton({
  intent,
  label,
  pendingLabel,
  primary,
}: {
  intent: 'draft' | 'publish' | 'save';
  label: string;
  pendingLabel: string;
  primary: boolean;
}) {
  const { pending, data } = useFormStatus();
  const mine = pending && data?.get('intent') === intent;
  return (
    <button
      type="submit"
      name="intent"
      value={intent}
      aria-disabled={pending}
      onClick={(event) => {
        if (pending) event.preventDefault();
      }}
      className={`${primary ? BUTTON_CLASS : SECONDARY_BUTTON_CLASS} sm:w-auto`}
    >
      {mine ? pendingLabel : label}
    </button>
  );
}

/** The publish confirm: part of the main form, so confirming submits every field with `intent=publish`. */
function PublishPanel({ prompt, onDismiss }: { prompt: string; onDismiss: () => void }) {
  const { pending } = useFormStatus();
  return (
    <ConfirmPanel
      id="publish"
      prompt={prompt}
      confirmLabel={PUBLISH_CONFIRM.confirmLabel}
      pendingLabel={PUBLISH_CONFIRM.pendingLabel}
      dismissLabel={PUBLISH_CONFIRM.dismissLabel}
      onDismiss={onDismiss}
      pending={pending}
      confirmName="intent"
      confirmValue="publish"
    />
  );
}

/**
 * The one-off session editor and the series-date editor (UI/UX "Session editor"): Details, Courts, Places,
 * Costing, Pricing, Cancellation deadline, held in controlled state (React 19 resets uncontrolled fields after
 * a form action). A draft offers "Save draft" first (so Enter saves a draft) and "Save and publish"; a paid
 * session asks first, in a confirm that is part of this form. A published session offers "Save changes". The
 * page supplies everything above the form (back link, banner, heading, scope and status lines) and the cancel
 * control below it. The API stays the authority: this form only avoids offering what it would refuse.
 */
export function SessionForm({
  teamId,
  mode,
  session,
  createKey,
  bankingHref,
  defaultPublishOpen = false,
}: {
  teamId: string;
  mode: 'create' | 'edit';
  session?: SessionResponse;
  /** A fresh UUID per page render: a retry of the same render replays, a new visit creates anew. */
  createKey?: string;
  /** The banking page with this page as `returnTo`, for a refused publish. */
  bankingHref: string;
  /** Render the publish confirm open on first render (tests). */
  defaultPublishOpen?: boolean;
}) {
  const form = useSessionForm({
    initial: initialSessionForm(session),
    kind: 'session',
    action: mode === 'create' ? createSessionAction : saveSessionAction,
  });
  const { state, dispatch, fieldErrors, serverState } = form;
  const [publishOpen, setPublishOpen] = useState(defaultPublishOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const published = session?.status === 'PUBLISHED';
  const feeText = formFeeSummary(state);
  const banner =
    serverState.error === undefined
      ? null
      : sessionErrorBanner(serverState.error.code, { bankingHref });
  const dismissPublish = (): void => {
    setPublishOpen(false);
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
      {mode === 'edit' && session !== undefined ? (
        <>
          <input type="hidden" name="sessionId" value={session.id} />
          <input type="hidden" name="expectedVersion" value={String(session.version)} />
          <input type="hidden" name="status" value={session.status} />
          <input type="hidden" name="overridden" value={String(session.isInstanceOverridden)} />
        </>
      ) : null}

      <DetailsFieldset
        state={state}
        errors={fieldErrors}
        dispatch={dispatch}
        date={session?.recurringRuleId != null ? 'fixed' : 'input'}
      />
      <CourtTable
        state={state.courts}
        errors={fieldErrors}
        dst={state.dst}
        live={state.live}
        dispatch={dispatch}
      />
      <PlacesFieldset
        state={state}
        errors={fieldErrors}
        dispatch={dispatch}
        published={published}
      />
      <CostingFieldset state={state} errors={fieldErrors} dispatch={dispatch} />
      <PricingFieldset state={state} errors={fieldErrors} dispatch={dispatch} />
      <DeadlineFieldset
        kind="session"
        state={state}
        errors={fieldErrors}
        dst={state.dst}
        readout={deadlineReadout(session?.startsAt ?? null)}
        dispatch={dispatch}
      />

      <div className="flex flex-col gap-3">
        {published ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <IntentButton intent="save" label="Save changes" pendingLabel="Saving…" primary />
          </div>
        ) : (
          // Primary first at 360 px (column-reverse), rightmost from 640 px; "Save draft" stays first in the DOM so Enter saves a draft.
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <IntentButton
              intent="draft"
              label="Save draft"
              pendingLabel="Saving…"
              primary={false}
            />
            {feeText === null ? (
              <IntentButton
                intent="publish"
                label="Save and publish"
                pendingLabel="Publishing…"
                primary
              />
            ) : (
              <button
                ref={triggerRef}
                type="button"
                aria-expanded={publishOpen}
                aria-controls="publish-panel"
                onClick={() => {
                  setPublishOpen((open) => !open);
                }}
                className={`${BUTTON_CLASS} sm:w-auto`}
              >
                Save and publish
              </button>
            )}
          </div>
        )}
        {publishOpen && !published && feeText !== null ? (
          <PublishPanel prompt={publishPrompt(feeText)} onDismiss={dismissPublish} />
        ) : null}
      </div>
    </form>
  );
}
