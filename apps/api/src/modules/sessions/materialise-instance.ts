/**
 * The two per-session transactions of the materialiser (architecture SA-1; binding T-1, T-2, T-4, T-18; ADR 0016 recurrence
 * contract). Each runs under `JOB_POLICY` and touches only its transaction, so a deadlock or lock timeout retries the whole of it.
 *
 * Prologue, in canonical lock order: `teams FOR KEY SHARE`, the rule `FOR NO KEY UPDATE` (new instance only), the publish gate
 * (BEFORE any `game_sessions` or `session_courts` lock or write), then the session. Publishing is always the guarded
 * `UPDATE … WHERE status = 'DRAFT'`, never `INSERT … 'PUBLISHED'`. A gate refusal leaves a DRAFT and claims the weekly notice.
 * The clock is read after the locks, and a date that has already started is not created.
 */
import type { Transaction } from 'kysely';
import { buildInstance, recurrenceDates, type LocalDate } from '@sgm/shared';
import { QUEUE_NAMES } from '../../jobs/registry.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Database } from '../../lib/db/kysely.ts';
import type { DB, GameSessions } from '../../lib/db/types.generated.ts';
import type { JobRunner } from '../../lib/jobs/jobs.ts';
import type { Logger } from '../../lib/logger/logger.ts';
import {
  checkTeamCanPublishPaidSession,
  type PublishGateRefusalReason,
} from '../team-banking/publish-gate.ts';
import { sessionAutoEnrolKey } from './auto-enrol.ts';
import { lockRule, lockSession, lockTeamKeyShare } from './locks.ts';
import { claimPayoutNotice, type PayoutNoticeDeps } from './materialise-notice.ts';
import * as repo from './repo.ts';
import {
  gateFeesOfPlan,
  gateFeesOfRow,
  instanceRow,
  readTemplateCourts,
  recurrenceRuleOf,
  templateOf,
} from './rule-template.ts';
import { JOB_POLICY, runSessionTransaction } from './tx.ts';
import type { Selectable } from 'kysely';

export interface InstanceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  readonly notice: PayoutNoticeDeps;
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export interface RuleRef {
  readonly ruleId: string;
  readonly teamId: string;
}

export type SkipReason = 'team_missing' | 'rule_changed' | 'started' | 'exists' | 'changed';

export type InstanceOutcome =
  | { readonly kind: 'skipped'; readonly reason: SkipReason }
  | {
      readonly kind: 'published';
      readonly sessionId: string;
      /** The rule version this instance was built from (read under the rule lock). */
      readonly ruleVersion: number;
    }
  | {
      readonly kind: 'draft';
      readonly sessionId: string;
      readonly reason: PublishGateRefusalReason;
      readonly ruleVersion: number;
    };

/**
 * One transaction for one missing date of a rule. Re-reads the rule under its lock (an edit or end between the job's plan and
 * now wins), builds the instance with the shared pure `buildInstance`, gates, inserts as DRAFT with `ON CONFLICT DO NOTHING`
 * and publishes by guarded UPDATE when the gate allows.
 */
export async function materialiseDate(
  deps: InstanceDeps,
  ref: RuleRef,
  date: LocalDate,
  windowStart: LocalDate,
): Promise<InstanceOutcome> {
  const { db, clock, log } = deps;
  return runSessionTransaction(
    db,
    JOB_POLICY,
    async (trx): Promise<InstanceOutcome> => {
      if (!(await lockTeamKeyShare(trx, ref.teamId)))
        return { kind: 'skipped', reason: 'team_missing' };
      const rule = await lockRule(trx, ref);
      if (rule === undefined || !rule.is_active) return { kind: 'skipped', reason: 'rule_changed' };
      // The locked rule is authoritative: skip a date it no longer generates (ended, shortened or re-planned meanwhile).
      if (recurrenceDates(recurrenceRuleOf(rule), { from: date, to: date }).length === 0) {
        return { kind: 'skipped', reason: 'rule_changed' };
      }

      const plan = buildInstance(templateOf(rule), await readTemplateCourts(trx, ref.ruleId), date);
      // ADR 0016 point 1: the gate (teams FOR KEY SHARE + is_payout_configured) precedes every game_sessions lock or write.
      const gate = await checkTeamCanPublishPaidSession(trx, {
        teamId: ref.teamId,
        pricingStructure: plan.pricingStructure,
        fees: gateFeesOfPlan(plan),
        log,
      });
      // The clock is read after the locks: a date whose start has passed is not created at all.
      if (plan.startsAt.getTime() <= clock.now().getTime()) {
        return { kind: 'skipped', reason: 'started' };
      }

      const sessionId = await insertInstance(trx, ref, plan);
      if (sessionId === undefined) return { kind: 'skipped', reason: 'exists' };
      await repo.insertCourts(
        trx,
        sessionId,
        plan.courts.map((court) => ({
          identifier: court.courtIdentifier,
          startTime: court.startTime,
          endTime: court.endTime,
        })),
      );

      if (gate.ok) {
        // The row is new and uncommitted, so nobody else can see it: no session lock is needed for the publish.
        if (!(await repo.publishDraft(trx, sessionId, {}))) {
          return { kind: 'skipped', reason: 'changed' };
        }
        return { kind: 'published', sessionId, ruleVersion: rule.version };
      }
      await claimPayoutNotice(trx, deps.notice, { ...ref, windowStart });
      return { kind: 'draft', sessionId, reason: gate.reason, ruleVersion: rule.version };
    },
    { path: 'materialiser', log },
  );
}

