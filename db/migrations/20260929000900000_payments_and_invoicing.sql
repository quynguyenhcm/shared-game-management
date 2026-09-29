-- Up Migration
-- Payment header with team routing (AC-VERIFY-8) and an immutable fee snapshot (algorithm Q11, F2).
CREATE TABLE payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  team_id               uuid NOT NULL REFERENCES teams (id) ON DELETE RESTRICT,
  registration_id       uuid,                    -- NULL only for (out-of-scope) subscription rows; FK below
  billing_type          billing_type NOT NULL DEFAULT 'PER_GAME',
  -- fee snapshot (header)
  pricing_structure     pricing_type NOT NULL,
  gst_registered        boolean NOT NULL,
  gst_rate_bps          smallint NOT NULL
    CONSTRAINT payments_gst_rate_bps_range CHECK (gst_rate_bps BETWEEN 0 AND 10000),  -- 1500 = 15%
  amount                numeric(10,2) NOT NULL
    CONSTRAINT payments_amount_non_negative CHECK (amount >= 0.00),                   -- GST-inclusive total
  -- GST once per payment on the inclusive total: 3/23 at 1500 bps; round() is HALF_UP (= money.ts).
  gst_amount            numeric(10,2) NOT NULL GENERATED ALWAYS AS
                          (round(amount * gst_rate_bps / (10000 + gst_rate_bps), 2)) STORED,
  subtotal_amount       numeric(10,2) NOT NULL GENERATED ALWAYS AS
                          (amount - round(amount * gst_rate_bps / (10000 + gst_rate_bps), 2)) STORED,
  -- lifecycle
  status                payment_status NOT NULL DEFAULT 'PENDING',
  payment_link_token    varchar(255) UNIQUE NOT NULL,
  akahu_payment_id      varchar(255),
  due_date              timestamptz NOT NULL,
  paid_at               timestamptz,
  is_tax_invoice_issued boolean NOT NULL DEFAULT false,
  invoice_number        integer,
  invoice_issued_at     timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_gst_rate_iff_registered CHECK (gst_registered = (gst_rate_bps > 0)),
  CONSTRAINT payments_paid_at_iff_paid CHECK ((status = 'PAID') = (paid_at IS NOT NULL)),
  CONSTRAINT payments_invoice_number_positive CHECK (invoice_number IS NULL OR invoice_number >= 1),
  CONSTRAINT payments_invoice_issued_consistent
    CHECK (is_tax_invoice_issued = (invoice_number IS NOT NULL)
           AND (invoice_number IS NULL) = (invoice_issued_at IS NULL)),
  CONSTRAINT uq_payments_team_invoice_number UNIQUE (team_id, invoice_number),  -- AC-VERIFY-9
  CONSTRAINT uq_payments_registration UNIQUE (registration_id),                 -- idempotent billing key
  -- Ownership chain: payer = registrant, team = session team (23503). NULL registration skips it.
  CONSTRAINT fk_payments_registration_owner FOREIGN KEY (registration_id, user_id, team_id)
    REFERENCES registrations (id, user_id, team_id) MATCH SIMPLE ON DELETE RESTRICT
);
CREATE INDEX idx_payments_team_paid_status ON payments (team_id, paid_at, status);  -- team exports/reports

-- One immutable line per party (position 0 = registrant, 1..2 = guests).
CREATE TABLE payment_line_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id            uuid NOT NULL REFERENCES payments (id) ON DELETE RESTRICT,
  party_position        smallint NOT NULL
    CONSTRAINT payment_line_items_party_position_range CHECK (party_position BETWEEN 0 AND 2),
  registration_guest_id uuid REFERENCES registration_guests (id) ON DELETE RESTRICT,
  pricing_structure     pricing_type NOT NULL,          -- = header (checked by the deferred trigger)
  applied_basis         fee_basis NOT NULL,
  party_sex             user_sex NOT NULL,              -- snapshot at charge time
  party_skill_level     skill_tier NOT NULL,            -- snapshot (team_members.skill_level for the registrant)
  unit_fee              numeric(10,2) NOT NULL
    CONSTRAINT payment_line_items_unit_fee_non_negative CHECK (unit_fee >= 0.00),  -- GST-inclusive
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_payment_line_items_party UNIQUE (payment_id, party_position),
  CONSTRAINT payment_line_items_guest_link CHECK ((party_position = 0) = (registration_guest_id IS NULL)),
  CONSTRAINT payment_line_items_basis_matches CHECK (
       (pricing_structure = 'FLAT' AND applied_basis = 'FLAT')
    OR (pricing_structure = 'BY_SEX' AND ((party_sex = 'MALE' AND applied_basis = 'SEX_MALE')
                                          OR (party_sex = 'FEMALE' AND applied_basis = 'SEX_FEMALE')
                                          OR (party_sex = 'OTHER' AND applied_basis = 'SEX_OTHER')))
    OR (pricing_structure = 'BY_SKILL_LEVEL' AND ((party_skill_level = 'BEGINNER' AND applied_basis = 'SKILL_BEGINNER')
                                                  OR (party_skill_level = 'INTERMEDIATE' AND applied_basis = 'SKILL_INTERMEDIATE')
                                                  OR (party_skill_level = 'ADVANCED' AND applied_basis = 'SKILL_ADVANCED')))
  )
);
CREATE INDEX idx_payment_line_items_payment ON payment_line_items (payment_id);

