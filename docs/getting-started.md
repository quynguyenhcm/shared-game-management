# Getting started

Everything a developer needs to run, test and extend the platform foundation. Always run root targets as
`pnpm run <target>` (never bare `pnpm <target>`, which can collide with built-in pnpm commands).

## Prerequisites

- Docker with Compose v2+ (Docker Desktop, or Colima on macOS: `colima start`).
- Node 24.7 or newer (`.nvmrc`; `engines` is `>=24.7 <25`). Password hashing uses argon2id from `node:crypto`, which first shipped in 24.7.
- Corepack, which ships with Node. It provides pnpm 10 at the version pinned in `packageManager`; no global pnpm install is needed.

## First run

```sh
pnpm run setup                 # corepack enable, pnpm install --frozen-lockfile, create .env
docker compose up -d --wait    # postgres 17, mailpit, api, worker, web; returns when all are healthy
pnpm run ci                    # lint, typecheck, unit + integration with the coverage gate, build
```

`pnpm run setup` copies `.env.example` to `.env` and replaces the `ENCRYPTION_KEYS` placeholder with a random dev key
(id `dev1`). It never overwrites an existing `.env`. `.env` is git-ignored: no secret is committed.

Once the stack is up:

| What          | Where                          |
| ------------- | ------------------------------ |
| Web           | http://localhost:3000          |
| API health    | http://localhost:4000/health   |
| Mailpit inbox | http://localhost:8025          |
| PostgreSQL 17 | `localhost:5432` (`sgm`/`sgm`) |

Integration tests need the compose `postgres` service (they create isolated databases on it). For hot-reload
development use `pnpm run dev` (starts `postgres` and `mailpit`, migrates, then runs web, api and worker in watch
mode; the worker registers the cron slots and works queued jobs). Do not run it alongside the compose `api`/`worker`/`web`
services: both bind the same ports and would share the job queues.

## Root targets

| Target                                    | What it does                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| `setup`                                   | One-time bootstrap (see above)                                                    |
| `dev`                                     | Postgres + Mailpit, migrate, run web, api and worker in watch mode                |
| `lint`                                    | ESLint (0 warnings allowed) and Prettier check                                    |
| `typecheck`                               | `tsc --noEmit` in every package (`strict: true`)                                  |
| `test`                                    | Unit project (fast loop, no database)                                             |
| `test:integration`                        | Integration project against real PostgreSQL 17                                    |
| `test:coverage`                           | Unit and integration projects with the 80% coverage gate (includes the auth code) |
| `build`                                   | Build every workspace                                                             |
| `ci`                                      | `lint`, `typecheck`, `test:coverage`, `build`; the same gates as CI               |
| `db:migrate` / `db:rollback` / `db:reset` | Apply, revert one, or drop and re-apply migrations (also installs pg-boss)        |
| `db:new`                                  | Create a new SQL migration file                                                   |
| `db:codegen`                              | Regenerate `apps/api/src/lib/db/types.generated.ts` from the migrated database    |
| `openapi`                                 | Regenerate `apps/api/openapi.yaml` from the routes                                |
| `jobs:trigger`                            | Enqueue a job by queue name for manual testing                                    |
| `test:e2e`                                | Playwright journeys on desktop and a 360 px phone (not part of `ci`, see below)   |
| `lint:actions`                            | actionlint on `.github/workflows` (via Docker)                                    |

## Add a migration

1. `pnpm run db:new <name>` creates `db/migrations/<utc-timestamp>_<name>.sql`.
2. Write both sections by hand: `-- Up Migration` and `-- Down Migration`. Every migration must be reversible.
3. Every difference from the reference draft `database-design.md` gets a row in `db/schema-deviations.md` (ID, objects,
   change, source requirement). `schema.int.test.ts` fails if a difference has no row or a row has no source.
4. `pnpm run db:migrate`, then `pnpm run db:codegen`, and commit the regenerated `types.generated.ts`.
   `db-codegen.int.test.ts` fails on any drift.
5. If you added or changed an enum, update `packages/shared/src/types/enums.ts` too. Parity is enforced at compile time and by
   `enum-parity.int.test.ts`.

The pg-boss schema is owned by pg-boss, not by these migrations. App processes never run DDL at boot.

## Register a job or a schedule

1. Add the queue name to `QUEUE_NAMES` and a definition to `QUEUES` in `apps/api/src/jobs/registry.ts`. Use the `exclusive`
   policy if you rely on a `singletonKey`.
2. Write the handler in `apps/api/src/jobs/` and wire it in `apps/api/src/jobs/bootstrap.ts`.
3. For a cron, add a slot to `SCHEDULES` in `apps/api/src/jobs/schedules.ts` (evaluated in Pacific/Auckland).
4. **Handlers must be idempotent.** Delivery is at-least-once; `singletonKey` only removes concurrent duplicates. Back every
   handler with a unique constraint or a guarded status transition (`UPDATE ... WHERE status = ... RETURNING`).
