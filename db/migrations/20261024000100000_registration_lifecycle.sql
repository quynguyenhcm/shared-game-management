-- Up Migration
-- registration-and-waitlist Phase 1 (AC-VERIFY-2, AC-VERIFY-11 schema half, AC-VERIFY-12). Ledger rows D-62..D-69 in
-- db/schema-deviations.md. Nothing here is wired to an allocator yet: the database upholds the lifecycle invariants.

-- D-62: the two new enums.
CREATE TYPE withdrawal_kind AS ENUM ('EARLY', 'LATE', 'BANNED');
CREATE TYPE registration_source AS ENUM ('MEMBER', 'AUTO_ENROL');

-- D-62: lifecycle columns. `withdrawal_fee_due` means "a late-withdrawal fee is currently owed" (R2).
ALTER TABLE registrations
  ADD COLUMN promoted_at            timestamptz,
  ADD COLUMN withdrawn_at           timestamptz,
  ADD COLUMN withdrawal_kind        withdrawal_kind,
  ADD COLUMN withdrawal_fee_due     boolean NOT NULL DEFAULT false,
  ADD COLUMN source                 registration_source NOT NULL DEFAULT 'MEMBER',
  ADD COLUMN registrant_skill_level skill_tier,
  ADD COLUMN registrant_sex         user_sex;

-- Backfill before the CHECKs (only test and dev rows can exist: no registration code has shipped).
UPDATE registrations SET withdrawn_at = updated_at, withdrawal_kind = 'EARLY' WHERE status = 'WITHDRAWN';
UPDATE registrations r
   SET registrant_sex = u.sex,
       registrant_skill_level = coalesce(
         (SELECT tm.skill_level FROM team_members tm WHERE tm.team_id = r.team_id AND tm.user_id = r.user_id),
         'BEGINNER')
  FROM users u
 WHERE u.id = r.user_id AND r.status = 'CONFIRMED';

-- D-63: stamps iff WITHDRAWN; a fee is owed only after a LATE withdrawal; WAITLISTED was never promoted; the R15
-- pricing snapshot exists for every row billing may read (CONFIRMED, or a withdrawal whose fee is still owed).
ALTER TABLE registrations
  ADD CONSTRAINT registrations_withdrawal_stamps CHECK (
        (status = 'WITHDRAWN') = (withdrawn_at IS NOT NULL)
    AND (status = 'WITHDRAWN') = (withdrawal_kind IS NOT NULL)),
  ADD CONSTRAINT registrations_fee_due_only_late CHECK (
        NOT withdrawal_fee_due OR (status = 'WITHDRAWN' AND withdrawal_kind = 'LATE')),
  ADD CONSTRAINT registrations_promoted_at_not_waitlisted CHECK (
        status <> 'WAITLISTED' OR promoted_at IS NULL),
  ADD CONSTRAINT registrations_registrant_snapshot CHECK (
        NOT (status = 'CONFIRMED' OR withdrawal_fee_due)
        OR (registrant_skill_level IS NOT NULL AND registrant_sex IS NOT NULL));

