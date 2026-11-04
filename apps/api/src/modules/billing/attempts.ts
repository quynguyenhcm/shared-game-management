/**
 * Starting a payment attempt, `POST /payments/:paymentId/attempts` (wallet-and-akahu-billing Phase 4a; AC-HAPPY-4, AC-ERROR-7,
 * AC-ERROR-10, CR-6, CR-7, A5, B10; C-BIL-PAY at attempt start per ADR 0020 and the Phase 2 note; algorithm doc C and D).
 *
 *   0. plain read of the payment by (id, payer): anyone else, and an unknown id, get the same 404 `not_found`;
 *   tx1 (lock order teams -> payments -> payment_attempts):
 *     1. `teams FOR KEY SHARE` with the payout flag and the sealed payee in one statement;
 *     2. `payments FOR NO KEY UPDATE` by (id, payer): concurrent starts for one payment run one after the other;
 *     3. not PENDING/OVERDUE -> 409 `payment_settled`; payout not configured (no banking or a payout block: the block takes
 *        NO KEY UPDATE, which KEY SHARE does not wait for, so the flag is read here at pay time) -> 409 `payout_not_configured`;
 *     4. a replay of this key answers what the key already got;
 *     5. claim the one blocking slot (CREATING, amount = the payment's amount); taken by a HELD attempt -> 409
 *        `payment_on_hold`; by an open one -> 409 `payment_in_progress` with its consent URL while the link has time left
 *        (CR-6), or, when the link has (nearly) expired, a cancel through the cancel job (never applied inline, CR-3) and no URL;
 *   create (no transaction): the team's payee decrypted for this call only; the statement reference is the payment's
 *     `payment_reference` (attempts have none of their own);
 *   tx2: CREATING -> OPEN (provider id, sealed URL, expiry). `payments` is not touched: it learns its Akahu id only when PAID.
 *     A row no longer CREATING, or a failed tx2, makes the provider payment an orphan: cancel enqueued, 503.
 *
 * Membership is never checked: a member who left or was banned after the session still pays their own charge (Edge 14).
 */
import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import { parseMoney, type AttemptResponse } from '@sgm/shared';
import type { PaymentsGateway } from '../../lib/akahu/gateway.ts';
import {
  createFailureCloseReason,
  createFailureOf,
  isExpiredAwaitingPayer,
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
import type { JobRunner } from '../../lib/jobs/jobs.ts';
import { enqueueAkahuCancel, type CancelSource } from './apply-akahu-result.ts';
import {
  claimAttemptSlot,
  closeAttemptAtCreate,
  findAttemptByKey,
  findBlockingAttempt,
  openAttempt,
  type AttemptIntent,
} from './attempts-repo.ts';

export type AttemptLogger = Pick<FastifyBaseLogger, 'info' | 'warn'>;

export interface AttemptStartDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  readonly gateway: Pick<PaymentsGateway, 'createPayment'>;
  readonly settings: PaymentStartSettings;
  /** `config.auth.webBaseUrl`: origin of the web app, no trailing slash. */
  readonly webBaseUrl: string;
}

/** The player-facing copy of a payout that cannot receive money (the default message is the admin's publish-gate copy). */
export const PAYOUT_UNAVAILABLE_MESSAGE = "This team can't receive payments right now.";

const LOCK_TIMEOUT_MS = 3000;

type Claim =
  | { readonly kind: 'replay'; readonly intent: AttemptIntent }
  | { readonly kind: 'blocked'; readonly intent: AttemptIntent }
  | {
      readonly kind: 'claimed';
      readonly id: string;
      readonly amount: ReturnType<typeof parseMoney>;
      readonly reference: string;
      readonly payee: SealedPayee;
    };

const returnUrl = (webBaseUrl: string, paymentId: string): string =>
  `${webBaseUrl}/payments/${paymentId}?return=1`;

function failureError(failure: CreateFailure): AppError {
  return failure.kind === 'unavailable'
    ? new AppError('payment_provider_unavailable')
    : new AppError('payment_provider_refused', { reason: failure.reason });
}

