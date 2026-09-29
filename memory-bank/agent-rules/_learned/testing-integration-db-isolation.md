---
name: Per-file template databases for integration tests
globs: ["**/*.int.test.ts", "apps/api/test/**"]
paths: ["apps/api/test/"]
topics: ["integration tests", "postgres", "isolation", "concurrency", "vitest"]
priority: low
auto_generated: true
derived_from: [platform-foundation]
evidence_count: 1
last_validated: 2026-09-30
---

# Integration-test database isolation

- Give each integration test file its own database, cloned from a migrated template database created once in global setup. Suites can then run in parallel without seeing each other's rows.
- Give concurrency tests (e.g. 20-way invoice allocation, waitlist position races) a separate clone and a pool larger than the parallelism (pool ≥ 21 for 20-way).
- Use real multi-connection tests for race conditions and a real SIGKILL of a child worker for crash recovery; don't mock these.
- Deferred constraints: tests that expect a COMMIT-time failure but roll back must `SET CONSTRAINTS … IMMEDIATE`.
