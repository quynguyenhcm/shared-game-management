/**
 * Resolving a held Akahu payment or top-up by hand over HTTP on a real PostgreSQL (wallet-and-akahu-billing Phase 4a part 3;
 * CR-15, CR-26, CR-27 grace, H2, B3; algorithm doc F / RF-7). Every resolution first re-reads Akahu OUTSIDE any lock: a definite
 * provider answer wins (409 `hold_resolved_by_provider`; a SENT for the right amount is applied through the funnel). Otherwise the
 * single apply funnel writes the outcome under the CR-4 locks: RECEIVED -> APPLIED (cap and duplicate rules apply) or, for an
 * observed amount that differs, UNAPPLIED (AMOUNT_MISMATCH); NOT_RECEIVED -> CLOSED with the 24 h grace and email 7. Who may act:
 * team admins of the payee team and GLOBAL_ADMIN (H2). Akahu is the stateless fake with its scripting overlay (provenance:
 * synthetic).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { createFakeControl, createFakePaymentsGateway } from '../../src/lib/akahu/fake-adapter.ts';
import type { PaymentsGateway } from '../../src/lib/akahu/gateway.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import type { EmailMessage } from '../../src/lib/notifications/notifier.ts';
import { testCrypto } from '../helpers/app-deps.ts';
import { buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  insertAuthSession,
  insertPayment,
  insertPaymentAttempt,
  insertPublishedSession,
  insertRegistration,
  insertTeam,
  insertTeamMember,
  insertUser,
  insertWallet,
  insertWalletTopUp,
} from '../helpers/factories.ts';
import { createRecordingJobs, type RecordingJobs } from '../helpers/registration-scene.ts';
import {
  call,
  errorOf,
  httpMember,
  httpOutsider,
  type HttpMember,
} from '../helpers/registrations-http.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

const BASE = new Date('2026-11-10T00:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const crypto = testCrypto();
const providerClock = createManualClock(BASE);
const control = createFakeControl();

let database: TestDatabase;
let jobs: RecordingJobs;
let h: AuthTestApp;
let getPaymentCalls = 0;

function countingGateway(): PaymentsGateway {
  const inner = createFakePaymentsGateway({ clock: providerClock, control });
  return {
    ...inner,
    getPayment(id) {
      getPaymentCalls += 1;
      return inner.getPayment(id);
    },
  };
}

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 20 });
  jobs = createRecordingJobs();
  h = await buildAuthTestApp(database.pool, { jobs, paymentsGateway: countingGateway() });
});
afterAll(async () => {
  await h.close();
  await database.close();
});
beforeEach(() => {
  h.clock.set(BASE);
  providerClock.set(BASE);
  control.reset();
  jobs.reset();
  getPaymentCalls = 0;
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
  readonly sessionId: string;
  readonly admin: HttpMember;
  readonly adminEmails: readonly string[];
  readonly payer: HttpMember;
}

async function scene(): Promise<Scene> {
  const teamId = await insertTeam(database.pool, {
    name: 'Tuesday Smashers',
    payoutConfigured: true,
    sealWith: crypto,
  });
  const adminEmails = [`a-${randomUUID()}@example.test`, `b-${randomUUID()}@example.test`];
  const admin = await teamAdmin(teamId, adminEmails[0]);
  await teamAdmin(teamId, adminEmails[1]);
  const { sessionId } = await insertPublishedSession(database.pool, teamId, {
    now: new Date(BASE.getTime() - 5 * DAY),
    flat: '17.00',
  });
  return { teamId, sessionId, admin, adminEmails, payer: await httpMember(h, teamId) };
}

/** A provider id the fake reads: `fake_<scenario>_<cents>_<createdAtMs>_<rand>` (created a minute before BASE). */
const providerId = (cents: number): string =>
  `fake_ok_${cents}_${BASE.getTime() - 60_000}_${randomBytes(4).toString('hex')}`;
const script = (id: string, providerStatus: string, providerStatusReason: string | null = null) =>
  control.scriptGet(id, [{ providerStatus, providerStatusReason }]);
const stillIndeterminate = (id: string) => script(id, 'FAILED', 'BANK_ERROR_INDETERMINATE');

interface HeldPayment {
  readonly paymentId: string;
  readonly attemptId: string;
  readonly akahuPaymentId: string;
}

