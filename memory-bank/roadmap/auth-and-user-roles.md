---
version: v1.0.0
status: planned
priority: high
complexity: 3
linked_tasks: [auth-and-user-roles]
created: 2026-09-29
---

# Auth and User Roles

Self-registration and sign-in with email/password, Google OAuth and Facebook OAuth (PRODDUCT-OVERVIEW §1).

- Required sex selection (`MALE`, `FEMALE`, `OTHER`) at registration, including for first-time OAuth users
- Global roles `GLOBAL_ADMIN`, `PLAYER`; `TEAM_ADMIN` is scoped per team via team membership
- Session management, password reset, route/API authorization guards (global role + per-team role)

**Depends on**: platform-foundation

**Complexity rationale**: Design decisions (auth library, OAuth account linking, RBAC model) across web and API; not system-wide → Level 3. (Evaluated via decision tree; accepted non-interactively per user request.)
