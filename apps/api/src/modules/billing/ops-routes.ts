/**
 * The payout block and the hold resolutions (wallet-and-akahu-billing Phase 4a; A3, CR-14, CR-15, CR-26, H2):
 *
 *   POST /teams/:teamId/payout-block ............................ requireGlobalRole('GLOBAL_ADMIN')
 *   POST /payments/:paymentId/hold-resolution ................... authenticated(); payee-team admin or GLOBAL_ADMIN, in-service
 *   POST /teams/:teamId/wallet/top-ups/:topUpId/hold-resolution . requireTeamRole('TEAM_ADMIN', { allowGlobalAdmin: true })
 *
 * Strict shared bodies (enums, no free text); `cache-control: no-store` on every answer, errors included.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ErrorResponse,
  HoldResolutionRequest,
  HoldResolutionResponse,
  PaymentIdParams,
  PayoutBlockRequest,
  PayoutBlockResponse,
  TeamIdParams,
  TeamTopUpParams,
} from '@sgm/shared';
import { authenticated, requireGlobalRole, requireTeamRole } from '../../lib/auth/policy.ts';
import { requireAuth } from '../../lib/auth/request-auth.ts';
import { resolveHeld, type HoldResolutionDeps } from './hold-resolution.ts';
import { blockPayout, type PayoutBlockDeps } from './payout-block.ts';

export interface OpsRoutesOptions {
  readonly deps: Omit<HoldResolutionDeps, 'log'> & PayoutBlockDeps;
}

const GUARDED = { 401: ErrorResponse, 403: ErrorResponse } as const;

const RESOLUTION_RULES =
  'Akahu is re-read first: when it now reports a definite answer, that wins and the manual one is refused with 409 `hold_resolved_by_provider` (a confirmed payment for the right amount is applied by the server). `RECEIVED` settles it (payment PAID / wallet credited, within the cap and never twice; otherwise recorded as received but not applied and the team admins are asked to refund). For a hold on a different amount `observedAmount` is required (422 otherwise) and the charge is settled only when it equals the amount owed; a different figure is recorded, not applied, and the payment stays payable. `NOT_RECEIVED` releases it: payable again, and a pending payment gets at least 24 hours from now. Who acted, when and why are stored; a replay of the same outcome answers the same; a contradicting one, or nothing on hold, is 409 `conflict`. 503 `payment_provider_unavailable` when Akahu cannot be read.';

export const opsRoutes: FastifyPluginAsync<OpsRoutesOptions> = (app, options) => {
  const { deps } = options;
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // Payment holds and payout problems are personal and operational: nothing here is cacheable.
  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  typed.post(
    '/teams/:teamId/payout-block',
    {
      config: { policy: requireGlobalRole('GLOBAL_ADMIN') },
      schema: {
        summary: "Mark a team's payout account as failing (GLOBAL_ADMIN)",
        description:
          "Records that payments to the team's bank account are failing: sets the payout block (if not already set), appends an audit event, emails each approved team admin (no account details) and asks Akahu to cancel the team's payments still waiting for the payer. The banking details are never changed; a team admin re-saving them lifts the block. While blocked, publishing a paid session, starting a top-up and starting a payment answer 409 `payout_not_configured`. `reason` is an enum and `akahuPaymentId` the optional evidence; there is no free text. A replay with the same `changeKey` answers the same and does nothing more. 404 `not_found` for an unknown team. GLOBAL_ADMIN only: a TEAM_ADMIN cannot block their own team's payouts.",
        operationId: 'blockTeamPayout',
        params: TeamIdParams,
        body: PayoutBlockRequest,
        response: { 200: PayoutBlockResponse, ...GUARDED, 404: ErrorResponse, 422: ErrorResponse },
      },
    },
    async (request) => {
      const result = await blockPayout(
        deps,
        {
          teamId: request.params.teamId,
          actorUserId: requireAuth(request).userId,
          reason: request.body.reason,
          akahuPaymentId: request.body.akahuPaymentId ?? null,
          changeKey: request.body.changeKey,
        },
        request.log,
      );
      return {
        payoutBlockedAt: result.payoutBlockedAt.toISOString(),
        alreadyBlocked: result.alreadyBlocked,
      };
    },
  );

  typed.post(
    '/payments/:paymentId/hold-resolution',
    {
      config: { policy: authenticated() },
      schema: {
        summary: 'Resolve a payment that is on hold with the bank',
        description: `For a payment whose Akahu attempt is under review. ${RESOLUTION_RULES} Team admins of the payee team and GLOBAL_ADMIN only: a plain member of that team is 403; anyone else, and an unknown id, get the same 404 \`not_found\`.`,
        operationId: 'resolvePaymentHold',
        params: PaymentIdParams,
        body: HoldResolutionRequest,
        response: {
          200: HoldResolutionResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
          503: ErrorResponse,
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      return resolveHeld(
        { ...deps, log: request.log },
        { kind: 'payment', paymentId: request.params.paymentId },
        { userId: auth.userId, role: auth.role },
        request.body,
      );
    },
  );

  typed.post(
    '/teams/:teamId/wallet/top-ups/:topUpId/hold-resolution',
    {
      config: { policy: requireTeamRole('TEAM_ADMIN', { allowGlobalAdmin: true }) },
      schema: {
        summary: 'Resolve a wallet top-up that is on hold with the bank',
        description: `For a top-up under review. ${RESOLUTION_RULES} TEAM_ADMIN of this team, or a GLOBAL_ADMIN; a top-up of another team is the same 404 \`not_found\` as an unknown id.`,
        operationId: 'resolveTopUpHold',
        params: TeamTopUpParams,
        body: HoldResolutionRequest,
        response: {
          200: HoldResolutionResponse,
          ...GUARDED,
          404: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
          503: ErrorResponse,
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      return resolveHeld(
        { ...deps, log: request.log },
        { kind: 'topUp', teamId: request.params.teamId, topUpId: request.params.topUpId },
        { userId: auth.userId, role: auth.role },
        request.body,
      );
    },
  );

  return Promise.resolve();
};
