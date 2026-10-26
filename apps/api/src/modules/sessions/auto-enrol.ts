/**
 * The auto-enrol follow-up (architecture SA-3, SA-5; binding P-1, T-2, T-19). Every session gets its Auto Enroll members
 * once, on its first publish, in a transaction of its own that holds no lock on the session or its rule when it starts.
 *
 * Serialised per session (T-19): the FIRST statement of the transaction takes the per-session advisory lock, before any row
 * lock, so an inline follow-up, a sweep job and a replayed `session-auto-enrol` job never overlap. After the lock the session
 * is re-read and the run returns unless it is still due; the allocator call and the `auto_enrolled_at` stamp share one
 * transaction, so the placements and the marker commit or roll back together, and the second runner finds the stamp.
 *
 * The no-op port (`enrols: false`) changes nothing and stamps nothing, so the session stays pending until a real allocator is
 * injected and a later run enrols it (the rollout gap, SA-5). Logs carry ids and counts, never member names or emails.
 *
 * O8 (registration ruling 2026-10-26, D-86): the session's `auto_enrol_notify` is read with the due check and passed to the
 * port as `notify`. Sessions left pending before registration shipped were set false by migration, so the first boot sweep
 * enrols that backlog without the R17 emails; `session.auto_enrol.completed` then carries `silent` (placements made without
 * an email). Every session published since defaults to true.
 */
import { z } from 'zod';
import type { Selectable, Transaction } from 'kysely';
import { selectAutoEnrollees } from '../skill-levels/auto-enrol.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Database } from '../../lib/db/kysely.ts';
import type { DB, GameSessions } from '../../lib/db/types.generated.ts';
import type { Logger } from '../../lib/logger/logger.ts';
import type { SessionAllocatorPort } from './allocator-port.ts';
import { classifySessionError } from './errors.ts';
import { lockSessionAutoEnrol } from './locks.ts';
import { JOB_POLICY, runSessionTransaction } from './tx.ts';

export const SessionAutoEnrolPayload = z.strictObject({
  sessionId: z.uuid(),
  teamId: z.uuid(),
  trigger: z.enum(['publish', 'sweep', 'manual']),
});
export type SessionAutoEnrolPayload = z.infer<typeof SessionAutoEnrolPayload>;

/** Singleton key of one session's follow-up job: a queued or active duplicate is dropped. */
export const sessionAutoEnrolKey = (sessionId: string): string => `session-auto-enrol:${sessionId}`;

export interface SessionAutoEnrolDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly allocator: SessionAllocatorPort;
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export type AutoEnrolKind = 'done' | 'noop_port' | 'not_due' | 'no_candidates';

export interface AutoEnrolOutcome {
  readonly kind: AutoEnrolKind;
  readonly candidates: number;
  readonly confirmed: number;
  readonly waitlisted: number;
  /** Members the allocator refused (overdue payments, opted out meanwhile, already registered, …). */
  readonly skipped: number;
}

const NOT_DUE: AutoEnrolOutcome = {
  kind: 'not_due',
  candidates: 0,
  confirmed: 0,
  waitlisted: 0,
  skipped: 0,
};

type DueSession = Pick<
  Selectable<GameSessions>,
  'date' | 'status' | 'starts_at' | 'auto_enrol_required' | 'auto_enrolled_at' | 'auto_enrol_notify'
>;

/** The session when it is still due: PUBLISHED, obliged, not yet stamped and not started. A plain read, no lock. */
async function readDue(
  reader: Database | Transaction<DB>,
  input: { readonly teamId: string; readonly sessionId: string },
  now: Date,
): Promise<DueSession | undefined> {
  const session = await reader
    .selectFrom('game_sessions')
    .select([
      'date',
      'status',
      'starts_at',
      'auto_enrol_required',
      'auto_enrolled_at',
      'auto_enrol_notify',
    ])
    .where('id', '=', input.sessionId)
    .where('team_id', '=', input.teamId)
    .executeTakeFirst();
  const due =
    session !== undefined &&
    session.status === 'PUBLISHED' &&
    session.auto_enrol_required &&
    session.auto_enrolled_at === null &&
    session.starts_at !== null &&
    session.starts_at.getTime() > now.getTime();
  return due ? session : undefined;
}