5. **The 02:00 to 02:59 rule.** No calendar-anchored schedule may fire in that local hour: it is skipped when DST starts and
   repeated when DST ends. `assertNoDstHourFirings` rejects such a slot at startup and in unit tests. The only exemption is
   `intervalSweep: true`, for an idempotent sweep that runs every few minutes (for example `post-game-billing`, every 5 minutes).

Failed jobs retry 3 times with exponential backoff and then stay visible in `pgboss.job` with state `failed`.

**Skill progression.** The `skill-progression` queue runs daily at 05:30 Pacific/Auckland. It moves an approved member up one
level after 40 qualifying games since their last level change (see ADR 0017). To run it on demand, with a worker running:
`pnpm run jobs:trigger skill-progression`. The run is idempotent, logs `skill.progression.completed` with its counts, and ends
`failed` if any member could not be processed (`skill.progression.member_failed` names them by id), so it retries safely.

**Ban reconciliation.** The `registration-ban-reconcile` queue runs daily at 05:45 Pacific/Auckland (the last daily slot), once at
every worker boot, and on demand with `pnpm run jobs:trigger registration-ban-reconcile`. It finds banned members who still hold
an active registration in a future published session of their team and re-enqueues one `member-banned` job each (a job already
queued or active is not duplicated); the real ban handler then withdraws them and promotes the waitlist. It logs
`registration.ban_reconcile.completed` with counts only. A `member-banned` job that ends `failed` logs
`team.member.banned.hook_failed` at level error and is retried by the next sweep. The worker database pool is 5 connections,
because the ban handler can hold one through a lock wait.

**Data retention note.** pg-boss job payloads (`pgboss.job.data`) may carry personal information such as email addresses
(the `send-email` queue does). Completed and failed jobs are retained for 7 days. Keep payloads minimal: prefer IDs over
values, and do not put secrets, bank details or tokens in a job payload.

## Sessions and recurring series

Team admins create one-off sessions and recurring series (see ADR 0019). A series is materialised
into sessions inside a rolling horizon, and the horizon is set by one environment variable, read by both the api and the
worker:

| Variable                  | Default | Allowed | Used by        | Meaning                                                          |
| ------------------------- | ------- | ------- | -------------- | ---------------------------------------------------------------- |
| `RECURRENCE_HORIZON_DAYS` | `28`    | 7 to 91 | api and worker | Series sessions exist from today to today plus N days (NZ time). |

- **The worker does the work.** The `recurrence-materialisation` sweep runs at 03:00 Pacific/Auckland and once at every
  worker boot. It fans out one `recurrence-rule` job per active series and one `session-auto-enrol` job per pending
  session. Without a running worker, no series sessions are created and no auto-enrol runs.
- **Manual runs.** `pnpm run jobs:trigger recurrence-materialisation` runs the sweep. `pnpm run jobs:trigger recurrence-rule '<json>'`
  re-runs one series, with `{ "ruleId", "teamId", "trigger" }` as its payload. `pnpm run jobs:trigger session-auto-enrol '<json>'`
  re-offers auto-enrol for one session, with `{ "sessionId", "teamId", "trigger" }`.
- **Banking emails go to Mailpit.** A series whose sessions cannot be published because the team has no payout details
  sends at most one email per admin per series per NZ week. In development it lands in the Mailpit inbox at http://localhost:8025.
- **After pulling the amended migration, reset the dev database.** The session migration `20261020000100000_session_scheduling.sql`
  was amended in place before it merged. A database that applied the earlier draft must run `pnpm run db:reset` once.
- **End-to-end coverage.** `apps/web/e2e/sessions.spec.ts` (AC-VERIFY-8) scans the session pages with axe at desktop and
  360 x 740 widths. It lives in `apps/web/e2e/sessions.spec.ts` and runs with `pnpm run test:e2e`.

## Add a notification adapter

1. Implement `Notifier` (`send(message): Promise<SendResult>`) in `apps/api/src/lib/notifications/adapters/<name>.ts`.
   Throw `TransientDeliveryError` (retryable), `PermanentDeliveryError` or `NotifierConfigurationError`; never report a failed
   delivery as success. Send `idempotencyKey` as the `X-Idempotency-Key` header or the provider's native key.
2. Add the name to the `NOTIFIER_ADAPTER` values in `apps/api/src/lib/config/config.ts` and a `case` in `createNotifier`
   (`notifier.ts`), the only place that knows adapter names.
