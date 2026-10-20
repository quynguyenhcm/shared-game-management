import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CreateSeriesRequest,
  EndSeriesRequest,
  EndSeriesResponse,
  ErrorResponse,
  PublishDraftsResponse,
  SeriesDetailResponse,
  SeriesIdParams,
  SeriesSaveResponse,
  SessionErrorResponse,
  TeamIdParams,
  UpdateSeriesRequest,
} from '@sgm/shared';
import { requireTeamRole } from '../../lib/auth/policy.ts';
import { requireAuth } from '../../lib/auth/request-auth.ts';
import type { SessionsContext } from './service.ts';
import type { SeriesService } from './series.ts';

export interface SeriesRoutesOptions {
  readonly service: SeriesService;
}

const contextOf = (request: FastifyRequest): SessionsContext => ({ log: request.log });

const ERRORS = {
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  409: SessionErrorResponse,
  422: SessionErrorResponse,
} as const;

const SHAPE =
  'TEAM_ADMIN of this team only (`allowGlobalAdmin` is off); a series of another team is 404 `not_found`. The actor is re-checked as an approved admin under a row lock inside every write (403 when demoted meanwhile). Writes that change a series carry `expectedVersion`: a stale one is 409 `series_stale` with the latest series in `error.current`, and nothing is written.';

/**
 * `/teams/:teamId/session-series` (session-scheduling-engine, recurring series): create with replay, read, edit with
 * synchronous propagation, End series and "Publish drafts now". Registered by `sessionsRoutes`, so it shares its prefix and its
 * `cache-control: no-store` hook. The per-rule materialiser job is only ever enqueued here; the API never materialises.
 */
export const seriesRoutes: FastifyPluginAsync<SeriesRoutesOptions> = (app, options) => {
  const { service } = options;
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const policy = requireTeamRole('TEAM_ADMIN');

  typed.post(
    '/:teamId/session-series',
    {
      config: { policy },
      schema: {
        summary: 'Create a recurring series',
        description: `Stores the rule and its court template and queues one materialisation run in the same transaction; the sessions appear within moments, published as they are created unless the team's banking gate refuses (those stay drafts). \`createKey\` is a UUID the form generates once per render: a replay of a committed request answers 200 with the existing series and queues nothing. The series stays \`materialising: true\` until its first run completes. ${SHAPE}`,
        operationId: 'createTeamSeries',
        params: TeamIdParams,
        body: CreateSeriesRequest,
        response: { 200: SeriesDetailResponse, 201: SeriesDetailResponse, ...ERRORS },
      },
    },
    async (request, reply) => {
      const { replayed, response } = await service.create(
        request.params.teamId,
        requireAuth(request).userId,
        request.body,
        contextOf(request),
      );
      void reply.code(replayed ? 200 : 201);
      return response;
    },
  );

  typed.get(
    '/:teamId/session-series/:ruleId',
    {
      config: { policy },
      schema: {
        summary: 'Read one series',
        description: `The series defaults, its court template and \`materialising\` (true while the last run trails \`version\`). ${SHAPE}`,
        operationId: 'getTeamSeries',
        params: SeriesIdParams,
        response: { 200: SeriesDetailResponse, ...ERRORS },
      },
    },
    async (request) => service.get(request.params.teamId, request.params.ruleId),
  );

  typed.put(
    '/:teamId/session-series/:ruleId',
    {
      config: { policy },
      schema: {
        summary: 'Edit a series',
        description: `Replaces the series defaults and court template and updates, in the same transaction, every future, unedited DRAFT or PUBLISHED date: each takes all of the change or none of it. Edited, started, closed and cancelled dates, published dates whose cancellation deadline has passed (now or after the change) and published dates with registered players whose fees would rise are left as they are and counted in \`outcome.skipped\`. A raise of public capacity on a published date calls the seat allocator once. The day, frequency, monthly week and first date are fixed after creation (422 \`series_pattern_fixed\`); \`recurUntil\` can only be extended or cleared (shortening goes through End series). A free-to-paid change that would reach a PUBLISHED date goes through the publish gate first and is refused whole with 409 \`payout_not_configured\`. A save that changes nothing is 200 and writes nothing. An ended series is 409 \`series_ended\`. ${SHAPE}`,
        operationId: 'updateTeamSeries',
        params: SeriesIdParams,
        body: UpdateSeriesRequest,
        response: { 200: SeriesSaveResponse, ...ERRORS },
      },
    },
    async (request) =>
      service.update(
        request.params.teamId,
        request.params.ruleId,
        requireAuth(request).userId,
        request.body,
        contextOf(request),
      ),
  );

  typed.post(
    '/:teamId/session-series/:ruleId/end',
    {
      config: { policy },
      schema: {
        summary: 'End a series',
        description: `Sets \`recurUntil\` to \`lastDate\` (the series becomes inactive when that date is today or earlier). After that date, unedited drafts are deleted; edited drafts and published sessions are kept, or the published ones cancelled when \`alsoCancelPublished\` is true (registrations are left as they are and nobody is emailed; \`activeRegistrationCount\` is how many players the admin should let know). Dates on or before \`lastDate\` are untouched. ${SHAPE}`,
        operationId: 'endTeamSeries',
        params: SeriesIdParams,
        body: EndSeriesRequest,
        response: { 200: EndSeriesResponse, ...ERRORS },
      },
    },
    async (request) =>
      service.end(
        request.params.teamId,
        request.params.ruleId,
        requireAuth(request).userId,
        request.body,
        contextOf(request),
      ),
  );

  typed.post(
    '/:teamId/session-series/:ruleId/publish-drafts',
    {
      config: { policy },
      schema: {
        summary: "Publish a series' drafts now",
        description: `Queues one materialisation run (\`manual\`) that retries the series' unedited banking-refused drafts through the publish gate. Answers 202; \`queued\` is false when a run was already waiting (a double click leaves one). Edited drafts are never published by it. ${SHAPE}`,
        operationId: 'publishTeamSeriesDrafts',
        params: SeriesIdParams,
        body: z.strictObject({}).optional(),
        response: { 202: PublishDraftsResponse, ...ERRORS },
      },
    },
    async (request, reply) => {
      const response = await service.publishDrafts(
        request.params.teamId,
        request.params.ruleId,
        requireAuth(request).userId,
        contextOf(request),
      );
      void reply.code(202);
      return response;
    },
  );

  return Promise.resolve();
};
