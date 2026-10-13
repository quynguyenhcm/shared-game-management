-- Up Migration
-- Financial rows are kept 7 years (productBrief retention NFR, AC-VERIFY-11): every FK is RESTRICT.
CREATE TABLE player_credits (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  team_id    uuid NOT NULL REFERENCES teams (id) ON DELETE RESTRICT,
  balance    numeric(10,2) NOT NULL DEFAULT 0.00
    CONSTRAINT player_credits_balance_range CHECK (balance BETWEEN 0.00 AND 100.00),  -- AC-VERIFY-10
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_player_credits_user_team UNIQUE (user_id, team_id)
);

-- wallet-and-akahu-billing must create the player_credits row (balance 0.00) before the first movement.
CREATE TABLE credit_transactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  team_id           uuid NOT NULL REFERENCES teams (id) ON DELETE RESTRICT,
  amount            numeric(10,2) NOT NULL
    CONSTRAINT credit_transactions_amount_nonzero CHECK (amount <> 0.00),
  transaction_type  credit_transaction_type NOT NULL,
  akahu_payment_id  varchar(255),
  registration_id   uuid,                                          -- NULL for top-ups; FK below
  resulting_balance numeric(10,2) NOT NULL
    CONSTRAINT credit_transactions_resulting_balance_range CHECK (resulting_balance BETWEEN 0.00 AND 100.00),
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Ownership chain: a movement's user/team equal its registration's (MATCH SIMPLE: NULL registration skips it).
  CONSTRAINT fk_credit_tx_registration_owner FOREIGN KEY (registration_id, user_id, team_id)
    REFERENCES registrations (id, user_id, team_id) MATCH SIMPLE ON DELETE RESTRICT,
  CONSTRAINT fk_credit_tx_wallet FOREIGN KEY (user_id, team_id)
    REFERENCES player_credits (user_id, team_id) ON DELETE RESTRICT
);
-- Idempotent wallet deduction: at most one AUTO_DEDUCTION per registration.
CREATE UNIQUE INDEX uq_credit_tx_auto_deduction_per_registration
  ON credit_transactions (registration_id) WHERE transaction_type = 'AUTO_DEDUCTION';

-- Down Migration
DROP INDEX uq_credit_tx_auto_deduction_per_registration;
DROP TABLE credit_transactions;
DROP TABLE player_credits;
