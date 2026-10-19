import type { MembershipStatus, SkillTier, TeamRole, TeamVisibility } from '@sgm/shared';
import { errorMessage } from '../auth/messages.ts';

/**
 * The copy deck and status tables of the team pages (user journey: "Status-driven team page", "Copy
 * deck"; UI/UX Q6). Pure data and functions so each table is unit-tested once and shared by the team
 * page, the invite page, Find and My teams. Field messages live in the shared zod schemas.
 */

// ---------------------------------------------------------------------------------------------
// Status labels
// ---------------------------------------------------------------------------------------------

/** What a person's row says about them: text, never colour alone. `role` is unknown on Find results. */
export function statusLabel(
  status: Exclude<MembershipStatus, 'BANNED'>,
  role?: TeamRole,
): 'Admin' | 'Member' | 'Pending approval' | 'Request declined' {
  switch (status) {
    case 'APPROVED':
      return role === 'TEAM_ADMIN' ? 'Admin' : 'Member';
    case 'PENDING':
      return 'Pending approval';
    case 'REJECTED':
      return 'Request declined';
  }
}

const PENDING_BODY =
  "Your request is with the team admins. There's no email for this yet, so check My teams to see the outcome.";

/** What the page offers next. `join_form` is only ever returned when the caller may ask to join. */
export type TeamAction = 'sign_in' | 'join_form' | 'my_teams' | 'manage' | 'team_page' | 'none';

export interface StatusView {
  kind:
    | 'not_found'
    | 'anonymous'
    | 'joinable'
    | 'pending'
    | 'member'
    | 'admin'
    | 'declined_public'
    | 'declined_private'
    | 'banned';
  label: string | null;
  body: string | null;
  action: TeamAction;
}

const view = (
  kind: StatusView['kind'],
  label: string | null,
  body: string | null,
  action: TeamAction,
): StatusView => ({ kind, label, body, action });

/**
 * The status table behind `/teams/[teamId]` (A2, A11, A16, A17). A private team is only ever shown to a
 * non-banned member (the API answers 404 otherwise), and its page never offers a join form: private
 * teams are joined, and re-requested after a rejection, through the invite link only.
 */
export function teamPageView(input: {
  signedIn: boolean;
  visibility: TeamVisibility;
  myStatus: MembershipStatus | null;
  myRole: TeamRole | null;
}): StatusView {
  const { signedIn, visibility, myStatus, myRole } = input;
  const isPrivate = visibility === 'PRIVATE';
  switch (myStatus) {
    case 'PENDING':
      return view('pending', statusLabel('PENDING'), PENDING_BODY, 'my_teams');
    case 'APPROVED':
      return myRole === 'TEAM_ADMIN'
        ? view(
            'admin',
            statusLabel('APPROVED', 'TEAM_ADMIN'),
            "You're an admin of this team.",
            'manage',
          )
        : view(
            'member',
            statusLabel('APPROVED', 'MEMBER'),
            "You're a member of this team.",
            'my_teams',
          );
    case 'REJECTED':
      return isPrivate
        ? view(
            'declined_private',
            statusLabel('REJECTED'),
            "Your last request wasn't approved. To ask again, open the team's invite link. If you don't have it, ask a team admin.",
            'none',
          )
        : view(
            'declined_public',
            statusLabel('REJECTED'),
            "Your last request wasn't approved. You can ask again.",
            'join_form',
          );
    case 'BANNED':
      return isPrivate ? view('not_found', null, null, 'none') : view('banned', null, null, 'none');
    default:
      if (isPrivate) return view('not_found', null, null, 'none');
      return signedIn
        ? view('joinable', null, null, 'join_form')
        : view('anonymous', null, null, 'sign_in');
  }
}

/** The invite landing table. A banned caller never gets here (the lookup answers 403). */
export function inviteView(myStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | null): StatusView {
  switch (myStatus) {
    case 'PENDING':
      return view('pending', statusLabel('PENDING'), PENDING_BODY, 'none');
    case 'APPROVED':
      return view(
        'member',
        statusLabel('APPROVED'),
        "You're already a member of this team.",
        'team_page',
      );
    default:
      return view('joinable', null, null, 'join_form');
  }
}

// ---------------------------------------------------------------------------------------------
// Notices and errors (codes in, fixed text out)
// ---------------------------------------------------------------------------------------------