3. Reuse the contract tests in `notifications.test.ts`. Business code depends on the `Notifier` interface only; send email
   from workflows through the `send-email` job.

## Encrypt a new sensitive column

1. Make the column `TEXT` and add the envelope format CHECK, copying the `teams_*_envelope` pattern from the teams migration,
   so a plaintext write fails with `23514`.
2. In `apps/api/.kysely-codegenrc.json` add a column override to `Ciphertext | null` (or `Ciphertext`), then `pnpm run db:codegen`.
3. Encrypt and decrypt through `createCrypto(...)` with an `EncryptionContext` of `{ table, column, rowId }`. The context is
   the AAD: a ciphertext copied to another row or column fails authentication. Never encrypt money or values you must sort or search.
4. If the UI needs a hint, store a non-reversible projection next to it (see `bank_account_last4`).
5. Add the column to `crypto-columns.int.test.ts` (raw-bytes plaintext check, AAD binding, CHECK rejection).
6. Key rotation: add the new key to `ENCRYPTION_KEYS`, flip `ENCRYPTION_ACTIVE_KEY_ID`, re-encrypt rows where
   `split_part(col, '.', 2) <> active` (`needsRotation` / `reencrypt`), then remove the old key. Errors and logs never contain key
   material or plaintext.

## Authentication configuration

Both apps validate these variables at boot and exit 1 with `Invalid configuration: <VAR> — <reason>` before binding a
port. The message names the variable and never its value. `.env.example` lists every one with its default.

| Variable                                               | Process  | Rule                                                                                                                                               | Default                                    |
| ------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `WEB_BASE_URL`                                         | api, web | http(s) URL with no path. https is required when `NODE_ENV=production` (the web alone allows a `localhost` / `127.0.0.1` host, as in Compose).     | `http://localhost:3000` (required in prod) |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | api      | Set both or neither. A half-configured provider fails boot; neither disables Google.                                                               | unset (Google disabled)                    |
| `FACEBOOK_OAUTH_APP_ID`, `FACEBOOK_OAUTH_APP_SECRET`   | api      | Set both or neither, as above.                                                                                                                     | unset (Facebook disabled)                  |
| `AUTH_FAKE_OAUTH`                                      | api      | `true` or `false`. `true` swaps in fake providers for E2E and is refused in production.                                                            | `false`                                    |
| `AUTH_SESSION_IDLE_DAYS`                               | api      | Integer 1 to 30.                                                                                                                                   | `7`                                        |
| `AUTH_SESSION_ABSOLUTE_DAYS`                           | api      | Integer 1 to 90, at least the idle days.                                                                                                           | `30`                                       |
| `AUTH_RESET_TOKEN_MINUTES`                             | api      | Integer 10 to 1440.                                                                                                                                | `60`                                       |
| `AUTH_LOGIN_MAX_FAILURES_PER_EMAIL`                    | api      | Integer 3 to 20 failed sign-ins per email within the window.                                                                                       | `5`                                        |
| `AUTH_LOGIN_MAX_FAILURES_PER_ADDRESS`                  | api      | Integer 5 to 200 failed sign-ins per client address (all emails) within the window.                                                                | `20`                                       |
| `AUTH_LOGIN_WINDOW_MINUTES`                            | api      | Integer 5 to 60.                                                                                                                                   | `15`                                       |
| `AUTH_FORGOT_MAX_PER_ADDRESS`                          | api      | Integer 3 to 100 forgot-password requests per client address per 60 minutes.                                                                       | `10`                                       |
| `AUTH_REGISTER_MAX_PER_ADDRESS`                        | api      | Integer 3 to 200 registration attempts per client address per 60 minutes (venue Wi-Fi shares one address, so keep it generous).                    | `20`                                       |
| `API_INTERNAL_SHARED_SECRET`                           | api, web | At least 32 characters, same value on both; authenticates the web-to-API hop. **Required in production.** Never logged.                            | unset (client-address throttle skipped)    |
| `WEB_TRUSTED_PROXY_HOPS`                               | web      | Integer 0 to 5: reverse proxies in front of the web that append to `X-Forwarded-For`. **Required in production**; 0 only for a localhost base URL. | `0` outside production                     |
| `API_INTERNAL_URL`                                     | web      | http(s) URL of the API as seen from the web server (also read by the api config, unchanged).                                                       | `http://localhost:4000`                    |

Rules of thumb: the shared secret must be identical in both apps or the client-address dimension of the sign-in throttle is
ignored (the per-email limit still applies). The sign-in throttle stores only keyed hashes of emails and addresses, and
the scheduled cleanup removes them within a day. Compose passes `WEB_BASE_URL`, `API_INTERNAL_SHARED_SECRET` and
`WEB_TRUSTED_PROXY_HOPS=0` to the web service and `API_INTERNAL_SHARED_SECRET` and `AUTH_FAKE_OAUTH` to the api.
The web container runs the production build, which refuses the placeholder secret of `.env.example`, so Compose uses its
own local-only value (`COMPOSE_API_INTERNAL_SHARED_SECRET`, with a built-in default) for both services instead of
reading `API_INTERNAL_SHARED_SECRET` from `.env`.

