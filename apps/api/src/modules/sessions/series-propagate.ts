/**
 * The propagation half of the series use cases (session-scheduling-engine): what a series edit (T-5) or End series (T-6) does to
 * the dated sessions of the series. Pure move out of `series.ts`: the lock order and the transaction boundary are unchanged.
 * Every function here runs INSIDE the caller's `runSessionTransaction`, after the prologue of ARCH SA-2 (teams KEY SHARE, the
 * gate when needed, the rule lock, the actor re-check) and locks each target instance `FOR UPDATE` in `(date, id)` order, so
 * the clock the caller passes was read after the rule lock.
 */
import {
  instantToLocal,
  planEndSeries,
  planSeriesReconciliation,
  summariseReconciliation,
  type EndSeriesResponse,
  type ExistingInstance,
  type SeriesRule,
} from '@sgm/shared';
import type { Transaction } from 'kysely';
import type { DB } from '../../lib/db/types.generated.ts';
import { AppError } from '../../lib/http/errors.ts';
import { isPaidSession } from '../team-banking/publish-gate.ts';
import type { SessionAllocatorPort } from './allocator-port.ts';
import { publicCapacity, stampFor } from './content.ts';
import { lockSession, type LockedRule, type LockedSession } from './locks.ts';
import * as repo from './repo.ts';
import {
  gateFeesOfRow,
  instanceContentColumns,
  readTemplateCourts,
  recurrenceRuleOf,
  templateOf,
} from './rule-template.ts';
import type { SessionsContext } from './service.ts';
import * as seriesRepo from './series-repo.ts';
import { existingInstanceOf } from './series-view.ts';
import type { SessionRow } from './view.ts';

export const seriesRuleOf = (rule: LockedRule): SeriesRule => ({
  ...recurrenceRuleOf(rule),
  ...templateOf(rule),
});

/** Thrown inside the edit transaction when a locked published target needs the gate that was not run; the edit reruns gated. */
export class GateRequired extends Error {
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
export async function lockedInstances(
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

/**
 * Series edit: locks every future, unedited instance in `(date, id)` order, plans the reconciliation on the locked rows
 * (A3) and rewrites each instance that takes the change. Throws `GateRequired` when a locked PUBLISHED instance turns out to
 * need the publish gate that was not run (the caller reruns the whole edit gated). Returns the counts and the number of
 * waitlisted players the allocator promoted after a public-capacity raise (C-SSE-3).
 */
export async function propagateSeriesEdit(
  trx: Transaction<DB>,
  input: {
    /** The rule as just written. */
    readonly rule: LockedRule;
    readonly now: Date;
    readonly newPaid: boolean;
    /** True when the publish gate already ran in this transaction. */
    readonly gated: boolean;
    readonly allocator: SessionAllocatorPort;
    readonly log: SessionsContext['log'];
  },
): Promise<{ summary: ReturnType<typeof summariseReconciliation>; promoted: number }> {
  const { rule, now, newPaid, gated, allocator, log } = input;
  const ruleId = rule.id;
  const teamId = rule.team_id;
  const today = instantToLocal(now).date;
  const candidates = await seriesRepo.listInstances(trx, {
    ruleId,
    teamId,
    from: today,
    inclusive: true,
  });
  const { instances, locked } = await lockedInstances(trx, teamId, candidates, now, false);
  const plan = planSeriesReconciliation({
    rule: seriesRuleOf(rule),
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
        { trx, now, log },
        { teamId, sessionId: row.id },
      );
      promoted += seats.length;
    }
  }

  return { summary: summariseReconciliation(plan), promoted };
}

/**
 * End series: locks every instance after the last date, plans the end (A4) and deletes the unedited drafts after it and
 * cancels the published ones when asked (AC-HAPPY-9 cancel rules: registrations stay, nobody is emailed, the count is told).
 */
export async function propagateSeriesEnd(
  trx: Transaction<DB>,
  input: {
    readonly rule: LockedRule;
    readonly lastDate: Parameters<typeof planEndSeries>[0]['lastDate'];
    readonly alsoCancelPublished: boolean;
    readonly now: Date;
  },
): Promise<{
  plan: ReturnType<typeof planEndSeries>;
  removedDrafts: number;
  cancelledPublished: number;
  registered: number;
  kept: EndSeriesResponse['keptOffPattern'];
}> {
  const { rule, lastDate, alsoCancelPublished, now } = input;
  const ruleId = rule.id;
  const teamId = rule.team_id;
  const today = instantToLocal(now).date;
  const rows = await seriesRepo.listInstances(trx, {
    ruleId,
    teamId,
    from: lastDate,
    inclusive: false,
  });
  const { instances, locked } = await lockedInstances(trx, teamId, rows, now, true);
  const plan = planEndSeries({
    rule: seriesRuleOf(rule),
    lastDate,
    instances,
    today,
    now,
    alsoCancelPublished,
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
      registered += (await repo.countActiveRegistrations(trx, [row.id])).get(row.id) ?? 0;
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

  return { plan, removedDrafts, cancelledPublished, registered, kept };
}
