---
slug: team-management
legacy_id:
feature: team-management
status: INITIALIZED
---

# team-management: Team Management

**Complexity**: Level 3 (inherited from team-management)
**Status**: INITIALIZED
**Roadmap**: team-management
**Branch**: feature/team-management
**Worktree**: N/A (main checkout)

## Task Description

Team creation, discovery, membership and moderation (PRODDUCT-OVERVIEW §2).

- Any user can create a team (name, description, `PUBLIC`/`PRIVATE`); creator becomes `TEAM_ADMIN`
- "Find a Team" search page `/teams/find` (public teams only)
- Private teams via invite link `/teams/join?code=XYZ` (unique token, regenerable)
- Join request requires a self-assessed skill level → `PENDING`; admin approve/reject
- Promote/demote team admins
- Ban member (`BANNED`): revokes access, blocks future registrations, cancels active registrations and triggers waitlist promotion (hook into registration-and-waitlist). A team admin can't be banned until they are demoted.

**Depends on**: auth-and-user-roles

## Test Strategy

(filled during planning)

## Implementation Roadmap

(filled during planning)

## Creative Phases

(filled during planning)

---

## Execution State

**Build Status**: RUNNING
**Current Phase**: PLAN
**Current Step**: Step 3 - Spec Writer Agent - RUNNING
**Step Started**: 2026-10-13
**Can Resume**: YES

### Active Sub-Agents
- Spec Writer Agent (sonnet)

### Completed Steps
- Step 0.1: Task provisioned on feature/team-management
