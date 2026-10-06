/**
 * Kysely queries for the password-auth flows. Services decide, this file only reads and writes rows.
 * Email arguments are always the normalised form (`normaliseEmail`).
 */
import { sql } from 'kysely';
import {
  normaliseEmail,
  type AssignableGlobalRole,
  type PublicUser,
  type UserSex,
} from '@sgm/shared';
import type { Database } from '../../lib/db/kysely.ts';

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly sex: UserSex;
  readonly role: AssignableGlobalRole;
}

export interface PasswordIdentity {
  readonly identityId: string;
  readonly userId: string;
  readonly passwordHash: string;
}

/** Anything but GLOBAL_ADMIN reads as PLAYER (the CHECK keeps TEAM_ADMIN out of `users.role`). */
function toRole(role: string): AssignableGlobalRole {
  return role === 'GLOBAL_ADMIN' ? 'GLOBAL_ADMIN' : 'PLAYER';
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    sex: row.sex,
    role: row.role,
  };
}

/** The user and PASSWORD identity for a normalised email, or `undefined` (also for OAuth-only accounts). */
export async function findPasswordIdentity(
  db: Database,
  email: string,
): Promise<PasswordIdentity | undefined> {
  const row = await db
    .selectFrom('auth_identities')
    .select(['id', 'user_id', 'password_hash'])
    .where('provider', '=', 'PASSWORD')
    .where('provider_subject', '=', email)
    .executeTakeFirst();
  if (row === undefined || row.password_hash === null) return undefined;
  return { identityId: row.id, userId: row.user_id, passwordHash: row.password_hash };
}

/** The user's current PASSWORD identity (fresh read, for re-checking inside a locked transaction). */
export async function findPasswordIdentityForUser(
  db: Database,
  userId: string,
): Promise<PasswordIdentity | undefined> {
  const row = await db
    .selectFrom('auth_identities')
    .select(['id', 'user_id', 'password_hash'])
    .where('provider', '=', 'PASSWORD')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (row === undefined || row.password_hash === null) return undefined;
  return { identityId: row.id, userId: row.user_id, passwordHash: row.password_hash };
}

export async function getUserById(db: Database, userId: string): Promise<UserRow | undefined> {
  const row = await db
    .selectFrom('users')
    .select(['id', 'email', 'full_name', 'sex', 'role'])
    .where('id', '=', userId)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : {
        id: row.id,
        email: row.email,
        fullName: row.full_name,
        sex: row.sex,
        role: toRole(row.role),
      };
}

/** Inserts the user (role defaults to PLAYER in the database) and its PASSWORD identity. Run in a transaction. */
export async function insertPasswordUser(
  db: Database,
  input: { email: string; fullName: string; sex: UserSex; passwordHash: string; now: Date },
): Promise<UserRow> {
  const user = await db
    .insertInto('users')
    .values({ email: input.email, full_name: input.fullName, sex: input.sex })
    .returning(['id', 'email', 'full_name', 'sex', 'role'])
    .executeTakeFirstOrThrow();
  await db
    .insertInto('auth_identities')
    .values({
      user_id: user.id,
      provider: 'PASSWORD',
      provider_subject: input.email,
      password_hash: input.passwordHash,
      last_used_at: input.now,
    })
    .execute();
  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    sex: user.sex,
    role: toRole(user.role),
  };
}

/** Stamps a successful sign-in and, when the stored hash is below current cost, replaces it. */
export async function recordPasswordLogin(
  db: Database,
  identityId: string,
  now: Date,
  upgradedHash?: string,
): Promise<void> {
  await db
    .updateTable('auth_identities')
    .set({
      last_used_at: now,
      ...(upgradedHash === undefined ? {} : { password_hash: upgradedHash }),
    })
    .where('id', '=', identityId)
    .execute();
}

// ---------------------------------------------------------------------------------------------
// Password reset (forgot / reset). Timestamps come from the injected clock; `GREATEST(created_at, $now)`
// keeps a `used_at`/`revoked_at` from falling before `created_at` (a CHECK) when replicas' clocks differ.
// ---------------------------------------------------------------------------------------------

export interface UserSummary {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
}

/** The user for a normalised email, or `undefined`. */
export async function findUserByEmail(
  db: Database,
  email: string,
): Promise<UserSummary | undefined> {
  const row = await db
    .selectFrom('users')
    .select(['id', 'email', 'full_name'])
    .where('email', '=', email)
    .executeTakeFirst();
  return row === undefined ? undefined : { id: row.id, email: row.email, fullName: row.full_name };
}

/** Serialises concurrent forgot requests for one user. Run in a transaction. */
export async function lockUserRow(db: Database, userId: string): Promise<void> {
  await db.selectFrom('users').select('id').where('id', '=', userId).forUpdate().execute();
}

