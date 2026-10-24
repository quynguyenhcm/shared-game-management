'use client';

import { FormBanner } from '../../../../../components/auth/form-banner.tsx';
import { SECONDARY_BUTTON_CLASS } from '../../../../../components/auth/styles.ts';
import { TeamShell } from '../../../../../components/teams/team-shell.tsx';
import { LOAD_ERROR_MESSAGE } from '../../../../../lib/registrations/labels.ts';

/**
 * The API could not answer for the session page: one outage state for the whole panel (a single small read feeds it).
 * It never redirects to sign-in or clears the cookie, so a brief outage does not sign anyone out; "Try again" reloads.
 */
export default function SessionPageError({ reset }: { error: Error; reset: () => void }) {
  return (
    <TeamShell>
      <title>Something went wrong – Shared Game Management</title>
      <h1 className="text-2xl font-semibold">Registration</h1>
      <FormBanner kind="error" lines={[LOAD_ERROR_MESSAGE]} />
      <button type="button" onClick={reset} className={`${SECONDARY_BUTTON_CLASS} sm:w-auto`}>
        Try again
      </button>
    </TeamShell>
  );
}
