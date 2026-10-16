# ADR 0016: Team banking, the publish gate and the cross-feature payout contracts

- Status: Accepted (2026-10-16)
- Task: team-banking-and-gst
- Source: [Banking architecture Q3, Q4, Q6, Q8 and the "ADR 0016 content" section](../../memory-bank/creative/team-banking-and-gst-banking-architecture.md); [NZ validation algorithm Q1, Q2, Q5](../../memory-bank/creative/team-banking-and-gst-nz-validation-algorithm.md); [payout setup user journey, "Hand-off contract"](../../memory-bank/creative/team-banking-and-gst-payout-setup-user-journey.md); task file "Creative Reconciliation (binding for build)" R1 to R12. Migrations `20261016000100000_team_banking_and_gst_invariants.sql` (ledger D-47 to D-53) and `20261016000200000_team_banking_change_keys.sql` (D-54).

## Context

A paid session needs somewhere to send the money. The code that publishes sessions (session-scheduling-engine) and the code that charges players (wallet-and-akahu-billing) do not exist yet, so this feature has to fix the rules they must follow. Three things must hold under concurrency, not just in the happy path:

1. A paid session is never PUBLISHED for a team with no usable payout destination, whichever path publishes it: the gated API, the recurrence job, or raw SQL.
2. The destination is never removed while a PUBLISHED paid session or an unsettled payment still depends on it.
3. Neither rule makes publishing wait on moderation or banking saves.

The first draft of the backstop (an unlocked trigger read, with the TypeScript gate taking `FOR SHARE` and the removal taking `FOR NO KEY UPDATE`) loses exactly the races it exists for: a raw publish and a removal that do not conflict each commit, and the paid session is stranded (write skew). The decision below closes every interleaving.

## Decision

### The payout destination (R1, R3, R6)

- The destination is `bank_account_name` and `bank_account_number` (AES-256-GCM envelopes, ADR 0005) plus `bank_account_last4`. They are saved and cleared as one block (CHECK `teams_payout_details_all_or_none`). The full number and name are write-only after save: responses carry the name for the admin and the last 4 only.
- `teams.is_payout_configured` is a generated column: the block is complete AND `payout_blocked_at IS NULL`. It cannot be written. Code reads it; it never sets it.
- `akahu_merchant_id`, `akahu_app_token` and `ird_number` are never read or written by this feature (D-52). They stay reserved for wallet-and-akahu-billing.
- No Akahu call is made at save time. "Set up" means the account was entered and passes the NZ bank and check-digit rules; it does not mean Akahu accepted it.

### The paid rule (R9)

A session is **paid** when some fee column that applies to its `pricing_structure` is above zero.

| `pricing_structure` | Columns that count                                 |
| ------------------- | -------------------------------------------------- |
| `FLAT`              | `fee_flat`                                         |
| `BY_SEX`            | `fee_male`, `fee_female`, `fee_other`              |
| `BY_SKILL_LEVEL`    | `fee_beginner`, `fee_intermediate`, `fee_advanced` |

NULL counts as 0. A negative fee is not paid. Columns of another structure never count. The rule has two encodings that must stay equal:

- SQL: `game_session_is_paid(...)`, which fails closed (an unknown structure is paid).
- TypeScript: `isPaidSession(pricingStructure, fees)` in `apps/api/src/modules/team-banking/publish-gate.ts`. It uses only the `Money` primitives (`parseMoney`, `toCents`), never floats, and an unparsable applicable fee fails closed. Its applies-map is a `Record<PricingType, readonly FeeKey[]>`, so a new pricing structure is a compile error until it is listed.

`apps/api/test/fixtures/paid-session-matrix.ts` (117 rows, hand-written expectations) is the parity fixture. Three suites run it: the SQL function, `isPaidSession`, and a real publish through the trigger for a configured and an unconfigured team. **Any change to the rule changes the SQL function, the TS function and the fixture in one commit.**

### Gate contract (normative)

Call `assertTeamCanPublishPaidSession(trx, { teamId, pricingStructure, fees, log?, actorId? })` (throws `AppError('payout_not_configured')`, HTTP 409) or the non-throwing `checkTeamCanPublishPaidSession(...)` (returns `{ ok: true }` or `{ ok: false, reason }`).

