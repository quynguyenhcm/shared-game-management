# ADR 0012: Fee snapshot and guest model

- Status: Accepted (2026-09-29)
- Task: platform-foundation
- Source: [algorithm Q11](../../memory-bank/creative/platform-foundation-algorithm.md)

## Context

Billing is per confirmed registration including guests, must be replay-safe (at-least-once jobs), and must keep an immutable record for seven years.

## Decision

A `registration_guests` child table (positions 1 to 2, sex, skill) with a deferred check against `registrations.guest_count`. A `payments` header carries `team_id` and a GST-rate snapshot with GST and subtotal as STORED generated columns; `payment_line_items` holds one immutable row per party with the applied fee basis. Idempotency comes from unique keys (`payments.registration_id`, line item per party, one auto-deduction per registration). Composite foreign keys enforce that payment, registration and session share user and team. BY_SEX pricing includes `fee_other` and a `SEX_OTHER` basis. A partial unique index on waitlist positions protects FIFO order.

## Consequences

- Deferred constraint triggers report at COMMIT; tests must use `SET CONSTRAINTS ALL IMMEDIATE` when they roll back.
- `guest_count` and `registrations.team_id` are denormalised, and the database makes drift impossible to commit.
- Registration-and-waitlist must follow the documented session-row locking contract for queue positions.
