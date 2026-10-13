import { describe, expect, it } from 'vitest';
import {
  BAN_REASON_MAX_LENGTH,
  BanMemberRequest,
  CURSOR_MAX_LENGTH,
  CreateTeamRequest,
  CreateTeamResponse,
  FIND_PAGE_SIZE,
  FindTeamsQuery,
  FindTeamsResponse,
  InviteCodeResponse,
  InviteLookupRequest,
  JoinRequestRequest,
  JoinRequestResponse,
  MEMBERS_PAGE_SIZE,
  MembersQuery,
  MembersResponse,
  MineTeamsResponse,
  ModerationResponse,
  TEAM_FIELD_MESSAGES,
  TeamDetailResponse,
  decodeFindCursor,
  encodeFindCursor,
} from './teams.ts';

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

const KEY = '3f2b8c1e-9d4a-4e7b-8a61-5c0d2f9e7b14';
const USER_ID = '0b6e5f1a-7c3d-4a2e-9f48-1d2c3b4a5e6f';
const valid = {
  name: 'Rosedale Badminton',
  description: 'Wednesday nights, all levels welcome',
  visibility: 'PUBLIC',
  skillLevel: 'INTERMEDIATE',
  idempotencyKey: KEY,
};
const member = {
  userId: USER_ID,
  fullName: 'Aroha Ngata',
  role: 'MEMBER',
  status: 'PENDING',
  skillLevel: 'ADVANCED',
  requestedAt: '2026-10-13T01:02:03.000Z',
  approvedAt: null,
  bannedAt: null,
  banReason: null,
};

