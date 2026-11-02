-- Up Migration
-- wallet-and-akahu-billing, Phase 1: the money invariants of the billing engine, the wallet ledger and the Akahu intents
-- (ledger D-87..D-98). Decision records: memory-bank/creative/wallet-and-akahu-billing-billing-architecture.md (Q2, Q4a,
-- Q4b, Q4f) and -algorithm.md (state machines), overridden where the task file's "Creative Reconciliation" (CR-1..CR-27)
-- says so: one intent enum shared by attempts and top-ups (CR-1), hold and resolution columns (CR-2, CR-26), the sealed
-- authorisation URL (CR-6), `payment_reference` (CR-7), append-only reminders (CR-8), `billing_session_blocks` (CR-9),
-- `team_banking_in_use` widened to intents (CR-10), the trigger-maintained ledger (CR-5). The D-75 session lifecycle
-- allowlist is NOT widened: billing writes a session row once, in the PUBLISHED -> COMPLETED move the matrix already allows.

-- D-90: enums. `payment_intent_status` is shared by payment_attempts and wallet_top_ups; blocking = CREATING, OPEN, HELD.
CREATE TYPE payment_intent_status AS ENUM ('CREATING', 'OPEN', 'HELD', 'APPLIED', 'UNAPPLIED', 'CLOSED');
CREATE TYPE payment_hold_reason AS ENUM ('INDETERMINATE', 'AMOUNT_MISMATCH');
CREATE TYPE payment_unapplied_reason AS ENUM ('OVER_CAP', 'DUPLICATE', 'LATE', 'AMOUNT_MISMATCH');
CREATE TYPE payment_resolution_reason AS ENUM
  ('RECEIVED', 'AMOUNT_MISMATCH', 'NOT_RECEIVED_INDETERMINATE', 'NOT_RECEIVED_NOT_SENT');
CREATE TYPE payout_block_reason AS ENUM
  ('AKAHU_REPORTED_ACCOUNT_PROBLEM', 'FUNDS_RETURNED', 'TEAM_REQUESTED', 'OTHER');

-- D-87 (and D-90): the two transition matrices as IMMUTABLE functions, so the triggers, the tests and a raw-SQL replay
-- of the shared TS fixtures all ask the same question. A same-status write is not a transition and is always accepted.
CREATE FUNCTION payment_status_transition_allowed(p_from payment_status, p_to payment_status)
  RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_from = p_to
      OR (p_from = 'PENDING' AND p_to IN ('PAID', 'OVERDUE'))
      OR (p_from = 'OVERDUE' AND p_to = 'PAID') $$;

CREATE FUNCTION payment_intent_transition_allowed(
  p_from payment_intent_status, p_to payment_intent_status, p_has_provider_id boolean)
  RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_from = p_to
      OR (p_from = 'CREATING' AND p_to IN ('OPEN', 'CLOSED'))
      OR (p_from = 'OPEN' AND p_to IN ('HELD', 'APPLIED', 'UNAPPLIED', 'CLOSED'))
      OR (p_from = 'HELD' AND p_to IN ('APPLIED', 'UNAPPLIED', 'CLOSED'))
      OR (p_from = 'CLOSED' AND p_to IN ('APPLIED', 'UNAPPLIED') AND coalesce(p_has_provider_id, false)) $$;

-- D-87: payments.status transitions. PENDING -> PAID | OVERDUE, OVERDUE -> PAID, PAID terminal, nothing enters FAILED
-- (B4 default: a failed attempt is recorded on the attempt and the charge stays payable). OVERDUE stays insertable
-- because the debt-gate fixtures seed OVERDUE rows with raw SQL; only `daily-overdue` writing it is an application
-- rule (C-BIL-2). TS twin: packages/shared/src/billing/payment-status.ts; fixture: test/fixtures/payment-transitions.ts.
CREATE FUNCTION payments_guard_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'FAILED' THEN
      RAISE EXCEPTION 'payments: a payment cannot be created FAILED'
        USING ERRCODE = '23000', CONSTRAINT = 'payments_status_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT payment_status_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'payment %: % -> % is not an allowed transition', OLD.id, OLD.status, NEW.status
      USING ERRCODE = '23000', CONSTRAINT = 'payments_status_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_guard_status BEFORE INSERT OR UPDATE OF status ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_guard_status();