### Google and Facebook sign-in

Each provider is optional and enabled by setting both of its variables; without them its button is hidden and its
endpoints answer 404 `provider_not_enabled`. The redirect URI is always `<WEB_BASE_URL>/auth/callback/<provider>` (the web
owns the callback).

**Google**

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) create an OAuth consent screen (external,
   scopes `openid`, `email`, `profile`) and an **OAuth 2.0 Client ID** of type **Web application**.
2. Add the authorised redirect URIs `http://localhost:3000/auth/callback/google` and the production origin's
   `https://<your-domain>/auth/callback/google`.
3. Put the client id and secret in `.env` as `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.

**Facebook**

1. In [Meta for Developers](https://developers.facebook.com/apps) create an app and add the **Facebook Login** product.
2. Under Facebook Login settings add the valid OAuth redirect URIs `http://localhost:3000/auth/callback/facebook` and
   `https://<your-domain>/auth/callback/facebook`.
3. Make sure the `email` permission is available (it is, by default, for `email` and `public_profile`).
4. Put the app id and secret in `.env` as `FACEBOOK_OAUTH_APP_ID` and `FACEBOOK_OAUTH_APP_SECRET`.
5. Notes: while the app is in **development** mode only app roles (admins, developers, testers) can sign in; switch it to
   **live** before real players use it. The adapter pins a Graph API version (`GRAPH_VERSION` in
   `apps/api/src/modules/auth/providers/facebook.ts`); versions expire about two years after release, so refresh it
   within that time. Facebook never asserts that an email is verified.

Restart the api after changing these variables. Inside the Facebook or Instagram in-app browser Google refuses to sign
in; the login and register pages show a hint above "Continue with Google" there.

### First GLOBAL_ADMIN

Nobody can make themselves an admin through the app. Register the account first, then run on a machine that can reach
the database (the command reads `DATABASE_URL` from the environment or `.env`):

```sh
pnpm --filter @sgm/api exec tsx --env-file-if-exists=../../.env src/cli.ts users set-role <email> GLOBAL_ADMIN
```

It prints the user id and the new role (no secrets) and exits 0; an unknown email exits non-zero and changes nothing.
The user's existing sessions see the new role on their next request. Use `PLAYER` to revoke it. `TEAM_ADMIN` is rejected:
it is a per-team role granted through team membership, never a global one.

### Production trust settings

The sign-in throttle limits guessing per client address as well as per email. The API only believes a client address that
arrives over an authenticated hop from the web, so production needs both of these (the apps refuse to boot without them):

- **`API_INTERNAL_SHARED_SECRET`**: at least 32 random characters, identical on the `web` and `api` services, never the
  `.env.example` placeholder. Generate one with `openssl rand -base64 48`. The web sends it as `x-sgm-internal-auth`; the
  API compares it in constant time and ignores `x-sgm-client-ip` without it.
- **`WEB_TRUSTED_PROXY_HOPS`**: the number of reverse proxies in front of the web that append to `X-Forwarded-For`
  (for example `1` behind one platform load balancer). The web takes the client address as the N-th entry counted from the
  **right**, so entries a visitor typed on the left are ignored. Setting it too low trusts a spoofable entry; too high
  yields no address (the per-email limit still applies and a warning is logged). `0` is allowed only with a localhost
  `WEB_BASE_URL`.

### Web build argument per environment

`WEB_BASE_URL` has two jobs in the web: a runtime variable (cookies, redirects, CSRF origin checks) and a **build-time**
input, because Next bakes `serverActions.allowedOrigins` into the standalone server when it builds. The image therefore
needs the environment's public origin as a build argument, and the runtime variable must be the same host:

```sh
docker build -f apps/web/Dockerfile --build-arg WEB_BASE_URL=https://games.example.nz -t sgm-web:prod .
```

- The Dockerfile has **no default**: building without the argument fails with `build arg WEB_BASE_URL is required`
  (only `docker-compose.yml` supplies `http://localhost:3000`, for development).
- Build one image per environment (staging and production differ in host). At boot the web refuses to start when the
  runtime `WEB_BASE_URL` host differs from the baked one (`Invalid configuration: WEB_BASE_URL — host differs from the host
this image was built for`); a local `next build` without `WEB_BASE_URL` bakes nothing and skips the check.

### End-to-end tests and the pre-release smoke test

