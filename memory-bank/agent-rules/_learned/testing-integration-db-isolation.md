---
name: Per-file template databases for integration tests
globs: ["**/*.int.test.ts", "apps/api/test/**"]
paths: ["apps/api/test/"]
topics: ["integration tests", "postgres", "isolation", "concurrency", "vitest", "verification", "environment", "e2e", "coverage"]
priority: medium
auto_generated: true
derived_from: [platform-foundation, team-banking-and-gst, skill-levels-and-auto-enroll]
evidence_count: 3
last_validated: 2026-10-17
---

# Integration-test database isolation

- Give each integration test file its own database, cloned from a migrated template database created once in global setup. Suites can then run in parallel without seeing each other's rows.
- Give concurrency tests (e.g. 20-way invoice allocation, waitlist position races) a separate clone and a pool larger than the parallelism (pool ≥ 21 for 20-way).
- Use real multi-connection tests for race conditions and a real SIGKILL of a child worker for crash recovery; don't mock these.
- Order races with a lock-waiter probe (`waitForLockWaiters`, reading `pg_stat_activity`), never sleeps, and run every race in both orders. In team-banking-and-gst the gate, raw publish and payment-creation races against removal ran 354/354 three times in a row with no flakiness.
- Deferred constraints: tests that expect a COMMIT-time failure but roll back must `SET CONSTRAINTS … IMMEDIATE`.
- Pass every verification command's environment preconditions to the agent that runs it, and check them before running: `pnpm run test:coverage` includes the integration project and needs `DATABASE_URL`, `ENCRYPTION_ACTIVE_KEY_ID` and `ENCRYPTION_KEYS`; `pnpm run test:e2e` needs the Compose stack and a `.env`. Report a named missing precondition instead of FAIL. In skill-levels-and-auto-enroll the verifier reported a coverage FAIL that was only a missing `DATABASE_URL`, and the Phase 5 e2e ran on `next dev` because no `.env` existed, which left a regression check open.
