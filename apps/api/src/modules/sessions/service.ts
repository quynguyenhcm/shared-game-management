/**
 * One-off session use cases (session-scheduling-engine Phase 2): create with replay, edit, publish, cancel, read and list.
 * Decisions: binding reconciliation T-5..T-12, architecture SA-2 (lock order), SA-3, SA-6 (optimistic concurrency) and
 * SA-7 (lifecycle), the recurrence algorithm's A5, conflict 6 and conflict 10.
 *
 * Every write is one `runSessionTransaction` whose prologue is fixed:
 *   1. `teams FOR KEY SHARE`, 2. the publish gate when the write could make a PUBLISHED paid session (before any
 *   `game_sessions` lock, ADR 0016), 3. the actor re-check `team_members FOR SHARE`, 4. `game_sessions FOR UPDATE`,
 *   5. the version and lifecycle decisions with the clock read AFTER the lock.
 * The whole function is retried on a deadlock or lock timeout, so it touches only the transaction: the auto-enrol job and the
 * allocator call go on the same transaction, and logging happens after commit.
 */
import type { FastifyBaseLogger } from 'fastify';
import {
  SESSION_FIELD_MESSAGES,
  feeRaised,
  instantToLocal,
  type CancelSessionResponse,
  type CreateSessionRequest,
  type DstOptionsEntry,
  type ListSessionsQuery,
  type LocalDate,
  type MoneyString,
  type SessionCommandRequest,
  type SessionDetailResponse,
  type SessionListResponse,
  type SessionResponse,
  type SessionWriteResponse,
  type UpdateSessionRequest,
} from '@sgm/shared';
import { QUEUE_NAMES } from '../../jobs/registry.ts';
import { refusing } from '../../lib/auth/team-refusals.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Database } from '../../lib/db/kysely.ts';
import { AppError } from '../../lib/http/errors.ts';
import type { JobRunner } from '../../lib/jobs/jobs.ts';
import { isPaidSession, type PublishGateFees } from '../team-banking/publish-gate.ts';
import type { SessionAllocatorPort } from './allocator-port.ts';
import { sessionAutoEnrolKey } from './auto-enrol.ts';
import {
  computeFeeColumns,
  contentChange,
  firstStartOn,
  publicCapacity,
  resolveSessionTimes,
  sessionFeesOf,
  sortCourts,
  stampFor,
  trimTime,
  type FeeColumns,
  type ResolvedDeadline,
  type SessionContent,
} from './content.ts';
import { mapSessionDbError } from './errors.ts';
import { gateOrRefuse } from './gate-step.ts';
import { assertSessionAdmin, lockSession, lockTeamKeyShare, type LockedSession } from './locks.ts';
import * as repo from './repo.ts';
import { decideSessionAction } from './transitions.ts';
import { HTTP_POLICY, runSessionTransaction } from './tx.ts';
import { toSessionResponse, type CourtRow, type SessionRow } from './view.ts';

const M = SESSION_FIELD_MESSAGES;
const ZERO = '0.00' as MoneyString;

/** The subset of the request logger the service uses (`request.log`, which carries the trace ids). */
export type SessionsLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

export interface SessionsContext {
  readonly log: SessionsLogger;
}

export interface SessionsServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  /** Job producer: the auto-enrol follow-up is enqueued through it on the publish transaction. */
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  /** The seat allocator seam (architecture SA-4): promotion after a capacity raise. */
  readonly allocator: SessionAllocatorPort;
}

export interface SessionsService {
  list(teamId: string, query: ListSessionsQuery): Promise<SessionListResponse>;
  get(teamId: string, sessionId: string): Promise<SessionDetailResponse>;
  create(
    teamId: string,
    actorId: string,
    input: CreateSessionRequest,
    ctx: SessionsContext,
  ): Promise<{ readonly replayed: boolean; readonly response: SessionWriteResponse }>;
  update(
    teamId: string,
    sessionId: string,
    actorId: string,
    input: UpdateSessionRequest,
    ctx: SessionsContext,
  ): Promise<SessionWriteResponse>;
  publish(
    teamId: string,
    sessionId: string,
    actorId: string,
    input: SessionCommandRequest,
    ctx: SessionsContext,
  ): Promise<SessionWriteResponse>;
  cancel(
    teamId: string,
    sessionId: string,
    actorId: string,
    input: SessionCommandRequest,
    ctx: SessionsContext,
  ): Promise<CancelSessionResponse>;
}

