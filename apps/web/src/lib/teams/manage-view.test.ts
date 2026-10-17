import { describe, expect, it } from 'vitest';
import {
  MANAGE_SECTIONS,
  inviteUrl,
  jumpLinks,
  memberRowControls,
  pagerHrefs,
  sectionHeadingId,
} from './manage-view.ts';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TEAM_ID = '7f3c2b1a-1111-4222-8333-444455556666';

const row = (userId: string, role: 'MEMBER' | 'TEAM_ADMIN', fullName = 'Dee Park') => ({
  userId,
  fullName,
  role,
});

describe('MANAGE_SECTIONS and jumpLinks (UI/UX amendment 1: Join requests, Members, Invite link, Banned members)', () => {
  it('orders the sections and gives each a heading id the jump list and focus rule can target', () => {
    expect(MANAGE_SECTIONS.map((section) => [section.id, section.title])).toEqual([
      ['requests', 'Join requests'],
      ['members', 'Members'],
      ['invite', 'Invite link'],
      ['banned', 'Banned members'],
    ]);
    expect(sectionHeadingId('members')).toBe('members-heading');
  });

  it('shows the pending count on the first link, with a plus when a next page exists', () => {
    expect(jumpLinks({ pendingCount: 3, pendingHasMore: false }).map((l) => l.label)).toEqual([
      'Join requests (3)',
      'Members',
      'Invite link',
      'Banned members',
    ]);
    expect(jumpLinks({ pendingCount: 50, pendingHasMore: true })[0]?.label).toBe(
      'Join requests (50+)',
    );
    expect(jumpLinks({ pendingCount: 0, pendingHasMore: false })[0]?.label).toBe('Join requests');
    expect(jumpLinks({ pendingCount: 2, pendingHasMore: false }).map((l) => l.href)).toEqual([
      '#requests',
      '#members',
      '#invite',
      '#banned',
    ]);
  });
});

describe('memberRowControls (row rules: AC-ERROR-6/7, no Ban on own row)', () => {
  it('a plain member can be made admin or banned', () => {
    expect(
      memberRowControls({ member: row(OTHER, 'MEMBER'), selfUserId: ME, adminCount: 1 }),
    ).toEqual({
      isSelf: false,
      roleLabel: 'Member',
      roleControl: { kind: 'promote' },
      banControl: { kind: 'ban' },
      skillControl: { kind: 'panel' },
    });
  });

  it('every approved row, yourself and admins included, offers the Skill and Auto Enroll panel (AC-ENTRY-1)', () => {
    for (const [userId, role] of [
      [ME, 'TEAM_ADMIN'],
      [OTHER, 'TEAM_ADMIN'],
      [OTHER, 'MEMBER'],
    ] as const) {
      const controls = memberRowControls({
        member: { ...row(userId, role), status: 'APPROVED' },
        selfUserId: ME,
        adminCount: 2,
      });
      expect(controls.skillControl).toEqual({ kind: 'panel' });
    }
  });

  it('pending, rejected and banned rows never get it (AC-ENTRY-2)', () => {
    for (const status of ['PENDING', 'REJECTED', 'BANNED'] as const) {
      const controls = memberRowControls({
        member: { ...row(OTHER, 'MEMBER'), status },
        selfUserId: ME,
        adminCount: 2,
      });
      expect(controls.skillControl).toEqual({ kind: 'none' });
    }
  });

  it('another admin can have admin rights removed, but Ban is blocked with the visible reason', () => {
    const controls = memberRowControls({
      member: row(OTHER, 'TEAM_ADMIN', 'Cam Ng'),
      selfUserId: ME,
      adminCount: 2,
    });
    expect(controls.roleLabel).toBe('Admin');
    expect(controls.roleControl).toEqual({ kind: 'demote' });
    expect(controls.banControl).toEqual({
      kind: 'blocked',
      hint: 'Remove admin rights from Cam Ng before banning them.',
    });
  });

  it('own row: remove-own-admin goes through the confirm and there is no Ban at all', () => {
    const controls = memberRowControls({
      member: row(ME, 'TEAM_ADMIN', 'Quy Nguyen'),
      selfUserId: ME,
      adminCount: 2,
    });
    expect(controls.isSelf).toBe(true);
    expect(controls.roleControl).toEqual({ kind: 'demote_self' });
    expect(controls.banControl).toEqual({ kind: 'none' });
  });

  it('the sole admin gets the last-admin hint instead of a Remove admin button (proactive, adminCount)', () => {
    const controls = memberRowControls({
      member: row(ME, 'TEAM_ADMIN'),
      selfUserId: ME,
      adminCount: 1,
    });
    expect(controls.roleControl).toEqual({
      kind: 'demote_blocked',
      hint: 'A team needs at least one admin. Make another member an admin first.',
    });
  });
});

describe('pagerHrefs (keyset "Next" and "Back to start", fragment kept)', () => {
  it('sets only this section cursor, keeps the other sections, and ends with the fragment', () => {
    const { next, start } = pagerHrefs({
      teamId: TEAM_ID,
      section: 'members',
      current: { requestsAfter: 'r1' },
      nextCursor: 'm2',
    });
    expect(next).toBe(`/teams/${TEAM_ID}/manage?requestsAfter=r1&membersAfter=m2#members`);
    expect(start).toBeNull();
  });

  it('offers Back to start (this section cursor removed) when the page is not the first, and no Next on the last page', () => {
    const { next, start } = pagerHrefs({
      teamId: TEAM_ID,
      section: 'banned',
      current: { bannedAfter: 'b1', membersAfter: 'm1' },
      nextCursor: null,
    });
    expect(next).toBeNull();
    expect(start).toBe(`/teams/${TEAM_ID}/manage?membersAfter=m1#banned`);
    expect(
      pagerHrefs({
        teamId: TEAM_ID,
        section: 'requests',
        current: { requestsAfter: 'x' },
        nextCursor: null,
      }).start,
    ).toBe(`/teams/${TEAM_ID}/manage#requests`);
  });
});

describe('inviteUrl (AC-HAPPY-2: {WEB_BASE_URL}/teams/join?code=...)', () => {
  it('joins the configured origin and the code, encoded', () => {
    expect(inviteUrl('https://app.example', 'abc_DEF-123')).toBe(
      'https://app.example/teams/join?code=abc_DEF-123',
    );
    expect(inviteUrl('http://localhost:3000', 'a b')).toBe(
      'http://localhost:3000/teams/join?code=a%20b',
    );
  });
});
