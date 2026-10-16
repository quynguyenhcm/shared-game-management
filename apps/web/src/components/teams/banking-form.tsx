'use client';

import { saveBankingAction } from '../../lib/teams/banking-actions.ts';
import {
  ACCOUNT_NAME_HINT,
  ACCOUNT_NUMBER_HINT_FIRST,
  ACCOUNT_NUMBER_HINT_SAVED,
  bankingErrorLines,
  validateBankingForm,
  viewHref,
} from '../../lib/teams/banking-view.ts';
import { ErrorSummary } from '../auth/error-summary.tsx';
import { FormBanner } from '../auth/form-banner.tsx';
import { LINK_CLASS } from '../auth/styles.ts';
import { SubmitButton } from '../auth/submit-button.tsx';
import { TextField } from '../auth/text-field.tsx';
import { useAuthForm } from '../auth/use-auth-form.ts';

const FIELD_ORDER = ['accountName', 'accountNumber', 'changeKey'] as const;

/**
 * Save banking details: the account name and the account number, nothing else (R1). The number is
 * write-only: a blank one keeps the saved number (`requireNumber` is false only when a readable one is
 * saved), and the typed number is re-echoed after an error because it is the value most often mistyped.
 * `changeKey` is a UUID v4 the page generated for this render (R8): a retry resends the same key, so a
 * replay never sends a second change email. No input has `maxlength`: a too-long value is explained.
 */
export function BankingForm({
  teamId,
  changeKey,
  savedAccountName,
  requireNumber,
  wasConfigured,
  returnTo,
  editing,
}: {
  teamId: string;
  changeKey: string;
  /** The saved name to prefill (empty when nothing readable is saved). */
  savedAccountName: string;
  /** No readable saved number to keep: the number is required. */
  requireNumber: boolean;
  /** Something readable was saved when the page rendered (picks the notice after a save). */
  wasConfigured: boolean;
  returnTo: string | undefined;
  /** Edit mode (`?edit=banking`): a Cancel link back to the summary. */
  editing: boolean;
}) {
  const form = useAuthForm(
    saveBankingAction,
    (values) => validateBankingForm(values, { requireNumber }),
    [],
  );
  const { fieldErrors, values } = form;
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
      <input type="hidden" name="wasConfigured" value={wasConfigured ? 'true' : 'false'} />
      {returnTo === undefined ? null : <input type="hidden" name="returnTo" value={returnTo} />}
      {editing ? <input type="hidden" name="edit" value="banking" /> : null}
      <TextField
        name="accountName"
        label="Account name"
        hint={ACCOUNT_NAME_HINT}
        autoComplete="off"
        autoCapitalize="words"
        defaultValue={values.accountName ?? savedAccountName}
        error={fieldErrors.accountName?.[0]}
      />
      <TextField
        name="accountNumber"
        label="Account number"
        hint={requireNumber ? ACCOUNT_NUMBER_HINT_FIRST : ACCOUNT_NUMBER_HINT_SAVED}
        autoComplete="off"
        inputMode="numeric"
        spellCheck={false}
        defaultValue={values.accountNumber}
        error={fieldErrors.accountNumber?.[0]}
      />
      <div className="flex flex-col gap-2">
        <SubmitButton label="Save banking details" pendingLabel="Saving…" />
        {editing ? (
          <a href={viewHref(teamId, 'banking', returnTo)} className={LINK_CLASS}>
            Cancel
          </a>
        ) : null}
      </div>
    </form>
  );
}
