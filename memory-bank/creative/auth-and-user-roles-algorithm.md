# Algorithm Decision: Auth and User Roles (account linking, Facebook without email, login throttling, token and session rules)

**Created**: 2026-10-06
**Status**: DECIDED
**Decision Type**: Algorithm
**Task**: auth-and-user-roles (Level 3)
**Questions owned**: Q3 (OAuth linking and email conflicts, email verification in v1), Q4 (Facebook without email), Q7 (login throttling across API replicas), plus email normalisation, password policy, reset-token and session-token lifetimes, single-use consumption, and session sliding expiry.
**Not decided here** (architecture doc `auth-and-user-roles-architecture.md`): library and hasher (Q1), session transport, cookie relay and CSRF (Q2), RBAC guard mechanics (Q5), OAuth redirect topology and the storage of OAuth state and pending sign-ups (Q6), fake provider (Q8). The rules below use an abstract store; see "Assumptions about the architecture" at the end.

## Problem Statement

Self-registration with email/password, Google and Facebook has to resolve four algorithmic questions safely for a small NZ sports-club audience:

1. When an OAuth sign-in returns an email that already belongs to a local account, what happens? The answer must hold up against **account pre-hijacking** (an attacker registers the victim's email first and keeps a back door), without an email-verification step at registration (out of scope in the approved spec).
2. What happens when Facebook returns no email?
3. How are failed sign-ins throttled per email and per client address, consistently across several API replicas, without storing IP addresses and without leaking which emails have accounts?
4. The supporting rules every flow depends on: how emails are normalised, which passwords are accepted, how long reset and session tokens live, how they are consumed exactly once, and how sliding session expiry is written without a database write on every request.

## Inputs & Outputs

### Inputs
| Name | Type | Size/Range | Source |
|------|------|------------|--------|
| Raw email | string | ≤ 254 chars after trim | `/register`, `/login`, `/forgot-password`, CLI, provider profile |
| Password | string | 10–128 code points after NFKC | `/register`, `/login`, `/reset-password` |
| Provider assertion | `{ provider, subject, email?, emailVerified?, name? }` | one per callback | Google ID token (`sub`, `email`, `email_verified`, `name`), Facebook Graph `/me?fields=id,name,email` |
| Flow intent | `signin` \| `link` (+ `link_user_id` for `link`) | per OAuth flow | `oauth_states` row (architecture Q6) |
| Current session | `{ userId } \| null` | per request | bearer session token sent by the web (architecture Q2) |
| Client address | IPv4 / IPv6 string or absent | per request | `request.clientAddress`, set only over the secret-authenticated web hop (architecture "Client address trust boundary") |
| Clock `now` | `Date` | injected | `deps.clock` (tests advance it) |
| Reset / session token | 32 random bytes, base64url (43 chars) | per issue | `crypto.randomBytes(32)` |

### Outputs
| Name | Type | Description |
|------|------|-------------|
| OAuth outcome | `signed_in` \| `pending_signup` \| `linked` \| `already_linked` \| error code | Result of the decision table in Q3 |
| Throttle verdict | `{ admitted: boolean, retryAfterSeconds: number }` | Result of `auth_throttle_admit` |
| Normalised email | ASCII string | Stored in `users.email` and `auth_identities.provider_subject` (PASSWORD) |
| Password verdict | ok \| `fieldErrors.password` | Length and blocklist checks |
| Session state | `valid` \| `expired` \| `revoked` + optional touch | Per-request validation result |

### Edge Cases
1. Provider subject already linked, but the provider now reports a different email → sign in as the linked user, never update `users.email`.
2. OAuth email matches a local account and the provider is Google with `email_verified=true` → still no sign-in and no link (Q3).
3. Pre-hijacked account (attacker registered the victim's email by password and connected their own Facebook) → the victim's completed password reset removes the attacker's identities and sessions (rule R1).
3a. Recycled inbox (the previous owner of an address signed up with Google, which asserted `email_verified=true`; the address later belongs to someone else) → the new owner's completed reset removes the GOOGLE identity too, so the previous owner's "Continue with Google" afterwards hits row S4 (`oauth_account_exists`) and cannot sign in (R1 as amended by user decision D1).
4. Two browser tabs complete the same first-time Google sign-up → one creates the user, the other signs in as that user.
5. Unknown email at `/login` → same throttle accounting, same dummy-hash cost, same 401 as a wrong password.
6. 20 concurrent wrong-password attempts for one email → exactly 5 password verifications.
7. A shared venue Wi-Fi (many players behind one NAT address) → the per-address limit is set higher than the per-email one.
8. Client address missing (no trusted hop, untrusted or missing internal secret outside production) → the address dimension is skipped, the email dimension still applies, and a warning is logged. Production cannot boot without the trust settings.
9. Email with uppercase letters, surrounding spaces, or an IDN domain such as `māori.nz` → lowercased, trimmed, domain converted to punycode; a non-ASCII local part is rejected.
10. Empty, whitespace-only or 129+ code-point password → 422 before any hashing.
11. Reset token submitted twice concurrently → exactly one succeeds (guarded UPDATE).
12. Session used continuously for 30 days → expires at the absolute cap regardless of activity.

## Constraints

### Performance Requirements
- **Maximum Latency**: sign-in API p95 under 1 s, excluding the intentional hash cost (spec NFR). Everything except the hash must add under 10 ms.
- **Throughput**: bursty sign-ins when a popular session opens, on the order of hundreds per minute at peak (foundation estimate for registration bursts).
- **Memory Budget**: constant per request; one in-process `Set` for the common-password list (a few hundred KB).

### Scale Requirements
- **Current Data Size**: hundreds to low thousands of users; at most a few sessions per user.
- **Expected Growth**: 10× over 2 years (tens of thousands of users).
- **Peak Load**: tens of concurrent sign-ins; a venue NAT can concentrate 20–40 players on one address.

### Other Constraints
- **P1**: invariants (email normal form, single-use tokens, one identity per provider per user, never zero sign-in methods) live in the database.
- **P3**: all timestamps are `timestamptz` UTC; the clock is injected.
- **P5**: emails (reset, security notifications) go through `enqueueEmail` in the same transaction as the domain write.
- **P7**: thresholds and lifetimes are env-configurable and validated at boot with ranges.
- **Hosting (ADR 0007, foundation architecture)**: several stateless API replicas, Postgres only (no Redis), and the API is reachable only server-side from the web, so `request.ip` at the API is the web container, not the browser.
- **Privacy (NZ Privacy Act 2020, IPP 1, 5, 9, 11)**: no IP address stored (spec). Emails typed by people who have no account are personal information about non-users and must not be stored in clear either.
- **Enumeration resistance**: AC-ERROR-3, AC-ERROR-6 and AC-VERIFY-10. Note that registration's 409 `email_taken` (AC-ERROR-1) already reveals that an account exists, so the OAuth conflict message does not create a new disclosure channel.

---

## Options Explored

### Q3: OAuth account linking and email conflicts

The threat model that decides this question:
- **Classic pre-hijack**: attacker registers `victim@x` with a password (no verification exists). The victim later uses "Continue with Google". If the system auto-links on email, the attacker's password still opens the victim's account.
- **Persistent pre-hijack**: same start, but the attacker also signs in and connects *their own* Facebook. Even if the victim later resets the password, the attacker's Facebook identity still opens the account. The spec's default (never auto-link) does **not** close this variant by itself.
- **OAuth-first pre-hijack**: attacker signs up with a Facebook account claiming `victim@x` (Facebook gives no verification claim). The victim later finds `email_taken`.
- **Google `email_verified`**: Google is authoritative only for `@gmail.com` and Workspace domains (the `hd` claim). For other domains, `email_verified=true` means the address was verified at some point, so it is strong evidence but not proof of current ownership.
- **Facebook**: no verification claim; the email is only "the primary email Facebook has".

#### Option 3A: Never auto-link (spec default)
- **Approach**: a known `(provider, subject)` signs in. An unknown subject whose email matches a local account is blocked with guidance to sign in by the existing method and connect the provider from `/account`. Linking happens only while signed in.
- **Pseudocode**:
  ```
  function oauthSignIn(a):
      if identity(a.provider, a.subject) exists: return signed_in(owner)
      if userByEmail(a.email) exists: return ERROR(oauth_account_exists)
      return pending_signup
  ```
- **Time Complexity**: Best/Average/Worst O(1) indexed lookups (2 unique-index probes).
- **Space Complexity**: O(1).
- **Data Structures**: `UNIQUE(provider, provider_subject)`, `UNIQUE(users.email)`.
- **Pros**: no silent merges, so the classic pre-hijack fails; no verification flow needed; trivially testable.
- **Cons**: does not close the persistent pre-hijack (attacker-connected identity survives a reset). A user who registered by password and later clicks Google has to sign in and repeat the OAuth round trip.
- **Best For**: small audiences, no verification infrastructure.
- **Worst For**: products with many "I forgot which button I used" users.

#### Option 3A′: Never auto-link, plus "reset proves the inbox" hardening (implicit verification)
- **Approach**: 3A, plus **rule R1** (as amended by user decision D1, 2026-10-06): **every** completed password reset, in one transaction, deletes **all** non-PASSWORD identities (GOOGLE and FACEBOOK, whatever any provider asserted in the past), upserts the PASSWORD identity, revokes all sessions, invalidates the user's other reset tokens, sets `users.email_verified_at = now` and clears the `login_email` throttle row. Whoever proves the inbox now owns the account, and every method attached by anyone else, at any time, is evicted. A nullable `users.email_verified_at` records inbox proof: it is set by a completed reset, and also by a Google sign-up (C5) or link (L4) when Google asserts `email_verified=true` for the account's email. It is **informational only** in v1: no rule reads it, it never exempts an identity from R1, and it is not shown in the v1 UI; it exists for the future email-verification flow.
- **Pseudocode**:
  ```
  function completeReset(token, newPassword):
      tx:
        uid = consumeToken(token)                     # guarded UPDATE ... RETURNING
        lock users[uid] FOR UPDATE
        upsert PASSWORD identity(uid, users[uid].email, hash(newPassword))   # before the delete: the last-method trigger sees ≥ 1 identity at commit
        removed = DELETE auth_identities WHERE user_id=uid AND provider <> 'PASSWORD' RETURNING provider   # unconditional (D1)
        UPDATE users SET email_verified_at = now WHERE id = uid
        revoke all sessions(uid, reason='password_reset'); invalidate other reset tokens(uid); clear login_email throttle
      return { removedProviders: removed }
  ```
- **Time Complexity**: O(1) for the OAuth path (same as 3A); reset adds O(k) for k ≤ 3 identities.
- **Space Complexity**: one nullable column.
- **Data Structures**: as 3A plus `users.email_verified_at`.
- **Pros**: closes all three pre-hijack variants **and** the recycled-inbox case (a historical Google `email_verified` assertion no longer keeps a previous owner's identity alive, codex critique finding 1) with no new email flow, page or token type. Forgot-password also becomes the recovery path for OAuth-only users. The rule has no branches, so it is simple to test.
- **Cons**: every user who resets loses their connected Google and Facebook sign-in and has to reconnect it (two clicks each). This is accepted (D1): resets are rare, the loss is warned about before (on `/account` and in the reset form hint) and explained after, and recoverability of the account outweighs the inconvenience.
- **Best For**: this product, with its small audience, no verification flow, and wallet and team-banking access worth protecting.
- **Worst For**: a large audience of Facebook-first users who often reset passwords.

#### Option 3B: Auto-link when both sides are verified (pulls email verification into v1)
- **Approach**: add a verification link at registration. Auto-link an unknown OAuth subject to a local account when the provider asserts the same email verified, authoritatively (Google and `@gmail.com`/`hd` only; never Facebook), **and** the local email is verified.
- **Pseudocode**:
  ```
  if identity known: signed_in
  m = userByEmail(a.email)
  if m and m.email_verified_at and a.provider == GOOGLE and a.emailVerified and googleAuthoritative(a):
      link(m, a); return signed_in(m)
  if m: return ERROR(oauth_account_exists)
  return pending_signup
  ```
- **Time Complexity**: O(1) per callback; adds a verification token flow (O(1) per verification).
- **Space Complexity**: verification tokens table (or a purpose column on reset tokens).
- **Pros**: smoothest returning-user UX; the industry pattern.
- **Cons**: brings email verification into v1 (new page, template, token purpose, "unverified" states in every later feature such as team join and registration gating); sign-up then has to wait on an inbox, against the persona target of registering in under 30 s. Google is authoritative for only part of the address space, and Facebook never qualifies, so the benefit is partial. Security is no better than 3A′.
- **Best For**: large consumer apps with high OAuth/password crossover.
- **Worst For**: a solo-developer v1 with a sub-minute onboarding goal.

#### Option 3C: Conflict screen with password re-authentication
- **Approach**: on an email conflict, keep the provider assertion in a pending-link record and show "Enter your password to connect Google". The correct password links and signs in.
- **Pseudocode**:
  ```
  if identity known: signed_in
  m = userByEmail(a.email)
  if m: pl = createPendingLink(m, a); return NEEDS_PASSWORD(pl)
  ...
  function confirmLink(pl, password): throttle(email); verify(m, password); link(m, pl); signed_in(m)
  ```
- **Time Complexity**: O(1) plus one hash verification.
- **Space Complexity**: a pending-link record type (architecture Q6 store).
- **Pros**: saves one OAuth round trip; as safe as 3A, since knowing the password is already sufficient to link from `/account`.
- **Cons**: a second password-entry surface that needs throttling, enumeration care and tests. OAuth-only and pre-hijack-victim accounts can't use it (they have no password), so it still needs the 3A′ reset path. Does not close the persistent pre-hijack by itself.
- **Best For**: products where conflicts are frequent.
- **Worst For**: v1 scope, which has 52 ACs already.

#### Option 3D: Trust the provider email and auto-link (rejected baseline)
- **Approach**: any OAuth sign-in whose email matches a local account signs into and links that account (Auth.js `allowDangerousEmailAccountLinking`).
- **Complexity**: O(1).
- **Pros**: zero friction.
- **Cons**: the classic pre-hijack succeeds outright, and with Facebook's unverified emails anyone can take over an account by creating a Facebook account with the victim's address. Unacceptable.

### Q4: Facebook without an email

Facebook omits `email` when the account has none (phone-only sign-up) or when the user declined the `email` permission in the consent dialog. Declined permissions can be asked again with `auth_type=rerequest`.

#### Option 4A: Block sign-up with guidance and a re-request button
- **Approach**: an unknown Facebook subject with no usable email → `oauth_email_missing`. The page explains the problem and offers "Try Facebook again and share your email", which restarts authorize with `auth_type=rerequest`, plus the other methods. A known subject without an email still signs in (the email is irrelevant once linked), and linking from `/account` works without an email.
- **Complexity**: O(1); no new state.
- **Pros**: consistent with Q3 (every account email is either user-typed at password registration and then provable by reset, or provider-supplied); no unverified-email capture path; recovers the "declined permission" case, which is likely the common one.
- **Cons**: phone-only Facebook users must pick another method.

#### Option 4B: Collect an email on `/register/complete` (unverified)
- **Approach**: the pending sign-up has no email, so `/register/complete` adds an Email field. A taken address follows the conflict rules.
- **Complexity**: O(1); one more pending-sign-up field and a branch in the form and contract.
- **Pros**: no dead end for phone-only users.
- **Cons**: creates accounts whose email no one has proven, which is the OAuth-first pre-hijack shape (R1 does mitigate it). A typo makes the reset path deliver to a stranger. Adds a branch to the form, contract and tests for a minority case.

#### Option 4C: Collect an email and verify it with a code before creating the account
- **Approach**: 4B plus a 6-digit code emailed through `send-email`; the user row is created only after the code is entered.
- **Complexity**: O(1) per step; new token purpose, throttling of code guesses, an extra page.
- **Pros**: no unproven emails.
- **Cons**: this is an email-verification flow, which the spec puts out of scope (the same cost as 3B), built for a minority path.

### Q7: Login throttling across API replicas

Fixed by the spec: 5 failures per email per 15 minutes; the 6th attempt returns 429 even with the right password and does not verify; Retry-After; "after the window the correct password works"; enumeration-neutral. Each candidate is judged on whether it is exact across N replicas, counts failures rather than requests, can key by email, and stores no IP address.

#### Option 7A: Postgres sliding log, one row per key, atomic admit/settle functions
- **Approach**: table `auth_throttle(scope, key_hash, attempts timestamptz[], updated_at)`. `key_hash` is HMAC-SHA256 of the normalised email or the truncated client address. A plpgsql function `auth_throttle_admit` locks the rows for the request's keys in a fixed order, prunes timestamps older than the window and, only if **no** key is at its limit, appends `now` to every key as a *provisional failure* (reserve before verify). On success, `auth_throttle_settle` deletes the email row (reset) and removes the provisional entry from the address row (refund). On failure, nothing more is written because the reservation is the failure record. Blocked attempts append nothing, so hammering cannot extend a lockout.
- **Pseudocode**:
  ```
  function login(email, password, addr):
      keys = [('login_email', hmac(email), 5), ('login_address', hmac(trunc(addr)), 20)?]
      v = db.auth_throttle_admit(keys, window=15m, now)          # 1 round trip
      if not v.admitted: return 429(retryAfter=v.retryAfterSeconds)   # no lookup, no hash
      ident = findPasswordIdentity(email)
      ok = hasher.verify(ident?.hash ?? DUMMY_HASH, password) and ident != null
      if ok: db.auth_throttle_settle(keys, now); issueSession(); return 200
      return 401 invalid_credentials                              # failure already recorded
  ```
- **Time Complexity**:
  - Best: O(1), a first attempt that creates the rows.
  - Average: O(k·L) with k ≤ 2 keys and L ≤ 20 timestamps, so effectively constant (under 50 array elements).
  - Worst: O(k·L) plus lock wait when one key is hot (a venue NAT row), serialised for microseconds per request.
- **Space Complexity**: O(active keys × L); rows are removed by cleanup once their newest attempt has left the window.
- **Data Structures**: B-tree PK `(scope, key_hash)`; small `timestamptz[]` per row.
- **Pros**: exact sliding-window semantics ("5 within any 15 minutes"); exact under concurrency (the row lock serialises admits, so 20 parallel wrong guesses produce exactly 5 verifications); one source of truth across replicas; no new infrastructure (P1, no Redis); stores no email and no IP in clear; Retry-After is exact. The 429 path skips both the user lookup and the hash, so it costs the same for known and unknown emails.
- **Cons**: one or two small writes per sign-in (admit, plus settle on success); a plpgsql function to maintain and test; a crash between admit and settle leaves one phantom failure (it expires within the window).
- **Best For**: few-replica deployments already on Postgres with modest sign-in volume.
- **Worst For**: very high request rates (thousands per second), where a Redis or edge limiter is cheaper.

#### Option 7B: Postgres fixed-window counter anchored at the first failure
- **Approach**: row `(scope, key_hash, window_started_at, failures int)`. One UPSERT: if the window expired, reset to `(now, 1)`, else `failures + 1`; blocked when `failures ≥ L`; Retry-After `= window_started_at + W − now`.
- **Pseudocode**:
  ```
  INSERT ... ON CONFLICT DO UPDATE SET
    window_started_at = CASE WHEN t.window_started_at <= now - W THEN now ELSE t.window_started_at END,
    failures = CASE WHEN t.window_started_at <= now - W THEN 1 ELSE t.failures + 1 END
  RETURNING failures, window_started_at
  ```
- **Time Complexity**: O(1) in every case.
- **Space Complexity**: O(active keys), fixed row width.
- **Pros**: simplest SQL; O(1) storage per key.
- **Cons**: allows up to 2L−1 failures inside one sliding 15-minute span (L at the end of one window, L at the start of the next), so the AC's "5 within 15 minutes" holds only per anchored window. Making it reserve-then-verify needs the same refund logic as 7A anyway. Multi-key all-or-nothing still needs a function.
- **Best For**: when an approximate limit is enough.
- **Worst For**: exact AC tests at window boundaries.

#### Option 7C: GCRA (generic cell rate algorithm) in Postgres
- **Approach**: one `tat timestamptz` per key; emission interval T = W/L = 3 min, burst tolerance τ = (L−1)·T = 12 min. Admit if `max(tat, now) − now ≤ τ`, then `tat = max(tat, now) + T`.
- **Time Complexity**: O(1) everywhere.
- **Space Complexity**: O(active keys), 1 timestamp each.
- **Pros**: smallest state; smooth rate; no array maths.
- **Cons**: the semantics are "5 at once, then 1 every 3 minutes", not "5 per 15 minutes". The AC's message "Try again in {n} minutes" becomes 3 for the next single attempt, which is harder to explain and test against the AC as written. A refund on success means rewinding `tat`, which is awkward with concurrent requests.
- **Best For**: API request-rate limiting.
- **Worst For**: failure-counting lockouts with user-facing wording.

#### Option 7D: `@fastify/rate-limit` (shared Redis store) or in-memory per replica
- **Approach**: register the plugin on `POST /auth/login` keyed by `request.ip` (or a custom key), with the default in-memory LRU store per replica or `ioredis` for a shared store.
- **Time Complexity**: O(1) per request.
- **Space Complexity**: O(keys) per replica, or in Redis.
- **Pros**: off-the-shelf; standard 429 and Retry-After headers.
- **Cons**: counts **requests**, not failures, so a successful sign-in consumes budget and a NAT full of successful logins hits the limit; per-email failure semantics need hand-written hooks around it. The in-memory store is per replica, so the effective limit is N×5 and resets on every deploy, which fails the AC across replicas. The shared store needs Redis, which the foundation explicitly avoided (one fewer service). At the API, `request.ip` is the web container, so every user shares one key unless the address is relayed anyway.
- **Best For**: generic per-IP flood protection at a public edge.
- **Worst For**: per-account failure throttling behind a server-side relay.

### Supporting rule S1: Email normalisation

| Option | Rule | Assessment |
|--------|------|------------|
| S1-a | `trim` + `toLowerCase()` only | Simple, but JS and Postgres `lower()` disagree on some non-ASCII characters (`İ`, ICU vs libc ctype), so a CHECK `email = lower(email)` could reject what JS produced, or the reverse. |
| **S1-b** | `trim` → NFC → split at the last `@` → local part must be ASCII and is lowercased → domain via `url.domainToASCII()` (punycode) then lowercased → length ≤ 254 → zod email check | Stored value is pure ASCII, so `lower()` is deterministic in any collation and the DB CHECK is exact. IDN `.nz` domains (macrons) still work through punycode. Rejects SMTPUTF8 local parts, which are vanishingly rare and poorly supported by email providers. |
| S1-c | S1-b + provider canonicalisation (drop Gmail dots and `+tags`) | Merges mailboxes that are distinct on other providers, breaks the reset path for the plus-tag a user actually typed, and reveals to an attacker which variants collide. Rejected. |
| S1-d | Preserve case; `citext` or a unique index on `lower(email)` | Contradicts the spec (`users.email` stored lowercase, AC-VERIFY-5 23514 on mixed case) and P1 simplicity. Rejected. |

### Supporting rule S2: Password policy

| Option | Rule | Assessment |
|--------|------|------------|
| S2-a | Length 10–128 only | Meets the spec's ACs; NIST SP 800-63B and OWASP ASVS also require a blocklist of commonly used and compromised values. |
| **S2-b** | NFKC, then 10–128 code points, no composition rules, no expiry, and reject (case-insensitively) values on a bundled common-password list or equal to the email or its local part | Offline, deterministic, unit-testable, no third-party call or cross-border transfer. Catches the passwords credential stuffers try first. |
| S2-c | S2-b + Have I Been Pwned range API (k-anonymity, 5-char SHA-1 prefix) | Best coverage, but a runtime dependency on an external service (timeouts, fail-open policy, config, fixtures) for a 12-user club app. Deferred: the check sits behind a `PasswordBlocklist` interface so an HIBP adapter can be added later. |
| S2-d | 15-character minimum (NIST SP 800-63B-4 for single-factor) | Strongest, but friction against the under-a-minute sign-up goal for casual players. Kept at 10 plus the blocklist; revisit with MFA work. |

### Supporting rule S3: Session sliding expiry write pattern

| Option | Write pattern | Assessment |
|--------|---------------|------------|
| S3-a | `UPDATE last_seen_at, expires_at` on every authenticated request | Exact idle expiry; one write per request (write amplification, WAL churn, row contention when a page fires parallel API calls). |
| **S3-b** | Throttled touch: write only when `now − last_seen_at ≥ 1 h`, guarded so concurrent requests write once | At most 24 writes per session per day; idle expiry is exact to within 1 h (it may fire up to 1 h early, never late). |
| S3-c | No sliding: fixed 30-day expiry | No writes, but no idle expiry, against AC-ASYNC-4. Rejected. |

---

## Complexity Comparison

| Metric | 3A | **3A′** | 3B | 3C | 7A (chosen) | 7B | 7C | 7D (memory) |
|--------|----|---------|----|----|-------------|----|----|-------------|
| Time (Best) | O(1) | O(1) | O(1) | O(1)+hash | O(1) | O(1) | O(1) | O(1) |
| Time (Avg) | O(1) | O(1) | O(1) | O(1)+hash | O(k·L)≈O(1) | O(1) | O(1) | O(1) |
| Time (Worst) | O(1) | O(1); reset O(3) | O(1) | O(1)+hash | O(k·L)+lock wait | O(1)+lock | O(1)+lock | O(1) |
| Space | O(1) | 1 column | token table | pending-link store | O(keys·L) | O(keys) | O(keys) | O(keys) per replica |
| DB writes per login | n/a | n/a | n/a | n/a | 1 (fail), 2 (success) | 1–2 | 1–2 | 0 |
| Exact across replicas | n/a | n/a | n/a | n/a | Yes | Approx. (2L−1) | Yes (different semantics) | No |
| Closes persistent pre-hijack | No | **Yes** | Yes (verification) | No | n/a | n/a | n/a | n/a |
| Implementation | Simple | Simple | Complex | Medium | Medium | Simple | Medium | Simple |

## Performance Projection

At the expected scale (low thousands of users, peaks of a few sign-ins per second):

| Step (per password sign-in) | Expected latency | Memory |
|-----------------------------|------------------|--------|
| `auth_throttle_admit` (2 keys, 1 round trip) | 1–2 ms | constant |
| Identity lookup by `(PASSWORD, email)` | < 1 ms | constant |
| Hash verify (real or dummy) | 50–300 ms (AC-VERIFY-1 bounds 50 ms–1 s) | hasher's memory cost (architecture Q1) |
| `auth_throttle_settle` (success only) | < 1 ms | constant |
| Session insert + `last_used_at` update | 1–2 ms | constant |
| **Total excluding hash** | **≈ 3–6 ms** | |
| 429 path | ≈ 1–2 ms (no lookup, no hash) | |

The OAuth decision table costs at most 3 unique-index probes (≈ 1–3 ms) plus the provider round trip, which dominates. A peak of 200 sign-ins per minute is 3.3 per second, or about 0.3–1 CPU core of hashing in total. The throttle adds about 7 throttle-row writes per second at peak, which is negligible.

---

## Decision

### Q3: **Chosen: Option 3A′** (never auto-link, never sign in on an email match, link only while signed in, plus rule R1 "a completed reset proves the inbox and evicts every Google and Facebook identity"). R1 originally exempted accounts whose email was already proven; user decision D1 (2026-10-06) removed that exemption, so the choice of 3A′ stands with an unconditional R1. **Email verification does not enter v1 as a flow.** v1 adds the nullable, informational `users.email_verified_at` column, set as described.

#### Rationale
- Pre-hijacking is the dominant risk for an account system with no verification flow, and accounts here have real value (wallet balance up to $100, registrations that incur fees, team banking and exports for TEAM_ADMINs). 3A alone stops the classic variant but leaves the persistent one open. R1 closes it with two SQL statements inside a transaction the reset already runs. That makes the forgot-password flow the single recovery path for every pre-hijack variant, and for OAuth-only users.
- 3B gives better UX for one cross-over path, at the cost of a verification flow, "unverified" states every later feature would need to respect, and inbox-dependent sign-up, against the persona goal of registering in under 30 s. Its auto-link would apply only to Google-authoritative addresses, never Facebook. It is not more secure than 3A′.
- 3C saves one redirect but adds a second password surface. It is a good follow-up if `auth.oauth.conflict` events turn out to be frequent.
- NZ Privacy Act: the conflict message names the email only to someone who just authenticated with a provider that returned it, and registration's 409 already discloses existence (IPP 11 impact unchanged). Provider emails are kept only in the short-lived pending sign-up; `auth_identities` stores no provider email (IPP 1 data minimisation).
- Support burden: the conflict page links straight to `/login?returnTo=/account` and to "Forgot your password?", so a confused player reaches a working state in one step, without contacting a team admin.

#### Decision table: OAuth callback (after the architecture layer has validated and consumed `state`)

Definitions: `P` = provider, `S` = provider subject, `E` = provider email after S1 normalisation (`∅` if missing or not normalisable), `V` = verified (`true` only for Google with `email_verified=true`; Facebook is always `false`), `O` = owner of identity `(P, S)` if any, `M` = local user with `users.email = E` if any, `U` = user bound to a `link` flow at authorize time (`oauth_states.link_user_id`), `cur` = user of the session presented at callback.

**Row 0 (all intents):** consent denied, state missing/unknown/expired/used, or provider token/userinfo failure → AC-ERROR-7 outcomes (architecture Q6 owns detection; messages unchanged).

**Intent `signin`** (from `/login` or `/register`; an existing session is ignored and replaced on success, revoked with `revoked_reason='replaced'`):

| # | Identity (P,S) known? | E | V | Local M with email E? | Outcome | Code / HTTP | User-facing message (on `/login` unless noted) |
|---|---|---|---|---|---|---|---|
| S1 | Yes (owner O) | any | any | any | Sign in as O; rotate session; `last_used_at = now`; never change `users.email` | 200 `signed_in` | (lands on `returnTo` or `/`) |
| S2 | No | ∅ | n/a | n/a | Block; nothing created | 422 `oauth_email_missing` | Facebook: "Facebook didn't share an email address, which we need to create your account. Try again and allow access to your email, or use Google or email and password instead." with button "Try Facebook again" (authorize with `auth_type=rerequest`). Google: "Google didn't share an email address we can use. Use another sign-in method." |
| S3 | No | present | false, P = GOOGLE | n/a | Block; nothing created | 422 `oauth_email_unverified` | "Google says this email address isn't verified. Verify it with Google or use another method." |
| S4 | No | present | any (Facebook) / true (Google) | Yes | Block; no session, no link; log `auth.oauth.conflict` (userId of M, provider; no email) | 409 `oauth_account_exists` (with `error.email = E` for the web server, architecture C-5) | "An account already exists for {E}. Sign in with your existing method, then connect {Google\|Facebook} from your Account page." Links: "Sign in" → `/login?returnTo=%2Faccount`, "Forgot your password?" → `/forgot-password` |
| S5 | No | present | any (Facebook) / true (Google) | No | Create pending sign-up `{P, S, E, V, name}` (TTL 15 min); redirect to `/register/complete` | 200 `pending_signup` | (shows `/register/complete`) |

**Completion `POST /auth/oauth/complete`** (pending sign-up `ps`, form `{ fullName, sex }`):

| # | Condition | Outcome | Code / HTTP | Message |
|---|---|---|---|---|
| C1 | Form invalid (no sex, name empty or > 255) | 422; `ps` **not** consumed | 422 `validation_failed` | "Select your sex to continue." / "Enter your name." |
| C2 | `ps` missing, expired or already used (guarded `UPDATE … SET used_at` returns 0 rows) | Nothing created | 400 `signup_expired` | "Your sign-up session expired. Please start again." |
| C3 | In the transaction, identity `(P,S)` now exists (second tab finished first) | Consume `ps`; sign in as its owner | 200 `signed_in` | n/a |
| C4 | In the transaction, `users.email = E` now exists (23505 on `users.email`) | Roll back; consume `ps` in a new statement | 409 `oauth_account_exists` | same as S4 |
| C5 | Otherwise | Consume `ps`; insert `users` (role PLAYER, sex, name, email E, `email_verified_at = now` iff `P = GOOGLE ∧ V`, informational only); insert identity `(P, S)`; issue session | 201 `signed_in` | (lands on `returnTo` or `/`) |

On 23505 for `uq_auth_identities_provider_subject` inside C5, re-run the decision once (it resolves to C3).

**Intent `link`** (started from `/account` while signed in as U = `oauth_states.link_user_id`):

| # | Condition | Outcome | Code / HTTP | Message (on `/account` unless noted) |
|---|---|---|---|---|
| L0 | `cur` is null, expired, or `cur ≠ U` | Nothing linked | 401 `session_expired` or 403 `link_session_mismatch` | "Sign in again to connect {Provider}." (redirect to `/login?returnTo=%2Faccount`) |
| L1 | (P,S) known and O = U | No-op | 200 `already_linked` | "{Provider} is already connected." |
| L2 | (P,S) known and O ≠ U | Nothing linked; log `auth.oauth.link_conflict` | 409 `identity_in_use` | "That {Provider} account is already connected to a different account." |
| L3 | (P,S) unknown and U already has a P identity | Nothing linked | 409 `provider_already_connected` | "Your account already has a {Provider} sign-in. Disconnect it first to connect a different one." |
| L4 | Otherwise (E may be ∅, unverified, or differ from U's email) | Insert identity (U, P, S); if `P = GOOGLE ∧ V ∧ E = U.email` and `email_verified_at` is NULL, set it to now (informational only; it never exempts the identity from R1); enqueue the security notification email (same transaction, P5) | 200 `linked` | "{Provider} connected. You can now sign in with it." |

**Unlink `DELETE /auth/identities/:provider`**: lock the users row `FOR UPDATE`; if the user has ≤ 1 identity → 409 `last_sign_in_method`; else delete. A deferred constraint trigger enforces the same rule in the database (schema item 4).

**Password sign-in for an account without a PASSWORD identity**: identity lookup misses, so the dummy hash is verified and the response is 401 `invalid_credentials` (AC-ERROR-3, AC-VERIFY-10 unchanged).

**Forgot and reset for an OAuth-only account**: allowed. The token is issued for any `users.email` match, and the reset upserts the PASSWORD identity (`provider_subject = users.email`). Combined with R1, this is the documented recovery path.

#### Trade-offs Accepted
- A user who registered by password and later clicks Google sees the conflict page and has to sign in, then connect: one extra round trip. Mitigated by the direct `returnTo=/account` link. Revisit with 3C if `auth.oauth.conflict` exceeds about 5% of OAuth callbacks.
- R1 disconnects every Google and Facebook identity on every completed reset, including legitimate ones and ones whose sign-up set `email_verified_at` (user decision D1). The reset success page then reads: "Password updated. For your security we disconnected {Provider list} from this account. Sign in and reconnect it from your Account page." The page shows only providers that were removed, and `/account` plus the reset form warn beforehand.
- No historical provider assertion is trusted at reset time: Google's `email_verified=true` proves only that the address was verified when Google checked it, so a recycled address would otherwise leave the previous owner a way in (codex critique finding 1). `email_verified_at` is kept as an informational record only.

### Q4: **Chosen: Option 4A** (block with guidance plus a `rerequest` retry).

#### Rationale
Consistent with Q3: every account email in v1 is either user-typed at password registration (provable later by reset) or supplied by the provider at sign-up. The decline-permission case, likely the most common cause, is recovered in one click with `auth_type=rerequest`. Phone-only Facebook users are a small minority and have two alternatives. 4B and 4C reopen the email-verification question that Q3 deliberately keeps out of v1.

#### Trade-offs Accepted
- Phone-only Facebook users cannot sign up with Facebook. Track `auth.oauth.email_missing` (provider, no PII). If it exceeds about 5% of Facebook first-time callbacks, revisit 4C together with a real verification flow.
- A known Facebook identity whose profile later loses its email keeps signing in (row S1), and linking Facebook from `/account` (L4) needs no email.

### Q7: **Chosen: Option 7A** (Postgres sliding log with atomic all-or-nothing admit, reserve-then-verify, and refund on success).

#### Parameters
| Scope | Key | Limit L | Window W | Counted | Reset by |
|-------|-----|---------|----------|---------|----------|
| `login_email` | HMAC(normalised email) | 5 (`AUTH_LOGIN_MAX_FAILURES_PER_EMAIL`, 3–20) | 15 min (`AUTH_LOGIN_WINDOW_MINUTES`, 5–60) | failed password sign-ins, including unknown emails | successful sign-in for that email (row deleted); completed password reset for that email (row deleted); window expiry |
| `login_address` | HMAC(client address, IPv4 /32, IPv6 /64) | **20** (`AUTH_LOGIN_MAX_FAILURES_PER_ADDRESS`, 5–200) | same W | failed password sign-ins across all emails | window expiry only. A success refunds its own provisional entry but never clears the row, so an attacker with one valid account cannot launder guesses. |
| `forgot_address` | HMAC(client address, same truncation) | 10 per 60 min (`AUTH_FORGOT_MAX_PER_ADDRESS`, fixed 60-min window) | 60 min | every forgot-password request | window expiry |

**Revision of AC-ERROR-4 ("the same limit applies per client address")**: the address limit is 20, not 5. Justification: players often sign in at the venue on shared Wi-Fi (one NAT address). Five typos across a whole club would lock everyone out for 15 minutes. Per-email limiting is what protects each account; the address dimension is a coarse brake on one-source spraying, and distributed attackers bypass it whatever its value.

**Lockout vs delay**: a lockout (429, no verification) for the remainder of the sliding window. The lockout cannot be extended by hammering (blocked attempts are not recorded), and the account owner can always escape through forgot-password (which clears `login_email`) or OAuth (not throttled by the email key). This bounds the denial-of-service someone can inflict by spraying a victim's email.

**Retry-After**: for each blocked key, `ceil(attempts[c − L + 1] + W − now)` in seconds, where `c` is the in-window count (normally `c = L`, so it is the oldest attempt). Take the maximum over blocked keys, with a minimum of 1. The page shows `n = ceil(retryAfter / 60)` with a minimum of 1: "Too many sign-in attempts. Try again in {n} minute(s)." (singular when n = 1).

**Enumeration and timing**:
1. Admit runs **before** any user lookup.
2. A 429 performs no lookup and no hash, so it costs the same for known and unknown emails.
3. An admitted unknown email verifies against the dummy hash (AC-VERIFY-10), and its failure is already recorded by the reservation, so unknown emails reach 429 after exactly the same number of attempts.
4. All 401s share one body.
5. `auth.login.failed` logs `reason ∈ {invalid_credentials, throttled_email, throttled_address}` with no email and no key hash.

**Keys and privacy**: `key_hash = HMAC-SHA256(K_throttle, scope || 0x00 || value)`, where `K_throttle = HKDF-SHA256(active encryption key, info = "sgm:v1:auth-throttle")` derived at boot (no new secret; rotating the encryption key just resets counters). Because the hash is keyed, the IPv4 space (2^32) cannot be brute-forced back to addresses, and emails typed by non-users are never stored. Rows live no longer than the window plus the time until the next cleanup run (≤ about 24 h). That is stated in the getting-started retention note, and it meets "no IP addresses stored" because only a keyed pseudonym exists and it is discarded on schedule.

**Missing address**: if `request.clientAddress` is absent, the address scope is skipped for that request and a rate-limited warning `auth.throttle.address_missing` is logged. The address is set only through the architecture's enforced trust boundary (web reads `X-Forwarded-For` from the right with `WEB_TRUSTED_PROXY_HOPS`; the API trusts `x-sgm-client-ip` only with a valid `x-sgm-internal-auth`), and `NODE_ENV=production` refuses to boot without those settings. A client-supplied `X-Forwarded-For` or `x-sgm-client-ip` therefore cannot choose the address key.

#### Rationale
7A is the only option that is exact across replicas and under concurrency, counts failures rather than requests, needs no new infrastructure, and makes the AC literally testable: 20 parallel wrong guesses give exactly 5 verifications, and the boundary test at minute 15 holds. Its cost is about 1–2 small writes per sign-in, insignificant at this scale. 7B is simpler but lets 9 failures through in a sliding 15 minutes. 7C changes the semantics the AC and message are written in. 7D fails across replicas (memory) or needs Redis, and counts the wrong thing.

#### Trade-offs Accepted
- 1–2 extra writes per sign-in. Acceptable: about 7 writes per second at an extreme peak.
- A crash between admit and a successful verify leaves one phantom failure, which expires within W.
- A hot address row (venue NAT) serialises admits for that address. The lock is held for microseconds inside one function call, never across the hash.
- Lock-out denial of service against a known email is possible for 15-minute periods. The owner can still reset or use OAuth; MFA and anomaly detection are out of scope.

### S1: **Chosen: S1-b** (trim, NFC, ASCII lowercase local part, punycode lowercase domain, ≤ 254). Applied identically to register, login, forgot, provider emails, and the CLI. The DB CHECK makes the normal form an invariant (P1).

### S2: **Chosen: S2-b** (NFKC; 10–128 code points; bundled common-password list; not equal to the email or its local part).
- List: SecLists `Common-Credentials/10-million-password-list-top-100000.txt` (MIT), filtered to entries of 10–128 code points, lowercased, deduplicated, committed as `apps/api/src/modules/auth/common-passwords.txt` with a source and licence header. Loaded once into a `Set` at boot (O(n) load, O(1) lookup).
- Applied only when a password is **set** (register, reset), never at sign-in. NFKC is applied before hashing on set and on verify (fixed now, since there are no legacy hashes).
- New field message: "This password is too common or too easy to guess. Choose a different one." (`fieldErrors.password`, 422 `validation_failed`).
- Long passwords: the 128 code-point cap (at most 512 UTF-8 bytes) bounds hash input; a rejection happens before hashing.

### S3: **Chosen: S3-b** (throttled touch, at most once per hour per session).

### Token lifetimes and single use (decided)

| Artefact | Entropy / storage | Lifetime | Consumption |
|----------|-------------------|----------|-------------|
| Session token | 32 bytes `randomBytes`, base64url in the web's cookie and the bearer header; `sha256` (bytea, 32 bytes) in `auth_sessions.token_hash` | idle 7 d (`AUTH_SESSION_IDLE_DAYS`, 1–30), absolute 30 d (`AUTH_SESSION_ABSOLUTE_DAYS`, ≥ idle, ≤ 90); `absolute_expires_at` stored at issue, so a config change never extends existing sessions | Issued fresh on every sign-in (fixation defence); revoked on logout (`revoked_reason='logout'`), on reset (all of the user's sessions, `password_reset`), and when a `signin` success replaces a presented session (`replaced`) |
| Reset token | 32 bytes, `sha256` in `password_reset_tokens.token_hash` | 60 min (`AUTH_RESET_TOKEN_MINUTES`, 10–1440) | Guarded `UPDATE … SET used_at = $now WHERE token_hash = $h AND used_at IS NULL AND expires_at > $now RETURNING user_id` inside the reset transaction. Success also sets `used_at` on every other unused token of that user. |
| OAuth state | `oauth_states` (architecture Q6) | 10 min | Single use, consumed with the same guarded UPDATE pattern (`SET used_at = $now WHERE used_at IS NULL AND expires_at > $now`) |
| Pending sign-up | `oauth_pending_signups` (architecture Q6) | 15 min (AC-ERROR-14) | `used_at` set only in C3–C5 (C2 finds nothing to use); never on a 422 (C1) |

A plain SHA-256 (no pepper) is sufficient for 256-bit random tokens: a database leak cannot be brute-forced back to a token.

---

## Implementation Details

### Data Structures
| Structure | Purpose | Operations Used |
|-----------|---------|-----------------|
| `users.email` UNIQUE + normalisation CHECK | Account lookup, conflict detection | O(log n) index probe |
| `users.email_verified_at` | Informational inbox-proof record (set by every completed reset and by Google sign-up/link with a matching verified email); read by no v1 rule; kept for the future verification flow | O(1) write |
| `auth_identities UNIQUE(provider, provider_subject)` | Known-subject lookup (S1, L1/L2) | O(log n) |
| `auth_identities UNIQUE(user_id, provider)` (new) | One identity per provider per user (L3, `DELETE /:provider`) | O(log n) |
| `auth_throttle` PK `(scope, key_hash)` + `timestamptz[]` | Sliding-log counters | O(log n) probe + O(L) array prune |
| `auth_sessions` UNIQUE `token_hash`, index `user_id` | Per-request validation, revoke-all | O(log n) |
| `password_reset_tokens` UNIQUE `token_hash`, index `(user_id, created_at)` | Consumption, 60-s resend limit, invalidate others | O(log n) |
| In-process `Set<string>` of common passwords | Blocklist | O(1) |
| Dummy password hash (computed once at boot with current parameters) | Constant-cost unknown-account verify | one verify per unknown sign-in |

### Algorithm Steps

**A. `normaliseEmail(raw): string | InvalidEmail`** (`packages/shared/src/auth/email.ts`, used by web and API)
1. `s = raw.trim().normalize('NFC')`; reject if empty or longer than 254.
2. Split at the **last** `@`; reject if there is no `@` or either side is empty.
3. Local part: reject if it contains any character outside `!`–`~` (ASCII printable, no space); lowercase it.
4. Domain: `d = domainToASCII(domain)` (`node:url`; the web uses the same helper server-side); reject if the result is empty; lowercase it.
5. Return `local + '@' + d` and validate with zod `.email()`. Error message: "Enter a valid email address."

**B. `checkPasswordForSet(pw, email): ok | fieldError`**
1. `p = pw.normalize('NFKC')`; `len = [...p].length`.
2. If `len < 10` or `len > 128` → "Use at least 10 characters." (or "Use at most 128 characters.").
3. If `p.toLowerCase()` is in the common-password set, or equals `email` or `email.split('@')[0]` → "This password is too common or too easy to guess. Choose a different one."

**C. Password sign-in** (`modules/auth/service.ts`)
1. `email = normaliseEmail(input)`. A malformed email still goes through steps 2–4 using a fixed sentinel key, so the response is the same generic 401, never a 422.
2. `keys = [login_email(email)] + (addr ? [login_address(addr)] : [])`.
3. `v = auth_throttle_admit(keys, W, now)`; if not admitted → 429 `too_many_attempts`, `Retry-After: v.retryAfterSeconds`; log `auth.login.failed reason=throttled_*`; stop.
4. `ident = repo.findIdentity('PASSWORD', email)`; `ok = await hasher.verify(ident?.passwordHash ?? DUMMY_HASH, NFKC(pw)) && ident !== null`.
5. If not ok → 401 `invalid_credentials`; log `auth.login.failed reason=invalid_credentials`; stop (the failure is already recorded).
6. `auth_throttle_settle(keys, now)`. In one transaction: revoke the presented session if any (`revoked_reason='replaced'`); insert the new session; set `last_used_at = now`; if `hasher.needsRehash(hash)`, update `password_hash`. Then return 200 `{ user, session }`; the web sets the cookie (architecture Q2).

**D. `auth_throttle_admit(p_scopes text[], p_keys bytea[], p_limits int[], p_windows interval[], p_now timestamptz) RETURNS TABLE(admitted boolean, retry_after_seconds int)`** (plpgsql, migration)
1. `INSERT … SELECT … ON CONFLICT DO NOTHING` an empty row for each key.
2. For each key in `(scope, key_hash)` order (deterministic, so no deadlocks): `SELECT attempts … FOR UPDATE`; prune to `a > p_now − window` (sorted); `UPDATE` the pruned array; if `cardinality ≥ limit`, mark blocked and fold the retry value `ceil(extract(epoch from pruned[c − limit + 1] + window − p_now))`.
3. If none is blocked, `UPDATE … SET attempts = attempts || p_now, updated_at = p_now` for every key.
4. Return `(NOT blocked, greatest(retry, 1) or 0)`.

**E. `auth_throttle_settle(p_email_key bytea, p_address_key bytea, p_now timestamptz)`**: `DELETE` the `login_email` row; `UPDATE` the `login_address` row with `attempts = array_remove(attempts, p_now)`.

**F. Forgot password** (AC-ERROR-6, AC-ASYNC-1)
1. Normalise the email. If the address is present, `auth_throttle_admit(['forgot_address'], …, 10, 60 min)`; when blocked → 429 `too_many_requests` "Too many requests. Try again in {n} minutes." (address-only, so it says nothing about the account).
2. Look up the user by email. If there is none → 202 (no token, no job).
3. In a transaction: `SELECT … FROM users WHERE id = $u FOR UPDATE` (serialises concurrent requests); if a token for `$u` has `created_at > now − 60 s` → commit with nothing done; otherwise insert the token and `enqueueEmail(idempotencyKey = 'password-reset:' || tokenId)`.
4. 202 with the identical body in every branch.

**G. Reset password** (AC-HAPPY-6, AC-ERROR-5, R1)
1. Validate the new password with B (422 without touching the token). The email for B's context check comes from the token's user, so first do a cheap **non-locking** `SELECT user_id … WHERE token_hash = $h AND used_at IS NULL AND expires_at > $now`. If it misses → 400 `invalid_or_expired_token` without hashing (stops CPU-burn with random tokens).
2. Hash outside the transaction.
3. In a transaction (R1 as amended by user decision D1; no branch on `email_verified_at`): guarded consume UPDATE (0 rows → 400, so the race loser loses here) → lock the user row → upsert the PASSWORD identity (`ON CONFLICT (provider, provider_subject) DO UPDATE SET password_hash`) → delete **every** non-PASSWORD identity of the user (`RETURNING provider`) → set `email_verified_at = $now` → revoke all sessions (`password_reset`) → set `used_at` on the user's other unused tokens → delete the `login_email` throttle row (HMAC of `users.email`).
4. Return 200 `{ removedProviders }` (possibly empty; user-journey C-6). Log `auth.password_reset.completed` (`userId`, `removedProviders`). The web redirects to `/login` with the message (plus the R1 sentence when `removedProviders` is non-empty).

**H. Session validation and touch** (per authenticated request; guard mechanics belong to architecture Q5)
1. No bearer token → 401 `unauthenticated`. Otherwise `row = SELECT s.*, u.role … FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = sha256(bearer token)`.
2. No row (unknown, or already removed by cleanup), `revoked_at` set, `now ≥ expires_at` or `now ≥ absolute_expires_at` → 401 `session_expired` (architecture Q2 resolve rule, adopted in consolidation so a cleaned-up session still reads as expired).
3. If `now − last_seen_at ≥ 1 h`: `UPDATE auth_sessions SET last_seen_at = $now, expires_at = LEAST($now + idle, absolute_expires_at) WHERE id = $id AND last_seen_at <= $now − interval '1 hour' AND revoked_at IS NULL` (fire-and-forget within the request; parallel requests write once).
4. Cookie (web-owned, architecture Q2): `Expires` = `absolute_expires_at` at issue. The cookie is **not** re-set on touch; idle expiry is enforced server-side. Confirmed by architecture Q2 (AC-ASYNC-4).

**I. Cleanup** (`auth-cleanup`, daily 05:00 Pacific/Auckland, AC-ASYNC-3). Each statement runs in batches of 5000 until 0 rows (keeps lock time short), and the job is idempotent:
- `auth_sessions WHERE revoked_at IS NOT NULL OR expires_at <= $now OR absolute_expires_at <= $now`
- `password_reset_tokens WHERE used_at IS NOT NULL OR expires_at <= $now`
- `auth_throttle WHERE updated_at <= $now − interval '60 minutes'` (the longest window, so every attempt in the row is stale)
- `oauth_states` and `oauth_pending_signups` `WHERE used_at IS NOT NULL OR expires_at <= $now`

### Edge Case Handling
| Edge Case | Handling |
|-----------|----------|
| Known subject, changed provider email | S1: sign in; `users.email` never touched |
| Email matches but provider is Google-verified | S4: block (no auto-link in v1) |
| Pre-hijack with an attacker-linked Facebook | Victim resets → R1 deletes FACEBOOK, revokes sessions, sets `email_verified_at` |
| Recycled inbox: previous owner's Google identity (sign-up set `email_verified_at`) | New owner resets → R1 deletes GOOGLE regardless; previous owner's next Google sign-in → S4 409 `oauth_account_exists`, no session |
| OAuth-first pre-hijack (Facebook claims victim's email) | Victim's register gets 409 → reset → R1 removes the attacker's FACEBOOK identity, adds PASSWORD |
| Two tabs complete the same pending sign-up | Guarded consume per record; second record → C3 (identity exists → sign in) or C4 |
| Facebook declined the email permission | S2 with a "Try Facebook again" `rerequest` button |
| Link a provider already on another account | L2 409 `identity_in_use`, no hint which account |
| Disconnect the last method, concurrently | Users row lock + deferred trigger → 409 / 23514 |
| 20 parallel wrong passwords | Row lock in admit → exactly 5 verify calls, 15 × 429 |
| Venue NAT | Address limit 20; successes refund their address entry |
| Missing client address | Email dimension only; warning logged |
| Malformed email at login | Sentinel key; generic 401 (no 422 that would reveal the validator) |
| Malformed email at register/forgot | 422 "Enter a valid email address." at register; forgot answers 202 (no-op) to stay uniform |
| Token reuse or replay | Guarded UPDATE returns 0 rows → 400 |
| Clock skew between replicas | `now` comes from the app clock; NTP skew of a few ms is irrelevant against 15-min / 1-h windows |

### Error Handling
| Error Condition | Response |
|-----------------|----------|
| Throttle function or DB unavailable | 503 `service_unavailable` via the shared error mapper (fail **closed**: never verify a password without the throttle) |
| Hasher throws | 500; the reservation stays (counts as a failure) |
| 23505 `users.email` at register | 409 `email_taken` (AC-ERROR-1, AC-INTEGRATION-5) |
| 23505 identity at OAuth completion | Re-run the decision once (C3) |
| 23514 `users_email_normalised` | Programming error (normaliser bypassed) → 500 and an error log |
| 23514 `auth_identities_last_method` | 409 `last_sign_in_method` |
| Security-notification email enqueue fails | The whole link transaction rolls back (P5); the user retries |

## Performance Expectations

### At Current Scale
- Expected latency: sign-in ≈ hash + 3–6 ms; 429 ≈ 1–2 ms; OAuth callback decision ≈ 1–3 ms plus the provider round trip.
- Memory usage: common-password `Set` of roughly 5–15k entries (< 1 MB); everything else constant.
- Throughput: hash-bound at roughly 3–20 sign-ins per second per core, far above need.
- DB writes: ≤ 2 throttle writes per sign-in; ≤ 1 session touch per active session per hour.

### At 10x Scale
- Expected latency: unchanged (index probes on tables of tens of thousands of rows).
- Memory usage: unchanged.
- Bottlenecks: hash CPU during a mass-sign-in burst (scale API replicas); a single extremely hot NAT address row (still microsecond lock holds).

### Optimization Opportunities
- If sign-in volume ever reaches hundreds per second, move the address dimension to an edge rate limiter and keep the email dimension in Postgres.
- An HIBP adapter behind the `PasswordBlocklist` interface (S2-c).
- Conflict-screen re-auth linking (3C) if `auth.oauth.conflict` is frequent.
- A full email-verification flow reusing `email_verified_at` (prerequisite for 3B and 4C).

## Validation Checklist

- [x] Meets latency requirements (≤ 6 ms beyond the hash)
- [x] Meets memory requirements (constant plus < 1 MB list)
- [x] Handles all edge cases (table above)
- [x] Scales to expected data size (index probes; 10× unchanged)
- [x] Implementation feasible (plain SQL, one plpgsql function pair, one trigger; no new services)
- [x] Respects Guiding Principles: P1 (normal form, single use, one identity per provider, last-method rule and throttle atomicity in the DB), P3 (UTC `timestamptz`, injected clock), P5 (notification and reset emails enqueued in the same transaction), P7 (all thresholds and lifetimes env-validated with ranges)

## Testing Strategy

### Unit Tests
- `normaliseEmail`: case, spaces, NFC, IDN punycode (`Aroha@Māori.NZ` → `aroha@xn--mori-qsa.nz`), non-ASCII local part rejected, last-`@` split, 254/255 boundary.
- `checkPasswordForSet`: 9/10/128/129 code points (including astral characters), NFKC folding, blocklist hit (case-insensitive), equals email or local part.
- OAuth decision function as a pure function over `(intent, P, S-known, E, V, M, U-has-P, cur)`: one test per row S1–S5, C1–C5, L0–L4.
- Retry-After maths: `c = L` and `c > L` (limit lowered), minute rounding ("1 minute" minimum).
- Dummy-hash spy: an unknown email calls `verify(DUMMY_HASH, …)` once (AC-VERIFY-10).

### Integration Tests (real Postgres 17)
- `auth_throttle_admit`: 5 failures → 6th blocked without a verify call; blocked attempts do not extend the window; injected clock at +15 min → admitted; success deletes the email row and refunds the address entry; address limit 20 across 20 emails.
- Concurrency (dedicated clone, pool ≥ 21): 20 parallel wrong-password sign-ins for one email → exactly 5 `verify` calls and 15 × 429.
- R1: pre-hijack scenario end to end (password register, link fake-provider FACEBOOK, reset → identity gone, sessions revoked, `email_verified_at` set); an account created by verified Google sign-up (so `email_verified_at` was already set) loses GOOGLE on reset too; `removedProviders` lists exactly the deleted providers.
- Recycled email: user A signs up with fake-provider Google (verified) for `x@example.com`; user B (the new inbox owner) completes a reset for that address; A's next Google callback with the same `sub` resolves to S4 409 `oauth_account_exists` and creates no session.
- Reset race (AC-INTEGRATION-5), forgot 60-s limit under 5 concurrent requests → 1 token.
- Last-method trigger: two concurrent disconnects of a two-method user → one 409/23514.
- Session touch: requests within 1 h write nothing; after 1 h one write; `expires_at` never exceeds `absolute_expires_at`; idle and absolute expiry with the injected clock.
- Cleanup removes only stale rows, including throttle rows older than 60 min; a second run deletes 0.
- Schema: mixed-case or non-ASCII email insert → 23514; duplicate `(user_id, provider)` → 23505.

### Performance Tests
- Benchmark: 100 sequential sign-ins on CI. Assert median non-hash overhead under 10 ms (hasher stubbed to a constant).
- Stress at 10×: not required for v1 (volumes are tiny); the concurrency test covers lock correctness.

## Next Steps

1. Phase 1 migrations: apply the schema implications below and add D-27 onwards ledger entries.
2. `packages/shared`: `normaliseEmail`, password length rule, and these codes in the authoritative `ErrorCode` list kept in the architecture doc: `too_many_attempts`, `too_many_requests`, `oauth_account_exists`, `oauth_email_missing`, `oauth_email_unverified`, `identity_in_use`, `provider_already_connected`, `link_session_mismatch`, `signup_expired`, `last_sign_in_method`, `service_unavailable`.
3. Phase 2: `throttle.ts` (key derivation, admit/settle wrappers), `password.ts` blocklist, session touch.
4. Phase 3: reset with R1 (unconditional, D1); cleanup including `auth_throttle`.
5. Phase 5: the OAuth decision function as a pure, table-tested module (`modules/auth/oauth-decision.ts`) called by the service.

---

## AC impact

Amend (proposed wording):
- **AC-ERROR-2**: add a fourth case: "…or with a common or easily guessed password ('This password is too common or too easy to guess. Choose a different one.')". Length is counted in Unicode code points after NFKC normalisation.
- **AC-ERROR-4**: "Given 5 failed sign-in attempts for one email within any 15-minute period, or 20 failed attempts from one client address across emails… the 6th (or 21st) attempt returns 429 `too_many_attempts` with `Retry-After` equal to the seconds until the oldest counted failure leaves the window… attempts made while blocked are not counted and do not extend the block; a successful sign-in or a completed password reset clears that email's count; the correct password works once the window has passed."
- **AC-ERROR-6**: append "…; more than 10 requests from one client address within 60 minutes return 429 `too_many_requests`, regardless of whether the accounts exist."
- **AC-ERROR-8**: message becomes "An account already exists for {email}. Sign in with your existing method, then connect {Provider} from your Account page." with links "Sign in" (`/login?returnTo=%2Faccount`) and "Forgot your password?"; applies to Google (verified) and Facebook alike; drop "(conservative default, revisit in creative)", since this is now decided.
- **AC-ERROR-9**: Facebook message becomes "Facebook didn't share an email address, which we need to create your account. Try again and allow access to your email, or use Google or email and password instead." with a "Try Facebook again" button that re-requests the email permission; add "a returning user whose Facebook identity is already connected signs in even without an email".
- **AC-HAPPY-6**: the reset transaction also deletes every GOOGLE and FACEBOOK identity, invalidates other reset tokens, sets `email_verified_at` and clears the email throttle count (R1 per D1); the API returns `{ removedProviders }`; append "…; a user whose account has only Google or Facebook sign-in can use the same flow, which adds an Email and password method."
- **AC-ASYNC-3**: add "expired throttle counters (older than 60 minutes)" to the deleted artefacts.
- **AC-ASYNC-4**: "…use within the idle window extends `expires_at` (written at most once per hour per session, never past the absolute cap)… the cookie's lifetime equals the session's absolute expiry; idle expiry is enforced by the server" (confirmed by architecture Q2).
- **AC-INTEGRATION-5**: add "and 20 concurrent wrong-password sign-ins for one email cause exactly 5 password verifications and 15 responses of 429".

Add:
- **AC-ERROR-16 (MUST) — Every completed reset evicts all Google and Facebook sign-in methods** (rewritten per user decision D1). Given an account with a connected FACEBOOK and/or GOOGLE identity (including a Google identity whose sign-up or link set `email_verified_at`), when a password reset completes, then every GOOGLE and FACEBOOK identity is removed in the reset transaction, all sessions are revoked, other reset tokens are invalidated, `users.email_verified_at` is set, the API returns them in `removedProviders`, and `/login` shows "Password updated. For your security we disconnected {Provider list} from this account. Sign in and reconnect it from your Account page."; in the recycled-email case the previous owner's Google sign-in afterwards ends in 409 `oauth_account_exists` with no session.
- **AC-ERROR-17 (SHOULD) — Connecting a method that is already in use is refused.** Connecting a Google or Facebook account that belongs to another user returns 409 `identity_in_use` ("That {Provider} account is already connected to a different account."); connecting a second account of a provider the user already has returns 409 `provider_already_connected`; connecting an already-connected one is a no-op ("{Provider} is already connected.").
- **AC-ASYNC-5 (SHOULD) — Connecting a sign-in method sends a security notice.** Linking a provider enqueues (same transaction, `idempotencyKey = identity-linked:<identityId>`, tag `template: identity-linked`) an email to the account address: "{Provider} sign-in was connected to your Shared Game Management account. If this wasn't you, reset your password." The email is delivered through the existing worker.

## Schema implications (Phase 1 migrations)

1. **`users`** (migration `db/migrations/20261006000100000_users_email_and_role_checks.sql`, which also carries items 2 and 4):
   - `ADD COLUMN email_verified_at timestamptz` (nullable; informational only in v1).
   - `CONSTRAINT users_email_normalised CHECK (email = lower(email) AND email ~ '^[!-?A-~]+@[!-?A-~]+$' AND char_length(email) <= 254)`: ASCII printable, no space, exactly one `@`, lowercase. The class `[!-?A-~]` is 0x21–0x7E minus `@` (0x40).
   - `CONSTRAINT users_role_not_team_admin CHECK (role <> 'TEAM_ADMIN')` (AC-VERIFY-4; enum handling per architecture Q5).
   - `CONSTRAINT uq_users_id_email UNIQUE (id, email)` (target of item 2's composite FK).
2. **`auth_identities`**:
   - `CONSTRAINT uq_auth_identities_user_provider UNIQUE (user_id, provider)` (one identity per provider per user; L3; `DELETE /auth/identities/:provider` is unambiguous).
   - `password_email varchar(255) GENERATED ALWAYS AS (CASE WHEN provider = 'PASSWORD' THEN provider_subject END) STORED` plus `FOREIGN KEY (user_id, password_email) REFERENCES users (id, email) ON UPDATE CASCADE ON DELETE CASCADE` (MATCH SIMPLE, so NULL for OAuth rows). This makes "PASSWORD `provider_subject` equals `users.email`" a DB invariant (P1) and follows any future email change automatically.
3. **`auth_throttle`** (new table + functions, own migration `db/migrations/20261006000500000_auth_throttle.sql`):
   - `scope varchar(32) NOT NULL CHECK (scope IN ('login_email','login_address','forgot_address'))`, `key_hash bytea NOT NULL CHECK (octet_length(key_hash) = 32)`, `attempts timestamptz[] NOT NULL DEFAULT '{}' CHECK (cardinality(attempts) <= 256)`, `updated_at timestamptz NOT NULL`, `PRIMARY KEY (scope, key_hash)`.
   - Functions `auth_throttle_admit(text[], bytea[], int[], interval[], timestamptz)` and `auth_throttle_settle(bytea, bytea, timestamptz)`; the down migration drops both.
4. **Last-method trigger**: `CONSTRAINT TRIGGER auth_identities_last_method AFTER DELETE ON auth_identities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW`. The function locks `users` row `OLD.user_id` `FOR UPDATE` (skipped if the user is gone, i.e. a cascade) and raises SQLSTATE 23514 `auth_identities_last_method` if no identity remains. Platform-foundation factories that create users without identities are unaffected (the trigger fires only on DELETE).
5. **`auth_sessions`** (shape owned by the architecture doc, which now includes these CHECKs): `id uuid PK`, `user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE`, `token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32)`, `created_at`, `last_seen_at`, `expires_at`, `absolute_expires_at` (all `timestamptz NOT NULL`), `revoked_at timestamptz`, `revoked_reason varchar(32)` (`logout`, `password_reset`, `replaced`; NULL iff `revoked_at` is NULL), `user_agent varchar(512)`. CHECKs: `last_seen_at >= created_at`, `expires_at <= absolute_expires_at`, `absolute_expires_at > created_at`, `revoked_at IS NULL OR revoked_at >= created_at`. Indexes `(user_id) WHERE revoked_at IS NULL` and `(expires_at)`.
6. **`password_reset_tokens`**: `id uuid PK`, `user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE`, `token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32)`, `created_at timestamptz NOT NULL DEFAULT now()`, `expires_at timestamptz NOT NULL CHECK (expires_at > created_at)`, `used_at timestamptz CHECK (used_at IS NULL OR used_at >= created_at)`. Index `(user_id, created_at DESC)`.
7. **OAuth state and pending sign-ups** (shape owned by architecture Q6, migration `20261006000400000`). Fields these rules need: `oauth_states` → `intent ('signin'|'link')`, `link_user_id` (NOT NULL iff intent = `link`, by CHECK), `provider`, `expires_at`, `used_at`; `oauth_pending_signups` → `provider`, `provider_subject`, `email` (NOT NULL, normalised, CHECK as in users), `email_verified boolean`, `full_name`, `return_to`, `expires_at`, `used_at`.
8. Ledger: D-27 onwards in `db/schema-deviations.md` for every item above, with Source "Algo Q3/Q7/S1/S3" as applicable.

## Assumptions about the architecture (reconciled with `auth-and-user-roles-architecture.md` on 2026-10-06)

- **A1 Client address relay** (resolved): the architecture's enforced trust boundary applies: the web derives the address from `X-Forwarded-For` read from the right with `WEB_TRUSTED_PROXY_HOPS`, strips incoming internal headers, and sends `x-sgm-client-ip` with `x-sgm-internal-auth`; the API compares the secret (`API_INTERNAL_SHARED_SECRET`) in constant time and otherwise ignores the address. Production refuses to boot without the secret or the hop count. Without an address, the address dimension is skipped (email limits still apply).
- **A2 OAuth store interface** (resolved): `createState({intent, linkUserId?, provider, ttl})`, `consumeState(id) → record | null` (single use, guarded `used_at`), `createPendingSignup({...})`, `peekPendingSignup(id)` (for prefill and the 422 path), `consumePendingSignup(id) → record | null` (guarded, inside the completion transaction). The decision table needs no more than this.
- **A3 Cookie lifetime** (confirmed): the web-owned cookie expires at the absolute expiry and is not refreshed on touch (step H.4).
- **A4 Hasher** (confirmed): `node:crypto` argon2id exposes `hash`, `verify` (with `needsRehash`); the dummy hash is created at boot with current parameters.
- **A5 Throttle key derivation** (confirmed): HKDF from the active `ENCRYPTION_KEYS` entry; no dedicated secret.

## Consolidation (2026-10-06)

Reconciled with the architecture and user-journey docs, the spec, the codex design critique and the user's decisions D1 and D2. The **Chosen** options (3A′, 4A, 7A, S1-b, S2-b, S3-b) are unchanged; R1 inside 3A′ is changed by D1.

- **R1 (critique finding 1, user decision D1)**: every completed reset now deletes all GOOGLE and FACEBOOK identities, unconditionally, in the reset transaction (plus upsert PASSWORD, revoke all sessions, invalidate other reset tokens, set `email_verified_at`, clear the email throttle row). The previous exemption for accounts with a proven email (including a Google `email_verified=true` sign-up) is removed. Updated: the 3A′ approach, pseudocode, pros and cons; the Q3 decision line; trade-offs; step G; edge cases 3 and 3a and the edge-case table (recycled inbox); R1 tests (the old "verified-Google account reset keeps GOOGLE" test is inverted, a recycled-email test is added); AC-ERROR-16 rewritten.
- **`email_verified_at`**: still set by Google sign-up (C5) and link (L4) when Google asserts a verified matching email, and by every reset; informational only, read by no v1 rule, not shown in the v1 UI.
- **Client address (D2, finding 2)**: the throttle's address now comes only from the architecture's enforced trust boundary; A1 is resolved and the "Missing address" paragraph updated.
- **Session resolve**: an unknown presented token now returns `session_expired` (architecture rule) instead of `unauthenticated`; `unauthenticated` means no token at all. The session token travels as a bearer header; the web owns the cookie (A3, H.4 confirmed).
- **Naming settled**: intents `signin`/`link` (was `SIGN_IN`/`LINK`); outcomes `signed_in`, `pending_signup`, `linked`, `already_linked` (were upper case); `link_user_id` (was `bound_user_id`/`boundUserId`); `used_at` on OAuth state and pending sign-ups (was `consumed_at`); `full_name` (was `suggested_name`); `auth_sessions.user_agent varchar(512)` (was 255) and `revoked_reason` with the value `replaced` for a session replaced at sign-in.
- **Error codes**: the authoritative list now lives in the architecture doc; this doc's codes are all in it, plus `service_unavailable` for the fail-closed 503. `oauth_account_exists` responses carry `error.email` for the web server (journey C-5); reset returns `removedProviders` (C-6).
- **Schema**: migration names pinned (`20261006000100000` carries the users and identity invariants and the last-method trigger; `20261006000500000_auth_throttle.sql` is its own file); pending sign-up `email` is `NOT NULL`.
