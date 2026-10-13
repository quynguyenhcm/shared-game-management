/**
 * The `member-banned` job handler (AC-ASYNC-2, AC-ERROR-12): validates the strict payload, re-reads the membership,
 * calls the injected port and classifies failures for the retry policy. The membership read is stubbed here; the
 * real queue and rows are exercised by `teams-ban-seam.int.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NonRetryableJobError, type JobContext } from '../lib/jobs/jobs.ts';
import type { MemberBannedHandler } from '../modules/teams/ban-hook.ts';
import * as repo from '../modules/teams/repo.ts';
import { createMemberBannedJobHandler } from './member-banned.ts';

vi.mock('../modules/teams/repo.ts', () => ({ findMembershipById: vi.fn() }));
const findMembershipById = vi.mocked(repo.findMembershipById);

interface Logged {
  level: string;
  fields: Record<string, unknown>;
}

function jobContext(overrides: Partial<Pick<JobContext, 'retryCount' | 'retryLimit'>> = {}) {
  const logs: Logged[] = [];
  const at = (level: string) => (fields: Record<string, unknown>) => {
    logs.push({ level, fields });
  };
  const ctx = {
    logger: { info: at('info'), warn: at('warn'), error: at('error') },
    jobId: 'job-1',
    queue: 'member-banned',
    retryCount: 0,
    retryLimit: 3,
    signal: new AbortController().signal,
    ...overrides,
  } as unknown as JobContext;
  return { ctx, logs };
}

const payload = () => ({
  teamId: randomUUID(),
  userId: randomUUID(),
  membershipId: randomUUID(),
  bannedBy: randomUUID(),
  bannedAt: '2026-10-13T01:02:03.000Z',
});

const handlerOf = (hook: MemberBannedHandler) =>
  createMemberBannedJobHandler({ db: {} as never, hook });

const okHook = (): MemberBannedHandler & { handle: ReturnType<typeof vi.fn> } => ({
  name: 'test',
  handle: vi.fn().mockResolvedValue({ affected: 2 }),
});

beforeEach(() => {
  findMembershipById.mockReset();
});

describe('payload validation', () => {
  it('fails non-retryably on a malformed payload and logs field paths only', async () => {
    const { ctx, logs } = jobContext();
    const hook = okHook();
    const bad = { ...payload(), userId: 'nope', email: 'private@example.test' };
    await expect(handlerOf(hook)(bad, ctx)).rejects.toBeInstanceOf(NonRetryableJobError);
    expect(hook.handle).not.toHaveBeenCalled();
    expect(findMembershipById).not.toHaveBeenCalled();
    const entry = logs.find((l) => l.fields.event === 'team.member.banned.invalid_payload');
    expect(entry?.level).toBe('error');
    expect(JSON.stringify(entry)).not.toContain('private@example.test');
    expect(entry?.fields.fields).toEqual(expect.arrayContaining(['userId']));
  });
});

describe('re-reading the membership', () => {
  it('completes as a no-op when the row is gone (team deleted)', async () => {
    findMembershipById.mockResolvedValue(undefined);
    const { ctx, logs } = jobContext();
    const hook = okHook();
    await expect(handlerOf(hook)(payload(), ctx)).resolves.toBeUndefined();
    expect(hook.handle).not.toHaveBeenCalled();
    expect(logs.map((l) => l.fields.event)).toContain('team.member.banned.stale');
  });

  it.each([
    [
      'ids that differ from the payload',
      (data: ReturnType<typeof payload>) => ({
        teamId: randomUUID(),
        userId: data.userId,
        status: 'BANNED' as const,
      }),
    ],
    [
      'a membership that is not BANNED',
      (data: ReturnType<typeof payload>) => ({
        teamId: data.teamId,
        userId: data.userId,
        status: 'APPROVED' as const,
      }),
    ],
  ])('fails non-retryably for %s and never calls the port', async (_label, row) => {
    const data = payload();
    findMembershipById.mockResolvedValue(row(data));
    const { ctx, logs } = jobContext();
    const hook = okHook();
    await expect(handlerOf(hook)(data, ctx)).rejects.toBeInstanceOf(NonRetryableJobError);
    expect(hook.handle).not.toHaveBeenCalled();
    expect(logs.find((l) => l.fields.event === 'team.member.banned.hook_failed')?.level).toBe(
      'error',
    );
  });
});

describe('calling the port', () => {
  const bannedRow = (data: ReturnType<typeof payload>) => ({
    teamId: data.teamId,
    userId: data.userId,
    status: 'BANNED' as const,
  });

  it('passes the event and context to the port and logs team.member.banned.handled', async () => {
    const data = payload();
    findMembershipById.mockResolvedValue(bannedRow(data));
    const { ctx, logs } = jobContext({ retryCount: 1 });
    const hook = okHook();
    await handlerOf(hook)(data, ctx);
    expect(hook.handle).toHaveBeenCalledTimes(1);
    const [event, hookContext] = hook.handle.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(event).toEqual({ ...data, bannedAt: new Date(data.bannedAt) });
    expect(hookContext).toMatchObject({ jobId: 'job-1', attempt: 2 });
    expect(logs.find((l) => l.fields.event === 'team.member.banned.handled')).toMatchObject({
      level: 'info',
      fields: { teamId: data.teamId, userId: data.userId, hook: 'test', affected: 2 },
    });
  });

  it('rethrows a transient failure with a warn log (will retry)', async () => {
    const data = payload();
    findMembershipById.mockResolvedValue(bannedRow(data));
    const { ctx, logs } = jobContext({ retryCount: 0, retryLimit: 3 });
    const hook = okHook();
    const boom = new Error('db blip');
    hook.handle.mockRejectedValue(boom);
    await expect(handlerOf(hook)(data, ctx)).rejects.toBe(boom);
    expect(logs.find((l) => l.fields.event === 'team.member.banned.hook_failed')).toMatchObject({
      level: 'warn',
      fields: { teamId: data.teamId, userId: data.userId, willRetry: true, attempt: 1 },
    });
  });

  it('logs an error once retries are exhausted, and for a non-retryable failure at once', async () => {
    const data = payload();
    findMembershipById.mockResolvedValue(bannedRow(data));

    const last = jobContext({ retryCount: 3, retryLimit: 3 });
    const failing = okHook();
    failing.handle.mockRejectedValue(new Error('still down'));
    await expect(handlerOf(failing)(data, last.ctx)).rejects.toThrow('still down');
    expect(
      last.logs.find((l) => l.fields.event === 'team.member.banned.hook_failed'),
    ).toMatchObject({ level: 'error', fields: { willRetry: false } });

    const first = jobContext({ retryCount: 0, retryLimit: 3 });
    const permanent = okHook();
    permanent.handle.mockRejectedValue(new NonRetryableJobError('invariant'));
    await expect(handlerOf(permanent)(data, first.ctx)).rejects.toBeInstanceOf(
      NonRetryableJobError,
    );
    expect(
      first.logs.find((l) => l.fields.event === 'team.member.banned.hook_failed'),
    ).toMatchObject({ level: 'error', fields: { willRetry: false } });
  });
});
