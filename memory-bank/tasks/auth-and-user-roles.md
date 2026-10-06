---
slug: auth-and-user-roles
legacy_id:
feature: auth-and-user-roles
status: PLANNING_COMPLETE
---

# auth-and-user-roles: Auth and User Roles

**Complexity**: Level 3 (inherited from auth-and-user-roles)
**Status**: PLANNING_COMPLETE
**Roadmap**: auth-and-user-roles
**Branch**: feature/auth-and-user-roles
**Worktree**: ~/yay-wt/shared-game-management/feature-auth-and-user-roles
**Base**: feature/platform-foundation (stacked; origin/main is still at the initial commit because GitHub push is blocked with a 403)

## Task Description

Self-registration and sign-in with email/password, Google OAuth and Facebook OAuth (PRODDUCT-OVERVIEW §1).

- Required sex selection (`MALE`, `FEMALE`, `OTHER`) at registration, including for first-time OAuth users
- Global roles `GLOBAL_ADMIN`, `PLAYER`; `TEAM_ADMIN` is scoped per team via team membership
- Session management, password reset, route/API authorization guards (global role + per-team role)

**Depends on**: platform-foundation

---

## Specification

**Feature Type**: End-User Feature
**Primary Persona**: Player (`PLAYER`): signs up in under a minute, picks a sex once, and gets into the app by email/password, Google or Facebook. Secondary: Global Admin (`GLOBAL_ADMIN`) and Team Admin (per-team role), who depend on the authorization guards this feature delivers.
**Creative Exploration Needed**: Yes: auth library vs hand-rolled; session strategy and web/API cookie relay; OAuth email-conflict and linking rules (and whether email verification is in scope); Facebook without an email; RBAC guard design; OAuth redirect topology and where short-lived OAuth state lives (see the Creative Exploration Needed section below).

*Note: this feature also delivers cross-cutting infrastructure (the authentication and authorization guards every later feature builds on). Those structural and security checks are written as `AC-VERIFY` and `AC-INTEGRATION` criteria inside this End-User spec.*

*Basis for this draft*: read from the stacked worktree (platform-foundation + this task), not `main`. Findings that shape the spec:
- `users` and `auth_identities` already exist (`db/migrations/20260929000200000_users_and_auth_identities.sql`): `users.sex user_sex NOT NULL`, `users.role global_role NOT NULL DEFAULT 'PLAYER'`, `users.email varchar(255) UNIQUE` (case-sensitive), `auth_identities(provider, provider_subject, password_hash)` with `UNIQUE(provider, provider_subject)` and `CHECK ((provider='PASSWORD') = (password_hash IS NOT NULL))`. `team_members(role team_role, status membership_status)` exists with `UNIQUE(team_id, user_id)`.
- **Gaps** this feature must close with new migrations: no sessions table, no password-reset token table, no case-insensitive email guarantee, and the `global_role` enum still carries the draft's `TEAM_ADMIN` value although TEAM_ADMIN is per-team only.
- The HTTP process (`apps/api/src/main.ts`, `buildApp(deps)` in `apps/api/src/app.ts`) currently has only `logger`, `version` and `checkDb`. Auth needs a Kysely handle, a job-runner **producer** (the reset email goes through `enqueueEmail` in `apps/api/src/jobs/send-email.ts`, P5) and auth config injected the same way.
- `apps/web` has only `layout.tsx`, `page.tsx` and `src/lib/api-client.ts` (which exposes `health()` only). The web talks to the API only server-side through `API_INTERNAL_URL`, and it is the only public origin in production (hosting constraints C5/C6).
- No shared HTTP error shape exists yet. The risk table in the platform-foundation architecture says this feature "sets the reference implementation" for module shape.