1. Call it **inside the transaction** that publishes a session, inserts one as PUBLISHED, or raises a published session's fee from free to paid. Outside a transaction it throws a programming `Error`. READ COMMITTED is assumed; under a stricter level a lost race surfaces as SQLSTATE 40001 and the caller retries.
2. Call it **before that transaction takes any `game_sessions` lock**. It takes `teams FOR KEY SHARE` and reads `is_payout_configured` in the same statement, and the lock lasts until COMMIT.
3. A free session needs no call (the function returns ok without a query).
4. A missing team is refused as not configured.
5. A refusal logs `team.banking.publish_gate_refused` with `teamId`, `reason` (`not_configured`, `payout_blocked` or `team_not_found`), `errorCode: 'payout_not_configured'`, and `actorId` only when the caller supplied one. It never logs a bank value. The API error is the same `payout_not_configured` for all three reasons.

Typical publish transaction:

```
BEGIN
  assertTeamCanPublishPaidSession(trx, ...)      -- teams FOR KEY SHARE
  SELECT ... FROM game_sessions WHERE id = $1 FOR UPDATE
  UPDATE game_sessions SET status = 'PUBLISHED'  -- trigger re-checks; its KEY SHARE is already held
COMMIT
```

Why `KEY SHARE`: it is the lock every foreign-key insert into `game_sessions` already takes on `teams`, so it adds no lock-order edge. It conflicts only with `FOR UPDATE`, so a publish never waits on moderation or a banking save (`FOR NO KEY UPDATE`).

### Database backstops (P1)

- `game_sessions_paid_requires_payout` (BEFORE INSERT OR UPDATE trigger on `game_sessions`): raises 23514 with that constraint name on any transition into published-and-paid when the team is not configured. It reads the team row `FOR KEY SHARE`. A session that was already published and paid for the same team is not rechecked (the removal guard keeps it valid).
- `teams_banking_in_use` (BEFORE UPDATE trigger `teams_guard_banking_removal` on `teams`): a removal first upgrades to `teams FOR UPDATE` (a no-op on the API path, which already holds it; on raw SQL it waits out any publisher holding `KEY SHARE`), then re-reads `team_banking_in_use(team)` in a fresh snapshot and raises 23514.
- `mapPublishGateDbError` and `mapBankingDbError` (`team-banking/errors.ts`, re-exported from `publish-gate.ts`) turn those two violations into `payout_not_configured` and `banking_in_use`. They key on SQLSTATE plus `err.constraint`, never on message text. A trigger error reaching a caller means a bug (the gate was skipped). Never use it for flow control: an error aborts the transaction, the TS check does not.
- A raw `INSERT ... status = 'PUBLISHED'` cannot commit today: `game_sessions_derive_instants` fills `starts_at` and `ends_at` from `session_courts`, which do not exist at insert time, so `game_sessions_instants_when_live` always fails. The payout trigger fires first (BEFORE triggers run before CHECKs), so a paid raw insert reports `game_sessions_paid_requires_payout`. Consumers therefore insert a DRAFT, add the courts, then publish.

### Lock rules

- Canonical order for every feature: `teams`, then `team_members`, then `game_sessions`, then `registrations`, then `registration_guests` and `payments` (ADR 0015, unchanged).
- Take the strongest `teams` lock you need first. A caller that also needs `FOR SHARE` takes it before calling the gate, whose `KEY SHARE` is then a no-op. Lock upgrades happen only on the raw-SQL removal path.
- `teams FOR UPDATE` is reserved for leaf transactions: invite regenerate and banking removal. It is taken as the first lock, and afterwards the transaction must not lock, update, or insert-and-wait on rows of `game_sessions`, `registrations`, `registration_guests` or `payments`. (A transaction that held `teams FOR UPDATE` and inserted a session racing a materialiser on `(rule, date)` would deadlock; that is why the rule exists.)
- Banking PUT and GST PUT take `teams FOR NO KEY UPDATE` (the moderation mutex). A PUT never turns `is_payout_configured` from true to false, so it needs no ordering against publishes. Billing setting `payout_blocked_at` (`FOR NO KEY UPDATE`) does not conflict with the gate's `KEY SHARE`: a publish concurrent with a block may pass on the older "configured" value, which is deliberate, because the block only matters for new publishes. The registration allocator never locks `teams` stronger than `KEY SHARE` and never writes `status` or fees, so the publish trigger does not fire for it.

