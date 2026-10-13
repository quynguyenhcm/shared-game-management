-- Up Migration
-- Sliding-log throttle shared by every API replica (algorithm Q7, option 7A). One row per keyed pseudonym
-- (HMAC-SHA256, so no email or address is stored in clear); `attempts` holds the in-window attempt instants.
CREATE TABLE auth_throttle (
  scope      varchar(32) NOT NULL
    CONSTRAINT auth_throttle_scope_known CHECK (scope IN ('login_email', 'login_address', 'forgot_address')),
  key_hash   bytea NOT NULL
    CONSTRAINT auth_throttle_key_hash_length CHECK (octet_length(key_hash) = 32),
  attempts   timestamptz[] NOT NULL DEFAULT '{}'
    CONSTRAINT auth_throttle_attempts_bounded CHECK (cardinality(attempts) <= 256),
  updated_at timestamptz NOT NULL,
  CONSTRAINT auth_throttle_pkey PRIMARY KEY (scope, key_hash)
);

-- Atomic all-or-nothing admit with reserve-then-verify. For each (scope, key, limit, window): lock the rows in a
-- fixed (scope, key) order so concurrent admits cannot deadlock, prune attempts older than the window, and block
-- the request when any key is at its limit. Only when no key blocks is `p_now` appended to every key as a
-- provisional failure; blocked attempts append nothing, so hammering cannot extend a lockout.
-- Returns (admitted, retry_after_seconds); retry_after_seconds is 0 when admitted, otherwise the largest wait over
-- the blocked keys until their oldest counted attempt leaves the window (minimum 1).
CREATE FUNCTION auth_throttle_admit(
  p_scopes  text[],
  p_keys    bytea[],
  p_limits  integer[],
  p_windows interval[],
  p_now     timestamptz
) RETURNS TABLE (admitted boolean, retry_after_seconds integer)
LANGUAGE plpgsql AS $$
DECLARE
  r         record;
  v_pruned  timestamptz[];
  v_count   integer;
  v_blocked boolean := false;
  v_retry   integer := 0;
BEGIN
  IF cardinality(p_scopes) IS DISTINCT FROM cardinality(p_keys)
     OR cardinality(p_scopes) IS DISTINCT FROM cardinality(p_limits)
     OR cardinality(p_scopes) IS DISTINCT FROM cardinality(p_windows) THEN
    RAISE EXCEPTION 'auth_throttle_admit: argument arrays must have the same length'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO auth_throttle (scope, key_hash, attempts, updated_at)
  SELECT DISTINCT t.scope, t.key, '{}'::timestamptz[], p_now
    FROM unnest(p_scopes, p_keys) AS t(scope, key)
   ORDER BY t.scope, t.key
  ON CONFLICT (scope, key_hash) DO NOTHING;

  FOR r IN
    SELECT t.scope, t.key, t.lim, t.win
      FROM unnest(p_scopes, p_keys, p_limits, p_windows) AS t(scope, key, lim, win)
     ORDER BY t.scope, t.key
  LOOP
    SELECT ARRAY(SELECT a FROM unnest(th.attempts) AS a WHERE a > p_now - r.win ORDER BY a)
      INTO v_pruned
      FROM auth_throttle th
     WHERE th.scope = r.scope AND th.key_hash = r.key
       FOR UPDATE;
    UPDATE auth_throttle SET attempts = v_pruned WHERE scope = r.scope AND key_hash = r.key;
    v_count := cardinality(v_pruned);
    IF v_count >= r.lim THEN
      v_blocked := true;
      v_retry := greatest(
        v_retry,
        ceil(extract(epoch FROM (v_pruned[v_count - r.lim + 1] + r.win - p_now)))::integer
      );
    END IF;
  END LOOP;

  IF NOT v_blocked THEN
    UPDATE auth_throttle th
       SET attempts = th.attempts || p_now, updated_at = p_now
      FROM (SELECT DISTINCT t.scope, t.key FROM unnest(p_scopes, p_keys) AS t(scope, key)) AS k
     WHERE th.scope = k.scope AND th.key_hash = k.key;
  END IF;

  RETURN QUERY SELECT NOT v_blocked, CASE WHEN v_blocked THEN greatest(v_retry, 1) ELSE 0 END;
END;
$$;

-- A successful sign-in: delete the email row (reset) and refund this request's own provisional entry from the
-- address row (one occurrence of p_now, so concurrent attempts sharing a timestamp are not over-refunded). The
-- address row is never cleared. Address first, then email: the same lock order as auth_throttle_admit.
CREATE FUNCTION auth_throttle_settle(
  p_email_key   bytea,
  p_address_key bytea,
  p_now         timestamptz
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_pos integer;
BEGIN
  IF p_address_key IS NOT NULL THEN
    SELECT array_position(attempts, p_now) INTO v_pos
      FROM auth_throttle
     WHERE scope = 'login_address' AND key_hash = p_address_key
       FOR UPDATE;
    IF v_pos IS NOT NULL THEN
      UPDATE auth_throttle
         SET attempts = attempts[1:v_pos - 1] || attempts[v_pos + 1:]
       WHERE scope = 'login_address' AND key_hash = p_address_key;
    END IF;
  END IF;
  DELETE FROM auth_throttle WHERE scope = 'login_email' AND key_hash = p_email_key;
END;
$$;

-- Down Migration
DROP FUNCTION auth_throttle_settle(bytea, bytea, timestamptz);
DROP FUNCTION auth_throttle_admit(text[], bytea[], integer[], interval[], timestamptz);
DROP TABLE auth_throttle;
