/**
 * Invoice issuance on a real PostgreSQL and a real pg-boss producer (tax-invoices-and-exports Phase 2; AC-ASYNC-1, AC-ASYNC-2,
 * AC-ASYNC-3, AC-HAPPY-4, AC-HAPPY-5, AC-ERROR-1, AC-ERROR-5). The two PAID writers (the billing engine's wallet branch and the
 * Akahu apply funnel, which also serves a held payment resolved by hand) only ENQUEUE `issue-invoices` inside their PAID
 * transaction; the per-team job, the on-demand service and the reconcile sweep all issue through the one SQL function. Akahu is the
 * stateless fake adapter (provenance: synthetic). Races are ordered with `waitForLockWaiters` or a parked statement, never sleeps.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QUEUES } from '../../src/jobs/registry.ts';
import {
  createInvoiceReconcileHandler,
  runInvoiceReconcile,
} from '../../src/jobs/invoice-reconcile.ts';
import { createIssueInvoicesHandler } from '../../src/jobs/issue-invoices.ts';
import { createFakeControl, createFakePaymentsGateway } from '../../src/lib/akahu/fake-adapter.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import { AppError } from '../../src/lib/http/errors.ts';
import {
  NonRetryableJobError,
  createJobRunner,
  type JobContext,
  type JobRunner,
} from '../../src/lib/jobs/jobs.ts';
import { billSession } from '../../src/modules/billing/bill-session.ts';
import {
  resolveHeldIntent,
  syncAkahuPayment,
  type AkahuSyncDeps,
} from '../../src/modules/billing/apply-akahu-result.ts';
import { issuePaymentDocument } from '../../src/modules/invoices/repo.ts';
import {
  issueOnDemand,
  issueTeamBacklog,
  type IssueDeps,
} from '../../src/modules/invoices/issue.ts';
import { testCrypto } from '../helpers/app-deps.ts';
import {
  insertBilledRegistration,
  insertPaymentAttempt,
  insertPublishedSession,
  insertRegistration,
  insertSession,
  insertTeam,
  insertWallet,
  type BilledRegistrationOptions,
  type PublishedSessionOptions,
} from '../helpers/factories.ts';
import { waitForLockWaiters } from '../helpers/lock-waiters.ts';
import { captureLogs, type CapturedLogs } from '../helpers/log-capture.ts';
import {
  createRecordingJobs,
  insertMember,
  type RecordingJobs,
} from '../helpers/registration-scene.ts';
import { createGatedDatabase } from '../helpers/statement-gate.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

const BASE = new Date('2026-11-10T00:00:00.000Z');
const WEB = 'https://games.example.nz';
const HOUR = 3_600_000;
const GST_NUMBER = '49091850';

const crypto = testCrypto();
const clock = createManualClock(BASE);
const control = createFakeControl();

let database: TestDatabase;
let worker: JobRunner;
let jobs: RecordingJobs;
let logs: CapturedLogs;

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 30 });
  // A connection killed on purpose (the crash test) must not raise an unhandled 'error' on a checked-out client.
  database.pool.on('connect', (client) => client.on('error', () => undefined));
  worker = createJobRunner({
    databaseUrl: database.url,
    logger: captureLogs().logger,
    role: 'worker',
  });
  await worker.start();
  for (const queue of QUEUES) await worker.defineQueue(queue);
});
afterAll(async () => {
  await worker.stop();
  await database.close();
});
beforeEach(() => {
  clock.set(BASE);
  control.reset();
  jobs = createRecordingJobs(worker);
  logs = captureLogs();
});

const kysely = () => createKysely(database.pool);
const issueDeps = (overrides: Partial<IssueDeps> = {}): IssueDeps => ({
  db: kysely(),
  log: logs.logger,
  ...overrides,
});

function jobContext(): JobContext {
  return {
    logger: logs.logger,
    jobId: 'job-1',
    queue: 'issue-invoices',
    retryCount: 0,
    retryLimit: 3,
    signal: new AbortController().signal,
  } as unknown as JobContext;
}
const runIssueJob = (
  teamId: string,
  overrides: Partial<Parameters<typeof createIssueInvoicesHandler>[0]> = {},
) => createIssueInvoicesHandler({ db: kysely(), jobs, ...overrides })({ teamId }, jobContext());

// ---------------------------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------------------------

const team = (options: { gstRegistered?: boolean } = {}): Promise<string> =>
  insertTeam(database.pool, {
    payoutConfigured: true,
    name: 'Hokio Badminton Club',
    gstRegistered: options.gstRegistered ?? true,
    ...(options.gstRegistered === false ? {} : { gstNumber: GST_NUMBER }),
  });

/** `count` payments of one team, each for a new player, all in one session. */
async function billed(
  teamId: string,
  count: number,
  options: BilledRegistrationOptions = {},
): Promise<string[]> {
  const sessionId = await insertSession(database.pool, teamId, {}, { maxPlayers: count + 2 });
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push((await insertBilledRegistration(database.pool, teamId, sessionId, options)).paymentId);
  }
  return ids;
}
const paidAt = (hour: number): Date => new Date(BASE.getTime() - 48 * HOUR + hour * HOUR);

