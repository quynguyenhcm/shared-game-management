/**
 * The invoice download routes (tax-invoices-and-exports Phase 3; AC-ENTRY-1, 3, AC-HAPPY-1, AC-ERROR-2, AC-VERIFY-6):
 *
 *   GET /payments/:paymentId/invoice ..................... authenticated(), payer only
 *   GET /teams/:teamId/payments/:paymentId/invoice ....... requireTeamRole('TEAM_ADMIN'), no GLOBAL_ADMIN (H9)
 *
 * A payment is resolved together with its caller (payer id, or team id), so any other caller and an unknown id get the same
 * 404 `not_found`; the team guard runs before the payment is looked up. 200 is the PDF as an attachment whose file name holds the
 * document number, `cache-control: no-store` (on every answer, errors included) and `x-content-type-options: nosniff`. 409
 * `invoice_not_available` for a payment that is not PAID above $0.00 (no number is consumed), 409 `invoice_pending` when the
 * issuing lock is busy. A download before the issuance job ran issues the document on demand.
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ErrorResponse, PaymentIdParams, TeamPaymentParams } from '@sgm/shared';
import { authenticated, requireTeamRole } from '../../lib/auth/policy.ts';
import { requireAuth } from '../../lib/auth/request-auth.ts';
import { attachmentDisposition } from '../../lib/http/content-disposition.ts';
import type { DocumentDownload, InvoiceService } from './service.ts';

export interface InvoiceRoutesOptions {
  readonly service: InvoiceService;
}

/** The 200 answer, for OpenAPI only: the bytes are sent as a Buffer, which bypasses the JSON serializer. */
const PDF_OK = {
  description:
    'The tax invoice or receipt as a PDF attachment (`content-disposition: attachment; filename="tax-invoice-INV-000001.pdf"`, `cache-control: no-store`).',
  content: { 'application/pdf': { schema: z.string().meta({ format: 'binary' }) } },
} as const;

const GUARDED = { 401: ErrorResponse, 403: ErrorResponse } as const;

function sendPdf(reply: FastifyReply, file: DocumentDownload): FastifyReply {
  return reply
    .type('application/pdf')
    .header('content-disposition', attachmentDisposition(file.filename))
    .header('content-length', file.bytes.length)
    .header('x-content-type-options', 'nosniff')
    .send(file.bytes);
}

const WHEN =
  'A PAID payment above $0.00 only: 409 `invoice_not_available` ("An invoice is available once the payment is paid.") for a pending, overdue, held, processing or $0.00 payment, and no invoice number is consumed. If the document has not been issued yet it is issued now (never twice); 409 `invoice_pending` if another issuer holds the lock for longer than the lock wait: retry shortly.';

export const invoiceRoutes: FastifyPluginAsync<InvoiceRoutesOptions> = (app, options) => {
  const { service } = options;
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // A tax document is personal: nothing here is cacheable, whatever the status.
  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  typed.get(
    '/payments/:paymentId/invoice',
    {
      config: { policy: authenticated() },
      schema: {
        summary: 'Download the tax invoice or receipt of a payment (payer only)',
        description: `The PDF tax invoice (a GST-registered team's payment) or receipt (otherwise) of the caller's own payment. ${WHEN} Only the payer can download it: any other signed-in caller, a team admin who is not the payer, and an unknown id all get the same 404 \`not_found\`.`,
        operationId: 'downloadMyPaymentDocument',
        params: PaymentIdParams,
        response: {
          200: PDF_OK,
          401: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
      },
    },
    async (request, reply) =>
      sendPdf(
        reply,
        await service.downloadForPayer(
          requireAuth(request).userId,
          request.params.paymentId,
          request.log,
        ),
      ),
  );

  typed.get(
    '/teams/:teamId/payments/:paymentId/invoice',
    {
      config: { policy: requireTeamRole('TEAM_ADMIN') },
      schema: {
        summary: "Download a team payment's tax invoice or receipt (team admin)",
        description: `The same PDF the payer gets, for any payment of the team. ${WHEN} TEAM_ADMIN of this team only (\`allowGlobalAdmin\` is off): a plain member and an admin of another team get 403, and a payment that is not this team's (or an unknown id) gets 404 \`not_found\`. The document names the player (as the invoice buyer) and never shows an email address.`,
        operationId: 'downloadTeamPaymentDocument',
        params: TeamPaymentParams,
        response: {
          200: PDF_OK,
          ...GUARDED,
          404: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
      },
    },
    async (request, reply) =>
      sendPdf(
        reply,
        await service.downloadForTeam(request.params.teamId, request.params.paymentId, request.log),
      ),
  );

  return Promise.resolve();
};
