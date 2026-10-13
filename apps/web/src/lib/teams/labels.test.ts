import { describe, expect, it } from 'vitest';
import {
  INVITE_INVALID_HEADING,
  NOT_FOUND_HEADING,
  SKILL_OPTIONS,
  TERMINAL_JOIN_ERRORS,
  VISIBILITY_OPTIONS,
  inviteView,
  isTerminalJoinError,
  memberCountLabel,
  noticeText,
  pendingRequestsLabel,
  sortMyTeams,
  statusLabel,
  teamErrorLines,
  teamPageView,
  truncateDescription,
} from './labels.ts';

describe('statusLabel (journey status labels: text, never colour alone)', () => {
  it('maps status and role to the four labels', () => {
    expect(statusLabel('APPROVED', 'TEAM_ADMIN')).toBe('Admin');
    expect(statusLabel('APPROVED', 'MEMBER')).toBe('Member');
    expect(statusLabel('PENDING', 'MEMBER')).toBe('Pending approval');
    expect(statusLabel('REJECTED', 'MEMBER')).toBe('Request declined');
  });

  it('shows Member for an approved row whose role is unknown (Find results carry no role)', () => {
    expect(statusLabel('APPROVED')).toBe('Member');
  });
});

describe('teamPageView (the status table behind /teams/[teamId], AC-HAPPY-13)', () => {
  const base = { signedIn: true, visibility: 'PUBLIC' as const, myStatus: null, myRole: null };

  it('anonymous visitor on a public team gets a sign-in prompt and no form (A16)', () => {
    const view = teamPageView({ ...base, signedIn: false });
    expect(view).toMatchObject({ kind: 'anonymous', label: null, action: 'sign_in' });
  });

  it('signed in with no row on a public team gets the join form', () => {
    expect(teamPageView(base)).toMatchObject({
      kind: 'joinable',
      label: null,
      action: 'join_form',
    });
  });

  it('PENDING shows the status and the no-email line (A11), with no form', () => {
    const view = teamPageView({ ...base, myStatus: 'PENDING', myRole: 'MEMBER' });
    expect(view).toMatchObject({
      kind: 'pending',
      label: 'Pending approval',
      body: "Your request is with the team admins. There's no email for this yet, so check My teams to see the outcome.",
      action: 'my_teams',
    });
  });

  it('APPROVED member and admin get their own body and action', () => {
    expect(teamPageView({ ...base, myStatus: 'APPROVED', myRole: 'MEMBER' })).toMatchObject({
      kind: 'member',
      label: 'Member',
      body: "You're a member of this team.",
      action: 'my_teams',
    });
    expect(teamPageView({ ...base, myStatus: 'APPROVED', myRole: 'TEAM_ADMIN' })).toMatchObject({
      kind: 'admin',
      label: 'Admin',
      body: "You're an admin of this team.",
      action: 'manage',
    });
  });

  it('REJECTED on a public team can ask again; on a private team needs the invite link (A2)', () => {
    expect(teamPageView({ ...base, myStatus: 'REJECTED', myRole: 'MEMBER' })).toMatchObject({
      kind: 'declined_public',
      label: 'Request declined',
      body: "Your last request wasn't approved. You can ask again.",
      action: 'join_form',
    });
    expect(
      teamPageView({ ...base, visibility: 'PRIVATE', myStatus: 'REJECTED', myRole: 'MEMBER' }),
    ).toMatchObject({
      kind: 'declined_private',
      label: 'Request declined',
      action: 'none',
    });
    expect(
      teamPageView({ ...base, visibility: 'PRIVATE', myStatus: 'REJECTED', myRole: 'MEMBER' }).body,
    ).toContain("open the team's invite link");
  });

  it('BANNED on a public team is a dead end: no label, no form', () => {
    expect(teamPageView({ ...base, myStatus: 'BANNED', myRole: 'MEMBER' })).toMatchObject({
      kind: 'banned',
      label: null,
      action: 'none',
    });
  });

  it('a private team is never offered a join form on its page: no row or banned is not found', () => {
    expect(teamPageView({ ...base, visibility: 'PRIVATE' }).kind).toBe('not_found');
    expect(
      teamPageView({ ...base, visibility: 'PRIVATE', myStatus: 'BANNED', myRole: 'MEMBER' }).kind,
    ).toBe('not_found');
    expect(
      teamPageView({ ...base, signedIn: false, visibility: 'PRIVATE', myStatus: null }).kind,
    ).toBe('not_found');
  });
});

describe('inviteView (the invite landing table)', () => {
  it('no row or REJECTED shows the join form', () => {
    expect(inviteView(null)).toMatchObject({ kind: 'joinable', action: 'join_form' });
    expect(inviteView('REJECTED')).toMatchObject({ kind: 'joinable', action: 'join_form' });
  });

  it('PENDING shows the status without a form; APPROVED links to the team page', () => {
    expect(inviteView('PENDING')).toMatchObject({
      kind: 'pending',
      label: 'Pending approval',
      action: 'none',
    });
    expect(inviteView('APPROVED')).toMatchObject({
      kind: 'member',
      body: "You're already a member of this team.",
      action: 'team_page',
    });
  });
});

