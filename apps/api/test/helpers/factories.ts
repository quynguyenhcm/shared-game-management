/**
 * Row factories for schema integration tests. Each call creates fresh, uniquely-keyed rows, so tests
 * sharing one cloned database never collide. Money is always passed as a 2-dp string.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createCrypto } from '../../src/lib/crypto/crypto.ts';
import { createKeyProvider } from '../../src/lib/crypto/keyring.ts';
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

export function insertUser(
  db: Queryable,
  sex: Sex = 'MALE',
  options: { email?: string } = {},
): Promise<string> {
  return insertId(
    db,
    `INSERT INTO users (email, full_name, sex) VALUES ($1, 'Test Player', $2) RETURNING id`,
    [options.email ?? `player-${randomUUID()}@example.test`, sex],
  );
}

/** A PASSWORD identity whose subject is the user's own email (the composite FK requires it). */
export function insertPasswordIdentity(
  db: Queryable,
  userId: string,
  passwordHash = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$aGFzaA',
): Promise<string> {
  return insertId(
    db,
    `INSERT INTO auth_identities (user_id, provider, provider_subject, password_hash)
     SELECT id, 'PASSWORD', email, $2 FROM users WHERE id = $1 RETURNING id`,
    [userId, passwordHash],
  );
}

/** A GOOGLE or FACEBOOK identity with a unique provider subject. */
export function insertOAuthIdentity(
  db: Queryable,
  userId: string,
  provider: 'GOOGLE' | 'FACEBOOK',
): Promise<string> {
  return insertId(
    db,
    `INSERT INTO auth_identities (user_id, provider, provider_subject) VALUES ($1, $2, $3) RETURNING id`,
    [userId, provider, `${provider.toLowerCase()}-${randomUUID()}`],
  );
}

/**
 * A live session row for `userId`, for tests that need a session without driving sign-in. Returns the raw
 * token (only its SHA-256 is stored, as in production). Times are absolute instants so a manual clock
 * can place the session anywhere on the timeline.
 */
export async function insertAuthSession(
  db: Queryable,
  userId: string,
  options: { createdAt: Date; idleDays?: number; absoluteDays?: number },
): Promise<{ id: string; token: string }> {
  const token = randomBytes(32).toString('base64url');
  const created = options.createdAt.getTime();
  const day = 86_400_000;
  const id = await insertId(
    db,
    `INSERT INTO auth_sessions (user_id, token_hash, created_at, last_seen_at, expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`,
    [
      userId,
      createHash('sha256').update(token).digest(),
      options.createdAt,
      new Date(created + (options.idleDays ?? 7) * day),
      new Date(created + (options.absoluteDays ?? 30) * day),
    ],
  );
  return { id, token };
}

/**
 * A `password_reset_tokens` row for `userId` without going through `forgot` (no email job). Returns the raw
 * token (only its SHA-256 is stored). Defaults: created at `createdAt`, valid for 60 minutes, unused.
 */
export async function insertResetToken(
  db: Queryable,
  userId: string,
  options: { createdAt: Date; validMinutes?: number; usedAt?: Date | null },
): Promise<{ id: string; token: string }> {
  const token = randomBytes(32).toString('base64url');
  const id = await insertId(
    db,
    `INSERT INTO password_reset_tokens (user_id, token_hash, created_at, expires_at, used_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      userId,
      createHash('sha256').update(token).digest(),
      options.createdAt,
      new Date(options.createdAt.getTime() + (options.validMinutes ?? 60) * 60_000),
      options.usedAt ?? null,
    ],
  );
  return { id, token };
}

/**
 * A `team_members` row whose approval and ban stamps match its status (team-management D-40, D-41):
 * `approved_*` are set for APPROVED and BANNED rows, `banned_*` for BANNED only. `actorId` is the admin who
 * approved or banned the member and defaults to the member's own id. A TEAM_ADMIN row must be APPROVED.
 */
export function insertTeamMember(
  db: Queryable,
  input: {
    teamId: string;
    userId: string;
    role?: 'TEAM_ADMIN' | 'MEMBER';
    status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'BANNED';
    skillLevel?: Skill;
    actorId?: string;
  },
): Promise<string> {
  const status = input.status ?? 'APPROVED';
  const actor = input.actorId ?? input.userId;
  const approved = status === 'APPROVED' || status === 'BANNED';
  const banned = status === 'BANNED';
  const now = new Date();
  return insertId(
    db,
    `INSERT INTO team_members (team_id, user_id, role, status, skill_level, approved_at, approved_by,
                               banned_at, banned_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      input.teamId,
      input.userId,
      input.role ?? 'MEMBER',
      status,
      input.skillLevel ?? 'BEGINNER',
      approved ? now : null,
      approved ? actor : null,
      banned ? now : null,
      banned ? actor : null,
    ],
  );
}

