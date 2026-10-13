import type { ApiResult } from '../api-client.ts';
import {
  LAST_ADMIN_MESSAGE,
  NO_ACCESS_HEADING,
  OUTAGE_MESSAGE,
  REGENERATE_SUCCESS,
  STALE_MESSAGE,
  adminBanBlockedHint,
} from './labels.ts';
import type { SectionId } from './manage-view.ts';

/**
 * What a manage-area Server Action reports to the page: the mapping from an API answer to the copy the
 * admin reads (AC-ERROR-6/7/9/11). Pure, so every outcome is unit-tested once. `refresh` says whether the
 * action revalidated the manage page; a 5xx never does (no optimistic or partial change, AC-ERROR-11).
 */

export type ModerationKind = 'approve' | 'reject' | 'promote' | 'demote' | 'ban' | 'regenerate';

export interface ModerationResult {
  ok: boolean;
  message: string;
  code?: string;
  refresh: boolean;
  fieldErrors?: Record<string, string[]>;
}

export type ModerationAction = (
  previous: ModerationResult | null,
  formData: FormData,
) => Promise<ModerationResult>;

/** The section whose status region reports the action. */
export function sectionFor(kind: ModerationKind): SectionId {
  switch (kind) {
    case 'approve':
    case 'reject':
      return 'requests';
    case 'promote':
    case 'demote':
    case 'ban':
      return 'members';
    case 'regenerate':
      return 'invite';
  }
}

export function successMessage(kind: ModerationKind, fullName = 'This person'): string {
  switch (kind) {
    case 'approve':
      return `${fullName} has been approved.`;
    case 'reject':
      return `${fullName}'s request was declined.`;
    case 'promote':
      return `${fullName} is now a team admin.`;
    case 'demote':
      return `${fullName} is no longer a team admin.`;
    case 'ban':
      return `${fullName} has been banned.`;
    case 'regenerate':
      return REGENERATE_SUCCESS;
  }
}

/** The outcome shown for an API answer. `fullName` is the name from the API (success) or the form (refusals). */
export function toModerationResult(
  kind: ModerationKind,
  result: ApiResult<unknown>,
  context: { fullName?: string },
): ModerationResult {
  if (result.ok) {
    return { ok: true, message: successMessage(kind, context.fullName), refresh: true };
  }
  const { status } = result;
  const code = result.error.code;
  if (status === 0 || status >= 500) {
    return { ok: false, code: 'service_unavailable', message: OUTAGE_MESSAGE, refresh: false };
  }
  if (code === 'membership_state_conflict' || status === 404) {
    return { ok: false, code: 'membership_state_conflict', message: STALE_MESSAGE, refresh: true };
  }
  if (code === 'last_team_admin') {
    return { ok: false, code, message: LAST_ADMIN_MESSAGE, refresh: false };
  }
  if (code === 'team_admin_cannot_be_banned') {
    return {
      ok: false,
      code,
      message: adminBanBlockedHint(context.fullName ?? 'this person'),
      refresh: true,
    };
  }
  if (status === 403) {
    return { ok: false, code: 'forbidden', message: NO_ACCESS_HEADING, refresh: true };
  }
  if (status === 422 && result.error.fieldErrors !== undefined) {
    const first = Object.values(result.error.fieldErrors)[0]?.[0] ?? OUTAGE_MESSAGE;
    return {
      ok: false,
      code: 'validation_failed',
      message: first,
      refresh: false,
      fieldErrors: result.error.fieldErrors,
    };
  }
  return { ok: false, code: 'service_unavailable', message: OUTAGE_MESSAGE, refresh: false };
}
