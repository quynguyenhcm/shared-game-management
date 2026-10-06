/**
 * Kysely queries for the password-auth flows. Services decide, this file only reads and writes rows.
 * Email arguments are always the normalised form (`normaliseEmail`).
 */
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
