import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RULE_ID,
  TEAM_ID,
  instanceFixture,
  seriesFixture,
} from '../../../../../../../lib/teams/sessions-fixtures.ts';

const mocks = vi.hoisted(() => ({
  teamDetail: vi.fn(),
  getSeries: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined }),
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  RedirectType: { replace: 'replace' },
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('../../../../../../../lib/auth/session.ts', () => ({
  requireUser: () => Promise.resolve({ id: 'user-1' }),
}));
vi.mock('../../../../../../../lib/auth/cookies.ts', () => ({
  readCookie: () => Promise.resolve('session-token'),
}));
vi.mock('../../../../../../../lib/log.ts', () => ({
  log: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));
vi.mock('../../../../../../../lib/api-client.ts', () => ({
  apiClient: { teamDetail: mocks.teamDetail, getSeries: mocks.getSeries },
}));

const page = await import('./page.tsx');
const SeriesPage = page.default;

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (status: number, code = 'internal_error') => ({
  ok: false as const,
  status,
  error: { code, message: 'x' },
});
const TEAM = ok({ team: { id: TEAM_ID, name: 'Rosedale Badminton', memberCount: 12 } });
const detail = (overrides = {}) => ok({ series: seriesFixture(overrides) });

const SERIES_URL = `/teams/${TEAM_ID}/manage/sessions/series/${RULE_ID}`;

async function render(
  query: Record<string, string> = {},
  results: { detail?: unknown; series?: unknown } = {},
  ids: { teamId?: string; ruleId?: string } = {},
): Promise<string> {
  mocks.teamDetail.mockResolvedValue(results.detail ?? TEAM);
  mocks.getSeries.mockResolvedValue(results.series ?? detail());
  const element = await SeriesPage({
    params: Promise.resolve({ teamId: ids.teamId ?? TEAM_ID, ruleId: ids.ruleId ?? RULE_ID }),
    searchParams: Promise.resolve(query),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-04T10:00:00.000Z'));
  mocks.teamDetail.mockReset();
  mocks.getSeries.mockReset();
  mocks.warn.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('series page: summary first (UI/UX D3 option 1, S2)', () => {
  it('exports noindex and force-dynamic; title and H1 are the series name; Sessions is the current area', async () => {
    expect(page.metadata).toMatchObject({ robots: { index: false } });
    expect(page.dynamic).toBe('force-dynamic');
    const html = await render();
    expect(html).toContain(
      '<title>Wednesdays at Rosedale – Rosedale Badminton – Shared Game Management</title>',
    );
    expect(html).toContain('Wednesdays at Rosedale</h1>');
    expect(/<a[^>]*aria-current="page"[^>]*>([^<]*)</.exec(html)?.[1]).toBe('Sessions');
  });

  it('shows the one-line summary, then the sessions with a unique "Edit {date}" link each, then the horizon line, then the details', async () => {
    const html = await render(
      {},
      {
        series: detail({
          instances: [
            instanceFixture({ id: 'a1111111-1111-4111-8111-111111111111', date: '2026-11-04' }),
            instanceFixture({
              id: 'b1111111-1111-4111-8111-111111111111',
              date: '2026-11-11',
              isInstanceOverridden: true,
              startsAt: '2026-11-10T19:00:00.000Z',
              endsAt: '2026-11-10T20:00:00.000Z',
            }),
          ],
        }),
      },
    );
    expect(html).toContain(
      'Weekly on Wednesdays · 8:00 am-10:00 am · 2 courts · $12.00 each · from 4 Nov 2026 · no end date',
    );
    expect(html).toContain('>Sessions in this series</h2>');
    expect(html).toMatch(
      new RegExp(
        `<a[^>]*href="/teams/${TEAM_ID}/manage/sessions/a1111111[^"]*"[^>]*>Edit Wed 4 Nov</a>`,
      ),
    );
    expect(html).toContain('>Edit Wed 11 Nov</a>');
    expect(html).toContain('>Edited<');
    const horizon = html.indexOf(
      'Sessions are added 28 days ahead. The next one, Wed 9 Dec, will be added on Wed 11 Nov.',
    );
    expect(horizon).toBeGreaterThan(html.indexOf('Edit Wed 11 Nov'));
    expect(horizon).toBeLessThan(html.indexOf('>Series details</h2>'));
  });

  it('the details block has the rows, "Change series details" (?edit=details) and End series', async () => {
    const html = await render();
    expect(html).toContain('>Series details</h2>');
    expect(html).toContain('Weekly on Wednesdays');
    expect(html).toMatch(
      new RegExp(`<a[^>]*href="${SERIES_URL}\\?edit=details"[^>]*>Change series details</a>`),
    );
    expect(html).toContain('>End series</button>');
  });

  it('puts past and cancelled dates in a collapsed disclosure with a count, not in the main list', async () => {
    const html = await render(
      {},
      {
        series: detail({
          instances: [
            instanceFixture({ id: 'a1111111-1111-4111-8111-111111111111' }),
            instanceFixture({
              id: 'c1111111-1111-4111-8111-111111111111',
              status: 'CANCELLED',
              date: '2026-11-18',
            }),
          ],
        }),
      },
    );
    expect(html).toContain('<details');
    expect(html).toContain('Past and cancelled sessions in this series (1)');
  });

  it('a notice banner carries the series-save counts', async () => {
    const html = await render({ notice: 'series_saved', count: '4', edited: '1' });
    expect(html).toContain('Series saved. 4 upcoming sessions updated.');
    expect(html).toContain('1 edited session kept its own details.');
  });
});

describe('series page: waiting and empty states (AC-ASYNC-6)', () => {
  it('a series still materialising shows the waiting line in a status region with a plain Refresh link', async () => {
    const html = await render(
      { notice: 'series_created' },
      { series: detail({ materialising: true, instances: [] }) },
    );
    expect(html).toContain('Series created.');
    expect(html).toContain('We&#x27;re adding the sessions in this series. Refresh in a moment.');
    expect(html).toMatch(new RegExp(`<a[^>]*href="${SERIES_URL}"[^>]*>Refresh</a>`));
    expect(html).toContain('role="status"');
  });

  it('ready with no sessions yet says when the first one will be added', async () => {
    const html = await render({}, { series: detail({ startsOn: '2027-01-06', instances: [] }) });
    expect(html).toContain(
      'No sessions yet. The first one, Wed 6 Jan 2027, will be added on Wed 9 Dec 2026.',
    );
  });
});

describe('series page: banking (AC-ASYNC-3, AC-ASYNC-4, AC-ASYNC-7)', () => {
  const drafts = [
    instanceFixture({
      id: 'd1111111-1111-4111-8111-111111111111',
      status: 'DRAFT',
      draftReason: 'banking',
      date: '2026-11-18',
    }),
  ];

  it('S2b: banking missing shows the count notice above the sessions, linking to banking with this page as returnTo; the rows say "bank account needed"', async () => {
    const html = await render(
      {},
      { series: detail({ isPayoutConfigured: false, bankingDrafts: 2, instances: drafts }) },
    );
    expect(html).toContain(
      '2 sessions in this series were saved as drafts because your team&#x27;s bank account isn&#x27;t set up. Members can&#x27;t register for them yet.',
    );
    const link = /<a[^>]*href="([^"]*banking[^"]*)"[^>]*>Set up banking and GST<\/a>/.exec(
      html,
    )?.[1];
    expect(link).toBe(
      `/teams/${TEAM_ID}/manage/banking?returnTo=${encodeURIComponent(SERIES_URL)}`,
    );
    expect(html.indexOf('Set up banking and GST')).toBeLessThan(html.indexOf('Edit Wed 18 Nov'));
    expect(html).toContain('Draft · bank account needed');
    expect(html).not.toContain('Publish drafts now');
  });

  it('S2r: banking set up with drafts left offers "Publish drafts now"', async () => {
    const html = await render(
      {},
      {
        series: detail({
          isPayoutConfigured: true,
          bankingDrafts: 2,
          editedDrafts: 1,
          instances: drafts,
        }),
      },
    );
    expect(html).toContain(
      'Your bank account is set up. 2 sessions in this series are still drafts.',
    );
    expect(html).toContain('1 edited draft needs you to publish it yourself.');
    expect(html).toContain('>Publish drafts now</button>');
    expect(html).not.toContain('Set up banking and GST');
  });

  it('no banking notice and no button when nothing waits on banking', async () => {
    const html = await render();
    expect(html).not.toContain('Publish drafts now');
    expect(html).not.toContain('bank account');
  });
});

describe('series page: edit mode is form-first (?edit=details, S3)', () => {
  it('shows the form with the effect line and no sessions list, details block or End series', async () => {
    const html = await render({ edit: 'details' });
    expect(html).toContain('Change series details</h1>');
    expect(html).toContain('Wednesdays at Rosedale');
    expect(html).toContain('>Save series<');
    expect(html).toContain(
      'Your changes will apply to 1 upcoming session and to sessions added later.',
    );
    expect(html).not.toContain('>Sessions in this series</h2>');
    expect(html).not.toContain('>End series<');
    expect(html).not.toContain('Edit Wed 4 Nov');
  });

  it('the Cancel link goes back to the series page (edit cleared)', async () => {
    const html = await render({ edit: 'details' });
    expect(html).toMatch(new RegExp(`<a[^>]*href="${SERIES_URL}"[^>]*>Cancel</a>`));
  });

  it('a stale notice on the reloaded form is an error alert with the latest values', async () => {
    const html = await render({ edit: 'details', notice: 'series_stale' });
    expect(html).toContain('This series changed since you opened it.');
    expect(html).toContain('role="alert"');
    expect(html).toContain('>Save series<');
  });

  it('an unknown ?edit value is ignored', async () => {
    const html = await render({ edit: 'everything' });
    expect(html).toContain('>Sessions in this series</h2>');
  });
});

describe('series page: an ended series (S4)', () => {
  const ended = detail({ isActive: false, recurUntil: '2026-12-16' });

  it('says it ended and how to run it again, with no Change, End or Publish controls', async () => {
    const html = await render({}, { series: ended });
    expect(html).toContain(
      'Ended. Last session 16 Dec 2026. To run it again, create a new series.',
    );
    expect(html).not.toContain('Change series details</a>');
    expect(html).not.toContain('>End series<');
    expect(html).not.toContain('Publish drafts now');
  });

  it('ignores ?edit=details (an ended series cannot be changed)', async () => {
    const html = await render({ edit: 'details' }, { series: ended });
    expect(html).not.toContain('>Save series<');
    expect(html).toContain('Ended. Last session');
  });

  it('shows the ended notice with the cancel and registered counts (T-6, P-2)', async () => {
    const html = await render(
      { notice: 'series_ended', cancelled: '3', registered: '9', date: '2026-12-16' },
      { series: ended },
    );
    expect(html).toContain('Series ended. No new sessions will be added after 16 Dec 2026.');
    expect(html).toContain('3 sessions after that date were cancelled.');
    expect(html).toContain('9 players were registered for them. Let them know.');
  });
});

describe('series page: guards (AC-ERROR-8)', () => {
  it('rejects non-UUID ids before any API call', async () => {
    await expect(render({}, {}, { ruleId: '../x' })).rejects.toThrow('NOT_FOUND');
    await expect(render({}, {}, { teamId: 'x' })).rejects.toThrow('NOT_FOUND');
    expect(mocks.getSeries).not.toHaveBeenCalled();
  });

  it('401 returns to the series page, keeping edit mode and dropping the notice', async () => {
    await expect(
      render({ edit: 'details', notice: 'series_saved' }, { series: fail(401, 'unauthenticated') }),
    ).rejects.toThrow(
      `REDIRECT:/auth/session-expired?returnTo=${encodeURIComponent(`${SERIES_URL}?edit=details`)}`,
    );
  });

  it('403 renders NoAccess with no nav and no series content', async () => {
    const html = await render({}, { series: fail(403, 'forbidden') });
    expect(html).toContain('You don&#x27;t have access to manage this team.');
    expect(html).not.toContain('<nav');
    expect(html).not.toContain('Wednesdays at Rosedale');
  });

  it('404 (unknown or another team’s series) and 422 are not found; a 5xx throws and logs without values', async () => {
    await expect(render({}, { series: fail(404, 'not_found') })).rejects.toThrow('NOT_FOUND');
    await expect(render({}, { series: fail(422, 'validation_failed') })).rejects.toThrow(
      'NOT_FOUND',
    );
    await expect(render({}, { series: fail(503, 'service_unavailable') })).rejects.toThrow(
      /API is unavailable/,
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      'web.teams.api_failure',
      expect.objectContaining({ action: 'series_load', status: 503 }),
    );
  });
});
