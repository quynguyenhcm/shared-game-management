/**
 * The SINGLE apply funnel for Akahu results (wallet-and-akahu-billing Phase 4a; CR-2, CR-3, CR-4, CR-25, CR-27, B3; algorithm doc E).
 * Every change an Akahu result makes to a payment attempt, a wallet top-up, a payment's PAID state or a wallet credit goes
 * through `applyAkahuResult`; nothing else writes those effects (boundaries.test.ts). Callers:
 *
 *   - the `akahu-sync` job (webhook, return-page GETs and start paths only ENQUEUE it) via `syncAkahuPayment`;
 *   - the `akahu-reconcile` sweep (missed webhooks, CR-25 finality polling) via `syncAkahuPayment`;
 *   - `daily-overdue` (CR-27 step 2), with the read it already made;
 *   - a person resolving a held intent (`resolveHeldIntent`, CR-15/CR-26/H2, via `hold-resolution.ts`): the same transaction and
 *     effects, with a FORCED decision (`decideResolution`) in place of the provider's, so this file stays the only writer of
 *     HELD, APPLIED, UNAPPLIED and PAID.
 *
 * Shape: the provider is re-read OUTSIDE any transaction (`syncAkahuPayment`), then ONE transaction locks the rows in the CR-4
 * order (`wallet_top_ups -> player_credits` for a top-up; `payments -> payment_attempts` for an attempt), reads the clock once
 * after the locks, and runs the pure decision table `decideApply` on the locked, fresh local state:
 *
 *   SENT, amount ok, absorbable .... APPLIED: payment PAID (paid_at, akahu_payment_id) / top-up credited by exactly its amount
 *   SENT, amount ok, not absorbable  UNAPPLIED: OVER_CAP (top-up over the cap), DUPLICATE (payment already PAID), LATE (a CLOSED
 *                                    top-up that no longer fits); never partial credit, never PAID twice, no invented credit
 *   SENT, amount differs ........... OPEN -> HELD (AMOUNT_MISMATCH); CLOSED -> UNAPPLIED (AMOUNT_MISMATCH); HELD stays held
 *   INDETERMINATE .................. OPEN -> HELD (INDETERMINATE)
 *   NOT_CHARGED .................... OPEN -> CLOSED; payment stays payable. After authorisation (CR-27): a PENDING payment's due
 *                                    date becomes greatest(due_date, now + 24 h) in the same transaction (OVERDUE is not moved)
 *   OPEN (in flight) ............... mirror only, forward-only by rank READY < AUTHORISED < SUBMITTED < SETTLEMENT_IN_PROGRESS
 *   UNRECOGNISED ................... left OPEN, logged at warn
 *
 * Amount rules are enforced HERE, in code (the database does not): a top-up credit is the intent amount, and an attempt counts
 * only when Akahu's amount, the attempt amount and the payment amount all agree. Emails are enqueued inside the transaction with
 * keys from the cause and sealed (they carry links). Logs are written after COMMIT and carry ids and decisions only.
 */
import { sql, type Kysely, type Transaction, type Updateable } from 'kysely';
import { WALLET_CAP, add, eq, lte, parseMoney, toMoneyString, type Money } from '@sgm/shared';
import type { GatewayOutcome, PaymentsGateway, ProviderPayment } from '../../lib/akahu/gateway.ts';
import type { Clock } from '../../lib/clock.ts';
import type { FieldCrypto } from '../../lib/crypto/crypto.ts';
import type { Database } from '../../lib/db/kysely.ts';
import type { DB } from '../../lib/db/types.generated.ts';
import type { JobRunner, TransactionLike } from '../../lib/jobs/jobs.ts';
import type { Logger } from '../../lib/logger/logger.ts';
import type { EmailMessage } from '../../lib/notifications/notifier.ts';
import { enqueueEmail } from '../../jobs/send-email.ts';
import { QUEUE_NAMES } from '../../jobs/registry.ts';
import { applyMovement, ensureWallet, lockWallets } from '../wallet/ledger.ts';
import {
  buildExtraPaymentAdminEmail,
  buildExtraPaymentPlayerEmail,
  buildPaymentHeldEmail,
  buildPaymentNotCompletedEmail,
  buildPaymentReceivedEmail,
  buildTopUpHeldEmail,
  buildTopUpNotCompletedEmail,
  buildTopUpReceivedEmail,
  type ExtraPaymentReason,
} from './emails.ts';
import { listApprovedAdmins } from './engine-repo.ts';
import { readPaymentEmailFacts, readTopUpEmailFacts } from './repo.ts';

// ---------------------------------------------------------------------------------------------------------------------------------
// The pure decision table
// ---------------------------------------------------------------------------------------------------------------------------------

export type IntentKind = 'ATTEMPT' | 'TOP_UP';
export type IntentStatus = 'CREATING' | 'OPEN' | 'HELD' | 'APPLIED' | 'UNAPPLIED' | 'CLOSED';
export type HoldReason = 'INDETERMINATE' | 'AMOUNT_MISMATCH';
export type UnappliedReason = ExtraPaymentReason;

export interface ApplyFacts {
  readonly kind: IntentKind;
  /** The locked local intent state. */
  readonly status: IntentStatus;
  /** The stored mirror of Akahu's status (`akahu_status`). */
  readonly mirror: string | null;
  /** The fresh provider read. */
  readonly view: { readonly outcome: GatewayOutcome; readonly providerStatus: string };
  /** Akahu's amount equals the intent amount (and, for an attempt, the payment amount). */
  readonly amountMatches: boolean;
  /** Top-up: the locked balance plus the amount fits under the cap. Attempt: the payment is still PENDING or OVERDUE. */
  readonly absorbable: boolean;
}

