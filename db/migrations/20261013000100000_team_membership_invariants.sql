-- Up Migration
-- team-management: membership invariants (D-40..D-46). Decision record:
-- memory-bank/creative/team-management-membership-architecture.md (section 1) and the task file's
-- "Creative Reconciliation" (create idempotency, AC-ERROR-15).
-- No backfill: no team code existed before this feature, so the only rows are tests or dev seeds. A dev
-- database holding rows that break a rule below fails this migration loudly; `pnpm db:reset` fixes it.

-- D-40: an admin is always an approved member (AC-ERROR-6: banning an admin fails with 23514).
ALTER TABLE team_members
  ADD CONSTRAINT team_members_admin_approved CHECK (role <> 'TEAM_ADMIN' OR status = 'APPROVED');

-- D-41: stamp columns match the status. A BANNED row was APPROVED first, so it keeps approved_*.
ALTER TABLE team_members
  ADD CONSTRAINT team_members_approval_stamps CHECK (
        (status IN ('APPROVED', 'BANNED')) = (approved_at IS NOT NULL)
    AND (status IN ('APPROVED', 'BANNED')) = (approved_by IS NOT NULL)),
  ADD CONSTRAINT team_members_ban_stamps CHECK (
        (status = 'BANNED') = (banned_at IS NOT NULL)
    AND (status = 'BANNED') = (banned_by IS NOT NULL)
    AND (status = 'BANNED' OR ban_reason IS NULL)),
  ADD CONSTRAINT team_members_ban_reason_length CHECK (
    ban_reason IS NULL OR (char_length(ban_reason) BETWEEN 1 AND 500 AND ban_reason = btrim(ban_reason)));

-- D-42: allowed status moves (BANNED is terminal in v1) and immutable ownership keys.
CREATE FUNCTION team_members_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'team_members.team_id and user_id are immutable'
      USING ERRCODE = '23000', CONSTRAINT = 'team_members_keys_immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'PENDING'  AND NEW.status IN ('APPROVED', 'REJECTED'))
      OR (OLD.status = 'REJECTED' AND NEW.status = 'PENDING')
      OR (OLD.status = 'APPROVED' AND NEW.status = 'BANNED')) THEN
    RAISE EXCEPTION 'team_members: % -> % is not an allowed transition', OLD.status, NEW.status
      USING ERRCODE = '23000', CONSTRAINT = 'team_members_status_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER team_members_guard_update
  BEFORE UPDATE OF status, team_id, user_id ON team_members
  FOR EACH ROW EXECUTE FUNCTION team_members_guard_update();

-- D-43: a team keeps at least one approved admin, checked at COMMIT. Locks the team row
-- FOR NO KEY UPDATE (serialises concurrent demotes without blocking FK inserts) and is skipped
-- when the team row is gone (ON DELETE CASCADE). Same pattern as auth_identities_last_method (D-33).
CREATE FUNCTION team_members_enforce_last_admin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM teams WHERE id = OLD.team_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM team_members
                 WHERE team_id = OLD.team_id AND role = 'TEAM_ADMIN' AND status = 'APPROVED') THEN
    RAISE EXCEPTION 'team % must keep at least one approved admin', OLD.team_id
      USING ERRCODE = '23514', CONSTRAINT = 'team_members_last_admin';
  END IF;
  RETURN NULL;
END $$;
-- Two triggers: a DELETE trigger's WHEN may not reference NEW.
CREATE CONSTRAINT TRIGGER team_members_last_admin_on_update
  AFTER UPDATE OF role, status ON team_members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.role = 'TEAM_ADMIN' AND OLD.status = 'APPROVED'
        AND NOT (NEW.role = 'TEAM_ADMIN' AND NEW.status = 'APPROVED'))
  EXECUTE FUNCTION team_members_enforce_last_admin();
CREATE CONSTRAINT TRIGGER team_members_last_admin_on_delete
  AFTER DELETE ON team_members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.role = 'TEAM_ADMIN' AND OLD.status = 'APPROVED')
  EXECUTE FUNCTION team_members_enforce_last_admin();

-- D-44: team content and invite-code format (43-char base64url codes; factory codes also match).
ALTER TABLE teams
  ADD CONSTRAINT teams_name_trimmed_length CHECK (char_length(name) BETWEEN 1 AND 100 AND name = btrim(name)),
  ADD CONSTRAINT teams_description_length CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 1000),
  ADD CONSTRAINT teams_invite_code_format CHECK (invite_code ~ '^[A-Za-z0-9_-]{32,100}$');

-- D-45: Find a team (ordering + keyset) and the admin member lists.
CREATE INDEX idx_teams_public_name ON teams (lower(name), id) WHERE visibility = 'PUBLIC';
CREATE INDEX idx_team_members_team_status_role ON team_members (team_id, status, role);

-- D-46: create idempotency (AC-ERROR-15). The create form sends a UUID v4 per render; a replay of the same
-- (creator, key) finds the team that already exists. A plain UNIQUE constraint (not a partial index) so that
-- INSERT ... ON CONFLICT (created_by, create_idempotency_key) can infer it; NULLs never conflict.
ALTER TABLE teams
  ADD COLUMN create_idempotency_key uuid,
  ADD CONSTRAINT uq_teams_created_by_idempotency_key UNIQUE (created_by, create_idempotency_key);

-- Down Migration
ALTER TABLE teams
  DROP CONSTRAINT uq_teams_created_by_idempotency_key,
  DROP COLUMN create_idempotency_key;
DROP INDEX idx_team_members_team_status_role;
DROP INDEX idx_teams_public_name;
ALTER TABLE teams
  DROP CONSTRAINT teams_invite_code_format,
  DROP CONSTRAINT teams_description_length,
  DROP CONSTRAINT teams_name_trimmed_length;
DROP TRIGGER team_members_last_admin_on_delete ON team_members;
DROP TRIGGER team_members_last_admin_on_update ON team_members;
DROP FUNCTION team_members_enforce_last_admin();
DROP TRIGGER team_members_guard_update ON team_members;
DROP FUNCTION team_members_guard_update();
ALTER TABLE team_members
  DROP CONSTRAINT team_members_ban_reason_length,
  DROP CONSTRAINT team_members_ban_stamps,
  DROP CONSTRAINT team_members_approval_stamps,
  DROP CONSTRAINT team_members_admin_approved;
