/**
 * Row factories for schema integration tests. Each call creates fresh, uniquely-keyed rows, so tests
 * sharing one cloned database never collide. Money is always passed as a 2-dp string.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { inTransaction, type Queryable } from './test-db.ts';

type Sex = 'MALE' | 'FEMALE' | 'OTHER';
type Skill = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';
type Pricing = 'FLAT' | 'BY_SEX' | 'BY_SKILL_LEVEL';

async function insertId(db: Queryable, text: string, values: unknown[]): Promise<string> {
  const { rows } = await db.query<{ id: string }>(text, values);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`insert returned no id: ${text}`);
  return id;
}

export function insertUser(db: Queryable, sex: Sex = 'MALE'): Promise<string> {
  return insertId(
    db,
    `INSERT INTO users (email, full_name, sex) VALUES ($1, 'Test Player', $2) RETURNING id`,
    [`player-${randomUUID()}@example.test`, sex],
  );
}

export function insertTeam(db: Queryable): Promise<string> {
  return insertId(
    db,
    `INSERT INTO teams (name, invite_code) VALUES ('Test Club', $1) RETURNING id`,
    [`invite-${randomUUID()}`],
  );
}

export interface SessionFees {
  readonly pricing?: Pricing;
  readonly flat?: string | null;
  readonly male?: string | null;
  readonly female?: string | null;
  readonly other?: string | null;
  readonly beginner?: string | null;
  readonly intermediate?: string | null;
  readonly advanced?: string | null;
}

/** A DRAFT session on 2026-10-07 with one court 19:00–21:00 (FLAT $17.00 unless fees say otherwise). */
export async function insertSession(
  db: Queryable,
  teamId: string,
  fees: SessionFees = {},
  options: { date?: string; recurringRuleId?: string | null; withCourt?: boolean } = {},
): Promise<string> {
  const pricing = fees.pricing ?? 'FLAT';
  const id = await insertId(
    db,
    `INSERT INTO game_sessions (team_id, recurring_rule_id, location, address, date, cancellation_deadline,
                                max_players, pricing_structure, fee_flat, fee_male, fee_female, fee_other,
                                fee_beginner, fee_intermediate, fee_advanced)
     VALUES ($1, $2, 'Test Hall', '1 Test Street, Auckland', $3, $4, 12, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      teamId,
      options.recurringRuleId ?? null,
      options.date ?? '2026-10-07',
      '2026-10-05T06:00:00Z',
      pricing,
      fees.flat === undefined ? (pricing === 'FLAT' ? '17.00' : null) : fees.flat,
      fees.male ?? null,
      fees.female ?? null,
      fees.other ?? null,
      fees.beginner ?? null,
      fees.intermediate ?? null,
      fees.advanced ?? null,
    ],
  );
  if (options.withCourt ?? true) {
    await db.query(
      `INSERT INTO session_courts (session_id, court_identifier, start_time, end_time)
       VALUES ($1, 'Court 1', '19:00', '21:00')`,
      [id],
    );
  }
  return id;
}

export interface RegistrationInput {
  readonly sessionId: string;
  readonly teamId: string;
  readonly userId: string;
  readonly status?: 'CONFIRMED' | 'WAITLISTED' | 'WITHDRAWN';
  readonly queuePosition?: number | null;
  readonly guestCount?: number;
}

export function insertRegistration(db: Queryable, input: RegistrationInput): Promise<string> {
  return insertId(
    db,
    `INSERT INTO registrations (session_id, team_id, user_id, status, queue_position, guest_count)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      input.sessionId,
      input.teamId,
      input.userId,
      input.status ?? 'CONFIRMED',
      input.queuePosition ?? null,
      input.guestCount ?? 0,
    ],
  );
}

export function insertGuest(
  db: Queryable,
  registrationId: string,
  position: number,
  sex: Sex = 'FEMALE',
  skill: Skill = 'INTERMEDIATE',
): Promise<string> {
  return insertId(
    db,
    `INSERT INTO registration_guests (registration_id, position, sex, skill_level)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [registrationId, position, sex, skill],
  );
}

export interface LineInput {
  readonly position: number;
  readonly basis: string;
  readonly sex: Sex;
  readonly skill: Skill;
  readonly unitFee: string;
  readonly guestId?: string | null;
}

export interface PaymentInput {
  readonly userId: string;
  readonly teamId: string;
  readonly registrationId: string | null;
  readonly amount: string;
  readonly pricing?: Pricing;
  readonly gstRegistered?: boolean;
  readonly lines?: readonly LineInput[];
}

/** Inserts a payment header and its line items on `db` (caller controls the transaction). */
export async function insertPaymentRows(db: Queryable, input: PaymentInput): Promise<string> {
  const pricing = input.pricing ?? 'FLAT';
  const gst = input.gstRegistered ?? true;
  const paymentId = await insertId(
    db,
    `INSERT INTO payments (user_id, team_id, registration_id, pricing_structure, gst_registered, gst_rate_bps,
                           amount, payment_link_token, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '2026-10-10T00:00:00Z') RETURNING id`,
    [
      input.userId,
      input.teamId,
      input.registrationId,
      pricing,
      gst,
      gst ? 1500 : 0,
      input.amount,
      `link-${randomUUID()}`,
    ],
  );
  const lines = input.lines ?? [
    { position: 0, basis: 'FLAT', sex: 'MALE', skill: 'BEGINNER', unitFee: input.amount },
  ];
  for (const line of lines) {
    await db.query(
      `INSERT INTO payment_line_items (payment_id, party_position, registration_guest_id, pricing_structure,
                                       applied_basis, party_sex, party_skill_level, unit_fee)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        paymentId,
        line.position,
        line.guestId ?? null,
        pricing,
        line.basis,
        line.sex,
        line.skill,
        line.unitFee,
      ],
    );
  }
  return paymentId;
}

/** Inserts a payment with its lines and commits (deferred line checks run at COMMIT). */
export function insertPayment(pool: pg.Pool, input: PaymentInput): Promise<string> {
  return inTransaction(pool, (client) => insertPaymentRows(client, input));
}

export interface BilledRegistration {
  readonly userId: string;
  readonly registrationId: string;
  readonly paymentId: string;
}

/** A new user registered (CONFIRMED) for `sessionId` with a committed $17.00 FLAT payment. */
export async function insertBilledRegistration(
  pool: pg.Pool,
  teamId: string,
  sessionId: string,
): Promise<BilledRegistration> {
  const userId = await insertUser(pool);
  const registrationId = await insertRegistration(pool, { sessionId, teamId, userId });
  const paymentId = await insertPayment(pool, {
    userId,
    teamId,
    registrationId,
    amount: '17.00',
  });
  return { userId, registrationId, paymentId };
}

export async function insertWallet(
  db: Queryable,
  userId: string,
  teamId: string,
  balance = '0.00',
): Promise<string> {
  return insertId(
    db,
    `INSERT INTO player_credits (user_id, team_id, balance) VALUES ($1, $2, $3) RETURNING id`,
    [userId, teamId, balance],
  );
}
