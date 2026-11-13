-- Up Migration
-- tax-invoices-and-exports, Phase 1 (ADR 0021; ledger D-99..D-105; creative amendments CR-1, CR-2).
-- One SQL issuer (`issue_payment_document`) turns a PAID payment above $0.00 into an immutable `payment_documents`
-- snapshot with a number from a per-team, per-kind gapless series (INV- tax invoices, RCT- receipts).

-- D-99: the document kind. A future CREDIT_NOTE is one ALTER TYPE ... ADD VALUE away (H5 extension point, not built).
CREATE TYPE payment_document_kind AS ENUM ('TAX_INVOICE', 'RECEIPT');

-- D-100: the kind follows the payment's immutable charge-time `gst_registered`, so it can never disagree with the GST lines.
CREATE FUNCTION payment_document_kind_of(p_gst_registered boolean) RETURNS payment_document_kind
  LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE WHEN p_gst_registered THEN 'TAX_INVOICE'::payment_document_kind ELSE 'RECEIPT'::payment_document_kind END
$$;

-- SQL twin of packages/shared/src/invoice/document.ts `formatDocumentNumber` (INV-000123, RCT-000123; wider than six digits
-- is printed in full, never truncated).
CREATE FUNCTION format_document_number(p_kind payment_document_kind, p_number integer) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT (CASE p_kind WHEN 'TAX_INVOICE' THEN 'INV-' ELSE 'RCT-' END)
         || repeat('0', greatest(6 - length(p_number::text), 0)) || p_number::text
$$;

-- CR-1 preflight. Nothing is cleared and no counter is rewound: a numbered payment that cannot become a document stops
-- the deploy, listing the offending ids. (The first version of this design cleared numbers on unpaid rows; the design
-- critique rejected that, so every numbered row is converted or the migration aborts.)
DO $$
DECLARE v_unpaid text; v_unsnapshottable text;
BEGIN
  SELECT string_agg(id::text, ', ' ORDER BY id) INTO v_unpaid FROM (
    SELECT id FROM payments
     WHERE invoice_number IS NOT NULL AND NOT (status = 'PAID' AND amount > 0.00)
     ORDER BY id LIMIT 20) AS offending;
  IF v_unpaid IS NOT NULL THEN
    RAISE EXCEPTION 'tax_invoices: payments carrying an invoice number that are not PAID above 0.00 (first 20 ids): %. Resolve them by hand before migrating.', v_unpaid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payments_invoice_requires_paid';
  END IF;
  SELECT string_agg(id::text, ', ' ORDER BY id) INTO v_unsnapshottable FROM (
    SELECT p.id FROM payments p
      LEFT JOIN registrations r ON r.id = p.registration_id
      LEFT JOIN game_sessions s ON s.id = r.session_id
     WHERE p.invoice_number IS NOT NULL AND s.starts_at IS NULL
     ORDER BY p.id LIMIT 20) AS offending;
  IF v_unsnapshottable IS NOT NULL THEN
    RAISE EXCEPTION 'tax_invoices: numbered payments with no registration or no session start to snapshot (first 20 ids): %. Resolve them by hand before migrating.', v_unsnapshottable
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_documents_matches_payment';
  END IF;
END $$;

