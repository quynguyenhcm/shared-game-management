# Agent Rules Index

Generated: 2026-10-07T00:00:00+13:00
Indexed: 6 rules (0 human-authored, 6 learned) | Rejected: 0 (unsafe) | Warnings: 0

## Validation Summary

### Health Check
- Total rules: 6
- Human-authored rules: 0
- Learned rules (auto-generated): 6
- Estimated max context: ~70 lines (OK; at most 4 rules match one file, e.g. an auth integration test)
- Conflicts detected: 0

### ⚠️ Warnings
None.

### 🚫 Rejected Rules (Unsafe)
None.

---

## Rules by File Pattern

| Pattern | Rule | Priority | Lines |
|---------|------|----------|-------|
| `memory-bank/tasks/*.md`, `memory-bank/techContext.md`, `memory-bank/systemPatterns.md` | [review-process-plan-claims.md](agent-rules/_learned/review-process-plan-claims.md) | low | 18 |
| `**/*.int.test.ts`, `apps/api/test/**` | [testing-integration-db-isolation.md](agent-rules/_learned/testing-integration-db-isolation.md) | low | 18 |
| `**/*.test.ts`, `**/*.int.test.ts`, `apps/api/test/**` | [testing-injected-clock.md](agent-rules/_learned/testing-injected-clock.md) | low | 16 |
| `apps/api/src/lib/jobs/**`, `apps/api/src/jobs/**` | [job-queues-pgboss.md](agent-rules/_learned/job-queues-pgboss.md) | low | 20 |
| `apps/api/src/modules/auth/**` | [auth-session-issuance.md](agent-rules/_learned/auth-session-issuance.md) | low | 17 |

## Rules by Path

| Path Contains | Rule | Priority | Lines |
|---------------|------|----------|-------|
| `memory-bank/` | [review-process-plan-claims.md](agent-rules/_learned/review-process-plan-claims.md) | low | 18 |
| `apps/api/test/` | [testing-integration-db-isolation.md](agent-rules/_learned/testing-integration-db-isolation.md) | low | 18 |
| `apps/api/test/`, `apps/api/src/modules/` | [testing-injected-clock.md](agent-rules/_learned/testing-injected-clock.md) | low | 16 |
| `yay-wt/` | [git-worktree-attached-head.md](agent-rules/_learned/git-worktree-attached-head.md) | low | 16 |
| `apps/api/src/lib/jobs/`, `apps/api/src/jobs/` | [job-queues-pgboss.md](agent-rules/_learned/job-queues-pgboss.md) | low | 20 |
| `apps/api/src/modules/auth/` | [auth-session-issuance.md](agent-rules/_learned/auth-session-issuance.md) | low | 17 |

## Rules by Topic

| Keywords | Rule | Priority |
|----------|------|----------|
| review, phase review, observability, documentation, plan, invariants, cross-phase | [review-process-plan-claims.md](agent-rules/_learned/review-process-plan-claims.md) | low |
| integration tests, postgres, isolation, concurrency, vitest | [testing-integration-db-isolation.md](agent-rules/_learned/testing-integration-db-isolation.md) | low |
| testing, clock, time, throttle, timestamps | [testing-injected-clock.md](agent-rules/_learned/testing-injected-clock.md) | low |
| git, worktree, build, commit, detached head | [git-worktree-attached-head.md](agent-rules/_learned/git-worktree-attached-head.md) | low |
| pg-boss, jobs, queue, retry, dedupe, worker, secrets, encryption | [job-queues-pgboss.md](agent-rules/_learned/job-queues-pgboss.md) | low |
| auth, sessions, concurrency, race condition, password reset, oauth | [auth-session-issuance.md](agent-rules/_learned/auth-session-issuance.md) | low |

---

## Conflict Resolutions

None.
