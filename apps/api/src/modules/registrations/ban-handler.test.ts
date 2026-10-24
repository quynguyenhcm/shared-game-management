/**
 * The real `MemberBannedHandler` (architecture Q4, ADR 0015; AC-ASYNC-2, AC-ERROR-9), driven through its seams: the session
 * selection, the per-session transaction runner and the allocator are fakes, so these tests pin the handler's own rules:
 * one session per transaction in `(starts_at, id)` order, continue on error, transient-first classification, shutdown, and
 * a log that carries ids and codes only. The database side is `registrations-ban.int.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../lib/clock.ts';
import type { Database } from '../../lib/db/kysely.ts';
import { NonRetryableJobError } from '../../lib/jobs/jobs.ts';
import type { MemberBannedEvent, MemberBannedHookContext } from '../teams/ban-hook.ts';
import type { Allocator, WithdrawOutcome } from './allocator.ts';
import { classifyBanError, createRegistrationsBanHandler } from './ban-handler.ts';
import { RegistrationInvariantError } from './repo.ts';
import { JOB_POLICY, type AllocatorTxOptions, type AllocatorTxPolicy } from './tx.ts';

const TEAM = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const MEMBERSHIP = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const S1 = '00000000-0000-4000-8000-000000000001';
const S2 = '00000000-0000-4000-8000-000000000002';
const S3 = '00000000-0000-4000-8000-000000000003';

const NOW = new Date('2026-10-25T00:00:00Z');
const event: MemberBannedEvent = {
  teamId: TEAM,
  userId: USER,
  membershipId: MEMBERSHIP,
  bannedBy: ADMIN,
  bannedAt: NOW,
};

interface LogLine {
  readonly level: string;
  readonly bindings: Record<string, unknown>;
}

function dbError(code: string): Error {
  return Object.assign(new Error('boom: row data that must never be logged'), { code });
}

function harness(
  options: {
    targets?: readonly string[];
    outcomes?: Record<string, WithdrawOutcome | Error>;
    /** Simulates the worker shutting down once the first session has been handled. */
    abortAfterFirst?: boolean;
  } = {},
) {
  const targets = (options.targets ?? [S1, S2]).map((sessionId, index) => ({
    sessionId,
    startsAt: new Date(NOW.getTime() + (index + 1) * 3_600_000),
  }));
  const logs: LogLine[] = [];
  const log = (level: string) => (bindings: Record<string, unknown>) => {
    logs.push({ level, bindings });
  };
  const logger = {
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
  const calls: {
    sessionId: string;
    cause: string;
    teamId: string;
    userId: string;
  }[] = [];
  const transactions: { policy: AllocatorTxPolicy; path: string; teamId: string }[] = [];
  const listed: { teamId: string; userId: string; now: Date }[] = [];
  const clock = createManualClock(NOW);
  const controller = new AbortController();
  const handler = createRegistrationsBanHandler({
    db: {} as Database,
    jobs: { enqueue: () => Promise.resolve(null) },
    clock,
    webBaseUrl: 'https://games.example.nz',
    listTargets: (_db, input, now) => {
      listed.push({ ...input, now });
      return Promise.resolve(targets);
    },
    runTransaction: (_db, policy, txOptions: AllocatorTxOptions, work) => {
      transactions.push({ policy, path: txOptions.path, teamId: txOptions.teamId });
      return work({ trx: { fake: true } as never, now: txOptions.clock.now() });
    },
    allocator: {
      withdrawFromSession: (_ctx, input) => {
        calls.push({
          sessionId: input.sessionId,
          cause: input.cause,
          teamId: input.teamId,
          userId: input.userId,
        });
        if (options.abortAfterFirst === true) controller.abort();
        const outcome = options.outcomes?.[input.sessionId];
        if (outcome instanceof Error) return Promise.reject(outcome);
        return Promise.resolve(
          outcome ?? {
            ok: true,
            registrationId: `reg-${input.sessionId}`,
            withdrawalKind: 'BANNED',
            feeDue: false,
            wasConfirmed: true,
            promoted: [],
            liabilitiesReleased: 0,
          },
        );
      },
    } satisfies Pick<Allocator, 'withdrawFromSession'>,
  });
  const context: MemberBannedHookContext = {
    logger: logger as unknown as MemberBannedHookContext['logger'],
    signal: controller.signal,
    jobId: 'job-1',
    attempt: 1,
  };
  return { handler, context, calls, transactions, logs, listed, controller, clock };
}

describe('classifyBanError', () => {
  it.each([
    ['40P01', 'transient'],
    ['55P03', 'transient'],
    ['40001', 'transient'],
    ['57014', 'transient'],
    ['53300', 'transient'],
    ['08006', 'transient'],
    ['08001', 'transient'],
    ['23514', 'permanent'],
    ['23505', 'permanent'],
    ['23503', 'permanent'],
    ['23P01', 'permanent'],
  ])('SQLSTATE %s is %s', (code, expected) => {
    expect(classifyBanError(dbError(code))).toBe(expected);
  });

  it('treats a registration invariant breach as permanent', () => {
    expect(classifyBanError(new RegistrationInvariantError('x', 'r1'))).toBe('permanent');
  });

  it('treats an abort, a pool timeout and anything unknown as transient', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(classifyBanError(abort)).toBe('transient');
    expect(classifyBanError(new Error('timeout exceeded when trying to connect'))).toBe(
      'transient',
    );
    expect(classifyBanError('a string')).toBe('transient');
    expect(classifyBanError(undefined)).toBe('transient');
  });
});

