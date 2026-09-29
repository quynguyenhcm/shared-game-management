-- Up Migration
CREATE TABLE users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- core gen_random_uuid(); uuid-ossp is not used
  email      varchar(255) UNIQUE NOT NULL,
  full_name  varchar(255) NOT NULL,
  sex        user_sex NOT NULL,
  role       global_role NOT NULL DEFAULT 'PLAYER',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Gap fix (AC-VERIFY-6): one row per sign-in method. PASSWORD carries the encoded hash
-- (argon2id/bcrypt; hashing belongs to auth-and-user-roles); GOOGLE/FACEBOOK carry the provider's
-- subject ID. provider_subject for PASSWORD is the normalised sign-in email.
CREATE TABLE auth_identities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider         auth_provider NOT NULL,
  provider_subject varchar(255) NOT NULL,
  password_hash    varchar(512),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz,
  CONSTRAINT uq_auth_identities_provider_subject UNIQUE (provider, provider_subject),
  CONSTRAINT auth_identities_password_hash_iff_password
    CHECK ((provider = 'PASSWORD') = (password_hash IS NOT NULL))
);
CREATE INDEX idx_auth_identities_user ON auth_identities (user_id);

-- Down Migration
DROP TABLE auth_identities;
DROP TABLE users;
