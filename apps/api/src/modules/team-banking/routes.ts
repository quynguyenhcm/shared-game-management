import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  BankingResponse,
  ErrorResponse,
  GstResponse,
  PutBankingRequest,
  PutGstRequest,
  TeamIdParams,
} from '@sgm/shared';
import { requireTeamRole } from '../../lib/auth/policy.ts';
import { requireAuth } from '../../lib/auth/request-auth.ts';
import type { TeamBankingContext, TeamBankingService } from './service.ts';

export interface TeamBankingRoutesOptions {
  readonly service: TeamBankingService;
}

const contextOf = (request: FastifyRequest): TeamBankingContext => ({ log: request.log });

/** The guard answers 401/403 in `onRequest`, before the body is parsed; the service answers 409/422. */
const ERROR_RESPONSES = {
  401: ErrorResponse,
  403: ErrorResponse,
  409: ErrorResponse,
  422: ErrorResponse,
} as const;

/**
 * `/teams/:teamId/banking` and `/teams/:teamId/gst`: `TEAM_ADMIN` of the team in the path only
 * (`allowGlobalAdmin` is off), strict bodies, and `cache-control: no-store` on every answer, errors included.
 * The account number and the encrypted values are never in a response; only the last 4 digits are.
 */
export const teamBankingRoutes: FastifyPluginAsync<TeamBankingRoutesOptions> = (app, options) => {
  const { service } = options;
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const policy = requireTeamRole('TEAM_ADMIN');

  // Banking and tax details are personal information: nothing here is cacheable, whatever the status.
  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  typed.get(
    '/:teamId/banking',
    {
      config: { policy },
      schema: {
        summary: "Read the team's banking details (masked)",
        description:
          'TEAM_ADMIN of this team only. Returns the account name, the last 4 digits of the account number, whether payouts are configured and whether a failed payout destination blocks publishing (`payoutBlocked`), and who last changed the details. The full account number is never returned. When the stored values cannot be decrypted the answer is still 200 with `accountName` null and `unreadable` true; saving the details again restores them.',
        operationId: 'getTeamBanking',
        params: TeamIdParams,
        response: { 200: BankingResponse, ...ERROR_RESPONSES },
      },
    },
    async (request) => service.getBanking(request.params.teamId, contextOf(request)),
  );

  typed.put(
    '/:teamId/banking',
    {
      config: { policy },
      schema: {
        summary: "Save the team's banking details",
        description:
          'TEAM_ADMIN of this team only. Saves the account name and account number as one block under the team-row lock, after re-checking that the caller is still an approved admin. A blank or omitted `accountNumber` keeps the saved number (422 on a first save). `changeKey` is a UUID v4 the form generates once per render; a replay never sends a second notification. A save that changes nothing writes nothing, except that any save clears a payout block. Every approved admin of the team (the caller included) is emailed about a change; the email carries no account name or digits. 422 `fieldErrors` use the shared copy deck and never echo the input; the body is strict.',
        operationId: 'putTeamBanking',
        params: TeamIdParams,
        body: PutBankingRequest,
        response: { 200: BankingResponse, ...ERROR_RESPONSES },
      },
    },
    async (request) =>
      service.putBanking(
        request.params.teamId,
        requireAuth(request).userId,
        request.body,
        contextOf(request),
      ),
  );

  typed.delete(
    '/:teamId/banking',
    {
      config: { policy },
      schema: {
        summary: "Remove the team's banking details",
        description:
          'TEAM_ADMIN of this team only. Takes the team row `FOR UPDATE` first, then refuses with 409 `banking_in_use` while the team has a PUBLISHED paid session or a PENDING or OVERDUE payment. Clears the name, number and last 4 together and any payout block, and notifies every approved admin. Removing when nothing is stored is a harmless 200.',
        operationId: 'deleteTeamBanking',
        params: TeamIdParams,
        response: { 200: BankingResponse, ...ERROR_RESPONSES },
      },
    },
    async (request) =>
      service.removeBanking(request.params.teamId, requireAuth(request).userId, contextOf(request)),
  );

  typed.get(
    '/:teamId/gst',
    {
      config: { policy },
      schema: {
        summary: "Read the team's GST settings",
        description:
          'TEAM_ADMIN of this team only. The GST number is a public business identifier (it is printed on invoices), returned as canonical digits.',
        operationId: 'getTeamGst',
        params: TeamIdParams,
        response: { 200: GstResponse, ...ERROR_RESPONSES },
      },
    },
    async (request) => service.getGst(request.params.teamId),
  );

  typed.put(
    '/:teamId/gst',
    {
      config: { policy },
      schema: {
        summary: "Save the team's GST settings",
        description:
          'TEAM_ADMIN of this team only. `gstRegistered` is required; an omitted or blank `gstNumber` keeps the saved number, so turning GST off keeps it. Registering requires a number (422 `fieldErrors.gstNumber`). The number must pass the IRD check-digit rules. This writes nothing to `payments`: existing payments keep the GST treatment they were charged with.',
        operationId: 'putTeamGst',
        params: TeamIdParams,
        body: PutGstRequest,
        response: { 200: GstResponse, ...ERROR_RESPONSES },
      },
    },
    async (request) =>
      service.putGst(
        request.params.teamId,
        requireAuth(request).userId,
        request.body,
        contextOf(request),
      ),
  );

  return Promise.resolve();
};
