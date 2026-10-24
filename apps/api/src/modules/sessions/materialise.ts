/**
 * The series materialiser (session-scheduling-engine Phase 3; architecture SA-1, binding T-1..T-4). `materialiseRule` is one
 * `recurrence-rule` job: it reads the clock once, works out the window `[today, today + RECURRENCE_HORIZON_DAYS]` in NZ time,
 * and for each missing date runs ONE transaction (`materialise-instance.ts`). Then it retries the rule's banking-refused drafts,
 * stamps the rule's bookkeeping (`materialised_version`, D-82) and logs a summary.
 *
 * Re-runs create nothing (`ON CONFLICT (recurring_rule_id, date) DO NOTHING` under the rule lock), and a failing date never stops
 * the run: its transaction rolls back alone, it is logged with ids and an SQLSTATE only, and the run goes on. The caller (the job
 * handler) turns the collected failures into a retry or a permanent failure with `failureVerdict` (AC-ERROR-9).
 *
 * Auto-enrol follows each publish made here: for a new instance it runs inline, right after the instance transaction commits, in a
 * transaction of its own (T-2); a retried draft queues the `session-auto-enrol` job on its publish transaction. Either way the D-80
 * marker, stamped under the per-session advisory lock, keeps it once per session.
 */
import {
  instantToLocal,
  isoWeekStart,
  recurrenceDates,
  addLocalDays,
  type LocalDate,
} from '@sgm/shared';
import type { Clock } from '../../lib/clock.ts';
import type { Database } from '../../lib/db/kysely.ts';
import type { JobRunner } from '../../lib/jobs/jobs.ts';
import type { Logger } from '../../lib/logger/logger.ts';
import type { SessionAllocatorPort } from './allocator-port.ts';
import { runSessionAutoEnrol } from './auto-enrol.ts';
import { classifySessionError, type FailureClass } from './errors.ts';
import { lockRule } from './locks.ts';
import {
  listRetryableDrafts,
  materialiseDate,
  retryDraft,
  type InstanceDeps,
  type RuleRef,
} from './materialise-instance.ts';
import type { PayoutNoticeDeps } from './materialise-notice.ts';
import { recurrenceRuleOf } from './rule-template.ts';
import type { RecurrenceRulePayload } from './rule-jobs.ts';
import { JOB_POLICY, runSessionTransaction } from './tx.ts';

/** The horizon used when nothing configures one (`RECURRENCE_HORIZON_DAYS` defaults to the same 28). */
export const DEFAULT_RECURRENCE_HORIZON_DAYS = 28;

export interface MaterialiseDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly allocator: SessionAllocatorPort;
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  readonly notice: PayoutNoticeDeps;
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** `RECURRENCE_HORIZON_DAYS`: how many days past today the window reaches (inclusive). */
  readonly horizonDays: number;
}

export interface MaterialiseCounts {
  readonly created: number;
  readonly published: number;
  readonly savedAsDraft: number;
  readonly draftsRetried: number;
  readonly autoEnrolled: number;
  readonly failed: number;
}

export interface MaterialiseResult extends MaterialiseCounts {
  /** `skipped` when the rule is missing, inactive or ended: nothing was created. */
  readonly skipped: 'not_found' | 'inactive' | 'ended' | undefined;
  readonly windowStart: LocalDate;
  /** One entry per failed instance or draft, as classified for the retry decision. */
  readonly failures: readonly FailureClass[];
}

/** The inclusive NZ date window of a run: today through today plus the horizon. */
export function materialisationWindow(
  now: Date,
  horizonDays: number,
): { readonly from: LocalDate; readonly to: LocalDate } {
  const from = instantToLocal(now).date;
  return { from, to: addLocalDays(from, horizonDays) };
}

export type FailureVerdict = 'none' | 'retry' | 'permanent';

