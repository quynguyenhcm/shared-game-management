import { context, propagation } from '@opentelemetry/api';
import {
  AuthSuccessResponse,
  BankingResponse,
  CancelSessionResponse,
  CreateTeamResponse,
  DstOptionsEntry,
  EndSeriesResponse,
  ErrorResponse,
  FindTeamsResponse,
  ForgotPasswordResponse,
  GstResponse,
  HealthResponse,
  IdentitiesResponse,
  InviteCodeResponse,
  InviteLookupResponse,
  JoinRequestResponse,
  MeResponse,
  MemberSkillChangeResponse,
  MembersResponse,
  MineTeamsResponse,
  ModerationResponse,
  OAuthAuthorizeResponse,
  OAuthCallbackResponse,
  OAuthCompleteResponse,
  OAuthPendingResponse,
  ProvidersResponse,
  PublishDraftsResponse,
  RemoveBankingResponse,
  ResetPasswordResponse,
  SeriesDetailResponse,
  SeriesListResponse,
  SeriesSaveResponse,
  SessionDetailResponse,
  SessionListResponse,
  SessionWriteResponse,
  TeamDetailResponse,
  type CreateSeriesRequest,
  type CreateSessionRequest,
  type EndSeriesRequest,
  type UpdateSeriesRequest,
  type UpdateSessionRequest,
  type ListSessionsQuery,
  type SessionCommandRequest,
  type BanMemberRequest,
  type CreateTeamRequest,
  type FindTeamsQuery,
  type MembersQuery,
  type ForgotPasswordRequest,
  type InviteLookupRequest,
  type JoinRequestRequest,
  type LoginRequest,
  type OAuthAuthorizeRequest,
  type OAuthCallbackRequest,
  type OAuthCompleteRequest,
  type PutBankingRequest,
  type PutGstRequest,
  type RegisterRequest,
  type ResetPasswordRequest,
  type SetAutoEnrollRequest,
  type SetSkillLevelRequest,
} from '@sgm/shared';
import { z } from 'zod';
import { deriveClientAddress } from './auth/client-address.ts';
import { loadWebConfig } from './config.ts';

/** The wire (input) form of a sessions body: money as strings, never the parsed `Money` the schema outputs. */
export type CreateSessionBody = z.input<typeof CreateSessionRequest>;
export type UpdateSessionBody = z.input<typeof UpdateSessionRequest>;
export type CreateSeriesBody = z.input<typeof CreateSeriesRequest>;
export type UpdateSeriesBody = z.input<typeof UpdateSeriesRequest>;
export type EndSeriesBody = z.input<typeof EndSeriesRequest>;

const REQUEST_TIMEOUT_MS = 2000;
const AUTH_TIMEOUT_MS = 5000;

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

/** Anything with `get` (a `Headers` or Next's read-only `headers()`), or a plain record. */
export type IncomingHeaders = Pick<Headers, 'get'> | Record<string, string | undefined>;

function readHeader(incoming: IncomingHeaders | undefined, name: string): string | undefined {
  if (incoming === undefined) return undefined;
  return typeof incoming.get === 'function'
    ? ((incoming as Pick<Headers, 'get'>).get(name) ?? undefined)
    : (incoming as Record<string, string | undefined>)[name];
}

/**
 * W3C trace context for a server-side API call (web -> API). Order: the active OpenTelemetry span
 * (when an SDK is registered), else the incoming request's `traceparent` continued with a new span
 * id, else a fresh root trace. Every API call therefore carries a `traceparent`.
 */
export function traceHeaders(incoming?: IncomingHeaders): Record<string, string> {
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);
  if (isValidTraceparent(headers.traceparent)) return headers;

  const traceparent = readHeader(incoming, 'traceparent');
  const tracestate = readHeader(incoming, 'tracestate');
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