`pnpm run test:e2e` runs `apps/web/e2e/*.spec.ts` against the running stack on two Playwright projects (desktop and a
360 x 740 phone). The auth journeys use the fake OAuth provider, so start the stack with it on and install Chromium once:

```sh
AUTH_FAKE_OAUTH=true docker compose up -d --build --wait
pnpm exec playwright install chromium     # once
pnpm run test:e2e
```

The specs scan every auth page with axe-core (critical or serious violations fail), check focus movement, mobile layout
and web-to-API trace continuity (the API log line for `POST /auth/login` carries the web request's `traceparent` trace
id; the check reads `docker compose logs api`, override with `E2E_API_LOG_COMMAND`). Reset emails are read from Mailpit
(`MAILPIT_API_URL`, default `http://localhost:8025`).

**Pre-release manual step (cannot run in CI).** The adapters are tested against recorded provider payloads. Before the
first release, with real credentials: register once with Google and once with Facebook, sign out, sign in again with each,
and connect and disconnect each from `/account`. Record the result, and confirm in particular that Facebook accepts the
`Authorization` header for the Graph call (see the Facebook deviation in the task notes).

## Payments and Akahu configuration

Billing takes payments through a provider-neutral port (`apps/api/src/lib/akahu/gateway.ts`). The adapter is chosen only
by `PAYMENTS_ADAPTER`, like `NOTIFIER_ADAPTER` and `AUTH_FAKE_OAUTH`.

- **`fake` (default).** A stateless fake that works across the api and the worker: `$17.00` succeeds, `$5.15` is declined,
  `$5.20` stays processing. It is refused when `NODE_ENV=production`.