/** `?notice=` codes for the team pages. Anything else renders nothing. */
export function noticeText(
  code: string | null | undefined,
  context: { teamName?: string } = {},
): string | null {
  switch (code) {
    case 'team_created':
      return "Team created. You're its first admin.";
    case 'join_requested':
      return 'Request sent. A team admin will review it.';
    case 'self_demoted':
      return `You're no longer an admin of ${context.teamName ?? 'this team'}.`;
    default:
      return null;
  }
}

export const NOT_FOUND_HEADING = "We couldn't find that team.";
export const NOT_FOUND_BODY = 'It may be private, or the link may be wrong.';
export const INVITE_INVALID_HEADING = "This invite link doesn't work";
export const BANNED_HEADING = "You can't join this team.";
export const FIND_LOAD_ERROR = "We can't load teams right now. Try again in a minute.";

const TEAM_ERROR_LINES: Record<string, string> = {
  already_requested: "You've already asked to join this team. A team admin will review it.",
  already_member: "You're already a member of this team.",
  banned_from_team: BANNED_HEADING,
  invite_invalid: 'This invite link is no longer valid. Ask a team admin for a new one.',
  not_found: NOT_FOUND_HEADING,
};

/** Join errors that end the form: the page shows the matching status instead of asking again. */
export const TERMINAL_JOIN_ERRORS: ReadonlySet<string> = new Set(Object.keys(TEAM_ERROR_LINES));

export function isTerminalJoinError(code: string | null | undefined): boolean {
  return typeof code === 'string' && TERMINAL_JOIN_ERRORS.has(code);
}

/** Message lines for a team error code; the auth deck covers outages and offline; `null` renders nothing. */
export function teamErrorLines(code: string | null | undefined): string[] | null {
  const line = code === undefined || code === null ? undefined : TEAM_ERROR_LINES[code];
  return line === undefined ? errorMessage(code, {}) : [line];
}

// ---------------------------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------------------------

export function memberCountLabel(count: number): string {
  return count === 1 ? '1 member' : `${count} members`;
}

export function pendingRequestsLabel(count: number): string {
  return count === 1 ? '1 join request waiting' : `${count} join requests waiting`;
}

/** Find shows at most 160 characters of a description. */
export const DESCRIPTION_PREVIEW_LENGTH = 160;

export function truncateDescription(description: string | null): string {
  if (description === null) return '';
  return description.length > DESCRIPTION_PREVIEW_LENGTH
    ? `${description.slice(0, DESCRIPTION_PREVIEW_LENGTH)}…`
    : description;
}

export interface MyTeamRow {
  id: string;
  name: string;
  visibility: TeamVisibility;
  role: TeamRole;
  status: Exclude<MembershipStatus, 'BANNED'>;
  pendingRequestCount?: number | undefined;
}

/** Rows that need the user (an admin row with requests waiting) first, then by name. */
export function sortMyTeams<T extends MyTeamRow>(teams: readonly T[]): T[] {
  const needsAction = (team: T): boolean => (team.pendingRequestCount ?? 0) > 0;
  return [...teams].sort((a, b) => {
    if (needsAction(a) !== needsAction(b)) return needsAction(a) ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id);
  });
}

// ---------------------------------------------------------------------------------------------
// Team-admin (manage) area copy (UI/UX "Copy" table; the ban copy is the 2026-10-13 user decision)
// ---------------------------------------------------------------------------------------------

export const NO_ACCESS_HEADING = "You don't have access to manage this team.";
export const STALE_MESSAGE =
  'Someone else already handled this request. The list has been refreshed.';
export const LAST_ADMIN_MESSAGE =
  'A team needs at least one admin. Make another member an admin first.';
export const OUTAGE_MESSAGE =
  'Something went wrong on our side. Your details are still here. Try again in a minute.';
/** A definite failure (5xx, a lock timeout): the transaction rolled back, so "nothing was changed" is true. */
export const SAVE_FAILED_MESSAGE = "We couldn't save that. Nothing was changed. Try again.";
/** No answer arrived (timeout, network): the save may have committed, so never claim nothing changed. */
export const UNCONFIRMED_MESSAGE =
  "We couldn't confirm that was saved. Try again; saving the same change twice is safe.";
export const SKILL_STALE_MESSAGE =
  "This member's level changed since you opened the panel. Check it and save again.";
export const AUTO_ENROLL_STALE_MESSAGE =
  "This member's Auto Enroll changed since you opened the panel. Check it and save again.";
