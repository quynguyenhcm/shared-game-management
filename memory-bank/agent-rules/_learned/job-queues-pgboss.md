---
name: pg-boss crash recovery, dedupe and permanent errors
globs: ["apps/api/src/lib/jobs/**", "apps/api/src/jobs/**"]
paths: ["apps/api/src/lib/jobs/", "apps/api/src/jobs/"]
topics: ["pg-boss", "jobs", "queue", "retry", "dedupe", "worker", "secrets", "encryption"]
priority: low
auto_generated: true
derived_from: [platform-foundation, auth-and-user-roles]
evidence_count: 2
last_validated: 2026-10-07
---

# pg-boss (12.x) job queue rules

- Crash recovery needs both `superviseIntervalSeconds` and `monitorIntervalSeconds` set, plus a per-queue `expireInSeconds`. Otherwise a SIGKILLed worker's active jobs are not recovered in a bounded time.
- `singletonKey` only dedupes on queues with the `exclusive` policy; on `standard` queues it is ignored. It suppresses concurrent queued/active duplicates only, and a replay after completion still runs. Handlers must be idempotent through a durable domain key or a guarded state transition.
- Fail permanent errors (e.g. `PermanentDeliveryError`, `NotifierConfigurationError`, invalid payloads) with a non-retryable error type so the job fails at once. Only transient errors retry with backoff.
- Validate job payloads at runtime (zod) in the handler; never cast `job.data`.
- Apps start pg-boss with `migrate: false`; the schema is installed by `db:migrate`.
- `pgboss.job.data` is kept for days and readable by anyone with DB access. Never put a secret (reset link, token) in a payload in clear: seal it with FieldCrypto bound to the idempotency key (`enqueueEmail(..., { crypto })`) and open it in the handler; a tampered or moved payload is a non-retryable failure. In auth-and-user-roles the raw reset token sat in `pgboss.job` until the final review.
