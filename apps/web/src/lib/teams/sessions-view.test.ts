import type {
  DstOptionsEntry,
  SeriesInstanceResponse,
  SeriesResponse,
  SessionResponse,
} from '@sgm/shared';
import { describe, expect, it } from 'vitest';
import { seriesListItemFixture } from './sessions-fixtures.ts';
import {
  LIST_SECTIONS,
  REFRESH_DELAYS_MS,
  cancelPrompt,
  changeNoticeLine,
  createSeriesPrompt,
  defaultEndDate,
  dstView,
  endSeriesImpact,
  feeSummary,
  formatClock,
  formatDateLong,
  formatDay,
  formatDayShort,
  formatTimeRange,
  noticeBanner,
  noticeQuery,
  parseNotice,
  pendingView,
  plural,
  publishPrompt,
  readOnlyReason,
  registeredLine,
  seriesBankingNotice,
  seriesDetailsRows,
  seriesEffect,
  seriesRows,
  seriesPatternLabel,
  seriesSavedLines,
  deadlineReadout,
  seriesStatusLabel,
  seriesSummaryLine,
  sessionHeading,
  sessionLabel,
  sessionScopeLine,
  sessionStatusLine,
  sessionWhen,
  showListBankingNotice,
} from './sessions-view.ts';

const BANKING = '/teams/T/manage/banking?returnTo=%2Fteams%2FT%2Fmanage%2Fsessions';

function session(overrides: Partial<SessionResponse> = {}): SessionResponse {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    teamId: '7f3c2b1a-1111-4222-8333-444455556666',
    recurringRuleId: null,
    status: 'PUBLISHED',
    phase: 'upcoming',
    date: '2026-11-04',
    location: 'Rosedale',
    address: '1 Court Rd',
    maxPlayers: 18,
    reservedSeats: 2,
    courtCost: '180.00',
    extraExpenses: '20.00',
    calculatedRatePerPlayer: '12.00',
    customPlayerRate: null,
    pricingStructure: 'FLAT',
    feeFlat: '12.00',
    feeMale: null,
    feeFemale: null,
    feeOther: null,
    feeBeginner: null,
    feeIntermediate: null,
    feeAdvanced: null,
    startsAt: '2026-11-03T19:00:00.000Z',
    endsAt: '2026-11-03T21:00:00.000Z',
    cancellationDeadline: '2026-11-01T19:00:00.000Z',
    deadlineIsDefault: true,
    isInstanceOverridden: false,
    draftReason: null,
    seriesName: null,
    version: 1,
    activeRegistrationCount: 0,
    feesLocked: null,
    courts: [],
    ...overrides,
  } as SessionResponse;
}

describe('plural and date formatting (copy deck: "Wed 4 Nov 2026", "8:00 am")', () => {
  it('plural picks the singular for exactly one', () => {
    expect(plural(1, 'player')).toBe('1 player');
    expect(plural(0, 'player')).toBe('0 players');
    expect(plural(3, 'court')).toBe('3 courts');
    expect(plural(2, 'person', 'people')).toBe('2 people');
  });

  it.each([
    ['2026-11-04', 'Wed 4 Nov 2026', 'Wed 4 Nov', '4 Nov 2026'],
    ['2026-09-27', 'Sun 27 Sep 2026', 'Sun 27 Sep', '27 Sep 2026'],
    ['2027-01-01', 'Fri 1 Jan 2027', 'Fri 1 Jan', '1 Jan 2027'],
  ])('%s formats as %s', (date, long, short, noWeekday) => {
    expect(formatDay(date)).toBe(long);
    expect(formatDayShort(date)).toBe(short);
    expect(formatDateLong(date)).toBe(noWeekday);
  });

  it.each([
    ['08:00', '8:00 am'],
    ['00:00', '12:00 am'],
    ['12:30', '12:30 pm'],
    ['18:05', '6:05 pm'],
    ['24:00', '12:00 am'],
  ])('%s reads %s', (time, text) => {
    expect(formatClock(time)).toBe(text);
  });

  it('ranges are compact on the list and spelled out in the series summary', () => {
    expect(formatTimeRange('08:00', '10:00', 'compact')).toBe('8:00-10:00 am');
    expect(formatTimeRange('09:00', '13:00', 'compact')).toBe('9:00 am-1:00 pm');
    expect(formatTimeRange('08:00', '10:00', 'full')).toBe('8:00 am-10:00 am');
  });

  it('a session shows its NZ day and range from its instants, and only the day when it has no courts', () => {
    expect(sessionWhen(session())).toEqual({
      day: 'Wed 4 Nov 2026',
      range: '8:00-10:00 am',
      text: 'Wed 4 Nov 2026, 8:00-10:00 am',
    });
    expect(sessionWhen(session({ startsAt: null, endsAt: null }))).toEqual({
      day: 'Wed 4 Nov 2026',
      range: null,
      text: 'Wed 4 Nov 2026',
    });
  });
});