-- D-99: the issue-time snapshot. Holds only what is mutable elsewhere (supplier and buyer names, the game, the charge
-- reason) plus the frozen number and layout version. Amounts, rate, GST number, billing type, paid_at and the lines stay
-- on `payments` / `payment_line_items`, which are immutable already (D-19, D-20, D-88, D-104). Guest names are never copied.
CREATE TABLE payment_documents (
  payment_id         uuid PRIMARY KEY REFERENCES payments (id) ON DELETE RESTRICT,
  document_kind      payment_document_kind NOT NULL,
  number_display     varchar(20) NOT NULL
    CONSTRAINT payment_documents_number_display_format CHECK (number_display ~ '^(INV|RCT)-[0-9]{6,}$'),
  issued_at          timestamptz NOT NULL,
  supplier_name      varchar(100) NOT NULL,
  buyer_name         varchar(255) NOT NULL,
  session_location   varchar(255) NOT NULL,
  session_starts_at  timestamptz NOT NULL,
  charge_reason      varchar(16) NOT NULL
    CONSTRAINT payment_documents_charge_reason_values CHECK (charge_reason IN ('GAME_FEE', 'LATE_WITHDRAWAL')),
  layout_version     smallint NOT NULL DEFAULT 1
    CONSTRAINT payment_documents_layout_version_positive CHECK (layout_version >= 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_documents_prefix_matches_kind
    CHECK ((left(number_display, 3) = 'INV') = (document_kind = 'TAX_INVOICE'))
);

CREATE TRIGGER payment_documents_append_only BEFORE UPDATE OR DELETE ON payment_documents
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- The insert guard ties the snapshot to the payment it documents: it carries a number, the kind follows gst_registered,
-- the printed number is the formatted counter value and the issue time is the payment's.
CREATE FUNCTION payment_documents_guard_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payments%ROWTYPE;
BEGIN
  SELECT * INTO p FROM payments WHERE id = NEW.payment_id;
  IF NOT FOUND OR p.invoice_number IS NULL
     OR NEW.document_kind <> payment_document_kind_of(p.gst_registered)
     OR NEW.number_display <> format_document_number(NEW.document_kind, p.invoice_number)
     OR NEW.issued_at IS DISTINCT FROM p.invoice_issued_at THEN
    RAISE EXCEPTION 'payment_documents: the snapshot for payment % does not match the payment''s number, kind or issue time', NEW.payment_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_documents_matches_payment';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_documents_guard_insert BEFORE INSERT ON payment_documents
  FOR EACH ROW EXECUTE FUNCTION payment_documents_guard_insert();

-- CR-1 conversion: every numbered payment (all PAID above 0.00 after the preflight) gets its snapshot with its existing
-- number, kind and issue time. No number changes. Kinds follow gst_registered (below), so a team that numbered both
-- registered and unregistered payments keeps each number, now inside its own series; a series may therefore start with a
-- hole that the other series filled (recorded in ADR 0021; no document had ever been printed, billing never issued one).
INSERT INTO payment_documents (payment_id, document_kind, number_display, issued_at, supplier_name, buyer_name,
                               session_location, session_starts_at, charge_reason)
SELECT p.id, payment_document_kind_of(p.gst_registered),
       format_document_number(payment_document_kind_of(p.gst_registered), p.invoice_number),
       p.invoice_issued_at, t.name, u.full_name, s.location, s.starts_at,
       CASE WHEN r.status = 'WITHDRAWN' THEN 'LATE_WITHDRAWAL' ELSE 'GAME_FEE' END
  FROM payments p
  JOIN teams t ON t.id = p.team_id
  JOIN users u ON u.id = p.user_id
  JOIN registrations r ON r.id = p.registration_id
  JOIN game_sessions s ON s.id = r.session_id
 WHERE p.invoice_number IS NOT NULL
 ORDER BY p.team_id, p.invoice_number;

-- D-100: one gapless series per team per document kind.
ALTER TABLE team_invoice_counters ADD COLUMN document_kind payment_document_kind NOT NULL DEFAULT 'TAX_INVOICE';
ALTER TABLE team_invoice_counters DROP CONSTRAINT team_invoice_counters_pkey;
ALTER TABLE team_invoice_counters ADD CONSTRAINT team_invoice_counters_pkey PRIMARY KEY (team_id, document_kind);
-- Rebuild each team's counters from the numbers already issued, per kind. A legacy single counter that also covered
-- numbers now in the other kind's series is replaced by the exact per-kind maximum, so the next number never collides.
INSERT INTO team_invoice_counters AS c (team_id, document_kind, last_number)
SELECT p.team_id, payment_document_kind_of(p.gst_registered), max(p.invoice_number)
  FROM payments p WHERE p.invoice_number IS NOT NULL
 GROUP BY p.team_id, payment_document_kind_of(p.gst_registered)
ON CONFLICT (team_id, document_kind) DO UPDATE SET last_number = EXCLUDED.last_number, updated_at = now();
-- A legacy counter row (defaulted to TAX_INVOICE) for a team whose numbers are all receipts-kind describes no tax invoice.
DELETE FROM team_invoice_counters c
 WHERE c.document_kind = 'TAX_INVOICE'
   AND EXISTS (SELECT 1 FROM payments p WHERE p.team_id = c.team_id AND p.invoice_number IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM payments p
                    WHERE p.team_id = c.team_id AND p.invoice_number IS NOT NULL AND p.gst_registered);

-- D-101: `is_tax_invoice_issued` becomes a generated column (it keeps its honest meaning and cannot drift); the old
-- consistency CHECK goes with the old column, and the number / issue-time pair CHECK replaces its second half.
ALTER TABLE payments DROP CONSTRAINT payments_invoice_issued_consistent;
ALTER TABLE payments DROP COLUMN is_tax_invoice_issued;
ALTER TABLE payments ADD COLUMN is_tax_invoice_issued boolean NOT NULL
  GENERATED ALWAYS AS (invoice_number IS NOT NULL AND gst_registered) STORED;
ALTER TABLE payments ADD CONSTRAINT payments_invoice_stamp_pair
  CHECK ((invoice_number IS NULL) = (invoice_issued_at IS NULL)) NOT VALID;
ALTER TABLE payments VALIDATE CONSTRAINT payments_invoice_stamp_pair;

-- D-102: a number only on a PAID payment above $0.00. PAID is terminal (D-87), so this can never become false later.
ALTER TABLE payments ADD CONSTRAINT payments_invoice_requires_paid
  CHECK (invoice_number IS NULL OR (status = 'PAID' AND amount > 0.00)) NOT VALID;
ALTER TABLE payments VALIDATE CONSTRAINT payments_invoice_requires_paid;

-- D-100: uniqueness per series; the discriminator is the immutable `gst_registered` (payment_document_kind_of names the map).
ALTER TABLE payments DROP CONSTRAINT uq_payments_team_invoice_number;
ALTER TABLE payments ADD CONSTRAINT uq_payments_team_series_number UNIQUE (team_id, gst_registered, invoice_number);

-- D-104: `paid_at` is frozen once set. The printed "Paid on" and the export period filter depend on it, and a moved
-- paid_at would shift income between already-filed GST periods. The apply funnel sets it once, from PENDING / OVERDUE.
-- Clearing it is already impossible (payments_paid_at_iff_paid, and PAID is terminal, D-87), so only a move to another
-- non-null value needs refusing here, which also lets the status guard report an illegal transition first.
CREATE OR REPLACE FUNCTION payments_guard_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.user_id, NEW.team_id, NEW.registration_id, NEW.billing_type, NEW.pricing_structure,
      NEW.gst_registered, NEW.gst_rate_bps, NEW.gst_number, NEW.payment_reference, NEW.amount, NEW.created_at)
     IS DISTINCT FROM
     (OLD.user_id, OLD.team_id, OLD.registration_id, OLD.billing_type, OLD.pricing_structure,
      OLD.gst_registered, OLD.gst_rate_bps, OLD.gst_number, OLD.payment_reference, OLD.amount, OLD.created_at)
     OR (OLD.invoice_number IS NOT NULL
         AND (NEW.invoice_number, NEW.invoice_issued_at) IS DISTINCT FROM (OLD.invoice_number, OLD.invoice_issued_at))
     OR (OLD.paid_at IS NOT NULL AND NEW.paid_at IS NOT NULL AND NEW.paid_at <> OLD.paid_at) THEN
    RAISE EXCEPTION 'payment % fee snapshot / invoice number / paid_at is immutable', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

