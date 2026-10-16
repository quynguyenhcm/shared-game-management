import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../api-client.ts';
import {
  autoEnrollState,
  autoEnrollTag,
  formatCalendarDate,
  skillProgressLine,
  skillProvenanceLine,
  skillRuleLine,
  toSkillResult,
  validateUntil,
} from './skill-levels-view.ts';

const TODAY = '2026-12-02';

const member = (over: Record<string, unknown> = {}) => ({
  userId: '22222222-2222-4222-8222-222222222222',
  fullName: 'Priya Patel',
  role: 'MEMBER' as const,
  status: 'APPROVED' as const,
  skillLevel: 'ADVANCED' as const,
  requestedAt: '2026-10-03T01:00:00.000Z',
  approvedAt: '2026-10-04T01:00:00.000Z',
  bannedAt: null,
  banReason: null,
  skillOverride: null,
  skillChangedAt: null,
  autoEnroll: { enabled: false, until: null, assignedAt: null },
  skillProgress: null,
  ...over,
});
const ok = (data: unknown): ApiResult<never> => ({ ok: true, status: 200, data }) as never;
const fail = (
  status: number,
  code: string,
  fieldErrors?: Record<string, string[]>,
): ApiResult<never> => ({
  ok: false,
  status,
  error: { code: code as 'internal_error', message: 'x', ...(fieldErrors ? { fieldErrors } : {}) },
});

describe('formatCalendarDate (a calendar date, never shifted by a time zone)', () => {
  it('formats YYYY-MM-DD as the same NZ-style day', () => {
    expect(formatCalendarDate('2026-11-30')).toBe('30 Nov 2026');
    expect(formatCalendarDate('2026-09-01')).toBe('1 Sep 2026');
    expect(formatCalendarDate('2026-12-31')).toBe('31 Dec 2026');
  });
});

describe('skillProvenanceLine (AC-ENTRY-1 provenance copy)', () => {
  it('never changed is Self-assessed', () => {
    expect(skillProvenanceLine(member())).toBe('Self-assessed');
  });

  it('an admin override names the admin and the NZ date of the override', () => {
    const at = '2026-10-17T01:00:00.000Z';
    expect(
      skillProvenanceLine(
        member({ skillOverride: { byName: 'Aroha Ngata', at }, skillChangedAt: at }),
      ),
    ).toBe('Set by Aroha Ngata · 17 Oct 2026');
  });

  it('a removed admin account reads "a former admin"', () => {
    const at = '2026-10-17T01:00:00.000Z';
    expect(
      skillProvenanceLine(member({ skillOverride: { byName: '', at }, skillChangedAt: at })),
    ).toBe('Set by a former admin · 17 Oct 2026');
  });

  it('a change after any override is automatic', () => {
    expect(skillProvenanceLine(member({ skillChangedAt: '2026-11-03T01:00:00.000Z' }))).toBe(
      'Moved up automatically · 3 Nov 2026',
    );
  });
});

describe('skillProgressLine (AC-HAPPY-11, capped, required from the API)', () => {
  it('shows games toward the next level', () => {
    expect(skillProgressLine({ games: 23, required: 40, nextLevel: 'INTERMEDIATE' })).toBe(
      '23 of 40 games toward Intermediate',
    );
  });

  it('takes the denominator from required, not a literal', () => {
    expect(skillProgressLine({ games: 3, required: 12, nextLevel: 'ADVANCED' })).toBe(
      '3 of 12 games toward Advanced',
    );
  });

  it.each([40, 41, 85])('caps %i games at the requirement', (games) => {
    expect(skillProgressLine({ games, required: 40, nextLevel: 'ADVANCED' })).toBe(
      '40 of 40 games toward Advanced',
    );
  });

  it('null is the highest level', () => {
    expect(skillProgressLine(null)).toBe('Highest level');
  });
});

describe('autoEnrollState and autoEnrollTag (AC-HAPPY-7/8/13, AC-ASYNC-3)', () => {
  it('off has no tag', () => {
    const off = { enabled: false, until: null, assignedAt: null };
    expect(autoEnrollState(off, TODAY)).toEqual({ kind: 'off' });
    expect(autoEnrollTag(off, TODAY)).toBeNull();
  });

  it('on with a future date, and no end date', () => {
    const dated = { enabled: true, until: '2026-12-20', assignedAt: '2026-10-01T00:00:00.000Z' };
    expect(autoEnrollState(dated, TODAY)).toEqual({ kind: 'active', until: '2026-12-20' });
    expect(autoEnrollTag(dated, TODAY)).toBe('Auto Enroll until 20 Dec 2026');
    const open = { enabled: true, until: null, assignedAt: '2026-10-01T00:00:00.000Z' };
    expect(autoEnrollTag(open, TODAY)).toBe('Auto Enroll, no end date');
  });

  it('an until equal to today is still active', () => {
    const today = { enabled: true, until: TODAY, assignedAt: '2026-10-01T00:00:00.000Z' };
    expect(autoEnrollState(today, TODAY)).toEqual({ kind: 'active', until: TODAY });
    expect(autoEnrollTag(today, TODAY)).toBe('Auto Enroll until 2 Dec 2026');
  });

  it('an until before today (flag still true) is ended', () => {
    const ended = { enabled: true, until: '2026-11-30', assignedAt: '2026-10-01T00:00:00.000Z' };
    expect(autoEnrollState(ended, TODAY)).toEqual({ kind: 'ended', until: '2026-11-30' });
    expect(autoEnrollTag(ended, TODAY)).toBe('Auto Enroll ended 30 Nov 2026');
  });
});