The race matrix is covered by `apps/api/test/integration/team-banking-gate.int.test.ts`, using real locks and `pg_stat_activity` waits (no sleeps), and rules out a deadlock (`40P01`) in every order, by asserting the refused or 409 outcome where the removal goes through the API: gate, raw UPDATE and raw-SQL removal each in front of and behind a publish; a payment stand-in in front of and behind a removal.

### Removal policy

Removal is refused while the team has a PUBLISHED paid session or a PENDING or OVERDUE payment, through the single SQL predicate `team_banking_in_use(team)`. The service and the backstop trigger both call it. Replacing the details is always allowed. Removal never cancels, unpublishes or edits any session: PUBLISHED, COMPLETED and CANCELLED sessions are untouched by it. Removing banking later blocks new paid publishes and free-to-paid fee edits (the gate is re-evaluated every time). wallet-and-akahu-billing may widen the predicate (for example to `FAILED` payments) by replacing this one function.

### Recurrence contract (session-scheduling-engine)

The materialiser creates future instances of a recurring rule, some of them as PUBLISHED paid sessions.

1. Materialise **one instance per transaction** (or a savepoint per instance). For each paid instance that would be PUBLISHED, call `checkTeamCanPublishPaidSession` **before inserting it** and before any `game_sessions` lock.
2. If the gate refuses, **save the instance as DRAFT**, not skipped. The `(recurring_rule_id, date)` key then exists, so re-runs stay idempotent (`uq_game_sessions_rule_date`), and the admin sees the instance in the schedule.
3. **Never rely on the trigger for flow control.** A 23514 `game_sessions_paid_requires_payout` reaching the materialiser is a bug: log it at `error` and roll back that instance only.
4. A refusal is **not a job failure**. Retries cannot fix configuration. Log `session.recurrence.publish_refused` (`teamId`, `ruleId`, `sessionId`, `reason`).
5. Send **at most one admin email per rule per run window**, enqueued in the same transaction with `idempotencyKey = payout-missing:<ruleId>:<windowStart>`, linking to `/teams/<teamId>/manage/banking`. The series view also says that some sessions were not published because banking details are missing, with the same link.
6. On later runs, retry the publish of DRAFT instances **the materialiser created** (`is_instance_overridden = false`) that are still in the future and inside the publish horizon, through the gate. Instances an admin has touched are left to the admin.

### Manual publish and the `returnTo` hand-off

A manual publish (UI or endpoint) that gets `payout_not_configured` must:

1. **Keep the draft.** Every edited field stays saved (or stays in the form if publishing is a separate request). The admin never retypes a session.
2. Show the API's message verbatim from the shared copy deck, in an alert region on the editor, focused once.
3. Link "Set up banking and GST" to `/teams/<teamId>/manage/banking?returnTo=<url-encoded path of the editor>`. The path must start with `/teams/<teamId>/`. Only an admin can publish, and only an admin can open banking, so the link never leads to a "no access" page.
4. The banking page validates `returnTo` with `safeReturnTo` (a single leading `/`, at most 512 characters, no backslash or control character, no `//` once decoded, not an auth page) and additionally requires the `/teams/<sameTeamId>/` prefix and that it does not point at the banking page itself. Otherwise it drops it silently and shows no back link.
5. The banking page keeps `returnTo` across edit mode, validation errors and the save redirect, and shows "Back to your session" in the saved banner. It never redirects automatically.

### Contract C-BIL-PAY (wallet-and-akahu-billing)