-- D-88: the team's GST number copied at charge time. The backfill copies the team's CURRENT number for registered
-- payments that predate the column (no production row exists: billing has never run), then the CHECK is added NOT VALID
-- and validated, so the scan runs under the lighter lock. gst_registered = (gst_number is present) and the teams format.
ALTER TABLE payments ADD COLUMN gst_number varchar(9);
UPDATE payments p SET gst_number = t.gst_number
  FROM teams t
 WHERE t.id = p.team_id AND p.gst_registered AND p.gst_number IS NULL AND t.gst_number IS NOT NULL;
ALTER TABLE payments ADD CONSTRAINT payments_gst_number_iff_registered
  CHECK ((gst_number IS NOT NULL) = gst_registered
         AND (gst_number IS NULL OR gst_number ~ '^[1-9][0-9]{7,8}$')) NOT VALID;
ALTER TABLE payments VALIDATE CONSTRAINT payments_gst_number_iff_registered;

-- D-89 (CR-7): payment_link_token -> payment_reference, SGM + 8 Crockford base32 characters, unique, not secret, sent as
-- the Akahu statement reference. Existing values (dev and test rows only) are regenerated so the CHECK validates.
ALTER TABLE payments RENAME COLUMN payment_link_token TO payment_reference;
ALTER TABLE payments RENAME CONSTRAINT payments_payment_link_token_key TO payments_payment_reference_key;
DO $$
DECLARE
  r        record;
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  ref      text;
  i        integer;
BEGIN
  FOR r IN SELECT id FROM payments WHERE payment_reference !~ '^SGM[0-9A-HJKMNP-TV-Z]{8}$' LOOP
    LOOP
      ref := 'SGM';
      FOR i IN 1..8 LOOP
        ref := ref || substr(alphabet, 1 + floor(random() * 32)::integer, 1);
      END LOOP;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM payments WHERE payment_reference = ref);
    END LOOP;
    UPDATE payments SET payment_reference = ref WHERE id = r.id;
  END LOOP;
END $$;
ALTER TABLE payments ALTER COLUMN payment_reference TYPE varchar(12);
ALTER TABLE payments ADD CONSTRAINT payments_payment_reference_format
  CHECK (payment_reference ~ '^SGM[0-9A-HJKMNP-TV-Z]{8}$');

-- D-88, D-89: the immutability guard now also freezes gst_number and payment_reference. due_date, status, paid_at and
-- akahu_payment_id stay writable (CR-27 raises due_date of a PENDING payment as a grace).
CREATE OR REPLACE FUNCTION payments_guard_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.user_id, NEW.team_id, NEW.registration_id, NEW.billing_type, NEW.pricing_structure,
      NEW.gst_registered, NEW.gst_rate_bps, NEW.gst_number, NEW.payment_reference, NEW.amount, NEW.created_at)
     IS DISTINCT FROM
     (OLD.user_id, OLD.team_id, OLD.registration_id, OLD.billing_type, OLD.pricing_structure,
      OLD.gst_registered, OLD.gst_rate_bps, OLD.gst_number, OLD.payment_reference, OLD.amount, OLD.created_at)
     OR (OLD.invoice_number IS NOT NULL
         AND (NEW.invoice_number, NEW.invoice_issued_at) IS DISTINCT FROM (OLD.invoice_number, OLD.invoice_issued_at)) THEN
    RAISE EXCEPTION 'payment % fee snapshot / invoice number is immutable', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