export async function runSessionAutoEnrol(
  deps: SessionAutoEnrolDeps,
  input: { readonly teamId: string; readonly sessionId: string },
): Promise<AutoEnrolOutcome> {
  const { db, clock, allocator, log } = deps;
  const ids = { teamId: input.teamId, sessionId: input.sessionId };

  if (!allocator.enrols) {
    // No real allocator: nothing to place and nothing to stamp. Say how many were waiting, and leave the marker pending.
    const session = await readDue(db, input, clock.now());
    if (session === undefined) return NOT_DUE;
    const entries = await selectAutoEnrollees(db, { ...input, sessionDate: session.date });
    log.info(
      { event: 'session.auto_enrol.port_noop', ...ids, candidates: entries.length },
      'auto-enrol deferred: no allocator is wired yet',
    );
    return { ...NOT_DUE, kind: 'noop_port', candidates: entries.length };
  }

  let skippedByReason: Record<string, number> = {};
  // O8: the due session's flag, kept for the completed event (the last attempt's read wins).
  let notify = true;
  let outcome: AutoEnrolOutcome;
  try {
    outcome = await runSessionTransaction(
      db,
      JOB_POLICY,
      async (trx) => {
        // T-19: the first statement after the lock timeout, before any row lock.
        await lockSessionAutoEnrol(trx, input.sessionId);
        const now = clock.now();
        const session = await readDue(trx, input, now);
        if (session === undefined) return NOT_DUE;

        // A retried transaction starts its tally again.
        skippedByReason = {};
        notify = session.auto_enrol_notify;
        const selected = await selectAutoEnrollees(trx, { ...input, sessionDate: session.date });
        let confirmed = 0;
        let waitlisted = 0;
        let skipped = 0;
        let kind: AutoEnrolKind = 'no_candidates';
        if (selected.length > 0) {
          kind = 'done';
          const results = await allocator.autoEnrolInSession(
            { trx, now, log },
            {
              ...input,
              entries: selected.map((member) => ({
                userId: member.userId,
                assignedAt: member.assignedAt,
                membershipId: member.membershipId,
              })),
              notify,
            },
          );
          for (const { outcome: result } of results) {
            if (!result.ok) {
              skipped += 1;
              skippedByReason[result.reason] = (skippedByReason[result.reason] ?? 0) + 1;
            } else if (result.status === 'CONFIRMED') confirmed += 1;
            else waitlisted += 1;
          }
        }
        // The marker shares the transaction with the placements; the guard makes a lost race a no-op.
        await trx
          .updateTable('game_sessions')
          .set({ auto_enrolled_at: now })
          .where('id', '=', input.sessionId)
          .where('status', '=', 'PUBLISHED')
          .where('auto_enrolled_at', 'is', null)
          .execute();
        return { kind, candidates: selected.length, confirmed, waitlisted, skipped };
      },
      { path: 'auto_enrol', teamId: input.teamId, log },
    );
  } catch (error) {
    const failure = classifySessionError(error);
    log.warn(
      {
        event: 'session.auto_enrol.failed',
        ...ids,
        allocator: allocator.name,
        sqlState: failure.sqlState,
        errorCode: failure.errorCode,
      },
      'auto-enrol failed and was rolled back; the marker stays pending',
    );
    throw error;
  }

  if (outcome.kind === 'done' || outcome.kind === 'no_candidates') {
    log.info(
      {
        event: 'session.auto_enrol.completed',
        ...ids,
        allocator: allocator.name,
        candidates: outcome.candidates,
        confirmed: outcome.confirmed,
        waitlisted: outcome.waitlisted,
        skipped: skippedByReason,
        // O8: only for a backlog session; how many members were placed without the R17 email (a count, no ids of members).
        ...(notify ? {} : { silent: outcome.confirmed + outcome.waitlisted }),
      },
      'auto-enrol completed',
    );
  }
  return outcome;
}
