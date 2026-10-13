/**
 * Kysely queries for the password-auth flows. Services decide, this file only reads and writes rows.
 * Email arguments are always the normalised form (`normaliseEmail`).
 */
import { sql } from 'kysely';
import {
  normaliseEmail,
  type AssignableGlobalRole,
  type Ciphertext,
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

// ---------------------------------------------------------------------------------------------
// OAuth: state, pending sign-ups and identities. The single-use rows are consumed with one guarded UPDATE.
// ---------------------------------------------------------------------------------------------

export type OAuthIdentityProvider = 'GOOGLE' | 'FACEBOOK';

export interface NewOAuthState {
  readonly id: string;
  readonly stateHash: Buffer;
  readonly provider: OAuthIdentityProvider;
  readonly intent: 'signin' | 'link';
  readonly linkUserId: string | null;
  readonly nonce: string | null;
  /** AES-GCM envelope from `FieldCrypto.encrypt`; the column rejects anything else (23514). */
  readonly codeVerifierEnc: Ciphertext | null;
  readonly returnTo: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export async function insertOAuthState(db: Database, input: NewOAuthState): Promise<void> {
  await db
    .insertInto('oauth_states')
    .values({
      id: input.id,
      state_hash: input.stateHash,
      provider: input.provider,
      intent: input.intent,
      link_user_id: input.linkUserId,
      nonce: input.nonce,
      code_verifier_enc: input.codeVerifierEnc,
      return_to: input.returnTo,
      created_at: input.createdAt,
      expires_at: input.expiresAt,
    })
    .execute();
}

export interface ConsumedOAuthState {
  readonly id: string;
  readonly intent: 'signin' | 'link';
  readonly linkUserId: string | null;
  readonly nonce: string | null;
  readonly codeVerifierEnc: string | null;
  readonly returnTo: string;
}

/**
 * The single-use guard for `state`: `used_at` is set only for an unused, unexpired row of this provider.
 * Replays, unknown, expired and other-provider states update zero rows and return `undefined`.
 */
export async function consumeOAuthState(
  db: Database,
  input: { stateHash: Buffer; provider: OAuthIdentityProvider; now: Date },
): Promise<ConsumedOAuthState | undefined> {
  const row = await db
    .updateTable('oauth_states')
    .set({ used_at: sql<Date>`GREATEST(created_at, ${input.now}::timestamptz)` })
    .where('state_hash', '=', input.stateHash)
    .where('provider', '=', input.provider)
    .where('used_at', 'is', null)
    .where('expires_at', '>', input.now)
    .returning(['id', 'intent', 'link_user_id', 'nonce', 'code_verifier_enc', 'return_to'])
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    id: row.id,
    intent: row.intent === 'link' ? 'link' : 'signin',
    linkUserId: row.link_user_id,
    nonce: row.nonce,
    codeVerifierEnc: row.code_verifier_enc,
    returnTo: row.return_to ?? '/',
  };
}

export async function findIdentityOwner(
  db: Database,
  provider: OAuthIdentityProvider,
  subject: string,
): Promise<{ identityId: string; userId: string } | undefined> {
  const row = await db
    .selectFrom('auth_identities')
    .select(['id', 'user_id'])
    .where('provider', '=', provider)
    .where('provider_subject', '=', subject)
    .executeTakeFirst();
  return row === undefined ? undefined : { identityId: row.id, userId: row.user_id };
}

export async function userHasIdentity(
  db: Database,
  userId: string,
  provider: OAuthIdentityProvider,
): Promise<boolean> {
  const row = await db
    .selectFrom('auth_identities')
    .select('id')
    .where('user_id', '=', userId)
    .where('provider', '=', provider)
    .executeTakeFirst();
  return row !== undefined;
}

/** Whether the identity still belongs to the user (a reset removes the OAuth ones). Re-check under `lockUserRow`. */
export async function identityBelongsToUser(
  db: Database,
  identityId: string,
  userId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('auth_identities')
    .select('id')
    .where('id', '=', identityId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row !== undefined;
}

/** Whether the session is still live (not revoked, not expired). Re-check under `lockUserRow`. */
export async function isSessionLive(db: Database, sessionId: string, now: Date): Promise<boolean> {
  const row = await db
    .selectFrom('auth_sessions')
    .select('id')
    .where('id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now)
    .where('absolute_expires_at', '>', now)
    .executeTakeFirst();
  return row !== undefined;
}

export async function recordOAuthLogin(db: Database, identityId: string, now: Date): Promise<void> {
  await db
    .updateTable('auth_identities')
    .set({ last_used_at: now })
    .where('id', '=', identityId)
    .execute();
}

export interface NewPendingSignup {
  readonly tokenHash: Buffer;
  readonly provider: OAuthIdentityProvider;
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly fullName: string | null;
  readonly returnTo: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export async function insertPendingSignup(db: Database, input: NewPendingSignup): Promise<void> {
  await db
    .insertInto('oauth_pending_signups')
    .values({
      token_hash: input.tokenHash,
      provider: input.provider,
      provider_subject: input.subject,
      email: input.email,
      email_verified: input.emailVerified,
      full_name: input.fullName,
      return_to: input.returnTo,
      created_at: input.createdAt,
      expires_at: input.expiresAt,
    })
    .execute();
}

export interface PendingSignup {
  readonly id: string;
  readonly provider: OAuthIdentityProvider;
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly fullName: string | null;
  readonly returnTo: string;
  readonly expiresAt: Date;
}

function toPending(row: {
  id: string;
  provider: string;
  provider_subject: string;
  email: string;
  email_verified: boolean;
  full_name: string | null;
  return_to: string | null;
  expires_at: Date;
}): PendingSignup {
  return {
    id: row.id,
    provider: row.provider === 'FACEBOOK' ? 'FACEBOOK' : 'GOOGLE',
    subject: row.provider_subject,
    email: row.email,
    emailVerified: row.email_verified,
    fullName: row.full_name,
    returnTo: row.return_to ?? '/',
    expiresAt: row.expires_at,
  };
}

/** Read-only view of a live pending sign-up (prefill for `/register/complete`). */
export async function findLivePendingSignup(
  db: Database,
  tokenHash: Buffer,
  now: Date,
): Promise<PendingSignup | undefined> {
  const row = await db
    .selectFrom('oauth_pending_signups')
    .select([
      'id',
      'provider',
      'provider_subject',
      'email',
      'email_verified',
      'full_name',
      'return_to',
      'expires_at',
    ])
    .where('token_hash', '=', tokenHash)
    .where('used_at', 'is', null)
    .where('expires_at', '>', now)
    .executeTakeFirst();
  return row === undefined ? undefined : toPending(row);
}

/** The single-use guard for a pending sign-up (used inside the completion transaction). */
export async function consumePendingSignup(
  db: Database,
  tokenHash: Buffer,
  now: Date,
): Promise<PendingSignup | undefined> {
  const row = await db
    .updateTable('oauth_pending_signups')
    .set({ used_at: sql<Date>`GREATEST(created_at, ${now}::timestamptz)` })
    .where('token_hash', '=', tokenHash)
    .where('used_at', 'is', null)
    .where('expires_at', '>', now)
    .returning([
      'id',
      'provider',
      'provider_subject',
      'email',
      'email_verified',
      'full_name',
      'return_to',
      'expires_at',
    ])
    .executeTakeFirst();
  return row === undefined ? undefined : toPending(row);
}

/** The user an OAuth sign-up creates: no password, role PLAYER (database default). */
export async function insertOAuthUser(
  db: Database,
  input: {
    email: string;
    fullName: string;
    sex: UserSex;
    provider: OAuthIdentityProvider;
    subject: string;
    emailVerifiedAt: Date | null;
    now: Date;
  },
): Promise<UserRow> {
  const user = await db
    .insertInto('users')
    .values({
      email: input.email,
      full_name: input.fullName,
      sex: input.sex,
      email_verified_at: input.emailVerifiedAt,
    })
    .returning(['id', 'email', 'full_name', 'sex', 'role'])
    .executeTakeFirstOrThrow();
  await db
    .insertInto('auth_identities')
    .values({
      user_id: user.id,
      provider: input.provider,
      provider_subject: input.subject,
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

export async function insertIdentity(
  db: Database,
  input: { userId: string; provider: OAuthIdentityProvider; subject: string; now: Date },
): Promise<string> {
  const row = await db
    .insertInto('auth_identities')
    .values({
      user_id: input.userId,
      provider: input.provider,
      provider_subject: input.subject,
      last_used_at: input.now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Informational inbox proof (Google `email_verified` for the account's own email); read by no v1 rule. */
export async function setEmailVerifiedIfUnset(
  db: Database,
  userId: string,
  now: Date,
): Promise<void> {
  await db
    .updateTable('users')
    .set({ email_verified_at: now })
    .where('id', '=', userId)
    .where('email_verified_at', 'is', null)
    .execute();
}

export interface IdentitySummary {
  readonly identityId: string;
  readonly provider: 'PASSWORD' | 'GOOGLE' | 'FACEBOOK';
  readonly connectedAt: Date;
  readonly lastUsedAt: Date | null;
}

export async function listIdentities(db: Database, userId: string): Promise<IdentitySummary[]> {
  const rows = await db
    .selectFrom('auth_identities')
    .select(['id', 'provider', 'created_at', 'last_used_at'])
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return rows.map((row) => ({
    identityId: row.id,
    provider: row.provider,
    connectedAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

export async function deleteIdentity(db: Database, identityId: string): Promise<void> {
  await db.deleteFrom('auth_identities').where('id', '=', identityId).execute();
}
