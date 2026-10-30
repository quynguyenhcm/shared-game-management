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
        'recurrence-rule',
        'registration-ban-reconcile',
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
      recurrenceRule: 'recurrence-rule',
      registrationBanReconcile: 'registration-ban-reconcile',
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
    // One daily ban-reconciliation sweep at a time; the member-banned singleton key is the per-membership guard (O4).
    expect(getQueue('registration-ban-reconcile').policy).toBe('exclusive');
  });

  it('runs one series at a time per key, with a trailing run, on a stately queue (SA-1, AC-ASYNC-1)', () => {
    // `singletonKey = recurrence-rule:<ruleId>`: one queued and one active job per rule, so an edit that commits during a run
    // queues exactly one trailing run that reads the latest rule. The sweep is exclusive: one sweep at a time.
    expect(getQueue('recurrence-rule').policy).toBe('stately');
    expect(getQueue('recurrence-materialisation').policy).toBe('exclusive');
  });

  it('applies a test-only expiry override to every queue without mutating the registry', () => {
    const overridden = withExpireOverride(QUEUES, 5);
    expect(overridden.every((queue) => queue.expireInSeconds === 5)).toBe(true);
    expect(getQueue('heartbeat').expireInSeconds).toBe(60);
    expect(withExpireOverride(QUEUES, undefined)).toEqual(QUEUES);
  });
});
