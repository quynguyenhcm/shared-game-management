'use client';

import { AuthCard } from '../../components/auth/auth-card.tsx';
import { FormBanner } from '../../components/auth/form-banner.tsx';
import { SECONDARY_BUTTON_CLASS } from '../../components/auth/styles.ts';
import { PAGE_ERROR_MESSAGE } from '../../lib/auth/messages.ts';

/**
 * Protected-page outage view (E-PAGE-1): shown when the API cannot answer. It never redirects to
 * /login or clears the cookie, so a brief outage does not sign anyone out. Later protected routes copy it.
 */
export default function AccountError({ reset }: { error: Error; reset: () => void }) {
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
