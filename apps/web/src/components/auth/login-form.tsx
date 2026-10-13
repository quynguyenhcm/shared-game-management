'use client';

import { loginAction } from '../../lib/auth/actions.ts';
import { forgotPasswordUrl, registerUrl } from '../../lib/auth/landing.ts';
import type { EnabledProviders } from '../../lib/auth/messages.ts';
import { validateLogin } from '../../lib/auth/validation.ts';
import { ErrorSummary } from './error-summary.tsx';
import { PasswordField } from './password-field.tsx';
import { StateBanner } from './state-banner.tsx';
import { LINK_CLASS } from './styles.ts';
import { SubmitButton } from './submit-button.tsx';
import { TextField } from './text-field.tsx';
import { useAuthForm } from './use-auth-form.ts';

const FIELD_ORDER = ['email', 'password'] as const;

export function LoginForm({
  returnTo,
  providers,
}: {
  returnTo?: string;
  providers: EnabledProviders;
}) {
  const form = useAuthForm(loginAction, validateLogin);
  const { fieldErrors, values } = form;
  return (
    <form action={form.submit} noValidate className="flex flex-col gap-5">
      <ErrorSummary
        errors={fieldErrors}
        order={FIELD_ORDER}
        focusToken={form.clientFailure ?? form.state}
      />
      <StateBanner state={form.state} returnTo={returnTo} providers={providers} />
      {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
      <TextField
        name="email"
        label="Email"
        type="email"
        autoComplete="username"
        defaultValue={values.email}
        error={fieldErrors.email?.[0]}
      />
      <div className="flex flex-col">
        <PasswordField
          label="Password"
          autoComplete="current-password"
          error={fieldErrors.password?.[0]}
        />
        <a href={forgotPasswordUrl({ returnTo })} className={LINK_CLASS}>
          Forgot your password?
        </a>
      </div>
      <SubmitButton label="Sign in" pendingLabel="Signing in…" />
      <p className="text-base">
        Don&apos;t have an account?{' '}
        <a href={registerUrl({ returnTo })} className={LINK_CLASS}>
          Create one
        </a>
      </p>
    </form>
  );
}
