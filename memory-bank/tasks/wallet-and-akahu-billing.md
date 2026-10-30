---
slug: wallet-and-akahu-billing
feature: wallet-and-akahu-billing
status: INITIALIZED
---

# wallet-and-akahu-billing: Wallet and Akahu Billing

**Complexity**: Level 4
**Status**: INITIALIZED
**Roadmap**: wallet-and-akahu-billing
**Branch**: feature/wallet-and-akahu-billing
**Worktree**: ~/yay-wt/shared-game-management/feature-wallet-and-akahu-billing

## Task Description

Prepaid wallet, post-game billing and payment collection via Akahu (PRODDUCT-OVERVIEW §7; workflows §3).

- Wallet per (player, team); top-up via Akahu direct payment; balance capped at $100.00 NZD
- Akahu routes every payment to the team's configured bank account; webhook handling (idempotent, signature-verified)
- Post-game engine at MAX(court end_time): session → COMPLETED; for each confirmed registration compute the fee (pricing model + guests), deduct from the wallet if the balance covers it (`PAID`, `PREPAID_CREDIT`), otherwise create an Akahu payment link due in 3 days
- Low-credit reminder when the balance drops below $20.00 after a deduction
- Daily cron: unpaid → `OVERDUE` after 3 days, plus reminder notifications
- Manual "send reminder" action for team/global admins
- Wallet ledger (`credit_transactions`) with resulting balances; reconciliation

**Depends on**: registration-and-waitlist (merged 2026-10-30, PR #8)

---

## Execution State

**Build Status**: RUNNING
**Current Phase**: PLAN
**Current Step**: Planning in progress
**Can Resume**: YES

### Active Sub-Agents
(none)

### Completed Steps
- Step 0.1 - Task auto-provisioned from roadmap feature (2026-10-30)
