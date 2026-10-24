/**
 * Registration use cases behind the HTTP routes (registration-and-waitlist Phase 3): the upcoming list, the session read model,
 * register and withdraw.
 *
 * Writes run through `runAllocatorTransaction(db, HTTP_POLICY, ...)` and the allocator of `allocator.ts`, which owns the lock
 * order (member gate, then the D-14 session lock), the seat decisions, the promotion and its email in the same transaction. This
 * file adds only what an HTTP caller needs around that: the response shape (read inside the writing transaction, so the rank
 * and the guests are the committed ones) and the mapping of allocator refusals to `AppError`s.
 *
 * The allocator already emits `registration.created`, `.withdrawn`, `.promoted` and `.refused` through the `log` it is given
 * (`request.log`, which carries the trace ids). This service therefore logs NONE of them again; a test counts each event once.
 *
 * `:sessionId` is always resolved together with `:teamId`: another team's session, a DRAFT and an unknown id all end as the same
 * 404 `not_found` (O2, AC-ENTRY-2). Nothing here looks a session up by its id alone.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Transaction } from 'kysely';
import {
  ZERO,
  toMoneyString,
  type RegistrationReadResponse,
  type SessionRegisterRequest,
  type SessionRegisterResponse,
  type SessionWithdrawRequest,
  type SessionWithdrawResponse,
  type UpcomingSessionsResponse,
} from '@sgm/shared';
import type { Clock } from '../../lib/clock.ts';
import type { Database } from '../../lib/db/kysely.ts';
import type { DB } from '../../lib/db/types.generated.ts';
import { AppError } from '../../lib/http/errors.ts';
import type { JobRunner } from '../../lib/jobs/jobs.ts';
import { createAllocator, type GuestInput } from './allocator.ts';
import { registerRefusalError, withdrawRefusalError } from './errors.ts';
import {
  readMyRegistration,
  readOwedFeeEstimate,
  readRegistrationModel,
  readUpcoming,
  readVisibleSession,
} from './read-model.ts';
import { HTTP_POLICY, runAllocatorTransaction } from './tx.ts';

/** The request logger the service passes on to the allocator. */
export type RegistrationsLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

export interface RegistrationsContext {
  readonly log: RegistrationsLogger;
}

export interface RegistrationsServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  /** Job producer: the promotion email is enqueued through it on the promoting transaction. */
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  /** `config.auth.webBaseUrl`: origin of the session-page link in the emails. */
  readonly webBaseUrl: string;
}

export interface RegistrationsService {
  upcoming(teamId: string, userId: string): Promise<UpcomingSessionsResponse>;
  read(teamId: string, sessionId: string, userId: string): Promise<RegistrationReadResponse>;
  register(
    teamId: string,
    sessionId: string,
    userId: string,
    input: SessionRegisterRequest,
    ctx: RegistrationsContext,
  ): Promise<SessionRegisterResponse>;
  withdraw(
    teamId: string,
    sessionId: string,
    userId: string,
    input: SessionWithdrawRequest,
    ctx: RegistrationsContext,
  ): Promise<SessionWithdrawResponse>;
}

export function createRegistrationsService(deps: RegistrationsServiceDeps): RegistrationsService {
  const { db, clock } = deps;
  const allocator = createAllocator({ jobs: deps.jobs, webBaseUrl: deps.webBaseUrl });

  /** One consistent snapshot for a read that joins several queries (counts, own row, rank): REPEATABLE READ, read only. */
  const readOnly = <T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T> =>
    db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(work);

  return {
    upcoming(teamId, userId) {
      const now = clock.now();
      return readOnly((trx) => readUpcoming(trx, { teamId, userId, now }));
    },

    async read(teamId, sessionId, userId) {
      const now = clock.now();
      const model = await readOnly((trx) =>
        readRegistrationModel(trx, { teamId, sessionId, userId, now }),
      );
      if (model === undefined) throw new AppError('not_found');
      return model;
    },

    async register(teamId, sessionId, userId, input, ctx) {
      const guests: GuestInput[] = input.guests.map((guest) => ({
        sex: guest.sex,
        skillLevel: guest.skillLevel,
        displayName: guest.displayName ?? null,
      }));
      const result = await runAllocatorTransaction(
        db,
        HTTP_POLICY,
        { clock, teamId, path: 'register', log: ctx.log },
        async ({ trx, now }) => {
          const outcome = await allocator.registerInSession(
            { trx, now, log: ctx.log },
            { teamId, sessionId, userId, guests },
          );
          if (!outcome.ok) return { outcome, registration: null };
          return { outcome, registration: await readMyRegistration(trx, sessionId, userId) };
        },
      );
      if (!result.outcome.ok) throw registerRefusalError(result.outcome, 1 + guests.length);
      const { registration } = result;
      if (registration === null || registration.status === 'WITHDRAWN') {
        throw new Error('a committed registration was not found in its own transaction');
      }
      return { registration: { ...registration, status: registration.status } };
    },

    async withdraw(teamId, sessionId, userId, input, ctx) {
      const result = await runAllocatorTransaction(
        db,
        HTTP_POLICY,
        { clock, teamId, path: 'withdraw', log: ctx.log },
        async ({ trx, now }) => {
          const outcome = await allocator.withdrawFromSession(
            { trx, now, log: ctx.log },
            { teamId, sessionId, userId, cause: 'player', expectLate: input.expectLate },
          );
          if (!outcome.ok || !outcome.feeDue) return { outcome, owed: null };
          // The seat was not replaced, so the late fee is owed: say how much (the estimate; billing computes the charge).
          const session = await readVisibleSession(trx, { teamId, sessionId });
          const owed =
            session === undefined ? null : await readOwedFeeEstimate(trx, session, userId);
          return { outcome, owed };
        },
      );
      const { outcome } = result;
      if (!outcome.ok) throw withdrawRefusalError(outcome);
      return {
        registration: {
          status: 'WITHDRAWN',
          withdrawalKind: outcome.withdrawalKind,
          withdrawalFeeDue: outcome.feeDue,
        },
        // Never who: the answer says only whether the waitlist took the place.
        replacedBy: outcome.promoted.length > 0 ? 'waitlist' : 'nobody',
        feeEstimate: result.owed ?? toMoneyString(ZERO),
      };
    },
  };
}