describe('deadline readout', () => {
  it('is the default deadline (48 hours before the first court) in NZ time, or null with no start', () => {
    expect(deadlineReadout('2026-11-03T19:00:00.000Z')).toBe('Mon 2 Nov, 8:00 am');
    expect(deadlineReadout(null)).toBeNull();
  });
});

describe('list sections (copy deck "Sessions list")', () => {
  it('has the four sections with their empty states', () => {
    expect(LIST_SECTIONS.map((section) => [section.id, section.title, section.empty])).toEqual([
      ['upcoming', 'Upcoming', 'No upcoming sessions. Published sessions appear here.'],
      ['drafts', 'Drafts', 'No drafts.'],
      ['series', 'Series', 'No recurring series yet.'],
      ['past', 'Past and cancelled', 'Nothing here yet.'],
    ]);
  });
});

describe('status labels (T-11, copy deck "Status labels" and "Draft labels")', () => {
  const configured = { isPayoutConfigured: true };
  const unconfigured = { isPayoutConfigured: false };

  it.each([
    [{ status: 'PUBLISHED', phase: 'upcoming' }, unconfigured, 'Published', []],
    [{ status: 'PUBLISHED', phase: 'started' }, unconfigured, 'Started', []],
    [{ status: 'PUBLISHED', phase: 'ended' }, unconfigured, 'Ended', []],
    [{ status: 'COMPLETED', phase: 'ended' }, unconfigured, 'Completed', []],
    [{ status: 'CANCELLED', phase: 'upcoming' }, unconfigured, 'Cancelled', []],
    [{ status: 'DRAFT', phase: 'upcoming', draftReason: 'admin' }, unconfigured, 'Draft', []],
    [{ status: 'DRAFT', phase: 'upcoming', draftReason: null }, unconfigured, 'Draft', []],
    [
      { status: 'DRAFT', phase: 'upcoming', draftReason: 'banking' },
      unconfigured,
      'Draft · bank account needed',
      [],
    ],
    [
      { status: 'DRAFT', phase: 'upcoming', draftReason: 'banking' },
      configured,
      'Draft · publishes overnight',
      [],
    ],
    [
      { status: 'DRAFT', phase: 'upcoming', draftReason: 'edited', isInstanceOverridden: true },
      configured,
      'Draft · Edited',
      [],
    ],
    [
      { status: 'DRAFT', phase: 'started', draftReason: 'admin' },
      configured,
      'Not published · date passed',
      [],
    ],
    [
      { status: 'DRAFT', phase: 'ended', draftReason: 'banking' },
      configured,
      'Not published · date passed',
      [],
    ],
  ] as const)('%j with %j reads "%s"', (input, payout, label, tags) => {
    const view = sessionLabel(session(input), payout);
    expect(view.label).toBe(label);
    expect(view.tags).toEqual(tags);
  });

  it('an edited published date is tagged Edited, and a series date is tagged with the series name', () => {
    const view = sessionLabel(
      session({ isInstanceOverridden: true, seriesName: 'Wednesdays at Rosedale' }),
      { isPayoutConfigured: true },
    );
    expect(view.tags).toEqual(['Edited', 'Series: Wednesdays at Rosedale']);
  });

  it('an edited draft is not tagged Edited twice', () => {
    const view = sessionLabel(
      session({ status: 'DRAFT', draftReason: 'edited', isInstanceOverridden: true }),
      { isPayoutConfigured: true },
    );
    expect(view.tags).toEqual([]);
  });

  it('the page-level banking notice shows from the API count while banking is missing, whatever rows are loaded', () => {
    expect(showListBankingNotice(1, false)).toBe(true);
    expect(showListBankingNotice(30, false)).toBe(true);
    expect(showListBankingNotice(1, true)).toBe(false);
    expect(showListBankingNotice(0, false)).toBe(false);
  });
});

describe('series on the list', () => {
  it('builds a row per listed series, with its status, and counts upcoming dates from the sessions it was given', () => {
    const rule = '41111111-1111-4111-8111-111111111111';
    const other = '51111111-1111-4111-8111-111111111111';
    const rows = seriesRows(
      [
        seriesListItemFixture({ id: rule }),
        seriesListItemFixture({
          id: other,
          name: 'Sundays at Albany',
          isActive: false,
          recurUntil: '2026-12-16',
        }),
      ],
      [
        session({ recurringRuleId: rule }),
        session({ recurringRuleId: rule, phase: 'ended' }),
        session({ recurringRuleId: other }),
        session(),
      ],
    );
    expect(rows).toEqual([
      {
        ruleId: rule,
        name: 'Wednesdays at Rosedale',
        statusText: 'Active',
        upcomingText: '1 upcoming',
      },
      {
        ruleId: other,
        name: 'Sundays at Albany',
        statusText: 'Ended 16 Dec 2026',
        upcomingText: '1 upcoming',
      },
    ]);
  });

  it('a series with no loaded dates, or still being created, still has a row and says no count it cannot know', () => {
    const rows = seriesRows(
      [
        seriesListItemFixture({ materialising: true }),
        seriesListItemFixture({ id: '51111111-1111-4111-8111-111111111111' }),
      ],
      [],
    );
    expect(rows.map((r) => [r.statusText, r.upcomingText])).toEqual([
      ['Adding sessions…', null],
      ['Active', null],
    ]);
  });

  it.each([
    [{ isActive: true, materialising: false, recurUntil: null }, 'Active'],
    [{ isActive: true, materialising: true, recurUntil: null }, 'Adding sessions…'],
    [{ isActive: false, materialising: false, recurUntil: '2026-12-16' }, 'Ended 16 Dec 2026'],
    // A series past its last date arrives from the API with isActive false (read-time rule): ended beats adding.
    [{ isActive: false, materialising: true, recurUntil: '2026-10-14' }, 'Ended 14 Oct 2026'],
  ])('%j reads "%s"', (series, label) => {
    expect(seriesStatusLabel(series)).toBe(label);
  });
});

