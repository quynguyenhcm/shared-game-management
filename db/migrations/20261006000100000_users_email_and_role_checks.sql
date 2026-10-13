-- Up Migration
-- auth-and-user-roles, Phase 1: database invariants for the account model (P1). Design: algorithm doc
-- "Schema implications" and architecture doc "Schema shapes".

-- users: normal-form email (S1-b: ASCII printable, no space, exactly one "@", lowercase, <= 254), TEAM_ADMIN is
-- per-team only (the enum value stays: removing an enum value is a costly migration), and an informational
-- inbox-proof timestamp.
ALTER TABLE users
  ADD COLUMN email_verified_at timestamptz,
  ADD CONSTRAINT users_email_normalised
    CHECK (email = lower(email) AND email ~ '^[!-?A-~]+@[!-?A-~]+$' AND char_length(email) <= 254),
  ADD CONSTRAINT users_role_not_team_admin CHECK (role <> 'TEAM_ADMIN'),
  ADD CONSTRAINT uq_users_id_email UNIQUE (id, email);   -- target of the PASSWORD-subject FK below

-- auth_identities: one identity per method per user; the PASSWORD subject is the user's normalised email.
-- password_email is NULL for OAuth rows, so MATCH SIMPLE skips the FK for them. PostgreSQL forbids
-- ON UPDATE CASCADE on a generated column, so an email change must move users.email and the identity subject in
-- one transaction after SET CONSTRAINTS fk_auth_identities_password_email DEFERRED (hence DEFERRABLE).
ALTER TABLE auth_identities
  ADD CONSTRAINT uq_auth_identities_user_provider UNIQUE (user_id, provider),
  ADD CONSTRAINT auth_identities_password_subject_lowercase
    CHECK (provider <> 'PASSWORD' OR provider_subject = lower(provider_subject)),
  ADD COLUMN password_email varchar(255)
    GENERATED ALWAYS AS (CASE WHEN provider = 'PASSWORD' THEN provider_subject END) STORED;

ALTER TABLE auth_identities
  ADD CONSTRAINT fk_auth_identities_password_email
    FOREIGN KEY (user_id, password_email) REFERENCES users (id, email)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;

-- A user can never be left without a sign-in method. Deferred to COMMIT so a transaction may swap methods (the
-- password-reset path deletes Google/Facebook and upserts PASSWORD). The user row lock serialises two concurrent
-- disconnects: the second COMMIT re-counts after the first committed and fails. FOR NO KEY UPDATE does not block
-- the FOR KEY SHARE locks that session and token inserts take on users. When the user row is gone (cascade delete
-- of a whole account) there is nothing to protect.
CREATE FUNCTION auth_identities_enforce_last_method() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM users WHERE id = OLD.user_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth_identities WHERE user_id = OLD.user_id) THEN
    RAISE EXCEPTION 'user % must keep at least one sign-in method', OLD.user_id
      USING ERRCODE = '23514', CONSTRAINT = 'auth_identities_last_method';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER auth_identities_last_method
  AFTER DELETE ON auth_identities
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION auth_identities_enforce_last_method();

-- Down Migration
DROP TRIGGER auth_identities_last_method ON auth_identities;
DROP FUNCTION auth_identities_enforce_last_method();
ALTER TABLE auth_identities DROP CONSTRAINT fk_auth_identities_password_email;
ALTER TABLE auth_identities DROP COLUMN password_email;
ALTER TABLE auth_identities
  DROP CONSTRAINT auth_identities_password_subject_lowercase,
  DROP CONSTRAINT uq_auth_identities_user_provider;
ALTER TABLE users
  DROP CONSTRAINT uq_users_id_email,
  DROP CONSTRAINT users_role_not_team_admin,
  DROP CONSTRAINT users_email_normalised,
  DROP COLUMN email_verified_at;
