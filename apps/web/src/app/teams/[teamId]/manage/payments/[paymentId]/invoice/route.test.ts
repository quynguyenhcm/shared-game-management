import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../../lib/log.ts', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { GET } = await import('./route.ts');

const TEAM = '7f3c2b1a-1111-4222-8333-444455556666';
const ID = '22222222-2222-4222-8222-222222222222';

const call = (teamId: string, paymentId: string, search = '') =>
  GET(
    new NextRequest(
      `http://localhost:3000/teams/${teamId}/manage/payments/${paymentId}/invoice${search}`,
      { headers: { cookie: 'sgm_session=live-token' } },
    ),
    { params: Promise.resolve({ teamId, paymentId }) },
  );

afterEach(() => vi.unstubAllGlobals());

describe('GET /teams/[teamId]/manage/payments/[paymentId]/invoice', () => {
  it('proxies the team route of the API', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response('%PDF-1', {
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': 'attachment; filename="tax-invoice-INV-000002.pdf"',
          },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect((await call(TEAM, ID)).status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
      new RegExp(`/teams/${TEAM}/payments/${ID}/invoice$`),
    );
  });

  it('lands a refusal back on the Payments page the link was on, and a 403 as forbidden', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({ error: { code: 'forbidden', message: 'x' } }, { status: 403 }),
        ),
      ),
    );
    const back = `/teams/${TEAM}/manage/payments?status=paid`;
    const response = await call(TEAM, ID, `?returnTo=${encodeURIComponent(back)}`);
    expect(response.headers.get('location')).toBe(
      `http://localhost:3000${back}&download_error=forbidden`,
    );
    const malformed = await call(TEAM, 'nope');
    expect(malformed.headers.get('location')).toBe(
      `http://localhost:3000/teams/${TEAM}/manage/payments?download_error=not_found`,
    );
  });
});
