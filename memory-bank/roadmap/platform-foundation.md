---
version: v1.0.0
status: complete
priority: high
complexity: 4
linked_tasks: [platform-foundation]
created: 2026-09-29
---

# Platform Foundation

Scaffold the repo and shared infrastructure every other feature builds on.

- Monorepo layout: Next.js + Tailwind web app, API service, shared types
- **Decide backend**: Node (Express/NestJS) or Python (FastAPI)
- PostgreSQL 17 migrations based on `database-design.md`, fixing the gaps it has against the spec:
  - auth identities table (password hash, Google/Facebook provider IDs)
  - `payments.team_id` (routing, GST, exports) and a per-payment fee snapshot
  - guest attributes (sex, skill level) so BY_SEX and BY_SKILL_LEVEL pricing can apply to guests
  - `UNIQUE(session_id, user_id)` on registrations; unique invoice number sequence per team
  - Akahu credentials and bank details encrypted at rest
- Background job runner / scheduler (recurrence, post-game billing, daily overdue cron)
- Email/notification service abstraction
- Money handling (DECIMAL / integer cents), Pacific/Auckland timezone handling
- Test harness, lint, CI pipeline, local dev via Docker Compose

**Complexity rationale**: System-wide foundation (stack choice, schema, job runner, CI) with multiple design decisions → Q5 yes. (Evaluated via decision tree; accepted non-interactively per user request.)