async function claim(
  deps: AttemptStartDeps,
  input: { readonly paymentId: string; readonly payerId: string; readonly idempotencyKey: string },
): Promise<Claim> {
  // Plain read to find the team (the lock prologue takes teams first); scoped to the payer, so everyone else sees "not found".
  const found = await deps.db
    .selectFrom('payments')
    .select('team_id')
    .where('id', '=', input.paymentId)
    .where('user_id', '=', input.payerId)
    .executeTakeFirst();
  if (found === undefined) throw new AppError('not_found');

  return deps.db.transaction().execute(async (trx) => {
    await sql.raw(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`).execute(trx);
    const team = await trx
      .selectFrom('teams')
      .select(['is_payout_configured', 'bank_account_name', 'bank_account_number'])
      .where('id', '=', found.team_id)
      .forKeyShare()
      .executeTakeFirstOrThrow();
    const payment = await trx
      .selectFrom('payments')
      .select(['status', 'amount', 'payment_reference'])
      .where('id', '=', input.paymentId)
      .where('user_id', '=', input.payerId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    if (payment.status !== 'PENDING' && payment.status !== 'OVERDUE') {
      throw new AppError('payment_settled');
    }
    if (!team.is_payout_configured) {
      throw new AppError('payout_not_configured', { message: PAYOUT_UNAVAILABLE_MESSAGE });
    }

    const prior = await findAttemptByKey(trx, input.paymentId, input.idempotencyKey);
    if (prior !== undefined) return { kind: 'replay', intent: prior };

    const amount = parseMoney(payment.amount);
    const id = await claimAttemptSlot(trx, {
      paymentId: input.paymentId,
      amount,
      idempotencyKey: input.idempotencyKey,
    });
    if (id === undefined) {
      const sameKey = await findAttemptByKey(trx, input.paymentId, input.idempotencyKey);
      if (sameKey !== undefined) return { kind: 'replay', intent: sameKey };
      const blocking = await findBlockingAttempt(trx, input.paymentId);
      if (blocking === undefined)
        throw new Error('attempt slot conflict without a blocking attempt');
      return { kind: 'blocked', intent: blocking };
    }
    return {
      kind: 'claimed',
      id,
      amount,
      reference: payment.payment_reference,
      payee: {
        teamId: found.team_id,
        nameEnvelope: team.bank_account_name,
        numberEnvelope: team.bank_account_number,
      },
    };
  });
}

async function requestCancel(
  deps: AttemptStartDeps,
  log: AttemptLogger,
  akahuPaymentId: string,
  source: Extract<CancelSource, 'expired' | 'start_orphan'>,
  attemptId: string,
): Promise<void> {
  try {
    await enqueueAkahuCancel(deps.jobs, { akahuPaymentId, source });
  } catch (error) {
    // Best effort: reconcile re-reads the provider payment anyway.
    log.warn(
      {
        event: 'billing.attempt.cancel_enqueue_failed',
        attemptId,
        source,
        errorClass: error instanceof Error ? error.name : typeof error,
      },
      'provider cancel could not be queued',
    );
  }
}

export async function startAttempt(
  deps: AttemptStartDeps,
  input: { readonly paymentId: string; readonly payerId: string; readonly idempotencyKey: string },
  log: AttemptLogger,
): Promise<AttemptResponse> {
  const claimed = await claim(deps, input);
  const now = deps.clock.now(); // after tx1: the instant of the create and of any resume decision
  const back = returnUrl(deps.webBaseUrl, input.paymentId);

  if (claimed.kind === 'replay') {
    const intent = claimed.intent;
    if (intent.status === 'CREATING') {
      throw new AppError('payment_in_progress', { resume: { redirectUrl: null, topUp: null } });
    }
    const failure = intent.akahuPaymentId === null ? createFailureOf(intent.closeReason) : null;
    if (failure !== null) throw failureError(failure);
    return { redirectUrl: resumeUrl(deps.crypto, 'payment_attempts', intent, now) ?? back };
  }

  if (claimed.kind === 'blocked') {
    const intent = claimed.intent;
    if (intent.status === 'HELD') throw new AppError('payment_on_hold');
    if (isExpiredAwaitingPayer(intent, now) && intent.akahuPaymentId !== null) {
      await requestCancel(deps, log, intent.akahuPaymentId, 'expired', intent.id);
    }
    throw new AppError('payment_in_progress', {
      resume: { redirectUrl: resumeUrl(deps.crypto, 'payment_attempts', intent, now), topUp: null },
    });
  }

  const started = await startProviderPayment(deps, {
    amount: claimed.amount,
    reference: claimed.reference,
    redirectUri: back,
    payee: claimed.payee,
    now,
  });

  if (started.kind !== 'created') {
    const reason = createFailureCloseReason(started);
    try {
      await closeAttemptAtCreate(deps.db, { id: claimed.id, reason, now });
    } catch (error) {
      log.warn(
        {
          event: 'billing.attempt.close_failed',
          attemptId: claimed.id,
          errorClass: error instanceof Error ? error.name : typeof error,
        },
        'attempt could not be closed after a failed create',
      );
    }
    log.warn(
      {
        event: 'billing.attempt.create_failed',
        attemptId: claimed.id,
        paymentId: input.paymentId,
        reason,
      },
      'payment attempt could not be started at the payment provider',
    );
    throw failureError(
      started.kind === 'unavailable' ? started : { kind: 'refused', reason: started.reason },
    );
  }

  let recorded = false;
  try {
    recorded = await openAttempt(deps.db, {
      id: claimed.id,
      akahuPaymentId: started.providerPaymentId,
      akahuStatus: started.providerStatus,
      akahuStatusReason: started.providerStatusReason,
      authorisationUrlEnc: sealAuthorisationUrl(
        deps.crypto,
        'payment_attempts',
        claimed.id,
        started.authorisationUrl,
      ),
      expiresAt: started.expiresAt,
    });
  } catch (error) {
    log.warn(
      {
        event: 'billing.attempt.record_failed',
        attemptId: claimed.id,
        errorClass: error instanceof Error ? error.name : typeof error,
      },
      'attempt could not be recorded after the provider created it',
    );
  }
  if (!recorded) {
    await requestCancel(deps, log, started.providerPaymentId, 'start_orphan', claimed.id);
    throw new AppError('payment_provider_unavailable');
  }

  log.info(
    { event: 'billing.attempt.started', attemptId: claimed.id, paymentId: input.paymentId },
    'payment attempt started',
  );
  return { redirectUrl: started.authorisationUrl };
}
