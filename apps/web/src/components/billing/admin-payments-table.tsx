import type { AdminPaymentsResponse } from '@sgm/shared';
import {
  ADMIN_BANKING_NOTICE,
  HOLD_ROW_ADMIN,
  formatDay,
  money,
  reminderCell,
} from '../../lib/billing/labels.ts';
import { bankingPagePath } from '../../lib/billing/paths.ts';
import { adminRowAction } from '../../lib/billing/wallet-view.ts';
import { LINK_CLASS } from '../auth/styles.ts';
import { HoldResolution } from './hold-resolution.tsx';
import { PaymentStatusTag } from './payment-status-tag.tsx';
import { ReminderConfirm } from './reminder-confirm.tsx';

type Row = AdminPaymentsResponse['payments'][number];

const CELL =
  'px-3 py-2 align-top max-sm:flex max-sm:gap-2 max-sm:px-0 max-sm:py-1 max-sm:before:min-w-28 max-sm:before:shrink-0 max-sm:before:font-semibold max-sm:before:content-[attr(data-label)]';

function PaymentRow({
  teamId,
  row,
  now,
  payoutBlocked,
}: {
  teamId: string;
  row: Row;
  now: string;
  payoutBlocked: boolean;
}) {
  const action = adminRowAction(row, { payoutBlocked, now: new Date(now) });
  return (
    <tr
      role="row"
      className="border-b border-slate-300 max-sm:mb-3 max-sm:block max-sm:rounded-md max-sm:border max-sm:p-3"
    >
      <td role="cell" data-label="Player" className={`${CELL} min-w-0 break-words font-medium`}>
        {row.player.fullName}
      </td>
      <td role="cell" data-label="Session" className={CELL}>
        {formatDay(row.sessionStartsAt)}
      </td>
      <td role="cell" data-label="Amount" className={`${CELL} tabular-nums`}>
        {money(row.amount)}
      </td>
      <td role="cell" data-label="Status" className={CELL}>
        <span className="flex flex-col items-start gap-1">
          <PaymentStatusTag
            status={row.status}
            billingType="PER_GAME"
            amount={row.amount}
            dueDate={row.dueDate}
            onHold={row.onHold}
          />
          {row.status !== 'PAID' && row.onHold ? (
            <span className="text-sm">{HOLD_ROW_ADMIN}</span>
          ) : null}
        </span>
      </td>
      <td role="cell" data-label="Last reminder" className={CELL}>
        {reminderCell(row.lastReminderAt, new Date(now))}
      </td>
      <td role="cell" className={`${CELL} max-sm:before:content-none`}>
        {action === 'reminder' || action === 'cooldown' ? (
          <ReminderConfirm
            teamId={teamId}
            paymentId={row.id}
            playerName={row.player.fullName}
            amount={row.amount}
            sessionStartsAt={row.sessionStartsAt}
            status={row.status}
            lastReminderAt={row.lastReminderAt}
            now={now}
            held={row.onHold}
            payoutBlocked={payoutBlocked}
          />
        ) : null}
        {action === 'hold' ? (
          <HoldResolution teamId={teamId} paymentId={row.id} playerName={row.player.fullName} />
        ) : null}
      </td>
    </tr>
  );
}

/**
 * The Payments area's list (UI/UX variant C): one native `<table>` with its roles written out, so it keeps its semantics when
 * Tailwind drops `display: table-*` below 640 px and each row becomes a bordered block whose cells show their `data-label`
 * ("Player", "Session", ...). The header row stays for screen readers. Names only: never an email address or a bank detail.
 * `now` is the page's clock. A payout-blocked team gets a notice that links to Banking and GST, and no reminder anywhere.
 */
export function AdminPaymentsTable({
  teamId,
  payments,
  payoutBlocked,
  now,
  emptyText = 'No payments yet. They appear here after a session ends.',
}: {
  teamId: string;
  payments: readonly Row[];
  payoutBlocked: boolean;
  /** ISO instant of the page render. */
  now: string;
  emptyText?: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      {payoutBlocked ? (
        <div className="flex flex-col items-start rounded-md border-2 border-slate-900 p-4">
          <p className="text-base">{ADMIN_BANKING_NOTICE}</p>
          <a href={bankingPagePath(teamId)} className={LINK_CLASS}>
            Go to Banking and GST
          </a>
        </div>
      ) : null}
      {payments.length === 0 ? (
        <p className="text-base">{emptyText}</p>
      ) : (
        <table role="table" className="w-full text-left text-base max-sm:block">
          <thead role="rowgroup" className="max-sm:sr-only">
            <tr role="row" className="border-b-2 border-slate-900">
              {['Player', 'Session', 'Amount', 'Status', 'Last reminder', 'Action'].map((name) => (
                <th key={name} role="columnheader" scope="col" className="px-3 py-2 font-semibold">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup" className="max-sm:block">
            {payments.map((row) => (
              <PaymentRow
                key={row.id}
                teamId={teamId}
                row={row}
                now={now}
                payoutBlocked={payoutBlocked}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
