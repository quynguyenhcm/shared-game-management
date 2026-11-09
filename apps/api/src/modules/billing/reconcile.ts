/**
 * `akahu-reconcile` (wallet-and-akahu-billing Phase 4a; algorithm doc H, CR-12, CR-25; AC-ASYNC-3): the safety net under the
 * webhook. Every 15 minutes (and at worker boot):
 *
 *   1. CREATING intents older than `AKAHU_RECONCILE_ORPHAN_AGE_SECONDS` are CLOSED (`create_abandoned`): nobody was handed their
 *      URL, so closing them is safe (DR-005). This file is the only other writer of the intent tables besides the apply funnel.
 *   2. Candidates, at most 100 per run, least recently synced first, are re-read and applied through the single funnel
 *      (`syncAkahuPayment`, which reads Akahu OUTSIDE any transaction), 4 at a time:
 *        - OPEN intents older than `AKAHU_RECONCILE_MIN_AGE_SECONDS` whose last sync is at least that old (hourly once the intent
 *          is an hour old) - a missed webhook is applied within about min age + 15 minutes;
 *        - CR-25 finality polling: HELD intents and CLOSED intents that carry a provider id, hourly during the first day after the
 *          hold / close and daily after that, until `AKAHU_FINALITY_HORIZON_HOURS` after it. A late SENT then follows the B3 rule.
 *   3. A provider outage (`GatewayUnavailableError`, which includes 429) stops scheduling further reads; the run still completes.
 *   4. An intent still OPEN after `AKAHU_RECONCILE_STUCK_AFTER_SECONDS` is logged `akahu.reconcile.stuck` at warn (at most hourly,
 *      because of the backoff above).
 *
 * The sweep calls the funnel directly rather than enqueueing `akahu-sync` so it can bound its own parallelism and stop on an
 * outage; the funnel's row locks and guarded transitions make a concurrent `akahu-sync` for the same id harmless.
 */
import { sql } from 'kysely';
import { GatewayUnavailableError } from '../../lib/akahu/gateway.ts';
import type { PaymentsConfig } from '../../lib/akahu/config.ts';
import {
  syncAkahuPayment,
  type AkahuSyncDeps,
  type IntentKind,
  type SyncResult,
} from './apply-akahu-result.ts';

export const RECONCILE_BATCH = 100;
export const RECONCILE_PARALLELISM = 4;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type ReconcileSettings = Pick<
  PaymentsConfig,
  | 'reconcileOrphanAgeSeconds'
  | 'reconcileMinAgeSeconds'
  | 'reconcileStuckAfterSeconds'
  | 'finalityHorizonHours'
>;

export interface AkahuReconcileDeps extends AkahuSyncDeps {
  readonly settings: ReconcileSettings;
  /** Rows per run; tests lower it. */
  readonly batchSize?: number;
}

export interface AkahuReconcileResult {
  readonly closedCreating: number;
  readonly checked: number;
  readonly applied: number;
  readonly held: number;
  readonly unapplied: number;
  readonly closed: number;
  readonly notFound: number;
  readonly failed: number;
  readonly stuck: number;
  readonly stoppedEarly: boolean;
}

interface Candidate {
  readonly kind: IntentKind;
  readonly id: string;
  readonly akahuPaymentId: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly mirror: string | null;
}

const ago = (now: Date, ms: number): Date => new Date(now.getTime() - ms);

/** Whole seconds from `from` to `to` (integer division; no floating point in billing code). */
const secondsBetween = (from: Date, to: Date): number => {
  const ms = to.getTime() - from.getTime();
  return (ms - (ms % 1000)) / 1000;
};

async function closeStaleCreating(deps: AkahuReconcileDeps, now: Date): Promise<number> {
  const cut = ago(now, deps.settings.reconcileOrphanAgeSeconds * 1000);
  const closed = { close_reason: 'create_abandoned', closed_at: now, status: 'CLOSED' as const };
  const attempts = await deps.db
    .updateTable('payment_attempts')
    .set(closed)
    .where('status', '=', 'CREATING')
    .where('created_at', '<=', cut)
    .returning('id')
    .execute();
  const topUps = await deps.db
    .updateTable('wallet_top_ups')
    .set(closed)
    .where('status', '=', 'CREATING')
    .where('created_at', '<=', cut)
    .returning('id')
    .execute();
  return attempts.length + topUps.length;
}

