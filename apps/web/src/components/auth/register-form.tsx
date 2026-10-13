'use client';

import { registerAction } from '../../lib/auth/actions.ts';
import { loginUrl } from '../../lib/auth/landing.ts';
import { validateRegister } from '../../lib/auth/validation.ts';
import { ErrorSummary } from './error-summary.tsx';
import { PasswordField } from './password-field.tsx';
import { SexField } from './sex-field.tsx';
import { StateBanner } from './state-banner.tsx';
import { LINK_CLASS } from './styles.ts';
import { SubmitButton } from './submit-button.tsx';
import { TextField } from './text-field.tsx';
import { useAuthForm } from './use-auth-form.ts';

const FIELD_ORDER = ['fullName', 'email', 'password', 'sex'] as const;

export function RegisterForm({ returnTo }: { returnTo?: string }) {
  const form = useAuthForm(registerAction, validateRegister);
  const { fieldErrors, values } = form;
  return (
    <form action={form.submit} noValidate className="flex flex-col gap-5">
      <ErrorSummary
        errors={fieldErrors}
        order={FIELD_ORDER}
        focusToken={form.clientFailure ?? form.state}
      />
      <StateBanner state={form.state} returnTo={returnTo} />
      {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
      <TextField
        name="fullName"
        label="Full name"
        hint="As your team will see it."
        autoComplete="name"
        autoCapitalize="words"
        defaultValue={values.fullName}
        error={fieldErrors.fullName?.[0]}
      />
      <TextField
        name="email"
        label="Email"
        type="email"
        hint="We'll send password reset links here."
        autoComplete="email"
        defaultValue={values.email}
        error={fieldErrors.email?.[0]}
      />
      <PasswordField
        label="Password"
        hint="At least 10 characters. Avoid common passwords."
        autoComplete="new-password"
        error={fieldErrors.password?.[0]}
      />
      <SexField defaultValue={values.sex} error={fieldErrors.sex?.[0]} />
      <SubmitButton label="Create account" pendingLabel="Creating account…" />
      <p className="text-base">
        Already have an account?{' '}
        <a href={loginUrl({ returnTo })} className={LINK_CLASS}>
          Sign in
        </a>
      </p>
    </form>
  );
}
