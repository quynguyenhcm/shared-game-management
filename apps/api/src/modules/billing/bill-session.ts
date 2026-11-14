/**
 * `bill-session`: the post-game billing of ONE session, in ONE transaction (algorithm doc G, architecture Q4c; AC-HAPPY-2, 3, 5-7,
 * 11, AC-ERROR-5, 9). The sweep (`sweep.ts`) enqueues it per ended PUBLISHED session; delivery is at-least-once, so everything
 * here is idempotent through durable guards: the guarded PUBLISHED -> COMPLETED move (a replay finds COMPLETED and returns),
 * `UNIQUE(registration_id)` on `payments`, one AUTO_DEDUCTION per registration, and cause-derived email keys.
 *
 * Lock order (CR-4, `LOCK_ORDER`), the only one this transaction takes:
 *   teams FOR KEY SHARE (C-BIL-PAY, with `is_payout_configured`)
 *     -> game_sessions FOR UPDATE -> registrations / guests (read by the hand-off)
 *     -> player_credits (every wallet needed, one statement ordered by user_id) -> payments (inserted last).
 * The wallets are locked BEFORE the payments are inserted because `payments.billing_type` is immutable and depends on the locked
 * balance. Nothing here waits on Akahu (no external call exists in this path), and the whole thing is one lock-timeout window.
 *
 * The clock is read once, AFTER the locks (P3): a wait on a lock can never make the session look due earlier than it was. The
 * session is billed only when `now >= ends_at` (which implies `now >= starts_at`, C-BIL-3). Billing never writes `registrations`
 * (C-ALL-1); it bills exactly `listBillableRegistrations`.
 *
 * B8: a PAID session whose team cannot take payments is held. Nothing is written except the `billing_session_blocks` marker; the
 * session stays PUBLISHED, the admins get one "Billing is paused" email per session (the marker claims it), and the first sweep
 * after the account is fixed bills it normally. A free session writes no payment, so it completes whatever the team's state.
 */
import { sql } from 'kysely';
import { isZero, negate, type Money, type SessionFeeColumns } from '@sgm/shared';
import type { Clock } from '../../lib/clock.ts';
import type { FieldCrypto } from '../../lib/crypto/crypto.ts';
import type { Database } from '../../lib/db/kysely.ts';
import type { JobRunner } from '../../lib/jobs/jobs.ts';
import type { Logger } from '../../lib/logger/logger.ts';
import type { EmailMessage } from '../../lib/notifications/notifier.ts';
import { enqueueInvoiceIssuance } from '../../jobs/issue-invoices.ts';
import { enqueueEmail } from '../../jobs/send-email.ts';
import { listBillableRegistrations } from '../registrations/billing-handoff.ts';
import { isPaidSession } from '../team-banking/publish-gate.ts';
import { applyMovement, lockWallets } from '../wallet/ledger.ts';
import { billingDueDate, computeCharge, decideSettlement } from './charge.ts';
import { buildBillingPausedEmail, buildLowCreditEmail, buildPaymentDueEmail } from './emails.ts';
import {
  claimBillingBlockNotice,
  completeSession,
  insertCharge,
  listApprovedAdmins,
  lockSessionForBilling,
  lockTeamForBilling,
  readRecipients,
  readSessionTeam,
  type BillingSession,
} from './engine-repo.ts';

/** Held back by one transaction's lock wait, in milliseconds: a longer wait fails the job and pg-boss retries it. */
const LOCK_TIMEOUT_MS = 5000;

export interface BillSessionDeps {
  readonly db: Database;
  /** The worker's runner: emails are enqueued INSIDE the billing transaction (P5). */
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  readonly clock: Clock;
  /** Seals the emails (they carry links). */
  readonly crypto: FieldCrypto;
  /** `config.auth.webBaseUrl`: origin of the web app, no trailing slash. */
  readonly webBaseUrl: string;
  readonly log: Pick<Logger, 'info' | 'warn'>;
}

export type BillSessionOutcome =
  | {
      readonly kind: 'completed';
      readonly payments: number;
      readonly deducted: number;
      readonly linked: number;
      readonly zero: number;
    }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'skipped'; readonly reason: 'missing' | 'not_published' | 'not_due' };

