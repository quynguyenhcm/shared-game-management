/**
 * The GLOBAL_ADMIN "mark payout blocked" action over HTTP on a real PostgreSQL (wallet-and-akahu-billing Phase 4a part 3; A3,
 * CR-14; AC-ERROR-4 as amended by A3; ADR 0016 R3). One transaction: `teams FOR NO KEY UPDATE`, `payout_blocked_at` set when it is
 * not, one append-only `payout_block_events` row, one sealed email per approved team admin naming no account detail, and a
 * best-effort `akahu-cancel` for the team's intents still waiting for the payer (READY). The banking columns are never touched; the
 * generated `is_payout_configured` turns false, so publishing a paid session, starting a top-up and starting an attempt all answer
 * 409 `payout_not_configured`. Akahu is the stateless fake (provenance: synthetic).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import type { EmailMessage } from '../../src/lib/notifications/notifier.ts';
import { testCrypto } from '../helpers/app-deps.ts';
import { buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  insertAuthSession,
  insertPayment,
  insertPaymentAttempt,
  insertPublishedSession,
  insertRegistration,
  insertSession,
  insertTeam,
  insertTeamMember,
  insertUser,
  insertWalletTopUp,
} from '../helpers/factories.ts';
import { createRecordingJobs, type RecordingJobs } from '../helpers/registration-scene.ts';
import { call, errorOf, httpMember, type HttpMember } from '../helpers/registrations-http.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

const BASE = new Date('2026-11-10T00:00:00.000Z');
const DAY = 24 * 3_600_000;

const crypto = testCrypto();

let database: TestDatabase;
let jobs: RecordingJobs;
let h: AuthTestApp;

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 20 });
  jobs = createRecordingJobs();
  h = await buildAuthTestApp(database.pool, { jobs });
});
afterAll(async () => {
  await h.close();
  await database.close();
});
beforeEach(() => {
  h.clock.set(BASE);
  jobs.reset();
});

// ---------------------------------------------------------------------------------------------
// Scene and HTTP
// ---------------------------------------------------------------------------------------------

async function signedIn(userId: string): Promise<HttpMember> {
  const { token } = await insertAuthSession(database.pool, userId, {
    createdAt: h.clock.now(),
    idleDays: 90,
    absoluteDays: 180,
  });
  return { userId, token };
}
async function teamAdmin(teamId: string, email?: string): Promise<HttpMember> {
  const userId = await insertUser(database.pool, 'FEMALE', { email });
  await insertTeamMember(database.pool, { teamId, userId, role: 'TEAM_ADMIN' });
  return signedIn(userId);
}
async function globalAdmin(): Promise<HttpMember> {
  const userId = await insertUser(database.pool, 'FEMALE');
  await database.pool.query(`UPDATE users SET role = 'GLOBAL_ADMIN' WHERE id = $1`, [userId]);
  return signedIn(userId);
}

interface Scene {
  readonly teamId: string;
  readonly admins: readonly HttpMember[];
  readonly adminEmails: readonly string[];
  readonly member: HttpMember;
}

async function scene(): Promise<Scene> {
  const teamId = await insertTeam(database.pool, {
    name: 'Tuesday Smashers',
    payoutConfigured: true,
    sealWith: crypto,
  });
  const adminEmails = [`a-${randomUUID()}@example.test`, `b-${randomUUID()}@example.test`];
  const admins = [await teamAdmin(teamId, adminEmails[0]), await teamAdmin(teamId, adminEmails[1])];
  // The plain member (below) is not told: approved TEAM_ADMINs only.
  return { teamId, admins, adminEmails, member: await httpMember(h, teamId) };
}

const block = (
  who: HttpMember | null,
  teamId: string,
  body: unknown = { reason: 'AKAHU_REPORTED_ACCOUNT_PROBLEM', changeKey: randomUUID() },
): Promise<LightMyRequestResponse> =>
  call(h, 'POST', `/teams/${teamId}/payout-block`, who?.token ?? null, body);

interface TeamRow {
  payout_blocked_at: Date | null;
  is_payout_configured: boolean;
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_account_last4: string | null;
  banking_updated_at: Date | null;
  banking_updated_by: string | null;
}
async function teamRow(teamId: string): Promise<TeamRow> {
  const { rows } = await database.pool.query<TeamRow>(
    `SELECT payout_blocked_at, is_payout_configured, bank_account_name, bank_account_number, bank_account_last4,
            banking_updated_at, banking_updated_by
       FROM teams WHERE id = $1`,
    [teamId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no team');
  return row;
}
async function events(teamId: string) {
  const { rows } = await database.pool.query<{
    id: string;
    actor_user_id: string | null;
    reason: string;
    akahu_payment_id: string | null;
    change_key: string;
  }>(
    `SELECT id, actor_user_id, reason, akahu_payment_id, change_key FROM payout_block_events
      WHERE team_id = $1 ORDER BY created_at, id`,
    [teamId],
  );
  return rows;
}

/** Every email job, opened with the sender's keyring; each must be sealed and enqueued inside the block's transaction. */
function emails(): EmailMessage[] {
  return jobs.recorded
    .filter((job) => job.queue === 'send-email')
    .map((job) => {
      expect(job.inTransaction, 'the email is enqueued inside the block transaction').toBe(true);
      const data = job.data as { idempotencyKey: string; sealed?: string };
      expect(data.sealed, 'the payout-blocked email is sealed').toBeTypeOf('string');
      return JSON.parse(
        crypto.decrypt(data.sealed as string, {
          table: 'pgboss.job',
          column: 'data.send-email',
          rowId: data.idempotencyKey,
        }),
      ) as EmailMessage;
    });
}
const cancels = () =>
  jobs.recorded
    .filter((job) => job.queue === 'akahu-cancel')
    .map((job) => {
      expect(job.inTransaction).toBe(true);
      return job.data as { akahuPaymentId: string; source: string };
    });

