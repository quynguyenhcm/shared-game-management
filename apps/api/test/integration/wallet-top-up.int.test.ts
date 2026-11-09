/**
 * Wallet top-up start and the wallet read model over HTTP on a real PostgreSQL (wallet-and-akahu-billing Phase 4a part 2; CR-6,
 * CR-17, CR-24, A5, B1, B10; AC-HAPPY-1, AC-HAPPY-12 API side, AC-ERROR-1, 2, 3, 7, AC-VERIFY-1, C-BIL-PAY at top-up start).
 * Akahu is the stateless fake adapter with its control overlay (provenance: synthetic); a completion is applied through the single
 * funnel (`syncAkahuPayment`), never inline by a request.
 *
 * Nothing sleeps: races are ordered with `waitForLockWaiters` on a row lock or gate the test holds.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import type { TopUpResponse, WalletResponse } from '@sgm/shared';
import { createFakeControl, createFakePaymentsGateway } from '../../src/lib/akahu/fake-adapter.ts';
import type { PaymentsGateway } from '../../src/lib/akahu/gateway.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import type { JobRunner } from '../../src/lib/jobs/jobs.ts';
import {
  syncAkahuPayment,
  type AkahuSyncDeps,
} from '../../src/modules/billing/apply-akahu-result.ts';
import { testCrypto } from '../helpers/app-deps.ts';
import { buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  insertAuthSession,
  insertPublishedSession,
  insertRegistration,
  insertTeam,
  insertTeamMember,
  insertUser,
  insertWallet,
  insertWalletTopUp,
  paymentReference,
} from '../helpers/factories.ts';
import { waitForLockWaiters } from '../helpers/lock-waiters.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import { createRecordingJobs, type RecordingJobs } from '../helpers/registration-scene.ts';
import {
  call,
  errorOf,
  httpMember,
  httpOutsider,
  type HttpMember,
} from '../helpers/registrations-http.ts';
import { createTestDatabase, pgError, type TestDatabase } from '../helpers/test-db.ts';

const BASE = new Date('2026-11-10T00:00:00.000Z');
const WEB = 'https://games.example.nz';
const MINUTE = 60_000;
/** The fake records the last 4 digits of the decrypted number: the factory's default payee account 01-0902-0068389-000. */
const ACCOUNT_LAST4 = '9000';
const CLEAR_BANKING =
  'UPDATE teams SET bank_account_name = NULL, bank_account_number = NULL, bank_account_last4 = NULL WHERE id = $1';

const crypto = testCrypto();
const providerClock = createManualClock(BASE);
const control = createFakeControl();

let database: TestDatabase;
let jobs: RecordingJobs;
let h: AuthTestApp;
/** Backends sitting "idle in transaction" at the moment of each create call (AC-ERROR-7: never while a lock is held). */
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
  readonly member: HttpMember;
}

async function scene(options: { payoutConfigured?: boolean; payoutBlockedAt?: Date } = {}) {
  const teamId = await insertTeam(database.pool, {
    name: 'Tuesday Smashers',
    payoutConfigured: options.payoutConfigured ?? true,
    ...(options.payoutBlockedAt === undefined ? {} : { payoutBlockedAt: options.payoutBlockedAt }),
    sealWith: crypto,
  });
  return { teamId, member: await httpMember(h, teamId) } satisfies Scene;
}

const start = (
  who: HttpMember | null,
  teamId: string,
  body: unknown = { amount: '30.00', idempotencyKey: randomUUID() },
): Promise<LightMyRequestResponse> =>
  call(h, 'POST', `/teams/${teamId}/wallet/top-ups`, who?.token ?? null, body);
const read = (who: HttpMember, teamId: string, query = ''): Promise<LightMyRequestResponse> =>
  call(h, 'GET', `/teams/${teamId}/wallet${query}`, who.token);

