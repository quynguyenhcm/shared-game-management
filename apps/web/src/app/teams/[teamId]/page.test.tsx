import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEAM_ID, upcomingFixture } from '../../../lib/registrations/fixtures.ts';

const mocks = vi.hoisted(() => ({
  teamDetail: vi.fn(),
  upcomingSessions: vi.fn(),
  token: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined }),
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: () => undefined,
  RedirectType: { replace: 'replace' },
  useRouter: () => ({ refresh: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('../_session.ts', () => ({ optionalSessionToken: mocks.token }));
vi.mock('../../../lib/auth/session.ts', () => ({
  getSessionState: () => Promise.resolve({ kind: 'signed_in', user: { id: 'u1' } }),
}));
vi.mock('../../../lib/log.ts', () => ({
  log: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));
vi.mock('../../../lib/api-client.ts', () => ({
  apiClient: { teamDetail: mocks.teamDetail, upcomingSessions: mocks.upcomingSessions },
}));

const { default: TeamPage } = await import('./page.tsx');

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (status: number) => ({
  ok: false as const,
  status,
  error: { code: 'internal_error', message: 'x' },
});
const detail = (myStatus: string | null, myRole: string | null = null) =>
  ok({
    team: {
      id: TEAM_ID,
      name: 'Rosedale Badminton',
      description: null,
      visibility: 'PUBLIC',
      memberCount: 12,
    },
    myStatus,
    myRole,
  });

async function render(): Promise<string> {
  const element = await TeamPage({
    params: Promise.resolve({ teamId: TEAM_ID }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  mocks.teamDetail.mockReset();
  mocks.upcomingSessions.mockReset();
  mocks.token.mockReset().mockResolvedValue('session-token');
  mocks.warn.mockClear();
});

describe('team page: "Upcoming sessions" for APPROVED members only (R8, AC-ENTRY-4 web side)', () => {
  it.each([
    ['a MEMBER', 'APPROVED', 'MEMBER'],
    ['a TEAM_ADMIN', 'APPROVED', 'TEAM_ADMIN'],
  ])(
    '%s sees the section, fed by GET /teams/:teamId/sessions/upcoming',
    async (_name, status, role) => {
      mocks.teamDetail.mockResolvedValue(detail(status, role));
      mocks.upcomingSessions.mockResolvedValue(
        ok(upcomingFixture([{ me: { status: 'CONFIRMED', waitlistRank: null } }])),
      );
      const html = await render();
      expect(mocks.upcomingSessions).toHaveBeenCalledWith(
        TEAM_ID,
        expect.objectContaining({ session: 'session-token' }),
      );
      expect(html).toContain('Upcoming sessions');
      expect(html).toContain(`/teams/${TEAM_ID}/sessions/`);
      expect(html).toContain('3 of 10 places left');
    },
  );

  it.each([
    ['PENDING', 'PENDING'],
    ['REJECTED', 'REJECTED'],
    ['BANNED', 'BANNED'],
    ['a non-member', null],
  ])('%s sees no section and the API is not asked', async (_name, status) => {
    mocks.teamDetail.mockResolvedValue(detail(status));
    const html = await render();
    expect(mocks.upcomingSessions).not.toHaveBeenCalled();
    expect(html).not.toContain('Upcoming sessions');
  });

  it('a failed list is contained to the section: the rest of the team page still renders', async () => {
    mocks.teamDetail.mockResolvedValue(detail('APPROVED', 'MEMBER'));
    mocks.upcomingSessions.mockResolvedValue(fail(503));
    const html = await render();
    expect(html).toContain('Rosedale Badminton');
    expect(html).toContain('We can&#x27;t load sessions right now. Try again in a minute.');
    expect(mocks.warn).toHaveBeenCalledWith('web.registrations.api_failure', {
      action: 'upcoming_sessions',
      status: 503,
      code: 'internal_error',
    });
  });
});