/** The session's fee columns as the shared fee rule reads them. */
function feeColumns(session: BillingSession): SessionFeeColumns {
  return {
    pricing: session.pricing_structure,
    flat: session.fee_flat,
    male: session.fee_male,
    female: session.fee_female,
    other: session.fee_other,
    beginner: session.fee_beginner,
    intermediate: session.fee_intermediate,
    advanced: session.fee_advanced,
  };
}

const firstName = (fullName: string): string => fullName.trim().split(/\s+/)[0] ?? 'there';

export async function billSession(
  deps: BillSessionDeps,
  input: { readonly sessionId: string },
): Promise<BillSessionOutcome> {
  const outcome = await deps.db.transaction().execute(async (trx): Promise<BillSessionOutcome> => {
    // The value is a constant integer, so inlining it is safe (SET cannot take a bind parameter).
    await sql.raw(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`).execute(trx);
    const sessionId = input.sessionId;

    const teamId = await readSessionTeam(trx, sessionId);
    if (teamId === undefined) return { kind: 'skipped', reason: 'missing' };
    const team = await lockTeamForBilling(trx, teamId); // 1. teams FOR KEY SHARE + is_payout_configured
    if (team === undefined) return { kind: 'skipped', reason: 'missing' };
    const session = await lockSessionForBilling(trx, { sessionId, teamId }); // 2. game_sessions FOR UPDATE
    if (session === undefined) return { kind: 'skipped', reason: 'missing' };
    if (session.status !== 'PUBLISHED') return { kind: 'skipped', reason: 'not_published' };

    const now = deps.clock.now(); // once, after the locks (P3)
    if (session.ends_at === null || now < session.ends_at) {
      return { kind: 'skipped', reason: 'not_due' };
    }

    const fees = feeColumns(session);
    const paid = isPaidSession(session.pricing_structure, {
      feeFlat: session.fee_flat,
      feeMale: session.fee_male,
      feeFemale: session.fee_female,
      feeOther: session.fee_other,
      feeBeginner: session.fee_beginner,
      feeIntermediate: session.fee_intermediate,
      feeAdvanced: session.fee_advanced,
    });
    const facts = {
      teamName: team.name,
      teamId,
      location: session.location,
      startsAt: session.starts_at ?? session.ends_at,
      webBaseUrl: deps.webBaseUrl,
    };
    const send = (message: EmailMessage): Promise<string | null> =>
      enqueueEmail(deps.jobs, message, { trx, crypto: deps.crypto });

    if (paid && !team.isPayoutConfigured) {
      // B8: hold the whole session. Only the marker is written; the admins are told once per session.
      if (await claimBillingBlockNotice(trx, { sessionId, teamId, now })) {
        for (const admin of await listApprovedAdmins(trx, teamId)) {
          await send(
            buildBillingPausedEmail({
              ...facts,
              to: admin.email,
              adminFirstName: firstName(admin.fullName),
              adminId: admin.userId,
              sessionId,
            }),
          );
        }
      }
      return { kind: 'blocked' };
    }

    // 3. The hand-off: exactly the registrations billing may charge (a free session has none to charge).
    const registrations = paid ? await listBillableRegistrations(trx, sessionId, now) : [];
    if (!(await completeSession(trx, sessionId))) {
      throw new Error(`session ${sessionId} left PUBLISHED while billing held its lock`);
    }
    if (registrations.length === 0) {
      return { kind: 'completed', payments: 0, deducted: 0, linked: 0, zero: 0 };
    }

    const charges = registrations.map((registration) => ({
      registration,
      charge: computeCharge(fees, registration),
    }));
    // 4. Wallets: every one that may be needed, locked once, ordered by user_id (CR-4), before any payment is inserted.
    const wallets = await lockWallets(
      trx,
      teamId,
      charges
        .filter(({ charge }) => !isZero(charge.total))
        .map(({ registration }) => registration.userId),
    );
    const balances = new Map<string, Money>(
      [...wallets.values()].map((wallet) => [wallet.userId, wallet.balance]),
    );

    const dueDate = billingDueDate(now);
    let deducted = 0;
    let linked = 0;
    let zero = 0;
    const pendingEmails: ((
      recipients: Awaited<ReturnType<typeof readRecipients>>,
    ) => EmailMessage)[] = [];
    const recipientIds: string[] = [];

    // 5. Per registration, in hand-off order: insert the payment (and its lines), then take the wallet or leave it PENDING.
    for (const { registration, charge } of charges) {
      const settlement = decideSettlement(balances.get(registration.userId) ?? null, charge.total);
      const common = {
        teamId,
        userId: registration.userId,
        registrationId: registration.registrationId,
        pricing: session.pricing_structure,
        amount: charge.total,
        dueDate,
        lines: charge.lines,
      };
      if (settlement.kind === 'LINK') {
        const { paymentId } = await insertCharge(trx, {
          ...common,
          billingType: 'PER_GAME',
          status: 'PENDING',
          paidAt: null,
        });
        linked += 1;
        const walletBalance = balances.get(registration.userId) ?? null;
        recipientIds.push(registration.userId);
        pendingEmails.push((recipients) =>
          buildPaymentDueEmail({
            ...facts,
            to: recipients.get(registration.userId)?.email ?? '',
            firstName: firstName(recipients.get(registration.userId)?.fullName ?? ''),
            paymentId,
            amount: charge.total,
            dueDate,
            guestCount: registration.guests.length,
            reason: registration.reason,
            walletBalance,
          }),
        );
      } else if (settlement.kind === 'ZERO') {
        // B7: recorded so reports and invoices see the party; no link, no email, no wallet movement.
        await insertCharge(trx, {
          ...common,
          billingType: 'PER_GAME',
          status: 'PAID',
          paidAt: now,
        });
        zero += 1;
      } else {
        await insertCharge(trx, {
          ...common,
          billingType: 'PREPAID_CREDIT',
          status: 'PAID',
          paidAt: now,
        });
        const movement = await applyMovement(trx, {
          userId: registration.userId,
          teamId,
          type: 'AUTO_DEDUCTION',
          amount: negate(charge.total),
          registrationId: registration.registrationId,
        });
        balances.set(registration.userId, movement.resultingBalance);
        deducted += 1;
        if (settlement.lowCredit) {
          recipientIds.push(registration.userId);
          pendingEmails.push((recipients) =>
            buildLowCreditEmail({
              ...facts,
              to: recipients.get(registration.userId)?.email ?? '',
              firstName: firstName(recipients.get(registration.userId)?.fullName ?? ''),
              deducted: charge.total,
              balance: movement.resultingBalance,
              creditTransactionId: movement.id,
            }),
          );
        }
      }
    }

    // 5b. Invoices (tax-invoices-and-exports, ADR 0021): billing only ENQUEUES. One `issue-invoices` job per team, inside this
    // transaction, when a wallet paid a fee (a PREPAID_CREDIT payment is PAID above $0.00). A $0.00 party is PAID too but has no
    // document, and a PENDING link is not paid, so neither enqueues. Billing never sets an invoice column (ADR 0020 C-INV-1).
    if (deducted > 0) await enqueueInvoiceIssuance(deps.jobs, { teamId }, { trx });

    // 6. Emails, in the same transaction: they exist exactly when this billing commits (P5, AC-ASYNC-4).
    const recipients = await readRecipients(trx, recipientIds);
    for (const build of pendingEmails) await send(build(recipients));

    return { kind: 'completed', payments: charges.length, deducted, linked, zero };
  });

  // Logged after COMMIT, so a line never describes work that rolled back.
  if (outcome.kind === 'completed') {
    deps.log.info(
      {
        event: 'billing.session.completed',
        sessionId: input.sessionId,
        payments: outcome.payments,
        deducted: outcome.deducted,
        linked: outcome.linked,
        zero: outcome.zero,
      },
      'session billed',
    );
  } else if (outcome.kind === 'blocked') {
    deps.log.warn(
      { event: 'billing.session.blocked', sessionId: input.sessionId },
      'session held: the team cannot take payments',
    );
  }
  return outcome;
}
