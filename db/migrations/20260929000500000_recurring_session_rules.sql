-- Up Migration
CREATE TABLE recurring_session_rules (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id                    uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  frequency                  recurrence_frequency NOT NULL DEFAULT 'WEEKLY',
  day_of_week                integer NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  default_location           varchar(255) NOT NULL,
  default_address            text NOT NULL,
  default_max_players        integer NOT NULL,
  default_reserved_seats     integer NOT NULL DEFAULT 0,
  default_court_count        integer NOT NULL DEFAULT 1,
  default_start_time         time NOT NULL,
  default_end_time           time NOT NULL,
  default_total_court_cost   numeric(10,2) DEFAULT 0.00,
  default_extra_expenses     numeric(10,2) DEFAULT 0.00,
  default_custom_player_rate numeric(10,2),
  pricing_structure          pricing_type NOT NULL DEFAULT 'FLAT',
  fee_flat                   numeric(10,2),
  fee_male                   numeric(10,2),
  fee_female                 numeric(10,2),
  -- BY_SEX rate for sex OTHER (spec-owner decision 2026-09-29). Default LEAST(fee_male, fee_female)
  -- is applied by session-scheduling-engine, not by the DB.
  fee_other                  numeric(10,2),
  fee_beginner               numeric(10,2),
  fee_intermediate           numeric(10,2),
  fee_advanced               numeric(10,2),
  recur_until                date,
  is_active                  boolean NOT NULL DEFAULT true,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  -- No midnight crossing; '24:00' means a midnight end.
  CONSTRAINT recurring_session_rules_time_order
    CHECK (default_start_time < time '24:00' AND default_end_time > default_start_time),
  CONSTRAINT recurring_session_rules_by_sex_fees_present
    CHECK (pricing_structure <> 'BY_SEX'
           OR (fee_male IS NOT NULL AND fee_female IS NOT NULL AND fee_other IS NOT NULL))
);

-- Down Migration
DROP TABLE recurring_session_rules;
