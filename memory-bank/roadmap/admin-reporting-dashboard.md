---
version: v1.0.0
status: planned
priority: medium
complexity: 2
linked_tasks: []
created: 2026-09-29
---

# Admin Reporting Dashboard

Master view of all player registrations across sessions for team/global admins (PRODDUCT-OVERVIEW §9).

- Filter by date range and payment status (`PAID`/`PENDING`/`OVERDUE`); search by player name/email; sortable columns
- Server-side pagination; scoped to the admin's teams (global admins see all)
- Row action: send payment reminder (reuses wallet-and-akahu-billing)

**Depends on**: wallet-and-akahu-billing

**Complexity rationale**: Clear requirements, standard filter/sort table over existing data → Level 2. (Evaluated via decision tree; accepted non-interactively per user request.)