describe('editor heading, scope, status and registrations (copy deck "Session editor")', () => {
  it('headings', () => {
    expect(sessionHeading(null)).toBe('New session');
    expect(sessionHeading(session())).toBe('Rosedale, Wed 4 Nov 2026');
  });

  it('scope lines: one-off, series unedited, series edited', () => {
    expect(sessionScopeLine({ seriesName: null, date: '2026-11-04', edited: false })).toBe(
      'One-off session. When you publish it, members on Auto Enroll are added to it.',
    );
    expect(
      sessionScopeLine({ seriesName: 'Wednesdays at Rosedale', date: '2026-11-04', edited: false }),
    ).toBe(
      "One date in Wednesdays at Rosedale. Changes here apply to Wed 4 Nov only. Once you save a change, this date is marked Edited and changes to the series won't overwrite it.",
    );
    expect(
      sessionScopeLine({ seriesName: 'Wednesdays at Rosedale', date: '2026-11-04', edited: true }),
    ).toBe(
      "Edited. This date has its own details, so changes to Wednesdays at Rosedale don't apply to it.",
    );
  });

  it.each([
    [
      { status: 'DRAFT', draftReason: 'admin' },
      true,
      false,
      "Draft. Members can't see it until you publish it.",
    ],
    [
      { status: 'DRAFT', draftReason: 'edited' },
      true,
      false,
      "This date has been edited, so it won't be published automatically. Publish it when it's ready.",
    ],
    [
      { status: 'DRAFT', draftReason: 'banking' },
      false,
      false,
      "This session wasn't published because your team's bank account isn't set up.",
    ],
    [
      { status: 'DRAFT', draftReason: 'banking' },
      true,
      false,
      'This session is still a draft. It will be published overnight, or you can publish it now.',
    ],
    [{ status: 'PUBLISHED', draftReason: null }, true, false, 'Published. Members can register.'],
    [
      { status: 'PUBLISHED', draftReason: null },
      true,
      true,
      'Published. Members can register. Members on Auto Enroll are being added.',
    ],
  ] as const)('%j (payout %s, just published %s)', (input, payout, justPublished, text) => {
    const view = sessionStatusLine(session(input), {
      isPayoutConfigured: payout,
      justPublished,
    });
    expect(view.text).toBe(text);
  });

  it('the banking draft status carries the Set up banking and GST link; others do not', () => {
    const banking = sessionStatusLine(session({ status: 'DRAFT', draftReason: 'banking' }), {
      isPayoutConfigured: false,
      justPublished: false,
    });
    expect(banking.link).toBe('Set up banking and GST');
    const plain = sessionStatusLine(session(), { isPayoutConfigured: true, justPublished: false });
    expect(plain.link).toBeNull();
  });

  it.each([
    [0, 'No one has registered yet.'],
    [1, '1 player is registered.'],
    [12, '12 players are registered.'],
  ])('registrations line for %s', (n, text) => {
    expect(registeredLine(n)).toBe(text);
  });

  it('change notice only when players are registered (P-2: no email wording)', () => {
    expect(changeNoticeLine(0)).toBeNull();
    expect(changeNoticeLine(12)).toBe(
      "12 players are registered. We don't email them about changes, so let them know if you change the date, times, place, cancellation deadline or fees.",
    );
    expect(changeNoticeLine(1)).toContain('1 player is registered.');
    expect(changeNoticeLine(12)).not.toMatch(/we.ll email/i);
  });
});