export const REGENERATE_PROMPT = 'Generate a new link? The old link stops working immediately.';
export const REGENERATE_SUCCESS = 'New invite link generated. The old link no longer works.';
export const SELF_DEMOTE_PROMPT = "Remove your own admin rights? You'll lose access to this page.";
export const BAN_REASON_LABEL = 'Reason (optional, only team admins see this)';
export const COPIED = 'Link copied.';
export const COPY_FAILED = "Couldn't copy automatically. The link is selected, copy it manually.";
export const EMPTY_REQUESTS = 'No join requests right now. New requests appear here.';
export const EMPTY_BANNED = 'No banned members.';
export const BANNED_INTRO = "Banned members lose access to this team and can't ask to join again.";

export function banPrompt(fullName: string): string {
  return `Ban ${fullName}? They lose access to this team and can't register for its sessions.`;
}

export function adminBanBlockedHint(fullName: string): string {
  return `Remove admin rights from ${fullName} before banning them.`;
}

export function emptyMembersLine(): string {
  return "You're the only member so far. Share the invite link to bring people in.";
}

export function inviteIntro(visibility: TeamVisibility): string {
  return visibility === 'PRIVATE'
    ? 'Only people with this link can find and ask to join this team. You still approve them.'
    : 'Share this link to invite people. Anyone who opens it can ask to join; you still approve them. This team is also listed in Find a team.';
}

const MANAGE_DATE = new Intl.DateTimeFormat('en-NZ', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Pacific/Auckland',
});

/** Dates are stored in UTC and shown in Pacific/Auckland, NZ style, only at the UI boundary (P3). */
export function formatManageDate(iso: string): string {
  return MANAGE_DATE.format(new Date(iso)).replace('Sept', 'Sep');
}

function skillName(skill: SkillTier): string {
  return SKILL_OPTIONS.find((option) => option.value === skill)?.label ?? skill;
}

export function requestedLine(skill: SkillTier, requestedAt: string): string {
  return `${skillName(skill)} · requested ${formatManageDate(requestedAt)}`;
}

export function bannedLine(bannedAt: string | null, reason: string | null): string {
  const when = bannedAt === null ? 'banned' : `banned ${formatManageDate(bannedAt)}`;
  return `${when} · ${reason === null || reason === '' ? 'No reason given.' : `Reason: ${reason}`}`;
}

export function manageSubtitle(visibility: TeamVisibility, memberCount: number): string {
  return `${visibility === 'PRIVATE' ? 'Private' : 'Public'} team · ${memberCountLabel(memberCount)}`;
}

// ---------------------------------------------------------------------------------------------
// Form option data (UI/UX Q6)
// ---------------------------------------------------------------------------------------------

export const SKILL_OPTIONS: readonly { value: SkillTier; label: string; help: string }[] = [
  { value: 'BEGINNER', label: 'Beginner', help: 'New to the sport or still learning the basics.' },
  {
    value: 'INTERMEDIATE',
    label: 'Intermediate',
    help: 'You play regularly and know the game well.',
  },
  { value: 'ADVANCED', label: 'Advanced', help: 'Experienced and competitive.' },
];

/** The admin-voiced help for the skill override: third person, unlike the player-facing `SKILL_OPTIONS`. */
export const SKILL_OVERRIDE_OPTIONS: readonly { value: SkillTier; label: string; help: string }[] =
  [
    {
      value: 'BEGINNER',
      label: 'Beginner',
      help: 'New to the sport or still learning the basics.',
    },
    {
      value: 'INTERMEDIATE',
      label: 'Intermediate',
      help: 'Plays regularly and knows the game well.',
    },
    { value: 'ADVANCED', label: 'Advanced', help: 'Experienced and competitive.' },
  ];

export const SKILL_HINT_CREATE = 'Your own level as a player. Team admins can see it.';
export const SKILL_HINT_JOIN =
  'Rate yourself honestly. The team admin sees this when they review your request.';

export const VISIBILITY_OPTIONS: readonly {
  value: TeamVisibility;
  label: string;
  help: string;
}[] = [
  {
    value: 'PUBLIC',
    label: 'Public',
    help: 'Anyone can find your team in Find a team and ask to join.',
  },
  {
    value: 'PRIVATE',
    label: 'Private',
    help: 'Only people with your invite link can find it and ask to join.',
  },
];

export const VISIBILITY_HINT = "You can't change this after the team is created.";
