-- Up Migration
-- session-scheduling-engine: series anchor and court template, optimistic-concurrency stamps, lifecycle and
-- immutability triggers, the default cancellation deadline, the C-SSE-1 CHECKs, content limits, the auto-enrol
-- marker, the banking-email claim and the fee-raise lock (D-70..D-83, D-85; D-84 is reserved). Decision records:
-- memory-bank/creative/session-scheduling-engine-architecture.md (SA-6..SA-8), -recurrence-algorithm.md (A1, A5,
-- conflict 10) and -binding-reconciliation.md (T-7..T-9, T-17, T-18), which wins where they differ.
--
-- Trigger firing order on game_sessions. PostgreSQL fires same-event BEFORE ROW triggers in NAME order, so the
-- names below ARE the order; renaming one changes behaviour (asserted from pg_trigger in sessions-schema.int.test.ts):
--   1. game_sessions_derive_instants        (D-08)  starts_at / ends_at from the courts
--   2. game_sessions_fee_raise_locked       (D-85)  fees can only go down once a player is registered
--   3. game_sessions_fill_default_deadline  (D-74)  cancellation_deadline = starts_at - 48 h while the default holds
--   4. game_sessions_guard_update           (D-75)  matrix, closed-row immutability, immutable keys
--   5. game_sessions_paid_requires_payout   (D-49)  a paid PUBLISHED session needs usable payout details
--   6. game_sessions_version_bump           (D-72)  version + updated_at, last so it sees the final row
-- BEFORE DELETE: game_sessions_guard_delete (D-75). session_courts: session_courts_guard_closed (D-76) fires
-- before the existing session_courts_touch_session (AFTER) so a refused court write never touches the session.
--
-- D-83 cleanup: nothing wrote these tables before this feature, so only tests or dev seeds hold rows. Stage 1
-- reshapes any such row so the CHECKs validate (never fails on old data), stage 2 adds each CHECK NOT VALID and
-- VALIDATEs it. The cleanup is not reversible (data); the schema is.

-- ---------------------------------------------------------------------------------------------------------
-- Stage 1a: new columns (everything the cleanup and the CHECKs below need)
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE recurring_session_rules
  ADD COLUMN starts_on            date,                                      -- D-70 (NOT NULL after backfill)
  ADD COLUMN monthly_week         smallint,                                  -- D-70
  ADD COLUMN version              integer     NOT NULL DEFAULT 1,            -- D-72
  ADD COLUMN updated_at           timestamptz NOT NULL DEFAULT now(),        -- D-72
  ADD COLUMN create_key           uuid,                                      -- D-73
  ADD COLUMN materialised_version integer,                                   -- D-82
  ADD COLUMN materialised_at      timestamptz;                               -- D-82

ALTER TABLE game_sessions
  ADD COLUMN version              integer     NOT NULL DEFAULT 1,            -- D-72
  ADD COLUMN updated_at           timestamptz NOT NULL DEFAULT now(),        -- D-72
  ADD COLUMN create_key           uuid,                                      -- D-73
  ADD COLUMN deadline_is_default  boolean     NOT NULL DEFAULT true,         -- D-74
  ADD COLUMN auto_enrol_required  boolean     NOT NULL DEFAULT true,         -- D-80 (P-1: every session)
  ADD COLUMN auto_enrolled_at     timestamptz;                               -- D-80

-- ---------------------------------------------------------------------------------------------------------
-- Stage 1b: D-83 cleanup of dev/test rows
-- ---------------------------------------------------------------------------------------------------------
-- The existing D-49 payout trigger fires on fee columns; the cleanup below never raises a fee on a row that has no
-- usable payout details on purpose, but the flat-fee repair can, so it is paused for the cleanup only.
ALTER TABLE game_sessions DISABLE TRIGGER game_sessions_paid_requires_payout;

DO $$
DECLARE
  anchored   integer;
  text_fixed integer;
  amounts    integer;
  fees       integer;
  courts     integer;