// =============================================================================================

describe('POST /teams/:teamId/payout-block: policy and body (A3, CR-14)', () => {
  it('is GLOBAL_ADMIN only: the team admin, a member and an outsider are 403 before the body is read; 401 without a session', async () => {
    const s = await scene();
    for (const who of [s.admins[0] ?? null, s.member]) {
      const refused = await block(who, s.teamId, { not: 'even valid' });
      expect(refused.statusCode).toBe(403);
      expect(errorOf(refused).code).toBe('forbidden');
    }
    expect((await block(null, s.teamId)).statusCode).toBe(401);
    expect((await teamRow(s.teamId)).payout_blocked_at).toBeNull();
    expect(await events(s.teamId)).toEqual([]);
  });

  it('answers 404 for an unknown team and 422 for free text, an unknown reason or a malformed Akahu id', async () => {
    const ops = await globalAdmin();
    const unknown = await block(ops, randomUUID());
    expect(unknown.statusCode).toBe(404);
    expect(errorOf(unknown).code).toBe('not_found');
    const s = await scene();
    for (const body of [
      { reason: 'OTHER', changeKey: randomUUID(), note: '01-0902-0068389-000' },
      { reason: 'because', changeKey: randomUUID() },
      { reason: 'OTHER', changeKey: randomUUID(), akahuPaymentId: 'has spaces/and slashes' },
      { reason: 'OTHER' },
    ]) {
      const refused = await block(ops, s.teamId, body);
      expect(refused.statusCode, JSON.stringify(body)).toBe(422);
    }
    expect((await teamRow(s.teamId)).payout_blocked_at).toBeNull();
  });
});

