-- Up Migration
-- Offset of Pacific/Auckland at an instant, independent of the session TimeZone GUC.
CREATE FUNCTION nz_utc_offset(ts timestamptz) RETURNS interval
  LANGUAGE sql STABLE STRICT PARALLEL SAFE
  AS $$ SELECT (ts AT TIME ZONE 'Pacific/Auckland') - (ts AT TIME ZONE 'UTC') $$;

-- SQL port of the TS offset-probe algorithm (@sgm/shared time, algorithm doc Q7). It never relies on
-- PostgreSQL's implicit gap/overlap rule (PG picks the LATER instant for an overlap; 'compatible'
-- picks the EARLIER one). Uses '24 hours' (absolute), never '1 day' (DST-aware in the session zone).
-- disambiguation: compatible | earlier | later | reject ('reject' raises 22007).
CREATE FUNCTION nz_local_to_utc(local_date date, local_time time, disambiguation text)
  RETURNS timestamptz LANGUAGE plpgsql STABLE STRICT PARALLEL SAFE AS $$
DECLARE
  l          timestamptz := (local_date + local_time) AT TIME ZONE 'UTC';  -- wall clock read as UTC ('24:00' -> next day)
  off_before interval    := nz_utc_offset(l - interval '24 hours');
  off_after  interval    := nz_utc_offset(l + interval '24 hours');
  c_before   timestamptz := l - off_before;
  c_after    timestamptz := l - off_after;
  ok_before  boolean     := nz_utc_offset(c_before) = off_before;
  ok_after   boolean     := nz_utc_offset(c_after) = off_after;
BEGIN
  IF disambiguation NOT IN ('compatible', 'earlier', 'later', 'reject') THEN
    RAISE EXCEPTION 'invalid disambiguation %', disambiguation USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF ok_before AND ok_after AND c_before <> c_after THEN            -- ambiguous (overlap)
    IF disambiguation = 'reject' THEN
      RAISE EXCEPTION 'ambiguous local time % % in Pacific/Auckland', local_date, local_time
        USING ERRCODE = 'invalid_datetime_format';
    END IF;
    RETURN CASE WHEN disambiguation = 'later' THEN greatest(c_before, c_after)
                ELSE least(c_before, c_after) END;                   -- compatible | earlier
  ELSIF ok_before THEN
    RETURN c_before;
  ELSIF ok_after THEN
    RETURN c_after;
  END IF;
  -- nonexistent (gap)
  IF disambiguation = 'reject' THEN
    RAISE EXCEPTION 'nonexistent local time % % in Pacific/Auckland', local_date, local_time
      USING ERRCODE = 'invalid_datetime_format';
  END IF;
  RETURN CASE WHEN disambiguation = 'earlier' THEN c_after ELSE c_before END;  -- compatible | later = shift forward
END $$;

