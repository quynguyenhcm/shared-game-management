import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { landingTarget, proxyDownload, refuseDownload } from './download.ts';

vi.mock('../log.ts', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

/**
 * The Next route-handler proxy (tax-invoices-and-exports architecture D1; AC-ENTRY-1, AC-HAPPY-1, AC-ERROR-2): the API is stubbed
 * with `fetch`, so these tests prove what the web forwards, what it streams back and how every failure becomes a 303 to a
 * validated landing page, never a raw JSON body.
 */

const PAYMENT = '22222222-2222-4222-8222-222222222222';
const API_PATH = `/payments/${PAYMENT}/invoice`;
const PAGE = `/payments/${PAYMENT}`;
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

function request(returnTo?: string, cookie: string | null = 'sgm_session=live-token'): NextRequest {
  const url = new URL(`http://localhost:3000${API_PATH}`);
  if (returnTo !== undefined) url.searchParams.set('returnTo', returnTo);
  return new NextRequest(url, {
    headers: {
      ...(cookie === null ? {} : { cookie }),
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      'x-forwarded-for': '203.0.113.9',
    },
  });
}

function stubApi(response: Response | Error) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const pdfResponse = (headers: Record<string, string> = {}) =>
  new Response(PDF, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="tax-invoice-INV-000001.pdf"',
      'content-length': String(PDF.length),
      'set-cookie': 'leak=1',
      'x-powered-by': 'api',
      ...headers,
    },
  });

const errorResponse = (status: number, code: string) =>
  Response.json({ error: { code, message: 'x' } }, { status });

const run = (returnTo?: string, cookie?: string | null) =>
  proxyDownload({ apiPath: API_PATH, request: request(returnTo, cookie), fallbackReturnTo: PAGE });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('proxyDownload: success', () => {
  it('streams the API bytes with an allowlisted header set, no-store and nosniff, forwarding the bearer and trace', async () => {
    const fetchMock = stubApi(pdfResponse());
    const response = await run();

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PDF);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="tax-invoice-INV-000001.pdf"',
    );
    expect(response.headers.get('content-length')).toBe(String(PDF.length));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    // Only the allowlist crosses: an upstream cookie or server header is dropped.
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-powered-by')).toBeNull();

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(new RegExp(`${API_PATH}$`));
    const sent = init?.headers as Record<string, string>;
    expect(sent.authorization).toBe('Bearer live-token');
    expect(sent.traceparent).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
    expect(init?.method).toBe('GET');
    expect(init?.cache).toBe('no-store');
  });

  it('refuses a 200 that is not an attachment of a known document type (never forwards HTML or JSON as a file)', async () => {
    stubApi(
      new Response('{"a":1}', {
        headers: {
          'content-type': 'application/json',
          'content-disposition': 'attachment; filename="x"',
        },
      }),
    );
    expect((await run()).headers.get('location')).toBe(
      `http://localhost:3000${PAGE}?download_error=service_unavailable`,
    );
    stubApi(pdfResponse({ 'content-disposition': 'inline; filename="x.pdf"' }));
    expect((await run()).headers.get('location')).toContain('download_error=service_unavailable');
  });
});