### Invocation Method
- **Location**: Web app (Next.js App Router, `apps/web/src/app/`). New public pages: `/register`, `/register/complete`, `/login`, `/forgot-password`, `/reset-password`. New protected page: `/account`. Provider callbacks land on `/auth/callback/google` and `/auth/callback/facebook` (Next route handlers that finish the OAuth exchange with the API and redirect). API (Fastify, `apps/api/src/modules/auth/`): `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `GET /auth/providers`, `POST /auth/password/forgot`, `POST /auth/password/reset`, `POST /auth/oauth/:provider/authorize`, `POST /auth/oauth/:provider/callback`, `POST /auth/oauth/complete`, `GET /auth/identities`, `POST /auth/identities/:provider/link`, `DELETE /auth/identities/:provider`. Operator: `pnpm --filter @sgm/api exec tsx --env-file-if-exists=../../.env src/cli.ts users set-role <email> <GLOBAL_ADMIN|PLAYER>`.
- **Element**: A new `SiteHeader` (`apps/web/src/components/site-header.tsx`, mounted in `apps/web/src/app/layout.tsx`) with links "Sign in" and "Create account" when signed out, and the user's name, an "Account" link and a "Sign out" button when signed in. Page controls: buttons "Create account", "Sign in", "Continue with Google", "Continue with Facebook", "Finish sign-up", "Send reset link", "Set new password"; link "Forgot your password?". Sex field: radio group labelled "Sex" with options Male, Female, Other (`MALE`, `FEMALE`, `OTHER`), none preselected.
- **Visibility**: Header links always visible. "Continue with Google/Facebook" render only when that provider is enabled (`GET /auth/providers`, driven by env credentials). `/account` and any future protected page require a session. `/login` and `/register` redirect to `/` when already signed in.
- **Navigation**: `/` (home, `apps/web/src/app/page.tsx`) → header "Create account" → `/register`, or "Sign in" → `/login` → "Forgot your password?" → `/forgot-password` → email link → `/reset-password?token=…`. Any protected route without a session → `/login?returnTo=<path>`. Post-auth landing is `returnTo` (validated) or `/`; the player dashboard does not exist until the `player-dashboard` feature.
- **Confidence**: MEDIUM. Page and endpoint names are HIGH (greenfield, no existing auth pattern to conflict with, derived from the productBrief onboarding flow). The session cookie relay between web and API, the OAuth redirect topology and the library choice are LOW and listed under Creative Exploration Needed.

### Success Criteria
- **User sees**: After registering or signing in, the browser lands on `/` (or the validated `returnTo`) with the header showing "Signed in as {fullName}" and a "Sign out" button. After a first-time OAuth sign-in the user first sees `/register/complete` (Sex required, name prefilled), then the signed-in state. After a reset, "Password updated. Sign in with your new password." on `/login`.
- **Verifiable at**: `GET /auth/me` returns `{ user: { id, email, fullName, sex, role } }` with a valid session and `401 { error: { code: 'unauthenticated' } }` without one; the header on any page; Mailpit (`MAILPIT_API_URL`, UI `http://localhost:8025`) for the reset email; DB rows below; `pgboss.job` for the `send-email` job.
- **Data persisted**: `users` (`email` lowercase, `full_name`, `sex`, `role='PLAYER'`), `auth_identities` (`provider`, `provider_subject` = normalised email for PASSWORD or the provider's stable subject ID, `password_hash` argon2id PHC string only for PASSWORD, `last_used_at`), new `auth_sessions` (user, SHA-256 of the opaque token, created/last-seen/expires/revoked timestamps, user agent), new `password_reset_tokens` (user, SHA-256 of token, expires, used timestamp), plus short-lived OAuth state and pending-signup records in Postgres (table shape decided in creative). New migrations are reversible and each new table or column is added to `db/schema-deviations.md`.
- **Observable within**: Immediate for register, login, logout and guards. Reset email is async: visible in Mailpit within 30 s of the request while the worker runs. Expired sessions, tokens and pending records disappear within one day via the scheduled cleanup job.

### Acceptance Criteria

**Entry points**

#### AC-ENTRY-1: Anonymous visitor can find Create account and Sign in from every page
**Priority**: MUST
**Given** a visitor without a session
**When** they open `/` or any public page
**Then** the header shows links "Sign in" (→ `/login`) and "Create account" (→ `/register`), keyboard-focusable and with visible labels

#### AC-ENTRY-2: Login page offers all three sign-in methods
**Priority**: MUST
**Given** Google and Facebook credentials are configured
**When** the visitor opens `/login`
**Then** they see Email and Password fields, a "Sign in" button, a "Forgot your password?" link, and "Continue with Google" and "Continue with Facebook" buttons; with a provider unconfigured, only that provider's button is absent

#### AC-ENTRY-3: Register page requires an explicit sex choice
**Priority**: MUST
**Given** a visitor on `/register`
**When** the page renders
**Then** it shows Full name, Email, Password, a required "Sex" radio group (Male, Female, Other) with nothing preselected, a "Create account" button and the enabled OAuth buttons; the form cannot be submitted until a sex option is chosen

#### AC-ENTRY-4: Protected pages send anonymous visitors to sign in and bring them back
**Priority**: MUST
**Given** a visitor with no valid session
**When** they open `/account`
**Then** they are redirected to `/login?returnTo=%2Faccount`, and after a successful sign-in they land on `/account`

#### AC-ENTRY-5: Signed-in state is visible and auth pages are skipped
**Priority**: MUST
**Given** a signed-in user
**When** they open any page, or open `/login` or `/register`
**Then** the header shows their name, an "Account" link and a "Sign out" button, and `/login` and `/register` redirect to `/`

#### AC-ENTRY-6: Forgot-password is reachable from the login page
**Priority**: MUST
**Given** a visitor on `/login`
**When** they click "Forgot your password?"
**Then** `/forgot-password` shows an Email field and a "Send reset link" button

**Happy paths**

#### AC-HAPPY-1: Player registers with email and password
**Priority**: MUST
**Given** a visitor on `/register`
**When** they enter Full name "Aroha Ngata", Email "Aroha.Ngata@Example.com", a password of at least 10 characters, choose Female, and click "Create account"
**Then** `POST /auth/register` returns 201; `users` has one row with `email='aroha.ngata@example.com'`, `sex='FEMALE'`, `role='PLAYER'`; `auth_identities` has one `PASSWORD` row whose `password_hash` starts with `$argon2id$`; an `auth_sessions` row exists; the browser has the session cookie and lands on `/` showing "Signed in as Aroha Ngata"

#### AC-HAPPY-2: Player signs in with email and password
**Priority**: MUST
**Given** a registered user with a PASSWORD identity
**When** they sign in on `/login` with their email in any letter case and the correct password
**Then** a new `auth_sessions` row and cookie are issued, `auth_identities.last_used_at` is updated, and they land on the validated `returnTo` or `/`

#### AC-HAPPY-3: First-time Google user completes sign-up with a required sex choice
**Priority**: MUST
**Given** a visitor with a Google account whose email is verified and not yet registered
**When** they click "Continue with Google", approve consent, and on `/register/complete` choose a sex and click "Finish sign-up"
**Then** only now are `users` (role `PLAYER`, chosen `sex`, name from Google, editable on that page) and a `GOOGLE` `auth_identities` row (`provider_subject` = Google `sub`, no password hash) created, a session is issued, and they land on `/`; no `users` row exists before that submit

#### AC-HAPPY-4: First-time Facebook user completes sign-up with a required sex choice
**Priority**: MUST
**Given** a visitor with a Facebook account that shares an email address and is not yet registered
**When** they click "Continue with Facebook", approve consent, and complete `/register/complete`
**Then** a `users` row and a `FACEBOOK` `auth_identities` row (`provider_subject` = Facebook user id) are created with the chosen sex, a session is issued, and they land on `/`

#### AC-HAPPY-5: Returning OAuth user signs in without being asked for sex again
**Priority**: MUST
**Given** a user who already has a `GOOGLE` or `FACEBOOK` identity
**When** they click the matching "Continue with …" button and approve
**Then** they are signed in directly (no `/register/complete`), `last_used_at` is updated, and no duplicate `users` or `auth_identities` row is created

#### AC-HAPPY-6: Player resets a forgotten password
**Priority**: MUST
**Given** a registered user who requested a reset on `/forgot-password`
**When** they open the emailed link, enter a new valid password on `/reset-password` and click "Set new password"
**Then** the password hash is replaced, the token is marked used, every existing session of that user is revoked, they are sent to `/login` with "Password updated. Sign in with your new password.", the new password signs in and the old one no longer does

#### AC-HAPPY-7: Player signs out and the session really ends
**Priority**: MUST
**Given** a signed-in user
**When** they click "Sign out"
**Then** `POST /auth/logout` returns 204, the `auth_sessions` row is marked revoked, the cookie is cleared, the header returns to "Sign in" and "Create account", and replaying the old cookie on `GET /auth/me` returns 401

#### AC-HAPPY-8: Global role guard separates GLOBAL_ADMIN from PLAYER
**Priority**: MUST
**Given** two signed-in users, one `PLAYER` and one `GLOBAL_ADMIN`, and a route protected by `requireGlobalRole('GLOBAL_ADMIN')`
**When** each calls it
**Then** the PLAYER gets 403 `forbidden` and the GLOBAL_ADMIN gets 200; after the admin's role is set back to `PLAYER` in the database, their very next request gets 403 (role is read from the database on every request, not cached in the session)

#### AC-HAPPY-9: Team role guard is scoped to the team and to approved membership
**Priority**: MUST
**Given** a user with `team_members` rows `(team A, role TEAM_ADMIN, status APPROVED)` and `(team B, role MEMBER, status APPROVED)`, and routes protected by `requireTeamRole('TEAM_ADMIN')` taking the team id from `:teamId`
**When** they call the team-admin route for team A, then for team B, then for an unrelated team C
**Then** team A returns 200, team B returns 403, team C returns 403; being `GLOBAL_ADMIN` does not pass the team-admin guard unless the route explicitly opts in with `allowGlobalAdmin: true`

#### AC-HAPPY-10: Operator can create the first GLOBAL_ADMIN
**Priority**: MUST
**Given** a registered user and database access through the CLI
**When** the operator runs `users set-role <email> GLOBAL_ADMIN`
**Then** `users.role` is `GLOBAL_ADMIN`, the command prints the user id and new role (no secrets), exits 0, and the user's existing session sees the new role on its next request; an unknown email exits non-zero with a clear message and changes nothing; `TEAM_ADMIN` is rejected as a role argument

#### AC-HAPPY-11: Signed-in user can connect a second sign-in method
**Priority**: SHOULD
**Given** a signed-in user on `/account` ("Sign-in methods" list showing Email and password, Google, Facebook with Connected / Not connected)
**When** they click "Connect Google" and complete the Google consent as the same human
**Then** a `GOOGLE` `auth_identities` row is added to their existing user (no new `users` row) and later "Continue with Google" signs them into that same user

#### AC-HAPPY-12: Signed-in user can disconnect a method but never the last one
**Priority**: COULD
**Given** a user with two connected sign-in methods on `/account`
**When** they click "Disconnect" on one
**Then** that identity row is removed; with only one method left, "Disconnect" is disabled and `DELETE /auth/identities/:provider` returns 409 `last_sign_in_method`

**Errors and recovery**

#### AC-ERROR-1: Duplicate email is rejected and the form is preserved
**Priority**: MUST
**Given** a user already exists for `aroha.ngata@example.com`
**When** a visitor registers with `AROHA.NGATA@example.com`
**Then** the API returns 409 `email_taken`, the page shows "An account with this email already exists." with links to sign in and reset the password, Full name and Email stay filled (password is cleared), and no second `users` or `auth_identities` row exists

#### AC-ERROR-2: Invalid registration input names the field and keeps what was typed
**Priority**: MUST
**Given** a visitor on `/register`
**When** they submit without a sex ("Select your sex to continue."), with a malformed email ("Enter a valid email address."), or with a password shorter than 10 or longer than 128 characters ("Use at least 10 characters.")
**Then** the API returns 422 `validation_failed` with `fieldErrors` per field, each message is shown beside its field and linked with `aria-describedby`, nothing is created, and a request body containing `role` or any unknown field is rejected (a client can never self-assign `GLOBAL_ADMIN`)

#### AC-ERROR-3: Wrong credentials give one generic answer
**Priority**: MUST
**Given** a visitor on `/login`
**When** they submit an unknown email, or a known email with the wrong password, or the password for an account that only has Google/Facebook identities
**Then** all three return the same 401 `invalid_credentials` body and show "Incorrect email or password." with no session created and no hint which part was wrong

#### AC-ERROR-4: Repeated failed sign-ins are throttled
**Priority**: MUST
**Given** 5 failed sign-in attempts for one email within 15 minutes (the same limit applies per client address across emails)
**When** a 6th attempt arrives, even with the correct password
**Then** the API returns 429 `too_many_attempts` with a `Retry-After` header, the page shows "Too many sign-in attempts. Try again in {n} minutes.", and the attempt neither verifies the password nor reveals whether the account exists; after the window the correct password works

#### AC-ERROR-5: Invalid, expired or reused reset tokens fail safely
**Priority**: MUST
**Given** a reset link that is expired (older than 60 minutes), already used, malformed, or for a deleted user
**When** the visitor submits a new password
**Then** the API returns 400 `invalid_or_expired_token`, `/reset-password` shows "This reset link is invalid or has expired." with a "Request a new link" link, and the existing password and sessions are unchanged; a new password that fails the length rule returns 422 without consuming the token

#### AC-ERROR-6: Forgot-password never reveals whether an account exists
**Priority**: MUST
**Given** a visitor on `/forgot-password`
**When** they submit an email that has no account
**Then** the API returns the same 202 and the page the same text as for a real account ("If an account exists for that email, we've sent a reset link."), no token and no email job are created, and the response does not differ in shape; a flood of requests for one email is limited to one new email per 60 seconds

#### AC-ERROR-7: OAuth cancellation, bad state and provider outage are recoverable
**Priority**: MUST
**Given** a visitor mid-way through a Google or Facebook sign-in
**When** they deny consent (`error=access_denied`), or the callback has a missing, unknown, expired or already-used `state`, or the provider's token or userinfo call fails or times out
**Then** no session and no `users` row is created, and they return to `/login` with respectively "Google sign-in was cancelled.", "We couldn't verify that sign-in attempt. Please try again.", or "Google is unavailable right now. Try again, or sign in with email and password."; a replayed callback URL does nothing the second time

#### AC-ERROR-8: OAuth email that matches an existing account never silently signs in or links
**Priority**: MUST
**Given** an existing user with a PASSWORD (or other provider) identity for `aroha.ngata@example.com`, and a visitor who completes Facebook sign-in returning that same email but no linked Facebook identity
**When** the OAuth callback is processed
**Then** no session is issued and no identity is attached; the visitor sees "An account already exists for aroha.ngata@example.com. Sign in with your existing method, then connect Facebook from your Account page." with a link to `/login`; linking happens only through AC-HAPPY-11 while signed in (conservative default, revisit in creative)

#### AC-ERROR-9: Missing or unverified provider email blocks account creation clearly
**Priority**: MUST
**Given** a Facebook login that returns no email, or a Google login with `email_verified=false`
**When** the callback is processed
**Then** no `users` row is created and the visitor sees, for Facebook, "Facebook didn't share an email address, which we need to create your account. Use Google or email and password instead.", and for Google, "Google says this email address isn't verified. Verify it with Google or use another method."

#### AC-ERROR-10: Disabled provider is hidden and cannot be reached directly
**Priority**: MUST
**Given** Google credentials are not configured
**When** a client calls `POST /auth/oauth/google/authorize` or opens `/auth/callback/google`
**Then** the API returns 404 `provider_not_enabled`, `GET /auth/providers` reports `google: false`, and the login and register pages show no Google button

#### AC-ERROR-11: Missing, expired or insufficient authorization is distinguishable and recoverable
**Priority**: MUST
**Given** a protected API route and a protected web page
**When** the request has no session, an expired or revoked session, or a valid session without the required role
**Then** the API returns 401 `unauthenticated` (no cookie), 401 `session_expired` (expired or revoked) or 403 `forbidden` (valid session, wrong role) using the shared error shape `{ error: { code, message } }`; the web clears a dead cookie and sends the user to `/login` with "Your session has expired. Sign in again." (expired case) and the protected page's `returnTo`

#### AC-ERROR-12: Team membership state controls team-scoped access immediately
**Priority**: MUST
**Given** a user whose `team_members.status` for team A is `PENDING`, `REJECTED` or `BANNED`, or who has no row for team A
**When** they call any `requireTeamRole` route for team A (MEMBER or TEAM_ADMIN)
**Then** the API returns 403 `forbidden`; changing the row to `APPROVED` or to `BANNED` takes effect on the next request with no re-login

#### AC-ERROR-13: `returnTo` cannot be used as an open redirect
**Priority**: MUST
**Given** `/login?returnTo=https://evil.example/` or `returnTo=//evil.example` or `returnTo=/\evil`
**When** the user signs in
**Then** the value is ignored and they land on `/`; only a same-origin path starting with a single `/` is honoured

#### AC-ERROR-14: Abandoned or expired OAuth sign-up leaves nothing behind
**Priority**: MUST
**Given** a first-time OAuth user on `/register/complete` who walks away, or whose pending sign-up is older than 15 minutes
**When** they submit the form or reload after expiry
**Then** no user is created; they are redirected to `/login` with "Your sign-up session expired. Please start again."; submitting without a sex returns 422 and keeps the pending sign-up valid until its expiry

#### AC-ERROR-15: Cross-site state-changing requests are refused
**Priority**: MUST
**Given** a signed-in user's browser and a page on another origin
**When** that page submits a POST to a web auth action or an API auth route with a foreign `Origin`
**Then** the request is rejected with 403 and has no effect (cookies are `SameSite=Lax` and mutating endpoints also check `Origin`)

**Async behaviour**

#### AC-ASYNC-1: Reset email is sent through the job queue, not inline
**Priority**: MUST
**Given** a registered user requests a reset
**When** `POST /auth/password/forgot` runs
**Then** the API answers 202 without waiting for SMTP; the `password_reset_tokens` row and the `send-email` job (via `enqueueEmail` with the same transaction, `idempotencyKey = password-reset:<tokenId>`, tag `template: password-reset`) commit together, so a job exists only if its token exists; the worker delivers the message and it appears in Mailpit within 30 s

#### AC-ASYNC-2: Reset email delivery failures are retried or surfaced, never lost silently
**Priority**: MUST
**Given** the notifier fails with a transient error, or with a permanent error
**When** the `send-email` job runs
**Then** a transient failure retries with the existing backoff and results in exactly one delivered email; a permanent failure ends the job in `failed` with an error log (`event: notification.failed`), and the user can request a new link, which creates a new token and job

#### AC-ASYNC-3: Expired auth artefacts are cleaned up by a scheduled job
**Priority**: SHOULD
**Given** expired or revoked sessions, expired or used reset tokens, and expired OAuth state or pending-signup rows
**When** the `auth-cleanup` queue runs (new slot in `apps/api/src/jobs/schedules.ts`, daily `0 5 * * *` Pacific/Auckland, outside the 02:00-02:59 DST window)
**Then** only those rows are deleted, active sessions and valid tokens are untouched, and a second immediate run deletes nothing and succeeds

#### AC-ASYNC-4: Session lifetime is observable and bounded
**Priority**: MUST
**Given** a session with an idle limit of 7 days and an absolute limit of 30 days (defaults, configurable)
**When** time is advanced with an injected clock
**Then** use within the idle window extends `expires_at` (never past the absolute cap), a request after 7 idle days or after 30 absolute days returns 401 `session_expired`, and the cookie lifetime matches the server-side expiry

**Structural, security and grounded checks**

#### AC-VERIFY-1: Passwords are hashed with a memory-hard algorithm and never stored or logged in clear
**Priority**: MUST
**Given** the password hasher used by register, reset and login
**When** a hash is produced and verified
**Then** the stored value is an argon2id PHC string (`$argon2id$…`, at most 512 characters, parameters at or above the OWASP minimum), verification works across a parameter upgrade (`needsRehash`), and a single hash takes between 50 ms and 1 s on the CI runner

#### AC-VERIFY-2: Session and reset tokens are random, stored hashed, and carried safely
**Priority**: MUST
**Given** a freshly issued session token and a reset token
**When** the database and the response headers are inspected
**Then** each token is at least 256 bits from `crypto.randomBytes`; only its SHA-256 appears in the database (no plaintext column); the cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `NODE_ENV=production` (host-prefixed name there), and never readable by JavaScript; the `/reset-password` page responds with `Referrer-Policy: no-referrer`

#### AC-VERIFY-3: Every route has an explicit authorization policy (default deny)
**Priority**: MUST
**Given** the fully built Fastify app
**When** a unit test enumerates every registered route
**Then** each declares one policy (`public`, `authenticated`, `globalRole`, `teamRole`) and the app refuses to boot or the test fails if a route has none; `/health` and the public auth endpoints are declared `public`, and a protected route called without its policy's credentials is denied by default

#### AC-VERIFY-4: The RBAC model is enforced in the database and read fresh on each request
**Priority**: MUST
**Given** the migrated schema
**When** a raw insert or update sets `users.role = 'TEAM_ADMIN'`
**Then** it fails with SQLSTATE 23514 (new CHECK), the shared type used by auth code exposes only `GLOBAL_ADMIN` and `PLAYER` as assignable, a team role is derived only from `team_members.role = 'TEAM_ADMIN' AND status = 'APPROVED'`, and the session carries no role claim

#### AC-VERIFY-5: Schema changes are reversible, ledgered and drift-checked
**Priority**: MUST
**Given** the new migrations (sessions, reset tokens, OAuth state or pending sign-ups, email-lowercase CHECK, role CHECK)
**When** `pnpm run test:integration` runs
**Then** the migrate / `rollback --all` / migrate round trip yields an identical schema, `db/schema-deviations.md` has an entry (D-27 onwards) for every new object with a Source, the committed `types.generated.ts` matches codegen, any new enum is mirrored in `packages/shared/src/types/enums.ts`, and a raw `INSERT INTO users … email='A@B.com'` fails with 23514

#### AC-VERIFY-6: Auth flows leave no secrets in logs
**Priority**: MUST
**Given** the log capture helper (`apps/api/test/helpers/log-capture.ts`) wrapping the logger
**When** register, login (success and failure), logout, forgot, reset and the OAuth callback all run
**Then** no log line contains a password, session token, reset token, OAuth `code`, `state`, access token, client secret or `Set-Cookie` value; the OAuth `code` and `state` query parameters are masked in request logs (default `LOG_REDACT_PATTERNS` extended); failed sign-ins log `event: auth.login.failed` with a reason code and no email address; successes log `auth.login.succeeded` with `userId` and `provider`; every line carries `traceId`

#### AC-VERIFY-7: Auth configuration is validated at boot with no secret leakage
**Priority**: MUST
**Given** the zod environment schema in `apps/api/src/lib/config/config.ts`
**When** the app boots with a half-configured provider (client id without secret, or the reverse), a non-http(s) `WEB_BASE_URL`, an out-of-range TTL, or fake-OAuth mode with `NODE_ENV=production`
**Then** it exits 1 before binding a port with `Invalid configuration: <VAR> — …` naming the variable but never its value; a provider with neither variable is simply disabled; `.env.example` and `docs/getting-started.md` list every new variable (`WEB_BASE_URL`, `GOOGLE_OAUTH_CLIENT_ID/_SECRET`, `FACEBOOK_OAUTH_APP_ID/_SECRET`, session and reset TTLs)

#### AC-VERIFY-8: Web and API share one contract and the OpenAPI document stays in sync
**Priority**: MUST
**Given** the zod schemas in `packages/shared/src/api/auth.ts` and `errors.ts`
**When** the unit tests and `pnpm run openapi` run
**Then** both Fastify routes and `apps/web/src/lib/api-client.ts` use those schemas, request schemas are strict, `apps/api/openapi.yaml` regenerates with no diff (`openapi.test.ts`) and documents the cookie security scheme and the 401/403/409/422/429 responses

#### AC-VERIFY-9: Auth code meets the coverage and CI gates
**Priority**: SHOULD
**Given** the project gates in `vitest.config.ts`
**When** `pnpm run ci` runs
**Then** lint, typecheck, unit, integration and build pass and `apps/api/src/modules/auth/**` is added to the 80% coverage threshold list

#### AC-VERIFY-10: Unknown-account sign-in costs the same as a known one
**Priority**: SHOULD
**Given** a login attempt for an email with no account
**When** the login service runs
**Then** it performs a verification against a fixed dummy hash (asserted with an injected hasher spy), so response time does not reveal whether the email is registered

#### AC-INTEGRATION-1: Reset email is really delivered over SMTP and the link works once
**Priority**: MUST
**Given** `NOTIFIER_ADAPTER=smtp` against Mailpit with the worker running
**When** a reset is requested for a real user
**Then** Mailpit's API (`MAILPIT_API_URL`) shows one message to that address with subject "Reset your Shared Game Management password", a text body stating the 60-minute expiry and "If you didn't request this, ignore this email.", and a link starting with `WEB_BASE_URL/reset-password?token=`; following it once resets the password and a second use fails

#### AC-INTEGRATION-2: Register, sign in, read self, sign out run against real Postgres
**Priority**: MUST
**Given** a per-file cloned test database (`createTestDatabase()`) and the real `buildApp` with the `memory` notifier and a fake OAuth provider
**When** `app.inject` drives register → `GET /auth/me` → logout → login → team-guard routes
**Then** each step passes and the `users`, `auth_identities`, `auth_sessions`, `password_reset_tokens` and `team_members` rows match the expected values (no mocked database)

#### AC-INTEGRATION-3: Provider adapters parse real provider payloads
**Priority**: MUST
**Given** recorded fixtures of genuine Google (ID token claims `sub`, `email`, `email_verified`, `name`) and Facebook (Graph `/me?fields=id,name,email`) token and profile responses, including the no-email and unverified cases
**When** the adapters' unit tests run
**Then** `provider_subject`, email, verification flag and name are extracted correctly, and the adapters reject a tampered ID token, wrong audience or expired token; a one-time manual smoke test against the real apps is recorded in the task's execution notes (see Implementation Guide Required)

#### AC-INTEGRATION-4: Web and API work together end to end with trace propagation
**Priority**: MUST
**Given** the Compose stack and Playwright (`apps/web/e2e/auth.spec.ts`, run by `pnpm run test:e2e`)
**When** a user registers through the UI, signs out, signs in, requests a reset, follows the Mailpit link and signs in with the new password
**Then** every step succeeds in the browser, and the API log line for `POST /auth/login` carries the same `traceId` as the web request's `traceparent`; first-time OAuth through the fake provider ends on `/register/complete` then signed in

#### AC-INTEGRATION-5: Races on registration and reset tokens resolve to one winner
**Priority**: MUST
**Given** a dedicated cloned database and a pool larger than the parallelism
**When** 20 concurrent registrations use the same email in different letter cases, and 20 concurrent resets consume the same token
**Then** exactly one registration returns 201 and the rest 409 `email_taken` (backed by the unique constraint, SQLSTATE 23505, not an application check), and exactly one reset succeeds (guarded `UPDATE … WHERE used_at IS NULL AND expires_at > now() RETURNING`)

### Scope Boundaries
- **In scope**:
  - Registration and sign-in by email/password, Google OAuth and Facebook OAuth; required sex selection for password and first-time OAuth users; password reset by email; opaque server-side sessions with logout, idle and absolute expiry; connect and disconnect sign-in methods on `/account`.
  - Global roles `GLOBAL_ADMIN` and `PLAYER`, the CLI to grant them, and API guards `authenticate`, `requireGlobalRole`, `requireTeamRole` (team role read from `team_members`), with default-deny route policy; matching web helpers (`getCurrentUser()`, `requireUser()`, request-interception redirect for protected pages).
  - New migrations (sessions, reset tokens, OAuth state/pending sign-ups, lowercase-email CHECK, no-TEAM_ADMIN-global CHECK), shared zod contracts and the shared API error shape, `SiteHeader`, `apiClient` auth methods that forward cookies and `traceparent`, config variables, `auth-cleanup` job, OpenAPI regeneration, docs updates (`docs/getting-started.md`, ADR for auth, `systemPatterns.md` auth pattern).
- **Out of scope**:
  - Email verification at registration (consequence: unverified password emails, hence no automatic account linking; see creative); MFA/TOTP and passkeys; "remember me" toggle; device and session list UI; "sign out everywhere" beyond revoking on password reset (COULD if cheap); change-password while signed in (use the reset flow); editing name, email or sex after sign-up; account deletion or anonymisation (financial rows are `ON DELETE RESTRICT`, D-15); admin user-management UI (CLI only); team creation, joining, TEAM_ADMIN assignment and ban handling (team-management and later features, which consume these guards); terms and privacy-policy pages and consent capture; other identity providers, SSO/SAML; global API rate limiting beyond the auth endpoints; the player dashboard landing page.
- **Dependencies**: platform-foundation (COMPLETE, stacked, not merged): `users`, `auth_identities`, `team_members`, `Notifier` and `send-email` job (`apps/api/src/jobs/send-email.ts`), pg-boss producer, zod config, pino redaction, crypto keyring, `createTestDatabase()`, web `api-client.ts`, Mailpit. External: a Google Cloud OAuth client and a Meta (Facebook Login) app with redirect URIs for dev and production. Downstream consumers: team-management and every later feature use `request.auth.userId` and the guards.
- **NFR implications**:
  - Security (productBrief: email/password plus OAuth 2.0, global plus per-team RBAC): OWASP ASVS-style controls above (hashing, token storage, CSRF, throttling, enumeration resistance, default deny, no secrets in logs).
  - Privacy (NZ Privacy Act 2020, IPP 5 and IPP 12): store only email, name, sex, provider subject and a user agent per session (no IP address); Google and Facebook receive sign-in events (a cross-border disclosure the privacy policy must name when the policy page ships).
  - Accessibility: labelled inputs, errors tied with `aria-describedby`, keyboard-operable radio group and buttons, no colour-only errors; UAT treats axe-core critical issues as blockers.
  - Observability: structured auth events (`auth.login.succeeded|failed`, `auth.register`, `auth.password_reset.requested|completed`, `auth.session.revoked`) with trace IDs and no PII beyond `userId`.
  - Performance: no hard gate; sign-in API p95 under 1 s excluding the intentional hash cost is the working target.

### Creative Exploration Needed
Specification is concrete for behaviour, UI and data. These design questions need `/yay:creative` (the AC defaults above are the conservative starting point and may be revised):
1. **Auth library or hand-rolled (LOW).** Candidates: (A) Fastify-native: argon2id hashing, an OAuth client library such as `arctic`, own DB sessions (fits the existing `auth_identities` schema, P1 and the module convention); (B) Better Auth with a Kysely adapter (brings its own tables, would conflict with `auth_identities`); (C) Auth.js in Next.js (session and adapter live on the web side, API would need to trust or re-verify its tokens). Includes the password hashing choice: native argon2id addon (bundling with tsup and the Docker image) vs `node:crypto` scrypt (no dependency).
2. **Session strategy and web/API cookie relay (MEDIUM, lean opaque DB sessions).** The spec assumes opaque, revocable DB sessions (role changes and bans take effect at once; JWT rejected unless creative argues otherwise). Open: the API sets `Set-Cookie` and Next relays it vs Next sets its own cookie and sends a bearer token to the API; cookie names and TTL defaults (7-day idle, 30-day absolute); CSRF approach for Server Actions plus API.
3. **OAuth account linking and email conflicts, including whether email verification joins v1 (LOW).** The default is "never auto-link, never sign in on an email match; link only while signed in". Alternatives: auto-link when the provider asserts a verified email and the existing account's email is verified (requires email verification at registration); linking via a password re-auth step on a conflict screen. Pre-hijacking by an attacker who registers a victim's email first is the risk to weigh.
4. **Facebook without an email (LOW).** The default blocks sign-up with guidance (AC-ERROR-9). Alternative: collect an email on `/register/complete` (unverified, so it needs the verification decision above).
5. **RBAC guard design (MEDIUM).** Declarative per-route policy enforced by an `onRoute` hook (assumed) vs composed `preHandler`s; whether `GLOBAL_ADMIN` bypasses team guards (default: only where a route opts in, for example payment reminders and admin reporting); 403 vs 404 for team routes on private teams (default 403; revisit in team-management); the `GlobalRole` enum value `TEAM_ADMIN` kept for draft parity but forbidden by CHECK (default) vs removing it with an enum-recreate migration.
6. **OAuth redirect topology and short-lived state (MEDIUM).** Web-owned callback (`/auth/callback/:provider`, assumed because only the web origin is public) calling JSON endpoints on the API; where state and PKCE verifier and the pending-signup record live (Postgres tables per P1, assumed) vs an encrypted cookie using the existing AES-GCM keyring; OAuth "link" intent.
7. **Throttling mechanism on more than one API replica (MEDIUM).** Postgres-backed attempt counters vs `@fastify/rate-limit` with a shared store; per-email and per-client-address keys.
8. **Fake OAuth provider for E2E (MEDIUM).** A test-only adapter selected by env and refused in production (AC-VERIFY-7) vs recorded HTTP stubs.

### Implementation Guide Required
Yes. Two parts cannot be auto-verified and need written steps in `docs/getting-started.md`:
1. **Google**: in Google Cloud Console create an OAuth 2.0 Web client, set authorised redirect URIs to `http://localhost:3000/auth/callback/google` and the production origin, copy the client id and secret into `.env` as `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`.
2. **Facebook**: in Meta for Developers create an app with Facebook Login, enable the `email` permission, add valid OAuth redirect URIs `http://localhost:3000/auth/callback/facebook` and production, copy the app id and secret into `FACEBOOK_OAUTH_APP_ID` / `FACEBOOK_OAUTH_APP_SECRET`; note app-mode (development vs live) limits who can sign in.
3. **Manual smoke test**: with real credentials, run register-by-Google and register-by-Facebook once, plus a returning sign-in for each, and record the result (AC-INTEGRATION-3).
4. **First admin**: after registering, run the `users set-role <email> GLOBAL_ADMIN` command shown in Invocation Method.

## Test Strategy

### Approach
- **Emphasis**: balanced, leaning integration. Security properties (uniqueness, single-use tokens, CHECKs, guards) are proven against real PostgreSQL 17 per P1; pure logic (hashing, token generation, `returnTo` validation, provider payload parsing, policy registry) is unit-tested; one Playwright journey covers the web.
- **Target test count**: about 110 across 6 phases. That is above the 20-test guideline because the spec carries 52 ACs, more than half of them security controls that each need a negative case; integration tests carry most of them via `app.inject`.

### File Organization
- **New test files**:
  - `apps/api/src/modules/auth/password.test.ts` (hasher, rehash, timing bounds)
  - `apps/api/src/modules/auth/tokens.test.ts` (entropy, hashing, cookie options)
  - `apps/api/src/lib/auth/policy.test.ts` (route enumeration, default deny; AC-VERIFY-3)
  - `apps/api/src/modules/auth/providers/providers.test.ts` (Google/Facebook fixtures, tampered tokens; AC-INTEGRATION-3)
  - `apps/api/src/modules/auth/service.test.ts` (dummy-hash spy, throttle maths, session expiry with injected clock)
  - `apps/api/test/integration/auth-schema.int.test.ts` (CHECKs, rollback round trip; AC-VERIFY-4/5)
  - `apps/api/test/integration/auth-password.int.test.ts` (register, login, me, logout, throttle, CSRF origin)
  - `apps/api/test/integration/auth-guards.int.test.ts` (global and team guards, membership state)
  - `apps/api/test/integration/auth-reset.int.test.ts` (forgot/reset, job in same transaction, Mailpit delivery)
  - `apps/api/test/integration/auth-oauth.int.test.ts` (fake provider, pending sign-up, conflicts, link/unlink)
  - `apps/api/test/integration/auth-races.int.test.ts` (AC-INTEGRATION-5)
  - `apps/api/test/integration/auth-cleanup.int.test.ts` (AC-ASYNC-3)
  - `apps/web/src/lib/auth/return-to.test.ts` (open-redirect cases)
  - `apps/web/e2e/auth.spec.ts` (AC-INTEGRATION-4)
- **Extend existing**: `apps/api/src/lib/config/config.test.ts` (new env vars, half-configured provider), `apps/api/src/lib/logger/logger.test.ts` (OAuth `code`/`state` masking), `apps/api/src/jobs/registry.test.ts` and `schedules.test.ts` (`auth-cleanup`), `apps/api/src/app.test.ts` (deps injection), `apps/api/src/openapi.test.ts` (drift), `apps/web/src/lib/api-client.test.ts` (cookie and `traceparent` forwarding), `apps/api/src/cli-guards.test.ts` (`users set-role`), `apps/api/test/integration/enum-parity.int.test.ts` and `schema.int.test.ts` (new tables).

### What NOT to Test
- Real Google and Facebook endpoints in CI: covered by recorded fixtures plus the one-off manual smoke test (Implementation Guide).
- Library internals (argon2 parameters beyond the PHC prefix, the OAuth library's PKCE maths, Fastify cookie parsing): the libraries' own suites cover them.
- Visual styling of the auth pages: UAT covers it; tests assert labels, roles and messages only.
- `types.generated.ts`: checked by tsc and the existing codegen drift test.

### Per-Phase Test Guidance
- Phase 1: about 14 tests. CHECKs reject `TEAM_ADMIN` and mixed-case email (23514); migrate/rollback round trip; enum parity; config rejects a half-configured provider and fake OAuth in production without echoing values; `buildApp` accepts db and job-producer deps.
- Phase 2: about 34 tests. Hasher PHC and rehash; token entropy and hashed storage; cookie flags; register/login/me/logout happy paths; duplicate email 409; generic 401; throttling 429; idle and absolute expiry with injected clock; dummy-hash spy; Origin check 403; every route has a policy; global guard 401/403; team guard by approved membership and immediate effect of status change; CLI `users set-role`; 20-way registration race; log hygiene for password flows.
- Phase 3: about 14 tests. Forgot answers 202 for known and unknown emails; token row and job commit together (rollback leaves neither); idempotency key; transient retry gives one email, permanent failure logs `notification.failed`; reset single use, expired and reused tokens fail; reset revokes sessions; Mailpit delivery with subject and link; 20-way reset race; cleanup deletes only expired rows and is idempotent.
- Phase 4: about 12 tests. Pages render required labels; sex radio has none preselected; protected page redirects to `/login?returnTo=`; signed-in visit to `/login` redirects; `returnTo` rejects absolute, protocol-relative and backslash URLs; api-client forwards cookies and `traceparent`; header shows the signed-in name.
- Phase 5: about 22 tests. Provider fixtures parse, tampered or wrong-audience tokens rejected; state mismatch and cancellation recover; first-time OAuth creates a pending sign-up, `/auth/oauth/complete` requires sex; returning user skips the prompt; email conflict never links or signs in; missing Facebook email blocked; disabled provider 404; expired pending sign-up leaves no user; link and unlink, never the last method; OAuth secrets absent from logs.
- Phase 6: about 6 tests. Playwright journey (register, sign out, sign in, reset via Mailpit, sign in again; fake-provider first-time OAuth); trace ID continuity; OpenAPI drift; coverage gate includes `modules/auth/**`.

## Implementation Plan

### Overview
Build authentication and authorization as the reference `modules/<feature>` implementation: Postgres-backed opaque sessions, argon2id passwords, Google and Facebook OAuth through a web-owned callback, and a declarative default-deny route policy with global and per-team guards. The API stays the authority; the web relays the session cookie server-side.

### Requirements
#### Functional
- Register and sign in with email/password, Google and Facebook; sex is required once per user.
- Password reset by emailed single-use link (60 minutes).
- Sessions with logout, 7-day idle and 30-day absolute expiry.
- Global roles `GLOBAL_ADMIN`/`PLAYER`; team role from approved `team_members` rows; route guards for both; CLI to grant global roles.
- Connect and disconnect sign-in methods on `/account`, never the last one.

#### Non-Functional
- Security controls in AC-VERIFY-1 to 10 and AC-ERROR-3, 4, 6, 13, 15.
- Privacy: no IP addresses stored; only email, name, sex, provider subject and user agent.
- Accessibility: labelled controls and `aria-describedby` errors; axe critical issues block UAT.
- Observability: structured `auth.*` events with `traceId`, no PII beyond `userId`.

### Component Analysis
#### New Components
- **Auth module** (`apps/api/src/modules/auth/`): routes, service, repo, password hasher, tokens, sessions, throttle, OAuth providers, reset emails.
- **Auth platform** (`apps/api/src/lib/auth/`): request auth decoration, route policy registry (`onRoute`), guards.
- **HTTP errors** (`apps/api/src/lib/http/errors.ts` + `packages/shared/src/api/errors.ts`): the shared `{ error: { code, message, fields? } }` shape, first used here.
- **Auth cleanup job** (`apps/api/src/jobs/auth-cleanup.ts`).
- **Web auth** (`apps/web/src/lib/auth/`, pages under `apps/web/src/app/`, `SiteHeader`, `proxy.ts`).

#### Affected Components
- `apps/api/src/app.ts` and `main.ts`: inject the Kysely handle, the job producer, auth config and clock; register the auth module and policy hook.
- `apps/api/src/lib/config/config.ts`: new env vars (AC-VERIFY-7).
- `apps/api/src/lib/logger/logger.ts`: default redaction for OAuth `code`/`state`.
- `apps/api/src/jobs/{registry,bootstrap,schedules}.ts`: `auth-cleanup` queue.
- `apps/api/src/cli.ts`: `users set-role`.
- `apps/web/src/lib/api-client.ts`: auth methods, cookie and `traceparent` forwarding.
- `apps/web/src/app/layout.tsx`: mount `SiteHeader`.
- `db/schema-deviations.md`, `types.generated.ts`, `packages/shared/src/types/enums.ts`, `apps/api/openapi.yaml`, `vitest.config.ts` coverage list.

### Implementation Strategy
1. Schema, contracts and wiring first, so every later phase builds on DB guarantees (P1) and shared zod contracts.
2. Password auth, sessions and guards next: the critical path, because every downstream feature consumes `request.auth` and the guards.
3. Password reset and cleanup: exercises P5 (enqueue in the same transaction) end to end.
4. Web password flows: gives a usable product before OAuth.
5. OAuth and identity linking: the riskiest part, built on the stable session and pending-sign-up model.
6. Full E2E journey, OpenAPI, docs and gates.

### Dependencies & Risks
- Risk: the branch is stacked on unmerged `feature/platform-foundation` → Mitigation: rebase onto `main` after that PR merges; do not change platform-foundation files beyond the listed extension points.
- Risk: the argon2 native addon may not bundle with tsup or build on the slim Docker image → Mitigation: creative Q1 decides argon2 vs `node:crypto` scrypt; Phase 2 runs `docker compose build api` before closing.
- Risk: OAuth account pre-hijacking → Mitigation: never auto-link (AC-ERROR-8) unless creative Q3 adds email verification.
- Risk: cookie relay through Next Server Actions and route handlers loses `Set-Cookie` or `traceparent` → Mitigation: creative Q2 fixes the topology; AC-INTEGRATION-4 proves it in a browser.
- Risk: the `global_role` enum still has `TEAM_ADMIN` → Mitigation: a CHECK now (AC-VERIFY-4); enum removal is a creative Q5 option.
- Risk: Next.js 16 renamed `middleware.ts` to `proxy.ts` → Mitigation: use `apps/web/src/proxy.ts`, and confirm against the installed Next version in Phase 4.

### Observability Requirements
- **Applies**: Yes → reference `${CLAUDE_PLUGIN_ROOT}/context/observability-requirements.md` during build.
- **Logging**: existing request logging; business events `auth.register`, `auth.login.succeeded|failed` (reason code, no email), `auth.password_reset.requested|completed`, `auth.session.revoked`, `auth.oauth.conflict`; errors via the shared HTTP error mapper.
- **Tracing**: the web forwards `traceparent` on every API call (AC-INTEGRATION-4); custom spans around password hashing and the provider token exchange.
- **Metrics**: none new beyond the standard HTTP metrics (no metrics backend yet).
- **Configuration**: `WEB_BASE_URL`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `FACEBOOK_OAUTH_APP_ID`, `FACEBOOK_OAUTH_APP_SECRET`, `AUTH_SESSION_IDLE_DAYS`, `AUTH_SESSION_ABSOLUTE_DAYS`, `AUTH_RESET_TOKEN_MINUTES`, `AUTH_FAKE_OAUTH` (refused in production). Final names are confirmed in creative.

### API Requirements
- **REST API**: Yes
  - OpenAPI spec: `apps/api/openapi.yaml`, generated by `pnpm run openapi` and drift-checked by `apps/api/src/openapi.test.ts`
  - Endpoints: `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `GET /auth/providers`, `POST /auth/password/forgot`, `POST /auth/password/reset`, `POST /auth/oauth/:provider/authorize`, `POST /auth/oauth/:provider/callback`, `POST /auth/oauth/complete`, `GET /auth/identities`, `POST /auth/identities/:provider/link`, `DELETE /auth/identities/:provider`
  - Build phase: load `${CLAUDE_PLUGIN_ROOT}/context/api-rest-requirements.md`
- **GraphQL API**: No

## Implementation Roadmap

### New Source Files (pin path + extension)
<!-- Library-dependent names (OAuth client, hasher) may be renamed by /yay:creative; record any rename as a deviation. -->
- [ ] `db/migrations/20261006000100000_users_email_and_role_checks.sql`: lowercase-email CHECK, no `TEAM_ADMIN` global role CHECK
- [ ] `db/migrations/20261006000200000_auth_sessions.sql`: `auth_sessions`
- [ ] `db/migrations/20261006000300000_password_reset_tokens.sql`: `password_reset_tokens`
- [ ] `db/migrations/20261006000400000_oauth_states_and_pending_signups.sql`: short-lived OAuth state and pending sign-ups (shape set by creative Q6)
- [ ] `packages/shared/src/api/auth.ts`: zod request/response schemas for `/auth/*`
- [ ] `packages/shared/src/api/errors.ts`: shared API error shape and codes
- [ ] `apps/api/src/lib/http/errors.ts`: Fastify error mapper (SQLSTATE and domain errors to the shared shape)
- [ ] `apps/api/src/lib/auth/policy.ts`: route policy types and `onRoute` default-deny registry
- [ ] `apps/api/src/lib/auth/guards.ts`: `authenticate`, `requireGlobalRole`, `requireTeamRole`
- [ ] `apps/api/src/lib/auth/request-auth.ts`: `request.auth` decoration and Fastify type augmentation
- [ ] `apps/api/src/modules/auth/routes.ts`: auth endpoints
- [ ] `apps/api/src/modules/auth/service.ts`: register, login, logout, reset, OAuth orchestration
- [ ] `apps/api/src/modules/auth/repo.ts`: Kysely queries for users, identities, sessions, tokens, OAuth state
- [ ] `apps/api/src/modules/auth/password.ts`: password hasher (argon2id or scrypt per creative Q1)
- [ ] `apps/api/src/modules/auth/tokens.ts`: random token generation, SHA-256 hashing, cookie options
- [ ] `apps/api/src/modules/auth/sessions.ts`: session issue, touch, expiry and revoke
- [ ] `apps/api/src/modules/auth/throttle.ts`: login attempt throttling (mechanism per creative Q7)
- [ ] `apps/api/src/modules/auth/emails.ts`: password-reset `EmailMessage` builder
- [ ] `apps/api/src/modules/auth/providers/provider.ts`: `OAuthProvider` interface
- [ ] `apps/api/src/modules/auth/providers/google.ts`: Google adapter
- [ ] `apps/api/src/modules/auth/providers/facebook.ts`: Facebook adapter
- [ ] `apps/api/src/modules/auth/providers/fake.ts`: test-only provider, refused in production
- [ ] `apps/api/src/modules/auth/providers/fixtures/*.json`: recorded provider payloads
- [ ] `apps/api/src/jobs/auth-cleanup.ts`: cleanup handler
- [ ] `apps/web/src/components/site-header.tsx`: header with auth links
- [ ] `apps/web/src/app/register/page.tsx`: register form
- [ ] `apps/web/src/app/register/complete/page.tsx`: OAuth sex prompt
- [ ] `apps/web/src/app/login/page.tsx`: sign-in page
- [ ] `apps/web/src/app/forgot-password/page.tsx`: request a reset
- [ ] `apps/web/src/app/reset-password/page.tsx`: set a new password
- [ ] `apps/web/src/app/account/page.tsx`: account and connected methods
- [ ] `apps/web/src/app/auth/callback/[provider]/route.ts`: OAuth callback route handler (`.ts`: a Next route handler with no JSX)
- [ ] `apps/web/src/lib/auth/session.ts`: `getCurrentUser()`, `requireUser()`
- [ ] `apps/web/src/lib/auth/actions.ts`: Server Actions for the auth forms
- [ ] `apps/web/src/lib/auth/return-to.ts`: `returnTo` validation
- [ ] `apps/web/src/proxy.ts`: protected-route redirect (Next 16 name for middleware)
- [ ] extend: `apps/api/src/app.ts`, `apps/api/src/main.ts`, `apps/api/src/cli.ts`, `apps/api/src/lib/config/config.ts`, `apps/api/src/lib/logger/logger.ts`, `apps/api/src/jobs/{registry,bootstrap,schedules}.ts`, `apps/api/src/lib/db/types.generated.ts` (codegen), `packages/shared/src/index.ts`, `packages/shared/src/types/enums.ts`, `apps/web/src/lib/api-client.ts`, `apps/web/src/app/layout.tsx`, `db/schema-deviations.md`, `apps/api/openapi.yaml`, `vitest.config.ts`, `.env.example`, `docs/getting-started.md`
- [ ] `docs/adr/0013-authentication-and-sessions.md`: ADR for the creative decisions

### Phases
- [ ] Phase 1: Schema, contracts and wiring: the 4 migrations, deviations ledger (D-27 onwards), codegen and enum parity; `packages/shared/src/api/{auth,errors}.ts`; the HTTP error mapper; auth config vars; `buildApp`/`main.ts` dependency injection (db, job producer, clock). ACs: VERIFY-4, VERIFY-5, VERIFY-7.
- [ ] Phase 2: Password auth, sessions and guards (API): hasher, tokens, sessions, throttle, Origin check; `register`, `login`, `logout`, `me`, `providers`; route policy registry and guards; CLI `users set-role`; log hygiene. ACs: HAPPY-1, HAPPY-2, HAPPY-7, HAPPY-8, HAPPY-9, HAPPY-10, ERROR-1, ERROR-2, ERROR-3, ERROR-4, ERROR-11, ERROR-12, ERROR-15, ASYNC-4, VERIFY-1, VERIFY-2, VERIFY-3, VERIFY-6, VERIFY-10, INTEGRATION-2, INTEGRATION-5 (registration).
- [ ] Phase 3: Password reset and cleanup: `password/forgot` and `password/reset`, reset email via `enqueueEmail` in the same transaction, session revocation on reset, `auth-cleanup` queue and schedule. ACs: HAPPY-6, ERROR-5, ERROR-6, ASYNC-1, ASYNC-2, ASYNC-3, INTEGRATION-1, INTEGRATION-5 (reset).
- [ ] Phase 4: Web password flows: `SiteHeader`, `/register`, `/login`, `/forgot-password`, `/reset-password`, `/account`, Server Actions, `proxy.ts` redirect, `returnTo` validation, api-client cookie and `traceparent` forwarding. ACs: ENTRY-1, ENTRY-3, ENTRY-4, ENTRY-5, ENTRY-6, ERROR-13, and the web half of HAPPY-1, HAPPY-2, HAPPY-6, HAPPY-7.
- [ ] Phase 5: OAuth and identity linking: provider adapters, fake provider, authorize/callback/complete, `/auth/callback/[provider]`, `/register/complete`, provider buttons, identities link and unlink on `/account`. ACs: ENTRY-2, HAPPY-3, HAPPY-4, HAPPY-5, HAPPY-11, HAPPY-12, ERROR-7, ERROR-8, ERROR-9, ERROR-10, ERROR-14, INTEGRATION-3.
- [ ] Phase 6: End-to-end, contract and docs: Playwright `auth.spec.ts` covering the full entry-to-success journey, trace continuity, OpenAPI regeneration, coverage gate, `docs/getting-started.md` (OAuth setup, first admin), ADR 0013, `systemPatterns.md` auth pattern. ACs: INTEGRATION-4, VERIFY-8, VERIFY-9; recheck every MUST AC.

## Creative Phases

- [ ] Architecture design → pending (Q1 library and hasher, Q2 session strategy and cookie relay, Q5 RBAC guard design, Q6 OAuth redirect topology and state storage, Q8 fake provider)
- [ ] Algorithm design → pending (Q3 OAuth linking and email-conflict rules, including email verification; Q4 Facebook without email; Q7 throttling across replicas)

---

## Execution State

**Build Status**: RUNNING
**Current Phase**: CREATIVE
**Current Step**: Step 3 - Architecture and Algorithm COMPLETE; User Journey design agent dispatched
**Step Started**: 2026-10-06
**Can Resume**: YES

### Deviations
- Plan | branch base | `feature/auth-and-user-roles` is stacked on `feature/platform-foundation` (63dbc43), not `origin/main`, because origin/main has only the initial commit (push blocked with a 403). Rebase onto main once platform-foundation merges.

### Active Sub-Agents
- Architecture Design: COMPLETE
- User Journey Design: DISPATCHED, Started: 2026-10-06
- Algorithm Design: COMPLETE

### Completed Steps
- 2026-10-06 Plan: Spec Writer (Sonnet) drafted 52 ACs; taxonomy lint CLEAN; specification approved by the user as drafted; 6-phase plan written; Architecture and Algorithm creative phases flagged (Level 3 with LOW-confidence questions).
- Algorithm Creative Design: COMPLETE (2026-10-06) - Output: memory-bank/creative/auth-and-user-roles-algorithm.md (3A′ never auto-link + reset-proves-inbox R1; 4A block Facebook-without-email with rerequest; 7A Postgres sliding-log throttle)
- Architecture Creative Design: COMPLETE (2026-10-06) - Output: memory-bank/creative/auth-and-user-roles-architecture.md (own Fastify module; node:crypto argon2id; own provider adapters + jose; opaque DB sessions, web-owned cookie, bearer to API; onRoute default-deny policies; Postgres OAuth state + pending sign-ups; env-selected fake provider). Reconciliation: the throttle interface follows the algorithm doc (`admit`/`settle`, reserve-then-verify), superseding the architecture doc's `check/recordFailure/recordSuccess` sketch.