-- D-103: series-aware numbering. Call ONLY from issue_payment_document (the single issuer), inside the transaction that
-- commits the document, as its last allocation. Lock order is payment row (FOR NO KEY UPDATE: no key changes, lighter than
-- FOR UPDATE) then the team counter row of the payment's series. The flag is generated now, so it is no longer written.
CREATE OR REPLACE FUNCTION assign_invoice_number(p_payment_id uuid) RETURNS integer
  LANGUAGE plpgsql VOLATILE STRICT AS $$
DECLARE
  v_team uuid; v_existing integer; v_status payment_status; v_amount numeric; v_gst boolean;
  v_kind payment_document_kind; v_n integer; v_rows integer;
BEGIN
  SELECT team_id, invoice_number, status, amount, gst_registered
    INTO v_team, v_existing, v_status, v_amount, v_gst
    FROM payments WHERE id = p_payment_id
     FOR NO KEY UPDATE;                              -- serialises issuers of the same payment
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment % not found', p_payment_id USING ERRCODE = 'no_data_found';   -- P0002
  END IF;
  IF v_existing IS NOT NULL THEN                     -- the losing racer lands here after the winner commits
    RAISE EXCEPTION 'payment % already has invoice number %', p_payment_id, v_existing
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'payments_invoice_number_set_once';
  END IF;
  IF v_status <> 'PAID' OR v_amount <= 0.00 THEN     -- the same name as the CHECK, so both report one error
    RAISE EXCEPTION 'payment %: an invoice number needs a PAID payment above 0.00', p_payment_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payments_invoice_requires_paid';
  END IF;
  v_kind := payment_document_kind_of(v_gst);
  INSERT INTO team_invoice_counters AS c (team_id, document_kind, last_number) VALUES (v_team, v_kind, 1)
  ON CONFLICT (team_id, document_kind) DO UPDATE SET last_number = c.last_number + 1, updated_at = now()
  RETURNING c.last_number INTO v_n;                  -- series counter row locked until COMMIT/ROLLBACK
  UPDATE payments SET invoice_number = v_n, invoice_issued_at = now()
   WHERE id = p_payment_id AND invoice_number IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN                                -- defensive: raising aborts the txn, so the bump rolls back
    RAISE EXCEPTION 'payment %: expected 1 row updated, got %', p_payment_id, v_rows
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'payments_invoice_number_set_once';
  END IF;
  RETURN v_n;
