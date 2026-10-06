---
slug: auth-and-user-roles
legacy_id:
feature: auth-and-user-roles
status: CREATIVE_COMPLETE
---

# auth-and-user-roles: Auth and User Roles

**Complexity**: Level 3 (inherited from auth-and-user-roles)
**Status**: CREATIVE_COMPLETE
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
**Creative Exploration Needed**: Yes, resolved in `/yay:creative` and consolidated on 2026-10-06 (see the Creative Exploration Needed section below).

*Note: this feature also delivers cross-cutting infrastructure (the authentication and authorization guards every later feature builds on). Those structural and security checks are written as `AC-VERIFY` and `AC-INTEGRATION` criteria inside this End-User spec.*

*Basis for this draft*: read from the stacked worktree (platform-foundation + this task), not `main`. Findings that shape the spec:
- `users` and `auth_identities` already exist (`db/migrations/20260929000200000_users_and_auth_identities.sql`): `users.sex user_sex NOT NULL`, `users.role global_role NOT NULL DEFAULT 'PLAYER'`, `users.email varchar(255) UNIQUE` (case-sensitive), `auth_identities(provider, provider_subject, password_hash)` with `UNIQUE(provider, provider_subject)` and `CHECK ((provider='PASSWORD') = (password_hash IS NOT NULL))`. `team_members(role team_role, status membership_status)` exists with `UNIQUE(team_id, user_id)`.
- **Gaps** this feature must close with new migrations: no sessions table, no password-reset token table, no case-insensitive email guarantee, and the `global_role` enum still carries the draft's `TEAM_ADMIN` value although TEAM_ADMIN is per-team only.
- The HTTP process (`apps/api/src/main.ts`, `buildApp(deps)` in `apps/api/src/app.ts`) currently has only `logger`, `version` and `checkDb`. Auth needs a Kysely handle, a job-runner **producer** (the reset email goes through `enqueueEmail` in `apps/api/src/jobs/send-email.ts`, P5) and auth config injected the same way.
- `apps/web` has only `layout.tsx`, `page.tsx` and `src/lib/api-client.ts` (which exposes `health()` only). The web talks to the API only server-side through `API_INTERNAL_URL`, and it is the only public origin in production (hosting constraints C5/C6).
- No shared HTTP error shape exists yet. The risk table in the platform-foundation architecture says this feature "sets the reference implementation" for module shape.

### Invocation Method
- **Location**: Web app (Next.js App Router, `apps/web/src/app/`). New public pages: `/register`, `/register/complete`, `/login`, `/forgot-password`, `/reset-password`. New protected page: `/account`. Web route handlers (no UI): `/auth/callback/google` and `/auth/callback/facebook` (one handler, `/auth/callback/[provider]`, which checks the `sgm_oauth` binding cookie, finishes the OAuth exchange with the API and redirects) and `/auth/session-expired?returnTo=…` (clears a dead session cookie only after `GET /auth/me` confirms 401, then redirects to `/login?notice=session_expired&returnTo=…`). API (Fastify, `apps/api/src/modules/auth/`; the API authenticates users only by `Authorization: Bearer <session token>` sent by the web server, never by a browser cookie):
  - `POST /auth/register` → 201 `{ user, session: { token, expiresAt } }`
  - `POST /auth/login` → 200 `{ user, session }`
  - `POST /auth/logout` → 204 (also for an already dead session)
  - `GET /auth/me` → `{ user }`
  - `GET /auth/providers` → `{ google, facebook }`
  - `POST /auth/password/forgot` → 202
  - `POST /auth/password/reset` → 200 `{ removedProviders: ('GOOGLE'|'FACEBOOK')[] }`
  - `POST /auth/password/reset/check` (COULD, C-7) → 204 or 400 `invalid_or_expired_token`, no consumption
  - `POST /auth/oauth/:provider/authorize` with `{ returnTo?, rerequest? }` (`rerequest` honoured for Facebook only, `auth_type=rerequest`) → `{ authorizationUrl, state }`
  - `POST /auth/oauth/:provider/callback` with `{ state, code }` or `{ state, error }` → `{ outcome: 'signed_in', user, session, returnTo }` | `{ outcome: 'pending_signup', pendingToken, returnTo }` | `{ outcome: 'linked' | 'already_linked', returnTo: '/account' }` | `ErrorResponse`
  - `GET /auth/oauth/pending` with header `X-Pending-Signup: <token>` → `{ provider, email, fullName, expiresAt, returnTo }`
  - `POST /auth/oauth/complete` with `{ pendingToken, fullName, sex }` → 201 or 200 `{ user, session, returnTo }`
  - `GET /auth/identities` → `{ identities: [{ provider, connectedAt, lastUsedAt }], enabledProviders: { google, facebook } }`
  - `POST /auth/identities/:provider/link` → `{ authorizationUrl, state }`
  - `DELETE /auth/identities/:provider` → 204
  - Operator: `pnpm --filter @sgm/api exec tsx --env-file-if-exists=../../.env src/cli.ts users set-role <email> <GLOBAL_ADMIN|PLAYER>`.
- **Element**: A new `SiteHeader` (`apps/web/src/components/site-header.tsx`, mounted in `apps/web/src/app/layout.tsx`) with links "Sign in" and "Create account" when signed out, and "Signed in as {fullName}", an "Account" link and a "Sign out" button when signed in. Page controls: buttons "Create account", "Sign in", "Continue with Google", "Continue with Facebook", "Try Facebook again", "Finish sign-up", "Use a different account", "Send reset link", "Send another link", "Set new password", "Connect Google", "Connect Facebook", "Disconnect"; links "Forgot your password?", "Set a password". Sex field: a `fieldset` with legend "Sex" and radios Male, Female, Other (`MALE`, `FEMALE`, `OTHER`), none preselected. All copy comes from the copy deck in `memory-bank/creative/auth-and-user-roles-user-journey.md`.
- **Visibility**: Header links always visible. "Continue with Google/Facebook" render only when that provider is enabled (`GET /auth/providers`, driven by env credentials). `/account` and any future protected page require a session. `/login` and `/register` redirect a signed-in user (one whose `GET /auth/me` succeeds, never mere cookie presence) to the validated `returnTo` or `/`.
- **Navigation**: `/` (home, `apps/web/src/app/page.tsx`) → header "Create account" → `/register`, or "Sign in" → `/login` → "Forgot your password?" → `/forgot-password` → email link → `/reset-password?token=…`. Header links carry `returnTo` (current path and query; none on `/`). Any protected route without a session → `/login?returnTo=<path>`. Post-auth landing is `returnTo` (validated by `safeReturnTo`) or `/`; sign-out lands on `/login?notice=signed_out`. Notices and errors travel only as codes in the query string. The player dashboard does not exist until the `player-dashboard` feature.
- **Confidence**: HIGH. Pages, endpoints, the cookie relay (web-owned cookie, bearer to the API), the OAuth redirect topology and the library choice were settled in the three creative documents.

