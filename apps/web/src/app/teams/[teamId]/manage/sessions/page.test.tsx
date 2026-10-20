import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RULE_ID, TEAM_ID, sessionFixture } from '../../../../../lib/teams/sessions-fixtures.ts';

const mocks = vi.hoisted(() => ({
  teamDetail: vi.fn(),
  listSessions: vi.fn(),
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
vi.mock('../../../../../lib/auth/session.ts', () => ({
  requireUser: () => Promise.resolve({ id: 'user-1' }),
}));
vi.mock('../../../../../lib/auth/cookies.ts', () => ({
  readCookie: () => Promise.resolve('session-token'),
}));
vi.mock('../../../../../lib/log.ts', () => ({
  log: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));
vi.mock('../../../../../lib/api-client.ts', () => ({
  apiClient: { teamDetail: mocks.teamDetail, listSessions: mocks.listSessions },
}));

const page = await import('./page.tsx');
const SessionsPage = page.default;

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (status: number, code = 'internal_error') => ({
  ok: false as const,
  status,
  error: { code, message: 'x' },
});
const TEAM = ok({ team: { id: TEAM_ID, name: 'Rosedale Badminton', memberCount: 12 } });
const listBody = (sessions: unknown[] = [], over: Record<string, unknown> = {}) =>
  ok({ sessions, nextCursor: null, isPayoutConfigured: true, ...over });

const published = sessionFixture({
  id: 'a1111111-1111-4111-8111-111111111111',
  status: 'PUBLISHED',
  draftReason: null,
  recurringRuleId: RULE_ID,
  seriesName: 'Wednesdays at Rosedale',
});
const bankingDraft = sessionFixture({
  id: 'b1111111-1111-4111-8111-111111111111',
  draftReason: 'banking',
  recurringRuleId: RULE_ID,
  seriesName: 'Wednesdays at Rosedale',
});

type Results = { detail?: unknown; upcoming?: unknown; drafts?: unknown; past?: unknown };

async function render(
  query: Record<string, string> = {},
  results: Results = {},
  teamId = TEAM_ID,
): Promise<string> {
  mocks.teamDetail.mockResolvedValue(results.detail ?? TEAM);
  mocks.listSessions.mockImplementation((_team: string, q: { view: string }) =>
    Promise.resolve(
      (q.view === 'upcoming'
        ? results.upcoming
        : q.view === 'drafts'
          ? results.drafts
          : results.past) ?? listBody(),
    ),
  );
  const element = await SessionsPage({
    params: Promise.resolve({ teamId }),
    searchParams: Promise.resolve(query),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  mocks.teamDetail.mockReset();
  mocks.listSessions.mockReset();
  mocks.warn.mockReset();
});

describe('sessions list page: shell (AC-ENTRY-1, AC-ENTRY-2)', () => {
  it('exports noindex metadata and force-dynamic', () => {
    expect(page.metadata).toMatchObject({ robots: { index: false } });
    expect(page.dynamic).toBe('force-dynamic');
  });

  it('sets the title, the H1, the intro, both create buttons and the Auto Enroll hint; Sessions is the one current area', async () => {
    const html = await render();
    expect(html).toContain('<title>Sessions – Rosedale Badminton – Shared Game Management</title>');
    expect(html).toContain('Sessions for Rosedale Badminton</h1>');
    expect(html).toContain(
      'Set up one-off sessions or a series that repeats. Members can register once a session is published.',
    );
    expect(html).toMatch(
      new RegExp(`<a[^>]*href="/teams/${TEAM_ID}/manage/sessions/new"[^>]*>New session</a>`),
    );
    expect(html).toMatch(
      new RegExp(
        `<a[^>]*href="/teams/${TEAM_ID}/manage/sessions/series/new"[^>]*>New recurring series</a>`,
      ),
    );
    expect(html).toContain(
      'Members on Auto Enroll are added to every session when it&#x27;s published.',
    );
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(/<a[^>]*aria-current="page"[^>]*>([^<]*)</.exec(html)?.[1]).toBe('Sessions');
  });

  it('asks the API for each section on its own cursor', async () => {
    await render({ upcoming: 'u1', past: 'p1' });
    const calls = (mocks.listSessions.mock.calls as [string, unknown][]).map(([team, q]) => [
      team,
      q,
    ]);
    expect(calls).toContainEqual([TEAM_ID, { view: 'upcoming', cursor: 'u1' }]);
    expect(calls).toContainEqual([TEAM_ID, { view: 'drafts' }]);
    expect(calls).toContainEqual([TEAM_ID, { view: 'past', cursor: 'p1' }]);
  });
});

describe('sessions list page: sections and the banking notice (AC-ASYNC-3, AC-HAPPY-14)', () => {
  it('shows every section with its rows, and a series row from the loaded dates', async () => {
    const html = await render(
      {},
      {
        upcoming: listBody([published]),
        drafts: listBody([bankingDraft], { isPayoutConfigured: false }),
      },
    );
    for (const title of ['Upcoming', 'Drafts', 'Series', 'Past and cancelled']) {
      expect(html).toContain(`>${title}</h2>`);
    }
    expect(html).toContain('Wed 4 Nov 2026, 8:00-10:00 am');
    expect(html).toMatch(new RegExp(`href="/teams/${TEAM_ID}/manage/sessions/series/${RULE_ID}"`));
  });

  it('shows one page-level banking notice when a banking draft waits and banking is missing, linking with the list as returnTo', async () => {
    const html = await render(
      {},
      {
        upcoming: listBody([], { isPayoutConfigured: false }),
        drafts: listBody([bankingDraft], { isPayoutConfigured: false }),
      },
    );
    expect(html).toContain(
      'Some sessions weren&#x27;t published because your team&#x27;s bank account isn&#x27;t set up.',
    );
    const link = /<a[^>]*href="([^"]*)"[^>]*>Set up banking and GST<\/a>/.exec(html)?.[1];
    expect(link).toBe(
      `/teams/${TEAM_ID}/manage/banking?returnTo=${encodeURIComponent(`/teams/${TEAM_ID}/manage/sessions`)}`,
    );
    expect(html.match(/Set up banking and GST/g)).toHaveLength(1);
  });

  it('no banking notice once banking is set up, and none without a banking draft', async () => {
    const configured = await render(
      {},
      { drafts: listBody([bankingDraft], { isPayoutConfigured: true }) },
    );
    expect(configured).not.toContain('Set up banking and GST');
    expect(configured).toContain('Draft · publishes overnight');
    const plain = await render(
      {},
      { drafts: listBody([sessionFixture()], { isPayoutConfigured: false }) },
    );
    expect(plain).not.toContain('Set up banking and GST');
  });

  it('renders every empty state when nothing exists', async () => {
    const html = await render();
    expect(html).toContain('No upcoming sessions. Published sessions appear here.');
    expect(html).toContain('No drafts.');
    expect(html).toContain('No recurring series yet.');
    expect(html).toContain('Nothing here yet.');
  });

  it('pages a section with its next cursor', async () => {
    const html = await render({}, { upcoming: listBody([published], { nextCursor: 'u2' }) });
    expect(html).toContain(`href="/teams/${TEAM_ID}/manage/sessions?upcoming=u2#upcoming"`);
  });
});

describe('sessions list page: notices', () => {
  it('shows the banner for a notice code and ignores an unknown one', async () => {
    const known = await render({ notice: 'session_not_editable' });
    expect(known).toContain('This session can&#x27;t be changed any more.');
    const unknown = await render({ notice: '<script>alert(1)</script>' });
    expect(unknown).not.toContain('alert(1)');
  });
});

describe('sessions list page: guards (AC-ERROR-8)', () => {
  it('rejects a non-UUID team id as not found before any API call', async () => {
    await expect(render({}, {}, '../x')).rejects.toThrow('NOT_FOUND');
    expect(mocks.listSessions).not.toHaveBeenCalled();
  });

  it('401 redirects to session-expired returning to the list (cursors and notice dropped)', async () => {
    await expect(
      render({ upcoming: 'u1', notice: 'draft_saved' }, { upcoming: fail(401, 'unauthenticated') }),
    ).rejects.toThrow(
      `REDIRECT:/auth/session-expired?returnTo=${encodeURIComponent(`/teams/${TEAM_ID}/manage/sessions`)}`,
    );
  });

  it('403 renders NoAccess: no area nav and no list', async () => {
    const html = await render({}, { upcoming: fail(403, 'forbidden') });
    expect(html).toContain('You don&#x27;t have access to manage this team.');
    expect(html).not.toContain('<nav');
    expect(html).not.toContain('New session');
  });

  it('a 422 is not found; a 5xx throws to the error page and logs without values', async () => {
    await expect(render({}, { drafts: fail(422, 'validation_failed') })).rejects.toThrow(
      'NOT_FOUND',
    );
    await expect(render({}, { past: fail(503, 'service_unavailable') })).rejects.toThrow(
      /API is unavailable/,
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      'web.teams.api_failure',
      expect.objectContaining({ action: 'sessions_list_load', status: 503 }),
    );
  });
});