END $$;

-- D-103: the single issuer. Idempotent: a payment that already has a document returns it with issued = false (the losing
-- racer lands here). The facts are plain reads (no locks); the allocation is the last locking step, then one INSERT.
-- Lock order: payment row, then counter row, then the FK KEY SHARE on teams and payments from the INSERT. `KEY SHARE`
-- conflicts only with `teams FOR UPDATE` (banking removal), which never locks a payment, so no cycle can form.
CREATE FUNCTION issue_payment_document(p_payment_id uuid)
  RETURNS TABLE (number_display text, issued boolean)
  LANGUAGE plpgsql VOLATILE STRICT AS $$
#variable_conflict use_column
DECLARE
  p payments%ROWTYPE; v_existing text; v_supplier text; v_buyer text; v_location text; v_starts timestamptz;
  v_reg_status registration_status; v_n integer; v_kind payment_document_kind;
BEGIN
  SELECT * INTO p FROM payments WHERE id = p_payment_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment % not found', p_payment_id USING ERRCODE = 'no_data_found';   -- P0002
  END IF;
  SELECT d.number_display INTO v_existing FROM payment_documents d WHERE d.payment_id = p_payment_id;
  IF FOUND THEN
    RETURN QUERY SELECT v_existing, false;
    RETURN;
  END IF;
  IF p.status <> 'PAID' OR p.amount <= 0.00 THEN    -- the TS service checks first and answers 409; this is the backstop
    RAISE EXCEPTION 'payment %: only a PAID payment above 0.00 is issued a document', p_payment_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payments_invoice_requires_paid';
  END IF;
  SELECT t.name INTO v_supplier FROM teams t WHERE t.id = p.team_id;
  SELECT u.full_name INTO v_buyer FROM users u WHERE u.id = p.user_id;
  SELECT s.location, s.starts_at, r.status INTO v_location, v_starts, v_reg_status
    FROM registrations r JOIN game_sessions s ON s.id = r.session_id WHERE r.id = p.registration_id;
  IF NOT FOUND OR v_starts IS NULL THEN
    RAISE EXCEPTION 'payment %: no registered game to document', p_payment_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_documents_matches_payment';
  END IF;
  v_n := assign_invoice_number(p_payment_id);        -- the allocation: from here only two cheap statements run
  v_kind := payment_document_kind_of(p.gst_registered);
  INSERT INTO payment_documents (payment_id, document_kind, number_display, issued_at, supplier_name, buyer_name,
                                 session_location, session_starts_at, charge_reason)
  SELECT p_payment_id, v_kind, format_document_number(v_kind, v_n), x.invoice_issued_at, v_supplier, v_buyer,
         v_location, v_starts, CASE WHEN v_reg_status = 'WITHDRAWN' THEN 'LATE_WITHDRAWAL' ELSE 'GAME_FEE' END
    FROM payments x WHERE x.id = p_payment_id;
  RETURN QUERY SELECT format_document_number(v_kind, v_n), true;
