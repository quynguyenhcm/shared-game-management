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

**Data retention note.** pg-boss job payloads (`pgboss.job.data`) may carry personal information such as email addresses
(the `send-email` queue does). Completed and failed jobs are retained for 7 days. Keep payloads minimal: prefer IDs over
values, and do not put secrets, bank details or tokens in a job payload.

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