describe('createRegistrationsBanHandler', () => {
  it('is named "registrations" for the job wrapper log', () => {
    expect(harness().handler.name).toBe('registrations');
  });

  it('selects once by current state with the clock reading, then withdraws each session in the given order with cause "ban"', async () => {
    const h = harness({ targets: [S1, S2, S3] });
    const outcome = await h.handler.handle(event, h.context);
    expect(outcome).toEqual({ affected: 3 });
    expect(h.listed).toEqual([{ teamId: TEAM, userId: USER, now: NOW }]);
    expect(h.calls.map((call) => [call.sessionId, call.cause, call.teamId, call.userId])).toEqual([
      [S1, 'ban', TEAM, USER],
      [S2, 'ban', TEAM, USER],
      [S3, 'ban', TEAM, USER],
    ]);
    // One transaction per session, each under the job policy.
    expect(h.transactions).toEqual([
      { policy: JOB_POLICY, path: 'ban', teamId: TEAM },
      { policy: JOB_POLICY, path: 'ban', teamId: TEAM },
      { policy: JOB_POLICY, path: 'ban', teamId: TEAM },
    ]);
  });

  it('returns affected 0 and touches nothing when the member has no active registration (a redelivery)', async () => {
    const h = harness({ targets: [] });
    expect(await h.handler.handle(event, h.context)).toEqual({ affected: 0 });
    expect(h.calls).toEqual([]);
  });

  it('counts a refusal as skipped, not affected and not a failure, and logs the reason', async () => {
    const h = harness({
      outcomes: { [S1]: { ok: false, reason: 'not_registered' } },
    });
    expect(await h.handler.handle(event, h.context)).toEqual({ affected: 1 });
    const skipped = h.logs.find(
      (line) => line.bindings.event === 'registration.ban.session_skipped',
    );
    expect(skipped).toMatchObject({
      level: 'info',
      bindings: { teamId: TEAM, sessionId: S1, userId: USER, reason: 'not_registered' },
    });
  });

  it('continues past a failing session, then rethrows a TRANSIENT error so the queue retries', async () => {
    const h = harness({ targets: [S1, S2, S3], outcomes: { [S2]: dbError('40001') } });
    const failure = await h.handler.handle(event, h.context).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(NonRetryableJobError);
    // The sessions on either side of the failure were still attempted.
    expect(h.calls.map((call) => call.sessionId)).toEqual([S1, S2, S3]);
    const failed = h.logs.find((line) => line.bindings.event === 'registration.ban.session_failed');
    expect(failed).toMatchObject({
      level: 'warn',
      bindings: {
        teamId: TEAM,
        sessionId: S2,
        userId: USER,
        class: 'transient',
        sqlState: '40001',
      },
    });
  });

  it('ends a PERMANENT failure as NonRetryableJobError after every session was attempted', async () => {
    const h = harness({
      targets: [S1, S2, S3],
      outcomes: { [S1]: new RegistrationInvariantError('team mismatch', 'r1') },
    });
    const failure = await h.handler.handle(event, h.context).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NonRetryableJobError);
    expect(h.calls.map((call) => call.sessionId)).toEqual([S1, S2, S3]);
    expect(
      h.logs.find((line) => line.bindings.event === 'registration.ban.session_failed'),
    ).toMatchObject({ level: 'error', bindings: { sessionId: S1, class: 'permanent' } });
  });

  it('throws transient when the run saw both kinds, so the retry re-attempts the transient one', async () => {
    const h = harness({
      targets: [S1, S2],
      outcomes: { [S1]: dbError('23514'), [S2]: dbError('55P03') },
    });
    const failure = await h.handler.handle(event, h.context).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(NonRetryableJobError);
  });

  it('stops between sessions on shutdown and throws a transient error, leaving the rest to the retry', async () => {
    const h = harness({ targets: [S1, S2, S3], abortAfterFirst: true });
    const failure = await h.handler.handle(event, h.context).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(NonRetryableJobError);
    expect(h.calls.map((call) => call.sessionId)).toEqual([S1]);
  });

  it('logs ids and codes only: never the error message, a name, an email or the ban reason', async () => {
    const h = harness({ outcomes: { [S1]: dbError('23514') } });
    await h.handler.handle(event, h.context).catch(() => undefined);
    const serialised = JSON.stringify(h.logs);
    expect(serialised).not.toContain('row data that must never be logged');
    expect(serialised).not.toMatch(/email|full_?name|ban_?reason/i);
  });

  it('never re-emits the allocator events (registration.created, withdrawn, promoted, refused)', async () => {
    const h = harness({ outcomes: { [S1]: { ok: false, reason: 'session_not_open' } } });
    await h.handler.handle(event, h.context);
    const events = h.logs.map((line) => String(line.bindings.event));
    expect(
      events.filter((name) => /^registration\.(created|withdrawn|promoted|refused)$/.test(name)),
    ).toEqual([]);
  });
});
