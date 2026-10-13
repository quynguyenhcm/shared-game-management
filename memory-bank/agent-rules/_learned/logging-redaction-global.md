---
name: Global log redaction keys and log-field assertions
globs: ["apps/api/src/lib/logger/**", "apps/api/src/**/*.ts", "**/*.int.test.ts"]
paths: ["apps/api/src/lib/logger/", "apps/api/src/modules/", "apps/api/test/"]
topics: ["logging", "redaction", "observability", "pino", "testing", "cross-feature"]
priority: low
auto_generated: true
derived_from: [team-management]
evidence_count: 1
last_validated: 2026-10-13
---

# Redaction keys are global

- A redaction key added to `apps/api/src/lib/logger/logger.ts` applies to every log line in every feature. Before adding one, grep all `log.*`/`logger.*` calls and log assertions across the repo for that field name, and rename harmless colliding fields (log error codes as `errorCode`, never `code`). In team-management, the exact-`code` key for invite codes silently redacted the shipped auth feature's `auth.oauth.link_conflict` error codes, and only the final review caught it.
- When a test covers a log event whose payload matters to operators, assert the logged fields, not only that the event fired. An event-presence assertion let the redaction regression through.