export type ApplyDecision =
  | { readonly kind: 'NOOP'; readonly warn?: 'held_amount_mismatch' }
  | { readonly kind: 'MIRROR' }
  | { readonly kind: 'MIRROR_UNKNOWN' }
  | { readonly kind: 'CLOSE'; readonly afterAuthorisation: boolean }
  | { readonly kind: 'HOLD'; readonly reason: HoldReason }
  | { readonly kind: 'APPLY' }
  | { readonly kind: 'UNAPPLY'; readonly reason: UnappliedReason };

const RANK: Readonly<Record<string, number>> = {
  READY: 0,
  AUTHORISED: 1,
  SUBMITTED: 2,
  SETTLEMENT_IN_PROGRESS: 3,
};

/** Rank of a provider status for the forward-only OPEN mirror; unknown and missing rank lowest. */
export function mirrorRank(status: string | null): number {
  return status !== null && Object.hasOwn(RANK, status) ? (RANK[status] ?? -1) : -1;
}

/** The payer had authorised at the bank: the mirror reached AUTHORISED, or the bank itself FAILED it (only reachable after). */
const authorisedBefore = (facts: ApplyFacts): boolean =>
  mirrorRank(facts.mirror) >= (RANK.AUTHORISED ?? 1) || facts.view.providerStatus === 'FAILED';

