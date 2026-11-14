/**
 * Payment attempt start and the payer's payment read models over HTTP on a real PostgreSQL (wallet-and-akahu-billing Phase 4a
 * part 2; CR-6, CR-7, CR-16, CR-17, A5, B10, C-BIL-PAY at attempt start per ADR 0020; AC-HAPPY-4, AC-HAPPY-9, AC-HAPPY-12 API side,
 * AC-ERROR-3, 7, 10, AC-VERIFY-1). Akahu is the stateless fake adapter with its control overlay (provenance: synthetic); a
 * completion is applied through the single funnel (`syncAkahuPayment`), never inline by a request.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import type {
  AttemptResponse,
  MyPaymentsResponse,
  PaymentResponse,
  UnpaidPaymentsResponse,
} from '@sgm/shared';
import { createFakeControl, createFakePaymentsGateway } from '../../src/lib/akahu/fake-adapter.ts';
import type { PaymentsGateway } from '../../src/lib/akahu/gateway.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import {
  syncAkahuPayment,
  type AkahuSyncDeps,
} from '../../src/modules/billing/apply-akahu-result.ts';
import { countOverdueByUser } from '../../src/modules/registrations/repo.ts';
import { testCrypto } from '../helpers/app-deps.ts';
import { buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  insertPayment,
  insertPaymentAttempt,
  insertPublishedSession,
  insertRegistration,
  insertTeam,
} from '../helpers/factories.ts';
import { captureLogs } from '../helpers/log-capture.ts';
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
const WEB = 'https://games.example.nz';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const crypto = testCrypto();
const providerClock = createManualClock(BASE);
const control = createFakeControl();

let database: TestDatabase;
let jobs: RecordingJobs;
let h: AuthTestApp;
const idleDuringCreate: number[] = [];
let getPaymentCalls = 0;

async function idleInTransactionCount(): Promise<number> {
  const { rows } = await database.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_stat_activity
      WHERE datname = current_database() AND state LIKE 'idle in transaction%' AND pid <> pg_backend_pid()`,
  );
  return Number(rows[0]?.n ?? '0');
}

function observedGateway(): PaymentsGateway {
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
  database = await createTestDatabase({ poolMax: 30 });
  jobs = createRecordingJobs();
  h = await buildAuthTestApp(database.pool, { jobs, paymentsGateway: observedGateway() });
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
  idleDuringCreate.length = 0;
  getPaymentCalls = 0;
  control.beforeCreate = async () => {
    idleDuringCreate.push(await idleInTransactionCount());
  };
});

// ---------------------------------------------------------------------------------------------
// Scene and HTTP
// ---------------------------------------------------------------------------------------------

interface Scene {
  readonly teamId: string;
  readonly sessionId: string;
  readonly payer: HttpMember;
}

async function scene(options: { name?: string } = {}): Promise<Scene> {
  const teamId = await insertTeam(database.pool, {
    name: options.name ?? 'Tuesday Smashers',
    payoutConfigured: true,
    sealWith: crypto,
  });
  const { sessionId } = await insertPublishedSession(database.pool, teamId, {
    now: new Date(BASE.getTime() - 5 * DAY),
    flat: '17.00',
  });
  return { teamId, sessionId, payer: await httpMember(h, teamId) };
}

async function owed(
  s: Scene,
  options: {
    amount?: string;
    status?: 'PENDING' | 'OVERDUE' | 'PAID';
    who?: HttpMember;
    lateWithdrawal?: boolean;
    sessionId?: string;
  } = {},
): Promise<string> {
  const userId = (options.who ?? s.payer).userId;
  const registrationId = await insertRegistration(database.pool, {
    sessionId: options.sessionId ?? s.sessionId,
    teamId: s.teamId,
    userId,
    ...(options.lateWithdrawal === true
      ? { status: 'WITHDRAWN' as const, withdrawalFeeDue: true }
      : {}),
  });
  return insertPayment(database.pool, {
    userId,
    teamId: s.teamId,
    registrationId,
    amount: options.amount ?? '17.00',
    dueDate: new Date(BASE.getTime() + 2 * DAY),
    ...(options.status === undefined ? {} : { status: options.status }),
  });
}

const pay = (
  who: HttpMember | null,
  paymentId: string,
  body: unknown = { idempotencyKey: randomUUID() },
): Promise<LightMyRequestResponse> =>
  call(h, 'POST', `/payments/${paymentId}/attempts`, who?.token ?? null, body);
const view = (who: HttpMember | null, paymentId: string): Promise<LightMyRequestResponse> =>
  call(h, 'GET', `/payments/${paymentId}`, who?.token ?? null);

interface AttemptRow {
  id: string;
  status: string;
  amount: string;
  akahu_payment_id: string | null;
  close_reason: string | null;
}
async function attemptRows(paymentId: string): Promise<AttemptRow[]> {
  const { rows } = await database.pool.query<AttemptRow>(
    `SELECT id, status, amount, akahu_payment_id, close_reason FROM payment_attempts
      WHERE payment_id = $1 ORDER BY created_at, id`,
    [paymentId],
  );
  return rows;
}
async function paymentRow(paymentId: string) {
  const { rows } = await database.pool.query<{
    status: string;
    paid_at: Date | null;
    akahu_payment_id: string | null;
    payment_reference: string;
    gst_amount: string;
  }>(
    'SELECT status, paid_at, akahu_payment_id, payment_reference, gst_amount FROM payments WHERE id = $1',
    [paymentId],
  );
  return rows[0];
}

const complete = (akahuPaymentId: string) =>
  syncAkahuPayment(
    {
      db: h.db,
      gateway: createFakePaymentsGateway({ clock: providerClock, control }),
      jobs,
      clock: h.clock,
      crypto,
      webBaseUrl: WEB,
      log: captureLogs().logger,
    } satisfies AkahuSyncDeps,
    { akahuPaymentId, source: 'webhook' },
  );

const resumeOf = (response: LightMyRequestResponse) =>
  response.json<{ error: { resume?: { redirectUrl: string | null } } }>().error.resume;

// =============================================================================================
// Happy paths
// =============================================================================================

describe('POST /payments/:paymentId/attempts (AC-HAPPY-4, AC-HAPPY-9, A5, B10)', () => {
  it('opens one attempt for the payment amount to the team account, outside any transaction; the completion pays it', async () => {
    const s = await scene();
    const paymentId = await owed(s);
    const response = await pay(s.payer, paymentId);
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json<AttemptResponse>()).toEqual({
      redirectUrl: `${WEB}/payments/${paymentId}?return=1`,
    });
    const [attempt] = await attemptRows(paymentId);
    expect(attempt).toMatchObject({ status: 'OPEN', amount: '17.00' });
    const before = await paymentRow(paymentId);
    expect(control.calls).toEqual([
      expect.objectContaining({
        amount: 1700n,
        reference: before?.payment_reference,
        redirectUri: `${WEB}/payments/${paymentId}?return=1`,
        payeeAccountLast4: '9000', // last 4 digits of T's decrypted account 01-0902-0068389-000
      }),
    ]);
    expect(idleDuringCreate).toEqual([0]);
    // tx2 records the attempt only: the payment learns its Akahu id when it becomes PAID.
    expect(before).toMatchObject({ status: 'PENDING', akahu_payment_id: null });

    await complete(attempt?.akahu_payment_id ?? '');
    const after = await paymentRow(paymentId);
    expect(after).toMatchObject({ status: 'PAID', akahu_payment_id: attempt?.akahu_payment_id });
    const page = (await view(s.payer, paymentId)).json<PaymentResponse>().payment;
    expect(page).toMatchObject({
      status: 'PAID',
      paidAt: after?.paid_at?.toISOString(),
      attempt: { status: 'APPLIED', outcome: 'none' },
      onHold: false,
    });
    const { rows } = await database.pool.query(
      'SELECT 1 FROM credit_transactions WHERE user_id = $1',
      [s.payer.userId],
    );
    expect(rows).toEqual([]); // the wallet is untouched
  });

  it('clears one of three OVERDUE payments, so the registration debt gate counts two (AC-HAPPY-9)', async () => {
    const s = await scene();
    const ids: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      const { sessionId } = await insertPublishedSession(database.pool, s.teamId, {
        now: new Date(BASE.getTime() - (10 + n) * DAY),
        flat: '17.00',
      });
      ids.push(await owed(s, { status: 'OVERDUE', sessionId }));
    }
    const overdue = async () =>
      (await h.db.transaction().execute((trx) => countOverdueByUser(trx, [s.payer.userId]))).get(
        s.payer.userId,
      );
    expect(await overdue()).toBe(3);
    expect((await pay(s.payer, ids[0] ?? '')).statusCode).toBe(201);
    const [attempt] = await attemptRows(ids[0] ?? '');
    await complete(attempt?.akahu_payment_id ?? '');
    expect((await paymentRow(ids[0] ?? ''))?.status).toBe('PAID');
    expect(await overdue()).toBe(2);
  });
});

// =============================================================================================
// Paying twice is impossible (AC-ERROR-10)
// =============================================================================================

describe('paying twice is impossible (AC-ERROR-10, CR-6)', () => {
  it('answers a double click with the same answer, a second tab with the open attempt, and a paid payment with payment_settled', async () => {
    const s = await scene();
    const paymentId = await owed(s);
    const key = { idempotencyKey: randomUUID() };
    const first = await pay(s.payer, paymentId, key);
    const doubleClick = await pay(s.payer, paymentId, key);
    expect(doubleClick.statusCode).toBe(201);
    expect(doubleClick.json<AttemptResponse>()).toEqual(first.json<AttemptResponse>());
    const secondTab = await pay(s.payer, paymentId);
    expect(secondTab.statusCode).toBe(409);
    expect(errorOf(secondTab).code).toBe('payment_in_progress');
    expect(resumeOf(secondTab)).toEqual({
      redirectUrl: first.json<AttemptResponse>().redirectUrl,
      topUp: null,
    });
    expect(control.calls).toHaveLength(1);

    const [attempt] = await attemptRows(paymentId);
    await complete(attempt?.akahu_payment_id ?? '');
    const settled = await pay(s.payer, paymentId);
    expect(settled.statusCode).toBe(409);
    expect(errorOf(settled).code).toBe('payment_settled');
    expect(await attemptRows(paymentId)).toHaveLength(1);
  });

  it('lets exactly one of two concurrent starts open an attempt', async () => {
    const s = await scene();
    const paymentId = await owed(s);
    const results = await Promise.all([pay(s.payer, paymentId), pay(s.payer, paymentId)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(control.calls).toHaveLength(1);
    expect((await attemptRows(paymentId)).filter((a) => a.status === 'OPEN')).toHaveLength(1);
  });

  it('answers 409 payment_on_hold while an attempt is HELD and creates no new attempt', async () => {
    const s = await scene();
    const paymentId = await owed(s);
    await insertPaymentAttempt(database.pool, {
      paymentId,
      amount: '17.00',
      status: 'HELD',
      akahuPaymentId: `fake_bei_1700_${BASE.getTime()}_held`,
    });
    const response = await pay(s.payer, paymentId);
    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe('payment_on_hold');
    expect(await attemptRows(paymentId)).toHaveLength(1);
    expect(control.calls).toEqual([]);
    expect((await view(s.payer, paymentId)).json<PaymentResponse>().payment).toMatchObject({
      onHold: true,
      attempt: { status: 'HELD', outcome: 'held' },
    });
  });

  it('cancels an expired open link through the cancel job (never inline) and answers 409 without a URL', async () => {
    const s = await scene();
    const paymentId = await owed(s);
    await pay(s.payer, paymentId);
    const [attempt] = await attemptRows(paymentId);
    h.clock.set(new Date(BASE.getTime() + 31 * MINUTE));
    jobs.reset();
    const again = await pay(s.payer, paymentId);
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).code).toBe('payment_in_progress');
    expect(resumeOf(again)).toEqual({ redirectUrl: null, topUp: null });
    expect(jobs.recorded.filter((job) => job.queue === 'akahu-cancel')).toEqual([
      expect.objectContaining({
        data: { akahuPaymentId: attempt?.akahu_payment_id, source: 'expired' },
      }),
    ]);
    expect((await attemptRows(paymentId))[0]?.status).toBe('OPEN');
    expect(getPaymentCalls).toBe(0);
  });
});

// =============================================================================================
// Declines and provider failures
// =============================================================================================

describe('declines and an unavailable provider (AC-ERROR-3, AC-ERROR-7)', () => {
  it('leaves a declined payment payable, says it failed, and lets the payer try again', async () => {
    const s = await scene();
    const paymentId = await owed(s, { amount: '5.15' }); // the fake declines $5.15 (FAILED/REJECTED)
    expect((await pay(s.payer, paymentId)).statusCode).toBe(201);
    const [attempt] = await attemptRows(paymentId);
    await complete(attempt?.akahu_payment_id ?? '');
    expect((await attemptRows(paymentId))[0]?.status).toBe('CLOSED');
    const page = (await view(s.payer, paymentId)).json<PaymentResponse>().payment;
    expect(page).toMatchObject({
      status: 'PENDING',
      attempt: { status: 'CLOSED', outcome: 'failed' },
    });
    expect((await pay(s.payer, paymentId)).statusCode).toBe(201);
  });

  it('answers 503 with the attempt closed, never calls Akahu under a lock, and a retry with a new key works', async () => {
    const s = await scene();
    const paymentId = await owed(s);
    control.failNextCreate('5xx');
    const failed = await pay(s.payer, paymentId);
    expect(failed.statusCode).toBe(503);
    expect(errorOf(failed).code).toBe('payment_provider_unavailable');
    expect(await attemptRows(paymentId)).toEqual([
      expect.objectContaining({
        status: 'CLOSED',
        close_reason: 'create_unavailable',
        akahu_payment_id: null,
      }),
    ]);
    expect((await paymentRow(paymentId))?.status).toBe('PENDING');
    expect((await pay(s.payer, paymentId)).statusCode).toBe(201);
    expect(idleDuringCreate).toEqual([0, 0]);
  });

  it('cancels the provider payment when the attempt can no longer be recorded (tx2 failure)', async () => {
    const s = await scene();
    const paymentId = await owed(s);
    control.beforeCreate = async () => {
      await database.pool.query(
        `UPDATE payment_attempts SET status = 'CLOSED', close_reason = 'create_abandoned', closed_at = now()
          WHERE payment_id = $1 AND status = 'CREATING'`,
        [paymentId],
      );
    };
    const response = await pay(s.payer, paymentId);
    expect(response.statusCode).toBe(503);
    expect(jobs.recorded.filter((job) => job.queue === 'akahu-cancel')).toEqual([
      expect.objectContaining({
        data: {
          akahuPaymentId: expect.stringMatching(/^fake_ok_1700_/) as string,
          source: 'start_orphan',
        },
      }),
    ]);
  });
});

// =============================================================================================
// C-BIL-PAY at attempt start (ADR 0020, Phase 2 note)
// =============================================================================================

describe('payout blocked at attempt start (C-BIL-PAY, AC-ERROR-4 player side)', () => {
  // A paid session cannot be published for a blocked team, so each scene blocks the payout after the charge exists.
  const blockPayout = (teamId: string) =>
    database.pool.query('UPDATE teams SET payout_blocked_at = now() WHERE id = $1', [teamId]);

  it('answers 409 payout_not_configured for a blocked team, inserts nothing, and the page says payout is blocked', async () => {
    const s = await scene();
    const paymentId = await owed(s);
    await blockPayout(s.teamId);
    const response = await pay(s.payer, paymentId);
    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe('payout_not_configured');
    expect(await attemptRows(paymentId)).toEqual([]);
    expect(control.calls).toEqual([]);
    expect((await view(s.payer, paymentId)).json<PaymentResponse>().payment.payoutBlocked).toBe(
      true,
    );
  });

  it('a block committed before the start wins; a block still uncommitted does not hold the start back (KEY SHARE vs NO KEY UPDATE)', async () => {
    const s = await scene();
    const first = await owed(s);
    const { sessionId } = await insertPublishedSession(database.pool, s.teamId, {
      now: new Date(BASE.getTime() - 3 * DAY),
      flat: '17.00',
    });
    const second = await owed(s, { sessionId });
    const blocker = await database.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('UPDATE teams SET payout_blocked_at = now() WHERE id = $1', [s.teamId]);
      // Uncommitted: the start reads the committed state and goes ahead (the block's own cancel sweep handles it).
      expect((await pay(s.payer, first)).statusCode).toBe(201);
      await blocker.query('COMMIT');
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
    const refused = await pay(s.payer, second);
    expect(errorOf(refused).code).toBe('payout_not_configured');
    expect(await attemptRows(second)).toEqual([]);
  });
});

// =============================================================================================
// Payer-only reads and uniform 404s (CR-7, AC-VERIFY-1)
// =============================================================================================

describe('payer-only routes answer one uniform 404', () => {
  it('gives another member, an outsider and an unknown id the same 404 on read and on start; 401 without a session', async () => {
    const s = await scene();
    const paymentId = await owed(s);
    const other = await httpMember(h, s.teamId);
    const outsider = await httpOutsider(h);
    const unknown = randomUUID();
    const bodies: unknown[] = [];
    for (const [who, id] of [
      [other, paymentId],
      [outsider, paymentId],
      [s.payer, unknown],
    ] as const) {
      for (const response of [await view(who, id), await pay(who, id)]) {
        expect(response.statusCode).toBe(404);
        expect(response.headers['cache-control']).toBe('no-store');
        bodies.push(response.json());
      }
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect((await view(null, paymentId)).statusCode).toBe(401);
    expect((await pay(null, paymentId)).statusCode).toBe(401);
    expect(control.calls).toEqual([]);
  });

  it('refuses a non-strict body with 422 and writes nothing', async () => {
    const s = await scene();
    const paymentId = await owed(s);
    const response = await pay(s.payer, paymentId, {
      idempotencyKey: randomUUID(),
      amount: '1.00',
    });
    expect(response.statusCode).toBe(422);
    expect(await attemptRows(paymentId)).toEqual([]);
  });
});

describe('GET /payments/:paymentId (CR-17, CR-3 return page)', () => {
  it('shows the session, lines, GST, reason and team, and enqueues a throttled re-read of an open attempt', async () => {
    const s = await scene();
    const paymentId = await owed(s, { lateWithdrawal: true });
    const response = await view(s.payer, paymentId);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const { rows } = await database.pool.query<{ location: string; starts_at: Date }>(
      'SELECT location, starts_at FROM game_sessions WHERE id = $1',
      [s.sessionId],
    );
    const stored = await paymentRow(paymentId);
    expect(response.json<PaymentResponse>()).toEqual({
      payment: {
        id: paymentId,
        reference: stored?.payment_reference,
        teamName: 'Tuesday Smashers',
        session: {
          id: s.sessionId,
          location: rows[0]?.location,
          startsAt: rows[0]?.starts_at.toISOString(),
        },
        amount: '17.00',
        gstAmount: stored?.gst_amount,
        lines: [{ position: 0, basis: 'FLAT', unitFee: '17.00' }],
        status: 'PENDING',
        billingType: 'PER_GAME',
        dueDate: new Date(BASE.getTime() + 2 * DAY).toISOString(),
        paidAt: null,
        reason: 'LATE_WITHDRAWAL',
        attempt: null,
        onHold: false,
        payoutBlocked: false,
        // A pending payment has no document yet (tax-invoices-and-exports: available only once PAID above $0.00).
        document: { kind: 'TAX_INVOICE', available: false, number: null },
      },
    });
    expect(jobs.recorded.filter((job) => job.queue === 'akahu-sync')).toEqual([]);

    await pay(s.payer, paymentId);
    const [attempt] = await attemptRows(paymentId);
    jobs.reset();
    const open = (await view(s.payer, paymentId)).json<PaymentResponse>().payment;
    expect(open.attempt).toMatchObject({ status: 'OPEN', outcome: 'processing' });
    expect(jobs.recorded.filter((job) => job.queue === 'akahu-sync')).toEqual([
      expect.objectContaining({
        data: { akahuPaymentId: attempt?.akahu_payment_id, source: 'return_page' },
        singletonKey: `akahu-sync:${attempt?.akahu_payment_id}`,
      }),
    ]);
    await database.pool.query('UPDATE payment_attempts SET last_synced_at = $2 WHERE id = $1', [
      attempt?.id,
      new Date(BASE.getTime() - 1_000),
    ]);
    jobs.reset();
    await view(s.payer, paymentId);
    expect(jobs.recorded.filter((job) => job.queue === 'akahu-sync')).toEqual([]);
    expect(getPaymentCalls).toBe(0);
  });
});

describe('the payer lists (GET /teams/:teamId/payments/me, GET /payments/me?status=UNPAID; CR-16, CR-17)', () => {
  it("lists only the caller's payments in the team, newest due first, with outcome and hold flags", async () => {
    const s = await scene();
    const mine = await owed(s);
    const other = await httpMember(h, s.teamId);
    await owed(s, { who: other });
    const response = await call(h, 'GET', `/teams/${s.teamId}/payments/me`, s.payer.token);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<MyPaymentsResponse>();
    expect(body.nextCursor).toBeNull();
    expect(body.payments).toEqual([
      expect.objectContaining({
        id: mine,
        sessionId: s.sessionId,
        amount: '17.00',
        status: 'PENDING',
        billingType: 'PER_GAME',
        reason: 'CONFIRMED',
        outcome: 'none',
        onHold: false,
        payoutBlocked: false,
      }),
    ]);
    const outsider = await httpOutsider(h);
    expect(
      (await call(h, 'GET', `/teams/${s.teamId}/payments/me`, outsider.token)).statusCode,
    ).toBe(403);
  });

  it("groups the caller's PENDING, OVERDUE and held payments across teams, and leaves out paid ones and other people's", async () => {
    const a = await scene({ name: 'Alpha Club' });
    const pending = await owed(a);
    const paid = await owed(a, {
      status: 'PAID',
      sessionId: (
        await insertPublishedSession(database.pool, a.teamId, {
          now: new Date(BASE.getTime() - 9 * DAY),
          flat: '17.00',
        })
      ).sessionId,
    });
    // The same person in a second team, with an OVERDUE payment on hold.
    const teamB = await insertTeam(database.pool, {
      name: 'Beta Club',
      payoutConfigured: true,
      sealWith: crypto,
    });
    await database.pool.query(
      `INSERT INTO team_members (team_id, user_id, role, status, skill_level, approved_at, approved_by)
       VALUES ($1, $2, 'MEMBER', 'APPROVED', 'BEGINNER', now(), $2)`,
      [teamB, a.payer.userId],
    );
    const { sessionId: sessionB } = await insertPublishedSession(database.pool, teamB, {
      now: new Date(BASE.getTime() - 6 * DAY),
      flat: '17.00',
    });
    const b: Scene = { teamId: teamB, sessionId: sessionB, payer: a.payer };
    const held = await owed(b, { status: 'OVERDUE' });
    await insertPaymentAttempt(database.pool, {
      paymentId: held,
      amount: '17.00',
      status: 'HELD',
      akahuPaymentId: `fake_bei_1700_${BASE.getTime()}_hold`,
    });
    const someoneElse = await httpMember(h, a.teamId);
    await owed(a, { who: someoneElse });

    const response = await call(h, 'GET', '/payments/me?status=UNPAID', a.payer.token);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<UnpaidPaymentsResponse>();
    const byTeam = Object.fromEntries(
      body.teams.map((team) => [
        team.teamName,
        team.payments.map((p) => [p.id, p.status, p.onHold]),
      ]),
    );
    expect(byTeam).toEqual({
      'Alpha Club': [[pending, 'PENDING', false]],
      'Beta Club': [[held, 'OVERDUE', true]],
    });
    expect(JSON.stringify(body)).not.toContain(paid);
    expect((await call(h, 'GET', '/payments/me?status=PAID', a.payer.token)).statusCode).toBe(422);
    expect((await call(h, 'GET', '/payments/me', null)).statusCode).toBe(401);
  });
});
