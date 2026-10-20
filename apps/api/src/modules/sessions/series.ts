/**
 * Series use cases (session-scheduling-engine Phase 3): create, read, edit with synchronous propagation (T-5, ARCH SA-9), End
 * series (T-6) and "Publish drafts now" (T-3). Decisions: binding reconciliation P-3 (fixed pattern), T-1 (lock order), T-5,
 * T-6, T-12; the recurrence algorithm's A3 target rules (`planSeriesReconciliation`) and A4 end rules (`planEndSeries`).
 *
 * Every write is one `runSessionTransaction` with the fixed prologue of ARCH SA-2, in the canonical lock order
 *   `teams FOR KEY SHARE` -> the publish gate (only when the change could make a PUBLISHED instance paid) -> the rule
 *   `FOR NO KEY UPDATE` -> the actor re-check `team_members FOR SHARE` -> each target instance `FOR UPDATE` in `(date, id)` order,
 * with the clock read after the locks. The per-rule `recurrence-rule` job is enqueued on the same transaction, so it exists only
 * when the change commits. The function touches only its transaction (a deadlock or lock timeout retries all of it); logging
 * happens after commit.
 */
import {
  SESSION_FIELD_MESSAGES,
  RecurrenceRuleError,
  assertRecurrenceRule,
  checkSeriesPatternFixed,
  instantToLocal,
  parseLocalTime,
  planEndSeries,
  planSeriesReconciliation,
  summariseReconciliation,
  type CreateSeriesRequest,
  type EndSeriesRequest,
  type EndSeriesResponse,
  type ExistingInstance,
  type LocalDate,
  type PublishDraftsResponse,
  type SeriesDetailResponse,
  type SeriesResponse,
  type SeriesRule,
  type SeriesSaveResponse,
  type UpdateSeriesRequest,
} from '@sgm/shared';
import type { Transaction } from 'kysely';
import { refusing } from '../../lib/auth/team-refusals.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Database } from '../../lib/db/kysely.ts';
import type { DB } from '../../lib/db/types.generated.ts';
import { AppError } from '../../lib/http/errors.ts';
import type { JobRunner } from '../../lib/jobs/jobs.ts';
import { isPaidSession } from '../team-banking/publish-gate.ts';
import type { SessionAllocatorPort } from './allocator-port.ts';
import {
  computeFeeColumns,
  publicCapacity,
  stampFor,
  trimTime,
  type FeeColumns,
  type StoredCourt,
} from './content.ts';
import { mapSessionDbError } from './errors.ts';
import { gateOrRefuse } from './gate-step.ts';
import {
  assertSessionAdmin,
  lockRule,
  lockSession,
  lockTeamKeyShare,
  type LockedRule,
  type LockedSession,
} from './locks.ts';
import * as repo from './repo.ts';
import { enqueueRuleMaterialisation } from './rule-jobs.ts';
import {
  gateFeesOfRow,
  instanceContentColumns,
  readTemplateCourts,
  recurrenceRuleOf,
  templateOf,
} from './rule-template.ts';
import type { SessionsContext } from './service.ts';
import * as seriesRepo from './series-repo.ts';
import {
  buildSeriesExtras,
  existingInstanceOf,
  toSeriesResponse,
  type RuleCourtRow,
} from './series-view.ts';
import { HTTP_POLICY, runSessionTransaction } from './tx.ts';
import type { SessionRow } from './view.ts';

const M = SESSION_FIELD_MESSAGES;

export interface SeriesServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  /** The seat allocator seam: promotion after a capacity raise on a published instance. */
  readonly allocator: SessionAllocatorPort;
}

export interface SeriesService {
  get(teamId: string, ruleId: string): Promise<SeriesDetailResponse>;
  create(
    teamId: string,
    actorId: string,
    input: CreateSeriesRequest,
    ctx: SessionsContext,
  ): Promise<{ readonly replayed: boolean; readonly response: SeriesDetailResponse }>;
  update(
    teamId: string,
    ruleId: string,
    actorId: string,
    input: UpdateSeriesRequest,
    ctx: SessionsContext,
  ): Promise<SeriesSaveResponse>;
  end(
    teamId: string,
    ruleId: string,
    actorId: string,
    input: EndSeriesRequest,
    ctx: SessionsContext,
  ): Promise<EndSeriesResponse>;
  publishDrafts(
    teamId: string,
    ruleId: string,
    actorId: string,
    ctx: SessionsContext,
  ): Promise<PublishDraftsResponse>;
}

