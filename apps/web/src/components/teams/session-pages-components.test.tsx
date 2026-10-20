import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  CREATE_KEY,
  RULE_ID,
  TEAM_ID,
  instanceFixture,
  seriesFixture,
  seriesListItemFixture,
  sessionFixture,
} from '../../lib/teams/sessions-fixtures.ts';

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined }),
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock('next/navigation', () => ({
  redirect: () => undefined,
  RedirectType: { replace: 'replace' },
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const { SessionForm } = await import('./session-form.tsx');
const { SeriesForm } = await import('./series-form.tsx');
const { SessionList } = await import('./session-list.tsx');
const { CancelSessionConfirm } = await import('./cancel-session-confirm.tsx');
const { PublishDraftsButton } = await import('./publish-drafts-button.tsx');
const { ManageProvider } = await import('./manage-context.tsx');
const { seriesRows } = await import('../../lib/teams/sessions-view.ts');

const BANKING = `/teams/${TEAM_ID}/manage/banking?returnTo=%2Fteams%2F${TEAM_ID}%2Fmanage%2Fsessions`;

/** The opening tag of the button with this text (React orders button attributes its own way). */
const buttonTag = (html: string, text: string): string =>
  new RegExp(`<button[^>]*>${text}`).exec(html)?.[0] ?? '';

const legends = (html: string): string[] =>
  [...html.matchAll(/<legend[^>]*>([^<]*)<\/legend>/g)].map((match) => match[1] ?? '');

describe('SessionForm: create (UI/UX "Session editor", D1 and D2 order)', () => {
  const html = renderToStaticMarkup(
    <SessionForm teamId={TEAM_ID} mode="create" createKey={CREATE_KEY} bankingHref={BANKING} />,
  );

  it('lays the fieldsets out Details, Courts, Places, Costing, Pricing, Cancellation deadline', () => {
    expect(legends(html)).toEqual([
      'Details',
      'Courts',
      'Places',
      'Costing',
      'Pricing',
      'Cancellation deadline',
    ]);
  });

  it('posts the team and the per-render createKey, and no version', () => {
    expect(html).toMatch(/name="teamId"[^>]*value="7f3c2b1a/);
    expect(html).toMatch(/name="createKey"[^>]*value="2f6c1c1e/);
    expect(html).not.toContain('name="expectedVersion"');
  });

  it('offers Save draft first (so Enter saves a draft) and Save and publish, both named intent', () => {
    expect(html.indexOf('>Save draft<')).toBeGreaterThan(-1);
    expect(html.indexOf('>Save draft<')).toBeLessThan(html.indexOf('>Save and publish<'));
    const draft = buttonTag(html, 'Save draft');
    expect(draft).toContain('name="intent"');
    expect(draft).toContain('value="draft"');
    // A blank form is free: publishing needs no charge confirm, so the button submits directly.
    const publish = buttonTag(html, 'Save and publish');
    expect(publish).toContain('type="submit"');
    expect(publish).toContain('name="intent"');
    expect(publish).toContain('value="publish"');
  });

  it('has no cancel control, no native dialog and no beforeunload hook', () => {
    expect(html).not.toContain('Cancel session');
    expect(html).not.toMatch(/<dialog|beforeunload|confirm\(/);
  });

  it('a new one-off session edits its date', () => {
    expect(html).toContain('type="date"');
    expect(html).toContain('name="date"');
  });
});

describe('SessionForm: edit a draft (E1)', () => {
  const paid = sessionFixture();

  it('posts the id, the version it was opened at, the status and the Edited flag', () => {
    const html = renderToStaticMarkup(
      <SessionForm teamId={TEAM_ID} mode="edit" session={paid} bankingHref={BANKING} />,
    );
    expect(html).toMatch(/name="sessionId"[^>]*value="11111111/);
    expect(html).toMatch(/name="expectedVersion"[^>]*value="3"/);
    expect(html).toMatch(/name="status"[^>]*value="DRAFT"/);
    expect(html).toMatch(/name="overridden"[^>]*value="false"/);
    expect(html).not.toContain('name="createKey"');
  });

  it('a paid draft puts Save and publish behind a confirm: a toggle, not a submit', () => {
    const html = renderToStaticMarkup(
      <SessionForm teamId={TEAM_ID} mode="edit" session={paid} bankingHref={BANKING} />,
    );
    expect(html).toMatch(
      /<button[^>]*type="button"[^>]*aria-expanded="false"[^>]*>Save and publish/,
    );
    expect(html).not.toContain('Publish this session?');
  });

  it('the open confirm names the fee, says Auto Enroll applies, and submits the main form with intent=publish; its dismiss label is "Keep editing"', () => {
    const html = renderToStaticMarkup(
      <SessionForm
        teamId={TEAM_ID}
        mode="edit"
        session={paid}
        bankingHref={BANKING}
        defaultPublishOpen
      />,
    );
    expect(html).toContain(
      'Publish this session? Members can register straight away, and each player is charged after the game: $12.00 each. Members on Auto Enroll will be added to it.',
    );
    const confirm = buttonTag(html, 'Publish session');
    expect(confirm).toContain('name="intent"');
    expect(confirm).toContain('value="publish"');
    expect(html).toContain('>Keep editing</button>');
    expect(html).not.toContain('>Cancel</button>');
    expect(html).toContain('aria-expanded="true"');
  });

  it('a free draft publishes straight from the button, with no confirm', () => {
    const free = sessionFixture({
      courtCost: '0.00',
      extraExpenses: '0.00',
      feeFlat: '0.00',
      calculatedRatePerPlayer: '0.00',
    });
    const html = renderToStaticMarkup(
      <SessionForm teamId={TEAM_ID} mode="edit" session={free} bankingHref={BANKING} />,
    );
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*value="publish"[^>]*>Save and publish/);
  });
});

describe('SessionForm: edit a published session (E2)', () => {
  const published = sessionFixture({
    status: 'PUBLISHED',
    draftReason: null,
    activeRegistrationCount: 12,
  });

  it('has one primary button, Save changes (intent=save), the capacity hint and no draft or publish buttons', () => {
    const html = renderToStaticMarkup(
      <SessionForm teamId={TEAM_ID} mode="edit" session={published} bankingHref={BANKING} />,
    );
    const save = buttonTag(html, 'Save changes');
    expect(save).toContain('name="intent"');
    expect(save).toContain('value="save"');
    expect(html).not.toContain('Save draft');
    expect(html).not.toContain('Save and publish');
    expect(html).toContain('Lowering this won&#x27;t remove anyone who&#x27;s already in.');
  });

  it('a locked-fees session shows the model as text and the lowered-only line (T-7)', () => {
    const html = renderToStaticMarkup(
      <SessionForm
        teamId={TEAM_ID}
        mode="edit"
        session={{ ...published, feesLocked: 'raise_only_blocked' }}
        bankingHref={BANKING}
      />,
    );
    expect(html).toContain('Pricing: Flat rate');
    expect(html).toContain('Players have registered, so fees can only be lowered.');
  });

  it('a series date shows its date as text with the move hint and posts it unchanged (the date cannot move)', () => {
    const html = renderToStaticMarkup(
      <SessionForm
        teamId={TEAM_ID}
        mode="edit"
        session={{ ...published, recurringRuleId: RULE_ID, seriesName: 'Wednesdays at Rosedale' }}
        bankingHref={BANKING}
      />,
    );
    expect(html).toContain('To move this night, cancel it and create a one-off session.');
    expect(html).not.toContain('type="date"');
    expect(html).toMatch(/type="hidden"[^>]*name="date"[^>]*value="2026-11-04"/);
  });
});

describe('SeriesForm: create (UI/UX D3, series form create)', () => {
  const html = renderToStaticMarkup(
    <SeriesForm
      teamId={TEAM_ID}
      mode="create"
      createKey={CREATE_KEY}
      bankingHref={BANKING}
      isPayoutConfigured={false}
      horizonDays={56}
    />,
  );

  it('asks Repeats, Details, Courts, Places, Costing, Pricing and shows the static deadline line', () => {
    expect(legends(html)).toEqual([
      'Repeats',
      'Details',
      'Courts',
      'Places',
      'Costing',
      'Pricing',
      'Cancellation deadline',
    ]);
    expect(html).toContain(
      '48 hours before the first court starts, for every session in the series.',
    );
    expect(html).not.toContain('name="deadlineMode"');
  });

  it('says the horizon it was given, not a built-in one', () => {
    expect(html).toContain('Sessions are added 56 days ahead and published automatically');
    expect(html).not.toContain('28 days ahead');
  });

  it('posts the createKey and has one Create series button that opens the confirm (type=button)', () => {
    expect(html).toMatch(/name="createKey"[^>]*value="2f6c1c1e/);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*aria-expanded="false"[^>]*>Create series/);
  });

  it('the open confirm warns that sessions will be drafts when banking is missing, and dismisses with "Keep editing"', () => {
    const open = renderToStaticMarkup(
      <SeriesForm
        teamId={TEAM_ID}
        mode="create"
        createKey={CREATE_KEY}
        bankingHref={BANKING}
        isPayoutConfigured={false}
        horizonDays={56}
        defaultConfirmOpen
      />,
    );
    expect(open).toContain('Create this series?');
    expect(open).toContain(
      'bank account isn&#x27;t set up, so the sessions will be saved as drafts until it is.',
    );
    expect(open).toContain('>Keep editing</button>');
    expect(open).not.toContain('>Cancel</button>');
  });
});

describe('SeriesForm: edit (P-3 fixed pattern, T-5 effect line)', () => {
  const series = seriesFixture({
    instances: [
      instanceFixture({ id: 'a', seriesChangeEffect: 'will_update' }),
      instanceFixture({ id: 'b', seriesChangeEffect: 'will_update' }),
      instanceFixture({ id: 'c', seriesChangeEffect: 'edited' }),
    ],
  });
  const html = renderToStaticMarkup(
    <SeriesForm
      teamId={TEAM_ID}
      mode="edit"
      series={series}
      bankingHref={BANKING}
      isPayoutConfigured
      horizonDays={series.horizonDays}
      cancelHref={`/teams/${TEAM_ID}/manage/sessions/series/${RULE_ID}`}
    />,
  );

  it('posts the rule id and the version, never a createKey', () => {
    expect(html).toMatch(/name="ruleId"[^>]*value="41111111/);
    expect(html).toMatch(/name="expectedVersion"[^>]*value="2"/);
    expect(html).not.toContain('name="createKey"');
  });

  it('shows Repeats and First session as read-only rows with the fixed-pattern sentence, posted unchanged', () => {
    expect(html).toContain(
      'To change the day or how often it repeats, end this series and start a new one.',
    );
    expect(html).toMatch(/type="hidden"[^>]*name="frequency"[^>]*value="WEEKLY"/);
    expect(html).toMatch(/type="hidden"[^>]*name="startsOn"[^>]*value="2026-11-04"/);
    expect(html).not.toContain('Which one?');
  });

  it('states what a save will do before it is pressed, then offers Save series and a Cancel link back to the series', () => {
    expect(html).toContain(
      'Your changes will apply to 2 upcoming sessions and to sessions added later. 1 edited session keeps its own details.',
    );
    expect(html.indexOf('Your changes will apply')).toBeLessThan(html.indexOf('>Save series<'));
    expect(html).toMatch(/<a[^>]*href="\/teams\/[^"]*\/series\/41111111[^"]*"[^>]*>Cancel<\/a>/);
  });
});

describe('SessionList (UI/UX D4: four sections, flat rows)', () => {
  const published = sessionFixture({
    id: 'a1111111-1111-4111-8111-111111111111',
    status: 'PUBLISHED',
    draftReason: null,
    recurringRuleId: RULE_ID,
    seriesName: 'Wednesdays at Rosedale',
    isInstanceOverridden: true,
  });
  const draft = sessionFixture({
    id: 'b1111111-1111-4111-8111-111111111111',
    draftReason: 'banking',
    date: '2026-11-07',
  });
  const base = {
    teamId: TEAM_ID,
    isPayoutConfigured: false,
    current: {},
  };

  it('renders the four sections in order with their empty-state lines when nothing is loaded', () => {
    const html = renderToStaticMarkup(
      <SessionList
        {...base}
        upcoming={{ sessions: [], nextCursor: null }}
        drafts={{ sessions: [], nextCursor: null }}
        past={{ sessions: [], nextCursor: null }}
        series={[]}
      />,
    );
    const headings = [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((match) => match[1]);
    expect(headings).toEqual(['Upcoming', 'Drafts', 'Series', 'Past and cancelled']);
    expect(html).toContain('No upcoming sessions. Published sessions appear here.');
    expect(html).toContain('No drafts.');
    expect(html).toContain('No recurring series yet.');
    expect(html).toContain('Nothing here yet.');
  });

  it('a row is one link (date and times), then place and courts, then label chips and the series tag', () => {
    const html = renderToStaticMarkup(
      <SessionList
        {...base}
        upcoming={{ sessions: [published], nextCursor: null }}
        drafts={{ sessions: [draft], nextCursor: null }}
        past={{ sessions: [], nextCursor: null }}
        series={seriesRows([seriesListItemFixture()], [published])}
      />,
    );
    expect(html).toMatch(
      new RegExp(
        `<a[^>]*href="/teams/${TEAM_ID}/manage/sessions/a1111111[^"]*"[^>]*>Wed 4 Nov 2026, 8:00-10:00 am</a>`,
      ),
    );
    expect(html).toContain('Rosedale');
    expect(html).toContain('2 courts');
    expect(html).toContain('>Published<');
    expect(html).toContain('>Edited<');
    expect(html).toContain('Series: Wednesdays at Rosedale');
    expect(html).toContain('Draft · bank account needed');
  });

  it('a series row shows its status line: Adding sessions…, Active or Ended {date}, even with no loaded dates', () => {
    const html = renderToStaticMarkup(
      <SessionList
        {...base}
        upcoming={{ sessions: [], nextCursor: null }}
        drafts={{ sessions: [], nextCursor: null }}
        past={{ sessions: [], nextCursor: null }}
        series={seriesRows(
          [
            seriesListItemFixture({ materialising: true }),
            seriesListItemFixture({
              id: '51111111-1111-4111-8111-111111111111',
              name: 'Sundays at Albany',
              isActive: false,
              recurUntil: '2026-12-16',
            }),
          ],
          [],
        )}
      />,
    );
    expect(html).toContain('Adding sessions…');
    expect(html).toContain('Ended 16 Dec 2026');
    expect(html).toContain('>Sundays at Albany</a>');
    expect(html).not.toContain('No recurring series yet.');
  });

  it('a series row links to the series page with its upcoming count', () => {
    const html = renderToStaticMarkup(
      <SessionList
        {...base}
        upcoming={{ sessions: [published], nextCursor: null }}
        drafts={{ sessions: [], nextCursor: null }}
        past={{ sessions: [], nextCursor: null }}
        series={seriesRows([seriesListItemFixture()], [{ ...published, phase: 'upcoming' }])}
      />,
    );
    expect(html).toMatch(
      new RegExp(
        `<a[^>]*href="/teams/${TEAM_ID}/manage/sessions/series/${RULE_ID}"[^>]*>Wednesdays at Rosedale</a>`,
      ),
    );
    expect(html).toContain('1 upcoming');
  });

  it('pages each section on its own cursor and keeps the other cursors (keyset, plain links)', () => {
    const html = renderToStaticMarkup(
      <SessionList
        {...base}
        current={{ drafts: 'd1' }}
        upcoming={{ sessions: [published], nextCursor: 'u2' }}
        drafts={{ sessions: [draft], nextCursor: null }}
        past={{ sessions: [], nextCursor: null }}
        series={[]}
      />,
    );
    expect(html).toContain(
      `href="/teams/${TEAM_ID}/manage/sessions?drafts=d1&amp;upcoming=u2#upcoming"`,
    );
    expect(html).toContain('aria-label="Next upcoming sessions"');
    expect(html).toContain('aria-label="Back to start of drafts"');
  });
});

describe('CancelSessionConfirm (UI/UX cancel prompts)', () => {
  const open = (session = sessionFixture({ status: 'PUBLISHED', activeRegistrationCount: 12 })) =>
    renderToStaticMarkup(
      <ManageProvider>
        <CancelSessionConfirm teamId={TEAM_ID} session={session} defaultOpen />
      </ManageProvider>,
    );

  it('a published session with players says how many are registered and that nobody is emailed; dismiss is "Keep session"', () => {
    const html = open();
    expect(html).toContain(
      'Cancel this session? 12 players are registered. We won&#x27;t email them, so let them know. No one is charged for it. You can&#x27;t undo this.',
    );
    expect(html).toContain('>Keep session</button>');
    expect(html).not.toContain('>Cancel</button>');
  });

  it('posts the team, session, version and whether it was a draft', () => {
    const html = open(sessionFixture({ status: 'DRAFT' }));
    expect(html).toMatch(/name="expectedVersion"[^>]*value="3"/);
    expect(html).toMatch(/name="wasDraft"[^>]*value="true"/);
    expect(html).toMatch(/name="sessionId"[^>]*value="11111111/);
    expect(html).toContain('>Keep draft</button>');
    expect(html).toContain('Cancel this draft?');
  });

  it('a series date names the date in the draft prompt and the confirm button', () => {
    const html = open(
      sessionFixture({
        status: 'DRAFT',
        recurringRuleId: RULE_ID,
        seriesName: 'Wednesdays at Rosedale',
      }),
    );
    expect(html).toContain('Cancel Wed 4 Nov?');
    expect(html).toContain('>Cancel this date</button>');
  });
});

describe('PublishDraftsButton (AC-ASYNC-7)', () => {
  it('is a form with the team and rule and one button, "Publish drafts now"', () => {
    const html = renderToStaticMarkup(
      <ManageProvider>
        <PublishDraftsButton teamId={TEAM_ID} ruleId={RULE_ID} />
      </ManageProvider>,
    );
    expect(html).toContain('>Publish drafts now</button>');
    expect(html).toMatch(/name="teamId"[^>]*value="7f3c2b1a/);
    expect(html).toMatch(/name="ruleId"[^>]*value="41111111/);
  });
});
