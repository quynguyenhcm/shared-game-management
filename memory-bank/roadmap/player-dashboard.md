---
version: next
status: planned
priority: medium
complexity: 2
linked_tasks: []
created: 2026-09-29
---

# Player Dashboard

Player-facing three-tab dashboard (PRODDUCT-OVERVIEW §3).

1. **Currently Opening**: upcoming published sessions across joined teams (team, court schedule, address, rate, seats left, Register button)
2. **My Registration**: DateTime, payment status (`PAID`/`PENDING`/`OVERDUE`), team, address, total fee
3. **Payments & Wallet**: balance per team + Top Up Credit (max $100), accordions Overdue/Pending/Paid with Akahu links and PDF invoice downloads

**Depends on**: wallet-and-akahu-billing

**Complexity rationale**: UI composition over APIs delivered by earlier features; clear requirements, few design decisions → Level 2. (Evaluated via decision tree; accepted non-interactively per user request.)
