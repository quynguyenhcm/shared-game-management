/**
 * The expected schema, written BY HAND from the repo-root `database-design.md` (AC-INTEGRATION-1).
 * It is deliberately NOT generated from the migrations under test. Column types use PostgreSQL's
 * `format_type()` spelling; `nullable` is the draft's nullability (a column without NOT NULL and
 * without PRIMARY KEY is nullable). Any difference between this file and the migrated database must
 * be listed in `db/schema-deviations.md`.
 */

export interface ExpectedColumn {
  readonly type: string;
  readonly nullable: boolean;
}

export interface ExpectedForeignKey {
  /** Referenced table. */
  readonly references: string;
  /** Draft ON DELETE action: pg_constraint.confdeltype letter (a = NO ACTION, c = CASCADE, n = SET NULL, r = RESTRICT). */
  readonly onDelete: 'a' | 'c' | 'n' | 'r';
}

export interface ExpectedTable {
  readonly columns: Readonly<Record<string, ExpectedColumn>>;
  /** Keyed by the referencing column. */
  readonly foreignKeys: Readonly<Record<string, ExpectedForeignKey>>;
}

const UUID_PK: ExpectedColumn = { type: 'uuid', nullable: false };
const TSTZ_NULL: ExpectedColumn = { type: 'timestamp with time zone', nullable: true };
const MONEY_NULL: ExpectedColumn = { type: 'numeric(10,2)', nullable: true };
const MONEY: ExpectedColumn = { type: 'numeric(10,2)', nullable: false };
const col = (type: string, nullable: boolean): ExpectedColumn => ({ type, nullable });

/** The 13 draft enum types, values in declaration order. */
export const EXPECTED_ENUMS: Readonly<Record<string, readonly string[]>> = {
  user_sex: ['MALE', 'FEMALE', 'OTHER'],
  skill_tier: ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'],
  global_role: ['GLOBAL_ADMIN', 'TEAM_ADMIN', 'PLAYER'],
  team_visibility: ['PUBLIC', 'PRIVATE'],
  team_role: ['TEAM_ADMIN', 'MEMBER'],
  membership_status: ['PENDING', 'APPROVED', 'REJECTED', 'BANNED'],
  pricing_type: ['FLAT', 'BY_SEX', 'BY_SKILL_LEVEL'],
  session_status: ['DRAFT', 'PUBLISHED', 'COMPLETED', 'CANCELLED'],
  registration_status: ['CONFIRMED', 'WAITLISTED', 'WITHDRAWN'],
  payment_status: ['PENDING', 'PAID', 'FAILED', 'OVERDUE'],
  billing_type: ['PER_GAME', 'PREPAID_CREDIT', 'MONTHLY_SUBSCRIPTION', 'QUARTERLY_SUBSCRIPTION'],
  recurrence_frequency: ['WEEKLY', 'FORTNIGHTLY', 'MONTHLY'],
  credit_transaction_type: ['TOPUP', 'AUTO_DEDUCTION', 'REFUND'],
};

