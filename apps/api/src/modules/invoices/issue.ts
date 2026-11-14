/**
 * The invoice issuance service (tax-invoices-and-exports Phase 2; AC-ASYNC-1, AC-ASYNC-2, AC-ASYNC-3, AC-ERROR-1, AC-ERROR-5; ADR
 * 0021 section 2). Three callers reach the one SQL issuer through `repo.ts`, so the database proves they are equivalent:
 *
 *   - `issueTeamBacklog`: the per-team `issue-invoices` job drains a team's unissued PAID payments, one payment per transaction,
 *     oldest paid first, skipping a payment that fails an integrity check and reporting it, bounded by a per-run limit;
 *   - `issueOnDemand`: a download request for a payment whose job has not run (or never will): refuses a payment that is not PAID
 *     above $0.00 with 409 `invoice_not_available` and no number consumed; retries once on a lock timeout, then 409
 *     `invoice_pending`. Issuance is idempotent, so a GET that issues is safe to replay;
 *   - the `invoice-reconcile` sweep (a job) only lists the teams that still have work.
 *
 * Whichever route settled the payment (Akahu, wallet, hand resolution), only `payments` columns are read: no attempt, ledger or
 * provider row. Logs carry ids, the document KIND, reasons and counts only: never a name, amount, GST number or document number.
 */
import { documentKindOf, isDocumentAvailable, type PaymentDocumentKind } from '@sgm/shared';
import type { Database } from '../../lib/db/kysely.ts';
import { AppError } from '../../lib/http/errors.ts';
import type { Logger } from '../../lib/logger/logger.ts';
import {
  issuePaymentDocument,
  listTeamsWithUnissuedPayments,
  nextUnissuedPayment,
  readPaymentForIssue,
  type IssueOptions,
  type IssuedDocument,
} from './repo.ts';

/** Payments one `issue-invoices` run issues before it queues a follow-up run (bounds a run's length, not the backlog). */
export const DEFAULT_RUN_LIMIT = 500;

export type IssueFn = (
  db: Database,
  paymentId: string,
  options: IssueOptions,
) => Promise<IssuedDocument>;

export interface IssueDeps {
  readonly db: Database;
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Per-transaction lock wait; defaults to the repo's 5 s. Tests shorten it. */
  readonly lockTimeoutMs?: number;
  /** Test seam: the issuing call (defaults to the repo's). */
  readonly issue?: IssueFn;
}

export interface OnDemandResult extends IssuedDocument {
  readonly documentKind: PaymentDocumentKind;
}

export interface BacklogResult {
  readonly issued: number;
  /** Payments another issuer got to first (already issued when this run reached them). */
  readonly skipped: number;
  /** Ids that failed an integrity check (SQLSTATE class 23) and were left for a person. */
  readonly failed: readonly string[];
  /** The per-run limit stopped the run while payments remained: the caller queues a follow-up run. */
  readonly limitReached: boolean;
}

export function sqlStateOf(error: unknown): string | undefined {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

const LOCK_TIMEOUT = '55P03';
const isIntegrityViolation = (error: unknown): boolean =>
  sqlStateOf(error)?.startsWith('23') === true;

/** One attempt, and on a lock timeout one more; a second timeout is `invoice_pending` (the lock holder is mid-issue). */
async function issueWithOneRetry(deps: IssueDeps, paymentId: string): Promise<IssuedDocument> {
  const issue = deps.issue ?? issuePaymentDocument;
  const options: IssueOptions =
    deps.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: deps.lockTimeoutMs };
  try {
    return await issue(deps.db, paymentId, options);
  } catch (first) {
    if (sqlStateOf(first) !== LOCK_TIMEOUT) throw first;
  }
  try {
    return await issue(deps.db, paymentId, options);
  } catch (second) {
    if (sqlStateOf(second) === LOCK_TIMEOUT)
      throw new AppError('invoice_pending', { cause: second });
    throw second;
  }
}

