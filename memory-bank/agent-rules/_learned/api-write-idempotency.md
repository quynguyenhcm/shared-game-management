---
name: Idempotency keys on every sibling write
globs: ["apps/api/src/modules/**/service.ts", "apps/api/src/modules/**/repo.ts", "packages/shared/src/api/*.ts", "apps/web/src/lib/**/*-actions.ts"]
paths: ["apps/api/src/modules/", "packages/shared/src/api/", "apps/web/src/lib/"]
topics: ["idempotency", "replay", "api design", "server actions", "contracts"]
priority: low
auto_generated: true
derived_from: [team-banking-and-gst]
evidence_count: 1
last_validated: 2026-10-17
---

# Idempotency keys on every sibling write

- When one write endpoint of a page takes a per-render idempotency key, give every sibling write on that page the same key and the same claim-under-lock rule. In team-banking-and-gst only the banking PUT had a `changeKey`, so a late replay of a GST save could flip the team's GST status after another admin changed it; the final review caught it.
- Claim the key durably under the row lock in the same statement as the write, and keep a bounded list of recent keys, not only the last one: a single "last key" cannot recognise a replay once another request has committed in between.
- Every committed request claims its key, including one that changed nothing (claim the key without touching audit columns). Refused requests claim nothing.
- When a contract has optional fields that "omit keeps the saved value", also define how to clear them (`null`), and which states may clear them (e.g. a GST number only while GST is off).
- A response that reports a side effect the UI announces (an email sent, something removed) must say whether it happened (`removed: boolean`) so the UI never claims an email that was not sent.