interface TopUpRow {
  id: string;
  status: string;
  amount: string;
  reference: string;
  akahu_payment_id: string | null;
  akahu_status: string | null;
  authorisation_url_enc: string | null;
  expires_at: Date | null;
  close_reason: string | null;
}
async function topUpRows(teamId: string): Promise<TopUpRow[]> {
  const { rows } = await database.pool.query<TopUpRow>(
    `SELECT id, status, amount, reference, akahu_payment_id, akahu_status, authorisation_url_enc, expires_at, close_reason
       FROM wallet_top_ups WHERE team_id = $1 ORDER BY created_at, id`,
    [teamId],
  );
  return rows;
}

const syncDeps = (overrides: Partial<AkahuSyncDeps> = {}): AkahuSyncDeps => ({
  db: h.db,
  gateway: createFakePaymentsGateway({ clock: providerClock, control }),
  jobs,
  clock: h.clock,
  crypto,
  webBaseUrl: WEB,
  log: captureLogs().logger,
  ...overrides,
});
const completeAtAkahu = (akahuPaymentId: string, overrides: Partial<AkahuSyncDeps> = {}) =>
  syncAkahuPayment(syncDeps(overrides), { akahuPaymentId, source: 'webhook' });

const cancelJobs = () => jobs.recorded.filter((job) => job.queue === 'akahu-cancel');
const syncJobs = () => jobs.recorded.filter((job) => job.queue === 'akahu-sync');

// =============================================================================================
// Happy path
// =============================================================================================

