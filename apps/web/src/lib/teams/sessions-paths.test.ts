import { describe, expect, it } from 'vitest';
import { bankingReturnTo } from './banking-view.ts';
import {
  bankingHandoff,
  listCursorParam,
  listPagerHrefs,
  newSeriesPath,
  newSessionPath,
  seriesEditPath,
  seriesPath,
  sessionPath,
  sessionsPath,
} from './sessions-paths.ts';

const T = '7f3c2b1a-1111-4222-8333-444455556666';
const S = '11111111-1111-4111-8111-111111111111';
const R = '41111111-1111-4111-8111-111111111111';

describe('Sessions paths (UI/UX "Page inventory and URL grammar")', () => {
  it('builds the five page paths under the manage area', () => {
    expect(sessionsPath(T)).toBe(`/teams/${T}/manage/sessions`);
    expect(newSessionPath(T)).toBe(`/teams/${T}/manage/sessions/new`);
    expect(sessionPath(T, S)).toBe(`/teams/${T}/manage/sessions/${S}`);
    expect(newSeriesPath(T)).toBe(`/teams/${T}/manage/sessions/series/new`);
    expect(seriesPath(T, R)).toBe(`/teams/${T}/manage/sessions/series/${R}`);
    expect(seriesEditPath(T, R)).toBe(`/teams/${T}/manage/sessions/series/${R}?edit=details`);
  });
});

describe('banking hand-off (AC-HAPPY-14: the return link is the page the admin started from)', () => {
  it('links to banking with the page path as an encoded returnTo', () => {
    expect(bankingHandoff(T, sessionsPath(T))).toBe(
      `/teams/${T}/manage/banking?returnTo=${encodeURIComponent(sessionsPath(T))}`,
    );
  });

  it.each([
    ['the list', sessionsPath(T)],
    ['a session editor', sessionPath(T, S)],
    ['the series page', seriesPath(T, R)],
    ['the series page in edit mode', seriesEditPath(T, R)],
    ['a new session', newSessionPath(T)],
  ])(
    'the banking page accepts the returnTo from %s (its allow-list is any path under the team)',
    (_name, path) => {
      expect(bankingReturnTo(T, path)).toBe(path);
      // The exact value the hand-off puts in the URL survives a decode round trip.
      const href = bankingHandoff(T, path);
      const raw = new URL(href, 'http://x.invalid').searchParams.get('returnTo');
      expect(bankingReturnTo(T, raw)).toBe(path);
    },
  );

  it('still refuses another team, the banking page itself and an absolute URL', () => {
    expect(bankingReturnTo(T, '/teams/other/manage/sessions')).toBeUndefined();
    expect(bankingReturnTo(T, `/teams/${T}/manage/banking`)).toBeUndefined();
    expect(bankingReturnTo(T, 'https://evil.example/teams')).toBeUndefined();
  });
});

describe('list pager (keyset cursors in ?upcoming=, ?drafts=, ?past=)', () => {
  it('names one cursor parameter per section', () => {
    expect(listCursorParam('upcoming')).toBe('upcoming');
    expect(listCursorParam('drafts')).toBe('drafts');
    expect(listCursorParam('past')).toBe('past');
  });

  it('Next changes only its own cursor, keeps the others, and ends with the section fragment', () => {
    const hrefs = listPagerHrefs({
      teamId: T,
      section: 'upcoming',
      current: { drafts: 'd1', past: undefined },
      nextCursor: 'u2',
    });
    expect(hrefs.next).toBe(`/teams/${T}/manage/sessions?drafts=d1&upcoming=u2#upcoming`);
    expect(hrefs.start).toBeNull();
  });

  it('offers Back to start only on a later page, clearing just that cursor', () => {
    const hrefs = listPagerHrefs({
      teamId: T,
      section: 'past',
      current: { upcoming: 'u1', past: 'p1' },
      nextCursor: null,
    });
    expect(hrefs.next).toBeNull();
    expect(hrefs.start).toBe(`/teams/${T}/manage/sessions?upcoming=u1#past`);
  });

  it('has no query string when nothing else is set', () => {
    const hrefs = listPagerHrefs({
      teamId: T,
      section: 'drafts',
      current: { drafts: 'd1' },
      nextCursor: null,
    });
    expect(hrefs.start).toBe(`/teams/${T}/manage/sessions#drafts`);
  });
});
