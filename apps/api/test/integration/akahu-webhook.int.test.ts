/**
 * `POST /webhooks/akahu` on the real app over a real PostgreSQL (wallet-and-akahu-billing Phase 4a; A4, CR-3; AC-ERROR-6). The
 * signing key and every payload are SYNTHETIC (a key pair generated per run; payloads shaped from the vendor docs,
 * provenance `vendor-doc-derived`); Phase 4b replaces them with a recorded sandbox webhook (MVE-005).
 *
 * The route verifies the signature over the raw bytes, correlates only by a stored provider id, and only ENQUEUES `akahu-sync`:
 * nothing is applied inline. A forged, modified or replayed request changes no money state.
 */
import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { createFakeControl, createFakePaymentsGateway } from '../../src/lib/akahu/fake-adapter.ts';
import { GatewayUnavailableError, type PaymentsGateway } from '../../src/lib/akahu/gateway.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import { syncAkahuPayment } from '../../src/modules/billing/apply-akahu-result.ts';
import { runAkahuReconcile } from '../../src/modules/billing/reconcile.ts';
import { buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import { testCrypto, testPaymentsConfig } from '../helpers/app-deps.ts';
import {
  insertPayment,
  insertPaymentAttempt,
  insertTeam,
  insertWalletTopUp,
} from '../helpers/factories.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import {
  createRecordingJobs,
  insertMember,
  type RecordingJobs,
} from '../helpers/registration-scene.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

const KEY_ID = 'synthetic-key-1';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: otherPrivateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const control = createFakeControl();

let database: TestDatabase;
let jobs: RecordingJobs;
let h: AuthTestApp;

beforeAll(async () => {
  database = await createTestDatabase();
  jobs = createRecordingJobs();
  h = await buildAuthTestApp(database.pool, {
    jobs,
    paymentsGateway: createFakePaymentsGateway({
      control,
      webhookKeys: { [KEY_ID]: publicKey },
    }),
  });
});
afterAll(async () => {
  await h.close();
  await database.close();
});
beforeEach(() => {
  jobs.reset();
  control.reset();
});

const sigOf = (body: string, key: KeyObject = privateKey): string =>
  sign('sha256', Buffer.from(body), key).toString('base64');

/** An Akahu one-off payment status update as the vendor docs describe it (synthetic values). */
const event = (paymentId: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'ONE_OFF_PAYMENT_STATUS_UPDATE',
    _payment: paymentId,
    status: 'SENT',
    note: 'body-marker-7731',
    ...extra,
  });