// ---------------------------------------------------------------------------------------------
// Row <-> content helpers
// ---------------------------------------------------------------------------------------------

const feeColumnsOf = (row: SessionRow): FeeColumns => ({
  totalCourtCost: row.total_court_cost ?? ZERO,
  extraExpenses: row.extra_expenses ?? ZERO,
  calculatedRatePerPlayer: row.calculated_rate_per_player ?? ZERO,
  customPlayerRate: row.custom_player_rate,
  pricingStructure: row.pricing_structure,
  feeFlat: row.fee_flat,
  feeMale: row.fee_male,
  feeFemale: row.fee_female,
  feeOther: row.fee_other,
  feeBeginner: row.fee_beginner,
  feeIntermediate: row.fee_intermediate,
  feeAdvanced: row.fee_advanced,
});

/** The flat rate a FLAT session charges: the same fallback chain publishing stamps into `fee_flat`. */
const effectiveFlatOf = (row: SessionRow): SessionRow['fee_flat'] =>
  row.pricing_structure === 'FLAT'
    ? (row.custom_player_rate ?? row.calculated_rate_per_player ?? row.fee_flat)
    : row.fee_flat;

const gateFeesOf = (row: SessionRow): PublishGateFees => ({
  feeFlat: effectiveFlatOf(row),
  feeMale: row.fee_male,
  feeFemale: row.fee_female,
  feeOther: row.fee_other,
  feeBeginner: row.fee_beginner,
  feeIntermediate: row.fee_intermediate,
  feeAdvanced: row.fee_advanced,
});

function contentOf(row: SessionRow, courts: readonly CourtRow[]): SessionContent {
  return {
    date: row.date,
    location: row.location,
    address: row.address,
    maxPlayers: row.max_players,
    reservedSeats: row.reserved_seats,
    fees: feeColumnsOf(row),
    deadline: { isDefault: row.deadline_is_default, instant: row.cancellation_deadline },
    courts: sortCourts(
      courts.map((court) => ({
        identifier: court.court_identifier,
        startTime: trimTime(court.start_time),
        endTime: trimTime(court.end_time),
      })),
    ),
  };
}

/** The writable columns for one set of content (the row's identity, status and version are never in it). */
function columnValues(input: {
  readonly date: LocalDate;
  readonly location: string;
  readonly address: string;
  readonly maxPlayers: number;
  readonly reservedSeats: number;
  readonly fees: FeeColumns;
  readonly deadline: ResolvedDeadline;
}) {
  const { fees } = input;
  return {
    date: input.date,
    location: input.location,
    address: input.address,
    max_players: input.maxPlayers,
    reserved_seats: input.reservedSeats,
    total_court_cost: fees.totalCourtCost,
    extra_expenses: fees.extraExpenses,
    calculated_rate_per_player: fees.calculatedRatePerPlayer,
    custom_player_rate: fees.customPlayerRate,
    pricing_structure: fees.pricingStructure,
    fee_flat: fees.feeFlat,
    fee_male: fees.feeMale,
    fee_female: fees.feeFemale,
    fee_other: fees.feeOther,
    fee_beginner: fees.feeBeginner,
    fee_intermediate: fees.feeIntermediate,
    fee_advanced: fees.feeAdvanced,
    cancellation_deadline: input.deadline.instant,
    deadline_is_default: input.deadline.kind === 'default',
  };
}

function invalid(
  fieldErrors: Record<string, string[]>,
  dstOptions: readonly DstOptionsEntry[] = [],
): AppError {
  return new AppError('validation_failed', {
    fieldErrors,
    ...(dstOptions.length === 0 ? {} : { dstOptions }),
  });
}

