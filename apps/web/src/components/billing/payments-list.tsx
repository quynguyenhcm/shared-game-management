import type { MyPaymentRow } from '@sgm/shared';
import {
  HOLD_ROW_PLAYER,
  LATE_WITHDRAWAL_REASON,
  NO_PAYMENTS,
  OLDER_PAID_GAMES,
  PAID_CAPPED_NOTE,
  PAYOUT_BLOCKED_PLAYER,
  formatDay,
  money,
} from '../../lib/billing/labels.ts';
import { paymentPath } from '../../lib/billing/paths.ts';
import { canPayRow, type PaymentGroups } from '../../lib/billing/wallet-view.ts';
import { myDocumentPath } from '../../lib/invoices/paths.ts';
import { BUTTON_CLASS, LINK_CLASS } from '../auth/styles.ts';
import { DownloadInvoiceLink } from '../invoices/download-invoice-link.tsx';
import { PaymentStatusTag } from './payment-status-tag.tsx';

function PaymentRow({ row, returnTo }: { row: MyPaymentRow; returnTo?: string | undefined }) {
  const label = `${row.location}, ${formatDay(row.sessionStartsAt)}`;
  const unpaid = row.status !== 'PAID';
  return (
    <li className="flex flex-col gap-2 border-b border-slate-300 py-3">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0 break-words font-medium">{label}</span>
        <span className="tabular-nums">{money(row.amount)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <PaymentStatusTag
          status={row.status}
          billingType={row.billingType}
          amount={row.amount}
          dueDate={row.dueDate}
          onHold={row.onHold}
        />
        {row.reason === 'LATE_WITHDRAWAL' ? (
          <span className="text-sm">{LATE_WITHDRAWAL_REASON}</span>
        ) : null}
        {row.document.available ? (
          <span className="sm:ml-auto">
            <DownloadInvoiceLink
              href={myDocumentPath(row.id, returnTo)}
              kind={row.document.kind}
              context={{
                location: row.location,
                day: formatDay(row.sessionStartsAt),
                amount: money(row.amount),
              }}
              variant="link"
            />
          </span>
        ) : null}
        {canPayRow(row) ? (
          <a
            href={paymentPath(row.id)}
            aria-label={`Pay now, ${label}, ${money(row.amount)}`}
            className={`${BUTTON_CLASS} sm:ml-auto sm:w-auto`}
          >
            Pay now
          </a>
        ) : null}
      </div>
      {unpaid && row.onHold ? <p className="text-sm">{HOLD_ROW_PLAYER}</p> : null}
      {unpaid && !row.onHold && row.payoutBlocked ? (
        <p className="text-sm">{PAYOUT_BLOCKED_PLAYER}</p>
      ) : null}
    </li>
  );
}

function Group({
  title,
  rows,
  returnTo,
}: {
  title: string;
  rows: readonly MyPaymentRow[];
  returnTo?: string | undefined;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-base font-semibold">{title}</h3>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <PaymentRow key={row.id} row={row} returnTo={returnTo} />
        ))}
      </ul>
    </div>
  );
}

/**
 * The caller's payments grouped Overdue, Pending, Paid (empty groups omitted), used by the wallet page and the cross-team
 * unpaid list. "Pay now" is a link to the payment page (the only place an attempt starts) on a payable row only: a held or
 * payout-blocked row says why instead, and a paid row has none. The caller supplies the `h2` of the section.
 */
export function PaymentsList({
  groups,
  emptyText = NO_PAYMENTS,
  returnTo,
  olderHref = null,
}: {
  groups: PaymentGroups;
  emptyText?: string;
  /** The page the invoice links live on: an error lands back here (`?download_error=`). */
  returnTo?: string | undefined;
  /** The "Show older paid games" link (R5): every paid game's invoice must be reachable. */
  olderHref?: string | null;
}) {
  const empty = groups.overdue.length + groups.pending.length + groups.paid.length === 0;
  if (empty) return <p className="text-base">{emptyText}</p>;
  return (
    <div className="flex flex-col gap-4">
      <Group title="Overdue" rows={groups.overdue} returnTo={returnTo} />
      <Group title="Pending" rows={groups.pending} returnTo={returnTo} />
      <Group title="Paid" rows={groups.paid} returnTo={returnTo} />
      {groups.paidTruncated ? <p className="text-sm">{PAID_CAPPED_NOTE}</p> : null}
      {olderHref === null ? null : (
        <a href={olderHref} className={`${LINK_CLASS} self-start`}>
          {OLDER_PAID_GAMES}
        </a>
      )}
    </div>
  );
}