BEGIN
  -- Anchor: the first date on or after the rule's creation day (NZ) whose weekday is day_of_week (0 = Sunday).
  UPDATE recurring_session_rules r
     SET starts_on = a.d + ((r.day_of_week - extract(dow FROM a.d)::integer + 7) % 7)
    FROM (SELECT id, (created_at AT TIME ZONE 'Pacific/Auckland')::date AS d FROM recurring_session_rules) a
   WHERE a.id = r.id;
  GET DIAGNOSTICS anchored = ROW_COUNT;
  -- Monthly: the ordinal of the anchor, a 5th weekday stored as "last" (-1).
  UPDATE recurring_session_rules
     SET monthly_week = CASE WHEN extract(day FROM starts_on) > 28 THEN -1
                             ELSE ((extract(day FROM starts_on)::integer - 1) / 7) + 1 END
   WHERE frequency = 'MONTHLY';
  UPDATE recurring_session_rules SET recur_until = starts_on WHERE recur_until < starts_on;

  -- Text: trimmed, within the length limits, never empty.
  UPDATE recurring_session_rules
     SET default_location = coalesce(nullif(btrim(left(btrim(default_location), 255)), ''), 'Unspecified'),
         default_address  = coalesce(nullif(btrim(left(btrim(default_address), 500)), ''), 'Unspecified')
   WHERE default_location <> btrim(left(btrim(default_location), 255)) OR btrim(default_location) = ''
      OR default_address  <> btrim(left(btrim(default_address), 500))  OR btrim(default_address) = '';
  GET DIAGNOSTICS text_fixed = ROW_COUNT;
  UPDATE game_sessions
     SET location = coalesce(nullif(btrim(left(btrim(location), 255)), ''), 'Unspecified'),
         address  = coalesce(nullif(btrim(left(btrim(address), 500)), ''), 'Unspecified')
   WHERE location <> btrim(left(btrim(location), 255)) OR btrim(location) = ''
      OR address  <> btrim(left(btrim(address), 500))  OR btrim(address) = '';
  GET DIAGNOSTICS amounts = ROW_COUNT;
  text_fixed := text_fixed + amounts;

  -- Amounts: a negative amount becomes 0.00.
  UPDATE recurring_session_rules
     SET default_total_court_cost   = CASE WHEN default_total_court_cost   < 0 THEN 0.00 ELSE default_total_court_cost   END,
         default_extra_expenses     = CASE WHEN default_extra_expenses     < 0 THEN 0.00 ELSE default_extra_expenses     END,
         default_custom_player_rate = CASE WHEN default_custom_player_rate < 0 THEN 0.00 ELSE default_custom_player_rate END,
         fee_flat         = CASE WHEN fee_flat         < 0 THEN 0.00 ELSE fee_flat         END,
         fee_male         = CASE WHEN fee_male         < 0 THEN 0.00 ELSE fee_male         END,
         fee_female       = CASE WHEN fee_female       < 0 THEN 0.00 ELSE fee_female       END,
         fee_other        = CASE WHEN fee_other        < 0 THEN 0.00 ELSE fee_other        END,
         fee_beginner     = CASE WHEN fee_beginner     < 0 THEN 0.00 ELSE fee_beginner     END,
         fee_intermediate = CASE WHEN fee_intermediate < 0 THEN 0.00 ELSE fee_intermediate END,
         fee_advanced     = CASE WHEN fee_advanced     < 0 THEN 0.00 ELSE fee_advanced     END
   WHERE least(default_total_court_cost, default_extra_expenses, default_custom_player_rate, fee_flat, fee_male,
               fee_female, fee_other, fee_beginner, fee_intermediate, fee_advanced) < 0;
  GET DIAGNOSTICS amounts = ROW_COUNT;
  UPDATE game_sessions
     SET total_court_cost           = CASE WHEN total_court_cost           < 0 THEN 0.00 ELSE total_court_cost           END,
         extra_expenses             = CASE WHEN extra_expenses             < 0 THEN 0.00 ELSE extra_expenses             END,
         calculated_rate_per_player = CASE WHEN calculated_rate_per_player < 0 THEN 0.00 ELSE calculated_rate_per_player END,
         custom_player_rate         = CASE WHEN custom_player_rate         < 0 THEN 0.00 ELSE custom_player_rate         END,
         fee_flat         = CASE WHEN fee_flat         < 0 THEN 0.00 ELSE fee_flat         END,
         fee_male         = CASE WHEN fee_male         < 0 THEN 0.00 ELSE fee_male         END,
         fee_female       = CASE WHEN fee_female       < 0 THEN 0.00 ELSE fee_female       END,
         fee_other        = CASE WHEN fee_other        < 0 THEN 0.00 ELSE fee_other        END,
         fee_beginner     = CASE WHEN fee_beginner     < 0 THEN 0.00 ELSE fee_beginner     END,
         fee_intermediate = CASE WHEN fee_intermediate < 0 THEN 0.00 ELSE fee_intermediate END,
         fee_advanced     = CASE WHEN fee_advanced     < 0 THEN 0.00 ELSE fee_advanced     END
   WHERE least(total_court_cost, extra_expenses, calculated_rate_per_player, custom_player_rate, fee_flat, fee_male,
               fee_female, fee_other, fee_beginner, fee_intermediate, fee_advanced) < 0;

  -- Capacity of a rule.
  UPDATE recurring_session_rules SET default_max_players = 1 WHERE default_max_players < 1;
  UPDATE recurring_session_rules
     SET default_reserved_seats = least(greatest(default_reserved_seats, 0), default_max_players)
   WHERE default_reserved_seats NOT BETWEEN 0 AND default_max_players;

  -- A rule is always publishable: its fees are complete for its structure (BY_SEX already is, D-05 era CHECK).
  UPDATE recurring_session_rules
     SET fee_flat = coalesce(fee_flat, 0.00),
         fee_beginner = coalesce(fee_beginner, 0.00),
         fee_intermediate = coalesce(fee_intermediate, 0.00),
         fee_advanced = coalesce(fee_advanced, 0.00)
   WHERE (pricing_structure = 'FLAT' AND fee_flat IS NULL)
      OR (pricing_structure = 'BY_SKILL_LEVEL'
          AND (fee_beginner IS NULL OR fee_intermediate IS NULL OR fee_advanced IS NULL));
  GET DIAGNOSTICS fees = ROW_COUNT;

  -- C-SSE-1 on live sessions: all three skill fees, and fee_flat = the final rate (custom, else calculated).
  UPDATE game_sessions
     SET fee_beginner = coalesce(fee_beginner, 0.00),
         fee_intermediate = coalesce(fee_intermediate, 0.00),
         fee_advanced = coalesce(fee_advanced, 0.00)
   WHERE status IN ('PUBLISHED', 'COMPLETED') AND pricing_structure = 'BY_SKILL_LEVEL'
     AND (fee_beginner IS NULL OR fee_intermediate IS NULL OR fee_advanced IS NULL);
  GET DIAGNOSTICS amounts = ROW_COUNT;
  fees := fees + amounts;
  UPDATE game_sessions
     SET fee_flat = coalesce(custom_player_rate, calculated_rate_per_player, fee_flat, 0.00)
   WHERE status IN ('PUBLISHED', 'COMPLETED') AND pricing_structure = 'FLAT'
     AND (fee_flat IS NULL OR fee_flat <> coalesce(custom_player_rate, calculated_rate_per_player, fee_flat));
  GET DIAGNOSTICS amounts = ROW_COUNT;
  fees := fees + amounts;

  -- Courts: trimmed identifiers (1..50, never empty), then duplicates inside one session renumbered.
  UPDATE session_courts
     SET court_identifier = coalesce(nullif(btrim(left(btrim(court_identifier), 50)), ''), 'Court')
   WHERE court_identifier <> btrim(left(btrim(court_identifier), 50)) OR btrim(court_identifier) = '';
  GET DIAGNOSTICS courts = ROW_COUNT;
  UPDATE session_courts sc
     SET court_identifier = left(sc.court_identifier, 44) || ' (' || d.rn || ')'
    FROM (SELECT id, row_number() OVER (PARTITION BY session_id, court_identifier ORDER BY created_at, id) AS rn
            FROM session_courts) d
   WHERE d.id = sc.id AND d.rn > 1;
  GET DIAGNOSTICS amounts = ROW_COUNT;
  courts := courts + amounts;

  -- Existing sessions were published (or not) before auto-enrol existed: not retroactive (ADR 0017 point 7).
  UPDATE game_sessions SET auto_enrol_required = false WHERE status <> 'DRAFT';

  -- The default deadline: a session whose deadline already equals start - 48 h keeps following it.
  UPDATE game_sessions SET deadline_is_default = false
   WHERE starts_at IS NOT NULL AND cancellation_deadline <> starts_at - interval '48 hours';

  RAISE NOTICE 'session scheduling cleanup: anchored % rule(s), fixed text on % row(s), repaired fees on % row(s), renamed % court identifier(s)',
    anchored, text_fixed, fees, courts;

