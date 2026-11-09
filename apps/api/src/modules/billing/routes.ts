import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  AdminPaymentsQuery,
  AdminPaymentsResponse,
  ErrorResponse,
  ReminderResponse,
  SendReminderRequest,
  TeamIdParams,
  TeamPaymentParams,
} from '@sgm/shared';
import { requireTeamRole } from '../../lib/auth/policy.ts';
import { requireAuth } from '../../lib/auth/request-auth.ts';
import type { BillingContext, BillingService } from './service.ts';

export interface BillingRoutesOptions {
  readonly service: BillingService;
}

const contextOf = (request: FastifyRequest): BillingContext => ({ log: request.log });

/** The guard answers 401 and 403 in `onRequest`, before the body is parsed; the service answers 404, 409 and 422. */
const GUARDED = { 401: ErrorResponse, 403: ErrorResponse } as const;

const ACCESS =
  "TEAM_ADMIN of this team, or a GLOBAL_ADMIN (`allowGlobalAdmin` is on). A payment is always resolved together with the team in the path: another team's payment and an unknown id answer the same 404 `not_found`.";

/**
 * `/teams/:teamId/payments` and `/teams/:teamId/payments/:paymentId/reminders` (wallet-and-akahu-billing Phase 3): the team admin's
 * payment list and the manual reminder. Strict shared bodies; `cache-control: no-store` on every answer, errors included.
 */
export const billingRoutes: FastifyPluginAsync<BillingRoutesOptions> = (app, options) => {
  const { service } = options;
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const policy = requireTeamRole('TEAM_ADMIN', { allowGlobalAdmin: true });

  // Who owes the team what is personal information: nothing here is cacheable, whatever the status.
  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  typed.get(
    '/:teamId/payments',
    {
      config: { policy },
      schema: {
        summary: "List a team's payments (admin)",
        description: `The team's payments, one page of 50 (\`nextCursor\` is opaque; pass it back as \`cursor\`). \`status\` is \`UNPAID\` (PENDING and OVERDUE, the default, oldest due first), \`PENDING\`, \`OVERDUE\`, \`PAID\`, \`FAILED\` or \`ALL\` (newest due first). Each row carries the payer's display name only (never an email address or a bank detail), the amount, the due and paid instants, \`lastReminderAt\` (the last manual reminder, derived from the reminder log) and \`onHold\` (an Akahu attempt is under review). \`payoutBlocked\` says the team's payout account is blocked. A bad \`status\`, an unknown query key or an unreadable \`cursor\` is 422. ${ACCESS}`,
        operationId: 'listTeamPayments',
        params: TeamIdParams,
        querystring: AdminPaymentsQuery,
        response: { 200: AdminPaymentsResponse, ...GUARDED, 422: ErrorResponse },
      },
    },
    async (request) => service.listTeamPayments(request.params.teamId, request.query),
  );

  typed.post(
    '/:teamId/payments/:paymentId/reminders',
    {
      config: { policy },
      schema: {
        summary: 'Email a player a reminder about an unpaid payment (admin)',
        description: `Enqueues one sealed reminder email to the payer and answers 202 \`{ sent: true, lastReminderAt }\`. The append-only reminder record and the email are written in one transaction. \`changeKey\` is a UUID v4 the form generates once per render: a replay of a recorded request answers the same 202 and sends nothing (checked first, so even inside the cooldown). 409 \`payment_settled\` for a PAID payment; 409 \`reminder_too_soon\` within 24 hours of the last manual reminder (exactly 24 hours later is allowed); 404 \`not_found\` for a payment that is not this team's. The body is strict (422 for extra keys or a bad key); the team guard runs before it, so a MEMBER is 403 whatever the body. ${ACCESS}`,
        operationId: 'sendPaymentReminder',
        params: TeamPaymentParams,
        body: SendReminderRequest,
        response: {
          202: ReminderResponse,
          ...GUARDED,
          404: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const response = await service.sendReminder(
        request.params.teamId,
        request.params.paymentId,
        requireAuth(request).userId,
        request.body,
        contextOf(request),
      );
      void reply.code(202);
      return response;
    },
  );

  return Promise.resolve();
};
