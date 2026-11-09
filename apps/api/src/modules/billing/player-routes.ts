/**
 * The payer's payment routes (wallet-and-akahu-billing Phase 4a; CR-7, CR-16, CR-17; AC-VERIFY-1):
 *
 *   GET  /payments/me?status=UNPAID ........ authenticated(): the caller's unpaid (and held) payments across teams, by team
 *   GET  /payments/:paymentId .............. authenticated(), payer only: the payment page
 *   POST /payments/:paymentId/attempts ..... authenticated(), payer only: start paying with Akahu
 *   GET  /teams/:teamId/payments/me ........ requireTeamRole('MEMBER'): the caller's payments in that team
 *
 * A payment is resolved by its id AND the caller: any other caller and an unknown id get the same 404 `not_found`. Strict shared
 * bodies and queries; money as `MoneyString`; `cache-control: no-store` on every answer, errors included.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  AttemptResponse,
  ErrorResponse,
  IntentErrorResponse,
  MyPaymentsQuery,
  MyPaymentsResponse,
  PaymentIdParams,
  PaymentResponse,
  StartAttemptRequest,
  TeamIdParams,
  UnpaidPaymentsResponse,
} from '@sgm/shared';
import { authenticated, requireTeamRole } from '../../lib/auth/policy.ts';
import { requireAuth } from '../../lib/auth/request-auth.ts';
import type { PlayerPaymentsService } from './player.ts';

export interface PlayerPaymentRoutesOptions {
  readonly service: PlayerPaymentsService;
}

const PAYER_ONLY =
  'Only the payer can see or pay a payment: any other signed-in caller, and an unknown id, get the same 404 `not_found`.';

export const playerPaymentRoutes: FastifyPluginAsync<PlayerPaymentRoutesOptions> = (
  app,
  options,
) => {
  const { service } = options;
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // What a person owes is personal: nothing here is cacheable.
  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  typed.get(
    '/payments/me',
    {
      config: { policy: authenticated() },
      schema: {
        summary: "List the caller's unpaid payments across teams",
        description:
          "The caller's PENDING and OVERDUE payments in every team (held ones included, `onHold: true`), most overdue first, grouped by team in that order; one page of 50 payments (`nextCursor` is opaque; pass it back as `cursor`). `status` may only be `UNPAID` (the default). This is the target of the registration debt block.",
        operationId: 'listMyUnpaidPayments',
        querystring: MyPaymentsQuery,
        response: { 200: UnpaidPaymentsResponse, 422: ErrorResponse },
      },
    },
    async (request) => service.listUnpaid(requireAuth(request).userId, request.query),
  );

  typed.get(
    '/payments/:paymentId',
    {
      config: { policy: authenticated() },
      schema: {
        summary: 'Read one payment (payer only)',
        description: `The payment page: the team, the session, the amount, the GST included, the fee lines, the status and due date, why it was charged (\`reason\`), the latest Akahu attempt with its \`outcome\`, whether it is \`onHold\` (under review with the bank: not payable) and whether the team's payout is blocked (\`payoutBlocked\`: not payable now). While the latest attempt is open, one background re-read of it is requested (at most every 5 seconds); the read never calls Akahu and never changes a payment. ${PAYER_ONLY}`,
        operationId: 'readPayment',
        params: PaymentIdParams,
        response: { 200: PaymentResponse, 404: ErrorResponse, 422: ErrorResponse },
      },
    },
    async (request) =>
      service.readPayment(requireAuth(request).userId, request.params.paymentId, request.log),
  );

  typed.post(
    '/payments/:paymentId/attempts',
    {
      config: { policy: authenticated() },
      schema: {
        summary: 'Start paying a payment with Akahu (payer only)',
        description: `Opens one Akahu payment for the payment's own amount to the team's bank account and answers 201 with the \`redirectUrl\` the browser follows to approve it at the bank. The payment becomes PAID only when Akahu confirms it (webhook or background re-read), never by this request. A repeat with the same \`idempotencyKey\` returns the same answer. 409 \`payment_settled\` when it is already paid; 409 \`payment_in_progress\` while another attempt is open (\`resume.redirectUrl\` continues it while its link has time left); 409 \`payment_on_hold\` while an attempt is under review with the bank; 409 \`payout_not_configured\` when the team cannot receive payments; 503 \`payment_provider_unavailable\` when Akahu cannot be reached (nothing is charged; retry with a new key); 422 \`payment_provider_refused\` with a stable \`reason\`. The body is strict. ${PAYER_ONLY}`,
        operationId: 'startPaymentAttempt',
        params: PaymentIdParams,
        body: StartAttemptRequest,
        response: {
          201: AttemptResponse,
          404: ErrorResponse,
          409: IntentErrorResponse,
          422: IntentErrorResponse,
          503: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const response = await service.startAttempt(
        requireAuth(request).userId,
        request.params.paymentId,
        request.body,
        request.log,
      );
      void reply.code(201);
      return response;
    },
  );

  typed.get(
    '/teams/:teamId/payments/me',
    {
      config: { policy: requireTeamRole('MEMBER') },
      schema: {
        summary: "List the caller's payments in a team",
        description:
          "The caller's own payments in this team, newest due first, one page of 50 (`nextCursor` is opaque; pass it back as `cursor`); `status=UNPAID` keeps PENDING and OVERDUE. Each row carries the session, the amount, the status, why it was charged, the latest attempt's `outcome`, `onHold` and `payoutBlocked`. APPROVED members of the team only.",
        operationId: 'listMyTeamPayments',
        params: TeamIdParams,
        querystring: MyPaymentsQuery,
        response: { 200: MyPaymentsResponse, 422: ErrorResponse },
      },
    },
    async (request) =>
      service.listTeamPayments(requireAuth(request).userId, request.params.teamId, request.query),
  );

  return Promise.resolve();
};