-- D-91 (CR-1, CR-2, CR-6, CR-26): one row per payment attempt at Akahu. Financial rows are kept 7 years: RESTRICT FKs,
-- no delete. `authorisation_url_enc` is a FieldCrypto envelope (AAD per row), never the plain URL.
CREATE TABLE payment_attempts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id            uuid NOT NULL REFERENCES payments (id) ON DELETE RESTRICT,
  idempotency_key       uuid NOT NULL,
  amount                numeric(10,2) NOT NULL
    CONSTRAINT payment_attempts_amount_positive CHECK (amount > 0.00),
  status                payment_intent_status NOT NULL DEFAULT 'CREATING',
  close_reason          varchar(64),
  akahu_payment_id      varchar(64),
  akahu_status          varchar(32),                  -- the provider's own status ("awaiting payer" = READY)
  akahu_status_reason   varchar(64),
  authorisation_url_enc text,
  expires_at            timestamptz,
  last_synced_at        timestamptz,
  hold_reason           payment_hold_reason,
  held_at               timestamptz,
  unapplied_reason      payment_unapplied_reason,
  resolution_reason     payment_resolution_reason,
  observed_amount       numeric(10,2),
  resolved_by           uuid REFERENCES users (id) ON DELETE RESTRICT,
  resolved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz,
  CONSTRAINT uq_payment_attempts_payment_key UNIQUE (payment_id, idempotency_key),
  CONSTRAINT uq_payment_attempts_akahu_payment UNIQUE (akahu_payment_id),
  CONSTRAINT payment_attempts_authorisation_url_envelope
    CHECK (authorisation_url_enc IS NULL
           OR authorisation_url_enc ~ '^v1\.[a-z0-9-]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{22}$'),
  -- A provider id exists from OPEN on; only an intent closed at create (refused or ambiguous) has none.
  CONSTRAINT payment_attempts_provider_id_stamp
    CHECK (akahu_payment_id IS NOT NULL OR status IN ('CREATING', 'CLOSED')),
  CONSTRAINT payment_attempts_open_stamp
    CHECK (status <> 'OPEN' OR (authorisation_url_enc IS NOT NULL AND expires_at IS NOT NULL)),
  -- CLOSED names its reason and time (a late SENT may later move it to APPLIED/UNAPPLIED, keeping them); a blocking
  -- intent has no close time.
  CONSTRAINT payment_attempts_closed_stamp
    CHECK ((status <> 'CLOSED' OR (closed_at IS NOT NULL AND close_reason IS NOT NULL))
           AND (status <> 'UNAPPLIED' OR closed_at IS NOT NULL)
           AND (status NOT IN ('CREATING', 'OPEN', 'HELD') OR closed_at IS NULL)),
  CONSTRAINT payment_attempts_hold_stamp
    CHECK ((hold_reason IS NULL) = (held_at IS NULL) AND (status <> 'HELD' OR hold_reason IS NOT NULL)),
  CONSTRAINT payment_attempts_unapplied_stamp
    CHECK ((status = 'UNAPPLIED') = (unapplied_reason IS NOT NULL)),
  CONSTRAINT payment_attempts_resolution_stamp
    CHECK ((resolved_by IS NULL) = (resolved_at IS NULL) AND (resolved_by IS NULL) = (resolution_reason IS NULL)
           AND (resolution_reason IS NULL OR hold_reason IS NOT NULL)),
  CONSTRAINT payment_attempts_observed_amount_positive CHECK (observed_amount IS NULL OR observed_amount > 0.00)
);
-- At most one blocking attempt per payment (AC-ERROR-10): CREATING, OPEN and HELD all hold the slot.
CREATE UNIQUE INDEX uq_payment_attempts_one_blocking ON payment_attempts (payment_id)
  WHERE status IN ('CREATING', 'OPEN', 'HELD');
CREATE INDEX idx_payment_attempts_open_created ON payment_attempts (created_at) WHERE status IN ('CREATING', 'OPEN');

CREATE FUNCTION payment_attempts_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.payment_id, NEW.idempotency_key, NEW.amount, NEW.created_at)
       IS DISTINCT FROM (OLD.payment_id, OLD.idempotency_key, OLD.amount, OLD.created_at)
     OR (OLD.akahu_payment_id IS NOT NULL AND NEW.akahu_payment_id IS DISTINCT FROM OLD.akahu_payment_id) THEN
    RAISE EXCEPTION 'payment attempt %: payment, key, amount and provider id are write-once', OLD.id
      USING ERRCODE = '23000', CONSTRAINT = 'payment_attempts_immutable';
  END IF;
  IF NOT payment_intent_transition_allowed(OLD.status, NEW.status, OLD.akahu_payment_id IS NOT NULL) THEN
    RAISE EXCEPTION 'payment attempt %: % -> % is not an allowed transition', OLD.id, OLD.status, NEW.status
      USING ERRCODE = '23000', CONSTRAINT = 'payment_attempts_status_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_attempts_guard_update BEFORE UPDATE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION payment_attempts_guard_update();
