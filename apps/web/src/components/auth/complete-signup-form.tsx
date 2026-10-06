'use client';

import { chooseDifferentAccountAction, completeSignupAction } from '../../lib/auth/actions.ts';
import { parseProvider } from '../../lib/auth/messages.ts';
import { validateCompleteSignup } from '../../lib/auth/validation.ts';
import { ErrorSummary } from './error-summary.tsx';
import { SexField } from './sex-field.tsx';
import { StateBanner } from './state-banner.tsx';
import { SECONDARY_BUTTON_CLASS } from './styles.ts';
import { SubmitButton } from './submit-button.tsx';
import { TextField } from './text-field.tsx';
import { useAuthForm } from './use-auth-form.ts';

const FIELD_ORDER = ['fullName', 'sex'] as const;

/**
 * The second step of a first-time OAuth sign-up: confirm the name the provider gave, and choose a sex
 * (required, none preselected). The account is created only when this form is submitted. "Use a
 * different account" is a second action on the same form, so it never runs the client validation.
 */
export function CompleteSignupForm({
  provider,
  email,
  fullName,
  returnTo,
}: {
  provider: 'google' | 'facebook';
  email: string;
  fullName: string | null;
  returnTo: string;
}) {
  const form = useAuthForm(completeSignupAction, validateCompleteSignup);
  const { fieldErrors, values } = form;
  return (
    <form action={form.submit} noValidate className="flex flex-col gap-5">
      <ErrorSummary
        errors={fieldErrors}
        order={FIELD_ORDER}
        focusToken={form.clientFailure ?? form.state}
      />
      <StateBanner state={form.state} returnTo={returnTo} />
      <p className="text-base">
        You&apos;re signing up with {parseProvider(provider) ?? provider} as {email}.
      </p>
      <input type="hidden" name="returnTo" value={returnTo} />
      <input type="hidden" name="provider" value={provider} />
      <TextField
        name="fullName"
        label="Full name"
        hint="As your team will see it."
        autoComplete="name"
        autoCapitalize="words"
        defaultValue={values.fullName ?? fullName ?? ''}
        error={fieldErrors.fullName?.[0]}
      />
      <SexField defaultValue={values.sex} error={fieldErrors.sex?.[0]} />
      <SubmitButton label="Finish sign-up" pendingLabel="Finishing…" />
      <button
        type="submit"
        formAction={chooseDifferentAccountAction}
        formNoValidate
        className={SECONDARY_BUTTON_CLASS}
      >
        Use a different account
      </button>
    </form>
  );
}