END $$;

ALTER TABLE game_sessions ENABLE TRIGGER game_sessions_paid_requires_payout;

-- ---------------------------------------------------------------------------------------------------------
-- D-70: the series anchor. day_of_week keeps PostgreSQL numbering (0 = Sunday), as the shared recurrence code.
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE recurring_session_rules ALTER COLUMN starts_on SET NOT NULL;

-- Is `d` the w-th (1..4) or last (-1) weekday of its month? (a 5th weekday is stored as -1.)
CREATE FUNCTION recurrence_monthly_anchor_ok(d date, w smallint) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
           WHEN w BETWEEN 1 AND 4 THEN ((extract(day FROM d)::integer - 1) / 7) + 1 = w
           WHEN w = -1            THEN extract(month FROM d + 7) <> extract(month FROM d)
           ELSE false
         END $$;

ALTER TABLE recurring_session_rules
  ADD CONSTRAINT recurring_session_rules_anchor_weekday
    CHECK (extract(dow FROM starts_on) = day_of_week) NOT VALID,
  ADD CONSTRAINT recurring_session_rules_monthly_week_iff_monthly
    CHECK ((frequency = 'MONTHLY') = (monthly_week IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT recurring_session_rules_monthly_week_range
    CHECK (monthly_week IS NULL OR monthly_week IN (1, 2, 3, 4, -1)) NOT VALID,
  ADD CONSTRAINT recurring_session_rules_monthly_anchor
    CHECK (monthly_week IS NULL OR recurrence_monthly_anchor_ok(starts_on, monthly_week)) NOT VALID,
  ADD CONSTRAINT recurring_session_rules_until_after_anchor
    CHECK (recur_until IS NULL OR recur_until >= starts_on) NOT VALID;
ALTER TABLE recurring_session_rules
  VALIDATE CONSTRAINT recurring_session_rules_anchor_weekday,
  VALIDATE CONSTRAINT recurring_session_rules_monthly_week_iff_monthly,
  VALIDATE CONSTRAINT recurring_session_rules_monthly_week_range,
  VALIDATE CONSTRAINT recurring_session_rules_monthly_anchor,
  VALIDATE CONSTRAINT recurring_session_rules_until_after_anchor;

-- ---------------------------------------------------------------------------------------------------------
-- D-71: the per-court template of a series, copied into session_courts at materialisation. default_court_count,
-- default_start_time and default_end_time stay as the editor's remembered bulk-fill values.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE recurring_rule_courts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id          uuid NOT NULL REFERENCES recurring_session_rules (id) ON DELETE CASCADE,
  position         smallint NOT NULL CHECK (position BETWEEN 1 AND 50),
  court_identifier varchar(50) NOT NULL,
  start_time       time NOT NULL,
  end_time         time NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- No midnight crossing; '24:00' means a midnight end (same as session_courts).
  CONSTRAINT recurring_rule_courts_time_order CHECK (start_time < time '24:00' AND end_time > start_time),
  CONSTRAINT recurring_rule_courts_identifier_trimmed
    CHECK (char_length(court_identifier) BETWEEN 1 AND 50 AND court_identifier = btrim(court_identifier)),
  CONSTRAINT uq_recurring_rule_courts_identifier UNIQUE (rule_id, court_identifier),
  CONSTRAINT uq_recurring_rule_courts_position UNIQUE (rule_id, position)
);

-- Existing rules get a template from their remembered defaults: Court 1..N over default_start..default_end.
INSERT INTO recurring_rule_courts (rule_id, position, court_identifier, start_time, end_time)
SELECT r.id, n, 'Court ' || n, r.default_start_time, r.default_end_time
  FROM recurring_session_rules r
 CROSS JOIN LATERAL generate_series(1, least(greatest(r.default_court_count, 1), 50)) AS n;

-- An ACTIVE rule has at least one template court, checked at COMMIT (a rule and its courts are written together).
CREATE FUNCTION recurring_rule_courts_present() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid uuid;
BEGIN
  IF TG_TABLE_NAME = 'recurring_session_rules' THEN
    rid := NEW.id;
  ELSE
    rid := OLD.rule_id;                                              -- AFTER DELETE / UPDATE OF rule_id only
  END IF;
  IF EXISTS (SELECT 1 FROM recurring_session_rules WHERE id = rid AND is_active)
     AND NOT EXISTS (SELECT 1 FROM recurring_rule_courts WHERE rule_id = rid) THEN
    RAISE EXCEPTION 'recurring_session_rules %: an active series needs at least one court', rid
      USING ERRCODE = '23514', CONSTRAINT = 'recurring_session_rules_courts_present';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER recurring_session_rules_courts_present
  AFTER INSERT OR UPDATE OF is_active ON recurring_session_rules
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION recurring_rule_courts_present();
CREATE CONSTRAINT TRIGGER recurring_rule_courts_present
  AFTER DELETE OR UPDATE OF rule_id ON recurring_rule_courts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION recurring_rule_courts_present();

-- ---------------------------------------------------------------------------------------------------------
-- D-72: optimistic-concurrency stamp, bumped by the DB on any content change by any writer. The column list per
-- table (TG_ARGV) is the derived or bookkeeping set that does NOT count as content. Writers cannot set version.
-- ---------------------------------------------------------------------------------------------------------
CREATE FUNCTION sessions_bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - TG_ARGV) IS DISTINCT FROM (to_jsonb(OLD) - TG_ARGV) THEN
    NEW.version := OLD.version + 1;
    IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
      NEW.updated_at := statement_timestamp();
    END IF;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER game_sessions_version_bump
  BEFORE UPDATE ON game_sessions FOR EACH ROW
  EXECUTE FUNCTION sessions_bump_version('version', 'starts_at', 'ends_at', 'auto_enrol_required', 'auto_enrolled_at');
