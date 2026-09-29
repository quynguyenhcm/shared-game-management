# ADR 0010: Time, DST policy and session instants

- Status: Accepted (2026-09-29)
- Task: platform-foundation
- Source: [algorithm Q7](../../memory-bank/creative/platform-foundation-algorithm.md)

## Context

Sessions are scheduled in Pacific/Auckland wall-clock time; DST creates nonexistent and ambiguous local times, and billing and cancellation logic need reliable instants.

## Decision

A hand-rolled `Intl` offset probe in `@sgm/shared/time` (no date library), with explicit disambiguation per call: `reject` for user input, `compatible` for derived times (a gap shifts forward, an overlap takes the earlier instant). The cancellation deadline defaults to an absolute 48 hours. `game_sessions.starts_at` and `ends_at` are maintained by database triggers using a plpgsql port of the same algorithm (`nz_local_to_utc`), which overrides PostgreSQL's native overlap rule.

## Consequences

- The conversion exists as one algorithm with two ports (TypeScript and SQL); a parity test in CI fails if they diverge.
- Both depend on host tzdata; NZ rules have been stable since 2007.
- Courts may not cross midnight (`24:00` means midnight); recorded as schema deviation D-09.
