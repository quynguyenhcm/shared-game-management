-- PostgreSQL 15+ Complete Database Schema

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- ENUM TYPES
-- =============================================================================
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
CREATE TYPE billing_type AS ENUM ('PER_GAME', 'PREPAID_CREDIT', 'MONTHLY_SUBSCRIPTION', 'QUARTERLY_SUBSCRIPTION');
CREATE TYPE recurrence_frequency AS ENUM ('WEEKLY', 'FORTNIGHTLY', 'MONTHLY');
CREATE TYPE credit_transaction_type AS ENUM ('TOPUP', 'AUTO_DEDUCTION', 'REFUND');

-- =============================================================================
-- 1. USERS & ACCOUNT PROFILE
-- =============================================================================
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    sex user_sex NOT NULL,
    role global_role NOT NULL DEFAULT 'PLAYER',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- 2. TEAMS & MERCHANT BANKING SETUP
-- =============================================================================
CREATE TABLE teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    visibility team_visibility NOT NULL DEFAULT 'PUBLIC',
    invite_code VARCHAR(100) UNIQUE NOT NULL,
    created_by UUID REFERENCES users(id),
    bank_account_name VARCHAR(255),
    bank_account_number VARCHAR(30), -- NZ Format: XX-XXXX-XXXXXXX-XX
    akahu_merchant_id VARCHAR(255),
    akahu_app_token VARCHAR(255),
    is_payout_configured BOOLEAN NOT NULL DEFAULT FALSE,
    gst_registered BOOLEAN NOT NULL DEFAULT FALSE,
    ird_number VARCHAR(20),
    gst_number VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- 3. TEAM MEMBERSHIP & MODERATION
-- =============================================================================
CREATE TABLE team_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role team_role NOT NULL DEFAULT 'MEMBER',
    status membership_status NOT NULL DEFAULT 'PENDING',
    skill_level skill_tier NOT NULL DEFAULT 'BEGINNER',
    skill_level_override_by UUID REFERENCES users(id),
    skill_level_override_at TIMESTAMP WITH TIME ZONE,
    is_auto_enroll BOOLEAN NOT NULL DEFAULT FALSE,
    auto_enroll_until DATE,
    banned_at TIMESTAMP WITH TIME ZONE,
    banned_by UUID REFERENCES users(id),
    ban_reason TEXT,
    requested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    approved_at TIMESTAMP WITH TIME ZONE,
    approved_by UUID REFERENCES users(id),
    UNIQUE(team_id, user_id)
);

-- =============================================================================
-- 4. RECURRING SESSION RULES
-- =============================================================================
CREATE TABLE recurring_session_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    frequency recurrence_frequency NOT NULL DEFAULT 'WEEKLY',
    day_of_week INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    default_location VARCHAR(255) NOT NULL,
    default_address TEXT NOT NULL,
    default_max_players INT NOT NULL,
    default_reserved_seats INT NOT NULL DEFAULT 0,
    default_court_count INT NOT NULL DEFAULT 1,
    default_start_time TIME NOT NULL,
    default_end_time TIME NOT NULL,
    default_total_court_cost DECIMAL(10, 2) DEFAULT 0.00,
    default_extra_expenses DECIMAL(10, 2) DEFAULT 0.00,
    default_custom_player_rate DECIMAL(10, 2),
    pricing_structure pricing_type NOT NULL DEFAULT 'FLAT',
    fee_flat DECIMAL(10, 2),
    fee_male DECIMAL(10, 2),
    fee_female DECIMAL(10, 2),
    fee_beginner DECIMAL(10, 2),
    fee_intermediate DECIMAL(10, 2),
    fee_advanced DECIMAL(10, 2),
    recur_until DATE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- 5. GAME SESSIONS & MULTI-COURT SCHEDULE
-- =============================================================================
CREATE TABLE game_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    recurring_rule_id UUID REFERENCES recurring_session_rules(id) ON DELETE SET NULL,
    is_instance_overridden BOOLEAN NOT NULL DEFAULT FALSE,
    location VARCHAR(255) NOT NULL,
    address TEXT NOT NULL,
    date DATE NOT NULL,
    cancellation_deadline TIMESTAMP WITH TIME ZONE NOT NULL,
    max_players INT NOT NULL,
    reserved_seats INT NOT NULL DEFAULT 0,
    total_court_cost DECIMAL(10, 2) DEFAULT 0.00,
    extra_expenses DECIMAL(10, 2) DEFAULT 0.00,
    calculated_rate_per_player DECIMAL(10, 2),
    custom_player_rate DECIMAL(10, 2),
    pricing_structure pricing_type NOT NULL DEFAULT 'FLAT',
    fee_flat DECIMAL(10, 2),
    fee_male DECIMAL(10, 2),
    fee_female DECIMAL(10, 2),
    fee_beginner DECIMAL(10, 2),
    fee_intermediate DECIMAL(10, 2),
    fee_advanced DECIMAL(10, 2),
    status session_status DEFAULT 'DRAFT',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE session_courts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES game_sessions(id) ON DELETE CASCADE,
    court_identifier VARCHAR(50) NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- 6. REGISTRATIONS & FIFO WAITLIST
-- =============================================================================
CREATE TABLE registrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES game_sessions(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    guest_count INT DEFAULT 0 CHECK (guest_count <= 2),
    status registration_status NOT NULL,
    queue_position INT DEFAULT NULL,
    registered_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- 7. PREPAID WALLET & PAYMENTS SUBSYSTEM
-- =============================================================================
CREATE TABLE player_credits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    balance DECIMAL(10, 2) NOT NULL DEFAULT 0.00 CHECK (balance >= 0.00),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, team_id)
);

CREATE TABLE credit_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    amount DECIMAL(10, 2) NOT NULL,
    transaction_type credit_transaction_type NOT NULL,
    akahu_payment_id VARCHAR(255),
    registration_id UUID REFERENCES registrations(id) ON DELETE SET NULL,
    resulting_balance DECIMAL(10, 2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    registration_id UUID REFERENCES registrations(id) ON DELETE SET NULL,
    billing_type billing_type NOT NULL DEFAULT 'PER_GAME',
    amount DECIMAL(10, 2) NOT NULL,
    subtotal_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    gst_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    status payment_status NOT NULL DEFAULT 'PENDING',
    payment_link_token VARCHAR(255) UNIQUE NOT NULL,
    akahu_payment_id VARCHAR(255),
    due_date TIMESTAMP WITH TIME ZONE NOT NULL,
    paid_at TIMESTAMP WITH TIME ZONE,
    is_tax_invoice_issued BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- INDEXES FOR PERFORMANCE
-- =============================================================================
CREATE INDEX idx_teams_visibility ON teams(visibility);
CREATE INDEX idx_team_members_user_team ON team_members(user_id, team_id, status);
CREATE INDEX idx_team_members_auto_enroll ON team_members(team_id, is_auto_enroll, auto_enroll_until);
CREATE INDEX idx_game_sessions_date ON game_sessions(date DESC);
CREATE INDEX idx_game_sessions_recurring ON game_sessions(recurring_rule_id, date);
CREATE INDEX idx_session_courts_session ON session_courts(session_id);
CREATE INDEX idx_registrations_session_status ON registrations(session_id, status, queue_position);
CREATE INDEX idx_registrations_user ON registrations(user_id, registered_at DESC);
CREATE INDEX idx_payments_user_status ON payments(user_id, status);
CREATE INDEX idx_payments_paid_at_status ON payments(paid_at, status);
CREATE INDEX idx_player_credits_user_team ON player_credits(user_id, team_id);