/** Field encryption with a throwaway keyring, for rows written straight to the database in tests. */
export const testFieldCrypto = createCrypto(
  createKeyProvider([{ id: 'test1', key: randomBytes(32) }], 'test1'),
);

/** A payout block (account name and number as envelopes under the correct AAD, plus last4) for one team row. */
export function payoutBlockFor(
  teamId: string,
  block: { accountName?: string; accountNumber?: string; last4?: string } = {},
): { name: string; number: string; last4: string } {
  return {
    name: testFieldCrypto.encrypt(block.accountName ?? 'Test Club Account', {
      table: 'teams',
      column: 'bank_account_name',
      rowId: teamId,
    }),
    number: testFieldCrypto.encrypt(block.accountNumber ?? '01-0902-0068389-000', {
      table: 'teams',
      column: 'bank_account_number',
      rowId: teamId,
    }),
    // Hand-built (the last 4 digits of the 7-digit account base of the default number).
    last4: block.last4 ?? '8389',
  };
}

export interface TeamOptions {
  readonly visibility?: 'PUBLIC' | 'PRIVATE';
  readonly name?: string;
  /** Writes a valid name + number + last4 block, so the generated `is_payout_configured` is true. */
  readonly payoutConfigured?: boolean;
  /** Sets `payout_blocked_at` (needs `payoutConfigured` for the flag to matter). */
  readonly payoutBlockedAt?: Date;
  readonly gstRegistered?: boolean;
  readonly gstNumber?: string;
}

