# ADR 0004: Job runner and scheduler

- Status: Accepted (2026-09-29)
- Task: platform-foundation
- Source: [architecture Q4](../../memory-bank/creative/platform-foundation-architecture.md)

## Context

Recurrence materialisation, post-game billing and a daily overdue check need scheduling, retries and crash recovery. Options were Postgres-backed (pg-boss, Graphile Worker), Redis-backed (BullMQ) and platform cron.

## Decision

pg-boss inside the worker process, with schedules registered in Pacific/Auckland. Post-game billing is a 5-minute sweep that enqueues one `bill-session` job per due session with `singletonKey`. Defaults: 3 retries, 5 s delay with exponential backoff, 900 s expiry (60 s for the heartbeat), completed jobs kept at least 7 days. Delivery is at-least-once, so every handler must be idempotent. No calendar-anchored schedule may fire between 02:00 and 02:59 local time (the `intervalSweep` sweeps are exempt). pg-boss owns the `pgboss` schema; `db:migrate` installs it and app processes never run DDL.

## Consequences

- No extra service (no Redis) and transactional enqueue; job state is readable with SQL.
- Polling latency of about 2 s, and recovery of a crashed worker's jobs is bounded by the queue expiry.
- Job payloads may contain PII (email addresses) and are retained for 7 days; see the retention note in [getting-started](../getting-started.md).
