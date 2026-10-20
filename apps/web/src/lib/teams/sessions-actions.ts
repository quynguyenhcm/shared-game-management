'use server';

import { SESSION_FIELD_MESSAGES, type SessionResponse } from '@sgm/shared';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { RedirectType, redirect } from 'next/navigation';
import { z } from 'zod';
import { apiClient, type ApiCallOptions, type ApiResult } from '../api-client.ts';
import { readCookie } from '../auth/cookies.ts';
import { loginUrl, sessionExpiredUrl } from '../auth/landing.ts';
import { log } from '../log.ts';
import { NO_ACCESS_HEADING, SAVE_FAILED_MESSAGE, UNCONFIRMED_MESSAGE } from './labels.ts';
import type { ModerationResult } from './moderation.ts';
import {
  newSeriesPath,
  newSessionPath,
  seriesPath,
  sessionPath,
  sessionsPath,
} from './sessions-paths.ts';
import {
  fieldErrorsFromRaised,
  formField,
  parseCreateSeries,
  parseCreateSession,
  parseUpdateSeries,
  parseUpdateSession,
  readIntent,
} from './sessions-request.ts';
import type { SessionActionState } from './session-form-state.ts';
import {
  noticeBanner,
  noticeQuery,
  parseYmd,
  type NoticeCode,
  type NoticeCountKey,
} from './sessions-view.ts';

/**
 * Server Actions of the Sessions pages: create, save draft, "Save and publish" (the A4 outcome table, including
 * create-and-publish on /new), save changes, cancel, series create and save, End series and "Publish drafts
 * now". Success and known-state outcomes `redirect(..., replace)` with a codes-only `?notice=` (Back never shows
 * a stale form); validation and banking refusals come back in place with what was typed kept by the controlled
 * form. Never optimistic: a 5xx says nothing was changed, an unreachable API says the save may have happened.
 * The API stays the authority: this module maps what it answered and decides nothing about sessions.
 *
 * Privacy: no field value, create key or token is ever logged; failures log the action, status and code only.
 */

// These helpers stay private on purpose: a `'use server'` module may export only Server Actions, and
// exporting one would make it callable from the browser.

type Failure = Extract<ApiResult<unknown>, { ok: false }>;

const isUuid = (value: string): boolean => z.uuid().safeParse(value).success;

async function requireSession(returnTo: string): Promise<string> {
  const token = await readCookie('session');
  return token ?? redirect(loginUrl({ returnTo }), RedirectType.replace);
}

async function callOptions(token: string): Promise<ApiCallOptions> {
  return { session: token, incoming: await headers() };
}

function logFailure(action: string, result: Failure): void {
  log.warn('web.teams.api_failure', { action, status: result.status, code: result.error.code });
}

function go(path: string, query: string): never {
  return redirect(`${path}${path.includes('?') ? '&' : '?'}${query}`, RedirectType.replace);
}

function notice(
  path: string,
  code: NoticeCode,
  counts: Partial<Record<NoticeCountKey, number>> = {},
  date?: string,
): never {
  return go(path, noticeQuery(code, counts, date));
}

/** The one-line text of a notice, for a result shown in a status region instead of a banner. */
function noticeText(
  code: NoticeCode,
  counts: Partial<Record<NoticeCountKey, number>> = {},
  date: string | null = null,
): string {
  return noticeBanner({ code, counts, date }, { bankingHref: '' }).lines.join(' ');
}

/** Counts that are zero are left out of the URL, so a banner never carries a line for nothing. */
function nonZero(counts: Record<string, number>): Partial<Record<NoticeCountKey, number>> {
  return Object.fromEntries(Object.entries(counts).filter(([, value]) => value > 0));
}

const notFoundState = (): SessionActionState => ({ error: { code: 'not_found' } });

// ---------------------------------------------------------------------------------------------
// Failure mapping
// ---------------------------------------------------------------------------------------------

/**
 * The in-place state (or redirect) for a failed session or series write. `here` is where a sign-in returns
 * to; `page` is what a lost admin role or a known state change refreshes. 409s that mean "the page you are on
 * is out of date" redirect to the page, which re-reads the row and says why.
 */
