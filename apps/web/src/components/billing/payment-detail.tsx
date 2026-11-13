import { ZERO, gt, parseMoney, type PaymentResponse } from '@sgm/shared';
import {
  LATE_WITHDRAWAL_NOTE,
  PAYMENT_DONE_ANNOUNCEMENT,
  PROCESSING_PAYMENT,
  basisLabel,
  dueLine,
  formatDateTime,
  formatDay,
  lineWho,
  money,
} from '../../lib/billing/labels.ts';
import { paymentPath } from '../../lib/billing/paths.ts';
import { paymentState } from '../../lib/billing/wallet-view.ts';
import { INVOICE_NUMBER_LABEL } from '../../lib/invoices/labels.ts';
import { myDocumentPath } from '../../lib/invoices/paths.ts';
import { DownloadErrorNotice } from '../invoices/download-error-notice.tsx';
import { DownloadInvoiceLink } from '../invoices/download-invoice-link.tsx';
import { RefreshWhilePending } from '../teams/refresh-while-pending.tsx';
import { PayButton } from './pay-button.tsx';
import { PaymentStatusTag } from './payment-status-tag.tsx';

/**
 * The payment page body: the summary list, what the player is paying for, and exactly one state from `paymentState` (the
 * documented priority) with at most one primary action. Hold is a first-class state: no button is rendered at all, and the page
 * never says the payer was not charged, because nobody knows yet. Everything shown is a field of the read model; no payment
 * link, token, bank detail or email address is ever rendered. `idempotencyKey` is a UUID the page generated for this render.
 */
export function PaymentDetail({
  payment,
  search,
  idempotencyKey,
  overdueCount,
  downloadError,
}: {
  payment: PaymentResponse['payment'];
  /** `?return=1` is where Akahu's return lands. */
  search: { return?: string | undefined };
  idempotencyKey: string;
  /** The caller's overdue count, for the register-for-more-games sentence (only shown from the debt limit). */
  overdueCount?: number | undefined;
  /** `?download_error=<code>`: why the last invoice download did not happen (set by the route handler's 303). */
  downloadError?: string | null | undefined;
}) {
  const state = paymentState(payment, search, { overdueCount: overdueCount ?? 0 });
  const heading = `Payment for ${payment.session.location}, ${formatDay(payment.session.startsAt)}`;
  const gstShown = gt(parseMoney(payment.gstAmount), ZERO);
  const held = payment.onHold || payment.attempt?.outcome === 'held';

  return (
    <div className="flex flex-col gap-6">
      <h1 className="min-w-0 break-words text-2xl font-semibold">{heading}</h1>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-base">
        <dt className="font-medium">Team</dt>
        <dd className="min-w-0 break-words">{payment.teamName}</dd>
        <dt className="font-medium">Game</dt>
        <dd className="min-w-0 break-words">{`${formatDateTime(payment.session.startsAt)}, ${payment.session.location}`}</dd>
        <dt className="font-medium">Amount</dt>
        <dd className="tabular-nums">{money(payment.amount)}</dd>
        {gstShown ? (
          <>
            <dt className="font-medium">GST</dt>
            <dd className="tabular-nums">{`Includes GST of ${money(payment.gstAmount)}`}</dd>
          </>
        ) : null}
        {payment.status === 'PAID' ? null : (
          <>
            <dt className="font-medium">Due</dt>
            <dd>{dueLine(payment.status, payment.dueDate)}</dd>
          </>
        )}
        {payment.document.number === null ? null : (
          <>
            <dt className="font-medium">{INVOICE_NUMBER_LABEL[payment.document.kind]}</dt>
            <dd className="break-words">{payment.document.number}</dd>
          </>
        )}
        <dt className="font-medium">Status</dt>
        <dd>
          <PaymentStatusTag
            status={payment.status}
            billingType={payment.billingType}
            amount={payment.amount}
            dueDate={payment.dueDate}
            onHold={held}
          />
        </dd>
      </dl>

      <section aria-labelledby="line-items-heading" className="flex flex-col gap-2">
        <h2 id="line-items-heading" className="text-lg font-semibold">
          What you&apos;re paying for
        </h2>
        {payment.reason === 'LATE_WITHDRAWAL' ? (
          <p className="text-base">{LATE_WITHDRAWAL_NOTE}</p>
        ) : null}
        {payment.lines.length === 0 ? null : (
          <table className="w-full max-w-md text-left text-base">
            <tbody>
              {payment.lines.map((line) => (
                <tr key={line.position} className="border-b border-slate-300">
                  <th scope="row" className="py-2 pr-3 font-medium">
                    {lineWho(line.position)}
                  </th>
                  <td className="py-2">{`${basisLabel(line.basis)} · ${money(line.unitFee)}`}</td>
                </tr>
              ))}
              <tr>
                <th scope="row" className="py-2 pr-3 font-semibold">
                  Total
                </th>
                <td className="py-2 font-semibold tabular-nums">{money(payment.amount)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </section>

      <section aria-label="Payment status" className="flex flex-col gap-3">
        {state.kind === 'hold' ? (
          <div
            role="status"
            className="flex flex-col gap-1 rounded-md border-2 border-slate-900 p-4"
          >
            <h2 className="text-lg font-semibold">{state.heading}</h2>
            <p className="text-base">{state.body}</p>
          </div>
        ) : null}
        {state.kind === 'processing' || search.return !== undefined ? (
          <RefreshWhilePending
            pending={state.kind === 'processing'}
            href={`${paymentPath(payment.id)}?return=1`}
            pendingText={PROCESSING_PAYMENT}
            slowText={state.kind === 'processing' ? (state.slowText ?? '') : ''}
            doneText={PAYMENT_DONE_ANNOUNCEMENT}
          />
        ) : null}
        {state.kind !== 'hold' && state.kind !== 'processing' ? (
          <p role="status" className="text-base">
            {state.message}
          </p>
        ) : null}
        {state.action === null ? null : (
          <PayButton
            paymentId={payment.id}
            idempotencyKey={idempotencyKey}
            kind={state.action}
            amount={payment.amount}
          />
        )}
        <DownloadErrorNotice code={downloadError} kind={payment.document.kind} />
        {payment.document.available ? (
          <DownloadInvoiceLink
            href={myDocumentPath(payment.id)}
            kind={payment.document.kind}
            context={{
              location: payment.session.location,
              day: formatDay(payment.session.startsAt),
              amount: money(payment.amount),
            }}
            variant="primary"
          />
        ) : null}
      </section>
    </div>
  );
}
