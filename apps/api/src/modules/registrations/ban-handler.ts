/**
 * The real `MemberBannedHandler` (architecture Q4, option 4A; ADR 0015, ADR 0018; AC-HAPPY-10, AC-ERROR-9, AC-ASYNC-2).
 *
 * A ban has already committed when this runs, so access is revoked whatever happens here. The handler gives a banned member's
 * upcoming registrations the same treatment as a player's own withdrawal, minus the fee:
 *
 *   1. Read `now` once and select, with no lock, the member's CONFIRMED and WAITLISTED rows in the team's future PUBLISHED
 *      sessions, in `(starts_at, id)` order (the selection is by CURRENT state, never by the payload, so a redelivery selects
 *      nothing and returns `affected: 0`).
 *   2. One transaction per session (`runAllocatorTransaction`, `JOB_POLICY`): `allocator.withdrawFromSession(cause: 'ban')`
 *      takes the D-14 session lock, re-checks the session and the row, withdraws as `BANNED` with no fee, and runs the shared
 *      promotion step, so the promoted party's email commits with the withdrawal. A refusal (the session started or was
 *      cancelled, or the row was already withdrawn by a racing player or an earlier delivery) is a skip, not a failure.
 *   3. A failure on one session is logged and the loop carries on, so one bad session never holds back the rest. At the end
 *      the run throws: a plain error when ANY failure was transient (the queue retries with backoff; sessions already done
 *      select nothing next time), else `NonRetryableJobError` (the job ends `failed` for an operator, and the daily sweep
 *      re-enqueues it while the member still holds an active registration).
 *
 * It never writes `team_members`, never reads the ban reason and never emails the banned member (ADR 0015 point 4). The
 * allocator already emits `registration.withdrawn` and `registration.promoted`; this file logs only its own
 * `registration.ban.*` events, with ids and codes (never an error message, which can echo row data).
 */
import type { Clock } from '../../lib/clock.ts';
import type { Database } from '../../lib/db/kysely.ts';
import { NonRetryableJobError, type JobRunner } from '../../lib/jobs/jobs.ts';
import type { MemberBannedHandler } from '../teams/ban-hook.ts';
import { createAllocator, type Allocator } from './allocator.ts';
import { listBanTargets, RegistrationInvariantError } from './repo.ts';
import { JOB_POLICY, runAllocatorTransaction } from './tx.ts';

export interface BanHandlerDeps {
  readonly db: Database;
  /** The worker's runner: the promotion emails are enqueued on the withdrawal's own transaction. */
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  readonly clock: Clock;
  /** Origin for the link in the promotion email. */
  readonly webBaseUrl: string;
  /** Test seams: the allocator, the session selection and the transaction runner. */
  readonly allocator?: Pick<Allocator, 'withdrawFromSession'>;
  readonly listTargets?: typeof listBanTargets;
  readonly runTransaction?: typeof runAllocatorTransaction;
}

export type BanErrorClass = 'transient' | 'permanent';

/** SQLSTATEs a retry can cure: deadlock, lock timeout, serialisation failure, statement timeout, too many connections. */
const TRANSIENT_STATES: ReadonlySet<string> = new Set([
  '40P01',
  '55P03',
  '40001',
  '57014',
  '53300',
]);

function sqlStateOf(error: unknown): string | undefined {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Transient first (Q4): an unknown error is retried, because retrying a harmless unknown costs seconds and giving up on a
 * curable one costs a stuck ban until the next sweep. Permanent means a retry would fail the same way: an integrity or
 * constraint violation (SQLSTATE class 23) or a broken registration invariant.
 */
export function classifyBanError(error: unknown): BanErrorClass {
  if (error instanceof RegistrationInvariantError) return 'permanent';
  const state = sqlStateOf(error);
  if (state === undefined) return 'transient';
  if (TRANSIENT_STATES.has(state) || state.startsWith('08')) return 'transient';
  return state.startsWith('23') ? 'permanent' : 'transient';
}

/** A code for the log, never the message: a database message can echo row data. */
function errorCodeOf(error: unknown): string {
  return sqlStateOf(error) ?? (error instanceof Error ? error.name : 'unknown');
}

export function createRegistrationsBanHandler(deps: BanHandlerDeps): MemberBannedHandler {
  const allocator =
    deps.allocator ?? createAllocator({ jobs: deps.jobs, webBaseUrl: deps.webBaseUrl });
  const listTargets = deps.listTargets ?? listBanTargets;
  const runTransaction = deps.runTransaction ?? runAllocatorTransaction;

  return {
    name: 'registrations',
    async handle(event, context) {
      const { logger, signal } = context;
      const ids = { teamId: event.teamId, userId: event.userId };
      // One clock reading for the whole run: selection and every per-session transaction act at this instant, so a
      // session that starts mid-run is still withdrawn (a later reading would refuse it as closed).
      const selectionNow = deps.clock.now();
      const fixedClock: Clock = { now: () => selectionNow };
      const targets = await listTargets(deps.db, ids, selectionNow);

      let affected = 0;
      let transientFailures = 0;
      let permanentFailures = 0;
      for (const target of targets) {
        if (signal.aborted) {
          // Shutdown: stop between sessions. The retry picks up what is still active.
          throw new Error('ban handler aborted before every session was processed');
        }
        try {
          const outcome = await runTransaction(
            deps.db,
            JOB_POLICY,
            { clock: fixedClock, teamId: event.teamId, path: 'ban', log: logger },
            ({ trx, now }) =>
              allocator.withdrawFromSession(
                { trx, now, log: logger },
                { ...ids, sessionId: target.sessionId, cause: 'ban' },
              ),
          );
          if (outcome.ok) {
            affected += 1;
          } else {
            logger.info(
              {
                event: 'registration.ban.session_skipped',
                ...ids,
                sessionId: target.sessionId,
                reason: outcome.reason,
              },
              'ban withdrawal skipped: the session or the registration changed under the lock',
            );
          }
        } catch (error) {
          const failureClass = classifyBanError(error);
          if (failureClass === 'transient') transientFailures += 1;
          else permanentFailures += 1;
          logger[failureClass === 'transient' ? 'warn' : 'error'](
            {
              event: 'registration.ban.session_failed',
              ...ids,
              sessionId: target.sessionId,
              class: failureClass,
              sqlState: errorCodeOf(error),
              // The row an operator must look at: an id, never row data.
              ...(error instanceof RegistrationInvariantError && error.registrationId !== undefined
                ? { registrationId: error.registrationId }
                : {}),
            },
            'ban withdrawal failed for one session; the others are still processed',
          );
        }
      }

      if (transientFailures > 0) {
        throw new Error(
          `ban handler: ${String(transientFailures)} session(s) failed transiently, ${String(permanentFailures)} permanently`,
        );
      }
      if (permanentFailures > 0) {
        throw new NonRetryableJobError(
          `ban handler: ${String(permanentFailures)} session(s) failed permanently`,
        );
      }
      return { affected };
    },
  };
}
