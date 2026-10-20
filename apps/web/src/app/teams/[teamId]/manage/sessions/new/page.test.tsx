import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEAM_ID } from '../../../../../../lib/teams/sessions-fixtures.ts';

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
vi.mock('../../../../../../lib/auth/session.ts', () => ({
  requireUser: () => Promise.resolve({ id: 'user-1' }),
}));
vi.mock('../../../../../../lib/auth/cookies.ts', () => ({
  readCookie: () => Promise.resolve('session-token'),
}));
vi.mock('../../../../../../lib/log.ts', () => ({
  log: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));
vi.mock('../../../../../../lib/api-client.ts', () => ({
  apiClient: { teamDetail: mocks.teamDetail, teamBanking: mocks.teamBanking },
}));

const page = await import('./page.tsx');
const NewSessionPage = page.default;

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (status: number, code = 'internal_error') => ({
  ok: false as const,
  status,
  error: { code, message: 'x' },
});
const TEAM = ok({ team: { id: TEAM_ID, name: 'Rosedale Badminton', memberCount: 12 } });
const BANKING = ok({
  banking: {
    isPayoutConfigured: true,
    payoutBlocked: false,
    accountName: null,
    unreadable: false,
    accountNumberLast4: null,
    lastChanged: null,
  },
});

async function render(results: { banking?: unknown } = {}, teamId = TEAM_ID): Promise<string> {
  mocks.teamDetail.mockResolvedValue(TEAM);
  mocks.teamBanking.mockResolvedValue(results.banking ?? BANKING);
  const element = await NewSessionPage({
    params: Promise.resolve({ teamId }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  mocks.teamDetail.mockReset();
  mocks.teamBanking.mockReset();
  mocks.warn.mockReset();
});

describe('new session page (N1)', () => {
  it('has the title, the H1, the one-off scope line, the nav with Sessions current and a create form with a fresh key', async () => {
    expect(page.metadata).toMatchObject({ robots: { index: false } });
    expect(page.dynamic).toBe('force-dynamic');
    const html = await render();
    expect(html).toContain(
      '<title>New session – Rosedale Badminton – Shared Game Management</title>',
    );
    expect(html).toContain('New session</h1>');
    expect(html).toContain(
      'One-off session. When you publish it, members on Auto Enroll are added to it.',
    );
    expect(/<a[^>]*aria-current="page"[^>]*>([^<]*)</.exec(html)?.[1]).toBe('Sessions');
    expect(html).toMatch(/name="createKey"[^>]*value="[0-9a-f-]{36}"/);
    expect(html).toContain('>Save draft<');
    expect(html).toContain('>Save and publish<');
    expect(html).not.toContain('Cancel session');
  });

  it('a new render gets a new createKey (a retry of the same render reuses its key)', async () => {
    const key = (html: string): string | undefined =>
      /name="createKey"[^>]*value="([0-9a-f-]{36})"/.exec(html)?.[1];
    expect(key(await render())).not.toBe(key(await render()));
  });

  it('rejects a non-UUID team id before any API call', async () => {
    await expect(render({}, '../x')).rejects.toThrow('NOT_FOUND');
    expect(mocks.teamBanking).not.toHaveBeenCalled();
  });

  it('401 returns to this page after sign-in; 403 is NoAccess with no nav and no form; 422 is not found', async () => {
    await expect(render({ banking: fail(401, 'unauthenticated') })).rejects.toThrow(
      `REDIRECT:/auth/session-expired?returnTo=${encodeURIComponent(`/teams/${TEAM_ID}/manage/sessions/new`)}`,
    );
    const html = await render({ banking: fail(403, 'forbidden') });
    expect(html).toContain('You don&#x27;t have access to manage this team.');
    expect(html).not.toContain('<nav');
    expect(html).not.toContain('<form');
    await expect(render({ banking: fail(422, 'validation_failed') })).rejects.toThrow('NOT_FOUND');
  });
});