-- amount = sum(unit_fee); a registrant line exists; header and lines agree on the pricing structure;
-- guest lines belong to the payment's registration at the same position. Checked at COMMIT.
CREATE FUNCTION check_payment_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payments%ROWTYPE; line_sum numeric; n_lines integer; bad integer; p_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN p_id := NEW.id; ELSE p_id := NEW.payment_id; END IF;
  SELECT * INTO p FROM payments WHERE id = p_id;
  IF NOT FOUND OR p.registration_id IS NULL THEN RETURN NULL; END IF;   -- subscription rows: no lines
  SELECT coalesce(sum(unit_fee), 0), count(*) INTO line_sum, n_lines
    FROM payment_line_items WHERE payment_id = p_id;
  SELECT count(*) INTO bad FROM payment_line_items li
    LEFT JOIN registration_guests g ON g.id = li.registration_guest_id
   WHERE li.payment_id = p_id
     AND (li.pricing_structure <> p.pricing_structure
          OR (li.party_position > 0
              AND (g.registration_id IS DISTINCT FROM p.registration_id OR g.position <> li.party_position)));
  IF n_lines = 0 OR line_sum <> p.amount OR bad > 0
     OR NOT EXISTS (SELECT 1 FROM payment_line_items WHERE payment_id = p_id AND party_position = 0) THEN
    RAISE EXCEPTION 'payment %: amount % vs % line(s) summing % (% inconsistent)', p_id, p.amount, n_lines, line_sum, bad
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_lines_match_header';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payment_lines_match_header_p AFTER INSERT ON payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_payment_lines();
CREATE CONSTRAINT TRIGGER payment_lines_match_header_l AFTER INSERT ON payment_line_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_payment_lines();

-- Immutability (7-year records): snapshot columns never change; the invoice number is set once.
CREATE FUNCTION payments_guard_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER payments_guard_immutable BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_guard_immutable();

CREATE FUNCTION reject_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER payment_line_items_append_only BEFORE UPDATE OR DELETE ON payment_line_items
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- Per-team gapless invoice counter (algorithm Q9, 9A).
CREATE TABLE team_invoice_counters (
  team_id     uuid PRIMARY KEY REFERENCES teams (id) ON DELETE RESTRICT,
  last_number integer NOT NULL CONSTRAINT team_invoice_counters_last_number_positive CHECK (last_number >= 1),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Call ONLY inside the transaction that issues the invoice, as its last statement. Gapless because
-- the counter bump rolls back with that transaction. Keyed by PAYMENT: the team is derived here,
-- never passed by the caller. Lock order is always payment row -> team counter row (no deadlock).
CREATE FUNCTION assign_invoice_number(p_payment_id uuid) RETURNS integer
  LANGUAGE plpgsql VOLATILE STRICT AS $$
DECLARE v_team uuid; v_existing integer; v_n integer; v_rows integer;
BEGIN
  SELECT team_id, invoice_number INTO v_team, v_existing
    FROM payments WHERE id = p_payment_id
     FOR UPDATE;                                     -- serialises issuers of the same payment
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment % not found', p_payment_id USING ERRCODE = 'no_data_found';   -- P0002
  END IF;
  IF v_existing IS NOT NULL THEN                     -- the losing racer lands here after the winner commits
    RAISE EXCEPTION 'payment % already has invoice number %', p_payment_id, v_existing
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'payments_invoice_number_set_once';
  END IF;
  INSERT INTO team_invoice_counters AS c (team_id, last_number) VALUES (v_team, 1)
  ON CONFLICT (team_id) DO UPDATE SET last_number = c.last_number + 1, updated_at = now()
  RETURNING c.last_number INTO v_n;                  -- team counter row locked until COMMIT/ROLLBACK
  UPDATE payments
     SET invoice_number = v_n, invoice_issued_at = now(), is_tax_invoice_issued = true
   WHERE id = p_payment_id AND invoice_number IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN                                -- defensive: raising aborts the txn, so the bump rolls back
    RAISE EXCEPTION 'payment %: expected 1 row updated, got %', p_payment_id, v_rows
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'payments_invoice_number_set_once';
  END IF;
  RETURN v_n;
END $$;

-- Down Migration
DROP FUNCTION assign_invoice_number(uuid);
DROP TABLE team_invoice_counters;
DROP TRIGGER payment_line_items_append_only ON payment_line_items;
DROP FUNCTION reject_modification();
DROP TRIGGER payments_guard_immutable ON payments;
DROP FUNCTION payments_guard_immutable();
DROP TRIGGER payment_lines_match_header_l ON payment_line_items;
DROP TRIGGER payment_lines_match_header_p ON payments;
DROP FUNCTION check_payment_lines();
DROP TABLE payment_line_items;
DROP TABLE payments;
