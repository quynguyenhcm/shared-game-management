/**
 * The payer's payment READ queries (wallet-and-akahu-billing Phase 4a; CR-16, CR-17, AC-HAPPY-12): the payment page, the caller's
 * payments in one team, and the caller's unpaid payments across teams. Every query is scoped by `payments.user_id = caller`, so a
 * payment of anyone else is simply absent (the route answers the uniform 404). Nothing here writes, locks or reads a clock; no
 * email address, bank detail or Akahu field is selected (only whether an attempt is held, and its status for the outcome).
 */
import { sql, type Kysely } from 'kysely';
import {
  parseMoney,
  type BillingType,
  type FeeBasis,
  type Money,
  type PaymentIntentStatus,
  type PaymentStatus,
} from '@sgm/shared';
import type { DB } from '../../lib/db/types.generated.ts';
import { KEYSET_TIME_FORMAT, type KeysetPosition } from '../../lib/http/cursor.ts';

/** Rows per page of the payer's lists. */
export const PLAYER_PAYMENTS_PAGE_SIZE = 50;

export interface PlayerPaymentRow {
  readonly id: string;
  readonly reference: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly payoutConfigured: boolean;
  readonly sessionId: string;
  readonly location: string;
  readonly startsAt: Date;
  readonly amount: Money;
  readonly gstAmount: Money;
  readonly status: PaymentStatus;
  readonly billingType: BillingType;
  readonly dueDate: Date;
  readonly paidAt: Date | null;
  readonly lateWithdrawal: boolean;
  readonly latestAttempt: {
    readonly status: PaymentIntentStatus;
    readonly closeReason: string | null;
  } | null;
  readonly onHold: boolean;
  /** Exact `due_date` text for the keyset cursor. */
  readonly dueCursor: string;
}

function baseQuery(db: Kysely<DB>, payerId: string) {
  return db
    .selectFrom('payments as p')
    .innerJoin('teams as t', 't.id', 'p.team_id')
    .innerJoin('registrations as r', 'r.id', 'p.registration_id')
    .innerJoin('game_sessions as s', 's.id', 'r.session_id')
    .select([
      'p.id',
      'p.payment_reference',
      'p.team_id',
      't.name as team_name',
      't.is_payout_configured',
      'r.session_id',
      'r.status as registration_status',
      's.location',
      's.starts_at',
      'p.amount',
      'p.gst_amount',
      'p.status',
      'p.billing_type',
      'p.due_date',
      'p.paid_at',
      sql<PaymentIntentStatus | null>`(SELECT a.status FROM payment_attempts a WHERE a.payment_id = p.id
                                        ORDER BY a.created_at DESC, a.id DESC LIMIT 1)`.as(
        'attempt_status',
      ),
      sql<string | null>`(SELECT a.close_reason FROM payment_attempts a WHERE a.payment_id = p.id
                            ORDER BY a.created_at DESC, a.id DESC LIMIT 1)`.as(
        'attempt_close_reason',
      ),
      sql<boolean>`EXISTS (SELECT 1 FROM payment_attempts a WHERE a.payment_id = p.id AND a.status = 'HELD')`.as(
        'on_hold',
      ),
      sql<string>`to_char(p.due_date AT TIME ZONE 'UTC', ${KEYSET_TIME_FORMAT})`.as('due_cursor'),
    ])
    .where('p.user_id', '=', payerId);
}

type BaseRow = Awaited<ReturnType<ReturnType<typeof baseQuery>['execute']>>[number];

const toRow = (row: BaseRow): PlayerPaymentRow => ({
  id: row.id,
  reference: row.payment_reference,
  teamId: row.team_id,
  teamName: row.team_name,
  payoutConfigured: row.is_payout_configured,
  sessionId: row.session_id,
  location: row.location,
  // `starts_at` is generated from the session's date and first court; the due instant stands in if it is ever missing.
  startsAt: row.starts_at ?? row.due_date,
  amount: parseMoney(row.amount),
  gstAmount: parseMoney(row.gst_amount),
  status: row.status,
  billingType: row.billing_type,
  dueDate: row.due_date,
  paidAt: row.paid_at,
  lateWithdrawal: row.registration_status === 'WITHDRAWN',
  latestAttempt:
    row.attempt_status === null
      ? null
      : { status: row.attempt_status, closeReason: row.attempt_close_reason },
  onHold: row.on_hold,
  dueCursor: row.due_cursor,
});

/** One payment of the payer, or undefined (another person's payment and an unknown id look the same). */
export async function findPayerPayment(
  db: Kysely<DB>,
  payerId: string,
  paymentId: string,
): Promise<PlayerPaymentRow | undefined> {
  const row = await baseQuery(db, payerId).where('p.id', '=', paymentId).executeTakeFirst();
  return row === undefined ? undefined : toRow(row);
}

export interface PaymentLine {
  readonly position: number;
  readonly basis: FeeBasis;
  readonly unitFee: Money;
}

export async function readPaymentLines(db: Kysely<DB>, paymentId: string): Promise<PaymentLine[]> {
  const rows = await db
    .selectFrom('payment_line_items')
    .select(['party_position', 'applied_basis', 'unit_fee'])
    .where('payment_id', '=', paymentId)
    .orderBy('party_position')
    .execute();
  return rows.map((row) => ({
    position: row.party_position,
    basis: row.applied_basis,
    unitFee: parseMoney(row.unit_fee),
  }));
}

/** The payer's payments in one team, newest due first (page size + 1 rows). `unpaidOnly` keeps PENDING and OVERDUE. */
export async function listPayerTeamPayments(
  db: Kysely<DB>,
  input: {
    readonly payerId: string;
    readonly teamId: string;
    readonly unpaidOnly: boolean;
    readonly after: KeysetPosition | undefined;
  },
): Promise<PlayerPaymentRow[]> {
  let query = baseQuery(db, input.payerId).where('p.team_id', '=', input.teamId);
  if (input.unpaidOnly) query = query.where('p.status', 'in', ['PENDING', 'OVERDUE']);
  if (input.after !== undefined) {
    query = query.where(
      sql<boolean>`(p.due_date, p.id) < (${input.after.at}::timestamptz, ${input.after.id}::uuid)`,
    );
  }
  const rows = await query
    .orderBy('p.due_date', 'desc')
    .orderBy('p.id', 'desc')
    .limit(PLAYER_PAYMENTS_PAGE_SIZE + 1)
    .execute();
  return rows.map(toRow);
}

/** The payer's PENDING and OVERDUE payments (held ones included) across every team, most overdue first (page size + 1 rows). */
export async function listPayerUnpaid(
  db: Kysely<DB>,
  input: { readonly payerId: string; readonly after: KeysetPosition | undefined },
): Promise<PlayerPaymentRow[]> {
  let query = baseQuery(db, input.payerId).where('p.status', 'in', ['PENDING', 'OVERDUE']);
  if (input.after !== undefined) {
    query = query.where(
      sql<boolean>`(p.due_date, p.id) > (${input.after.at}::timestamptz, ${input.after.id}::uuid)`,
    );
  }
  const rows = await query
    .orderBy('p.due_date', 'asc')
    .orderBy('p.id', 'asc')
    .limit(PLAYER_PAYMENTS_PAGE_SIZE + 1)
    .execute();
  return rows.map(toRow);
}