describe('read-only reasons (copy deck "Read-only")', () => {
  it.each([
    [
      { status: 'PUBLISHED', phase: 'started' },
      "This session has started, so it can't be changed or cancelled.",
    ],
    [{ status: 'PUBLISHED', phase: 'ended' }, "This session has ended, so it can't be changed."],
    [{ status: 'COMPLETED', phase: 'ended' }, "This session is complete, so it can't be changed."],
    [
      { status: 'CANCELLED', phase: 'upcoming' },
      "This session was cancelled, so it can't be changed.",
    ],
    [
      { status: 'DRAFT', phase: 'started' },
      "This draft's start time passed before it was published, so it can't be published or changed.",
    ],
    [{ status: 'PUBLISHED', phase: 'upcoming' }, null],
    [{ status: 'DRAFT', phase: 'upcoming' }, null],
  ] as const)('%j', (input, reason) => {
    expect(readOnlyReason(session(input as Partial<SessionResponse>))).toBe(reason);
  });
});

describe('cancel prompt variants (copy deck "Cancel and read-only", P-2)', () => {
  const base = { triggerLabel: 'Cancel session' };

  it('one-off draft', () => {
    expect(cancelPrompt({ status: 'DRAFT', seriesDate: null, activeRegistrationCount: 0 })).toEqual(
      {
        ...base,
        prompt: "Cancel this draft? It won't be published, and you can't undo this.",
        confirmLabel: 'Cancel draft',
        dismissLabel: 'Keep draft',
      },
    );
  });

  it('series draft names the date and says the series will not add it again', () => {
    expect(
      cancelPrompt({ status: 'DRAFT', seriesDate: '2026-11-04', activeRegistrationCount: 0 }),
    ).toEqual({
      ...base,
      prompt: "Cancel Wed 4 Nov? The series won't add this date again, and you can't undo this.",
      confirmLabel: 'Cancel this date',
      dismissLabel: 'Keep draft',
    });
  });

  it('published with no one registered, one-off and series', () => {
    const oneOff = cancelPrompt({
      status: 'PUBLISHED',
      seriesDate: null,
      activeRegistrationCount: 0,
    });
    expect(oneOff.prompt).toBe(
      "Cancel this session? No one has registered yet. You can't undo this.",
    );
    expect(oneOff.confirmLabel).toBe('Cancel session');
    expect(oneOff.dismissLabel).toBe('Keep session');
    const series = cancelPrompt({
      status: 'PUBLISHED',
      seriesDate: '2026-11-04',
      activeRegistrationCount: 0,
    });
    expect(series.prompt).toBe(
      "Cancel this session? No one has registered yet. You can't undo this. The series won't add this date again.",
    );
  });

  it('published with players registered states the count and that no one is emailed', () => {
    expect(
      cancelPrompt({ status: 'PUBLISHED', seriesDate: null, activeRegistrationCount: 9 }).prompt,
    ).toBe(
      "Cancel this session? 9 players are registered. We won't email them, so let them know. No one is charged for it. You can't undo this.",
    );
  });

  it('no dismiss label is ever just "Cancel" beside a Cancel action', () => {
    for (const status of ['DRAFT', 'PUBLISHED'] as const) {
      for (const seriesDate of [null, '2026-11-04']) {
        expect(
          cancelPrompt({ status, seriesDate, activeRegistrationCount: 2 }).dismissLabel,
        ).not.toBe('Cancel');
      }
    }
  });
});

describe('fee summary and confirm prompts (P-1: Auto Enroll for every session)', () => {
  it.each([
    [{ pricingStructure: 'FLAT', feeFlat: '12.00' }, '$12.00 each'],
    [
      { pricingStructure: 'BY_SEX', feeMale: '17.00', feeFemale: '16.00', feeOther: '16.00' },
      '$17.00 male, $16.00 female, $16.00 other',
    ],
    [
      {
        pricingStructure: 'BY_SKILL_LEVEL',
        feeBeginner: '10.00',
        feeIntermediate: '12.00',
        feeAdvanced: '14.00',
      },
      '$10.00 beginner, $12.00 intermediate, $14.00 advanced',
    ],
    [{ pricingStructure: 'FLAT', feeFlat: '0.00' }, null],
    [{ pricingStructure: 'BY_SEX', feeMale: '0.00', feeFemale: '0.00', feeOther: '0.00' }, null],
  ])('%j summarises as %j (null means free)', (fees, text) => {
    expect(
      feeSummary({
        feeFlat: null,
        feeMale: null,
        feeFemale: null,
        feeOther: null,
        feeBeginner: null,
        feeIntermediate: null,
        feeAdvanced: null,
        ...fees,
      } as never),
    ).toBe(text);
  });

  it('the publish prompt always mentions Auto Enroll, and charges only paid sessions', () => {
    expect(publishPrompt('$12.00 each')).toBe(
      'Publish this session? Members can register straight away, and each player is charged after the game: $12.00 each. Members on Auto Enroll will be added to it.',
    );
    expect(publishPrompt(null)).toBe(
      'Publish this session? Members can register straight away. Members on Auto Enroll will be added to it.',
    );
  });

  it('the create-series prompt adds the charge and the draft warning only when they apply', () => {
    const plain = createSeriesPrompt({
      firstDate: '2026-11-04',
      feeSummary: null,
      bankingMissing: false,
    });
    expect(plain).toBe(
      'Create this series? Sessions from Wed 4 Nov are added now and published for registration. Members on Auto Enroll are added to each one.',
    );
    const full = createSeriesPrompt({
      firstDate: '2026-11-04',
      feeSummary: '$12.00 each',
      bankingMissing: true,
    });
    expect(full).toBe(
      "Create this series? Sessions from Wed 4 Nov are added now and published for registration. Members on Auto Enroll are added to each one. Each player is charged after the game: $12.00 each. Your team's bank account isn't set up, so the sessions will be saved as drafts until it is.",
    );
  });
});

