-- Up Migration
-- team-banking-and-gst: payout and GST invariants (D-47..D-53). Decision records:
-- memory-bank/creative/team-banking-and-gst-banking-architecture.md (Q3, Q4, Q6, Q8) and
-- team-banking-and-gst-nz-validation-algorithm.md (Q2, Q5), overridden where the task file's
-- "Creative Reconciliation" (R1-R12) says so: no Akahu column or envelope CHECK is touched (R1), one GST number
-- (R2), payout_blocked_at feeds the generated flag (R3), staged cleanup then NOT VALID + VALIDATE (R5).

-- D-53: stage 1, clean up rows the old schema allowed, so the new CHECKs validate. Never fails on old data.
DO $$
DECLARE
  cleared_blocks integer;
  nulled_numbers integer;
  deregistered   integer;
BEGIN
  -- A partial banking block (some but not all of name, number, last4) cannot be completed: clear it entirely.
  UPDATE teams
     SET bank_account_name = NULL, bank_account_number = NULL, bank_account_last4 = NULL
   WHERE NOT ((bank_account_name IS NULL) = (bank_account_number IS NULL)
              AND (bank_account_number IS NULL) = (bank_account_last4 IS NULL));
  GET DIAGNOSTICS cleared_blocks = ROW_COUNT;

  -- A malformed GST number is dropped (format first, so a registered team with a bad number is then
  -- deregistered by the next statement rather than failing the CHECK).
  UPDATE teams SET gst_number = NULL WHERE gst_number IS NOT NULL AND gst_number !~ '^[1-9][0-9]{7,8}$';
  GET DIAGNOSTICS nulled_numbers = ROW_COUNT;

  -- Registered for GST but no number to print: the registration cannot stand.
  UPDATE teams SET gst_registered = false WHERE gst_registered AND gst_number IS NULL;
  GET DIAGNOSTICS deregistered = ROW_COUNT;

  RAISE NOTICE 'team banking cleanup: cleared % partial payout block(s), nulled % malformed gst_number value(s), deregistered % GST team(s) without a number',
    cleared_blocks, nulled_numbers, deregistered;
END $$;

-- D-47: payout_blocked_at (R3) and the generated is_payout_configured (Arch Q6, extended by R3). The column is
-- dropped and re-added: its value is computed, so nothing is backfilled. Precedent: D-19 payments.gst_amount.
ALTER TABLE teams ADD COLUMN payout_blocked_at timestamptz;
ALTER TABLE teams DROP COLUMN is_payout_configured;
ALTER TABLE teams
  ADD COLUMN is_payout_configured boolean NOT NULL GENERATED ALWAYS AS (
    bank_account_name IS NOT NULL AND bank_account_number IS NOT NULL AND bank_account_last4 IS NOT NULL
    AND payout_blocked_at IS NULL) STORED;
-- Sorts after teams_bank_account_*_envelope so a plaintext write keeps reporting the envelope CHECK first.
ALTER TABLE teams
  ADD CONSTRAINT teams_payout_details_all_or_none CHECK (
        (bank_account_name IS NULL) = (bank_account_number IS NULL)
    AND (bank_account_number IS NULL) = (bank_account_last4 IS NULL)) NOT VALID;
ALTER TABLE teams VALIDATE CONSTRAINT teams_payout_details_all_or_none;

-- D-48: GST settings (R2: one number, canonical digits without a leading zero, 8 or 9 digits).
ALTER TABLE teams
  ADD CONSTRAINT teams_gst_number_format CHECK (gst_number IS NULL OR gst_number ~ '^[1-9][0-9]{7,8}$') NOT VALID,
  ADD CONSTRAINT teams_gst_registered_requires_gst_number CHECK (NOT gst_registered OR gst_number IS NOT NULL) NOT VALID;
ALTER TABLE teams VALIDATE CONSTRAINT teams_gst_number_format;
ALTER TABLE teams VALIDATE CONSTRAINT teams_gst_registered_requires_gst_number;

-- D-51: banking audit stamp (R8). Outside the all-or-none block so it survives a removal. The by-column may
-- become NULL when the user is deleted.
ALTER TABLE teams
  ADD COLUMN banking_updated_at timestamptz,
  ADD COLUMN banking_updated_by uuid REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE teams
  ADD CONSTRAINT teams_banking_updated_pair CHECK (banking_updated_by IS NULL OR banking_updated_at IS NOT NULL) NOT VALID;
ALTER TABLE teams VALIDATE CONSTRAINT teams_banking_updated_pair;

-- D-49: the paid-session rule (algorithm doc Q5, R9). Only the fee columns that apply to the pricing
-- structure count; NULL is 0; paid only when a fee is > 0 (a negative fee is not paid). Not STRICT: NULL fees are
-- meaningful. An unknown structure fails closed (demands banking). Twin of isPaidSession (Phase 3).
CREATE FUNCTION game_session_is_paid(
  pricing_structure pricing_type, fee_flat numeric, fee_male numeric, fee_female numeric, fee_other numeric,
  fee_beginner numeric, fee_intermediate numeric, fee_advanced numeric) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE pricing_structure
    WHEN 'FLAT'           THEN coalesce(fee_flat, 0) > 0
    WHEN 'BY_SEX'         THEN coalesce(fee_male, 0) > 0 OR coalesce(fee_female, 0) > 0 OR coalesce(fee_other, 0) > 0
    WHEN 'BY_SKILL_LEVEL' THEN coalesce(fee_beginner, 0) > 0 OR coalesce(fee_intermediate, 0) > 0
                               OR coalesce(fee_advanced, 0) > 0
    ELSE true
  END $$;