describe('copy deck helpers', () => {
  it('notices come from a closed list and name the team where the copy does', () => {
    expect(noticeText('join_requested')).toBe('Request sent. A team admin will review it.');
    expect(noticeText('team_created')).toBe("Team created. You're its first admin.");
    expect(noticeText('self_demoted', { teamName: 'Rosedale Badminton' })).toBe(
      "You're no longer an admin of Rosedale Badminton.",
    );
    expect(noticeText('<script>')).toBeNull();
    expect(noticeText(undefined)).toBeNull();
  });

  it('error codes map to the copy deck; unknown codes fall back to the generic banner', () => {
    expect(teamErrorLines('already_requested')).toEqual([
      "You've already asked to join this team. A team admin will review it.",
    ]);
    expect(teamErrorLines('already_member')).toEqual(["You're already a member of this team."]);
    expect(teamErrorLines('banned_from_team')).toEqual(["You can't join this team."]);
    expect(teamErrorLines('invite_invalid')).toEqual([
      'This invite link is no longer valid. Ask a team admin for a new one.',
    ]);
    expect(teamErrorLines('not_found')).toEqual(["We couldn't find that team."]);
    expect(teamErrorLines('service_unavailable')).toEqual([
      'Something went wrong on our side. Your details are still here. Try again in a minute.',
    ]);
    expect(teamErrorLines('offline')?.[0]).toContain('offline');
    expect(teamErrorLines('')).toBeNull();
  });

  it('terminal join errors replace the form with the matching status', () => {
    for (const code of [
      'already_requested',
      'already_member',
      'banned_from_team',
      'invite_invalid',
      'not_found',
    ]) {
      expect(isTerminalJoinError(code), code).toBe(true);
    }
    expect(TERMINAL_JOIN_ERRORS.size).toBe(5);
    expect(isTerminalJoinError('service_unavailable')).toBe(false);
    expect(isTerminalJoinError(undefined)).toBe(false);
  });

  it('member counts and waiting-request counts pluralise', () => {
    expect(memberCountLabel(1)).toBe('1 member');
    expect(memberCountLabel(0)).toBe('0 members');
    expect(memberCountLabel(14)).toBe('14 members');
    expect(pendingRequestsLabel(1)).toBe('1 join request waiting');
    expect(pendingRequestsLabel(2)).toBe('2 join requests waiting');
  });

  it('truncates a description at 160 characters with an ellipsis and tolerates null', () => {
    expect(truncateDescription(null)).toBe('');
    expect(truncateDescription('Short')).toBe('Short');
    const long = 'x'.repeat(200);
    const cut = truncateDescription(long);
    expect(cut).toBe(`${'x'.repeat(160)}…`);
    expect(truncateDescription('y'.repeat(160))).toBe('y'.repeat(160));
  });

  it('exposes the page headings the 404 and invalid-invite states use', () => {
    expect(NOT_FOUND_HEADING).toBe("We couldn't find that team.");
    expect(INVITE_INVALID_HEADING).toBe("This invite link doesn't work");
  });
});

describe('sortMyTeams (rows needing the user first, then by name)', () => {
  const row = (
    name: string,
    status: 'PENDING' | 'APPROVED' | 'REJECTED' = 'APPROVED',
    pendingRequestCount?: number,
  ) => ({
    id: name,
    name,
    visibility: 'PUBLIC' as const,
    role: pendingRequestCount === undefined ? ('MEMBER' as const) : ('TEAM_ADMIN' as const),
    status,
    ...(pendingRequestCount === undefined ? {} : { pendingRequestCount }),
  });

  it('puts admin rows with waiting requests first, then alphabetical (case-insensitive)', () => {
    const sorted = sortMyTeams([
      row('albany'),
      row('Zeta', 'APPROVED', 3),
      row('Beta', 'PENDING'),
      row('Alpha', 'APPROVED', 0),
      row('Mu', 'APPROVED', 1),
    ]);
    expect(sorted.map((team) => team.name)).toEqual(['Mu', 'Zeta', 'albany', 'Alpha', 'Beta']);
  });

  it('does not mutate its input', () => {
    const input = [row('b'), row('a')];
    sortMyTeams(input);
    expect(input.map((team) => team.name)).toEqual(['b', 'a']);
  });
});

describe('field option data (Q6: honest skill capture, none preselected)', () => {
  it('lists Beginner, Intermediate and Advanced with one-line help', () => {
    expect(SKILL_OPTIONS.map((option) => [option.value, option.label])).toEqual([
      ['BEGINNER', 'Beginner'],
      ['INTERMEDIATE', 'Intermediate'],
      ['ADVANCED', 'Advanced'],
    ]);
    for (const option of SKILL_OPTIONS) expect(option.help.length).toBeGreaterThan(10);
  });

  it('lists Public and Private', () => {
    expect(VISIBILITY_OPTIONS.map((option) => [option.value, option.label])).toEqual([
      ['PUBLIC', 'Public'],
      ['PRIVATE', 'Private'],
    ]);
  });
});
