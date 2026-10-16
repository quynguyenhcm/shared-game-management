/**
 * Kysely queries for the banking and GST settings on the `teams` row. Services decide; this file reads and writes.
 * The Akahu columns (`akahu_merchant_id`, `akahu_app_token`) and `ird_number` are never selected or written here
 * (R1, R2: they belong to wallet-and-akahu-billing), and `is_payout_configured` is generated and only ever read.
 */
import { sql } from 'kysely';
import type { Ciphertext } from '@sgm/shared';
import type { Database } from '../../lib/db/kysely.ts';

export interface BankingRow {
  readonly teamName: string;
  readonly accountNameEnvelope: Ciphertext | null;
  readonly accountNumberEnvelope: Ciphertext | null;
  readonly last4: string | null;
  readonly isPayoutConfigured: boolean;
  readonly payoutBlockedAt: Date | null;
  readonly updatedAt: Date | null;
  /** The updater's current full name; null when the audit stamp is empty or the account was deleted. */
  readonly updatedByName: string | null;
  /** Change keys of the newest committed saves and removals (D-54); the durable replay claim. */
  readonly changeKeys: readonly string[];
}

/** The banking block with the audit stamp. Under the team lock it is exact; without one it is one statement. */
export async function readBanking(db: Database, teamId: string): Promise<BankingRow | undefined> {
  const row = await db
    .selectFrom('teams as t')
    .leftJoin('users as u', 'u.id', 't.banking_updated_by')
    .select([
      't.name as team_name',
      't.bank_account_name',
      't.bank_account_number',
      't.bank_account_last4',
      't.is_payout_configured',
      't.payout_blocked_at',
      't.banking_updated_at',
      'u.full_name as updated_by_name',
      't.banking_change_keys',
    ])
    .where('t.id', '=', teamId)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : {
        teamName: row.team_name,
        accountNameEnvelope: row.bank_account_name,
        accountNumberEnvelope: row.bank_account_number,
        last4: row.bank_account_last4,
        isPayoutConfigured: row.is_payout_configured,
        payoutBlockedAt: row.payout_blocked_at,
        updatedAt: row.banking_updated_at,
        updatedByName: row.updated_by_name,
        changeKeys: row.banking_change_keys,
      };
}

export interface BankingWrite {
  readonly accountNameEnvelope: Ciphertext;
  /** Omitted: the stored number and last 4 stay byte-identical. */
  readonly number?: { readonly envelope: Ciphertext; readonly last4: string };
  readonly now: Date;
  readonly actorId: string;
  /** Stored with the change so a replay of this request is recognised under the lock (D-54). */
  readonly changeKey: string;
}

/** One UPDATE for the whole block: saving always clears `payout_blocked_at` (R3) and stamps the audit columns (R8). */
export async function writeBanking(
  db: Database,
  teamId: string,
  input: BankingWrite,
): Promise<void> {
  await db
    .updateTable('teams')
    .set({
      bank_account_name: input.accountNameEnvelope,
      ...(input.number === undefined
        ? {}
        : { bank_account_number: input.number.envelope, bank_account_last4: input.number.last4 }),
      payout_blocked_at: null,
      banking_updated_at: input.now,
      banking_updated_by: input.actorId,
      banking_change_keys: appendChangeKey(input.changeKey),
    })
    .where('id', '=', teamId)
    .execute();
}

/** Appends a key to the replay list and keeps only the newest `CHANGE_KEYS_KEPT`. */
const CHANGE_KEYS_KEPT = 32;
const appendChangeKey = (changeKey: string) =>
  sql<
    string[]
  >`(array_append(banking_change_keys, ${changeKey}::uuid))[greatest(1, cardinality(banking_change_keys) + 2 - ${CHANGE_KEYS_KEPT}::int):]`;

/** Clears the block (all three columns together) and the payout block, and stamps who removed it and when. */
export async function clearBanking(
  db: Database,
  teamId: string,
  input: { now: Date; actorId: string; changeKey: string },
): Promise<void> {
  await db
    .updateTable('teams')
    .set({
      bank_account_name: null,
      bank_account_number: null,
      bank_account_last4: null,
      payout_blocked_at: null,
      banking_updated_at: input.now,
      banking_updated_by: input.actorId,
      banking_change_keys: appendChangeKey(input.changeKey),
    })
    .where('id', '=', teamId)
    .execute();
}

/** The one SQL definition of "the payout destination is still needed" (D-50); the removal trigger calls it too. */
export async function isBankingInUse(db: Database, teamId: string): Promise<boolean> {
  const { rows } = await sql<{ in_use: boolean }>`
    SELECT team_banking_in_use(${teamId}::uuid) AS in_use`.execute(db);
  return rows[0]?.in_use === true;
}

export interface AdminRecipient {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
}

/** Every approved admin of the team, ordered by id. Exact under the team lock. */
export async function listApprovedAdmins(
  db: Database,
  teamId: string,
): Promise<readonly AdminRecipient[]> {
  const rows = await db
    .selectFrom('team_members as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select(['u.id as user_id', 'u.email', 'u.full_name'])
    .where('m.team_id', '=', teamId)
    .where('m.role', '=', 'TEAM_ADMIN')
    .where('m.status', '=', 'APPROVED')
    .orderBy('u.id')
    .execute();
  return rows.map((row) => ({ userId: row.user_id, email: row.email, fullName: row.full_name }));
}

export async function getUserName(db: Database, userId: string): Promise<string> {
  const row = await db
    .selectFrom('users')
    .select('full_name')
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  return row.full_name;
}

export interface GstRow {
  readonly gstRegistered: boolean;
  readonly gstNumber: string | null;
}

export async function readGst(db: Database, teamId: string): Promise<GstRow | undefined> {
  const row = await db
    .selectFrom('teams')
    .select(['gst_registered', 'gst_number'])
    .where('id', '=', teamId)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : { gstRegistered: row.gst_registered, gstNumber: row.gst_number };
}

export async function writeGst(db: Database, teamId: string, input: GstRow): Promise<void> {
  await db
    .updateTable('teams')
    .set({ gst_registered: input.gstRegistered, gst_number: input.gstNumber })
    .where('id', '=', teamId)
    .execute();
}
