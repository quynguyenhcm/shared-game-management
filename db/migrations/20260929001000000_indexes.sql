-- Up Migration
-- The 11 indexes of database-design.md, unchanged.
CREATE INDEX idx_teams_visibility ON teams (visibility);
CREATE INDEX idx_team_members_user_team ON team_members (user_id, team_id, status);
CREATE INDEX idx_team_members_auto_enroll ON team_members (team_id, is_auto_enroll, auto_enroll_until);
CREATE INDEX idx_game_sessions_date ON game_sessions (date DESC);
CREATE INDEX idx_game_sessions_recurring ON game_sessions (recurring_rule_id, date);
CREATE INDEX idx_session_courts_session ON session_courts (session_id);
CREATE INDEX idx_registrations_session_status ON registrations (session_id, status, queue_position);
CREATE INDEX idx_registrations_user ON registrations (user_id, registered_at DESC);
CREATE INDEX idx_payments_user_status ON payments (user_id, status);
CREATE INDEX idx_payments_paid_at_status ON payments (paid_at, status);
CREATE INDEX idx_player_credits_user_team ON player_credits (user_id, team_id);

-- Down Migration
DROP INDEX idx_player_credits_user_team;
DROP INDEX idx_payments_paid_at_status;
DROP INDEX idx_payments_user_status;
DROP INDEX idx_registrations_user;
DROP INDEX idx_registrations_session_status;
DROP INDEX idx_session_courts_session;
DROP INDEX idx_game_sessions_recurring;
DROP INDEX idx_game_sessions_date;
DROP INDEX idx_team_members_auto_enroll;
DROP INDEX idx_team_members_user_team;
DROP INDEX idx_teams_visibility;
