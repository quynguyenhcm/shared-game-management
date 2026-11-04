/**
 * Billing's READ queries for the payment routes and the daily job's emails (wallet-and-akahu-billing Phase 3). Nothing here writes:
 * `payments` is written only by `engine-repo.ts`, `overdue.ts` and `apply-akahu-result.ts`, `payment_reminders` only by
 * `reminders.ts` (boundaries.test).
 * Every function takes a Kysely handle or the caller's transaction and reads no clock.
 *
 * The admin list never selects an email address, a bank column or an Akahu field: a payer is a name and a user id.
 */
import { sql, type Kysely } from 'kysely';
import { parseMoney, type Money, type PaymentStatus } from '@sgm/shared';
import type { DB } from '../../lib/db/types.generated.ts';

export type AdminPaymentsFilter = 'UNPAID' | 'PENDING' | 'OVERDUE' | 'PAID' | 'FAILED' | 'ALL';

/** Rows per page of the admin list. */
export const ADMIN_PAYMENTS_PAGE_SIZE = 50;

/** Unpaid work is listed most-overdue first (oldest due date); history (paid, failed, all) newest first. */
export const listsOldestFirst = (filter: AdminPaymentsFilter): boolean =>
  filter === 'UNPAID' || filter === 'PENDING' || filter === 'OVERDUE';

/** The keyset position after the last row of a page: the due instant at full microsecond precision, and the id. */
export interface AdminPaymentsPosition {
  readonly dueCursor: string;
  readonly id: string;
}

export interface AdminPaymentRow {
  readonly id: string;
  readonly reference: string;
  readonly playerId: string;
  readonly playerName: string;
  readonly sessionStartsAt: Date;
  readonly amount: Money;
  readonly status: PaymentStatus;
  readonly dueDate: Date;
  readonly paidAt: Date | null;
  readonly lastReminderAt: Date | null;
  readonly onHold: boolean;
  /** Exact text of `due_date` for the cursor (a JS Date would drop microseconds and break the keyset). */
  readonly dueCursor: string;
}

