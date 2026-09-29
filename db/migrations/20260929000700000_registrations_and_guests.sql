-- Up Migration
CREATE TABLE registrations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid NOT NULL,                                   -- FK below (composite, RESTRICT)
  team_id        uuid NOT NULL,                                   -- = the session's team (ownership chain)
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  guest_count    integer NOT NULL DEFAULT 0
    CONSTRAINT registrations_guest_count_range CHECK (guest_count BETWEEN 0 AND 2),
  status         registration_status NOT NULL,
  queue_position integer
    CONSTRAINT registrations_queue_position_positive CHECK (queue_position IS NULL OR queue_position >= 1),
  registered_at  timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_registrations_session_user UNIQUE (session_id, user_id),
  CONSTRAINT uq_registrations_id_user_team UNIQUE (id, user_id, team_id),  -- target of payments/credit FKs
  CONSTRAINT fk_registrations_session_team FOREIGN KEY (session_id, team_id)
    REFERENCES game_sessions (id, team_id) ON DELETE RESTRICT,
  CONSTRAINT registrations_queue_position_iff_waitlisted
    CHECK ((status = 'WAITLISTED') = (queue_position IS NOT NULL))
);

-- FIFO safety (AC-VERIFY-19). The allocator belongs to registration-and-waitlist and MUST, for every
-- enqueue / withdraw / promote, first run SELECT ... FROM game_sessions WHERE id = $1 FOR UPDATE; then
-- enqueue = coalesce(max(queue_position), 0) + 1 over WAITLISTED rows; promote = lowest queue_position.
-- This index turns any path that skips the lock into a 23505 instead of a duplicate position.
CREATE UNIQUE INDEX uq_registrations_waitlist_position
  ON registrations (session_id, queue_position) WHERE status = 'WAITLISTED';

-- Gap fix (AC-VERIFY-7): each guest's sex and skill, so BY_SEX / BY_SKILL_LEVEL can price guests.
CREATE TABLE registration_guests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id uuid NOT NULL REFERENCES registrations (id) ON DELETE CASCADE,  -- billed guests are RESTRICTed by line items
  position        smallint NOT NULL
    CONSTRAINT registration_guests_position_range CHECK (position BETWEEN 1 AND 2),
  sex             user_sex NOT NULL,
  skill_level     skill_tier NOT NULL,
  display_name    varchar(100),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_registration_guests_position UNIQUE (registration_id, position)
);

-- guest_count = number of guest rows and positions are contiguous (1, or 1 and 2). Checked at COMMIT.
CREATE FUNCTION check_registration_guest_count() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r_id uuid; expected integer; actual integer; max_pos integer;
BEGIN
  -- IF branches, not one CASE: plpgsql resolves every NEW/OLD field in an expression, and
  -- registrations has no registration_id column.
  IF TG_TABLE_NAME = 'registrations' THEN r_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN r_id := OLD.registration_id;
  ELSE r_id := NEW.registration_id;
  END IF;
  SELECT guest_count INTO expected FROM registrations WHERE id = r_id;
  IF NOT FOUND THEN RETURN NULL; END IF;                          -- registration deleted in the same txn
  SELECT count(*), coalesce(max(position), 0) INTO actual, max_pos
    FROM registration_guests WHERE registration_id = r_id;
  IF actual <> expected OR max_pos <> expected THEN
    RAISE EXCEPTION 'registration %: guest_count % but % guest row(s) (max position %)', r_id, expected, actual, max_pos
      USING ERRCODE = 'check_violation', CONSTRAINT = 'registration_guest_count_matches';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER registration_guest_count_matches_r
  AFTER INSERT OR UPDATE OF guest_count ON registrations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_registration_guest_count();
CREATE CONSTRAINT TRIGGER registration_guest_count_matches_g
  AFTER INSERT OR UPDATE OR DELETE ON registration_guests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_registration_guest_count();

-- A guest cannot be moved to another registration.
CREATE FUNCTION registration_guests_keep_registration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.registration_id IS DISTINCT FROM OLD.registration_id THEN
    RAISE EXCEPTION 'registration_guests.registration_id is immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER registration_guests_keep_registration
  BEFORE UPDATE ON registration_guests
  FOR EACH ROW EXECUTE FUNCTION registration_guests_keep_registration();

-- Down Migration
DROP TRIGGER registration_guests_keep_registration ON registration_guests;
DROP FUNCTION registration_guests_keep_registration();
DROP TRIGGER registration_guest_count_matches_g ON registration_guests;
DROP TRIGGER registration_guest_count_matches_r ON registrations;
DROP FUNCTION check_registration_guest_count();
DROP TABLE registration_guests;
DROP INDEX uq_registrations_waitlist_position;
DROP TABLE registrations;