function series(overrides: Partial<SeriesResponse> = {}): SeriesResponse {
  return {
    id: '41111111-1111-4111-8111-111111111111',
    teamId: '7f3c2b1a-1111-4222-8333-444455556666',
    name: 'Wednesdays at Rosedale',
    frequency: 'WEEKLY',
    dayOfWeek: 3,
    startsOn: '2026-11-04',
    monthlyWeek: null,
    recurUntil: null,
    isActive: true,
    version: 2,
    materialising: false,
    location: 'Rosedale',
    address: '1 Court Rd',
    maxPlayers: 18,
    reservedSeats: 0,
    courtCost: '180.00',
    extraExpenses: '20.00',
    calculatedRatePerPlayer: '12.00',
    customPlayerRate: null,
    pricingStructure: 'FLAT',
    feeFlat: '12.00',
    feeMale: null,
    feeFemale: null,
    feeOther: null,
    feeBeginner: null,
    feeIntermediate: null,
    feeAdvanced: null,
    courts: [
      { identifier: 'Court 1', startTime: '08:00', endTime: '10:00' },
      { identifier: 'Court 2', startTime: '08:00', endTime: '09:00' },
    ],
    isPayoutConfigured: true,
    bankingDrafts: 0,
    editedDrafts: 0,
    instances: [],
    ...overrides,
  } as SeriesResponse;
}

function instance(overrides: Partial<SeriesInstanceResponse> = {}): SeriesInstanceResponse {
  return {
    id: '61111111-1111-4111-8111-111111111111',
    date: '2026-11-04',
    startsAt: '2026-11-03T19:00:00.000Z',
    endsAt: '2026-11-03T21:00:00.000Z',
    status: 'PUBLISHED',
    phase: 'upcoming',
    draftReason: null,
    isInstanceOverridden: false,
    activeRegistrationCount: 0,
    version: 1,
    seriesChangeEffect: 'will_update',
    ...overrides,
  };
}

describe('series summary (copy deck "Series")', () => {
  it.each([
    [{ frequency: 'WEEKLY', dayOfWeek: 3, monthlyWeek: null }, 'Weekly on Wednesdays'],
    [{ frequency: 'FORTNIGHTLY', dayOfWeek: 0, monthlyWeek: null }, 'Every 2 weeks on Sundays'],
    [{ frequency: 'MONTHLY', dayOfWeek: 3, monthlyWeek: 2 }, 'Monthly on the second Wednesday'],
    [{ frequency: 'MONTHLY', dayOfWeek: 5, monthlyWeek: -1 }, 'Monthly on the last Friday'],
  ] as const)('%j reads "%s"', (input, text) => {
    expect(seriesPatternLabel(input)).toBe(text);
  });

  it('one line: pattern, time span over the template courts, courts, fee, from and until', () => {
    expect(seriesSummaryLine(series())).toBe(
      'Weekly on Wednesdays · 8:00 am-10:00 am · 2 courts · $12.00 each · from 4 Nov 2026 · no end date',
    );
    expect(seriesSummaryLine(series({ recurUntil: '2026-12-16' }))).toContain('until 16 Dec 2026');
  });

  it('details rows are Repeats, First session and Repeat until', () => {
    expect(seriesDetailsRows(series())).toEqual([
      { term: 'Repeats', value: 'Weekly on Wednesdays' },
      { term: 'First session', value: '4 Nov 2026' },
      { term: 'Repeat until', value: 'No end date' },
    ]);
    expect(seriesDetailsRows(series({ recurUntil: '2026-12-16' }))[2]?.value).toBe('16 Dec 2026');
  });
});

describe('series change effect line (T-5)', () => {
  it('counts upcoming updates, edited keeps and registered fee limits from the instances', () => {
    const effect = seriesEffect([
      instance({ seriesChangeEffect: 'will_update' }),
      instance({ seriesChangeEffect: 'will_update' }),
      instance({ seriesChangeEffect: 'has_registrations' }),
      instance({ seriesChangeEffect: 'edited' }),
      instance({ seriesChangeEffect: 'closed' }),
    ]);
    expect(effect).toEqual({
      updated: 3,
      edited: 1,
      registered: 1,
      line: "Your changes will apply to 3 upcoming sessions and to sessions added later. 1 edited session keeps its own details. 1 published session has a player who has registered or still owes a late-withdrawal fee, so fees on it can only be lowered. Started, past and cancelled sessions don't change.",
    });
  });

  it('with nothing upcoming it says so', () => {
    expect(seriesEffect([instance({ seriesChangeEffect: 'closed' })]).line).toBe(
      'Your changes will apply to sessions added later.',
    );
  });

  it('omits the edited and registered sentences when there are none, and pluralises', () => {
    expect(seriesEffect([instance()]).line).toBe(
      "Your changes will apply to 1 upcoming session and to sessions added later. Started, past and cancelled sessions don't change.",
    );
  });
});