function formFailure(
  action: string,
  result: Failure,
  ctx: { here: string; page: string; kind: 'session' | 'series' },
): SessionActionState {
  const { status, error } = result;
  if (status === 401) return redirect(sessionExpiredUrl(ctx.here), RedirectType.replace);
  if (status === 403) {
    revalidatePath(ctx.page);
    return { error: { code: 'forbidden' } };
  }
  if (status === 404) return notFoundState();
  if (status === 422 && error.fieldErrors !== undefined) {
    return {
      fieldErrors: error.fieldErrors,
      ...(result.dstOptions === undefined ? {} : { dstOptions: result.dstOptions }),
    };
  }
  if (status === 409) {
    switch (error.code) {
      case 'session_stale':
        return notice(ctx.page, 'session_stale');
      case 'series_stale':
        return go(`${ctx.page}?edit=details`, noticeQuery('series_stale'));
      case 'session_started':
        return notice(ctx.page, 'session_started');
      case 'session_not_editable':
      case 'session_state_conflict':
        return notice(ctx.page, 'session_not_editable');
      case 'series_ended':
        return notice(ctx.page, 'series_already_ended');
      case 'session_fee_locked':
        return {
          error: { code: 'session_fee_locked' },
          fieldErrors: fieldErrorsFromRaised(result.raisedFields ?? []),
        };
      case 'payout_not_configured':
        return { error: { code: 'payout_not_configured' } };
    }
  }
  logFailure(action, result);
  return { error: { code: status === 0 ? 'unconfirmed' : 'save_failed' } };
}

/** The outcome of the publish that follows a save (A4): the save already committed, so most refusals land on the draft. */
function publishOutcome(
  action: string,
  result: ApiResult<unknown>,
  ctx: { target: string; created: boolean },
): SessionActionState {
  if (result.ok) return notice(ctx.target, 'published');
  const { status, error } = result;
  if (status === 401) return redirect(sessionExpiredUrl(ctx.target), RedirectType.replace);
  if (status === 403) {
    revalidatePath(ctx.target);
    return { error: { code: 'forbidden' } };
  }
  if (status === 404) return notFoundState();
  if (status === 409) {
    switch (error.code) {
      case 'payout_not_configured':
        return notice(ctx.target, 'publish_refused_banking');
      case 'session_started':
        return notice(ctx.target, 'session_started');
      case 'session_stale':
        return notice(ctx.target, 'session_stale');
      case 'session_not_editable':
      case 'session_state_conflict':
        return notice(ctx.target, 'session_not_editable');
    }
  }
  if (status === 422) {
    // Create-and-publish leaves the form for the new draft; the field errors are not carried across the redirect.
    if (ctx.created) return notice(ctx.target, 'publish_incomplete');
    // Incomplete pricing or no court: the save stands, so refresh the page to the new version and keep the typing.
    revalidatePath(ctx.target);
    return {
      error: { code: 'publish_incomplete' },
      fieldErrors: error.fieldErrors ?? {},
    };
  }
  // Unknown outcome of the publish after a committed save: the page shows what is true (draft or published).
  logFailure(action, result);
  return notice(ctx.target, 'draft_saved');
}

/** The result of a confirm (cancel, End series): a message for the status region, or a redirect for a known state. */
function confirmFailure(
  action: string,
  result: Failure,
  ctx: { here: string; page: string },
): ModerationResult {
  const { status, error } = result;
  if (status === 401) return redirect(sessionExpiredUrl(ctx.here), RedirectType.replace);
  if (status === 403) {
    revalidatePath(ctx.page);
    return { ok: false, code: 'forbidden', message: NO_ACCESS_HEADING, refresh: true };
  }
  if (status === 404) {
    return {
      ok: false,
      code: 'not_found',
      message: "We couldn't find that session. It may have been removed.",
      refresh: true,
      close: true,
    };
  }
  if (status === 422 && error.fieldErrors !== undefined) {
    const message =
      Object.values(error.fieldErrors)[0]?.[0] ?? SESSION_FIELD_MESSAGES.reloadAndRetry;
    return {
      ok: false,
      code: 'validation_failed',
      message,
      refresh: false,
      fieldErrors: error.fieldErrors,
    };
  }
  if (status === 409) {
    switch (error.code) {
      case 'session_stale':
      case 'series_stale':
        revalidatePath(ctx.page);
        return {
          ok: false,
          code: error.code,
          message: noticeText(error.code),
          refresh: true,
          close: true,
        };
      case 'series_ended':
        revalidatePath(ctx.page);
        return {
          ok: false,
          code: 'series_ended',
          message: 'This series has already ended.',
          refresh: true,
          close: true,
        };
      case 'session_started':
        return notice(ctx.page, 'session_started');
      case 'session_not_editable':
      case 'session_state_conflict':
        return notice(ctx.page, 'session_not_editable');
    }
  }
  logFailure(action, result);
  return {
    ok: false,
    code: 'service_unavailable',
    message: status === 0 ? UNCONFIRMED_MESSAGE : SAVE_FAILED_MESSAGE,
    refresh: false,
  };
}

const notFoundResult = (): ModerationResult => ({
  ok: false,
  code: 'not_found',
  message: "We couldn't find that session. It may have been removed.",
  refresh: false,
  close: true,
});

