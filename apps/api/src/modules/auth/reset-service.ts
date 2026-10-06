/**
 * Password reset: `forgot` (request a link) and `reset` (use it). Algorithm F and G, rule R1 as amended by
 * user decision D1: every completed reset evicts all Google and Facebook sign-in methods.
 *
 * Enumeration resistance (AC-ERROR-6): `forgot` answers identically whether or not the account exists, and
 * its only 429 is the per-address limit, which depends on the caller and never on the account.
 * No raw token, password or email is ever put in a log field.
 */
import type {
  ForgotPasswordRequest,
  ResetPasswordRequest,
  ResetPasswordResponse,
} from '@sgm/shared';
import { normaliseEmail } from '@sgm/shared';
import { enqueueEmail } from '../../jobs/send-email.ts';
import type { Clock } from '../../lib/clock.ts';
import type { AuthConfig } from '../../lib/config/config.ts';
import type { FieldCrypto } from '../../lib/crypto/crypto.ts';
import type { Database } from '../../lib/db/kysely.ts';
import { AppError } from '../../lib/http/errors.ts';
import type { JobRunner } from '../../lib/jobs/jobs.ts';
import { createAddressMissingWarning } from './address-warning.ts';
import { buildPasswordResetEmail } from './emails.ts';
import type { PasswordHasher } from './password.ts';
import { checkPasswordForSet, type PasswordBlocklist } from './password-policy.ts';
import {
  consumeResetToken,
  deleteOAuthIdentities,
  findLiveResetToken,
  findUserByEmail,
  hasResetTokenCreatedAfter,
  insertResetTokenRow,
  invalidateUnusedResetTokens,
  lockUserEmail,
  lockUserRow,
  markEmailVerified,
  revokeAllSessions,
  upsertPasswordIdentity,
} from './repo.ts';
import type { RequestContext } from './service.ts';
import { hashToken, newToken } from './tokens.ts';
import type { LoginThrottle } from './throttle.ts';

/** At most one new reset email per user per minute: a flood of requests for one email is absorbed. */
const RESEND_FLOOR_MS = 60_000;
const MINUTE_MS = 60_000;

export interface ResetService {
  /** Always resolves for a well-formed request (the web shows the same page); throws only 429/503. */
  forgot(input: ForgotPasswordRequest, ctx: RequestContext): Promise<void>;
  reset(input: ResetPasswordRequest, ctx: RequestContext): Promise<ResetPasswordResponse>;
}

export interface ResetServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly config: Pick<AuthConfig, 'webBaseUrl' | 'resetTokenMinutes'>;
  readonly hasher: PasswordHasher;
  readonly throttle: Pick<LoginThrottle, 'admitForgot' | 'clearEmail'>;
  readonly blocklist: PasswordBlocklist;
  /** Producer used to enqueue the email inside the request transaction (P5). */
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  /** Seals the email (it holds the raw reset token) before it reaches the retained job table (AC-VERIFY-2). */
  readonly crypto: FieldCrypto;
  readonly warnAddressMissing?: ReturnType<typeof createAddressMissingWarning>;
}

