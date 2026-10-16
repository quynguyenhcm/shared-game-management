---
slug: skill-levels-and-auto-enroll
legacy_id:
feature: skill-levels-and-auto-enroll
status: INITIALIZED
---

# skill-levels-and-auto-enroll: Skill Levels and Auto Enroll

**Complexity**: Level 3 (inherited from skill-levels-and-auto-enroll)
**Status**: INITIALIZED
**Roadmap**: skill-levels-and-auto-enroll
**Branch**: feature/skill-levels-and-auto-enroll
**Worktree**: N/A (main checkout)

## Task Description

Member skill management and auto-enrollment (PRODDUCT-OVERVIEW §2).

- Admin manual skill override (records who/when)
- Auto-progression: 40 games for a team in the trailing 365 days moves the member up a level (`BEGINNER` → `INTERMEDIATE` → `ADVANCED`). Define what counts as a "game" (confirmed + completed session) and how admin overrides interact.
- Auto Enroll flag with optional `auto_enroll_until`; consumed by the session materialiser (order by auto-enroll assignment date)

**Depends on**: team-management (COMPLETE)

**Related in-flight / planned work**: `session-scheduling-engine` (planned, owns the session materialiser that consumes Auto Enroll) and `registration-and-waitlist` (in flight, CREATIVE_COMPLETE, owns registration/attendance state that defines a "game").

## Test Strategy

_(filled during planning)_

## Implementation Roadmap

_(filled during planning)_

## Creative Phases

_(filled during planning)_

---

## Execution State

**Build Status**: RUNNING
**Current Phase**: PLAN
**Current Step**: Step 3 - Spec Writer Agent - RUNNING
**Step Started**: 2026-10-17
**Can Resume**: YES

### Active Sub-Agents
(none)

### Completed Steps
- Step 0.1: Task provisioned from roadmap feature
