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

const { SkillLevelField } = await import('./skill-level-field.tsx');
const { CreateTeamForm } = await import('./create-team-form.tsx');
const { JoinTeamForm } = await import('./join-team-form.tsx');
const { TeamSearchForm, FindResults } = await import('./team-search.tsx');

const KEY = '2f6c1c1e-7a64-4c0e-9d61-3c1f0c1f0a11';
const TEAM_ID = '7f3c2b1a-1111-4222-8333-444455556666';
const CODE = 'Zk3hQ9mXw2Lr8TfVb1NcY7uPaE4sJd6GoI0yHtKqRnA';

function radios(html: string, name: string): string[] {
  return (html.match(/<input[^>]*type="radio"[^>]*>/g) ?? []).filter((tag) =>
    tag.includes(`name="${name}"`),
  );
}

describe('SkillLevelField (Q6, AC-ERROR-2)', () => {
  const html = renderToStaticMarkup(<SkillLevelField hint="Hint text." />);

  it('is a fieldset "Your skill level" with Beginner, Intermediate and Advanced, none preselected', () => {
    expect(html).toMatch(/<legend[^>]*>Your skill level<\/legend>/);
    const inputs = radios(html, 'skillLevel');
    expect(inputs.map((tag) => /value="(\w+)"/.exec(tag)?.[1])).toEqual([
      'BEGINNER',
      'INTERMEDIATE',
      'ADVANCED',
    ]);
    for (const tag of inputs) expect(tag).not.toContain('checked');
    expect(html).toMatch(/<label[^>]*>[^<]*<input[^>]*>\s*Beginner<\/label>|>Beginner<\/label>/);
  });

  it('ties each option help text to its radio with aria-describedby, outside the label', () => {
    for (const tag of radios(html, 'skillLevel')) {
      const described = /aria-describedby="([^"]+)"/.exec(tag)?.[1];
      expect(described).toBeDefined();
      expect(html).toContain(`id="${described}"`);
    }
    expect(html).toContain('New to the sport or still learning the basics.');
    // The accessible name stays exactly the level: the help is not inside any <label>.
    const labels = html.match(/<label[^>]*>.*?<\/label>/g) ?? [];
    expect(labels).toHaveLength(3);
    for (const label of labels)
      expect(label).not.toMatch(/New to the sport|play regularly|competitive/);
  });

  it('shows the hint, makes the first radio the error-summary target, and links the group to hint and error', () => {
    expect(html).toContain('Hint text.');
    expect(radios(html, 'skillLevel')[0]).toContain('id="field-skillLevel"');
    const withError = renderToStaticMarkup(
      <SkillLevelField hint="Hint text." error="Select your skill level to continue." />,
    );
    expect(withError).toContain('Select your skill level to continue.');
    expect(withError).toMatch(
      /<fieldset[^>]*aria-describedby="field-skillLevel-hint field-skillLevel-error"/,
    );
  });

  it('refills a previous choice after a failed submit, but never invents one', () => {
    const refilled = renderToStaticMarkup(<SkillLevelField hint="h" defaultValue="ADVANCED" />);
    const checked = radios(refilled, 'skillLevel').filter((tag) => tag.includes('checked'));
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain('value="ADVANCED"');
  });
});

describe('CreateTeamForm (AC-HAPPY-1, AC-ERROR-1, AC-ERROR-15)', () => {
  const html = renderToStaticMarkup(<CreateTeamForm idempotencyKey={KEY} />);

  it('has the labelled fields in order and the Create team button', () => {
    const positions = [
      'Team name',
      'Description (optional)',
      'Visibility',
      'Your skill level',
      'Create team',
    ].map((text) => html.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).toMatch(/<label[^>]*for="field-name"[^>]*>Team name<\/label>/);
    expect(html).toMatch(
      /<label[^>]*for="field-description"[^>]*>Description \(optional\)<\/label>/,
    );
  });

  it('renders the idempotency key once as a hidden field, unchanged', () => {
    const hidden = html.match(/<input[^>]*type="hidden"[^>]*name="idempotencyKey"[^>]*>/g) ?? [];
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toContain(`value="${KEY}"`);
  });

  it('offers Public and Private with none preselected, in a fieldset with a legend and hint', () => {
    expect(html).toMatch(/<legend[^>]*>Visibility<\/legend>/);
    const visibility = radios(html, 'visibility');
    expect(visibility.map((tag) => /value="(\w+)"/.exec(tag)?.[1])).toEqual(['PUBLIC', 'PRIVATE']);
    for (const tag of visibility) expect(tag).not.toContain('checked');
    expect(html).toContain('You can&#x27;t change this after the team is created.');
  });

  it("asks for the creator's own skill level with none preselected", () => {
    const skill = radios(html, 'skillLevel');
    expect(skill).toHaveLength(3);
    for (const tag of skill) expect(tag).not.toContain('checked');
    expect(html).toContain('Your own level as a player. Team admins can see it.');
  });

  it('puts no maxlength on any input, so a long value is explained instead of silently cut (AC-ERROR-1)', () => {
    expect(html.toLowerCase()).not.toContain('maxlength');
  });

  it('is a noValidate form so the error summary, not the browser, explains problems', () => {
    expect(html).toMatch(/<form[^>]*noValidate/i);
  });
});

