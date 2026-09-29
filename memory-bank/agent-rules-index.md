# Agent Rules Index

Generated: 2026-09-30T00:00:00+13:00
Indexed: 4 rules (0 human-authored, 4 learned) | Rejected: 0 (unsafe) | Warnings: 0

## Validation Summary

### Health Check
- Total rules: 4
- Human-authored rules: 0
- Learned rules (auto-generated): 4
- Estimated max context: ~60 lines (OK)
- Conflicts detected: 0

### ⚠️ Warnings
None.

### 🚫 Rejected Rules (Unsafe)
None.

---

## Rules by File Pattern

| Pattern | Rule | Priority | Lines |
|---------|------|----------|-------|
| `memory-bank/tasks/*.md`, `memory-bank/techContext.md`, `memory-bank/systemPatterns.md` | [review-process-plan-claims.md](agent-rules/_learned/review-process-plan-claims.md) | low | 17 |
| `**/*.int.test.ts`, `apps/api/test/**` | [testing-integration-db-isolation.md](agent-rules/_learned/testing-integration-db-isolation.md) | low | 18 |
| `apps/api/src/lib/jobs/**`, `apps/api/src/jobs/**` | [job-queues-pgboss.md](agent-rules/_learned/job-queues-pgboss.md) | low | 19 |

## Rules by Path

| Path Contains | Rule | Priority | Lines |
|---------------|------|----------|-------|
| `memory-bank/` | [review-process-plan-claims.md](agent-rules/_learned/review-process-plan-claims.md) | low | 17 |
| `apps/api/test/` | [testing-integration-db-isolation.md](agent-rules/_learned/testing-integration-db-isolation.md) | low | 18 |
| `yay-wt/` | [git-worktree-attached-head.md](agent-rules/_learned/git-worktree-attached-head.md) | low | 15 |
| `apps/api/src/lib/jobs/`, `apps/api/src/jobs/` | [job-queues-pgboss.md](agent-rules/_learned/job-queues-pgboss.md) | low | 19 |

## Rules by Topic

| Keywords | Rule | Priority |
|----------|------|----------|
| review, phase review, observability, documentation, plan | [review-process-plan-claims.md](agent-rules/_learned/review-process-plan-claims.md) | low |
| integration tests, postgres, isolation, concurrency, vitest | [testing-integration-db-isolation.md](agent-rules/_learned/testing-integration-db-isolation.md) | low |
| git, worktree, build, commit, detached head | [git-worktree-attached-head.md](agent-rules/_learned/git-worktree-attached-head.md) | low |
| pg-boss, jobs, queue, retry, dedupe, worker | [job-queues-pgboss.md](agent-rules/_learned/job-queues-pgboss.md) | low |

---

## Conflict Resolutions

None.
