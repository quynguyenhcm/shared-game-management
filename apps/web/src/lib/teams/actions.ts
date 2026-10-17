'use server';

import {
  BanMemberRequest,
  CreateTeamRequest,
  JoinRequestRequest,
  type MemberSkillChangeResponse,
  SetAutoEnrollRequest,
  SetSkillLevelRequest,
  TEAM_FIELD_MESSAGES,
  safeReturnTo,
} from '@sgm/shared';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { RedirectType, redirect } from 'next/navigation';
import { z } from 'zod';
import { apiClient, type ApiCallOptions, type ApiResult } from '../api-client.ts';
import { readCookie } from '../auth/cookies.ts';
import type { FormState } from '../auth/form-state.ts';
import { buildUrl, loginUrl, sessionExpiredUrl } from '../auth/landing.ts';
import { log } from '../log.ts';
import { STALE_MESSAGE } from './labels.ts';
import { toModerationResult, type ModerationKind, type ModerationResult } from './moderation.ts';
import { toSkillResult, type SkillPanelResult, type SkillResultKind } from './skill-levels-view.ts';
import { validateCreateTeam, validateJoinRequest } from './validation.ts';

/**
 * Server Actions for the create and join forms, and for the team-admin (manage) area. Navigation is
 * always `redirect(..., replace)` so Back never shows a stale form; every other outcome is an in-place
 * result that keeps what was typed. The manage actions are never optimistic: they report what the API
 * answered and revalidate the manage page only when the list may have changed.
 */

const CREATE_RETURN_TO = '/teams/new';

function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === 'string' ? value : undefined;
}

