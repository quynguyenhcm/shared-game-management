---
name: Lock and re-check on every session-issuing path
globs: ["apps/api/src/modules/auth/**"]
paths: ["apps/api/src/modules/auth/"]
topics: ["auth", "sessions", "concurrency", "race condition", "password reset", "oauth"]
priority: low
auto_generated: true
derived_from: [auth-and-user-roles]
evidence_count: 1
last_validated: 2026-10-07
---

# Session issuance races a password reset

- Every path that issues a session or attaches a credential (password login, OAuth sign-in, sign-up completion, identity link, and any new one) must `lockUserRow` and re-check the credential or identity — and for links, that the linking session is still live — inside the issuing transaction. A concurrent password reset (D1: evicts sessions and OAuth identities) must always win.
- When a race fix lands on one path, write it down as an invariant for the whole class (in `systemPatterns.md`) before the next phase starts. In auth-and-user-roles the login-vs-reset fix (Phase 4) was not generalised, and the same hole reappeared in three OAuth paths in Phase 5.
- Prove each path with a deterministic race test: hold an uncommitted reset transaction (row lock taken, identities deleted, sessions revoked), start the request, wait until it is blocked, then commit the reset and assert no session or link was created.