async function heldPayment(
  s: Scene,
  options: {
    holdReason?: 'INDETERMINATE' | 'AMOUNT_MISMATCH';
    providerCents?: number;
    dueDate?: Date;
    status?: 'PENDING' | 'OVERDUE';
  } = {},
): Promise<HeldPayment> {
  // One session per held payment: a player has one registration per session.
  const { sessionId } = await insertPublishedSession(database.pool, s.teamId, {
    now: new Date(BASE.getTime() - 4 * DAY),
    flat: '17.00',
  });
  const registrationId = await insertRegistration(database.pool, {
    sessionId,
    teamId: s.teamId,
    userId: s.payer.userId,
  });
  const paymentId = await insertPayment(database.pool, {
    userId: s.payer.userId,
    teamId: s.teamId,
    registrationId,
    amount: '17.00',
    dueDate: options.dueDate ?? new Date(BASE.getTime() + 2 * DAY),
    ...(options.status === undefined ? {} : { status: options.status }),
  });
  const akahuPaymentId = providerId(options.providerCents ?? 1700);
  const attemptId = await insertPaymentAttempt(database.pool, {
    paymentId,
    amount: '17.00',
    status: 'HELD',
    akahuPaymentId,
    akahuStatus: 'SUBMITTED',
    holdReason: options.holdReason ?? 'INDETERMINATE',
  });
  return { paymentId, attemptId, akahuPaymentId };
}

