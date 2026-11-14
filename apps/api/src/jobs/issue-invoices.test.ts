/**
 * The `issue-invoices` and `invoice-reconcile` jobs' contracts against fake collaborators (tax-invoices-and-exports Phase 2;
 * AC-ASYNC-1, AC-ASYNC-2, AC-ASYNC-3). The issuance transaction itself, the drain order and every race run on real PostgreSQL in
 * `test/integration/invoice-issuance.int.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { NonRetryableJobError, type JobContext } from '../lib/jobs/jobs.ts';
import { createInvoiceReconcileHandler, runInvoiceReconcile } from './invoice-reconcile.ts';
import {
  ISSUE_RUN_LIMIT,
  IssueInvoicesPayload,
  createIssueInvoicesHandler,
  enqueueInvoiceIssuance,
  issueInvoicesKey,
} from './issue-invoices.ts';

const TEAM = '2f2e2d2c-2b2a-4928-8726-252423222120';
const OTHER_TEAM = '3a3b3c3d-3e3f-4a41-8243-444546474849';

function context() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = {
    logger,
    jobId: 'job-1',
    queue: 'issue-invoices',
    retryCount: 0,
    retryLimit: 3,
    signal: new AbortController().signal,
  } as unknown as JobContext;
  return { logger, ctx };
}

const events = (logger: { info: ReturnType<typeof vi.fn> }): unknown[] =>
  logger.info.mock.calls.map((call) => (call[0] as { event?: string }).event);

describe('enqueueInvoiceIssuance', () => {
  it('files one stately job per team under singletonKey issue-invoices:<teamId>, inside the given transaction', async () => {
    const enqueue = vi.fn().mockResolvedValue('job-1');
    const trx = { executeQuery: vi.fn() };
    await enqueueInvoiceIssuance({ enqueue }, { teamId: TEAM }, { trx });
    expect(enqueue).toHaveBeenCalledWith(
      'issue-invoices',
      { teamId: TEAM },
      { singletonKey: `issue-invoices:${TEAM}`, trx },
    );
    expect(issueInvoicesKey(TEAM)).toBe(`issue-invoices:${TEAM}`);
  });

  it('files outside a transaction when none is given', async () => {
    const enqueue = vi.fn().mockResolvedValue(null);
    await expect(enqueueInvoiceIssuance({ enqueue }, { teamId: TEAM })).resolves.toBeNull();
    expect(enqueue.mock.calls[0]?.[2]).toEqual({ singletonKey: `issue-invoices:${TEAM}` });
  });

  it('accepts only a strict { teamId } payload', () => {
    expect(IssueInvoicesPayload.safeParse({ teamId: TEAM }).success).toBe(true);
    for (const bad of [{}, { teamId: 'nope' }, { teamId: TEAM, extra: 1 }]) {
      expect(IssueInvoicesPayload.safeParse(bad).success).toBe(false);
    }
  });
});

describe('issue-invoices handler', () => {
  const drainResult = { issued: 2, skipped: 0, failed: [] as string[], limitReached: false };
  const handlerFor = (drain: ReturnType<typeof vi.fn>, enqueue = vi.fn()) =>
    createIssueInvoicesHandler({ db: {} as never, jobs: { enqueue }, drain: drain as never });

  it('drains the team with the per-run limit and logs the run totals only', async () => {
    const drain = vi.fn().mockResolvedValue(drainResult);
    const { ctx, logger } = context();
    await handlerFor(drain)({ teamId: TEAM }, ctx);
    expect(drain.mock.calls[0]?.[1]).toEqual({ teamId: TEAM, runLimit: ISSUE_RUN_LIMIT });
    expect(ISSUE_RUN_LIMIT).toBe(500);
    expect(logger.info).toHaveBeenCalledWith(
      { event: 'invoice.run.completed', teamId: TEAM, issued: 2, skipped: 0, failed: 0 },
      expect.any(String),
    );
  });

  it('fails a malformed payload at once, naming only field paths', async () => {
    const drain = vi.fn();
    const { ctx, logger } = context();
    await expect(handlerFor(drain)({ teamId: 'nope', secret: 'hush' }, ctx)).rejects.toBeInstanceOf(
      NonRetryableJobError,
    );
    expect(drain).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('hush');
  });

  it('re-enqueues itself without a transaction when the per-run limit left work behind', async () => {
    const drain = vi.fn().mockResolvedValue({ ...drainResult, limitReached: true });
    const enqueue = vi.fn().mockResolvedValue('job-2');
    const { ctx } = context();
    await handlerFor(drain, enqueue)({ teamId: TEAM }, ctx);
    expect(enqueue).toHaveBeenCalledWith(
      'issue-invoices',
      { teamId: TEAM },
      { singletonKey: `issue-invoices:${TEAM}` },
    );
  });

  it('ends the run NonRetryableJobError when any payment failed, after the others committed and the follow-up run was queued', async () => {
    const drain = vi
      .fn()
      .mockResolvedValue({ issued: 3, skipped: 0, failed: ['p1'], limitReached: true });
    const enqueue = vi.fn().mockResolvedValue('job-2');
    const { ctx } = context();
    await expect(handlerFor(drain, enqueue)({ teamId: TEAM }, ctx)).rejects.toBeInstanceOf(
      NonRetryableJobError,
    );
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('rethrows a transient failure as a fresh retryable error that never quotes the driver message', async () => {
    const drain = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('connection to 10.0.0.5 lost: secret'), { code: '57P01' }),
      );
    const { ctx, logger } = context();
    const failure = handlerFor(drain)({ teamId: TEAM }, ctx);
    await expect(failure).rejects.toThrow(/issue-invoices failed \(Error, SQLSTATE 57P01\)/);
    await expect(failure).rejects.not.toBeInstanceOf(NonRetryableJobError);
    await expect(failure).rejects.not.toThrow(/secret/);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'invoice.run.failed',
        teamId: TEAM,
        errorClass: 'Error',
        sqlState: '57P01',
      }),
      expect.any(String),
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
  });
});

describe('invoice-reconcile', () => {
  it('queues one issue-invoices job per team with leftovers, paging through the teams, and takes no transaction', async () => {
    const enqueue = vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce(null);
    const listTeams = vi.fn().mockResolvedValueOnce([TEAM, OTHER_TEAM]).mockResolvedValueOnce([]);
    const log = { info: vi.fn() };
    const result = await runInvoiceReconcile({
      db: {} as never,
      jobs: { enqueue },
      log,
      listTeams: listTeams as never,
      pageSize: 2,
    });
    expect(result).toEqual({ teams: 2, enqueued: 1 });
    expect(listTeams.mock.calls[1]?.[1]).toEqual({ after: OTHER_TEAM, limit: 2 });
    for (const call of enqueue.mock.calls) expect(call[2]).not.toHaveProperty('trx');
    expect(log.info).toHaveBeenCalledWith(
      { event: 'invoice.reconcile.enqueued', teams: 2, enqueued: 1 },
      expect.any(String),
    );
  });

  it('its handler runs the sweep and never rethrows the driver error', async () => {
    const handler = createInvoiceReconcileHandler({
      db: {} as never,
      jobs: { enqueue: vi.fn() },
      listTeams: vi.fn().mockRejectedValue(new Error('db down: secret-value')) as never,
    });
    const { ctx, logger } = context();
    const failure = handler({}, ctx);
    await expect(failure).rejects.toThrow(/invoice-reconcile failed \(Error\)/);
    await expect(failure).rejects.not.toThrow(/secret-value/);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret-value');
    expect(events(logger)).toEqual([]);
  });
});