describe('CreateTeamRequest (AC-ERROR-1, AC-ERROR-15)', () => {
  it('parses a valid body, trimming the name and keeping the idempotency key', () => {
    expect(CreateTeamRequest.parse({ ...valid, name: '  Rosedale Badminton ' })).toEqual(valid);
  });

  it('treats a blank description as absent and accepts exactly 1000 characters', () => {
    expect(CreateTeamRequest.parse({ ...valid, description: '   ' }).description).toBeUndefined();
    expect(CreateTeamRequest.safeParse({ ...valid, description: 'd'.repeat(1000) }).success).toBe(
      true,
    );
  });

  it('names each failing field with the copy-deck message', () => {
    expect(fieldErrors(CreateTeamRequest, {})).toMatchObject({
      name: [TEAM_FIELD_MESSAGES.nameRequired],
      visibility: [TEAM_FIELD_MESSAGES.visibilityRequired],
      skillLevel: [TEAM_FIELD_MESSAGES.skillLevelRequired],
      idempotencyKey: [TEAM_FIELD_MESSAGES.idempotencyKeyInvalid],
    });
    expect(TEAM_FIELD_MESSAGES.nameRequired).toBe('Enter a team name.');
    expect(TEAM_FIELD_MESSAGES.nameTooLong).toBe('Use 100 characters or fewer.');
    expect(TEAM_FIELD_MESSAGES.descriptionTooLong).toBe('Use 1000 characters or fewer.');
    expect(fieldErrors(CreateTeamRequest, { ...valid, name: '   ' }).name).toEqual([
      'Enter a team name.',
    ]);
    expect(fieldErrors(CreateTeamRequest, { ...valid, name: 'n'.repeat(101) }).name).toEqual([
      'Use 100 characters or fewer.',
    ]);
    expect(
      fieldErrors(CreateTeamRequest, { ...valid, description: 'd'.repeat(1001) }).description,
    ).toEqual(['Use 1000 characters or fewer.']);
    expect(fieldErrors(CreateTeamRequest, { ...valid, skillLevel: 'EXPERT' }).skillLevel).toEqual([
      'Select your skill level to continue.',
    ]);
  });

  it('requires a UUID v4 idempotency key (missing or malformed is a field error)', () => {
    for (const bad of [undefined, '', 'not-a-uuid', '0190f3a2-7b2c-7000-8000-000000000000']) {
      const body = { ...valid, ...(bad === undefined ? {} : { idempotencyKey: bad }) };
      if (bad === undefined) delete (body as Partial<typeof valid>).idempotencyKey;
      expect(fieldErrors(CreateTeamRequest, body), String(bad)).toHaveProperty('idempotencyKey');
    }
  });

  it('is strict: role, status, inviteCode, createdBy and unknown fields are refused', () => {
    for (const extra of [
      { inviteCode: 'x'.repeat(43) },
      { createdBy: USER_ID },
      { role: 'TEAM_ADMIN' },
      { status: 'APPROVED' },
      { anything: 1 },
    ]) {
      expect(CreateTeamRequest.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
  });
});

describe('join, invite lookup and ban bodies', () => {
  it('requires a skill level on a join request and allows an optional invite code', () => {
    expect(JoinRequestRequest.parse({ skillLevel: 'BEGINNER' })).toEqual({
      skillLevel: 'BEGINNER',
    });
    expect(
      JoinRequestRequest.parse({ skillLevel: 'ADVANCED', inviteCode: 'c'.repeat(43) }),
    ).toEqual({ skillLevel: 'ADVANCED', inviteCode: 'c'.repeat(43) });
    expect(fieldErrors(JoinRequestRequest, {}).skillLevel).toEqual([
      'Select your skill level to continue.',
    ]);
    expect(
      JoinRequestRequest.safeParse({ skillLevel: 'BEGINNER', role: 'TEAM_ADMIN' }).success,
    ).toBe(false);
  });

  it('accepts any bounded string as a lookup code so a malformed code answers invite_invalid, not 422', () => {
    expect(InviteLookupRequest.parse({ code: 'short' })).toEqual({ code: 'short' });
    expect(InviteLookupRequest.safeParse({}).success).toBe(false);
    expect(InviteLookupRequest.safeParse({ code: 'c'.repeat(1000) }).success).toBe(false);
    expect(InviteLookupRequest.safeParse({ code: 'x', extra: 1 }).success).toBe(false);
  });

  it('trims a ban reason, treats blank as absent and caps it at 500 characters', () => {
    expect(BAN_REASON_MAX_LENGTH).toBe(500);
    expect(BanMemberRequest.parse({})).toEqual({});
    expect(BanMemberRequest.parse({ reason: '  repeated no-shows ' })).toEqual({
      reason: 'repeated no-shows',
    });
    expect(BanMemberRequest.parse({ reason: '   ' }).reason).toBeUndefined();
    expect(BanMemberRequest.safeParse({ reason: 'r'.repeat(500) }).success).toBe(true);
    expect(BanMemberRequest.safeParse({ reason: 'r'.repeat(501) }).success).toBe(false);
    expect(BanMemberRequest.safeParse({ reason: 'x', status: 'BANNED' }).success).toBe(false);
  });
});

describe('Find a team query and cursor (Architecture A8)', () => {
  it('normalises q (NFC, trim, collapsed spaces), treats empty as absent and caps at 100', () => {
    expect(FindTeamsQuery.parse({ q: '  bad   minton ' })).toEqual({ q: 'bad minton' });
    expect(FindTeamsQuery.parse({ q: '   ' }).q).toBeUndefined();
    expect(FindTeamsQuery.parse({}).q).toBeUndefined();
    // "e" + combining acute folds to the precomposed form.
    expect(FindTeamsQuery.parse({ q: 'é' }).q).toBe('é');
    expect(FindTeamsQuery.safeParse({ q: 'q'.repeat(100) }).success).toBe(true);
    expect(FindTeamsQuery.safeParse({ q: 'q'.repeat(101) }).success).toBe(false);
    expect(FindTeamsQuery.safeParse({ q: 'x', page: 2 }).success).toBe(false);
  });

  it('round-trips a versioned cursor and rejects malformed or oversized ones as 422 input', () => {
    const payload = { v: 1, n: 'rosedale badminton', i: USER_ID, d: 'f' } as const;
    const encoded = encodeFindCursor(payload);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded.length).toBeLessThanOrEqual(CURSOR_MAX_LENGTH);
    expect(decodeFindCursor(encoded)).toEqual(payload);
    expect(FindTeamsQuery.parse({ after: encoded })).toEqual({ after: encoded });
    expect(decodeFindCursor('%%%')).toBeNull();
    expect(decodeFindCursor(Buffer.from('{"v":2}').toString('base64url'))).toBeNull();
    expect(
      decodeFindCursor(
        Buffer.from(JSON.stringify({ v: 1, n: 'a', i: 'not-uuid', d: 'x' })).toString('base64url'),
      ),
    ).toBeNull();
    expect(FindTeamsQuery.safeParse({ after: 'garbage!' }).success).toBe(false);
    expect(FindTeamsQuery.safeParse({ after: 'a'.repeat(CURSOR_MAX_LENGTH + 1) }).success).toBe(
      false,
    );
  });

  it('exposes the page sizes the architecture fixes (Find 20, admin lists 50)', () => {
    expect(FIND_PAGE_SIZE).toBe(20);
    expect(MEMBERS_PAGE_SIZE).toBe(50);
  });
});

describe('response contracts (Creative Reconciliation)', () => {
  it('Find returns nextCursor and prevCursor and per-team myStatus without BANNED', () => {
    const body = {
      teams: [
        { id: USER_ID, name: 'Albany', description: null, memberCount: 3, myStatus: 'PENDING' },
        { id: KEY, name: 'Rosedale', description: 'x', memberCount: 0, myStatus: null },
      ],
      nextCursor: 'abc',
      prevCursor: null,
    };
    expect(FindTeamsResponse.parse(body)).toEqual(body);
    expect(
      FindTeamsResponse.safeParse({
        ...body,
        teams: [{ ...body.teams[0], myStatus: 'BANNED' }],
      }).success,
    ).toBe(false);
    expect(FindTeamsResponse.safeParse({ teams: [], nextCursor: null }).success).toBe(false);
  });

  it('My teams rows carry pendingRequestCount; team detail carries myStatus and myRole', () => {
    const mine = {
      teams: [
        {
          id: USER_ID,
          name: 'A',
          visibility: 'PRIVATE',
          role: 'TEAM_ADMIN',
          status: 'APPROVED',
          pendingRequestCount: 2,
        },
        { id: KEY, name: 'B', visibility: 'PUBLIC', role: 'MEMBER', status: 'PENDING' },
      ],
    };
    expect(MineTeamsResponse.parse(mine)).toEqual(mine);
    expect(
      MineTeamsResponse.safeParse({ teams: [{ ...mine.teams[1], status: 'BANNED' }] }).success,
    ).toBe(false);
    const detail = {
      team: { id: USER_ID, name: 'A', description: null, visibility: 'PUBLIC', memberCount: 4 },
      myStatus: 'BANNED',
      myRole: null,
    };
    expect(TeamDetailResponse.parse(detail)).toEqual(detail);
    expect(TeamDetailResponse.safeParse({ team: detail.team }).success).toBe(false);
  });

  it('create, join and invite-code responses never contain an invite code except the admin ones', () => {
    const created = {
      team: { id: USER_ID, name: 'A', description: null, visibility: 'PRIVATE' },
      membership: { status: 'APPROVED', role: 'TEAM_ADMIN', skillLevel: 'INTERMEDIATE' },
    };
    expect(CreateTeamResponse.parse(created)).toEqual(created);
    expect(
      CreateTeamResponse.parse({ ...created, team: { ...created.team, inviteCode: 'leak' } }),
    ).toEqual(created);
    expect(
      JoinRequestResponse.parse({ membership: { status: 'PENDING', skillLevel: 'BEGINNER' } }),
    ).toEqual({ membership: { status: 'PENDING', skillLevel: 'BEGINNER' } });
    expect(InviteCodeResponse.parse({ inviteCode: 'c'.repeat(43) })).toEqual({
      inviteCode: 'c'.repeat(43),
    });
  });

  it('member lists include fullName and adminCount but have no email field; moderation echoes fullName', () => {
    const list = { members: [member], nextCursor: null, adminCount: 1 };
    expect(MembersResponse.parse(list)).toEqual(list);
    expect(
      Object.keys(
        MembersResponse.parse({ ...list, members: [{ ...member, email: 'a@b.co' }] }).members[0] ??
          {},
      ),
    ).not.toContain('email');
    expect(ModerationResponse.parse({ member })).toEqual({ member });
    expect(MembersQuery.parse({ status: 'BANNED' })).toEqual({ status: 'BANNED' });
    expect(fieldErrors(MembersQuery, { status: 'REJECTED' })).toHaveProperty('status');
    expect(MembersQuery.safeParse({}).success).toBe(false);
  });
});