describe('POST /teams/:teamId/wallet/top-ups (AC-HAPPY-1, A5, B10)', () => {
  it('creates one intent, asks Akahu for the amount to the team account outside any transaction, and credits once on completion', async () => {
    const s = await scene();
    const response = await start(s.member, s.teamId);
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<TopUpResponse>();
    const [row] = await topUpRows(s.teamId);
    expect(body).toEqual({
      topUp: { id: row?.id, amount: '30.00', status: 'OPEN' },
      redirectUrl: `${WEB}/teams/${s.teamId}/wallet?topUp=${row?.id}`, // the fake "approves instantly"
    });
    // One OPEN intent with the provider id, a sealed URL (AAD of this row) and the configured expiry.
    expect(row).toMatchObject({ status: 'OPEN', amount: '30.00', akahu_status: 'READY' });
    expect(row?.reference).toMatch(/^SGM[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(row?.akahu_payment_id).toMatch(/^fake_ok_3000_/);
    expect(row?.authorisation_url_enc).not.toContain('https');
    expect(
      crypto.decrypt(row?.authorisation_url_enc ?? '', {
        table: 'wallet_top_ups',
        column: 'authorisation_url',
        rowId: row?.id ?? '',
      }),
    ).toBe(body.redirectUrl);
    expect(row?.expires_at?.toISOString()).toBe(
      new Date(BASE.getTime() + 30 * MINUTE).toISOString(),
    );
    // The call: the amount, the intent's reference, the return page, and T's account (last 4 only recorded).
    expect(control.calls).toEqual([
      {
        amount: 3000n,
        reference: row?.reference,
        redirectUri: `${WEB}/teams/${s.teamId}/wallet?topUp=${row?.id}`,
        webhookUri: expect.stringMatching(/^https?:\/\//) as string,
        payeeAccountLast4: ACCOUNT_LAST4,
      },
    ]);
    expect(idleDuringCreate).toEqual([0]);
    // No log line carries the payee, the account or the consent URL.
    const logged = JSON.stringify(h.logs.lines());
    expect(logged).not.toMatch(/Test Club Account|0068389|authorisation/i);

    // The completion is applied by the funnel (CR-3), once.
    const id = row?.akahu_payment_id ?? '';
    expect((await completeAtAkahu(id)).outcome).toBe('applied');
    expect((await completeAtAkahu(id)).outcome).toBe('applied');
    const { rows: ledger } = await database.pool.query<{
      amount: string;
      resulting_balance: string;
      akahu_payment_id: string;
    }>(
      `SELECT amount, resulting_balance, akahu_payment_id FROM credit_transactions WHERE team_id = $1`,
      [s.teamId],
    );
    expect(ledger).toEqual([{ amount: '30.00', resulting_balance: '30.00', akahu_payment_id: id }]);
    const wallet = (await read(s.member, s.teamId)).json<WalletResponse>();
    expect(wallet.wallet).toMatchObject({
      balance: '30.00',
      headroom: '70.00',
      pendingTopUp: null,
    });
  });

  it('answers a repeat with the same key with the same top-up and calls Akahu once', async () => {
    const s = await scene();
    const body = { amount: '25.00', idempotencyKey: randomUUID() };
    const first = await start(s.member, s.teamId, body);
    const again = await start(s.member, s.teamId, body);
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(201);
    expect(again.json<TopUpResponse>()).toEqual(first.json<TopUpResponse>());
    expect(control.calls).toHaveLength(1);
    expect(await topUpRows(s.teamId)).toHaveLength(1);
  });
});

// =============================================================================================
// Refusals before any intent
// =============================================================================================

describe('refusals that write nothing and call nobody (AC-ERROR-1, AC-VERIFY-1, C-BIL-PAY)', () => {
  it('refuses an amount over the headroom with the limit stated, and a full wallet as full', async () => {
    const s = await scene();
    await insertWallet(database.pool, s.member.userId, s.teamId, '85.00');
    const over = await start(s.member, s.teamId, { amount: '20.00', idempotencyKey: randomUUID() });
    expect(over.statusCode).toBe(422);
    expect(errorOf(over)).toMatchObject({
      code: 'validation_failed',
      fieldErrors: { amount: ['You can top up at most $15.00.'] },
    });

    const full = await scene();
    await insertWallet(database.pool, full.member.userId, full.teamId, '100.00');
    const refused = await start(full.member, full.teamId, {
      amount: '1.00',
      idempotencyKey: randomUUID(),
    });
    expect(errorOf(refused).fieldErrors).toEqual({ amount: ['Your wallet is full.'] });
    // Only the synthetic funding intents of insertWallet exist; no start intent, no call.
    expect((await topUpRows(s.teamId)).filter((row) => row.status !== 'APPLIED')).toEqual([]);
    expect(control.calls).toEqual([]);
  });

  it('answers 422 naming the field for invalid amounts and for extra fields, before writing anything', async () => {
    const s = await scene();
    for (const amount of ['0', '-5', '12.345', 'abc']) {
      const response = await start(s.member, s.teamId, { amount, idempotencyKey: randomUUID() });
      expect(response.statusCode, amount).toBe(422);
      expect(Object.keys(errorOf(response).fieldErrors ?? {}), amount).toEqual(['amount']);
    }
    const extra = await start(s.member, s.teamId, {
      amount: '10.00',
      idempotencyKey: randomUUID(),
      balance: '100.00',
    });
    expect(extra.statusCode).toBe(422);
    expect(await topUpRows(s.teamId)).toEqual([]);
    expect(control.calls).toEqual([]);
  });

  it('runs the team guard before the body: 401 without a session, 403 for an outsider and a pending member, whatever the body', async () => {
    const s = await scene();
    const outsider = await httpOutsider(h);
    const pending = await httpMember(h, s.teamId, { status: 'PENDING' });
    expect((await start(null, s.teamId, { nonsense: true })).statusCode).toBe(401);
    for (const who of [outsider, pending]) {
      const response = await start(who, s.teamId, { nonsense: true });
      expect(response.statusCode).toBe(403);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect((await read(outsider, s.teamId)).statusCode).toBe(403);
    expect(control.calls).toEqual([]);
  });

  it('answers 409 payout_not_configured for a payout-blocked team and a team without banking, inserting nothing', async () => {
    for (const options of [
      { payoutBlockedAt: new Date('2026-11-01T00:00:00Z') },
      { payoutConfigured: false },
    ]) {
      const s = await scene(options);
      const response = await start(s.member, s.teamId);
      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('payout_not_configured');
      expect(await topUpRows(s.teamId)).toEqual([]);
    }
    expect(control.calls).toEqual([]);
  });
});

// =============================================================================================
// One open top-up per wallet
// =============================================================================================

describe('one blocking top-up per wallet (AC-ERROR-2, CR-6, CR-24)', () => {
  it('lets one of two concurrent starts through and answers the other 409 top_up_in_progress with the open one', async () => {
    const s = await scene();
    await insertWallet(database.pool, s.member.userId, s.teamId, '60.00');
    const [a, b] = await Promise.all([start(s.member, s.teamId), start(s.member, s.teamId)]);
    const responses = [a, b] as LightMyRequestResponse[];
    const created = responses.filter((r) => r.statusCode === 201);
    const refused = responses.filter((r) => r.statusCode === 409);
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const open = created[0]?.json<TopUpResponse>().topUp;
    const error = refused[0]?.json<{
      error: { code: string; resume: { topUp: { id: string; amount: string } | null } };
    }>().error;
    expect(error?.code).toBe('top_up_in_progress');
    expect(error?.resume.topUp).toMatchObject({ id: open?.id, amount: '30.00' });
    expect(control.calls).toHaveLength(1);

    // Later, from a second tab: the open top-up is resumed with its consent URL while the link has time left.
    const later = await start(s.member, s.teamId);
    expect(later.statusCode).toBe(409);
    expect(
      later.json<{ error: { resume: { redirectUrl: string | null } } }>().error.resume.redirectUrl,
    ).toBe(created[0]?.json<TopUpResponse>().redirectUrl);
  });

  it('does not resume an expired link: it enqueues the cancel (never applied inline) and answers 409 without a URL', async () => {
    const s = await scene();
    const opened = (await start(s.member, s.teamId)).json<TopUpResponse>();
    const [row] = await topUpRows(s.teamId);
    h.clock.set(new Date(BASE.getTime() + 29 * MINUTE)); // one minute left: under the two-minute floor
    jobs.reset();
    const again = await start(s.member, s.teamId);
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: { resume: unknown } }>().error.resume).toEqual({
      redirectUrl: null,
      topUp: { id: opened.topUp.id, amount: '30.00', status: 'OPEN' },
    });
    expect(cancelJobs()).toEqual([
      expect.objectContaining({
        data: { akahuPaymentId: row?.akahu_payment_id, source: 'expired' },
        singletonKey: `akahu-cancel:${row?.akahu_payment_id}`,
      }),
    ]);
    expect((await topUpRows(s.teamId))[0]?.status).toBe('OPEN');
    expect(getPaymentCalls).toBe(0);
  });

  it('validates headroom on the balance AFTER the slot is claimed: a credit committing while the next start waits is seen (CR-24)', async () => {
    const s = await scene();
    await insertWallet(database.pool, s.member.userId, s.teamId, '0.00');
    // Top-up A of $90.00 is open at Akahu and completes.
    const a = await start(s.member, s.teamId, { amount: '90.00', idempotencyKey: randomUUID() });
    expect(a.statusCode).toBe(201);
    const [rowA] = await topUpRows(s.teamId);
    // The funnel's transaction pauses at its first enqueue (the "top-up received" email), after A is APPLIED and credited.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reachedGate!: () => void;
    const atGate = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });
    const gatedJobs: Pick<JobRunner, 'enqueue'> = {
      async enqueue() {
        reachedGate();
        await gate;
        return 'gated';
      },
    };
    const applying = completeAtAkahu(rowA?.akahu_payment_id ?? '', { jobs: gatedJobs });
    await atGate;
    // Start B ($20.00) now: its insert waits on A's uncommitted row in the one-blocking index.
    const b = start(s.member, s.teamId, { amount: '20.00', idempotencyKey: randomUUID() });
    await waitForLockWaiters(database.pool, 1, 'start B blocked behind the credit');
    release();
    await applying;
    const response = await b;
    expect(response.statusCode).toBe(422);
    expect(errorOf(response).fieldErrors).toEqual({ amount: ['You can top up at most $10.00.'] });
    expect((await topUpRows(s.teamId)).map((row) => row.status)).toEqual(['APPLIED']);
    expect(control.calls).toHaveLength(1);
  });
});

