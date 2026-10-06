# ADR 0014: Account linking and sign-in throttling

- Status: Accepted (2026-10-06)
- Task: auth-and-user-roles
- Source: [algorithm Q3, Q4, Q7](../../memory-bank/creative/auth-and-user-roles-algorithm.md)

## Context

Without an email-verification flow, an OAuth email that matches an existing account cannot be trusted: signing in or linking on that match lets someone who registered first (or a previous owner of a recycled inbox) take the account. Accounts carry real value (a wallet balance, fee-bearing registrations, team banking exports). Separately, password sign-in needs a brake on guessing that is exact across API replicas, hides whether an email is registered, and does not lock a whole venue out of a shared Wi-Fi.

## Decision

- **Never auto-link, never sign in on an email match; link only while signed in (Q3, option 3A').** A first-time OAuth identity whose email belongs to another user ends in 409 `oauth_account_exists` with no session and no identity attached. Linking happens only from `/account` for the signed-in user (`oauth_states.intent = 'link'`), and a connect sends a security-notice email in the same transaction as the identity insert.
- **Rule R1: every completed password reset evicts all Google and Facebook identities (user decision D1).** In the reset transaction the PASSWORD identity is upserted, every `GOOGLE` and `FACEBOOK` identity of the user is deleted whatever a provider asserted in the past, all sessions are revoked, other reset tokens are invalidated and the email's sign-in throttle count is cleared. Forgot-password is therefore the single recovery path for pre-hijacked accounts and recycled addresses, and also how an OAuth-only account adds a password. `users.email_verified_at` is informational and never exempts an identity.
- **No email-verification flow in v1.** A later flow can relax R1; until then the reset proves the inbox.
- **Facebook without an email is blocked with guidance (Q4, option 4A).** No `users` row is created; the page offers "Try Facebook again" (`auth_type=rerequest`) and the other methods. A known Facebook identity still signs in without an email.
- **Last method is protected in the database.** A deferred constraint trigger (`auth_identities_last_method`) refuses a commit that leaves a user with no identity, so two concurrent disconnects cannot remove both.
- **Postgres sliding-log throttle with reserve-then-verify (Q7, option 7A).** `auth_throttle_admit` records an attempt before the password is checked and `auth_throttle_settle` refunds it on success, all in one function call under row locks. Limits: 5 failures per email and 20 per client address in 15 minutes (`login_email`, `login_address`), forgot-password 10 per address per 60 minutes and a registration address limit, all configurable. A blocked attempt does no lookup and no hash, is not counted and does not extend the block; the 429 carries `Retry-After`. A completed reset or a successful sign-in clears the email's count; the address row is never cleared by a success (an attacker with one valid account cannot launder guesses).
- **Keyed pseudonyms only.** The key is `HMAC-SHA256(K_throttle, scope || 0x00 || value)` with `K_throttle` derived by HKDF from the active encryption key. No email or address is stored in clear, and the scheduled `auth-cleanup` job deletes rows once their window has passed (within about a day).
- **The address comes only from the trusted chain.** See ADR 0013: a client-supplied `X-Forwarded-For` or `x-sgm-client-ip` cannot choose an address key. When there is no trusted address the address dimension is skipped with a rate-limited warning and the per-email limit still protects each account.

## Alternatives considered

- **3A, never link, no reset hardening.** Leaves persistent pre-hijacking open (R1 closes it with two SQL statements in a transaction the reset already runs).
- **3B, auto-link when both sides are verified.** Needs a verification flow, "unverified" states in every later feature and inbox-dependent sign-up; Facebook never asserts verification, so it would apply to Google only. Not more secure than 3A'.
- **3C, conflict screen with password re-authentication.** Saves one redirect but adds a second password surface. Revisit if `auth.oauth.conflict` exceeds about 5% of callbacks.
- **3D, trust the provider email and link.** Rejected: account takeover by a provider account that merely claims the address.
- **4B/4C, collect an email on `/register/complete`, optionally verified by a code.** Reopens the verification question Q3 keeps out of v1; phone-only Facebook users have two other methods. Revisit if `auth.oauth.email_missing` exceeds about 5% of Facebook first-time callbacks.
- **7B, fixed-window counter.** Simpler but lets up to 9 failures through in a sliding 15 minutes.
- **7C, GCRA.** Changes the semantics the acceptance criterion and message are written in.
- **7D, `@fastify/rate-limit` with memory or Redis.** Memory fails across replicas; Redis is new infrastructure; both count requests, not failures.

## Consequences

- A user who registered by password and then taps Google sees the conflict page and has to sign in first, then connect (one extra step, with a direct `returnTo=/account` link).
- A legitimate reset also disconnects the user's Google and Facebook sign-in; the reset form warns beforehand and the sign-in page explains and points to `/account` afterwards.
- One or two small writes per sign-in, and a hot address row (a venue NAT) serialises admits for microseconds.
- A crash between admit and verify leaves one phantom failure that expires within the window; a known email can be locked out for 15 minutes by spraying, but the owner can still reset or use OAuth.
- Changing a limit is a config change (`AUTH_LOGIN_*`, `AUTH_FORGOT_MAX_PER_ADDRESS`, `AUTH_REGISTER_MAX_PER_ADDRESS`); changing the semantics is a migration of the two SQL functions (`db/schema-deviations.md`).
