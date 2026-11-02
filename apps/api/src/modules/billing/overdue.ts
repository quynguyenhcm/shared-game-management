/**
 * `daily-overdue` (algorithm doc I, ruling H1, CR-27; AC-HAPPY-8, AC-VERIFY-6): marks unpaid charges OVERDUE. This file is the ONLY
 * writer of `payments.status = 'OVERDUE'` (C-BIL-2; `boundaries.test.ts` greps for it).
 *
 * The clock is read ONCE at the start of a run. Candidates are PENDING payments with `due_date <= now`, in keyset pages of 200,
 * each joined to the payment's blocking attempt (CREATING, OPEN or HELD). The stored `due_date` is respected as it is, and a
 * payment of a payout-blocked team is not skipped (CR-27). The decision is made on FRESH state, not on the stored mirror:
 *
 *   no attempt, CREATING, or OPEN with Akahu still READY ... flip to OVERDUE (a link opened at 03:59 does not defer the debt)
 *   HELD ..................................................... skip, no re-read
 *   OPEN: re-read from Akahu OUTSIDE any transaction (4 at a time):
 *     AUTHORISED / SUBMITTED / SETTLEMENT_IN_PROGRESS ........ skip (the money is on its way)
 *     SENT, same amount ...................................... minimal apply: attempt APPLIED, payment PAID (no wallet, no email)
 *     SENT, other amount ..................................... attempt HELD (AMOUNT_MISMATCH), payment untouched
 *     INDETERMINATE .......................................... skip, untouched (the hold is Phase 4's)
 *     NOT_CHARGED ............................................ skip when the payer had authorised it (Phase 4's apply owns the
 *                                                              24 h grace), otherwise flip
 *     UNRECOGNISED, not found, unreachable, any throw ........ defer: untouched and logged, never flipped on stale data
 *
 * Phase 4's `applyAkahuResult` replaces the minimal PAID apply and adds the payment-received email.
 *
 * Writes. A flip batch is ONE transaction: the candidate rows are locked `FOR UPDATE SKIP LOCKED` (a payment someone else is
 * working on, for example a payer's result being applied, is left for the next run instead of waiting), then a guarded UPDATE
 * (`status = 'PENDING' AND due_date <= now AND` no HELD attempt) flips them, and one sealed overdue email per flipped payment is
 * enqueued in the same transaction (key `payment-overdue:<paymentId>`), so a re-run the same day changes and sends nothing. Lock
 * order is payments -> payment_attempts and never a wallet. Logs are written after COMMIT and carry counts and ids only.
 */
import { sql } from 'kysely';
import { eq, parseMoney, type Money } from '@sgm/shared';
import type { PaymentsGateway, ProviderPayment } from '../../lib/akahu/gateway.ts';
import type { Clock } from '../../lib/clock.ts';
import type { FieldCrypto } from '../../lib/crypto/crypto.ts';
import type { Database } from '../../lib/db/kysely.ts';
import type { JobRunner } from '../../lib/jobs/jobs.ts';
import type { Logger } from '../../lib/logger/logger.ts';
import { enqueueEmail } from '../../jobs/send-email.ts';
import { buildOverdueEmail } from './emails.ts';
import { countOverdueByUsers, readPaymentEmailFacts } from './repo.ts';

export const OVERDUE_PAGE_SIZE = 200;
/** How many payments are re-read from Akahu at a time (the same bound as the reconcile sweep). */
export const OVERDUE_READ_PARALLELISM = 4;
const LOCK_TIMEOUT_MS = 5000;

/** The Akahu statuses that mean the payer has authorised the payment at the bank. */
const AUTHORISED_MIRROR = new Set(['AUTHORISED', 'SUBMITTED', 'SETTLEMENT_IN_PROGRESS']);

/** The payment's blocking attempt as stored locally. */
export interface LocalAttempt {
  readonly status: 'CREATING' | 'OPEN' | 'HELD';
  readonly akahuPaymentId: string | null;
  /** The stored mirror of Akahu's status; possibly stale. */
  readonly akahuStatus: string | null;
}

/** A fresh Akahu read, or why there is none. */
export type OverdueRead = ProviderPayment | 'not_found' | 'unavailable';

