/**
 * Starting a wallet top-up, `POST /teams/:teamId/wallet/top-ups` (wallet-and-akahu-billing Phase 4a; CR-6, CR-24, A5, B1, B10,
 * C-BIL-PAY; algorithm doc B and D). Three steps, the provider call between two short transactions and never under a lock:
 *
 *   tx1 (lock order teams -> team_members -> wallet_top_ups -> player_credits):
 *     1. `teams FOR KEY SHARE` with the payout flag and the sealed payee in the same statement; not configured (no banking, or a
 *        payout block) -> 409 `payout_not_configured`, nothing inserted. A banking removal (FOR UPDATE) and this start serialise.
 *     2. `team_members FOR SHARE`: still an APPROVED member (the route guard ran outside this transaction) -> else 403.
 *     3. A replay of this key answers what the key already got.
 *     4. CR-24: claim the wallet's one blocking slot FIRST (insert CREATING; a concurrent claim waits on the index), so the
 *        balance read next is never older than a credit that committed while this start waited.
 *     5. `player_credits FOR SHARE` in a fresh statement; amount over the headroom (B1) -> 422 "You can top up at most $X." and
 *        the whole transaction (the claim included) rolls back.
 *   create (no transaction): the payee is decrypted for this call only; `startProviderPayment` makes the one create call.
 *   tx2: CREATING -> OPEN with the provider id, the sealed consent URL and the expiry. If the row is no longer CREATING (the
 *     reconcile sweep closed it) or tx2 fails, the provider payment is an orphan: a best-effort cancel is enqueued and the answer
 *     is 503. A provider failure closes the intent and answers 503 `payment_provider_unavailable` (or 422 refused).
 *
 * A second start while one is open answers 409 `top_up_in_progress` with the open one and its consent URL while the link has
 * time left (CR-6); an expired, still-unauthorised link is cancelled through the cancel job (never applied inline, CR-3) and the
 * answer carries no URL. Nothing here credits the wallet: only the apply funnel does, on the provider's word (CR-3).
 */
import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import {
  WALLET_CAP,
  gt,
  parseMoney,
  subtract,
  toMoneyString,
  topUpHeadroomMessage,
  type Money,
  type TopUpResponse,
} from '@sgm/shared';
import type { PaymentsGateway } from '../../lib/akahu/gateway.ts';
import {
  createFailureCloseReason,
  createFailureOf,
  isExpiredAwaitingPayer,
  newStatementReference,
  resumeUrl,
  sealAuthorisationUrl,
  startProviderPayment,
  type CreateFailure,
  type PaymentStartSettings,
  type SealedPayee,
} from '../../lib/akahu/start.ts';
import type { Clock } from '../../lib/clock.ts';
import type { FieldCrypto } from '../../lib/crypto/crypto.ts';
import type { Database } from '../../lib/db/kysely.ts';
import { AppError } from '../../lib/http/errors.ts';
import {
  claimTopUpSlot,
  closeTopUpAtCreate,
  findBlockingTopUp,
  findTopUpByKey,
  openTopUp,
  type TopUpIntent,
} from './top-up-repo.ts';

export type WalletLogger = Pick<FastifyBaseLogger, 'info' | 'warn'>;

/** Why a provider payment is cancelled from a start path (the `akahu-cancel` job's sources). */
export type StartCancelSource = 'expired' | 'start_orphan';

export interface TopUpStartDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly gateway: Pick<PaymentsGateway, 'createPayment'>;
  readonly settings: PaymentStartSettings;
  /** `config.auth.webBaseUrl`: origin of the web app, no trailing slash. */
  readonly webBaseUrl: string;
  /**
   * Enqueues a best-effort provider cancel (the `akahu-cancel` job). Injected by the app, so the wallet module never imports
   * billing (boundaries.test).
   */
  readonly cancelProviderPayment: (input: {
    readonly akahuPaymentId: string;
    readonly source: StartCancelSource;
  }) => Promise<unknown>;
}

export interface TopUpStartInput {
  readonly userId: string;
  readonly teamId: string;
  readonly amount: Money;
  readonly idempotencyKey: string;
}

/** The player-facing copy of a payout that cannot receive money (the default message is the admin's publish-gate copy). */
export const PAYOUT_UNAVAILABLE_MESSAGE = "This team can't receive payments right now.";