describe('series banking notices (S2b, S2r) and the waiting state', () => {
  it('S2b while banking is not set up', () => {
    expect(seriesBankingNotice(series({ bankingDrafts: 2, isPayoutConfigured: false }))).toEqual({
      kind: 'needed',
      text: "2 sessions in this series were saved as drafts because your team's bank account isn't set up. Members can't register for them yet.",
      link: 'Set up banking and GST',
      button: null,
    });
    expect(
      seriesBankingNotice(series({ bankingDrafts: 1, isPayoutConfigured: false }))?.text,
    ).toContain('1 session in this series was saved as a draft');
  });

  it('S2r once banking is set up, with the edited-drafts sentence and the publish button', () => {
    expect(
      seriesBankingNotice(series({ bankingDrafts: 2, editedDrafts: 1, isPayoutConfigured: true })),
    ).toEqual({
      kind: 'ready',
      text: "Your bank account is set up. 2 sessions in this series are still drafts. They'll be published automatically overnight, or you can publish them now. 1 edited draft needs you to publish it yourself.",
      link: null,
      button: 'Publish drafts now',
    });
  });

  it('no notice when nothing waits on banking', () => {
    expect(seriesBankingNotice(series({ bankingDrafts: 0, editedDrafts: 3 }))).toBeNull();
  });

  it('bounded refresh at 2, 5 and 10 seconds, then the slow-path text', () => {
    expect(REFRESH_DELAYS_MS).toEqual([2000, 5000, 10000]);
    expect(pendingView({ pending: true, refreshesDone: 0 })).toEqual({
      kind: 'waiting',
      text: "We're adding the sessions in this series. Refresh in a moment.",
    });
    expect(pendingView({ pending: true, refreshesDone: 2 }).kind).toBe('waiting');
    expect(pendingView({ pending: true, refreshesDone: 3 })).toEqual({
      kind: 'slow',
      text: 'This is taking longer than usual. Your series is saved and its sessions will appear here. Refresh in a minute.',
    });
    expect(pendingView({ pending: false, refreshesDone: 1 })).toEqual({ kind: 'done', text: '' });
  });
});

describe('End series impact (T-6, computed client-side from the instances)', () => {
  const instances = [
    instance({ date: '2026-11-04', status: 'PUBLISHED' }),
    instance({
      date: '2026-11-11',
      status: 'DRAFT',
      isInstanceOverridden: false,
      draftReason: 'banking',
    }),
    instance({
      date: '2026-11-18',
      status: 'DRAFT',
      isInstanceOverridden: false,
      draftReason: 'banking',
    }),
    instance({
      date: '2026-11-25',
      status: 'DRAFT',
      isInstanceOverridden: true,
      draftReason: 'edited',
    }),
    instance({ date: '2026-12-02', status: 'PUBLISHED', activeRegistrationCount: 4 }),
    instance({ date: '2026-12-09', status: 'PUBLISHED', activeRegistrationCount: 5 }),
    instance({ date: '2026-12-16', status: 'CANCELLED' }),
  ];

  it('counts what falls after the chosen last date', () => {
    const impact = endSeriesImpact(instances, '2026-11-04', false);
    expect(impact).toMatchObject({ deleted: 2, keptEdited: 1, published: 2, players: 9 });
    expect(impact.lines).toEqual([
      '2 unedited draft sessions after this date will be deleted.',
      '1 edited draft and 2 published sessions after this date will be kept.',
    ]);
    expect(impact.checkboxLabel).toBe('Also cancel the 2 published sessions after this date');
  });

  it('ticking the box cancels the published sessions and adds the registered-players line', () => {
    expect(endSeriesImpact(instances, '2026-11-04', true).lines).toEqual([
      '2 unedited draft sessions after this date will be deleted.',
      '1 edited draft after this date will be kept, and the 2 published sessions will be cancelled.',
      "9 players are registered for them. We won't email them, so let them know.",
    ]);
  });

  it('no registered players: no players line even when cancelling', () => {
    const lines = endSeriesImpact([instance({ date: '2026-12-02' })], '2026-11-04', true).lines;
    expect(lines).toEqual(['The 1 published session will be cancelled.']);
  });

  it('nothing after the date: a plain line and no checkbox', () => {
    const impact = endSeriesImpact(instances, '2027-01-01', false);
    expect(impact.lines).toEqual(['No sessions come after this date.']);
    expect(impact.checkboxLabel).toBeNull();
  });

  it('a started or invalid date computes nothing', () => {
    expect(endSeriesImpact(instances, '', false).lines).toEqual([]);
  });
});

