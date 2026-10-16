/**
 * `team.action.refused`, one event shape for every module that guards routes with `requireTeamRole`
 * (team-banking-and-gst Architecture "team.action.refused": registered ONCE at the root in `buildApp`, so the
 * teams and team-banking modules, and any later one, log identically).
 *
 * Two sources: the route guard answers 403 in `onRequest` before any handler runs, so only an `onError` hook can
 * see it (`registerTeamRefusalLogging`); a domain refusal (409, 422, a stale admin) is raised inside a service,
 * which wraps its work in `refusing`. Fields are ids and a reason code, never the request body.
 */
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { AppError } from '../http/errors.ts';

/** The subset of the request logger a service uses (`request.log`, which carries the trace ids). */
export type RefusalLogger = Pick<FastifyBaseLogger, 'info' | 'warn'>;

const UUID_TEXT = /^[0-9a-f-]{36}$/i;

/** Errors `refusing` already logged, so the `onError` hook does not log the same refusal a second time. */
const alreadyLogged = new WeakSet<object>();

/** Logs the guard's 403 on every route whose policy is `teamRole`. A 401 has no actor and is not logged. */
export function registerTeamRefusalLogging(app: FastifyInstance): void {
  app.addHook('onError', (request, _reply, error, done) => {
    const policy = request.routeOptions.config.policy;
    if (
      policy?.kind === 'teamRole' &&
      error instanceof AppError &&
      error.code === 'forbidden' &&
      !alreadyLogged.has(error) &&
      request.auth !== null
    ) {
      const params = request.params as Record<string, unknown> | undefined;
      const teamId = params?.[policy.teamIdParam];
      request.log.warn(
        {
          event: 'team.action.refused',
          action: `${request.method} ${request.routeOptions.url ?? ''}`,
          actorId: request.auth.userId,
          ...(typeof teamId === 'string' && UUID_TEXT.test(teamId) ? { teamId } : {}),
          reason: 'forbidden',
        },
        'team action refused',
      );
    }
    done();
  });
}

/**
 * Logs one `team.action.refused` event (reason = the error code, never the input) for a domain refusal and
 * rethrows. The request logger already carries the traceId.
 */
export async function refusing<T>(
  log: RefusalLogger,
  fields: { action: string; actorId: string; teamId?: string },
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError) {
      alreadyLogged.add(error);
      const level = error.code === 'forbidden' ? 'warn' : 'info';
      log[level](
        { event: 'team.action.refused', ...fields, reason: error.code },
        'team action refused',
      );
    }
    throw error;
  }
}