const DUE_CURSOR_FORMAT = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`;

/** One page (page size + 1 rows, so the caller can tell whether there is another) of a team's payments. */
export async function listTeamPayments(
  db: Kysely<DB>,
  input: {
    readonly teamId: string;
    readonly filter: AdminPaymentsFilter;
    readonly after: AdminPaymentsPosition | undefined;
  },
): Promise<AdminPaymentRow[]> {
  const oldestFirst = listsOldestFirst(input.filter);
  let query = db
    .selectFrom('payments as p')
    .innerJoin('users as u', 'u.id', 'p.user_id')
    .leftJoin('registrations as r', 'r.id', 'p.registration_id')
    .leftJoin('game_sessions as s', 's.id', 'r.session_id')
    .select([
      'p.id',
      'p.payment_reference',
      'p.user_id',
      'u.full_name',
      'p.amount',
      'p.status',
      'p.due_date',
      'p.paid_at',
      sql<Date>`coalesce(s.starts_at, p.due_date)`.as('session_starts_at'),
      sql<Date | null>`(SELECT max(m.created_at) FROM payment_reminders m WHERE m.payment_id = p.id)`.as(
        'last_reminder_at',
      ),
      sql<boolean>`EXISTS (SELECT 1 FROM payment_attempts a WHERE a.payment_id = p.id AND a.status = 'HELD')`.as(
        'on_hold',
      ),
      sql<string>`to_char(p.due_date AT TIME ZONE 'UTC', ${DUE_CURSOR_FORMAT})`.as('due_cursor'),
    ])
    .where('p.team_id', '=', input.teamId);
  if (input.filter === 'UNPAID') query = query.where('p.status', 'in', ['PENDING', 'OVERDUE']);
  else if (input.filter !== 'ALL') query = query.where('p.status', '=', input.filter);
  if (input.after !== undefined) {
    const { dueCursor, id } = input.after;
    query = query.where(
      oldestFirst
        ? sql<boolean>`(p.due_date, p.id) > (${dueCursor}::timestamptz, ${id}::uuid)`
        : sql<boolean>`(p.due_date, p.id) < (${dueCursor}::timestamptz, ${id}::uuid)`,
    );
  }
  const rows = await query
    .orderBy('p.due_date', oldestFirst ? 'asc' : 'desc')
    .orderBy('p.id', oldestFirst ? 'asc' : 'desc')
    .limit(ADMIN_PAYMENTS_PAGE_SIZE + 1)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    reference: row.payment_reference,
    playerId: row.user_id,
    playerName: row.full_name,
    sessionStartsAt: row.session_starts_at,
    amount: parseMoney(row.amount),
    status: row.status,
    dueDate: row.due_date,
    paidAt: row.paid_at,
    lastReminderAt: row.last_reminder_at,
    onHold: row.on_hold,
    dueCursor: row.due_cursor,
  }));
}

/** Whether Akahu's refusal of the team's payout account is on record (`payout_blocked_at`), for the list's banner. */
export async function readPayoutBlocked(db: Kysely<DB>, teamId: string): Promise<boolean> {
  const row = await db
    .selectFrom('teams')
    .select(sql<boolean>`payout_blocked_at IS NOT NULL`.as('blocked'))
    .where('id', '=', teamId)
    .executeTakeFirst();
  return row?.blocked ?? false;
}

export interface PaymentEmailFacts {
  readonly paymentId: string;
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly location: string;
  readonly startsAt: Date;
  readonly amount: Money;
  readonly dueDate: Date;
  readonly status: PaymentStatus;
}

/**
 * What a payment email needs, by payment id: the payer's address and name, the team, the session and the money. A payment whose
 * registration is gone still gets its email, with a generic place and the due instant standing in for the session start.
 */
export async function readPaymentEmailFacts(
  db: Kysely<DB>,
  paymentIds: readonly string[],
): Promise<Map<string, PaymentEmailFacts>> {
  const facts = new Map<string, PaymentEmailFacts>();
  if (paymentIds.length === 0) return facts;
  const rows = await db
    .selectFrom('payments as p')
    .innerJoin('users as u', 'u.id', 'p.user_id')
    .innerJoin('teams as t', 't.id', 'p.team_id')
    .leftJoin('registrations as r', 'r.id', 'p.registration_id')
    .leftJoin('game_sessions as s', 's.id', 'r.session_id')
    .select([
      'p.id',
      'p.user_id',
      'u.email',
      'u.full_name',
      'p.team_id',
      't.name as team_name',
      's.location',
      's.starts_at',
      'p.amount',
      'p.due_date',
      'p.status',
    ])
    .where('p.id', 'in', [...paymentIds])
    .execute();
  for (const row of rows) {
    facts.set(row.id, {
      paymentId: row.id,
      userId: row.user_id,
      email: row.email,
      fullName: row.full_name,
      teamId: row.team_id,
      teamName: row.team_name,
      location: row.location ?? 'your session',
      startsAt: row.starts_at ?? row.due_date,
      amount: parseMoney(row.amount),
      dueDate: row.due_date,
      status: row.status,
    });
  }
  return facts;
}

/** OVERDUE payments per payer across every team (the registration debt gate counts the same rows). */
export async function countOverdueByUsers(
  db: Kysely<DB>,
  userIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (userIds.length === 0) return counts;
  const rows = await db
    .selectFrom('payments')
    .select(['user_id', (eb) => eb.fn.countAll<string>().as('overdue')])
    .where('status', '=', 'OVERDUE')
    .where('user_id', 'in', [...new Set(userIds)])
    .groupBy('user_id')
    .execute();
  for (const row of rows) counts.set(row.user_id, parseInt(row.overdue, 10));
  return counts;
}

export interface TopUpEmailFacts {
  readonly topUpId: string;
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
  readonly teamId: string;
  readonly teamName: string;
}

/** What a top-up email needs: the payer's address and name and the team (a plain read; nothing here is locked). */
export async function readTopUpEmailFacts(
  db: Kysely<DB>,
  topUpId: string,
): Promise<TopUpEmailFacts | undefined> {
  const row = await db
    .selectFrom('wallet_top_ups as w')
    .innerJoin('users as u', 'u.id', 'w.user_id')
    .innerJoin('teams as t', 't.id', 'w.team_id')
    .select(['w.id', 'w.user_id', 'u.email', 'u.full_name', 'w.team_id', 't.name as team_name'])
    .where('w.id', '=', topUpId)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : {
        topUpId: row.id,
        userId: row.user_id,
        email: row.email,
        fullName: row.full_name,
        teamId: row.team_id,
        teamName: row.team_name,
      };
}
