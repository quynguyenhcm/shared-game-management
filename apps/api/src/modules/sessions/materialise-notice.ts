/**
 * The weekly "bank account needed" claim and email (AC-ASYNC-3; binding T-4, T-18). The claim is a row in
 * `payout_notice_claims (rule_id, window_start)` taken with `INSERT … ON CONFLICT DO NOTHING RETURNING` in the SAME
 * transaction as the instance or draft that was refused. Only the transaction that gets a row back enqueues the emails, so two
 * concurrent runs, a retry and a replay together send one set per rule per NZ week. The rule row is never updated by it.
 */
import type { Transaction } from 'kysely';
import type { LocalDate } from '@sgm/shared';
import type { EmailMessage } from '../../lib/notifications/notifier.ts';
import type { DB } from '../../lib/db/types.generated.ts';
import { buildPayoutMissingEmail } from './emails.ts';

/** Queues one email on the caller's transaction (production: `enqueueEmail` over the worker's runner). */
export type SendEmailOnTransaction = (
  message: EmailMessage,
  trx: Transaction<DB>,
) => Promise<unknown>;

export interface PayoutNoticeDeps {
  readonly sendEmail: SendEmailOnTransaction;
  readonly webBaseUrl: string;
}

/**
 * Claims this rule's NZ week and, only when the claim is new, emails every approved admin. Returns whether it emailed.
 * Must run inside the transaction of the refused instance, after the team and rule locks.
 */
export async function claimPayoutNotice(
  trx: Transaction<DB>,
  deps: PayoutNoticeDeps,
  input: { readonly teamId: string; readonly ruleId: string; readonly windowStart: LocalDate },
): Promise<boolean> {
  const claimed = await trx
    .insertInto('payout_notice_claims')
    .values({ rule_id: input.ruleId, window_start: input.windowStart })
    .onConflict((conflict) => conflict.columns(['rule_id', 'window_start']).doNothing())
    .returning('rule_id')
    .executeTakeFirst();
  if (claimed === undefined) return false;

  const team = await trx
    .selectFrom('teams')
    .select('name')
    .where('id', '=', input.teamId)
    .executeTakeFirst();
  const admins = await trx
    .selectFrom('team_members as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select(['u.id as user_id', 'u.email'])
    .where('m.team_id', '=', input.teamId)
    .where('m.role', '=', 'TEAM_ADMIN')
    .where('m.status', '=', 'APPROVED')
    .orderBy('u.id')
    .execute();
  for (const admin of admins) {
    await deps.sendEmail(
      buildPayoutMissingEmail({
        to: admin.email,
        recipientId: admin.user_id,
        teamId: input.teamId,
        teamName: team?.name ?? 'your team',
        ruleId: input.ruleId,
        windowStart: input.windowStart,
        webBaseUrl: deps.webBaseUrl,
      }),
      trx,
    );
  }
  return true;
}
