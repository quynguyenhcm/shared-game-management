---
version: v1.0.0
status: planned
priority: medium
complexity: 3
linked_tasks: []
created: 2026-09-29
---

# Tax Invoices and Exports

NZ GST compliance outputs (PRODDUCT-OVERVIEW §8).

- GST split for GST-registered teams: `GST = Total * 3 / 23`, stored per payment (subtotal + GST)
- PDF tax invoices/receipts with team IRD/GST numbers, sequential invoice numbers and the GST breakdown (per IRD taxable supply information rules)
- CSV/Excel income exports: custom date range, GST bi-monthly periods, and the NZ financial year (Apr 1 – Mar 31)

**Depends on**: wallet-and-akahu-billing

**Complexity rationale**: PDF generation + export formats + tax rule correctness across billing and admin UI → Level 3. (Evaluated via decision tree; accepted non-interactively per user request.)
