# Getting started

Everything a developer needs to run, test and extend the platform foundation. Always run root targets as
`pnpm run <target>` (never bare `pnpm <target>`, which can collide with built-in pnpm commands).

## Prerequisites

- Docker with Compose v2+ (Docker Desktop, or Colima on macOS: `colima start`).
- Node 24 (`.nvmrc`; `engines` is `>=24 <25`).
- Corepack, which ships with Node. It provides pnpm 10 at the version pinned in `packageManager`; no global pnpm install is needed.

## First run

```sh
pnpm run setup                 # corepack enable, pnpm install --frozen-lockfile, create .env
docker compose up -d --wait    # postgres 17, mailpit, api, worker, web; returns when all are healthy
pnpm run ci                    # lint, typecheck, unit + coverage, integration, build
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

| Target                                    | What it does                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `setup`                                   | One-time bootstrap (see above)                                                 |
| `dev`                                     | Postgres + Mailpit, migrate, run web, api and worker in watch mode             |
| `lint`                                    | ESLint (0 warnings allowed) and Prettier check                                 |
| `typecheck`                               | `tsc --noEmit` in every package (`strict: true`)                               |
| `test`                                    | Unit project with coverage gate                                                |
| `test:integration`                        | Integration project against real PostgreSQL 17                                 |
| `build`                                   | Build every workspace                                                          |
| `ci`                                      | `lint`, `typecheck`, `test`, `test:integration`, `build`; the same gates as CI |
| `db:migrate` / `db:rollback` / `db:reset` | Apply, revert one, or drop and re-apply migrations (also installs pg-boss)     |
| `db:new`                                  | Create a new SQL migration file                                                |
| `db:codegen`                              | Regenerate `apps/api/src/lib/db/types.generated.ts` from the migrated database |
| `openapi`                                 | Regenerate `apps/api/openapi.yaml` from the routes                             |
| `jobs:trigger`                            | Enqueue a job by queue name for manual testing                                 |
| `test:e2e`                                | Playwright smoke test (not part of `ci`)                                       |
| `lint:actions`                            | actionlint on `.github/workflows` (via Docker)                                 |

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
