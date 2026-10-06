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
import type { PasswordHasher } from './password.ts';
import { checkPasswordForSet, type PasswordBlocklist } from './password-policy.ts';
import {
  findPasswordIdentity,
  getUserById,
  insertPasswordUser,
  recordPasswordLogin,
  toPublicUser,
} from './repo.ts';
import type { IssuedSession, RequestAuth, SessionService } from './sessions.ts';
import type { LoginThrottle } from './throttle.ts';

/** The throttle key for a sign-in email that does not normalise; it cannot equal a real normalised email. */
const MALFORMED_EMAIL_KEY = '!malformed';
const ADDRESS_MISSING_WARNING_INTERVAL_MS = 60_000;

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
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && (error as Error & { code?: unknown }).code === '23505';

function toSessionInfo(session: IssuedSession): SessionInfo {
  return { token: session.token, expiresAt: session.expiresAt.toISOString() };
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { db, clock, config, sessions, hasher, throttle, blocklist } = deps;
  let lastAddressWarning = 0;

  return {
    async register(input, ctx) {
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
        const now = Date.now();
        if (now - lastAddressWarning >= ADDRESS_MISSING_WARNING_INTERVAL_MS) {
          lastAddressWarning = now;
          ctx.log.warn(
            { event: 'auth.throttle.address_missing' },
            'no trusted client address: only the per-email limit applies',
          );
        }
      }

      // Reserve before verifying: a blocked attempt does no lookup and no hash (same cost for any email).
      const verdict = await throttle.admitLogin(keys, clock.now());
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

      await throttle.settleLogin(keys, clock.now());
      const upgradedHash = checked.needsRehash ? await hasher.hash(input.password) : undefined;
      const presented =
        ctx.presentedToken === null ? null : await sessions.resolve(ctx.presentedToken);
      const { session, replacedSessionId } = await db.transaction().execute(async (trx) => {
        let replaced: string | null = null;
        if (presented?.status === 'valid') {
          const revoked = await sessions.revoke(trx, presented.auth.sessionId, 'replaced');
          replaced = revoked ? presented.auth.sessionId : null;
        }
        await recordPasswordLogin(trx, identity.identityId, clock.now(), upgradedHash);
        return {
          session: await sessions.issue(trx, identity.userId, ctx.userAgent),
          replacedSessionId: replaced,
        };
      });
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
      // The fake provider stands in for both when enabled (E2E only; the config refuses it in production).
      return {
        google: config.fakeOAuth || config.google !== null,
        facebook: config.fakeOAuth || config.facebook !== null,
      };
    },
  };
}
