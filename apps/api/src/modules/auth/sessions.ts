/**
 * Opaque server-side sessions (architecture Q2). The token is 256 random bits; only its SHA-256 is stored.
 * Expiry is idle (`expires_at`, slides by an hourly touch) and absolute (`absolute_expires_at`, fixed at
 * issue). Every timestamp comes from the injected clock, so tests can move time. The session carries no
 * role: the role is joined from `users` on every resolve (AC-VERIFY-4).
 */
import { sql } from 'kysely';
import type { AssignableGlobalRole } from '@sgm/shared';
import type { Clock } from '../../lib/clock.ts';
import type { AuthConfig } from '../../lib/config/config.ts';
import type { Database } from '../../lib/db/kysely.ts';
import type { Logger } from '../../lib/logger/logger.ts';
import { hashToken, newToken } from './tokens.ts';

/** `expires_at` and `last_seen_at` are written at most once per session per hour. */
export const SESSION_TOUCH_INTERVAL_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type SessionRevokeReason = 'logout' | 'password_reset' | 'replaced';

/** Who a valid session belongs to; the role is read from the database on each resolve. */
export interface RequestAuth {
  readonly userId: string;
  readonly sessionId: string;
  readonly role: AssignableGlobalRole;
}

export type ResolvedSession =
  { readonly status: 'valid'; readonly auth: RequestAuth } | { readonly status: 'expired' };

export interface IssuedSession {
  readonly sessionId: string;
  readonly token: string;
  /** The absolute expiry, which is also the web cookie's `Expires`. */
  readonly expiresAt: Date;
}

export interface SessionService {
  /** Always a new row (no pre-auth session exists, so fixation does not apply). Pass a transaction to join one. */
  issue(executor: Database, userId: string, userAgent: string | null): Promise<IssuedSession>;
  /** Unknown, revoked and expired all read as `expired`; a valid session may be touched. */
  resolve(rawToken: string): Promise<ResolvedSession>;
  /** `true` when this call revoked it (a session already revoked is left alone). */
  revoke(executor: Database, sessionId: string, reason: SessionRevokeReason): Promise<boolean>;
}

export interface SessionServiceOptions {
  readonly db: Database;
  readonly clock: Clock;
  readonly config: Pick<AuthConfig, 'sessionIdleDays' | 'sessionAbsoluteDays'>;
  readonly logger?: Pick<Logger, 'warn'>;
}

/** The user agent as stored: trimmed to the column's 512 characters, `null` when absent. */
export function storedUserAgent(header: string | undefined): string | null {
  if (header === undefined || header === '') return null;
  return header.slice(0, 512);
}

export function createSessionService(options: SessionServiceOptions): SessionService {
  const { db, clock, config } = options;

  return {
    async issue(executor, userId, userAgent) {
      const now = clock.now();
      const absolute = new Date(now.getTime() + config.sessionAbsoluteDays * DAY_MS);
      const idle = new Date(now.getTime() + config.sessionIdleDays * DAY_MS);
      const { raw, hash } = newToken();
      const row = await executor
        .insertInto('auth_sessions')
        .values({
          user_id: userId,
          token_hash: hash,
          created_at: now,
          last_seen_at: now,
          expires_at: idle < absolute ? idle : absolute,
          absolute_expires_at: absolute,
          user_agent: userAgent,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { sessionId: row.id, token: raw, expiresAt: absolute };
    },

    async resolve(rawToken) {
      const row = await db
        .selectFrom('auth_sessions as s')
        .innerJoin('users as u', 'u.id', 's.user_id')
        .select([
          's.id',
          's.user_id',
          's.last_seen_at',
          's.expires_at',
          's.absolute_expires_at',
          's.revoked_at',
          'u.role',
        ])
        .where('s.token_hash', '=', hashToken(rawToken))
        .executeTakeFirst();
      const now = clock.now();
      if (
        row === undefined ||
        row.revoked_at !== null ||
        now >= row.expires_at ||
        now >= row.absolute_expires_at
      ) {
        return { status: 'expired' };
      }
      if (now.getTime() - row.last_seen_at.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
        try {
          // Guarded so parallel requests write once, and never past the absolute expiry.
          const idleExpiry = new Date(now.getTime() + config.sessionIdleDays * DAY_MS);
          await db
            .updateTable('auth_sessions')
            .set({
              last_seen_at: now,
              expires_at: sql<Date>`LEAST(${idleExpiry}::timestamptz, absolute_expires_at)`,
            })
            .where('id', '=', row.id)
            .where('last_seen_at', '<=', new Date(now.getTime() - SESSION_TOUCH_INTERVAL_MS))
            .where('revoked_at', 'is', null)
            .execute();
        } catch (error) {
          // The touch only extends idle expiry; failing it must not fail an otherwise valid request.
          options.logger?.warn(
            { event: 'auth.session.touch_failed', err: error },
            'session touch failed',
          );
        }
      }
      // Anything but GLOBAL_ADMIN (including a TEAM_ADMIN the CHECK should make impossible) is a PLAYER.
      const role: AssignableGlobalRole = row.role === 'GLOBAL_ADMIN' ? 'GLOBAL_ADMIN' : 'PLAYER';
      return { status: 'valid', auth: { userId: row.user_id, sessionId: row.id, role } };
    },

    async revoke(executor, sessionId, reason) {
      const result = await executor
        .updateTable('auth_sessions')
        .set({ revoked_at: clock.now(), revoked_reason: reason })
        .where('id', '=', sessionId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },
  };
}