describe('validateUntil (AC-ERROR-3 client pre-check; the API stays the authority)', () => {
  it('accepts empty, today and later', () => {
    expect(validateUntil('', false, TODAY)).toBeNull();
    expect(validateUntil(TODAY, false, TODAY)).toBeNull();
    expect(validateUntil('2027-01-01', false, TODAY)).toBeNull();
  });

  it('refuses a past date', () => {
    expect(validateUntil('2026-12-01', false, TODAY)).toBe('Choose today or a later date.');
  });

  it('refuses a partly typed date (the browser reports an empty value)', () => {
    expect(validateUntil('', true, TODAY)).toBe('Enter a complete date, or clear the field.');
  });
});

describe('skillRuleLine (AC-HAPPY-12 consequence line)', () => {
  it('states the rule, the member count and the restart', () => {
    const line = skillRuleLine('Priya Patel', 'BEGINNER', {
      games: 23,
      required: 40,
      nextLevel: 'INTERMEDIATE',
    });
    expect(line).toContain('23 of 40');
    expect(line).toContain('Intermediate');
    expect(line).toContain('restarts');
  });

  it('at the highest level says so', () => {
    expect(skillRuleLine('Priya Patel', 'ADVANCED', null)).toContain(
      'Advanced is the highest level.',
    );
  });
});

describe('toSkillResult (AC-HAPPY-1/3/7/8/10, AC-ERROR-3/6/8/9 web copy)', () => {
  const ctx = { fullName: 'Priya Patel' };

  it('skill: changed names the new level; unchanged says already', () => {
    const data = { member: member({ skillLevel: 'ADVANCED' }), changed: true };
    expect(toSkillResult('skill', ok(data), ctx)).toEqual({
      ok: true,
      kind: 'skill',
      message: 'Skill level for Priya Patel set to Advanced.',
      refresh: true,
    });
    expect(toSkillResult('skill', ok({ ...data, changed: false }), ctx).message).toBe(
      'Priya Patel is already Advanced.',
    );
  });

  it('auto enroll: on with a date, on with no date, off', () => {
    const on = member({ autoEnroll: { enabled: true, until: '2026-11-30', assignedAt: 'x' } });
    expect(toSkillResult('autoEnroll', ok({ member: on, changed: true }), ctx).message).toBe(
      'Auto Enroll on for Priya Patel until 30 Nov 2026.',
    );
    const open = member({ autoEnroll: { enabled: true, until: null, assignedAt: 'x' } });
    expect(toSkillResult('autoEnroll', ok({ member: open, changed: true }), ctx).message).toBe(
      'Auto Enroll on for Priya Patel, with no end date.',
    );
    expect(toSkillResult('autoEnroll', ok({ member: member(), changed: true }), ctx).message).toBe(
      'Auto Enroll turned off for Priya Patel.',
    );
  });

  it('auto enroll: unchanged is a no-op message, not a claim of change', () => {
    const result = toSkillResult('autoEnroll', ok({ member: member(), changed: false }), ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Nothing to change. Auto Enroll for Priya Patel is already off.');
  });

  it('422 passes the field errors through and does not refresh', () => {
    const result = toSkillResult(
      'autoEnroll',
      fail(422, 'validation_failed', { until: ['Choose today or a later date.'] }),
      ctx,
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'validation_failed',
      message: 'Choose today or a later date.',
      refresh: false,
      fieldErrors: { until: ['Choose today or a later date.'] },
    });
    expect(result.close).toBeUndefined();
  });

  it('409 skill_level_stale refreshes the panel and keeps it open (AC-ERROR-9)', () => {
    const result = toSkillResult('skill', fail(409, 'skill_level_stale'), ctx);
    expect(result).toMatchObject({
      ok: false,
      code: 'skill_level_stale',
      message: "This member's level changed since you opened the panel. Check it and save again.",
      refresh: true,
    });
    expect(result.close).toBeUndefined();
  });

  it('409 membership_state_conflict and 404 are member-specific, refresh and close (AC-ERROR-8)', () => {
    for (const failure of [fail(409, 'membership_state_conflict'), fail(404, 'not_found')]) {
      expect(toSkillResult('skill', failure, ctx)).toMatchObject({
        ok: false,
        code: 'membership_state_conflict',
        message: 'Priya Patel is no longer an approved member. The list has been refreshed.',
        refresh: true,
        close: true,
      });
    }
  });

  it('403 is the no-access heading, refreshes and closes', () => {
    expect(toSkillResult('autoEnroll', fail(403, 'forbidden'), ctx)).toMatchObject({
      ok: false,
      code: 'forbidden',
      message: "You don't have access to manage this team.",
      refresh: true,
      close: true,
    });
  });

  it('5xx and 503 lock timeouts say nothing was changed and never refresh (AC-ERROR-6)', () => {
    for (const status of [500, 503]) {
      expect(toSkillResult('skill', fail(status, 'service_unavailable'), ctx)).toMatchObject({
        ok: false,
        message: "We couldn't save that. Nothing was changed. Try again.",
        refresh: false,
      });
    }
  });

  it('an unreachable API (status 0) does not claim nothing changed', () => {
    const result = toSkillResult('skill', fail(0, 'service_unavailable'), ctx);
    expect(result).toMatchObject({
      ok: false,
      message:
        "We couldn't confirm that was saved. Try again; saving the same change twice is safe.",
      refresh: false,
    });
  });

  it('any other failure falls back to the generic retry copy', () => {
    expect(toSkillResult('skill', fail(418, 'internal_error'), ctx).message).toBe(
      "We couldn't save that. Nothing was changed. Try again.",
    );
  });
});
