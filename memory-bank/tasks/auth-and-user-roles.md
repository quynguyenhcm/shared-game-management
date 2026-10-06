---
slug: auth-and-user-roles
legacy_id:
feature: auth-and-user-roles
status: INITIALIZED
---

# auth-and-user-roles: Auth and User Roles

**Complexity**: Level 3 (inherited from auth-and-user-roles)
**Status**: INITIALIZED
**Roadmap**: auth-and-user-roles
**Branch**: feature/auth-and-user-roles
**Worktree**: ~/yay-wt/shared-game-management/feature-auth-and-user-roles
**Base**: feature/platform-foundation (stacked; origin/main is still at the initial commit because GitHub push is blocked with a 403)

## Task Description

Self-registration and sign-in with email/password, Google OAuth and Facebook OAuth (PRODDUCT-OVERVIEW §1).

- Required sex selection (`MALE`, `FEMALE`, `OTHER`) at registration, including for first-time OAuth users
- Global roles `GLOBAL_ADMIN`, `PLAYER`; `TEAM_ADMIN` is scoped per team via team membership
- Session management, password reset, route/API authorization guards (global role + per-team role)

**Depends on**: platform-foundation

---

## Execution State

**Build Status**: RUNNING
**Current Phase**: PLAN
**Current Step**: Planning in progress
**Can Resume**: NO

### Deviations
- Plan | branch base | `feature/auth-and-user-roles` is stacked on `feature/platform-foundation` (63dbc43), not `origin/main`, because origin/main has only the initial commit (push blocked with a 403). Rebase onto main once platform-foundation merges.

### Active Sub-Agents
(none)

### Completed Steps
(none)
