/**
 * Queue registry: the single source of truth for every queue's name and pg-boss options, shared by
 * the worker (which creates the queues) and producers (which only enqueue by name).
 *
 * DELIVERY GUARANTEE: AT-LEAST-ONCE (details in `lib/jobs/jobs.ts`). A job can run more than once
 * (worker crash, expiry, replay after completion), and `singletonKey` only suppresses concurrent
 * duplicates. Every handler registered here or by a later feature must therefore be idempotent
 * through its own durable guard: a unique constraint or a guarded status transition.
 *
 * Defaults (architecture Q4): retryLimit 3, retryDelay 5 s with exponential backoff, expiry 900 s
 * (heartbeat 60 s) and completed jobs kept for at least 7 days. Queues that rely on a
 * `singletonKey` for duplicate suppression use the `exclusive` policy: without it pg-boss ignores
 * the key on a `standard` queue.
 */
import type { QueueDefinition } from '../lib/jobs/jobs.ts';

export const QUEUE_NAMES = {
  heartbeat: 'heartbeat',
  recurrenceMaterialisation: 'recurrence-materialisation',
  postGameBilling: 'post-game-billing',
  dailyOverdue: 'daily-overdue',
  sendEmail: 'send-email',
  authCleanup: 'auth-cleanup',
  memberBanned: 'member-banned',
  skillProgression: 'skill-progression',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

const DEFAULTS = {
  retryLimit: 3,
  retryDelay: 5,
  retryBackoff: true,
  expireInSeconds: 900,
  retentionDays: 7,
} as const;

export const QUEUES: readonly QueueDefinition[] = [
  { ...DEFAULTS, name: QUEUE_NAMES.heartbeat, policy: 'standard', expireInSeconds: 60 },
  // Schedule slots: the scheduler enqueues into the queue named like the slot. One run at a time.
  { ...DEFAULTS, name: QUEUE_NAMES.recurrenceMaterialisation, policy: 'exclusive' },
  { ...DEFAULTS, name: QUEUE_NAMES.postGameBilling, policy: 'exclusive' },
  { ...DEFAULTS, name: QUEUE_NAMES.dailyOverdue, policy: 'exclusive' },
  // One email per idempotency key at a time (`singletonKey = notify:<idempotencyKey>`).
  { ...DEFAULTS, name: QUEUE_NAMES.sendEmail, policy: 'exclusive' },
  // Daily housekeeping of expired auth rows (sessions, tokens, OAuth state, throttle). One run at a time.
  { ...DEFAULTS, name: QUEUE_NAMES.authCleanup, policy: 'exclusive' },
  // A ban's side effect (cancel registrations, promote the waitlist): one job per membership
  // (`singletonKey = member-banned:<membershipId>`), enqueued in the ban's own transaction. ADR 0015.
  { ...DEFAULTS, name: QUEUE_NAMES.memberBanned, policy: 'exclusive' },
  // Daily skill progression sweep (skill-levels-and-auto-enroll): one run at a time. The member-row lock and the
  // guarded UPDATE, not this policy, are what make a redelivery or an overlapping run safe.
  { ...DEFAULTS, name: QUEUE_NAMES.skillProgression, policy: 'exclusive' },
];

export function getQueue(name: string): QueueDefinition {
  const queue = QUEUES.find((candidate) => candidate.name === name);
  if (!queue) throw new Error(`queue "${name}" is not registered`);
  return queue;
}

/** Test-only: replaces every queue's expiry (JOBS_EXPIRE_SECONDS_OVERRIDE). Returns new objects. */
export function withExpireOverride(
  queues: readonly QueueDefinition[],
  expireInSeconds: number | undefined,
): readonly QueueDefinition[] {
  if (expireInSeconds === undefined) return queues;
  return queues.map((queue) => ({ ...queue, expireInSeconds }));
}