/** The 10 draft tables. */
export const EXPECTED_TABLES: Readonly<Record<string, ExpectedTable>> = {
  users: {
    columns: {
      id: UUID_PK,
      email: col('character varying(255)', false),
      full_name: col('character varying(255)', false),
      sex: col('user_sex', false),
      role: col('global_role', false),
      created_at: TSTZ_NULL,
    },
    foreignKeys: {},
  },
  teams: {
    columns: {
      id: UUID_PK,
      name: col('character varying(255)', false),
      description: col('text', true),
      visibility: col('team_visibility', false),
      invite_code: col('character varying(100)', false),
      created_by: col('uuid', true),
      bank_account_name: col('character varying(255)', true),
      bank_account_number: col('character varying(30)', true),
      akahu_merchant_id: col('character varying(255)', true),
      akahu_app_token: col('character varying(255)', true),
      is_payout_configured: col('boolean', false),
      gst_registered: col('boolean', false),
      ird_number: col('character varying(20)', true),
      gst_number: col('character varying(20)', true),
      created_at: TSTZ_NULL,
    },
    foreignKeys: { created_by: { references: 'users', onDelete: 'a' } },
  },
  team_members: {
    columns: {
      id: UUID_PK,
      team_id: col('uuid', true),
      user_id: col('uuid', true),
      role: col('team_role', false),
      status: col('membership_status', false),
      skill_level: col('skill_tier', false),
      skill_level_override_by: col('uuid', true),
      skill_level_override_at: TSTZ_NULL,
      is_auto_enroll: col('boolean', false),
      auto_enroll_until: col('date', true),
      banned_at: TSTZ_NULL,
      banned_by: col('uuid', true),
      ban_reason: col('text', true),
      requested_at: TSTZ_NULL,
      approved_at: TSTZ_NULL,
      approved_by: col('uuid', true),
    },
    foreignKeys: {
      team_id: { references: 'teams', onDelete: 'c' },
      user_id: { references: 'users', onDelete: 'c' },
      skill_level_override_by: { references: 'users', onDelete: 'a' },
      banned_by: { references: 'users', onDelete: 'a' },
      approved_by: { references: 'users', onDelete: 'a' },
    },
  },
  recurring_session_rules: {
    columns: {
      id: UUID_PK,
      team_id: col('uuid', true),
      frequency: col('recurrence_frequency', false),
      day_of_week: col('integer', false),
      default_location: col('character varying(255)', false),
      default_address: col('text', false),
      default_max_players: col('integer', false),
      default_reserved_seats: col('integer', false),
      default_court_count: col('integer', false),
      default_start_time: col('time without time zone', false),
      default_end_time: col('time without time zone', false),
      default_total_court_cost: MONEY_NULL,
      default_extra_expenses: MONEY_NULL,
      default_custom_player_rate: MONEY_NULL,
      pricing_structure: col('pricing_type', false),
      fee_flat: MONEY_NULL,
      fee_male: MONEY_NULL,
      fee_female: MONEY_NULL,
      fee_beginner: MONEY_NULL,
      fee_intermediate: MONEY_NULL,
      fee_advanced: MONEY_NULL,
      recur_until: col('date', true),
      is_active: col('boolean', false),
      created_at: TSTZ_NULL,
    },
    foreignKeys: { team_id: { references: 'teams', onDelete: 'c' } },
  },
  game_sessions: {
    columns: {
      id: UUID_PK,
      team_id: col('uuid', true),
      recurring_rule_id: col('uuid', true),
      is_instance_overridden: col('boolean', false),
      location: col('character varying(255)', false),
      address: col('text', false),
      date: col('date', false),
      cancellation_deadline: col('timestamp with time zone', false),
      max_players: col('integer', false),
      reserved_seats: col('integer', false),
      total_court_cost: MONEY_NULL,
      extra_expenses: MONEY_NULL,
      calculated_rate_per_player: MONEY_NULL,
      custom_player_rate: MONEY_NULL,
      pricing_structure: col('pricing_type', false),
      fee_flat: MONEY_NULL,
      fee_male: MONEY_NULL,
      fee_female: MONEY_NULL,
      fee_beginner: MONEY_NULL,
      fee_intermediate: MONEY_NULL,
      fee_advanced: MONEY_NULL,
      status: col('session_status', true),
      created_at: TSTZ_NULL,
    },
    foreignKeys: {
      team_id: { references: 'teams', onDelete: 'c' },
      recurring_rule_id: { references: 'recurring_session_rules', onDelete: 'n' },
    },
  },
  session_courts: {
    columns: {
      id: UUID_PK,
      session_id: col('uuid', true),
      court_identifier: col('character varying(50)', false),
      start_time: col('time without time zone', false),
      end_time: col('time without time zone', false),
      created_at: TSTZ_NULL,
    },
    foreignKeys: { session_id: { references: 'game_sessions', onDelete: 'c' } },
  },
  registrations: {
    columns: {
      id: UUID_PK,
      session_id: col('uuid', true),
      user_id: col('uuid', true),
      guest_count: col('integer', true),
      status: col('registration_status', false),
      queue_position: col('integer', true),
      registered_at: TSTZ_NULL,
      updated_at: TSTZ_NULL,
    },
    foreignKeys: {
      session_id: { references: 'game_sessions', onDelete: 'c' },
      user_id: { references: 'users', onDelete: 'c' },
    },
  },
  player_credits: {
    columns: {
      id: UUID_PK,
      user_id: col('uuid', true),
      team_id: col('uuid', true),
      balance: MONEY,
      updated_at: TSTZ_NULL,
    },
    foreignKeys: {
      user_id: { references: 'users', onDelete: 'c' },
      team_id: { references: 'teams', onDelete: 'c' },
    },
  },
  credit_transactions: {
    columns: {
      id: UUID_PK,
      user_id: col('uuid', true),
      team_id: col('uuid', true),
      amount: MONEY,
      transaction_type: col('credit_transaction_type', false),
      akahu_payment_id: col('character varying(255)', true),
      registration_id: col('uuid', true),
      resulting_balance: MONEY,
      created_at: TSTZ_NULL,
    },
    foreignKeys: {
      user_id: { references: 'users', onDelete: 'c' },
      team_id: { references: 'teams', onDelete: 'c' },
      registration_id: { references: 'registrations', onDelete: 'n' },
    },
  },
  payments: {
    columns: {
      id: UUID_PK,
      user_id: col('uuid', true),
      registration_id: col('uuid', true),
      billing_type: col('billing_type', false),
      amount: MONEY,
      subtotal_amount: MONEY,
      gst_amount: MONEY,
      status: col('payment_status', false),
      payment_link_token: col('character varying(255)', false),
      akahu_payment_id: col('character varying(255)', true),
      due_date: col('timestamp with time zone', false),
      paid_at: TSTZ_NULL,
      is_tax_invoice_issued: col('boolean', false),
      created_at: TSTZ_NULL,
    },
    foreignKeys: {
      user_id: { references: 'users', onDelete: 'c' },
      registration_id: { references: 'registrations', onDelete: 'n' },
    },
  },
};

/** The 11 draft indexes: table and leading columns (an equivalent with the same leading columns counts). */
export const EXPECTED_INDEXES: Readonly<
  Record<string, { readonly table: string; readonly columns: readonly string[] }>
> = {
  idx_teams_visibility: { table: 'teams', columns: ['visibility'] },
  idx_team_members_user_team: { table: 'team_members', columns: ['user_id', 'team_id', 'status'] },
  idx_team_members_auto_enroll: {
    table: 'team_members',
    columns: ['team_id', 'is_auto_enroll', 'auto_enroll_until'],
  },
  idx_game_sessions_date: { table: 'game_sessions', columns: ['date'] },
  idx_game_sessions_recurring: { table: 'game_sessions', columns: ['recurring_rule_id', 'date'] },
  idx_session_courts_session: { table: 'session_courts', columns: ['session_id'] },
  idx_registrations_session_status: {
    table: 'registrations',
    columns: ['session_id', 'status', 'queue_position'],
  },
  idx_registrations_user: { table: 'registrations', columns: ['user_id', 'registered_at'] },
  idx_payments_user_status: { table: 'payments', columns: ['user_id', 'status'] },
  idx_payments_paid_at_status: { table: 'payments', columns: ['paid_at', 'status'] },
  idx_player_credits_user_team: { table: 'player_credits', columns: ['user_id', 'team_id'] },
};
