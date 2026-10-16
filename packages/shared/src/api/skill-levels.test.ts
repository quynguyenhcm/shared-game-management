import { describe, expect, it } from 'vitest';
import { ErrorCode } from './errors.ts';
import {
  MemberSkillChangeResponse,
  SKILL_LEVELS_FIELD_MESSAGES,
  SetAutoEnrollRequest,
  SetSkillLevelRequest,
  SkillLevelConflictResponse,
} from './skill-levels.ts';
import { TeamMemberRow } from './teams.ts';

/** An APPROVED row as the API returns it, with the additive skill and Auto Enroll fields. */
const ROW = {
  userId: '22222222-2222-4222-8222-222222222222',
  fullName: 'Priya Patel',
  role: 'MEMBER',
  status: 'APPROVED',
  skillLevel: 'ADVANCED',
  requestedAt: '2026-10-03T01:00:00.000Z',
  approvedAt: '2026-10-04T01:00:00.000Z',
  bannedAt: null,
  banReason: null,
  skillOverride: { byName: 'Aroha Ngata', at: '2026-10-17T01:02:03.456Z' },
  skillChangedAt: '2026-10-17T01:02:03.456Z',
  autoEnroll: { enabled: true, until: '2026-11-30', assignedAt: '2026-10-17T01:02:03.456Z' },
  skillProgress: null,
} as const;

describe('TeamMemberRow additive fields (AC-VERIFY-7: existing fields unchanged, new ones required)', () => {
  it('parses a row with every additive field, and a never-touched row', () => {
    expect(TeamMemberRow.parse(ROW)).toEqual(ROW);
    const plain = {
      ...ROW,
      skillLevel: 'BEGINNER',
      skillOverride: null,
      skillChangedAt: null,
      autoEnroll: { enabled: false, until: null, assignedAt: null },
      skillProgress: { games: 23, required: 40, nextLevel: 'INTERMEDIATE' },
    };
    expect(TeamMemberRow.parse(plain)).toEqual(plain);
  });

  it('requires each additive field on every row and keeps the until a calendar date', () => {
    for (const field of ['skillOverride', 'skillChangedAt', 'autoEnroll', 'skillProgress']) {
      const rest = Object.fromEntries(Object.entries(ROW).filter(([key]) => key !== field));
      expect(TeamMemberRow.safeParse(rest).success, field).toBe(false);
    }
    expect(
      TeamMemberRow.safeParse({
        ...ROW,
        autoEnroll: { ...ROW.autoEnroll, until: '2026-11-30T00:00:00Z' },
      }).success,
    ).toBe(false);
  });
});

describe('PUT response shapes', () => {
  it('answers { member, changed } so the web can tell a save from a no-op', () => {
    expect(MemberSkillChangeResponse.parse({ member: ROW, changed: false })).toEqual({
      member: ROW,
      changed: false,
    });
    expect(MemberSkillChangeResponse.safeParse({ member: ROW }).success).toBe(false);
  });

  it('a stale override carries the current member beside the error; other 409s carry none', () => {
    expect(ErrorCode).toContain('skill_level_stale');
    const stale = {
      error: { code: 'skill_level_stale', message: 'x' },
      member: ROW,
    };
    expect(SkillLevelConflictResponse.parse(stale)).toEqual(stale);
    expect(
      SkillLevelConflictResponse.parse({
        error: { code: 'membership_state_conflict', message: 'x' },
      }),
    ).not.toHaveProperty('member');
  });
});

function fieldErrors(
  schema: { safeParse(value: unknown): unknown },
  value: unknown,
): Record<string, string[]> {
  const result = schema.safeParse(value) as {
    success: boolean;
    error?: { issues: { path: PropertyKey[]; message: string }[] };
  };
  expect(result.success).toBe(false);
  const map: Record<string, string[]> = {};
  for (const issue of result.error?.issues ?? []) {
    (map[issue.path.join('.') || '_form'] ??= []).push(issue.message);
  }
  return map;
}

