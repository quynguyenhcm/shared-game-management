import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined }),
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock('next/navigation', () => ({
  redirect: () => undefined,
  RedirectType: { replace: 'replace' },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const { InlineConfirm } = await import('./inline-confirm.tsx');
const { JoinRequestList } = await import('./join-request-list.tsx');
const { MemberList } = await import('./member-list.tsx');
const { BannedList } = await import('./banned-list.tsx');
const { SectionPager } = await import('./section-pager.tsx');
const { ManageJumpNav } = await import('./manage-jump-nav.tsx');
const { ManageSection } = await import('./manage-section.tsx');
const { InviteLinkPanel } = await import('./invite-link-panel.tsx');
const { approveMemberAction, banMemberAction, regenerateInviteAction } =
  await import('../../lib/teams/actions.ts');

const TEAM_ID = '7f3c2b1a-1111-4222-8333-444455556666';
const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';

const person = (
  userId: string,
  fullName: string,
  role: 'MEMBER' | 'TEAM_ADMIN' = 'MEMBER',
  extra: Record<string, unknown> = {},
) => ({
  userId,
  fullName,
  role,
  status: 'APPROVED' as const,
  skillLevel: 'BEGINNER' as const,
  requestedAt: '2026-10-03T01:00:00.000Z',
  approvedAt: '2026-10-04T01:00:00.000Z',
  bannedAt: null,
  banReason: null,
  ...extra,
});

describe('InlineConfirm (UI/UX: the one confirmation pattern; never window.confirm)', () => {
  const base = {
    id: 'ban-x',
    section: 'members' as const,
    action: banMemberAction,
    fields: { teamId: TEAM_ID, userId: OTHER, fullName: 'Dee Park' },
    triggerLabel: 'Ban',
    triggerAriaLabel: 'Ban Dee Park',
    prompt: "Ban Dee Park? They lose access to this team and can't register for its sessions.",
    confirmLabel: 'Ban member',
    pendingLabel: 'Banning…',
    destructive: true,
  };

  it('closed: a trigger button with aria-expanded=false and aria-controls, and no panel', () => {
    const html = renderToStaticMarkup(<InlineConfirm {...base} />);
    const trigger = /<button[^>]*>/.exec(html)?.[0] ?? '';
    expect(trigger).toContain('aria-expanded="false"');
    expect(trigger).toContain('aria-controls="ban-x-panel"');
    expect(trigger).toContain('aria-label="Ban Dee Park"');
    expect(html).not.toContain('role="group"');
    expect(html).not.toContain('Ban member');
  });

  it('open: a non-modal role=group labelled by its prompt, the prompt takes focus, Cancel and the confirm are buttons', () => {
    const html = renderToStaticMarkup(<InlineConfirm {...base} defaultOpen />);
    expect(html).toMatch(/<button[^>]*aria-expanded="true"/);
    const panel = /<div[^>]*role="group"[^>]*>/.exec(html)?.[0] ?? '';
    expect(panel).toContain('id="ban-x-panel"');
    expect(panel).toContain('aria-labelledby="ban-x-prompt"');
    expect(html).not.toContain('aria-modal');
    expect(html).toMatch(
      /<p[^>]*id="ban-x-prompt"[^>]*tabindex="-1"[^>]*>Ban Dee Park\? They lose access/i,
    );
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Ban member<\/button>/);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Cancel<\/button>/);
    // The destructive confirm names the action in text and is styled red.
    expect(html).toMatch(/<button[^>]*bg-red-800[^>]*>Ban member/);
    // Carries the ids the Server Action needs, and the name only for the refusal copy.
    expect(html).toMatch(/<input[^>]*type="hidden"[^>]*name="teamId"[^>]*value="7f3c2b1a/);
    expect(html).toMatch(/<input[^>]*type="hidden"[^>]*name="userId"[^>]*value="22222222/);
  });

  it('the ban reason field is a labelled textarea limited to 500 characters (AC-HAPPY-11)', () => {
    const html = renderToStaticMarkup(
      <InlineConfirm
        {...base}
        defaultOpen
        reasonField={{
          name: 'reason',
          label: 'Reason (optional, only team admins see this)',
          maxLength: 500,
        }}
      />,
    );
    expect(html).toMatch(
      /<label[^>]*for="ban-x-reason"[^>]*>Reason \(optional, only team admins see this\)<\/label>/,
    );
    const textarea = /<textarea[^>]*>/.exec(html)?.[0] ?? '';
    expect(textarea).toContain('name="reason"');
    expect(textarea).toContain('id="ban-x-reason"');
    expect(textarea).toMatch(/maxLength="500"/i);
  });

  it('the source never uses a native dialog', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./inline-confirm.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/window\.confirm|\bconfirm\(|\balert\(|\bprompt\(/);
  });
});

describe('JoinRequestList (AC-HAPPY-6/7)', () => {
  const html = renderToStaticMarkup(
    <JoinRequestList
      teamId={TEAM_ID}
      requests={[
        person(OTHER, 'Ana Lee', 'MEMBER', { status: 'PENDING', skillLevel: 'INTERMEDIATE' }),
      ]}
    />,
  );

  it('shows name, skill and a dated "requested" line with Approve and Reject (accessible names start with the visible text)', () => {
    expect(html).toContain('Ana Lee');
    expect(html).toContain('Intermediate · requested 3 Oct 2026');
    expect(html).toMatch(/<time[^>]*dateTime="2026-10-03T01:00:00.000Z"/i);
    expect(html).toMatch(/<button[^>]*aria-label="Approve Ana Lee"[^>]*>Approve<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-label="Reject Ana Lee"[^>]*>Reject<\/button>/);
    // Reject has no confirmation: a rejected person can ask again (AC-HAPPY-8).
    expect(html).not.toContain('role="group"');
  });

  it('is a list labelled by its section heading', () => {
    expect(html).toMatch(/<ul[^>]*aria-labelledby="requests-heading"/);
  });
});

describe('MemberList (AC-HAPPY-9..11, AC-ERROR-6/7 row rules)', () => {
  const members = [
    person(ME, 'Quy Nguyen', 'TEAM_ADMIN'),
    person(OTHER, 'Cam Ng', 'TEAM_ADMIN'),
    person(THIRD, 'Dee Park', 'MEMBER'),
  ];
  const html = renderToStaticMarkup(
    <MemberList teamId={TEAM_ID} members={members} selfUserId={ME} adminCount={2} />,
  );
  const rowOf = (name: string): string => {
    const items = html.split('<li').slice(1);
    return items.find((item) => item.includes(name)) ?? '';
  };

  it('labels roles in text and marks your own row', () => {
    expect(rowOf('Quy Nguyen')).toContain('(you)');
    expect(rowOf('Quy Nguyen')).toContain('Admin');
    expect(rowOf('Dee Park')).toContain('Member');
  });

  it('your own row has Remove admin (confirmed) and no Ban', () => {
    const row = rowOf('Quy Nguyen');
    expect(row).toContain('aria-label="Remove admin, Quy Nguyen"');
    expect(row).not.toContain('aria-label="Ban Quy Nguyen"');
    expect(row).toContain('aria-controls="self-demote-panel"');
  });

  it('another admin: Remove admin, and Ban is aria-disabled with the visible reason linked by aria-describedby', () => {
    const row = rowOf('Cam Ng');
    expect(row).toContain('aria-label="Remove admin, Cam Ng"');
    const ban = /<button[^>]*aria-label="Ban Cam Ng"[^>]*>/.exec(row)?.[0] ?? '';
    expect(ban).toContain('aria-disabled="true"');
    const described = /aria-describedby="([^"]+)"/.exec(ban)?.[1] ?? '';
    expect(described).not.toBe('');
    expect(row).toContain(`id="${described}"`);
    expect(row).toContain('Remove admin rights from Cam Ng before banning them.');
  });

  it('a plain member: Make admin (one tap, no confirm) and Ban (confirm)', () => {
    const row = rowOf('Dee Park');
    expect(row).toMatch(/<button[^>]*aria-label="Make admin, Dee Park"[^>]*>Make admin<\/button>/);
    const ban = /<button[^>]*aria-label="Ban Dee Park"[^>]*>/.exec(row)?.[0] ?? '';
    expect(ban).toContain('aria-expanded="false"');
    expect(ban).toContain('aria-controls="ban-');
  });

  it('the sole admin sees the last-admin hint and no Remove admin button', () => {
    const solo = renderToStaticMarkup(
      <MemberList
        teamId={TEAM_ID}
        members={[person(ME, 'Quy Nguyen', 'TEAM_ADMIN')]}
        selfUserId={ME}
        adminCount={1}
      />,
    );
    expect(solo).toContain('A team needs at least one admin. Make another member an admin first.');
    expect(solo).not.toContain('Remove admin, Quy Nguyen');
  });

  it('the only-member empty state links to the invite section', () => {
    const only = renderToStaticMarkup(
      <MemberList
        teamId={TEAM_ID}
        members={[person(ME, 'Quy Nguyen', 'TEAM_ADMIN')]}
        selfUserId={ME}
        adminCount={2}
      />,
    );
    expect(only).toContain(
      'You&#x27;re the only member so far. Share the invite link to bring people in.',
    );
    expect(only).toMatch(/<a[^>]*href="#invite"[^>]*>Go to Invite link<\/a>/);
  });
});

describe('BannedList (read-only, reason escaped as text)', () => {
  it('lists name, banned date and reason, and escapes markup in the reason', () => {
    const html = renderToStaticMarkup(
      <BannedList
        members={[
          person(OTHER, 'Eli Fox', 'MEMBER', {
            status: 'BANNED',
            bannedAt: '2026-10-09T01:00:00.000Z',
            banReason: '<script>alert(1)</script>',
          }),
          person(THIRD, 'Fay Wu', 'MEMBER', {
            status: 'BANNED',
            bannedAt: '2026-10-08T01:00:00.000Z',
          }),
        ]}
      />,
    );
    expect(html).toContain('Eli Fox');
    expect(html).toContain('banned 9 Oct 2026 · Reason: &lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('banned 8 Oct 2026 · No reason given.');
    expect(html).not.toMatch(/<button/);
  });

  it('shows the empty state', () => {
    expect(renderToStaticMarkup(<BannedList members={[]} />)).toContain('No banned members.');
  });
});

describe('SectionPager and ManageJumpNav', () => {
  it('renders Next and Back to start as plain links with section-specific accessible names', () => {
    const html = renderToStaticMarkup(
      <SectionPager
        label="members"
        next={`/teams/${TEAM_ID}/manage?membersAfter=c#members`}
        start={`/teams/${TEAM_ID}/manage#members`}
      />,
    );
    expect(html).toMatch(
      /<a[^>]*href="[^"]*membersAfter=c#members"[^>]*aria-label="Next members"[^>]*>Next<\/a>/,
    );
    expect(html).toMatch(/<a[^>]*aria-label="Back to start of members"[^>]*>Back to start<\/a>/);
    expect(renderToStaticMarkup(<SectionPager label="members" next={null} start={null} />)).toBe(
      '',
    );
  });

  it('the jump list is a labelled nav with the four anchors and the count', () => {
    const html = renderToStaticMarkup(<ManageJumpNav pendingCount={3} pendingHasMore={false} />);
    expect(html).toMatch(/<nav[^>]*aria-label="On this page"/);
    for (const href of ['#requests', '#members', '#invite', '#banned']) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain('Join requests (3)');
  });
});

describe('ManageSection', () => {
  it('is a labelled section whose h2 is a focus target, with a persistent status region from first render', () => {
    const html = renderToStaticMarkup(
      <ManageSection id="members" title="Members">
        <p>body</p>
      </ManageSection>,
    );
    expect(html).toMatch(/<section[^>]*id="members"[^>]*aria-labelledby="members-heading"/);
    expect(html).toMatch(/<h2[^>]*id="members-heading"[^>]*tabindex="-1"[^>]*>Members<\/h2>/);
    expect(html).toMatch(/<div[^>]*role="status"[^>]*>\s*<\/div>/);
  });
});

describe('InviteLinkPanel (AC-HAPPY-2/12)', () => {
  const url = 'https://app.example/teams/join?code=abc_DEF-123';
  const html = renderToStaticMarkup(
    <InviteLinkPanel teamId={TEAM_ID} url={url} visibility="PRIVATE" />,
  );

  it('shows the full URL in a labelled read-only field with Copy link and Generate new link', () => {
    expect(html).toMatch(/<label[^>]*for="invite-url"[^>]*>Invite link<\/label>/);
    const input = /<input[^>]*id="invite-url"[^>]*>/.exec(html)?.[0] ?? '';
    expect(input).toMatch(/readOnly/i);
    expect(input).toContain(`value="${url}"`);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Copy link<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Generate new link<\/button>/);
  });

  it('uses the private-team intro and keeps the Copy status region present from first render', () => {
    expect(html).toContain(
      'Only people with this link can find and ask to join this team. You still approve them.',
    );
    expect(html).toMatch(/role="status"/);
  });

  it('the regenerate confirm carries the exact prompt', () => {
    const open = renderToStaticMarkup(
      <InlineConfirm
        id="regenerate"
        section="invite"
        action={regenerateInviteAction}
        fields={{ teamId: TEAM_ID }}
        triggerLabel="Generate new link"
        prompt="Generate a new link? The old link stops working immediately."
        confirmLabel="Generate new link"
        pendingLabel="Generating…"
        defaultOpen
      />,
    );
    expect(open).toContain('Generate a new link? The old link stops working immediately.');
    expect(open).toMatch(/<button[^>]*type="submit"[^>]*>Generate new link<\/button>/);
  });
});

describe('one-tap actions are forms, so they work before hydration', () => {
  it('Approve is a submit button inside a form', () => {
    const html = renderToStaticMarkup(
      <JoinRequestList
        teamId={TEAM_ID}
        requests={[person(OTHER, 'Ana Lee', 'MEMBER', { status: 'PENDING' })]}
      />,
    );
    expect(html).toMatch(/<form[^>]*>[\s\S]*<button[^>]*type="submit"[^>]*>Approve<\/button>/);
    expect(typeof approveMemberAction).toBe('function');
  });
});
