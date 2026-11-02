/**
 * The post-game engine's SQL: the ONLY writer of `payments`, `payment_line_items` and `billing_session_blocks`, and the only
 * writer of `game_sessions.status = 'COMPLETED'` (CR-9, ADR 0020). Every function takes the caller's transaction; none opens one
 * or reads a clock. The decisions live in `charge.ts`; the order of the locks lives in `bill-session.ts`.
 *
 * Contract C-BIL-PAY (ADR 0016): `lockTeamForBilling` is the first statement of the billing transaction. It takes
 * `teams FOR KEY SHARE` (a banking removal takes `FOR UPDATE`, so the two serialise) and reads the generated
 * `is_payout_configured` in the same statement, so the answer is the committed state after any removal that was ahead of us.
 *
 * ADR 0016 GST snapshot: `insertCharge` copies `gst_registered`, the rate and `gst_number` out of `teams` in the SAME statement
 * that inserts the payment (`INSERT ... SELECT ... FROM teams`), so one payment never carries a number that does not belong to
 * its `gst_registered`; the table CHECK and the immutability trigger keep it that way afterwards.
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { Transaction } from 'kysely';
import {
  GST_RATE_BPS,
  toMoneyString,
  type BillingType,
  type Money,
  type PaymentStatus,
  type PricingType,
} from '@sgm/shared';
import type { Selectable } from 'kysely';
import type { DB, GameSessions } from '../../lib/db/types.generated.ts';
import type { ChargeLine } from './charge.ts';

export interface BillingTeam {
  readonly name: string;
  readonly isPayoutConfigured: boolean;
}

/** `teams FOR KEY SHARE` plus the payout flag: C-BIL-PAY, always the first lock of a billing transaction. */
export async function lockTeamForBilling(
  trx: Transaction<DB>,
  teamId: string,
): Promise<BillingTeam | undefined> {
  const row = await trx
    .selectFrom('teams')
    .select(['name', 'is_payout_configured'])
    .where('id', '=', teamId)
    .forKeyShare()
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : { name: row.name, isPayoutConfigured: row.is_payout_configured };
}

/** The session's team, read without a lock (the lock prologue needs the team before it can lock the session). */
export async function readSessionTeam(
  trx: Transaction<DB>,
  sessionId: string,
): Promise<string | undefined> {
  const row = await trx
    .selectFrom('game_sessions')
    .select('team_id')
    .where('id', '=', sessionId)
    .executeTakeFirst();
  return row?.team_id;
}

export type BillingSession = Selectable<GameSessions>;

/**
 * `game_sessions FOR UPDATE` (D-14), scoped to the team: the second lock of the billing transaction, after `teams`. The sessions
 * module keeps its own lock helper private to it (its boundary test), so billing takes the same lock here, in the same order.
 */
export function lockSessionForBilling(
  trx: Transaction<DB>,
  input: { readonly sessionId: string; readonly teamId: string },
): Promise<BillingSession | undefined> {
  return trx
    .selectFrom('game_sessions')
    .selectAll()
    .where('id', '=', input.sessionId)
    .where('team_id', '=', input.teamId)
    .forUpdate()
    .executeTakeFirst();
}

/** PUBLISHED -> COMPLETED, guarded: false when the session is not PUBLISHED any more (a replay, or a cancel that won). */
export async function completeSession(trx: Transaction<DB>, sessionId: string): Promise<boolean> {
  const done = await trx
    .updateTable('game_sessions')
    .set({ status: 'COMPLETED' })
    .where('id', '=', sessionId)
    .where('status', '=', 'PUBLISHED')
    .returning('id')
    .executeTakeFirst();
  return done !== undefined;
}

/** `SGM` plus 8 Crockford base32 characters (the `payments_payment_reference_format` CHECK): unique, not secret (CR-7). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newPaymentReference(): string {
  return `SGM${Array.from(randomBytes(8), (byte) => CROCKFORD[byte % 32]).join('')}`;
}

export interface NewCharge {
  readonly teamId: string;
  readonly userId: string;
  readonly registrationId: string;
  readonly pricing: PricingType;
  readonly amount: Money;
  readonly billingType: Extract<BillingType, 'PER_GAME' | 'PREPAID_CREDIT'>;
  readonly status: Extract<PaymentStatus, 'PAID' | 'PENDING'>;
  readonly dueDate: Date;
  /** Set exactly when `status` is PAID (the CHECK `payments_paid_at_iff_paid`). */
  readonly paidAt: Date | null;
  readonly lines: readonly ChargeLine[];
}

