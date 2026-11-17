import type { UnpaidPaymentsResponse } from '@sgm/shared';
import { NO_PAYMENTS, PAYMENTS_LOAD_FAILED, SHOW_MORE } from '../../lib/billing/labels.ts';
import {
  FIND_A_TEAM,
  NO_TEAM_WALLET,
  PAYMENTS_HEADING,
  WALLETS_LOAD_FAILED,
  WALLET_HEADING,
  WALLET_LOAD_FAILED,
} from '../../lib/dashboard/labels.ts';
import { PAYMENTS_RETURN_TO } from '../../lib/dashboard/paths.ts';
import {
  paymentAccordions,
  paymentsEmpty,
  type AccordionView,
  type WalletCardView,
} from '../../lib/dashboard/view.ts';
import { LINK_CLASS, FOCUS_RING } from '../auth/styles.ts';
import { PaymentRow } from '../billing/payments-list.tsx';
import { DownloadErrorNotice } from '../invoices/download-error-notice.tsx';

export type PaymentsState = {
  teams: { kind: 'failed' } | { kind: 'ok'; cards: WalletCardView[] };
  payments:
    | { kind: 'failed' }
    | {
        kind: 'ok';
        unpaid: UnpaidPaymentsResponse;
        paid: UnpaidPaymentsResponse;
        paidCursor?: string | undefined;
        unpaidCursor?: string | undefined;
      };
  /** `?download_error=<code>` of the invoice route's 303; unknown codes render nothing. */
  downloadError: string | undefined;
};

function WalletCard({ card }: { card: WalletCardView }) {
  return (
    <li className="flex flex-col gap-2 rounded-md border border-slate-300 p-3">
      <h3 className="min-w-0 break-words text-lg font-semibold">
        <a href={card.href} className={LINK_CLASS}>
          {card.name}
        </a>
      </h3>
      {card.failed ? (
        <p role="status" className="text-base">
          {WALLET_LOAD_FAILED}
        </p>
      ) : (
        <>
          <p className="text-2xl font-semibold">{card.balance}</p>
          <p className="text-base">{card.line}</p>
          {card.action === null ? null : (
            <a href={card.action.href} className={`${LINK_CLASS} self-start`}>
              {card.action.text}
              <span className="sr-only">{card.action.srSuffix}</span>
            </a>
          )}
        </>
      )}
    </li>
  );
}

function Accordion({ view }: { view: AccordionView }) {
  const showMore =
    view.showMoreHref === null ? null : (
      <a href={view.showMoreHref} className={`${LINK_CLASS} self-start`}>
        {SHOW_MORE}
      </a>
    );
  return (
    <details open={view.open} className="rounded-md border border-slate-300 px-3">
      <summary
        className={`flex min-h-11 cursor-pointer items-center text-base font-semibold ${FOCUS_RING}`}
      >
        {view.title}
      </summary>
      <div className="flex flex-col gap-3 pb-3">
        {view.groups.length === 0 ? <p className="text-base">{view.empty}</p> : null}
        {view.groups.map((group) => (
          <div key={group.teamId} className="flex flex-col gap-1">
            <h4 className="min-w-0 break-words text-base font-semibold">{group.teamName}</h4>
            <ul className="flex flex-col">
              {group.rows.map((row) => (
                <PaymentRow key={row.id} row={row} returnTo={PAYMENTS_RETURN_TO} />
              ))}
            </ul>
          </div>
        ))}
        {showMore}
      </div>
    </details>
  );
}

function FindTeam() {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-base">{NO_TEAM_WALLET}</p>
      <a href="/teams/find" className={`${LINK_CLASS} self-start`}>
        {FIND_A_TEAM}
      </a>
    </div>
  );
}

/**
 * Payments & Wallet: a wallet card per approved team (balance, the one state line and the one allowed next step, all from the
 * wallet read model), then three native `<details>` accordions Overdue, Pending, Paid. Every row is the existing `PaymentRow`, so
 * `Pay now` and the invoice download appear exactly where the billing pages offer them. The dashboard starts no payment and
 * claims nothing about the provider: `Top up credit` and `Pay now` are links into pages that already degrade honestly.
 */
export function PaymentsTab({ state }: { state: PaymentsState }) {
  const { teams, payments } = state;
  const noCards = teams.kind === 'ok' && teams.cards.length === 0;
  const empty = payments.kind === 'ok' && paymentsEmpty(payments.unpaid, payments.paid);
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="wallet-heading" className="flex flex-col gap-3">
        <h2 id="wallet-heading" className="text-lg font-semibold">
          {WALLET_HEADING}
        </h2>
        {teams.kind === 'failed' ? (
          <p role="status" className="text-base">
            {WALLETS_LOAD_FAILED}
          </p>
        ) : noCards ? (
          <FindTeam />
        ) : (
          <ul className="flex flex-col gap-3">
            {teams.cards.map((card) => (
              <WalletCard key={card.teamId} card={card} />
            ))}
          </ul>
        )}
      </section>
      {noCards && empty ? null : (
        <section aria-labelledby="payments-heading" className="flex flex-col gap-3">
          <h2 id="payments-heading" className="text-lg font-semibold">
            {PAYMENTS_HEADING}
          </h2>
          <DownloadErrorNotice code={state.downloadError} />
          {payments.kind === 'failed' ? (
            <p role="status" className="text-base">
              {PAYMENTS_LOAD_FAILED}
            </p>
          ) : empty ? (
            <p className="text-base">{NO_PAYMENTS}</p>
          ) : (
            <div className="flex flex-col gap-3">
              {paymentAccordions(payments).map((view) => (
                <Accordion key={view.id} view={view} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