-- D-64: the transition guard (BEFORE UPDATE, SQLSTATE 23000, one constraint name per rule). INSERT is constrained
-- only by the CHECKs above, so fixtures can insert any valid state.
CREATE FUNCTION registrations_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.team_id IS DISTINCT FROM OLD.team_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'registrations.session_id, team_id and user_id are immutable'
      USING ERRCODE = '23000', CONSTRAINT = 'registrations_keys_immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'WAITLISTED' AND NEW.status = 'CONFIRMED')
      OR (OLD.status IN ('CONFIRMED', 'WAITLISTED') AND NEW.status = 'WITHDRAWN')
      OR (OLD.status = 'WITHDRAWN' AND NEW.status IN ('CONFIRMED', 'WAITLISTED'))) THEN
    RAISE EXCEPTION 'registrations: % -> % is not an allowed transition', OLD.status, NEW.status
      USING ERRCODE = '23000', CONSTRAINT = 'registrations_status_transition';
  END IF;
  IF OLD.status = 'WAITLISTED' AND NEW.status = 'WAITLISTED'
     AND NEW.queue_position IS DISTINCT FROM OLD.queue_position THEN
    RAISE EXCEPTION 'registrations %: a waitlisted row keeps its queue position', OLD.id
      USING ERRCODE = '23000', CONSTRAINT = 'registrations_queue_position_stable';
  END IF;
  IF NEW.guest_count IS DISTINCT FROM OLD.guest_count
     AND NOT (OLD.status = 'WITHDRAWN' AND NEW.status IN ('CONFIRMED', 'WAITLISTED')) THEN
    RAISE EXCEPTION 'registrations %: guest_count changes only when a withdrawn row is re-activated', OLD.id
      USING ERRCODE = '23000', CONSTRAINT = 'registrations_guest_count_frozen';
  END IF;
  IF (OLD.status = 'WAITLISTED' AND NEW.status = 'CONFIRMED' AND NEW.promoted_at IS NULL)
     OR (OLD.status = 'WITHDRAWN' AND NEW.status = 'CONFIRMED' AND NEW.promoted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'registrations %: a promotion sets promoted_at, a re-take leaves it NULL', OLD.id
      USING ERRCODE = '23000', CONSTRAINT = 'registrations_promotion_stamp';
  END IF;
  -- R2: "currently owed" only ever goes true -> false, except in the UPDATE that withdraws the row.
  IF NEW.withdrawal_fee_due AND NOT OLD.withdrawal_fee_due
     AND NOT (OLD.status <> 'WITHDRAWN' AND NEW.status = 'WITHDRAWN') THEN
    RAISE EXCEPTION 'registrations %: withdrawal_fee_due can only be released, never raised again', OLD.id
      USING ERRCODE = '23000', CONSTRAINT = 'registrations_fee_due_one_way';
  END IF;
  -- R15: the pricing snapshot is rewritten only when the row becomes CONFIRMED (a re-take included).
  IF (NEW.registrant_skill_level IS DISTINCT FROM OLD.registrant_skill_level
      OR NEW.registrant_sex IS DISTINCT FROM OLD.registrant_sex)
     AND NOT (OLD.status <> 'CONFIRMED' AND NEW.status = 'CONFIRMED') THEN
    RAISE EXCEPTION 'registrations %: the pricing snapshot changes only on a transition into CONFIRMED', OLD.id
      USING ERRCODE = '23000', CONSTRAINT = 'registrations_snapshot_immutable';
  END IF;
  -- R17: `source` is set when the row is created or re-activated, never while it keeps its state.
  IF NEW.source IS DISTINCT FROM OLD.source
     AND NOT (OLD.status = 'WITHDRAWN' AND NEW.status IN ('CONFIRMED', 'WAITLISTED')) THEN
    RAISE EXCEPTION 'registrations %: source is set on creation or re-activation only', OLD.id
      USING ERRCODE = '23000', CONSTRAINT = 'registrations_source_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER registrations_guard_update
  BEFORE UPDATE ON registrations
  FOR EACH ROW EXECUTE FUNCTION registrations_guard_update();

-- D-65: capacity backstop, checked at COMMIT and only for writes that make a row CONFIRMED, so an admin capacity cut or
-- a withdrawal is never blocked. It takes the session row FOR UPDATE NOWAIT (R4): an allocator path already holds that
-- lock, so this succeeds at once; a writer that skipped the allocator and finds it held fails 55P03 immediately instead
-- of forming a registrations -> game_sessions wait cycle. One trigger serves INSERT and UPDATE (the WHEN reads only NEW).
CREATE FUNCTION registrations_enforce_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cap integer; taken integer;
BEGIN
  SELECT max_players - reserved_seats INTO cap FROM game_sessions WHERE id = NEW.session_id FOR UPDATE NOWAIT;
  IF NOT FOUND THEN
    RETURN NULL;                                                    -- session deleted in the same transaction
  END IF;
  SELECT coalesce(sum(1 + guest_count), 0) INTO taken
    FROM registrations WHERE session_id = NEW.session_id AND status = 'CONFIRMED';
  IF taken > cap THEN
    RAISE EXCEPTION 'session %: % confirmed seats exceed public capacity %', NEW.session_id, taken, cap
      USING ERRCODE = 'check_violation', CONSTRAINT = 'registrations_within_capacity';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER registrations_within_capacity
  AFTER INSERT OR UPDATE OF status, guest_count ON registrations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.status = 'CONFIRMED')
  EXECUTE FUNCTION registrations_enforce_capacity();

-- D-66: one member's active registrations in a team (ban handler, reconciliation sweep).
CREATE INDEX idx_registrations_active_member ON registrations (team_id, user_id, session_id)
  WHERE status IN ('CONFIRMED', 'WAITLISTED');

-- D-67 (R2): the owed late fees of a session, oldest first (the release read under the session lock; the widened D-85
-- predicate).
CREATE INDEX idx_registrations_fee_due ON registrations (session_id, withdrawn_at) WHERE withdrawal_fee_due;

-- D-68 (R20, ADR 0019 section 8, BIND T-17): SSE's D-85 predicate also counts a late withdrawal whose fee is still owed.
-- CREATE OR REPLACE: SSE's trigger game_sessions_fee_raise_locked depends on the function, which this feature never drops.
CREATE OR REPLACE FUNCTION game_session_has_active_registrations(p_session_id uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM registrations r
                  WHERE r.session_id = p_session_id
                    AND (r.status IN ('CONFIRMED', 'WAITLISTED') OR (r.status = 'WITHDRAWN' AND r.withdrawal_fee_due))) $$;

-- Down Migration
-- Restores SSE's original body (never drops the function: game_sessions_fee_raise_locked depends on it).
CREATE OR REPLACE FUNCTION game_session_has_active_registrations(p_session_id uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM registrations r
                  WHERE r.session_id = p_session_id AND r.status IN ('CONFIRMED', 'WAITLISTED')) $$;
DROP INDEX idx_registrations_fee_due;
DROP INDEX idx_registrations_active_member;
DROP TRIGGER registrations_within_capacity ON registrations;
DROP FUNCTION registrations_enforce_capacity();
DROP TRIGGER registrations_guard_update ON registrations;
DROP FUNCTION registrations_guard_update();
ALTER TABLE registrations
  DROP CONSTRAINT registrations_registrant_snapshot,
  DROP CONSTRAINT registrations_promoted_at_not_waitlisted,
  DROP CONSTRAINT registrations_fee_due_only_late,
  DROP CONSTRAINT registrations_withdrawal_stamps,
  DROP COLUMN registrant_sex,
  DROP COLUMN registrant_skill_level,
  DROP COLUMN source,
  DROP COLUMN withdrawal_fee_due,
  DROP COLUMN withdrawal_kind,
  DROP COLUMN withdrawn_at,
  DROP COLUMN promoted_at;
DROP TYPE registration_source;
DROP TYPE withdrawal_kind;
