---
slug: player-dashboard
feature: player-dashboard
status: INITIALIZED
---

# player-dashboard: Player Dashboard

**Complexity**: Level 2
**Status**: INITIALIZED
**Roadmap**: player-dashboard
**Branch**: feature/player-dashboard
**Worktree**: /Users/admin/yay-wt/shared-game-management/feature-player-dashboard

## Task Description

Player-facing three-tab dashboard (PRODUCT-OVERVIEW §3).

1. **Currently Opening**: upcoming published sessions across joined teams (team, court schedule, address, rate, seats left, Register button)
2. **My Registration**: DateTime, payment status (`PAID`/`PENDING`/`OVERDUE`), team, address, total fee
3. **Payments & Wallet**: balance per team + Top Up Credit (max $100), accordions Overdue/Pending/Paid with Akahu links and PDF invoice downloads

**Depends on**: wallet-and-akahu-billing (Phases 1-6 merged in PR #9; live Akahu, Phase 4b, is not live yet), tax-invoices-and-exports (merged in PR #10: PDF downloads).

**Complexity rationale**: UI composition over APIs delivered by earlier features; clear requirements, few design decisions → Level 2.

---

## Execution State

**Build Status**: RUNNING
**Current Phase**: PLAN
**Current Step**: Step 0.1 - Task created
**Can Resume**: YES

### Active Sub-Agents
(none)

### Completed Steps
(none)
