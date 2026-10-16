---
slug: team-banking-and-gst
legacy_id:
feature: team-banking-and-gst
status: INITIALIZED
---

# team-banking-and-gst: Team Banking and GST

**Complexity**: Level 3 (inherited from team-banking-and-gst)
**Status**: INITIALIZED
**Roadmap**: team-banking-and-gst
**Branch**: feature/team-banking-and-gst
**Worktree**: N/A (main checkout)

## Task Description

Team merchant banking and tax settings (PRODDUCT-OVERVIEW §2, §8).

- Bank account name + NZ account number validation (`XX-XXXX-XXXXXXX-XX`, incl. bank/branch checks)
- Akahu merchant credentials, stored encrypted; `is_payout_configured` flag
- Gate: paid sessions can't be published until banking is configured
- GST settings: IRD number, GST registration number, GST-registered toggle (IRD number validation)

**Depends on**: team-management (merged in PR #4).

**Downstream**: session-scheduling-engine (consumes the publish gate), wallet-and-akahu-billing (consumes the Akahu credentials and GST snapshot per ADR 0012), tax-invoices-and-exports (GST/IRD details on invoices). registration-and-waitlist is planned and designed but gated on session-scheduling-engine.

## Test Strategy

(filled at Step 5)

## Implementation Roadmap

(filled at Step 5)

## Creative Phases

(filled at Step 6)

---

## Execution State

**Build Status**: RUNNING
**Current Phase**: PLAN
**Current Step**: Planning in progress
**Can Resume**: YES

### Active Sub-Agents
(none)

### Completed Steps
- Step 0.1: Task provisioned on feature/team-banking-and-gst
