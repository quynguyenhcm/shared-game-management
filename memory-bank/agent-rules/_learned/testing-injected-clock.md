---
name: Advance injected clocks inside one operation
globs: ["**/*.test.ts", "**/*.int.test.ts", "apps/api/test/**"]
paths: ["apps/api/test/", "apps/api/src/modules/"]
topics: ["testing", "clock", "time", "throttle", "timestamps"]
priority: low
auto_generated: true
derived_from: [auth-and-user-roles]
evidence_count: 1
last_validated: 2026-10-07
---

# Advance injected clocks between sequential calls

- When a test injects a `Clock`, advance it between the sequential calls of one operation (admit then settle, issue then verify, reserve then refund). A frozen clock hides bugs where two calls each read `clock.now()` and later match on exact timestamp equality. In auth-and-user-roles the login throttle never refunded in production for this reason, and every frozen-clock test passed.
- In production code, read the clock once per operation and pass the value down; prefer a reservation id over timestamp equality when one step must find what an earlier step recorded.