// ---------------------------------------------------------------------------------------------
// Rule content helpers
// ---------------------------------------------------------------------------------------------

type SeriesContent = Pick<
  CreateSeriesRequest,
  'location' | 'address' | 'maxPlayers' | 'reservedSeats' | 'courts'
>;

/**
 * The content columns of a rule for one set of defaults. The editor's remembered bulk-fill values (`default_start_time`,
 * `default_end_time`, `default_court_count`) are the earliest start, the latest end and the number of template courts.
 */
function ruleValues(input: SeriesContent, fees: FeeColumns) {
  const starts = input.courts.map((court) => court.startTime).sort();
  const ends = input.courts.map((court) => court.endTime).sort();
  return {
    default_location: input.location,
    default_address: input.address,
    default_max_players: input.maxPlayers,
    default_reserved_seats: input.reservedSeats,
    default_total_court_cost: fees.totalCourtCost,
    default_extra_expenses: fees.extraExpenses,
    default_custom_player_rate: fees.customPlayerRate,
    pricing_structure: fees.pricingStructure,
    fee_flat: fees.feeFlat,
    fee_male: fees.feeMale,
    fee_female: fees.feeFemale,
    fee_other: fees.feeOther,
    fee_beginner: fees.feeBeginner,
    fee_intermediate: fees.feeIntermediate,
    fee_advanced: fees.feeAdvanced,
    default_start_time: starts[0] ?? parseLocalTime('00:00'),
    default_end_time: ends.at(-1) ?? parseLocalTime('00:00'),
    default_court_count: input.courts.length,
  };
}

const TIME_COLUMNS: ReadonlySet<string> = new Set(['default_start_time', 'default_end_time']);

/** True when the stored rule already holds exactly this content, recur-until and court template (the SA-6 no-op). */
function sameRuleContent(
  rule: LockedRule,
  values: ReturnType<typeof ruleValues>,
  recurUntil: LocalDate | null,
  courtsBefore: readonly RuleCourtRow[],
  courtsAfter: readonly StoredCourt[],
): boolean {
  if (rule.recur_until !== recurUntil) return false;
  for (const key of Object.keys(values) as (keyof typeof values)[]) {
    const before: unknown = rule[key];
    const after: unknown = values[key];
    const same = TIME_COLUMNS.has(key)
      ? trimTime(String(before)) === trimTime(String(after))
      : before === after;
    if (!same) return false;
  }
  const describe = (id: string, start: string, end: string): string =>
    `${id}|${trimTime(start)}|${trimTime(end)}`;
  return (
    courtsBefore.map((c) => describe(c.court_identifier, c.start_time, c.end_time)).join('\n') ===
    courtsAfter.map((c) => describe(c.identifier, c.startTime, c.endTime)).join('\n')
  );
}

const seriesRuleOf = (rule: LockedRule): SeriesRule => ({
  ...recurrenceRuleOf(rule),
  ...templateOf(rule),
});

const patternOf = (rule: LockedRule) => ({
  frequency: rule.frequency,
  dayOfWeek: rule.day_of_week,
  startsOn: rule.starts_on,
  monthlyWeek: rule.monthly_week,
  recurUntil: rule.recur_until,
});

const invalid = (fieldErrors: Record<string, string[]>): AppError =>
  new AppError('validation_failed', { fieldErrors });

/** Thrown inside the edit transaction when a locked published target needs the gate that was not run; the edit reruns gated. */
class GateRequired extends Error {
  constructor() {
    super('the publish gate is required for this series edit');
    this.name = 'GateRequired';
  }
}

/** A future, not-yet-started DRAFT or PUBLISHED instance: the only kind a series write can change. */
function isCandidate(row: SessionRow, now: Date, includeEdited: boolean): boolean {
  return (
    (row.status === 'DRAFT' || row.status === 'PUBLISHED') &&
    (includeEdited || !row.is_instance_overridden) &&
    (row.starts_at === null || row.starts_at.getTime() > now.getTime())
  );
}

/**
 * Locks every candidate `FOR UPDATE` in `(date, id)` order (the rows arrive in that order) and returns the instances as the
 * reconciliation reads them: locked rows where there is a lock, the unlocked read for the rest (edited, closed and started rows
 * cannot become changeable, so a stale read of them is harmless).
 */