/** What a publish needs that a draft may lack (C-SSE-1, C-SSE-2): a court, and every fee its pricing model reads. */
function publishErrors(row: SessionRow): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  if (row.starts_at === null) errors.courts = [M.courtsRequired];
  const missing = (field: string, value: unknown): void => {
    if (value === null) errors[field] = [M.amountFormat];
  };
  if (row.pricing_structure === 'FLAT') {
    missing('feeFlat', row.custom_player_rate ?? row.calculated_rate_per_player ?? row.fee_flat);
  } else if (row.pricing_structure === 'BY_SEX') {
    missing('feeMale', row.fee_male);
    missing('feeFemale', row.fee_female);
    missing('feeOther', row.fee_other);
  } else {
    missing('feeBeginner', row.fee_beginner);
    missing('feeIntermediate', row.fee_intermediate);
    missing('feeAdvanced', row.fee_advanced);
  }
  return errors;
}

/**
 * Writes the new content of a locked session. The courts are rewritten first, then the row, in an order that can never
 * put an explicit deadline after the start in between (the `deadline <= starts_at` CHECK is not deferrable): a stored
 * explicit deadline is parked on the default (recomputed by the database at every court write) unless it is provably at
 * or before every intermediate start. The row is written last, once, with `updated_at` stamped explicitly so a court-only
 * edit still bumps the version; a series date that really changed is marked edited (the flag never rides on no-ops).
 */
async function rewriteSession(
  trx: Database,
  locked: LockedSession,
  courtsBefore: readonly CourtRow[],
  before: SessionContent,
  after: SessionContent,
  changed: readonly string[],
  now: Date,
  deadline: ResolvedDeadline,
): Promise<void> {
  const courtsMoved = changed.includes('courts');
  const dateMoved = changed.includes('date');
  if ((courtsMoved || dateMoved) && !before.deadline.isDefault) {
    const oldFirst = firstStartOn(before.date as LocalDate, before.courts);
    const newFirst = firstStartOn(before.date as LocalDate, after.courts);
    const floor =
      oldFirst === undefined || newFirst === undefined
        ? undefined
        : new Date(Math.min(oldFirst.getTime(), newFirst.getTime()));
    if (floor === undefined || before.deadline.instant.getTime() > floor.getTime()) {
      await repo.updateSession(trx, locked.id, { deadline_is_default: true });
    }
  }
  if (courtsMoved) await repo.syncCourts(trx, locked.id, courtsBefore, after.courts);
  await repo.updateSession(trx, locked.id, {
    ...columnValues({
      date: after.date as LocalDate,
      location: after.location,
      address: after.address,
      maxPlayers: after.maxPlayers,
      reservedSeats: after.reservedSeats,
      fees: after.fees,
      deadline,
    }),
    updated_at: stampFor(now, locked),
    ...(locked.recurring_rule_id === null ? {} : { is_instance_overridden: true }),
  });
}

// ---------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------