export type OverdueDecision =
  | { readonly kind: 'flip' }
  | { readonly kind: 'apply_paid' }
  | { readonly kind: 'hold_mismatch' }
  | {
      readonly kind: 'skip';
      readonly reason: 'held' | 'in_flight' | 'indeterminate' | 'post_authorisation_failure';
    }
  | { readonly kind: 'defer'; readonly reason: 'unrecognised' | 'not_found' | 'unavailable' };

/** The pure decision table (algorithm T6, CR-27). `read` is only consulted for an OPEN attempt. */
export function decideOverdue(
  attempt: LocalAttempt | null,
  read: OverdueRead | null,
  paymentAmount: Money,
): OverdueDecision {
  if (attempt === null || attempt.status === 'CREATING') return { kind: 'flip' };
  if (attempt.status === 'HELD') return { kind: 'skip', reason: 'held' };
  if (read === null || read === 'unavailable') return { kind: 'defer', reason: 'unavailable' };
  if (read === 'not_found') return { kind: 'defer', reason: 'not_found' };
  const { outcome } = read;
  switch (outcome.kind) {
    case 'OPEN':
      return outcome.phase === 'AWAITING_PAYER'
        ? { kind: 'flip' }
        : { kind: 'skip', reason: 'in_flight' };
    case 'SUCCEEDED':
      return eq(read.amount, paymentAmount) ? { kind: 'apply_paid' } : { kind: 'hold_mismatch' };
    case 'INDETERMINATE':
      return { kind: 'skip', reason: 'indeterminate' };
    case 'NOT_CHARGED':
      return attempt.akahuStatus !== null && AUTHORISED_MIRROR.has(attempt.akahuStatus)
        ? { kind: 'skip', reason: 'post_authorisation_failure' }
        : { kind: 'flip' };
    case 'UNRECOGNISED':
      return { kind: 'defer', reason: 'unrecognised' };
  }
}

export interface DailyOverdueDeps {
  readonly db: Database;
  /** Re-reads attempts from Akahu; never called inside a transaction. */
  readonly gateway: Pick<PaymentsGateway, 'getPayment'>;
  /** The worker's runner: emails are enqueued INSIDE the flip transaction (P5). */
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  readonly clock: Clock;
  /** Seals the emails (they carry a link). */
  readonly crypto: FieldCrypto;
  /** `config.auth.webBaseUrl`: origin of the web app, no trailing slash. */
  readonly webBaseUrl: string;
  readonly log: Pick<Logger, 'info' | 'warn'>;
  /** Rows per candidate page; tests lower it to exercise the keyset loop. */
  readonly batchSize?: number;
}

export interface DailyOverdueResult {
  readonly scanned: number;
  readonly marked: number;
  readonly paid: number;
  readonly heldMismatch: number;
  readonly deferred: number;
  /** Skipped on purpose: held, in flight at the bank, indeterminate, failed after authorisation, or row contended. */
  readonly skipped: number;
}

interface Candidate {
  readonly paymentId: string;
  readonly amount: Money;
  readonly attemptId: string | null;
  readonly attempt: LocalAttempt | null;
}

/** Runs `work` over `items` with at most `limit` in flight, keeping the order of the results. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await work(item);
    }
  };
  await Promise.all(Array.from({ length: limit < items.length ? limit : items.length }, lane));
  return results;
}

async function readCandidates(
  db: Database,
  input: { readonly now: Date; readonly after: string | undefined; readonly size: number },
): Promise<Candidate[]> {
  let query = db
    .selectFrom('payments as p')
    .leftJoin('payment_attempts as a', (join) =>
      join.onRef('a.payment_id', '=', 'p.id').on('a.status', 'in', ['CREATING', 'OPEN', 'HELD']),
    )
    .select([
      'p.id',
      'p.amount',
      'a.id as attempt_id',
      'a.status as attempt_status',
      'a.akahu_payment_id',
      'a.akahu_status',
    ])
    .where('p.status', '=', 'PENDING')
    .where('p.due_date', '<=', input.now);
  if (input.after !== undefined) query = query.where('p.id', '>', input.after);
  const rows = await query.orderBy('p.id').limit(input.size).execute();
  return rows.map((row) => ({
    paymentId: row.id,
    amount: parseMoney(row.amount),
    attemptId: row.attempt_id,
    attempt:
      row.attempt_status === null ||
      (row.attempt_status !== 'CREATING' &&
        row.attempt_status !== 'OPEN' &&
        row.attempt_status !== 'HELD')
        ? null
        : {
            status: row.attempt_status,
            akahuPaymentId: row.akahu_payment_id,
            akahuStatus: row.akahu_status,
          },
  }));
}

/** Re-reads one attempt from Akahu; any failure, of any kind, is "unavailable" (nothing is concluded from it). */
async function readFromAkahu(
  gateway: Pick<PaymentsGateway, 'getPayment'>,
  providerPaymentId: string,
): Promise<OverdueRead> {
  try {
    return await gateway.getPayment(providerPaymentId);
  } catch {
    return 'unavailable';
  }
}

