---
version: next
status: planned
priority: high
complexity: 4
linked_tasks: []
created: 2026-09-29
---

# Registration and Waitlist

Registration, FIFO waitlist, debt control and cancellation rules (PRODDUCT-OVERVIEW §5, §6; workflows §1, §2).

- Public capacity = `max_players - reserved_seats`
- Up to 2 guests per registrant; the group is confirmed or waitlisted together
- FIFO waitlist with sequential `queue_position`; auto-promote when seats free up. Define how a group that doesn't fit is handled (skip or block).
- Debt gate: block registration when the user has 3 or more `OVERDUE` payments
- Cancellation: before the deadline → `WITHDRAWN`, $0, promote; after the deadline → `WITHDRAWN`. If someone is waitlisted, promote them and they take the fee; if not, charge the withdrawing player.
  - NOTE: the overview's §6 wording has the 48h windows reversed; the workflows doc (`NOW <= deadline` → free) is authoritative.
- Concurrency safety (row locks / serializable transactions) for seat allocation and promotion

**Depends on**: session-scheduling-engine

**Complexity rationale**: Concurrency-critical state machine with multiple interacting rules and a phased rollout → Level 4. (Evaluated via decision tree; accepted non-interactively per user request.)
