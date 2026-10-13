'use client';

import { useEffect, useState } from 'react';
import { forgotPasswordAction } from '../../lib/auth/actions.ts';
import { loginUrl } from '../../lib/auth/landing.ts';
import { validateForgotPassword } from '../../lib/auth/validation.ts';
import { AuthCard } from './auth-card.tsx';
import { ErrorSummary } from './error-summary.tsx';
import { StateBanner } from './state-banner.tsx';
import { LINK_CLASS, SECONDARY_BUTTON_CLASS } from './styles.ts';
import { SubmitButton } from './submit-button.tsx';
import { TextField } from './text-field.tsx';
import { useAuthForm } from './use-auth-form.ts';

const TITLE_SUFFIX = ' – Shared Game Management';

/** Request a reset link. Two states on one URL: the form and "Check your email" (identical for any address). */
export function ForgotPasswordForm({
  returnTo,
  defaultEmail,
}: {
  returnTo?: string;
  defaultEmail?: string;
}) {
  const form = useAuthForm(forgotPasswordAction, validateForgotPassword);
  const [editing, setEditing] = useState(false);
  const sent = form.state.sent;
  const showSent = sent !== undefined && !editing;

  useEffect(() => {
    if (!showSent) return;
    const original = document.title;
    document.title = `Check your email${TITLE_SUFFIX}`;
    return () => {
      document.title = original;
    };
  }, [showSent]);

  const submit = (formData: FormData): void => {
    setEditing(false);
    form.submit(formData);
  };

  if (showSent) {
    return (
      <AuthCard title="Check your email">
        <StateBanner state={form.state} returnTo={returnTo} />
        <p className="text-base">
          If an account exists for that email, we&apos;ve sent a reset link.
        </p>
        <p className="text-base">
          We sent it to {sent.email}. The link works once and expires in 60 minutes.
        </p>
        <p className="text-base">
          Didn&apos;t get it after a few minutes? Check your spam folder, then send another link.
        </p>
        <form action={submit} className="flex flex-col gap-3">
          <input type="hidden" name="email" value={sent.email} />
          <SubmitButton label="Send another link" pendingLabel="Sending…" />
        </form>
        <button
          type="button"
          onClick={() => {
            setEditing(true);
          }}
          className={`${LINK_CLASS} justify-start`}
        >
          Use a different email
        </button>
        <a href={loginUrl({ returnTo })} className={LINK_CLASS}>
          Back to sign in
        </a>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Reset your password">
      <p className="text-base">
        Enter the email you signed up with and we&apos;ll send you a link to set a new password.
      </p>
      <form action={submit} noValidate className="flex flex-col gap-5">
        <ErrorSummary
          errors={form.fieldErrors}
          order={['email']}
          focusToken={form.clientFailure ?? form.state}
        />
        <StateBanner state={form.state} returnTo={returnTo} />
        <TextField
          name="email"
          label="Email"
          type="email"
          autoComplete="email"
          defaultValue={form.values.email ?? defaultEmail}
          error={form.fieldErrors.email?.[0]}
        />
        <SubmitButton label="Send reset link" pendingLabel="Sending…" />
      </form>
      <a href={loginUrl({ returnTo })} className={`${SECONDARY_BUTTON_CLASS} no-underline`}>
        Back to sign in
      </a>
    </AuthCard>
  );
}
