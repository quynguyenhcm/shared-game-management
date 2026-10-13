---
name: Reconcile plan and doc claims against the tree at every review
globs: ["memory-bank/tasks/*.md", "memory-bank/techContext.md", "memory-bank/systemPatterns.md"]
paths: ["memory-bank/"]
topics: ["review", "phase review", "observability", "documentation", "plan", "invariants", "cross-phase"]
priority: low
auto_generated: true
derived_from: [platform-foundation, auth-and-user-roles]
evidence_count: 2
last_validated: 2026-10-07
---

# Reconcile plan and doc claims against the built tree

- At each phase review, check the task's Architectural Plan items (e.g. Observability, API requirements) and any memory-bank doc claims against the actual code and `package.json`, not only the phase's ACs. In platform-foundation, planned OpenTelemetry tracing was dropped in Phase 5, and `techContext.md` claimed it existed. Six phase reviews missed it; only the final whole-branch review caught it.
- Treat a `TODO(Phase N)` marker that is still present after Phase N as a review finding.
- Ledger items marked "accepted" that touch security should be re-opened at the final review.
- At each phase review, list the invariants earlier phases established (e.g. D1: reset beats any concurrent session issuance) and check every new code path in the diff that touches them, not only the phase's ACs. In auth-and-user-roles six phase reviews returned PROCEED again, and the final review found a Critical and three security Importants, all on paths added after the invariant was set.
