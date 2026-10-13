-- Up Migration
-- Registration gets its own per-address window next to the forgot-password one (Phase 3 follow-up of the
-- Phase 2 review): `register_address` rows are keyed by the same keyed pseudonym of the truncated client
-- address, under their own scope so the budgets never mix. The admit function is scope-agnostic.
ALTER TABLE auth_throttle DROP CONSTRAINT auth_throttle_scope_known;
ALTER TABLE auth_throttle ADD CONSTRAINT auth_throttle_scope_known
  CHECK (scope IN ('login_email', 'login_address', 'forgot_address', 'register_address'));

-- Down Migration
DELETE FROM auth_throttle WHERE scope = 'register_address';
ALTER TABLE auth_throttle DROP CONSTRAINT auth_throttle_scope_known;
ALTER TABLE auth_throttle ADD CONSTRAINT auth_throttle_scope_known
  CHECK (scope IN ('login_email', 'login_address', 'forgot_address'));
