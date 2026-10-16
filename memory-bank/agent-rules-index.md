# Agent Rules Index

Generated: 2026-10-17T00:00:00+13:00
Indexed: 9 rules (0 human-authored, 9 learned) | Rejected: 0 (unsafe) | Warnings: 0

## Validation Summary

### Health Check
- Total rules: 9
- Human-authored rules: 0
- Learned rules (auto-generated): 9
- Estimated max context: ~100 lines (OK; at most 5 rules match one file, e.g. an API module `service.ts` or an integration test)
- Conflicts detected: 0

### ⚠️ Warnings
None.

### 🚫 Rejected Rules (Unsafe)
None.

---

## Rules by File Pattern

| Pattern | Rule | Priority | Lines |
|---------|------|----------|-------|
| `memory-bank/tasks/*.md`, `memory-bank/techContext.md`, `memory-bank/systemPatterns.md` | [review-process-plan-claims.md](agent-rules/_learned/review-process-plan-claims.md) | medium | 24 |
| `**/*.int.test.ts`, `apps/api/test/**` | [testing-integration-db-isolation.md](agent-rules/_learned/testing-integration-db-isolation.md) | low | 19 |
| `**/*.test.ts`, `**/*.int.test.ts`, `apps/api/test/**` | [testing-injected-clock.md](agent-rules/_learned/testing-injected-clock.md) | low | 17 |
| `apps/api/src/lib/logger/**`, `apps/api/src/**/*.ts`, `**/*.int.test.ts` | [logging-redaction-global.md](agent-rules/_learned/logging-redaction-global.md) | low | 17 |
| `apps/api/src/lib/jobs/**`, `apps/api/src/jobs/**` | [job-queues-pgboss.md](agent-rules/_learned/job-queues-pgboss.md) | low | 20 |
| `apps/api/src/modules/auth/**` | [auth-session-issuance.md](agent-rules/_learned/auth-session-issuance.md) | low | 17 |
| `apps/api/src/modules/**/service.ts`, `apps/api/src/modules/**/repo.ts`, `packages/shared/src/api/*.ts`, `apps/web/src/lib/**/*-actions.ts` | [api-write-idempotency.md](agent-rules/_learned/api-write-idempotency.md) | low | 19 |
| `db/migrations/*.sql`, `apps/api/src/modules/**/*.ts`, `apps/api/test/integration/**` | [db-derived-flags-and-gates.md](agent-rules/_learned/db-derived-flags-and-gates.md) | low | 19 |

## Rules by Path

| Path Contains | Rule | Priority | Lines |
|---------------|------|----------|-------|
| `memory-bank/` | [review-process-plan-claims.md](agent-rules/_learned/review-process-plan-claims.md) | medium | 24 |
| `apps/api/test/` | [testing-integration-db-isolation.md](agent-rules/_learned/testing-integration-db-isolation.md) | low | 19 |
| `apps/api/test/`, `apps/api/src/modules/` | [testing-injected-clock.md](agent-rules/_learned/testing-injected-clock.md) | low | 17 |
| `apps/api/src/lib/logger/`, `apps/api/src/modules/`, `apps/api/test/` | [logging-redaction-global.md](agent-rules/_learned/logging-redaction-global.md) | low | 17 |
| `yay-wt/` | [git-worktree-attached-head.md](agent-rules/_learned/git-worktree-attached-head.md) | low | 16 |
| `apps/api/src/lib/jobs/`, `apps/api/src/jobs/` | [job-queues-pgboss.md](agent-rules/_learned/job-queues-pgboss.md) | low | 20 |
| `apps/api/src/modules/auth/` | [auth-session-issuance.md](agent-rules/_learned/auth-session-issuance.md) | low | 17 |
| `apps/api/src/modules/`, `packages/shared/src/api/`, `apps/web/src/lib/` | [api-write-idempotency.md](agent-rules/_learned/api-write-idempotency.md) | low | 19 |
| `db/migrations/`, `apps/api/src/modules/`, `apps/api/test/integration/` | [db-derived-flags-and-gates.md](agent-rules/_learned/db-derived-flags-and-gates.md) | low | 19 |

## Rules by Topic

| Keywords | Rule | Priority |
|----------|------|----------|
| review, phase review, observability, documentation, plan, invariants, cross-phase, cross-feature, creative, critique, idempotency, replay, reconciliation | [review-process-plan-claims.md](agent-rules/_learned/review-process-plan-claims.md) | medium |
| integration tests, postgres, isolation, concurrency, vitest | [testing-integration-db-isolation.md](agent-rules/_learned/testing-integration-db-isolation.md) | low |
| testing, clock, time, throttle, timestamps, flaky, timeouts, DST | [testing-injected-clock.md](agent-rules/_learned/testing-injected-clock.md) | low |
| logging, redaction, observability, pino, testing, cross-feature | [logging-redaction-global.md](agent-rules/_learned/logging-redaction-global.md) | low |
| git, worktree, build, commit, detached head | [git-worktree-attached-head.md](agent-rules/_learned/git-worktree-attached-head.md) | low |
| pg-boss, jobs, queue, retry, dedupe, worker, secrets, encryption | [job-queues-pgboss.md](agent-rules/_learned/job-queues-pgboss.md) | low |
| auth, sessions, concurrency, race condition, password reset, oauth | [auth-session-issuance.md](agent-rules/_learned/auth-session-issuance.md) | low |
| idempotency, replay, api design, server actions, contracts | [api-write-idempotency.md](agent-rules/_learned/api-write-idempotency.md) | low |
| postgres, generated columns, triggers, gates, locking, migrations, invariants | [db-derived-flags-and-gates.md](agent-rules/_learned/db-derived-flags-and-gates.md) | low |

---

## Conflict Resolutions

None.
