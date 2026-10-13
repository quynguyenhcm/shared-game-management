import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient, traceHeaders } from './api-client.ts';

const INCOMING = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;

function stubFetch() {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(Response.json({ status: 'ok', db: 'ok', version: '1.0.0' })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentHeaders(fetchMock: ReturnType<typeof stubFetch>): Record<string, string> {
  return (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiClient trace propagation (web -> API)', () => {
  it('creates a W3C traceparent when the page has none, so every API call is traceable', async () => {
    const fetchMock = stubFetch();
    await expect(apiClient.health()).resolves.toMatchObject({ status: 'ok' });
    expect(sentHeaders(fetchMock).traceparent).toMatch(TRACEPARENT);
  });

  it('continues the incoming trace: same trace id as the browser/request traceparent', async () => {
    const fetchMock = stubFetch();
    await apiClient.health(new Headers({ traceparent: INCOMING, tracestate: 'a=b' }));
    const headers = sentHeaders(fetchMock);
    expect(headers.traceparent?.split('-')[1]).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(headers.tracestate).toBe('a=b');
  });

  it('ignores a malformed incoming traceparent and starts a fresh trace', () => {
    const headers = traceHeaders(new Headers({ traceparent: 'garbage' }));
    expect(headers.traceparent).toMatch(TRACEPARENT);
    expect(headers.traceparent).not.toBe('garbage');
  });
});
