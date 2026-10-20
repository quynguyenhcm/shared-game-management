import type { MembershipStatus, TeamRole } from '@sgm/shared';
import { LAST_ADMIN_MESSAGE, adminBanBlockedHint } from './labels.ts';

/**
 * Pure view rules of the manage page (UI/UX "Key Components"): section order and ids, the jump list, which
 * controls a member row offers, the keyset pager links and the invite URL. Kept free of React so every rule
 * is unit-tested once; the components only render what these return.
 */

/**
 * Every status region and confirm slot of the manage area: People sections, the banking page's two, then
 * one per Sessions page (the list, the session editor and the series page each render one section).
 */
export type SectionId =
  | 'requests'
  | 'members'
  | 'invite'
  | 'banned'
  | 'banking'
  | 'gst'
  | 'sessions'
  | 'session'
  | 'series';

/** The People sections that page with a keyset cursor. */
type PagedSection = 'requests' | 'members' | 'banned';

export const MANAGE_SECTIONS: readonly { id: SectionId; title: string }[] = [
  { id: 'requests', title: 'Join requests' },
  { id: 'members', title: 'Members' },
  { id: 'invite', title: 'Invite link' },
  { id: 'banned', title: 'Banned members' },
];

/** The `h2` of a section is the focus target after a row leaves its list (journey focus rule). */
export function sectionHeadingId(section: SectionId): string {
  return `${section}-heading`;
}

export interface JumpLink {
  id: SectionId;
  label: string;
  href: string;
}

/** "On this page" links; the first carries the waiting count, with a plus when a next page exists. */
export function jumpLinks(input: { pendingCount: number; pendingHasMore: boolean }): JumpLink[] {
  return MANAGE_SECTIONS.map(({ id, title }) => ({
    id,
    href: `#${id}`,
    label:
      id === 'requests' && input.pendingCount > 0
        ? `${title} (${input.pendingCount}${input.pendingHasMore ? '+' : ''})`
        : title,
  }));
}

export type RoleControl =
  | { kind: 'promote' }
  | { kind: 'demote' }
  | { kind: 'demote_self' }
  | { kind: 'demote_blocked'; hint: string };

export type BanControl = { kind: 'ban' } | { kind: 'blocked'; hint: string } | { kind: 'none' };

/** The "Skill and Auto Enroll" disclosure: offered on approved rows only (admins and yourself included). */
export type SkillControl = { kind: 'panel' } | { kind: 'none' };

export interface MemberRowControls {
  isSelf: boolean;
  roleLabel: 'Admin' | 'Member';
  roleControl: RoleControl;
  banControl: BanControl;
  skillControl: SkillControl;
}

/**
 * What an approved member's row offers. The API stays the authority (a hidden control is not a guard): this
 * only avoids offering what it would refuse. An admin's Ban is shown disabled with its reason (AC-ERROR-6),
 * your own row never offers Ban, and the sole admin sees the last-admin hint instead of "Remove admin".
 */
export function memberRowControls(input: {
  member: { userId: string; fullName: string; role: TeamRole; status?: MembershipStatus };
  selfUserId: string;
  adminCount: number;
}): MemberRowControls {
  const { member, selfUserId, adminCount } = input;
  const isSelf = member.userId === selfUserId;
  // The Members list only holds approved people, so a row without a status is approved.
  const skillControl: SkillControl =
    member.status === undefined || member.status === 'APPROVED'
      ? { kind: 'panel' }
      : { kind: 'none' };
  if (member.role !== 'TEAM_ADMIN') {
    return {
      isSelf,
      roleLabel: 'Member',
      roleControl: { kind: 'promote' },
      banControl: { kind: 'ban' },
      skillControl,
    };
  }
  if (isSelf) {
    return {
      isSelf,
      roleLabel: 'Admin',
      roleControl:
        adminCount <= 1
          ? { kind: 'demote_blocked', hint: LAST_ADMIN_MESSAGE }
          : { kind: 'demote_self' },
      banControl: { kind: 'none' },
      skillControl,
    };
  }
  return {
    isSelf,
    roleLabel: 'Admin',
    roleControl: { kind: 'demote' },
    banControl: { kind: 'blocked', hint: adminBanBlockedHint(member.fullName) },
    skillControl,
  };
}

const CURSOR_PARAM: Record<PagedSection, string> = {
  requests: 'requestsAfter',
  members: 'membersAfter',
  banned: 'bannedAfter',
};

export function cursorParam(section: PagedSection): string {
  return CURSOR_PARAM[section];
}

/**
 * "Next" and "Back to start" links for one section. Each changes only its own cursor, keeps the other
 * sections' cursors, and ends with the section fragment so the page does not jump to the top.
 */
export function pagerHrefs(input: {
  teamId: string;
  section: PagedSection;
  current: Record<string, string | undefined>;
  nextCursor: string | null;
}): { next: string | null; start: string | null } {
  const { teamId, section, current, nextCursor } = input;
  const param = CURSOR_PARAM[section];
  const build = (cursor: string | null): string => {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(current)) {
      if (name !== param && value !== undefined && value !== '') query.set(name, value);
    }
    if (cursor !== null) query.set(param, cursor);
    const text = query.toString();
    return `/teams/${teamId}/manage${text === '' ? '' : `?${text}`}#${section}`;
  };
  const onLaterPage = current[param] !== undefined && current[param] !== '';
  return {
    next: nextCursor === null ? null : build(nextCursor),
    start: onLaterPage ? build(null) : null,
  };
}

/** `{WEB_BASE_URL}/teams/join?code=<code>` (AC-HAPPY-2); the origin comes from configuration. */
export function inviteUrl(webBaseUrl: string, code: string): string {
  return `${webBaseUrl}/teams/join?code=${encodeURIComponent(code)}`;
}
