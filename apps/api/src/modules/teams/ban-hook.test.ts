/**
 * The ban seam's port side (AC-ASYNC-1, AC-ASYNC-2): a strict id-only payload, the deterministic singleton key,
 * the in-transaction enqueue helper and the safe no-op default handler.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  MemberBannedPayload,
  enqueueMemberBanned,
  memberBannedSingletonKey,
  noopMemberBannedHandler,
  toMemberBannedEvent,
  type MemberBannedHookContext,
} from './ban-hook.ts';

const payload = (): MemberBannedPayload => ({
  teamId: randomUUID(),
  userId: randomUUID(),
  membershipId: randomUUID(),
  bannedBy: randomUUID(),
  bannedAt: '2026-10-13T01:02:03.456Z',
});

describe('MemberBannedPayload (AC-ASYNC-1)', () => {
  it('accepts exactly the five id/timestamp fields', () => {
    expect(MemberBannedPayload.safeParse(payload()).success).toBe(true);
  });

  it.each([
    ['a name', { fullName: 'Someone' }],
    ['an email', { email: 'someone@example.test' }],
    ['the reason', { banReason: 'rude' }],
  ])('rejects %s: the payload carries ids only', (_label, extra) => {
    expect(MemberBannedPayload.safeParse({ ...payload(), ...extra }).success).toBe(false);
  });

  it('rejects a non-UUID id and a bannedAt that is not UTC ISO-8601', () => {
    expect(MemberBannedPayload.safeParse({ ...payload(), teamId: 'nope' }).success).toBe(false);
    expect(MemberBannedPayload.safeParse({ ...payload(), bannedAt: '2026-10-13' }).success).toBe(
      false,
    );
    expect(
      MemberBannedPayload.safeParse({ ...payload(), bannedAt: '2026-10-13T01:02:03+13:00' })
        .success,
    ).toBe(false);
  });

  it('converts to an event with a real Date', () => {
    const data = payload();
    expect(toMemberBannedEvent(data)).toEqual({
      ...data,
      bannedAt: new Date('2026-10-13T01:02:03.456Z'),
    });
  });
});

describe('enqueueMemberBanned', () => {
  it('enqueues on the member-banned queue inside the given transaction with the membership singleton key', async () => {
    const data = payload();
    const enqueue = vi.fn().mockResolvedValue('job-1');
    const trx = { executeQuery: vi.fn() };
    const id = await enqueueMemberBanned({ enqueue }, data, { trx });
    expect(id).toBe('job-1');
    expect(enqueue).toHaveBeenCalledWith('member-banned', data, {
      singletonKey: `member-banned:${data.membershipId}`,
      trx,
    });
    expect(memberBannedSingletonKey(data.membershipId)).toBe(`member-banned:${data.membershipId}`);
  });

  it('refuses a payload that is not strict, before anything is enqueued', async () => {
    const enqueue = vi.fn();
    await expect(
      enqueueMemberBanned({ enqueue }, { ...payload(), email: 'x@y.test' } as never, {
        trx: { executeQuery: vi.fn() },
      }),
    ).rejects.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('noopMemberBannedHandler (AC-ASYNC-2)', () => {
  it('logs team.member.banned.hook_noop with ids only and succeeds, so a replay changes nothing', async () => {
    const info = vi.fn();
    const data = payload();
    const context = {
      logger: { info },
      signal: new AbortController().signal,
      jobId: 'j',
      attempt: 1,
    } as unknown as MemberBannedHookContext;
    const event = toMemberBannedEvent(data);
    expect(noopMemberBannedHandler.name).toBe('noop');
    await expect(noopMemberBannedHandler.handle(event, context)).resolves.toEqual({ affected: 0 });
    await expect(noopMemberBannedHandler.handle(event, context)).resolves.toEqual({ affected: 0 });
    expect(info).toHaveBeenCalledTimes(2);
    const [fields] = info.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({
      event: 'team.member.banned.hook_noop',
      teamId: data.teamId,
      userId: data.userId,
    });
    expect(Object.keys(fields).sort()).toEqual(
      ['event', 'membershipId', 'teamId', 'userId'].sort(),
    );
  });
});
