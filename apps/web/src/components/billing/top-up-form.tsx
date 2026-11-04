'use client';

import { startTopUpAction } from '../../lib/billing/actions.ts';
import { billingErrorLines, topUpHint, topUpTrustLines } from '../../lib/billing/labels.ts';
import { validateTopUp } from '../../lib/billing/wallet-view.ts';
import { ErrorSummary } from '../auth/error-summary.tsx';
import { FormBanner } from '../auth/form-banner.tsx';
import { SubmitButton } from '../auth/submit-button.tsx';
import { TextField } from '../auth/text-field.tsx';
import { useAuthForm } from '../auth/use-auth-form.ts';
import { AkahuStartForm } from './akahu-start-form.tsx';
import { useIdempotencyKey } from './use-keys.ts';

const FIELD_ORDER = ['amount'] as const;

/**
 * Top up the wallet: one labelled amount field, validated in the browser with the shared money functions and the headroom the
 * page loaded (the API re-checks against the balance it reads). What was typed is kept after an error; a failure issues a new
 * idempotency key for the retry. Success is a `redirect()` to Akahu from the Server Action.
 */
export function TopUpForm({
  teamId,
  teamName,
  headroom,
  idempotencyKey,
}: {
  teamId: string;
  teamName: string;
  /** The wallet read model's `headroom` (2-dp string): the most that can still be added. */
  headroom: string;
  idempotencyKey: string;
}) {
  const form = useAuthForm(startTopUpAction, (values) => validateTopUp(values, headroom), []);
  const { state, fieldErrors, values } = form;
  const key = useIdempotencyKey(
    idempotencyKey,
    state,
    state.error !== undefined || state.fieldErrors !== undefined,
  );
  return (
    <form action={form.submit} noValidate className="flex max-w-xl flex-col gap-4">
      <ErrorSummary
        errors={fieldErrors}
        order={FIELD_ORDER}
        focusToken={form.clientFailure ?? state}
      />
      {state.error === undefined ? null : (
        <FormBanner
          kind="error"
          lines={billingErrorLines(state.error.code, {
            retryAfterSeconds: state.error.retryAfterSeconds,
          })}
          focusToken={state}
        />
      )}
      <input type="hidden" name="teamId" value={teamId} />
      <input type="hidden" name="idempotencyKey" value={key} />
      <TextField
        name="amount"
        label="Top-up amount (NZD)"
        hint={topUpHint(headroom)}
        autoComplete="off"
        inputMode="decimal"
        enterKeyHint="go"
        spellCheck={false}
        defaultValue={values.amount}
        error={fieldErrors.amount?.[0]}
      />
      <SubmitButton label="Top up with Akahu" pendingLabel="Taking you to Akahu…" />
      <div className="flex flex-col gap-1">
        {topUpTrustLines(teamName).map((line) => (
          <p key={line} className="text-sm text-slate-700">
            {line}
          </p>
        ))}
      </div>
    </form>
  );
}

/**
 * "Continue with Akahu" for a top-up that is open but whose player left Akahu: posts the open top-up's own amount with a fresh
 * key, and the API answers 409 with the resume link, which the Server Action follows.
 */
export function ContinueTopUp({
  teamId,
  amount,
  idempotencyKey,
}: {
  teamId: string;
  /** The open top-up's amount (2-dp string). */
  amount: string;
  idempotencyKey: string;
}) {
  return (
    <AkahuStartForm
      action={startTopUpAction}
      fields={{ teamId, amount }}
      idempotencyKey={idempotencyKey}
      label="Continue with Akahu"
      trustLines={[]}
    />
  );
}
