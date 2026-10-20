/**
 * The `recurrence-rule` job contract (architecture SA-1, binding T-3): its strict payload, its singleton key and the one
 * function every producer uses to queue a run. Series create, edit and end call `enqueueRuleMaterialisation` on their own
 * transaction, "Publish drafts now" calls it after commit, and the nightly sweep calls it per active rule. The queue is
 * `stately`, so a run queued while another is active becomes exactly one trailing run that reads the latest rule.
 */
import { z } from 'zod';
import { QUEUE_NAMES } from '../../jobs/registry.ts';
import type { EnqueueOptions, JobRunner } from '../../lib/jobs/jobs.ts';

export const RECURRENCE_RULE_TRIGGERS = [
  'sweep',
  'rule_created',
  'rule_updated',
  'rule_ended',
  'manual',
] as const;

export const RecurrenceRulePayload = z.strictObject({
  ruleId: z.uuid(),
  teamId: z.uuid(),
  trigger: z.enum(RECURRENCE_RULE_TRIGGERS),
});
export type RecurrenceRulePayload = z.infer<typeof RecurrenceRulePayload>;

/** Singleton key of one rule's run: at most one queued and one active job per rule. */
export const recurrenceRuleKey = (ruleId: string): string => `recurrence-rule:${ruleId}`;

/**
 * Queues one materialisation run of a rule. Pass `trx` to enqueue inside the caller's transaction, so the job exists only
 * if the series change commits. Resolves to the job id, or `null` when a queued job for this rule already exists (the
 * trailing run is then already waiting, and it will read the latest rule).
 */
export function enqueueRuleMaterialisation(
  jobs: Pick<JobRunner, 'enqueue'>,
  input: RecurrenceRulePayload,
  options: Pick<EnqueueOptions, 'trx'> = {},
): Promise<string | null> {
  return jobs.enqueue(QUEUE_NAMES.recurrenceRule, input, {
    singletonKey: recurrenceRuleKey(input.ruleId),
    ...(options.trx === undefined ? {} : { trx: options.trx }),
  });
}