/** A team with a 256-bit base64url invite code (matches the `teams_invite_code_format` CHECK). */
export async function insertTeam(db: Queryable, options: TeamOptions = {}): Promise<string> {
  const id = randomUUID();
  const block = options.payoutConfigured === true ? payoutBlockFor(id) : undefined;
  return insertId(
    db,
    `INSERT INTO teams (id, name, visibility, invite_code, bank_account_name, bank_account_number,
                        bank_account_last4, payout_blocked_at, gst_registered, gst_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      id,
      options.name ?? 'Test Club',
      options.visibility ?? 'PUBLIC',
      randomBytes(32).toString('base64url'),
      block?.name ?? null,
      block?.number ?? null,
      block?.last4 ?? null,
      options.payoutBlockedAt ?? null,
      options.gstRegistered ?? false,
      options.gstNumber ?? null,
    ],
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

export type SessionStatus = 'DRAFT' | 'PUBLISHED' | 'COMPLETED' | 'CANCELLED';

/** The legal lifecycle paths of the DB matrix (D-75): DRAFT → PUBLISHED → COMPLETED, and → CANCELLED from either. */
const LIFECYCLE_PATH: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  DRAFT: [],
  PUBLISHED: ['PUBLISHED'],
  COMPLETED: ['PUBLISHED', 'COMPLETED'],
  CANCELLED: ['CANCELLED'],
};

/**
 * Moves a session to `target` along the legal lifecycle path, one UPDATE per step (never a raw
 * DRAFT → COMPLETED jump, which the DB matrix refuses). A no-op when already there.
 */
export async function advanceSessionTo(
  db: Queryable,
  sessionId: string,
  target: SessionStatus,
): Promise<void> {
  const { rows } = await db.query<{ status: SessionStatus }>(
    `SELECT status FROM game_sessions WHERE id = $1`,
    [sessionId],
  );
  const current = rows[0]?.status;
  if (current === undefined) throw new Error(`advanceSessionTo: session ${sessionId} not found`);
  if (current === target) return;
  const path = LIFECYCLE_PATH[target];
  const at = path.indexOf(current);
  const remaining = current === 'DRAFT' ? path : at >= 0 ? path.slice(at + 1) : [];
  if (remaining.length === 0) {
    throw new Error(`advanceSessionTo: ${current} → ${target} is not a legal path`);
  }
  for (const step of remaining) {
    await db.query(`UPDATE game_sessions SET status = $2 WHERE id = $1`, [sessionId, step]);
  }
}

/** `advanceSessionTo` for many DRAFT sessions at once: one UPDATE per step of the legal path, not per session. */
export async function advanceSessionsTo(
  db: Queryable,
  sessionIds: readonly string[],
  target: SessionStatus,
): Promise<void> {
  if (target === 'DRAFT' || sessionIds.length === 0) return;
  for (const step of LIFECYCLE_PATH[target]) {
    await db.query(`UPDATE game_sessions SET status = $2 WHERE id = ANY($1::uuid[])`, [
      sessionIds,
      step,
    ]);
  }
}

export interface SessionOptions {
  readonly date?: string;
  readonly recurringRuleId?: string | null;
  readonly withCourt?: boolean;
  /** Reached through `advanceSessionTo` (courts first), never inserted directly. Default DRAFT. */
  readonly status?: SessionStatus;
  /** `calculated_rate_per_player` (FLAT). With no `fees.flat`, `fee_flat` follows custom ?? calculated. */
  readonly calculatedRate?: string | null;
  readonly customRate?: string | null;
  readonly maxPlayers?: number;
  readonly createKey?: string | null;
}

/**
 * A session on 2026-10-07 with one court 19:00–21:00 (FLAT $17.00 unless fees say otherwise). DRAFT unless
 * `options.status` says otherwise. A session that ends up PUBLISHED or COMPLETED (C-SSE-1) gets complete fees
 * for its structure: BY_SKILL_LEVEL defaults every skill fee to $17.00 and a FLAT `fee_flat` is the final rate.
 */
export async function insertSession(
  db: Queryable,
  teamId: string,
  fees: SessionFees = {},
  options: SessionOptions = {},
): Promise<string> {
  const pricing = fees.pricing ?? 'FLAT';
  const status = options.status ?? 'DRAFT';
  const live = status === 'PUBLISHED' || status === 'COMPLETED';
  const skillDefault = live && pricing === 'BY_SKILL_LEVEL' ? '17.00' : null;
  const finalRate = options.customRate ?? options.calculatedRate ?? null;
  const flatDefault = pricing === 'FLAT' ? (finalRate ?? '17.00') : null;
  const id = await insertId(
    db,
    `INSERT INTO game_sessions (team_id, recurring_rule_id, location, address, date, cancellation_deadline,
                                max_players, pricing_structure, fee_flat, fee_male, fee_female, fee_other,
                                fee_beginner, fee_intermediate, fee_advanced, calculated_rate_per_player,
                                custom_player_rate, create_key)
     VALUES ($1, $2, 'Test Hall', '1 Test Street, Auckland', $3, $4, $13, $5, $6, $7, $8, $9, $10, $11, $12,
             $14, $15, $16)
     RETURNING id`,
    [
      teamId,
      options.recurringRuleId ?? null,
      options.date ?? '2026-10-07',
      '2026-10-05T06:00:00Z',
      pricing,
      fees.flat === undefined ? flatDefault : fees.flat,
      fees.male ?? null,
      fees.female ?? null,
      fees.other ?? null,
      fees.beginner === undefined ? skillDefault : fees.beginner,
      fees.intermediate === undefined ? skillDefault : fees.intermediate,
      fees.advanced === undefined ? skillDefault : fees.advanced,
      options.maxPlayers ?? 12,
      options.calculatedRate ?? null,
      options.customRate ?? null,
      options.createKey ?? null,
    ],
  );
  if (options.withCourt ?? true) {
    await db.query(
      `INSERT INTO session_courts (session_id, court_identifier, start_time, end_time)
       VALUES ($1, 'Court 1', '19:00', '21:00')`,
      [id],
    );
  }
  if (status !== 'DRAFT') await advanceSessionTo(db, id, status);
  return id;
}

export interface RuleOptions extends SessionFees {
  readonly frequency?: 'WEEKLY' | 'FORTNIGHTLY' | 'MONTHLY';
  /** 0 = Sunday … 6 = Saturday; must be the weekday of `startsOn`. Default 3 (Wednesday). */
  readonly dayOfWeek?: number;
  /** The series' first date and anchor. Default 2026-10-07 (a Wednesday). */
  readonly startsOn?: string;
  /** 1..4 or -1 (last); required for MONTHLY. */
  readonly monthlyWeek?: number | null;
  readonly recurUntil?: string | null;
  readonly isActive?: boolean;
  readonly createKey?: string | null;
  /** Template courts; default one court 19:00–21:00. An empty list inserts the rule with no template. */
  readonly courts?: readonly { identifier: string; start: string; end: string }[];
}

/**
 * A recurring rule with its court template, written in ONE statement so the deferred "an active rule has a
 * court" constraint is satisfied at commit even on an autocommit pool. FLAT $17.00 unless fees say otherwise.
 */
export async function insertRule(
  db: Queryable,
  teamId: string,
  options: RuleOptions = {},
): Promise<string> {
  const pricing = options.pricing ?? 'FLAT';
  const courts = options.courts ?? [{ identifier: 'Court 1', start: '19:00', end: '21:00' }];
  const skillDefault = pricing === 'BY_SKILL_LEVEL' ? '17.00' : null;
  const { rows } = await db.query<{ id: string }>(
    `WITH rule AS (
       INSERT INTO recurring_session_rules (team_id, frequency, day_of_week, starts_on, monthly_week, recur_until,
                                            is_active, default_location, default_address, default_max_players,
                                            default_start_time, default_end_time, pricing_structure, fee_flat,
                                            fee_male, fee_female, fee_other, fee_beginner, fee_intermediate,
                                            fee_advanced, create_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Test Hall', '1 Test Street, Auckland', 12, '19:00', '21:00', $8,
               $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING id),
     template AS (
       INSERT INTO recurring_rule_courts (rule_id, position, court_identifier, start_time, end_time)
       SELECT rule.id, c.ord, c.identifier, c.start_time::time, c.end_time::time
         FROM rule,
              unnest($17::text[], $18::text[], $19::text[]) WITH ORDINALITY AS c(identifier, start_time, end_time, ord)
       RETURNING 1)
     SELECT id FROM rule`,
    [
      teamId,
      options.frequency ?? 'WEEKLY',
      options.dayOfWeek ?? 3,
      options.startsOn ?? '2026-10-07',
      options.monthlyWeek ?? null,
      options.recurUntil ?? null,
      options.isActive ?? true,
      pricing,
      options.flat === undefined ? (pricing === 'FLAT' ? '17.00' : null) : options.flat,
      options.male ?? null,
      options.female ?? null,
      options.other ?? null,
      options.beginner === undefined ? skillDefault : options.beginner,
      options.intermediate === undefined ? skillDefault : options.intermediate,
      options.advanced === undefined ? skillDefault : options.advanced,
      options.createKey ?? null,
      courts.map((court) => court.identifier),
      courts.map((court) => court.start),
      courts.map((court) => court.end),
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('insertRule returned no id');
  return id;
}

/** One more template court on an existing rule (the next free position unless given). */
export function insertRuleCourt(
  db: Queryable,
  ruleId: string,
  court: { identifier: string; start?: string; end?: string; position?: number },
): Promise<string> {
  return insertId(
    db,
    `INSERT INTO recurring_rule_courts (rule_id, position, court_identifier, start_time, end_time)
     VALUES ($1, coalesce($2::smallint, (SELECT coalesce(max(position), 0) + 1 FROM recurring_rule_courts WHERE rule_id = $1)),
             $3, $4, $5)
     RETURNING id`,
    [
      ruleId,
      court.position ?? null,
      court.identifier,
      court.start ?? '19:00',
      court.end ?? '21:00',
    ],
  );
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