async function numberOf(paymentId: string): Promise<string | null> {
  const { rows } = await database.pool.query<{ n: string | null }>(
    `SELECT d.number_display AS n FROM payments p
       LEFT JOIN payment_documents d ON d.payment_id = p.id WHERE p.id = $1`,
    [paymentId],
  );
  return rows[0]?.n ?? null;
}
async function numbersOf(paymentIds: readonly string[]): Promise<(string | null)[]> {
  return Promise.all(paymentIds.map(numberOf));
}
async function lastNumber(teamId: string, kind = 'TAX_INVOICE'): Promise<number | undefined> {
  const { rows } = await database.pool.query<{ last_number: number }>(
    'SELECT last_number FROM team_invoice_counters WHERE team_id = $1 AND document_kind = $2',
    [teamId, kind],
  );
  return rows[0]?.last_number;
}
const documentCount = async (teamId: string): Promise<number> =>
  (
    await database.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment_documents d JOIN payments p ON p.id = d.payment_id
        WHERE p.team_id = $1`,
      [teamId],
    )
  ).rows[0]?.n ?? 0;
const inv = (n: number): string => `INV-${String(n).padStart(6, '0')}`;
const rct = (n: number): string => `RCT-${String(n).padStart(6, '0')}`;

/** The `issue-invoices` jobs filed for one team, from the real pg-boss table. */
async function issueJobs(teamId: string, pool = database.pool) {
  const { rows } = await pool.query<{ singleton_key: string; state: string }>(
    `SELECT singleton_key, state FROM pgboss.job WHERE name = 'issue-invoices' AND singleton_key = $1`,
    [`issue-invoices:${teamId}`],
  );
  return rows;
}
const issueEnqueues = (teamId: string) =>
  jobs.recorded.filter(
    (job) => job.queue === 'issue-invoices' && job.singletonKey === `issue-invoices:${teamId}`,
  );

/** Jobs double whose send-email enqueue fails: the PAID transaction rolls back after the invoice job was filed inside it. */
function failingEmails(delegate: RecordingJobs): Pick<JobRunner, 'enqueue'> {
  return {
    enqueue(queue, data, options) {
      return queue === 'send-email'
        ? Promise.reject(new Error('email enqueue failed on purpose'))
        : delegate.enqueue(queue, data, options);
    },
  };
}

// ---- billing scene (the wallet branch of bill-session) ----

interface Scene {
  readonly teamId: string;
  readonly sessionId: string;
  readonly endsAt: Date;
}
async function billingScene(fees: Omit<PublishedSessionOptions, 'now'>): Promise<Scene> {
  const teamId = await team();
  const { sessionId } = await insertPublishedSession(database.pool, teamId, { now: BASE, ...fees });
  const { rows } = await database.pool.query<{ ends_at: Date }>(
    'SELECT ends_at FROM game_sessions WHERE id = $1',
    [sessionId],
  );
  return { teamId, sessionId, endsAt: rows[0]?.ends_at ?? BASE };
}
async function registrant(
  s: Scene,
  options: { wallet?: string; sex?: 'MALE' | 'FEMALE' } = {},
): Promise<string> {
  const userId = await insertMember(database.pool, s.teamId, { sex: options.sex ?? 'MALE' });
  await insertRegistration(database.pool, {
    sessionId: s.sessionId,
    teamId: s.teamId,
    userId,
  });
  if (options.wallet !== undefined)
    await insertWallet(database.pool, userId, s.teamId, options.wallet);
  return userId;
}
function bill(s: Scene, jobsDouble: Pick<JobRunner, 'enqueue'> = jobs) {
  clock.set(s.endsAt);
  return billSession(
    { db: kysely(), jobs: jobsDouble, clock, crypto, webBaseUrl: WEB, log: logs.logger },
    { sessionId: s.sessionId },
  );
}

// ---- apply funnel scene (Akahu result and hand resolution) ----

const providerId = (cents: number): string =>
  `fake_ok_${cents}_${BASE.getTime() - 60_000}_${randomBytes(4).toString('hex')}`;
const applyDeps = (jobsDouble: Pick<JobRunner, 'enqueue'> = jobs): AkahuSyncDeps => ({
  db: kysely(),
  gateway: createFakePaymentsGateway({ clock, control }),
  jobs: jobsDouble,
  clock,
  crypto,
  webBaseUrl: WEB,
  log: logs.logger,
});

/** A PENDING payment with an attempt in `state` (OPEN: the bank is processing it; HELD: waiting for a person). */
async function attemptedPayment(
  teamId: string,
  state: 'OPEN' | 'HELD',
): Promise<{ paymentId: string; attemptId: string; akahuPaymentId: string }> {
  const sessionId = await insertSession(database.pool, teamId, {}, { maxPlayers: 4 });
  const { paymentId } = await insertBilledRegistration(database.pool, teamId, sessionId, {
    status: 'PENDING',
  });
  const akahuPaymentId = providerId(1700);
  const attemptId = await insertPaymentAttempt(database.pool, {
    paymentId,
    amount: '17.00',
    status: state,
    akahuPaymentId,
    akahuStatus: state === 'HELD' ? 'SUBMITTED' : 'READY',
    ...(state === 'HELD' ? { holdReason: 'INDETERMINATE' as const } : {}),
  });
  return { paymentId, attemptId, akahuPaymentId };
}
const settleByAkahu = (akahuPaymentId: string, deps = applyDeps()) => {
  control.scriptGet(akahuPaymentId, [{ providerStatus: 'SENT', providerStatusReason: null }]);
  return syncAkahuPayment(deps, { akahuPaymentId, source: 'webhook' });
};
const resolveReceived = (attemptId: string, actorUserId: string, deps = applyDeps()) =>
  resolveHeldIntent(deps, {
    ref: { kind: 'ATTEMPT', id: attemptId },
    actorUserId,
    outcome: 'RECEIVED',
    observedAmount: null,
    freshAmountMismatch: false,
    freshIndeterminate: false,
  });
const statusOf = async (paymentId: string): Promise<string> =>
  (
    await database.pool.query<{ status: string }>('SELECT status FROM payments WHERE id = $1', [
      paymentId,
    ])
  ).rows[0]?.status ?? 'MISSING';

// =============================================================================================
// Enqueue sites: billing only enqueues, in the PAID transaction (AC-ASYNC-1)
// =============================================================================================

describe('the PAID writers enqueue issue-invoices inside their PAID transaction (AC-ASYNC-1)', () => {
  it('bill-session files exactly one issue-invoices:<teamId> job for a session whose wallets paid, whatever the head count', async () => {
    const s = await billingScene({ flat: '17.00' });
    await registrant(s, { wallet: '60.00' });
    await registrant(s, { wallet: '60.00' });

    expect(await bill(s)).toMatchObject({ kind: 'completed', deducted: 2 });

    expect(issueEnqueues(s.teamId)).toMatchObject([
      { data: { teamId: s.teamId }, inTransaction: true },
    ]);
    expect(await issueJobs(s.teamId)).toEqual([
      { singleton_key: `issue-invoices:${s.teamId}`, state: 'created' },
    ]);
  });

  it('bill-session files none when nothing was paid from a wallet: a $0.00 party and a PENDING link (AC-ERROR-5)', async () => {
    const s = await billingScene({
      pricing: 'BY_SEX',
      male: '0.00',
      female: '12.00',
      other: '13.00',
    });
    await registrant(s, { sex: 'MALE', wallet: '50.00' });
    await registrant(s, { sex: 'FEMALE' });

    expect(await bill(s)).toMatchObject({ kind: 'completed', zero: 1, linked: 1, deducted: 0 });

    expect(issueEnqueues(s.teamId)).toEqual([]);
    expect(await issueJobs(s.teamId)).toEqual([]);
  });

  it('bill-session leaves no job behind when its transaction rolls back after the job was filed', async () => {
    const s = await billingScene({ flat: '17.00' });
    const userId = await registrant(s, { wallet: '30.00' }); // 13.00 left: the low-credit email is enqueued after the loop

    await expect(bill(s, failingEmails(jobs))).rejects.toThrow(/on purpose/);

    expect(issueEnqueues(s.teamId)).toHaveLength(1); // it WAS filed inside the transaction ...
    expect(await issueJobs(s.teamId)).toEqual([]); // ... and rolled back with it
    expect(
      (await database.pool.query('SELECT 1 FROM payments WHERE user_id = $1', [userId])).rowCount,
    ).toBe(0);
  });

  it('the apply funnel files one job when an Akahu result moves the payment to PAID, and a replay files nothing more', async () => {
    const teamId = await team();
    const { paymentId, akahuPaymentId } = await attemptedPayment(teamId, 'OPEN');

    await settleByAkahu(akahuPaymentId);

    expect(await statusOf(paymentId)).toBe('PAID');
    expect(issueEnqueues(teamId)).toMatchObject([{ data: { teamId }, inTransaction: true }]);
    expect(await issueJobs(teamId)).toHaveLength(1);

    jobs.reset();
    await settleByAkahu(akahuPaymentId); // already APPLIED: a no-op
    expect(issueEnqueues(teamId)).toEqual([]);
    expect(await issueJobs(teamId)).toHaveLength(1);
  });

  it('a held payment resolved as RECEIVED is invoiced only then: unavailable while held, one job and a number after (AC-ERROR-1)', async () => {
    const teamId = await team();
    const admin = await insertMember(database.pool, teamId);
    const { paymentId, attemptId } = await attemptedPayment(teamId, 'HELD');

    await expect(issueOnDemand(issueDeps(), { paymentId })).rejects.toMatchObject({
      code: 'invoice_not_available',
    });
    expect(await issueJobs(teamId)).toEqual([]);
    expect(await lastNumber(teamId)).toBeUndefined();

    expect(await resolveReceived(attemptId, admin)).toMatchObject({ outcome: 'resolved' });

    expect(await statusOf(paymentId)).toBe('PAID');
    expect(issueEnqueues(teamId)).toMatchObject([{ inTransaction: true }]);
    await runIssueJob(teamId);
    expect(await numberOf(paymentId)).toBe(inv(1));
  });

  it('the apply funnel leaves no job behind when its transaction rolls back', async () => {
    const teamId = await team();
    const { paymentId, akahuPaymentId } = await attemptedPayment(teamId, 'OPEN');

    await expect(settleByAkahu(akahuPaymentId, applyDeps(failingEmails(jobs)))).rejects.toThrow(
      /on purpose/,
    );

    expect(await statusOf(paymentId)).toBe('PENDING');
    expect(await issueJobs(teamId)).toEqual([]);
  });
});

// =============================================================================================
// The per-team job: drain order, gapless numbers, idempotency and races (AC-ASYNC-2, AC-HAPPY-4)
// =============================================================================================

describe('the issue-invoices job (AC-HAPPY-4, AC-ASYNC-2)', () => {
  it('issues every unissued PAID payment of the team in paid order, per kind, and ignores unpaid and $0.00 rows', async () => {
    const teamId = await team();
    const [late, early] = [
      ...(await billed(teamId, 1, { status: 'PAID', paidAt: paidAt(10) })),
      ...(await billed(teamId, 1, { status: 'PAID', paidAt: paidAt(8) })),
    ] as [string, string];
    const [receiptA, receiptB] = [
      ...(await billed(teamId, 1, { status: 'PAID', gstRegistered: false, paidAt: paidAt(11) })),
      ...(await billed(teamId, 1, { status: 'PAID', gstRegistered: false, paidAt: paidAt(9) })),
    ] as [string, string];
    const ignored = [
      ...(await billed(teamId, 1, { status: 'PENDING' })),
      ...(await billed(teamId, 1, { status: 'OVERDUE' })),
      ...(await billed(teamId, 1, { status: 'PAID', amount: '0.00', paidAt: paidAt(7) })),
    ];

    await runIssueJob(teamId);

    // INV series: 08:00 then 10:00. RCT series: 09:00 then 11:00. The two series count independently.
    expect(await numbersOf([early, late])).toEqual([inv(1), inv(2)]);
    expect(await numbersOf([receiptB, receiptA])).toEqual([rct(1), rct(2)]);
    expect(await numbersOf(ignored)).toEqual([null, null, null]);
    expect([await lastNumber(teamId), await lastNumber(teamId, 'RECEIPT')]).toEqual([2, 2]);

    // Logs carry ids, the kind and counts only: no number, name, amount or GST number.
    const issued = logs.lines().filter((line) => line.event === 'invoice.issued');
    expect(issued).toHaveLength(4);
    expect(issued[0]).toMatchObject({ paymentId: early, teamId, documentKind: 'TAX_INVOICE' });
    expect(issued.map((line) => line.documentKind)).toEqual([
      'TAX_INVOICE',
      'RECEIPT',
      'TAX_INVOICE',
      'RECEIPT',
    ]);
    const text = JSON.stringify(logs.lines());
    for (const secret of ['INV-0', 'RCT-0', GST_NUMBER, 'Hokio', '17.00']) {
      expect(text).not.toContain(secret);
    }
    expect(logs.lines().find((line) => line.event === 'invoice.run.completed')).toMatchObject({
      teamId,
      issued: 4,
      failed: 0,
    });
  });

  it('is idempotent when the job is delivered twice: the second run issues nothing and changes no number', async () => {
    const teamId = await team();
    const ids = await billed(teamId, 3, { status: 'PAID' });

    await runIssueJob(teamId);
    const first = await numbersOf(ids);
    await runIssueJob(teamId);

    expect(await numbersOf(ids)).toEqual(first);
    expect(new Set(first).size).toBe(3);
    expect(await lastNumber(teamId)).toBe(3);
    const runs = logs.lines().filter((line) => line.event === 'invoice.run.completed');
    expect(runs.map((run) => run.issued)).toEqual([3, 0]);
  });

  it('gives one number when the job and an on-demand request race for one payment', async () => {
    const teamId = await team();
    const [paymentId] = await billed(teamId, 1, { status: 'PAID' });
    const holder = await database.pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
    let onDemand: Awaited<ReturnType<typeof issueOnDemand>> | undefined;
    try {
      const requests = [
        issueOnDemand(issueDeps(), { paymentId: paymentId ?? '' }).then((r) => {
          onDemand = r;
        }),
        runIssueJob(teamId),
      ];
      await waitForLockWaiters(database.pool, 2, 'issuers blocked on the payment row');
      await holder.query('COMMIT');
      await Promise.all(requests);
    } finally {
      holder.release();
    }

    expect(await numberOf(paymentId ?? '')).toBe(inv(1));
    expect(await lastNumber(teamId)).toBe(1);
    expect(await documentCount(teamId)).toBe(1);
    const issuedLines = logs.lines().filter((line) => line.event === 'invoice.issued');
    expect(issuedLines).toHaveLength(1); // exactly one of the two actually issued
    expect(onDemand?.numberDisplay).toBe(inv(1));
  });

  it('numbers ten payments of one team that become PAID together with ten distinct consecutive numbers', async () => {
    const teamId = await team();
    const ids = await billed(teamId, 10, { status: 'PAID' });

    await Promise.all(ids.map((paymentId) => issueOnDemand(issueDeps(), { paymentId })));

    const numbers = (await numbersOf(ids)).map(String).sort();
    expect(numbers).toEqual(Array.from({ length: 10 }, (_, i) => inv(i + 1)));
    expect(await lastNumber(teamId)).toBe(10);
  });

  it('runs two teams in parallel, each with its own gapless series from 1', async () => {
    const [a, b] = [await team(), await team()];
    const [idsA, idsB] = [
      await billed(a, 3, { status: 'PAID' }),
      await billed(b, 3, { status: 'PAID' }),
    ];

    await Promise.all([runIssueJob(a), runIssueJob(b)]);

    expect((await numbersOf(idsA)).map(String).sort()).toEqual([inv(1), inv(2), inv(3)]);
    expect((await numbersOf(idsB)).map(String).sort()).toEqual([inv(1), inv(2), inv(3)]);
  });

  it('leaves the counter unchanged and the sequence gapless when the issuing backend dies between allocation and COMMIT', async () => {
    const teamId = await team();
    const [first, second] = await billed(teamId, 2, { status: 'PAID' });
    const gated = createGatedDatabase(database.pool);
    const hold = gated.arm(/issue_payment_document/);

    const doomed = issueOnDemand({ db: gated.db, log: logs.logger }, { paymentId: first ?? '' });
    doomed.catch(() => undefined);
    await hold.reached; // the number is allocated and the transaction is open
    const { rows } = await database.pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'idle in transaction'
          AND query ILIKE '%issue_payment_document%'`,
    );
    expect(rows).toHaveLength(1);
    await database.pool.query('SELECT pg_terminate_backend($1)', [rows[0]?.pid]);
    hold.release();
    await expect(doomed).rejects.toBeDefined();

    expect(await lastNumber(teamId)).toBeUndefined();
    expect(await numberOf(first ?? '')).toBeNull();
    // The next issue takes the number the crash never consumed, and then the next one.
    expect((await issueOnDemand(issueDeps(), { paymentId: second ?? '' })).numberDisplay).toBe(
      inv(1),
    );
    expect((await issueOnDemand(issueDeps(), { paymentId: first ?? '' })).numberDisplay).toBe(
      inv(2),
    );
  });

  it('skips a payment that fails an integrity check (class 23), commits the others, and ends the run NonRetryableJobError', async () => {
    const teamId = await team();
    // `broken` is the first in paid order, so a drain that forgot it would pick it again and loop.
    const [broken] = await billed(teamId, 1, { status: 'PAID', paidAt: paidAt(1) });
    const [ok1] = await billed(teamId, 1, { status: 'PAID', paidAt: paidAt(2) });
    const [ok2] = await billed(teamId, 1, { status: 'PAID', paidAt: paidAt(3) });
    const issue: IssueDeps['issue'] = (db, paymentId, options) =>
      paymentId === broken
        ? Promise.reject(Object.assign(new Error('value: 1700 secret-quote'), { code: '23514' }))
        : issuePaymentDocument(db, paymentId, options);

    await expect(runIssueJob(teamId, { issue })).rejects.toBeInstanceOf(NonRetryableJobError);

    expect(await numbersOf([ok1 ?? '', ok2 ?? ''])).toEqual([inv(1), inv(2)]); // gapless: the failure took no number
    expect(await numberOf(broken ?? '')).toBeNull();
    const failed = logs.lines().find((line) => line.event === 'invoice.issue.failed');
    expect(failed).toMatchObject({ paymentId: broken, teamId, sqlState: '23514' });
    expect(JSON.stringify(logs.lines())).not.toContain('secret-quote');
  });

  it('re-enqueues itself without a transaction when the per-run limit leaves payments behind, until the backlog is clear', async () => {
    const teamId = await team();
    const ids = await billed(teamId, 5, { status: 'PAID' });

    await runIssueJob(teamId, { runLimit: 2 });
    expect((await numbersOf(ids)).filter((n) => n !== null)).toHaveLength(2);
    const followUp = issueEnqueues(teamId);
    expect(followUp).toMatchObject([{ inTransaction: false, data: { teamId } }]);
    expect(await issueJobs(teamId)).toHaveLength(1);

    await runIssueJob(teamId, { runLimit: 2 });
    await runIssueJob(teamId, { runLimit: 2 });
    expect((await numbersOf(ids)).map(String).sort()).toEqual([
      inv(1),
      inv(2),
      inv(3),
      inv(4),
      inv(5),
    ]);
    expect(await lastNumber(teamId)).toBe(5);
  });

  it('issueTeamBacklog reports its counts and never drains another team', async () => {
    const [a, b] = [await team(), await team()];
    await billed(a, 2, { status: 'PAID' });
    const [other] = await billed(b, 1, { status: 'PAID' });

    expect(await issueTeamBacklog(issueDeps(), { teamId: a })).toEqual({
      issued: 2,
      skipped: 0,
      failed: [],
      limitReached: false,
    });
    expect(await numberOf(other ?? '')).toBeNull();
  });
});

