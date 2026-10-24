---
name: Wire config-derived values explicitly at the composition root
globs: ["apps/api/src/app.ts", "apps/api/src/main.ts", "apps/api/src/worker.ts", "apps/api/src/jobs/bootstrap.ts", "apps/web/src/lib/**/*.ts"]
paths: ["apps/api/src/", "apps/web/src/lib/"]
topics: ["config", "12-factor", "composition root", "dependency injection", "defaults", "environment"]
priority: low
auto_generated: true
derived_from: [session-scheduling-engine]
evidence_count: 1
last_validated: 2026-10-24
---

# No silent defaults for config-derived values

- Make every config-derived value a required field on `AppDeps` / `RegisterJobsOptions`, and pass it from `config` in `main.ts` and `worker.ts`. Don't add `?? <literal>` fallbacks in `buildApp` or bootstrap. A new entrypoint that forgets the value should fail to compile, not quietly use a dev value. In session-scheduling-engine, Phase 3 shipped `webBaseUrl ?? 'http://localhost:3000'`, and `recurrenceHorizonDays` still defaults to 28 in `AppDeps`.
- The web app never copies a server config value as a constant. It reads the value from the API response that owns it, the way `horizonDays` comes from the series reads. In session-scheduling-engine, the web hard-coded a 28-day horizon while `RECURRENCE_HORIZON_DAYS` can be set from 7 to 91 (Phase 5 HALT).