### Success Criteria
- **User sees**: After registering (password or first-time OAuth), the browser lands on the validated `returnTo` or `/` with the header showing "Signed in as {fullName}" and the notice "Welcome! Your account is ready." once. A first-time OAuth user first sees `/register/complete` (Sex required, name prefilled). After sign-out, `/login` shows "You've signed out.". After a reset, `/login` shows "Password updated. Sign in with your new password." or, when Google or Facebook sign-in was removed, "Password updated. For your security we disconnected {Provider list} from this account. Sign in and reconnect it from your Account page."
- **Verifiable at**: `GET /auth/me` returns `{ user: { id, email, fullName, sex, role } }` with a valid bearer token and `401 { error: { code: 'unauthenticated', message } }` without one; the header on any page; Mailpit (`MAILPIT_API_URL`, UI `http://localhost:8025`) for the reset and sign-in-method-connected emails; DB rows below; `pgboss.job` for the `send-email` job.
- **Data persisted**: `users` (`email` in normal form, `full_name`, `sex`, `role='PLAYER'`, new nullable `email_verified_at`), `auth_identities` (`provider`, `provider_subject` = normalised email for PASSWORD or the provider's stable subject ID, `password_hash` argon2id PHC string only for PASSWORD, `last_used_at`; new `UNIQUE(user_id, provider)`), new `auth_sessions` (user, SHA-256 of the opaque token, `created_at`, `last_seen_at`, `expires_at`, `absolute_expires_at`, `revoked_at`, `revoked_reason`, `user_agent varchar(512)`), new `password_reset_tokens` (user, SHA-256 of token, `expires_at`, `used_at`), new `oauth_states` and `oauth_pending_signups` (single-use, `used_at`), new `auth_throttle` (HMAC-keyed counters only, no email or IP in clear). New migrations are reversible and each new table, column, constraint, trigger or function is added to `db/schema-deviations.md`.
- **Observable within**: Immediate for register, login, logout and guards. Reset email is async: visible in Mailpit within 30 s of the request while the worker runs. Expired sessions, tokens, OAuth rows and throttle counters disappear within one day via the scheduled cleanup job.

### Acceptance Criteria

**Entry points**

#### AC-ENTRY-1: Anonymous visitor can find Create account and Sign in from every page
**Priority**: MUST
**Given** a visitor without a session
**When** they open `/` or any public page
**Then** the header shows links "Sign in" (→ `/login`) and "Create account" (→ `/register`), keyboard-focusable and with visible labels; on any page other than `/` both links carry `returnTo` set to the current path and query (on auth pages, the page's existing validated `returnTo`), and on `/` they carry none

#### AC-ENTRY-2: Login page offers all three sign-in methods
**Priority**: MUST
**Given** Google and Facebook credentials are configured
**When** the visitor opens `/login`
**Then** they see Email and Password fields, a "Sign in" button, a "Forgot your password?" link, and "Continue with Google" and "Continue with Facebook" buttons; with a provider unconfigured, only that provider's button is absent

#### AC-ENTRY-3: Register page requires an explicit sex choice
**Priority**: MUST
**Given** a visitor on `/register`
**When** the page renders and they submit it
**Then** it shows Full name, Email, Password, a required "Sex" radio group (Male, Female, Other) with nothing preselected, a "Create account" button and the enabled OAuth buttons; the submit button stays enabled, and a submit without a sex is blocked client-side (no request) with "Select your sex to continue." in the error summary and beside the field, with the API's 422 as the backstop when JavaScript is off; `/register/complete` follows the same rule

#### AC-ENTRY-4: Protected pages send anonymous visitors to sign in and bring them back
**Priority**: MUST
**Given** a visitor with no valid session
**When** they open `/account`
**Then** they are redirected to `/login?returnTo=%2Faccount`, and after a successful sign-in they land on `/account`

#### AC-ENTRY-5: Signed-in state is visible and auth pages are skipped
**Priority**: MUST
**Given** a signed-in user (their `GET /auth/me` succeeds)
**When** they open any page, or open `/login` or `/register` with or without `returnTo`
**Then** the header shows "Signed in as {fullName}", an "Account" link and a "Sign out" button, and `/login` and `/register` redirect to the validated `returnTo` or `/`; a browser holding only a dead session cookie is shown the form, not redirected (no redirect loop)

#### AC-ENTRY-6: Forgot-password is reachable from the login page
**Priority**: MUST
**Given** a visitor on `/login`
**When** they click "Forgot your password?"
**Then** `/forgot-password` shows an Email field and a "Send reset link" button

#### AC-ENTRY-7: Back button and repeat visits never show a stale auth form while signed in
**Priority**: SHOULD
**Given** a user who just signed in, registered, finished OAuth sign-up or reset their password
**When** they press the browser Back button, or open `/login` or `/register` directly
**Then** they never see a usable sign-in or sign-up form while signed in: every post-auth redirect replaced the history entry, auth and protected pages send `Cache-Control: no-store`, and the server redirects signed-in visits to the validated `returnTo` or `/`

#### AC-ENTRY-8: Flows finished elsewhere or replayed resolve to the signed-in state
**Priority**: SHOULD
**Given** a first-time OAuth sign-up open on `/register/complete` in two tabs, or a used OAuth callback URL still in the browser history
**When** tab B submits or reloads after tab A finished, or a signed-in browser revisits the used callback URL
**Then** the browser lands on the validated `returnTo` or `/`, signed in, with no error message, and no OAuth state or pending sign-up is used twice

**Happy paths**

#### AC-HAPPY-1: Player registers with email and password
**Priority**: MUST
**Given** a visitor on `/register?returnTo=%2Faccount`
**When** they enter Full name "Aroha Ngata", Email "Aroha.Ngata@Example.com", Password "kowhai-court-27", choose Female, and click "Create account"
**Then** `POST /auth/register` returns 201 `{ user, session }`; `users` has one row with `email='aroha.ngata@example.com'`, `sex='FEMALE'`, `role='PLAYER'`; `auth_identities` has one `PASSWORD` row whose `password_hash` starts with `$argon2id$`; an `auth_sessions` row exists; the web sets the session cookie and, through a history-replacing redirect, lands on `/account` (or `/` without `returnTo`) showing "Signed in as Aroha Ngata" and "Welcome! Your account is ready." once; pressing Back does not show the registration form

#### AC-HAPPY-2: Player signs in with email and password
**Priority**: MUST
**Given** a registered user with a PASSWORD identity
**When** they sign in on `/login` with their email in any letter case and the correct password
**Then** a new `auth_sessions` row is issued (a session the browser already presented is revoked with `revoked_reason='replaced'`), the web sets the cookie, `auth_identities.last_used_at` is updated, and they land on the validated `returnTo` or `/`

#### AC-HAPPY-3: First-time Google user completes sign-up with a required sex choice
**Priority**: MUST
**Given** a visitor with a Google account whose email is verified and not yet registered
**When** they click "Continue with Google", approve consent, and on `/register/complete` choose a sex and click "Finish sign-up"
**Then** only now are `users` (role `PLAYER`, chosen `sex`, name from Google, editable on that page) and a `GOOGLE` `auth_identities` row (`provider_subject` = Google `sub`, no password hash) created, a session is issued, and they land on the `returnTo` stored with the pending sign-up (or `/`) with "Welcome! Your account is ready."; no `users` row exists before that submit

#### AC-HAPPY-4: First-time Facebook user completes sign-up with a required sex choice
**Priority**: MUST
**Given** a visitor with a Facebook account that shares an email address and is not yet registered
**When** they click "Continue with Facebook", approve consent, and complete `/register/complete`
**Then** a `users` row and a `FACEBOOK` `auth_identities` row (`provider_subject` = Facebook user id) are created with the chosen sex, a session is issued, and they land on the pending sign-up's `returnTo` (or `/`) with "Welcome! Your account is ready."

#### AC-HAPPY-5: Returning OAuth user signs in without being asked for sex again
**Priority**: MUST
**Given** a user who already has a `GOOGLE` or `FACEBOOK` identity
**When** they click the matching "Continue with …" button and approve
**Then** they are signed in directly (no `/register/complete`), `last_used_at` is updated, and no duplicate `users` or `auth_identities` row is created

#### AC-HAPPY-6: Player resets a forgotten password
**Priority**: MUST
**Given** a registered user, with any combination of sign-in methods, who requested a reset on `/forgot-password`
**When** they open the emailed link, enter a new valid password on `/reset-password` and click "Set new password"
**Then** in one transaction the token gets `used_at`, every other unused reset token of the user is invalidated, the PASSWORD identity is created or its hash replaced, every `GOOGLE` and `FACEBOOK` identity of the user is deleted (rule R1, see AC-ERROR-16), every session is revoked with `revoked_reason='password_reset'`, `users.email_verified_at` is set and that email's sign-in throttle count is cleared; the API returns 200 `{ removedProviders }`; the web deletes this browser's session cookie and lands on `/login?notice=password_updated` with "Password updated. Sign in with your new password.", or, when `removedProviders` is not empty, on `/login?notice=password_updated&removed=…&returnTo=%2Faccount` with "Password updated. For your security we disconnected {Provider list} from this account. Sign in and reconnect it from your Account page."; the new password signs in and the old one no longer does; an account with only Google or Facebook sign-in uses the same flow to add an Email and password method

#### AC-HAPPY-7: Player signs out and the session really ends
**Priority**: MUST
**Given** a signed-in user
**When** they click "Sign out"
**Then** `POST /auth/logout` returns 204 (also for an already dead session), the `auth_sessions` row gets `revoked_at` and `revoked_reason='logout'`, the web deletes the cookie, they land on `/login?notice=signed_out` showing "You've signed out.", the header returns to "Sign in" and "Create account", and replaying the old token on `GET /auth/me` returns 401 `session_expired`

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
**Given** a signed-in user on `/account`, whose "Sign-in methods" list shows "Email and password" plus each provider that is enabled or already connected, each marked "Connected" or "Not connected"
**When** they click "Connect Google" and complete the Google consent as the same human
**Then** a `GOOGLE` `auth_identities` row is added to their existing user (no new `users` row), they land on `/account?notice=linked&provider=google` showing "Google connected. You can now sign in with it.", and later "Continue with Google" signs them into that same user; an account without a PASSWORD identity shows the link "Set a password" (→ `/forgot-password?returnTo=%2Faccount`) with the warning that doing so disconnects its Google and Facebook sign-in

#### AC-HAPPY-12: Signed-in user can disconnect a method but never the last one
**Priority**: COULD
**Given** a user with two connected sign-in methods on `/account`
**When** they click "Disconnect" on one
**Then** that identity row is removed without a confirmation step and `/account` shows "{Provider} disconnected. You can connect it again at any time."; with only one method left, "Disconnect" is `aria-disabled` with the note "You need at least one way to sign in.", and `DELETE /auth/identities/:provider` returns 409 `last_sign_in_method` (backed by a deferred database trigger, so two concurrent disconnects cannot remove both)

#### AC-HAPPY-13: Confirmations show once and survive an API failure
**Priority**: SHOULD
**Given** a signed-in user, and a user who has just seen "Welcome! Your account is ready." or "Password updated."
**When** the first clicks "Sign out" while the API is unreachable, and the second reloads the page
**Then** the first still lands on `/login` with "You've signed out." and no session cookie (the web logs a warning), and the second does not see the notice again because notice and error codes are removed from the address bar after render while `returnTo` is kept

**Errors and recovery**

#### AC-ERROR-1: Duplicate email is rejected and the form is preserved
**Priority**: MUST
**Given** a user already exists for `aroha.ngata@example.com`
**When** a visitor registers with `AROHA.NGATA@example.com`
**Then** the API returns 409 `email_taken`, the page shows "An account with this email already exists. If you signed up with Google or Facebook, use that button to sign in." with links "Sign in instead" (`/login?returnTo=…`) and "Reset your password" (`/forgot-password?returnTo=…`), Full name, Email and Sex stay filled (password is cleared), focus moves to the error banner, and no second `users` or `auth_identities` row exists

#### AC-ERROR-2: Invalid registration input names the field and keeps what was typed
**Priority**: MUST
**Given** a visitor on `/register`
**When** they submit without a sex ("Select your sex to continue."), with a malformed email ("Enter a valid email address."), with a password shorter than 10 code points after NFKC ("Use at least 10 characters."), longer than 128 code points ("Use at most 128 characters."), or on the common-password list or equal to the email or its local part ("This password is too common or too easy to guess. Choose a different one.")
**Then** the API returns 422 `validation_failed` with `fieldErrors` per field, each message is shown beside its field and linked with `aria-describedby`, nothing is created, and a request body containing `role` or any unknown field is rejected with 422 (a client can never self-assign `GLOBAL_ADMIN`)

#### AC-ERROR-3: Wrong credentials give one generic answer
**Priority**: MUST
**Given** a visitor on `/login`
**When** they submit an unknown email, or a known email with the wrong password, or the password for an account that only has Google/Facebook identities
**Then** all three return the same 401 `invalid_credentials` body and show "Incorrect email or password." (plus "If you signed up with Google or Facebook, use those buttons instead." whenever a provider is enabled), the email stays filled and the password is cleared, with no session created and no hint which part was wrong

#### AC-ERROR-4: Repeated failed sign-ins are throttled
**Priority**: MUST
**Given** 5 failed sign-in attempts for one email within any 15-minute period, or 20 failed attempts from one client address across emails (the address derived only as in AC-VERIFY-14)
**When** the next attempt arrives, even with the correct password
**Then** the API returns 429 `too_many_attempts` with `Retry-After` equal to the seconds until the oldest counted failure leaves the window, the page shows "Too many sign-in attempts. Try again in {n} minutes." ("minute" when n is 1) and "You can reset your password now, or continue with Google or Facebook." (naming only enabled providers), and the attempt neither looks up the account nor verifies the password; attempts made while blocked are not counted and do not extend the block; a successful sign-in or a completed reset clears that email's count; a client-supplied `X-Forwarded-For` or `x-sgm-client-ip` value cannot move an attempt to another address key; the correct password works once the window has passed

#### AC-ERROR-5: Invalid, expired or reused reset tokens fail safely
**Priority**: MUST
**Given** a reset link that is expired (older than 60 minutes), already used, malformed, or for a deleted user
**When** the visitor submits a new password
**Then** the API returns 400 `invalid_or_expired_token` without hashing, `/reset-password` shows "This reset link is invalid or has expired. If you just set a new password, try signing in with it." with links "Request a new link" and "Back to sign in", and the existing password, identities and sessions are unchanged; a new password that fails the password rules returns 422 without consuming the token

#### AC-ERROR-6: Forgot-password never reveals whether an account exists
**Priority**: MUST
**Given** a visitor on `/forgot-password`
**When** they submit a syntactically valid email that has no account
**Then** the API returns the same 202 and the page the same "Check your email" state as for a real account ("If an account exists for that email, we've sent a reset link."), no token and no email job are created, and the response does not differ in shape; a flood of requests for one email is limited to one new email per 60 seconds; more than 10 requests from one client address within 60 minutes return 429 `too_many_requests` ("Too many requests. Try again in {n} minutes.") whether or not the accounts exist; a syntactically invalid email is rejected by the web with "Enter a valid email address." before any API call

#### AC-ERROR-7: OAuth cancellation, bad state and provider outage are recoverable
**Priority**: MUST
**Given** a visitor mid-way through a Google or Facebook sign-in started from `/login?returnTo=%2Faccount`
**When** they deny consent (`error=access_denied`), or the callback has a missing, unknown, expired or already-used `state` or fails the browser-binding check, or the provider's token or userinfo call fails or times out
**Then** no session and no `users` row is created, and they return to `/login?error=<code>&provider=<provider>&returnTo=%2Faccount` with respectively "{Provider} sign-in was cancelled.", "We couldn't verify that sign-in attempt. Please try again.", or "{Provider} is unavailable right now. Try again, or sign in with email and password.", so a successful retry still lands on `/account`; when the flow was started from `/account` to connect a provider, the same failures land on `/account` with "Connecting {Provider} was cancelled.", "We couldn't verify that attempt to connect {Provider}. Please try again." or "{Provider} is unavailable right now. Try connecting again later."; a replayed callback URL does nothing the second time (a signed-in browser goes to `/` silently)

#### AC-ERROR-8: OAuth email that matches an existing account never silently signs in or links
**Priority**: MUST
**Given** an existing user with a PASSWORD (or other provider) identity for `aroha.ngata@example.com`, and a visitor who completes Google (verified email) or Facebook sign-in returning that same email but no linked identity
**When** the OAuth callback (or a pending sign-up completion) is processed
**Then** the API returns 409 `oauth_account_exists`, no session is issued and no identity is attached, the visitor lands on `/login?error=oauth_account_exists&provider=<provider>&returnTo=%2Faccount` and sees "An account already exists for aroha.ngata@example.com. Sign in with your existing method, then connect {Provider} from your Account page." with links "Sign in" (`/login?returnTo=%2Faccount`) and "Forgot your password?"; linking happens only through AC-HAPPY-11 while signed in

#### AC-ERROR-9: Missing or unverified provider email blocks account creation clearly
**Priority**: MUST
**Given** a first-time Facebook login that returns no email, or a Google login with `email_verified=false`
**When** the callback is processed
**Then** no `users` row is created; Facebook gives 422 `oauth_email_missing` and "Facebook didn't share an email address, which we need to create your account. Try again and allow access to your email, or use Google or email and password instead." with a "Try Facebook again" button that restarts authorize with `rerequest: true`; Google gives 422 `oauth_email_unverified` and "Google says this email address isn't verified. Verify it with Google or use another method."; a returning user whose Facebook identity is already connected signs in even without an email

#### AC-ERROR-10: Disabled provider is hidden and cannot be reached directly
**Priority**: MUST
**Given** Google credentials are not configured
**When** a client calls `POST /auth/oauth/google/authorize` or opens `/auth/callback/google`
**Then** the API returns 404 `provider_not_enabled`, `GET /auth/providers` reports `google: false`, and the login and register pages show no Google button

#### AC-ERROR-11: Missing, expired or insufficient authorization is distinguishable and recoverable
**Priority**: MUST
**Given** a protected API route and a protected web page
**When** the request has no session token, a presented token that is expired, revoked or unknown, or a valid session without the required role
**Then** the API returns 401 `unauthenticated` (no token), 401 `session_expired` (presented token expired, revoked or unknown) or 403 `forbidden` (valid session, wrong role) using the shared error shape `{ error: { code, message } }`; the web sends a dead session through `/auth/session-expired`, which deletes the cookie only after `GET /auth/me` confirms 401 (with a live session it just redirects to `returnTo`), and lands on `/login` with "Your session has expired. Sign in again." and the protected page's `returnTo`; when the API is unreachable a protected page shows "We can't load this page right now" with "Try again" instead of redirecting or signing the user out

#### AC-ERROR-12: Team membership state controls team-scoped access immediately
**Priority**: MUST
**Given** a user whose `team_members.status` for team A is `PENDING`, `REJECTED` or `BANNED`, or who has no row for team A
**When** they call any `requireTeamRole` route for team A (MEMBER or TEAM_ADMIN)
**Then** the API returns 403 `forbidden`; changing the row to `APPROVED` or to `BANNED` takes effect on the next request with no re-login

#### AC-ERROR-13: `returnTo` cannot be used as an open redirect or a loop
**Priority**: MUST
**Given** `/login?returnTo=https://evil.example/` or `returnTo=//evil.example` or `returnTo=/\evil`, or a `returnTo` pointing at an auth page (`/login`, `/register`, `/register/complete`, `/forgot-password`, `/reset-password` or anything under `/auth/`)
**When** the user signs in
**Then** the value is ignored and they land on `/`; only a same-origin path starting with a single `/` that is not an auth page is honoured, and the same `safeReturnTo` rule is applied by the web before every redirect and by the API before storing a `returnTo`

#### AC-ERROR-14: Abandoned or expired OAuth sign-up leaves nothing behind
**Priority**: MUST
**Given** a first-time OAuth user on `/register/complete` who walks away, or whose pending sign-up is older than 15 minutes, or whose browser no longer has the `sgm_pending` cookie
**When** they submit the form or reload after expiry
**Then** no user is created; the API returns 400 `signup_expired` (a missing cookie counts as expired) and they are redirected to `/login?error=signup_expired` with "Your sign-up session expired. Please start again."; if the browser already has a live session (the sign-up finished in another tab) they land on `returnTo` or `/` signed in instead; submitting without a sex returns 422 and keeps the pending sign-up valid until its expiry; "Use a different account" clears the pending sign-up and returns to `/login`

#### AC-ERROR-15: Cross-site state-changing requests are refused
**Priority**: MUST
**Given** a signed-in user's browser and a page on another origin
**When** that page submits a POST to a web auth action or route handler, or a request reaches a mutating API route with a foreign `Origin`
**Then** the request is rejected with 403 (`cross_origin_request` from the API) and has no effect: cookies are `SameSite=Lax`, Server Actions and `proxy.ts` check `Origin` against `WEB_BASE_URL`, and the API refuses a foreign `Origin` on mutating requests

#### AC-ERROR-16: Every completed reset evicts all Google and Facebook sign-in methods
**Priority**: MUST
**Given** an account with a connected `FACEBOOK` identity, a connected `GOOGLE` identity (including one whose sign-up or link set `users.email_verified_at` from Google's `email_verified=true`), or both
**When** a password reset for that account's email completes
**Then** in the reset transaction every `GOOGLE` and `FACEBOOK` identity of the user is deleted whatever any provider asserted in the past, the PASSWORD identity is upserted, all sessions are revoked, other reset tokens are invalidated and `users.email_verified_at` is set; the API returns those providers in `removedProviders` and `/login` shows "Password updated. For your security we disconnected {Provider list} from this account. Sign in and reconnect it from your Account page."; in the recycled-email case (the previous owner of the address signed up with Google, the address now belongs to someone else who completes a reset) the previous owner's "Continue with Google" afterwards ends in 409 `oauth_account_exists` with no session

#### AC-ERROR-17: Connecting a method that is already in use is refused
**Priority**: SHOULD
**Given** a signed-in user on `/account`
**When** they connect a Google or Facebook account that belongs to another user, a second account of a provider they already have, or the account they already have connected
**Then** the first returns 409 `identity_in_use` ("That {Provider} account is already connected to a different account."), the second 409 `provider_already_connected` ("Your account already has a {Provider} sign-in. Disconnect it first to connect a different one."), and the third is a no-op with outcome `already_linked` ("{Provider} is already connected."); nothing is linked in the first two cases and no hint names the other account

#### AC-ERROR-18: Service unavailable is survivable
**Priority**: MUST
**Given** a visitor on `/register`, `/login`, `/forgot-password`, `/reset-password` or `/register/complete`
**When** the API is unreachable, times out or answers 5xx (including 503 `service_unavailable` when the throttle store is down) on submit
**Then** the page shows "Something went wrong on our side. Your details are still here. Try again in a minute.", keeps every non-password field, and nothing is created; on a protected page load the user sees "We can't load this page right now" with "Try again" and is not redirected to `/login` or signed out; with a session cookie present and the API down, the header shows no "Sign in" link; when `GET /auth/providers` fails, `/login` and `/register` hide the OAuth buttons and show "Sign-in is having trouble right now. Google and Facebook buttons will be back shortly. You can still try email and password."

#### AC-ERROR-19: Reset link is checked before the user types
**Priority**: COULD
**Given** an expired, used or malformed reset link
**When** `/reset-password` loads
**Then** it calls `POST /auth/password/reset/check` (public, no hashing, no consumption) and shows "This reset link is invalid or has expired." with "Request a new link" instead of the password form; a valid link shows the form and the token is still unused

#### AC-ERROR-20: OAuth email conflict shows the email without putting it in a URL
**Priority**: MUST
**Given** the AC-ERROR-8 conflict for `aroha.ngata@example.com` via Facebook
**When** the user lands on `/login`
**Then** the URL is `/login?error=oauth_account_exists&provider=facebook&returnTo=%2Faccount` with no email in it, the banner takes the address from the 60-second HttpOnly `sgm_flash` cookie set by the callback, signing in with the form on that page lands on `/account`, and a reload after 60 s shows "An account already exists for the email address on your Facebook account. Sign in with your existing method, then connect Facebook from your Account page."

**Async behaviour**

#### AC-ASYNC-1: Reset email is sent through the job queue, not inline
**Priority**: MUST
**Given** a registered user requests a reset
**When** `POST /auth/password/forgot` runs
**Then** the API answers 202 without waiting for SMTP; the `password_reset_tokens` row and the `send-email` job (via `enqueueEmail` with the same transaction, `idempotencyKey = password-reset:<tokenId>`, tag `template: password-reset`) commit together, so a job exists only if its token exists; the page changes to "Check your email" with "If an account exists for that email, we've sent a reset link.", "We sent it to {typed email}. The link works once and expires in 60 minutes.", a "Send another link" button and links "Use a different email" and "Back to sign in", identical apart from the echoed email for known and unknown accounts; the worker delivers the message and it appears in Mailpit within 30 s

#### AC-ASYNC-2: Reset email delivery failures are retried or surfaced, never lost silently
**Priority**: MUST
**Given** the notifier fails with a transient error, or with a permanent error
**When** the `send-email` job runs
**Then** a transient failure retries with the existing backoff and results in exactly one delivered email; a permanent failure ends the job in `failed` with an error log (`event: notification.failed`), and the user can request a new link, which creates a new token and job

#### AC-ASYNC-3: Expired auth artefacts are cleaned up by a scheduled job
**Priority**: SHOULD
**Given** expired or revoked sessions, expired or used reset tokens, expired or used OAuth state and pending-signup rows, and throttle counters whose newest attempt is older than 60 minutes
**When** the `auth-cleanup` queue runs (new slot in `apps/api/src/jobs/schedules.ts`, daily `0 5 * * *` Pacific/Auckland, outside the 02:00-02:59 DST window)
**Then** only those rows are deleted (in batches), active sessions, valid tokens and live counters are untouched, and a second immediate run deletes nothing and succeeds

#### AC-ASYNC-4: Session lifetime is observable and bounded
**Priority**: MUST
**Given** a session with an idle limit of 7 days and an absolute limit of 30 days (defaults, configurable)
**When** time is advanced with an injected clock
**Then** use within the idle window extends `expires_at` (written at most once per hour per session, never past `absolute_expires_at`), a request after 7 idle days or after 30 absolute days returns 401 `session_expired`, the session cookie's `Expires` equals the session's absolute expiry, and idle expiry is enforced by the API

#### AC-ASYNC-5: Connecting a sign-in method sends a security notice
**Priority**: SHOULD
**Given** a signed-in user who connects Google or Facebook from `/account`
**When** the link succeeds
**Then** in the same transaction as the identity insert an email job is enqueued (`idempotencyKey = identity-linked:<identityId>`, tag `template: identity-linked`) to the account address with subject "{Provider} sign-in connected to your Shared Game Management account" and the body sentence "If this wasn't you, reset your password now"; if the enqueue fails, the link rolls back; the worker delivers it to Mailpit

**Structural, security and grounded checks**

#### AC-VERIFY-1: Passwords are hashed with a memory-hard algorithm and never stored or logged in clear
**Priority**: MUST
**Given** the password hasher used by register, reset and login
**When** a hash is produced and verified
**Then** the stored value is an argon2id PHC string (`$argon2id$…`, at most 512 characters, parameters at or above the OWASP minimum), verification works across a parameter upgrade (`needsRehash`), and a single hash takes between 50 ms and 1 s on the CI runner

#### AC-VERIFY-2: Session and reset tokens are random, stored hashed, and carried safely
**Priority**: MUST
**Given** a freshly issued session token and a reset token
**When** the database, the API responses and the web response headers are inspected
**Then** each token is at least 256 bits from `crypto.randomBytes`; only its SHA-256 appears in the database (no plaintext column); the API returns the session token only in the JSON body to the web server and never sets cookies; the web sets the cookie `HttpOnly`, `SameSite=Lax`, `Path=/` and, whenever `WEB_BASE_URL` is https (required in production except for a localhost base URL), `Secure` with the `__Host-` prefixed name, so it is never readable by JavaScript; the `/reset-password` page responds with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`

#### AC-VERIFY-3: Every route has an explicit authorization policy (default deny)
**Priority**: MUST
**Given** the fully built Fastify app
**When** a unit test enumerates every registered route
**Then** each declares one policy (`public`, `optionalSession`, `authenticated`, `globalRole`, `teamRole`) and the app refuses to boot or the test fails if a route has none; `/health` and the public auth endpoints are declared `public`, `POST /auth/logout` and `POST /auth/oauth/:provider/callback` are `optionalSession`, and a protected route called without its policy's credentials is denied by default

#### AC-VERIFY-4: The RBAC model is enforced in the database and read fresh on each request
**Priority**: MUST
**Given** the migrated schema
**When** a raw insert or update sets `users.role = 'TEAM_ADMIN'`
**Then** it fails with SQLSTATE 23514 (new CHECK), the shared type used by auth code exposes only `GLOBAL_ADMIN` and `PLAYER` as assignable, a team role is derived only from `team_members.role = 'TEAM_ADMIN' AND status = 'APPROVED'`, and the session carries no role claim

#### AC-VERIFY-5: Schema changes are reversible, ledgered and drift-checked
**Priority**: MUST
**Given** the five new migrations (`users`/`auth_identities` checks, `auth_sessions`, `password_reset_tokens`, `oauth_states` and `oauth_pending_signups`, `auth_throttle` with its functions)
**When** `pnpm run test:integration` runs
**Then** the migrate / `rollback --all` / migrate round trip yields an identical schema, `db/schema-deviations.md` has an entry (D-27 onwards) for every new table, column, constraint, trigger and function with a Source, the committed `types.generated.ts` matches codegen, any new enum is mirrored in `packages/shared/src/types/enums.ts`, a raw `INSERT INTO users … email='A@B.com'` or a non-ASCII email fails with 23514, a second `GOOGLE` identity for one user fails with 23505 (`UNIQUE(user_id, provider)`), and deleting a user's last identity fails at commit with 23514 (`auth_identities_last_method`)

#### AC-VERIFY-6: Auth flows leave no secrets in logs
**Priority**: MUST
**Given** the log capture helper (`apps/api/test/helpers/log-capture.ts`) wrapping the logger
**When** register, login (success and failure), logout, forgot, reset and the OAuth callback all run
**Then** no log line contains a password, session token, reset token, OAuth `code`, `state`, access token, client secret, `Set-Cookie` value, `x-sgm-internal-auth` value, client address or throttle key hash; the OAuth `code` and `state` query parameters are masked in request logs (exact-name query masking); failed sign-ins log `event: auth.login.failed` with `reason` in `invalid_credentials|throttled_email|throttled_address` and no email address; successes log `auth.login.succeeded` with `userId` and `provider`; every line carries `traceId`

#### AC-VERIFY-7: Auth configuration is validated at boot with no secret leakage
**Priority**: MUST
**Given** the zod environment schemas in `apps/api/src/lib/config/config.ts` and `apps/web/src/lib/config.ts`
**When** either app boots with a half-configured provider (client id without secret, or the reverse), a non-http(s) `WEB_BASE_URL`, `NODE_ENV=production` with a non-https `WEB_BASE_URL` (the web allows a localhost host), an out-of-range TTL or throttle limit, fake-OAuth mode with `NODE_ENV=production`, or `NODE_ENV=production` without `API_INTERNAL_SHARED_SECRET` (both apps, at least 32 characters) or without `WEB_TRUSTED_PROXY_HOPS` (web; `0` only for a localhost `WEB_BASE_URL`)
**Then** it exits 1 before binding a port with `Invalid configuration: <VAR> — …` naming the variable but never its value; a provider with neither variable is simply disabled; the web validates `API_INTERNAL_URL` and `WEB_BASE_URL` at boot the same way; `.env.example` and `docs/getting-started.md` list every new variable (`WEB_BASE_URL`, `GOOGLE_OAUTH_CLIENT_ID/_SECRET`, `FACEBOOK_OAUTH_APP_ID/_SECRET`, `AUTH_FAKE_OAUTH`, `AUTH_SESSION_IDLE_DAYS`, `AUTH_SESSION_ABSOLUTE_DAYS`, `AUTH_RESET_TOKEN_MINUTES`, `AUTH_LOGIN_MAX_FAILURES_PER_EMAIL`, `AUTH_LOGIN_MAX_FAILURES_PER_ADDRESS`, `AUTH_LOGIN_WINDOW_MINUTES`, `AUTH_FORGOT_MAX_PER_ADDRESS`, `API_INTERNAL_SHARED_SECRET`, `WEB_TRUSTED_PROXY_HOPS`)

#### AC-VERIFY-8: Web and API share one contract and the OpenAPI document stays in sync
**Priority**: MUST
**Given** the zod schemas in `packages/shared/src/api/auth.ts` and `errors.ts`
**When** the unit tests and `pnpm run openapi` run
**Then** both Fastify routes and `apps/web/src/lib/api-client.ts` use those schemas, request schemas are strict, the `ErrorCode` enum equals the authoritative list in the architecture document, error bodies use `fieldErrors`, and `apps/api/openapi.yaml` regenerates with no diff (`openapi.test.ts`) and documents the bearer security scheme `sessionToken` (`type: http`, `scheme: bearer`; the browser cookie belongs to the web and is not part of the API contract) and the 401/403/409/422/429 responses

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

#### AC-VERIFY-11: Focus and announcements work across every auth page
**Priority**: MUST
**Given** any auth page or `/account` used with a keyboard and a screen reader
**When** a submit fails validation, a server error returns, or a page loads with a notice or error code
**Then** on validation failure focus moves to an error summary ("There's a problem") whose items link to each invalid field, each field has `aria-invalid="true"` and `aria-describedby` pointing at its message and hint, and the `<title>` starts with "Error: "; on a single server error focus moves to the error banner (`role="alert"`, `tabindex="-1"`); a notice on page load (`role="status"`) sits after the H1 without stealing focus, while an error on page load receives focus once; pending submits announce their label through a polite live region; the Sex radio group is a `fieldset` with legend "Sex" operable with arrow keys; nothing is conveyed by colour alone; axe-core reports no critical or serious violations on `/login`, `/register`, `/register/complete`, `/forgot-password` (both states), `/reset-password` and `/account`

#### AC-VERIFY-12: Auth forms are phone-friendly
**Priority**: SHOULD
**Given** a 360 × 740 viewport
**When** the player opens `/login`, `/register` or `/register/complete`
**Then** OAuth buttons appear above the email form, there is no horizontal scroll, inputs use at least 16 px text, every tap target (buttons, radio labels, links in banners) is at least 44 × 44 px, email inputs use `type="email"` with `autocapitalize="none"`, password inputs carry the right `autocomplete` value and a "Show password" toggle, and no field is auto-focused

#### AC-VERIFY-13: In-app browsers get a hint before Google sign-in
**Priority**: SHOULD
**Given** a request whose user agent identifies the Facebook, Messenger or Instagram in-app browser
**When** `/login` or `/register` renders with Google enabled
**Then** the hint "Google sign-in doesn't work inside the Facebook or Instagram app. Open this page in your browser (use the app's menu, then "Open in browser"), or use another sign-in method." appears directly above "Continue with Google"; ordinary browsers do not show it

#### AC-VERIFY-14: The client address comes only from the trusted proxy chain over an authenticated hop
**Priority**: MUST
**Given** the web configured with `WEB_TRUSTED_PROXY_HOPS=N` and both apps sharing `API_INTERNAL_SHARED_SECRET`
**When** browser requests reach the web with no `X-Forwarded-For`, with a multi-hop `X-Forwarded-For` whose leftmost entries are client-supplied, or with a forged `x-sgm-client-ip` or `x-sgm-internal-auth` header, and API requests arrive with a missing or wrong `x-sgm-internal-auth`
**Then** the web takes the client address only as the N-th `X-Forwarded-For` entry counted from the right (unknown when there are fewer than N entries or the entry is not a valid IP), strips any incoming `x-sgm-client-ip` and `x-sgm-internal-auth`, and sends its own `x-sgm-client-ip` only together with `x-sgm-internal-auth`; the API compares that secret in constant time and ignores `x-sgm-client-ip` unless it matches (the address dimension is then skipped with a warning, never replaced by the web container's IP); unit tests cover a client-supplied XFF, a multi-hop XFF, a missing secret and a forged secret

#### AC-VERIFY-15: The OAuth browser-binding cookie resists tampering, expiry and replay
**Priority**: MUST
**Given** an OAuth flow started in the browser, which set `sgm_oauth` to the binding value defined in the architecture document (`<state>.<ctx>`, at most 1024 bytes)
**When** the callback arrives with that cookie missing, expired, oversized, malformed, with a state component that differs from the query `state`, with an edited `ctx` (`returnTo` or intent), or a second time
**Then** the web compares only the state component with the query `state` in constant time; any mismatch, missing or malformed cookie is treated as an invalid state without calling the API, so the server-side state is not consumed; an edited `ctx` can change only the error landing (its `returnTo` is re-validated with `safeReturnTo` and its intent is a hint, while the `oauth_states` row decides intent, linked user and success `returnTo`); the cookie is deleted on every callback; shared fixtures prove that a state generated by the API parses in the web codec

**Integration (real systems)**

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
**Then** `provider_subject`, email, verification flag and name are extracted correctly; the Google adapter rejects an ID token with a bad signature (verified with `jose` against Google's JWKS), wrong audience, wrong issuer, wrong nonce or past expiry; the Facebook adapter sends `appsecret_proof` and a pinned Graph version; a one-time manual smoke test against the real apps is recorded in the task's execution notes (see Implementation Guide Required)

#### AC-INTEGRATION-4: Web and API work together end to end with trace propagation
**Priority**: MUST
**Given** the Compose stack and Playwright (`apps/web/e2e/auth.spec.ts`, run by `pnpm run test:e2e`)
**When** a user registers through the UI, signs out, signs in, requests a reset, follows the Mailpit link and signs in with the new password
**Then** every step succeeds in the browser, and the API log line for `POST /auth/login` carries the same `traceId` as the web request's `traceparent`; first-time OAuth through the fake provider ends on `/register/complete` then signed in

#### AC-INTEGRATION-5: Races on registration, reset tokens and sign-in throttling resolve exactly
**Priority**: MUST
**Given** a dedicated cloned database and a pool larger than the parallelism
**When** 20 concurrent registrations use the same email in different letter cases, 20 concurrent resets consume the same token, and 20 concurrent wrong-password sign-ins target one email
**Then** exactly one registration returns 201 and the rest 409 `email_taken` (backed by the unique constraint, SQLSTATE 23505, not an application check), exactly one reset succeeds (guarded `UPDATE … WHERE used_at IS NULL AND expires_at > $now RETURNING`), and the sign-ins cause exactly 5 password verifications and 15 responses of 429

### Scope Boundaries
- **In scope**:
  - Registration and sign-in by email/password, Google OAuth and Facebook OAuth; required sex selection for password and first-time OAuth users; password reset by email, which also adds a password to OAuth-only accounts and always disconnects Google and Facebook sign-in (R1, user decision D1); opaque server-side sessions with logout, idle and absolute expiry; connect and disconnect sign-in methods on `/account` with a security notice email on connect.
  - Global roles `GLOBAL_ADMIN` and `PLAYER`, the CLI to grant them, and API guards `authenticate`, `requireGlobalRole`, `requireTeamRole` (team role read from `team_members`), with default-deny route policy; matching web helpers (`getCurrentUser()`, `requireUser()`, `proxy.ts` redirect for protected pages, `/auth/session-expired`).
  - New migrations (email/role checks and identity constraints, sessions, reset tokens, OAuth state and pending sign-ups, throttle table and functions), shared zod contracts and the shared API error shape, email normalisation and the password policy (length plus common-password list), Postgres login and forgot-password throttling, the authenticated web-to-API hop for the client address, `SiteHeader`, `apiClient` auth methods that send the bearer token and `traceparent`, config variables (API and web), `auth-cleanup` job, OpenAPI regeneration, docs updates (`docs/getting-started.md`, ADRs 0013 and 0014, `systemPatterns.md` auth pattern).
- **Out of scope**:
  - Email verification as a flow (consequence: never auto-link; a completed reset proves the inbox and evicts every Google and Facebook identity; `users.email_verified_at` is informational only in v1); MFA/TOTP and passkeys; "remember me" toggle; device and session list UI; "sign out everywhere" beyond revoking on password reset; change-password while signed in (use the reset flow); editing name, email or sex after sign-up; account deletion or anonymisation (financial rows are `ON DELETE RESTRICT`, D-15); admin user-management UI (CLI only); team creation, joining, TEAM_ADMIN assignment and ban handling (team-management and later features, which consume these guards); terms and privacy-policy pages and consent capture; other identity providers, SSO/SAML; global API rate limiting beyond the auth endpoints; a Have I Been Pwned check; the player dashboard landing page.
- **Dependencies**: platform-foundation (COMPLETE, stacked, not merged): `users`, `auth_identities`, `team_members`, `Notifier` and `send-email` job (`apps/api/src/jobs/send-email.ts`), pg-boss producer, zod config, pino redaction, crypto keyring, `createTestDatabase()`, web `api-client.ts`, Mailpit. External: a Google Cloud OAuth client and a Meta (Facebook Login) app with redirect URIs for dev and production. Downstream consumers: team-management and every later feature use `request.auth.userId` and the guards.
- **NFR implications**:
  - Security (productBrief: email/password plus OAuth 2.0, global plus per-team RBAC): OWASP ASVS-style controls above (hashing, token storage, CSRF, throttling, enumeration resistance, default deny, no secrets in logs, account-recovery eviction, authenticated internal hop).
  - Privacy (NZ Privacy Act 2020, IPP 5 and IPP 12): store only email, name, sex, provider subject and a user agent per session; no IP address is stored in clear (the throttle keeps only an HMAC pseudonym of a truncated address, deleted within about a day); Google and Facebook receive sign-in events (a cross-border disclosure the privacy policy must name when the policy page ships).
  - Accessibility: labelled inputs, errors tied with `aria-describedby`, keyboard-operable radio group and buttons, no colour-only errors (AC-VERIFY-11); UAT treats axe-core critical issues as blockers.
  - Observability: structured auth events (`auth.login.succeeded|failed`, `auth.register`, `auth.password_reset.requested|completed`, `auth.session.revoked`, `auth.oauth.*`, `auth.identity.linked|unlinked`) with trace IDs and no PII beyond `userId`.
  - Performance: no hard gate; sign-in API p95 under 1 s excluding the intentional hash cost is the working target.

### Creative Exploration Needed
Resolved — see memory-bank/creative/auth-and-user-roles-{architecture,algorithm,user-journey}.md
1. **Q1 library and hasher**: own Fastify `modules/auth` composition (1A) with `node:crypto` argon2id (H1, Node `>=24.7 <25`, `@node-rs/argon2` as fallback only) and thin Google/Facebook adapters plus `jose` (O3); no arctic, Better Auth or Auth.js.
2. **Q2 sessions and relay**: opaque Postgres sessions; the web owns the `sgm_session` cookie and calls the API with `Authorization: Bearer`, and the API sets no cookies (2B); 7-day idle and 30-day absolute expiry with an hourly touch; CSRF through `SameSite=Lax` plus Origin checks in Server Actions, `proxy.ts` and the API.
3. **Q3 linking and email conflicts**: never auto-link, never sign in on an email match, link only while signed in (3A′); every completed reset evicts all Google and Facebook identities (R1 as amended by user decision D1); no email-verification flow in v1.
4. **Q4 Facebook without an email**: block sign-up with guidance and a "Try Facebook again" `rerequest` retry (4A); a known Facebook identity still signs in without an email.
5. **Q5 RBAC guards**: declarative `onRoute` default-deny registry with `public | optionalSession | authenticated | globalRole | teamRole` (5A); GLOBAL_ADMIN passes team guards only with `allowGlobalAdmin`; 403 for team routes; the global `TEAM_ADMIN` value is blocked by a CHECK.
6. **Q6 OAuth topology and state**: web-owned callback `/auth/callback/[provider]` with single-use Postgres `oauth_states` and `oauth_pending_signups` rows (6A) plus the `sgm_oauth` browser-binding cookie whose schema is defined once in the architecture document.
7. **Q7 throttling**: Postgres sliding-log table `auth_throttle` with atomic reserve-then-verify `auth_throttle_admit`/`auth_throttle_settle` (7A): 5 failures per email and 20 per client address per 15 minutes, forgot-password 10 per address per 60 minutes, HMAC-keyed; the address comes only from the trusted proxy hops over the secret-authenticated web hop.
8. **Q8 fake provider**: env-selected `AUTH_FAKE_OAUTH` adapter refused in production, with Playwright intercepting `https://oauth.fake.invalid/**` and the same recorded fixtures as the unit tests (8A).

### Implementation Guide Required
Yes. These parts cannot be auto-verified and need written steps in `docs/getting-started.md`:
1. **Google**: in Google Cloud Console create an OAuth 2.0 Web client, set authorised redirect URIs to `http://localhost:3000/auth/callback/google` and the production origin, copy the client id and secret into `.env` as `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`.
2. **Facebook**: in Meta for Developers create an app with Facebook Login, enable the `email` permission, add valid OAuth redirect URIs `http://localhost:3000/auth/callback/facebook` and production, copy the app id and secret into `FACEBOOK_OAUTH_APP_ID` / `FACEBOOK_OAUTH_APP_SECRET`; note app-mode (development vs live) limits who can sign in, and the two-year Graph API version refresh.
3. **Manual smoke test**: with real credentials, run register-by-Google and register-by-Facebook once, plus a returning sign-in for each, and record the result (AC-INTEGRATION-3).
4. **First admin**: after registering, run the `users set-role <email> GLOBAL_ADMIN` command shown in Invocation Method.
5. **Production trust settings**: generate `API_INTERNAL_SHARED_SECRET` (for example `openssl rand -base64 48`) and set the same value on the web and api services; set `WEB_TRUSTED_PROXY_HOPS` to the number of platform proxies that append to `X-Forwarded-For` in front of the web (AC-VERIFY-14).

## Test Strategy

### Approach
- **Emphasis**: balanced, leaning integration. Security properties (uniqueness, single-use tokens, CHECKs, triggers, throttle atomicity, guards, reset eviction) are proven against real PostgreSQL 17 per P1; pure logic (hashing, token generation, email normalisation, password policy, `returnTo` validation, the OAuth decision table, the binding-cookie codec, client-address derivation, provider payload parsing, policy registry, landing URLs) is unit-tested; Playwright covers the web journeys on desktop and a 360 px mobile project, with axe scans.
- **Target test count**: about 145 across 6 phases. That is above the 20-test guideline because the spec carries 66 ACs, more than half of them security controls that each need a negative case; integration tests carry most of them via `app.inject`, and the OAuth decision table (15 rows) and landing table are table-driven unit tests.

### File Organization
- **New test files**:
  - `packages/shared/src/auth/email.test.ts` (normalisation, IDN punycode, non-ASCII local part, 254/255 boundary)
  - `packages/shared/src/auth/return-to.test.ts` (open-redirect and auth-page cases; moved from the web)
  - `packages/shared/src/auth/oauth-binding.test.ts` (binding-cookie codec, size limit, tamper cases, API-state interop fixture; AC-VERIFY-15)
  - `apps/api/src/lib/http/errors.test.ts` (mapper statuses, `fieldErrors`, `ErrorCode` list parity)
  - `apps/api/src/lib/http/internal-auth.test.ts` (constant-time secret check, missing and forged secret, header ignored without it; AC-VERIFY-14)
  - `apps/api/src/modules/auth/password.test.ts` (hasher, rehash, known-answer vector, timing bounds)
  - `apps/api/src/modules/auth/password-policy.test.ts` (code-point lengths, NFKC, common list, equals email)
  - `apps/api/src/modules/auth/tokens.test.ts` (entropy, hashing)
  - `apps/api/src/lib/auth/policy.test.ts` (route enumeration, default deny; AC-VERIFY-3)
  - `apps/api/src/modules/auth/oauth-decision.test.ts` (one test per decision row S1–S5, C1–C5, L0–L4)
  - `apps/api/src/modules/auth/providers/providers.test.ts` (Google/Facebook fixtures, tampered tokens; AC-INTEGRATION-3)
  - `apps/api/src/modules/auth/service.test.ts` (dummy-hash spy, Retry-After maths, session expiry with injected clock)
  - `apps/api/test/integration/auth-schema.int.test.ts` (CHECKs, composite FK, last-method trigger, rollback round trip; AC-VERIFY-4/5)
  - `apps/api/test/integration/auth-password.int.test.ts` (register, login, me, logout, Origin check, session touch)
  - `apps/api/test/integration/auth-throttle.int.test.ts` (admit/settle, sliding window, refund, address limit, internal-auth header; AC-ERROR-4)
  - `apps/api/test/integration/auth-guards.int.test.ts` (global and team guards, membership state)
  - `apps/api/test/integration/auth-reset.int.test.ts` (forgot/reset, job in same transaction, R1 eviction including the recycled-email case, forgot address limit, Mailpit delivery)
  - `apps/api/test/integration/auth-oauth.int.test.ts` (fake provider, pending sign-up, conflicts, link/unlink, security notice)
  - `apps/api/test/integration/auth-races.int.test.ts` (AC-INTEGRATION-5)
  - `apps/api/test/integration/auth-cleanup.int.test.ts` (AC-ASYNC-3)
  - `apps/web/src/lib/config.test.ts` (web env validation and production refusals)
  - `apps/web/src/lib/auth/client-address.test.ts` (trusted hops, client-supplied and multi-hop XFF, invalid IP; AC-VERIFY-14)
  - `apps/web/src/lib/auth/landing.test.ts` (outcome and error code → redirect URL, table-driven over `messages.ts`)
  - `apps/web/src/lib/auth/in-app-browser.test.ts` (UA classifier fixtures; AC-VERIFY-13)
  - `apps/web/e2e/auth.spec.ts` (AC-INTEGRATION-4 and the journey scenarios, desktop and mobile projects, axe scans)
- **Extend existing**: `apps/api/src/lib/config/config.test.ts` (new env vars, half-configured provider, production refusals), `apps/api/src/lib/logger/logger.test.ts` (OAuth `code`/`state` masking, internal headers redacted), `apps/api/src/jobs/registry.test.ts` and `schedules.test.ts` (`auth-cleanup`), `apps/api/src/app.test.ts` (deps injection), `apps/api/src/openapi.test.ts` (drift, bearer scheme), `apps/web/src/lib/api-client.test.ts` (bearer, `traceparent`, internal headers from an allowlist), `apps/api/src/cli-guards.test.ts` (`users set-role`), `apps/api/test/integration/enum-parity.int.test.ts` and `schema.int.test.ts` (new tables).

### What NOT to Test
- Real Google and Facebook endpoints in CI: covered by recorded fixtures plus the one-off manual smoke test (Implementation Guide).
- Library internals (argon2 parameters beyond the PHC prefix and the known-answer vector, `jose` signature maths, Next cookie serialisation): the libraries' own suites cover them.
- Visual styling of the auth pages: UAT covers it; tests assert labels, roles, messages and the AC-VERIFY-12 layout checks only.
- `types.generated.ts`: checked by tsc and the existing codegen drift test.

### Per-Phase Test Guidance
- Phase 1: about 18 tests. CHECKs reject `TEAM_ADMIN`, mixed-case and non-ASCII email (23514); `UNIQUE(user_id, provider)` (23505); composite FK keeps the PASSWORD subject equal to `users.email`; last-method trigger; `auth_throttle` table and functions exist; migrate/rollback round trip; enum parity; API and web config reject a half-configured provider, fake OAuth in production, and production without `API_INTERNAL_SHARED_SECRET` or `WEB_TRUSTED_PROXY_HOPS`, without echoing values; `ErrorCode` list matches the architecture document; `buildApp` accepts db, job-producer and clock deps.
- Phase 2: about 42 tests. Hasher PHC, rehash and known-answer self-test; password policy; `normaliseEmail`; token entropy and hashed storage; register/login/me/logout happy paths (204 for a dead session, `revoked_reason`); duplicate email 409; generic 401; throttle admit/settle (5th failure then 429 without verify, blocked attempts not counted, window boundary, success clears email and refunds address, address limit 20, Retry-After); internal-auth hook (missing and forged secret ignore `x-sgm-client-ip`, no fallback to `request.ip`); idle and absolute expiry and hourly touch with injected clock; dummy-hash spy; Origin check 403; every route has a policy; global guard 401/403 and `session_expired` for unknown tokens; team guard by approved membership and immediate effect of status change; CLI `users set-role`; 20-way registration race and 20-way wrong-password race; log hygiene for password flows.
- Phase 3: about 20 tests. Forgot answers 202 for known and unknown emails; forgot address limit 429 `too_many_requests`; token row and job commit together (rollback leaves neither); idempotency key; transient retry gives one email, permanent failure logs `notification.failed`; reset single use, expired and reused tokens fail without hashing; reset revokes sessions and invalidates other tokens; R1 eviction removes GOOGLE and FACEBOOK even when `email_verified_at` was set, returns `removedProviders`; recycled email: the previous owner's Google identity cannot sign in after the new owner's reset; OAuth-only account gains a PASSWORD identity; Mailpit delivery with subject and link; 20-way reset race; cleanup deletes only stale rows (including throttle rows) and is idempotent.
- Phase 4: about 24 tests. Pages render required labels; sex radio has none preselected and client validation blocks a missing sex; protected page redirects to `/login?returnTo=`; signed-in visit to `/login` redirects while a dead cookie gets the form; `/auth/session-expired` keeps a live session's cookie; `returnTo` rejects absolute, protocol-relative, backslash and auth-page URLs; api-client sends the bearer, `traceparent`, `x-sgm-internal-auth` and a derived `x-sgm-client-ip`, and never forwards incoming internal headers; client-address derivation for 0, 1 and 2 hops and spoofed leftmost entries; cookie flags and `__Host-` naming by `WEB_BASE_URL` scheme; header states; landing table; sign-out lands on `/login` even when the API fails; error summary focus and `aria-describedby`; mobile attributes.
- Phase 5: about 30 tests. Provider fixtures parse, tampered or wrong-audience tokens rejected; decision table rows S1–S5, C1–C5, L0–L4; binding-cookie codec and tamper, expiry and replay cases; state mismatch and cancellation recover with `returnTo` kept; first-time OAuth creates a pending sign-up, `/auth/oauth/complete` requires sex; returning user skips the prompt; email conflict never links or signs in and puts no email in the URL; missing Facebook email blocked with `rerequest`; disabled provider 404; expired pending sign-up leaves no user; link and unlink, never the last method, security notice enqueued in the link transaction; in-app browser hint; OAuth secrets absent from logs.
- Phase 6: about 11 tests. Playwright journeys on desktop and mobile (register, sign out, sign in, reset via Mailpit, sign in again; fake-provider first-time OAuth; conflict landing; two-tab pending sign-up); axe scans of every auth page and `/account`; trace ID continuity; OpenAPI drift with the bearer scheme; coverage gate includes `modules/auth/**`.

## Implementation Plan

### Overview
Build authentication and authorization as the reference `modules/<feature>` implementation: Postgres-backed opaque sessions, argon2id passwords, Google and Facebook OAuth through a web-owned callback, a Postgres sliding-log throttle, and a declarative default-deny route policy with global and per-team guards. The API stays the authority and is reached only by the web server with a bearer token over a secret-authenticated hop; the web owns every cookie.

### Requirements
#### Functional
- Register and sign in with email/password, Google and Facebook; sex is required once per user.
- Password reset by emailed single-use link (60 minutes); every completed reset also removes all Google and Facebook identities, revokes all sessions and records the inbox proof (D1).
- Sessions with logout, 7-day idle and 30-day absolute expiry.
- Global roles `GLOBAL_ADMIN`/`PLAYER`; team role from approved `team_members` rows; route guards for both; CLI to grant global roles.
- Connect and disconnect sign-in methods on `/account`, never the last one; a security notice email on every connect.

#### Non-Functional
- Security controls in AC-VERIFY-1 to 15 and AC-ERROR-3, 4, 6, 13, 15, 16.
- Privacy: no IP addresses stored in clear; only email, name, sex, provider subject and user agent, plus HMAC throttle keys that expire within a day.
- Accessibility: labelled controls and `aria-describedby` errors; axe critical issues block UAT (AC-VERIFY-11).
- Observability: structured `auth.*` events with `traceId`, no PII beyond `userId`.

### Component Analysis
#### New Components
- **Auth module** (`apps/api/src/modules/auth/`): routes, services (`service.ts`, `reset-service.ts`, `oauth-service.ts`), the pure OAuth decision table, repo, password hasher and policy, tokens, sessions, throttle, OAuth providers, emails.
- **Auth platform** (`apps/api/src/lib/auth/`): request auth decoration, route policy registry (`onRoute`), guards.
- **HTTP layer** (`apps/api/src/lib/http/{errors,origin,internal-auth}.ts` + `packages/shared/src/api/errors.ts`): the shared `{ error: { code, message, fieldErrors? } }` shape, first used here; the Origin check; the internal-hop secret check that alone decides whether `x-sgm-client-ip` is trusted.
- **Shared auth helpers** (`packages/shared/src/auth/`): `normaliseEmail`, `safeReturnTo`, the `sgm_oauth` binding codec.
- **Auth cleanup job** (`apps/api/src/jobs/auth-cleanup.ts`).
- **Web auth** (`apps/web/src/lib/config.ts`, `apps/web/src/lib/auth/`, pages under `apps/web/src/app/`, `SiteHeader`, form primitives, `proxy.ts`).

#### Affected Components
- `apps/api/src/app.ts` and `main.ts`: inject the Kysely handle, the job producer, the keyring, auth config, clock, providers, hasher and throttle; register error handling, Origin and internal-auth hooks, the policy registry and the auth module.
- `apps/api/src/lib/config/config.ts`: new env vars (AC-VERIFY-7).
- `apps/api/src/lib/logger/logger.ts`: exact-name query masking for OAuth `code`/`state`; `x-sgm-client-ip`, `x-sgm-internal-auth` and `set-cookie` header redaction.
- `apps/api/src/jobs/{registry,bootstrap,schedules}.ts`: `auth-cleanup` queue.
- `apps/api/src/cli.ts`: `users set-role`.
- `apps/api/src/routes/health.ts`: `publicRoute()` policy.
- `apps/web/src/lib/api-client.ts`: auth methods, bearer, `traceparent`, internal headers.
- `apps/web/src/app/layout.tsx`: mount `SiteHeader` and `FlashNotice`; `apps/web/src/instrumentation.ts` loads the web config; `apps/web/next.config.ts` sets `serverActions.allowedOrigins`.
- `db/schema-deviations.md`, `types.generated.ts`, `packages/shared/src/types/enums.ts`, `apps/api/openapi.yaml`, `vitest.config.ts` coverage list, `docker-compose.yml`, root `package.json` engines.

### Implementation Strategy
1. Schema, contracts and wiring first, so every later phase builds on DB guarantees (P1) and shared zod contracts.
2. Password auth, sessions, throttle and guards next: the critical path, because every downstream feature consumes `request.auth` and the guards.
3. Password reset (with R1 eviction) and cleanup: exercises P5 (enqueue in the same transaction) end to end.
4. Web password flows: gives a usable product before OAuth.
5. OAuth and identity linking: the riskiest part, built on the stable session and pending-sign-up model.
6. Full E2E journeys, OpenAPI, docs and gates.

### Dependencies & Risks
- Risk: the branch is stacked on unmerged `feature/platform-foundation` → Mitigation: rebase onto `main` after that PR merges; do not change platform-foundation files beyond the listed extension points.
- Risk: the web-to-API trust boundary for the client address (critique finding 2): a spoofed `X-Forwarded-For` or `x-sgm-client-ip` would let an attacker spread guesses across address keys or lock out a venue → Mitigation: the web derives the address only from `WEB_TRUSTED_PROXY_HOPS` counted from the right and strips incoming internal headers; the API trusts `x-sgm-client-ip` only with a constant-time-checked `x-sgm-internal-auth` (`API_INTERNAL_SHARED_SECRET`); production refuses to boot without either setting (AC-VERIFY-7, AC-VERIFY-14). The per-email limit, which protects each account, never depends on the address.
- Risk: OAuth account pre-hijacking and recycled inboxes → Mitigation: never auto-link (AC-ERROR-8) and every completed reset evicts all Google and Facebook identities (AC-ERROR-16, D1).
- Risk: R1 surprises a legitimate user who loses a connected provider on reset → Mitigation: warned on `/account` and in the reset form hint before, explained with a reconnect route after (`removedProviders`).
- Risk: the Next 16 Server Action origin check misfires behind the platform proxy → Mitigation: `serverActions.allowedOrigins` from `WEB_BASE_URL` plus `proxy.ts`'s own Origin check; AC-ERROR-15 and AC-INTEGRATION-4 run through the real stack.
- Risk: the `global_role` enum still has `TEAM_ADMIN` → Mitigation: a CHECK now (AC-VERIFY-4) and the shared `AssignableGlobalRole` type; enum recreation stays possible later.
- Risk: Next.js 16 renamed `middleware.ts` to `proxy.ts` → Mitigation: use `apps/web/src/proxy.ts`, and confirm against the installed Next version in Phase 4.

### Observability Requirements
- **Applies**: Yes → reference `${CLAUDE_PLUGIN_ROOT}/context/observability-requirements.md` during build.
- **Logging**: existing request logging; business events `auth.register`, `auth.login.succeeded|failed` (`reason` `invalid_credentials|throttled_email|throttled_address`, no email), `auth.password_reset.requested|completed` (`removedProviders`), `auth.session.revoked` (`reason` `logout|password_reset|replaced`), `auth.oauth.started|cancelled|failed|conflict|link_conflict|email_missing`, `auth.oauth.pending.created`, `auth.identity.linked|unlinked`, `auth.throttle.address_missing`, `auth.client_address.untrusted`; the web logs `auth.oauth.callback.landing`; errors via the shared HTTP error mapper.
- **Tracing**: the web forwards `traceparent` on every API call (AC-INTEGRATION-4); custom spans around password hashing and the provider token exchange; no `traceparent` to Google or Facebook.
- **Metrics**: none new beyond the standard HTTP metrics (no metrics backend yet); names reserved in ADR 0013.
- **Configuration** (final names): `WEB_BASE_URL`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `FACEBOOK_OAUTH_APP_ID`, `FACEBOOK_OAUTH_APP_SECRET`, `AUTH_FAKE_OAUTH` (refused in production), `AUTH_SESSION_IDLE_DAYS`, `AUTH_SESSION_ABSOLUTE_DAYS`, `AUTH_RESET_TOKEN_MINUTES`, `AUTH_LOGIN_MAX_FAILURES_PER_EMAIL`, `AUTH_LOGIN_MAX_FAILURES_PER_ADDRESS`, `AUTH_LOGIN_WINDOW_MINUTES`, `AUTH_FORGOT_MAX_PER_ADDRESS`, `API_INTERNAL_SHARED_SECRET` (api and web, required in production), `WEB_TRUSTED_PROXY_HOPS` (web, required in production), plus the existing `API_INTERNAL_URL` now validated by the web. Rules and defaults: architecture document, "Final environment variables".

### API Requirements
- **REST API**: Yes
  - OpenAPI spec: `apps/api/openapi.yaml`, generated by `pnpm run openapi` and drift-checked by `apps/api/src/openapi.test.ts`; security scheme `sessionToken` (HTTP bearer)
  - Endpoints: `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `GET /auth/providers`, `POST /auth/password/forgot`, `POST /auth/password/reset`, `POST /auth/password/reset/check` (COULD), `POST /auth/oauth/:provider/authorize`, `POST /auth/oauth/:provider/callback`, `GET /auth/oauth/pending`, `POST /auth/oauth/complete`, `GET /auth/identities`, `POST /auth/identities/:provider/link`, `DELETE /auth/identities/:provider`
  - Error codes: the authoritative `ErrorCode` list in `memory-bank/creative/auth-and-user-roles-architecture.md` ("Shared HTTP error shape")
  - Build phase: load `${CLAUDE_PLUGIN_ROOT}/context/api-rest-requirements.md`
- **GraphQL API**: No

## Implementation Roadmap

### New Source Files (pin path + extension)
<!-- Consolidated 2026-10-06 against the three creative documents. Record any later rename as a deviation. -->
- [ ] `db/migrations/20261006000100000_users_email_and_role_checks.sql`: `users_email_normalised` and `users_role_not_team_admin` CHECKs, `users.email_verified_at`, `uq_users_id_email`; on `auth_identities`: `uq_auth_identities_user_provider`, lowercase PASSWORD-subject CHECK, `password_email` generated column with the composite FK to `users (id, email)`, deferred `auth_identities_last_method` constraint trigger
- [ ] `db/migrations/20261006000200000_auth_sessions.sql`: `auth_sessions` (incl. `revoked_reason`, `user_agent varchar(512)`)
- [ ] `db/migrations/20261006000300000_password_reset_tokens.sql`: `password_reset_tokens` (`used_at`)
- [ ] `db/migrations/20261006000400000_oauth_states_and_pending_signups.sql`: `oauth_states` (`intent`, `link_user_id`, `used_at`) and `oauth_pending_signups` (`email NOT NULL`, `full_name`, `used_at`)
- [ ] `db/migrations/20261006000500000_auth_throttle.sql`: `auth_throttle` table and the `auth_throttle_admit` / `auth_throttle_settle` functions
- [ ] `packages/shared/src/api/auth.ts`: zod request/response schemas for `/auth/*`, field messages from the copy deck
- [ ] `packages/shared/src/api/errors.ts`: `ErrorResponse` (`fieldErrors`) and the authoritative `ErrorCode` list
- [ ] `packages/shared/src/auth/email.ts`: `normaliseEmail` (S1-b)
- [ ] `packages/shared/src/auth/return-to.ts`: `safeReturnTo` incl. auth-page exclusion (moved from `apps/web/src/lib/auth/return-to.ts`)
- [ ] `packages/shared/src/auth/oauth-binding.ts`: `sgm_oauth` binding-cookie codec and `OAUTH_STATE_PATTERN`
- [ ] `apps/api/src/lib/http/errors.ts`: Fastify error mapper (SQLSTATE and domain errors to the shared shape)
- [ ] `apps/api/src/lib/http/origin.ts`: foreign-`Origin` refusal on mutating requests
- [ ] `apps/api/src/lib/http/internal-auth.ts`: `x-sgm-internal-auth` constant-time check and `request.clientAddress`
- [ ] `apps/api/src/lib/clock.ts`: injectable `Clock`
- [ ] `apps/api/src/lib/auth/policy.ts`: route policy types and `onRoute` default-deny registry
- [ ] `apps/api/src/lib/auth/guards.ts`: `authenticate`, global-role and team-role checks
- [ ] `apps/api/src/lib/auth/request-auth.ts`: `request.auth` decoration, bearer session resolution, Fastify type augmentation
- [ ] `apps/api/src/modules/auth/routes.ts`: auth endpoints
- [ ] `apps/api/src/modules/auth/service.ts`: register, login, logout, me, identities
- [ ] `apps/api/src/modules/auth/reset-service.ts`: forgot and reset (R1)
- [ ] `apps/api/src/modules/auth/oauth-service.ts`: authorize, callback, pending, complete, link
- [ ] `apps/api/src/modules/auth/oauth-decision.ts`: pure OAuth decision table (S1–S5, C1–C5, L0–L4)
- [ ] `apps/api/src/modules/auth/repo.ts`: Kysely queries for users, identities, sessions, tokens, OAuth state
- [ ] `apps/api/src/modules/auth/password.ts`: `node:crypto` argon2id hasher with self-test
- [ ] `apps/api/src/modules/auth/password-policy.ts`: `checkPasswordForSet` and the `PasswordBlocklist` interface
- [ ] `apps/api/src/modules/auth/common-passwords.txt`: bundled list with source and licence header
- [ ] `apps/api/src/modules/auth/tokens.ts`: random token generation and SHA-256 hashing
- [ ] `apps/api/src/modules/auth/sessions.ts`: session issue, touch, expiry and revoke
- [ ] `apps/api/src/modules/auth/throttle.ts`: `LoginThrottle` over `auth_throttle_admit`/`settle`, HKDF key derivation
- [ ] `apps/api/src/modules/auth/emails.ts`: `password-reset` and `identity-linked` `EmailMessage` builders
- [ ] `apps/api/src/modules/auth/providers/provider.ts`: `OAuthProvider` interface
- [ ] `apps/api/src/modules/auth/providers/registry.ts`: enabled providers from config, fake mode
- [ ] `apps/api/src/modules/auth/providers/pkce.ts`: verifier, S256 challenge, nonce
- [ ] `apps/api/src/modules/auth/providers/google.ts`: Google adapter (`jose` ID-token verification)
- [ ] `apps/api/src/modules/auth/providers/facebook.ts`: Facebook adapter (`appsecret_proof`, pinned Graph version, `rerequest`)
- [ ] `apps/api/src/modules/auth/providers/fake.ts`: test-only provider, refused in production
- [ ] `apps/api/src/modules/auth/providers/fixtures/*.json`: recorded provider payloads
- [ ] `apps/api/src/jobs/auth-cleanup.ts`: cleanup handler
- [ ] `apps/web/src/lib/config.ts`: zod web env (`API_INTERNAL_URL`, `WEB_BASE_URL`, `API_INTERNAL_SHARED_SECRET`, `WEB_TRUSTED_PROXY_HOPS`)
- [ ] `apps/web/src/components/site-header.tsx`: header with auth links
- [ ] `apps/web/src/components/site-header-links.tsx`: client part of the header (`returnTo`, `aria-current`)
- [ ] `apps/web/src/components/flash-notice.tsx`: one-time `welcome` notice and code stripping
- [ ] `apps/web/src/components/auth/{auth-card,oauth-buttons,text-field,password-field,sex-field,error-summary,form-banner,submit-button}.tsx`: form primitives
- [ ] `apps/web/src/components/auth/{login-form,register-form,complete-signup-form,forgot-password-form,reset-password-form,sign-in-methods}.tsx`: client forms wired to the Server Actions
- [ ] `apps/web/src/app/register/page.tsx`: register form
- [ ] `apps/web/src/app/register/complete/page.tsx`: OAuth sex prompt
- [ ] `apps/web/src/app/login/page.tsx`: sign-in page
- [ ] `apps/web/src/app/forgot-password/page.tsx`: request a reset (form and sent states)
- [ ] `apps/web/src/app/reset-password/page.tsx`: set a new password
- [ ] `apps/web/src/app/account/page.tsx`: account and connected methods
- [ ] `apps/web/src/app/account/error.tsx`: protected-page outage view
- [ ] `apps/web/src/app/auth/callback/[provider]/route.ts`: OAuth callback route handler (`.ts`: a Next route handler with no JSX)
- [ ] `apps/web/src/app/auth/session-expired/route.ts`: dead-cookie cleanup (X14 rule)
- [ ] `apps/web/src/lib/auth/session.ts`: `getCurrentUser()`, `requireUser()`
- [ ] `apps/web/src/lib/auth/actions.ts`: Server Actions for the auth forms
- [ ] `apps/web/src/lib/auth/cookies.ts`: cookie names, options, set and clear helpers (`sgm_session`, `sgm_oauth`, `sgm_pending`, `sgm_flash`)
- [ ] `apps/web/src/lib/auth/messages.ts`: notice and error code → copy deck text
- [ ] `apps/web/src/lib/auth/landing.ts`: outcome and error → redirect URL
- [ ] `apps/web/src/lib/auth/in-app-browser.ts`: in-app browser UA classifier
- [ ] `apps/web/src/lib/auth/client-address.ts`: client address from `X-Forwarded-For` with trusted hops
- [ ] `apps/web/src/proxy.ts`: protected-route redirect, Origin check, internal-header stripping, `/reset-password` headers (Next 16 name for middleware)
- [ ] extend: `apps/api/src/app.ts`, `apps/api/src/main.ts`, `apps/api/src/cli.ts`, `apps/api/src/openapi.ts` (inert deps, bearer scheme), `apps/api/src/routes/health.ts` (policy), `apps/api/src/lib/config/config.ts`, `apps/api/src/lib/logger/logger.ts`, `apps/api/src/jobs/{registry,bootstrap,schedules}.ts`, `apps/api/src/lib/db/types.generated.ts` (codegen), `apps/api/test/helpers/factories.ts` (users, identities, sessions, memberships), `packages/shared/src/index.ts`, `packages/shared/src/types/enums.ts`, `apps/web/src/lib/api-client.ts`, `apps/web/src/app/layout.tsx`, `apps/web/src/instrumentation.ts`, `apps/web/next.config.ts` (`serverActions.allowedOrigins`), `apps/web/playwright.config.ts` (mobile project), `db/schema-deviations.md`, `apps/api/openapi.yaml`, `vitest.config.ts`, `docker-compose.yml` (web: `WEB_BASE_URL`, `API_INTERNAL_SHARED_SECRET`, `WEB_TRUSTED_PROXY_HOPS`; api: `API_INTERNAL_SHARED_SECRET`, `AUTH_FAKE_OAUTH` passthrough), root `package.json` (`engines.node` `>=24.7 <25`), `.env.example`, `docs/getting-started.md`
- [ ] Dependencies: add `jose` (api) and `@axe-core/playwright` (web, dev). Do not add `arctic`, `argon2`, `@node-rs/argon2` (fallback only), `@fastify/cookie` or `@fastify/rate-limit`.
- [ ] `docs/adr/0013-authentication-sessions-and-route-authorization.md`: ADR for architecture Q1, Q2, Q5, Q6, Q8 with alternatives
- [ ] `docs/adr/0014-account-linking-and-login-throttling.md`: ADR for algorithm Q3 (incl. R1 per D1), Q4, Q7 with alternatives

### Phases
Each AC is assigned to exactly one phase: the phase that builds its API behaviour, unless its subject is web-owned. Where an API-phase AC also names web copy or landings (HAPPY-1, HAPPY-2, HAPPY-6, HAPPY-7, ERROR-1 to 4, ERROR-11, ERROR-16), Phase 4 or 5 builds that half and re-runs the AC; it is not re-assigned.
- [ ] Phase 1: Schema, contracts and wiring: the 5 migrations, deviations ledger (D-27 onwards), codegen and enum parity; `packages/shared/src/api/{auth,errors}.ts`, `packages/shared/src/auth/{email,return-to}.ts`; the HTTP error mapper, Origin hook and clock; API and web config vars; `buildApp`/`main.ts` dependency injection; engines bump; `health.ts` policy. ACs: VERIFY-4, VERIFY-5, VERIFY-7.
- [ ] Phase 2: Password auth, sessions, throttle and guards (API): hasher and password policy, tokens, sessions, `auth_throttle` port, internal-auth hook, Origin check; `register`, `login`, `logout`, `me`, `providers`; route policy registry and guards; CLI `users set-role`; log hygiene. ACs: HAPPY-1, HAPPY-2, HAPPY-7, HAPPY-8, HAPPY-9, HAPPY-10, ERROR-1, ERROR-2, ERROR-3, ERROR-4, ERROR-11, ERROR-12, ERROR-15, ASYNC-4, VERIFY-1, VERIFY-3, VERIFY-6, VERIFY-10, INTEGRATION-2.
- [ ] Phase 3: Password reset and cleanup: `password/forgot` (with the address limit) and `password/reset` with R1 eviction (D1) and `removedProviders`, reset email via `enqueueEmail` in the same transaction, `auth-cleanup` queue and schedule (incl. throttle rows). ACs: HAPPY-6, ERROR-5, ERROR-6, ERROR-16, ASYNC-1, ASYNC-2, ASYNC-3, INTEGRATION-1, INTEGRATION-5.
- [ ] Phase 4: Web password flows: web config, `SiteHeader` and `FlashNotice`, form primitives, `/register`, `/login`, `/forgot-password`, `/reset-password`, `/account` (no OAuth rows yet), Server Actions, cookies, `messages.ts`, `landing.ts`, `proxy.ts`, `/auth/session-expired`, `returnTo` validation, api-client bearer, `traceparent` and internal headers, client-address derivation, `POST /auth/password/reset/check` (COULD). ACs: ENTRY-1, ENTRY-3, ENTRY-4, ENTRY-5, ENTRY-6, ENTRY-7, HAPPY-13, ERROR-13, ERROR-18, ERROR-19, VERIFY-2, VERIFY-11, VERIFY-12, VERIFY-14.
- [ ] Phase 5: OAuth and identity linking: provider adapters, registry, PKCE, fake provider, the pure decision table, authorize/callback/pending/complete, `/auth/callback/[provider]` with the binding cookie, `/register/complete`, provider buttons and in-app hint, identities link and unlink on `/account`, identity-linked email. ACs: ENTRY-2, ENTRY-8, HAPPY-3, HAPPY-4, HAPPY-5, HAPPY-11, HAPPY-12, ERROR-7, ERROR-8, ERROR-9, ERROR-10, ERROR-14, ERROR-17, ERROR-20, ASYNC-5, VERIFY-13, VERIFY-15, INTEGRATION-3.
- [ ] Phase 6: End-to-end, contract and docs: Playwright `auth.spec.ts` covering every journey on desktop and mobile with axe scans, trace continuity, OpenAPI regeneration, coverage gate, `docs/getting-started.md` (OAuth setup, first admin, production trust settings), ADRs 0013 and 0014, `systemPatterns.md` auth pattern. ACs: INTEGRATION-4, VERIFY-8, VERIFY-9; recheck every MUST AC.

## Creative Phases

- [x] Architecture design → complete: `memory-bank/creative/auth-and-user-roles-architecture.md` (Q1, Q2, Q5, Q6, Q8)
- [x] Algorithm design → complete: `memory-bank/creative/auth-and-user-roles-algorithm.md` (Q3, Q4, Q7, plus email normalisation, password policy, token and session rules)
- [x] User Journey design → complete: `memory-bank/creative/auth-and-user-roles-user-journey.md` (added because Level 3 requires it; consumes the two docs above)

Consolidated 2026-10-06: spec and design docs reconciled (see Design Critique).

**Naming settled in consolidation** (used in all four files): single-use timestamp column `used_at` on `password_reset_tokens`, `oauth_states` and `oauth_pending_signups` (not `consumed_at`); OAuth intent values `signin` / `link` and callback outcomes `signed_in` / `pending_signup` / `linked` / `already_linked` (lowercase); `oauth_states.link_user_id` (not `bound_user_id`); `auth_sessions.user_agent varchar(512)`; `auth_sessions.revoked_reason` kept, values `logout` / `password_reset` / `replaced`; `oauth_pending_signups.full_name` (not `suggested_name`); error field map `fieldErrors` (not `fields`); login-failure log reasons `invalid_credentials` / `throttled_email` / `throttled_address`. Remapped journey AC ids: AC-A11Y-1 → AC-VERIFY-11, AC-MOBILE-1 → AC-VERIFY-12, AC-MOBILE-2 → AC-VERIFY-13, AC-NAV-1 → AC-ENTRY-7, AC-NAV-2 → AC-ENTRY-8.

### Design Critique (advisory)
- **Backend**: codex (adversarial-review), 2026-10-06. Log: `.claude-logs/codex-critique-20261006.log` (not committed)
- **Verdict**: needs-attention. The design leaves a persistent account-recovery bypass, trusts a client-IP chain that can be spoofed, and gives implementers conflicting OAuth and API contracts.
- **Findings**:
  1. [high] R1 keeps a stale Google identity after the inbox changes owner (algorithm.md:107-128). A historical `email_verified` assertion exempts the Google identity from eviction on reset, so a recycled address leaves the previous owner able to sign in.
     - Applied 2026-10-06 (user decision D1): every completed reset deletes all GOOGLE and FACEBOOK identities in the reset transaction, regardless of `email_verified_at` or any past provider assertion, and also upserts PASSWORD, revokes all sessions, invalidates other reset tokens and sets `email_verified_at`. `email_verified_at` is still set by Google sign-up and link but is informational only. Spec: AC-HAPPY-6, AC-ERROR-16 (incl. the recycled-email case); algorithm R1, decision table, edge cases and tests; journey F5, X12, copy and C-6.
  2. [high] The client-address throttle trusts forwarding data an attacker can influence (architecture.md:663). The first `x-forwarded-for` value is copied to `x-sgm-client-ip` with no allowlisted proxy chain and no authenticated web-to-API hop.
     - Applied 2026-10-06: enforced invariant. The web reads `X-Forwarded-For` from the right using `WEB_TRUSTED_PROXY_HOPS` and strips incoming `x-sgm-client-ip`/`x-sgm-internal-auth`; every web→API call carries `x-sgm-internal-auth` (`API_INTERNAL_SHARED_SECRET`), checked in constant time; the API ignores `x-sgm-client-ip` without it and never falls back to `request.ip`; production boot fails without either setting. Spec: AC-ERROR-4, AC-VERIFY-7, new AC-VERIFY-14; architecture "Client address" section and env vars.
  3. [medium] The OAuth binding-cookie contracts conflict (user-journey.md:707-715): architecture uses the raw state, the journey uses `<state>.<payload>`.
     - Applied 2026-10-06: one `sgm_oauth` schema in the architecture doc (`<state>.<ctx>`, ≤ 1024 bytes, constant-time compare of the state component only, `ctx.r` through `safeReturnTo`, `ctx.i` an untrusted hint with the `oauth_states` row authoritative, defined tamper/expiry/replay behaviour, interop tests); the journey references it; codec moved to `packages/shared/src/auth/oauth-binding.ts`. Spec: new AC-VERIFY-15.
  4. [medium] The HTTP contract still contradicts itself (architecture.md:665-684): the error-code enum differs from the algorithm and journey docs, and the spec says OpenAPI uses a cookie scheme while the architecture uses bearer.
     - Applied 2026-10-06: one authoritative `ErrorCode` list (algorithm/journey codes; `pending_signup_expired`, `oauth_email_conflict` and `identity_already_linked` removed) in the architecture doc, mirrored in the spec; `fieldErrors` everywhere; OpenAPI documents the bearer `sessionToken` scheme (AC-VERIFY-8).

---

## Execution State

**Build Status**: IDLE
**Current Phase**: CREATIVE → BUILD
**Current Step**: Creative complete; spec consolidation (AC impact, naming, critique findings) pending before Phase 1
**Can Resume**: NO
**Creative Critique**: CREATIVE CRITIQUE: codex — usable (needs-attention, 4 findings: all applied; finding 1 per user decision)

### Deviations
- Plan | branch base | `feature/auth-and-user-roles` is stacked on `feature/platform-foundation` (63dbc43), not `origin/main`, because origin/main has only the initial commit (push blocked with a 403). Rebase onto main once platform-foundation merges.

### Active Sub-Agents
- Architecture Design: COMPLETE
- User Journey Design: COMPLETE
- Algorithm Design: COMPLETE

### Completed Steps
- 2026-10-06 Plan: Spec Writer (Sonnet) drafted 52 ACs; taxonomy lint CLEAN; specification approved by the user as drafted; 6-phase plan written; Architecture and Algorithm creative phases flagged (Level 3 with LOW-confidence questions).
- Algorithm Creative Design: COMPLETE (2026-10-06) - Output: memory-bank/creative/auth-and-user-roles-algorithm.md (3A′ never auto-link + reset-proves-inbox R1; 4A block Facebook-without-email with rerequest; 7A Postgres sliding-log throttle)
- Architecture Creative Design: COMPLETE (2026-10-06) - Output: memory-bank/creative/auth-and-user-roles-architecture.md (own Fastify module; node:crypto argon2id; own provider adapters + jose; opaque DB sessions, web-owned cookie, bearer to API; onRoute default-deny policies; Postgres OAuth state + pending sign-ups; env-selected fake provider). Reconciliation: the throttle interface follows the algorithm doc (`admit`/`settle`, reserve-then-verify), superseding the architecture doc's `check/recordFailure/recordSuccess` sketch.
- User Journey Creative Design: COMPLETE (2026-10-06) - Output: memory-bank/creative/auth-and-user-roles-user-journey.md (dedicated single-purpose pages, OAuth buttons first, progressive-enhancement Server Actions, codes-only URLs, returnTo end to end; 10 flows, copy deck, contradictions X1–X14 resolved, contract additions C-1..C-7).
