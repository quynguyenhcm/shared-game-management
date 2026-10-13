import { context, propagation } from '@opentelemetry/api';
import { HealthResponse } from '@sgm/shared';

const REQUEST_TIMEOUT_MS = 2000;

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isValidTraceparent(value: string | undefined): value is string {
  const match = value === undefined ? null : TRACEPARENT.exec(value);
  return match !== null && !/^0+$/.test(match[1] ?? '') && !/^0+$/.test(match[2] ?? '');
}

/**
 * W3C trace context for a server-side API call (web -> API). Order: the active OpenTelemetry span
 * (when an SDK is registered), else the incoming request's `traceparent` continued with a new span
 * id, else a fresh root trace. Every API call therefore carries a `traceparent`.
 */
/** Anything with `get` (a `Headers` or Next's read-only `headers()`), or a plain record. */
export type IncomingHeaders = Pick<Headers, 'get'> | Record<string, string | undefined>;

export function traceHeaders(incoming?: IncomingHeaders): Record<string, string> {
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);
  if (isValidTraceparent(headers.traceparent)) return headers;

  const read = (name: string): string | undefined =>
    incoming !== undefined && typeof incoming.get === 'function'
      ? ((incoming as Pick<Headers, 'get'>).get(name) ?? undefined)
      : (incoming as Record<string, string | undefined> | undefined)?.[name];
  const traceparent = read('traceparent');
  const tracestate = read('tracestate');
  if (isValidTraceparent(traceparent)) {
    const [, traceId, , flags] = TRACEPARENT.exec(traceparent) ?? [];
    const result: Record<string, string> = {
      traceparent: `00-${traceId ?? ''}-${randomHex(8)}-${flags ?? '01'}`,
    };
    if (tracestate) result.tracestate = tracestate;
    return result;
  }
  return { traceparent: `00-${randomHex(16)}-${randomHex(8)}-01` };
}

function baseUrl(): string {
  return process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
}

export const apiClient = {
  /**
   * Fetches API health server-side. Returns null on any failure or timeout (never throws), so a
   * stopped API renders "unavailable" instead of a 500.
   */
  async health(incoming?: IncomingHeaders): Promise<HealthResponse | null> {
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