/** A hidden "what the panel was showing" field: empty (or missing) means the API returned `null`. */
function emptyAsNull(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
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

// ---------------------------------------------------------------------------------------------
// Team-admin (manage) area
// ---------------------------------------------------------------------------------------------

const staleList = (): ModerationResult => ({
  ok: false,
  code: 'membership_state_conflict',
  message: STALE_MESSAGE,
  refresh: false,
});

function managePath(teamId: string): string {
  return `/teams/${teamId}/manage`;
}

interface MemberTarget {
  teamId: string;
  userId: string;
  fullName: string | undefined;
}

/** The ids of a row action; non-UUIDs never reach an API path (they are the stale-list answer). */
function memberTarget(formData: FormData): MemberTarget | null {
  const teamId = field(formData, 'teamId') ?? '';
  const userId = field(formData, 'userId') ?? '';
  if (!z.uuid().safeParse(teamId).success || !z.uuid().safeParse(userId).success) return null;
  return { teamId, userId, fullName: field(formData, 'fullName') };
}

function settle(teamId: string, outcome: ModerationResult): ModerationResult {
  if (outcome.refresh) revalidatePath(managePath(teamId));
  return outcome;
}

async function moderateMember(
  kind: Exclude<ModerationKind, 'ban' | 'regenerate'>,
  formData: FormData,
): Promise<ModerationResult> {
  const target = memberTarget(formData);
  if (target === null) return staleList();
  const returnTo = managePath(target.teamId);
  const token = await requireSession(returnTo);
  const result = await apiClient.moderateMember(target.teamId, target.userId, kind, {
    session: token,
    incoming: await headers(),
  });
  if (!result.ok && result.status === 401) {
    return redirect(sessionExpiredUrl(returnTo), RedirectType.replace);
  }
  if (!result.ok && (result.status === 0 || result.status >= 500)) {
    log.warn('web.teams.api_failure', {
      action: kind,
      status: result.status,
      code: result.error.code,
    });
  }
  const fullName = result.ok ? result.data.member.fullName : target.fullName;
  return settle(target.teamId, toModerationResult(kind, result, fullName ? { fullName } : {}));
}

export async function approveMemberAction(
  _previous: ModerationResult | null,
  formData: FormData,
): Promise<ModerationResult> {
  return moderateMember('approve', formData);
}

export async function rejectMemberAction(
  _previous: ModerationResult | null,
  formData: FormData,
): Promise<ModerationResult> {
  return moderateMember('reject', formData);
}

export async function promoteMemberAction(
  _previous: ModerationResult | null,
  formData: FormData,
): Promise<ModerationResult> {
  return moderateMember('promote', formData);
}

export async function demoteMemberAction(
  _previous: ModerationResult | null,
  formData: FormData,
): Promise<ModerationResult> {
  return moderateMember('demote', formData);
}

/**
 * The caller removes their own admin rights. They are still a member, so on success they land on the team
 * page with the notice; as the sole admin the API refuses (409 `last_team_admin`) and the page stays.
 */
export async function demoteSelfAction(
  _previous: ModerationResult | null,
  formData: FormData,
): Promise<ModerationResult> {
  const outcome = await moderateMember('demote', formData);
  const teamId = field(formData, 'teamId') ?? '';
  if (!outcome.ok) return outcome;
  return redirect(buildUrl(`/teams/${teamId}`, { notice: 'self_demoted' }), RedirectType.replace);
}

export async function banMemberAction(
  _previous: ModerationResult | null,
  formData: FormData,
): Promise<ModerationResult> {
  const target = memberTarget(formData);
  if (target === null) return staleList();
  const typed = field(formData, 'reason')?.trim();
  const body = BanMemberRequest.safeParse(
    typed === undefined || typed === '' ? {} : { reason: typed },
  );
  if (!body.success) {
    const message = TEAM_FIELD_MESSAGES.reasonTooLong;
    return {
      ok: false,
      code: 'validation_failed',
      message,
      refresh: false,
      fieldErrors: { reason: [message] },
    };
  }
  const returnTo = managePath(target.teamId);
  const token = await requireSession(returnTo);
  const result = await apiClient.banMember(target.teamId, target.userId, body.data, {
    session: token,
    incoming: await headers(),
  });
  if (!result.ok && result.status === 401) {
    return redirect(sessionExpiredUrl(returnTo), RedirectType.replace);
  }
  if (!result.ok && (result.status === 0 || result.status >= 500)) {
    log.warn('web.teams.api_failure', {
      action: 'ban',
      status: result.status,
      code: result.error.code,
    });
  }
  const fullName = result.ok ? result.data.member.fullName : target.fullName;
  return settle(target.teamId, toModerationResult('ban', result, fullName ? { fullName } : {}));
}

/** The new code is never returned to the browser by the action: the revalidated page renders the new URL. */
export async function regenerateInviteAction(
  _previous: ModerationResult | null,
  formData: FormData,
): Promise<ModerationResult> {
  const teamId = field(formData, 'teamId') ?? '';
  if (!z.uuid().safeParse(teamId).success) return staleList();
  const returnTo = managePath(teamId);
  const token = await requireSession(returnTo);
  const result = await apiClient.regenerateInviteCode(teamId, {
    session: token,
    incoming: await headers(),
  });
  if (!result.ok && result.status === 401) {
    return redirect(sessionExpiredUrl(returnTo), RedirectType.replace);
  }
  if (!result.ok && (result.status === 0 || result.status >= 500)) {
    log.warn('web.teams.api_failure', {
      action: 'regenerate',
      status: result.status,
      code: result.error.code,
    });
  }
  return settle(teamId, toModerationResult('regenerate', result, {}));
}

// ---------------------------------------------------------------------------------------------
// "Skill and Auto Enroll" panel (skill-levels-and-auto-enroll)
// ---------------------------------------------------------------------------------------------

/** A save the form could not build into a valid body: a field error with no request (the API re-validates). */
function invalidPanelInput(kind: SkillResultKind, error: z.ZodError): SkillPanelResult {
  const fieldErrors = z.flattenError(error).fieldErrors as Record<string, string[]>;
  const message = Object.values(fieldErrors)[0]?.[0] ?? STALE_MESSAGE;
  return { ok: false, kind, code: 'validation_failed', message, refresh: false, fieldErrors };
}

/** The target is not a valid member id: the same answer as a member who has left the list. */
function goneMember(kind: SkillResultKind, fullName: string | undefined): SkillPanelResult {
  return {
    ok: false,
    kind,
    code: 'membership_state_conflict',
    message: `${fullName === undefined || fullName === '' ? 'This person' : fullName} is no longer an approved member. The list has been refreshed.`,
    refresh: false,
    close: true,
  };
}

async function savePanel(
  kind: SkillResultKind,
  target: MemberTarget,
  call: (options: ApiCallOptions) => Promise<ApiResult<MemberSkillChangeResponse>>,
): Promise<SkillPanelResult> {
  const returnTo = managePath(target.teamId);
  const token = await requireSession(returnTo);
  const result = await call({ session: token, incoming: await headers() });
  if (!result.ok && result.status === 401) {
    return redirect(sessionExpiredUrl(returnTo), RedirectType.replace);
  }
  if (!result.ok && (result.status === 0 || result.status >= 500)) {
    log.warn('web.teams.api_failure', {
      action: kind === 'skill' ? 'skill_level' : 'auto_enroll',
      status: result.status,
      code: result.error.code,
    });
  }
  const outcome = toSkillResult(kind, result, { fullName: target.fullName ?? 'This person' });
  if (outcome.refresh) revalidatePath(managePath(target.teamId));
  return outcome;
}

/**
 * Admin override of one member's level. The form sends the level the panel was showing
 * (`expectedSkillLevel`, `expectedChangedAt`; empty means "never changed"), so the API can refuse a save
 * based on a stale view (409 `skill_level_stale`). Never optimistic; revalidates only when the list changed.
 */
export async function setSkillLevelAction(
  _previous: SkillPanelResult | null,
  formData: FormData,
): Promise<SkillPanelResult> {
  const target = memberTarget(formData);
  if (target === null) return goneMember('skill', field(formData, 'fullName'));
  const body = SetSkillLevelRequest.safeParse({
    skillLevel: field(formData, 'skillLevel'),
    expectedSkillLevel: field(formData, 'expectedSkillLevel'),
    expectedChangedAt: emptyAsNull(field(formData, 'expectedChangedAt')),
  });
  if (!body.success) return invalidPanelInput('skill', body.error);
  return savePanel('skill', target, (options) =>
    apiClient.setSkillLevel(target.teamId, target.userId, body.data, options),
  );
}

/**
 * Auto Enroll on (with an optional end date) or off. A date is never sent with the flag off. The form also sends
 * the stored state the panel was showing (`expectedEnabled`, `expectedUntil`, `expectedAssignedAt`; empty means
 * none), so the API refuses a save based on a stale view (409 `auto_enroll_stale`).
 */
export async function setAutoEnrollAction(
  _previous: SkillPanelResult | null,
  formData: FormData,
): Promise<SkillPanelResult> {
  const target = memberTarget(formData);
  if (target === null) return goneMember('autoEnroll', field(formData, 'fullName'));
  const enabled = field(formData, 'enabled') === 'true';
  const typed = field(formData, 'until');
  const shownEnabled = field(formData, 'expectedEnabled');
  const body = SetAutoEnrollRequest.safeParse({
    enabled,
    until: enabled && typed !== undefined && typed !== '' ? typed : null,
    // Anything but the two literals stays a non-boolean, so the schema refuses it rather than guessing.
    expectedEnabled:
      shownEnabled === 'true' ? true : shownEnabled === 'false' ? false : shownEnabled,
    expectedUntil: emptyAsNull(field(formData, 'expectedUntil')),
    expectedAssignedAt: emptyAsNull(field(formData, 'expectedAssignedAt')),
  });
  if (!body.success) return invalidPanelInput('autoEnroll', body.error);
  return savePanel('autoEnroll', target, (options) =>
    apiClient.setAutoEnroll(target.teamId, target.userId, body.data, options),
  );
}
