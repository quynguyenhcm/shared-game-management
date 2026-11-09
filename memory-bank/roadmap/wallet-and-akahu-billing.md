---
version: v1.0.0
status: planned
priority: high
complexity: 4
linked_tasks: [wallet-and-akahu-billing]
created: 2026-09-29
---

# Wallet and Akahu Billing

Prepaid wallet, post-game billing and payment collection via Akahu (PRODDUCT-OVERVIEW §7; workflows §3).

- Wallet per (player, team); top-up via Akahu direct payment; balance capped at $100.00 NZD
- Akahu routes every payment to the team's configured bank account; webhook handling (idempotent, signature-verified)
- Post-game engine at MAX(court end_time): session → COMPLETED; for each confirmed registration compute the fee (pricing model + guests), deduct from the wallet if the balance covers it (`PAID`, `PREPAID_CREDIT`), otherwise create an Akahu payment link due in 3 days
- Low-credit reminder when the balance drops below $20.00 after a deduction
- Daily cron: unpaid → `OVERDUE` after 3 days, plus reminder notifications
- Manual "send reminder" action for team/global admins
- Wallet ledger (`credit_transactions`) with resulting balances; reconciliation

**Depends on**: registration-and-waitlist

**Complexity rationale**: External payment integration, webhooks, scheduled jobs and a financial ledger; system-wide money flows → Level 4. (Evaluated via decision tree; accepted non-interactively per user request.)