-- D-49: publish backstop (Arch Q4, protocol step 1 and 4). Fires only on a transition INTO published-and-paid.
-- Reads the team FOR KEY SHARE: the lock every FK insert into game_sessions already takes, so it adds no
-- lock-order edge, and it only conflicts with the removal's FOR UPDATE.
CREATE FUNCTION game_sessions_enforce_payout() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  configured boolean;
BEGIN
  IF NEW.status <> 'PUBLISHED' OR NOT game_session_is_paid(
       NEW.pricing_structure, NEW.fee_flat, NEW.fee_male, NEW.fee_female, NEW.fee_other,
       NEW.fee_beginner, NEW.fee_intermediate, NEW.fee_advanced) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Already published and paid for the same team: the removal guard keeps it valid, no lock needed.
    IF OLD.status = 'PUBLISHED' AND OLD.team_id = NEW.team_id AND game_session_is_paid(
         OLD.pricing_structure, OLD.fee_flat, OLD.fee_male, OLD.fee_female, OLD.fee_other,
         OLD.fee_beginner, OLD.fee_intermediate, OLD.fee_advanced) THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT is_payout_configured INTO configured FROM teams WHERE id = NEW.team_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN NEW;                       -- the foreign key reports 23503
  END IF;
  IF NOT configured THEN
    RAISE EXCEPTION 'team % has no usable payout details for a paid published session', NEW.team_id
      USING ERRCODE = '23514', CONSTRAINT = 'game_sessions_paid_requires_payout';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER game_sessions_paid_requires_payout
  BEFORE INSERT OR UPDATE OF status, pricing_structure, fee_flat, fee_male, fee_female, fee_other,
                             fee_beginner, fee_intermediate, fee_advanced, team_id
  ON game_sessions FOR EACH ROW EXECUTE FUNCTION game_sessions_enforce_payout();

-- D-50: one definition of "the payout destination is still needed" (R4): a PUBLISHED paid session, or a payment
-- still to be settled. The API removal path and the raw-SQL backstop both call it; billing may widen it.
CREATE FUNCTION team_banking_in_use(p_team uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM game_sessions s
                  WHERE s.team_id = p_team AND s.status = 'PUBLISHED'
                    AND game_session_is_paid(s.pricing_structure, s.fee_flat, s.fee_male, s.fee_female,
                                             s.fee_other, s.fee_beginner, s.fee_intermediate, s.fee_advanced))
      OR EXISTS (SELECT 1 FROM payments p WHERE p.team_id = p_team AND p.status IN ('PENDING', 'OVERDUE')) $$;

-- D-50: removal backstop (Arch Q4, protocol step 5). On the API path the service already holds the team row
-- FOR UPDATE, so the upgrade below is a no-op. On a raw-SQL removal (which holds only NO KEY UPDATE from its own
-- UPDATE) it waits out any publisher holding KEY SHARE; the next statement's fresh READ COMMITTED snapshot then
-- sees that publish.
CREATE FUNCTION teams_guard_banking_removal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM teams WHERE id = OLD.id FOR UPDATE;
  IF team_banking_in_use(OLD.id) THEN
    RAISE EXCEPTION 'team % payout details are in use', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'teams_banking_in_use';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER teams_guard_banking_removal
  BEFORE UPDATE OF bank_account_name, bank_account_number, bank_account_last4 ON teams
  FOR EACH ROW WHEN (OLD.bank_account_number IS NOT NULL AND NEW.bank_account_number IS NULL)
  EXECUTE FUNCTION teams_guard_banking_removal();

-- Down Migration
DROP TRIGGER teams_guard_banking_removal ON teams;
DROP FUNCTION teams_guard_banking_removal();
DROP FUNCTION team_banking_in_use(uuid);
DROP TRIGGER game_sessions_paid_requires_payout ON game_sessions;
DROP FUNCTION game_sessions_enforce_payout();
DROP FUNCTION game_session_is_paid(pricing_type, numeric, numeric, numeric, numeric, numeric, numeric, numeric);
ALTER TABLE teams
  DROP CONSTRAINT teams_banking_updated_pair,
  DROP COLUMN banking_updated_by,
  DROP COLUMN banking_updated_at;
ALTER TABLE teams
  DROP CONSTRAINT teams_gst_registered_requires_gst_number,
  DROP CONSTRAINT teams_gst_number_format;
-- Restore the plain flag, recomputed from the block. The row cleanup of the up migration is not reversible.
ALTER TABLE teams
  DROP CONSTRAINT teams_payout_details_all_or_none,
  DROP COLUMN is_payout_configured;
ALTER TABLE teams DROP COLUMN payout_blocked_at;
ALTER TABLE teams ADD COLUMN is_payout_configured boolean NOT NULL DEFAULT false;
UPDATE teams
   SET is_payout_configured =
         (bank_account_name IS NOT NULL AND bank_account_number IS NOT NULL AND bank_account_last4 IS NOT NULL);