// =============================================================================================
// Provider failures
// =============================================================================================

describe('Akahu unavailable or refusing (AC-ERROR-7)', () => {
  it('answers 503, closes the intent, and a retry with a new key works; the old key keeps its answer', async () => {
    const s = await scene();
    for (const failure of ['timeout', '5xx', 'network'] as const) {
      control.failNextCreate(failure);
      const key = randomUUID();
      const failed = await start(s.member, s.teamId, { amount: '30.00', idempotencyKey: key });
      expect(failed.statusCode, failure).toBe(503);
      expect(errorOf(failed).code).toBe('payment_provider_unavailable');
      const replay = await start(s.member, s.teamId, { amount: '30.00', idempotencyKey: key });
      expect(errorOf(replay).code).toBe('payment_provider_unavailable');
    }
    const rows = await topUpRows(s.teamId);
    expect(rows.map((row) => [row.status, row.close_reason])).toEqual([
      ['CLOSED', 'create_unavailable'],
      ['CLOSED', 'create_unavailable'],
      ['CLOSED', 'create_unavailable'],
    ]);
    expect(idleDuringCreate.every((n) => n === 0)).toBe(true);
    const retry = await start(s.member, s.teamId);
    expect(retry.statusCode).toBe(201);
    expect(control.calls).toHaveLength(1);
  });

  it('answers 422 payment_provider_refused with a stable reason for a definite refusal and closes the intent', async () => {
    const s = await scene();
    control.failNextCreate({ refused: 'single_limit_exceeded' });
    const refused = await start(s.member, s.teamId);
    expect(refused.statusCode).toBe(422);
    expect(refused.json<{ error: { code: string; reason: string } }>().error).toMatchObject({
      code: 'payment_provider_refused',
      reason: 'amount_over_bank_limit',
    });
    expect((await topUpRows(s.teamId)).map((row) => row.close_reason)).toEqual([
      'create_refused:single_limit_exceeded',
    ]);
  });

  it('cancels the provider payment when the intent can no longer be recorded (tx2 failure) and answers 503', async () => {
    const s = await scene();
    control.beforeCreate = async () => {
      // Reconcile closes the CREATING row while the create call is in flight.
      await database.pool.query(
        `UPDATE wallet_top_ups SET status = 'CLOSED', close_reason = 'create_abandoned', closed_at = now()
          WHERE team_id = $1 AND status = 'CREATING'`,
        [s.teamId],
      );
    };
    const response = await start(s.member, s.teamId);
    expect(response.statusCode).toBe(503);
    expect(errorOf(response).code).toBe('payment_provider_unavailable');
    expect(cancelJobs()).toEqual([
      expect.objectContaining({
        data: {
          akahuPaymentId: expect.stringMatching(/^fake_ok_3000_/) as string,
          source: 'start_orphan',
        },
      }),
    ]);
    expect((await topUpRows(s.teamId)).map((row) => row.akahu_payment_id)).toEqual([null]);
  });
});

