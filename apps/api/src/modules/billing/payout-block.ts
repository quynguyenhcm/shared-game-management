/**
 * The manual payout block (wallet-and-akahu-billing Phase 4a; A3, CR-14; AC-ERROR-4 as amended; ADR 0016 R3). A GLOBAL_ADMIN
 * records that payments to a team's bank account are failing; Akahu documents no "destination rejected" signal, so this is the only
 * trigger (FAILED/REJECTED never blocks). One transaction:
 *
 *   1. `teams FOR NO KEY UPDATE` (first in the CR-4 order; billing's `KEY SHARE` is deliberately not blocked by it, ADR 0016);
 *   2. a replay of (team, `changeKey`) answers from the audit record and writes and sends nothing;
 *   3. `payout_blocked_at = now` only when it is not already set; the banking columns are never written, and the generated
 *      `is_payout_configured` turns false on its own (publish, top-up and attempt starts then answer 409 `payout_not_configured`);
 *   4. one append-only `payout_block_events` row (enum reason, optional Akahu payment id, no free text);
 *   5. when the block is new: one sealed email per approved TEAM_ADMIN, naming no account detail, keyed by the block instant;
 *   6. a best-effort `akahu-cancel` for the team's intents still waiting for the payer (OPEN with the mirror READY). One the payer
 *      has already authorised is left to complete (algorithm doc: "an already-open attempt completes normally").
 *
 * This file is the only writer of `payout_block_events` and the only code outside team-banking that sets `payout_blocked_at`.
 * There is no unblock: a team admin's banking re-save clears it.
 */
import { sql } from 'kysely';
import type { PayoutBlockReason } from '@sgm/shared';
import type { Clock } from '../../lib/clock.ts';
import type { FieldCrypto } from '../../lib/crypto/crypto.ts';
import type { Database } from '../../lib/db/kysely.ts';
import { AppError } from '../../lib/http/errors.ts';
import type { JobRunner } from '../../lib/jobs/jobs.ts';
import type { Logger } from '../../lib/logger/logger.ts';
import { enqueueEmail } from '../../jobs/send-email.ts';
import { enqueueAkahuCancel } from './apply-akahu-result.ts';
import { buildPayoutBlockedEmail } from './emails.ts';
import { listApprovedAdmins } from './engine-repo.ts';

const LOCK_TIMEOUT_MS = 5000;

export interface PayoutBlockDeps {
  readonly db: Database;
  /** Emails and cancels are enqueued INSIDE the block transaction. */
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  readonly clock: Clock;
  /** Seals the emails (they carry a link). */
  readonly crypto: FieldCrypto;
  /** `config.auth.webBaseUrl`: origin of the web app, no trailing slash. */
  readonly webBaseUrl: string;
}

export interface PayoutBlockInput {
  readonly teamId: string;
  /** The GLOBAL_ADMIN; null only for a future automatic trigger. */
  readonly actorUserId: string | null;
  readonly reason: PayoutBlockReason;
  readonly akahuPaymentId: string | null;
  readonly changeKey: string;
}

export interface PayoutBlockResult {
  readonly payoutBlockedAt: Date;
  readonly alreadyBlocked: boolean;
  readonly eventId: string;
  readonly replayed: boolean;
}

const firstNameOf = (fullName: string): string => fullName.trim().split(/\s+/)[0] ?? 'there';

export async function blockPayout(
  deps: PayoutBlockDeps,
  input: PayoutBlockInput,
  log: Pick<Logger, 'warn'>,
): Promise<PayoutBlockResult> {
  const result = await deps.db.transaction().execute(async (trx): Promise<PayoutBlockResult> => {
    await sql.raw(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`).execute(trx);
    const team = await trx
      .selectFrom('teams')
      .select(['id', 'name', 'payout_blocked_at'])
      .where('id', '=', input.teamId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (team === undefined) throw new AppError('not_found');

    const recorded = await trx
      .selectFrom('payout_block_events')
      .select(['id', 'created_at'])
      .where('team_id', '=', input.teamId)
      .where('change_key', '=', input.changeKey)
      .executeTakeFirst();
    if (recorded !== undefined) {
      // The first answer: the block instant, and whether it predates this event (it was already blocked then).
      const blockedAt = team.payout_blocked_at ?? recorded.created_at;
      return {
        payoutBlockedAt: blockedAt,
        alreadyBlocked: blockedAt.getTime() < recorded.created_at.getTime(),
        eventId: recorded.id,
        replayed: true,
      };
    }

    const now = deps.clock.now(); // once, after the lock
    const alreadyBlocked = team.payout_blocked_at !== null;
    const payoutBlockedAt = team.payout_blocked_at ?? now;
    if (!alreadyBlocked) {
      await trx
        .updateTable('teams')
        .set({ payout_blocked_at: now })
        .where('id', '=', input.teamId)
        .where('payout_blocked_at', 'is', null)
        .execute();
    }
    const event = await trx
      .insertInto('payout_block_events')
      .values({
        team_id: input.teamId,
        actor_user_id: input.actorUserId,
        reason: input.reason,
        akahu_payment_id: input.akahuPaymentId,
        change_key: input.changeKey,
        created_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    if (!alreadyBlocked) {
      for (const admin of await listApprovedAdmins(trx, input.teamId)) {
        await enqueueEmail(
          deps.jobs,
          buildPayoutBlockedEmail({
            to: admin.email,
            adminFirstName: firstNameOf(admin.fullName),
            adminId: admin.userId,
            teamName: team.name,
            teamId: input.teamId,
            payoutBlockedAt,
            webBaseUrl: deps.webBaseUrl,
          }),
          { trx, crypto: deps.crypto },
        );
      }
    }

    // Intents still waiting for the payer (never one already authorised: cancel.ts never cancels past READY anyway).
    const waiting = [
      ...(await trx
        .selectFrom('payment_attempts as a')
        .innerJoin('payments as p', 'p.id', 'a.payment_id')
        .select('a.akahu_payment_id')
        .where('p.team_id', '=', input.teamId)
        .where('a.status', '=', 'OPEN')
        .where((eb) =>
          eb.or([eb('a.akahu_status', 'is', null), eb('a.akahu_status', '=', 'READY')]),
        )
        .execute()),
      ...(await trx
        .selectFrom('wallet_top_ups as t')
        .select('t.akahu_payment_id')
        .where('t.team_id', '=', input.teamId)
        .where('t.status', '=', 'OPEN')
        .where((eb) =>
          eb.or([eb('t.akahu_status', 'is', null), eb('t.akahu_status', '=', 'READY')]),
        )
        .execute()),
    ];
    for (const row of waiting) {
      if (row.akahu_payment_id !== null) {
        await enqueueAkahuCancel(
          deps.jobs,
          { akahuPaymentId: row.akahu_payment_id, source: 'payout_block' },
          { trx },
        );
      }
    }
    return { payoutBlockedAt, alreadyBlocked, eventId: event.id, replayed: false };
  });
  if (!result.replayed) {
    // After COMMIT; ids and the enum reason only.
    log.warn(
      {
        event: 'billing.payout.blocked',
        teamId: input.teamId,
        actorId: input.actorUserId,
        blockReason: input.reason,
        eventId: result.eventId,
        alreadyBlocked: result.alreadyBlocked,
      },
      'team payout marked as failing',
    );
  }
  return result;
}
