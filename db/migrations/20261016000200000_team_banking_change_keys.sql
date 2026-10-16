-- Up Migration
-- team-banking-and-gst: D-54, durable replay claim for the banking change key (Phase 2 review, Codex P1). Every
-- committed banking save or removal appends its change key here (the newest 32 are kept), and a save checks the
-- list under the team lock, so a delayed replay of a request that already committed is a no-op instead of
-- re-applying its stale values, even after another admin has saved something else since.
ALTER TABLE teams ADD COLUMN banking_change_keys uuid[] NOT NULL DEFAULT '{}';

-- Down Migration
ALTER TABLE teams DROP COLUMN banking_change_keys;