/** A failed call: the API's error body, or a synthetic one for network failures, timeouts and bad bodies. */
export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      /** HTTP status, or 0 when no response arrived (network error, timeout). */
      status: number;
      error: ErrorResponse['error'];
      retryAfterSeconds?: number;
      /** Session routes only (422): the wall-clock times that do not exist or happen twice, with what can be stored. */
      dstOptions?: DstOptionsEntry[];
      /** Session routes only (409 `session_fee_locked`): the snake_case fee columns the edit would have raised. */
      raisedFields?: string[];
    };

export interface ApiCallOptions {
  /** Session token for `Authorization: Bearer`. */
  session?: string | null;
  /** The incoming request's headers: only `traceparent`, `tracestate`, `user-agent` and `x-forwarded-for` are read. */
  incoming?: IncomingHeaders;
}

interface ApiRequest<T> extends ApiCallOptions {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  schema?: z.ZodType<T>;
  /** Extra request headers (an allowlisted few, set by `apiClient` only; never copied from the browser). */
  extraHeaders?: Record<string, string>;
}

/**
 * What only session routes add to an error body: `dstOptions` and `raisedFields`. Each is read on its own with
 * the shared schema, so a malformed extra is dropped and can never hide the error code.
 */
function sessionErrorExtras(raw: unknown): {
  dstOptions?: DstOptionsEntry[];
  raisedFields?: string[];
} {
  const error = (raw as { error?: Record<string, unknown> } | null)?.error;
  if (error === null || typeof error !== 'object') return {};
  const dst = DstOptionsEntry.array().safeParse(error.dstOptions);
  const raised = z.array(z.string()).safeParse(error.raisedFields);
  return {
    ...(dst.success ? { dstOptions: dst.data } : {}),
    ...(raised.success ? { raisedFields: raised.data } : {}),
  };
}

/** The lower-case path spelling of an OAuth provider (`/auth/oauth/:provider/*`). */
export type OAuthProviderPath = 'google' | 'facebook';

function failure<T>(
  status: number,
  code: ErrorResponse['error']['code'],
  message: string,
): ApiResult<T> {
  return { ok: false, status, error: { code, message } };
}

/**
 * The one way the web talks to the API. Outgoing headers are built from an allowlist and never copied
 * from the incoming request: `x-sgm-internal-auth` comes from config and `x-sgm-client-ip` is derived
 * from `X-Forwarded-For` with the trusted hop count (or omitted). Never throws on 4xx, 5xx, a network
 * error or a timeout.
 */
export async function apiFetch<T>(request: ApiRequest<T>): Promise<ApiResult<T>> {
  try {
    const config = loadWebConfig();
    const headers: Record<string, string> = { ...traceHeaders(request.incoming) };
    const userAgent = readHeader(request.incoming, 'user-agent');
    if (userAgent) headers['user-agent'] = userAgent;
    if (config.internalAuthSecret !== null)
      headers['x-sgm-internal-auth'] = config.internalAuthSecret;
    const clientAddress = deriveClientAddress(
      readHeader(request.incoming, 'x-forwarded-for'),
      config.trustedProxyHops,
    );
    if (clientAddress !== null) headers['x-sgm-client-ip'] = clientAddress;
    if (request.session) headers.authorization = `Bearer ${request.session}`;
    Object.assign(headers, request.extraHeaders);
    if (request.body !== undefined) headers['content-type'] = 'application/json';

    const response = await fetch(`${config.apiInternalUrl}${request.path}`, {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });

    if (response.ok) {
      if (request.schema === undefined)
        return { ok: true, status: response.status, data: undefined as T };
      const parsed = request.schema.safeParse(await response.json());
      return parsed.success
        ? { ok: true, status: response.status, data: parsed.data }
        : failure(response.status, 'internal_error', 'Unexpected response from the API.');
    }

    const retryAfter = Number(response.headers.get('retry-after'));
    const raw: unknown = await response.json().catch(() => null);
    const body = ErrorResponse.safeParse(raw);
    const error = body.success
      ? body.data.error
      : {
          code:
            response.status >= 500 ? ('service_unavailable' as const) : ('internal_error' as const),
          message: 'Unexpected response from the API.',
        };
    return {
      ok: false,
      status: response.status,
      error,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
      ...sessionErrorExtras(raw),
    };
  } catch {
    return failure(0, 'service_unavailable', 'The API could not be reached.');
  }
}