// =============================================================================================
// C-BIL-PAY at top-up start vs a banking removal, both orders (ADR 0016, CR-10)
// =============================================================================================

describe('banking removal racing a top-up start (C-BIL-PAY, CR-10)', () => {
  it('removal first: the start waits behind the team lock, then answers 409 payout_not_configured and inserts nothing', async () => {
    const s = await scene();
    const remover = await database.pool.connect();
    try {
      await remover.query('BEGIN');
      await remover.query(CLEAR_BANKING, [s.teamId]);
      const pending = start(s.member, s.teamId);
      await waitForLockWaiters(database.pool, 1, 'start blocked behind the removal');
      await remover.query('COMMIT');
      const response = await pending;
      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('payout_not_configured');
    } finally {
      await remover.query('ROLLBACK').catch(() => undefined);
      remover.release();
    }
    expect(await topUpRows(s.teamId)).toEqual([]);
    expect(control.calls).toEqual([]);
  });

  it('start first: the removal waits behind teams FOR KEY SHARE and is then refused, because the top-up holds the account', async () => {
    const s = await scene();
    await insertWallet(database.pool, s.member.userId, s.teamId, '0.00');
    // Hold the wallet row so the start stops after claiming its slot (teams KEY SHARE held, CREATING inserted).
    const holder = await database.pool.connect();
    let removal: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT id FROM player_credits WHERE user_id = $1 AND team_id = $2 FOR UPDATE',
        [s.member.userId, s.teamId],
      );
      const pending = start(s.member, s.teamId);
      await waitForLockWaiters(database.pool, 1, 'start blocked on the wallet row');
      removal = pgError(database.pool.query(CLEAR_BANKING, [s.teamId]));
      await waitForLockWaiters(database.pool, 2, 'removal blocked behind the start');
      await holder.query('COMMIT');
      expect((await pending).statusCode).toBe(201);
      expect(await removal).toMatchObject({ code: '23514', constraint: 'teams_banking_in_use' });
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect((await topUpRows(s.teamId)).map((row) => row.status)).toEqual(['OPEN']);
  });
});

