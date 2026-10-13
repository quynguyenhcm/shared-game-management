-- Up Migration
-- Opaque server-side sessions (architecture Q2). Only the SHA-256 of the 256-bit token is stored; the role is
-- never copied here (it is read from users on every request).
CREATE TABLE auth_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash          bytea NOT NULL
    CONSTRAINT uq_auth_sessions_token_hash UNIQUE
    CONSTRAINT auth_sessions_token_hash_length CHECK (octet_length(token_hash) = 32),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,                  -- idle expiry, slides up to absolute_expires_at
  absolute_expires_at timestamptz NOT NULL,                  -- fixed at issue, never extended
  revoked_at          timestamptz,
  revoked_reason      varchar(32)
    CONSTRAINT auth_sessions_revoked_reason_known
    CHECK (revoked_reason IN ('logout', 'password_reset', 'replaced')),
  user_agent          varchar(512),
  CONSTRAINT auth_sessions_revoked_pair CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT auth_sessions_last_seen_after_created CHECK (last_seen_at >= created_at),
  CONSTRAINT auth_sessions_expiry_within_absolute CHECK (expires_at <= absolute_expires_at),
  CONSTRAINT auth_sessions_absolute_after_created CHECK (absolute_expires_at > created_at),
  CONSTRAINT auth_sessions_revoked_after_created CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX idx_auth_sessions_user_active ON auth_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_auth_sessions_expires_at ON auth_sessions (expires_at);

-- Down Migration
DROP TABLE auth_sessions;