// ---------------------------------------------------------------------------------------------
// One-off sessions
// ---------------------------------------------------------------------------------------------

/** "Save draft" and "Save and publish" on /new: create with the replay key, then publish when asked. */
export async function createSessionAction(
  _previous: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const teamId = formField(formData, 'teamId') ?? '';
  if (!isUuid(teamId)) return notFoundState();
  const parsed = parseCreateSession(formData);
  if (!parsed.ok) return { fieldErrors: parsed.fieldErrors };

  const here = newSessionPath(teamId);
  const options = await callOptions(await requireSession(here));
  const created = await apiClient.createSession(teamId, parsed.body, options);
  if (!created.ok)
    return formFailure('create_session', created, { here, page: here, kind: 'session' });

  const { session } = created.data;
  const target = sessionPath(teamId, session.id);
  if (readIntent(formData, 'draft') !== 'publish') return notice(target, 'draft_saved');
  const published = await apiClient.publishSession(
    teamId,
    session.id,
    { expectedVersion: session.version },
    options,
  );
  return publishOutcome('publish_session', published, { target, created: true });
}

/**
 * "Save draft", "Save changes" and "Save and publish" on an existing session. Publishing always saves first
 * (PUT, then POST publish with the version the save returned), so a refusal never loses an edit.
 */
export async function saveSessionAction(
  _previous: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const teamId = formField(formData, 'teamId') ?? '';
  const sessionId = formField(formData, 'sessionId') ?? '';
  if (!isUuid(teamId) || !isUuid(sessionId)) return notFoundState();
  const parsed = parseUpdateSession(formData);
  if (!parsed.ok) return { fieldErrors: parsed.fieldErrors };

  const target = sessionPath(teamId, sessionId);
  const options = await callOptions(await requireSession(target));
  const saved = await apiClient.updateSession(teamId, sessionId, parsed.body, options);
  if (!saved.ok)
    return formFailure('save_session', saved, { here: target, page: target, kind: 'session' });

  const { session, material, promoted } = saved.data;
  const wasPublished = formField(formData, 'status') === 'PUBLISHED';
  if (readIntent(formData, wasPublished ? 'save' : 'draft') === 'publish') {
    const published = await apiClient.publishSession(
      teamId,
      sessionId,
      { expectedVersion: session.version },
      options,
    );
    return publishOutcome('publish_session', published, { target, created: false });
  }
  const outcome = savedNotice(session, parsed.body.expectedVersion, formData, {
    material,
    promoted,
  });
  return notice(target, outcome.code, outcome.counts, outcome.date);
}

interface SavedNotice {
  code: NoticeCode;
  counts: Partial<Record<NoticeCountKey, number>>;
  date?: string;
}

/** The banner after a plain save: nothing changed, changes to a published session, a first edit of a series date, or a draft. */
function savedNotice(
  session: SessionResponse,
  expectedVersion: number,
  formData: FormData,
  write: { material: boolean; promoted: number },
): SavedNotice {
  // A save that changes nothing is a 200 that writes nothing, so the version did not move.
  if (session.version === expectedVersion) return { code: 'nothing_changed', counts: {} };
  if (session.status === 'PUBLISHED' && (write.material || write.promoted > 0)) {
    return {
      code: 'changes_saved',
      counts: nonZero({
        // The registered count is only worth telling when a field players care about changed (P-2).
        registered: write.material ? session.activeRegistrationCount : 0,
        promoted: write.promoted,
        material: write.material ? 1 : 0,
      }),
    };
  }
  const firstEdit =
    session.recurringRuleId !== null &&
    formField(formData, 'overridden') === 'false' &&
    session.isInstanceOverridden;
  if (firstEdit) return { code: 'instance_saved_first', counts: {}, date: session.date };
  return { code: session.status === 'DRAFT' ? 'draft_saved' : 'changes_saved', counts: {} };
}

/** Cancel, run by the editor's `InlineConfirm`: registrations are left as they are and nobody is emailed (P-2). */
export async function cancelSessionAction(
  _previous: ModerationResult | null,
  formData: FormData,
): Promise<ModerationResult> {
  const teamId = formField(formData, 'teamId') ?? '';
  const sessionId = formField(formData, 'sessionId') ?? '';
  const expectedVersion = Number(formField(formData, 'expectedVersion'));
  if (!isUuid(teamId) || !isUuid(sessionId) || !Number.isInteger(expectedVersion)) {
    return notFoundResult();
  }
  const target = sessionPath(teamId, sessionId);
  const options = await callOptions(await requireSession(target));
  const result = await apiClient.cancelSession(teamId, sessionId, { expectedVersion }, options);
  if (!result.ok) return confirmFailure('cancel_session', result, { here: target, page: target });

  return formField(formData, 'wasDraft') === 'true'
    ? notice(target, 'cancelled_draft')
    : notice(target, 'cancelled', { registered: result.data.activeRegistrationCount });
}