// =============================================================================================
// GET /teams/:teamId/wallet (AC-HAPPY-12, CR-17, CR-3 return-page sync)
// =============================================================================================

describe('GET /teams/:teamId/wallet', () => {
  it('reads 0.00 without creating a wallet row for a member who has none', async () => {
    const s = await scene();
    const response = await read(s.member, s.teamId);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json<WalletResponse>()).toEqual({
      wallet: {
        balance: '0.00',
        cap: '100.00',
        headroom: '100.00',
        lowCreditThreshold: '20.00',
        pendingTopUp: null,
        lastClosedTopUp: null,
      },
      transactions: [],
      nextCursor: null,
    });
    const { rows } = await database.pool.query(
      'SELECT 1 FROM player_credits WHERE user_id = $1 AND team_id = $2',
      [s.member.userId, s.teamId],
    );
    expect(rows).toEqual([]);
  });

  it('lists movements newest first with the session of each deduction, paginated by nextCursor', async () => {
    const s = await scene();
    await insertWallet(database.pool, s.member.userId, s.teamId, '50.00');
    const { sessionId } = await insertPublishedSession(database.pool, s.teamId, {
      now: BASE,
      flat: '17.00',
    });
    const registrationId = await insertRegistration(database.pool, {
      sessionId,
      teamId: s.teamId,
      userId: s.member.userId,
    });
    await database.pool.query(
      `INSERT INTO credit_transactions (user_id, team_id, amount, transaction_type, registration_id, resulting_balance)
       VALUES ($1, $2, '-17.00', 'AUTO_DEDUCTION', $3, '33.00')`,
      [s.member.userId, s.teamId, registrationId],
    );
    // 50 one-dollar top-ups so the ledger spans two pages (52 rows).
    for (let n = 0; n < 50; n += 1) {
      const akahuPaymentId = `synthetic-${randomUUID()}`;
      const { rows } = await database.pool.query<{ id: string }>(
        `INSERT INTO wallet_top_ups (user_id, team_id, reference, idempotency_key, amount, status, akahu_payment_id)
         VALUES ($1, $2, $3, $4, '1.00', 'APPLIED', $5) RETURNING id`,
        [s.member.userId, s.teamId, paymentReference(), randomUUID(), akahuPaymentId],
      );
      await database.pool.query(
        `INSERT INTO credit_transactions (user_id, team_id, amount, transaction_type, akahu_payment_id, wallet_top_up_id,
                                          resulting_balance)
         VALUES ($1, $2, '1.00', 'TOPUP', $3, $4, $5)`,
        [s.member.userId, s.teamId, akahuPaymentId, rows[0]?.id, `${34 + n}.00`],
      );
    }
    const first = (await read(s.member, s.teamId)).json<WalletResponse>();
    expect(first.wallet.balance).toBe('83.00');
    expect(first.transactions).toHaveLength(50);
    expect(first.transactions[0]).toMatchObject({
      type: 'TOPUP',
      amount: '1.00',
      resultingBalance: '83.00',
      session: null,
    });
    expect(first.nextCursor).not.toBeNull();
    const second = (
      await read(s.member, s.teamId, `?cursor=${encodeURIComponent(first.nextCursor ?? '')}`)
    ).json<WalletResponse>();
    expect(second.nextCursor).toBeNull();
    expect(second.transactions.map((t) => [t.type, t.amount, t.resultingBalance])).toEqual([
      ['AUTO_DEDUCTION', '-17.00', '33.00'],
      ['TOPUP', '50.00', '50.00'],
    ]);
    const { rows: session } = await database.pool.query<{ location: string; starts_at: Date }>(
      'SELECT location, starts_at FROM game_sessions WHERE id = $1',
      [sessionId],
    );
    expect(second.transactions[0]?.session).toEqual({
      id: sessionId,
      location: session[0]?.location,
      startsAt: session[0]?.starts_at.toISOString(),
    });
    const ids = new Set([...first.transactions, ...second.transactions].map((t) => t.id));
    expect(ids.size).toBe(52);
    expect((await read(s.member, s.teamId, '?cursor=garbage')).statusCode).toBe(422);
  });

  it('shows the open top-up as processing and the last uncredited one for the B3 notice', async () => {
    const s = await scene();
    const closedAt = new Date('2026-11-09T00:00:00Z');
    await insertWalletTopUp(database.pool, {
      userId: s.member.userId,
      teamId: s.teamId,
      amount: '40.00',
      status: 'CLOSED',
      akahuPaymentId: `fake_rej_4000_${BASE.getTime()}_aaaa`,
      settledAt: closedAt,
    });
    const opened = (
      await start(s.member, s.teamId, { amount: '20.00', idempotencyKey: randomUUID() })
    ).json<TopUpResponse>();
    const wallet = (await read(s.member, s.teamId)).json<WalletResponse>().wallet;
    expect(wallet.pendingTopUp).toEqual({
      id: opened.topUp.id,
      amount: '20.00',
      status: 'OPEN',
      outcome: 'processing',
      createdAt: expect.any(String) as string,
    });
    expect(wallet.lastClosedTopUp).toMatchObject({
      amount: '40.00',
      status: 'CLOSED',
      unappliedReason: null,
      closedAt: closedAt.toISOString(),
    });
  });

  it('enqueues one throttled re-read for the open top-up named by ?topUp= and never calls Akahu itself', async () => {
    const s = await scene();
    const opened = (await start(s.member, s.teamId)).json<TopUpResponse>();
    const [row] = await topUpRows(s.teamId);
    jobs.reset();
    expect((await read(s.member, s.teamId)).statusCode).toBe(200);
    expect(syncJobs()).toEqual([]); // no ?topUp=: a plain visit enqueues nothing
    await read(s.member, s.teamId, `?topUp=${opened.topUp.id}`);
    expect(syncJobs()).toEqual([
      expect.objectContaining({
        data: { akahuPaymentId: row?.akahu_payment_id, source: 'return_page' },
        singletonKey: `akahu-sync:${row?.akahu_payment_id}`,
      }),
    ]);
    // Synced 2 s ago: throttled. Synced 6 s ago: one more.
    await database.pool.query('UPDATE wallet_top_ups SET last_synced_at = $2 WHERE id = $1', [
      row?.id,
      new Date(BASE.getTime() - 2_000),
    ]);
    jobs.reset();
    await read(s.member, s.teamId, `?topUp=${opened.topUp.id}`);
    expect(syncJobs()).toEqual([]);
    await database.pool.query('UPDATE wallet_top_ups SET last_synced_at = $2 WHERE id = $1', [
      row?.id,
      new Date(BASE.getTime() - 6_000),
    ]);
    await read(s.member, s.teamId, `?topUp=${opened.topUp.id}`);
    expect(syncJobs()).toHaveLength(1);
    expect(getPaymentCalls).toBe(0);
  });

  it("keeps each member's wallet to themselves", async () => {
    const s = await scene();
    await insertWallet(database.pool, s.member.userId, s.teamId, '30.00');
    const other = await httpMember(h, s.teamId);
    expect((await read(other, s.teamId)).json<WalletResponse>().wallet.balance).toBe('0.00');
    // A team admin of the team is a member too, and sees only their own wallet.
    const adminId = await insertUser(database.pool, 'FEMALE');
    await insertTeamMember(database.pool, {
      teamId: s.teamId,
      userId: adminId,
      role: 'TEAM_ADMIN',
    });
    const { token } = await insertAuthSession(database.pool, adminId, {
      createdAt: h.clock.now(),
      idleDays: 90,
      absoluteDays: 180,
    });
    expect(
      (await read({ userId: adminId, token }, s.teamId)).json<WalletResponse>().wallet.balance,
    ).toBe('0.00');
  });
});
