/**
 * Domain enums mirrored from PostgreSQL (`db/migrations/*_enums.sql`), values in DB order.
 * Guarded three ways (architecture Q12, AC-INTEGRATION-2): the `enum-parity` integration test
 * against `pg_enum`, the compile-time check against kysely-codegen output
 * (`apps/api/src/lib/db/enum-parity.ts`) and the codegen drift test.
 */

export const UserSex = ['MALE', 'FEMALE', 'OTHER'] as const;
export type UserSex = (typeof UserSex)[number];

export const SkillTier = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'] as const;
export type SkillTier = (typeof SkillTier)[number];

export const GlobalRole = ['GLOBAL_ADMIN', 'TEAM_ADMIN', 'PLAYER'] as const;
export type GlobalRole = (typeof GlobalRole)[number];

/**
 * The global roles auth code may assign or expose. `TEAM_ADMIN` stays in the database enum (the draft
 * has it) but is per-team only: a CHECK keeps it out of `users.role` (AC-VERIFY-4) and the team role is
 * derived from `team_members`.
 */
export const AssignableGlobalRole = [
  'GLOBAL_ADMIN',
  'PLAYER',
] as const satisfies readonly GlobalRole[];
export type AssignableGlobalRole = (typeof AssignableGlobalRole)[number];

export const TeamVisibility = ['PUBLIC', 'PRIVATE'] as const;
export type TeamVisibility = (typeof TeamVisibility)[number];

export const TeamRole = ['TEAM_ADMIN', 'MEMBER'] as const;
export type TeamRole = (typeof TeamRole)[number];

export const MembershipStatus = ['PENDING', 'APPROVED', 'REJECTED', 'BANNED'] as const;
export type MembershipStatus = (typeof MembershipStatus)[number];

export const PricingType = ['FLAT', 'BY_SEX', 'BY_SKILL_LEVEL'] as const;
export type PricingType = (typeof PricingType)[number];

export const SessionStatus = ['DRAFT', 'PUBLISHED', 'COMPLETED', 'CANCELLED'] as const;
export type SessionStatus = (typeof SessionStatus)[number];

export const RegistrationStatus = ['CONFIRMED', 'WAITLISTED', 'WITHDRAWN'] as const;
export type RegistrationStatus = (typeof RegistrationStatus)[number];

/** How a withdrawn registration ended: before the deadline, after it, or because the member was banned. */
export const WithdrawalKind = ['EARLY', 'LATE', 'BANNED'] as const;
export type WithdrawalKind = (typeof WithdrawalKind)[number];

/** How a registration row was created: by the member, or by the team's Auto Enroll. */
export const RegistrationSource = ['MEMBER', 'AUTO_ENROL'] as const;
export type RegistrationSource = (typeof RegistrationSource)[number];

export const PaymentStatus = ['PENDING', 'PAID', 'FAILED', 'OVERDUE'] as const;
export type PaymentStatus = (typeof PaymentStatus)[number];

/** Subscription values exist for draft conformance only; no v1.0.0 code path uses them. */
export const BillingType = [
  'PER_GAME',
  'PREPAID_CREDIT',
  'MONTHLY_SUBSCRIPTION',
  'QUARTERLY_SUBSCRIPTION',
] as const;
export type BillingType = (typeof BillingType)[number];

export const RecurrenceFrequency = ['WEEKLY', 'FORTNIGHTLY', 'MONTHLY'] as const;
export type RecurrenceFrequency = (typeof RecurrenceFrequency)[number];

export const CreditTransactionType = ['TOPUP', 'AUTO_DEDUCTION', 'REFUND'] as const;
export type CreditTransactionType = (typeof CreditTransactionType)[number];

/** Gap fix: sign-in methods of `auth_identities`. */
export const AuthProvider = ['PASSWORD', 'GOOGLE', 'FACEBOOK'] as const;
export type AuthProvider = (typeof AuthProvider)[number];