const LOCK_TIMEOUT_MS = 3000;
const REFERENCE_ATTEMPTS = 3;

type Claim =
  | { readonly kind: 'replay'; readonly intent: TopUpIntent }
  | { readonly kind: 'blocked'; readonly intent: TopUpIntent }
  | {
      readonly kind: 'claimed';
      readonly id: string;
      readonly reference: string;
      readonly payee: SealedPayee;
    };

const returnUrl = (webBaseUrl: string, teamId: string, topUpId: string): string =>
  `${webBaseUrl}/teams/${teamId}/wallet?topUp=${topUpId}`;

const topUpView = (intent: Pick<TopUpIntent, 'id' | 'amount' | 'status'>) => ({
  id: intent.id,
  amount: toMoneyString(intent.amount),
  status: intent.status,
});

function failureError(failure: CreateFailure): AppError {
  return failure.kind === 'unavailable'
    ? new AppError('payment_provider_unavailable')
    : new AppError('payment_provider_refused', { reason: failure.reason });
}

async function claim(deps: TopUpStartDeps, input: TopUpStartInput): Promise<Claim> {
  const owner = { userId: input.userId, teamId: input.teamId };
  return deps.db.transaction().execute(async (trx) => {
    await sql.raw(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`).execute(trx);
    const team = await trx
      .selectFrom('teams')
      .select(['is_payout_configured', 'bank_account_name', 'bank_account_number'])
      .where('id', '=', input.teamId)
      .forKeyShare()
      .executeTakeFirst();
    if (team === undefined) throw new AppError('forbidden');
    if (!team.is_payout_configured) {
      throw new AppError('payout_not_configured', { message: PAYOUT_UNAVAILABLE_MESSAGE });
    }
    const member = await trx
      .selectFrom('team_members')
      .select('id')
      .where('team_id', '=', input.teamId)
      .where('user_id', '=', input.userId)
      .where('status', '=', 'APPROVED')
      .forShare()
      .executeTakeFirst();
    if (member === undefined) throw new AppError('forbidden');

    const prior = await findTopUpByKey(trx, owner, input.idempotencyKey);
    if (prior !== undefined) return { kind: 'replay', intent: prior };

    for (let attempt = 0; attempt < REFERENCE_ATTEMPTS; attempt += 1) {
      const reference = newStatementReference();
      const id = await claimTopUpSlot(trx, {
        ...owner,
        amount: input.amount,
        reference,
        idempotencyKey: input.idempotencyKey,
      });
      if (id === undefined) {
        // Told apart by reading (each statement sees what committed while the claim waited).
        const sameKey = await findTopUpByKey(trx, owner, input.idempotencyKey);
        if (sameKey !== undefined) return { kind: 'replay', intent: sameKey };
        const blocking = await findBlockingTopUp(trx, owner);
        if (blocking !== undefined) return { kind: 'blocked', intent: blocking };
        continue; // the reference collided: draw another
      }
      // CR-24: the balance is read AFTER the slot is ours, in a fresh statement.
      const wallet = await trx
        .selectFrom('player_credits')
        .select('balance')
        .where('user_id', '=', input.userId)
        .where('team_id', '=', input.teamId)
        .forShare()
        .executeTakeFirst();
      const balance = wallet === undefined ? parseMoney('0.00') : parseMoney(wallet.balance);
      const headroom = subtract(WALLET_CAP, balance);
      if (gt(input.amount, headroom)) {
        throw new AppError('validation_failed', {
          fieldErrors: { amount: [topUpHeadroomMessage(headroom)] },
        });
      }
      return {
        kind: 'claimed',
        id,
        reference,
        payee: {
          teamId: input.teamId,
          nameEnvelope: team.bank_account_name,
          numberEnvelope: team.bank_account_number,
        },
      };
    }
    throw new Error('could not allocate a unique top-up reference');
  });
}

export async function startTopUp(
  deps: TopUpStartDeps,
  input: TopUpStartInput,
  log: WalletLogger,
): Promise<TopUpResponse> {
  const claimed = await claim(deps, input);
  const now = deps.clock.now(); // after tx1's locks were released: the instant of the create and of any resume decision

  if (claimed.kind === 'replay') {
    const intent = claimed.intent;
    if (intent.status === 'CREATING') {
      throw new AppError('top_up_in_progress', {
        resume: { redirectUrl: null, topUp: topUpView(intent) },
      });
    }
    const failure = intent.akahuPaymentId === null ? createFailureOf(intent.closeReason) : null;
    if (failure !== null) throw failureError(failure);
    return {
      topUp: topUpView(intent),
      redirectUrl:
        resumeUrl(deps.crypto, 'wallet_top_ups', intent, now) ??
        returnUrl(deps.webBaseUrl, input.teamId, intent.id),
    };
  }

  if (claimed.kind === 'blocked') {
    const intent = claimed.intent;
    if (isExpiredAwaitingPayer(intent, now) && intent.akahuPaymentId !== null) {
      // Cancel-and-replace (RF-6): the cancel job re-reads and closes it; the next start then gets a fresh link.
      await requestCancel(deps, log, intent.akahuPaymentId, 'expired', intent.id);
    }
    throw new AppError('top_up_in_progress', {
      resume: {
        redirectUrl: resumeUrl(deps.crypto, 'wallet_top_ups', intent, now),
        topUp: topUpView(intent),
      },
    });
  }

  const started = await startProviderPayment(deps, {
    amount: input.amount,
    reference: claimed.reference,
    redirectUri: returnUrl(deps.webBaseUrl, input.teamId, claimed.id),
    payee: claimed.payee,
    now,
  });

  if (started.kind !== 'created') {
    const reason = createFailureCloseReason(started);
    try {
      await closeTopUpAtCreate(deps.db, { id: claimed.id, reason, now });
    } catch (error) {
      // The reconcile sweep closes a stale CREATING row; the answer to the player does not change.
      log.warn(
        {
          event: 'wallet.topup.close_failed',
          topUpId: claimed.id,
          errorClass: error instanceof Error ? error.name : typeof error,
        },
        'top-up could not be closed after a failed create',
      );
    }
    log.warn(
      { event: 'wallet.topup.create_failed', topUpId: claimed.id, teamId: input.teamId, reason },
      'top-up could not be started at the payment provider',
    );
    throw failureError(
      started.kind === 'unavailable' ? started : { kind: 'refused', reason: started.reason },
    );
  }

  let recorded = false;
  try {
    recorded = await openTopUp(deps.db, {
      id: claimed.id,
      akahuPaymentId: started.providerPaymentId,
      akahuStatus: started.providerStatus,
      akahuStatusReason: started.providerStatusReason,
      authorisationUrlEnc: sealAuthorisationUrl(
        deps.crypto,
        'wallet_top_ups',
        claimed.id,
        started.authorisationUrl,
      ),
      expiresAt: started.expiresAt,
    });
  } catch (error) {
    log.warn(
      {
        event: 'wallet.topup.record_failed',
        topUpId: claimed.id,
        errorClass: error instanceof Error ? error.name : typeof error,
      },
      'top-up could not be recorded after the provider created it',
    );
  }
  if (!recorded) {
    // Nobody was handed the consent URL: cancel the provider payment and let the player try again.
    await requestCancel(deps, log, started.providerPaymentId, 'start_orphan', claimed.id);
    throw new AppError('payment_provider_unavailable');
  }

  log.info(
    {
      event: 'wallet.topup.started',
      topUpId: claimed.id,
      teamId: input.teamId,
      userId: input.userId,
    },
    'top-up started',
  );
  return {
    topUp: { id: claimed.id, amount: toMoneyString(input.amount), status: 'OPEN' },
    redirectUrl: started.authorisationUrl,
  };
}

async function requestCancel(
  deps: TopUpStartDeps,
  log: WalletLogger,
  akahuPaymentId: string,
  source: StartCancelSource,
  topUpId: string,
): Promise<void> {
  try {
    await deps.cancelProviderPayment({ akahuPaymentId, source });
  } catch (error) {
    // Best effort: reconcile re-reads the provider payment anyway.
    log.warn(
      {
        event: 'wallet.topup.cancel_enqueue_failed',
        topUpId,
        source,
        errorClass: error instanceof Error ? error.name : typeof error,
      },
      'provider cancel could not be queued',
    );
  }
}