/**
 * Inserts one payment header (GST snapshot read from `teams` in the same statement) and its line items. A conflict on
 * `uq_payments_registration` is an invariant breach (a PUBLISHED session must have no payment) and propagates, so the whole
 * billing transaction rolls back. The deferred `payment_lines_match_header` check runs at COMMIT.
 */
export async function insertCharge(
  trx: Transaction<DB>,
  charge: NewCharge,
): Promise<{ readonly paymentId: string }> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO payments (user_id, team_id, registration_id, billing_type, pricing_structure, gst_registered,
                          gst_rate_bps, gst_number, amount, status, payment_reference, due_date, paid_at)
    SELECT ${charge.userId}::uuid, t.id, ${charge.registrationId}::uuid, ${charge.billingType}::billing_type,
           ${charge.pricing}::pricing_type, t.gst_registered,
           CASE WHEN t.gst_registered THEN ${GST_RATE_BPS}::smallint ELSE 0::smallint END,
           CASE WHEN t.gst_registered THEN t.gst_number END,
           ${toMoneyString(charge.amount)}::numeric, ${charge.status}::payment_status,
           ${newPaymentReference()}, ${charge.dueDate}::timestamptz, ${charge.paidAt}::timestamptz
      FROM teams t
     WHERE t.id = ${charge.teamId}::uuid
    RETURNING id`.execute(trx);
  const paymentId = rows[0]?.id;
  if (paymentId === undefined) throw new Error('payment insert returned no row: the team is gone');
  await trx
    .insertInto('payment_line_items')
    .values(
      charge.lines.map((line) => ({
        payment_id: paymentId,
        party_position: line.position,
        registration_guest_id: line.guestId,
        pricing_structure: charge.pricing,
        applied_basis: line.basis,
        party_sex: line.sex,
        party_skill_level: line.skillLevel,
        unit_fee: toMoneyString(line.unitFee),
      })),
    )
    .execute();
  return { paymentId };
}

/**
 * B8: records that a session was held because its team could not take payments, and claims the admin notice. Returns true
 * exactly once per session (the caller that gets true enqueues the "Billing is paused" emails in the same transaction), so
 * every later sweep and replay finds the marker already notified and says nothing.
 */
export async function claimBillingBlockNotice(
  trx: Transaction<DB>,
  input: { readonly sessionId: string; readonly teamId: string; readonly now: Date },
): Promise<boolean> {
  await trx
    .insertInto('billing_session_blocks')
    .values({ session_id: input.sessionId, team_id: input.teamId, blocked_at: input.now })
    .onConflict((conflict) => conflict.column('session_id').doNothing())
    .execute();
  const claimed = await trx
    .updateTable('billing_session_blocks')
    .set({ notified_at: input.now })
    .where('session_id', '=', input.sessionId)
    .where('notified_at', 'is', null)
    .returning('session_id')
    .executeTakeFirst();
  return claimed !== undefined;
}

export interface Recipient {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
}

/** The people a billing email goes to, by user id (plain reads: `users` is never locked by billing). */
export async function readRecipients(
  trx: Transaction<DB>,
  userIds: readonly string[],
): Promise<Map<string, Recipient>> {
  const recipients = new Map<string, Recipient>();
  if (userIds.length === 0) return recipients;
  const rows = await trx
    .selectFrom('users')
    .select(['id', 'email', 'full_name'])
    .where('id', 'in', [...new Set(userIds)])
    .execute();
  for (const row of rows) {
    recipients.set(row.id, { userId: row.id, email: row.email, fullName: row.full_name });
  }
  return recipients;
}

/** Every approved TEAM_ADMIN of the team, a plain read (`team_members` is before `game_sessions` in the lock order). */
export async function listApprovedAdmins(
  trx: Transaction<DB>,
  teamId: string,
): Promise<Recipient[]> {
  const rows = await trx
    .selectFrom('team_members as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select(['u.id', 'u.email', 'u.full_name'])
    .where('m.team_id', '=', teamId)
    .where('m.role', '=', 'TEAM_ADMIN')
    .where('m.status', '=', 'APPROVED')
    .orderBy('u.id')
    .execute();
  return rows.map((row) => ({ userId: row.id, email: row.email, fullName: row.full_name }));
}
