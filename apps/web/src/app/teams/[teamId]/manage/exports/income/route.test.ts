import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../../lib/log.ts', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { GET } = await import('./route.ts');

/**
 * The income export download route (tax-invoices-and-exports Phase 4; AC-HAPPY-6..9, AC-ERROR-2, 3, 4; CR-3): the plain GET
 * form posts every period group's fields, the route forwards only the selected type's, streams the file, and answers every
 * refusal with a 303 back to the exports page with the entered values kept. Cancellation of the browser request reaches the API.
 */

const TEAM = '7f3c2b1a-1111-4222-8333-444455556666';
const PAGE = `/teams/${TEAM}/manage/exports`;
const ALL_GROUPS =
  'format=csv&from=2027-06-01&to=2027-06-15&gst=2m-odd%2F2027-05&year=2026-27&returnTo=%2Fteams';

function incoming(search: string, init: { signal?: AbortSignal; cookie?: string } = {}) {
  return new NextRequest(`http://localhost:3000${PAGE}/income?${search}`, {
    headers: { cookie: init.cookie ?? 'sgm_session=live-token' },
    ...(init.signal === undefined ? {} : { signal: init.signal }),
  });
}

const call = (search: string, teamId = TEAM, init?: { signal?: AbortSignal; cookie?: string }) =>
  GET(incoming(search, init), { params: Promise.resolve({ teamId }) });

function stubApi(response: Response) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(response));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const apiError = (status: number, code: string, fieldErrors?: Record<string, string[]>) =>
  Response.json(
    { error: { code, message: 'x', ...(fieldErrors === undefined ? {} : { fieldErrors }) } },
    { status },
  );

afterEach(() => vi.unstubAllGlobals());

describe('GET /teams/[teamId]/manage/exports/income: success', () => {
  it('forwards only the selected period type to the API and streams the file with its name, no-store and nosniff', async () => {
    const fetchMock = stubApi(
      new Response('Invoice number\r\n', {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="income_hokio_2027-06-01_to_2027-06-15.csv"',
          'x-export-row-count': '0',
        },
      }),
    );
    const response = await call(`period=custom&${ALL_GROUPS}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="income_hokio_2027-06-01_to_2027-06-15.csv"',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(
      new RegExp(
        `/teams/${TEAM}/exports/income\\?format=csv&period=custom&from=2027-06-01&to=2027-06-15$`,
      ),
    );
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer live-token');

    await call(`period=gst&${ALL_GROUPS}`);
    expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(
      /\/exports\/income\?format=csv&period=gst&cadence=2m-odd&end=2027-05$/,
    );
    await call(`period=fy&${ALL_GROUPS}`);
    expect(String(fetchMock.mock.calls[2]?.[0])).toMatch(
      /\/exports\/income\?format=csv&period=fy&year=2026-27$/,
    );
  });
});

describe('GET /teams/[teamId]/manage/exports/income: refusals land on the exports page', () => {
  it('a 422 field error keeps the entered values and names the field (no message text in the URL)', async () => {
    stubApi(
      apiError(422, 'validation_failed', { to: ["The end date can't be before the start date"] }),
    );
    const response = await call(
      'period=custom&format=csv&from=2027-06-15&to=2027-06-01&gst=2m-odd%2F2027-05&year=2026-27',
    );
    expect(response.status).toBe(303);
    const location = response.headers.get('location') ?? '';
    expect(location).toBe(
      `http://localhost:3000${PAGE}?period=custom&from=2027-06-15&to=2027-06-01&format=csv&download_error=validation_failed&field=to`,
    );
    expect(location).not.toContain('start%20date');
  });

  it('maps 429 export_busy, 422 export_too_large, 403 and a 5xx to their codes', async () => {
    const landing = async (response: Response) => {
      stubApi(response);
      const result = await call(`period=fy&${ALL_GROUPS}`);
      expect(result.status).toBe(303);
      return result.headers.get('location');
    };
    const base = `http://localhost:3000${PAGE}?period=fy&year=2026-27&format=csv&download_error=`;
    expect(await landing(apiError(429, 'export_busy'))).toBe(`${base}export_busy`);
    expect(await landing(apiError(422, 'export_too_large'))).toBe(`${base}export_too_large`);
    expect(await landing(apiError(403, 'forbidden'))).toBe(`${base}forbidden`);
    expect(await landing(apiError(500, 'internal_error'))).toBe(`${base}service_unavailable`);
  });

  it('a dead session goes through /auth/session-expired back to the exports page', async () => {
    stubApi(apiError(401, 'session_expired'));
    const response = await call(`period=fy&${ALL_GROUPS}`);
    expect(response.headers.get('location')).toBe(
      `http://localhost:3000/auth/session-expired?returnTo=${encodeURIComponent(PAGE)}`,
    );
  });

  it('refuses an unknown period type and a malformed team id without calling the API', async () => {
    const fetchMock = stubApi(new Response('never'));
    const unknown = await call('period=monthly&format=csv');
    expect(unknown.headers.get('location')).toBe(
      `http://localhost:3000${PAGE}?format=csv&download_error=validation_failed&field=period`,
    );
    const malformed = await call(`period=fy&${ALL_GROUPS}`, 'not-a-uuid');
    expect(malformed.headers.get('location')).toBe(
      'http://localhost:3000/teams?download_error=not_found',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /teams/[teamId]/manage/exports/income: cancellation (CR-3)', () => {
  it('closing the browser request aborts the API fetch, so the API cancels its statement', async () => {
    const controller = new AbortController();
    let upstream: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            upstream = init?.signal ?? undefined;
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      ),
    );
    const pending = call(`period=fy&${ALL_GROUPS}`, TEAM, { signal: controller.signal });
    await vi.waitFor(() => {
      expect(upstream).toBeDefined();
    });
    expect(upstream?.aborted).toBe(false);
    controller.abort();
    expect(upstream?.aborted).toBe(true);
    await pending;
  });
});