describe('proxyDownload: every failure is a 303 to the landing page with a code', () => {
  const landing = async (response: Response | Error, returnTo?: string) => {
    stubApi(response);
    const result = await run(returnTo);
    expect(result.status).toBe(303);
    return result.headers.get('location');
  };

  it('maps the API codes to landing codes: not available, pending, not found, forbidden', async () => {
    expect(await landing(errorResponse(409, 'invoice_not_available'))).toBe(
      `http://localhost:3000${PAGE}?download_error=invoice_not_available`,
    );
    expect(await landing(errorResponse(409, 'invoice_pending'))).toContain(
      'download_error=invoice_pending',
    );
    expect(await landing(errorResponse(404, 'not_found'))).toContain('download_error=not_found');
    expect(await landing(errorResponse(422, 'validation_failed'))).toContain(
      'download_error=not_found',
    );
    expect(await landing(errorResponse(403, 'forbidden'))).toContain('download_error=forbidden');
  });

  it('maps a server error, an unreadable body, a network failure and a timeout to service_unavailable', async () => {
    expect(await landing(errorResponse(500, 'internal_error'))).toContain(
      'download_error=service_unavailable',
    );
    expect(await landing(new Response('<html>bad gateway</html>', { status: 502 }))).toContain(
      'download_error=service_unavailable',
    );
    expect(await landing(new TypeError('fetch failed'))).toContain(
      'download_error=service_unavailable',
    );
    expect(await landing(new DOMException('timed out', 'TimeoutError'))).toContain(
      'download_error=service_unavailable',
    );
  });

  it('sends a dead session through /auth/session-expired and a missing cookie to sign-in, keeping the landing page', async () => {
    stubApi(errorResponse(401, 'session_expired'));
    const expired = await run();
    expect(expired.status).toBe(303);
    expect(expired.headers.get('location')).toBe(
      `http://localhost:3000/auth/session-expired?returnTo=${encodeURIComponent(PAGE)}`,
    );

    const fetchMock = stubApi(pdfResponse());
    const anonymous = await run(undefined, null);
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get('location')).toBe(
      `http://localhost:3000/login?returnTo=${encodeURIComponent(PAGE)}`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lands on the requested returnTo (query kept, an older error replaced), never on another origin', async () => {
    const wallet =
      '/teams/7f3c2b1a-1111-4222-8333-444455556666/wallet?payments=all&download_error=not_found';
    expect(await landing(errorResponse(409, 'invoice_not_available'), wallet)).toBe(
      'http://localhost:3000/teams/7f3c2b1a-1111-4222-8333-444455556666/wallet?payments=all&download_error=invoice_not_available',
    );
    for (const hostile of [
      'https://evil.example/steal',
      '//evil.example/steal',
      '/\\evil.example',
      'javascript:alert(1)',
      '/login',
    ]) {
      expect(landingTarget(request(hostile), PAGE)).toBe(PAGE);
      stubApi(errorResponse(409, 'invoice_not_available'));
      const location = (await run(hostile)).headers.get('location') ?? '';
      expect(new URL(location).origin).toBe('http://localhost:3000');
      expect(location).toContain(PAGE);
    }
  });

  it('puts only a code in the URL: no name, amount or file name', async () => {
    const location = await landing(errorResponse(409, 'invoice_not_available'));
    expect(location).not.toMatch(/Aroha|\$|INV-|\.pdf/);
  });

  it('answers a request it cannot serve (a malformed id) like any other failure', () => {
    const response = refuseDownload(request(), '/payments', 'not_found');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/payments?download_error=not_found',
    );
  });
});

describe('proxyDownload: income export answers (tax-invoices-and-exports Phase 4, CR-3, AC-ERROR-3, 4)', () => {
  const CSV = 'Invoice number,Paid date\r\n';
  const csvResponse = () =>
    new Response(CSV, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="income_hokio_fy_2026-27.csv"',
        'content-length': String(CSV.length),
        'x-export-row-count': '0',
      },
    });

  it('streams a CSV attachment with the API file name, no-store and nosniff', async () => {
    stubApi(csvResponse());
    const response = await run();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(CSV);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="income_hokio_fy_2026-27.csv"',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('lands 429 export_busy and 422 export_too_large on their own codes', async () => {
    stubApi(errorResponse(429, 'export_busy'));
    expect((await run()).headers.get('location')).toBe(
      `http://localhost:3000${PAGE}?download_error=export_busy`,
    );
    stubApi(errorResponse(422, 'export_too_large'));
    expect((await run()).headers.get('location')).toBe(
      `http://localhost:3000${PAGE}?download_error=export_too_large`,
    );
  });

  it('hands every failure (with the 422 field names) to a custom landing builder when one is given', async () => {
    const landing = vi.fn(() => '/custom?download_error=validation_failed');
    stubApi(
      Response.json(
        {
          error: {
            code: 'validation_failed',
            message: 'x',
            fieldErrors: { to: ["The end date can't be before the start date"], from: ['y'] },
          },
        },
        { status: 422 },
      ),
    );
    const response = await proxyDownload({
      apiPath: API_PATH,
      request: request(),
      fallbackReturnTo: PAGE,
      landing,
    });
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/custom?download_error=validation_failed',
    );
    expect(landing).toHaveBeenCalledWith(
      { status: 422, apiCode: 'validation_failed', code: 'not_found', fields: ['to', 'from'] },
      PAGE,
    );

    stubApi(new TypeError('fetch failed'));
    await proxyDownload({ apiPath: API_PATH, request: request(), fallbackReturnTo: PAGE, landing });
    expect(landing).toHaveBeenLastCalledWith(
      { status: 0, apiCode: undefined, code: 'service_unavailable', fields: [] },
      PAGE,
    );
  });

  it('aborting the incoming request aborts the upstream API fetch (cancellation reaches the API and its statement)', async () => {
    const controller = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            upstreamSignal = init?.signal ?? undefined;
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      ),
    );
    const incoming = new NextRequest(new URL(`http://localhost:3000${API_PATH}`), {
      headers: { cookie: 'sgm_session=live-token' },
      signal: controller.signal,
    });
    const pending = proxyDownload({ apiPath: API_PATH, request: incoming, fallbackReturnTo: PAGE });
    await vi.waitFor(() => {
      expect(upstreamSignal).toBeDefined();
    });
    expect(upstreamSignal?.aborted).toBe(false);
    controller.abort();
    expect(upstreamSignal?.aborted).toBe(true);
    expect((await pending).status).toBe(303);
  });
});
