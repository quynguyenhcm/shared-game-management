'use client';

import { AuthCard } from '../../../components/auth/auth-card.tsx';
import { FormBanner } from '../../../components/auth/form-banner.tsx';
import { SECONDARY_BUTTON_CLASS } from '../../../components/auth/styles.ts';
import { PAGE_ERROR_MESSAGE } from '../../../lib/auth/messages.ts';

/**
 * Outage view (E-PAGE-1) for /register/complete: the API could not load the pending sign-up. The
 * `sgm_pending` cookie is left alone, so "Try again" can pick up where the user was.
 */
export default function CompleteSignupError({ reset }: { error: Error; reset: () => void }) {
  return (
    <AuthCard title="We can't load this page right now">
      <title>Something went wrong – Shared Game Management</title>
      <FormBanner kind="error" lines={[PAGE_ERROR_MESSAGE]} />
      <button type="button" onClick={reset} className={SECONDARY_BUTTON_CLASS}>
        Try again
      </button>
    </AuthCard>
  );
}
