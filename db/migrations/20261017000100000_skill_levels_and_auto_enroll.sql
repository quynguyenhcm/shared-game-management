-- Up Migration
-- skill-levels-and-auto-enroll: counting baseline, override and Auto Enroll invariants, two partial indexes
-- (D-55..D-61). Decision records: memory-bank/creative/skill-levels-and-auto-enroll-progression-algorithm.md
-- (baseline semantics, counting window) and -seams-architecture.md (invariants, indexes), as amended by the
-- task file's "Binding Reconciliation".
-- No backfill beyond the one below: nothing wrote the override or Auto Enroll columns before this feature, so
-- the only rows are tests or dev seeds. The pre-flight raises a clear error instead of a bare 23514 when a
-- dev database holds rows that would break a rule below; `pnpm db:reset` fixes it.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM team_members WHERE is_auto_enroll AND status <> 'APPROVED') THEN
    RAISE EXCEPTION 'skill_levels_and_auto_enroll: team_members has Auto Enroll set on a row that is not APPROVED; clear is_auto_enroll, auto_enroll_until and auto_enroll_assigned_at on those rows first';
  END IF;
  IF EXISTS (SELECT 1 FROM team_members
              WHERE NOT is_auto_enroll
                AND (auto_enroll_until IS NOT NULL OR auto_enroll_assigned_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'skill_levels_and_auto_enroll: team_members has auto_enroll_until or auto_enroll_assigned_at set while is_auto_enroll is false; clear them first';
  END IF;
  IF EXISTS (SELECT 1 FROM team_members
              WHERE (skill_level_override_by IS NULL) <> (skill_level_override_at IS NULL)) THEN
    RAISE EXCEPTION 'skill_levels_and_auto_enroll: team_members has skill_level_override_by without skill_level_override_at (or the reverse); fix or clear both first';
  END IF;
END $$;

-- D-55: the counting baseline. The UTC instant of the last committed write that changed skill_level to a
-- different value (admin override or automatic progression); NULL = never changed since joining.
ALTER TABLE team_members ADD COLUMN skill_level_changed_at timestamptz;

-- Rows that already carry an override stamp get the baseline from it (an override writes both from one instant).
UPDATE team_members SET skill_level_changed_at = skill_level_override_at
 WHERE skill_level_override_at IS NOT NULL;

-- D-56 / D-57: the override stamps travel together, and the baseline is never earlier than the override that
-- set it (and exists whenever an override does, so provenance is always derivable).
ALTER TABLE team_members
  ADD CONSTRAINT team_members_override_stamps_paired
    CHECK ((skill_level_override_by IS NULL) = (skill_level_override_at IS NULL)),
  ADD CONSTRAINT team_members_changed_after_override
    CHECK (skill_level_override_at IS NULL
           OR (skill_level_changed_at IS NOT NULL AND skill_level_changed_at >= skill_level_override_at));

-- D-58 / D-59: Auto Enroll fields are cleared when it is off, and it exists only on APPROVED rows. The existing
-- team_members_auto_enroll_assigned CHECK (D-05) still covers "on without an assignment time".
ALTER TABLE team_members
  ADD CONSTRAINT team_members_auto_enroll_cleared_when_off
    CHECK (is_auto_enroll OR (auto_enroll_until IS NULL AND auto_enroll_assigned_at IS NULL)),
  ADD CONSTRAINT team_members_auto_enroll_approved_only
    CHECK (NOT is_auto_enroll OR status = 'APPROVED');

-- D-60: the qualifying-game count (CONFIRMED registrations of one member in one team, joined to sessions by id).
CREATE INDEX idx_registrations_confirmed_member
  ON registrations (team_id, user_id, session_id) WHERE status = 'CONFIRMED';

-- D-61: the auto-enrol selection (predicate and order without a sort). The draft index of the same stem,
-- idx_team_members_auto_enroll (team_id, is_auto_enroll, auto_enroll_until), is kept.
CREATE INDEX idx_team_members_auto_enroll_order
  ON team_members (team_id, auto_enroll_assigned_at, id) WHERE is_auto_enroll;

-- Down Migration
DROP INDEX idx_team_members_auto_enroll_order;
DROP INDEX idx_registrations_confirmed_member;
ALTER TABLE team_members
  DROP CONSTRAINT team_members_auto_enroll_approved_only,
  DROP CONSTRAINT team_members_auto_enroll_cleared_when_off,
  DROP CONSTRAINT team_members_changed_after_override,
  DROP CONSTRAINT team_members_override_stamps_paired,
  DROP COLUMN skill_level_changed_at;
