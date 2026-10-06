# Architecture Decision: Auth and User Roles

**Created**: 2026-10-06
**Status**: DECIDED
**Decision Type**: Architecture
**Task**: `auth-and-user-roles` (Level 3). Spec: `memory-bank/tasks/auth-and-user-roles.md` (approved; ACs are the contract)
**Resolves**: Creative Q1 (library and password hasher), Q2 (session strategy and web/API relay), Q5 (RBAC guards), Q6 (OAuth redirect topology and short-lived state), Q8 (fake provider for E2E), plus app wiring, module layout, the shared HTTP error shape and final env var names.
**Not decided here**: Q3 (OAuth linking, email conflicts, email verification), Q4 (Facebook without email) and Q7 (login throttling across replicas). They belong to `memory-bank/creative/auth-and-user-roles-algorithm.md`. Where this design depends on them, it fixes only the interface (see [Interfaces handed to Algorithm Design](#interfaces-handed-to-algorithm-design)).
**Basis**: the stacked worktree (`feature/platform-foundation` + this task), not `main`. Governing principles P1–P7 come from `memory-bank/systemPatterns.md`. Prior decisions: `docs/adr/0001`–`0012` and `memory-bank/creative/platform-foundation-architecture.md`.

---

## Context

### System Requirements
- Register and sign in with email/password, Google and Facebook. Sex is required once per user, including first-time OAuth users, and no `users` row may exist before that choice (AC-HAPPY-3).
- Opaque, revocable server-side sessions with logout, 7-day idle and 30-day absolute expiry (AC-ASYNC-4). Role and team membership are read fresh from the database on every request (AC-HAPPY-8, AC-ERROR-12, AC-VERIFY-4).
- Password reset by a single-use emailed link. The token and the `send-email` job are written in one transaction (AC-ASYNC-1, P5).
- Default-deny route authorization with `public`, `authenticated`, `globalRole` and `teamRole` policies (AC-VERIFY-3), shared by every later feature.
- Connect and disconnect sign-in methods while signed in (AC-HAPPY-11/12).
- A fake OAuth provider for integration and E2E tests that cannot run in production (AC-VERIFY-7, AC-INTEGRATION-2/4).

### Technical Constraints
- **Topology (ADR 0007, C5/C6)**: the web app is the only public origin. It reaches the API server-side through `API_INTERNAL_URL`. The browser never calls the API. OAuth redirect URIs must therefore point at the web origin.
- **Stack (ADR 0001–0004)**: Node 24, Fastify 5 + `fastify-type-provider-zod`, Kysely over `pg`, node-pg-migrate SQL, pg-boss (producer in the HTTP process), zod contracts in `@sgm/shared`, Next.js 16.3 App Router (`proxy.ts` replaces `middleware.ts` and runs on the Node runtime).
- **Build and image (platform-foundation Phase 2 deviations)**: the api is bundled with tsup and third-party dependencies stay external. The runtime image is `node:24-slim`, built with the classic builder on Colima (no buildx, no BuildKit cache mounts) and pruned with `pnpm deploy --legacy --prod`. A native addon must ship a prebuilt glibc binary or it will not build on the slim image.
- **Existing schema**: `users(email UNIQUE, sex NOT NULL, role global_role DEFAULT 'PLAYER')`, `auth_identities(UNIQUE(provider, provider_subject), CHECK password_hash iff PASSWORD)`, `team_members(UNIQUE(team_id, user_id), role, status)`. The `global_role` enum still contains `TEAM_ADMIN`.
- **Existing platform pieces to reuse**: the zod config loader (`lib/config`), the pino logger with key and query redaction (`lib/logger`), the AES-256-GCM keyring (`lib/crypto`), the job runner and `enqueueEmail(runner, msg, { trx })` (`jobs/send-email.ts`), `traceHeaders()` in the web `api-client.ts`, and `createTestDatabase()`.

### Non-Functional Requirements
- **Security**: ASVS-style controls: memory-hard hashing, hashed tokens at rest, CSRF defence, throttling, enumeration resistance, default deny, no secrets in logs (AC-VERIFY-1/2/3/6/10, AC-ERROR-3/4/6/13/15).
- **Privacy (NZ Privacy Act, IPP 5 and IPP 12)**: store only email, name, sex, provider subject and a session user agent. No IP addresses are stored or logged.
- **Performance**: sign-in p95 under 1 s excluding the intentional hash cost. Scale is hundreds to low thousands of users, with bursts when registration opens.
- **Operability**: one developer. No new stateful services (no Redis). Every new setting is validated at boot (P7).
- **Observability**: structured `auth.*` events with `traceId`, no PII beyond `userId`, and `traceparent` carried web → api.

---

## Component Analysis

### Core Components

| Component | Purpose | Responsibilities |
|-----------|---------|------------------|
| `apps/api/src/lib/http/errors.ts` | Shared HTTP error handling | `AppError(code, status, message, fieldErrors?)`; Fastify error and not-found handlers that map zod validation to 422, domain errors to their status, and anything unknown to a 500 with no details. |
| `apps/api/src/lib/http/origin.ts` | Cross-origin refusal | An `onRequest` hook that answers 403 `cross_origin_request` when a mutating request carries an `Origin` other than `WEB_BASE_URL`'s origin. |
| `apps/api/src/lib/http/internal-auth.ts` | Authenticated web hop | An `onRequest` hook that checks `x-sgm-internal-auth` against `API_INTERNAL_SHARED_SECRET` in constant time and sets `request.clientAddress` from `x-sgm-client-ip` only when it matches (see [Client address](#client-address-trust-boundary-enforced-invariant)). |
| `packages/shared/src/auth/oauth-binding.ts` | `sgm_oauth` codec | Encode, parse and validate the browser-binding cookie value defined in [Browser-binding cookie `sgm_oauth`](#browser-binding-cookie-sgm_oauth-the-one-schema). Isomorphic, so API tests can prove interop. |
| `apps/web/src/lib/auth/client-address.ts` | Client address derivation | Reads `X-Forwarded-For` from the right using `WEB_TRUSTED_PROXY_HOPS`; returns a valid IP or `null`. |
| `apps/api/src/lib/auth/policy.ts` | Route policy registry | The `RoutePolicy` type and its constructors (`publicRoute()`, `optionalSession()`, `authenticated()`, `requireGlobalRole()`, `requireTeamRole()`). An `onRoute` hook that refuses to register a route without a policy, attaches the guard hooks and adds the OpenAPI `security` and error responses. |
| `apps/api/src/lib/auth/request-auth.ts` | Request identity | Fastify type augmentation (`config.policy`, `request.auth`, `request.teamMembership`). Session resolution from `Authorization: Bearer`. |
| `apps/api/src/lib/auth/guards.ts` | Authorization checks | `authenticate` (401 `unauthenticated` or `session_expired`), global-role check (403), team-role check against approved `team_members` (403), the `allowGlobalAdmin` opt-in. |
| `apps/api/src/lib/clock.ts` | Injectable time | A `Clock { now(): Date }` and `systemClock`. Auth SQL takes time from the clock as a parameter, not from `now()`, so expiry is testable. |
| `apps/api/src/modules/auth/*` | Auth feature module (reference implementation) | Routes, services (password, reset, OAuth), repo, hasher, tokens, sessions, throttle port, emails, provider adapters. |
| `apps/api/src/jobs/auth-cleanup.ts` | Housekeeping | Deletes expired or revoked sessions, expired or used reset tokens, and expired OAuth state and pending sign-ups. Idempotent. |
| `packages/shared/src/api/{auth,errors}.ts` | Contracts | Strict zod request and response schemas. `ErrorResponse` and the `ErrorCode` union. Email normalisation. |
| `packages/shared/src/auth/return-to.ts` | `returnTo` validation | Isomorphic `safeReturnTo(value)`, used by the web (redirects) and the API (stored with the OAuth state). |
| `apps/web/src/lib/config.ts` | Web config (P7) | zod-validated `API_INTERNAL_URL` and `WEB_BASE_URL`, loaded from `instrumentation.ts` `register()` so a bad value fails at boot. |
| `apps/web/src/lib/auth/*` | Web auth layer | Cookie names and options, `getCurrentUser()` and `requireUser()`, Server Actions, notice and error message maps. |
| `apps/web/src/proxy.ts` | Edge of the web origin | Cheap redirect when a protected path has no session cookie. `Origin` check on mutating requests. Strips incoming `x-sgm-client-ip` and `x-sgm-internal-auth` request headers. `Referrer-Policy: no-referrer` on `/reset-password`. |
| `apps/web/src/app/auth/callback/[provider]/route.ts` | OAuth redirect target | Compares `state` with the binding cookie, calls the API callback, sets the session or pending-sign-up cookie, then redirects. |
| `apps/web/src/app/auth/session-expired/route.ts` | Dead-cookie cleanup | Deletes the session cookie (Server Components cannot) and redirects to `/login?returnTo=…&notice=session_expired`. |

### Component Interactions

```
Browser ──HTTPS──► web (Next.js 16, only public origin)
                    │  cookies (HttpOnly, SameSite=Lax, __Host- when https):
                    │    sgm_session  (opaque session token, Expires = absolute expiry)
                    │    sgm_oauth    (OAuth state binding <state>.<ctx>, 10 min)
                    │    sgm_pending  (pending sign-up token, 15 min)
                    │    sgm_flash    (conflict email for one banner, 60 s; user-journey X2)
                    │
                    │  Server Actions / route handlers / RSC ──► api-client.ts
                    │      Authorization: Bearer <session token>    (when signed in)
                    │      traceparent, user-agent,
                    │      x-sgm-internal-auth (shared secret) + x-sgm-client-ip (derived, may be absent)
                    ▼
                  api (Fastify, internal) ── onRequest: origin check → internal-auth (client address) → session resolve (policy ≠ public)
                    │                        preHandler: role / team guard
                    │  modules/auth: routes → services → repo (Kysely) ─┬─► PostgreSQL 17
                    │                                                   │   users, auth_identities, auth_sessions,
                    │  enqueueEmail(…, { trx })  ── same transaction ───┘   password_reset_tokens, oauth_states,
                    │                                                       oauth_pending_signups, auth_throttle,
                    │                                                       team_members, pgboss.job
                    └─► Google / Facebook (token + profile over HTTPS, 5 s timeout, client spans only)
worker ── send-email (reset link) ──► Notifier ──► Mailpit / Postmark
worker ── auth-cleanup (0 5 * * * Pacific/Auckland) ──► DELETE expired auth rows
```

- **web → api**: HTTP/JSON with shared zod schemas. The session token travels as a bearer header. The API sets no cookies.
- **api → postgres**: every auth invariant (unique email, one identity per provider per user, single-use tokens, no global `TEAM_ADMIN`) is a constraint (P1).
- **api → pg-boss**: the HTTP process is a producer only. The reset email is enqueued inside the token-insert transaction (P5).

---

## Options Explored

The questions below are separable. Each has its own options, evaluation and decision. Weights follow the platform-foundation architecture doc: maintainability 0.25, correctness and safety 0.25, time to market 0.20, operational simplicity 0.15, cost 0.10, performance 0.05. Scores run from 1 to 5.

### Q1: Auth library vs hand-rolled, and the password hasher

Versions checked on 2026-10-06 (npm): `better-auth` 1.7.7, `next-auth` 4.24.15 (v5 never left beta; the project is in maintenance under Better Auth's stewardship), `arctic` 3.7.0, `oauth4webapi` 3.8.8, `jose` 6.2.12, `@node-rs/argon2` 2.2.1, `argon2` 0.45.1. Lucia, which used to be the default "own your sessions" library, was deprecated in 2025 and replaced by a guide to writing the same session code yourself. That is the approach Option 1A takes.

#### Option 1A: Fastify-native composition (own sessions, built-in hasher, thin provider adapters)
- **Description**: The `modules/auth` feature module owns registration, login, sessions, reset and OAuth orchestration on top of the existing schema. Sessions and tokens use `node:crypto` (`randomBytes`, SHA-256). Passwords use `node:crypto` argon2id (see the hasher sub-decision). OAuth uses two thin adapters (Google, Facebook) over an injected `fetch` with timeouts, plus `jose` to verify Google ID tokens.
- **Architecture Diagram**: see [Component Interactions](#component-interactions).
- **Pros**:
  - Fits `auth_identities`, `users.sex NOT NULL`, the deferred user creation of AC-HAPPY-3 and the module convention exactly. No schema adaptation layer is needed.
  - Every security property is a DB constraint (P1) or ours to test. Nothing is hidden behind framework defaults.
  - Adds one runtime dependency (`jose`, zero dependencies of its own). The image gets no native addon.
  - Auth becomes the reference `modules/<feature>` implementation that the platform-foundation risk table asked for.
- **Cons**:
  - We write and maintain security-sensitive code: token handling, PKCE, state, ID token checks. This is mitigated by small surfaces, recorded fixtures and the AC-VERIFY and AC-INTEGRATION-3 tests.
  - No built-in extras (MFA, passkeys). They are out of scope for v1.
- **Technical Fit**: High
- **Complexity**: Medium
- **Scalability**: High (stateless API replicas, Postgres sessions)

#### Option 1B: Better Auth 1.7 with the Kysely adapter, mounted in Fastify
- **Description**: Better Auth handles email/password, social providers, sessions and its rate limiter. Its handler is mounted on a Fastify catch-all, with custom table and field names mapped onto our schema.
- **Pros**:
  - Batteries included: providers, session cookies, account linking, plugins (2FA and passkeys later).
  - Active maintenance and a large user base.
- **Cons**:
  - Its data model (`user`, `session`, `account`, `verification`) differs from ours. `account.providerId` is a free string where we use the `auth_provider` enum, and the password lives on the account. Field mapping covers names, not constraints, so the CHECKs and enums of P1 sit beside a library that expects its own invariants.
  - Social sign-in creates the user at the OAuth callback. Deferring creation until sex is chosen (AC-HAPPY-3, AC-ERROR-14) means fighting the library through hooks.
  - It owns its HTTP surface and cookies. That conflicts with the web-only public origin (the cookie must be relayed), with the declarative default-deny registry (its routes are a catch-all), and with the OpenAPI drift test.
  - Its default hasher is scrypt. Argon2id needs a custom hash function, and so a hasher decision anyway.
- **Technical Fit**: Low
- **Complexity**: Medium (low to start, high to bend)
- **Scalability**: High

#### Option 1C: Auth.js (next-auth) in the Next.js app
- **Description**: The web owns authentication and sessions. The API trusts a signed token or re-verifies sessions in a shared table.
- **Pros**:
  - Familiar Next.js integration, with Google and Facebook providers built in.
- **Cons**:
  - The API stops being the authority. It would have to trust the web's JWT, which breaks immediate revocation and role changes (AC-HAPPY-7/8), or read a session table written by another app, which is the "apps share a DB schema" anti-pattern.
  - The Credentials provider does not support database sessions (JWT only) and is discouraged by the maintainers.
  - v5 never reached stable, and the project is in maintenance mode.
- **Technical Fit**: Low
- **Complexity**: Medium
- **Scalability**: Medium

| Criterion (weight) | 1A Composition | 1B Better Auth | 1C Auth.js |
|---|---|---|---|
| Maintainability (.25) | 4 | 3 | 2 |
| Correctness/safety (.25) | 5 | 3 | 2 |
| Time to market (.20) | 3 | 4 | 3 |
| Operational simplicity (.15) | 5 | 4 | 3 |
| Cost (.10) | 5 | 5 | 5 |
| Performance (.05) | 4 | 4 | 4 |
| **Weighted** | **4.30** | 3.60 | 2.75 |

#### Sub-decision Q1-H: password hasher

| Option | Summary |
|---|---|
| **H1 `node:crypto.argon2` (argon2id)** | Built into Node since **v24.7.0** and backed by the bundled OpenSSL 3.5. No dependency and no addon. Returns the raw tag, so we write the PHC string ourselves (about 40 lines). Verified locally on Node 24.19.0: `crypto.argon2` and `argon2Sync` exist, no `ExperimentalWarning` is printed, and m=64 MiB, t=3, p=1 takes about 96 ms on the dev machine (m=19 MiB, t=2 takes about 20 ms). |
| H2 `@node-rs/argon2` 2.2.1 | Rust napi addon with prebuilt binaries (linux-x64-gnu and arm64, darwin). No node-gyp. Emits PHC strings and has `verify`. Adds a platform-specific optional dependency that `pnpm deploy` must carry into the slim image. |
| H3 `argon2` (node-argon2) 0.45.1 | Native addon, prebuilt through `node-gyp-build`. Falls back to compiling from source when no prebuild matches, which fails on `node:24-slim` without build tools. |
| H4 `node:crypto.scrypt` | Built in. Not argon2id, so AC-VERIFY-1 (`$argon2id$`) would have to change. Measured cost is N=2^17 at about 258 ms. |

| Criterion (weight) | H1 node argon2 | H2 @node-rs | H3 argon2 | H4 scrypt |
|---|---|---|---|---|
| Maintainability (.25) | 4 | 4 | 3 | 4 |
| Correctness/safety (.25) | 5 | 5 | 5 | 4 |
| Time to market (.20) | 4 | 5 | 4 | 4 |
| Operational simplicity (.15) | 5 | 3 | 2 | 5 |
| Cost (.10) | 5 | 5 | 5 | 5 |
| Performance (.05) | 5 | 5 | 5 | 4 |
| **Weighted** | **4.55** | 4.45 | 3.85 | 4.25 |

H1 wins on operations: no addon in a classic-builder slim image, and nothing for tsup or `pnpm deploy` to get wrong. H2 is the drop-in fallback. Both produce the same standard PHC format, so switching does not invalidate stored hashes.

#### Sub-decision Q1-O: OAuth client

| Option | Summary |
|---|---|
| O1 `arctic` 3.7 | Small and maintained. Inspection of the 3.7.0 package shows it calls the global `fetch` with **no timeout or `AbortSignal`**, and that its Facebook provider **hard-codes Graph API `v16.0`**, a version past its two-year lifetime. Google needs a separate ID-token verifier, because arctic only decodes. |
| O2 `oauth4webapi` 3.8 | OpenID-certified, with `customFetch` and `signal` support, PKCE helpers and ID-token claim validation. OIDC-centric and verbose. Facebook is not OIDC, so it needs hand-built authorization-server metadata. |
| **O3 Thin adapters + `jose`** | About 150 lines per provider pair over an injected `fetch` with `AbortSignal.timeout(5000)`. PKCE S256 via `node:crypto`. Google ID token verified with `jose.jwtVerify` against Google's JWKS (`iss`, `aud`, `exp`, `nonce`). Facebook Graph `/me?fields=id,name,email` with `appsecret_proof` and a pinned current Graph version. |

| Criterion (weight) | O1 arctic | O2 oauth4webapi | O3 adapters + jose |
|---|---|---|---|
| Maintainability (.25) | 4 | 3 | 4 |
| Correctness/safety (.25) | 3 (no timeout, stale Graph version, no ID-token signature check) | 5 | 5 |
| Time to market (.20) | 5 | 3 | 4 |
| Operational simplicity (.15) | 4 | 4 | 5 |
| Cost (.10) | 5 | 5 | 5 |
| Performance (.05) | 4 | 4 | 4 |
| **Weighted** | 4.05 | 3.90 | **4.50** |

### Q2: Session strategy and web/API cookie relay

All options assume the web is the only public origin and the API is internal (C5/C6). The spec's lean (opaque DB sessions) is re-checked against a stateless alternative in 2D.

#### Option 2A: API issues `Set-Cookie`; web relays it
- **Description**: API auth routes answer with `Set-Cookie`. Server Actions and route handlers read `response.headers.getSetCookie()`, parse the attributes and re-emit them with `cookies().set(...)`. The web forwards the browser's `Cookie` header on every API call.
- **Pros**: Cookie attributes are defined once, in the API, and API-level `app.inject` tests can assert them directly.
- **Cons**:
  - Every auth action has to parse and re-emit Set-Cookie (attributes, `__Host-` rules, Max-Age vs Expires), which is easy to get subtly wrong.
  - Server Components cannot set cookies, so a sliding refresh `Set-Cookie` returned during a page render is silently lost.
  - The API becomes cookie-authenticated, so it needs CSRF defence of its own if it is ever exposed.
- **Technical Fit**: Medium. **Complexity**: Medium. **Scalability**: High.

#### Option 2B: Web owns the cookie; API is a bearer-token authority (opaque DB sessions)
- **Description**: The API creates the session row and returns `{ user, session: { token, expiresAt } }` in the JSON body of `register`, `login` and `oauth/*` success responses. Only the web's server code ever sees this body. The web stores the token in its own HttpOnly cookie and sends it to the API as `Authorization: Bearer <token>`. The API sets no cookies and never reads cookies.
- **Pros**:
  - One cookie owner, the only public origin, writing cookies only where Next allows it (actions, route handlers, proxy).
  - The API cannot be hit by CSRF: browsers never attach a bearer header on their own.
  - The existing redaction already masks `req.headers.authorization`.
  - Authority stays in the API. Revocation, role changes and bans take effect on the next request.
  - Future non-browser clients get a natural interface.
- **Cons**:
  - The token appears in a JSON body on the internal hop. This is acceptable because the hop is private or HTTPS (C5) and response bodies are not logged.
  - Cookie-flag ACs move from API-level to web-level tests (see [AC impact](#ac-impact)).
- **Technical Fit**: High. **Complexity**: Low. **Scalability**: High.

#### Option 2C: Next rewrites `/api/*` to the API (browser talks to the API through the web origin)
- **Description**: `next.config.ts` rewrites proxy browser calls to `API_INTERNAL_URL`. The API sets the cookie directly on the web origin. Server Components still forward cookies themselves.
- **Pros**: Client components could call the API without Server Actions.
- **Cons**:
  - Two paths to the API (rewrite and server-side), each with its own CSRF and trace handling.
  - Exposes the whole API surface publicly, which undoes C6's "web is the only public origin".
  - The default-deny policy and the Origin check become the only barrier.
- **Technical Fit**: Low. **Complexity**: Medium. **Scalability**: High.

#### Option 2D: Stateless signed tokens (JWT/PASETO) instead of DB sessions
- **Description**: The API issues a signed access token (short TTL) plus a refresh token. The web holds both.
- **Pros**: No session read per request.
- **Cons**:
  - AC-HAPPY-7 (a replayed cookie returns 401 after logout) and AC-HAPPY-6 (a reset revokes every session) need a deny-list or short TTL plus a refresh-token table. That is a DB session again, with two token types.
  - The role is read from the DB on every request anyway (AC-HAPPY-8), so the saved read buys nothing.
- **Technical Fit**: Low. **Complexity**: High. **Scalability**: High.

| Criterion (weight) | 2A Set-Cookie relay | 2B Web cookie + bearer | 2C Rewrites | 2D JWT |
|---|---|---|---|---|
| Maintainability (.25) | 3 | 5 | 3 | 3 |
| Correctness/safety (.25) | 4 | 5 | 3 | 3 |
| Time to market (.20) | 3 | 4 | 4 | 3 |
| Operational simplicity (.15) | 4 | 5 | 3 | 3 |
| Cost (.10) | 5 | 5 | 5 | 5 |
| Performance (.05) | 4 | 4 | 4 | 5 |
| **Weighted** | 3.65 | **4.75** | 3.45 | 3.30 |

### Q5: RBAC guard design

#### Option 5A: Declarative per-route policy enforced by an `onRoute` registry (default deny)
- **Description**: Every route declares `config: { policy }`. A root `onRoute` hook, registered before any route, throws at registration time if `policy` is missing, so `buildApp` rejects and the process never binds a port. It then attaches the matching hooks: session resolution at `onRequest` (before the body is parsed) and the role or team check at `preHandler` (after `params` are validated).
- **Pros**:
  - Forgetting a guard is structurally impossible, not just caught by review.
  - One place adds the OpenAPI `security` requirement and the 401/403 responses, so the docs follow the policy.
  - Route enumeration for AC-VERIFY-3 comes for free: the hook records every policy.
- **Cons**: Slightly indirect, because the guard code is not visible in the route body. Mitigated by named policy constructors.
- **Technical Fit**: High. **Complexity**: Low. **Scalability**: High.

#### Option 5B: Composed `preHandler`s per route, plus an enumeration test
- **Description**: Routes list `preHandler: [authenticate, requireTeamRole('TEAM_ADMIN')]`. A unit test enumerates routes and checks that each has a known guard or a `public` marker.
- **Pros**: Explicit at each route, and idiomatic Fastify.
- **Cons**:
  - Default deny lives in a test, not the runtime, so a route registered by a plugin the test doesn't build is unguarded.
  - Hook ordering (authenticate before role) must be repeated correctly everywhere.
- **Technical Fit**: Medium. **Complexity**: Low. **Scalability**: High.

#### Option 5C: Global authentication hook with a public allowlist, roles per route
- **Description**: A root `onRequest` hook authenticates every request except allowlisted paths. Role checks are per-route `preHandler`s.
- **Pros**: Default-authenticated.
- **Cons**:
  - The allowlist is a list of path strings that drifts from the routes.
  - Authorization (roles, teams) is still opt-in per route, so default deny covers only authentication.
- **Technical Fit**: Medium. **Complexity**: Low. **Scalability**: High.

| Criterion (weight) | 5A onRoute registry | 5B composed preHandlers | 5C global hook + allowlist |
|---|---|---|---|
| Maintainability (.25) | 5 | 4 | 3 |
| Correctness/safety (.25) | 5 | 3 | 3 |
| Time to market (.20) | 4 | 5 | 4 |
| Operational simplicity (.15) | 5 | 4 | 4 |
| Cost (.10) | 5 | 5 | 5 |
| Performance (.05) | 5 | 5 | 4 |
| **Weighted** | **4.80** | 4.10 | 3.60 |

**Sub-decisions:**

| Question | Options | Chosen | Why |
|---|---|---|---|
| GLOBAL_ADMIN and team guards | (a) always bypass; (b) never; (c) per-route `allowGlobalAdmin: true` | **(c)** | Matches AC-HAPPY-9. Platform oversight routes (payment reminders, admin reporting) opt in explicitly, and team-private actions stay private by default. |
| 403 vs 404 for team routes | (a) 403 everywhere; (b) 404 for private teams; (c) 404 for all non-members | **(a) 403** | The guard does not look up the team. A missing team, a team without membership and a non-approved membership all give the same 403 `forbidden`, so the guard reveals nothing about team existence. A per-route `hideExistence` option (404) is **reserved, not built**. team-management may add it for private-team reads. |
| Membership states | approved only vs approved plus pending (read-only) | **Approved only** | `requireTeamRole('MEMBER')` passes for `MEMBER` or `TEAM_ADMIN` with `status='APPROVED'`. `requireTeamRole('TEAM_ADMIN')` needs both. PENDING, REJECTED and BANNED fail (AC-ERROR-12). |
| `global_role` still contains `TEAM_ADMIN` | (a) `CHECK (role <> 'TEAM_ADMIN')`; (b) enum recreate migration (rename type, create a 2-value type, `ALTER COLUMN … USING`, drop the old type) | **(a) CHECK** | Same precedent as `billing_type`, where draft values are kept for conformance with `database-design.md`. Enum parity and the shared enum stay unchanged, and AC-VERIFY-4 expects 23514. The generated Kysely type still includes `TEAM_ADMIN`. The fix is a shared `AssignableGlobalRole = Exclude<GlobalRole, 'TEAM_ADMIN'>`, which is the only role type auth code, the CLI and the zod schemas use. Option (b) stays available later as a non-breaking migration. |
| Session-optional routes | fold into `public` vs a fifth kind | **Fifth kind `optionalSession`** | `POST /auth/logout` (idempotent 204 even when the session is dead) and `POST /auth/oauth/:provider/callback` (link intent must match the current session) read a session when one is present but never answer 401. Hiding that inside handlers would bypass the registry. |

### Q6: OAuth redirect topology and short-lived state

**Topology (confirmed, assumed by the spec):** the provider redirects to the **web-owned** callback `/auth/callback/[provider]`. The browser can only reach the web, and the redirect URI must be on a public origin. The API builds the authorization URL and redirect URI from `WEB_BASE_URL`, and the web callback calls JSON API endpoints server-side.

#### Option 6A: Postgres rows for state and pending sign-up; browser-binding cookies hold only random handles
- **Description**: `POST /auth/oauth/:provider/authorize` inserts an `oauth_states` row with the SHA-256 of `state`, provider, intent, `link_user_id`, nonce, `return_to`, the encrypted PKCE verifier and a 10-minute expiry. The callback consumes it with one guarded `UPDATE … SET used_at = $now WHERE state_hash = $1 AND used_at IS NULL AND expires_at > $now RETURNING`. A first-time user gets an `oauth_pending_signups` row (verified provider profile, 15 min). The web holds only `sgm_oauth` (the raw state plus an unauthenticated landing hint, for the browser binding) and `sgm_pending` (the raw pending token).
- **Pros**:
  - Single use is enforced by the database (P1). A replayed callback finds a used row and does nothing (AC-ERROR-7).
  - Pending sign-ups can expire, be consumed once and be cleaned (AC-ERROR-14, AC-ASYNC-3).
  - Matches the spec's Data Persisted and AC-VERIFY-5 wording.
  - No provider profile data (email, name) is held in the browser.
- **Cons**: Two small tables, one more write per sign-in, and a cleanup job (which is needed anyway).
- **Technical Fit**: High. **Complexity**: Low. **Scalability**: High.

#### Option 6B: Encrypted cookies (AES-GCM keyring) for state, verifier and pending profile
- **Description**: The API returns a sealed blob (state, verifier, intent, expiry; later the profile) that the web stores in a cookie and sends back.
- **Pros**: Stateless, with no tables.
- **Cons**:
  - Single use cannot be enforced: a cookie can be replayed until it expires. Replay protection then rests on the provider's one-time codes, which does not cover the pending-sign-up step.
  - The keyring's AAD needs a row id, which a stateless blob has to invent.
  - Profile PII sits in the browser.
  - It diverges from the spec's tables and cleanup AC.
- **Technical Fit**: Medium. **Complexity**: Medium. **Scalability**: High.

#### Option 6C: Hybrid (state in an encrypted cookie, pending sign-up in Postgres)
- **Pros**: One fewer table.
- **Cons**: Still no single-use state (AC-ERROR-7 replay), and two mechanisms to reason about.
- **Technical Fit**: Medium. **Complexity**: Medium. **Scalability**: High.

| Criterion (weight) | 6A Postgres rows | 6B Encrypted cookies | 6C Hybrid |
|---|---|---|---|
| Maintainability (.25) | 5 | 3 | 3 |
| Correctness/safety (.25) | 5 | 3 | 3 |
| Time to market (.20) | 4 | 4 | 4 |
| Operational simplicity (.15) | 4 | 5 | 4 |
| Cost (.10) | 5 | 5 | 5 |
| Performance (.05) | 4 | 5 | 4 |
| **Weighted** | **4.60** | 3.80 | 3.60 |

**Browser binding (in addition to 6A, not instead of it).** A state row alone does not stop login CSRF: an attacker could start a flow, approve with their own account and send the victim the callback URL. The web therefore sets the `sgm_oauth` cookie when it starts the flow, and the callback route handler compares the query `state` with the cookie's state component (constant-time) **before** calling the API. A mismatch or a missing cookie gives "We couldn't verify that sign-in attempt" and the state is not consumed. `SameSite=Lax` is enough because Google and Facebook return with a top-level GET. The cookie's format is defined once, below; the user-journey document references it.

#### Browser-binding cookie `sgm_oauth` (the one schema)

| Aspect | Rule |
|---|---|
| Name | `__Host-sgm_oauth` when `WEB_BASE_URL` is https, else `sgm_oauth`; HttpOnly, SameSite=Lax, Path=/, Secure when https, no Domain; Max-Age 600 (equal to the state TTL) |
| Value | `<state>.<ctx>`, exactly one `.` |
| `state` | the raw state returned by `authorize`: 32 random bytes as base64url, so it matches `OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/` (no `.` possible) |
| `ctx` | base64url (no padding) of UTF-8 JSON `{ "v": 1, "r": <returnTo>, "i": "signin" \| "link" }`, parsed with a strict zod schema (unknown keys rejected); `r` is a string of at most 512 characters |
| Size | the whole value is at most 1024 bytes; a longer value is rejected before decoding |
| Comparison | only the state component is compared with the query `state`, using `timingSafeEqual` over two 43-byte buffers; a query `state` that fails `OAUTH_STATE_PATTERN` is a mismatch without comparing. `ctx` is never compared and never authenticated |
| `r` (returnTo) | always passed through `safeReturnTo` when read; used **only** for error landings, when the API cannot supply a stored `returnTo`. On success the API's `oauth_states.return_to` (or the pending row's) is authoritative |
| `i` (intent) | an untrusted hint used **only** to choose the error landing (`/login` for `signin`, `/account` for `link`). The `oauth_states` row's `intent` and `link_user_id` decide what the callback does; editing `i` can at most move an error message to the other page |
| Missing or expired | treated as a binding mismatch: the API is not called, so the server state is not consumed. Landing: a signed-in browser goes to `/` silently; otherwise `/login?error=oauth_state_invalid&provider=…` (no `returnTo`, since there is no `ctx`) |
| Tampered (bad format, oversized, bad base64url or JSON, unknown `v`, `i` not in the enum, state mismatch) | same as missing; if `ctx` itself parsed, its sanitised `r` and `i` may still choose the error landing |
| Replay | the handler deletes the cookie on **every** callback outcome before calling the API, so a replayed callback URL finds no cookie; the guarded `used_at` UPDATE independently makes the state single-use |
| New flow | starting another flow overwrites the cookie, so the first tab's return fails the binding check ("Please try again") |
| Interop tests | `packages/shared/src/auth/oauth-binding.test.ts`: encode/parse round trip; every tamper case above; size limit; constant-time compare called with the state component only; a fixture state produced by the API's `newToken()` (and asserted in the API's `oauth-service` tests to match `OAUTH_STATE_PATTERN`) parses in the codec |

**Link intent.** `POST /auth/identities/:provider/link` (policy `authenticated`) creates the state with `intent='link'` and `link_user_id = request.auth.userId`. On callback (policy `optionalSession`), the API requires `request.auth?.userId === link_user_id` before it attaches the identity (else 403 `link_session_mismatch`, or 401 `session_expired` when the presented session is dead). What happens on an identity or email conflict is Algorithm Q3's decision.

### Q8: Fake OAuth provider for E2E

#### Option 8A: Env-selected fake adapter in the API, with Playwright intercepting the fake authorization host
- **Description**: `AUTH_FAKE_OAUTH=true` replaces the Google and Facebook adapters with `FakeOAuthProvider` instances, so both providers report enabled without credentials. The config refuses it when `NODE_ENV=production`, and boot logs a warning when it is on. The fake authorization URL is `https://oauth.fake.invalid/authorize?provider=…&state=…&redirect_uri=…`, a reserved TLD that never resolves. Playwright's `page.route('https://oauth.fake.invalid/**')` plays the consent screen: it answers 302 to `redirect_uri?state=…&code=fake.<base64url JSON>` or `…&error=access_denied`. The fake adapter decodes `code` with a strict zod schema (`{ fixture, sub?, email?, name? }`) and returns the normalised profile from the **same recorded fixtures** the real adapters' unit tests parse (`providers/fixtures/*.json`). Integration tests call `POST /auth/oauth/:provider/callback` with such codes directly through `app.inject`.
- **Pros**:
  - Zero test code in the web bundle. The real web callback, cookies, state binding and API orchestration all run end to end.
  - Per-run unique emails and subjects through the code payload.
  - One fixture set serves unit and E2E tests.
- **Cons**:
  - The real adapters' HTTP code is not exercised in E2E. It is covered by unit tests with recorded responses through an injected `fetch`, plus the one-off manual smoke test (AC-INTEGRATION-3).
- **Technical Fit**: High. **Complexity**: Low. **Scalability**: n/a.

#### Option 8B: Recorded HTTP stubs (undici `MockAgent` / nock) for the real adapters
- **Description**: The real adapters run, and outbound HTTP to Google and Facebook is intercepted.
- **Pros**: Exercises real adapter HTTP code.
- **Cons**:
  - Works in-process (unit and integration) but not in the Compose E2E stack, where the API runs in a container.
  - Something still has to play the provider's consent page for the browser.
- **Technical Fit**: Medium (good for unit tests, not E2E). **Complexity**: Medium.

#### Option 8C: A mock OIDC server container (e.g. `navikt/mock-oauth2-server`) in Compose
- **Description**: A real OIDC server with an interactive login form. Provider endpoints become configurable.
- **Pros**: Highest fidelity for Google-style OIDC, including JWKS signature checks.
- **Cons**:
  - Cannot emulate Facebook's Graph `/me`.
  - Needs per-provider endpoint config in production code paths and one more service in Compose and CI.
- **Technical Fit**: Low. **Complexity**: High.

| Criterion (weight) | 8A fake adapter + route interception | 8B HTTP stubs | 8C mock OIDC server |
|---|---|---|---|
| Maintainability (.25) | 5 | 3 | 3 |
| Correctness/safety (.25) | 4 | 4 | 4 |
| Time to market (.20) | 5 | 3 | 2 |
| Operational simplicity (.15) | 5 | 4 | 2 |
| Cost (.10) | 5 | 5 | 4 |
| Performance (.05) | 5 | 5 | 4 |
| **Weighted** | **4.75** | 3.70 | 3.05 |

8B is still used, but only where it fits: the real adapters' unit tests inject a `fetch` double that replays recorded responses (AC-INTEGRATION-3).

---

## Evaluation Matrix (summary of the chosen option per question)

| Criteria | Q1 1A + H1 + O3 | Q2 2B | Q5 5A | Q6 6A | Q8 8A |
|----------|------|------|------|------|------|
| Scalability | High (stateless replicas; one indexed session read per request) | High | High | High | n/a |
| Maintainability | 4 | 5 | 5 | 5 | 5 |
| Performance | argon2id ~100 ms by design; other paths are single-row queries | 4 | 5 | 4 | 5 |
| Security | 5 (no addon, DB invariants, verified ID tokens) | 5 (API immune to CSRF) | 5 (structural default deny) | 5 (single-use, browser-bound) | 4 (refused in production) |
| Observability | 5 (spans around hash and provider calls) | 5 (bearer already redacted) | 5 (policy recorded per route) | 5 | 4 |
| Implementation Cost | Medium | Low | Low | Low | Low |

---

## Observability Architecture

### Logging
- **Library**: the existing pino logger (`apps/api/src/lib/logger/logger.ts`), shared by Fastify. No new library.
- **Format**: structured JSON with `timestamp`, `level`, `message`, `service`, `version`, `traceId`, `spanId` and `requestId` (existing).
- **Redaction changes** (AC-VERIFY-6):
  - Query masking gains an **exact-name** list `code`, `state`, `token`, `error_description`. It is not a key pattern, because the substring `code` would also mask `statusCode` and `providerCode`.
  - Exact header paths `req.headers["x-sgm-client-ip"]`, `req.headers["x-sgm-internal-auth"]` and `req.headers["set-cookie"]` are added to `REDACT_PATHS`. `authorization` and `cookie` are already redacted.
  - Body keys matching `token` and `password` are already covered by the default `LOG_REDACT_PATTERNS` and `BASE_KEY_PATTERNS`.
  - Services never log request bodies, emails or names.
- **Business events** (info unless noted, `userId` only as PII):
  - `auth.register` (`provider`)
  - `auth.login.succeeded` (`userId`, `provider`)
  - `auth.login.failed` (warn; `reason`: `invalid_credentials|throttled_email|throttled_address`, the algorithm doc's reason codes; never the email or a key hash)
  - `auth.session.revoked` (`reason`: `logout|password_reset|replaced`)
  - `auth.password_reset.requested` (`userId` or `known: false`)
  - `auth.password_reset.completed` (`userId`, `removedProviders`)
  - `auth.oauth.started|cancelled|failed` (`provider`, `reason`)
  - `auth.oauth.conflict`, `auth.oauth.link_conflict`, `auth.oauth.email_missing` (`provider`; the rules are Q3/Q4's)
  - `auth.oauth.pending.created` (`provider`)
  - `auth.identity.linked|unlinked`
  - `auth.throttle.address_missing` (rate-limited warn) and `auth.client_address.untrusted` (warn: `x-sgm-client-ip` arrived without a valid `x-sgm-internal-auth`)
  - `auth.authz.denied` (debug; `policy` kind, `status`)
- **Configuration**: unchanged (`LOG_LEVEL`, `LOG_FORMAT`, `LOG_OUTPUT`, `LOG_FILE_PATH`, `LOG_REDACT_PATTERNS`).

### Distributed Tracing
- **SDK**: OpenTelemetry (existing `@fastify/otel` request spans). The web has no SDK. `api-client.ts` `traceHeaders()` already creates or continues `traceparent`.
- **Propagation**: W3C Trace Context.
- **Service Boundaries**:

  | From | To | Protocol | Propagation Method |
  |------|-----|----------|-------------------|
  | Browser | web | HTTPS | Root context comes from the incoming request (none required) |
  | web (Server Action, route handler, RSC) | api | HTTP | `traceparent`/`tracestate` from `traceHeaders(await headers())` on every auth call |
  | api | PostgreSQL | pg wire | No propagation (pg instrumentation not wired, per techContext) |
  | api (forgot) | `pgboss.job` | SQL | `payload._meta.traceparent` via `jobs.enqueue` inside the token transaction |
  | worker | handler (`send-email`, `auth-cleanup`) | in-process | `send-email`: child span from `_meta`. `auth-cleanup` cron: new root span `"auth-cleanup process"` |
  | api | Google / Facebook | HTTPS | **Client span only, no `traceparent` injected.** Trace context is not sent to third parties: it would disclose internal ids and has no receiver. This is a deliberate exception to "propagate on every HTTP client". |

- **Custom spans**: `auth.password.hash`, `auth.password.verify` (attribute `rehash: boolean`), `oauth.<provider>.token_exchange`, `oauth.<provider>.profile`, `oauth.google.id_token_verify`.
- **Sampling**: unchanged (`OTEL_TRACES_SAMPLER=parentbased_traceidratio`, `OTEL_TRACES_SAMPLER_ARG` 1.0 in dev, 0.1 in production).

### Metrics
- No metrics exporter exists yet (foundation: `METRICS_ENABLED=false`, no implementation). This feature **reserves** the names below in the ADR so the metrics feature can implement them without renaming. Labels are low-cardinality only: no user, session, team or email.
- **Standard Metrics**:
  - `http_requests_total{method, route, status_code}`
  - `http_request_duration_seconds{method, route}`
- **Custom Business Metrics**:
  - `sgm_auth_logins_total{provider, outcome}` (`succeeded|failed|throttled`): sign-in health and attack signal
  - `sgm_auth_registrations_total{provider}`: onboarding funnel
  - `sgm_auth_password_hash_duration_seconds`: hash cost drift on new hardware
  - `sgm_auth_oauth_callbacks_total{provider, outcome}` (`signed_in|pending|linked|cancelled|state_invalid|provider_error|conflict`)
  - `sgm_auth_sessions_revoked_total{reason}`
  - `sgm_auth_authz_denied_total{policy, status}` (`policy` ∈ `authenticated|globalRole|teamRole`; `status` ∈ `401|403`)

### Configuration Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| LOG_LEVEL | Log verbosity | `info` (`debug` in development) |
| LOG_FORMAT | Output format | `json` |
| OTEL_EXPORTER_OTLP_ENDPOINT | Collector endpoint | none |
| OTEL_SERVICE_NAME | Service identifier | `sgm-api` / `sgm-worker` (set per process) |
| OTEL_TRACES_SAMPLER_ARG | Sampling ratio | 1.0 (dev) |

Auth variables are listed under [Final environment variables](#final-environment-variables).

---

## Decision

**Chosen**: Option 1A (Fastify-native composition), with H1 (`node:crypto` argon2id), O3 (thin provider adapters + `jose`), 2B (web-owned cookie, bearer to the API, opaque DB sessions), 5A (declarative `onRoute` default-deny registry), 6A (Postgres state and pending sign-up rows plus browser-binding cookies) and 8A (env-selected fake adapter and Playwright interception).

### Q1: Library and hasher
**Chosen**: **1A + H1 + O3.** Highest weighted scores (4.30, 4.55, 4.50). The schema, the deferred user creation and the web-only public origin all fit our own code better than a framework's model. The Node 24 built-in argon2 removes the native-addon risk the plan flagged for the classic-builder slim image.

**Hasher specification** (`apps/api/src/modules/auth/password.ts`, interface `PasswordHasher { hash(pw), verify(phc, pw): { ok, needsRehash } }`):
- **Algorithm**: `crypto.argon2('argon2id', { message, nonce: randomBytes(16), parallelism: 1, tagLength: 32, memory: 65536, passes: 3 })`. This is m=64 MiB, t=3, p=1, above the OWASP minimum (m=19 MiB, t=2, p=1), and matches RFC 9106's second recommended memory size. Locally it takes about 96 ms, and on CI it is expected to be about 150–300 ms (inside AC-VERIFY-1's 50 ms–1 s). The async variant runs on the libuv threadpool.
- **Encoding**: standard PHC string `$argon2id$v=19$m=65536,t=3,p=1$<salt b64, no padding>$<hash b64, no padding>` (about 97 characters, under 512). It is verifiable by any argon2 library, so H2 is a transparent fallback.
- **Verify**: parse the PHC string strictly, recompute with the stored parameters, compare with `timingSafeEqual`. `needsRehash` is true when stored m, t, p, tag length or salt length are below current. On a successful login with `needsRehash`, the identity's hash is replaced in the same transaction.
- **Input**: the password is NFKC-normalised before hashing (NIST SP 800-63B). Length rules (10–128) are checked by the shared zod schema on the raw input.
- **Concurrency cap**: a per-process semaphore allows at most 2 concurrent hashes or verifications. That bounds transient memory to 128 MiB and leaves the 4-thread libuv pool free for DNS and fs. Waiters queue, and the time spent waiting is inside the request span.
- **Dummy hash** (AC-VERIFY-10): computed once at hasher construction. Unknown accounts and accounts with no PASSWORD identity still call `verify(dummy, pw)`.
- **Boot self-test (P7)**: `createPasswordHasher()` checks that `crypto.argon2` is a function and runs a known-answer test: the RFC 9106 §5.3 argon2id vector (m=32, t=3, p=4, with secret and associated data, both of which `crypto.argon2` accepts), costing well under 1 ms. A unit test also checks that a PHC string from another implementation (a committed fixture string) verifies. If either fails, boot stops with `Invalid configuration: runtime — node:crypto argon2 unavailable (Node >= 24.7 with OpenSSL >= 3.2 required)`. This catches Node builds linked against an older shared OpenSSL.
- **Engines**: root `package.json` `engines.node` goes from `>=24 <25` to `>=24.7 <25`. `node:24-slim` and `actions/setup-node@node 24` already resolve to 24.19+.

**OAuth adapter specification** (`providers/provider.ts`):
```ts
interface OAuthProvider {
  readonly name: 'GOOGLE' | 'FACEBOOK';
  /** PKCE verifier and nonce are generated by the service and passed in; the adapter only builds the URL. */
  authorizationUrl(input: { state: string; redirectUri: string; codeVerifier?: string; nonce?: string }): URL;
  /** Exchanges the code and returns a normalised, provider-verified profile. Throws ProviderError. */
  exchange(input: { code: string; redirectUri: string; codeVerifier?: string; nonce?: string }): Promise<ProviderProfile>;
}
interface ProviderProfile {
  provider: 'GOOGLE' | 'FACEBOOK';
  subject: string;                 // Google `sub` / Facebook `id`
  email: string | null;            // lower-cased; null when not shared
  emailVerified: boolean;          // Google `email_verified`; Facebook: see Algorithm Q3/Q4
  fullName: string | null;
}
class ProviderError extends Error { readonly kind: 'unavailable' | 'rejected' | 'invalid_response' }
```
- **Google**: PKCE S256 and `nonce`, scopes `openid email profile`. Token endpoint over the injected `fetch` with `AbortSignal.timeout(5000)`. The `id_token` is verified with `jose.jwtVerify` against `createRemoteJWKSet('https://www.googleapis.com/oauth2/v3/certs')`, injectable as a local JWKS in tests: `iss ∈ {https://accounts.google.com, accounts.google.com}`, `aud = GOOGLE_OAUTH_CLIENT_ID`, `exp` and `nonce`. The access token is discarded.
- **Facebook**: no PKCE (state + app secret), scope `email,public_profile`. Code exchange, then `GET https://graph.facebook.com/<GRAPH_VERSION>/me?fields=id,name,email&appsecret_proof=HMAC_SHA256(app_secret, access_token)`. `GRAPH_VERSION` is a constant in `facebook.ts`, set at build to the current Graph version (check the Meta changelog). A unit test asserts its `vNN.N` format, and the ADR notes the two-year refresh. The access token is discarded.
- **Error mapping**: network or timeout or 5xx → `unavailable` ("Google is unavailable right now…"). 4xx `invalid_grant` → `rejected` (treated like a bad state). Schema mismatch or failed ID-token verification → `invalid_response` (logged at warn, shown as "couldn't verify").
- **No provider tokens are stored.** Nothing from the provider is persisted except subject, email and name (privacy NFR).

### Q2: Sessions and relay
**Chosen**: **2B: opaque Postgres sessions, web-owned cookie, bearer to the API.**

**Session model** (`modules/auth/sessions.ts`, `tokens.ts`):
- **Token**: 32 bytes from `randomBytes`, sent as base64url (43 characters). Only `sha256(token)` is stored, as `bytea`, unique (AC-VERIFY-2).
- **Lifetimes**: `expires_at = min(now + idle, absolute_expires_at)`, `absolute_expires_at = created_at + absolute`. Defaults are idle 7 days and absolute 30 days (env).
- **Touch**: an authenticated request extends `expires_at` (and sets `last_seen_at`) only when `last_seen_at` is older than **1 hour** (`SESSION_TOUCH_INTERVAL`, a constant). That is at most one write per session per hour, and the drift is negligible against a 7-day idle window.
- **Resolve** (one query, run by `authenticate`): `SELECT s.id, s.user_id, s.expires_at, s.revoked_at, u.role FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`. Results:
  - no bearer → 401 `unauthenticated`
  - bearer present but no row (unknown or already cleaned up), `revoked_at` set, or `expires_at <= clock.now()` → 401 `session_expired`
  - otherwise `request.auth = { userId, sessionId, role }`. The role comes from `users` on every request, and the session carries no role claim (AC-VERIFY-4).
- **Issue**: always a new row on register, login and OAuth completion. There is no pre-auth session, so session fixation does not apply. The user agent is stored truncated to 512 characters (forwarded by the web as `user-agent`). No IP address is stored.
- **Revoke**: logout sets `revoked_at` and `revoked_reason='logout'`. A completed reset revokes every live session of the user with `password_reset`, in the reset transaction. A sign-in that presents an existing session revokes it with `replaced` (algorithm token table).
- **Response contract**: successful `register`, `login` and `oauth/complete` (and an OAuth callback that signs in) return `{ user: UserView, session: { token, expiresAt } }`, where `expiresAt` is the absolute expiry. `GET /auth/me` returns `{ user }` only (AC Success Criteria).

**Cookies** (web only, `apps/web/src/lib/auth/cookies.ts`):

| Cookie | Name when `WEB_BASE_URL` is https / http | Value | Lifetime | Attributes |
|---|---|---|---|---|
| Session | `__Host-sgm_session` / `sgm_session` | session token | `Expires = session.expiresAt` (absolute) | HttpOnly, SameSite=Lax, Path=/, Secure when https, no Domain |
| OAuth binding | `__Host-sgm_oauth` / `sgm_oauth` | `<state>.<ctx>` (see [the one schema](#browser-binding-cookie-sgm_oauth-the-one-schema)) | Max-Age 600 | same |
| Pending sign-up | `__Host-sgm_pending` / `sgm_pending` | raw pending token | Max-Age 900 | same |
| Flash email | `__Host-sgm_flash` / `sgm_flash` | conflicting email from a 409 `oauth_account_exists` (user-journey X2) | Max-Age 60 | same |

- Secure and the `__Host-` prefix depend on **`WEB_BASE_URL` being https**, not on `NODE_ENV`. The Compose web container runs the production build over `http://localhost:3000`, so a `NODE_ENV` rule would break E2E. The web config refuses `NODE_ENV=production` with an `http:` `WEB_BASE_URL` unless the hostname is `localhost` or `127.0.0.1`. The API config refuses `NODE_ENV=production` with a non-https `WEB_BASE_URL`, with no exception.
- The cookie lifetime is the absolute expiry. Idle expiry is enforced by the API and shows up as `session_expired`. The cookie is never rewritten during a render (Server Components cannot set cookies).
- Flash messages travel as **codes** in the query string (`/login?notice=password_updated`, `?error=oauth_cancelled&provider=google`). They are mapped to fixed text in `apps/web/src/lib/auth/messages.ts`, so arbitrary text is never reflected.

**CSRF (AC-ERROR-15)**:
- **Web**: Server Actions use Next's built-in check (POST only, `Origin` compared with Host or `X-Forwarded-Host`). Set `serverActions.allowedOrigins = [new URL(WEB_BASE_URL).host]`, with the exact config key checked against the installed Next 16.3 at build, so the check holds behind the platform proxy. `proxy.ts` also refuses (403) any non-GET/HEAD request whose `Origin` is present and not `WEB_BASE_URL`'s origin. That covers route handlers. All auth mutations are Server Actions, and the OAuth callback is a GET protected by state and its binding cookie. Session cookies are `SameSite=Lax`.
- **API**: `lib/http/origin.ts` refuses (403 `cross_origin_request`) any non-GET/HEAD/OPTIONS request carrying an `Origin` other than `WEB_BASE_URL`'s origin. Server-side `fetch` from the web sends no `Origin`, so legitimate calls pass. This is defence in depth: bearer authentication already makes the API immune to browser CSRF.

**Web helpers**:
- `getCurrentUser()` is wrapped in React `cache()`, with one `GET /auth/me` per render. It returns `null` on 401.
- `requireUser(returnTo)`: on no cookie → `redirect('/login?returnTo=…')`. On 401 with a cookie present → `redirect('/auth/session-expired?returnTo=…')`. That route handler calls `GET /auth/me` again and deletes the cookie only on 401 (user-journey X14, so a cross-site GET cannot sign anyone out), then redirects to `/login?returnTo=…&notice=session_expired`; with a live session it redirects to `returnTo` (AC-ERROR-11).
- `proxy.ts` only checks that the cookie exists on protected matchers (`/account` for now). The real check is `requireUser` in the page, following Next's guidance that proxy is not an auth boundary.

### Q5: RBAC guards
**Chosen**: **5A.** The shapes below are binding for downstream features.

```ts
// apps/api/src/lib/auth/policy.ts
type RoutePolicy =
  | { kind: 'public' }
  | { kind: 'optionalSession' }
  | { kind: 'authenticated' }
  | { kind: 'globalRole'; roles: readonly AssignableGlobalRole[] }
  | { kind: 'teamRole'; role: TeamRole; teamIdParam: string; allowGlobalAdmin: boolean };

export const publicRoute = (): RoutePolicy => ({ kind: 'public' });
export const optionalSession = (): RoutePolicy => ({ kind: 'optionalSession' });
export const authenticated = (): RoutePolicy => ({ kind: 'authenticated' });
export const requireGlobalRole = (...roles: AssignableGlobalRole[]): RoutePolicy => ({ kind: 'globalRole', roles });
export const requireTeamRole = (role: TeamRole, opts: { teamIdParam?: string; allowGlobalAdmin?: boolean } = {}): RoutePolicy =>
  ({ kind: 'teamRole', role, teamIdParam: opts.teamIdParam ?? 'teamId', allowGlobalAdmin: opts.allowGlobalAdmin ?? false });

declare module 'fastify' {
  interface FastifyContextConfig { policy?: RoutePolicy }
  interface FastifyRequest {
    auth: RequestAuth | null;                         // decorated null; set by authenticate / optional resolve
    teamMembership: { teamId: string; role: TeamRole } | null;  // set by the team guard
  }
}
// usage
app.get('/teams/:teamId/settings', { config: { policy: requireTeamRole('TEAM_ADMIN') }, schema: {...} }, handler);
```

- **Registration (`registerAuthPlatform(app, deps)`)**: called in `buildApp` **before** swagger and before any route. It adds the root `onRoute` hook that:
  1. throws `Error('route <METHOD> <url> declares no auth policy')` when `routeOptions.config?.policy` is missing (so `buildApp` rejects and the app refuses to boot);
  2. for `teamRole`, checks that the route URL contains `:<teamIdParam>`;
  3. appends hooks per kind: `optionalSession` → `onRequest` resolve that never fails; `authenticated`, `globalRole`, `teamRole` → `onRequest` authenticate (401 before body parsing); then `preHandler` role or team check (after zod params validation);
  4. merges `security: [{ sessionToken: [] }]` and the shared `ErrorResponse` for 401/403 into `routeOptions.schema`;
  5. records `{ method, url, policy }` in a registry that `policy.test.ts` enumerates (AC-VERIFY-3).
- Auto-generated HEAD routes inherit `config`. The registry treats them like their GET. 404s are not routes and go to the not-found handler.
- **Team check** (`guards.ts`): `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 AND status = 'APPROVED'`. `TEAM_ADMIN` satisfies `MEMBER`. A non-UUID `:teamId` is rejected by the route's zod params first (422). With `allowGlobalAdmin` and `request.auth.role === 'GLOBAL_ADMIN'`, the check passes and `teamMembership` stays `null`. Membership is never cached (AC-ERROR-12).
- **Global-role check**: `roles.includes(request.auth.role)`, with the role read in the resolve query (AC-HAPPY-8).
- **Handler narrowing**: `requireAuth(request): RequestAuth` throws `AppError('unauthenticated')` if called under a policy that does not guarantee a session. That protects against wiring mistakes.
- **Schema (P1)**: migration 1 adds `CHECK (role <> 'TEAM_ADMIN')` on `users.role`. The shared `AssignableGlobalRole` is the only role type in zod schemas, the CLI and services. Register schemas are strict, so a `role` field gives 422 (AC-ERROR-2).

### Q6: OAuth topology and state
**Chosen**: **6A + browser-binding cookies, web-owned callback.**

**Sign-in flow (intent `signin`):**
```
Browser  ── click "Continue with Google" (form → Server Action startOAuth('google', returnTo)) ──► web
web      ── POST /auth/oauth/google/authorize { returnTo, rerequest? }  (policy public) ─────────► api
            (rerequest: Facebook only → auth_type=rerequest; ignored for Google)
api      ── state, nonce, PKCE verifier = randomBytes(32) each; INSERT oauth_states(state_hash, provider,
            intent='signin', nonce, code_verifier_enc = encrypt(verifier, oauth_states.code_verifier:<id>),
            return_to = safeReturnTo(returnTo), expires_at = now+10m)
         ◄── 200 { authorizationUrl, state }
web      ── cookies().set(sgm_oauth = <state>.<ctx>, 600 s); redirect(authorizationUrl) ──► Google consent
Google   ── 302 WEB_BASE_URL/auth/callback/google?code&state  (or ?error=access_denied&state) ──► web route handler
web      ── delete sgm_oauth; parse it; state component === query state? (timingSafeEqual)
            else → /login?error=oauth_state_invalid&provider=google (API not called)
         ── POST /auth/oauth/google/callback { state, code } | { state, error }
            (policy optionalSession; Bearer forwarded if the browser has a session) ──► api
api      ── UPDATE oauth_states SET used_at=$now WHERE state_hash=$1 AND provider=$2 AND used_at IS NULL
            AND expires_at > $now RETURNING …   (0 rows → 400 oauth_state_invalid; replay does nothing)
         ── error=access_denied → 400 oauth_cancelled
         ── provider.exchange(code, verifier, nonce) → ProviderProfile   (timeout → 502 provider_unavailable)
         ── outcome decided by Algorithm Q3/Q4 rules:
              signed_in      → 200 { outcome:'signed_in', user, session, returnTo }
              pending_signup → 200 { outcome:'pending_signup', pendingToken, returnTo }   (INSERT oauth_pending_signups)
              linked         → 200 { outcome:'linked', returnTo:'/account' }
              already_linked → 200 { outcome:'already_linked', returnTo:'/account' }
              rejected       → 4xx { error:{ code, message, email? } }   (oauth_account_exists, oauth_email_missing, …;
                                 email only on oauth_account_exists, read by the web server for sgm_flash)
web      ── signed_in: set session cookie, redirect(returnTo) | pending: set sgm_pending (900 s),
            redirect('/register/complete') | linked/already_linked: redirect('/account?notice=…')
            | error: landing from lib/auth/landing.ts (user-journey F3/F8), e.g. /login?error=<code>&provider=google&returnTo=<ctx.r>)
```
**Completion:**
- `/register/complete` (an RSC) calls `GET /auth/oauth/pending` with header `X-Pending-Signup: <token>` (policy public) and gets `{ provider, email, fullName, expiresAt, returnTo }` to prefill the form (user-journey C-3).
- The "Finish sign-up" Server Action calls `POST /auth/oauth/complete { pendingToken, fullName, sex }`. In one transaction the API runs a guarded `UPDATE oauth_pending_signups SET used_at = $now WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $now RETURNING …`, then `INSERT users`, `INSERT auth_identities`, then issues the session and returns `{ user, session, returnTo }`. Unique constraints arbitrate races (algorithm rows C3/C4).
- A 422 for a missing sex does **not** consume the row (validation runs before the transaction), as AC-ERROR-14 requires.

**Expiry constants**: OAuth state 10 min, pending sign-up 15 min (AC-ERROR-14). Both are constants in `modules/auth/oauth-service.ts`, not env.

**Why the verifier is encrypted**: under P4, credential columns are encrypted. A PKCE verifier is a short-lived credential for the code exchange. The keyring is already in the process (it is added to `main.ts`), and the AAD binds it to its row. Facebook rows have `code_verifier_enc IS NULL`.

### Q8: Fake provider
**Chosen**: **8A.**
- `AUTH_FAKE_OAUTH=true` → `providers/registry.ts` returns `FakeOAuthProvider('GOOGLE')` and `FakeOAuthProvider('FACEBOOK')`, ignoring real credentials, and boot logs `auth.oauth.fake_enabled` at warn.
- The config refuses it in production (AC-VERIFY-7).
- The web has no fake-specific code. Playwright intercepts `https://oauth.fake.invalid/**`.
- The Compose stack enables it through `.env` for `pnpm run test:e2e`. `docs/getting-started.md` documents this.
- Fake `code` grammar: `fake.<base64url(JSON {fixture: 'google-verified'|'google-unverified'|'facebook-with-email'|'facebook-no-email', sub?, email?, name?})>`. It is parsed by a strict zod schema, and anything else is a `rejected` provider error.

### App wiring (`buildApp(deps)` and `main.ts`)

```ts
// apps/api/src/app.ts
export interface AppDeps extends HealthDeps {
  readonly logger: Logger;
  readonly db: Database;                         // Kysely<DB> from lib/db/kysely.ts
  readonly jobs: Pick<JobRunner, 'enqueue'>;     // producer
  readonly clock: Clock;                         // lib/clock.ts
  readonly crypto: FieldCrypto;                  // lib/crypto (PKCE verifier)
  readonly auth: AuthConfig;                     // config.auth
  readonly oauthProviders: OAuthProviderRegistry;// providers/registry.ts, built from config
  readonly passwordHasher: PasswordHasher;       // modules/auth/password.ts
  readonly loginThrottle: LoginThrottle;         // modules/auth/throttle.ts (Algorithm Q7: auth_throttle admit/settle)
  readonly internalAuthSecret: string | null;    // API_INTERNAL_SHARED_SECRET (required in production)
  /** Test seam: extra plugins registered after auth (e.g. guard fixture routes for AC-HAPPY-8/9). */
  readonly extraPlugins?: readonly FastifyPluginAsync[];
}
```
**Order inside `buildApp`**:
1. Fastify plus the tracing hook (existing).
2. Zod compilers.
3. `registerErrorHandling(app)`.
4. `registerOriginCheck(app, auth.webBaseUrl)`.
4a. `registerInternalAuth(app, internalAuthSecret)` (decorates `request.clientAddress`).
5. `registerAuthPlatform(app, deps)` (decorators and the `onRoute` registry).
6. Swagger, with `components.securitySchemes.sessionToken = { type: 'http', scheme: 'bearer' }`.
7. `registerHealthRoute` (now with `config.policy: publicRoute()`).
8. `app.register(authModule, { prefix: '/auth', deps })`.
9. `extraPlugins`.
10. `app.ready()`.

**`main.ts` order**:
1. `loadConfigOrExit()`
2. logger
3. pool → `createKysely(pool)`
4. `createKeyProvider` → `createCrypto` (the keyring is validated at boot, as in the worker)
5. `createJobRunner({ role: 'producer' })` → `await start()`
6. `createPasswordHasher()` (self-test)
7. `buildOAuthProviders(config.auth)`
8. `createLoginThrottle(db, keyring)` (Algorithm Q7; HKDF throttle key from the active encryption key)
9. `buildApp(...)`
10. listen.

Shutdown: `app.close()` → `runner.stop()` → `pool.end()`.

`openapi.ts` builds the app with inert deps (no DB): a Kysely over an unconnected pool, a no-op runner, the fake providers. The routes, not the deps, define the document.

#### Client address trust boundary (enforced invariant)

The client address feeds only the throttle's address dimension (Algorithm Q7). It must not be influenced by the browser. This replaces the earlier "copy the first `x-forwarded-for` value" rule (critique finding 2).

1. **Derivation (web only, `apps/web/src/lib/auth/client-address.ts`)**: `WEB_TRUSTED_PROXY_HOPS = N` is the number of reverse proxies in front of the web that each **append** the peer address to `X-Forwarded-For`. The web splits the incoming `X-Forwarded-For` on commas, trims each entry, and takes the **N-th entry counted from the right** (N = 1 means the last entry, written by the proxy closest to the web). Entries to the left of it were supplied by the client or by untrusted hops and are ignored. If the header has fewer than N entries, if N = 0, or if the chosen entry is not a valid IP (`net.isIP`), the address is `null`. A trusted proxy that **overwrites** `X-Forwarded-For` instead of appending counts as one hop and must be the outermost one; document the platform's behaviour in `docs/getting-started.md`.
2. **Strip**: `proxy.ts` removes any incoming `x-sgm-client-ip` and `x-sgm-internal-auth` request headers, and `apiFetch` builds outgoing headers from an allowlist (it never copies incoming headers), always overwriting `x-sgm-client-ip` with the derived value or omitting it when `null`.
3. **Authenticated hop**: every web→API call carries `x-sgm-internal-auth: <API_INTERNAL_SHARED_SECRET>`. The API's `internal-auth.ts` `onRequest` hook compares it in constant time (`timingSafeEqual` over the SHA-256 digests of the presented and configured values, so lengths never leak). Only on a match does it set `request.clientAddress` from `x-sgm-client-ip` (re-validated with `net.isIP`). Without a match, or with no secret configured, `request.clientAddress = null`, any `x-sgm-client-ip` is ignored and `auth.client_address.untrusted` is logged (rate-limited). There is **no fallback to `request.ip`**: behind the web that is the web container, which would put every player in one bucket.
4. **Scope**: the secret authenticates the hop, not the user. A request without it is still served (bearer sessions remain the authority); it only loses the address dimension. It is not an OpenAPI security scheme.
5. **Boot (P7)**: with `NODE_ENV=production`, the API refuses to start without `API_INTERNAL_SHARED_SECRET` (at least 32 characters), and the web refuses to start without `API_INTERNAL_SHARED_SECRET` or `WEB_TRUSTED_PROXY_HOPS` (integer 0–5; 0 is allowed only when `WEB_BASE_URL`'s host is `localhost` or `127.0.0.1`, as for the Compose E2E stack). Outside production both may be unset; the address dimension is then skipped with `auth.throttle.address_missing`.
6. **Privacy**: the address is redacted from logs, never stored in plaintext (only the HMAC pseudonym in `auth_throttle`), and Fastify `trustProxy` stays off, so request logs keep showing the web hop.
7. **Tests**: `client-address.test.ts` (no XFF, client-supplied leftmost entries, multi-hop XFF with N = 1 and 2, fewer entries than N, invalid IP), `internal-auth.test.ts` (missing secret, forged secret of equal and different length, valid secret), `api-client.test.ts` (incoming internal headers never forwarded), config tests for the production refusals.

### Shared HTTP error shape

```ts
// packages/shared/src/api/errors.ts — the authoritative list (consolidated 2026-10-06; the spec mirrors it)
export const ErrorCode = [
  // generic
  'validation_failed', 'unauthenticated', 'session_expired', 'forbidden', 'cross_origin_request',
  'not_found', 'conflict', 'internal_error', 'service_unavailable',
  // password auth and reset
  'email_taken', 'invalid_credentials', 'too_many_attempts', 'too_many_requests', 'invalid_or_expired_token',
  // OAuth sign-in and sign-up (algorithm Q3/Q4)
  'provider_not_enabled', 'provider_unavailable', 'oauth_state_invalid', 'oauth_cancelled',
  'oauth_email_missing', 'oauth_email_unverified', 'oauth_account_exists', 'signup_expired',
  // identities (algorithm Q3 link and unlink)
  'identity_in_use', 'provider_already_connected', 'link_session_mismatch', 'last_sign_in_method',
] as const;
export const ErrorResponse = z.object({
  error: z.object({
    code: z.enum(ErrorCode),
    message: z.string(),                                    // safe, user-presentable, never echoes input
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
    email: z.string().optional(),                           // only with oauth_account_exists (user-journey C-5);
                                                            // read by the web server, never rendered from a URL
  }),
});
```

| Code | HTTP | Raised by |
|---|---|---|
| `validation_failed` | 422 | any strict body or params schema; password policy; carries `fieldErrors` |
| `unauthenticated` | 401 | protected route without a bearer token |
| `session_expired` | 401 | presented token expired, revoked or unknown; link callback with a dead session (L0) |
| `forbidden` | 403 | global-role or team-role guard |
| `cross_origin_request` | 403 | `origin.ts` |
| `not_found` | 404 | not-found handler |
| `conflict` | 409 | untranslated 23505 |
| `internal_error` | 500 | anything unmapped |
| `service_unavailable` | 503 | throttle store or DB unavailable (algorithm: fail closed) |
| `email_taken` | 409 | register (23505 on `users.email`) |
| `invalid_credentials` | 401 | login |
| `too_many_attempts` | 429 + `Retry-After` | login throttle |
| `too_many_requests` | 429 + `Retry-After` | forgot-password address limit |
| `invalid_or_expired_token` | 400 | reset, reset check |
| `provider_not_enabled` | 404 | authorize, callback, link for a disabled provider |
| `provider_unavailable` | 502 | provider network error, timeout or 5xx |
| `oauth_state_invalid` | 400 | state missing, unknown, expired or used; provider `rejected` or `invalid_response` |
| `oauth_cancelled` | 400 | callback with `error=access_denied` |
| `oauth_email_missing` | 422 | decision row S2 |
| `oauth_email_unverified` | 422 | decision row S3 |
| `oauth_account_exists` | 409 | decision rows S4 and C4 (with `error.email`) |
| `signup_expired` | 400 | decision row C2; pending lookup for a missing, expired or used row |
| `identity_in_use` | 409 | decision row L2 |
| `provider_already_connected` | 409 | decision row L3 |
| `link_session_mismatch` | 403 | decision row L0 (session belongs to another user) |
| `last_sign_in_method` | 409 | unlink; 23514 from `auth_identities_last_method` |

`already_linked` is a 200 callback outcome, not an error.
- **Mapper** (`lib/http/errors.ts`):
  - `AppError` → its status and code.
  - Zod schema validation (`hasZodFastifySchemaValidationErrors`) → **422** `validation_failed` with `fieldErrors`, replacing Fastify's default 400.
  - Unknown key in a strict body → 422.
  - SQLSTATE 23505 not translated by a service → 409 `conflict`.
  - Database unavailable (connection errors, the throttle function failing) → 503 `service_unavailable`.
  - Any other error → 500 `internal_error`, logged with `err`, with no detail in the body.
  - `setNotFoundHandler` → 404 `not_found`.
- `too_many_attempts` and `too_many_requests` set the `Retry-After` header (seconds).
- Field messages for AC-ERROR-2 come from the shared schemas, so web and API show the same text.

### Final environment variables

| Variable | Process | Rule | Default |
|---|---|---|---|
| `WEB_BASE_URL` | api, web | http(s) URL with no path. API: https required when `NODE_ENV=production`. Web: https required in production unless the host is localhost | `http://localhost:3000` (`.env.example`) |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | api | both or neither (a half-configured provider fails boot) | unset → Google disabled |
| `FACEBOOK_OAUTH_APP_ID` / `FACEBOOK_OAUTH_APP_SECRET` | api | both or neither | unset → Facebook disabled |
| `AUTH_FAKE_OAUTH` | api | `true`/`false`; `true` refused when `NODE_ENV=production` | `false` |
| `AUTH_SESSION_IDLE_DAYS` | api | integer 1–30 | `7` |
| `AUTH_SESSION_ABSOLUTE_DAYS` | api | integer 1–90 and ≥ idle | `30` |
| `AUTH_RESET_TOKEN_MINUTES` | api | integer 10–1440 | `60` |
| `API_INTERNAL_URL` | web | existing; now validated by the web config | `http://localhost:4000` |
| `AUTH_LOGIN_MAX_FAILURES_PER_EMAIL` | api | integer 3–20 (Algorithm Q7) | `5` |
| `AUTH_LOGIN_MAX_FAILURES_PER_ADDRESS` | api | integer 5–200 | `20` |
| `AUTH_LOGIN_WINDOW_MINUTES` | api | integer 5–60 | `15` |
| `AUTH_FORGOT_MAX_PER_ADDRESS` | api | integer 3–100, fixed 60-minute window | `10` |
| `API_INTERNAL_SHARED_SECRET` | api, web | at least 32 characters; same value on both; **required when `NODE_ENV=production`**; never logged | unset (address dimension skipped); `.env.example` ships a dev-only placeholder |
| `WEB_TRUSTED_PROXY_HOPS` | web | integer 0–5 ([Client address](#client-address-trust-boundary-enforced-invariant)); **required when `NODE_ENV=production`**, where 0 is allowed only for a localhost `WEB_BASE_URL` | `0` outside production |

Constants, not env: OAuth state TTL 10 min, pending sign-up TTL 15 min, session touch interval 1 h, provider HTTP timeout 5 s, argon2 parameters, Graph API version, the reset email's 60-second per-user resend floor (AC-ERROR-6; a `FOR UPDATE` on the user row plus the latest token's `created_at`, Algorithm step F), the `sgm_oauth` size limit (1024 bytes), the `sgm_flash` lifetime (60 s). The throttle HMAC key is derived by HKDF from the active `ENCRYPTION_KEYS` entry (no new secret). Compose: the `web` service gains `WEB_BASE_URL`, `API_INTERNAL_SHARED_SECRET` and `WEB_TRUSTED_PROXY_HOPS=0`; the `api` service gains `API_INTERNAL_SHARED_SECRET` and the `AUTH_FAKE_OAUTH` passthrough. `.env.example` gains every variable above, and `AUTH_FAKE_OAUTH=true` is documented for E2E.

### Schema shapes (input to Phase 1 migrations)

Final file names (consolidated 2026-10-06; the algorithm doc's "Schema implications" add the invariants marked *Algo*):

1. **`db/migrations/20261006000100000_users_email_and_role_checks.sql`**:
   - `users`: `CONSTRAINT users_email_normalised CHECK (email = lower(email) AND email ~ '^[!-?A-~]+@[!-?A-~]+$' AND char_length(email) <= 254)` (*Algo* S1, stricter than a plain `lower()` check), `CONSTRAINT users_role_not_team_admin CHECK (role <> 'TEAM_ADMIN')`, `ADD COLUMN email_verified_at timestamptz` (*Algo*; informational only in v1, see the algorithm doc's R1), `CONSTRAINT uq_users_id_email UNIQUE (id, email)`.
   - `auth_identities`: `CONSTRAINT uq_auth_identities_user_provider UNIQUE (user_id, provider)`, so there is one identity per method per user (needed by `DELETE /auth/identities/:provider` and AC-HAPPY-11); `CHECK (provider <> 'PASSWORD' OR provider_subject = lower(provider_subject))`; `password_email` generated column with `FOREIGN KEY (user_id, password_email) REFERENCES users (id, email) ON UPDATE CASCADE ON DELETE CASCADE` (*Algo*); deferred constraint trigger `auth_identities_last_method` (*Algo*, raises 23514 when a user's last identity is deleted).
2. **`db/migrations/20261006000200000_auth_sessions.sql`**:
   - Columns: `id uuid PK`, `user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE`, `token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32)`, `created_at timestamptz NOT NULL DEFAULT now()`, `last_seen_at timestamptz NOT NULL`, `expires_at timestamptz NOT NULL`, `absolute_expires_at timestamptz NOT NULL`, `revoked_at timestamptz`, `revoked_reason varchar(32) CHECK (revoked_reason IN ('logout','password_reset','replaced'))`, `user_agent varchar(512)`.
   - CHECKs: `(revoked_at IS NULL) = (revoked_reason IS NULL)`, `last_seen_at >= created_at`, `expires_at <= absolute_expires_at`, `absolute_expires_at > created_at`, `revoked_at IS NULL OR revoked_at >= created_at`.
   - Indexes: `(user_id) WHERE revoked_at IS NULL` and `(expires_at)`.
3. **`db/migrations/20261006000300000_password_reset_tokens.sql`**:
   - Columns: `id uuid PK`, `user_id … ON DELETE CASCADE`, `token_hash bytea NOT NULL UNIQUE CHECK (octet_length = 32)`, `created_at timestamptz NOT NULL DEFAULT now()`, `expires_at timestamptz NOT NULL CHECK (expires_at > created_at)`, `used_at timestamptz CHECK (used_at IS NULL OR used_at >= created_at)`.
   - Index: `(user_id, created_at DESC)` for the 60-second floor.
4. **`db/migrations/20261006000400000_oauth_states_and_pending_signups.sql`**:
   - `oauth_states`: `id`, `state_hash bytea UNIQUE (32)`, `provider auth_provider CHECK (provider <> 'PASSWORD')`, `intent varchar(8) CHECK (intent IN ('signin','link'))`, `link_user_id uuid REFERENCES users ON DELETE CASCADE`, `CHECK ((intent = 'link') = (link_user_id IS NOT NULL))`, `nonce varchar(64)`, `code_verifier_enc text` (with the existing envelope CHECK pattern), `return_to varchar(512) CHECK (return_to IS NULL OR (return_to LIKE '/%' AND return_to NOT LIKE '//%'))`, `created_at`, `expires_at`, `used_at`.
   - `oauth_pending_signups`: `id`, `token_hash bytea UNIQUE (32)`, `provider` (≠ PASSWORD), `provider_subject varchar(255) NOT NULL`, `email varchar(255) NOT NULL` with the same normal-form CHECK as `users.email` (Algorithm Q4 4A: a missing email never reaches a pending sign-up), `email_verified boolean NOT NULL`, `full_name varchar(255)`, `return_to` (same CHECK), `created_at`, `expires_at`, `used_at`.
5. **`db/migrations/20261006000500000_auth_throttle.sql`** (*Algo* Q7): `auth_throttle(scope, key_hash, attempts timestamptz[], updated_at)` with `PRIMARY KEY (scope, key_hash)` and the functions `auth_throttle_admit` and `auth_throttle_settle`; the down migration drops both functions and the table.

Each object gets a `db/schema-deviations.md` entry (D-27 onwards), and enum parity is unchanged (no new enum: `intent`, `revoked_reason` and `scope` are CHECKed varchars to avoid the enum add/remove migration cost for internal state).

### Rationale (summary)
The web is the only public origin, so it should be the only cookie writer. The API is the authority, so it holds sessions, roles and every invariant in Postgres. Pre-built auth frameworks bring their own data model, cookies and HTTP surface. Each of those conflicts with one of the three points above. The pieces we write are small, and each is backed by a constraint or a test. The one native-code risk the plan flagged (the argon2 addon on a slim, classic-builder image) goes away because Node 24 ships argon2.

### Trade-offs Accepted
- **We own security code** (sessions, PKCE, state, ID-token checks), instead of inheriting a framework's. The surfaces are small. `jose` does the cryptographic JWT work. Recorded fixtures and the AC-VERIFY tests pin the behaviour, and the 80% coverage gate covers `modules/auth/**`.
- **`node:crypto.argon2` is recent (v24.7.0).** The boot self-test and known-answer vector catch an unsuitable runtime. `@node-rs/argon2` is a drop-in fallback with the same PHC format.
- **The session token travels in a JSON body on the internal hop.** Acceptable under C5 (private network or HTTPS). Bodies are never logged.
- **The cookie lifetime is the absolute expiry, not the sliding idle expiry.** A browser may keep a cookie that the server already treats as idle-expired. The first request gets `session_expired` and the cookie is cleared. AC-ASYNC-4's wording is amended accordingly.
- **The API trusts `x-sgm-client-ip` only behind the shared secret**, and the web derives it only from a configured number of trusted proxy hops. A misconfigured hop count can put players in the wrong address bucket (too low: a proxy's address; too high: unknown, so the address dimension is skipped); the per-email limit, which protects each account, does not depend on it. One shared secret means rotation is a coordinated redeploy of web and api.
- **`global_role` keeps `TEAM_ADMIN` behind a CHECK** for draft parity, so the generated type is wider than the assignable type. `AssignableGlobalRole` narrows it.
- **The E2E fake bypasses the real adapters' HTTP.** Covered by fixture unit tests and the manual smoke test.

---

## Interfaces handed to Algorithm Design

The architecture fixes these seams. `auth-and-user-roles-algorithm.md` chooses what goes behind them (all three are now settled).

1. **Throttle port (Q7)**, following the algorithm doc's reserve-then-verify design (this supersedes the earlier three-method sketch; see Consolidation):
   ```ts
   interface LoginThrottle {
     /** Before any lookup or hash; reserves a provisional failure on every key, or denies → 429 (AC-ERROR-4). */
     admitLogin(keys: ThrottleKeys, now: Date): Promise<ThrottleVerdict>;
     /** Successful sign-in: delete the email row, refund this attempt's address entry. */
     settleLogin(keys: ThrottleKeys, now: Date): Promise<void>;
     /** Forgot-password address limit (10 per 60 min) → 429 too_many_requests. */
     admitForgot(clientAddress: string | null, now: Date): Promise<ThrottleVerdict>;
     /** Completed reset: delete the email row inside the reset transaction. */
     clearEmail(email: string, trx: Transaction<DB>): Promise<void>;
   }
   interface ThrottleKeys { email: string /* normalised */; clientAddress: string | null /* request.clientAddress */ }
   type ThrottleVerdict = { admitted: true } | { admitted: false; retryAfterSeconds: number };
   ```
   Backed by the `auth_throttle` table and its two plpgsql functions (migration 5). Keys are HMAC pseudonyms; no plaintext address or email is stored.
2. **OAuth outcome (Q3/Q4)**: `oauth-service` calls the pure `oauth-decision.ts` and returns `signed_in | pending_signup | linked | already_linked | rejected(code)`. The codes are in the authoritative `ErrorCode` list above.
3. **Email verification**: not in v1 as a flow. `users.email_verified_at` exists and is set by Google sign-up/link and by every completed reset, but no v1 rule reads it (algorithm R1 as amended by user decision D1).

---

## Implementation Guidelines

1. **Phase 1 order**: migrations and deviations → `db:codegen` → shared `api/errors.ts`, `api/auth.ts`, `auth/return-to.ts` → `lib/http/errors.ts`, `lib/http/origin.ts`, `lib/clock.ts` → config additions (API and web) → `AppDeps` and `main.ts` wiring with a stub auth module that registers no routes. The `onRoute` registry lands in Phase 2, but `health.ts` gets its `policy` in Phase 1 so the registry can be strict from its first commit.
2. **Time from the clock**: every expiry comparison and timestamp written by auth code takes `clock.now()` as a parameter (`expires_at > ${now}`), never SQL `now()`, so AC-ASYNC-4 can advance time. Column defaults (`created_at DEFAULT now()`) are fine.
3. **Tokens**: `tokens.ts` exports `newToken(): { raw: string; hash: Buffer }` and `hashToken(raw): Buffer`. Raw tokens exist only in responses and emails. Never put them in a log field, an error message or a span attribute.
4. **Transactions**: the register, OAuth complete, link (insert identity + security email), reset (consume token + upsert PASSWORD + delete every GOOGLE/FACEBOOK identity + revoke sessions + invalidate other tokens + set `email_verified_at` + clear the email throttle row) and forgot (insert token + `enqueueEmail(runner, msg, { trx })`) flows each run in one `db.transaction()`. Services translate 23505 on `users_email_key` to `email_taken` (register) or `oauth_account_exists` (OAuth complete), and on `uq_auth_identities_*` per the algorithm decision table.
5. **Route modules**: `modules/auth/routes.ts` registers every route with an explicit `config.policy` and strict shared schemas. Handlers stay thin and the services hold the rules (module convention).
6. **Web API client**: extend `api-client.ts` with one internal `apiFetch({ path, method, body, schema, session, incoming })`. It builds headers from an allowlist and always sends `traceHeaders(incoming)`, `user-agent` from the incoming request, `x-sgm-internal-auth` when the secret is configured, and `x-sgm-client-ip` only when `client-address.ts` derived one; `Authorization` when a session is given. It never copies incoming headers wholesale. It returns a discriminated result `{ ok: true, data } | { ok: false, status, error: ErrorResponse['error'] }`. It never throws on 4xx and has a 5 s timeout. Auth methods are thin wrappers over it.
7. **`returnTo`**: `safeReturnTo` accepts only strings that start with exactly one `/`, contain no `\`, no control characters and no `//` prefix after decoding, and resolve to the same origin as a dummy base. Auth-page paths (`/login`, `/register`, `/register/complete`, `/forgot-password`, `/reset-password`, anything under `/auth/`) also become `/` (user-journey X13). Everything else becomes `/`. The web applies it before every redirect, and the API applies it before storing.
8. **`/reset-password`**: `proxy.ts` sets `Referrer-Policy: no-referrer` (and `Cache-Control: no-store`) on that path. The Server Action reads the token from a hidden form field, not from a re-read URL.
9. **CLI `users set-role`**: uses the same Kysely repo. It validates the role with `AssignableGlobalRole` (`TEAM_ADMIN` rejected before the DB, and the CHECK as backstop), looks up the email normalised, prints `id` and the new role, and exits 1 on an unknown email.
10. **`auth-cleanup`**: a new queue (`exclusive`) and schedule slot `0 5 * * *` in Pacific/Auckland (passes `assertNoDstHourFirings`). It deletes stale rows from `auth_sessions`, `password_reset_tokens`, `oauth_states`, `oauth_pending_signups` and `auth_throttle` with one `DELETE … WHERE` per table, in batches of 5000 until 0 rows (algorithm step I), using `clock.now()`. It logs counts only.
11. **ADR 0013** records Q1, Q2, Q5, Q6 and Q8 with their alternatives (the phase review of platform-foundation flagged ADRs without alternatives).

---

## Validation Checklist

- [x] **Meets all system requirements**: every AC maps to a component:
  - registration, login and sessions → `modules/auth` + `auth_sessions`
  - guards → `lib/auth`
  - reset → tokens + `enqueueEmail` in a transaction
  - OAuth → 6A + O3
  - E2E → 8A
  - Q3, Q4 and Q7 go behind the named interfaces.
- [x] **Respects technical constraints**: web-only public origin (2B, web-owned callback), no Redis, no native addon in a slim classic-builder image (H1), Next 16 `proxy.ts` on the Node runtime.
- [x] **Addresses non-functional requirements**: security controls are listed per AC. No IP is stored or logged. Sign-in latency is dominated by the intentional ~100–300 ms hash.
- [x] **Technically feasible**: `crypto.argon2` and the timings were checked on Node 24.19.0. The arctic limitations were checked in the 3.7.0 package source. Next 16 `proxy.ts` and the Server Action origin check were confirmed from the Next 16 release material. The exact `serverActions.allowedOrigins` key and the `@fastify/swagger` and `onRoute` mutation order are flagged for checking at build.
- [x] **Risks identified and acceptable** (below).
- [x] **Complies with Guiding Principles** (no deviations):
  - P1: CHECKs and UNIQUEs for email case, global role, one identity per provider, single-use tokens and state.
  - P2: not applicable.
  - P3: all new timestamps are `timestamptz`, and the cleanup cron is Pacific/Auckland outside 02:00–02:59.
  - P4: the PKCE verifier is encrypted with the keyring, nothing is plaintext in logs, and tokens are stored hashed.
  - P5: the reset email is enqueued in the token transaction, and cleanup runs through the queue.
  - P6: no new root scripts (`test:e2e` already exists).
  - P7: every new variable is zod-validated in the API and (new) in the web, the hasher self-test fails at boot, and the fake provider is refused in production.
- [x] **Respects established patterns**: module convention, adapter behind an interface (providers, hasher, throttle), branded or shared types, the `enqueueEmail` contract and the per-file test databases.
- [x] **Observability architecture defined**: events, spans and reserved metric names.
- [x] **Trace context propagation across all service boundaries**: web → api, api → job `_meta`, cron root span. Third-party OAuth calls get client spans without propagation (justified above).
- [x] **Logging strategy consistent with observability-requirements.md**: camelCase fields, redaction extended, no PII beyond `userId`.
- [x] **Metrics strategy follows naming conventions**: `sgm_` prefix, `_total` and `_seconds` suffixes, no ID labels.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| A runtime without `crypto.argon2` (Node < 24.7, or Node linked to an older shared OpenSSL) | L | H | Engines `>=24.7`. A boot self-test with a known-answer vector refuses to start. `@node-rs/argon2` fallback behind `PasswordHasher` with the same PHC strings. |
| argon2 memory pressure under burst sign-ins (64 MiB each) | M | M | Per-process semaphore of 2 (≤128 MiB). The throttle bounds abuse. Parameters can be raised or lowered later through `needsRehash`. |
| Next 16 Server Action origin check misfires behind the platform proxy (false 403s or a weakened check) | M | M | `serverActions.allowedOrigins` from `WEB_BASE_URL`, plus `proxy.ts`'s own Origin check. AC-ERROR-15 and AC-INTEGRATION-4 run through the real stack. |
| Facebook Graph version pinned in code expires (about 2-year lifetime) | M | M | A single constant, an ADR note, and a getting-started checklist item. Meta auto-upgrades calls to expired versions to the oldest live one, so the failure mode is degraded, not broken. |
| API accidentally exposed publicly (direct callers could try to supply a client address) | L | M | C6 forbids it, and the deployment feature verifies it. Built now: `x-sgm-client-ip` is ignored unless `x-sgm-internal-auth` matches `API_INTERNAL_SHARED_SECRET` (constant time), and production refuses to boot without the secret. |
| Spoofed or mis-derived client address skews the address throttle (critique finding 2) | M | M | The web takes the N-th `X-Forwarded-For` entry from the right (`WEB_TRUSTED_PROXY_HOPS`), strips incoming internal headers, and never falls back to the leftmost entry or to `request.ip`; production refuses to boot without the hop count; unit tests for client-supplied and multi-hop XFF. |
| Login CSRF through OAuth (an attacker's callback URL) | L | H | Browser-binding `sgm_oauth` cookie compared before the state is consumed. State is single-use and expires in 10 min. |
| Missing policy on a future route | M | H | Boot-time refusal in the `onRoute` registry, and route enumeration in the unit test. |
| `onRoute` schema mutation not visible to `@fastify/swagger` (hook order) | M | L | Register the registry before swagger. `openapi.test.ts` drift check. Fallback: declare `security` explicitly per route. |
| Cookie and server expiry disagree (absolute cookie, idle server) | H | L | By design. The first request gets `session_expired`, then the session-expired route clears the cookie with a clear message. |
| Stacked branch: platform files change when foundation merges | M | M | Touch only the listed extension points (`app.ts`, `main.ts`, `config.ts`, `logger.ts`, `jobs/*`, `cli.ts`, `api-client.ts`, `layout.tsx`). Rebase after the merge. |

---

## AC impact

ACs to amend, with proposed wording. Everything not listed stands as written.

1. **AC-VERIFY-2** (cookie owner moves to the web): "…each token is at least 256 bits from `crypto.randomBytes`; only its SHA-256 appears in the database (no plaintext column); the API returns the session token only in the JSON body to the web server and never sets cookies; the **web** sets the cookie `HttpOnly`, `SameSite=Lax`, `Path=/`, and, whenever `WEB_BASE_URL` is https (required in production except for a localhost base URL), `Secure` with the `__Host-` prefixed name, so it is never readable by JavaScript; the `/reset-password` page responds with `Referrer-Policy: no-referrer`."
2. **AC-ASYNC-4**: "…use within the idle window extends `expires_at` (at most once per hour of activity, never past the absolute cap), a request after 7 idle days or after 30 absolute days returns 401 `session_expired`, and the session cookie's `Expires` equals the session's absolute expiry."
3. **AC-ERROR-11**: "…the API returns 401 `unauthenticated` (no session token), 401 `session_expired` (a presented token that is expired, revoked or unknown) or 403 `forbidden`…"
4. **AC-VERIFY-3**: "…each declares one policy (`public`, `optionalSession`, `authenticated`, `globalRole`, `teamRole`)…; `/health` and the public auth endpoints are declared `public`, and `POST /auth/logout` and `POST /auth/oauth/:provider/callback` are `optionalSession`…"
5. **AC-VERIFY-8**: "…documents the bearer session-token security scheme `sessionToken` (the browser cookie is owned by the web and is not part of the API contract), the `ErrorCode` enum equals the authoritative list, and the 401/403/409/422/429 responses."
6. **AC-ERROR-15**: "…the request is rejected with 403 (`cross_origin_request` from the API) and has no effect (cookies are `SameSite=Lax`, Server Actions and `proxy.ts` check `Origin`, and the API refuses a foreign `Origin` on mutating requests)."
7. **AC-INTEGRATION-3**: "…and the Google adapter rejects an ID token with a bad signature (verified with `jose` against Google's JWKS), wrong audience, wrong issuer, wrong nonce or past expiry; the Facebook adapter sends `appsecret_proof`…"
8. **AC-VERIFY-7**: add `AUTH_FAKE_OAUTH`, the four throttle variables, `API_INTERNAL_SHARED_SECRET` and `WEB_TRUSTED_PROXY_HOPS` to the variable list. Add: "`NODE_ENV=production` with a non-https `WEB_BASE_URL`, or without `API_INTERNAL_SHARED_SECRET` (api and web) or `WEB_TRUSTED_PROXY_HOPS` (web), is refused; the web app validates `API_INTERNAL_URL` and `WEB_BASE_URL` at boot the same way."
8a. **AC-ERROR-4** and new **AC-VERIFY-14** (consolidation, critique finding 2): the address dimension uses only the client address derived and authenticated as in [Client address](#client-address-trust-boundary-enforced-invariant); tests cover client-supplied and multi-hop `X-Forwarded-For` and a missing or forged secret.
8b. New **AC-VERIFY-15** (consolidation, critique finding 3): the `sgm_oauth` binding cookie behaves as in [the one schema](#browser-binding-cookie-sgm_oauth-the-one-schema).
9. **AC-HAPPY-7**: "`POST /auth/logout` returns 204 (also for an already dead session), the `auth_sessions` row is marked revoked, the web deletes the cookie…"
10. **AC-VERIFY-5**: add "`UNIQUE(user_id, provider)` on `auth_identities`" to the list of new constraints. A second GOOGLE identity for one user fails with 23505.
11. **AC-ERROR-2 / Implementation Plan**: the shared error shape's field map is `fieldErrors` everywhere (the plan's Component Analysis has been aligned).
12. **Invocation Method**:
    - Add `GET /auth/oauth/pending` (pending sign-up prefill, token in `X-Pending-Signup`).
    - `POST /auth/oauth/:provider/callback` accepts `{ state, code }` or `{ state, error }`.
    - `POST /auth/oauth/:provider/authorize` returns `{ authorizationUrl, state }`.
    - Add the web route `/auth/session-expired`.
13. **Engines** (not an AC; a Technical constraint note): Node `>=24.7 <25`.

## New Source Files changes

Legend: **+** add, **R** rename/move, **=** confirmed, **−** removed.

- = all four planned migrations, with the shapes in [Schema shapes](#schema-shapes-input-to-phase-1-migrations); **+** `db/migrations/20261006000500000_auth_throttle.sql` (Algorithm Q7). Migration 1 also carries the `auth_identities` constraints and the last-method trigger.
- = `packages/shared/src/api/auth.ts`, `packages/shared/src/api/errors.ts`
- **+** `packages/shared/src/auth/email.ts` (`normaliseEmail`, Algorithm S1) and **+** `packages/shared/src/auth/oauth-binding.ts` (the `sgm_oauth` codec; moved here from the user-journey doc's `apps/web/src/lib/auth/oauth-binding.ts` so the API can test interop), each with a test.
- **R** `apps/web/src/lib/auth/return-to.ts` → **`packages/shared/src/auth/return-to.ts`** (+ `return-to.test.ts`), because the API validates `returnTo` too. Test pin `apps/web/src/lib/auth/return-to.test.ts` → `packages/shared/src/auth/return-to.test.ts`.
- = `apps/api/src/lib/http/errors.ts`; **+** `apps/api/src/lib/http/origin.ts`; **+** `apps/api/src/lib/http/internal-auth.ts` (+ test)
- **+** `apps/web/src/lib/auth/client-address.ts` (+ test)
- **+** `apps/api/src/modules/auth/oauth-decision.ts`, `password-policy.ts`, `common-passwords.txt` (Algorithm Q3, S2)
- **+** `apps/api/src/lib/clock.ts`
- = `apps/api/src/lib/auth/{policy.ts,guards.ts,request-auth.ts}`
- = `apps/api/src/modules/auth/{routes.ts,repo.ts,password.ts,tokens.ts,sessions.ts,throttle.ts,emails.ts}`
- **R** `apps/api/src/modules/auth/service.ts` is split into **`service.ts`** (register, login, logout, me, identities), **+ `reset-service.ts`** (forgot and reset) and **+ `oauth-service.ts`** (authorize, callback, pending, complete, link). Each stays under about 300 lines.
- = `apps/api/src/modules/auth/providers/{provider.ts,google.ts,facebook.ts,fake.ts}`, `providers/fixtures/*.json`; **+** `providers/registry.ts` (enabled providers from config; fake mode); **+** `providers/pkce.ts` (verifier, S256 challenge, nonce)
- = `apps/api/src/jobs/auth-cleanup.ts`
- **+** `apps/web/src/lib/config.ts` (zod web env, loaded by `instrumentation.ts`)
- **+** `apps/web/src/lib/auth/cookies.ts` (names, options, set and clear helpers)
- **+** `apps/web/src/lib/auth/messages.ts` (notice and error code → text)
- = `apps/web/src/lib/auth/{session.ts,actions.ts}`
- **+** `apps/web/src/app/auth/session-expired/route.ts`
- = `apps/web/src/app/auth/callback/[provider]/route.ts`, `apps/web/src/proxy.ts`, all planned pages and `site-header.tsx`
- **Extend (additions to the plan's list)**:
  - `apps/api/src/routes/health.ts` (policy)
  - `apps/api/src/openapi.ts` (inert deps, security scheme)
  - `apps/api/src/lib/crypto` usage in `main.ts`
  - `apps/web/src/instrumentation.ts` (load web config)
  - `apps/web/next.config.ts` (`serverActions.allowedOrigins`)
  - `docker-compose.yml` (web: `WEB_BASE_URL`, `API_INTERNAL_SHARED_SECRET`, `WEB_TRUSTED_PROXY_HOPS`; api: `API_INTERNAL_SHARED_SECRET`, `AUTH_FAKE_OAUTH` passthrough)
  - root `package.json` engines `>=24.7 <25`
  - `apps/api/test/helpers/factories.ts` (users, sessions, memberships)
- **Dependencies**: add `jose` (api). Do **not** add `arctic`, `argon2`, `@node-rs/argon2` (fallback only, not installed unless needed), `@fastify/cookie` or `@fastify/rate-limit`. The Q7 mechanism (Postgres `auth_throttle`) is decided in the algorithm doc.
- **ADR (Phase 6)**: `docs/adr/0013-authentication-sessions-and-route-authorization.md`, titled **"ADR 0013: Authentication, sessions and route authorization"**. It covers Q1 (composition, `node:crypto` argon2id, thin adapters + jose), Q2 (web-owned cookie, bearer to the API, opaque DB sessions, authenticated internal hop), Q5 (`onRoute` default-deny policy registry), Q6 (web-owned callback, Postgres state with a browser-binding cookie) and Q8 (env-selected fake provider), with the alternatives for each. Algorithm Q3, Q4 and Q7 get `docs/adr/0014-account-linking-and-login-throttling.md`.

## Next Steps

1. Done: Algorithm Design settled Q3, Q4 and Q7 behind the interfaces above, and the consolidation of 2026-10-06 reconciled all three creative docs with the spec.
2. Done: the planner applied the AC amendments and file changes to `memory-bank/tasks/auth-and-user-roles.md`.
3. Phase 1: migrations and deviations (D-27+), codegen, shared contracts, the HTTP error and origin layer, clock, config (API and web, incl. the production trust settings), `AppDeps` and `main.ts` wiring, the engines bump, and `health.ts` policy.
4. Phase 2: hasher (with self-test and known-answer vector), tokens, sessions, the policy registry and guards, password routes, CLI `set-role`, then `docker compose build api` to confirm the image still builds without native addons.
5. Phases 3 to 6 as planned. Phase 6 writes ADR 0013 and the `systemPatterns.md` auth pattern (policy registry, bearer relay, internal-hop secret, the `modules/auth` reference shape).

## Consolidation (2026-10-06)

Reconciled with the algorithm and user-journey docs, the spec, the codex design critique and the user's decisions D1 and D2. The **Chosen** decisions (1A + H1 + O3, 2B, 5A, 6A, 8A) are unchanged.

- **Client address (critique finding 2, D2)**: replaced "copy the first `x-forwarded-for` value" with an enforced invariant: `WEB_TRUSTED_PROXY_HOPS` read from the right, incoming internal headers stripped, `x-sgm-internal-auth` checked in constant time against `API_INTERNAL_SHARED_SECRET`, no fallback to `request.ip`, production boot refusal. The shared-secret hardening that was deferred in the risk table is now built. New components `lib/http/internal-auth.ts` and `apps/web/src/lib/auth/client-address.ts`.
- **Binding cookie (critique finding 3, D2)**: added the single `sgm_oauth` schema (`<state>.<ctx>`, ≤ 1024 bytes, state-only constant-time compare, `ctx` an untrusted hint, tamper/expiry/replay rules, interop tests). The codec lives in `packages/shared/src/auth/oauth-binding.ts`. Added the `sgm_flash` cookie from the journey doc.
- **Error contract (critique finding 4, D2)**: one authoritative `ErrorCode` list with a status table. Removed `pending_signup_expired` (now `signup_expired`); dropped the placeholders `oauth_email_conflict` and `identity_already_linked` (now `oauth_account_exists`, `identity_in_use`); added `oauth_email_missing`, `oauth_email_unverified`, `provider_already_connected`, `link_session_mismatch`, `too_many_requests`, `service_unavailable`; `ErrorResponse` gains the optional `email` for `oauth_account_exists` (C-5). `fieldErrors` is the only field-map name. OpenAPI documents only the bearer `sessionToken` scheme.
- **Reset eviction (D1)**: the reset transaction (implementation guideline 4) now always deletes every GOOGLE and FACEBOOK identity; `email_verified_at` is informational.
- **Naming settled**: `used_at` on all single-use tables (was `consumed_at` for pending sign-ups); intent values `signin`/`link`; outcomes `signed_in`/`pending_signup`/`linked`/`already_linked`; `link_user_id`; `user_agent varchar(512)`; `revoked_reason` kept with the new value `replaced`; `full_name` on pending sign-ups; login-failure log reasons follow the algorithm doc (`invalid_credentials|throttled_email|throttled_address`).
- **Schema**: migration file names pinned (`20261006000100000`–`20261006000500000`); `oauth_pending_signups.email` is `NOT NULL`; the algorithm's email CHECK, `email_verified_at`, composite FK, last-method trigger and `auth_throttle` migration folded in.
- **Contracts**: `authorize` accepts `rerequest` (C-1); the throttle port is the algorithm's admit/settle shape (replacing `check/recordFailure/recordSuccess`); pending and complete return `returnTo` (C-3); `already_linked` outcome; `/auth/session-expired` deletes the cookie only on a confirmed 401 (X14); `safeReturnTo` excludes auth pages (X13); new env vars for throttling and the trust boundary; cleanup runs in batches.
