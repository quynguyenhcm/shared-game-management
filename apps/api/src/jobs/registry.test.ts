import { describe, expect, it } from 'vitest';
import { QUEUE_NAMES, QUEUES, getQueue, withExpireOverride } from './registry.ts';

describe('queue registry', () => {
  it('declares every foundation queue once with the plan-level defaults', () => {
    expect(QUEUES.map((queue) => queue.name).sort()).toEqual(
      [
        'auth-cleanup',
        'daily-overdue',
        'heartbeat',
        'member-banned',
        'post-game-billing',
        'recurrence-materialisation',
        'send-email',
        'session-auto-enrol',
        'skill-progression',
      ].sort(),
    );
    expect(new Set(QUEUES.map((queue) => queue.name)).size).toBe(QUEUES.length);
    for (const queue of QUEUES) {
      expect(queue).toMatchObject({ retryLimit: 3, retryDelay: 5, retryBackoff: true });
      expect(queue.retentionDays).toBeGreaterThanOrEqual(7);
      expect(queue.expireInSeconds).toBe(queue.name === 'heartbeat' ? 60 : 900);
    }
  });

  it('exposes the binding schedule slot names as queue names', () => {
    expect(QUEUE_NAMES).toMatchObject({
      heartbeat: 'heartbeat',
      recurrenceMaterialisation: 'recurrence-materialisation',
      postGameBilling: 'post-game-billing',
      dailyOverdue: 'daily-overdue',
      sendEmail: 'send-email',
      authCleanup: 'auth-cleanup',
      memberBanned: 'member-banned',
      skillProgression: 'skill-progression',
      sessionAutoEnrol: 'session-auto-enrol',
    });
    expect(getQueue('heartbeat').name).toBe('heartbeat');
    expect(() => getQueue('nope')).toThrow(/not registered/);
  });

  it('uses exclusive policy where a singletonKey must suppress concurrent duplicates', () => {
    expect(getQueue('send-email').policy).toBe('exclusive');
    expect(getQueue('post-game-billing').policy).toBe('exclusive');
    // One cleanup run at a time: two overlapping runs would only fight over the same rows.
    expect(getQueue('auth-cleanup').policy).toBe('exclusive');
    // One ban job per membership (`singletonKey = member-banned:<membershipId>`), enqueued in the ban transaction.
    expect(getQueue('member-banned').policy).toBe('exclusive');
    // One daily progression sweep at a time; the per-member row lock is the real guard (AC-ASYNC-2).
    expect(getQueue('skill-progression').policy).toBe('exclusive');
    // One auto-enrol follow-up per session (`singletonKey = session-auto-enrol:<sessionId>`); the D-80 marker,
    // stamped under the advisory lock, is the durable once-only guard (T-19).
    expect(getQueue('session-auto-enrol').policy).toBe('exclusive');
  });

  it('adds only the auto-enrol follow-up queue in the one-off phase (recurrence-rule arrives with series)', () => {
    expect(QUEUES.map((queue) => queue.name)).not.toContain('recurrence-rule');
  });

  it('applies a test-only expiry override to every queue without mutating the registry', () => {
    const overridden = withExpireOverride(QUEUES, 5);
    expect(overridden.every((queue) => queue.expireInSeconds === 5)).toBe(true);
    expect(getQueue('heartbeat').expireInSeconds).toBe(60);
    expect(withExpireOverride(QUEUES, undefined)).toEqual(QUEUES);
  });
});