describe('the block transaction (AC-ERROR-4 per A3, R3)', () => {
  it('sets payout_blocked_at, records one audit event, emails each approved admin once and never touches banking', async () => {
    const s = await scene();
    const ops = await globalAdmin();
    const before = await teamRow(s.teamId);
    const changeKey = randomUUID();
    const response = await block(ops, s.teamId, {
      reason: 'FUNDS_RETURNED',
      akahuPaymentId: 'pay_abc123',
      changeKey,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ payoutBlockedAt: BASE.toISOString(), alreadyBlocked: false });

    const after = await teamRow(s.teamId);
    expect(after.payout_blocked_at?.toISOString()).toBe(BASE.toISOString());
    expect(after.is_payout_configured).toBe(false);
    expect({ ...after, payout_blocked_at: null, is_payout_configured: true }).toEqual({
      ...before,
      payout_blocked_at: null,
      is_payout_configured: true,
    });
    expect(await events(s.teamId)).toEqual([
      expect.objectContaining({
        actor_user_id: ops.userId,
        reason: 'FUNDS_RETURNED',
        akahu_payment_id: 'pay_abc123',
        change_key: changeKey,
      }),
    ]);

    const sent = emails();
    expect(sent.map((email) => email.to).sort()).toEqual([...s.adminEmails].sort());
    for (const email of sent) {
      expect(email.subject).toBe("Payments to Tuesday Smashers's bank account are failing");
      expect(email.text).toContain(`/teams/${s.teamId}/manage/banking`);
      // No account name, number or last 4 digits.
      expect(email.text).not.toContain('Test Club Account');
      expect(email.text).not.toContain('8389');
      expect(email.text).not.toContain('0068389');
      expect(email.idempotencyKey).toMatch(
        new RegExp(`^payout-blocked:${s.teamId}:${BASE.getTime()}:`),
      );
    }
    const line = h.logs.lines().find((entry) => entry.event === 'billing.payout.blocked');
    expect(line).toMatchObject({
      teamId: s.teamId,
      actorId: ops.userId,
      blockReason: 'FUNDS_RETURNED',
      alreadyBlocked: false,
    });
    expect(JSON.stringify(line)).not.toContain('8389');
  });

  it('a replay of the same changeKey answers the same and writes and sends nothing more', async () => {
    const s = await scene();
    const ops = await globalAdmin();
    const body = { reason: 'TEAM_REQUESTED', changeKey: randomUUID() };
    const first = await block(ops, s.teamId, body);
    jobs.reset();
    h.clock.set(new Date(BASE.getTime() + 60_000));
    const replay = await block(ops, s.teamId, body);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(await events(s.teamId)).toHaveLength(1);
    expect(jobs.recorded).toEqual([]);
  });

  it('a second block while blocked keeps the first instant, is audited, and emails nobody again', async () => {
    const s = await scene();
    const ops = await globalAdmin();
    await block(ops, s.teamId);
    jobs.reset();
    h.clock.set(new Date(BASE.getTime() + DAY));
    const again = await block(ops, s.teamId, { reason: 'OTHER', changeKey: randomUUID() });
    expect(again.json()).toEqual({ payoutBlockedAt: BASE.toISOString(), alreadyBlocked: true });
    expect((await teamRow(s.teamId)).payout_blocked_at?.toISOString()).toBe(BASE.toISOString());
    expect(await events(s.teamId)).toHaveLength(2);
    expect(emails()).toEqual([]);
  });

  it("enqueues a best-effort cancel for the team's intents still waiting for the payer, never for one in flight or held", async () => {
    const s = await scene();
    const other = await scene();
    const { sessionId } = await insertPublishedSession(database.pool, s.teamId, {
      now: new Date(BASE.getTime() - 5 * DAY),
      flat: '17.00',
    });
    const charge = async (teamId: string, sid: string): Promise<string> => {
      const userId = (await httpMember(h, teamId)).userId;
      const registrationId = await insertRegistration(database.pool, {
        sessionId: sid,
        teamId,
        userId,
      });
      return insertPayment(database.pool, {
        userId,
        teamId,
        registrationId,
        amount: '17.00',
        dueDate: new Date(BASE.getTime() + 2 * DAY),
      });
    };
    const ready = `fake_ok_1700_${BASE.getTime()}_ready`;
    const inFlight = `fake_ok_1700_${BASE.getTime()}_flight`;
    const held = `fake_ok_1700_${BASE.getTime()}_held`;
    const topUp = `fake_ok_2000_${BASE.getTime()}_topup`;
    const otherTeam = `fake_ok_1700_${BASE.getTime()}_other`;
    await insertPaymentAttempt(database.pool, {
      paymentId: await charge(s.teamId, sessionId),
      amount: '17.00',
      status: 'OPEN',
      akahuPaymentId: ready,
    });
    await insertPaymentAttempt(database.pool, {
      paymentId: await charge(s.teamId, sessionId),
      amount: '17.00',
      status: 'OPEN',
      akahuPaymentId: inFlight,
      akahuStatus: 'AUTHORISED',
    });
    await insertPaymentAttempt(database.pool, {
      paymentId: await charge(s.teamId, sessionId),
      amount: '17.00',
      status: 'HELD',
      akahuPaymentId: held,
    });
    await insertWalletTopUp(database.pool, {
      userId: s.member.userId,
      teamId: s.teamId,
      amount: '20.00',
      status: 'OPEN',
      akahuPaymentId: topUp,
    });
    const { sessionId: otherSession } = await insertPublishedSession(database.pool, other.teamId, {
      now: new Date(BASE.getTime() - 5 * DAY),
      flat: '17.00',
    });
    await insertPaymentAttempt(database.pool, {
      paymentId: await charge(other.teamId, otherSession),
      amount: '17.00',
      status: 'OPEN',
      akahuPaymentId: otherTeam,
    });

    expect((await block(await globalAdmin(), s.teamId)).statusCode).toBe(200);
    expect(cancels().sort((a, b) => a.akahuPaymentId.localeCompare(b.akahuPaymentId))).toEqual(
      [
        { akahuPaymentId: ready, source: 'payout_block' },
        { akahuPaymentId: topUp, source: 'payout_block' },
      ].sort((a, b) => a.akahuPaymentId.localeCompare(b.akahuPaymentId)),
    );
  });
});