/** Whether the user has a reset token created strictly after `since` (the 60-second resend floor). */
export async function hasResetTokenCreatedAfter(
  db: Database,
  userId: string,
  since: Date,
): Promise<boolean> {
  const row = await db
    .selectFrom('password_reset_tokens')
    .select('id')
    .where('user_id', '=', userId)
    .where('created_at', '>', since)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

export async function insertResetTokenRow(
  db: Database,
  input: { userId: string; tokenHash: Buffer; createdAt: Date; expiresAt: Date },
): Promise<string> {
  const row = await db
    .insertInto('password_reset_tokens')
    .values({
      user_id: input.userId,
      token_hash: input.tokenHash,
      created_at: input.createdAt,
      expires_at: input.expiresAt,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Non-locking read of a still-usable token and its user's email; no write, no hashing. */
export async function findLiveResetToken(
  db: Database,
  tokenHash: Buffer,
  now: Date,
): Promise<{ userId: string; email: string } | undefined> {
  const row = await db
    .selectFrom('password_reset_tokens as t')
    .innerJoin('users as u', 'u.id', 't.user_id')
    .select(['t.user_id', 'u.email'])
    .where('t.token_hash', '=', tokenHash)
    .where('t.used_at', 'is', null)
    .where('t.expires_at', '>', now)
    .executeTakeFirst();
  return row === undefined ? undefined : { userId: row.user_id, email: row.email };
}

/**
 * The single-use guard: `used_at` is set only if the token is still unused and unexpired. Concurrent
 * resets queue on the row lock, and every loser re-evaluates the predicate and gets `undefined`.
 */
export async function consumeResetToken(
  db: Database,
  tokenHash: Buffer,
  now: Date,
): Promise<string | undefined> {
  const row = await db
    .updateTable('password_reset_tokens')
    .set({ used_at: sql<Date>`GREATEST(created_at, ${now}::timestamptz)` })
    .where('token_hash', '=', tokenHash)
    .where('used_at', 'is', null)
    .where('expires_at', '>', now)
    .returning('user_id')
    .executeTakeFirst();
  return row?.user_id;
}

/** Locks the user row for the rest of the reset transaction and returns its current email. */
export async function lockUserEmail(db: Database, userId: string): Promise<string | undefined> {
  const row = await db
    .selectFrom('users')
    .select('email')
    .where('id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
  return row?.email;
}

/** Creates the PASSWORD identity (subject = the user's email) or replaces its hash. */
export async function upsertPasswordIdentity(
  db: Database,
  input: { userId: string; email: string; passwordHash: string },
): Promise<void> {
  await db
    .insertInto('auth_identities')
    .values({
      user_id: input.userId,
      provider: 'PASSWORD',
      provider_subject: input.email,
      password_hash: input.passwordHash,
    })
    .onConflict((conflict) =>
      conflict
        .columns(['provider', 'provider_subject'])
        .doUpdateSet({ password_hash: input.passwordHash }),
    )
    .execute();
}

/** Rule R1 (user decision D1): deletes every GOOGLE and FACEBOOK identity; returns the providers removed. */
export async function deleteOAuthIdentities(
  db: Database,
  userId: string,
): Promise<('GOOGLE' | 'FACEBOOK')[]> {
  const rows = await db
    .deleteFrom('auth_identities')
    .where('user_id', '=', userId)
    .where('provider', 'in', ['GOOGLE', 'FACEBOOK'])
    .returning('provider')
    .execute();
  const removed = new Set<'GOOGLE' | 'FACEBOOK'>();
  for (const { provider } of rows) {
    if (provider === 'GOOGLE' || provider === 'FACEBOOK') removed.add(provider);
  }
  return [...removed].sort();
}

/** The completed reset proved the inbox: informational record, read by no v1 rule. */
export async function markEmailVerified(db: Database, userId: string, now: Date): Promise<void> {
  await db.updateTable('users').set({ email_verified_at: now }).where('id', '=', userId).execute();
}

/** Revokes every live session of the user with `revoked_reason = 'password_reset'`. */
export async function revokeAllSessions(db: Database, userId: string, now: Date): Promise<number> {
  const result = await db
    .updateTable('auth_sessions')
    .set({
      revoked_at: sql<Date>`GREATEST(created_at, ${now}::timestamptz)`,
      revoked_reason: 'password_reset',
    })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

/** Marks every other unused reset token of the user as used, so an older emailed link dies too. */
export async function invalidateUnusedResetTokens(
  db: Database,
  userId: string,
  now: Date,
): Promise<void> {
  await db
    .updateTable('password_reset_tokens')
    .set({ used_at: sql<Date>`GREATEST(created_at, ${now}::timestamptz)` })
    .where('user_id', '=', userId)
    .where('used_at', 'is', null)
    .execute();
}

/**
 * Operator action (`cli users set-role`): sets the global role by email. Returns `null` for an unknown
 * email. A role outside the assignable set is refused by the `users_role_not_team_admin` CHECK as a backstop.
 */
export async function setUserRole(
  db: Database,
  rawEmail: string,
  role: AssignableGlobalRole,
): Promise<{ id: string; role: AssignableGlobalRole } | null> {
  const email = normaliseEmail(rawEmail);
  if (email === null) return null;
  const row = await db
    .updateTable('users')
    .set({ role })
    .where('email', '=', email)
    .returning(['id', 'role'])
    .executeTakeFirst();
  return row === undefined ? null : { id: row.id, role: toRole(row.role) };
}