async function readCandidates(deps: AkahuReconcileDeps, now: Date): Promise<Candidate[]> {
  const minAgeCut = ago(now, deps.settings.reconcileMinAgeSeconds * 1000);
  const hourAgo = ago(now, HOUR_MS);
  const dayAgo = ago(now, DAY_MS);
  const horizonCut = ago(now, deps.settings.finalityHorizonHours * HOUR_MS);
  const limit = deps.batchSize ?? RECONCILE_BATCH;
  const { rows } = await sql<{
    kind: IntentKind;
    id: string;
    akahu_payment_id: string;
    status: string;
    created_at: Date;
    akahu_status: string | null;
  }>`
    WITH intents AS (
      SELECT 'ATTEMPT' AS kind, id, akahu_payment_id, status::text AS status, created_at, last_synced_at, akahu_status,
             CASE status WHEN 'HELD' THEN held_at WHEN 'CLOSED' THEN closed_at END AS settled_at
        FROM payment_attempts
       WHERE status IN ('OPEN', 'HELD', 'CLOSED') AND akahu_payment_id IS NOT NULL
      UNION ALL
      SELECT 'TOP_UP' AS kind, id, akahu_payment_id, status::text AS status, created_at, last_synced_at, akahu_status,
             CASE status WHEN 'HELD' THEN held_at WHEN 'CLOSED' THEN closed_at END AS settled_at
        FROM wallet_top_ups
       WHERE status IN ('OPEN', 'HELD', 'CLOSED') AND akahu_payment_id IS NOT NULL
    )
    SELECT kind, id, akahu_payment_id, status, created_at, akahu_status
      FROM intents
     WHERE (status = 'OPEN'
            AND created_at <= ${minAgeCut}
            AND (last_synced_at IS NULL OR last_synced_at <= ${minAgeCut})
            AND (created_at > ${hourAgo} OR last_synced_at IS NULL OR last_synced_at <= ${hourAgo}))
        OR (status IN ('HELD', 'CLOSED')
            AND coalesce(settled_at, created_at) > ${horizonCut}
            AND (last_synced_at IS NULL
                 OR (coalesce(settled_at, created_at) > ${dayAgo} AND last_synced_at <= ${hourAgo})
                 OR last_synced_at <= ${dayAgo}))
     ORDER BY last_synced_at ASC NULLS FIRST, created_at, id
     LIMIT ${limit}`.execute(deps.db);
  return rows.map((row) => ({
    kind: row.kind,
    id: row.id,
    akahuPaymentId: row.akahu_payment_id,
    status: row.status,
    createdAt: row.created_at,
    mirror: row.akahu_status,
  }));
}

const stillOpen = (result: SyncResult): boolean =>
  result.outcome !== 'applied' ||
  result.decision.kind === 'NOOP' ||
  result.decision.kind === 'MIRROR' ||
  result.decision.kind === 'MIRROR_UNKNOWN';

export async function runAkahuReconcile(deps: AkahuReconcileDeps): Promise<AkahuReconcileResult> {
  const now = deps.clock.now(); // once, for the selection; the funnel reads its own clock after its locks
  const closedCreating = await closeStaleCreating(deps, now);
  const candidates = await readCandidates(deps, now);
  const stuckCut = ago(now, deps.settings.reconcileStuckAfterSeconds * 1000);
  const counts = {
    checked: 0,
    applied: 0,
    held: 0,
    unapplied: 0,
    closed: 0,
    notFound: 0,
    failed: 0,
    stuck: 0,
  };
  const stuckLines: Record<string, unknown>[] = [];
  let stopped = false;
  let next = 0;

  const lane = async (): Promise<void> => {
    for (;;) {
      if (stopped) return;
      const candidate = candidates[next];
      next += 1;
      if (candidate === undefined) return;
      let result: SyncResult;
      try {
        counts.checked += 1;
        result = await syncAkahuPayment(deps, {
          akahuPaymentId: candidate.akahuPaymentId,
          source: 'reconcile',
        });
      } catch (error) {
        if (error instanceof GatewayUnavailableError) {
          if (!stopped) {
            deps.log.warn(
              { event: 'akahu.reconcile.unavailable', reason: error.reason },
              'akahu unavailable: reconcile stops scheduling reads this run',
            );
          }
          stopped = true;
          return;
        }
        counts.failed += 1;
        deps.log.warn(
          {
            event: 'akahu.reconcile.read_failed',
            intentKind: candidate.kind,
            intentId: candidate.id,
            errorClass: error instanceof Error ? error.name : typeof error,
          },
          'reconcile could not apply an intent',
        );
        continue;
      }
      if (result.outcome === 'not_found') counts.notFound += 1;
      if (result.outcome === 'applied') {
        const kind = result.decision.kind;
        if (kind === 'APPLY') counts.applied += 1;
        else if (kind === 'HOLD') counts.held += 1;
        else if (kind === 'UNAPPLY') counts.unapplied += 1;
        else if (kind === 'CLOSE') counts.closed += 1;
      }
      if (candidate.status === 'OPEN' && candidate.createdAt <= stuckCut && stillOpen(result)) {
        counts.stuck += 1;
        stuckLines.push({
          event: 'akahu.reconcile.stuck',
          intentKind: candidate.kind,
          intentId: candidate.id,
          ageSeconds: secondsBetween(candidate.createdAt, now),
          akahuStatus: candidate.mirror,
        });
      }
    }
  };
  const lanes =
    candidates.length < RECONCILE_PARALLELISM ? candidates.length : RECONCILE_PARALLELISM;
  await Promise.all(Array.from({ length: lanes }, lane));

  for (const line of stuckLines) deps.log.warn(line, 'akahu intent still open');
  const result = { closedCreating, ...counts, stoppedEarly: stopped };
  deps.log.info({ event: 'akahu.reconcile.completed', ...result }, 'akahu reconcile run complete');
  return result;
}