/** Gap fix: the basis a payment line was priced on (algorithm Q11). */
export const FeeBasis = [
  'FLAT',
  'SEX_MALE',
  'SEX_FEMALE',
  'SEX_OTHER',
  'SKILL_BEGINNER',
  'SKILL_INTERMEDIATE',
  'SKILL_ADVANCED',
] as const;
export type FeeBasis = (typeof FeeBasis)[number];

/**
 * wallet-and-akahu-billing CR-1: the lifecycle of one Akahu payment intent, shared by `payment_attempts` and
 * `wallet_top_ups`. CREATING, OPEN and HELD block a new intent for the same payment or wallet.
 */
export const PaymentIntentStatus = [
  'CREATING',
  'OPEN',
  'HELD',
  'APPLIED',
  'UNAPPLIED',
  'CLOSED',
] as const;
export type PaymentIntentStatus = (typeof PaymentIntentStatus)[number];

/** Why an intent is HELD (CR-2, CR-26): an indeterminate bank error, or a SENT amount that differs from ours. */
export const PaymentHoldReason = ['INDETERMINATE', 'AMOUNT_MISMATCH'] as const;
export type PaymentHoldReason = (typeof PaymentHoldReason)[number];

/** Why a SENT payment could not be absorbed (B3): over the wallet cap, a duplicate, late, or a mismatched amount. */
export const PaymentUnappliedReason = ['OVER_CAP', 'DUPLICATE', 'LATE', 'AMOUNT_MISMATCH'] as const;
export type PaymentUnappliedReason = (typeof PaymentUnappliedReason)[number];

/** How a GLOBAL_ADMIN resolved a HELD intent (CR-15, CR-26); no free text. */
export const PaymentResolutionReason = [
  'RECEIVED',
  'AMOUNT_MISMATCH',
  'NOT_RECEIVED_INDETERMINATE',
  'NOT_RECEIVED_NOT_SENT',
] as const;
export type PaymentResolutionReason = (typeof PaymentResolutionReason)[number];

/** Why a GLOBAL_ADMIN marked a team's payout destination as blocked (A3, CR-14); no free text. */
export const PayoutBlockReason = [
  'AKAHU_REPORTED_ACCOUNT_PROBLEM',
  'FUNDS_RETURNED',
  'TEAM_REQUESTED',
  'OTHER',
] as const;
export type PayoutBlockReason = (typeof PayoutBlockReason)[number];

/**
 * The numbered document issued for a PAID payment above $0.00 (tax-invoices-and-exports, ADR 0021): a tax invoice for a
 * GST-registered charge, otherwise a receipt (H2). Each kind has its own gapless series per team.
 */
export const PaymentDocumentKind = ['TAX_INVOICE', 'RECEIPT'] as const;
export type PaymentDocumentKind = (typeof PaymentDocumentKind)[number];

/** Every public PostgreSQL enum type, keyed by its DB name. */
export const DB_ENUMS = {
  user_sex: UserSex,
  skill_tier: SkillTier,
  global_role: GlobalRole,
  team_visibility: TeamVisibility,
  team_role: TeamRole,
  membership_status: MembershipStatus,
  pricing_type: PricingType,
  session_status: SessionStatus,
  registration_status: RegistrationStatus,
  withdrawal_kind: WithdrawalKind,
  registration_source: RegistrationSource,
  payment_status: PaymentStatus,
  billing_type: BillingType,
  recurrence_frequency: RecurrenceFrequency,
  credit_transaction_type: CreditTransactionType,
  auth_provider: AuthProvider,
  fee_basis: FeeBasis,
  payment_intent_status: PaymentIntentStatus,
  payment_hold_reason: PaymentHoldReason,
  payment_unapplied_reason: PaymentUnappliedReason,
  payment_resolution_reason: PaymentResolutionReason,
  payout_block_reason: PayoutBlockReason,
  payment_document_kind: PaymentDocumentKind,
} as const satisfies Readonly<Record<string, readonly string[]>>;
