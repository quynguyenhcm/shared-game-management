import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../api-client.ts';
import { sectionFor, successMessage, toModerationResult } from './moderation.ts';

const fail = (
  status: number,
  code: string,
  fieldErrors?: Record<string, string[]>,
): ApiResult<never> => ({
  ok: false,
  status,
  error: { code: code as 'internal_error', message: 'x', ...(fieldErrors ? { fieldErrors } : {}) },
});
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, status: 200, data });

describe('sectionFor (which status region reports the action)', () => {
  it('maps each moderation kind to its manage section', () => {
    expect(sectionFor('approve')).toBe('requests');
    expect(sectionFor('reject')).toBe('requests');
    expect(sectionFor('promote')).toBe('members');
    expect(sectionFor('demote')).toBe('members');
    expect(sectionFor('ban')).toBe('members');
    expect(sectionFor('regenerate')).toBe('invite');
  });
});

describe('successMessage (UI/UX copy table)', () => {
  it.each([
    ['approve', 'Ana Lee has been approved.'],
    ['reject', "Ana Lee's request was declined."],
    ['promote', 'Ana Lee is now a team admin.'],
    ['demote', 'Ana Lee is no longer a team admin.'],
    ['ban', 'Ana Lee has been banned.'],
  ] as const)('%s', (kind, text) => {
    expect(successMessage(kind, 'Ana Lee')).toBe(text);
  });

  it('regenerate needs no name', () => {
    expect(successMessage('regenerate')).toBe(
      'New invite link generated. The old link no longer works.',
    );
  });
});

describe('toModerationResult (AC-ERROR-6/7/9/11 web copy)', () => {
  it('success names the person from the API answer and refreshes the list', () => {
    expect(toModerationResult('ban', ok({}), { fullName: 'Dee Park' })).toEqual({
      ok: true,
      message: 'Dee Park has been banned.',
      refresh: true,
    });
  });

  it('409 membership_state_conflict and 404 are the stale-list banner and refresh', () => {
    const stale = 'Someone else already handled this request. The list has been refreshed.';
    expect(toModerationResult('approve', fail(409, 'membership_state_conflict'), {})).toMatchObject(
      {
        ok: false,
        code: 'membership_state_conflict',
        message: stale,
        refresh: true,
      },
    );
    expect(toModerationResult('approve', fail(404, 'not_found'), {})).toMatchObject({
      message: stale,
      refresh: true,
    });
  });

  it('409 last_team_admin keeps the list as is and says what to do', () => {
    expect(toModerationResult('demote', fail(409, 'last_team_admin'), {})).toEqual({
      ok: false,
      code: 'last_team_admin',
      message: 'A team needs at least one admin. Make another member an admin first.',
      refresh: false,
    });
  });

  it('409 team_admin_cannot_be_banned shows the Remove admin rights sentence with the name, and refreshes', () => {
    expect(
      toModerationResult('ban', fail(409, 'team_admin_cannot_be_banned'), { fullName: 'Cam Ng' }),
    ).toMatchObject({
      ok: false,
      message: 'Remove admin rights from Cam Ng before banning them.',
      refresh: true,
    });
  });

  it('5xx and an unreachable API (status 0) never refresh, never sign out, and say the details are still here', () => {
    const outage =
      'Something went wrong on our side. Your details are still here. Try again in a minute.';
    for (const status of [500, 503, 0]) {
      expect(toModerationResult('ban', fail(status, 'service_unavailable'), {})).toEqual({
        ok: false,
        code: 'service_unavailable',
        message: outage,
        refresh: false,
      });
    }
  });

  it('a 403 (demoted meanwhile) refreshes so the page re-renders as no-access', () => {
    expect(toModerationResult('promote', fail(403, 'forbidden'), {})).toMatchObject({
      ok: false,
      code: 'forbidden',
      message: "You don't have access to manage this team.",
      refresh: true,
    });
  });

  it('a 422 on the ban reason keeps the typed text and carries the field error', () => {
    expect(
      toModerationResult(
        'ban',
        fail(422, 'validation_failed', { reason: ['Use 500 characters or fewer.'] }),
        {},
      ),
    ).toEqual({
      ok: false,
      code: 'validation_failed',
      message: 'Use 500 characters or fewer.',
      refresh: false,
      fieldErrors: { reason: ['Use 500 characters or fewer.'] },
    });
  });
});