CREATE TRIGGER payment_attempts_no_delete BEFORE DELETE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- D-92 (CR-1, CR-7, B1): one row per wallet top-up at Akahu. The amount range is the $1.00 minimum and the $100.00 cap;
-- the headroom check against the live balance is the application's (CR-24).
CREATE TABLE wallet_top_ups (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  team_id               uuid NOT NULL REFERENCES teams (id) ON DELETE RESTRICT,
  reference             varchar(12) NOT NULL,
  idempotency_key       uuid NOT NULL,
  amount                numeric(10,2) NOT NULL
    CONSTRAINT wallet_top_ups_amount_range CHECK (amount BETWEEN 1.00 AND 100.00),
  status                payment_intent_status NOT NULL DEFAULT 'CREATING',
  close_reason          varchar(64),
  akahu_payment_id      varchar(64),
  akahu_status          varchar(32),
  akahu_status_reason   varchar(64),
  authorisation_url_enc text,
  expires_at            timestamptz,
  last_synced_at        timestamptz,
  hold_reason           payment_hold_reason,
  held_at               timestamptz,
  unapplied_reason      payment_unapplied_reason,
  resolution_reason     payment_resolution_reason,
  observed_amount       numeric(10,2),
  resolved_by           uuid REFERENCES users (id) ON DELETE RESTRICT,
  resolved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz,
  CONSTRAINT wallet_top_ups_reference_format CHECK (reference ~ '^SGM[0-9A-HJKMNP-TV-Z]{8}$'),
  CONSTRAINT uq_wallet_top_ups_reference UNIQUE (reference),
  CONSTRAINT uq_wallet_top_ups_owner_key UNIQUE (user_id, team_id, idempotency_key),
  CONSTRAINT uq_wallet_top_ups_akahu_payment UNIQUE (akahu_payment_id),
  CONSTRAINT uq_wallet_top_ups_id_owner UNIQUE (id, user_id, team_id),  -- target of the ledger's ownership FK
  CONSTRAINT wallet_top_ups_authorisation_url_envelope
    CHECK (authorisation_url_enc IS NULL
           OR authorisation_url_enc ~ '^v1\.[a-z0-9-]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{22}$'),
  CONSTRAINT wallet_top_ups_provider_id_stamp
    CHECK (akahu_payment_id IS NOT NULL OR status IN ('CREATING', 'CLOSED')),
  CONSTRAINT wallet_top_ups_open_stamp
    CHECK (status <> 'OPEN' OR (authorisation_url_enc IS NOT NULL AND expires_at IS NOT NULL)),
  CONSTRAINT wallet_top_ups_closed_stamp
    CHECK ((status <> 'CLOSED' OR (closed_at IS NOT NULL AND close_reason IS NOT NULL))
           AND (status <> 'UNAPPLIED' OR closed_at IS NOT NULL)
           AND (status NOT IN ('CREATING', 'OPEN', 'HELD') OR closed_at IS NULL)),
  CONSTRAINT wallet_top_ups_hold_stamp
    CHECK ((hold_reason IS NULL) = (held_at IS NULL) AND (status <> 'HELD' OR hold_reason IS NOT NULL)),
  CONSTRAINT wallet_top_ups_unapplied_stamp
    CHECK ((status = 'UNAPPLIED') = (unapplied_reason IS NOT NULL)),
  CONSTRAINT wallet_top_ups_resolution_stamp
    CHECK ((resolved_by IS NULL) = (resolved_at IS NULL) AND (resolved_by IS NULL) = (resolution_reason IS NULL)
           AND (resolution_reason IS NULL OR hold_reason IS NOT NULL)),
  CONSTRAINT wallet_top_ups_observed_amount_positive CHECK (observed_amount IS NULL OR observed_amount > 0.00)
);
-- At most one blocking top-up per wallet (AC-ERROR-2).
CREATE UNIQUE INDEX uq_wallet_top_ups_one_blocking ON wallet_top_ups (user_id, team_id)
  WHERE status IN ('CREATING', 'OPEN', 'HELD');
CREATE INDEX idx_wallet_top_ups_open_created ON wallet_top_ups (created_at) WHERE status IN ('CREATING', 'OPEN');