function post(
  app: AuthTestApp['app'],
  body: string,
  headers: Record<string, string | undefined>,
  url = '/webhooks/akahu',
): Promise<LightMyRequestResponse> {
  const clean = Object.fromEntries(
    Object.entries({ 'content-type': 'application/json', ...headers }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return app.inject({ method: 'POST', url, payload: body, headers: clean });
}
const signed = (body: string, key: KeyObject = privateKey, keyId = KEY_ID) => ({
  'x-akahu-payments-signature': sigOf(body, key),
  'x-akahu-payments-signing-key': keyId,
});

const providerId = (cents: number): string =>
  `fake_ok_${cents}_${Date.now() - 60_000}_${randomBytes(4).toString('hex')}`;

async function openAttempt(): Promise<{ paymentId: string; attemptId: string; id: string }> {
  const teamId = await insertTeam(database.pool, { payoutConfigured: true });
  const userId = await insertMember(database.pool, teamId, {
    email: `payer-${randomUUID()}@example.test`,
  });
  const paymentId = await insertPayment(database.pool, {
    userId,
    teamId,
    registrationId: null,
    amount: '17.00',
    dueDate: new Date(Date.now() + 86_400_000),
  });
  const id = providerId(1700);
  const attemptId = await insertPaymentAttempt(database.pool, {
    paymentId,
    amount: '17.00',
    status: 'OPEN',
    akahuPaymentId: id,
  });
  return { paymentId, attemptId, id };
}

const syncJobs = () => jobs.recorded.filter((job) => job.queue === 'akahu-sync');
const logEvents = (event: string) => h.logs.lines().filter((line) => line.event === event);
async function statusOf(paymentId: string): Promise<string | undefined> {
  const { rows } = await database.pool.query<{ status: string }>(
    `SELECT status FROM payments WHERE id = $1`,
    [paymentId],
  );
  return rows[0]?.status;
}

describe('POST /webhooks/akahu: a verified event only enqueues a re-read (CR-3)', () => {
  it('answers 200 and enqueues one akahu-sync keyed by the stored provider id, applying nothing inline', async () => {
    const c = await openAttempt();
    const body = event(c.id);
    const response = await post(h.app, body, signed(body));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(syncJobs()).toEqual([
      expect.objectContaining({
        singletonKey: `akahu-sync:${c.id}`,
        data: { akahuPaymentId: c.id, source: 'webhook' },
      }),
    ]);
    expect(await statusOf(c.paymentId)).toBe('PENDING');
    expect(logEvents('akahu.webhook.accepted')[0]).toMatchObject({ akahuPaymentId: c.id });
  });

  it('correlates a top-up by its stored provider id too', async () => {
    const teamId = await insertTeam(database.pool, { payoutConfigured: true });
    const userId = await insertMember(database.pool, teamId);
    const id = providerId(2000);
    await insertWalletTopUp(database.pool, {
      userId,
      teamId,
      amount: '20.00',
      status: 'OPEN',
      akahuPaymentId: id,
    });
    const body = event(id);
    expect((await post(h.app, body, signed(body))).statusCode).toBe(200);
    expect(syncJobs()).toHaveLength(1);
  });

  it('a replayed event is answered 200 and, synced twice, still pays once (AC-ERROR-6)', async () => {
    const c = await openAttempt();
    control.scriptGet(c.id, [{ providerStatus: 'SENT', providerStatusReason: null }]);
    const body = event(c.id);
    for (let n = 0; n < 3; n += 1) {
      expect((await post(h.app, body, signed(body))).statusCode).toBe(200);
    }
    expect(syncJobs().every((job) => job.singletonKey === `akahu-sync:${c.id}`)).toBe(true);
    const deps = {
      db: createKysely(database.pool),
      gateway: createFakePaymentsGateway({ control }),
      jobs,
      clock: h.clock,
      crypto: testCrypto(),
      webBaseUrl: 'https://games.example.nz',
      log: captureLogs().logger,
    };
    jobs.reset();
    await syncAkahuPayment(deps, { akahuPaymentId: c.id, source: 'webhook' });
    await syncAkahuPayment(deps, { akahuPaymentId: c.id, source: 'webhook' });
    expect(await statusOf(c.paymentId)).toBe('PAID');
    expect(jobs.recorded.filter((job) => job.queue === 'send-email')).toHaveLength(1);
  });

  it('answers 200 without enqueueing for an unknown _payment, another event type or a malformed body; URL params are never read', async () => {
    const c = await openAttempt();
    const unknown = event(providerId(1700));
    const otherType = JSON.stringify({ type: 'SOMETHING_ELSE', _payment: c.id });
    const malformed = '{not json';
    const noPayment = JSON.stringify({ type: 'ONE_OFF_PAYMENT_STATUS_UPDATE' });
    for (const body of [unknown, otherType, malformed, noPayment]) {
      expect((await post(h.app, body, signed(body))).statusCode).toBe(200);
    }
    // A known id in the query string does not correlate an event whose body names an unknown payment.
    expect(
      (await post(h.app, unknown, signed(unknown), `/webhooks/akahu?_payment=${c.id}`)).statusCode,
    ).toBe(200);
    expect(syncJobs()).toEqual([]);
    expect(logEvents('akahu.webhook.unmatched').length).toBe(2);
    expect(
      logEvents('akahu.webhook.ignored')
        .map((line) => line.reason)
        .sort(),
    ).toEqual(['malformed', 'malformed', 'other_type'].sort());
  });
});

describe('POST /webhooks/akahu: forged or broken requests are refused (A4, AC-ERROR-6)', () => {
  it.each<[string, (body: string) => Record<string, string | undefined>, string]>([
    ['no signature headers', () => ({}), 'missing_header'],
    ['no key id', (body) => ({ 'x-akahu-payments-signature': sigOf(body) }), 'missing_header'],
    [
      'a key id that is not a safe token',
      (body) => signed(body, privateKey, '../keys'),
      'bad_key_id',
    ],
    [
      'a signature that is not base64',
      () => ({
        'x-akahu-payments-signature': 'not base64!!',
        'x-akahu-payments-signing-key': KEY_ID,
      }),
      'bad_signature_format',
    ],
    ['an unknown key id', (body) => signed(body, privateKey, 'unknown-key-9'), 'unknown_key'],
    ['a signature by another key', (body) => signed(body, otherPrivateKey), 'signature_mismatch'],
  ])(
    'answers 401 for %s, logs the reason without the body, and enqueues nothing',
    async (_l, headers, reason) => {
      const c = await openAttempt();
      const body = event(c.id);
      const response = await post(h.app, body, headers(body));
      expect(response.statusCode).toBe(401);
      expect(syncJobs()).toEqual([]);
      const rejected = logEvents('akahu.webhook.rejected').at(-1);
      expect(rejected).toMatchObject({ reason });
      const text = JSON.stringify(h.logs.lines());
      expect(text).not.toContain('body-marker-7731');
      expect(text).not.toContain(sigOf(body));
    },
  );

  it('answers 401 when the body was modified after signing', async () => {
    const c = await openAttempt();
    const body = event(c.id);
    const headers = signed(body);
    const tampered = event(c.id, { status: 'SENT ' });
    expect((await post(h.app, tampered, headers)).statusCode).toBe(401);
    expect(logEvents('akahu.webhook.rejected').at(-1)).toMatchObject({
      reason: 'signature_mismatch',
    });
    expect(syncJobs()).toEqual([]);
  });

  it('answers 413 for a body over 16 KiB', async () => {
    const body = JSON.stringify({ pad: 'x'.repeat(17 * 1024) });
    expect((await post(h.app, body, signed(body))).statusCode).toBe(413);
  });
});

describe('POST /webhooks/akahu: transient failures answer 5xx so Akahu retries', () => {
  it('answers 503 when the signing key cannot be fetched, and when the re-read cannot be enqueued', async () => {
    const inner = createFakePaymentsGateway({ webhookKeys: { [KEY_ID]: publicKey } });
    const keysDown: PaymentsGateway = {
      ...inner,
      webhookKeys: {
        resolve: () => Promise.reject(new GatewayUnavailableError('key_fetch_failed')),
      },
    };
    const down = await buildAuthTestApp(database.pool, { jobs, paymentsGateway: keysDown });
    try {
      const c = await openAttempt();
      const body = event(c.id);
      expect((await post(down.app, body, signed(body))).statusCode).toBe(503);
      expect(
        down.logs.lines().find((line) => line.event === 'akahu.webhook.unavailable'),
      ).toMatchObject({ reason: 'key_fetch_failed' });
    } finally {
      await down.close();
    }

    const failingJobs = {
      enqueue: () => Promise.reject(new Error('queue down')),
    };
    const noQueue = await buildAuthTestApp(database.pool, {
      jobs: failingJobs,
      paymentsGateway: inner,
    });
    try {
      const c = await openAttempt();
      const body = event(c.id);
      expect((await post(noQueue.app, body, signed(body))).statusCode).toBe(503);
    } finally {
      await noQueue.close();
    }
  });
});

describe('a webhook-enqueued akahu-sync racing the reconcile sweep for the same Akahu id (Phase 4a follow-up)', () => {
  /**
   * The literal race: the job the webhook route enqueued (its recorded payload) runs on one real connection while
   * `runAkahuReconcile` re-reads the same OPEN intent on another. The reconcile clock is 2 h ahead so the fresh intent is past the
   * minimum age; every other intent is parked out of the sweep's reach so only this id is a candidate.
   */
  async function raceFor(akahuPaymentId: string): Promise<{ emailKeys: string[] }> {
    await database.pool.query(
      `UPDATE payment_attempts SET last_synced_at = '2126-01-01T00:00:00Z' WHERE akahu_payment_id <> $1`,
      [akahuPaymentId],
    );
    await database.pool.query(
      `UPDATE wallet_top_ups SET last_synced_at = '2126-01-01T00:00:00Z' WHERE akahu_payment_id <> $1`,
      [akahuPaymentId],
    );
    control.scriptGet(akahuPaymentId, [{ providerStatus: 'SENT', providerStatusReason: null }]);
    const body = event(akahuPaymentId);
    expect((await post(h.app, body, signed(body))).statusCode).toBe(200);
    const [enqueued] = syncJobs();
    expect(syncJobs()).toHaveLength(1);
    const payload = enqueued?.data as { akahuPaymentId: string; source: 'webhook' };
    jobs.reset();

    const clock = createManualClock(new Date(Date.now() + 2 * 3_600_000));
    const deps = {
      db: createKysely(database.pool),
      gateway: createFakePaymentsGateway({ clock, control }),
      jobs,
      clock,
      crypto: testCrypto(),
      webBaseUrl: 'https://games.example.nz',
      log: captureLogs().logger,
    };
    await Promise.all([
      syncAkahuPayment(deps, payload),
      runAkahuReconcile({
        ...deps,
        settings: { ...testPaymentsConfig(), reconcileMinAgeSeconds: 0 },
      }),
    ]);
    return { emailKeys: jobs.emails().map((email) => email.idempotencyKey) };
  }

  it('payment attempt: exactly one PAID payment and one payment-received email', async () => {
    const c = await openAttempt();
    const { emailKeys } = await raceFor(c.id);
    expect(await statusOf(c.paymentId)).toBe('PAID');
    expect(emailKeys.filter((key) => key.includes(c.paymentId))).toEqual([
      `payment-received:${c.paymentId}`,
    ]);
    const { rows } = await database.pool.query(
      `SELECT 1 FROM payments WHERE id = $1 AND akahu_payment_id = $2 AND status = 'PAID'`,
      [c.paymentId, c.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('top-up: exactly one credit, the balance is credited once, one top-up email', async () => {
    const teamId = await insertTeam(database.pool, { payoutConfigured: true });
    const userId = await insertMember(database.pool, teamId, {
      email: `topup-${randomUUID()}@example.test`,
    });
    const id = providerId(2000);
    await insertWalletTopUp(database.pool, {
      userId,
      teamId,
      amount: '20.00',
      status: 'OPEN',
      akahuPaymentId: id,
    });
    const { emailKeys } = await raceFor(id);
    const credits = await database.pool.query(
      `SELECT amount::text FROM credit_transactions WHERE akahu_payment_id = $1 AND transaction_type = 'TOPUP'`,
      [id],
    );
    expect(credits.rows).toEqual([{ amount: '20.00' }]);
    const wallet = await database.pool.query<{ balance: string }>(
      `SELECT balance::text FROM player_credits WHERE user_id = $1 AND team_id = $2`,
      [userId, teamId],
    );
    expect(wallet.rows[0]?.balance).toBe('20.00');
    expect(emailKeys).toHaveLength(1);
  });
});
