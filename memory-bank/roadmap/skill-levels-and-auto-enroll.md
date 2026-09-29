---
version: v1.0.0
status: planned
priority: medium
complexity: 3
linked_tasks: []
created: 2026-09-29
---

# Skill Levels and Auto Enroll

Member skill management and auto-enrollment (PRODDUCT-OVERVIEW §2).

- Admin manual skill override (records who/when)
- Auto-progression: 40 games for a team in the trailing 365 days moves the member up a level (`BEGINNER` → `INTERMEDIATE` → `ADVANCED`). Define what counts as a "game" (confirmed + completed session) and how admin overrides interact.
- Auto Enroll flag with optional `auto_enroll_until`; consumed by the session materialiser (order by auto-enroll assignment date)

**Depends on**: team-management

**Complexity rationale**: Requires rule design (game counting, override precedence) and touches membership + scheduling → Level 3. (Evaluated via decision tree; accepted non-interactively per user request.)
