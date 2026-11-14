/**
 * The download use cases (tax-invoices-and-exports Phase 3; AC-ENTRY-1, 3, AC-HAPPY-1, AC-ASYNC-1, AC-ASYNC-3, AC-ERROR-1,
 * AC-ERROR-2, AC-VERIFY-6): resolve the payment together with its caller, issue its document on demand when the job has not
 * run yet (`issueOnDemand`: idempotent, never a second number, 409 `invoice_not_available` for an unpaid or $0.00 payment
 * without consuming a number, 409 `invoice_pending` on a lock timeout), build the document model from the issue-time snapshot
 * and render the PDF.
 *
 * Whichever route settled the payment (Akahu, wallet, a resolved hold), only `payments` and `payment_documents` are read. The
 * log carries ids, the caller's role and the document KIND only: never a name, an amount, a GST number or the document number.
 */
import { trace } from '@opentelemetry/api';
import { DOCUMENT_NAMES } from '@sgm/shared';
import type { Database } from '../../lib/db/kysely.ts';
import { AppError } from '../../lib/http/errors.ts';
import type { Logger } from '../../lib/logger/logger.ts';
import { buildDocumentModel } from './document.ts';
import { issueOnDemand } from './issue.ts';
import {
  findPayerPayment,
  findTeamPayment,
  readDocumentFacts,
  type ResolvedPayment,
} from './read.ts';
import { renderDocumentPdf, type InvoiceFonts } from './render-pdf.ts';

export type DownloadLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

export type DownloaderRole = 'payer' | 'team_admin';

export interface InvoiceServiceDeps {
  readonly db: Database;
  /** The two embedded fonts, read once at boot (`loadInvoiceFonts`). */
  readonly fonts: InvoiceFonts;
  /** Lock wait of an on-demand issue; the default is the issuer's 5 s. Tests shorten it. */
  readonly lockTimeoutMs?: number;
}

export interface DocumentDownload {
  readonly bytes: Buffer;
  /** `tax-invoice-INV-000001.pdf` / `receipt-RCT-000001.pdf`: the document number is the only variable part. */
  readonly filename: string;
}

export interface InvoiceService {
  /** The payer's own payment's document (`GET /payments/:paymentId/invoice`). */
  downloadForPayer(
    payerId: string,
    paymentId: string,
    log: DownloadLogger,
  ): Promise<DocumentDownload>;
  /** A payment of the team (`GET /teams/:teamId/payments/:paymentId/invoice`; the team-admin guard ran first). */
  downloadForTeam(
    teamId: string,
    paymentId: string,
    log: DownloadLogger,
  ): Promise<DocumentDownload>;
}

const tracer = trace.getTracer('sgm-api');

export function createInvoiceService(deps: InvoiceServiceDeps): InvoiceService {
  async function download(
    payment: ResolvedPayment | undefined,
    role: DownloaderRole,
    log: DownloadLogger,
  ): Promise<DocumentDownload> {
    if (payment === undefined) throw new AppError('not_found');
    const issued = await issueOnDemand(
      {
        db: deps.db,
        log,
        ...(deps.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: deps.lockTimeoutMs }),
      },
      { paymentId: payment.id },
    );
    const facts = await readDocumentFacts(deps.db, payment.id);
    if (facts === undefined) {
      // issueOnDemand returned a number, so the document row must exist: anything else is a server fault, never a 404.
      throw new Error('A payment document was issued but cannot be read.');
    }
    const bytes = await tracer.startActiveSpan('invoice.render_pdf', async (span) => {
      try {
        return await renderDocumentPdf(buildDocumentModel(facts), deps.fonts);
      } finally {
        span.end();
      }
    });
    log.info(
      {
        event: 'invoice.downloaded',
        paymentId: payment.id,
        teamId: payment.teamId,
        actorRole: role,
        documentKind: issued.documentKind,
        issuedOnDemand: issued.issued,
      },
      'invoice downloaded',
    );
    return {
      bytes,
      filename: `${DOCUMENT_NAMES[facts.kind].replace(' ', '-')}-${facts.numberDisplay}.pdf`,
    };
  }

  return {
    async downloadForPayer(payerId, paymentId, log) {
      return download(await findPayerPayment(deps.db, payerId, paymentId), 'payer', log);
    },
    async downloadForTeam(teamId, paymentId, log) {
      return download(await findTeamPayment(deps.db, teamId, paymentId), 'team_admin', log);
    },
  };
}