CREATE TRIGGER recurring_session_rules_version_bump
  BEFORE UPDATE ON recurring_session_rules FOR EACH ROW
  EXECUTE FUNCTION sessions_bump_version('version', 'materialised_version', 'materialised_at');

-- ---------------------------------------------------------------------------------------------------------
-- D-73: create idempotency (the D-46 shape: a plain UNIQUE, NULLs distinct, scoped by team).
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE game_sessions
  ADD CONSTRAINT uq_game_sessions_team_create_key UNIQUE (team_id, create_key);
ALTER TABLE recurring_session_rules
  ADD CONSTRAINT uq_recurring_session_rules_team_create_key UNIQUE (team_id, create_key);

-- ---------------------------------------------------------------------------------------------------------
-- D-74: while deadline_is_default holds, the DB keeps cancellation_deadline = starts_at - 48 h (absolute hours,
-- never '2 days', which is DST-aware). Without courts (starts_at NULL) the writer's value stands.
-- ---------------------------------------------------------------------------------------------------------
CREATE FUNCTION game_sessions_fill_default_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deadline_is_default AND NEW.starts_at IS NOT NULL THEN
    NEW.cancellation_deadline := NEW.starts_at - interval '48 hours';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER game_sessions_fill_default_deadline
  BEFORE INSERT OR UPDATE ON game_sessions
  FOR EACH ROW EXECUTE FUNCTION game_sessions_fill_default_deadline();

