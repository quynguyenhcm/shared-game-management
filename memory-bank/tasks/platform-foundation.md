---
slug: platform-foundation
legacy_id:            # only set by the v2 migration for pre-2.0 tasks (e.g., TASK-007)
feature: platform-foundation
status: INITIALIZED
---

# platform-foundation: Platform Foundation

**Complexity**: Level 4 (inherited from platform-foundation)
**Status**: INITIALIZED
**Roadmap**: platform-foundation
**Branch**: feature/platform-foundation
**Worktree**: N/A (primary checkout)

## Task Description

Scaffold the repo and shared infrastructure every other feature builds on.

- Monorepo layout: Next.js + Tailwind web app, API service, shared types
- **Decide backend**: Node (Express/NestJS) or Python (FastAPI)
- PostgreSQL 15 migrations based on `database-design.md`, fixing the gaps it has against the spec:
  - auth identities table (password hash, Google/Facebook provider IDs)
  - `payments.team_id` (routing, GST, exports) and a per-payment fee snapshot
  - guest attributes (sex, skill level) so BY_SEX and BY_SKILL_LEVEL pricing can apply to guests
  - `UNIQUE(session_id, user_id)` on registrations; unique invoice number sequence per team
  - Akahu credentials and bank details encrypted at rest
- Background job runner / scheduler (recurrence, post-game billing, daily overdue cron)
- Email/notification service abstraction
- Money handling (DECIMAL / integer cents), Pacific/Auckland timezone handling
- Test harness, lint, CI pipeline, local dev via Docker Compose

Source specs: `PRODDUCT-OVERVIEW.md`, `database-design.md`, `workflows_state_machine_architecture.md` (repo root, untracked).

## User Journey Definition

**Feature Type**: [End-User Feature | NFR/Infrastructure]
**Creative Phase Required**: [Yes - Type | No]

### Invocation Method (End-User Features)
- **Location**: [exact page/screen/component]
- **Element**: [exact button/link/command]
- **Visibility**: [always visible | conditional]
- **Navigation**: [steps from entry to feature]

### Success Criteria (End-User Features)
- **User sees**: [exact message/screen/feedback]
- **User can verify at**: [exact location]
- **Data persisted**: [what and where]
- **Observable within**: [timeframe]

### NFR Verification (Infrastructure Features)
- **Test method**: [exact command/tool]
- **Success metrics**: [specific thresholds]
- **Observable at**: [dashboard/log location]

### Acceptance Criteria
- AC-ENTRY-1: [user can find the feature]
- AC-HAPPY-1: [user completes primary journey]
- AC-ERROR-1: [error handling]

## Test Strategy

### Approach
- **Emphasis**: [unit | integration | E2E | balanced — override systemPatterns.md default if needed]
- **Target test count**: [N total across all phases — justify if >20]

### File Organization
- **New test files**: [list files to create and what they cover]
- **Extend existing**: [list existing test files to add tests to, rather than creating new ones]

### What NOT to Test
- [Thing] — [reason: covered by type system / existing tests / framework / out of scope]

### Per-Phase Test Guidance
- Phase 1: [N tests — what behaviors to verify]
- Phase 2: [N tests — what behaviors to verify]

## Implementation Roadmap

### New Source Files (pin path + extension)
<!--
  Pin EVERY new source file (incl. hooks/utils/types — not just components) with
  its explicit path AND extension, resolved from systemPatterns.md → Code
  Organization Patterns / techContext.md → Source extensions. This removes the
  extension from being an ad-hoc build-time guess. Use "extend" for files modified.
-->
- [ ] [e.g., `frontend/src/hooks/useFeedbackSubmitMutation.ts` — submit mutation hook]
- [ ] [e.g., `frontend/src/components/FeedbackWidget.tsx` — widget]

### Phases
- [ ] Phase 1: [phase name]
- [ ] Phase 2: [phase name]

## Creative Phases

- [ ] [Architecture | User Journey | UI/UX | Algorithm] design → pending

---

## Execution State

**Build Status**: IDLE
**Last Completed**: N/A
**Can Resume**: NO

### Active Sub-Agents
(none)

### Completed Steps
(none)