END $$;

-- D-103: a numbered payment without its document cannot commit, so allocating without issuing is impossible.
CREATE FUNCTION payment_documents_require_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM payment_documents d WHERE d.payment_id = NEW.id) THEN
    RAISE EXCEPTION 'payment %: a numbered payment must have its payment_documents row', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_documents_required';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payment_documents_required AFTER INSERT OR UPDATE OF invoice_number ON payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.invoice_number IS NOT NULL)
  EXECUTE FUNCTION payment_documents_require_row();

-- D-105: serves the issuance drain and the reconcile sweep (PAID above $0.00, not yet numbered).
CREATE INDEX idx_payments_unissued ON payments (team_id, paid_at, id)
  WHERE status = 'PAID' AND invoice_number IS NULL AND amount > 0.00;

-- Down Migration
-- CR-2: forward-only once used. A document is a 7-year tax record and the per-kind series is its numbering, so the
-- down migration never drops either while any exists. Recovery after first use is a forward remediation migration or an
-- application rollback that is compatible with this schema (ADR 0021). With nothing issued it restores the D-22 shape.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM payment_documents) OR EXISTS (SELECT 1 FROM team_invoice_counters) THEN
    RAISE EXCEPTION 'tax_invoices down: refusing to drop issued payment documents or their numbering (forward-only after first use, ADR 0021)'
      USING ERRCODE = 'object_not_in_prerequisite_state';   -- 55000
  END IF;
END $$;

DROP INDEX idx_payments_unissued;
DROP TRIGGER payment_documents_required ON payments;
DROP FUNCTION payment_documents_require_row();
DROP FUNCTION issue_payment_document(uuid);

-- Back to the platform-foundation numbering (D-22) and the wallet-and-billing guard (D-88, D-89).
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

ALTER TABLE payments DROP CONSTRAINT uq_payments_team_series_number;
ALTER TABLE payments ADD CONSTRAINT uq_payments_team_invoice_number UNIQUE (team_id, invoice_number);
ALTER TABLE payments DROP CONSTRAINT payments_invoice_requires_paid;
ALTER TABLE payments DROP CONSTRAINT payments_invoice_stamp_pair;
ALTER TABLE payments DROP COLUMN is_tax_invoice_issued;
ALTER TABLE payments ADD COLUMN is_tax_invoice_issued boolean NOT NULL DEFAULT false;
ALTER TABLE payments ADD CONSTRAINT payments_invoice_issued_consistent
  CHECK (is_tax_invoice_issued = (invoice_number IS NOT NULL)
         AND (invoice_number IS NULL) = (invoice_issued_at IS NULL));

ALTER TABLE team_invoice_counters DROP CONSTRAINT team_invoice_counters_pkey;
ALTER TABLE team_invoice_counters DROP COLUMN document_kind;
ALTER TABLE team_invoice_counters ADD CONSTRAINT team_invoice_counters_pkey PRIMARY KEY (team_id);

CREATE OR REPLACE FUNCTION assign_invoice_number(p_payment_id uuid) RETURNS integer
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

DROP TRIGGER payment_documents_guard_insert ON payment_documents;
DROP FUNCTION payment_documents_guard_insert();
DROP TRIGGER payment_documents_append_only ON payment_documents;
DROP TABLE payment_documents;
DROP FUNCTION format_document_number(payment_document_kind, integer);
DROP FUNCTION payment_document_kind_of(boolean);
DROP TYPE payment_document_kind;