**Every payment-creation path takes `teams FOR KEY SHARE` and checks `is_payout_configured` before inserting any payment row.** This includes post-game payment links for an already COMPLETED session, which the publish gate does not cover. A removal then either waits for the payment and refuses (`banking_in_use`, because the payment is PENDING), or commits first, and the payment path sees no banking and fails cleanly with `payout_not_configured`, inserting nothing. `apps/api/test/helpers/payment-stand-in.ts` is a test-only model of this protocol, raced against a removal in both orders; billing replaces it with its real path under the same contract.

### `payout_blocked_at` obligation (wallet-and-akahu-billing, R3)

When Akahu declines a payout because of the destination account, billing sets `teams.payout_blocked_at = now()` **under the team-row lock** (take `teams FOR NO KEY UPDATE`, like a banking save). It then notifies the admins. That makes `is_payout_configured` false, so the gate and the trigger refuse new paid publishes until the admin fixes the account. Billing **never clears or changes the banking columns**: clearing them would be a removal that skips the removal guard, and the trigger would refuse it anyway while sessions or payments depend on the account. Saving banking details clears `payout_blocked_at`; so does removing them. A declined payout must not be recorded any other way that the gate cannot see.

### GST number snapshot (R2, R10)

The team's single GST number (`teams.gst_number`, canonical digits with no leading zero, plaintext because it is printed on tax invoices) must be copied into `payments.gst_number` (a column wallet-and-akahu-billing adds; `payments` has none today) **at charge time**, in the same statement that reads `gst_registered` and the rate (`GST_RATE_BPS` from `packages/shared/src/nz/gst.ts`), so a later change to the team's settings never alters an issued charge or invoice. Turning GST off keeps the saved number. This feature never writes `ird_number`.

### Validator tables: annual review

The NZ bank-account and IRD/GST validators in `packages/shared/src/nz/*` are data tables transcribed from the IRD _Payroll Calculations & Business Rules Specification 2026-27_ (the Payments NZ register is a cross-check only). **Review them every April**, when IRD publishes the next specification, and re-run the table-driven vectors: new or retired bank IDs and changed IRD ranges would otherwise block legitimate teams or admit bad numbers.

### Notifications and audit (R8)

Every banking save that changes something, and every removal, stamps `banking_updated_at` and `banking_updated_by` and enqueues one sealed `send-email` job per approved admin (the actor included) in the same transaction. The email names who and when, and contains no account name or digits. A replayed request with the same `changeKey` writes and sends nothing (D-54).

## Alternatives considered

- **Trigger reads the team row without a lock (spec draft, option 4A).** Loses the raw UPDATE and raw INSERT races against a removal (write skew).
- **Trigger and gate take `teams FOR SHARE`.** The trigger runs after the `game_sessions` row is locked, so it would take `game_sessions` then `teams`, the reverse of the canonical order, and could deadlock against any holder of `teams NO KEY UPDATE` or `UPDATE` that goes on to lock a session.
- **Removal cancels or unpublishes dependent sessions (4D).** Silent destructive side effects on player-visible sessions.
- **Removal allowed, publish gate only.** Strands PUBLISHED paid sessions and unsettled payments with no destination.
- **Billing clears the banking columns on a declined payout.** Bypasses the removal guard; replaced by `payout_blocked_at`.
- **Per-team Akahu credentials as the destination (3A, 3B).** Adds secrets and friction without enabling a payment; the payee in Akahu's model is an account number and name.

## Consequences

- A removal briefly blocks foreign-key inserts for the team (the `FOR UPDATE`); publishes never wait on moderation or banking saves.
- The removal guard is conservative: a publish or a payment in flight makes a removal answer 409 `banking_in_use`, and the admin retries.
- Every consuming feature's plan must cite this ADR (gate call contract, lock rules, recurrence handling, C-BIL-PAY, `payout_blocked_at`), and its build gate re-checks them. registration-and-waitlist's `insertPublishedSession` test helper must create a team with `insertTeam({ payoutConfigured: true })`.
- The rule has three encodings (SQL, TS, fixture); the parity suites fail if they drift.
- registration-and-waitlist, which also planned ADR 0016 and ledger numbers from D-47, renumbers to ADR 0017 and the next free D-number at its build gate.