describe('series save report (T-5): counts only from the response outcome', () => {
  it('reports updated and kept-edited counts', () => {
    expect(
      seriesSavedLines({
        updated: 4,
        unchanged: 0,
        skipped: { edited: 1, started: 0, closed: 0, deadlinePassed: 0, feeLocked: 0 },
      }),
    ).toEqual([
      'Series saved. 4 upcoming sessions updated.',
      '1 edited session kept its own details.',
    ]);
  });

  it('lists the other skip reasons, and says so when nothing was upcoming', () => {
    expect(
      seriesSavedLines({
        updated: 1,
        unchanged: 0,
        skipped: { edited: 0, started: 1, closed: 1, deadlinePassed: 2, feeLocked: 3 },
      }),
    ).toEqual([
      'Series saved. 1 upcoming session updated.',
      '2 sessions were left as they are because they have started or closed.',
      '2 published sessions were left as they are because their cancellation deadline has passed.',
      '3 published sessions kept their current fees because a player has registered or still owes a late-withdrawal fee, and fees can only be lowered.',
    ]);
    expect(
      seriesSavedLines({
        updated: 0,
        unchanged: 0,
        skipped: { edited: 0, started: 0, closed: 0, deadlinePassed: 0, feeLocked: 0 },
      }),
    ).toEqual(['Series saved. Sessions added later will use the new details.']);
  });
});

describe('DST choice view (copy deck "DST choice", T-10)', () => {
  const gap: DstOptionsEntry = {
    field: 'courts.0.startTime',
    date: '2026-09-27',
    time: '02:30',
    kind: 'nonexistent',
    options: [
      { choice: 'shiftedForward', localTime: '03:30', instant: '2026-09-26T14:30:00.000Z' },
      { choice: 'shiftedBackward', localTime: '01:30', instant: '2026-09-26T13:30:00.000Z' },
    ],
  };
  const overlap: DstOptionsEntry = {
    field: 'courts.0.endTime',
    date: '2027-04-04',
    time: '02:30',
    kind: 'ambiguous',
    options: [
      { choice: 'earlier', localTime: '02:30', instant: '2027-04-03T13:30:00.000Z' },
      { choice: 'later', localTime: '02:30', instant: '2027-04-03T14:30:00.000Z' },
    ],
  };

  it('a gap offers both shifted times', () => {
    expect(dstView(gap, 'court')).toEqual({
      message:
        "2:30 am doesn't happen on Sun 27 Sep 2026, because clocks go forward an hour at 2 am.",
      buttons: [
        { choice: 'shiftedForward', label: 'Use 3:30 am' },
        { choice: 'shiftedBackward', label: 'Use 1:30 am' },
      ],
    });
  });

  it('a court overlap offers only the first, with its zone abbreviation taken from the instant', () => {
    expect(dstView(overlap, 'court')).toEqual({
      message:
        "2:30 am happens twice on Sun 4 Apr 2027, because clocks go back an hour at 3 am. We'll use the first one.",
      buttons: [{ choice: 'earlier', label: 'Use the first 2:30 am (NZDT)' }],
    });
  });

  it('a deadline overlap offers both', () => {
    const view = dstView(overlap, 'deadline');
    expect(view.message).toBe(
      '2:30 am happens twice on Sun 4 Apr 2027, because clocks go back an hour at 3 am. Choose which one you mean.',
    );
    expect(view.buttons).toEqual([
      { choice: 'earlier', label: 'Use the first 2:30 am (NZDT)' },
      { choice: 'later', label: 'Use the second 2:30 am (NZST)' },
    ]);
  });
});

