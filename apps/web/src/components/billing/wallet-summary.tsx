import type { WalletResponse } from '@sgm/shared';
import {
  BANK_SLOW,
  PROCESSING_TOP_UP,
  TOP_UP_DONE_ANNOUNCEMENT,
  balanceLine,
  money,
} from '../../lib/billing/labels.ts';
import { walletPath } from '../../lib/billing/paths.ts';
import { walletState } from '../../lib/billing/wallet-view.ts';
import { LINK_CLASS } from '../auth/styles.ts';
import { RefreshWhilePending } from '../teams/refresh-while-pending.tsx';
import { BillingSection } from './billing-section.tsx';
import { ContinueTopUp, TopUpForm } from './top-up-form.tsx';

/**
 * The team page's one-line entry to the wallet (AC-ENTRY-1): "Wallet: $12.50 · Top up or pay". When the wallet call failed the
 * balance is simply left out ("Wallet and payments"); the failure never takes the team page down.
 */
export function WalletLine({ teamId, balance }: { teamId: string; balance: string | null }) {
  return (
    <a href={walletPath(teamId)} className={LINK_CLASS}>
      {balance === null ? 'Wallet and payments' : `Wallet: ${money(balance)} · Top up or pay`}
    </a>
  );
}

/**
 * The Wallet section: the balance and exactly one of the top-up form, "full", the open top-up's processing panel, or a hold
 * notice (UI/UX "Wallet section states"). Everything shown is a field of the wallet read model; the headroom and the cap are
 * the API's, never derived here. `idempotencyKey` is a UUID the page generated for this render.
 */
export function WalletSummary({
  teamId,
  teamName,
  wallet,
  search,
  idempotencyKey,
}: {
  teamId: string;
  teamName: string;
  wallet: WalletResponse['wallet'];
  /** `?topUp=<id>` is where Akahu's return lands. */
  search: { topUp?: string | undefined };
  idempotencyKey: string;
}) {
  const state = walletState(wallet, { topUp: search.topUp });
  const pending = wallet.pendingTopUp;
  return (
    <BillingSection id="wallet" title="Wallet">
      <p className="text-2xl font-semibold">{balanceLine(wallet.balance)}</p>
      {state.kind === 'form' ? (
        <>
          <div role="status" className="text-base">
            {state.notice === null ? null : <p className="font-medium">{state.notice.text}</p>}
          </div>
          <p className="text-base">{state.headroomLine}</p>
          <TopUpForm
            teamId={teamId}
            teamName={teamName}
            headroom={wallet.headroom}
            idempotencyKey={idempotencyKey}
          />
        </>
      ) : null}
      {state.kind === 'full' ? (
        <div role="status" className="flex flex-col gap-2 text-base">
          <p>{state.line}</p>
          {state.notice === null ? null : <p className="font-medium">{state.notice.text}</p>}
        </div>
      ) : null}
      {search.topUp !== undefined && (state.kind !== 'processing' || state.returned) ? (
        <RefreshWhilePending
          pending={state.kind === 'processing'}
          href={`${walletPath(teamId)}?topUp=${search.topUp}`}
          pendingText={PROCESSING_TOP_UP}
          slowText={BANK_SLOW}
          doneText={TOP_UP_DONE_ANNOUNCEMENT}
        />
      ) : null}
      {state.kind === 'processing' && !state.returned && pending !== null ? (
        <div className="flex flex-col gap-3">
          <p role="status" className="text-base">
            {state.startedLine}
          </p>
          <ContinueTopUp teamId={teamId} amount={pending.amount} idempotencyKey={idempotencyKey} />
        </div>
      ) : null}
      {state.kind === 'held' ? (
        <div role="status" className="flex flex-col gap-1 text-base">
          <p className="font-medium">{state.heading}</p>
          <p>{state.body}</p>
        </div>
      ) : null}
    </BillingSection>
  );
}
