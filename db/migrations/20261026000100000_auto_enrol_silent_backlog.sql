-- Up Migration
-- registration-and-waitlist O8 (human ruling 2026-10-26): the silent first run. Ledger row D-86 in db/schema-deviations.md;
-- ADR 0018 section 6.
--
-- At deploy, SSE has left every PUBLISHED session published before registration existed pending auto-enrol (D-80:
-- auto_enrol_required, auto_enrolled_at NULL). The first worker boot sweep enrols them all, and would send one R17
-- auto-enrol email per placed member per session in one burst. That backlog is enrolled WITHOUT emails; sessions published
-- after this migration email as normal (the column default). Placements, logs and the D-80 stamp are unchanged.
-- The silent backlog is exactly what was pending when this migration ran: a session published by the old build after the
-- migration but before the new worker boots defaults to true and emails as normal.

-- D-86: per-session "send the R17 auto-enrol email". Read by runSessionAutoEnrol (readDue) and passed to the allocator port.
ALTER TABLE game_sessions
  ADD COLUMN auto_enrol_notify boolean NOT NULL DEFAULT true;

-- D-86: the flag is auto-enrol bookkeeping, like the D-80 marker, not session content, so it joins the D-72 TG_ARGV list
-- that the version bump ignores. Without this the backfill below would bump `version` and `updated_at` on every backlog
-- row, and an admin edit form opened before the deploy would fail its stale-save check (409) for a change no admin made.
-- The trigger keeps its name, so the documented BEFORE UPDATE firing order (name order, SSE migration header) holds. The
-- function and SSE's D-72 ledger row are not edited.
DROP TRIGGER game_sessions_version_bump ON game_sessions;
CREATE TRIGGER game_sessions_version_bump
  BEFORE UPDATE ON game_sessions FOR EACH ROW
  EXECUTE FUNCTION sessions_bump_version('version', 'starts_at', 'ends_at', 'auto_enrol_required', 'auto_enrolled_at',
                                         'auto_enrol_notify');

-- D-86: the backlog. The UPDATE touches only PUBLISHED rows and only this column, so the D-75 guard (status unchanged, not a
-- closed row) passes, the column-scoped D-49 payout and D-85 fee-lock triggers do not fire, D-08 and D-74 recompute the
-- values they already hold, and the version bump (above) leaves `version` and `updated_at` alone. A session that has
-- already started is included: readDue never enrols it anyway.
UPDATE game_sessions SET auto_enrol_notify = false
 WHERE status = 'PUBLISHED' AND auto_enrol_required AND auto_enrolled_at IS NULL;

-- Down Migration
DROP TRIGGER game_sessions_version_bump ON game_sessions;
CREATE TRIGGER game_sessions_version_bump
  BEFORE UPDATE ON game_sessions FOR EACH ROW
  EXECUTE FUNCTION sessions_bump_version('version', 'starts_at', 'ends_at', 'auto_enrol_required', 'auto_enrolled_at');
ALTER TABLE game_sessions
  DROP COLUMN auto_enrol_notify;
