import { describe, expect, it } from 'vitest';
import {
  horizonLine,
  nextSeriesDate,
  noSessionsYetLine,
  noticeBanner,
  parseNotice,
  sessionErrorBanner,
  splitSeriesInstances,
} from './sessions-view.ts';
import { instanceFixture } from './sessions-fixtures.ts';

const HREF = '/teams/T/manage/banking?returnTo=%2Fteams%2FT%2Fmanage%2Fsessions%2FS';

describe('sessionErrorBanner (the in-place page error of a Sessions form)', () => {
  it.each([
    ['forbidden', "You don't have access to manage this team."],
    ['not_found', "We couldn't find that session. It may have been removed."],
    ['save_failed', "We couldn't save that. Nothing was changed. Try again."],
    [
      'unconfirmed',
      "We couldn't confirm that was saved. Try again; saving the same change twice is safe.",
    ],
    [
      'offline',
      'Something went wrong on our side. Your details are still here. Try again in a minute.',
    ],
    [
      'session_fee_locked',
      'Fees can only be lowered: a player has registered or still owes a late-withdrawal fee.',
    ],
    ['publish_incomplete', 'Your other changes are saved as a draft.'],
  ])('%s reads "%s" as an error banner', (code, headline) => {
    const banner = sessionErrorBanner(code, { bankingHref: HREF });
    expect(banner?.kind).toBe('error');
    expect(banner?.lines[0]).toBe(headline);
    expect(banner?.links).toEqual([]);
  });

  it('a banking refusal says nothing was saved and links to banking with the page as returnTo (AC-ERROR-1)', () => {
    expect(sessionErrorBanner('payout_not_configured', { bankingHref: HREF })).toEqual({
      kind: 'error',
      lines: [
        "Add your team's bank account details before publishing a paid session.",
        'Nothing was saved.',
      ],
      links: [{ label: 'Set up banking and GST', href: HREF }],
    });
  });

  it('an unknown code is the outage text, never a raw code', () => {
    expect(sessionErrorBanner('something_else', { bankingHref: HREF })?.lines[0]).toMatch(
      /Something went wrong/,
    );
  });
});

describe('the two notices 5C adds to the closed list', () => {
  it('parses publish_incomplete and series_already_ended and words them as errors', () => {
    const incomplete = parseNotice({ notice: 'publish_incomplete' });
    expect(incomplete).not.toBeNull();
    expect(noticeBanner(incomplete!, { bankingHref: HREF })).toMatchObject({
      kind: 'error',
      lines: [
        'Your other changes are saved as a draft.',
        "It couldn't be published yet. Check the pricing and courts, then publish again.",
      ],
    });
    const ended = parseNotice({ notice: 'series_already_ended' });
    expect(noticeBanner(ended!, { bankingHref: HREF })).toMatchObject({
      kind: 'error',
      lines: ["This series has ended, so it can't be changed."],
    });
  });
});

const WEEKLY = {
  frequency: 'WEEKLY',
  dayOfWeek: 3,
  startsOn: '2026-11-04',
  monthlyWeek: null,
  recurUntil: null,
} as const;

describe('the horizon line and the empty series line (copy deck "Series")', () => {
  it('has no horizon of its own: it is a required argument, the API value (7-91), never a web constant', () => {
    expect(nextSeriesDate(WEEKLY, '2026-11-04', 56)).toEqual({
      date: '2027-01-06',
      addedOn: '2026-11-11',
    });
    expect(horizonLine({ date: '2027-01-06', addedOn: '2026-11-11' }, 56)).toBe(
      'Sessions are added 56 days ahead. The next one, Wed 6 Jan, will be added on Wed 11 Nov.',
    );
  });

  it('the next date is the first one after today plus the horizon, and it is added that many days before', () => {
    // Today Wed 4 Nov: the window ends Wed 2 Dec, so the next to be added is Wed 9 Dec, on Wed 11 Nov.
    expect(nextSeriesDate(WEEKLY, '2026-11-04', 28)).toEqual({
      date: '2026-12-09',
      addedOn: '2026-11-11',
    });
    expect(horizonLine({ date: '2026-12-09', addedOn: '2026-11-11' }, 28)).toBe(
      'Sessions are added 28 days ahead. The next one, Wed 9 Dec, will be added on Wed 11 Nov.',
    );
  });

  it('a first date beyond the window is the first one to be added', () => {
    const later = { ...WEEKLY, startsOn: '2027-01-06' };
    expect(nextSeriesDate(later, '2026-11-04', 28)).toEqual({
      date: '2027-01-06',
      addedOn: '2026-12-09',
    });
    expect(noSessionsYetLine({ date: '2027-01-06', addedOn: '2026-12-09' })).toBe(
      'No sessions yet. The first one, Wed 6 Jan 2027, will be added on Wed 9 Dec 2026.',
    );
  });

  it('follows the pattern: fortnightly skips a week and monthly keeps its ordinal', () => {
    expect(nextSeriesDate({ ...WEEKLY, frequency: 'FORTNIGHTLY' }, '2026-11-04', 28)?.date).toBe(
      '2026-12-16',
    );
    expect(
      nextSeriesDate(
        {
          frequency: 'MONTHLY',
          dayOfWeek: 3,
          startsOn: '2026-11-04',
          monthlyWeek: 1,
          recurUntil: null,
        },
        '2026-11-04',
        28,
      )?.date,
    ).toBe('2027-01-06');
  });

  it('is null once the end date has been reached, so the line is omitted', () => {
    expect(nextSeriesDate({ ...WEEKLY, recurUntil: '2026-12-02' }, '2026-11-04', 28)).toBeNull();
  });
});

describe('splitSeriesInstances (upcoming list versus the Past disclosure)', () => {
  it('keeps published and draft dates that are upcoming or started in the list; the rest are past or cancelled', () => {
    const upcoming = instanceFixture({ id: 'a' });
    const started = instanceFixture({ id: 'b', phase: 'started' });
    const draft = instanceFixture({ id: 'c', status: 'DRAFT', draftReason: 'banking' });
    const cancelled = instanceFixture({ id: 'd', status: 'CANCELLED' });
    const ended = instanceFixture({ id: 'e', phase: 'ended' });
    const expired = instanceFixture({ id: 'f', status: 'DRAFT', phase: 'ended' });
    const completed = instanceFixture({ id: 'g', status: 'COMPLETED', phase: 'ended' });
    const { listed, past } = splitSeriesInstances([
      upcoming,
      started,
      draft,
      cancelled,
      ended,
      expired,
      completed,
    ]);
    expect(listed.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(past.map((row) => row.id)).toEqual(['d', 'e', 'f', 'g']);
  });
});
