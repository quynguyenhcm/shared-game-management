---
name: Same guard on every sibling write
globs: ["apps/api/src/modules/**/service.ts", "apps/api/src/modules/**/repo.ts", "packages/shared/src/api/*.ts", "apps/web/src/lib/**/*-actions.ts", "apps/web/src/lib/**/actions.ts"]
paths: ["apps/api/src/modules/", "packages/shared/src/api/", "apps/web/src/lib/"]
topics: ["idempotency", "replay", "api design", "server actions", "contracts", "optimistic concurrency", "stale", "concurrency"]
priority: low
auto_generated: true
derived_from: [team-banking-and-gst, skill-levels-and-auto-enroll]
evidence_count: 2
last_validated: 2026-10-17
---

# Same guard on every sibling write

- When one write endpoint of a page takes a per-render idempotency key, give every sibling write on that page the same key and the same claim-under-lock rule. In team-banking-and-gst only the banking PUT had a `changeKey`, so a late replay of a GST save could flip the team's GST status after another admin changed it; the final review caught it.
- Claim the key durably under the row lock in the same statement as the write, and keep a bounded list of recent keys, not only the last one: a single "last key" cannot recognise a replay once another request has committed in between.
- Every committed request claims its key, including one that changed nothing (claim the key without touching audit columns). Refused requests claim nothing.
- When a contract has optional fields that "omit keeps the saved value", also define how to clear them (`null`), and which states may clear them (e.g. a GST number only while GST is off).
- A response that reports a side effect the UI announces (an email sent, something removed) must say whether it happened (`removed: boolean`) so the UI never claims an email that was not sent.
- The same holds for optimistic-concurrency guards: when one write on a resource sends the state the form was showing and gets a 409 with the current row on a mismatch, every sibling write on that resource gets the same expected-value compare under the row lock, the same 409-with-current-row answer, and a test of the stale path. A save that would change nothing stays a no-op on a stale view, so retries are safe. In skill-levels-and-auto-enroll the override PUT was guarded but the Auto Enroll PUT beside it was last-writer-wins: a stale panel could re-enrol (and later charge) a member another admin had turned off. Five phase reviews and the creative critique passed it; the final review caught it.
