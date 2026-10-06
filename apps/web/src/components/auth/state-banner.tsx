'use client';

import { errorLinks } from '../../lib/auth/landing.ts';
import type { FormState } from '../../lib/auth/form-state.ts';
import { errorMessage, type EnabledProviders } from '../../lib/auth/messages.ts';
import { FormBanner } from './form-banner.tsx';

/** The banner for a Server Action's page-level error, worded from the copy deck. */
export function StateBanner({
  state,
  returnTo,
  providers,
}: {
  state: FormState;
  returnTo?: string | undefined;
  providers?: EnabledProviders | undefined;
}) {
  if (state.error === undefined) return null;
  const { code, retryAfterSeconds } = state.error;
  const lines = errorMessage(code, { retryAfterSeconds, providers });
  if (lines === null) return null;
  return (
    <FormBanner kind="error" lines={lines} links={errorLinks(code, returnTo)} focusToken={state} />
  );
}