CREATE FUNCTION wallet_top_ups_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.user_id, NEW.team_id, NEW.reference, NEW.idempotency_key, NEW.amount, NEW.created_at)
       IS DISTINCT FROM (OLD.user_id, OLD.team_id, OLD.reference, OLD.idempotency_key, OLD.amount, OLD.created_at)
     OR (OLD.akahu_payment_id IS NOT NULL AND NEW.akahu_payment_id IS DISTINCT FROM OLD.akahu_payment_id) THEN
    RAISE EXCEPTION 'wallet top-up %: owner, reference, key, amount and provider id are write-once', OLD.id
      USING ERRCODE = '23000', CONSTRAINT = 'wallet_top_ups_immutable';
  END IF;
  IF NOT payment_intent_transition_allowed(OLD.status, NEW.status, OLD.akahu_payment_id IS NOT NULL) THEN
    RAISE EXCEPTION 'wallet top-up %: % -> % is not an allowed transition', OLD.id, OLD.status, NEW.status
      USING ERRCODE = '23000', CONSTRAINT = 'wallet_top_ups_status_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wallet_top_ups_guard_update BEFORE UPDATE ON wallet_top_ups
  FOR EACH ROW EXECUTE FUNCTION wallet_top_ups_guard_update();
CREATE TRIGGER wallet_top_ups_no_delete BEFORE DELETE ON wallet_top_ups
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- D-93 (CR-5): the ledger. The application only INSERTs credit_transactions with its computed resulting_balance; the
-- BEFORE INSERT trigger locks the wallet row, refuses unless resulting_balance = balance + amount, then writes the
-- balance. player_credits is inserted at 0.00 and its balance changes only from inside that trigger (nesting depth 2),
-- so "balance = latest resulting_balance = running sum from 0.00" holds for every writer, raw SQL included.
ALTER TABLE credit_transactions ADD COLUMN wallet_top_up_id uuid;
ALTER TABLE credit_transactions ADD CONSTRAINT fk_credit_tx_top_up_owner
  FOREIGN KEY (wallet_top_up_id, user_id, team_id) REFERENCES wallet_top_ups (id, user_id, team_id)
  MATCH SIMPLE ON DELETE RESTRICT;
ALTER TABLE credit_transactions ADD CONSTRAINT credit_transactions_no_refund
  CHECK (transaction_type <> 'REFUND');                               -- B3: no refund movement in v1
ALTER TABLE credit_transactions ADD CONSTRAINT credit_transactions_type_shape CHECK (
     (transaction_type = 'TOPUP' AND amount > 0.00 AND akahu_payment_id IS NOT NULL
      AND wallet_top_up_id IS NOT NULL AND registration_id IS NULL)
  OR (transaction_type = 'AUTO_DEDUCTION' AND amount < 0.00 AND registration_id IS NOT NULL
      AND wallet_top_up_id IS NULL));
CREATE UNIQUE INDEX uq_credit_tx_topup_akahu_payment ON credit_transactions (akahu_payment_id)
  WHERE transaction_type = 'TOPUP';
CREATE UNIQUE INDEX uq_credit_tx_topup_intent ON credit_transactions (wallet_top_up_id)
  WHERE transaction_type = 'TOPUP';

CREATE FUNCTION credit_transactions_ledger_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_balance numeric(10,2);
BEGIN
  SELECT balance INTO v_balance FROM player_credits
   WHERE user_id = NEW.user_id AND team_id = NEW.team_id
     FOR NO KEY UPDATE;                         -- free when the caller already holds the wallet lock
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no wallet for user % in team %', NEW.user_id, NEW.team_id
      USING ERRCODE = '23503', CONSTRAINT = 'fk_credit_tx_wallet';
  END IF;
  IF NEW.resulting_balance IS DISTINCT FROM v_balance + NEW.amount THEN
    RAISE EXCEPTION 'credit_transactions: resulting balance % is not balance % + amount %',
      NEW.resulting_balance, v_balance, NEW.amount
      USING ERRCODE = '23514', CONSTRAINT = 'credit_transactions_balance_chain';
  END IF;
  UPDATE player_credits SET balance = NEW.resulting_balance, updated_at = now()
   WHERE user_id = NEW.user_id AND team_id = NEW.team_id;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_transactions_ledger_chain BEFORE INSERT ON credit_transactions
  FOR EACH ROW EXECUTE FUNCTION credit_transactions_ledger_chain();
CREATE TRIGGER credit_transactions_append_only BEFORE UPDATE OR DELETE ON credit_transactions
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