describe('SetSkillLevelRequest (AC-ERROR-3, optimistic concurrency)', () => {
  const valid = {
    skillLevel: 'ADVANCED',
    expectedSkillLevel: 'BEGINNER',
    expectedChangedAt: null,
  };

  it('accepts a level with the state the panel was showing, with or without a baseline instant', () => {
    expect(SetSkillLevelRequest.parse(valid)).toEqual(valid);
    const withBaseline = { ...valid, expectedChangedAt: '2026-10-17T01:02:03.456Z' };
    expect(SetSkillLevelRequest.parse(withBaseline)).toEqual(withBaseline);
  });

  it('rejects an unknown or missing level with the skillLevel copy', () => {
    expect(fieldErrors(SetSkillLevelRequest, { ...valid, skillLevel: 'EXPERT' })).toEqual({
      skillLevel: [SKILL_LEVELS_FIELD_MESSAGES.skillLevelRequired],
    });
    expect(
      fieldErrors(SetSkillLevelRequest, {
        expectedSkillLevel: 'BEGINNER',
        expectedChangedAt: null,
      }),
    ).toEqual({ skillLevel: [SKILL_LEVELS_FIELD_MESSAGES.skillLevelRequired] });
  });

  it('requires both expectation fields and a real instant', () => {
    expect(Object.keys(fieldErrors(SetSkillLevelRequest, { skillLevel: 'ADVANCED' }))).toEqual([
      'expectedSkillLevel',
      'expectedChangedAt',
    ]);
    expect(
      fieldErrors(SetSkillLevelRequest, { ...valid, expectedChangedAt: 'yesterday' }),
    ).toHaveProperty('expectedChangedAt');
    expect(
      fieldErrors(SetSkillLevelRequest, { ...valid, expectedChangedAt: '2026-10-17' }),
    ).toHaveProperty('expectedChangedAt');
  });

  it('is strict: an owned field or any extra key is refused', () => {
    for (const extra of [
      { skillLevelOverrideBy: 'x' },
      { skillLevelChangedAt: '2026-10-17T00:00:00Z' },
      { role: 'TEAM_ADMIN' },
    ]) {
      expect(SetSkillLevelRequest.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
  });
});

describe('SetAutoEnrollRequest (AC-ERROR-3)', () => {
  it('accepts on with a date, on without one, and off without one', () => {
    expect(SetAutoEnrollRequest.parse({ enabled: true, until: '2026-11-30' })).toEqual({
      enabled: true,
      until: '2026-11-30',
    });
    expect(SetAutoEnrollRequest.parse({ enabled: true, until: null }).until).toBeNull();
    expect(SetAutoEnrollRequest.parse({ enabled: false, until: null }).enabled).toBe(false);
  });

  it('rejects a malformed or impossible date with the until copy', () => {
    for (const until of ['30/11/2026', '2026-13-01', '2026-02-30', '', 20261130, undefined]) {
      expect(fieldErrors(SetAutoEnrollRequest, { enabled: true, until })).toEqual({
        until: [SKILL_LEVELS_FIELD_MESSAGES.untilInvalid],
      });
    }
  });

  it('rejects an end date on an off flag, on the until field', () => {
    expect(fieldErrors(SetAutoEnrollRequest, { enabled: false, until: '2026-11-30' })).toEqual({
      until: [SKILL_LEVELS_FIELD_MESSAGES.untilNeedsAutoEnroll],
    });
  });

  it('requires a boolean enabled and refuses unknown fields such as the assignment time', () => {
    expect(fieldErrors(SetAutoEnrollRequest, { enabled: 'yes', until: null })).toHaveProperty(
      'enabled',
    );
    expect(
      SetAutoEnrollRequest.safeParse({
        enabled: true,
        until: null,
        autoEnrollAssignedAt: '2026-10-17T00:00:00Z',
      }).success,
    ).toBe(false);
  });
});
