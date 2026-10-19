---
slug: session-scheduling-engine
feature: session-scheduling-engine
status: INITIALIZED
---

# session-scheduling-engine: Session Scheduling Engine

**Complexity**: Level 4
**Status**: INITIALIZED
**Roadmap**: session-scheduling-engine
**Branch**: feature/session-scheduling-engine
**Worktree**: ~/yay-wt/shared-game-management/session-scheduling-engine

## Task Description

Multi-court session setup, costing and recurrence (PRODDUCT-OVERVIEW §4; workflows §4).

- Recurring rules (weekly/fortnightly/monthly, optional `recur_until`); background worker materialises session + court instances
- Single-instance overrides (courts, capacity, times, rates) without breaking the series; rule edits must not overwrite overridden instances
- Session fields: location, full street address, date, cancellation deadline (default 48h before start), `max_players`, `reserved_seats`
- Multi-court fast setup: bulk default start/end times with per-court inline overrides
- Costing: suggested rate `ceil((total_court_cost + extra_expenses) / max_players)` shown in an editable field
- Pricing models: `FLAT`, `BY_SEX`, `BY_SKILL_LEVEL`
- Draft → Published → Completed/Cancelled lifecycle; auto-enroll members on materialisation

**Depends on**: team-banking-and-gst (merged), skill-levels-and-auto-enroll (merged)

**Downstream contracts already handed to this feature** (must be honoured by the spec):
- registration-and-waitlist (in flight, `feature/registration-and-waitlist`): C-SSE-1..5 in `creative/registration-and-waitlist-allocator-architecture.md`; slot contract and page-ownership split in `creative/registration-and-waitlist-registration-user-journey.md` (admin surfaces under `/teams/[teamId]/manage/sessions` belong here; the player session page belongs to registration)
- team-banking-and-gst: publish gate and recurrence materialiser contract (ADR 0016, `creative/team-banking-and-gst-banking-architecture.md`)
- skill-levels-and-auto-enroll: auto-enrol obligations (ADR 0017)
- platform-foundation: `fee_other` default `LEAST(fee_male, fee_female)` for BY_SEX, DST input policy, `recurrence-materialisation` cron job slot (`creative/platform-foundation-algorithm.md`, `-architecture.md`)

**Complexity rationale**: Recurrence engine + override semantics + background workers + complex admin UI; multiple creative phases → Level 4.

## Execution State

**Build Status**: IDLE
**Last Completed**: N/A
**Can Resume**: NO

### Active Sub-Agents
(none)

### Completed Steps
(none)