CREATE FUNCTION player_credits_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.balance <> 0.00 THEN
      RAISE EXCEPTION 'player_credits: a wallet is created at 0.00 and funded through the ledger'
        USING ERRCODE = '23000', CONSTRAINT = 'player_credits_balance_ledger_only';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'player_credits rows are kept (7-year retention)'
      USING ERRCODE = '23000', CONSTRAINT = 'player_credits_no_delete';
  END IF;
  IF (NEW.id, NEW.user_id, NEW.team_id) IS DISTINCT FROM (OLD.id, OLD.user_id, OLD.team_id) THEN
    RAISE EXCEPTION 'player_credits: owner is immutable'
      USING ERRCODE = '23000', CONSTRAINT = 'player_credits_keys_immutable';
  END IF;
  IF NEW.balance IS DISTINCT FROM OLD.balance AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'player_credits.balance changes only through a credit_transactions row'
      USING ERRCODE = '23000', CONSTRAINT = 'player_credits_balance_ledger_only';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER player_credits_guard BEFORE INSERT OR UPDATE OR DELETE ON player_credits
  FOR EACH ROW EXECUTE FUNCTION player_credits_guard();

-- D-94 (CR-10): the payout destination is also in use while a top-up or a payment attempt of the team is CREATING,
-- OPEN or HELD (money may be in flight to that account). FAILED is not added (B4: never set). The service reads this same
-- function and the removal trigger calls it, so service, trigger and parity tests change together (AC-VERIFY-11).
CREATE OR REPLACE FUNCTION team_banking_in_use(p_team uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM game_sessions s
                  WHERE s.team_id = p_team AND s.status = 'PUBLISHED'
                    AND game_session_is_paid(s.pricing_structure, s.fee_flat, s.fee_male, s.fee_female,
                                             s.fee_other, s.fee_beginner, s.fee_intermediate, s.fee_advanced))
      OR EXISTS (SELECT 1 FROM payments p WHERE p.team_id = p_team AND p.status IN ('PENDING', 'OVERDUE'))
      OR EXISTS (SELECT 1 FROM wallet_top_ups t
                  WHERE t.team_id = p_team AND t.status IN ('CREATING', 'OPEN', 'HELD'))
      OR EXISTS (SELECT 1 FROM payment_attempts a JOIN payments p ON p.id = a.payment_id
                  WHERE p.team_id = p_team AND a.status IN ('CREATING', 'OPEN', 'HELD')) $$;

-- D-95 (CR-8): the manual reminder log. lastReminderAt is derived from it; payments gets no reminder columns, so the
-- immutability guard above is not widened for them.
CREATE TABLE payment_reminders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id    uuid NOT NULL REFERENCES payments (id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  kind          varchar(16) NOT NULL DEFAULT 'MANUAL'
    CONSTRAINT payment_reminders_kind CHECK (kind = 'MANUAL'),
  change_key    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_payment_reminders_payment_key UNIQUE (payment_id, change_key)
);
CREATE INDEX idx_payment_reminders_payment_created ON payment_reminders (payment_id, created_at DESC);
CREATE TRIGGER payment_reminders_append_only BEFORE UPDATE OR DELETE ON payment_reminders
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- D-96 (A3, CR-14): the manual "payout blocked" audit. An enum reason and an optional Akahu payment id, no free text,
-- so no bank digits can be typed into the audit row. actor_user_id is NULL only for a future automatic trigger.
CREATE TABLE payout_block_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id          uuid NOT NULL REFERENCES teams (id) ON DELETE RESTRICT,
  actor_user_id    uuid REFERENCES users (id) ON DELETE RESTRICT,
  reason           payout_block_reason NOT NULL,
  akahu_payment_id varchar(64),
  change_key       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_block_events_akahu_payment_id_format
    CHECK (akahu_payment_id IS NULL OR akahu_payment_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  CONSTRAINT uq_payout_block_events_team_key UNIQUE (team_id, change_key)
);
CREATE INDEX idx_payout_block_events_team_created ON payout_block_events (team_id, created_at DESC);
CREATE TRIGGER payout_block_events_append_only BEFORE UPDATE OR DELETE ON payout_block_events
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- D-97 (CR-9, B8): one claim row per session held because its team could not take payments at billing time; the
-- admins' "Billing is paused" email is sent when the claim is new, and notified_at records it.
CREATE TABLE billing_session_blocks (
  session_id  uuid PRIMARY KEY,
  team_id     uuid NOT NULL REFERENCES teams (id) ON DELETE RESTRICT,
  blocked_at  timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  CONSTRAINT billing_session_blocks_session_team_fk
    FOREIGN KEY (session_id, team_id) REFERENCES game_sessions (id, team_id) ON DELETE RESTRICT
);