-- ---------------------------------------------------------------------------------------------------------
-- D-75: lifecycle matrix, closed-row immutability, immutable keys, DRAFT-only deletion. The TS twin is
-- modules/sessions/transitions.ts (+ SESSION_TRANSITIONS), pinned by test/fixtures/session-transitions.ts.
-- Time-relative rules (cancel or edit only before starts_at) stay in TS: now() stays out of SQL rules.
-- ---------------------------------------------------------------------------------------------------------
CREATE FUNCTION game_sessions_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.team_id IS DISTINCT FROM OLD.team_id
     OR (OLD.recurring_rule_id IS NOT NULL AND NEW.date IS DISTINCT FROM OLD.date) THEN
    RAISE EXCEPTION 'game_sessions.team_id is immutable, and so is the date of a series session'
      USING ERRCODE = '23000', CONSTRAINT = 'game_sessions_keys_immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'DRAFT'     AND NEW.status IN ('PUBLISHED', 'CANCELLED'))
      OR (OLD.status = 'PUBLISHED' AND NEW.status IN ('CANCELLED', 'COMPLETED'))) THEN
    RAISE EXCEPTION 'game_sessions: % -> % is not an allowed transition', OLD.status, NEW.status
      USING ERRCODE = '23000', CONSTRAINT = 'game_sessions_status_transition';
  END IF;
  -- A closed row changes in nothing but its series link (the FK's ON DELETE SET NULL), version and updated_at.
  IF OLD.status IN ('COMPLETED', 'CANCELLED')
     AND ((to_jsonb(NEW) - '{version,updated_at,recurring_rule_id}'::text[])
            IS DISTINCT FROM (to_jsonb(OLD) - '{version,updated_at,recurring_rule_id}'::text[])
          OR (NEW.recurring_rule_id IS NOT NULL AND NEW.recurring_rule_id IS DISTINCT FROM OLD.recurring_rule_id)) THEN
    RAISE EXCEPTION 'game_sessions: a % session cannot be changed', OLD.status
      USING ERRCODE = '23000', CONSTRAINT = 'game_sessions_closed_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER game_sessions_guard_update
  BEFORE UPDATE ON game_sessions
  FOR EACH ROW EXECUTE FUNCTION game_sessions_guard_update();

-- Only a DRAFT can be deleted. A team deleted as a whole cascades into its sessions: the team row is already gone then.
CREATE FUNCTION game_sessions_guard_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND EXISTS (SELECT 1 FROM teams WHERE id = OLD.team_id) THEN
    RAISE EXCEPTION 'game_sessions: only a DRAFT session can be deleted (this one is %)', OLD.status
      USING ERRCODE = '23000', CONSTRAINT = 'game_sessions_delete_draft_only';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER game_sessions_guard_delete
  BEFORE DELETE ON game_sessions
  FOR EACH ROW EXECUTE FUNCTION game_sessions_guard_delete();

-- ---------------------------------------------------------------------------------------------------------
-- D-76: no court insert, update or delete on a COMPLETED or CANCELLED session (ADR 0017 C-GAME-1 point 3). The
-- session row is locked FOR NO KEY UPDATE (the mode the touch trigger's UPDATE needs anyway, so no lock upgrade
-- deadlock) so a raw court write racing a completion waits for it and then sees COMPLETED. A missing session row
-- (a cascade delete in progress) is allowed.
-- ---------------------------------------------------------------------------------------------------------
CREATE FUNCTION session_courts_guard_closed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sids uuid[];
  sid uuid;
  current_status session_status;
BEGIN
  IF TG_OP = 'INSERT' THEN
    sids := ARRAY[NEW.session_id];
  ELSIF TG_OP = 'DELETE' THEN
    sids := ARRAY[OLD.session_id];
  ELSE
    sids := ARRAY[OLD.session_id, NEW.session_id];
  END IF;
  FOREACH sid IN ARRAY sids LOOP
    SELECT status INTO current_status FROM game_sessions WHERE id = sid FOR NO KEY UPDATE;
    IF FOUND AND current_status IN ('COMPLETED', 'CANCELLED') THEN
      RAISE EXCEPTION 'session_courts: session % is % and its courts cannot be changed', sid, current_status
        USING ERRCODE = '23000', CONSTRAINT = 'session_courts_closed_immutable';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_courts_guard_closed
  BEFORE INSERT OR UPDATE OR DELETE ON session_courts
  FOR EACH ROW EXECUTE FUNCTION session_courts_guard_closed();

-- ---------------------------------------------------------------------------------------------------------
-- D-77: C-SSE-1 on live (PUBLISHED or COMPLETED) sessions. A FLAT session's fee_flat IS the final rate (custom,
-- else calculated); the coalesce keeps a row without costing columns valid while every service-written row,
-- which always has calculated_rate_per_player, is held to it.
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE game_sessions
  ADD CONSTRAINT game_sessions_skill_fees_when_live
    CHECK (status NOT IN ('PUBLISHED', 'COMPLETED') OR pricing_structure <> 'BY_SKILL_LEVEL'
           OR (fee_beginner IS NOT NULL AND fee_intermediate IS NOT NULL AND fee_advanced IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT game_sessions_flat_fee_when_live
    CHECK (status NOT IN ('PUBLISHED', 'COMPLETED') OR pricing_structure <> 'FLAT'
           OR (fee_flat IS NOT NULL
               AND fee_flat = coalesce(custom_player_rate, calculated_rate_per_player, fee_flat))) NOT VALID;

-- ---------------------------------------------------------------------------------------------------------
-- D-79: content limits (AC-ERROR-2: a raw-SQL write fails with 23514). Money is never negative; a rule's capacity
-- and fees are always complete for its structure, so every instance is publishable.
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE game_sessions
  ADD CONSTRAINT game_sessions_location_trimmed
    CHECK (char_length(location) BETWEEN 1 AND 255 AND location = btrim(location)) NOT VALID,
  ADD CONSTRAINT game_sessions_address_trimmed
    CHECK (char_length(address) BETWEEN 1 AND 500 AND address = btrim(address)) NOT VALID,
  ADD CONSTRAINT game_sessions_amounts_non_negative
    CHECK (coalesce(total_court_cost, 0) >= 0 AND coalesce(extra_expenses, 0) >= 0
           AND coalesce(calculated_rate_per_player, 0) >= 0 AND coalesce(custom_player_rate, 0) >= 0
           AND coalesce(fee_flat, 0) >= 0 AND coalesce(fee_male, 0) >= 0 AND coalesce(fee_female, 0) >= 0
           AND coalesce(fee_other, 0) >= 0 AND coalesce(fee_beginner, 0) >= 0
           AND coalesce(fee_intermediate, 0) >= 0 AND coalesce(fee_advanced, 0) >= 0) NOT VALID;
ALTER TABLE recurring_session_rules
  ADD CONSTRAINT recurring_session_rules_location_trimmed
    CHECK (char_length(default_location) BETWEEN 1 AND 255 AND default_location = btrim(default_location)) NOT VALID,
  ADD CONSTRAINT recurring_session_rules_address_trimmed
    CHECK (char_length(default_address) BETWEEN 1 AND 500 AND default_address = btrim(default_address)) NOT VALID,
  ADD CONSTRAINT recurring_session_rules_amounts_non_negative
    CHECK (coalesce(default_total_court_cost, 0) >= 0 AND coalesce(default_extra_expenses, 0) >= 0
           AND coalesce(default_custom_player_rate, 0) >= 0
           AND coalesce(fee_flat, 0) >= 0 AND coalesce(fee_male, 0) >= 0 AND coalesce(fee_female, 0) >= 0
           AND coalesce(fee_other, 0) >= 0 AND coalesce(fee_beginner, 0) >= 0
           AND coalesce(fee_intermediate, 0) >= 0 AND coalesce(fee_advanced, 0) >= 0) NOT VALID,
  ADD CONSTRAINT recurring_session_rules_capacity
    CHECK (default_max_players > 0 AND default_reserved_seats BETWEEN 0 AND default_max_players) NOT VALID,
  ADD CONSTRAINT recurring_session_rules_fees_complete
    CHECK ((pricing_structure <> 'FLAT' OR fee_flat IS NOT NULL)
           AND (pricing_structure <> 'BY_SKILL_LEVEL'
                OR (fee_beginner IS NOT NULL AND fee_intermediate IS NOT NULL AND fee_advanced IS NOT NULL))) NOT VALID;

-- ---------------------------------------------------------------------------------------------------------
-- D-80: the durable auto-enrol obligation of a session. Required by default (P-1: every session, one-off or
-- series); stamped only when a real allocator ran. A stamp implies the obligation.
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE game_sessions
  ADD CONSTRAINT game_sessions_auto_enrol_stamp
    CHECK (auto_enrolled_at IS NULL OR auto_enrol_required) NOT VALID;

ALTER TABLE game_sessions
  VALIDATE CONSTRAINT game_sessions_skill_fees_when_live,
  VALIDATE CONSTRAINT game_sessions_flat_fee_when_live,
  VALIDATE CONSTRAINT game_sessions_location_trimmed,
  VALIDATE CONSTRAINT game_sessions_address_trimmed,
  VALIDATE CONSTRAINT game_sessions_amounts_non_negative,
  VALIDATE CONSTRAINT game_sessions_auto_enrol_stamp;
ALTER TABLE recurring_session_rules
  VALIDATE CONSTRAINT recurring_session_rules_location_trimmed,
  VALIDATE CONSTRAINT recurring_session_rules_address_trimmed,
  VALIDATE CONSTRAINT recurring_session_rules_amounts_non_negative,
  VALIDATE CONSTRAINT recurring_session_rules_capacity,
  VALIDATE CONSTRAINT recurring_session_rules_fees_complete;

CREATE INDEX idx_game_sessions_auto_enrol_pending ON game_sessions (starts_at)
  WHERE status = 'PUBLISHED' AND auto_enrol_required AND auto_enrolled_at IS NULL;

-- D-78: one court identifier per session, trimmed and 1 to 50 characters.
ALTER TABLE session_courts
  ADD CONSTRAINT session_courts_identifier_trimmed
    CHECK (char_length(court_identifier) BETWEEN 1 AND 50 AND court_identifier = btrim(court_identifier)) NOT VALID,
  ADD CONSTRAINT uq_session_courts_session_identifier UNIQUE (session_id, court_identifier);
ALTER TABLE session_courts VALIDATE CONSTRAINT session_courts_identifier_trimmed;

-- ---------------------------------------------------------------------------------------------------------
-- D-81 (T-18): the durable claim for "at most one banking-missing email per series per window". Claimed with
-- INSERT ... ON CONFLICT DO NOTHING RETURNING in the instance transaction; the rule row is never updated.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE payout_notice_claims (
  rule_id      uuid NOT NULL REFERENCES recurring_session_rules (id) ON DELETE CASCADE,
  window_start date NOT NULL,
  claimed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, window_start)
);

-- ---------------------------------------------------------------------------------------------------------
-- D-85 (T-17): once a PUBLISHED session has an active registration its fees can only go down. The function is the
-- one definition of "active" (registration-and-waitlist CREATE OR REPLACEs it to add withdrawals with a fee due);
-- the trigger is the raw-SQL backstop of the API's 409 session_fee_locked, evaluated under the session row lock.
-- ---------------------------------------------------------------------------------------------------------
CREATE FUNCTION game_session_has_active_registrations(p_session_id uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM registrations r
                  WHERE r.session_id = p_session_id AND r.status IN ('CONFIRMED', 'WAITLISTED')) $$;

CREATE FUNCTION game_sessions_enforce_fee_raise_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE raised boolean;
BEGIN
  IF OLD.status <> 'PUBLISHED' THEN
    RETURN NEW;
  END IF;
  IF NEW.pricing_structure IS DISTINCT FROM OLD.pricing_structure THEN
    raised := true;
  ELSIF NEW.pricing_structure = 'FLAT' THEN
    raised := coalesce(NEW.fee_flat, 0) > coalesce(OLD.fee_flat, 0);
  ELSIF NEW.pricing_structure = 'BY_SEX' THEN
    raised := coalesce(NEW.fee_male, 0) > coalesce(OLD.fee_male, 0)
           OR coalesce(NEW.fee_female, 0) > coalesce(OLD.fee_female, 0)
           OR coalesce(NEW.fee_other, 0) > coalesce(OLD.fee_other, 0);
  ELSE
    raised := coalesce(NEW.fee_beginner, 0) > coalesce(OLD.fee_beginner, 0)
           OR coalesce(NEW.fee_intermediate, 0) > coalesce(OLD.fee_intermediate, 0)
           OR coalesce(NEW.fee_advanced, 0) > coalesce(OLD.fee_advanced, 0);
  END IF;
  IF raised AND game_session_has_active_registrations(OLD.id) THEN
    RAISE EXCEPTION 'game_sessions %: fees can only be lowered once players have registered', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'game_sessions_fee_raise_locked';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER game_sessions_fee_raise_locked
  BEFORE UPDATE OF pricing_structure, fee_flat, fee_male, fee_female, fee_other, fee_beginner,
                   fee_intermediate, fee_advanced
  ON game_sessions FOR EACH ROW EXECUTE FUNCTION game_sessions_enforce_fee_raise_lock();

-- Down Migration
DROP TRIGGER game_sessions_fee_raise_locked ON game_sessions;
DROP FUNCTION game_sessions_enforce_fee_raise_lock();
DROP FUNCTION game_session_has_active_registrations(uuid);
DROP TABLE payout_notice_claims;
ALTER TABLE session_courts
  DROP CONSTRAINT uq_session_courts_session_identifier,
  DROP CONSTRAINT session_courts_identifier_trimmed;
DROP INDEX idx_game_sessions_auto_enrol_pending;
ALTER TABLE recurring_session_rules
  DROP CONSTRAINT recurring_session_rules_fees_complete,
  DROP CONSTRAINT recurring_session_rules_capacity,
  DROP CONSTRAINT recurring_session_rules_amounts_non_negative,
  DROP CONSTRAINT recurring_session_rules_address_trimmed,
  DROP CONSTRAINT recurring_session_rules_location_trimmed;
ALTER TABLE game_sessions
  DROP CONSTRAINT game_sessions_auto_enrol_stamp,
  DROP CONSTRAINT game_sessions_amounts_non_negative,
  DROP CONSTRAINT game_sessions_address_trimmed,
  DROP CONSTRAINT game_sessions_location_trimmed,
  DROP CONSTRAINT game_sessions_flat_fee_when_live,
  DROP CONSTRAINT game_sessions_skill_fees_when_live;
DROP TRIGGER session_courts_guard_closed ON session_courts;
DROP FUNCTION session_courts_guard_closed();
DROP TRIGGER game_sessions_guard_delete ON game_sessions;
DROP FUNCTION game_sessions_guard_delete();
DROP TRIGGER game_sessions_guard_update ON game_sessions;
DROP FUNCTION game_sessions_guard_update();
DROP TRIGGER game_sessions_fill_default_deadline ON game_sessions;
DROP FUNCTION game_sessions_fill_default_deadline();
ALTER TABLE recurring_session_rules DROP CONSTRAINT uq_recurring_session_rules_team_create_key;
ALTER TABLE game_sessions DROP CONSTRAINT uq_game_sessions_team_create_key;
DROP TRIGGER recurring_session_rules_version_bump ON recurring_session_rules;
DROP TRIGGER game_sessions_version_bump ON game_sessions;
DROP FUNCTION sessions_bump_version();
DROP TRIGGER recurring_rule_courts_present ON recurring_rule_courts;
DROP TRIGGER recurring_session_rules_courts_present ON recurring_session_rules;
DROP FUNCTION recurring_rule_courts_present();
DROP TABLE recurring_rule_courts;
ALTER TABLE recurring_session_rules
  DROP CONSTRAINT recurring_session_rules_until_after_anchor,
  DROP CONSTRAINT recurring_session_rules_monthly_anchor,
  DROP CONSTRAINT recurring_session_rules_monthly_week_range,
  DROP CONSTRAINT recurring_session_rules_monthly_week_iff_monthly,
  DROP CONSTRAINT recurring_session_rules_anchor_weekday;
DROP FUNCTION recurrence_monthly_anchor_ok(date, smallint);
ALTER TABLE game_sessions
  DROP COLUMN auto_enrolled_at,
  DROP COLUMN auto_enrol_required,
  DROP COLUMN deadline_is_default,
  DROP COLUMN create_key,
  DROP COLUMN updated_at,
  DROP COLUMN version;
ALTER TABLE recurring_session_rules
  DROP COLUMN materialised_at,
  DROP COLUMN materialised_version,
  DROP COLUMN create_key,
  DROP COLUMN updated_at,
  DROP COLUMN version,
  DROP COLUMN monthly_week,
  DROP COLUMN starts_on;