/**
 * Issue-on-demand for one payment the caller has already been authorised to read (the Phase 3 routes resolve it with its payer or
 * team first). Returns the document number, whether this call issued it, and its kind.
 */
export async function issueOnDemand(
  deps: IssueDeps,
  input: { readonly paymentId: string },
): Promise<OnDemandResult> {
  const payment = await readPaymentForIssue(deps.db, input.paymentId);
  if (payment === undefined) throw new AppError('not_found');
  const documentKind = documentKindOf(payment.gstRegistered);
  const common = { paymentId: payment.id, teamId: payment.teamId };

  if (payment.numberDisplay !== null) {
    deps.log.info(
      { event: 'invoice.issue.skipped', ...common, reason: 'already_issued' },
      'invoice already issued',
    );
    return { numberDisplay: payment.numberDisplay, issued: false, documentKind };
  }
  if (!isDocumentAvailable(payment.status, payment.amount)) {
    deps.log.info(
      {
        event: 'invoice.issue.skipped',
        ...common,
        reason: payment.status === 'PAID' ? 'zero_amount' : 'not_paid',
      },
      'invoice not available for this payment',
    );
    throw new AppError('invoice_not_available');
  }

  const document = await issueWithOneRetry(deps, payment.id);
  deps.log.info(
    document.issued
      ? { event: 'invoice.issued', ...common, documentKind, trigger: 'on_demand' }
      : { event: 'invoice.issue.skipped', ...common, reason: 'already_issued' },
    document.issued ? 'invoice issued on demand' : 'invoice already issued',
  );
  return { ...document, documentKind };
}

/**
 * Drains one team's unissued PAID payments above $0.00 in `(paid_at, id)` order, each in its own transaction. A payment that fails
 * an integrity check (SQLSTATE class 23) is logged, skipped for the rest of the run and returned in `failed`; the others commit.
 * Anything else (a lost connection, a lock timeout, a deadlock) is rethrown for the caller to retry: nothing is half-written, so
 * a retried run simply continues from the next unissued payment.
 */
export async function issueTeamBacklog(
  deps: IssueDeps,
  input: { readonly teamId: string; readonly runLimit?: number },
): Promise<BacklogResult> {
  const issue = deps.issue ?? issuePaymentDocument;
  const options: IssueOptions =
    deps.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: deps.lockTimeoutMs };
  const runLimit = input.runLimit ?? DEFAULT_RUN_LIMIT;
  const failed: string[] = [];
  let issued = 0;
  let skipped = 0;
  let processed = 0;
  for (;;) {
    const next = await nextUnissuedPayment(deps.db, input.teamId, failed);
    if (next === undefined) return { issued, skipped, failed, limitReached: false };
    if (processed >= runLimit) return { issued, skipped, failed, limitReached: true };
    processed += 1;
    const common = { paymentId: next.id, teamId: input.teamId };
    try {
      const document = await issue(deps.db, next.id, options);
      if (document.issued) {
        issued += 1;
        deps.log.info(
          {
            event: 'invoice.issued',
            ...common,
            documentKind: documentKindOf(next.gstRegistered),
            trigger: 'job',
          },
          'invoice issued',
        );
      } else {
        skipped += 1;
        deps.log.info(
          { event: 'invoice.issue.skipped', ...common, reason: 'already_issued' },
          'invoice already issued',
        );
      }
    } catch (error) {
      if (!isIntegrityViolation(error)) throw error;
      failed.push(next.id);
      deps.log.error(
        {
          event: 'invoice.issue.failed',
          ...common,
          errorClass: error instanceof Error ? error.name : typeof error,
          sqlState: sqlStateOf(error),
        },
        'invoice could not be issued',
      );
    }
  }
}

/** The sweep's keyset page of teams that still have unissued PAID payments. */
export function listTeamsNeedingIssuance(
  db: Database,
  page: { readonly after?: string; readonly limit: number },
): Promise<string[]> {
  return listTeamsWithUnissuedPayments(db, page);
}
