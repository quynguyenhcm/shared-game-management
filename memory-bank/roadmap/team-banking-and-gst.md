---
version: v1.0.0
status: planned
priority: high
complexity: 3
linked_tasks: []
created: 2026-09-29
---

# Team Banking and GST

Team merchant banking and tax settings (PRODDUCT-OVERVIEW §2, §8).

- Bank account name + NZ account number validation (`XX-XXXX-XXXXXXX-XX`, incl. bank/branch checks)
- Akahu merchant credentials, stored encrypted; `is_payout_configured` flag
- Gate: paid sessions can't be published until banking is configured
- GST settings: IRD number, GST registration number, GST-registered toggle (IRD number validation)

**Depends on**: team-management

**Complexity rationale**: Secure credential storage + external integration setup + publish gate across components → Level 3. (Evaluated via decision tree; accepted non-interactively per user request.)