export const apiClient = {
  /**
   * Fetches API health server-side. Returns null on any failure or timeout (never throws), so a
   * stopped API renders "unavailable" instead of a 500.
   */
  async health(incoming?: IncomingHeaders): Promise<HealthResponse | null> {
    try {
      const response = await fetch(`${loadWebConfig().apiInternalUrl}/health`, {
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

  register: (body: RegisterRequest, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: '/auth/register',
      method: 'POST',
      body,
      schema: AuthSuccessResponse,
    }),

  login: (body: LoginRequest, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: '/auth/login',
      method: 'POST',
      body,
      schema: AuthSuccessResponse,
    }),

  logout: (options: ApiCallOptions = {}) =>
    apiFetch<undefined>({ ...options, path: '/auth/logout', method: 'POST' }),

  me: (session: string, options: Omit<ApiCallOptions, 'session'> = {}) =>
    apiFetch({ ...options, session, path: '/auth/me', method: 'GET', schema: MeResponse }),

  providers: (options: ApiCallOptions = {}) =>
    apiFetch({ ...options, path: '/auth/providers', method: 'GET', schema: ProvidersResponse }),

  forgotPassword: (body: ForgotPasswordRequest, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: '/auth/password/forgot',
      method: 'POST',
      body,
      schema: ForgotPasswordResponse,
    }),

  resetPassword: (body: ResetPasswordRequest, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: '/auth/password/reset',
      method: 'POST',
      body,
      schema: ResetPasswordResponse,
    }),

  oauthAuthorize: (
    provider: OAuthProviderPath,
    body: OAuthAuthorizeRequest,
    options: ApiCallOptions = {},
  ) =>
    apiFetch({
      ...options,
      path: `/auth/oauth/${provider}/authorize`,
      method: 'POST',
      body,
      schema: OAuthAuthorizeResponse,
    }),

  /** Forward the session (when there is one) so a connect flow can prove it is the same user. */
  oauthCallback: (
    provider: OAuthProviderPath,
    body: OAuthCallbackRequest,
    options: ApiCallOptions = {},
  ) =>
    apiFetch({
      ...options,
      path: `/auth/oauth/${provider}/callback`,
      method: 'POST',
      body,
      schema: OAuthCallbackResponse,
    }),

  /** The pending sign-up handle travels in a header, never in the URL. */
  oauthPending: (pendingToken: string, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: '/auth/oauth/pending',
      method: 'GET',
      extraHeaders: { 'x-pending-signup': pendingToken },
      schema: OAuthPendingResponse,
    }),

  oauthComplete: (body: OAuthCompleteRequest, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: '/auth/oauth/complete',
      method: 'POST',
      body,
      schema: OAuthCompleteResponse,
    }),

  identities: (session: string, options: Omit<ApiCallOptions, 'session'> = {}) =>
    apiFetch({
      ...options,
      session,
      path: '/auth/identities',
      method: 'GET',
      schema: IdentitiesResponse,
    }),

  startLink: (
    provider: OAuthProviderPath,
    session: string,
    options: Omit<ApiCallOptions, 'session'> = {},
  ) =>
    apiFetch({
      ...options,
      session,
      path: `/auth/identities/${provider}/link`,
      method: 'POST',
      schema: OAuthAuthorizeResponse,
    }),

  unlink: (
    provider: OAuthProviderPath,
    session: string,
    options: Omit<ApiCallOptions, 'session'> = {},
  ) =>
    apiFetch<undefined>({
      ...options,
      session,
      path: `/auth/identities/${provider}`,
      method: 'DELETE',
    }),

  // -------------------------------------------------------------------------------------------
  // Teams (team-management). `session` is required for the authenticated routes and optional for
  // Find and the team page (the API treats a bad token there as anonymous).
  // -------------------------------------------------------------------------------------------

  createTeam: (body: CreateTeamRequest, options: ApiCallOptions = {}) =>
    apiFetch({ ...options, path: '/teams', method: 'POST', body, schema: CreateTeamResponse }),

  findTeams: (query: Pick<FindTeamsQuery, 'q' | 'after'>, options: ApiCallOptions = {}) => {
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.after) params.set('after', query.after);
    const text = params.toString();
    return apiFetch({
      ...options,
      path: text === '' ? '/teams/find' : `/teams/find?${text}`,
      method: 'GET',
      schema: FindTeamsResponse,
    });
  },

  mineTeams: (session: string, options: Omit<ApiCallOptions, 'session'> = {}) =>
    apiFetch({
      ...options,
      session,
      path: '/teams/mine',
      method: 'GET',
      schema: MineTeamsResponse,
    }),

  teamDetail: (teamId: string, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}`,
      method: 'GET',
      schema: TeamDetailResponse,
    }),

  /** POST so the invite code travels in the body and never in a URL the API logs. */
  inviteLookup: (body: InviteLookupRequest, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: '/teams/invite/lookup',
      method: 'POST',
      body,
      schema: InviteLookupResponse,
    }),

  joinRequest: (teamId: string, body: JoinRequestRequest, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/join-requests`,
      method: 'POST',
      body,
      schema: JoinRequestResponse,
    }),

  // -------------------------------------------------------------------------------------------
  // Team-admin area (`TEAM_ADMIN` routes: the API answers 403 to everyone else, before validation).
  // -------------------------------------------------------------------------------------------

  /** One section per call (`status`), 50 per page, `after` is the opaque cursor of that section. */
  teamMembers: (
    teamId: string,
    query: Pick<MembersQuery, 'status' | 'after'>,
    options: ApiCallOptions = {},
  ) => {
    const params = new URLSearchParams({ status: query.status });
    if (query.after) params.set('after', query.after);
    return apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/members?${params.toString()}`,
      method: 'GET',
      schema: MembersResponse,
    });
  },

  /** Approve, reject, promote and demote take no body: sending JSON content-type with none is a 422. */
  moderateMember: (
    teamId: string,
    userId: string,
    action: 'approve' | 'reject' | 'promote' | 'demote',
    options: ApiCallOptions = {},
  ) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}/${action}`,
      method: 'POST',
      schema: ModerationResponse,
    }),

  banMember: (
    teamId: string,
    userId: string,
    body: BanMemberRequest,
    options: ApiCallOptions = {},
  ) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}/ban`,
      method: 'POST',
      body,
      schema: ModerationResponse,
    }),

  /** Admin override of a member's level; the body carries what the panel was showing (optimistic concurrency). */
  setSkillLevel: (
    teamId: string,
    userId: string,
    body: SetSkillLevelRequest,
    options: ApiCallOptions = {},
  ) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}/skill-level`,
      method: 'PUT',
      body,
      schema: MemberSkillChangeResponse,
    }),

  setAutoEnroll: (
    teamId: string,
    userId: string,
    body: SetAutoEnrollRequest,
    options: ApiCallOptions = {},
  ) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}/auto-enroll`,
      method: 'PUT',
      body,
      schema: MemberSkillChangeResponse,
    }),

  teamInviteCode: (teamId: string, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/invite-code`,
      method: 'GET',
      schema: InviteCodeResponse,
    }),

  /** POST with NO body and no JSON content-type (the route takes none; an empty JSON body is a 422). */
  regenerateInviteCode: (teamId: string, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/invite-code/regenerate`,
      method: 'POST',
      schema: InviteCodeResponse,
    }),

  // -------------------------------------------------------------------------------------------
  // Team banking and GST (`TEAM_ADMIN` routes; responses are masked, never the full account number).
  // -------------------------------------------------------------------------------------------

  teamBanking: (teamId: string, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/banking`,
      method: 'GET',
      schema: BankingResponse,
    }),

  putTeamBanking: (teamId: string, body: PutBankingRequest, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/banking`,
      method: 'PUT',
      body,
      schema: BankingResponse,
    }),

  /** DELETE takes no body (the route has none; the API generates its own idempotency key). */
  removeTeamBanking: (teamId: string, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/banking`,
      method: 'DELETE',
      schema: RemoveBankingResponse,
    }),

  teamGst: (teamId: string, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/gst`,
      method: 'GET',
      schema: GstResponse,
    }),

  putTeamGst: (teamId: string, body: PutGstRequest, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/gst`,
      method: 'PUT',
      body,
      schema: GstResponse,
    }),

  // -------------------------------------------------------------------------------------------
  // Sessions and series (session-scheduling-engine; `TEAM_ADMIN` routes, never cached). The ids are
  // encoded, so a hostile id can never change the path.
  // -------------------------------------------------------------------------------------------

  /** One list section per call: `view`, keyset `cursor` and `limit` (the API defaults to 25). */
  listSessions: (
    teamId: string,
    query: Pick<ListSessionsQuery, 'view'> & { cursor?: string | undefined; limit?: number },
    options: ApiCallOptions = {},
  ) => {
    const params = new URLSearchParams({ view: query.view });
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor) params.set('cursor', query.cursor);
    return apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/sessions?${params.toString()}`,
      method: 'GET',
      schema: SessionListResponse,
    });
  },

  createSession: (teamId: string, body: CreateSessionBody, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/sessions`,
      method: 'POST',
      body,
      schema: SessionWriteResponse,
    }),

  getSession: (teamId: string, sessionId: string, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/sessions/${encodeURIComponent(sessionId)}`,
      method: 'GET',
      schema: SessionDetailResponse,
    }),

  updateSession: (
    teamId: string,
    sessionId: string,
    body: UpdateSessionBody,
    options: ApiCallOptions = {},
  ) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/sessions/${encodeURIComponent(sessionId)}`,
      method: 'PUT',
      body,
      schema: SessionWriteResponse,
    }),

  publishSession: (
    teamId: string,
    sessionId: string,
    body: SessionCommandRequest,
    options: ApiCallOptions = {},
  ) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/sessions/${encodeURIComponent(sessionId)}/publish`,
      method: 'POST',
      body,
      schema: SessionWriteResponse,
    }),

  cancelSession: (
    teamId: string,
    sessionId: string,
    body: SessionCommandRequest,
    options: ApiCallOptions = {},
  ) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/sessions/${encodeURIComponent(sessionId)}/cancel`,
      method: 'POST',
      body,
      schema: CancelSessionResponse,
    }),

  createSeries: (teamId: string, body: CreateSeriesBody, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/session-series`,
      method: 'POST',
      body,
      schema: SeriesDetailResponse,
    }),

  listSeries: (teamId: string, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/session-series`,
      method: 'GET',
      schema: SeriesListResponse,
    }),

  getSeries: (teamId: string, ruleId: string, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/session-series/${encodeURIComponent(ruleId)}`,
      method: 'GET',
      schema: SeriesDetailResponse,
    }),

  updateSeries: (
    teamId: string,
    ruleId: string,
    body: UpdateSeriesBody,
    options: ApiCallOptions = {},
  ) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/session-series/${encodeURIComponent(ruleId)}`,
      method: 'PUT',
      body,
      schema: SeriesSaveResponse,
    }),

  endSeries: (teamId: string, ruleId: string, body: EndSeriesBody, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/session-series/${encodeURIComponent(ruleId)}/end`,
      method: 'POST',
      body,
      schema: EndSeriesResponse,
    }),

  /** POST with NO body and no JSON content-type: "Publish drafts now" answers 202. */
  publishSeriesDrafts: (teamId: string, ruleId: string, options: ApiCallOptions = {}) =>
    apiFetch({
      ...options,
      path: `/teams/${encodeURIComponent(teamId)}/session-series/${encodeURIComponent(ruleId)}/publish-drafts`,
      method: 'POST',
      schema: PublishDraftsResponse,
    }),
};
