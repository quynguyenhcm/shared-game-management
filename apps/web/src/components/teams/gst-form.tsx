'use client';

import { formatIrdNumber } from '@sgm/shared';
import { useState } from 'react';
import type { FormState } from '../../lib/auth/form-state.ts';
import type { FieldErrors } from '../../lib/auth/validation.ts';
import { saveGstAction } from '../../lib/teams/banking-actions.ts';
import {
  GST_CLEAR_HINT,
  GST_CLEAR_LABEL,
  GST_NUMBER_HINT,
  GST_TOGGLE_LABEL,
  bankingErrorLines,
  gstHelperText,
  validateGstForm,
  viewHref,
} from '../../lib/teams/banking-view.ts';
import { ErrorSummary } from '../auth/error-summary.tsx';
import { FormBanner } from '../auth/form-banner.tsx';
import { LINK_CLASS } from '../auth/styles.ts';
import { SubmitButton } from '../auth/submit-button.tsx';
import { TextField } from '../auth/text-field.tsx';
import { useAuthForm } from '../auth/use-auth-form.ts';

const FIELD_ORDER = ['gstRegistered', 'gstNumber'] as const;

/**
 * The toggle and the single GST number (R2). The number input exists only while the toggle is on, so
 * turning GST off submits `gstRegistered` alone and the API keeps the saved number. Keyed by the parent on
 * the form state: React 19 resets the form's inputs after an action, and a fresh mount re-seeds `checked`.
 */
function GstFields({
  initialChecked,
  defaultNumber,
  hasSavedNumber,
  fieldErrors,
}: {
  initialChecked: boolean;
  defaultNumber: string | undefined;
  /** A number is saved: while GST is off it can be removed (it is personal data for a sole trader). */
  hasSavedNumber: boolean;
  fieldErrors: FieldErrors;
}) {
  const [checked, setChecked] = useState(initialChecked);
  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="flex min-h-11 items-center gap-3">
          <input
            id="field-gstRegistered"
            name="gstRegistered"
            type="checkbox"
            defaultChecked={initialChecked}
            aria-describedby="field-gstRegistered-hint"
            onChange={(event) => {
              setChecked(event.target.checked);
            }}
            className="size-5 shrink-0 accent-slate-900"
          />
          <label htmlFor="field-gstRegistered" className="text-base font-medium">
            {GST_TOGGLE_LABEL}
          </label>
        </div>
        <p id="field-gstRegistered-hint" className="text-sm text-slate-700">
          {gstHelperText(checked)}
        </p>
      </div>
      {checked ? (
        <TextField
          name="gstNumber"
          label="GST number"
          hint={GST_NUMBER_HINT}
          autoComplete="off"
          inputMode="numeric"
          spellCheck={false}
          defaultValue={defaultNumber}
          error={fieldErrors.gstNumber?.[0]}
        />
      ) : hasSavedNumber ? (
        <div className="flex flex-col gap-1">
          <div className="flex min-h-11 items-center gap-3">
            <input
              id="field-clearGstNumber"
              name="clearGstNumber"
              type="checkbox"
              aria-describedby="field-clearGstNumber-hint"
              className="size-5 shrink-0 accent-slate-900"
            />
            <label htmlFor="field-clearGstNumber" className="text-base font-medium">
              {GST_CLEAR_LABEL}
            </label>
          </div>
          <p id="field-clearGstNumber-hint" className="text-sm text-slate-700">
            {GST_CLEAR_HINT}
          </p>
        </div>
      ) : null}
    </>
  );
}

/** Changes whenever the submitted toggle, number or outcome changes, so `GstFields` re-seeds after a result. */
function resultKey(state: FormState): string {
  return [
    state.error?.code ?? '',
    JSON.stringify(state.fieldErrors ?? {}),
    state.values?.gstRegistered ?? '',
    state.values?.gstNumber ?? '',
  ].join('|');
}

export function GstForm({
  teamId,
  savedRegistered,
  savedNumber,
  changeKey,
  returnTo,
  editing,
}: {
  teamId: string;
  savedRegistered: boolean;
  /** Canonical digits, or null. */
  savedNumber: string | null;
  /** A UUID v4 per page render: a retry resends it, so a late replay changes nothing (D-54). */
  changeKey: string;
  returnTo: string | undefined;
  /** Edit mode (`?edit=gst`): a Cancel link back to the summary. */
  editing: boolean;
}) {
  const form = useAuthForm(
    saveGstAction,
    (values) => validateGstForm(values, { hasSavedGstNumber: savedNumber !== null }),
    [],
  );
  const { fieldErrors, values } = form;
  const initialChecked =
    values.gstRegistered === undefined ? savedRegistered : values.gstRegistered === 'on';
  const defaultNumber =
    values.gstNumber ?? (savedNumber === null ? undefined : formatIrdNumber(savedNumber));
  return (
    <form action={form.submit} noValidate className="flex max-w-xl flex-col gap-5">
      <ErrorSummary
        errors={fieldErrors}
        order={FIELD_ORDER}
        focusToken={form.clientFailure ?? form.state}
      />
      {form.state.error === undefined ? null : (
        <FormBanner
          kind="error"
          lines={bankingErrorLines(form.state.error.code)}
          focusToken={form.state}
        />
      )}
      <input type="hidden" name="teamId" value={teamId} />
      <input type="hidden" name="changeKey" value={changeKey} />
      {returnTo === undefined ? null : <input type="hidden" name="returnTo" value={returnTo} />}
      {editing ? <input type="hidden" name="edit" value="gst" /> : null}
      <GstFields
        key={resultKey(form.state)}
        initialChecked={initialChecked}
        defaultNumber={defaultNumber}
        hasSavedNumber={savedNumber !== null}
        fieldErrors={fieldErrors}
      />
      <div className="flex flex-col gap-2">
        <SubmitButton label="Save GST settings" pendingLabel="Saving…" />
        {editing ? (
          <a href={viewHref(teamId, 'gst', returnTo)} className={LINK_CLASS}>
            Cancel
          </a>
        ) : null}
      </div>
    </form>
  );
}
