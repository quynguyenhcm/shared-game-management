import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_ID,
  TEAM_ID,
  readFixture,
  registrationFixture,
} from '../../../../../lib/registrations/fixtures.ts';

const mocks = vi.hoisted(() => ({
  teamDetail: vi.fn(),
  sessionRegistration: vi.fn(),
  requireUser: vi.fn(),
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
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('../../../../../lib/auth/session.ts', () => ({ requireUser: mocks.requireUser }));
vi.mock('../../../../../lib/auth/cookies.ts', () => ({
  readCookie: () => Promise.resolve('session-token'),
}));
vi.mock('../../../../../lib/log.ts', () => ({
  log: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));
vi.mock('../../../../../lib/api-client.ts', () => ({
  apiClient: { teamDetail: mocks.teamDetail, sessionRegistration: mocks.sessionRegistration },
}));

const page = await import('./page.tsx');
const SessionPage = page.default;

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (status: number, code = 'internal_error') => ({
  ok: false as const,
  status,
  error: { code, message: 'x' },
});
const TEAM = ok({ team: { id: TEAM_ID, name: 'Rosedale Badminton', memberCount: 12 } });
const PAGE_URL = `/teams/${TEAM_ID}/sessions/${SESSION_ID}`;

async function render(
  results: { team?: unknown; read?: unknown } = {},
  ids: { teamId?: string; sessionId?: string } = {},
): Promise<string> {
  mocks.teamDetail.mockResolvedValue(results.team ?? TEAM);
  mocks.sessionRegistration.mockResolvedValue(results.read ?? ok(readFixture()));
  const element = await SessionPage({
    params: Promise.resolve({
      teamId: ids.teamId ?? TEAM_ID,
      sessionId: ids.sessionId ?? SESSION_ID,
    }),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  mocks.teamDetail.mockReset();
  mocks.sessionRegistration.mockReset();
  mocks.requireUser.mockReset().mockResolvedValue({ id: 'user-1' });
  mocks.warn.mockClear();
});

describe('player session page /teams/[teamId]/sessions/[sessionId] (R23: registration-and-waitlist owns it)', () => {
  it('renders the player summary and the registration panel from one GET .../registration (AC-ENTRY-1)', async () => {
    const html = await render();
    expect(mocks.sessionRegistration).toHaveBeenCalledTimes(1);
    expect(mocks.sessionRegistration.mock.calls[0]?.slice(0, 2)).toEqual([TEAM_ID, SESSION_ID]);
    expect(mocks.sessionRegistration.mock.calls[0]?.[2]).toMatchObject({
      session: 'session-token',
    });
    expect(html).toContain('<h1');
    expect(html).toContain('Rosedale Courts');
    expect(html).toContain('id="registration-heading"');
    expect(html).toContain('3 of 10 places left');
    expect(html).toContain('Bringing guests?');
    expect(html).toContain('Back to Rosedale Badminton');
    // one h1, then the panel's h2
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html.indexOf('<h1')).toBeLessThan(html.indexOf('<h2'));
  });

  it('titles the page with the location and the Auckland day, and is not indexable', async () => {
    const html = await render();
    expect(html).toContain('<title>Rosedale Courts, Wed 4 Nov – Shared Game Management</title>');
    expect(page.metadata).toMatchObject({ robots: { index: false } });
    expect(page.dynamic).toBe('force-dynamic');
  });

  it('requires a signed-in user and returns to this page (AC-ENTRY-2: anonymous goes to /login with returnTo)', async () => {
    await render();
    expect(mocks.requireUser).toHaveBeenCalledWith(PAGE_URL);
  });

  it('a 403 from the read model is the not-a-member state: the words, a way back, no session details, no form (AC-ENTRY-2)', async () => {
    const html = await render({ read: fail(403, 'forbidden') });
    expect(html).toContain('You need to be a member of this team to register.');
    expect(html).toContain(`href="/teams/${TEAM_ID}"`);
    expect(html).not.toContain('Rosedale Courts');
    expect(html).not.toContain('<form');
  });

  it('a 404 and a malformed id are the same not-found (another team, DRAFT or unknown session)', async () => {
    await expect(render({ read: fail(404, 'not_found') })).rejects.toThrow('NOT_FOUND');
    await expect(render({}, { sessionId: 'nope' })).rejects.toThrow('NOT_FOUND');
    await expect(render({}, { teamId: '../x' })).rejects.toThrow('NOT_FOUND');
  });

  it('a 401 goes to session expiry, returning here; a 5xx throws to the error page and logs only status and code', async () => {
    await expect(render({ read: fail(401, 'unauthenticated') })).rejects.toThrow(
      `REDIRECT:/auth/session-expired?returnTo=${encodeURIComponent(PAGE_URL)}`,
    );
    await expect(render({ read: fail(503, 'service_unavailable') })).rejects.toThrow();
    expect(mocks.warn).toHaveBeenCalledWith('web.registrations.api_failure', {
      action: 'session_page',
      status: 503,
      code: 'service_unavailable',
    });
  });

  it('survives a failed team-name read: the panel still renders', async () => {
    const html = await render({ team: fail(503, 'service_unavailable') });
    expect(html).toContain('Bringing guests?');
    expect(html).toContain('Back to the team');
  });

  it('renders a cancelled session ahead of the registration (R27, P-2)', async () => {
    const html = await render({
      read: ok(
        readFixture({
          session: { status: 'CANCELLED' },
          me: { registration: registrationFixture({ status: 'CONFIRMED' }) },
          canRegister: false,
          blockedReason: 'session_not_open',
        }),
      ),
    });
    expect(html).toContain('This session has been cancelled.');
    expect(html).not.toContain('You&#x27;re in.');
  });
});
