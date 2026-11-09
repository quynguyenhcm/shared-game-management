import type { WalletResponse } from '@sgm/shared';
import {
  NO_LEDGER,
  formatDay,
  ledgerDescription,
  money,
  signedAmountText,
} from '../../lib/billing/labels.ts';
import { LINK_CLASS } from '../auth/styles.ts';
import { BillingSection } from './billing-section.tsx';

/**
 * Wallet activity, newest first: date, description, a signed amount (a real plus or minus sign, so it is never colour alone)
 * and the balance after it. Paging is a plain link (`?cursor=`) that replaces the list, with "Back to newest": no client state
 * and no unbounded page. Every figure is the API's.
 */
export function LedgerList({
  transactions,
  nextCursor,
  walletPath,
  cursor,
}: {
  transactions: WalletResponse['transactions'];
  nextCursor: string | null;
  /** The wallet page's path, the base of the paging links. */
  walletPath: string;
  /** The cursor this page was loaded with, or null for the newest. */
  cursor: string | null;
}) {
  return (
    <BillingSection id="activity" title="Wallet activity">
      {transactions.length === 0 ? (
        <p className="text-base">{NO_LEDGER}</p>
      ) : (
        <ul className="flex flex-col">
          {transactions.map((item) => (
            <li key={item.id} className="flex flex-col gap-0.5 border-b border-slate-300 py-3">
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0 break-words">
                  <span className="font-medium">{formatDay(item.createdAt)}</span>{' '}
                  <span>{ledgerDescription(item)}</span>
                </span>
                <span className="tabular-nums font-medium">{signedAmountText(item.amount)}</span>
              </div>
              <span className="text-sm text-slate-700">{`Balance ${money(item.resultingBalance)}`}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-x-4">
        {nextCursor === null ? null : (
          <a href={`${walletPath}?cursor=${encodeURIComponent(nextCursor)}`} className={LINK_CLASS}>
            Show older activity
          </a>
        )}
        {cursor === null ? null : (
          <a href={walletPath} className={LINK_CLASS}>
            Back to newest
          </a>
        )}
      </div>
    </BillingSection>
  );
}