// ---------------------------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------------------------

export async function createSeriesAction(
  _previous: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const teamId = formField(formData, 'teamId') ?? '';
  if (!isUuid(teamId)) return notFoundState();
  const parsed = parseCreateSeries(formData);
  if (!parsed.ok) return { fieldErrors: parsed.fieldErrors };

  const here = newSeriesPath(teamId);
  const options = await callOptions(await requireSession(here));
  const created = await apiClient.createSeries(teamId, parsed.body, options);
  if (!created.ok)
    return formFailure('create_series', created, { here, page: here, kind: 'series' });
  return notice(seriesPath(teamId, created.data.series.id), 'series_created');
}

/** Save series: one synchronous transaction that reports counts; a free-to-paid change banking refuses saves nothing. */
export async function saveSeriesAction(
  _previous: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const teamId = formField(formData, 'teamId') ?? '';
  const ruleId = formField(formData, 'ruleId') ?? '';
  if (!isUuid(teamId) || !isUuid(ruleId)) return notFoundState();
  const parsed = parseUpdateSeries(formData);
  if (!parsed.ok) return { fieldErrors: parsed.fieldErrors };

  const target = seriesPath(teamId, ruleId);
  const here = `${target}?edit=details`;
  const options = await callOptions(await requireSession(here));
  const saved = await apiClient.updateSeries(teamId, ruleId, parsed.body, options);
  if (!saved.ok) return formFailure('save_series', saved, { here, page: target, kind: 'series' });

  if (saved.data.series.version === parsed.body.expectedVersion) {
    return notice(target, 'series_nothing_changed');
  }
  const { updated, skipped } = saved.data.outcome;
  return notice(
    target,
    'series_saved',
    nonZero({
      count: updated,
      edited: skipped.edited,
      started: skipped.started,
      closed: skipped.closed,
      deadlinePassed: skipped.deadlinePassed,
      feeLocked: skipped.feeLocked,
    }),
  );
}

/** End series, run by the series page's `InlineConfirm`: one transaction, so there is no partial-failure state. */
export async function endSeriesAction(
  _previous: ModerationResult | null,
  formData: FormData,
): Promise<ModerationResult> {
  const teamId = formField(formData, 'teamId') ?? '';
  const ruleId = formField(formData, 'ruleId') ?? '';
  const expectedVersion = Number(formField(formData, 'expectedVersion'));
  if (!isUuid(teamId) || !isUuid(ruleId) || !Number.isInteger(expectedVersion)) {
    return notFoundResult();
  }
  const lastDate = formField(formData, 'lastDate') ?? '';
  if (parseYmd(lastDate) === null) {
    const message = SESSION_FIELD_MESSAGES.dateInvalid;
    return {
      ok: false,
      code: 'validation_failed',
      message,
      refresh: false,
      fieldErrors: { lastDate: [message] },
    };
  }
  const target = seriesPath(teamId, ruleId);
  const options = await callOptions(await requireSession(target));
  const result = await apiClient.endSeries(
    teamId,
    ruleId,
    {
      expectedVersion,
      lastDate,
      alsoCancelPublished: formField(formData, 'alsoCancelPublished') === 'true',
    },
    options,
  );
  if (!result.ok) return confirmFailure('end_series', result, { here: target, page: target });

  revalidatePath(target);
  revalidatePath(sessionsPath(teamId));
  return {
    ok: true,
    message: noticeText(
      'series_ended',
      nonZero({
        cancelled: result.data.cancelledPublished,
        registered: result.data.activeRegistrationCount,
      }),
      lastDate,
    ),
    refresh: true,
  };
}

/** "Publish drafts now": queues one run that retries the banking-refused drafts; the page says it is working. */
export async function publishDraftsAction(
  _previous: ModerationResult | null,
  formData: FormData,
): Promise<ModerationResult> {
  const teamId = formField(formData, 'teamId') ?? '';
  const ruleId = formField(formData, 'ruleId') ?? '';
  if (!isUuid(teamId) || !isUuid(ruleId)) return notFoundResult();
  const target = seriesPath(teamId, ruleId);
  const options = await callOptions(await requireSession(target));
  const result = await apiClient.publishSeriesDrafts(teamId, ruleId, options);
  if (result.ok) return notice(target, 'publishing_drafts');
  // An ended series cannot publish anything: show the ended state with the reason.
  if (result.status === 409 && result.error.code === 'series_ended') {
    return notice(target, 'series_already_ended');
  }
  return confirmFailure('publish_drafts', result, { here: target, page: target });
}
