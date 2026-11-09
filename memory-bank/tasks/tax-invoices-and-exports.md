---
slug: tax-invoices-and-exports
feature: tax-invoices-and-exports
status: INITIALIZED
---

# tax-invoices-and-exports: Tax Invoices and Exports

**Complexity**: Level 3
**Status**: INITIALIZED
**Roadmap**: tax-invoices-and-exports
**Branch**: feature/tax-invoices-and-exports
**Worktree**: /Users/admin/yay-wt/shared-game-management/feature-tax-invoices-and-exports

## Task Description

NZ GST compliance outputs (PRODUCT-OVERVIEW §8), from roadmap feature `tax-invoices-and-exports` (v1.0.0, Level 3):

- GST split for GST-registered teams: `GST = Total * 3 / 23`, stored per payment (subtotal + GST)
- PDF tax invoices/receipts with team IRD/GST numbers, sequential invoice numbers and the GST breakdown (per IRD taxable supply information rules)
- CSV/Excel income exports: custom date range, GST bi-monthly periods, and the NZ financial year (Apr 1 – Mar 31)

**Depends on**: wallet-and-akahu-billing (Phases 1-6 merged to main in PR #9, 2026-11-09; Akahu live adapter, Phase 4b, still gated, so payments run on the fake adapter in dev and E2E).

**Complexity rationale**: PDF generation + export formats + tax rule correctness across billing and admin UI → Level 3.

## Test Strategy

(filled at Step 5)

## Implementation Roadmap

(filled at Step 5)

## Creative Phases

(decided at Step 3.3)

---

## Execution State

**Build Status**: RUNNING
**Current Phase**: PLAN
**Current Step**: Planning in progress
**Last Completed**: N/A
**Can Resume**: YES

### Active Sub-Agents
(none)

### Completed Steps
- Step 0.1: task provisioned from roadmap feature (2026-11-10)
