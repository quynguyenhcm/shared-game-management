---
version: next
status: planned
priority: high
complexity: 4
linked_tasks: []
created: 2026-09-29
---

# Session Scheduling Engine

Multi-court session setup, costing and recurrence (PRODDUCT-OVERVIEW §4; workflows §4).

- Recurring rules (weekly/fortnightly/monthly, optional `recur_until`); background worker materialises session + court instances
- Single-instance overrides (courts, capacity, times, rates) without breaking the series; rule edits must not overwrite overridden instances
- Session fields: location, full street address, date, cancellation deadline (default 48h before start), `max_players`, `reserved_seats`
- Multi-court fast setup: bulk default start/end times with per-court inline overrides
- Costing: suggested rate `ceil((total_court_cost + extra_expenses) / max_players)` shown in an editable field
- Pricing models: `FLAT`, `BY_SEX`, `BY_SKILL_LEVEL`
- Draft → Published → Completed/Cancelled lifecycle; auto-enroll members on materialisation

**Depends on**: team-banking-and-gst, skill-levels-and-auto-enroll

**Complexity rationale**: Recurrence engine + override semantics + background workers + complex admin UI; multiple creative phases → Level 4. (Evaluated via decision tree; accepted non-interactively per user request.)
