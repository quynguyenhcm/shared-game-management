/**
 * Shared scaffolding for the team banking and GST integration tests: people with real sessions, teams with
 * approved admins, the five routes as one-liners and a raw read of the `teams` row with the real keyring.
 * Account numbers are hand-valid vectors from `packages/shared/src/nz/bank-account.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import type { FieldCrypto } from '../../src/lib/crypto/crypto.ts';
import { testCrypto } from './app-deps.ts';
import { bearer, type AuthTestApp } from './auth-app.ts';
import { insertAuthSession, insertTeam, insertTeamMember, insertUser } from './factories.ts';
import type { TestDatabase } from './test-db.ts';

export interface TestAccount {
  /** As a user would type it (2-digit suffix). */
  readonly input: string;
  /** As stored: suffix padded to 3 digits. */
  readonly canonical: string;
  readonly last4: string;
}

export const ACCOUNT_A: TestAccount = {
  input: '01-0902-0068389-00',
  canonical: '01-0902-0068389-000',
  last4: '8389',
};
export const ACCOUNT_B: TestAccount = {
  input: '12-3040-0123455-00',
  canonical: '12-3040-0123455-000',
  last4: '3455',
};
export const ACCOUNT_C: TestAccount = {
  input: '08-6523-1954512-001',
  canonical: '08-6523-1954512-001',
  last4: '4512',
};

/** Valid GST numbers (IRD check digits): `49-091-850` and `136-410-132`. */
export const GST_A = { input: '49-091-850', canonical: '49091850' } as const;
export const GST_B = { input: '136-410-132', canonical: '136410132' } as const;

export interface Person {
  readonly id: string;
  readonly token: string;
  readonly fullName: string;
  readonly email: string;
}

export interface TeamsRow {
  readonly bank_account_name: string | null;
  readonly bank_account_number: string | null;
  readonly bank_account_last4: string | null;
  readonly is_payout_configured: boolean;
  readonly payout_blocked_at: Date | null;
  readonly banking_updated_at: Date | null;
  readonly banking_updated_by: string | null;
  readonly gst_registered: boolean;
  readonly gst_number: string | null;
  readonly ird_number: string | null;
  readonly akahu_merchant_id: string | null;
  readonly akahu_app_token: string | null;
}

export interface BankingBody {
  banking: {
    isPayoutConfigured: boolean;
    payoutBlocked: boolean;
    accountName: string | null;
    unreadable: boolean;
    accountNumberLast4: string | null;
    lastChanged: { at: string; by: { fullName: string } | null } | null;
  };
}

export interface GstBody {
  gst: { gstRegistered: boolean; gstNumber: string | null };
}

export interface ErrorBody {
  error: { code: string; message: string; fieldErrors?: Record<string, string[]> };
}

export type BankingPayload = Record<string, unknown>;

export function createBankingScene(
  h: AuthTestApp,
  database: TestDatabase,
  /** The keyring the app under test seals with (the default test keyring unless the test rotates keys). */
  crypto: FieldCrypto = testCrypto(),
) {
  let counter = 0;

  async function person(fullName?: string): Promise<Person> {
    counter += 1;
    const name = fullName ?? `Banker ${String(counter).padStart(4, '0')}`;
    const email = `banker-${counter}-${randomUUID().slice(0, 8)}@example.test`;
    const id = await insertUser(database.pool, 'FEMALE', { email });
    await database.pool.query(`UPDATE users SET full_name = $2 WHERE id = $1`, [id, name]);
    const { token } = await insertAuthSession(database.pool, id, { createdAt: h.clock.now() });
    return { id, token, fullName: name, email };
  }

  /** A team (optionally already configured) with the given people as approved admins. */
  async function team(
    admins: readonly Person[],
    options: { payoutConfigured?: boolean; name?: string } = {},
  ): Promise<string> {
    counter += 1;
    const teamId = await insertTeam(database.pool, {
      name: options.name ?? `Banking Team ${counter}`,
      ...(options.payoutConfigured === true ? { payoutConfigured: true } : {}),
    });
    for (const admin of admins) {
      await insertTeamMember(database.pool, { teamId, userId: admin.id, role: 'TEAM_ADMIN' });
    }
    return teamId;
  }

  type Method = 'GET' | 'PUT' | 'DELETE';
  const call = (
    method: Method,
    url: string,
    who: Person | null,
    payload?: unknown,
  ): Promise<LightMyRequestResponse> =>
    h.app.inject({
      method,
      url,
      ...(who === null ? {} : { headers: bearer(who.token) }),
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  /** A valid banking body; `accountNumber` is omitted when `undefined`. */
  const body = (
    accountName: string,
    account: TestAccount | undefined,
    extra: BankingPayload = {},
  ): BankingPayload => ({
    accountName,
    ...(account === undefined ? {} : { accountNumber: account.input }),
    changeKey: randomUUID(),
    ...extra,
  });

  async function row(teamId: string): Promise<TeamsRow> {
    const { rows } = await database.pool.query<TeamsRow>(
      `SELECT bank_account_name, bank_account_number, bank_account_last4, is_payout_configured,
              payout_blocked_at, banking_updated_at, banking_updated_by, gst_registered, gst_number,
              ird_number, akahu_merchant_id, akahu_app_token
         FROM teams WHERE id = $1`,
      [teamId],
    );
    const found = rows[0];
    if (found === undefined) throw new Error('team row missing');
    return found;
  }

  /** The stored name and number decrypted with the real keyring under their AAD. */
  async function opened(teamId: string): Promise<{ name: string | null; number: string | null }> {
    const stored = await row(teamId);
    const open = (value: string | null, column: string): string | null =>
      value === null ? null : crypto.decrypt(value, { table: 'teams', column, rowId: teamId });
    return {
      name: open(stored.bank_account_name, 'bank_account_name'),
      number: open(stored.bank_account_number, 'bank_account_number'),
    };
  }

  return {
    crypto,
    person,
    team,
    row,
    opened,
    body,
    call,
    getBanking: (teamId: string, who: Person | null) =>
      call('GET', `/teams/${teamId}/banking`, who),
    putBanking: (teamId: string, who: Person | null, payload: unknown) =>
      call('PUT', `/teams/${teamId}/banking`, who, payload),
    deleteBanking: (teamId: string, who: Person | null) =>
      call('DELETE', `/teams/${teamId}/banking`, who),
    getGst: (teamId: string, who: Person | null) => call('GET', `/teams/${teamId}/gst`, who),
    putGst: (teamId: string, who: Person | null, payload: unknown) =>
      call('PUT', `/teams/${teamId}/gst`, who, payload),
  };
}

export type BankingScene = ReturnType<typeof createBankingScene>;

/** `send-email` jobs in `pgboss.job` for one team's banking-changed notifications. */
export interface EmailJobRow {
  readonly singleton_key: string | null;
  readonly data: Record<string, unknown>;
}

export async function bankingEmailJobs(
  database: TestDatabase,
  teamId: string,
): Promise<EmailJobRow[]> {
  const { rows } = await database.pool.query<EmailJobRow>(
    `SELECT singleton_key, data FROM pgboss.job
      WHERE name = 'send-email' AND singleton_key LIKE $1 ORDER BY singleton_key`,
    [`notify:banking-changed:${teamId}:%`],
  );
  return rows;
}