async function lockedInstances(
  trx: Transaction<DB>,
  teamId: string,
  rows: readonly SessionRow[],
  now: Date,
  includeEdited: boolean,
): Promise<{ instances: ExistingInstance[]; locked: Map<string, LockedSession> }> {
  const locked = new Map<string, LockedSession>();
  for (const row of rows) {
    if (!isCandidate(row, now, includeEdited)) continue;
    const fresh = await lockSession(trx, { sessionId: row.id, teamId });
    if (fresh !== undefined) locked.set(row.id, fresh);
  }
  const current = rows.map((row) => locked.get(row.id) ?? row);
  const ids = current.map((row) => row.id);
  const [courts, counts] = await Promise.all([
    repo.listCourtsFor(trx, ids),
    repo.countActiveRegistrations(trx, ids),
  ]);
  return {
    locked,
    instances: current.map((row) =>
      existingInstanceOf(row, courts.get(row.id) ?? [], counts.get(row.id) ?? 0),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------

export function createSeriesService(deps: SeriesServiceDeps): SeriesService {
  const { db, clock, jobs, allocator } = deps;

  async function viewOf(reader: Database, rule: LockedRule): Promise<SeriesResponse> {
    const now = clock.now();
    const rows = await seriesRepo.listSeriesPageInstances(reader, {
      ruleId: rule.id,
      teamId: rule.team_id,
      today: instantToLocal(now).date,
    });
    const ids = rows.map((row) => row.id);
    const [templateCourts, courtsByRow, counts, draftCounts, isPayoutConfigured] =
      await Promise.all([
        seriesRepo.listRuleCourts(reader, rule.id),
        repo.listCourtsFor(reader, ids),
        repo.countActiveRegistrations(reader, ids),
        seriesRepo.countRuleDrafts(reader, { ruleId: rule.id, teamId: rule.team_id }),
        repo.readPayoutConfigured(reader, rule.team_id),
      ]);
    return toSeriesResponse(
      rule,
      templateCourts,
      buildSeriesExtras({
        rule,
        templateCourts,
        rows,
        courtsByRow,
        counts,
        draftCounts,
        isPayoutConfigured,
        now,
        today: instantToLocal(now).date,
      }),
    );
  }

  async function requireRule(
    reader: Database,
    teamId: string,
    ruleId: string,
  ): Promise<LockedRule> {
    const rule = await seriesRepo.findRule(reader, teamId, ruleId);
    if (rule === undefined) throw new AppError('not_found');
    return rule;
  }

  async function stale(
    reader: Database,
    rule: LockedRule,
    context: { actorId: string; expectedVersion: number; log: SessionsContext['log'] },
  ): Promise<AppError> {
    context.log.info(
      {
        event: 'session.stale_refused',
        teamId: rule.team_id,
        ruleId: rule.id,
        actorId: context.actorId,
        expectedVersion: context.expectedVersion,
        currentVersion: rule.version,
      },
      'stale series save refused',
    );
    return new AppError('series_stale', { current: await viewOf(reader, rule) });
  }

  /** Queues one run of the rule's materialiser on `trx`: it exists only if the series change commits. */
  const enqueueRun = (
    trx: Transaction<DB>,
    rule: Pick<LockedRule, 'id' | 'team_id'>,
    trigger: 'rule_created' | 'rule_updated' | 'rule_ended' | 'manual',
  ): Promise<string | null> =>
    enqueueRuleMaterialisation(jobs, { ruleId: rule.id, teamId: rule.team_id, trigger }, { trx });

  return {
    async get(teamId, ruleId) {
      return { series: await viewOf(db, await requireRule(db, teamId, ruleId)) };
    },

    create(teamId, actorId, input, ctx) {
      return refusing(ctx.log, { action: 'create_series', actorId, teamId }, async () => {
        const fees = computeFeeColumns(input, null);
        if (!fees.ok) throw invalid(fees.fieldErrors);

        let created: { id: string; replayed: boolean };
        try {
          created = await runSessionTransaction(
            db,
            HTTP_POLICY,
            async (trx) => {
              if (!(await lockTeamKeyShare(trx, teamId))) throw new AppError('forbidden');
              await assertSessionAdmin(trx, teamId, actorId);
              const id = await seriesRepo.insertRule(trx, {
                team_id: teamId,
                create_key: input.createKey,
                frequency: input.frequency,
                day_of_week: input.dayOfWeek,
                starts_on: input.startsOn,
                monthly_week: input.monthlyWeek,
                recur_until: input.recurUntil,
                is_active: true,
                ...ruleValues(input, fees.fees),
              });
              if (id === undefined) {
                const existing = await seriesRepo.findRuleByCreateKey(trx, teamId, input.createKey);
                if (existing === undefined) throw new AppError('conflict');
                return { id: existing.id, replayed: true };
              }
              await seriesRepo.insertRuleCourts(trx, id, input.courts);
              await enqueueRun(trx, { id, team_id: teamId }, 'rule_created');
              return { id, replayed: false };
            },
            { path: 'series_create', teamId, log: ctx.log },
          );
        } catch (error) {
          throw mapSessionDbError(error);
        }

        const rule = await requireRule(db, teamId, created.id);
        if (!created.replayed) {
          ctx.log.info(
            {
              event: 'session.series.created',
              teamId,
              ruleId: created.id,
              actorId,
              frequency: rule.frequency,
              // Never `version`: the logger's base `version` is the service version.
              ruleVersion: rule.version,
            },
            'series created',
          );
        }
        return { replayed: created.replayed, response: { series: await viewOf(db, rule) } };
      });
    },

    update(teamId, ruleId, actorId, input, ctx) {
      return refusing(ctx.log, { action: 'update_series', actorId, teamId }, async () => {
        const r0 = await requireRule(db, teamId, ruleId);
        if (!r0.is_active) throw new AppError('series_ended');

        // Request-only validation first: nothing here needs a lock.
        const fees = computeFeeColumns(input, {
          pricingStructure: r0.pricing_structure,
          feeOther: r0.fee_other,
        });
        const fieldErrors = {
          ...checkSeriesPatternFixed(patternOf(r0), input),
          ...(fees.ok ? {} : fees.fieldErrors),
        };
        if (!fees.ok || Object.keys(fieldErrors).length > 0) throw invalid(fieldErrors);
        const newFees = fees.fees;
        const newPaid = isPaidSession(newFees.pricingStructure, newFees);
        const values = ruleValues(input, newFees);

        const apply = async (trx: Transaction<DB>, forceGate: boolean) => {
          if (!(await lockTeamKeyShare(trx, teamId))) throw new AppError('forbidden');

          // The gate decision reads the instances WITHOUT a lock: it runs before every `game_sessions` lock (ADR 0016). A
          // PUBLISHED instance that turned out to need it after all makes the whole edit rerun gated (`GateRequired`).
          let gated = false;
          if (newPaid) {
            const published = await seriesRepo.listPublishedTargets(trx, {
              ruleId,
              teamId,
              now: clock.now(),
            });
            const reachesFree = published.some(
              (row) => !isPaidSession(row.pricing_structure, gateFeesOfRow(row)),
            );
            if (forceGate || reachesFree) {
              await gateOrRefuse(trx, {
                teamId,
                subject: { ruleId },
                actorId,
                fees: newFees,
                pricingStructure: newFees.pricingStructure,
                path: 'series_edit',
                log: ctx.log,
              });
              gated = true;
            }
          }

          const rule = await lockRule(trx, { ruleId, teamId });
          if (rule === undefined) throw new AppError('not_found');
          if (!rule.is_active) throw new AppError('series_ended');
          await assertSessionAdmin(trx, teamId, actorId);

          // The pattern was checked against an unlocked read: check the locked rule too (an End may have shortened it).
          const lockedErrors = checkSeriesPatternFixed(patternOf(rule), input);
          if (Object.keys(lockedErrors).length > 0) throw invalid(lockedErrors);

          const courtsBefore = await seriesRepo.listRuleCourts(trx, ruleId);
          if (sameRuleContent(rule, values, input.recurUntil, courtsBefore, input.courts)) {
            // SA-6: a save that would change nothing is a 200 with the current rule, whatever the version.
            return {
              series: await viewOf(trx, rule),
              outcome: summariseReconciliation([]),
              changed: false,
              promoted: 0,
            };
          }
          if (rule.version !== input.expectedVersion) {
            throw await stale(trx, rule, {
              actorId,
              expectedVersion: input.expectedVersion,
              log: ctx.log,
            });
          }

          const now = clock.now();
          const today = instantToLocal(now).date;
          await seriesRepo.replaceRuleCourts(trx, ruleId, input.courts);
          await seriesRepo.updateRule(trx, ruleId, {
            ...values,
            recur_until: input.recurUntil,
            updated_at: stampFor(now, rule),
          });
          const updatedRule = await requireRule(trx, teamId, ruleId);

          // Propagate: every candidate is locked in (date, id) order, then the plan is made on the locked rows.
          const candidates = await seriesRepo.listInstances(trx, {
            ruleId,
            teamId,
            from: today,
            inclusive: true,
          });
          const { instances, locked } = await lockedInstances(trx, teamId, candidates, now, false);
          const plan = planSeriesReconciliation({
            rule: seriesRuleOf(updatedRule),
            courts: await readTemplateCourts(trx, ruleId),
            instances,
            today,
            now,
          });

          let promoted = 0;
          for (const action of plan) {
            if (action.kind !== 'update') continue;
            const row = locked.get(action.sessionId);
            if (row === undefined) continue;
            if (
              row.status === 'PUBLISHED' &&
              newPaid &&
              !gated &&
              !isPaidSession(row.pricing_structure, gateFeesOfRow(row))
            ) {
              throw new GateRequired();
            }
            const courtsNow = await repo.listCourts(trx, row.id);
            // An unedited instance follows the default deadline; make sure the court rewrite cannot trip the CHECK.
            if (!row.deadline_is_default) {
              await repo.updateSession(trx, row.id, { deadline_is_default: true });
            }
            await repo.syncCourts(
              trx,
              row.id,
              courtsNow,
              action.target.courts.map((court) => ({
                identifier: court.courtIdentifier,
                startTime: court.startTime,
                endTime: court.endTime,
              })),
            );
            await repo.updateSession(trx, row.id, {
              ...instanceContentColumns(action.target),
              updated_at: stampFor(now, row),
            });
            // C-SSE-3: public capacity rose on a PUBLISHED instance: promote the waitlist once, in this transaction.
            if (
              row.status === 'PUBLISHED' &&
              publicCapacity(action.target) >
                publicCapacity({ maxPlayers: row.max_players, reservedSeats: row.reserved_seats })
            ) {
              const seats = await allocator.promoteWaitlist(
                { trx, now, log: ctx.log },
                { teamId, sessionId: row.id },
              );
              promoted += seats.length;
            }
          }

          await enqueueRun(trx, updatedRule, 'rule_updated');
          const summary = summariseReconciliation(plan);
          return {
            series: await viewOf(trx, updatedRule),
            outcome: {
              updated: summary.updated,
              unchanged: summary.unchanged,
              skipped: summary.skipped,
            },
            changed: true,
            promoted,
          };
        };

        let result: Awaited<ReturnType<typeof apply>>;
        try {
          try {
            result = await runSessionTransaction(db, HTTP_POLICY, (trx) => apply(trx, false), {
              path: 'series_edit',
              teamId,
              log: ctx.log,
            });
          } catch (error) {
            if (!(error instanceof GateRequired)) throw error;
            result = await runSessionTransaction(db, HTTP_POLICY, (trx) => apply(trx, true), {
              path: 'series_edit',
              teamId,
              log: ctx.log,
            });
          }
        } catch (error) {
          throw mapSessionDbError(error);
        }

        if (result.changed) {
          ctx.log.info(
            {
              event: 'session.series.updated',
              teamId,
              ruleId,
              actorId,
              ruleVersion: result.series.version,
              skippedEdited: result.outcome.skipped.edited,
              skippedStarted: result.outcome.skipped.started,
              skippedClosed: result.outcome.skipped.closed,
              skippedDeadlinePassed: result.outcome.skipped.deadlinePassed,
              skippedFeeLocked: result.outcome.skipped.feeLocked,
              updated: result.outcome.updated,
              unchanged: result.outcome.unchanged,
              promoted: result.promoted,
            },
            'series updated',
          );
        }
        return { series: result.series, outcome: result.outcome };
      });
    },

    end(teamId, ruleId, actorId, input, ctx) {
      return refusing(ctx.log, { action: 'end_series', actorId, teamId }, async () => {
        const r0 = await requireRule(db, teamId, ruleId);
        if (!r0.is_active) throw new AppError('series_ended');
        try {
          assertRecurrenceRule({ ...recurrenceRuleOf(r0), recurUntil: input.lastDate });
        } catch (error) {
          if (!(error instanceof RecurrenceRuleError)) throw error;
          throw invalid({ lastDate: [M.recurUntilBeforeStart] });
        }

        let result: EndSeriesResponse;
        try {
          result = await runSessionTransaction(
            db,
            HTTP_POLICY,
            async (trx) => {
              if (!(await lockTeamKeyShare(trx, teamId))) throw new AppError('forbidden');
              const rule = await lockRule(trx, { ruleId, teamId });
              if (rule === undefined) throw new AppError('not_found');
              await assertSessionAdmin(trx, teamId, actorId);
              if (!rule.is_active) throw new AppError('series_ended');
              if (rule.version !== input.expectedVersion) {
                throw await stale(trx, rule, {
                  actorId,
                  expectedVersion: input.expectedVersion,
                  log: ctx.log,
                });
              }

              const now = clock.now();
              const today = instantToLocal(now).date;
              const rows = await seriesRepo.listInstances(trx, {
                ruleId,
                teamId,
                from: input.lastDate,
                inclusive: false,
              });
              const { instances, locked } = await lockedInstances(trx, teamId, rows, now, true);
              const plan = planEndSeries({
                rule: seriesRuleOf(rule),
                lastDate: input.lastDate,
                instances,
                today,
                now,
                alsoCancelPublished: input.alsoCancelPublished,
              });

              let removedDrafts = 0;
              let cancelledPublished = 0;
              let registered = 0;
              const kept: EndSeriesResponse['keptOffPattern'] = [];
              for (const action of plan.actions) {
                const row = locked.get(action.sessionId);
                if (action.kind === 'keep_off_pattern') {
                  kept.push({
                    sessionId: action.sessionId,
                    date: action.date,
                    status: action.status,
                  });
                } else if (action.kind === 'delete' && row !== undefined) {
                  if (!(await seriesRepo.deleteDraft(trx, action.sessionId))) {
                    throw new AppError('session_state_conflict');
                  }
                  removedDrafts += 1;
                } else if (action.kind === 'cancel' && row !== undefined) {
                  // The cancel rules (AC-HAPPY-9): registrations are left as they are, nobody is emailed, the count is told.
                  registered +=
                    (await repo.countActiveRegistrations(trx, [row.id])).get(row.id) ?? 0;
                  if (
                    !(await repo.cancelFrom(trx, row.id, 'PUBLISHED', {
                      updated_at: stampFor(now, row),
                    }))
                  ) {
                    throw new AppError('session_state_conflict');
                  }
                  cancelledPublished += 1;
                }
              }

              await seriesRepo.updateRule(trx, ruleId, {
                recur_until: plan.recurUntil,
                is_active: plan.isActive,
                updated_at: stampFor(now, rule),
              });
              const ended = await requireRule(trx, teamId, ruleId);
              await enqueueRun(trx, ended, 'rule_ended');
              return {
                series: await viewOf(trx, ended),
                removedDrafts,
                cancelledPublished,
                keptOffPattern: kept,
                activeRegistrationCount: registered,
              };
            },
            { path: 'series_end', teamId, log: ctx.log },
          );
        } catch (error) {
          throw mapSessionDbError(error);
        }

        ctx.log.info(
          {
            event: 'session.series.ended',
            teamId,
            ruleId,
            actorId,
            ruleVersion: result.series.version,
            recurUntil: input.lastDate,
            removedDrafts: result.removedDrafts,
            cancelledPublished: result.cancelledPublished,
            keptOffPattern: result.keptOffPattern.length,
          },
          'series ended',
        );
        return result;
      });
    },

    publishDrafts(teamId, ruleId, actorId, ctx) {
      return refusing(ctx.log, { action: 'publish_series_drafts', actorId, teamId }, async () => {
        let result: { series: SeriesResponse; queued: boolean };
        try {
          result = await runSessionTransaction(
            db,
            HTTP_POLICY,
            async (trx) => {
              if (!(await lockTeamKeyShare(trx, teamId))) throw new AppError('forbidden');
              await assertSessionAdmin(trx, teamId, actorId);
              const rule = await requireRule(trx, teamId, ruleId);
              // An ended series publishes nothing more: say so instead of queueing a run that will skip it.
              if (!rule.is_active) throw new AppError('series_ended');
              // `stately`: null means a run for this rule is already queued, and it will read the latest rule.
              const jobId = await enqueueRun(trx, rule, 'manual');
              return { series: await viewOf(trx, rule), queued: jobId !== null };
            },
            { path: 'series_publish_drafts', teamId, log: ctx.log },
          );
        } catch (error) {
          throw mapSessionDbError(error);
        }
        ctx.log.info(
          {
            event: 'session.series.publish_drafts_requested',
            teamId,
            ruleId,
            actorId,
            queued: result.queued,
          },
          'publish drafts now requested',
        );
        return result;
      });
    },
  };
}
