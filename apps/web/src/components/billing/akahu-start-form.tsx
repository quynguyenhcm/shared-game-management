'use client';

import { useActionState, useMemo } from 'react';
import { withOfflineFallback, type FormAction } from '../../lib/auth/form-state.ts';
import { billingErrorLines } from '../../lib/billing/labels.ts';
import { FormBanner } from '../auth/form-banner.tsx';
import { SubmitButton } from '../auth/submit-button.tsx';
import { useIdempotencyKey } from './use-keys.ts';

/**
 * A one-button form that starts something at Akahu and leaves the site on success: the payment page's pay, retry and continue
 * buttons and the wallet's "Continue with Akahu". It is a plain `<form action>` (works before hydration); the Server Action
 * does the `redirect()`, so this island only ever sees a failure. The idempotency key is the page's, reused by a double submit
 * and replaced after a failure. While it runs the button stays focusable (`aria-disabled`) and ignores clicks.
 */
export function AkahuStartForm({
  action,
  fields,
  label,
  pendingLabel = 'Taking you to Akahu…',
  trustLines,
  idempotencyKey,
}: {
  action: FormAction;
  /** Hidden inputs besides the key (`paymentId`, or `teamId` and `amount`). */
  fields: Record<string, string>;
  label: string;
  pendingLabel?: string;
  trustLines: readonly string[];
  idempotencyKey: string;
}) {
  const guarded = useMemo(() => withOfflineFallback(action), [action]);
  const [state, dispatch] = useActionState(guarded, {});
  const key = useIdempotencyKey(idempotencyKey, state, state.error !== undefined);
  return (
    <form action={dispatch} className="flex max-w-xl flex-col gap-3">
      {state.error === undefined ? null : (
        <FormBanner
          kind="error"
          lines={billingErrorLines(state.error.code, {
            retryAfterSeconds: state.error.retryAfterSeconds,
          })}
          focusToken={state}
        />
      )}
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <input type="hidden" name="idempotencyKey" value={key} />
      <SubmitButton label={label} pendingLabel={pendingLabel} />
      {trustLines.map((line) => (
        <p key={line} className="text-sm text-slate-700">
          {line}
        </p>
      ))}
    </form>
  );
}
