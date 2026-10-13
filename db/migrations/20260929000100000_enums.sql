-- Up Migration
-- The 13 enum types of database-design.md (values and order unchanged), plus two gap-fix enums:
-- auth_provider (auth identities, AC-VERIFY-6) and fee_basis (payment line items, algorithm Q11).
-- Mirrored in packages/shared/src/types/enums.ts in this order (AC-INTEGRATION-2).
CREATE TYPE user_sex AS ENUM ('MALE', 'FEMALE', 'OTHER');
CREATE TYPE skill_tier AS ENUM ('BEGINNER', 'INTERMEDIATE', 'ADVANCED');
CREATE TYPE global_role AS ENUM ('GLOBAL_ADMIN', 'TEAM_ADMIN', 'PLAYER');
CREATE TYPE team_visibility AS ENUM ('PUBLIC', 'PRIVATE');
CREATE TYPE team_role AS ENUM ('TEAM_ADMIN', 'MEMBER');
CREATE TYPE membership_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'BANNED');
CREATE TYPE pricing_type AS ENUM ('FLAT', 'BY_SEX', 'BY_SKILL_LEVEL');
CREATE TYPE session_status AS ENUM ('DRAFT', 'PUBLISHED', 'COMPLETED', 'CANCELLED');
CREATE TYPE registration_status AS ENUM ('CONFIRMED', 'WAITLISTED', 'WITHDRAWN');
CREATE TYPE payment_status AS ENUM ('PENDING', 'PAID', 'FAILED', 'OVERDUE');
-- MONTHLY_/QUARTERLY_SUBSCRIPTION are kept for draft conformance; no v1.0.0 code path uses them.
CREATE TYPE billing_type AS ENUM ('PER_GAME', 'PREPAID_CREDIT', 'MONTHLY_SUBSCRIPTION', 'QUARTERLY_SUBSCRIPTION');
CREATE TYPE recurrence_frequency AS ENUM ('WEEKLY', 'FORTNIGHTLY', 'MONTHLY');
CREATE TYPE credit_transaction_type AS ENUM ('TOPUP', 'AUTO_DEDUCTION', 'REFUND');
CREATE TYPE auth_provider AS ENUM ('PASSWORD', 'GOOGLE', 'FACEBOOK');
CREATE TYPE fee_basis AS ENUM (
  'FLAT', 'SEX_MALE', 'SEX_FEMALE', 'SEX_OTHER', 'SKILL_BEGINNER', 'SKILL_INTERMEDIATE', 'SKILL_ADVANCED'
);

-- Down Migration
DROP TYPE fee_basis;
DROP TYPE auth_provider;
DROP TYPE credit_transaction_type;
DROP TYPE recurrence_frequency;
DROP TYPE billing_type;
DROP TYPE payment_status;
DROP TYPE registration_status;
DROP TYPE session_status;
DROP TYPE pricing_type;
DROP TYPE membership_status;
DROP TYPE team_role;
DROP TYPE team_visibility;
DROP TYPE global_role;
DROP TYPE skill_tier;
DROP TYPE user_sex;
