/**
 * `GET /teams/:teamId/wallet` and `POST /teams/:teamId/wallet/top-ups` (wallet-and-akahu-billing Phase 4a; AC-VERIFY-1). Both are
 * for APPROVED members of the team (TEAM_ADMIN included, no GLOBAL_ADMIN bypass: a wallet is personal); the guard answers 401 and
 * 403 in `onRequest`, before the body is parsed. Strict shared bodies and queries; money as `MoneyString`; `cache-control:
 * no-store` on every answer, errors included.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ErrorResponse,
  IntentErrorResponse,
  TeamIdParams,
  TopUpRequest,
  TopUpResponse,
  WalletQuery,
  WalletResponse,
} from '@sgm/shared';
import { requireTeamRole } from '../../lib/auth/policy.ts';
import { requireAuth } from '../../lib/auth/request-auth.ts';
import { readWallet, type WalletReadDeps } from './read.ts';
import { startTopUp, type TopUpStartDeps } from './top-up.ts';

export interface WalletRoutesOptions {
  readonly deps: TopUpStartDeps & WalletReadDeps;
}

const GUARDED = { 401: ErrorResponse, 403: ErrorResponse } as const;

export const walletRoutes: FastifyPluginAsync<WalletRoutesOptions> = (app, options) => {
  const { deps } = options;
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const policy = requireTeamRole('MEMBER');

  // A wallet is personal and changes with every payment: nothing here is cacheable.
  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  typed.get(
    '/:teamId/wallet',
    {
      config: { policy },
      schema: {
        summary: "Read the caller's wallet in a team",
        description:
          "The caller's own wallet in this team: `balance` (0.00 when they have none; a read never creates one), the `cap` (100.00), the `headroom` left under it and the `lowCreditThreshold`; `pendingTopUp` is the open top-up (CREATING, OPEN or HELD) with its `outcome`, and `lastClosedTopUp` the last finished top-up when it was not credited (closed or received-but-not-applied). `transactions` is one page of the ledger, newest first, each deduction naming its session; pass `nextCursor` back as `cursor`. `topUp` is the id Akahu's return page carries: when that top-up is still open, one background re-read of it is requested (at most every 5 seconds); the read itself never calls Akahu and never changes a balance. APPROVED members of the team only.",
        operationId: 'readWallet',
        params: TeamIdParams,
        querystring: WalletQuery,
        response: { 200: WalletResponse, ...GUARDED, 422: ErrorResponse },
      },
    },
    async (request) =>
      readWallet(
        deps,
        { userId: requireAuth(request).userId, teamId: request.params.teamId },
        request.query,
        request.log,
      ),
  );

  typed.post(
    '/:teamId/wallet/top-ups',
    {
      config: { policy },
      schema: {
        summary: 'Start a wallet top-up with Akahu',
        description:
          'Creates one top-up intent and asks Akahu for a payment of `amount` to the team\'s bank account, then answers 201 with the top-up and the `redirectUrl` the browser follows to approve it at the bank. The wallet is credited only when Akahu confirms the payment (webhook or background re-read), never by this request. A repeat with the same `idempotencyKey` returns the same top-up. 422 `validation_failed` for an amount below $1.00, not a 0-2 decimal amount, over the headroom ("You can top up at most $X."), or an extra field; 409 `top_up_in_progress` while another top-up is open (`resume` carries it and, while its link has time left, its `redirectUrl`); 409 `payout_not_configured` when the team cannot receive payments; 503 `payment_provider_unavailable` when Akahu cannot be reached (nothing is charged; retry with a new key); 422 `payment_provider_refused` with a stable `reason`. APPROVED members of the team only; the guard runs before the body.',
        operationId: 'startWalletTopUp',
        params: TeamIdParams,
        body: TopUpRequest,
        response: {
          201: TopUpResponse,
          ...GUARDED,
          409: IntentErrorResponse,
          422: IntentErrorResponse,
          503: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const response = await startTopUp(
        deps,
        {
          userId: requireAuth(request).userId,
          teamId: request.params.teamId,
          amount: request.body.amount,
          idempotencyKey: request.body.idempotencyKey,
        },
        request.log,
      );
      void reply.code(201);
      return response;
    },
  );

  return Promise.resolve();
};
