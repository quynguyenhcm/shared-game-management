/**
 * The billing hand-off (R7, ADR 0018 C-BIL-1..3). Billing bills EXACTLY the registrations this returns, one payment per
 * registration for the whole party: every CONFIRMED row (a promoted party takes the fee by being confirmed) and every
 * WITHDRAWN row whose late fee is still owed (`withdrawal_fee_due`). Money-free: nothing here writes or reads a money table.
 *
 * Contract for the caller:
 * - Read it at or after `starts_at`, inside the caller's transaction (R7). The owed flag can only be released while the session
 *   is open, so from the start on the list is final. The function enforces both: a pool handle, or `now < starts_at`, throws a
 *   `BillingHandoffError` instead of returning a list that could still change.
 * - The list is empty for a session that is not PUBLISHED or COMPLETED (a CANCELLED or DRAFT game is never billed).
 * - The registrant's sex and skill level are the snapshot taken when the row became CONFIRMED (R15, ADR 0017 C-PRICE-1), never
 *   `users.sex` or `team_members.skill_level` as they are now. Guests carry `guestId` (for `payment_line_items`) and `position`.
 * - Registrations and guest rows are never deleted, so billing's RESTRICT line-item references stay valid.
 *
 * It locks the session row `FOR SHARE` (canonical order: the session before its registrations), so a cancellation or a
 * COMPLETED move cannot interleave, and reads the registrations and guests in that same transaction. Billing, which holds the
 * session `FOR UPDATE` itself (C-BIL-1), re-takes the lock for free.
 */
import type { Transaction } from 'kysely';
import type { SkillTier, UserSex } from '@sgm/shared';
import type { DB } from '../../lib/db/types.generated.ts';
import { RegistrationInvariantError } from './repo.ts';

export class BillingHandoffError extends Error {
  constructor(
    readonly reason: 'not_in_transaction' | 'before_start',
    message: string,
  ) {
    super(message);
    this.name = 'BillingHandoffError';
  }
}

export interface BillableGuest {
  readonly guestId: string;
  readonly position: 1 | 2;
  readonly sex: UserSex;
  readonly skillLevel: SkillTier;
}

export interface BillableRegistration {
  readonly registrationId: string;
  readonly userId: string;
  readonly teamId: string;
  readonly reason: 'CONFIRMED' | 'LATE_WITHDRAWAL';
  readonly registrantSex: UserSex;
  readonly registrantSkillLevel: SkillTier;
  readonly guests: readonly BillableGuest[];
}

export async function listBillableRegistrations(
  trx: Transaction<DB>,
  sessionId: string,
  now: Date,
): Promise<readonly BillableRegistration[]> {
  if (!trx.isTransaction) {
    throw new BillingHandoffError(
      'not_in_transaction',
      "the billing hand-off must be read inside the caller's transaction",
    );
  }
  const db = trx;
  const session = await db
    .selectFrom('game_sessions')
    .select(['status', 'starts_at'])
    .where('id', '=', sessionId)
    .forShare()
    .executeTakeFirst();
  if (session === undefined || (session.status !== 'PUBLISHED' && session.status !== 'COMPLETED')) {
    return [];
  }
  // A PUBLISHED or COMPLETED session always has starts_at (ADR 0019 C-SSE-2). A null here is treated as not started, never as billable.
  if (session.starts_at === null || now < session.starts_at) {
    throw new BillingHandoffError(
      'before_start',
      `session ${sessionId} has not started: the hand-off is final only at or after starts_at`,
    );
  }
  const rows = await db
    .selectFrom('registrations')
    .select(['id', 'user_id', 'team_id', 'status', 'registrant_sex', 'registrant_skill_level'])
    .where('session_id', '=', sessionId)
    .where((eb) =>
      eb.or([
        eb('status', '=', 'CONFIRMED'),
        eb.and([eb('status', '=', 'WITHDRAWN'), eb('withdrawal_fee_due', '=', true)]),
      ]),
    )
    .orderBy('registered_at')
    .orderBy('id')
    .execute();
  if (rows.length === 0) return [];
  const guestRows = await db
    .selectFrom('registration_guests')
    .select(['id', 'registration_id', 'position', 'sex', 'skill_level'])
    .where(
      'registration_id',
      'in',
      rows.map((row) => row.id),
    )
    .orderBy('position')
    .execute();
  return rows.map((row) => {
    // The `registrations_registrant_snapshot` CHECK guarantees both for these rows; anything else is a broken invariant.
    if (row.registrant_sex === null || row.registrant_skill_level === null) {
      throw new RegistrationInvariantError(
        `billable registration ${row.id} has no pricing snapshot`,
        row.id,
      );
    }
    return {
      registrationId: row.id,
      userId: row.user_id,
      teamId: row.team_id,
      reason: row.status === 'CONFIRMED' ? 'CONFIRMED' : 'LATE_WITHDRAWAL',
      registrantSex: row.registrant_sex,
      registrantSkillLevel: row.registrant_skill_level,
      guests: guestRows
        .filter((guest) => guest.registration_id === row.id)
        .map((guest) => ({
          guestId: guest.id,
          position: guest.position as 1 | 2,
          sex: guest.sex,
          skillLevel: guest.skill_level,
        })),
    };
  });
}
