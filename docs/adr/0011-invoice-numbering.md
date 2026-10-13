# ADR 0011: Invoice numbering

- Status: Accepted (2026-09-29)
- Task: platform-foundation
- Source: [algorithm Q9](../../memory-bank/creative/platform-foundation-algorithm.md)

## Context

IRD requires unique, identifiable tax invoices. Numbers must be unique per team, gapless among committed invoices and concurrency-safe. Options: counter row, per-team sequence, `MAX+1` under an advisory lock, and MERGE.

## Decision

A gapless per-team counter row, upserted by `assign_invoice_number(payment_id)` inside the caller's transaction. It locks the payment row first, refuses a payment that already has a number, derives the team from the payment and bumps the counter. Stored as `payments.invoice_number INTEGER` with `UNIQUE(team_id, invoice_number)` and a set-once guard. Display format `INV-000123`, no team prefix in v1.

**Pending confirmation:** the numbering scheme and display format have not yet been confirmed by an accountant against IRD tax-invoice requirements. Treat the format as provisional until that confirmation.

## Consequences

- Allocations for one team serialise until commit; allocate last before COMMIT, use `SET LOCAL lock_timeout = '5s'` and never allocate for two teams in one transaction.
- Issued invoices are never deleted; voiding and credit notes (tax-invoices-and-exports) must not reuse numbers.
- An optional frozen `teams.invoice_prefix` can be added later without breaking existing numbers.
