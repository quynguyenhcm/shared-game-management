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
  billSession: 'bill-session',
  dailyOverdue: 'daily-overdue',
  sendEmail: 'send-email',
  authCleanup: 'auth-cleanup',
  memberBanned: 'member-banned',
  skillProgression: 'skill-progression',
  sessionAutoEnrol: 'session-auto-enrol',
  recurrenceRule: 'recurrence-rule',
  registrationBanReconcile: 'registration-ban-reconcile',
  akahuSync: 'akahu-sync',
  akahuCancel: 'akahu-cancel',
  akahuReconcile: 'akahu-reconcile',
  issueInvoices: 'issue-invoices',
  invoiceReconcile: 'invoice-reconcile',
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
  // One billing job per ended session (wallet-and-akahu-billing CR-13, `singletonKey = bill-session:<sessionId>`), enqueued by the
  // sweep. The worker runs it with local concurrency 1, so a backlog is billed oldest first (B9). The guarded PUBLISHED ->
  // COMPLETED move and `UNIQUE(registration_id)`, not this policy, are the durable once-only guards.
  { ...DEFAULTS, name: QUEUE_NAMES.billSession, policy: 'exclusive' },
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
  // The auto-enrol follow-up of one session (session-scheduling-engine, binding P-1, T-2, T-19): one job per session
  // (`singletonKey = session-auto-enrol:<sessionId>`), enqueued in the publish transaction. The D-80 marker, stamped under
  // the per-session advisory lock, is the durable once-only guard, not this policy.
  { ...DEFAULTS, name: QUEUE_NAMES.sessionAutoEnrol, policy: 'exclusive' },
  // One series' materialisation run (session-scheduling-engine SA-1, T-3): `singletonKey = recurrence-rule:<ruleId>`, enqueued
  // by the nightly sweep, the boot sweep and (in their own transactions) series create, edit, end and "Publish drafts now".
  // `stately` allows one queued and one active job per key, so an edit that commits during a run queues exactly one trailing
  // run that reads the latest rule. Idempotence comes from `uq_game_sessions_rule_date` and guarded UPDATEs, never from this policy.
  { ...DEFAULTS, name: QUEUE_NAMES.recurrenceRule, policy: 'stately' },
  // Daily ban reconciliation (registration-and-waitlist, architecture Q4, O4): one run at a time. The sweep only enqueues
  // `member-banned` jobs (singleton per membership), so overlap would at worst enqueue nothing twice.
  { ...DEFAULTS, name: QUEUE_NAMES.registrationBanReconcile, policy: 'exclusive' },
  // The single Akahu apply funnel (wallet-and-akahu-billing CR-3): one job per provider payment
  // (`singletonKey = akahu-sync:<akahuPaymentId>`), enqueued by the webhook, the return pages and the start paths. `stately` keeps
  // one queued plus one active job per id, so a webhook that arrives during a run queues exactly one trailing re-read. The
  // guarded intent transitions under the CR-4 row locks, not this policy, make a replay a no-op.
  { ...DEFAULTS, name: QUEUE_NAMES.akahuSync, policy: 'stately' },
  // Best-effort cancel of a provider payment still in READY (`singletonKey = akahu-cancel:<akahuPaymentId>`): a superseded
  // attempt, a payout block (CR-14) or an orphan created at Akahu whose local intent was already closed.
  { ...DEFAULTS, name: QUEUE_NAMES.akahuCancel, policy: 'exclusive' },
  // The 15-minute reconcile sweep (CR-12, CR-25): one run at a time; also queued at every worker boot.
  { ...DEFAULTS, name: QUEUE_NAMES.akahuReconcile, policy: 'exclusive' },
  // The tax invoices and receipts of ONE team (tax-invoices-and-exports, ADR 0021 section 2): `singletonKey = issue-invoices:<teamId>`,
  // enqueued by `bill-session` and the Akahu apply funnel inside their PAID transaction, and by the reconcile sweep. `stately`
  // keeps one queued plus one active run per team, so a PAID that commits during a run queues exactly one trailing run. The SQL
  // issuer's idempotence and the counter row lock, not this policy, keep the numbers unique and gapless.
  { ...DEFAULTS, name: QUEUE_NAMES.issueInvoices, policy: 'stately' },
  // The 15-minute sweep that queues `issue-invoices` for any team with a PAID payment still unnumbered (also the backfill of
  // pre-feature payments): one run at a time; also queued at every worker boot.
  { ...DEFAULTS, name: QUEUE_NAMES.invoiceReconcile, policy: 'exclusive' },
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