describe('JoinTeamForm (AC-HAPPY-4/5)', () => {
  it('shows "Ask to join {Team}", the skill fieldset with the join hint, and one Request to join button', () => {
    const html = renderToStaticMarkup(
      <JoinTeamForm
        teamId={TEAM_ID}
        teamName="Rosedale Badminton"
        returnTo={`/teams/${TEAM_ID}`}
      />,
    );
    expect(html).toContain('Ask to join Rosedale Badminton');
    expect(html).toMatch(/<legend[^>]*>Your skill level<\/legend>/);
    expect(html).toContain(
      'Rate yourself honestly. The team admin sees this when they review your request.',
    );
    expect(html.match(/>Request to join</g)).toHaveLength(1);
    for (const tag of radios(html, 'skillLevel')) expect(tag).not.toContain('checked');
  });

  it('carries the team id and return target, and only carries an invite code when it has one', () => {
    const publicHtml = renderToStaticMarkup(
      <JoinTeamForm teamId={TEAM_ID} teamName="T" returnTo={`/teams/${TEAM_ID}`} />,
    );
    expect(publicHtml).toMatch(/<input[^>]*name="teamId"[^>]*value="7f3c2b1a/);
    expect(publicHtml).not.toContain('name="inviteCode"');

    const inviteHtml = renderToStaticMarkup(
      <JoinTeamForm
        teamId={TEAM_ID}
        teamName="T"
        inviteCode={CODE}
        returnTo={`/teams/join?code=${CODE}`}
      />,
    );
    const hidden = inviteHtml.match(/<input[^>]*type="hidden"[^>]*name="inviteCode"[^>]*>/g) ?? [];
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toContain(`value="${CODE}"`);
  });
});

describe('TeamSearchForm and FindResults (AC-ENTRY-2, AC-HAPPY-3)', () => {
  it('is a GET form to /teams/find with the label "Search teams" and a Search button, keeping the query', () => {
    const html = renderToStaticMarkup(<TeamSearchForm q="badminton" />);
    expect(html).toMatch(
      /<form[^>]*action="\/teams\/find"[^>]*method="get"|<form[^>]*method="get"[^>]*action="\/teams\/find"/i,
    );
    expect(html).toMatch(/<label[^>]*>Search teams<\/label>/);
    expect(html).toMatch(
      /<input[^>]*name="q"[^>]*value="badminton"|<input[^>]*value="badminton"[^>]*name="q"/,
    );
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Search<\/button>/);
  });

  const teams = [
    {
      id: TEAM_ID,
      name: 'Rosedale Badminton',
      description: 'd'.repeat(200),
      memberCount: 14,
      myStatus: 'APPROVED' as const,
    },
    {
      id: '8a3c2b1a-1111-4222-8333-444455556666',
      name: 'Albany Badminton',
      description: null,
      memberCount: 1,
      myStatus: 'PENDING' as const,
    },
    {
      id: '9b3c2b1a-1111-4222-8333-444455556666',
      name: 'North Shore',
      description: 'Netball',
      memberCount: 0,
      myStatus: 'REJECTED' as const,
    },
  ];

  it('lists name, truncated description, member count and a View team link, with status tags (A5)', () => {
    const html = renderToStaticMarkup(
      <FindResults q="badminton" teams={teams} nextCursor={null} prevCursor={null} />,
    );
    expect(html).toContain('Teams matching &quot;badminton&quot;');
    expect(html).toContain('Rosedale Badminton');
    expect(html).toContain(`${'d'.repeat(160)}…`);
    expect(html).not.toContain('d'.repeat(161));
    expect(html).toContain('14 members');
    expect(html).toContain('1 member<');
    expect(html).toMatch(new RegExp(`<a[^>]*href="/teams/${TEAM_ID}"[^>]*>View team`));
    expect(html).toContain('Member');
    expect(html).toContain('Pending approval');
    expect(html).not.toContain('Request declined');
  });

  it('uses the all-teams heading and the empty states', () => {
    const all = renderToStaticMarkup(
      <FindResults q="" teams={teams} nextCursor={null} prevCursor={null} />,
    );
    expect(all).toContain('All public teams');
    const none = renderToStaticMarkup(
      <FindResults q="zzz" teams={[]} nextCursor={null} prevCursor={null} />,
    );
    expect(none).toContain('No teams match &quot;zzz&quot;. Try a different word, or ');
    expect(none).toMatch(/<a[^>]*href="\/teams\/new"[^>]*>create your own team<\/a>/);
    const nothing = renderToStaticMarkup(
      <FindResults q="" teams={[]} nextCursor={null} prevCursor={null} />,
    );
    expect(nothing).toContain('No public teams yet.');
  });

  it('pages with Previous and Next links that keep q and carry the opaque cursors', () => {
    const html = renderToStaticMarkup(
      <FindResults q="bad min" teams={teams} nextCursor="next_-1" prevCursor="prev_-2" />,
    );
    expect(html).toMatch(
      /<a[^>]*href="\/teams\/find\?q=bad\+min&amp;after=next_-1"[^>]*>Next<\/a>/,
    );
    expect(html).toMatch(
      /<a[^>]*href="\/teams\/find\?q=bad\+min&amp;after=prev_-2"[^>]*>Previous<\/a>/,
    );
    const first = renderToStaticMarkup(
      <FindResults q="" teams={teams} nextCursor="n" prevCursor={null} />,
    );
    expect(first).not.toContain('Previous');
    expect(first).toMatch(/href="\/teams\/find\?after=n"[^>]*>Next/);
  });
});