- **`akahu`.** The live adapter is not available until Phase 4b (it is gated on Akahu's written answer and sandbox access): selecting it stops boot with
  `PAYMENTS_ADAPTER=akahu is not available in this build`. Until then a production boot is refused outright.
- **Webhook path.** Akahu will call `POST /webhooks/akahu` (set `AKAHU_WEBHOOK_URL` to its absolute public URL). The
  signature headers `x-akahu-payments-signature` and `x-akahu-payments-signing-key` are redacted from logs.

Every malformed value stops boot with an error that names the variable and never prints its value.

| Variable                              | Default                         | Allowed               | Meaning                                                                                |
| ------------------------------------- | ------------------------------- | --------------------- | -------------------------------------------------------------------------------------- |
| `PAYMENTS_ADAPTER`                    | `fake`                          | `akahu` or `fake`     | Which gateway to build. `fake` is refused in production; `akahu` is Phase 4b.          |
| `AKAHU_APP_TOKEN`                     | unset                           | non-empty             | Akahu app token. Required with `akahu`.                                                |
| `AKAHU_APP_SECRET`                    | unset                           | non-empty             | Akahu app secret. Required with `akahu`.                                               |
| `AKAHU_PAYMENTS_API_URL`              | `https://api.payments.akahu.io` | URL                   | Payments API base. In production: https and a host ending in `.akahu.io`.              |
| `AKAHU_WEBHOOK_URL`                   | unset                           | http(s) URL, no query | Public URL sent to Akahu as `webhook_uri`. Required with `akahu`; https in production. |
| `AKAHU_PAYMENT_EXPIRY_MINUTES`        | `30`                            | 15 to 120             | Expiry set on every created payment.                                                   |
| `AKAHU_RECONCILE_ORPHAN_AGE_SECONDS`  | `120`                           | 30 to 3600            | Age after which reconcile closes a stale `CREATING` intent.                            |
| `AKAHU_RECONCILE_MIN_AGE_SECONDS`     | `300`                           | 60 to 3600            | Age after which reconcile re-reads an `OPEN` intent.                                   |
| `AKAHU_RECONCILE_STUCK_AFTER_SECONDS` | `21600`                         | 3600 to 604800        | Age after which an open intent is logged as stuck.                                     |
| `AKAHU_FINALITY_HORIZON_HOURS`        | `168`                           | 1 to 720              | How long after close or hold reconcile keeps re-reading for a late success.            |

## Wallet, billing and Akahu operations

This section is for whoever runs the platform. It covers the Akahu setup that is still to be done, the environment, re-running
billing jobs, reading the reconciliation check, what an admin does after a payout block or for a held payment, and the sandbox
smoke test. Business rules are in [ADR 0020](adr/0020-wallet-and-akahu-billing.md).

### Akahu app and webhook (to be done, pending Phase 4b)

**Status: not done.** Creating the Akahu app and registering the webhook waits for three gates: Akahu's written answer to
MVE-001 (go or no-go on third-party team payees), sandbox credentials (MVE-002), and a verified signed sandbox webhook stored as a
fixture (MVE-005). The steps will be written in Phase 4b, once those gates clear. Do not create a production app or webhook
before then.

What the app will need, so the inputs are ready:

- An app token and an app secret, set as `AKAHU_APP_TOKEN` and `AKAHU_APP_SECRET`. Keep them in the platform secret store and
  never commit them (ADR 0007).
- A public, absolute `https` URL for `POST /webhooks/akahu`, set as `AKAHU_WEBHOOK_URL`. It must have no query string.
- The payments API base, `AKAHU_PAYMENTS_API_URL` (defaults to `https://api.payments.akahu.io`). In production it must be `https`
  on a `.akahu.io` host.

Until Phase 4b the code runs only with `PAYMENTS_ADAPTER=fake`. Setting `PAYMENTS_ADAPTER=akahu` stops boot, so no webhook
receives Akahu traffic yet.

### Environment variables (wallet, billing and Akahu)

Every variable below is listed in `.env.example` and validated at boot in `apps/api/src/lib/config/config.ts`. A malformed value
stops boot and names the variable without printing its value. The full table with defaults and allowed values is in
[Payments and Akahu configuration](#payments-and-akahu-configuration) above.

- `PAYMENTS_ADAPTER` (`fake` by default; `akahu` is not bootable until Phase 4b)
- `AKAHU_APP_TOKEN`, `AKAHU_APP_SECRET` (required only with `akahu`)
- `AKAHU_PAYMENTS_API_URL`
- `AKAHU_WEBHOOK_URL` (required only with `akahu`)
- `AKAHU_PAYMENT_EXPIRY_MINUTES` (default 30)
- `AKAHU_RECONCILE_ORPHAN_AGE_SECONDS` (default 120)
- `AKAHU_RECONCILE_MIN_AGE_SECONDS` (default 300)
- `AKAHU_RECONCILE_STUCK_AFTER_SECONDS` (default 21600)
- `AKAHU_FINALITY_HORIZON_HOURS` (default 168)

There are no wallet or billing environment variables. The business limits are code constants, so they cannot be set per
deployment: the wallet cap is $100.00, the top-up minimum is $1.00, the low-credit alert is below $20.00, and an unpaid charge
becomes overdue 72 hours after billing. The schedules are fixed too: `post-game-billing` every 5 minutes, `akahu-reconcile`
every 15 minutes, and `daily-overdue` at 04:00 Pacific/Auckland.

### Re-running a failed billing job

Both jobs run in the worker, so start the worker first (`pnpm run dev`, or the Compose `worker` service). Then:

1. Find the failure. Failed jobs stay in `pgboss.job` with state `failed`. Filter by the job name (`bill-session`,
   `daily-overdue`) and read the session id from the job's data. The worker log line `billing.session.failed` carries the
   session id, the error class and the SQLSTATE. It never carries the message.
2. Re-run one session's billing:

   ```sh
   pnpm run jobs:trigger bill-session '{"sessionId":"<session-uuid>","trigger":"manual"}'
   ```

   `trigger` is `sweep` or `manual`. Use `manual` for an operator run.

3. Re-run the overdue job (safe to repeat; a second run the same day changes nothing and sends nothing):

   ```sh
   pnpm run jobs:trigger daily-overdue
   ```

4. Re-run the sweep if many sessions were missed. It re-enqueues every due PUBLISHED session, oldest first:

   ```sh
   pnpm run jobs:trigger post-game-billing
   ```

A session whose failure is a data-integrity error (SQLSTATE class 23) will not succeed on retry. The job ends failed at once,
and the next 5-minute sweep re-enqueues it, so it fails again until the data is fixed. Read the logged SQLSTATE and fix the cause
before re-running. Do not hand-edit payment, ledger or session rows. The triggers refuse most of those edits (append-only ledger,
guarded status), and an edit that gets past them would hide a real problem.

A session whose team cannot take payments is held, not failed (B8). Its log line is `billing.session.blocked`, and it bills on
the first sweep after banking is saved again (see the payout block section below).

### Reading `cli billing reconcile`

**Status: built in Phase 6.** The command
checks that the money tables agree with each other (AC-VERIFY-12). It is run the same way as the other operator commands:

```sh
pnpm --filter @sgm/api exec tsx --env-file-if-exists=../../.env src/cli.ts billing reconcile
```

What it checks:

- For every wallet, the balance equals the sum of its ledger amounts, and equals the latest `resulting_balance`.
- For every wallet, the ledger rows form one unbroken sequence from 0.00: no row starts at a balance the wallet never reached
  (`LEDGER_CHAIN_BREAK`, by row id), and no balance is left by two rows or never left (`LEDGER_CHAIN_FORK`, by wallet id with
  the balance). Repeated balances cannot hide either.
- Every `AUTO_DEDUCTION` has a matching PAID `PREPAID_CREDIT` payment for the same registration and amount.
- Every PAID `PER_GAME` payment, and every `TOPUP`, has an Akahu payment id.
- Informational, not a discrepancy: top-ups currently on hold are listed, because a hold needs an admin decision (see below).

Each discrepancy is printed with the id of the row that disagrees. Exit codes:

- `0`: no discrepancies.
- `1`: at least one discrepancy. Note that the CLI's generic error handler also exits `1` when the command itself fails (for
  example, the database is unreachable), so read the message as well as the code.
- `2`: a usage error (wrong arguments).

Investigate each discrepancy by its id. The ledger and payment rows are protected by triggers, so a discrepancy is corrected by
a reviewed fix (usually a forward migration or an explicit admin procedure), not by editing rows in place.

### Payout blocked: what an admin does

A payout block means Akahu cannot pay the team's bank account (ADR 0016, ADR 0020 section 13). It is set manually by a
GLOBAL_ADMIN from the team's Payments area, with a reason from a fixed list and no free text. It is never set automatically in
this version. The effects:

- Every approved admin of the team is emailed. The email names no account name or digits.
- The Banking and GST page shows the blocked notice, and publishing a new paid session is refused.
- Players cannot start a top-up or pay a charge. They see "This team can't receive payments right now."
- Sessions that ended while blocked are held, not billed. They bill on the first sweep after the account is fixed.
- Pending charges are not skipped by the overdue job while the team is blocked, so they can go overdue.

What the team admins do, in order:

1. Check the bank account name and number on the Banking and GST page against the team's bank records.
2. Re-save the banking details. A save clears the block (there is no separate unblock action). If the account number is the
   problem, enter it again. Leaving the number blank keeps the saved number.
3. Confirm the blocked notice has gone and that a paid session can be published.
4. Wait for the next sweep (within 5 minutes) to bill held sessions. Their players then receive their charges as usual.
5. Check the Payments area for any hold or "money received but not applied" items, and resolve them (below).

Note that a payment is paid to the team's account as it is when the player pays (B10). A charge created before the block is
payable again once the account is saved, and its money goes to the saved account.

### Held payments and top-ups

A hold means the outcome at the bank could not be confirmed. The payment shows "Under review". It has no pay button and no
reminder button, and the player is told it is under review. Only the team's admins or a GLOBAL_ADMIN can resolve a hold (ruling
H2).

