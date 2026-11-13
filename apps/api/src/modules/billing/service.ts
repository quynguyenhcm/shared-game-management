/**
 * The admin payment use cases (wallet-and-akahu-billing Phase 3): a team's payments list and the manual reminder (B6, CR-8).
 * The route guard (`TEAM_ADMIN` of the team in the path, or a GLOBAL_ADMIN) answers 401 and 403 in `onRequest`; everything here is
 * scoped to the team in the path, so another team's payment is the same 404 as an unknown id.
 *
 * The reminder is one transaction: lock the payment row `FOR UPDATE` (concurrent requests for one payment run one after the
 * other), answer a replay of (payment, `changeKey`) from the record, refuse a settled or too-recent payment, then append the
 * `payment_reminders` row and enqueue ONE sealed email in the same transaction (P5), so the email exists exactly when the
 * reminder is on record. Nothing here reads or writes a wallet, so the lock order stays payments only.
 */
import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import {
  documentKindOf,
  isDocumentAvailable,
  toMoneyString,
  type AdminPaymentsQuery,
  type AdminPaymentsResponse,
  type ReminderResponse,
  type SendReminderRequest,
} from '@sgm/shared';
import { enqueueEmail } from '../../jobs/send-email.ts';
import { refusing } from '../../lib/auth/team-refusals.ts';
import type { Clock } from '../../lib/clock.ts';
import type { FieldCrypto } from '../../lib/crypto/crypto.ts';
import type { Database } from '../../lib/db/kysely.ts';
import { AppError } from '../../lib/http/errors.ts';
import type { JobRunner } from '../../lib/jobs/jobs.ts';
import { buildReminderEmail } from './emails.ts';
import {
  ADMIN_PAYMENTS_PAGE_SIZE,
  listTeamPayments,
  readPaymentEmailFacts,
  readPayoutBlocked,
  type AdminPaymentsPosition,
} from './repo.ts';
import {
  findReminderByKey,
  insertReminder,
  latestReminderAt,
  reminderAllowed,
} from './reminders.ts';

/** The subset of the request logger the service uses (`request.log`, which carries the trace ids). */
export type BillingLogger = Pick<FastifyBaseLogger, 'info' | 'warn'>;

export interface BillingContext {
  readonly log: BillingLogger;
}

export interface BillingServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  /** Seals the reminder email (it carries a link). */
  readonly crypto: FieldCrypto;
  /** Job producer: the email is enqueued through it inside the reminder's own transaction. */
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  /** `config.auth.webBaseUrl`: origin of the web app, no trailing slash. */
  readonly webBaseUrl: string;
}

export interface BillingService {
  listTeamPayments(teamId: string, query: AdminPaymentsQuery): Promise<AdminPaymentsResponse>;
  sendReminder(
    teamId: string,
    paymentId: string,
    actorId: string,
    input: SendReminderRequest,
    ctx: BillingContext,
  ): Promise<ReminderResponse>;
}

/** Held back by one transaction's lock wait, in milliseconds. */
const LOCK_TIMEOUT_MS = 5000;

const CURSOR_DUE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const encodeCursor = (position: AdminPaymentsPosition): string =>
  Buffer.from(JSON.stringify({ d: position.dueCursor, i: position.id })).toString('base64url');