// =============================================================================================
// On demand (the download routes call this in Phase 3) (AC-ASYNC-1, AC-ASYNC-3, AC-ERROR-1, AC-ERROR-5)
// =============================================================================================

describe('issue on demand', () => {
  it('refuses a payment that is not PAID above $0.00 with invoice_not_available and consumes no number', async () => {
    const teamId = await team();
    const [pending] = await billed(teamId, 1, { status: 'PENDING' });
    const [overdue] = await billed(teamId, 1, { status: 'OVERDUE' });
    const [free] = await billed(teamId, 1, { status: 'PAID', amount: '0.00' });
    const processing = await attemptedPayment(teamId, 'OPEN');
    const held = await attemptedPayment(teamId, 'HELD');

    for (const paymentId of [pending, overdue, free, processing.paymentId, held.paymentId]) {
      const failure = await issueOnDemand(issueDeps(), { paymentId: paymentId ?? '' }).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AppError);
      expect(failure).toMatchObject({ code: 'invoice_not_available', status: 409 });
    }
    expect(await lastNumber(teamId)).toBeUndefined();
    expect(await documentCount(teamId)).toBe(0);
    const skipped = logs.lines().filter((line) => line.event === 'invoice.issue.skipped');
    expect(skipped.map((line) => line.reason).sort()).toEqual([
      'not_paid',
      'not_paid',
      'not_paid',
      'not_paid',
      'zero_amount',
    ]);
  });

  it('answers not_found for an unknown payment', async () => {
    await expect(
      issueOnDemand(issueDeps(), { paymentId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('issues an unissued PAID payment now: issued_at is the issue time, the paid date is untouched, and a repeat returns the same number', async () => {
    const teamId = await team();
    const [paymentId] = await billed(teamId, 1, { status: 'PAID', paidAt: paidAt(3) });
    const before = (await database.pool.query<{ t: Date }>('SELECT clock_timestamp() AS t')).rows[0]
      ?.t as Date;

    const first = await issueOnDemand(issueDeps(), { paymentId: paymentId ?? '' });
    const again = await issueOnDemand(issueDeps(), { paymentId: paymentId ?? '' });

    const after = (await database.pool.query<{ t: Date }>('SELECT clock_timestamp() AS t')).rows[0]
      ?.t as Date;
    expect(first).toEqual({ numberDisplay: inv(1), issued: true, documentKind: 'TAX_INVOICE' });
    expect(again).toEqual({ numberDisplay: inv(1), issued: false, documentKind: 'TAX_INVOICE' });
    const { rows } = await database.pool.query<{ paid_at: Date; invoice_issued_at: Date }>(
      'SELECT paid_at, invoice_issued_at FROM payments WHERE id = $1',
      [paymentId],
    );
    expect(rows[0]?.paid_at).toEqual(paidAt(3));
    expect(rows[0]?.invoice_issued_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(rows[0]?.invoice_issued_at.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(await lastNumber(teamId)).toBe(1);
    const lines = logs.lines().filter((line) => line.event === 'invoice.issued');
    expect(lines).toMatchObject([
      { paymentId, teamId, documentKind: 'TAX_INVOICE', trigger: 'on_demand' },
    ]);
  });

  it('retries once on a lock timeout (55P03) and then answers invoice_pending; a lock that clears in between is issued', async () => {
    const teamId = await team();
    const [stuck, clears] = await billed(teamId, 2, { status: 'PAID' });

    // Held the whole time: both attempts time out.
    const holder = await database.pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM payments WHERE id = $1 FOR UPDATE', [stuck]);
    let attempts = 0;
    const counting: IssueDeps['issue'] = (db, id, options) => {
      attempts += 1;
      return issuePaymentDocument(db, id, options);
    };
    try {
      await expect(
        issueOnDemand(issueDeps({ lockTimeoutMs: 100, issue: counting }), {
          paymentId: stuck ?? '',
        }),
      ).rejects.toMatchObject({ code: 'invoice_pending', status: 409 });
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(attempts).toBe(2);
    expect(await lastNumber(teamId)).toBeUndefined();

    // Released after the first timeout: the retry issues.
    const second = await database.pool.connect();
    await second.query('BEGIN');
    await second.query('SELECT id FROM payments WHERE id = $1 FOR UPDATE', [clears]);
    let calls = 0;
    const releasing: IssueDeps['issue'] = async (db, id, options) => {
      calls += 1;
      try {
        return await issuePaymentDocument(db, id, options);
      } catch (error) {
        if (calls === 1) await second.query('ROLLBACK');
        throw error;
      }
    };
    try {
      expect(
        await issueOnDemand(issueDeps({ lockTimeoutMs: 100, issue: releasing }), {
          paymentId: clears ?? '',
        }),
      ).toMatchObject({ numberDisplay: inv(1), issued: true });
    } finally {
      second.release();
    }
    expect(calls).toBe(2);
  });

  it('does not hide a failure that is not a lock timeout: it surfaces as is, never as invoice_pending', async () => {
    const teamId = await team();
    const [paymentId] = await billed(teamId, 1, { status: 'PAID' });
    let calls = 0;
    const flaky: IssueDeps['issue'] = () => {
      calls += 1;
      return Promise.reject(
        Object.assign(new Error('x'), { code: calls === 1 ? '55P03' : '57P01' }),
      );
    };
    const failure = await issueOnDemand(issueDeps({ issue: flaky }), {
      paymentId: paymentId ?? '',
    }).catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: '57P01' });
    expect(calls).toBe(2);
    await expect(
      issuePaymentDocument(kysely(), paymentId ?? '', { lockTimeoutMs: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(await lastNumber(teamId)).toBeUndefined();
  });
});

// =============================================================================================
// Settlement-route independence (AC-HAPPY-5)
// =============================================================================================

describe('settlement-route independence (AC-HAPPY-5)', () => {
  it('invoices a wallet payment, an Akahu payment and a hand-resolved hold alike, from payments columns only', async () => {
    const s = await billingScene({ flat: '17.00' });
    const walletUser = await registrant(s, { wallet: '60.00' });
    await bill(s); // PREPAID_CREDIT, no attempt row, one ledger row
    const akahu = await attemptedPayment(s.teamId, 'OPEN');
    await settleByAkahu(akahu.akahuPaymentId);
    const admin = await insertMember(database.pool, s.teamId);
    const held = await attemptedPayment(s.teamId, 'HELD');
    await resolveReceived(held.attemptId, admin);
    const walletPayment = (
      await database.pool.query<{ id: string }>('SELECT id FROM payments WHERE user_id = $1', [
        walletUser,
      ])
    ).rows[0]?.id as string;

    await runIssueJob(s.teamId);

    const ids = [walletPayment, akahu.paymentId, held.paymentId];
    expect((await numbersOf(ids)).map(String).sort()).toEqual([inv(1), inv(2), inv(3)]);
    const { rows } = await database.pool.query<{ document_kind: string; billing_type: string }>(
      `SELECT d.document_kind, p.billing_type FROM payment_documents d JOIN payments p ON p.id = d.payment_id
        WHERE p.team_id = $1 ORDER BY p.billing_type`,
      [s.teamId],
    );
    expect(rows.map((row) => row.document_kind)).toEqual([
      'TAX_INVOICE',
      'TAX_INVOICE',
      'TAX_INVOICE',
    ]);

    // The issuer reads no attempt, ledger or Akahu table: not in its SQL text, not in the statements the service runs.
    const { rows: functions } = await database.pool.query<{ prosrc: string }>(
      `SELECT prosrc FROM pg_proc WHERE proname IN ('issue_payment_document', 'assign_invoice_number')`,
    );
    expect(functions).toHaveLength(2);
    for (const fn of functions)
      expect(fn.prosrc).not.toMatch(/payment_attempts|credit_transactions|akahu|wallet_top_ups/i);
    const [fresh] = await billed(s.teamId, 1, { status: 'PAID' });
    const gated = createGatedDatabase(database.pool);
    await issueOnDemand({ db: gated.db, log: logs.logger }, { paymentId: fresh ?? '' });
    expect(gated.statements.length).toBeGreaterThan(0);
    for (const { sql } of gated.statements) {
      expect(sql).not.toMatch(/payment_attempts|credit_transactions|akahu|wallet_top_ups/i);
    }
  });
});

// =============================================================================================
// The reconcile sweep and the backfill of pre-feature payments (AC-ASYNC-3)
// =============================================================================================

describe('invoice-reconcile (AC-ASYNC-3, AC-ERROR-1, AC-ERROR-5)', () => {
  let sweepDb: TestDatabase;
  let sweepJobs: RecordingJobs;
  const sweepTeam = (gst = true) =>
    insertTeam(sweepDb.pool, {
      payoutConfigured: true,
      gstRegistered: gst,
      ...(gst ? { gstNumber: GST_NUMBER } : {}),
    });
  async function sweepBilled(teamId: string, options: BilledRegistrationOptions): Promise<string> {
    const sessionId = await insertSession(sweepDb.pool, teamId, {}, { maxPlayers: 4 });
    return (await insertBilledRegistration(sweepDb.pool, teamId, sessionId, options)).paymentId;
  }

  beforeAll(async () => {
    // Its own database: the sweep looks at every team, so no other test's unissued rows may be in it.
    sweepDb = await createTestDatabase({ poolMax: 10 });
  });
  afterAll(async () => {
    await sweepDb.close();
  });
  beforeEach(() => {
    sweepJobs = createRecordingJobs();
  });

  it('files one issue-invoices job per team that has leftovers, and none for a team with only unpaid, held, processing or $0.00 payments', async () => {
    const withLeftover = await sweepTeam();
    await sweepBilled(withLeftover, { status: 'PAID' });
    const allIssued = await sweepTeam();
    await issuePaymentDocument(
      createKysely(sweepDb.pool),
      await sweepBilled(allIssued, { status: 'PAID' }),
    );
    const nothingToIssue = await sweepTeam();
    await sweepBilled(nothingToIssue, { status: 'PENDING' });
    await sweepBilled(nothingToIssue, { status: 'OVERDUE' });
    await sweepBilled(nothingToIssue, { status: 'PAID', amount: '0.00' });
    const held = await sweepBilled(nothingToIssue, { status: 'PENDING' });
    await insertPaymentAttempt(sweepDb.pool, {
      paymentId: held,
      amount: '17.00',
      status: 'HELD',
      akahuPaymentId: providerId(1700),
      akahuStatus: 'SUBMITTED',
    });
    const processing = await sweepBilled(nothingToIssue, { status: 'PENDING' });
    await insertPaymentAttempt(sweepDb.pool, {
      paymentId: processing,
      amount: '17.00',
      status: 'OPEN',
      akahuPaymentId: providerId(1700),
    });

    const result = await runInvoiceReconcile({
      db: createKysely(sweepDb.pool),
      jobs: sweepJobs,
      log: logs.logger,
    });

    expect(result).toEqual({ teams: 1, enqueued: 1 });
    expect(sweepJobs.recorded).toMatchObject([
      {
        queue: 'issue-invoices',
        data: { teamId: withLeftover },
        singletonKey: `issue-invoices:${withLeftover}`,
        inTransaction: false,
      },
    ]);
    const { rows } = await sweepDb.pool.query(
      `SELECT 1 FROM team_invoice_counters WHERE team_id = $1`,
      [nothingToIssue],
    );
    expect(rows).toHaveLength(0); // last_number unchanged: no counter row was ever created for it
    expect(logs.lines().find((line) => line.event === 'invoice.reconcile.enqueued')).toMatchObject({
      teams: 1,
    });
  });

  it('backfills payments PAID before the feature: sweep, then each team job, numbers in paid order', async () => {
    const teamId = await sweepTeam();
    const newest = await sweepBilled(teamId, { status: 'PAID', paidAt: paidAt(20) });
    const oldest = await sweepBilled(teamId, { status: 'PAID', paidAt: paidAt(2) });
    const middle = await sweepBilled(teamId, { status: 'PAID', paidAt: paidAt(10) });
    await sweepBilled(teamId, { status: 'PENDING' });

    // The handler a worker runs for the slot or at boot.
    const sweep = createInvoiceReconcileHandler({
      db: createKysely(sweepDb.pool),
      jobs: sweepJobs,
    });
    await sweep({ source: 'boot' }, jobContext());
    const queued = sweepJobs.recorded.filter(
      (job) => (job.data as { teamId?: string }).teamId === teamId,
    );
    expect(queued).toHaveLength(1);
    await createIssueInvoicesHandler({ db: createKysely(sweepDb.pool), jobs: sweepJobs })(
      queued[0]?.data as { teamId: string },
      jobContext(),
    );

    const { rows } = await sweepDb.pool.query<{ id: string; n: string }>(
      `SELECT p.id, d.number_display AS n FROM payment_documents d JOIN payments p ON p.id = d.payment_id
        WHERE p.team_id = $1 ORDER BY d.number_display`,
      [teamId],
    );
    expect(rows.map((row) => [row.id, row.n])).toEqual([
      [oldest, inv(1)],
      [middle, inv(2)],
      [newest, inv(3)],
    ]);

    // A second sweep finds nothing for the team: the backfill is complete and re-running it is harmless.
    sweepJobs.reset();
    await sweep({}, jobContext());
    expect(
      sweepJobs.recorded.filter((job) => (job.data as { teamId?: string }).teamId === teamId),
    ).toEqual([]);
  });
});
