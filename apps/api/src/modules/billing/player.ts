/**
 * The payer's payment use cases (wallet-and-akahu-billing Phase 4a; CR-7, CR-16, CR-17, CR-3 return page): the payment page, the
 * caller's payments in a team, the caller's unpaid payments across teams, and the attempt start (`attempts.ts`). Everything is
 * scoped to the caller as payer: another person's payment and an unknown id are the same 404 `not_found`.
 *
 * The payment page's one side effect is a SIGNAL (CR-3): while the latest attempt is OPEN, one `akahu-sync` re-read is enqueued, at
 * most once per `SYNC_THROTTLE_MS` of the attempt's last real read. The page never calls Akahu and never applies a result.
 */
import {
  intentOutcome,
  toMoneyString,
  type AttemptResponse,
  type MyPaymentRow,
  type MyPaymentsQuery,
  type MyPaymentsResponse,
  type PaymentReason,
  type PaymentResponse,
  type StartAttemptRequest,
  type UnpaidPaymentsResponse,
} from '@sgm/shared';
import { SYNC_THROTTLE_MS } from '../../lib/akahu/constants.ts';
import { decodeKeysetCursor, encodeKeysetCursor } from '../../lib/http/cursor.ts';
import { AppError } from '../../lib/http/errors.ts';
import { enqueueAkahuSync } from './apply-akahu-result.ts';
import { startAttempt, type AttemptLogger, type AttemptStartDeps } from './attempts.ts';
import { findLatestAttempt } from './attempts-repo.ts';
import {
  PLAYER_PAYMENTS_PAGE_SIZE,
  findPayerPayment,
  listPayerTeamPayments,
  listPayerUnpaid,
  readPaymentLines,
  type PlayerPaymentRow,
} from './player-repo.ts';

export type PlayerPaymentsDeps = AttemptStartDeps;

export interface PlayerPaymentsService {
  readPayment(payerId: string, paymentId: string, log: AttemptLogger): Promise<PaymentResponse>;
  listTeamPayments(
    payerId: string,
    teamId: string,
    query: MyPaymentsQuery,
  ): Promise<MyPaymentsResponse>;
  listUnpaid(payerId: string, query: MyPaymentsQuery): Promise<UnpaidPaymentsResponse>;
  startAttempt(
    payerId: string,
    paymentId: string,
    input: StartAttemptRequest,
    log: AttemptLogger,
  ): Promise<AttemptResponse>;
}

const reasonOf = (row: PlayerPaymentRow): PaymentReason =>
  row.lateWithdrawal ? 'LATE_WITHDRAWAL' : 'CONFIRMED';

function toMyRow(row: PlayerPaymentRow): MyPaymentRow {
  return {
    id: row.id,
    reference: row.reference,
    sessionId: row.sessionId,
    sessionStartsAt: row.startsAt.toISOString(),
    location: row.location,
    amount: toMoneyString(row.amount),
    status: row.status,
    billingType: row.billingType,
    dueDate: row.dueDate.toISOString(),
    paidAt: row.paidAt === null ? null : row.paidAt.toISOString(),
    reason: reasonOf(row),
    outcome: intentOutcome(row.latestAttempt),
    onHold: row.onHold,
    payoutBlocked: !row.payoutConfigured,
  };
}

const nextCursorOf = (rows: readonly PlayerPaymentRow[]): string | null => {
  const last = rows[PLAYER_PAYMENTS_PAGE_SIZE - 1];
  return rows.length > PLAYER_PAYMENTS_PAGE_SIZE && last !== undefined
    ? encodeKeysetCursor({ at: last.dueCursor, id: last.id })
    : null;
};

export function createPlayerPaymentsService(deps: PlayerPaymentsDeps): PlayerPaymentsService {
  return {
    async readPayment(payerId, paymentId, log) {
      const row = await findPayerPayment(deps.db, payerId, paymentId);
      if (row === undefined) throw new AppError('not_found');
      const lines = await readPaymentLines(deps.db, paymentId);
      const attempt = await findLatestAttempt(deps.db, paymentId);

      if (attempt?.status === 'OPEN' && attempt.akahuPaymentId !== null) {
        const now = deps.clock.now();
        const stale =
          attempt.lastSyncedAt === null ||
          now.getTime() - attempt.lastSyncedAt.getTime() >= SYNC_THROTTLE_MS;
        if (stale) {
          try {
            await enqueueAkahuSync(deps.jobs, {
              akahuPaymentId: attempt.akahuPaymentId,
              source: 'return_page',
            });
          } catch (error) {
            // A read never fails because the signal could not be queued: the webhook and reconcile still come.
            log.warn(
              {
                event: 'billing.attempt.sync_enqueue_failed',
                attemptId: attempt.id,
                errorClass: error instanceof Error ? error.name : typeof error,
              },
              'return-page re-read could not be queued',
            );
          }
        }
      }

      return {
        payment: {
          id: row.id,
          reference: row.reference,
          teamName: row.teamName,
          session: {
            id: row.sessionId,
            location: row.location,
            startsAt: row.startsAt.toISOString(),
          },
          amount: toMoneyString(row.amount),
          gstAmount: toMoneyString(row.gstAmount),
          lines: lines.map((line) => ({
            position: line.position,
            basis: line.basis,
            unitFee: toMoneyString(line.unitFee),
          })),
          status: row.status,
          billingType: row.billingType,
          dueDate: row.dueDate.toISOString(),
          paidAt: row.paidAt === null ? null : row.paidAt.toISOString(),
          reason: reasonOf(row),
          attempt:
            attempt === undefined
              ? null
              : {
                  status: attempt.status,
                  startedAt: attempt.createdAt.toISOString(),
                  outcome: intentOutcome(attempt),
                },
          onHold: row.onHold,
          payoutBlocked: !row.payoutConfigured,
        },
      };
    },

    async listTeamPayments(payerId, teamId, query) {
      const rows = await listPayerTeamPayments(deps.db, {
        payerId,
        teamId,
        unpaidOnly: query.status === 'UNPAID',
        after: query.cursor === undefined ? undefined : decodeKeysetCursor(query.cursor),
      });
      return {
        payments: rows.slice(0, PLAYER_PAYMENTS_PAGE_SIZE).map(toMyRow),
        nextCursor: nextCursorOf(rows),
      };
    },

    async listUnpaid(payerId, query) {
      const rows = await listPayerUnpaid(deps.db, {
        payerId,
        after: query.cursor === undefined ? undefined : decodeKeysetCursor(query.cursor),
      });
      // Grouped by team in the order each team first appears (the most overdue payment leads).
      const teams = new Map<string, UnpaidPaymentsResponse['teams'][number]>();
      for (const row of rows.slice(0, PLAYER_PAYMENTS_PAGE_SIZE)) {
        let group = teams.get(row.teamId);
        if (group === undefined) {
          group = { teamId: row.teamId, teamName: row.teamName, payments: [] };
          teams.set(row.teamId, group);
        }
        group.payments.push(toMyRow(row));
      }
      return { teams: [...teams.values()], nextCursor: nextCursorOf(rows) };
    },

    startAttempt(payerId, paymentId, input, log) {
      return startAttempt(deps, { paymentId, payerId, idempotencyKey: input.idempotencyKey }, log);
    },
  };
}
