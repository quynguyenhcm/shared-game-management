import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEAM_ID } from '../../../../../../../lib/teams/sessions-fixtures.ts';

const mocks = vi.hoisted(() => ({
  teamDetail: vi.fn(),
  teamBanking: vi.fn(),
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
  apiClient: { teamDetail: mocks.teamDetail, teamBanking: mocks.teamBanking },
}));

const page = await import('./page.tsx');
const NewSeriesPage = page.default;

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (status: number, code = 'internal_error') => ({
  ok: false as const,
  status,
  error: { code, message: 'x' },
});
const TEAM = ok({ team: { id: TEAM_ID, name: 'Rosedale Badminton', memberCount: 12 } });
const banking = (isPayoutConfigured: boolean) =>
  ok({
    banking: {
      isPayoutConfigured,
      payoutBlocked: false,
      accountName: null,
      unreadable: false,
      accountNumberLast4: null,
      lastChanged: null,
    },
  });

async function render(results: { banking?: unknown } = {}, teamId = TEAM_ID): Promise<string> {
  mocks.teamDetail.mockResolvedValue(TEAM);
  mocks.teamBanking.mockResolvedValue(results.banking ?? banking(true));
  const element = await NewSeriesPage({
    params: Promise.resolve({ teamId }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  mocks.teamDetail.mockReset();
  mocks.teamBanking.mockReset();
});

describe('new series page (S0)', () => {
  it('has the title, the H1, the nav with Sessions current and the create form with Repeats first and a fresh key', async () => {
    expect(page.metadata).toMatchObject({ robots: { index: false } });
    expect(page.dynamic).toBe('force-dynamic');
    const html = await render();
    expect(html).toContain(
      '<title>New recurring series – Rosedale Badminton – Shared Game Management</title>',
    );
    expect(html).toContain('New recurring series</h1>');
    expect(/<a[^>]*aria-current="page"[^>]*>([^<]*)</.exec(html)?.[1]).toBe('Sessions');
    expect(html.indexOf('>Repeats<')).toBeLessThan(html.indexOf('>Details<'));
    expect(html).toContain('Sessions are added 28 days ahead and published automatically');
    expect(html).toMatch(/name="createKey"[^>]*value="[0-9a-f-]{36}"/);
    expect(html).toContain('>Create series<');
  });

  it('rejects a non-UUID team id; 401 returns here; 403 is NoAccess', async () => {
    await expect(render({}, '../x')).rejects.toThrow('NOT_FOUND');
    await expect(render({ banking: fail(401, 'unauthenticated') })).rejects.toThrow(
      `REDIRECT:/auth/session-expired?returnTo=${encodeURIComponent(`/teams/${TEAM_ID}/manage/sessions/series/new`)}`,
    );
    const html = await render({ banking: fail(403, 'forbidden') });
    expect(html).not.toContain('<nav');
    expect(html).not.toContain('<form');
  });
});
