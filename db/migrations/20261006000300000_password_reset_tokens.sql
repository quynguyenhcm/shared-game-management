-- Up Migration
-- Single-use password-reset tokens (algorithm "Token lifetimes and single use"). Only the SHA-256 of the token is
-- stored; consumption is a guarded UPDATE ... SET used_at WHERE used_at IS NULL AND expires_at > now.
CREATE TABLE password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL
    CONSTRAINT uq_password_reset_tokens_token_hash UNIQUE
    CONSTRAINT password_reset_tokens_token_hash_length CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
    CONSTRAINT password_reset_tokens_expires_after_created CHECK (expires_at > created_at),
  used_at    timestamptz
    CONSTRAINT password_reset_tokens_used_after_created CHECK (used_at IS NULL OR used_at >= created_at)
);
-- Serves the 60-second per-user resend floor (latest token for a user).
CREATE INDEX idx_password_reset_tokens_user_created ON password_reset_tokens (user_id, created_at DESC);

-- Down Migration
DROP TABLE password_reset_tokens;