CREATE TABLE game_sessions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id                    uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,  -- NOT NULL: ownership chain
  recurring_rule_id          uuid REFERENCES recurring_session_rules (id) ON DELETE SET NULL,
  is_instance_overridden     boolean NOT NULL DEFAULT false,
  location                   varchar(255) NOT NULL,
  address                    text NOT NULL,
  date                       date NOT NULL,
  cancellation_deadline      timestamptz NOT NULL,
  max_players                integer NOT NULL,
  reserved_seats             integer NOT NULL DEFAULT 0,
  total_court_cost           numeric(10,2) DEFAULT 0.00,
  extra_expenses             numeric(10,2) DEFAULT 0.00,
  calculated_rate_per_player numeric(10,2),
  custom_player_rate         numeric(10,2),
  pricing_structure          pricing_type NOT NULL DEFAULT 'FLAT',
  fee_flat                   numeric(10,2),
  fee_male                   numeric(10,2),
  fee_female                 numeric(10,2),
  -- BY_SEX rate for sex OTHER; default LEAST(fee_male, fee_female) set by session-scheduling-engine.
  fee_other                  numeric(10,2),
  fee_beginner               numeric(10,2),
  fee_intermediate           numeric(10,2),
  fee_advanced               numeric(10,2),
  status                     session_status NOT NULL DEFAULT 'DRAFT',
  -- DB-maintained by game_sessions_derive_instants (app writes are overwritten).
  starts_at                  timestamptz,
  ends_at                    timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_game_sessions_id_team UNIQUE (id, team_id),     -- target of registrations' composite FK
  CONSTRAINT game_sessions_instants_when_live
    CHECK (status IN ('DRAFT', 'CANCELLED') OR (starts_at IS NOT NULL AND ends_at IS NOT NULL)),
  CONSTRAINT game_sessions_deadline_before_start
    CHECK (starts_at IS NULL OR cancellation_deadline <= starts_at),
  CONSTRAINT game_sessions_max_players_positive CHECK (max_players > 0),
  CONSTRAINT game_sessions_reserved_seats_range CHECK (reserved_seats BETWEEN 0 AND max_players),
  CONSTRAINT game_sessions_by_sex_fees_present
    CHECK (pricing_structure <> 'BY_SEX'
           OR (fee_male IS NOT NULL AND fee_female IS NOT NULL AND fee_other IS NOT NULL))
);

CREATE TABLE session_courts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid NOT NULL REFERENCES game_sessions (id) ON DELETE CASCADE,
  court_identifier varchar(50) NOT NULL,
  start_time       time NOT NULL,
  end_time         time NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- No midnight crossing; '24:00' means a midnight end.
  CONSTRAINT session_courts_time_order CHECK (start_time < time '24:00' AND end_time > start_time)
);

CREATE FUNCTION game_sessions_derive_instants() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT nz_local_to_utc(NEW.date, min(sc.start_time), 'compatible'),
         nz_local_to_utc(NEW.date, max(sc.end_time), 'compatible')
    INTO NEW.starts_at, NEW.ends_at
    FROM session_courts sc WHERE sc.session_id = NEW.id;           -- no courts -> NULL, NULL (STRICT)
  RETURN NEW;
END $$;
CREATE TRIGGER game_sessions_derive_instants
  BEFORE INSERT OR UPDATE ON game_sessions
  FOR EACH ROW EXECUTE FUNCTION game_sessions_derive_instants();

-- Any court change touches its session(s); the BEFORE UPDATE trigger above then recomputes.
CREATE FUNCTION session_courts_touch_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE game_sessions SET ends_at = NULL WHERE id = OLD.session_id;
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.session_id IS DISTINCT FROM OLD.session_id) THEN
    UPDATE game_sessions SET ends_at = NULL WHERE id = NEW.session_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER session_courts_touch_session
  AFTER INSERT OR UPDATE OR DELETE ON session_courts
  FOR EACH ROW EXECUTE FUNCTION session_courts_touch_session();

-- Billing sweep (architecture Q4, T3): WHERE status = 'PUBLISHED' AND ends_at <= now().
CREATE INDEX idx_game_sessions_billing_due ON game_sessions (ends_at) WHERE status = 'PUBLISHED';
-- Idempotent recurrence materialisation (AC-VERIFY-12). One-off sessions (NULL rule) are unconstrained.
CREATE UNIQUE INDEX uq_game_sessions_rule_date ON game_sessions (recurring_rule_id, date)
  WHERE recurring_rule_id IS NOT NULL;

-- Down Migration
DROP INDEX uq_game_sessions_rule_date;
DROP INDEX idx_game_sessions_billing_due;
DROP TRIGGER session_courts_touch_session ON session_courts;
DROP FUNCTION session_courts_touch_session();
DROP TRIGGER game_sessions_derive_instants ON game_sessions;
DROP FUNCTION game_sessions_derive_instants();
DROP TABLE session_courts;
DROP TABLE game_sessions;
DROP FUNCTION nz_local_to_utc(date, time, text);
DROP FUNCTION nz_utc_offset(timestamptz);
