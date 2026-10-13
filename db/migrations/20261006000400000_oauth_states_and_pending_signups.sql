-- Up Migration
-- Short-lived OAuth rows (architecture Q6). Browser-binding cookies hold only random handles; everything
-- sensitive lives here, hashed or encrypted, and every row is single use (used_at).

-- One row per authorize call. `state_hash` is the SHA-256 of the raw state echoed back by the provider.
CREATE TABLE oauth_states (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash        bytea NOT NULL
    CONSTRAINT uq_oauth_states_state_hash UNIQUE
    CONSTRAINT oauth_states_state_hash_length CHECK (octet_length(state_hash) = 32),
  provider          auth_provider NOT NULL
    CONSTRAINT oauth_states_provider_not_password CHECK (provider <> 'PASSWORD'),
  intent            varchar(8) NOT NULL
    CONSTRAINT oauth_states_intent_known CHECK (intent IN ('signin', 'link')),
  link_user_id      uuid REFERENCES users (id) ON DELETE CASCADE,
  nonce             varchar(64),
  -- AES-256-GCM envelope (same format CHECK as the teams_*_envelope columns): a plaintext write fails with 23514.
  code_verifier_enc text
    CONSTRAINT oauth_states_code_verifier_envelope
    CHECK (code_verifier_enc IS NULL
           OR code_verifier_enc ~ '^v1\.[a-z0-9-]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{22}$'),
  return_to         varchar(512)
    CONSTRAINT oauth_states_return_to_local CHECK (return_to IS NULL OR (return_to ~ '^/($|[^/\\])' AND return_to !~ '[[:cntrl:]]')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL
    CONSTRAINT oauth_states_expires_after_created CHECK (expires_at > created_at),
  used_at           timestamptz
    CONSTRAINT oauth_states_used_after_created CHECK (used_at IS NULL OR used_at >= created_at),
  CONSTRAINT oauth_states_link_user_iff_link CHECK ((intent = 'link') = (link_user_id IS NOT NULL))
);
CREATE INDEX idx_oauth_states_expires_at ON oauth_states (expires_at);

-- A first-time OAuth visitor's verified profile, parked until they choose a sex on /register/complete. No users
-- row exists before that (AC-HAPPY-3). A missing provider email never reaches this table (algorithm Q4, 4A).
CREATE TABLE oauth_pending_signups (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash       bytea NOT NULL
    CONSTRAINT uq_oauth_pending_signups_token_hash UNIQUE
    CONSTRAINT oauth_pending_signups_token_hash_length CHECK (octet_length(token_hash) = 32),
  provider         auth_provider NOT NULL
    CONSTRAINT oauth_pending_signups_provider_not_password CHECK (provider <> 'PASSWORD'),
  provider_subject varchar(255) NOT NULL,
  email            varchar(255) NOT NULL
    CONSTRAINT oauth_pending_signups_email_normalised
    CHECK (email = lower(email) AND email ~ '^[!-?A-~]+@[!-?A-~]+$' AND char_length(email) <= 254),
  email_verified   boolean NOT NULL,
  full_name        varchar(255),
  return_to        varchar(512)
    CONSTRAINT oauth_pending_signups_return_to_local CHECK (return_to IS NULL OR (return_to ~ '^/($|[^/\\])' AND return_to !~ '[[:cntrl:]]')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
    CONSTRAINT oauth_pending_signups_expires_after_created CHECK (expires_at > created_at),
  used_at          timestamptz
    CONSTRAINT oauth_pending_signups_used_after_created CHECK (used_at IS NULL OR used_at >= created_at)
);
CREATE INDEX idx_oauth_pending_signups_expires_at ON oauth_pending_signups (expires_at);

-- Down Migration
DROP TABLE oauth_pending_signups;
DROP TABLE oauth_states;
