---
name: Advance injected clocks inside one operation
globs: ["**/*.test.ts", "**/*.int.test.ts", "apps/api/test/**"]
paths: ["apps/api/test/", "apps/api/src/modules/"]
topics: ["testing", "clock", "time", "throttle", "timestamps", "flaky", "timeouts", "DST", "locks", "concurrency"]
priority: medium
auto_generated: true
derived_from: [auth-and-user-roles, team-management, skill-levels-and-auto-enroll]
evidence_count: 3
last_validated: 2026-10-17
---

# Advance injected clocks between sequential calls

- When a test injects a `Clock`, advance it between the sequential calls of one operation (admit then settle, issue then verify, reserve then refund). A frozen clock hides bugs where two calls each read `clock.now()` and later match on exact timestamp equality. In auth-and-user-roles the login throttle never refunded in production for this reason, and every frozen-clock test passed.
- Wall-clock-bound tests (DST/schedule unit tests, pg-boss `previewSchedule` with a 1000 ms budget) time out when parallel agents load the CPU. Prefer an injected clock or a load-tolerant budget, and when only these time out, re-run the failing files sequentially before calling it a regression. In team-management Phase 3's first verifier run failed this way and passed on a quiet re-run.
- In production code, read the clock once per operation and pass the value down; prefer a reservation id over timestamp equality when one step must find what an earlier step recorded.
- In every lock-then-decide path (HTTP saves as well as jobs), read `clock.now()` after the row lock is taken, never before the transaction: a request that waited behind another writer must stamp and validate against when it wrote, not when it arrived (a wait across NZ midnight otherwise stores an end date that is already past, and new order keys stop matching commit order). Pin it with a test that holds the lock, advances the clock, then releases. In skill-levels-and-auto-enroll the progression job read `now` after its lock but both admin saves read it first; the final review caught it.