/** An unreadable cursor is a 422 on the `cursor` field; nothing from it reaches SQL unchecked. */
function decodeCursor(cursor: string): AdminPaymentsPosition {
  const invalid = new AppError('validation_failed', {
    fieldErrors: { cursor: ['That page link is not valid. Start again from the first page.'] },
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid;
  }
  const { d, i } = (parsed ?? {}) as { d?: unknown; i?: unknown };
  if (typeof d !== 'string' || typeof i !== 'string' || !CURSOR_DUE.test(d) || !CURSOR_ID.test(i)) {
    throw invalid;
  }
  return { dueCursor: d, id: i };
}

const firstName = (fullName: string): string => fullName.trim().split(/\s+/)[0] ?? 'there';

export function createBillingService(deps: BillingServiceDeps): BillingService {
  const { db, clock, crypto, jobs, webBaseUrl } = deps;

  return {
    async listTeamPayments(teamId, query) {
      const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      const rows = await listTeamPayments(db, { teamId, filter: query.status, after });
      const page = rows.slice(0, ADMIN_PAYMENTS_PAGE_SIZE);
      const last = page.at(-1);
      return {
        payments: page.map((row) => ({
          id: row.id,
          reference: row.reference,
          player: { userId: row.playerId, fullName: row.playerName },
          sessionStartsAt: row.sessionStartsAt.toISOString(),
          amount: toMoneyString(row.amount),
          status: row.status,
          dueDate: row.dueDate.toISOString(),
          paidAt: row.paidAt === null ? null : row.paidAt.toISOString(),
          lastReminderAt: row.lastReminderAt === null ? null : row.lastReminderAt.toISOString(),
          onHold: row.onHold,
          document: {
            kind: documentKindOf(row.gstRegistered),
            available: isDocumentAvailable(row.status, toMoneyString(row.amount)),
            number: row.documentNumber,
          },
        })),
        nextCursor:
          rows.length > ADMIN_PAYMENTS_PAGE_SIZE && last !== undefined
            ? encodeCursor({ dueCursor: last.dueCursor, id: last.id })
            : null,
        payoutBlocked: await readPayoutBlocked(db, teamId),
      };
    },

    sendReminder(teamId, paymentId, actorId, input, ctx) {
      return refusing(
        ctx.log,
        { action: 'send_payment_reminder', actorId, teamId },
        async (): Promise<ReminderResponse> => {
          const outcome = await db.transaction().execute(async (trx) => {
            await sql.raw(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`).execute(trx);
            // The payment is resolved together with its team: another team's payment is the same 404 as an unknown id.
            const payment = await trx
              .selectFrom('payments')
              .select(['id', 'status'])
              .where('id', '=', paymentId)
              .where('team_id', '=', teamId)
              .forUpdate()
              .executeTakeFirst();
            if (payment === undefined) throw new AppError('not_found');

            // A replay is answered first, from the record, whatever the payment's state or cooldown is now.
            const replay = await findReminderByKey(trx, { paymentId, changeKey: input.changeKey });
            if (replay !== undefined) return { sent: false, at: replay.createdAt };

            // CR-18: a held payment cannot be paid or retried, so a "Pay now" reminder would mislead the payer.
            if (payment.status !== 'PAID') {
              const held = await trx
                .selectFrom('payment_attempts')
                .select('id')
                .where('payment_id', '=', paymentId)
                .where('status', '=', 'HELD')
                .executeTakeFirst();
              if (held !== undefined) throw new AppError('payment_on_hold');
            }

            const last = await latestReminderAt(trx, paymentId);
            const now = clock.now(); // after the lock (P3), the one instant of this request
            const verdict = reminderAllowed(payment, last, now);
            if (!verdict.ok) throw new AppError(verdict.code);

            await insertReminder(trx, {
              paymentId,
              actorUserId: actorId,
              changeKey: input.changeKey,
              now,
            });
            const fact = (await readPaymentEmailFacts(trx, [paymentId])).get(paymentId);
            if (fact === undefined) throw new Error(`payment ${paymentId} has no payer to remind`);
            await enqueueEmail(
              jobs,
              buildReminderEmail({
                to: fact.email,
                firstName: firstName(fact.fullName),
                teamName: fact.teamName,
                teamId: fact.teamId,
                location: fact.location,
                startsAt: fact.startsAt,
                webBaseUrl,
                paymentId,
                changeKey: input.changeKey,
                amount: fact.amount,
                dueDate: fact.dueDate,
                overdue: payment.status === 'OVERDUE' || fact.dueDate.getTime() <= now.getTime(),
              }),
              { trx, crypto },
            );
            return { sent: true, at: now };
          });
          // After COMMIT; ids only (never the payer's address or the amount).
          if (outcome.sent) {
            ctx.log.info(
              { event: 'billing.reminder.sent', paymentId, teamId, actorId },
              'payment reminder sent',
            );
          }
          return { sent: true, lastReminderAt: outcome.at.toISOString() };
        },
      );
    },
  };
}
