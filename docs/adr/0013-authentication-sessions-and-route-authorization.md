# ADR 0013: Authentication, sessions and route authorization

- Status: Accepted (2026-10-06)
- Task: auth-and-user-roles
- Source: [architecture Q1, Q2, Q5, Q6, Q8](../../memory-bank/creative/auth-and-user-roles-architecture.md)

## Context

Players register and sign in with email and password, Google or Facebook. The API must know who is calling and which global or per-team role they hold, and every later feature builds on that. Constraints: the web is the only public origin in production (ADR 0007), `users` and `auth_identities` already exist with strict constraints (ADR 0003), and the feature has to be testable end to end without real Google or Facebook credentials.

## Decision

- **Own Fastify module, not a framework (Q1).** `apps/api/src/modules/auth/` owns registration, sign-in, sessions, reset and OAuth orchestration on the existing schema. Passwords use argon2id from `node:crypto` (Node 24.7 or newer; m=64 MiB, t=3, p=1, PHC strings, a known-answer self-test at boot, at most 2 concurrent hashes). Google and Facebook use thin adapters over an injected `fetch` with a 5 s timeout, plus `jose` to verify Google ID tokens (issuer, audience, expiry, nonce) and PKCE S256 for Google. Facebook sends `appsecret_proof` and a pinned Graph version (`GRAPH_VERSION` in `facebook.ts`, refresh within two years). No provider token is stored or logged.
- **Opaque Postgres sessions, web-owned cookie, bearer to the API (Q2).** The token is 32 random bytes, only its SHA-256 is stored. Sessions expire after 7 idle days (extended at most once an hour) and 30 absolute days; the role is read from `users` on every request, so a role change applies at once. The web sets `sgm_session` (`__Host-` prefixed and Secure when `WEB_BASE_URL` is https), `HttpOnly`, `SameSite=Lax`, and calls the API with `Authorization: Bearer`. The API never sets a cookie. CSRF defence: `SameSite=Lax`, Next's Server Action origin check (`serverActions.allowedOrigins` from `WEB_BASE_URL`), `proxy.ts` and the API each refuse a foreign `Origin` on mutating requests.
- **Authenticated web-to-API hop.** The web derives the client address only from the `WEB_TRUSTED_PROXY_HOPS`-th `X-Forwarded-For` entry from the right and sends it as `x-sgm-client-ip` together with `x-sgm-internal-auth` (`API_INTERNAL_SHARED_SECRET`, compared in constant time). The API ignores the address without the secret and never falls back to `request.ip`. Production refuses to boot without the secret and the hop count.
- **Declarative default-deny route policy (Q5).** Every route declares `public`, `optionalSession`, `authenticated`, `globalRole` or `teamRole` in `config.policy`. `registerAuthPlatform` hooks `onRoute`: a route without a policy fails `buildApp`, and the policy adds the hooks and the OpenAPI `sessionToken` bearer requirement. `GLOBAL_ADMIN` passes a team guard only with `allowGlobalAdmin: true`. The team role comes from `team_members` (`status = 'APPROVED'`), read on every request. `users.role` is limited to `GLOBAL_ADMIN` and `PLAYER` by a CHECK; `TEAM_ADMIN` exists only per team.
- **Web-owned OAuth callback with single-use Postgres state (Q6).** `/auth/callback/[provider]` is a web route handler. `oauth_states` and `oauth_pending_signups` rows are consumed by a guarded `UPDATE ... WHERE used_at IS NULL AND expires_at > $now RETURNING`, so a replay does nothing. A browser-binding cookie `sgm_oauth` (`<state>.<ctx>`, at most 1024 bytes) is compared with the query `state` in constant time before the API is called. The PKCE verifier is stored encrypted (AAD-bound to its row). No `users` row exists until the visitor has chosen a sex on `/register/complete`.
- **Env-selected fake provider (Q8).** `AUTH_FAKE_OAUTH=true` swaps in fake Google and Facebook adapters that parse the same recorded fixtures as the real adapters' unit tests. The config and the registry both refuse it in production. Playwright answers the reserved host `oauth.fake.invalid` with a redirect to the web callback carrying a `fake.<payload>` code.
- **One shared contract.** The zod schemas in `packages/shared/src/api/{auth,errors}.ts` are used by the Fastify routes, the web `api-client` and the OpenAPI generator. Errors are `{ error: { code, message, fieldErrors? } }` with one authoritative `ErrorCode` list. `apps/api/openapi.yaml` documents the bearer scheme and is drift-tested.

## Alternatives considered

- **Better Auth** (Kysely adapter mounted in Fastify). Batteries included, but its `user`, `session`, `account` model fights our constraints and enums, it creates the user at the OAuth callback (we must defer it until sex is chosen), it owns the HTTP surface and cookies (conflicts with the web-only origin, the default-deny registry and the OpenAPI drift test), and its default hasher is scrypt.
- **Auth.js (next-auth) in the web app.** The web would own sessions and the API would have to trust a signed token or re-verify against a shared table. v5 never left beta; the project is in maintenance.
- **Lucia-style libraries / `arctic`.** Lucia is deprecated in favour of writing the same session code; `arctic` would add a dependency for two small adapters we need to test with our own fixtures anyway.
- **`@node-rs/argon2` or `argon2`.** A native addon in the slim image. Kept only as a fallback if `node:crypto` argon2 is unavailable (the boot self-test would flag it).
- **Stateless signed tokens (JWT) for sessions.** Cannot be revoked on logout or password reset and would carry a role claim that goes stale.
- **A cookie the API sets directly.** Needs the API to be a public origin; the web-only origin constraint makes the relay simpler and keeps the API immune to browser CSRF.
- **Imperative per-route `preHandler` checks.** A forgotten check is a hole; the `onRoute` registry makes it a boot failure.

## Consequences

- We maintain security-sensitive code (tokens, PKCE, state, ID token checks). The surface is small and covered by recorded fixtures, tampered-token tests, the log-hygiene test and the browser journeys.
- No MFA, passkeys, session list or "remember me" in v1.
- Every downstream feature declares a policy on each route and reads `request.auth.userId`; a route without one does not boot.
- `WEB_BASE_URL` is baked into the web build (Server Action `allowedOrigins`): each environment needs its own web image (build arg), and the server refuses to boot when the runtime host differs. See [getting started](../getting-started.md#web-build-argument-per-environment).
- No metrics exporter exists yet, so these names are reserved for the metrics feature (low-cardinality labels only, never a user, session, team or email): `sgm_auth_logins_total{provider, outcome}`, `sgm_auth_registrations_total{provider}`, `sgm_auth_password_hash_duration_seconds`, `sgm_auth_oauth_callbacks_total{provider, outcome}`, `sgm_auth_sessions_revoked_total{reason}`, `sgm_auth_authz_denied_total{policy, status}`.
- Manual pre-release item: a smoke test with real Google and Facebook credentials (the only part CI cannot cover).