describe('notices: closed code list, codes-only query, fixed text', () => {
  const ctx = { bankingHref: BANKING };
  const text = (query: Record<string, string>) => {
    const notice = parseNotice(query);
    expect(notice).not.toBeNull();
    return noticeBanner(notice!, ctx);
  };

  it.each([
    [{ notice: 'draft_saved' }, 'notice', 'Draft saved.'],
    [{ notice: 'published' }, 'notice', 'Session published. Members can now register.'],
    [{ notice: 'changes_saved' }, 'notice', 'Changes saved.'],
    [
      { notice: 'changes_saved', material: '1', registered: '0' },
      'notice',
      'Changes saved. No one had registered.',
    ],
    [
      { notice: 'changes_saved', material: '1', registered: '12' },
      'notice',
      'Changes saved. 12 players were registered. Let them know about the change.',
    ],
    [
      { notice: 'changes_saved', material: '1', registered: '1', promoted: '2' },
      'notice',
      'Changes saved. 1 player was registered. Let them know about the change. 2 players moved off the waitlist.',
    ],
    [
      { notice: 'instance_saved_first', date: '2026-11-04' },
      'notice',
      'Changes saved for Wed 4 Nov. This date is now marked Edited.',
    ],
    [{ notice: 'nothing_changed' }, 'notice', 'Nothing to change.'],
    [{ notice: 'cancelled_draft' }, 'notice', 'Draft cancelled.'],
    [
      { notice: 'cancelled', registered: '0' },
      'notice',
      'Session cancelled. No one had registered.',
    ],
    [
      { notice: 'cancelled', registered: '9' },
      'notice',
      "Session cancelled. 9 players were registered. Let them know it's cancelled.",
    ],
    [{ notice: 'series_created' }, 'notice', 'Series created.'],
    [
      { notice: 'series_saved', count: '4', edited: '1' },
      'notice',
      'Series saved. 4 upcoming sessions updated. 1 edited session kept its own details.',
    ],
    [{ notice: 'series_nothing_changed' }, 'notice', 'Nothing to change.'],
    [
      { notice: 'series_ended', date: '2026-12-16' },
      'notice',
      'Series ended. No new sessions will be added after 16 Dec 2026.',
    ],
    [
      { notice: 'series_ended', date: '2026-12-16', cancelled: '3', registered: '9' },
      'notice',
      'Series ended. No new sessions will be added after 16 Dec 2026. 3 sessions after that date were cancelled. 9 players were registered for them. Let them know.',
    ],
    [
      { notice: 'publishing_drafts' },
      'notice',
      "We're publishing the drafts in this series. Refresh in a moment.",
    ],
    [
      { notice: 'session_stale' },
      'error',
      'This session changed since you opened it. Review the latest version and save again. Your unsaved changes were not kept.',
    ],
    [
      { notice: 'series_stale' },
      'error',
      'This series changed since you opened it. Review the latest version and save again. Your unsaved changes were not kept.',
    ],
    [
      { notice: 'session_started' },
      'error',
      "This session has started, so it can't be changed or cancelled.",
    ],
    [{ notice: 'session_not_editable' }, 'error', "This session can't be changed any more."],
  ])('%j', (query, kind, copy) => {
    const banner = text(query);
    expect(banner.kind).toBe(kind);
    expect(banner.lines.join(' ')).toBe(copy);
  });

  it('the banking refusals are errors with the verbatim API message and the banking link', () => {
    const one = text({ notice: 'publish_refused_banking' });
    expect(one.kind).toBe('error');
    expect(one.lines).toEqual([
      "Add your team's bank account details before publishing a paid session.",
      'Your changes are saved as a draft.',
    ]);
    expect(one.links).toEqual([{ label: 'Set up banking and GST', href: BANKING }]);
    const many = text({ notice: 'series_banking_refused' });
    expect(many.lines).toEqual([
      "Add your team's bank account details before publishing a paid session.",
      'Nothing was saved.',
    ]);
    expect(many.links).toEqual([{ label: 'Set up banking and GST', href: BANKING }]);
  });

  it('only a closed list of codes parses; unknown, repeated and malformed input is dropped', () => {
    expect(parseNotice({})).toBeNull();
    expect(parseNotice({ notice: 'nope' })).toBeNull();
    expect(parseNotice({ notice: ['draft_saved', 'published'] })).toBeNull();
    expect(parseNotice({ notice: '<script>' })).toBeNull();
  });

  it('counts must be integers 0 to 999; a bad count or date is dropped, never echoed', () => {
    const notice = parseNotice({
      notice: 'series_saved',
      count: '1000',
      edited: '-1',
      started: '2.5',
      closed: 'x',
      date: 'not-a-date',
      registered: '7',
    });
    expect(notice).toEqual({ code: 'series_saved', counts: { registered: 7 }, date: null });
    expect(noticeBanner(notice!, ctx).lines.join(' ')).toBe(
      'Series saved. Sessions added later will use the new details.',
    );
  });

  it('builds the query string the actions redirect with, and it parses back', () => {
    const query = noticeQuery('series_saved', { count: 4, edited: 1 });
    expect(query).toBe('notice=series_saved&count=4&edited=1');
    const params = Object.fromEntries(new URLSearchParams(query));
    expect(parseNotice(params)).toEqual({
      code: 'series_saved',
      counts: { count: 4, edited: 1 },
      date: null,
    });
    expect(noticeQuery('series_ended', { cancelled: 3 }, '2026-12-16')).toBe(
      'notice=series_ended&cancelled=3&date=2026-12-16',
    );
    expect(noticeQuery('draft_saved')).toBe('notice=draft_saved');
  });
});

describe('defaultEndDate', () => {
  it('is today once the series has started, and the first session while it has not (the API refuses a last date before the first)', () => {
    expect(defaultEndDate('2026-10-20', '2026-10-14')).toBe('2026-10-20');
    expect(defaultEndDate('2026-10-20', '2026-10-20')).toBe('2026-10-20');
    expect(defaultEndDate('2026-10-20', '2026-10-23')).toBe('2026-10-23');
  });
});
