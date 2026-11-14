/**
 * The binary download proxy of the Next route handlers (tax-invoices-and-exports architecture Decision D1; AC-ENTRY-1, 3,
 * AC-HAPPY-1, AC-ERROR-2). The browser never talks to the API (systemPatterns, Web to API), so a download goes through a GET
 * route handler that forwards the session bearer and:
 *
 *   - on 200, streams the API's bytes back with an ALLOWLISTED header set (`content-type` of a known document type, an
 *     `attachment` `content-disposition`, `content-length`), adds `cache-control: no-store` and `x-content-type-options: nosniff`,
 *     and never buffers the file in this process;
 *   - on ANY failure answers `303 See Other` to a validated `returnTo` page with `?download_error=<code>`, so the person never
 *     sees a raw JSON body and the page renders the sentence; a dead session goes through `/auth/session-expired`, a missing
 *     cookie to the sign-in page. A network failure or timeout is `service_unavailable`.
 *
 * `returnTo` goes through the shared `safeReturnTo` (same-origin path only), and nothing sensitive (a name, an amount, a file
 * name) is ever put in a URL or a log line: only a status and a code.
 */
import { safeReturnTo } from '@sgm/shared';
import { NextResponse, type NextRequest } from 'next/server';
import { buildApiHeaders } from '../api-client.ts';
import { cookieName } from '../auth/cookies.ts';
import { loginUrl, sessionExpiredUrl } from '../auth/landing.ts';
import { loadWebConfig } from '../config.ts';
import { log } from '../log.ts';
import { withDownloadError, type DownloadErrorCode } from './paths.ts';

/** How long a download may take (the API renders one page in tens of milliseconds; an export is bounded by its row cap). */
export const DOWNLOAD_TIMEOUT_MS = 30_000;

const ALLOWED_CONTENT_TYPES: readonly string[] = [
  'application/pdf',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

/** What an API error code becomes on the landing page. Anything unlisted is `service_unavailable`. */
function landingCode(status: number, apiCode: string | undefined): DownloadErrorCode {
  if (
    apiCode === 'invoice_not_available' ||
    apiCode === 'invoice_pending' ||
    apiCode === 'export_too_large' ||
    apiCode === 'export_busy'
  ) {
    return apiCode;
  }
  if (status === 404 || status === 422) return 'not_found';
  if (status === 403) return 'forbidden';
  return 'service_unavailable';
}

export interface ProxyDownloadInput {
  /** The API path (with its query string), already built from validated ids. */
  readonly apiPath: string;
  readonly request: NextRequest;
  /** Where an error lands when the request has no valid `returnTo` (the page the link lives on). */
  readonly fallbackReturnTo: string;
  /** True when the route fixes the landing page: the request's `returnTo` is ignored and `fallbackReturnTo` always used. */
  readonly ignoreReturnTo?: boolean;
  /**
   * Builds the landing path of a failed download from the failure and the validated landing page. Default: the page with
   * `download_error=<code>`. The income export uses it to send the entered values and the 422 field names back to its form.
   */
  readonly landing?: (failure: DownloadFailure, target: string) => string;
}

/** Why a download failed, as the landing builder sees it. `fields` are the 422 `fieldErrors` keys (names only, no text). */
export interface DownloadFailure {
  /** The API status, or 0 when the API could not be reached. */
  readonly status: number;
  readonly apiCode: string | undefined;
  /** The default landing code for this failure. */
  readonly code: DownloadErrorCode;
  readonly fields: readonly string[];
}

function fieldNamesOf(body: unknown): string[] {
  const fieldErrors = (body as { error?: { fieldErrors?: unknown } } | null)?.error?.fieldErrors;
  return typeof fieldErrors === 'object' && fieldErrors !== null ? Object.keys(fieldErrors) : [];
}

/** `303 See Other` to a same-origin path (built by the caller from validated parts). */
export const seeOther = (target: string): NextResponse =>
  NextResponse.redirect(new URL(target, loadWebConfig().webBaseUrl), 303);

/** The page an error lands on: the request's own `returnTo` when it is a safe same-origin path, else the fallback. */
export function landingTarget(request: NextRequest, fallbackReturnTo: string): string {
  const requested = request.nextUrl.searchParams.get('returnTo');
  const safe = safeReturnTo(requested);
  return requested === null || safe === '/' ? fallbackReturnTo : safe;
}

/** Answers a request that cannot be served (a malformed id) like any other failure: 303 to the landing page with the code. */
export function refuseDownload(
  request: NextRequest,
  fallbackReturnTo: string,
  code: DownloadErrorCode,
): NextResponse {
  return seeOther(withDownloadError(landingTarget(request, fallbackReturnTo), code));
}

export async function proxyDownload(input: ProxyDownloadInput): Promise<NextResponse> {
  const { request, apiPath } = input;
  const target =
    input.ignoreReturnTo === true
      ? input.fallbackReturnTo
      : landingTarget(request, input.fallbackReturnTo);
  const land = (failure: DownloadFailure): NextResponse =>
    seeOther(
      input.landing === undefined
        ? withDownloadError(target, failure.code)
        : input.landing(failure, target),
    );
  const unavailable = (status: number): NextResponse =>
    land({ status, apiCode: undefined, code: 'service_unavailable', fields: [] });
  const config = loadWebConfig();
  const token = request.cookies.get(cookieName('session', config.webBaseUrl))?.value;
  if (token === undefined || token === '') return seeOther(loginUrl({ returnTo: target }));

  let upstream: Response;
  try {
    const { headers, apiInternalUrl } = buildApiHeaders({
      session: token,
      incoming: request.headers,
    });
    upstream = await fetch(`${apiInternalUrl}${apiPath}`, {
      method: 'GET',
      headers,
      cache: 'no-store',
      redirect: 'manual',
      // The person closing the tab cancels the API call too.
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
    });
  } catch {
    log.warn('web.download.unreachable', { status: 0 });
    return unavailable(0);
  }

  if (upstream.status === 401) {
    await upstream.body?.cancel();
    return seeOther(sessionExpiredUrl(target));
  }

  if (upstream.ok) {
    const contentType = upstream.headers.get('content-type') ?? '';
    const disposition = upstream.headers.get('content-disposition') ?? '';
    const allowed = ALLOWED_CONTENT_TYPES.some((type) =>
      contentType.toLowerCase().startsWith(type),
    );
    if (allowed && disposition.toLowerCase().startsWith('attachment;') && upstream.body !== null) {
      const headers = new Headers({
        'content-type': contentType,
        'content-disposition': disposition,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      const length = upstream.headers.get('content-length');
      if (length !== null && upstream.headers.get('content-encoding') === null) {
        headers.set('content-length', length);
      }
      return new NextResponse(upstream.body, { status: 200, headers });
    }
    log.warn('web.download.unexpected_response', { status: upstream.status });
    await upstream.body?.cancel();
    return unavailable(upstream.status);
  }

  const body: unknown = await upstream.json().catch(() => null);
  const apiCode = (body as { error?: { code?: unknown } } | null)?.error?.code;
  const knownCode = typeof apiCode === 'string' ? apiCode : undefined;
  const code = landingCode(upstream.status, knownCode);
  if (code === 'service_unavailable')
    log.warn('web.download.api_failure', { status: upstream.status });
  return land({ status: upstream.status, apiCode: knownCode, code, fields: fieldNamesOf(body) });
}
