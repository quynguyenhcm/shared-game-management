# ADR 0011: Invoice numbering

- Status: Accepted (2026-09-29); the counter key, the uniqueness constraint and the flag are superseded in part by [ADR 0021](0021-tax-invoices-and-exports.md) (2026-11-13)
- Task: platform-foundation
- Source: [algorithm Q9](../../memory-bank/creative/platform-foundation-algorithm.md)

## Context

IRD requires unique, identifiable tax invoices. Numbers must be unique per team, gapless among committed invoices and concurrency-safe. Options: counter row, per-team sequence, `MAX+1` under an advisory lock, and MERGE.

## Decision

A gapless per-team counter row, upserted by `assign_invoice_number(payment_id)` inside the caller's transaction. It locks the payment row first, refuses a payment that already has a number, derives the team from the payment and bumps the counter. Stored as `payments.invoice_number INTEGER` with `UNIQUE(team_id, invoice_number)` and a set-once guard. Display format `INV-000123`, no team prefix in v1.

**Pending confirmation (restated 2026-11-13):** the numbering scheme and display format have still not been confirmed by an accountant against IRD tax-invoice requirements. Treat the format as provisional until ADR 0021's accountant review record (AC-VERIFY-9) is filled in.

**Superseded in part by ADR 0021:** there is now one gapless series per team **per document kind** (`INV-000123` for tax invoices, `RCT-000123` for receipts), keyed `(team_id, document_kind)` with uniqueness `(team_id, gst_registered, invoice_number)`; a number exists only on a PAID payment above $0.00 and is issued only through `issue_payment_document`; `is_tax_invoice_issued` is a generated column. Everything else in this ADR still holds.

## Consequences

- Allocations for one team serialise until commit; allocate last before COMMIT, use `SET LOCAL lock_timeout = '5s'` and never allocate for two teams in one transaction.
- Issued invoices are never deleted; voiding and credit notes (tax-invoices-and-exports) must not reuse numbers.
- An optional frozen `teams.invoice_prefix` can be added later without breaking existing numbers.
