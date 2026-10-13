'use client';

import type { FormState } from '../../lib/auth/form-state.ts';
import { teamErrorLines } from '../../lib/teams/labels.ts';
import { FormBanner } from '../auth/form-banner.tsx';

/** The banner for a team Server Action's page-level error, worded from the team copy deck. */
export function TeamFormBanner({ state }: { state: FormState }) {
  if (state.error === undefined) return null;
  const lines = teamErrorLines(state.error.code);
  return lines === null ? null : <FormBanner kind="error" lines={lines} focusToken={state} />;
}