describe('after the block (AC-ERROR-4 Then clause)', () => {
  it('refuses publishing a paid session, starting a top-up and starting an attempt with 409 payout_not_configured', async () => {
    const s = await scene();
    const draft = await insertSession(
      database.pool,
      s.teamId,
      { flat: '17.00' },
      { date: '2026-11-20' },
    );
    const { sessionId } = await insertPublishedSession(database.pool, s.teamId, {
      now: new Date(BASE.getTime() - 5 * DAY),
      flat: '17.00',
    });
    const registrationId = await insertRegistration(database.pool, {
      sessionId,
      teamId: s.teamId,
      userId: s.member.userId,
    });
    const paymentId = await insertPayment(database.pool, {
      userId: s.member.userId,
      teamId: s.teamId,
      registrationId,
      amount: '17.00',
      dueDate: new Date(BASE.getTime() + 2 * DAY),
    });

    expect((await block(await globalAdmin(), s.teamId)).statusCode).toBe(200);

    const publish = await call(
      h,
      'POST',
      `/teams/${s.teamId}/sessions/${draft}/publish`,
      s.admins[0]?.token ?? null,
      {
        expectedVersion: (
          await database.pool.query<{ version: number }>(
            'SELECT version FROM game_sessions WHERE id = $1',
            [draft],
          )
        ).rows[0]?.version,
      },
    );
    expect(publish.statusCode, publish.body).toBe(409);
    expect(errorOf(publish).code).toBe('payout_not_configured');

    const topUp = await call(h, 'POST', `/teams/${s.teamId}/wallet/top-ups`, s.member.token, {
      amount: '20.00',
      idempotencyKey: randomUUID(),
    });
    expect(topUp.statusCode).toBe(409);
    expect(errorOf(topUp).code).toBe('payout_not_configured');

    const attempt = await call(h, 'POST', `/payments/${paymentId}/attempts`, s.member.token, {
      idempotencyKey: randomUUID(),
    });
    expect(attempt.statusCode).toBe(409);
    expect(errorOf(attempt).code).toBe('payout_not_configured');
  });
});
