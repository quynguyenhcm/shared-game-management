-- Up Migration
CREATE TABLE team_members (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id                 uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id                 uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role                    team_role NOT NULL DEFAULT 'MEMBER',
  status                  membership_status NOT NULL DEFAULT 'PENDING',
  skill_level             skill_tier NOT NULL DEFAULT 'BEGINNER',
  skill_level_override_by uuid REFERENCES users (id),
  skill_level_override_at timestamptz,
  is_auto_enroll          boolean NOT NULL DEFAULT false,
  auto_enroll_until       date,
  -- Gap fix (AC-VERIFY-12): workflows doc §4 orders auto-enrolment by "Auto-Enroll Assignment Date".
  auto_enroll_assigned_at timestamptz,
  banned_at               timestamptz,
  banned_by               uuid REFERENCES users (id),
  ban_reason              text,
  requested_at            timestamptz NOT NULL DEFAULT now(),
  approved_at             timestamptz,
  approved_by             uuid REFERENCES users (id),
  CONSTRAINT uq_team_members_team_user UNIQUE (team_id, user_id),
  CONSTRAINT team_members_auto_enroll_assigned
    CHECK (NOT is_auto_enroll OR auto_enroll_assigned_at IS NOT NULL)
);

-- Down Migration
DROP TABLE team_members;
