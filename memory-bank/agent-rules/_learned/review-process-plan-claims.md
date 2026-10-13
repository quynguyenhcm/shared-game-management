---
name: Reconcile plan and doc claims against the tree at every review
globs: ["memory-bank/tasks/*.md", "memory-bank/techContext.md", "memory-bank/systemPatterns.md"]
paths: ["memory-bank/"]
topics: ["review", "phase review", "observability", "documentation", "plan", "invariants", "cross-phase", "cross-feature", "creative", "critique"]
priority: medium
auto_generated: true
derived_from: [platform-foundation, auth-and-user-roles, team-management]
evidence_count: 3
last_validated: 2026-10-13
---

# Reconcile plan and doc claims against the built tree

- At each phase review, check the task's Architectural Plan items (e.g. Observability, API requirements) and any memory-bank doc claims against the actual code and `package.json`, not only the phase's ACs. In platform-foundation, planned OpenTelemetry tracing was dropped in Phase 5, and `techContext.md` claimed it existed. Six phase reviews missed it; only the final whole-branch review caught it.
- Treat a `TODO(Phase N)` marker that is still present after Phase N as a review finding.
- Ledger items marked "accepted" that touch security should be re-opened at the final review.
- At each phase review, list the invariants earlier phases established (e.g. D1: reset beats any concurrent session issuance) and check every new code path in the diff that touches them, not only the phase's ACs. In auth-and-user-roles six phase reviews returned PROCEED again, and the final review found a Critical and three security Importants, all on paths added after the invariant was set.
- When a phase changes something global or shared (logger redaction, middleware, error mapper, shared schema), the code and phase reviews must search callers and tests in earlier features for impact, not only the phase's own diff. In team-management a global logger key passed four phase reviews and broke auth logging; only the final whole-branch review caught it.
- Verify numeric contract claims (page sizes, limits) against the code, not the plan text.
- Run the creative adversarial critique against the branch diff (`--base origin/<pr_target> --scope branch`); on a clean feature branch the default working-tree scope reviews nothing. In team-management the scoped critique found three real defects before build.
- When parallel creative agents disagree, write one binding reconciliation section (or fold the amendments into the ACs) before the first build phase, so build agents read a single ruling per conflict.