Before resolving, establish what the bank actually did, from the provider's own record. The app re-reads the provider before
it applies a manual outcome. If the provider now reports a definite status, the manual outcome is refused with
`hold_resolved_by_provider`, and the refresh shows the provider's result.

To resolve a held payment, open the team's Payments area and use the hold action on that payment:

- `RECEIVED`: the money arrived. The payment is marked PAID.
- `NOT_RECEIVED`: the money did not arrive. The payment is payable again. If the player had already authorised it at the bank, its
  due date moves to at least 24 hours from now.
- For a hold with an amount mismatch, `RECEIVED` needs the amount the bank actually received. The payment is applied only if it
  equals the charge. Otherwise the money is recorded as "not applied". The team refunds it outside the app, and no wallet credit
  is given.

Held top-ups have no web screen in this version. Resolve them through the API with a bearer token of an eligible account:

```sh
curl -X POST "$API_URL/teams/<teamId>/wallet/top-ups/<topUpId>/hold-resolution" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"outcome":"RECEIVED","changeKey":"<new-uuid>"}'
```

Use `NOT_RECEIVED` for an outcome that did not arrive, and add `"observedAmount":"<amount>"` for a `RECEIVED` mismatch. Use a new
`changeKey` for each decision. Find held top-ups with `cli billing reconcile`.

A hold that is resolved `RECEIVED` may still come back as "recorded, not applied" (the cap or a duplicate). That is expected:
the money is recorded, the player and the team admins are told, and the team refunds it outside the app.

### Sandbox smoke test (DEFERRED to Phase 4b)

> **DEFERRED to Phase 4b. Not executed. Requires the live adapter and sandbox credentials.** This checklist cannot run until
> the Akahu gates clear (MVE-001, MVE-002, MVE-005). No result has been recorded. Record each run with its date and tester in the
> release notes, not here.

Run against a test team with payout configured, in Akahu's sandbox, with the worker running:

- [ ] **Top-up.** Start a $30.00 top-up from the team's wallet page and complete the Akahu step. Expect one credit of $30.00, one
      `TOPUP` ledger row with an Akahu payment id, and the balance shown. Replay the same completion event and expect no change.
