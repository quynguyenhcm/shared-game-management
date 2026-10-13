/**
 * Password auth rules: register, login, logout, me, providers. Handlers stay thin; the rules live here.
 * Email arguments reach this file already normalised by the shared zod schema (register) or are normalised
 * here (login, which must answer a malformed email with the same generic 401 as an unknown one).
 */
import type { FastifyBaseLogger } from 'fastify';
import type {
  AuthSuccessResponse,
  LoginRequest,
  MeResponse,
  ProvidersResponse,
  RegisterRequest,
  SessionInfo,
} from '@sgm/shared';
import { normaliseEmail } from '@sgm/shared';
import type { Clock } from '../../lib/clock.ts';
import type { AuthConfig } from '../../lib/config/config.ts';
import type { Database } from '../../lib/db/kysely.ts';
import { AppError } from '../../lib/http/errors.ts';
import { createAddressMissingWarning } from './address-warning.ts';
import type { PasswordHasher } from './password.ts';
import type { OAuthProviderRegistry } from './providers/provider.ts';
import { checkPasswordForSet, type PasswordBlocklist } from './password-policy.ts';
import {
  findPasswordIdentity,
  findPasswordIdentityForUser,
  getUserById,
  insertPasswordUser,
  lockUserRow,
  recordPasswordLogin,
  toPublicUser,
} from './repo.ts';
import type { IssuedSession, RequestAuth, SessionService } from './sessions.ts';
import type { LoginThrottle } from './throttle.ts';

/** The throttle key for a sign-in email that does not normalise; it cannot equal a real normalised email. */
const MALFORMED_EMAIL_KEY = '!malformed';

/** The subset of the request logger the service uses (`request.log`, which carries the trace ids). */
export type AuthLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;

export interface RequestContext {
  readonly log: AuthLogger;
  readonly userAgent: string | null;
  /** `request.clientAddress`: only ever set over the secret-authenticated web hop. */
  readonly clientAddress: string | null;
}

export interface LoginContext extends RequestContext {
  /** The bearer token the browser presented with this sign-in, if any; it is replaced on success. */
  readonly presentedToken: string | null;
}

export interface AuthService {
  register(input: RegisterRequest, ctx: RequestContext): Promise<AuthSuccessResponse>;
  login(input: LoginRequest, ctx: LoginContext): Promise<AuthSuccessResponse>;
  /** Revokes the session when there is a live one; a dead or absent session is not an error. */
  logout(auth: RequestAuth | null, ctx: RequestContext): Promise<void>;
  me(auth: RequestAuth): Promise<MeResponse>;
  providers(): ProvidersResponse;
}

export interface AuthServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly config: AuthConfig;
  readonly sessions: SessionService;
  readonly hasher: PasswordHasher;
  readonly throttle: LoginThrottle;
  readonly blocklist: PasswordBlocklist;
  /** Which providers are enabled (credentials, or the fakes in E2E mode). */
  readonly providers: Pick<OAuthProviderRegistry, 'enabled'>;
  /** Shared with the reset service so both log one "no trusted address" warning per minute together. */
  readonly warnAddressMissing?: ReturnType<typeof createAddressMissingWarning>;
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && (error as Error & { code?: unknown }).code === '23505';