const resolvePayment = (
  who: HttpMember | null,
  paymentId: string,
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> =>
  call(h, 'POST', `/payments/${paymentId}/hold-resolution`, who?.token ?? null, {
    changeKey: randomUUID(),
    ...body,
  });
const resolveTopUp = (
  who: HttpMember | null,
  teamId: string,
  topUpId: string,
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> =>
  call(
    h,
    'POST',
    `/teams/${teamId}/wallet/top-ups/${topUpId}/hold-resolution`,
    who?.token ?? null,
    { changeKey: randomUUID(), ...body },
  );

interface Row {
  [key: string]: unknown;
}
async function one(sqlText: string, values: unknown[]): Promise<Row> {
  const { rows } = await database.pool.query<Row>(sqlText, values);
  const row = rows[0];
  if (row === undefined) throw new Error(`no row for ${sqlText}`);
  return row;
}
const paymentOf = (id: string) =>
  one(`SELECT status, paid_at, due_date, akahu_payment_id FROM payments WHERE id = $1`, [id]);
const attemptOf = (id: string) =>
  one(
    `SELECT status, unapplied_reason, close_reason, resolution_reason, resolved_by, resolved_at, observed_amount
       FROM payment_attempts WHERE id = $1`,
    [id],
  );
const topUpOf = (id: string) =>
  one(
    `SELECT status, unapplied_reason, close_reason, resolution_reason, resolved_by, resolved_at
       FROM wallet_top_ups WHERE id = $1`,
    [id],
  );
async function balanceOf(userId: string, teamId: string): Promise<string | null> {
  const { rows } = await database.pool.query<{ balance: string }>(
    `SELECT balance FROM player_credits WHERE user_id = $1 AND team_id = $2`,
    [userId, teamId],
  );
  return rows[0]?.balance ?? null;
}

function emails(): EmailMessage[] {
  return jobs.recorded
    .filter((job) => job.queue === 'send-email')
    .map((job) => {
      expect(job.inTransaction, 'an email is enqueued inside the resolution transaction').toBe(
        true,
      );
      const data = job.data as { idempotencyKey: string; sealed?: string };
      expect(data.sealed, 'every resolution email is sealed').toBeTypeOf('string');
      return JSON.parse(
        crypto.decrypt(data.sealed as string, {
          table: 'pgboss.job',
          column: 'data.send-email',
          rowId: data.idempotencyKey,
        }),
      ) as EmailMessage;
    });
}

// =============================================================================================
// Payments
// =============================================================================================

describe('POST /payments/:paymentId/hold-resolution: RECEIVED (CR-15, CR-26)', () => {
  it('re-reads Akahu first, then a payee-team admin marks it received: attempt APPLIED, payment PAID once, email 5 after a hold', async () => {
    const s = await scene();
    const held = await heldPayment(s);
    stillIndeterminate(held.akahuPaymentId);
    const response = await resolvePayment(s.admin, held.paymentId, { outcome: 'RECEIVED' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      intentStatus: 'APPLIED',
      resolutionReason: 'RECEIVED',
      resolvedAt: BASE.toISOString(),
    });
    expect(getPaymentCalls).toBe(1);
    expect(await paymentOf(held.paymentId)).toMatchObject({
      status: 'PAID',
      akahu_payment_id: held.akahuPaymentId,
    });
    expect(await attemptOf(held.attemptId)).toMatchObject({
      status: 'APPLIED',
      resolution_reason: 'RECEIVED',
      resolved_by: s.admin.userId,
      observed_amount: null,
    });
    const [received] = emails();
    expect(received?.idempotencyKey).toBe(`payment-received:${held.paymentId}`);
    expect(received?.text).toContain('We checked with your bank and your payment went through.');
    expect(h.logs.lines().find((line) => line.event === 'billing.hold.resolved')).toMatchObject({
      intentKind: 'ATTEMPT',
      intentId: held.attemptId,
      outcome: 'RECEIVED',
      resolutionReason: 'RECEIVED',
      actorId: s.admin.userId,
    });
  });

  it('a replay answers the same from the record without calling Akahu or sending anything; a contradicting one is 409', async () => {
    const s = await scene();
    const held = await heldPayment(s);
    stillIndeterminate(held.akahuPaymentId);
    const changeKey = randomUUID();
    const first = await resolvePayment(s.admin, held.paymentId, { outcome: 'RECEIVED', changeKey });
    jobs.reset();
    getPaymentCalls = 0;
    h.clock.set(new Date(BASE.getTime() + HOUR));
    const replay = await resolvePayment(s.admin, held.paymentId, {
      outcome: 'RECEIVED',
      changeKey,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(getPaymentCalls).toBe(0);
    expect(jobs.recorded).toEqual([]);
    const contradicting = await resolvePayment(s.admin, held.paymentId, {
      outcome: 'NOT_RECEIVED',
    });
    expect(contradicting.statusCode).toBe(409);
    expect(errorOf(contradicting).code).toBe('conflict');
    expect((await paymentOf(held.paymentId)).status).toBe('PAID');
  });

  it('an AMOUNT_MISMATCH hold needs observedAmount; a different figure is recorded UNAPPLIED with the B3 notices, an equal one pays', async () => {
    const s = await scene();
    const mismatch = await heldPayment(s, { holdReason: 'AMOUNT_MISMATCH', providerCents: 1600 });
    script(mismatch.akahuPaymentId, 'SENT');
    const missing = await resolvePayment(s.admin, mismatch.paymentId, { outcome: 'RECEIVED' });
    expect(missing.statusCode).toBe(422);
    expect(errorOf(missing)).toMatchObject({
      code: 'validation_failed',
      fieldErrors: { observedAmount: [expect.any(String)] },
    });
    expect((await attemptOf(mismatch.attemptId)).status).toBe('HELD');

    script(mismatch.akahuPaymentId, 'SENT');
    const recorded = await resolvePayment(s.admin, mismatch.paymentId, {
      outcome: 'RECEIVED',
      observedAmount: '16.00',
    });
    expect(recorded.statusCode, recorded.body).toBe(200);
    expect(recorded.json()).toMatchObject({
      intentStatus: 'UNAPPLIED',
      resolutionReason: 'AMOUNT_MISMATCH',
    });
    expect(await attemptOf(mismatch.attemptId)).toMatchObject({
      status: 'UNAPPLIED',
      unapplied_reason: 'AMOUNT_MISMATCH',
      observed_amount: '16.00',
    });
    // The payment stays payable: no PAID, and the payer can start a fresh attempt.
    expect((await paymentOf(mismatch.paymentId)).status).toBe('PENDING');
    const sent = emails();
    expect(sent.map((email) => email.to)).toHaveLength(3);
    expect(sent.every((email) => email.text.includes('$16.00'))).toBe(true);
    const retry = await call(h, 'POST', `/payments/${mismatch.paymentId}/attempts`, s.payer.token, {
      idempotencyKey: randomUUID(),
    });
    expect(retry.statusCode, retry.body).toBe(201);

    const equal = await heldPayment(s, { holdReason: 'AMOUNT_MISMATCH', providerCents: 1600 });
    script(equal.akahuPaymentId, 'SENT');
    const paid = await resolvePayment(s.admin, equal.paymentId, {
      outcome: 'RECEIVED',
      observedAmount: '17.00',
    });
    expect(paid.json()).toMatchObject({ intentStatus: 'APPLIED', resolutionReason: 'RECEIVED' });
    expect(await paymentOf(equal.paymentId)).toMatchObject({ status: 'PAID' });
    expect((await attemptOf(equal.attemptId)).observed_amount).toBe('17.00');
  });

  it('a payment someone already paid by another attempt is recorded UNAPPLIED (DUPLICATE), never PAID twice', async () => {
    const s = await scene();
    const held = await heldPayment(s);
    await database.pool.query(`UPDATE payments SET status = 'PAID', paid_at = $2 WHERE id = $1`, [
      held.paymentId,
      BASE,
    ]);
    stillIndeterminate(held.akahuPaymentId);
    const response = await resolvePayment(s.admin, held.paymentId, { outcome: 'RECEIVED' });
    expect(response.json()).toMatchObject({
      intentStatus: 'UNAPPLIED',
      resolutionReason: 'RECEIVED',
    });
    expect(await attemptOf(held.attemptId)).toMatchObject({ unapplied_reason: 'DUPLICATE' });
  });
});

describe('POST /payments/:paymentId/hold-resolution: NOT_RECEIVED (CR-26, CR-27)', () => {
  it('closes the attempt, gives a PENDING payment 24 h from now (never less than before) and sends email 7 after a hold', async () => {
    const s = await scene();
    const soon = await heldPayment(s, { dueDate: new Date(BASE.getTime() + 2 * HOUR) });
    stillIndeterminate(soon.akahuPaymentId);
    const response = await resolvePayment(s.admin, soon.paymentId, { outcome: 'NOT_RECEIVED' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      intentStatus: 'CLOSED',
      resolutionReason: 'NOT_RECEIVED_INDETERMINATE',
      resolvedAt: BASE.toISOString(),
    });
    expect(await attemptOf(soon.attemptId)).toMatchObject({
      status: 'CLOSED',
      close_reason: 'ops_not_received',
      resolved_by: s.admin.userId,
    });
    const payment = await paymentOf(soon.paymentId);
    expect(payment.status).toBe('PENDING');
    expect((payment.due_date as Date).toISOString()).toBe(
      new Date(BASE.getTime() + DAY).toISOString(),
    );
    const [notCompleted] = emails();
    expect(notCompleted?.idempotencyKey).toBe(`payment-not-completed:${soon.attemptId}`);
    expect(notCompleted?.text).toContain(
      "We checked with your bank: the payment didn't go through.",
    );

    // Grace never shortens a later due date.
    const later = await heldPayment(s, { dueDate: new Date(BASE.getTime() + 3 * DAY) });
    script(later.akahuPaymentId, 'CANCELLED', 'TIMED_OUT');
    const notSent = await resolvePayment(s.admin, later.paymentId, { outcome: 'NOT_RECEIVED' });
    expect(notSent.json()).toMatchObject({ resolutionReason: 'NOT_RECEIVED_NOT_SENT' });
    expect(((await paymentOf(later.paymentId)).due_date as Date).toISOString()).toBe(
      new Date(BASE.getTime() + 3 * DAY).toISOString(),
    );

    // Payable again.
    const retry = await call(h, 'POST', `/payments/${soon.paymentId}/attempts`, s.payer.token, {
      idempotencyKey: randomUUID(),
    });
    expect(retry.statusCode, retry.body).toBe(201);
  });

  it('never moves an OVERDUE payment back and keeps its due date', async () => {
    const s = await scene();
    const due = new Date(BASE.getTime() - DAY);
    const held = await heldPayment(s, { dueDate: due, status: 'OVERDUE' });
    stillIndeterminate(held.akahuPaymentId);
    await resolvePayment(s.admin, held.paymentId, { outcome: 'NOT_RECEIVED' });
    const payment = await paymentOf(held.paymentId);
    expect(payment.status).toBe('OVERDUE');
    expect((payment.due_date as Date).toISOString()).toBe(due.toISOString());
  });
});

describe('a definite provider answer wins (CR-26)', () => {
  it('a fresh SENT for the right amount is applied by the funnel and the manual NOT_RECEIVED is refused 409', async () => {
    const s = await scene();
    const held = await heldPayment(s);
    script(held.akahuPaymentId, 'SENT');
    const response = await resolvePayment(s.admin, held.paymentId, { outcome: 'NOT_RECEIVED' });
    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe('hold_resolved_by_provider');
    expect((await paymentOf(held.paymentId)).status).toBe('PAID');
    expect(await attemptOf(held.attemptId)).toMatchObject({
      status: 'APPLIED',
      resolved_by: null,
      resolution_reason: null,
    });
  });

  it('a fresh not-charged answer refuses RECEIVED (nothing changes), and a fresh SENT for another amount refuses NOT_RECEIVED', async () => {
    const s = await scene();
    const cancelled = await heldPayment(s);
    script(cancelled.akahuPaymentId, 'CANCELLED', 'TIMED_OUT');
    const refused = await resolvePayment(s.admin, cancelled.paymentId, { outcome: 'RECEIVED' });
    expect(refused.statusCode).toBe(409);
    expect(errorOf(refused).code).toBe('hold_resolved_by_provider');
    expect((await attemptOf(cancelled.attemptId)).status).toBe('HELD');
    expect((await paymentOf(cancelled.paymentId)).status).toBe('PENDING');

    const moved = await heldPayment(s, { holdReason: 'AMOUNT_MISMATCH', providerCents: 1600 });
    script(moved.akahuPaymentId, 'SENT');
    const notReceived = await resolvePayment(s.admin, moved.paymentId, {
      outcome: 'NOT_RECEIVED',
    });
    expect(errorOf(notReceived).code).toBe('hold_resolved_by_provider');
    expect((await attemptOf(moved.attemptId)).status).toBe('HELD');
  });

  it('answers 503 when Akahu cannot be read and changes nothing', async () => {
    const s = await scene();
    const held = await heldPayment(s);
    control.failNextGet('5xx');
    const response = await resolvePayment(s.admin, held.paymentId, { outcome: 'RECEIVED' });
    expect(response.statusCode).toBe(503);
    expect(errorOf(response).code).toBe('payment_provider_unavailable');
    expect((await attemptOf(held.attemptId)).status).toBe('HELD');
  });

  it('answers 409 when the payment has no held attempt', async () => {
    const s = await scene();
    const registrationId = await insertRegistration(database.pool, {
      sessionId: s.sessionId,
      teamId: s.teamId,
      userId: s.payer.userId,
    });
    const paymentId = await insertPayment(database.pool, {
      userId: s.payer.userId,
      teamId: s.teamId,
      registrationId,
      amount: '17.00',
      dueDate: new Date(BASE.getTime() + DAY),
    });
    await insertPaymentAttempt(database.pool, {
      paymentId,
      amount: '17.00',
      status: 'OPEN',
      akahuPaymentId: providerId(1700),
    });
    const response = await resolvePayment(s.admin, paymentId, { outcome: 'RECEIVED' });
    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe('conflict');
    expect(getPaymentCalls).toBe(0);
  });
});

describe('who may resolve a payment hold (H2)', () => {
  it('payee-team admins and GLOBAL_ADMIN may; another team admin and an outsider get 404, a member 403, nobody 401', async () => {
    const s = await scene();
    const other = await scene();
    const held = await heldPayment(s);
    for (const who of [other.admin, await httpOutsider(h)]) {
      const hidden = await resolvePayment(who, held.paymentId, { outcome: 'RECEIVED' });
      expect(hidden.statusCode).toBe(404);
      expect(errorOf(hidden).code).toBe('not_found');
    }
    // The payer is a plain member of the payee team.
    const member = await resolvePayment(s.payer, held.paymentId, { outcome: 'RECEIVED' });
    expect(member.statusCode).toBe(403);
    expect((await resolvePayment(null, held.paymentId, { outcome: 'RECEIVED' })).statusCode).toBe(
      401,
    );
    const unknown = await resolvePayment(s.admin, randomUUID(), { outcome: 'RECEIVED' });
    expect(unknown.statusCode).toBe(404);
    expect(getPaymentCalls).toBe(0);
    expect((await attemptOf(held.attemptId)).status).toBe('HELD');

    const ops = await globalAdmin();
    stillIndeterminate(held.akahuPaymentId);
    const resolved = await resolvePayment(ops, held.paymentId, { outcome: 'RECEIVED' });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect((await attemptOf(held.attemptId)).resolved_by).toBe(ops.userId);
  });
});

// =============================================================================================
// Top-ups
// =============================================================================================

describe('POST /teams/:teamId/wallet/top-ups/:topUpId/hold-resolution', () => {
  async function heldTopUp(s: Scene, amount: string, balance: string | null) {
    if (balance !== null) await insertWallet(database.pool, s.payer.userId, s.teamId, balance);
    const akahuPaymentId = providerId(Math.round(Number.parseFloat(amount) * 100));
    const topUpId = await insertWalletTopUp(database.pool, {
      userId: s.payer.userId,
      teamId: s.teamId,
      amount,
      status: 'HELD',
      akahuPaymentId,
      akahuStatus: 'SUBMITTED',
    });
    return { topUpId, akahuPaymentId };
  }

  it('RECEIVED credits the wallet by the intent amount and emails the new balance', async () => {
    const s = await scene();
    const held = await heldTopUp(s, '30.00', '15.00');
    stillIndeterminate(held.akahuPaymentId);
    const response = await resolveTopUp(s.admin, s.teamId, held.topUpId, { outcome: 'RECEIVED' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      intentStatus: 'APPLIED',
      resolutionReason: 'RECEIVED',
    });
    expect(await balanceOf(s.payer.userId, s.teamId)).toBe('45.00');
    expect(await topUpOf(held.topUpId)).toMatchObject({ resolved_by: s.admin.userId });
    expect(emails().map((email) => email.idempotencyKey)).toEqual([
      `top-up-received:${held.topUpId}`,
    ]);
  });

  it('RECEIVED over the cap is UNAPPLIED (OVER_CAP): no credit, B3 notices to the player and every admin', async () => {
    const s = await scene();
    const held = await heldTopUp(s, '30.00', '80.00');
    stillIndeterminate(held.akahuPaymentId);
    const response = await resolveTopUp(s.admin, s.teamId, held.topUpId, { outcome: 'RECEIVED' });
    expect(response.json()).toMatchObject({
      intentStatus: 'UNAPPLIED',
      resolutionReason: 'RECEIVED',
    });
    expect(await topUpOf(held.topUpId)).toMatchObject({ unapplied_reason: 'OVER_CAP' });
    expect(await balanceOf(s.payer.userId, s.teamId)).toBe('80.00');
    expect(emails()).toHaveLength(3);
  });

  it('NOT_RECEIVED closes it with the after-hold notice and frees the wallet for a new top-up', async () => {
    const s = await scene();
    const held = await heldTopUp(s, '20.00', null);
    stillIndeterminate(held.akahuPaymentId);
    const response = await resolveTopUp(s.admin, s.teamId, held.topUpId, {
      outcome: 'NOT_RECEIVED',
    });
    expect(response.json()).toMatchObject({
      intentStatus: 'CLOSED',
      resolutionReason: 'NOT_RECEIVED_INDETERMINATE',
    });
    const [notice] = emails();
    expect(notice?.idempotencyKey).toBe(`top-up-not-completed:${held.topUpId}`);
    expect(notice?.text).toContain("We checked with your bank: the top-up didn't go through.");
    const next = await call(h, 'POST', `/teams/${s.teamId}/wallet/top-ups`, s.payer.token, {
      amount: '20.00',
      idempotencyKey: randomUUID(),
    });
    expect(next.statusCode, next.body).toBe(201);
  });

  it('is for team admins of the path team or GLOBAL_ADMIN; a top-up of another team is 404, a member and a foreign admin 403', async () => {
    const s = await scene();
    const other = await scene();
    const held = await heldTopUp(s, '20.00', null);
    // Another team's admin, using their own team in the path: the top-up is not found there.
    const elsewhere = await resolveTopUp(other.admin, other.teamId, held.topUpId, {
      outcome: 'RECEIVED',
    });
    expect(elsewhere.statusCode).toBe(404);
    // ...and with the payee team in the path, the guard refuses before the body.
    expect(
      (await resolveTopUp(other.admin, s.teamId, held.topUpId, { outcome: 'RECEIVED' })).statusCode,
    ).toBe(403);
    expect(
      (await resolveTopUp(s.payer, s.teamId, held.topUpId, { outcome: 'RECEIVED' })).statusCode,
    ).toBe(403);
    expect(getPaymentCalls).toBe(0);

    stillIndeterminate(held.akahuPaymentId);
    const ops = await globalAdmin();
    const resolved = await resolveTopUp(ops, s.teamId, held.topUpId, { outcome: 'NOT_RECEIVED' });
    expect(resolved.statusCode, resolved.body).toBe(200);
  });
});