export function createSessionsService(deps: SessionsServiceDeps): SessionsService {
  const { db, clock, jobs, allocator } = deps;

  /** The admin view of `row`, read through `reader` (the pool, or the writer's own transaction). */
  async function viewOf(reader: Database, row: SessionRow, now: Date): Promise<SessionResponse> {
    const [courts, counts, names] = await Promise.all([
      repo.listCourts(reader, row.id),
      repo.countActiveRegistrations(reader, [row.id]),
      repo.listRuleNames(
        reader,
        row.team_id,
        row.recurring_rule_id === null ? [] : [row.recurring_rule_id],
      ),
    ]);
    return toSessionResponse(row, courts, {
      now,
      activeRegistrationCount: counts.get(row.id) ?? 0,
      seriesName:
        row.recurring_rule_id === null ? null : (names.get(row.recurring_rule_id) ?? null),
    });
  }

  /**
   * Why a team-scoped read or lock found no session (AC-ERROR-8, human ruling 2026-10-24): a session that exists under another
   * team is 403 `forbidden` (the same body as every other refusal, naming nothing of that row), an id that exists nowhere is
   * 404 `not_found`. The check is a plain SELECT, never a lock, and runs only on the failure path, so it adds nothing to
   * LOCK_ORDER wherever it is called (before the transaction, or inside it after the locks it already holds).
   */
  async function missingSession(reader: Database, sessionId: string): Promise<AppError> {
    return new AppError((await repo.sessionExists(reader, sessionId)) ? 'forbidden' : 'not_found');
  }

  async function requireRow(
    reader: Database,
    teamId: string,
    sessionId: string,
  ): Promise<SessionRow> {
    const row = await repo.findSession(reader, teamId, sessionId);
    if (row === undefined) throw await missingSession(reader, sessionId);
    return row;
  }

  /** 409 `session_stale` carrying the latest row, so the editor refreshes without another request. */
  async function stale(
    reader: Database,
    row: SessionRow,
    context: { actorId: string; expectedVersion: number; now: Date; log: SessionsLogger },
  ): Promise<AppError> {
    context.log.info(
      {
        event: 'session.stale_refused',
        teamId: row.team_id,
        sessionId: row.id,
        actorId: context.actorId,
        expectedVersion: context.expectedVersion,
        currentVersion: row.version,
      },
      'stale session save refused',
    );
    return new AppError('session_stale', { current: await viewOf(reader, row, context.now) });
  }

  return {
    async list(teamId, query) {
      const now = clock.now();
      const [page, isPayoutConfigured, bankingDrafts] = await Promise.all([
        repo.listSessionsPage(db, {
          teamId,
          view: query.view,
          now,
          limit: query.limit,
          cursor: query.cursor,
        }),
        repo.readPayoutConfigured(db, teamId),
        repo.countBankingDrafts(db, teamId),
      ]);
      const ids = page.rows.map((row) => row.id);
      const ruleIds = [
        ...new Set(
          page.rows.flatMap((row) =>
            row.recurring_rule_id === null ? [] : [row.recurring_rule_id],
          ),
        ),
      ];
      const [courts, counts, names] = await Promise.all([
        repo.listCourtsFor(db, ids),
        repo.countActiveRegistrations(db, ids),
        repo.listRuleNames(db, teamId, ruleIds),
      ]);
      return {
        sessions: page.rows.map((row) =>
          toSessionResponse(row, courts.get(row.id) ?? [], {
            now,
            activeRegistrationCount: counts.get(row.id) ?? 0,
            seriesName:
              row.recurring_rule_id === null ? null : (names.get(row.recurring_rule_id) ?? null),
          }),
        ),
        nextCursor: page.nextCursor,
        isPayoutConfigured,
        bankingDrafts,
      };
    },

    async get(teamId, sessionId) {
      const row = await requireRow(db, teamId, sessionId);
      return { session: await viewOf(db, row, clock.now()) };
    },

    create(teamId, actorId, input, ctx) {
      return refusing(ctx.log, { action: 'create_session', actorId, teamId }, async () => {
        const now = clock.now();
        const today = instantToLocal(now).date;
        const times = resolveSessionTimes({
          date: input.date,
          courts: input.courts,
          cancellationDeadline: input.cancellationDeadline,
        });
        const fees = computeFeeColumns(input, null);
        const fieldErrors: Record<string, string[]> = {
          ...(input.date < today ? { date: [M.datePast] } : {}),
          ...(times.ok ? {} : times.fieldErrors),
          ...(fees.ok ? {} : fees.fieldErrors),
        };
        if (!times.ok || !fees.ok || Object.keys(fieldErrors).length > 0) {
          throw invalid(fieldErrors, times.ok ? [] : times.dstOptions);
        }

        let created: { id: string; replayed: boolean };
        try {
          created = await runSessionTransaction(
            db,
            HTTP_POLICY,
            async (trx) => {
              if (!(await lockTeamKeyShare(trx, teamId))) throw new AppError('forbidden');
              await assertSessionAdmin(trx, teamId, actorId);
              const id = await repo.insertSession(trx, {
                team_id: teamId,
                create_key: input.createKey,
                status: 'DRAFT',
                ...columnValues({
                  date: input.date,
                  location: input.location,
                  address: input.address,
                  maxPlayers: input.maxPlayers,
                  reservedSeats: input.reservedSeats,
                  fees: fees.fees,
                  deadline: times.deadline,
                }),
              });
              if (id === undefined) {
                const existing = await repo.findSessionByCreateKey(trx, teamId, input.createKey);
                if (existing === undefined) throw new AppError('conflict');
                return { id: existing.id, replayed: true };
              }
              await repo.insertCourts(trx, id, times.courts);
              return { id, replayed: false };
            },
            { path: 'create', teamId, log: ctx.log },
          );
        } catch (error) {
          throw mapSessionDbError(error);
        }

        const row = await requireRow(db, teamId, created.id);
        const session = await viewOf(db, row, now);
        if (!created.replayed) {
          ctx.log.info(
            {
              event: 'session.created',
              teamId,
              sessionId: created.id,
              actorId,
              // Never `version`: the logger's base `version` is the service version.
              sessionVersion: row.version,
              changed: [],
              promoted: 0,
            },
            'session created',
          );
        }
        return { replayed: created.replayed, response: { session, promoted: 0, material: false } };
      });
    },

    update(teamId, sessionId, actorId, input, ctx) {
      return refusing(ctx.log, { action: 'update_session', actorId, teamId }, async () => {
        const now0 = clock.now();
        const s0 = await requireRow(db, teamId, sessionId);

        // Request-only validation first: nothing here needs a lock.
        const today = instantToLocal(now0).date;
        const times = resolveSessionTimes({
          date: input.date,
          courts: input.courts,
          cancellationDeadline: input.cancellationDeadline,
        });
        const fees = computeFeeColumns(input, {
          pricingStructure: s0.pricing_structure,
          feeOther: s0.fee_other,
        });
        const dateMoved = input.date !== s0.date;
        const fieldErrors: Record<string, string[]> = {
          ...(dateMoved && s0.recurring_rule_id !== null ? { date: [M.datePatternFixed] } : {}),
          ...(dateMoved && s0.recurring_rule_id === null && input.date < today
            ? { date: [M.datePast] }
            : {}),
          ...(times.ok ? {} : times.fieldErrors),
          ...(fees.ok ? {} : fees.fieldErrors),
        };
        if (!times.ok || !fees.ok || Object.keys(fieldErrors).length > 0) {
          throw invalid(fieldErrors, times.ok ? [] : times.dstOptions);
        }

        // The gate decision uses the unlocked read; the locked version must still equal it, or the save is stale.
        const needsGate =
          s0.status === 'PUBLISHED' &&
          isPaidSession(fees.fees.pricingStructure, fees.fees) &&
          !isPaidSession(s0.pricing_structure, gateFeesOf(s0));

        const after: SessionContent = {
          date: input.date,
          location: input.location,
          address: input.address,
          maxPlayers: input.maxPlayers,
          reservedSeats: input.reservedSeats,
          fees: fees.fees,
          deadline: {
            isDefault: times.deadline.kind === 'default',
            instant: times.deadline.instant,
          },
          courts: times.courts,
        };

        let result: {
          session: SessionResponse;
          promoted: number;
          material: boolean;
          changed: string[];
        };
        try {
          result = await runSessionTransaction(
            db,
            HTTP_POLICY,
            async (trx) => {
              if (!(await lockTeamKeyShare(trx, teamId))) throw new AppError('forbidden');
              if (needsGate) {
                await gateOrRefuse(trx, {
                  teamId,
                  subject: { sessionId },
                  actorId,
                  fees: fees.fees,
                  pricingStructure: fees.fees.pricingStructure,
                  path: 'edit',
                  log: ctx.log,
                });
              }
              await assertSessionAdmin(trx, teamId, actorId);
              const locked = await lockSession(trx, { sessionId, teamId });
              if (locked === undefined) throw await missingSession(trx, sessionId);
              const staleContext = {
                actorId,
                expectedVersion: input.expectedVersion,
                log: ctx.log,
              };
              // Changed since the unlocked read the gate decision rested on: let the admin look again.
              if (locked.version !== s0.version) {
                throw await stale(trx, locked, { ...staleContext, now: clock.now() });
              }
              const now = clock.now();
              const decision = decideSessionAction(
                'edit',
                { status: locked.status, startsAt: locked.starts_at },
                now,
              );
              if (!decision.ok) throw new AppError(decision.error);
              // The decision above looked at the OLD start. A PUBLISHED session cannot be saved into a start that has
              // already passed (players could never be un-notified); a DRAFT may, it just cannot be published.
              if (locked.status === 'PUBLISHED' && times.startsAt <= now) {
                throw new AppError('session_started');
              }

              const courtsBefore = await repo.listCourts(trx, sessionId);
              const before = contentOf(locked, courtsBefore);
              const change = contentChange(before, after);
              if (change.changed.length === 0) {
                // SA-6: a save that would change nothing is a 200 with the current row, whatever the version.
                return {
                  session: await viewOf(trx, locked, now),
                  promoted: 0,
                  material: false,
                  changed: [],
                };
              }
              if (locked.version !== input.expectedVersion) {
                throw await stale(trx, locked, { ...staleContext, now });
              }

              // T-7: once a PUBLISHED session has an active registration, fees can only go down (session lock held).
              if (locked.status === 'PUBLISHED') {
                const registered =
                  (await repo.countActiveRegistrations(trx, [sessionId])).get(sessionId) ?? 0;
                if (registered > 0) {
                  const raised = feeRaised(sessionFeesOf(before.fees), sessionFeesOf(after.fees));
                  if (raised.length > 0) {
                    throw new AppError('session_fee_locked', { raisedFields: raised });
                  }
                }
              }

              await rewriteSession(
                trx,
                locked,
                courtsBefore,
                before,
                after,
                change.changed,
                now,
                times.deadline,
              );

              // C-SSE-3: public capacity rose on a PUBLISHED, not-started session: promote the waitlist once, in this
              // transaction, after the lock and the update.
              let promoted = 0;
              if (locked.status === 'PUBLISHED' && publicCapacity(after) > publicCapacity(before)) {
                const seats = await allocator.promoteWaitlist(
                  { trx, now, log: ctx.log },
                  { teamId, sessionId },
                );
                promoted = seats.length;
              }
              const fresh = await requireRow(trx, teamId, sessionId);
              return {
                session: await viewOf(trx, fresh, now),
                promoted,
                material: change.material,
                changed: change.changed,
              };
            },
            { path: 'edit', teamId, log: ctx.log },
          );
        } catch (error) {
          throw mapSessionDbError(error);
        }

        if (result.changed.length > 0) {
          ctx.log.info(
            {
              event: 'session.updated',
              teamId,
              sessionId,
              actorId,
              sessionVersion: result.session.version,
              changed: result.changed,
              promoted: result.promoted,
            },
            'session updated',
          );
        }
        return { session: result.session, promoted: result.promoted, material: result.material };
      });
    },

    publish(teamId, sessionId, actorId, input, ctx) {
      return refusing(ctx.log, { action: 'publish_session', actorId, teamId }, async () => {
        const s0 = await requireRow(db, teamId, sessionId);
        // A draft saved by someone else since the admin looked: refuse before taking any lock.
        if (s0.status === 'DRAFT' && s0.version !== input.expectedVersion) {
          throw await stale(db, s0, {
            actorId,
            expectedVersion: input.expectedVersion,
            now: clock.now(),
            log: ctx.log,
          });
        }
        const paid = isPaidSession(s0.pricing_structure, gateFeesOf(s0));
        const needsGate = s0.status === 'DRAFT' && paid;

        let result: { session: SessionResponse; published: boolean; autoEnrolQueued: boolean };
        try {
          result = await runSessionTransaction(
            db,
            HTTP_POLICY,
            async (trx) => {
              if (!(await lockTeamKeyShare(trx, teamId))) throw new AppError('forbidden');
              if (needsGate) {
                await gateOrRefuse(trx, {
                  teamId,
                  subject: { sessionId },
                  actorId,
                  fees: gateFeesOf(s0),
                  pricingStructure: s0.pricing_structure,
                  path: 'manual',
                  log: ctx.log,
                });
              }
              await assertSessionAdmin(trx, teamId, actorId);
              const locked = await lockSession(trx, { sessionId, teamId });
              if (locked === undefined) throw await missingSession(trx, sessionId);
              // A replayed publish of a PUBLISHED session is a harmless 200: nothing written, nothing enqueued.
              if (locked.status === 'PUBLISHED') {
                return {
                  session: await viewOf(trx, locked, clock.now()),
                  published: false,
                  autoEnrolQueued: false,
                };
              }
              const staleContext = {
                actorId,
                expectedVersion: input.expectedVersion,
                log: ctx.log,
              };
              const now = clock.now();
              const decision = decideSessionAction(
                'publish',
                { status: locked.status, startsAt: locked.starts_at },
                now,
              );
              if (!decision.ok) throw new AppError(decision.error);

              // The fees that were gated must be the fees published (ADR 0016 gate contract): same version only.
              if (locked.version !== s0.version || locked.version !== input.expectedVersion) {
                throw await stale(trx, locked, { ...staleContext, now });
              }

              const missing = publishErrors(locked);
              if (Object.keys(missing).length > 0) throw invalid(missing);

              const flat = effectiveFlatOf(locked);
              const published = await repo.publishDraft(trx, sessionId, {
                fee_flat: flat,
                updated_at: stampFor(now, locked),
              });
              if (!published) throw new AppError('session_state_conflict');

              // P-1, T-2: every session is auto-enrolled once, on its first publish, in a follow-up transaction.
              if (locked.auto_enrol_required) {
                await jobs.enqueue(
                  QUEUE_NAMES.sessionAutoEnrol,
                  { sessionId, teamId, trigger: 'publish' },
                  { trx, singletonKey: sessionAutoEnrolKey(sessionId) },
                );
              }
              const fresh = await requireRow(trx, teamId, sessionId);
              return {
                session: await viewOf(trx, fresh, now),
                published: true,
                autoEnrolQueued: locked.auto_enrol_required,
              };
            },
            { path: 'publish', teamId, log: ctx.log },
          );
        } catch (error) {
          throw mapSessionDbError(error);
        }

        if (result.published) {
          ctx.log.info(
            {
              event: 'session.published',
              teamId,
              sessionId,
              actorId,
              paid,
              autoEnrolQueued: result.autoEnrolQueued,
            },
            'session published',
          );
        }
        return { session: result.session, promoted: 0, material: false };
      });
    },

    cancel(teamId, sessionId, actorId, input, ctx) {
      return refusing(ctx.log, { action: 'cancel_session', actorId, teamId }, async () => {
        let result: { session: SessionResponse; count: number; from: 'DRAFT' | 'PUBLISHED' };
        try {
          result = await runSessionTransaction(
            db,
            HTTP_POLICY,
            async (trx) => {
              if (!(await lockTeamKeyShare(trx, teamId))) throw new AppError('forbidden');
              await assertSessionAdmin(trx, teamId, actorId);
              const locked = await lockSession(trx, { sessionId, teamId });
              if (locked === undefined) throw await missingSession(trx, sessionId);
              const now = clock.now();
              const decision = decideSessionAction(
                'cancel',
                { status: locked.status, startsAt: locked.starts_at },
                now,
              );
              if (!decision.ok) throw new AppError(decision.error);
              if (locked.version !== input.expectedVersion) {
                throw await stale(trx, locked, {
                  actorId,
                  expectedVersion: input.expectedVersion,
                  now,
                  log: ctx.log,
                });
              }
              // `decision.ok` means the status is DRAFT or PUBLISHED. Registrations are left exactly as they are
              // (C-SSE-4): no allocator call, no email. The admin is told how many players to let know (P-2).
              const from = locked.status as 'DRAFT' | 'PUBLISHED';
              const cancelled = await repo.cancelFrom(trx, sessionId, from, {
                updated_at: stampFor(now, locked),
              });
              if (!cancelled) throw new AppError('session_state_conflict');
              const count =
                (await repo.countActiveRegistrations(trx, [sessionId])).get(sessionId) ?? 0;
              const fresh = await requireRow(trx, teamId, sessionId);
              return {
                session: await viewOf(trx, fresh, now),
                count,
                from,
              };
            },
            { path: 'cancel', teamId, log: ctx.log },
          );
        } catch (error) {
          throw mapSessionDbError(error);
        }
        ctx.log.info(
          { event: 'session.cancelled', teamId, sessionId, actorId, fromStatus: result.from },
          'session cancelled',
        );
        return { session: result.session, activeRegistrationCount: result.count };
      });
    },
  };
}
