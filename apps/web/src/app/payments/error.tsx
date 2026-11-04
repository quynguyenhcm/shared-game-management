'use client';

import { FormBanner } from '../../components/auth/form-banner.tsx';
import { SECONDARY_BUTTON_CLASS } from '../../components/auth/styles.ts';
import { TeamShell } from '../../components/teams/team-shell.tsx';
import { PAGE_ERROR_MESSAGE } from '../../lib/auth/messages.ts';

/**
 * The API could not answer for a payments page. It never redirects to sign-in or clears the cookie, so a brief outage does not
 * sign anyone out; "Try again" reloads the same URL (a `?return=1` from Akahu is kept).
 */
export default function PaymentsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <TeamShell>
      <title>Something went wrong – Shared Game Management</title>
      <h1 className="text-2xl font-semibold">We can&apos;t load this page right now</h1>
      <FormBanner kind="error" lines={[PAGE_ERROR_MESSAGE]} />
      <button type="button" onClick={reset} className={`${SECONDARY_BUTTON_CLASS} sm:w-auto`}>
        Try again
      </button>
    </TeamShell>
  );
}