- [ ] **Pay.** For a PENDING charge, start a payment from `/payments/<id>` and complete the Akahu step. Expect the payment PAID once,
      "Paid on {date}." shown, and the wallet balance unchanged. Replay the completion and expect no second PAID transition.
- [ ] **Decline.** Start a payment and decline or cancel it in the sandbox. Expect the payment to stay payable, the copy
      "Your payment didn't go through. You haven't been charged." to appear, and no PAID transition and no wallet movement.
- [ ] **Webhook.** Confirm a sandbox webhook is accepted, and a forged or unsigned request is refused with no state change.

Keep the fixtures recorded from these runs with their provenance (sandbox-real), as ADR 0020 requires.

## Income export limits

Team admins download their income (PAID payments) as CSV or Excel from `GET /teams/:teamId/exports/income` (ADR 0021). Each
export is built completely in the api before it is sent, inside one read-only database snapshot, so it is bounded by three api
environment variables. Each can be lowered; none can be raised past its ceiling (the api refuses to boot):

| Variable                       | Default    | Allowed             | Meaning                                                                                                    |
| ------------------------------ | ---------- | ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `INCOME_EXPORT_MAX_ROWS`       | `50000`    | 1 to 50,000         | More PAID payments in the range is refused with 422 `export_too_large` ("Choose a shorter range.").        |
| `INCOME_EXPORT_MAX_BYTES`      | `33554432` | 1,024 to 67,108,864 | The file (CSV bytes, or the zipped XLSX) may not grow past this while it is built: 422 `export_too_large`. |
| `INCOME_EXPORT_MAX_CONCURRENT` | `2`        | 1 to 8              | Exports running at once in one api process, and never two for the same team: 429 `export_busy`.            |

- **Never truncated.** A refused export returns a JSON error and no file. A client that disconnects cancels the export's
  database statement and frees its slot (logged as `income_export.cancelled`).
- **Logs.** `income_export.generated` carries the team id, the period type, the format and the row count only;
  `income_export.refused` carries the team id and the reason (`rows`, `bytes`, `money_range` or `busy`).
- **Measured.** `apps/api/test/integration/income-exports-load.int.test.ts` exports 50,000 rows in both formats and runs four
  concurrent worst-case-width exports; it prints its timings and sizes (`--silent=false`).

## Money and time rules

- Money in the database is `NUMERIC(10,2)`, on the wire a 2-decimal string (`MoneyString`), and in TypeScript branded `bigint`
  cents (`Money`). Use `@sgm/shared` (`parseMoney`, `add`, `multiplyByRatio`, `toMoneyString`). Never use `number` or floats for
  money. Rounding is HALF_UP; the rate suggestion uses CEIL to whole dollars. The wallet balance is constrained to 0.00 to 100.00.
- Time is stored as `timestamptz` (UTC) with the database and processes running in UTC. Local wall-clock times are Pacific/Auckland
  and converted only with `@sgm/shared` time helpers (`localToInstant`, `instantToLocal`). User input uses `reject` for
  nonexistent and ambiguous local times; derived times use `compatible`. Display dates as `DD/MM/YYYY` (`formatNz*`).
  `game_sessions.starts_at` and `ends_at` are written only by database triggers.
- Invoice numbers come from `assign_invoice_number(payment_id)` inside the issuing transaction (gapless per team, `INV-000123`).

## Tracing

The api and worker start OpenTelemetry from `apps/api/src/instrumentation.ts` (loaded with `--import`). By default no
exporter runs: spans stay in-process, but their trace ids appear in every request and job log line (`traceId`,
`spanId`). Set `OTEL_EXPORTER_OTLP_ENDPOINT` (an http(s) collector base URL) to export over OTLP/HTTP, or
`OTEL_TRACES_EXPORTER=console` to print spans. `OTEL_SDK_DISABLED=true` turns the SDK off. The web app sends a
`traceparent` on every server-side API call, the API continues it, and jobs enqueued during a request carry it in
`_meta.traceparent` to the worker's `"{queue} process"` span.

## Decisions

See [`docs/adr/`](adr/) for the recorded stack and algorithm decisions.

## Troubleshooting

- Port already in use on 3000, 4000, 5432, 8025 or 1025: stop the other stack (`docker compose down`) first.
- `docker compose up` slow on first run: images are built once; later runs use the cache.
- After pulling code changes run `docker compose up -d --wait --build`. Plain `up` reuses an existing `sgm-api:dev` / `sgm-web:dev` image, so a stale image from an older checkout can crash on start (for example an old `db migrate` stub).
- Integration tests cannot connect: check `docker compose ps` shows `postgres` healthy.
- The `web` container exits at start with `Invalid configuration: ...`: it runs the production build, which validates its
  environment (see Authentication configuration). `docker logs sgm-web-1` shows the variable (never its value).
