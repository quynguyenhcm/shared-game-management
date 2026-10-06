import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  token: null as string | null,
  me: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('./cookies.ts', () => ({ readCookie: () => Promise.resolve(mocks.token) }));
vi.mock('../api-client.ts', () => ({ apiClient: { me: mocks.me } }));

const { SessionUnavailableError, getSessionState, requireUser, sessionStateFrom } =
  await import('./session.ts');

const USER = {
  id: '7f3c2b1a-1111-4222-8333-444455556666',
  email: 'aroha.ngata@example.com',
  fullName: 'Aroha Ngata',
  sex: 'FEMALE',
  role: 'PLAYER',
};

beforeEach(() => {
  mocks.token = null;
  mocks.me.mockReset();
});

describe('sessionStateFrom (header states and X7: "signed in" is a real API check, never cookie presence)', () => {
  it('maps cookie presence and the /auth/me answer to the journey states', () => {
    expect(sessionStateFrom(false, null)).toEqual({ kind: 'anonymous' });
    expect(
      sessionStateFrom(true, { ok: true, status: 200, data: { user: USER } } as never),
    ).toEqual({
      kind: 'signed_in',
      user: USER,
    });
    const dead = {
      ok: false,
      status: 401,
      error: { code: 'session_expired', message: '' },
    } as never;
    expect(sessionStateFrom(true, dead)).toEqual({ kind: 'dead_cookie' });
    const down = {
      ok: false,
      status: 0,
      error: { code: 'service_unavailable', message: '' },
    } as never;
    expect(sessionStateFrom(true, down)).toEqual({ kind: 'unavailable' });
    const boom = {
      ok: false,
      status: 503,
      error: { code: 'service_unavailable', message: '' },
    } as never;
    expect(sessionStateFrom(true, boom)).toEqual({ kind: 'unavailable' });
  });
});

describe('requireUser (AC-ERROR-11, AC-ERROR-18)', () => {
  it('redirects to /login with returnTo when there is no cookie, without calling the API', async () => {
    await expect(requireUser('/account')).rejects.toThrow('REDIRECT:/login?returnTo=%2Faccount');
    expect(mocks.me).not.toHaveBeenCalled();
  });

  it('sends a dead cookie through /auth/session-expired', async () => {
    mocks.token = 'dead';
    mocks.me.mockResolvedValue({
      ok: false,
      status: 401,
      error: { code: 'session_expired', message: '' },
    });
    await expect(requireUser('/account')).rejects.toThrow(
      'REDIRECT:/auth/session-expired?returnTo=%2Faccount',
    );
  });

  it('throws (for error.tsx) instead of redirecting or signing out when the API is down', async () => {
    mocks.token = 'live';
    mocks.me.mockResolvedValue({
      ok: false,
      status: 0,
      error: { code: 'service_unavailable', message: '' },
    });
    await expect(requireUser('/account')).rejects.toBeInstanceOf(SessionUnavailableError);
  });

  it('returns the user for a live session; getSessionState reports signed_in', async () => {
    mocks.token = 'live';
    mocks.me.mockResolvedValue({ ok: true, status: 200, data: { user: USER } });
    await expect(requireUser('/account')).resolves.toEqual(USER);
    await expect(getSessionState()).resolves.toEqual({ kind: 'signed_in', user: USER });
    expect(mocks.me).toHaveBeenCalledWith('live', expect.anything());
  });
});
