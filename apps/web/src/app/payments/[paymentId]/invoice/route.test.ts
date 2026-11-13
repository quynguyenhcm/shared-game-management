import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/log.ts', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { GET } = await import('./route.ts');

const ID = '22222222-2222-4222-8222-222222222222';

const call = (paymentId: string, search = '') =>
  GET(
    new NextRequest(`http://localhost:3000/payments/${paymentId}/invoice${search}`, {
      headers: { cookie: 'sgm_session=live-token' },
    }),
    { params: Promise.resolve({ paymentId }) },
  );

afterEach(() => vi.unstubAllGlobals());

describe('GET /payments/[paymentId]/invoice', () => {
  it('proxies the payer route of the API and streams the PDF', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response('%PDF-1', {
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': 'attachment; filename="receipt-RCT-000001.pdf"',
          },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const response = await call(ID);
    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(new RegExp(`/payments/${ID}/invoice$`));
  });

  it('lands an error on the payment page by default and never calls the API for a malformed id', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        Response.json({ error: { code: 'invoice_not_available', message: 'x' } }, { status: 409 }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect((await call(ID)).headers.get('location')).toBe(
      `http://localhost:3000/payments/${ID}?download_error=invoice_not_available`,
    );
    fetchMock.mockClear();
    const malformed = await call('not-a-uuid');
    expect(malformed.headers.get('location')).toBe(
      'http://localhost:3000/payments?download_error=not_found',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