function toSessionInfo(session: IssuedSession): SessionInfo {
  return { token: session.token, expiresAt: session.expiresAt.toISOString() };
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { db, clock, sessions, hasher, throttle, blocklist } = deps;
  const warnAddressMissing = deps.warnAddressMissing ?? createAddressMissingWarning(clock);

  /** Per-address registration limit, spent before any hashing; a missing address skips the dimension. */
  async function enforceRegisterLimit(ctx: RequestContext): Promise<void> {
    if (ctx.clientAddress === null) {
      warnAddressMissing(
        ctx.log,
        'no trusted client address: the register address limit is skipped',
      );
      return;
    }
    const admitted = await throttle.admitRegister(ctx.clientAddress, clock.now());
    if (admitted.admitted) return;
    ctx.log.warn({ event: 'auth.register.throttled' }, 'registration throttled by address');
    throw new AppError('too_many_requests', { retryAfterSeconds: admitted.retryAfterSeconds });
  }

  return {
    async register(input, ctx) {
      await enforceRegisterLimit(ctx);
      const verdict = checkPasswordForSet(input.password, input.email, blocklist);
      if (!verdict.ok) {
        throw new AppError('validation_failed', { fieldErrors: { password: [verdict.message] } });
      }
      // Hashed outside the transaction so a connection is not held for the hash cost.
      const passwordHash = await hasher.hash(input.password);
      try {
        const { user, session } = await db.transaction().execute(async (trx) => {
          const created = await insertPasswordUser(trx, {
            email: input.email,
            fullName: input.fullName,
            sex: input.sex,
            passwordHash,
            now: clock.now(),
          });
          return { user: created, session: await sessions.issue(trx, created.id, ctx.userAgent) };
        });
        ctx.log.info(
          { event: 'auth.register', provider: 'PASSWORD', userId: user.id },
          'account registered',
        );
        return { user: toPublicUser(user), session: toSessionInfo(session) };
      } catch (error) {
        // The unique constraint, not an application check, decides the race (AC-INTEGRATION-5).
        if (isUniqueViolation(error)) throw new AppError('email_taken', { cause: error });
        throw error;
      }
    },

    async login(input, ctx) {
      const email = normaliseEmail(input.email);
      const keys = { email: email ?? MALFORMED_EMAIL_KEY, clientAddress: ctx.clientAddress };
      if (ctx.clientAddress === null) {
        warnAddressMissing(ctx.log, 'no trusted client address: only the per-email limit applies');
      }

      // Reserve before verifying: a blocked attempt does no lookup and no hash (same cost for any email).
      // The settle refunds by exact instant, so it must reuse this one `now` (a real clock moves while hashing).
      const attemptedAt = clock.now();
      const verdict = await throttle.admitLogin(keys, attemptedAt);
      if (!verdict.admitted) {
        ctx.log.warn(
          {
            event: 'auth.login.failed',
            reason: verdict.blockedBy === 'email' ? 'throttled_email' : 'throttled_address',
          },
          'sign-in throttled',
        );
        throw new AppError('too_many_attempts', { retryAfterSeconds: verdict.retryAfterSeconds });
      }

      const identity = email === null ? undefined : await findPasswordIdentity(db, email);
      // An unknown account still pays for one verification (AC-VERIFY-10).
      const checked = await hasher.verify(
        identity?.passwordHash ?? hasher.dummyHash,
        input.password,
      );
      if (!checked.ok || identity === undefined) {
        // The failure is already recorded by the reservation.
        ctx.log.warn(
          { event: 'auth.login.failed', reason: 'invalid_credentials' },
          'sign-in failed',
        );
        throw new AppError('invalid_credentials');
      }

      const upgradedHash = checked.needsRehash ? await hasher.hash(input.password) : undefined;
      const presented =
        ctx.presentedToken === null ? null : await sessions.resolve(ctx.presentedToken);
      const outcome = await db.transaction().execute(async (trx) => {
        // A reset may have committed since the verify above (AC-ERROR-16): lock the user, re-read the
        // identity, and refuse unless it still carries the very hash that was verified.
        await lockUserRow(trx, identity.userId);
        const current = await findPasswordIdentityForUser(trx, identity.userId);
        if (current === undefined || current.passwordHash !== identity.passwordHash) return null;
        let replaced: string | null = null;
        if (presented?.status === 'valid') {
          const revoked = await sessions.revoke(trx, presented.auth.sessionId, 'replaced');
          replaced = revoked ? presented.auth.sessionId : null;
        }
        await recordPasswordLogin(trx, current.identityId, clock.now(), upgradedHash);
        return {
          session: await sessions.issue(trx, identity.userId, ctx.userAgent),
          replacedSessionId: replaced,
        };
      });
      if (outcome === null) {
        // Same answer as a wrong password; the reservation already counts as a failure (no settle).
        ctx.log.warn(
          { event: 'auth.login.failed', reason: 'invalid_credentials' },
          'sign-in failed',
        );
        throw new AppError('invalid_credentials');
      }
      await throttle.settleLogin(keys, attemptedAt);
      const { session, replacedSessionId } = outcome;
      const user = await getUserById(db, identity.userId);
      if (user === undefined) throw new Error('user vanished during sign-in');
      if (replacedSessionId !== null) {
        ctx.log.info(
          { event: 'auth.session.revoked', reason: 'replaced', userId: user.id },
          'session replaced',
        );
      }
      ctx.log.info(
        { event: 'auth.login.succeeded', provider: 'PASSWORD', userId: user.id },
        'sign-in succeeded',
      );
      return { user: toPublicUser(user), session: toSessionInfo(session) };
    },

    async logout(auth, ctx) {
      if (auth === null) return;
      if (await sessions.revoke(db, auth.sessionId, 'logout')) {
        ctx.log.info(
          { event: 'auth.session.revoked', reason: 'logout', userId: auth.userId },
          'signed out',
        );
      }
    },

    async me(auth) {
      const user = await getUserById(db, auth.userId);
      // The session joined a live user row an instant ago; a miss means the user was just deleted.
      if (user === undefined) throw new AppError('session_expired');
      return { user: toPublicUser(user) };
    },

    providers() {
      return deps.providers.enabled();
    },
  };
}
