import { HealthResponse } from '@sgm/shared';

const REQUEST_TIMEOUT_MS = 2000;

/** W3C trace-context pass-through; headers are only added when the caller has them. */
export function traceHeaders(
  incoming?: Headers | Record<string, string | undefined>,
): Record<string, string> {
  const read = (name: string): string | undefined =>
    incoming instanceof Headers ? (incoming.get(name) ?? undefined) : incoming?.[name];
  const headers: Record<string, string> = {};
  const traceparent = read('traceparent');
  const tracestate = read('tracestate');
  if (traceparent) headers.traceparent = traceparent;
  if (tracestate) headers.tracestate = tracestate;
  return headers;
}

function baseUrl(): string {
  return process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
}

export const apiClient = {
  /**
   * Fetches API health server-side. Returns null on any failure or timeout (never throws), so a
   * stopped API renders "unavailable" instead of a 500.
   */
  async health(incoming?: Headers): Promise<HealthResponse | null> {
    try {
      const response = await fetch(`${baseUrl()}/health`, {
        headers: traceHeaders(incoming),
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // 503 carries a valid degraded body; both are parsed with the shared schema.
      const parsed = HealthResponse.safeParse(await response.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  },
};
