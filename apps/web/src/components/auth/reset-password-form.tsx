'use client';

import { resetPasswordAction } from '../../lib/auth/actions.ts';
import { validateResetPassword } from '../../lib/auth/validation.ts';
import { ErrorSummary } from './error-summary.tsx';
import { PasswordField } from './password-field.tsx';
import { StateBanner } from './state-banner.tsx';
import { SubmitButton } from './submit-button.tsx';
import { useAuthForm } from './use-auth-form.ts';

/**
 * Sets the new password. The token comes from a hidden field, not a re-read URL. A dead link hides the
 * form and shows the recovery links (E-RESET-1); a weak password leaves the token usable.
 */
export function ResetPasswordForm({ token }: { token: string }) {
  const form = useAuthForm(resetPasswordAction, validateResetPassword);
  if (form.state.error?.code === 'invalid_or_expired_token') {
    return <StateBanner state={form.state} />;
  }
  return (
    <form action={form.submit} noValidate className="flex flex-col gap-5">
      <ErrorSummary
        errors={form.fieldErrors}
        order={['password']}
        focusToken={form.clientFailure ?? form.state}
      />
      <StateBanner state={form.state} />
      <input type="hidden" name="token" value={token} />
      <PasswordField
        label="New password"
        hint="At least 10 characters. Avoid common passwords. Setting a new password signs you out on all your devices and disconnects any Google or Facebook sign-in."
        autoComplete="new-password"
        error={form.fieldErrors.password?.[0]}
      />
      <SubmitButton label="Set new password" pendingLabel="Saving…" />
    </form>
  );
}