export function decideApply(facts: ApplyFacts): ApplyDecision {
  const { status, view } = facts;
  if (status === 'APPLIED' || status === 'UNAPPLIED' || status === 'CREATING') {
    return { kind: 'NOOP' };
  }
  switch (view.outcome.kind) {
    case 'SUCCEEDED': {
      if (!facts.amountMatches) {
        if (status === 'OPEN') return { kind: 'HOLD', reason: 'AMOUNT_MISMATCH' };
        if (status === 'HELD') return { kind: 'NOOP', warn: 'held_amount_mismatch' };
        return { kind: 'UNAPPLY', reason: 'AMOUNT_MISMATCH' };
      }
      if (facts.absorbable) return { kind: 'APPLY' };
      if (facts.kind === 'ATTEMPT') return { kind: 'UNAPPLY', reason: 'DUPLICATE' };
      return { kind: 'UNAPPLY', reason: status === 'CLOSED' ? 'LATE' : 'OVER_CAP' };
    }
    case 'OPEN':
      return status === 'OPEN' && mirrorRank(view.providerStatus) > mirrorRank(facts.mirror)
        ? { kind: 'MIRROR' }
        : { kind: 'NOOP' };
    case 'NOT_CHARGED':
      return status === 'OPEN'
        ? { kind: 'CLOSE', afterAuthorisation: authorisedBefore(facts) }
        : { kind: 'NOOP' };
    case 'INDETERMINATE':
      return status === 'OPEN' ? { kind: 'HOLD', reason: 'INDETERMINATE' } : { kind: 'NOOP' };
    case 'UNRECOGNISED':
      return status === 'OPEN' ? { kind: 'MIRROR_UNKNOWN' } : { kind: 'NOOP' };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The pure resolution table (CR-15, CR-26): a person's verdict on a HELD intent, applied as a forced decision
// ---------------------------------------------------------------------------------------------------------------------------------

export type ResolutionOutcome = 'RECEIVED' | 'NOT_RECEIVED';
/** `payment_resolution_reason`. */
export type ResolutionReason =
  'RECEIVED' | 'AMOUNT_MISMATCH' | 'NOT_RECEIVED_INDETERMINATE' | 'NOT_RECEIVED_NOT_SENT';

export interface ResolutionFacts {
  readonly kind: IntentKind;
  /** The locked local intent state. */
  readonly status: IntentStatus;
  readonly holdReason: HoldReason | null;
  /** A resolution already on record (a replay, or someone else was first). */
  readonly storedResolution: ResolutionReason | null;
  readonly outcome: ResolutionOutcome;
  /** What the person saw arrive in the team's account; null when not given. */
  readonly observedAmount: Money | null;
  readonly intentAmount: Money;
  /** The fresh read was SENT for a different amount: RECEIVED then needs an observed amount too. */
  readonly freshAmountMismatch: boolean;
  /** The fresh read was still INDETERMINATE (otherwise NOT_RECEIVED records "not sent"). */
  readonly freshIndeterminate: boolean;
  /** As in `ApplyFacts`: the top-up fits under the cap / the payment is still PENDING or OVERDUE. */
  readonly absorbable: boolean;
}

export type ResolutionDecision =
  | { readonly kind: 'REPLAY' }
  | { readonly kind: 'NOT_HELD' }
  | { readonly kind: 'OBSERVED_AMOUNT_REQUIRED' }
  | {
      readonly kind: 'RESOLVE';
      readonly decision: ApplyDecision;
      readonly reason: ResolutionReason;
    };

const receivedClass = (reason: ResolutionReason): ResolutionOutcome =>
  reason === 'RECEIVED' || reason === 'AMOUNT_MISMATCH' ? 'RECEIVED' : 'NOT_RECEIVED';

export function decideResolution(facts: ResolutionFacts): ResolutionDecision {
  if (facts.storedResolution !== null) {
    return receivedClass(facts.storedResolution) === facts.outcome
      ? { kind: 'REPLAY' }
      : { kind: 'NOT_HELD' };
  }
  if (facts.status !== 'HELD') return { kind: 'NOT_HELD' };
  if (facts.outcome === 'NOT_RECEIVED') {
    // A release after a hold counts as "after authorisation": CR-27 grace and email 7 (with the after-hold line) follow.
    return {
      kind: 'RESOLVE',
      decision: { kind: 'CLOSE', afterAuthorisation: true },
      reason: facts.freshIndeterminate ? 'NOT_RECEIVED_INDETERMINATE' : 'NOT_RECEIVED_NOT_SENT',
    };
  }
  const observedRequired = facts.holdReason === 'AMOUNT_MISMATCH' || facts.freshAmountMismatch;
  if (observedRequired && facts.observedAmount === null)
    return { kind: 'OBSERVED_AMOUNT_REQUIRED' };
  if (facts.observedAmount !== null && !eq(facts.observedAmount, facts.intentAmount)) {
    // B3: recorded and notified, never settled as the full charge, never credited.
    return {
      kind: 'RESOLVE',
      decision: { kind: 'UNAPPLY', reason: 'AMOUNT_MISMATCH' },
      reason: 'AMOUNT_MISMATCH',
    };
  }
  if (facts.absorbable) return { kind: 'RESOLVE', decision: { kind: 'APPLY' }, reason: 'RECEIVED' };
  return {
    kind: 'RESOLVE',
    decision: { kind: 'UNAPPLY', reason: facts.kind === 'ATTEMPT' ? 'DUPLICATE' : 'OVER_CAP' },
    reason: 'RECEIVED',
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------------------------------------------

/** CR-27: a failure after authorisation gives the payer this long from now. */
export const POST_AUTHORISATION_GRACE_MS = 24 * 3_600_000;
const LOCK_TIMEOUT_MS = 5000;

/** Who asked for a re-read (logged; never trusted for state). */
export const SYNC_SOURCES = [
  'webhook',
  'reconcile',
  'return_page',
  'start',
  'cancel',
  'overdue',
  'hold_resolution',
] as const;
export type SyncSource = (typeof SYNC_SOURCES)[number];

/** Why a provider payment is being cancelled (logged). */
export const CANCEL_SOURCES = ['superseded', 'payout_block', 'start_orphan', 'expired'] as const;
export type CancelSource = (typeof CANCEL_SOURCES)[number];

/** Provider ids are interpolated into URLs and job keys: a conservative token shape (Akahu's and the fake's ids fit). */
export const PROVIDER_PAYMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface AkahuApplyDeps {
  readonly db: Database;
  /** Emails and follow-up cancels are enqueued INSIDE the apply transaction. */
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  readonly clock: Clock;
  /** Seals the emails (they carry links). */
  readonly crypto: FieldCrypto;
  /** `config.auth.webBaseUrl`: origin of the web app, no trailing slash. */
  readonly webBaseUrl: string;
  readonly log: Pick<Logger, 'info' | 'warn'>;
}

export interface AkahuSyncDeps extends AkahuApplyDeps {
  /** Re-read OUTSIDE any transaction. */
  readonly gateway: Pick<PaymentsGateway, 'getPayment'>;
}

export type ApplyResult =
  | { readonly outcome: 'unmatched' }
  | {
      readonly outcome: 'applied';
      readonly intentKind: IntentKind;
      readonly intentId: string;
      readonly decision: ApplyDecision;
      /** CR-27: the payment's due date was raised in this transaction. */
      readonly graced: boolean;
    };

export type SyncResult = ApplyResult | { readonly outcome: 'not_found' };

/** A person's verdict on a HELD intent, after the caller re-read Akahu outside any lock (`hold-resolution.ts`). */
export interface HoldResolutionInput {
  readonly ref: IntentRef;
  readonly actorUserId: string;
  readonly outcome: ResolutionOutcome;
  readonly observedAmount: Money | null;
  readonly freshAmountMismatch: boolean;
  readonly freshIndeterminate: boolean;
}

export type HoldResolutionResult =
  | {
      readonly outcome: 'resolved' | 'replayed';
      readonly intentStatus: IntentStatus;
      readonly resolutionReason: ResolutionReason;
      readonly resolvedAt: Date;
    }
  | { readonly outcome: 'not_held' }
  | { readonly outcome: 'observed_amount_required' };

export interface IntentRef {
  readonly kind: IntentKind;
  readonly id: string;
}

/** Correlates ONLY by a stored provider id (A4): attempts first, then top-ups. A plain read. */
export async function findIntentByProviderId(
  db: Kysely<DB>,
  akahuPaymentId: string,
): Promise<IntentRef | null> {
  const attempt = await db
    .selectFrom('payment_attempts')
    .select('id')
    .where('akahu_payment_id', '=', akahuPaymentId)
    .executeTakeFirst();
  if (attempt !== undefined) return { kind: 'ATTEMPT', id: attempt.id };
  const topUp = await db
    .selectFrom('wallet_top_ups')
    .select('id')
    .where('akahu_payment_id', '=', akahuPaymentId)
    .executeTakeFirst();
  return topUp === undefined ? null : { kind: 'TOP_UP', id: topUp.id };
}

/** Enqueues the one re-read job per provider payment (`stately`: one queued plus one active). Part 2's return pages use it too. */
export function enqueueAkahuSync(
  jobs: Pick<JobRunner, 'enqueue'>,
  input: { readonly akahuPaymentId: string; readonly source: SyncSource },
  options: { readonly trx?: TransactionLike } = {},
): Promise<string | null> {
  return jobs.enqueue(
    QUEUE_NAMES.akahuSync,
    { akahuPaymentId: input.akahuPaymentId, source: input.source },
    {
      singletonKey: `akahu-sync:${input.akahuPaymentId}`,
      ...(options.trx === undefined ? {} : { trx: options.trx }),
    },
  );
}

/** Enqueues a best-effort cancel of a provider payment (READY only at Akahu). Payout block and start orphans use it too. */
export function enqueueAkahuCancel(
  jobs: Pick<JobRunner, 'enqueue'>,
  input: { readonly akahuPaymentId: string; readonly source: CancelSource },
  options: { readonly trx?: TransactionLike } = {},
): Promise<string | null> {
  return jobs.enqueue(
    QUEUE_NAMES.akahuCancel,
    { akahuPaymentId: input.akahuPaymentId, source: input.source },
    {
      singletonKey: `akahu-cancel:${input.akahuPaymentId}`,
      ...(options.trx === undefined ? {} : { trx: options.trx }),
    },
  );
}

/**
 * The `akahu-sync` body: correlate by stored id, re-read Akahu OUTSIDE any transaction, then apply. A transient provider failure
 * (`GatewayUnavailableError`) propagates (the job retries; the reconcile sweep stops); an id Akahu does not know is logged and
 * left alone.
 */
export async function syncAkahuPayment(
  deps: AkahuSyncDeps,
  input: { readonly akahuPaymentId: string; readonly source: SyncSource },
): Promise<SyncResult> {
  const ref = await findIntentByProviderId(deps.db, input.akahuPaymentId);
  if (ref === null) {
    deps.log.info(
      { event: 'akahu.sync.unmatched', akahuPaymentId: input.akahuPaymentId, source: input.source },
      'no intent carries this provider payment id',
    );
    return { outcome: 'unmatched' };
  }
  const view = await deps.gateway.getPayment(input.akahuPaymentId);
  if (view === 'not_found' || view.providerPaymentId !== input.akahuPaymentId) {
    deps.log.warn(
      {
        event: 'akahu.sync.anomaly',
        reason: 'not_found',
        intentKind: ref.kind,
        intentId: ref.id,
        source: input.source,
      },
      'the provider does not know a payment we recorded',
    );
    return { outcome: 'not_found' };
  }
  return applyAkahuResult(deps, view, input.source);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The transaction
// ---------------------------------------------------------------------------------------------------------------------------------

type IntentTable = 'payment_attempts' | 'wallet_top_ups';

interface LockedIntent {
  readonly id: string;
  readonly status: IntentStatus;
  readonly amount: Money;
  readonly mirror: string | null;
  readonly akahuPaymentId: string | null;
  readonly closedAt: Date | null;
  readonly holdReason: HoldReason | null;
  readonly resolutionReason: ResolutionReason | null;
  readonly resolvedAt: Date | null;
}

interface LockedPayment {
  readonly id: string;
  readonly status: 'PENDING' | 'OVERDUE' | 'PAID' | 'FAILED';
  readonly amount: Money;
}

/** What moved the intent: a fresh provider read, or a person's resolution of a hold. */
type Trigger =
  | { readonly kind: 'provider'; readonly view: ProviderPayment }
  | { readonly kind: 'resolution'; readonly input: HoldResolutionInput };

/** The resolution columns written with a forced decision. */
interface ResolutionStamp {
  readonly reason: ResolutionReason;
  readonly actorUserId: string;
  readonly observedAmount: Money | null;
}

interface Effects {
  graced: boolean;
  /** Set by a resolution trigger: the answer for the route. */
  resolution?: HoldResolutionResult;
  /** Post-commit log lines. */
  readonly lines: { level: 'info' | 'warn'; fields: Record<string, unknown>; message: string }[];
}

const closeReasonOf = (view: ProviderPayment): string =>
  `akahu:${view.providerStatus}${view.providerStatusReason === null ? '' : `:${view.providerStatusReason}`}`.slice(
    0,
    64,
  );

/** `close_reason` of an intent a person released as not received (algorithm doc F). */
const OPS_CLOSE_REASON = 'ops_not_received';

const firstNameOf = (fullName: string): string => fullName.trim().split(/\s+/)[0] ?? 'there';

/**
 * Applies one fresh provider read to the intent that stored its id. Safe to run concurrently and repeatedly for the same id: the
 * row locks serialise the runs and every transition is guarded on the locked state, so exactly one run performs an APPLY.
 */
export async function applyAkahuResult(
  deps: AkahuApplyDeps,
  view: ProviderPayment,
  source: SyncSource,
): Promise<ApplyResult> {
  const ref = await findIntentByProviderId(deps.db, view.providerPaymentId);
  if (ref === null) return { outcome: 'unmatched' };
  const effects: Effects = { graced: false, lines: [] };
  const decision = await deps.db.transaction().execute(async (trx) => {
    await sql.raw(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`).execute(trx);
    const trigger: Trigger = { kind: 'provider', view };
    return ref.kind === 'ATTEMPT'
      ? applyToAttempt(trx, deps, ref.id, trigger, effects)
      : applyToTopUp(trx, deps, ref.id, trigger, effects);
  });
  // After COMMIT: a line never describes work that rolled back. Ids and decisions only.
  for (const line of effects.lines) deps.log[line.level](line.fields, line.message);
  deps.log.info(
    {
      event: 'akahu.sync.applied',
      intentKind: ref.kind,
      intentId: ref.id,
      decision: decision.kind,
      providerStatus: view.providerStatus,
      graced: effects.graced,
      source,
    },
    'akahu result applied',
  );
  return {
    outcome: 'applied',
    intentKind: ref.kind,
    intentId: ref.id,
    decision,
    graced: effects.graced,
  };
}

/**
 * A person's verdict on a HELD intent (CR-15, CR-26, H2), applied in the same transaction shape and with the same effects as a
 * provider result: the CR-4 locks, the clock read once after them, the guarded intent write, PAID / the wallet credit / the B3
 * notices / the CR-27 grace and the follow-up email. The caller has already re-read Akahu outside any lock and refused a definite
 * provider answer; this re-checks the locked state (`decideResolution`), so a hold the provider or another person settled in the
 * meantime is `not_held`, and a replay of the same outcome answers from the record.
 */
export async function resolveHeldIntent(
  deps: AkahuApplyDeps,
  input: HoldResolutionInput,
): Promise<HoldResolutionResult> {
  const effects: Effects = { graced: false, lines: [] };
  await deps.db.transaction().execute(async (trx) => {
    await sql.raw(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`).execute(trx);
    const trigger: Trigger = { kind: 'resolution', input };
    return input.ref.kind === 'ATTEMPT'
      ? applyToAttempt(trx, deps, input.ref.id, trigger, effects)
      : applyToTopUp(trx, deps, input.ref.id, trigger, effects);
  });
  for (const line of effects.lines) deps.log[line.level](line.fields, line.message);
  const result = effects.resolution ?? { outcome: 'not_held' };
  if (result.outcome === 'resolved') {
    deps.log.info(
      {
        event: 'billing.hold.resolved',
        intentKind: input.ref.kind,
        intentId: input.ref.id,
        outcome: input.outcome,
        resolutionReason: result.resolutionReason,
        intentStatus: result.intentStatus,
        actorId: input.actorUserId,
        graced: effects.graced,
      },
      'held intent resolved by a person',
    );
  }
  return result;
}

async function lockIntent(
  trx: Transaction<DB>,
  table: IntentTable,
  id: string,
): Promise<LockedIntent> {
  const row = await trx
    .selectFrom(table)
    .select([
      'id',
      'status',
      'amount',
      'akahu_status',
      'akahu_payment_id',
      'closed_at',
      'hold_reason',
      'resolution_reason',
      'resolved_at',
    ])
    .where('id', '=', id)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  return {
    id: row.id,
    status: row.status,
    amount: parseMoney(row.amount),
    mirror: row.akahu_status,
    akahuPaymentId: row.akahu_payment_id,
    closedAt: row.closed_at,
    holdReason: row.hold_reason,
    resolutionReason: row.resolution_reason,
    resolvedAt: row.resolved_at,
  };
}

/**
 * The decision for this trigger on the locked intent, or null when nothing is to be written (a stale provider id, or a resolution
 * that is a replay / not held / missing its observed amount, whose answer is left in `effects.resolution`).
 */
function decideFor(
  kind: IntentKind,
  intent: LockedIntent,
  trigger: Trigger,
  amounts: { readonly providerAmountMatches: boolean; readonly absorbable: boolean },
  effects: Effects,
): { decision: ApplyDecision; stamp: ResolutionStamp | null } | null {
  if (trigger.kind === 'provider') {
    if (intent.akahuPaymentId !== trigger.view.providerPaymentId) return null;
    return {
      decision: decideApply({
        kind,
        status: intent.status,
        mirror: intent.mirror,
        view: trigger.view,
        amountMatches: amounts.providerAmountMatches,
        absorbable: amounts.absorbable,
      }),
      stamp: null,
    };
  }
  const { input } = trigger;
  const verdict = decideResolution({
    kind,
    status: intent.status,
    holdReason: intent.holdReason,
    storedResolution: intent.resolutionReason,
    outcome: input.outcome,
    observedAmount: input.observedAmount,
    intentAmount: intent.amount,
    freshAmountMismatch: input.freshAmountMismatch,
    freshIndeterminate: input.freshIndeterminate,
    absorbable: amounts.absorbable,
  });
  switch (verdict.kind) {
    case 'REPLAY':
      effects.resolution =
        intent.resolutionReason !== null && intent.resolvedAt !== null
          ? {
              outcome: 'replayed',
              intentStatus: intent.status,
              resolutionReason: intent.resolutionReason,
              resolvedAt: intent.resolvedAt,
            }
          : { outcome: 'not_held' };
      return null;
    case 'NOT_HELD':
      effects.resolution = { outcome: 'not_held' };
      return null;
    case 'OBSERVED_AMOUNT_REQUIRED':
      effects.resolution = { outcome: 'observed_amount_required' };
      return null;
    case 'RESOLVE':
      return {
        decision: verdict.decision,
        stamp: {
          reason: verdict.reason,
          actorUserId: input.actorUserId,
          observedAmount: input.observedAmount,
        },
      };
  }
}

const STATUS_AFTER: Readonly<Partial<Record<ApplyDecision['kind'], IntentStatus>>> = {
  APPLY: 'APPLIED',
  UNAPPLY: 'UNAPPLIED',
  CLOSE: 'CLOSED',
};

/** Records the route's answer for a resolution that was written. */
function noteResolved(
  effects: Effects,
  decision: ApplyDecision,
  stamp: ResolutionStamp | null,
  now: Date,
): void {
  const intentStatus = STATUS_AFTER[decision.kind];
  if (stamp === null || intentStatus === undefined) return;
  effects.resolution = {
    outcome: 'resolved',
    intentStatus,
    resolutionReason: stamp.reason,
    resolvedAt: now,
  };
}

/** The intent-row values of a decision (both tables share these columns). */
function intentValues(
  intent: LockedIntent,
  decision: ApplyDecision,
  trigger: Trigger,
  now: Date,
  resolution: ResolutionStamp | null,
): Updateable<DB['payment_attempts']> & Updateable<DB['wallet_top_ups']> {
  if (resolution !== null) {
    // A person's verdict: the provider mirror is left as Akahu last reported it; who, when, why and what they saw are recorded.
    return {
      ...decisionValues(intent, decision, {}, now, OPS_CLOSE_REASON),
      resolution_reason: resolution.reason,
      resolved_by: resolution.actorUserId,
      resolved_at: now,
      observed_amount:
        resolution.observedAmount === null ? null : toMoneyString(resolution.observedAmount),
    };
  }
  const view = trigger.kind === 'provider' ? trigger.view : null;
  const stamp =
    view === null
      ? {}
      : {
          akahu_status: view.providerStatus,
          akahu_status_reason: view.providerStatusReason,
          last_synced_at: now,
        };
  if (decision.kind === 'NOOP' || decision.kind === 'MIRROR_UNKNOWN')
    return { last_synced_at: now };
  if (decision.kind === 'MIRROR') return stamp;
  return decisionValues(
    intent,
    decision,
    stamp,
    now,
    view === null ? OPS_CLOSE_REASON : closeReasonOf(view),
  );
}

/** The status columns of a settling decision, on top of `stamp`. */
function decisionValues(
  intent: LockedIntent,
  decision: ApplyDecision,
  stamp: Updateable<DB['payment_attempts']> & Updateable<DB['wallet_top_ups']>,
  now: Date,
  closeReason: string,
): Updateable<DB['payment_attempts']> & Updateable<DB['wallet_top_ups']> {
  switch (decision.kind) {
    case 'NOOP':
    case 'MIRROR_UNKNOWN':
    case 'MIRROR':
      return stamp;
    case 'CLOSE':
      return { ...stamp, status: 'CLOSED', close_reason: closeReason, closed_at: now };
    case 'HOLD':
      return { ...stamp, status: 'HELD', hold_reason: decision.reason, held_at: now };
    case 'APPLY':
      return { ...stamp, status: 'APPLIED', closed_at: intent.closedAt ?? now };
    case 'UNAPPLY':
      return {
        ...stamp,
        status: 'UNAPPLIED',
        unapplied_reason: decision.reason,
        closed_at: intent.closedAt ?? now,
      };
  }
}

/** The intent-row write of a decision, guarded on the locked status. Literal table names keep the single-writer grep honest. */
async function writeIntent(
  trx: Transaction<DB>,
  table: IntentTable,
  intent: LockedIntent,
  decision: ApplyDecision,
  trigger: Trigger,
  now: Date,
  resolution: ResolutionStamp | null,
): Promise<void> {
  const values = intentValues(intent, decision, trigger, now, resolution);
  if (table === 'payment_attempts') {
    await trx
      .updateTable('payment_attempts')
      .set(values)
      .where('id', '=', intent.id)
      .where('status', '=', intent.status)
      .execute();
  } else {
    await trx
      .updateTable('wallet_top_ups')
      .set(values)
      .where('id', '=', intent.id)
      .where('status', '=', intent.status)
      .execute();
  }
}

function heldLine(
  kind: IntentKind,
  intentId: string,
  decision: ApplyDecision,
  effects: Effects,
): void {
  if (decision.kind === 'HOLD') {
    effects.lines.push({
      level: 'warn',
      fields: { event: 'akahu.intent.held', intentKind: kind, intentId, reason: decision.reason },
      message: 'akahu intent held for review',
    });
  } else if (decision.kind === 'UNAPPLY') {
    effects.lines.push({
      level: 'warn',
      fields: {
        event: 'akahu.intent.unapplied',
        intentKind: kind,
        intentId,
        reason: decision.reason,
      },
      message: 'money received but not applied',
    });
  } else if (decision.kind === 'MIRROR_UNKNOWN') {
    effects.lines.push({
      level: 'warn',
      fields: { event: 'akahu.status.unknown', intentKind: kind, intentId },
      message: 'unrecognised akahu status: intent left open',
    });
  } else if (decision.kind === 'NOOP' && decision.warn !== undefined) {
    effects.lines.push({
      level: 'warn',
      fields: { event: 'akahu.intent.anomaly', intentKind: kind, intentId, reason: decision.warn },
      message: 'held intent re-read with a different amount',
    });
  }
}

async function sendAll(
  deps: AkahuApplyDeps,
  trx: Transaction<DB>,
  messages: readonly EmailMessage[],
): Promise<void> {
  for (const message of messages) {
    await enqueueEmail(deps.jobs, message, { trx, crypto: deps.crypto });
  }
}

/** B3 notices: the player and every approved admin of the payee team. */
async function extraPaymentNotices(
  deps: AkahuApplyDeps,
  trx: Transaction<DB>,
  input: {
    readonly intentId: string;
    readonly reason: UnappliedReason;
    readonly amount: Money;
    readonly player: { readonly email: string; readonly fullName: string };
    readonly teamId: string;
    readonly teamName: string;
    readonly location: string | null;
    readonly startsAt: Date | null;
  },
): Promise<void> {
  const shared = {
    intentId: input.intentId,
    amount: input.amount,
    reason: input.reason,
    location: input.location,
    startsAt: input.startsAt,
    teamName: input.teamName,
    teamId: input.teamId,
    webBaseUrl: deps.webBaseUrl,
  };
  const admins = await listApprovedAdmins(trx, input.teamId);
  await sendAll(deps, trx, [
    buildExtraPaymentPlayerEmail({
      ...shared,
      to: input.player.email,
      firstName: firstNameOf(input.player.fullName),
    }),
    ...admins.map((admin) =>
      buildExtraPaymentAdminEmail({
        ...shared,
        to: admin.email,
        adminFirstName: firstNameOf(admin.fullName),
        adminId: admin.userId,
        playerFullName: input.player.fullName,
      }),
    ),
  ]);
}

/** What Akahu reports as sent, or (for a person's resolution) what they saw arrive, else the intent amount. */
const receivedAmountOf = (trigger: Trigger, intent: LockedIntent): Money =>
  trigger.kind === 'provider'
    ? trigger.view.amount
    : (trigger.input.observedAmount ?? intent.amount);

async function applyToAttempt(
  trx: Transaction<DB>,
  deps: AkahuApplyDeps,
  attemptId: string,
  trigger: Trigger,
  effects: Effects,
): Promise<ApplyDecision> {
  // A plain read to find the payment, then the CR-4 order: payments before payment_attempts.
  const { payment_id: paymentId } = await trx
    .selectFrom('payment_attempts')
    .select('payment_id')
    .where('id', '=', attemptId)
    .executeTakeFirstOrThrow();
  const paymentRow = await trx
    .selectFrom('payments')
    .select(['id', 'status', 'amount'])
    .where('id', '=', paymentId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  const payment: LockedPayment = {
    id: paymentRow.id,
    status: paymentRow.status,
    amount: parseMoney(paymentRow.amount),
  };
  const intent = await lockIntent(trx, 'payment_attempts', attemptId);
  const now = deps.clock.now(); // once, after the locks

  const decided = decideFor(
    'ATTEMPT',
    intent,
    trigger,
    {
      // Akahu's amount, the attempt's and the payment's must all agree: an attempt never settles a payment for another amount.
      providerAmountMatches:
        trigger.kind === 'provider' &&
        eq(trigger.view.amount, intent.amount) &&
        eq(intent.amount, payment.amount),
      absorbable: payment.status === 'PENDING' || payment.status === 'OVERDUE',
    },
    effects,
  );
  if (decided === null) return { kind: 'NOOP' };
  const { decision, stamp } = decided;
  await writeIntent(trx, 'payment_attempts', intent, decision, trigger, now, stamp);
  heldLine('ATTEMPT', intent.id, decision, effects);

  const needsEmail =
    decision.kind === 'APPLY' ||
    decision.kind === 'HOLD' ||
    decision.kind === 'UNAPPLY' ||
    (decision.kind === 'CLOSE' && decision.afterAuthorisation);
  if (!needsEmail) {
    noteResolved(effects, decision, stamp, now);
    return decision;
  }

  let dueDate: Date | null = null;
  if (decision.kind === 'CLOSE' && payment.status === 'PENDING') {
    // CR-27 grace: never shortens (greatest), never touches an OVERDUE payment (guarded on PENDING).
    const graced = await trx
      .updateTable('payments')
      .set({
        due_date: sql<Date>`greatest(due_date, ${new Date(now.getTime() + POST_AUTHORISATION_GRACE_MS)}::timestamptz)`,
      })
      .where('id', '=', payment.id)
      .where('status', '=', 'PENDING')
      .returning('due_date')
      .executeTakeFirst();
    if (graced !== undefined) {
      effects.graced = true;
      dueDate = graced.due_date;
    }
  }
  if (decision.kind === 'APPLY' && intent.akahuPaymentId !== null) {
    // I2: the one guarded move to PAID, under the payment row lock.
    await trx
      .updateTable('payments')
      .set({ status: 'PAID', paid_at: now, akahu_payment_id: intent.akahuPaymentId })
      .where('id', '=', payment.id)
      .where('status', 'in', ['PENDING', 'OVERDUE'])
      .execute();
    // A late SENT on a CLOSED attempt can leave a newer attempt open: it is no longer needed, so cancel it (best effort).
    const superseded = await trx
      .selectFrom('payment_attempts')
      .select('akahu_payment_id')
      .where('payment_id', '=', payment.id)
      .where('id', '<>', intent.id)
      .where('status', '=', 'OPEN')
      .where('akahu_payment_id', 'is not', null)
      .execute();
    for (const row of superseded) {
      if (row.akahu_payment_id !== null) {
        await enqueueAkahuCancel(
          deps.jobs,
          { akahuPaymentId: row.akahu_payment_id, source: 'superseded' },
          { trx },
        );
      }
    }
    effects.lines.push({
      level: 'info',
      fields: { event: 'billing.payment.paid', paymentId: payment.id, attemptId: intent.id },
      message: 'payment paid by bank transfer',
    });
  }
  noteResolved(effects, decision, stamp, now);

  const fact = (await readPaymentEmailFacts(trx, [payment.id])).get(payment.id);
  if (fact === undefined) return decision;
  const session = {
    to: fact.email,
    firstName: firstNameOf(fact.fullName),
    teamName: fact.teamName,
    teamId: fact.teamId,
    location: fact.location,
    startsAt: fact.startsAt,
    webBaseUrl: deps.webBaseUrl,
  };
  switch (decision.kind) {
    case 'APPLY':
      await sendAll(deps, trx, [
        buildPaymentReceivedEmail({
          ...session,
          paymentId: payment.id,
          amount: payment.amount,
          paidAt: now,
          afterHold: intent.status === 'HELD',
        }),
      ]);
      break;
    case 'HOLD':
      await sendAll(deps, trx, [
        buildPaymentHeldEmail({
          ...session,
          attemptId: intent.id,
          paymentId: payment.id,
          amount: payment.amount,
          overdue: payment.status === 'OVERDUE',
        }),
      ]);
      break;
    case 'CLOSE':
      await sendAll(deps, trx, [
        buildPaymentNotCompletedEmail({
          ...session,
          attemptId: intent.id,
          paymentId: payment.id,
          amount: payment.amount,
          dueDate: dueDate ?? fact.dueDate,
          overdue: payment.status === 'OVERDUE',
          afterHold: trigger.kind === 'resolution',
        }),
      ]);
      break;
    case 'UNAPPLY':
      await extraPaymentNotices(deps, trx, {
        intentId: intent.id,
        reason: decision.reason,
        amount: receivedAmountOf(trigger, intent),
        player: { email: fact.email, fullName: fact.fullName },
        teamId: fact.teamId,
        teamName: fact.teamName,
        location: fact.location,
        startsAt: fact.startsAt,
      });
      break;
    default:
      break;
  }
  return decision;
}

async function applyToTopUp(
  trx: Transaction<DB>,
  deps: AkahuApplyDeps,
  topUpId: string,
  trigger: Trigger,
  effects: Effects,
): Promise<ApplyDecision> {
  // CR-4: wallet_top_ups, then player_credits.
  const owner = await trx
    .selectFrom('wallet_top_ups')
    .select(['user_id', 'team_id'])
    .where('id', '=', topUpId)
    .executeTakeFirstOrThrow();
  const intent = await lockIntent(trx, 'wallet_top_ups', topUpId);
  // The wallet is locked only when a credit is possible: a SENT on an intent that can still be credited, or a person's RECEIVED.
  const mayCredit =
    trigger.kind === 'provider'
      ? trigger.view.outcome.kind === 'SUCCEEDED' &&
        (intent.status === 'OPEN' || intent.status === 'HELD' || intent.status === 'CLOSED')
      : trigger.input.outcome === 'RECEIVED' &&
        intent.status === 'HELD' &&
        intent.resolutionReason === null;
  let balance: Money | null = null;
  if (mayCredit) {
    await ensureWallet(trx, { userId: owner.user_id, teamId: owner.team_id });
    const wallets = await lockWallets(trx, owner.team_id, [owner.user_id]);
    balance = wallets.get(owner.user_id)?.balance ?? null;
  }
  const now = deps.clock.now(); // once, after the locks

  const decided = decideFor(
    'TOP_UP',
    intent,
    trigger,
    {
      providerAmountMatches: trigger.kind === 'provider' && eq(trigger.view.amount, intent.amount),
      absorbable: balance !== null && lte(add(balance, intent.amount), WALLET_CAP),
    },
    effects,
  );
  if (decided === null) return { kind: 'NOOP' };
  const { decision, stamp } = decided;
  await writeIntent(trx, 'wallet_top_ups', intent, decision, trigger, now, stamp);
  heldLine('TOP_UP', intent.id, decision, effects);
  noteResolved(effects, decision, stamp, now);

  let newBalance: Money | null = null;
  if (decision.kind === 'APPLY' && intent.akahuPaymentId !== null) {
    // The credit is exactly the intent amount (never Akahu's figure, never partial); the ledger re-checks the range.
    const moved = await applyMovement(trx, {
      userId: owner.user_id,
      teamId: owner.team_id,
      type: 'TOPUP',
      amount: intent.amount,
      walletTopUpId: intent.id,
      akahuPaymentId: intent.akahuPaymentId,
    });
    newBalance = moved.resultingBalance;
    effects.lines.push({
      level: 'info',
      fields: { event: 'wallet.topup.credited', topUpId: intent.id },
      message: 'wallet top-up credited',
    });
  }

  const needsEmail =
    decision.kind === 'APPLY' ||
    decision.kind === 'HOLD' ||
    decision.kind === 'UNAPPLY' ||
    (decision.kind === 'CLOSE' && decision.afterAuthorisation);
  if (!needsEmail) return decision;
  const fact = await readTopUpEmailFacts(trx, intent.id);
  if (fact === undefined) return decision;
  const wallet = {
    to: fact.email,
    firstName: firstNameOf(fact.fullName),
    teamName: fact.teamName,
    teamId: fact.teamId,
    webBaseUrl: deps.webBaseUrl,
  };
  switch (decision.kind) {
    case 'APPLY':
      if (newBalance !== null) {
        await sendAll(deps, trx, [
          buildTopUpReceivedEmail({
            ...wallet,
            topUpId: intent.id,
            amount: intent.amount,
            balance: newBalance,
          }),
        ]);
      }
      break;
    case 'HOLD':
      await sendAll(deps, trx, [
        buildTopUpHeldEmail({ ...wallet, topUpId: intent.id, amount: intent.amount }),
      ]);
      break;
    case 'CLOSE':
      await sendAll(deps, trx, [
        buildTopUpNotCompletedEmail({
          ...wallet,
          topUpId: intent.id,
          amount: intent.amount,
          afterHold: trigger.kind === 'resolution',
        }),
      ]);
      break;
    case 'UNAPPLY':
      await extraPaymentNotices(deps, trx, {
        intentId: intent.id,
        reason: decision.reason,
        amount: receivedAmountOf(trigger, intent),
        player: { email: fact.email, fullName: fact.fullName },
        teamId: fact.teamId,
        teamName: fact.teamName,
        location: null,
        startsAt: null,
      });
      break;
    default:
      break;
  }
  return decision;
}
