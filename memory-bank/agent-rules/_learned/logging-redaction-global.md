---
name: Global log redaction keys and log-field assertions
globs: ["apps/api/src/lib/logger/**", "apps/api/src/**/*.ts", "**/*.int.test.ts"]
paths: ["apps/api/src/lib/logger/", "apps/api/src/modules/", "apps/api/test/"]
topics: ["logging", "redaction", "observability", "pino", "testing", "cross-feature"]
priority: low
auto_generated: true
derived_from: [team-management, team-banking-and-gst]
evidence_count: 2
last_validated: 2026-10-17
---

# Redaction keys are global

- A redaction key added to `apps/api/src/lib/logger/logger.ts` applies to every log line in every feature. Before adding one, grep all `log.*`/`logger.*` calls and log assertions across the repo for that field name, and rename harmless colliding fields (log error codes as `errorCode`, never `code`). In team-management, the exact-`code` key for invite codes silently redacted the shipped auth feature's `auth.oauth.link_conflict` error codes, and only the final review caught it.
- When a test covers a log event whose payload matters to operators, assert the logged fields, not only that the event fired. An event-presence assertion let the redaction regression through.
- Prefer anchored patterns (`/^(bank_?)?account_?(name|number)$/i`) over prefixes, and check new log field names against the existing suffix rules: a planned `replacedAkahuAppToken` would have been hidden by `/token$/`, so team-banking-and-gst logged `changedFields` instead. The collision grep before adding the pattern found nothing, and there was no regression.
