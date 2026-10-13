---
version: v1.0.0
status: planned
priority: high
complexity: 3
linked_tasks: [team-management]
created: 2026-09-29
---

# Team Management

Team creation, discovery, membership and moderation (PRODDUCT-OVERVIEW §2).

- Any user can create a team (name, description, `PUBLIC`/`PRIVATE`); creator becomes `TEAM_ADMIN`
- "Find a Team" search page `/teams/find` (public teams only)
- Private teams via invite link `/teams/join?code=XYZ` (unique token, regenerable)
- Join request requires a self-assessed skill level → `PENDING`; admin approve/reject
- Promote/demote team admins
- Ban member (`BANNED`): revokes access, blocks future registrations, cancels active registrations and triggers waitlist promotion (hook into registration-and-waitlist). A team admin can't be banned until they are demoted.

**Depends on**: auth-and-user-roles

**Complexity rationale**: Multiple components (UI, API, membership state machine) with design decisions → Level 3. (Evaluated via decision tree; accepted non-interactively per user request.)