-- D-98: overdue selection and the admin list. `idx_game_sessions_billing_due` (ends_at WHERE status = 'PUBLISHED',
-- platform-foundation) already serves the sweep, so the architecture's `idx_game_sessions_published_ends_at` is not duplicated.
CREATE INDEX idx_payments_pending_due ON payments (due_date) WHERE status = 'PENDING';
CREATE INDEX idx_payments_team_status_due ON payments (team_id, status, due_date);

-- Down Migration
DROP INDEX idx_payments_team_status_due;
DROP INDEX idx_payments_pending_due;
DROP TABLE billing_session_blocks;
DROP TABLE payout_block_events;
DROP TABLE payment_reminders;

-- D-94 restored (the team-banking definition) before the tables it no longer reads are dropped.
CREATE OR REPLACE FUNCTION team_banking_in_use(p_team uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM game_sessions s
                  WHERE s.team_id = p_team AND s.status = 'PUBLISHED'
                    AND game_session_is_paid(s.pricing_structure, s.fee_flat, s.fee_male, s.fee_female,
                                             s.fee_other, s.fee_beginner, s.fee_intermediate, s.fee_advanced))
      OR EXISTS (SELECT 1 FROM payments p WHERE p.team_id = p_team AND p.status IN ('PENDING', 'OVERDUE')) $$;

DROP TRIGGER player_credits_guard ON player_credits;
DROP FUNCTION player_credits_guard();
DROP TRIGGER credit_transactions_append_only ON credit_transactions;
DROP TRIGGER credit_transactions_ledger_chain ON credit_transactions;
DROP FUNCTION credit_transactions_ledger_chain();
DROP INDEX uq_credit_tx_topup_intent;
DROP INDEX uq_credit_tx_topup_akahu_payment;
ALTER TABLE credit_transactions DROP CONSTRAINT credit_transactions_type_shape;
ALTER TABLE credit_transactions DROP CONSTRAINT credit_transactions_no_refund;
ALTER TABLE credit_transactions DROP CONSTRAINT fk_credit_tx_top_up_owner;
ALTER TABLE credit_transactions DROP COLUMN wallet_top_up_id;

DROP TABLE wallet_top_ups;
DROP FUNCTION wallet_top_ups_guard_update();
DROP TABLE payment_attempts;
DROP FUNCTION payment_attempts_guard_update();

-- The original immutability guard (platform-foundation), then the payments columns.
CREATE OR REPLACE FUNCTION payments_guard_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.user_id, NEW.team_id, NEW.registration_id, NEW.billing_type, NEW.pricing_structure,
      NEW.gst_registered, NEW.gst_rate_bps, NEW.amount, NEW.created_at)
     IS DISTINCT FROM
     (OLD.user_id, OLD.team_id, OLD.registration_id, OLD.billing_type, OLD.pricing_structure,
      OLD.gst_registered, OLD.gst_rate_bps, OLD.amount, OLD.created_at)
     OR (OLD.invoice_number IS NOT NULL
         AND (NEW.invoice_number, NEW.invoice_issued_at) IS DISTINCT FROM (OLD.invoice_number, OLD.invoice_issued_at)) THEN
    RAISE EXCEPTION 'payment % fee snapshot / invoice number is immutable', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE payments DROP CONSTRAINT payments_payment_reference_format;
ALTER TABLE payments ALTER COLUMN payment_reference TYPE varchar(255);
ALTER TABLE payments RENAME CONSTRAINT payments_payment_reference_key TO payments_payment_link_token_key;
ALTER TABLE payments RENAME COLUMN payment_reference TO payment_link_token;
ALTER TABLE payments DROP CONSTRAINT payments_gst_number_iff_registered;
ALTER TABLE payments DROP COLUMN gst_number;
DROP TRIGGER payments_guard_status ON payments;
DROP FUNCTION payments_guard_status();

DROP FUNCTION payment_intent_transition_allowed(payment_intent_status, payment_intent_status, boolean);
DROP FUNCTION payment_status_transition_allowed(payment_status, payment_status);
DROP TYPE payout_block_reason;
DROP TYPE payment_resolution_reason;
DROP TYPE payment_unapplied_reason;
DROP TYPE payment_hold_reason;
DROP TYPE payment_intent_status;
