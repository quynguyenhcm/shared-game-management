---
slug: registration-and-waitlist
legacy_id:
feature: registration-and-waitlist
status: INITIALIZED
---

# registration-and-waitlist: Registration and Waitlist

**Complexity**: Level 4 (inherited from registration-and-waitlist)
**Status**: INITIALIZED
**Roadmap**: registration-and-waitlist
**Branch**: feature/registration-and-waitlist
**Worktree**: N/A (main checkout)

## Task Description

Registration, FIFO waitlist, debt control and cancellation rules (PRODDUCT-OVERVIEW §5, §6; workflows §1, §2).

- Public capacity = `max_players - reserved_seats`
- Up to 2 guests per registrant; the group is confirmed or waitlisted together
- FIFO waitlist with sequential `queue_position`; auto-promote when seats free up. Define how a group that doesn't fit is handled (skip or block).
- Debt gate: block registration when the user has 3 or more `OVERDUE` payments
- Cancellation: before the deadline → `WITHDRAWN`, $0, promote; after the deadline → `WITHDRAWN`. If someone is waitlisted, promote them and they take the fee; if not, charge the withdrawing player.
  - NOTE: the overview's §6 wording has the 48h windows reversed; the workflows doc (`NOW <= deadline` → free) is authoritative.
- Concurrency safety (row locks / serializable transactions) for seat allocation and promotion

**Depends on**: session-scheduling-engine (NOT yet built: no code creates or publishes `game_sessions`), team-management (merged in PR #4).

**Obligations inherited from team-management (ADR 0015, binding)**:
- Call `assertApprovedMember(trx, teamId, userId)` inside the registration transaction, before any `game_sessions` lock (lock order `teams → team_members → game_sessions → registrations`).
- Replace the no-op `MemberBannedHandler` with the real one: withdraw a banned member's CONFIRMED/WAITLISTED registrations in the team's future PUBLISHED sessions as an early withdrawal (no fee, no payment row), one session per transaction under the D-14 session lock, then normal FIFO promotion; no notification to the banned player; `NonRetryableJobError` for permanent failures.
- Ship the reconciliation sweep that re-enqueues `member-banned` for BANNED members who still hold active registrations (covers bans the no-op handled and permanently failed jobs).
- Restore cancellation wording in the ban confirmation once the real handler ships.

**Build gate**: `/yay:build` is held until session-scheduling-engine is merged (decision 2026-10-14: plan and creative now, build later).

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
**Step Started**: 2026-10-14
**Can Resume**: YES

### Active Sub-Agents
- Spec Writer Agent (opus)

### Completed Steps
- Step 0.1: Task provisioned on feature/registration-and-waitlist