async function insertInstance(
  trx: Transaction<DB>,
  ref: RuleRef,
  plan: ReturnType<typeof buildInstance>,
): Promise<string | undefined> {
  const row = await trx
    .insertInto('game_sessions')
    .values(instanceRow(ref, plan))
    .onConflict((conflict) =>
      conflict
        .columns(['recurring_rule_id', 'date'])
        .where('recurring_rule_id', 'is not', null)
        .doNothing(),
    )
    .returning('id')
    .executeTakeFirst();
  return row?.id;
}

export type DraftRow = Pick<
  Selectable<GameSessions>,
  | 'id'
  | 'date'
  | 'version'
  | 'pricing_structure'
  | 'auto_enrol_required'
  | 'fee_flat'
  | 'fee_male'
  | 'fee_female'
  | 'fee_other'
  | 'fee_beginner'
  | 'fee_intermediate'
  | 'fee_advanced'
>;

export type RetryOutcome =
  | { readonly kind: 'published' }
  | { readonly kind: 'refused'; readonly reason: PublishGateRefusalReason }
  | { readonly kind: 'skipped'; readonly reason: SkipReason };

/** Unedited, future DRAFT instances of the rule inside the window: the candidates for a publish retry (ADR 0016 point 6). */
export function listRetryableDrafts(
  db: Database,
  ref: RuleRef,
  bounds: { readonly now: Date; readonly windowEnd: LocalDate },
): Promise<DraftRow[]> {
  return db
    .selectFrom('game_sessions')
    .select([
      'id',
      'date',
      'version',
      'pricing_structure',
      'auto_enrol_required',
      'fee_flat',
      'fee_male',
      'fee_female',
      'fee_other',
      'fee_beginner',
      'fee_intermediate',
      'fee_advanced',
    ])
    .where('team_id', '=', ref.teamId)
    .where('recurring_rule_id', '=', ref.ruleId)
    .where('status', '=', 'DRAFT')
    .where('is_instance_overridden', '=', false)
    .where('starts_at', '>', bounds.now)
    .where('date', '<=', bounds.windowEnd)
    .orderBy('date', 'asc')
    .orderBy('id', 'asc')
    .execute();
}

/**
 * Publishes one banking-refused draft through the gate. The caller read `seen` without a lock; here the gate runs first, then the
 * session is locked and must still be the version that was gated, still a DRAFT and still not edited by an admin. A refusal is
 * not an error: the draft stays, and the weekly notice is claimed (a no-op if this NZ week already has it).
 * The auto-enrol follow-up is queued on this transaction (T-2) and runs in its own transaction.
 */
export async function retryDraft(
  deps: InstanceDeps,
  ref: RuleRef,
  seen: DraftRow,
  windowStart: LocalDate,
): Promise<RetryOutcome> {
  const { db, clock, jobs, log } = deps;
  return runSessionTransaction(
    db,
    JOB_POLICY,
    async (trx): Promise<RetryOutcome> => {
      if (!(await lockTeamKeyShare(trx, ref.teamId)))
        return { kind: 'skipped', reason: 'team_missing' };
      // The rule may have been ended or shortened since the job listed its drafts: an edit or End that committed wins (T-1 order:
      // teams, then the rule, then the gate and the session). A draft the rule no longer generates is left for End series / the admin.
      const rule = await lockRule(trx, ref);
      if (
        rule === undefined ||
        !rule.is_active ||
        recurrenceDates(recurrenceRuleOf(rule), { from: seen.date, to: seen.date }).length === 0
      ) {
        return { kind: 'skipped', reason: 'rule_changed' };
      }
      const gate = await checkTeamCanPublishPaidSession(trx, {
        teamId: ref.teamId,
        pricingStructure: seen.pricing_structure,
        fees: gateFeesOfRow(seen),
        log,
      });
      if (!gate.ok) {
        await claimPayoutNotice(trx, deps.notice, { ...ref, windowStart });
        return { kind: 'refused', reason: gate.reason };
      }

      const locked = await lockSession(trx, { sessionId: seen.id, teamId: ref.teamId });
      if (
        locked === undefined ||
        locked.status !== 'DRAFT' ||
        locked.is_instance_overridden ||
        locked.version !== seen.version
      ) {
        return { kind: 'skipped', reason: 'changed' };
      }
      if (locked.starts_at === null || locked.starts_at.getTime() <= clock.now().getTime()) {
        return { kind: 'skipped', reason: 'started' };
      }
      if (!(await repo.publishDraft(trx, seen.id, {})))
        return { kind: 'skipped', reason: 'changed' };
      if (locked.auto_enrol_required) {
        await jobs.enqueue(
          QUEUE_NAMES.sessionAutoEnrol,
          { sessionId: seen.id, teamId: ref.teamId, trigger: 'publish' },
          { trx, singletonKey: sessionAutoEnrolKey(seen.id) },
        );
      }
      return { kind: 'published' };
    },
    { path: 'retry', log },
  );
}