/**
 * What the job does after the loop (AC-ERROR-9): nothing, throw a plain error so pg-boss retries with backoff (any failure
 * was transient: lock timeout, deadlock, serialisation, connection class, or unknown), or throw a non-retryable error
 * (every failure was a constraint or data error that a retry repeats).
 */
export function failureVerdict(failures: readonly FailureClass[]): FailureVerdict {
  if (failures.length === 0) return 'none';
  return failures.some((failure) => failure.transient) ? 'retry' : 'permanent';
}

export async function materialiseRule(
  deps: MaterialiseDeps,
  input: RecurrenceRulePayload,
): Promise<MaterialiseResult> {
  const startedAt = performance.now();
  const { db, clock, log } = deps;
  const ref: RuleRef = { ruleId: input.ruleId, teamId: input.teamId };
  const ids = { teamId: input.teamId, ruleId: input.ruleId };
  const instanceDeps: InstanceDeps = {
    db,
    clock,
    jobs: deps.jobs,
    notice: deps.notice,
    log,
  };

  // The clock is read once per job; the window and the notice week come from this instant.
  const runNow = clock.now();
  const window = materialisationWindow(runNow, deps.horizonDays);
  const empty = {
    created: 0,
    published: 0,
    savedAsDraft: 0,
    draftsRetried: 0,
    autoEnrolled: 0,
    failed: 0,
    windowStart: window.from,
    failures: [] as FailureClass[],
  };

  const rule = await db
    .selectFrom('recurring_session_rules')
    .selectAll()
    .where('id', '=', input.ruleId)
    .where('team_id', '=', input.teamId)
    .executeTakeFirst();
  const skipped =
    rule === undefined
      ? 'not_found'
      : !rule.is_active
        ? 'inactive'
        : rule.recur_until !== null && rule.recur_until < window.from
          ? 'ended'
          : undefined;
  if (rule === undefined || skipped !== undefined) {
    log.info(
      { event: 'session.recurrence.rule_skipped', ...ids, reason: skipped },
      'recurrence rule skipped',
    );
    // An inactive or ended rule is still "processed", so the series page stops waiting for it.
    if (rule !== undefined) await stampBookkeeping(deps, ref, rule.version, clock.now());
    return { ...empty, skipped };
  }

  const counts = { created: 0, published: 0, savedAsDraft: 0, draftsRetried: 0, autoEnrolled: 0 };
  const failures: FailureClass[] = [];
  let stampVersion = rule.version;
  // Drafts saved by this very run were just gated, so the retry below leaves them for the next run.
  const createdThisRun = new Set<string>();
  const windowStart = isoWeekStart(window.from);

  const fail = (error: unknown, date: LocalDate): void => {
    const failure = classifySessionError(error);
    failures.push(failure);
    // Ids and codes only: never `code` as a field name (redaction) and never the message (it may echo row data).
    const fields = {
      event: 'session.recurrence.instance_failed',
      ...ids,
      date,
      sqlState: failure.sqlState,
      errorCode: failure.errorCode,
      transient: failure.transient,
    };
    if (failure.transient) log.warn(fields, 'series instance failed; the job will retry');
    else log.error(fields, 'series instance failed permanently');
  };

  const followUp = async (sessionId: string): Promise<void> => {
    try {
      const outcome = await runSessionAutoEnrol(
        { db, clock, allocator: deps.allocator, log },
        { teamId: input.teamId, sessionId },
      );
      if (outcome.kind === 'done' || outcome.kind === 'no_candidates') counts.autoEnrolled += 1;
    } catch {
      // `runSessionAutoEnrol` logged `session.auto_enrol.failed`; the marker stays pending and the sweep re-offers it.
    }
  };

  // 1. Missing dates, in date order, one transaction each.
  const wanted = recurrenceDates(recurrenceRuleOf(rule), window);
  const existing = new Set(
    (
      await db
        .selectFrom('game_sessions')
        .select('date')
        .where('recurring_rule_id', '=', input.ruleId)
        .where('date', '>=', window.from)
        .where('date', '<=', window.to)
        .execute()
    ).map((row) => row.date),
  );
  for (const date of wanted.filter((candidate) => !existing.has(candidate))) {
    try {
      const outcome = await materialiseDate(instanceDeps, ref, date, windowStart);
      if (outcome.kind === 'skipped') continue;
      stampVersion = Math.max(stampVersion, outcome.ruleVersion);
      counts.created += 1;
      createdThisRun.add(outcome.sessionId);
      const base = { ...ids, sessionId: outcome.sessionId, date };
      if (outcome.kind === 'published') {
        counts.published += 1;
        log.info(
          { event: 'session.recurrence.instance_created', ...base, status: 'PUBLISHED' },
          'series session created and published',
        );
        await followUp(outcome.sessionId);
      } else {
        counts.savedAsDraft += 1;
        log.info(
          { event: 'session.recurrence.instance_created', ...base, status: 'DRAFT' },
          'series session created as a draft',
        );
        log.info(
          { event: 'session.recurrence.publish_refused', ...base, reason: outcome.reason },
          'series session saved as a draft: no usable payout details',
        );
      }
    } catch (error) {
      fail(error, date);
    }
  }

  // 2. Draft retry (ADR 0016 point 6): unedited, future, banking-refused drafts publish once the gate allows.
  let drafts: Awaited<ReturnType<typeof listRetryableDrafts>> = [];
  try {
    drafts = await listRetryableDrafts(db, ref, { now: runNow, windowEnd: window.to });
  } catch (error) {
    fail(error, window.from);
  }
  for (const draft of drafts.filter((candidate) => !createdThisRun.has(candidate.id))) {
    try {
      const outcome = await retryDraft(instanceDeps, ref, draft, windowStart);
      if (outcome.kind === 'published') counts.draftsRetried += 1;
      else if (outcome.kind === 'refused') {
        log.info(
          {
            event: 'session.recurrence.publish_refused',
            ...ids,
            sessionId: draft.id,
            date: draft.date,
            reason: outcome.reason,
          },
          'series draft still cannot be published: no usable payout details',
        );
      }
    } catch (error) {
      fail(error, draft.date);
    }
  }

  // 3. Bookkeeping: the series page stops saying "adding sessions" once the run has covered the rule's version (D-82).
  // A run with a transient failure leaves it pending, because the retry will complete the work.
  if (failureVerdict(failures) !== 'retry') {
    await stampBookkeeping(deps, ref, stampVersion, clock.now());
  }

  const result: MaterialiseResult = {
    ...counts,
    failed: failures.length,
    skipped: undefined,
    windowStart: window.from,
    failures,
  };
  log.info(
    {
      event: 'session.recurrence.run_completed',
      ...ids,
      trigger: input.trigger,
      windowStart: window.from,
      created: counts.created,
      published: counts.published,
      savedAsDraft: counts.savedAsDraft,
      draftsRetried: counts.draftsRetried,
      autoEnrolled: counts.autoEnrolled,
      failed: failures.length,
      durationMs: Math.round(performance.now() - startedAt),
    },
    'series materialisation run completed',
  );
  return result;
}

/**
 * Stamps `materialised_version` (never backwards) and `materialised_at` under the rule lock. Both columns are excluded from the
 * version bump, so this never makes the rule look edited.
 */
async function stampBookkeeping(
  deps: Pick<MaterialiseDeps, 'db' | 'log'>,
  ref: RuleRef,
  version: number,
  at: Date,
): Promise<void> {
  await runSessionTransaction(
    deps.db,
    JOB_POLICY,
    async (trx) => {
      const locked = await lockRule(trx, ref);
      if (locked === undefined) return;
      if (locked.materialised_version !== null && locked.materialised_version >= version) return;
      await trx
        .updateTable('recurring_session_rules')
        .set({ materialised_version: version, materialised_at: at })
        .where('id', '=', ref.ruleId)
        .execute();
    },
    { path: 'materialiser_stamp', teamId: ref.teamId, log: deps.log },
  );
}