export function createResetService(deps: ResetServiceDeps): ResetService {
  const { db, clock, config, hasher, throttle, blocklist, jobs, crypto } = deps;
  const warnAddressMissing = deps.warnAddressMissing ?? createAddressMissingWarning(clock);

  return {
    async forgot(input, ctx) {
      if (ctx.clientAddress === null) {
        warnAddressMissing(
          ctx.log,
          'no trusted client address: the forgot-password address limit is skipped',
        );
      }
      // Address limit first, for known and unknown emails alike: it must not reveal the account.
      const verdict = await throttle.admitForgot(ctx.clientAddress, clock.now());
      if (!verdict.admitted) {
        ctx.log.warn(
          { event: 'auth.password_reset.requested', outcome: 'throttled_address' },
          'forgot-password throttled by address',
        );
        throw new AppError('too_many_requests', { retryAfterSeconds: verdict.retryAfterSeconds });
      }

      const email = normaliseEmail(input.email);
      const user = email === null ? undefined : await findUserByEmail(db, email);
      if (user === undefined) {
        ctx.log.info(
          { event: 'auth.password_reset.requested', outcome: 'no_account' },
          'password reset requested',
        );
        return;
      }

      const now = clock.now();
      // The token row and the email job commit together: a job exists only if its token exists.
      const tokenId = await db.transaction().execute(async (trx) => {
        await lockUserRow(trx, user.id); // serialises concurrent requests for this user
        if (
          await hasResetTokenCreatedAfter(trx, user.id, new Date(now.getTime() - RESEND_FLOOR_MS))
        ) {
          return null;
        }
        const token = newToken();
        const id = await insertResetTokenRow(trx, {
          userId: user.id,
          tokenHash: token.hash,
          createdAt: now,
          expiresAt: new Date(now.getTime() + config.resetTokenMinutes * MINUTE_MS),
        });
        await enqueueEmail(
          jobs,
          buildPasswordResetEmail({
            to: user.email,
            fullName: user.fullName,
            token: token.raw,
            tokenId: id,
            webBaseUrl: config.webBaseUrl,
            expiryMinutes: config.resetTokenMinutes,
          }),
          { trx, crypto },
        );
        return id;
      });
      ctx.log.info(
        {
          event: 'auth.password_reset.requested',
          outcome: tokenId === null ? 'resend_floor' : 'sent',
          userId: user.id,
          ...(tokenId === null ? {} : { tokenId }),
        },
        'password reset requested',
      );
    },

    async reset(input, ctx) {
      const tokenHash = hashToken(input.token);
      // Cheap non-locking check first: random or reused tokens never reach the hasher (no CPU burn).
      const live = await findLiveResetToken(db, tokenHash, clock.now());
      if (live === undefined) return failInvalidToken(ctx);

      // The policy needs the account's email (a password equal to it is refused); a 422 leaves the token usable.
      const verdict = checkPasswordForSet(input.password, live.email, blocklist);
      if (!verdict.ok) {
        throw new AppError('validation_failed', { fieldErrors: { password: [verdict.message] } });
      }
      // Hashed outside the transaction so a connection is not held for the hash cost.
      const passwordHash = await hasher.hash(input.password);

      const outcome = await db.transaction().execute(async (trx) => {
        const now = clock.now();
        // Guarded consume: the race loser updates 0 rows here and ends in the 400 below.
        const userId = await consumeResetToken(trx, tokenHash, now);
        if (userId === undefined) return null;
        const email = await lockUserEmail(trx, userId);
        if (email === undefined) return null;
        // R1/D1, unconditionally: PASSWORD first (so the last-method trigger is satisfied at COMMIT), then
        // every Google and Facebook identity goes, whatever any provider asserted in the past.
        await upsertPasswordIdentity(trx, { userId, email, passwordHash });
        const removedProviders = await deleteOAuthIdentities(trx, userId);
        await markEmailVerified(trx, userId, now);
        await revokeAllSessions(trx, userId, now);
        await invalidateUnusedResetTokens(trx, userId, now);
        await throttle.clearEmail(email, trx);
        return { userId, removedProviders };
      });
      if (outcome === null) return failInvalidToken(ctx);

      ctx.log.info(
        {
          event: 'auth.password_reset.completed',
          userId: outcome.userId,
          removedProviders: outcome.removedProviders,
        },
        'password reset completed',
      );
      for (const provider of outcome.removedProviders) {
        ctx.log.info(
          {
            event: 'auth.identity.unlinked',
            userId: outcome.userId,
            provider,
            reason: 'password_reset',
          },
          'sign-in method removed by password reset',
        );
      }
      return { removedProviders: outcome.removedProviders };
    },
  };
}

function failInvalidToken(ctx: RequestContext): never {
  ctx.log.warn(
    { event: 'auth.password_reset.failed', reason: 'invalid_or_expired_token' },
    'password reset refused',
  );
  throw new AppError('invalid_or_expired_token');
}
