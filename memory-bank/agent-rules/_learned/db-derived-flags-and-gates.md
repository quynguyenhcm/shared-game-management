---
name: Derived flags and SQL-backed gates
globs: ["db/migrations/*.sql", "apps/api/src/modules/**/*.ts", "apps/api/test/integration/**"]
paths: ["db/migrations/", "apps/api/src/modules/", "apps/api/test/integration/"]
topics: ["postgres", "generated columns", "triggers", "gates", "locking", "migrations", "invariants", "money", "liability", "property tests"]
priority: medium
auto_generated: true
derived_from: [team-banking-and-gst, registration-and-waitlist, tax-invoices-and-exports]
evidence_count: 3
last_validated: 2026-11-13
---

# Derived flags and SQL-backed gates

- Derive "is configured" flags as a generated column from the data they summarise, and record an externally detected failure as a separate nullable timestamp (`payout_blocked_at`) that the generated expression includes. The gate, the trigger and the UI then read one source and the flag cannot drift.
- Back every service-level gate with a SQL trigger and one shared SQL predicate that both the service and the trigger call (`team_banking_in_use`, `game_session_is_paid`), with a fixture matrix that keeps any TS twin equal to the SQL function.
- A trigger that reads a parent row must take only the lock the foreign-key check already takes (`FOR KEY SHARE`) or none, never a stronger one after the child row is locked; the writer that removes the parent takes `FOR UPDATE` first and then only reads. Prove each pairing with a race in both orders.
- A BEFORE trigger fires before CHECK constraints, so a new trigger can change which error an existing test sees. Grep existing tests and factories for the rows it touches (team-banking-and-gst broke `session-instants.int.test.ts:67` through a paid-by-default factory) and add a factory option rather than weakening the test.
- Model an owed amount as a one-way flag on the row (true to false only, enforced by a trigger, plus a CHECK tying it to the only state that can owe), not as a money row. When two release paths can fire in one step, write the netting rule down and pin it with a conservation property test (the seats confirmed in a step release at most that many seats of liability). In registration-and-waitlist a fee-due re-registrant cleared its own fee and released another owed fee with the same seat; each rule was correct alone, and only the Phase 2 reviewer caught it (invariant I14 was added after the HALT).
- Adding constraints to a table with live rows: clean up the shapes the old schema allowed, add the CHECKs `NOT VALID`, then `VALIDATE`, and add an upgrade test seeded with every old shape.
- A migration that adds immutability to existing data preflights the legacy rows and raises with the offending ids rather than clearing numbers or rewinding counters, and its down migration refuses once any immutable record exists. In tax-invoices-and-exports the Codex design critique caught a plan that would have cleared issued invoice numbers and a down migration that would drop 7-year tax records (CR-1, CR-2).
- Cancellation or cleanup of long-running database work must not draw from the pool that work is holding: use a dedicated short-lived connection, fired without awaiting the cancelled query. In tax-invoices-and-exports `pg_cancel_backend` via the app pool deadlocked when every pool slot held an export (Codex P1).
- Apply a current-state fallback (a team's current GST number, name or setting) only when the result is empty, never to historical rows that carry their own snapshot values. In tax-invoices-and-exports the export Summary printed a team's current GST number on a period of pre-registration receipts; only the final whole-branch review caught it.
