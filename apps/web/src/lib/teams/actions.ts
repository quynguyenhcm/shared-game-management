'use server';

import { CreateTeamRequest, JoinRequestRequest, safeReturnTo } from '@sgm/shared';
import { headers } from 'next/headers';
import { RedirectType, redirect } from 'next/navigation';
import { z } from 'zod';
import { apiClient, type ApiResult } from '../api-client.ts';
import { readCookie } from '../auth/cookies.ts';
import type { FormState } from '../auth/form-state.ts';
import { buildUrl, loginUrl, sessionExpiredUrl } from '../auth/landing.ts';
import { log } from '../log.ts';
import { validateCreateTeam, validateJoinRequest } from './validation.ts';

/**
 * Server Actions for the create and join forms. Navigation is always `redirect(..., replace)` so Back
 * never shows a stale form; every other outcome is an in-place `FormState` that keeps what was typed.
 */

const CREATE_RETURN_TO = '/teams/new';

function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === 'string' ? value : undefined;
}

function hasErrors(errors: Record<string, string[]>): boolean {
  return Object.keys(errors).length > 0;
}

/** The in-place state for a failed API call (a 401 never gets here: it is a redirect). */
function failed(
  action: string,
  result: Extract<ApiResult<unknown>, { ok: false }>,
  values: Record<string, string>,
): FormState {
  if (result.status === 0 || result.status >= 500) {
    log.warn('web.teams.api_failure', { action, status: result.status, code: result.error.code });
  }
  if (result.status === 422 && result.error.fieldErrors !== undefined) {
    return { fieldErrors: result.error.fieldErrors, values };
  }
  return { error: { code: result.error.code }, values };
}

/** The session token, or a redirect to sign in that returns to the page the form was on. */
async function requireSession(returnTo: string): Promise<string> {
  const token = await readCookie('session');
  return token ?? redirect(loginUrl({ returnTo }), RedirectType.replace);
}

export async function createTeamAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const raw = {
    name: field(formData, 'name'),
    description: field(formData, 'description'),
    visibility: field(formData, 'visibility'),
    skillLevel: field(formData, 'skillLevel'),
    idempotencyKey: field(formData, 'idempotencyKey'),
  };
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) if (value !== undefined) values[name] = value;

  const fieldErrors = validateCreateTeam(raw);
  if (hasErrors(fieldErrors)) return { fieldErrors, values };
  const token = await requireSession(CREATE_RETURN_TO);

  const result = await apiClient.createTeam(CreateTeamRequest.parse(raw), {
    session: token,
    incoming: await headers(),
  });
  if (!result.ok) {
    if (result.status === 401) {
      return redirect(sessionExpiredUrl(CREATE_RETURN_TO), RedirectType.replace);
    }
    return failed('create_team', result, values);
  }
  // 201 for a new team, 200 for a replay of the same idempotency key: both land on the same team.
  return redirect(
    buildUrl(`/teams/${result.data.team.id}/manage`, { notice: 'team_created' }),
    RedirectType.replace,
  );
}

export async function joinTeamAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const teamId = field(formData, 'teamId') ?? '';
  const skillLevel = field(formData, 'skillLevel');
  const inviteCode = field(formData, 'inviteCode');
  const returnTo = safeReturnTo(field(formData, 'returnTo'));
  const values: Record<string, string> = skillLevel === undefined ? {} : { skillLevel };

  // A non-UUID id is not a team: never put it in an API path.
  if (!z.uuid().safeParse(teamId).success) return { error: { code: 'not_found' }, values };
  const fieldErrors = validateJoinRequest({ skillLevel });
  if (hasErrors(fieldErrors)) return { fieldErrors, values };
  const token = await requireSession(returnTo);

  const body = JoinRequestRequest.parse({
    skillLevel,
    ...(inviteCode === undefined || inviteCode === '' ? {} : { inviteCode }),
  });
  const result = await apiClient.joinRequest(teamId, body, {
    session: token,
    incoming: await headers(),
  });
  if (!result.ok) {
    if (result.status === 401) return redirect(sessionExpiredUrl(returnTo), RedirectType.replace);
    return failed('join_team', result, values);
  }
  // The team page replaces the invite URL, so the code leaves the address bar and this history entry (A1).
  return redirect(buildUrl(`/teams/${teamId}`, { notice: 'join_requested' }), RedirectType.replace);
}