export async function runDailyOverdue(deps: DailyOverdueDeps): Promise<DailyOverdueResult> {
  const now = deps.clock.now(); // once, for the whole run
  const pageSize = deps.batchSize ?? OVERDUE_PAGE_SIZE;
  const totals = { scanned: 0, marked: 0, paid: 0, heldMismatch: 0, deferred: 0 };
  const skips = {
    held: 0,
    inFlight: 0,
    indeterminate: 0,
    postAuthorisationFailure: 0,
    contended: 0,
  };
  const deferrals: { paymentId: string; attemptId: string | null; reason: string }[] = [];

  /** The flip batch: lock what is free, flip what is still due and unheld, enqueue one email per flip. All in one transaction. */
  const flip = async (batch: readonly Candidate[]): Promise<number> => {
    const ids = batch.map((candidate) => candidate.paymentId);
    const flipped = await deps.db.transaction().execute(async (trx) => {
      await sql.raw(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`).execute(trx);
      const free = await trx
        .selectFrom('payments')
        .select('id')
        .where('id', 'in', ids)
        .where('status', '=', 'PENDING')
        .where('due_date', '<=', now)
        .orderBy('id')
        .forUpdate()
        .skipLocked()
        .execute();
      skips.contended += ids.length - free.length;
      if (free.length === 0) return [];
      const done = await trx
        .updateTable('payments')
        .set({ status: 'OVERDUE' })
        .where(
          'id',
          'in',
          free.map((row) => row.id),
        )
        .where('status', '=', 'PENDING')
        .where('due_date', '<=', now)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('payment_attempts as a')
                .select('a.id')
                .whereRef('a.payment_id', '=', 'payments.id')
                .where('a.status', '=', 'HELD'),
            ),
          ),
        )
        .returning(['id', 'user_id'])
        .execute();
      if (done.length === 0) return [];
      const facts = await readPaymentEmailFacts(
        trx,
        done.map((row) => row.id),
      );
      const overdueCounts = await countOverdueByUsers(
        trx,
        done.map((row) => row.user_id),
      );
      for (const row of [...done].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        const fact = facts.get(row.id);
        if (fact === undefined) continue;
        await enqueueEmail(
          deps.jobs,
          buildOverdueEmail({
            to: fact.email,
            firstName: fact.fullName.trim().split(/\s+/)[0] ?? 'there',
            teamName: fact.teamName,
            teamId: fact.teamId,
            location: fact.location,
            startsAt: fact.startsAt,
            webBaseUrl: deps.webBaseUrl,
            paymentId: row.id,
            amount: fact.amount,
            dueDate: fact.dueDate,
            overdueCount: overdueCounts.get(row.user_id) ?? 1,
          }),
          { trx, crypto: deps.crypto },
        );
      }
      return done;
    });
    return flipped.length;
  };

  /** Akahu says SENT for the exact amount: PAID in one transaction (payment, then its attempt). */
  const applyPaid = async (candidate: Candidate, read: ProviderPayment): Promise<boolean> =>
    deps.db.transaction().execute(async (trx) => {
      await sql.raw(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`).execute(trx);
      const payment = await trx
        .selectFrom('payments')
        .select('id')
        .where('id', '=', candidate.paymentId)
        .where('status', '=', 'PENDING')
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (payment === undefined || candidate.attemptId === null) {
        skips.contended += 1;
        return false;
      }
      const attempt = await trx
        .updateTable('payment_attempts')
        .set({
          status: 'APPLIED',
          akahu_status: read.providerStatus,
          akahu_status_reason: read.providerStatusReason,
          last_synced_at: now,
        })
        .where('id', '=', candidate.attemptId)
        .where('status', '=', 'OPEN')
        .returning('id')
        .executeTakeFirst();
      if (attempt === undefined) return false;
      await trx
        .updateTable('payments')
        .set({ status: 'PAID', paid_at: now })
        .where('id', '=', candidate.paymentId)
        .where('status', '=', 'PENDING')
        .execute();
      return true;
    });

  /** Akahu says SENT for another amount: the attempt is HELD for a human; the payment is not touched. */
  const holdMismatch = async (candidate: Candidate, read: ProviderPayment): Promise<boolean> =>
    deps.db.transaction().execute(async (trx) => {
      await sql.raw(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`).execute(trx);
      const payment = await trx
        .selectFrom('payments')
        .select('id')
        .where('id', '=', candidate.paymentId)
        .where('status', '=', 'PENDING')
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (payment === undefined || candidate.attemptId === null) {
        skips.contended += 1;
        return false;
      }
      const attempt = await trx
        .updateTable('payment_attempts')
        .set({
          status: 'HELD',
          hold_reason: 'AMOUNT_MISMATCH',
          held_at: now,
          akahu_status: read.providerStatus,
          akahu_status_reason: read.providerStatusReason,
          last_synced_at: now,
        })
        .where('id', '=', candidate.attemptId)
        .where('status', '=', 'OPEN')
        .returning('id')
        .executeTakeFirst();
      return attempt !== undefined;
    });

  let after: string | undefined;
  for (;;) {
    const page = await readCandidates(deps.db, { now, after, size: pageSize });
    if (page.length === 0) break;
    totals.scanned += page.length;

    // Re-reads happen here, between transactions: no database lock is held while Akahu answers.
    const reads = await mapBounded(page, OVERDUE_READ_PARALLELISM, (candidate) =>
      candidate.attempt?.status === 'OPEN' && candidate.attempt.akahuPaymentId !== null
        ? readFromAkahu(deps.gateway, candidate.attempt.akahuPaymentId)
        : Promise.resolve<OverdueRead | null>(null),
    );

    const toFlip: Candidate[] = [];
    for (const [index, candidate] of page.entries()) {
      const read = reads[index] ?? null;
      const decision = decideOverdue(candidate.attempt, read, candidate.amount);
      switch (decision.kind) {
        case 'flip':
          toFlip.push(candidate);
          break;
        case 'apply_paid':
          if (read !== null && typeof read === 'object' && (await applyPaid(candidate, read))) {
            totals.paid += 1;
          }
          break;
        case 'hold_mismatch':
          if (read !== null && typeof read === 'object' && (await holdMismatch(candidate, read))) {
            totals.heldMismatch += 1;
          }
          break;
        case 'skip':
          if (decision.reason === 'held') skips.held += 1;
          else if (decision.reason === 'in_flight') skips.inFlight += 1;
          else if (decision.reason === 'indeterminate') skips.indeterminate += 1;
          else skips.postAuthorisationFailure += 1;
          break;
        case 'defer':
          totals.deferred += 1;
          deferrals.push({
            paymentId: candidate.paymentId,
            attemptId: candidate.attemptId,
            reason: decision.reason,
          });
          break;
      }
    }
    if (toFlip.length > 0) totals.marked += await flip(toFlip);

    const last = page.at(-1);
    if (page.length < pageSize || last === undefined) break;
    after = last.paymentId;
  }

  // After COMMIT: a line never describes work that rolled back. Counts and ids only.
  for (const deferral of deferrals) {
    deps.log.warn(
      { event: 'billing.overdue.deferred', ...deferral },
      'overdue decision deferred: Akahu state unavailable',
    );
  }
  const skipped =
    skips.held +
    skips.inFlight +
    skips.indeterminate +
    skips.postAuthorisationFailure +
    skips.contended;
  if (skipped > 0) {
    deps.log.info({ event: 'billing.overdue.skipped', ...skips }, 'overdue run skipped payments');
  }
  if (totals.paid + totals.heldMismatch > 0) {
    deps.log.info(
      { event: 'billing.overdue.settled', paid: totals.paid, heldMismatch: totals.heldMismatch },
      'overdue run settled payments found paid at Akahu',
    );
  }
  deps.log.info(
    { event: 'billing.overdue.marked', count: totals.marked },
    'payments marked overdue',
  );
  return { ...totals, skipped };
}
