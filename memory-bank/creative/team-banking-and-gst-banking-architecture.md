# Architecture Decision: Team Banking, the Publish Gate and Cross-Feature Contracts

**Created**: 2026-10-16
**Status**: DECIDED (Q3 needs a product-owner confirmation at the reconciliation step; see Q3)
**Decision Type**: Architecture
**Task**: `team-banking-and-gst` (Level 3). Spec: `memory-bank/tasks/team-banking-and-gst.md` on `feature/team-banking-and-gst` (43 ACs; amended only where listed in [Spec Amendments](#spec-amendments)).
**Resolves**: Creative Q3 (Akahu credentials), Q4 (removal policy, lock protocol, recurrence contract), Q6 (`is_payout_configured`), Q8 (fraud and audit), Q9 API side (`GLOBAL_ADMIN`), Q10 (GST rate constant), Q11 (GST number history), plus where `lockTeam`/`findApprovedRole` live, the `team.action.refused` hook and the camelCase logger redaction.
**Not decided here**: validators and the exact paid-session rule (algorithm doc, Q1, Q2, Q5); page placement, nav marking and copy (journey and UI/UX docs, Q7, Q9 UX). This doc only fixes the *shape* of `game_session_is_paid` that the triggers call.
**Basis**: `main` at `e19fc12`. Principles P1 to P7 (`systemPatterns.md` on `main`). Binding prior decisions: ADR 0005 (envelopes), 0012 (fee snapshot), 0015 (lock order, moderation shape, gate pattern), ledger D-03, D-04, D-08, D-14, D-19, D-40 to D-46. Code read: `modules/teams/{service,repo,routes,membership}.ts`, `lib/crypto/crypto.ts`, `lib/logger/logger.ts`, `lib/auth/policy.ts`, `app.ts`, `jobs/{send-email,registry}.ts`, migrations `…0300000` (teams), `…0600000` (sessions), `…0900000` (payments), `20261013000100000`, `test/integration/crypto-columns.int.test.ts`. Cross-feature: `feature/registration-and-waitlist:memory-bank/creative/registration-and-waitlist-allocator-architecture.md` (allocator takes `game_sessions FOR UPDATE`, never a `teams` lock; billing locks the session then moves it to COMPLETED). Learned rules: `logging-redaction-global`, `review-process-plan-claims`, `job-queues-pgboss`, `testing-integration-db-isolation`.
**External research**: Akahu developer docs (see Q3, sources at the end).

---

## Context

### System Requirements
- Team admins store the payout destination (bank account name and NZ number) encrypted, see only masked values afterwards, and can replace or remove it.
- A paid session can never be PUBLISHED for a team that has no payout destination, whichever code path publishes it (gated API, recurrence job, raw SQL). This must hold under concurrency (P1).
- Removing the payout destination must not strand sessions or payments that still need it.
- GST settings are read by billing at charge time and printed on tax invoices for 7 years.
- Changing the payout account is the main fraud move for a compromised admin session; other admins must find out.

### Technical Constraints
- Columns already exist on `teams` (D-03, D-04): `bank_account_name`, `bank_account_number`, `akahu_app_token`, `ird_number` are envelopes; `bank_account_last4`, `akahu_merchant_id`, `gst_number`, `gst_registered`, `is_payout_configured` are plaintext.
- Canonical lock order (ADR 0015): `teams → team_members → game_sessions → registrations → registration_guests → payments`. READ COMMITTED everywhere.
- The `teams` row is the per-team mutex: `FOR SHARE` (join), `FOR NO KEY UPDATE` (moderation), `FOR UPDATE` (invite regenerate). FK inserts that reference `teams` (sessions, members, payments, wallets) take `FOR KEY SHARE`.
- No Akahu client exists; it arrives with wallet-and-akahu-billing. No new env vars in this feature (P7).
- Logger redaction is global (learned rule): any new key pattern must be checked against every existing log field.

### Non-Functional Requirements
- P1 invariants in SQL; P2 no float money; P4 envelopes, never logged; P5 email via the job queue in the same transaction; NZ Privacy Act 2020 (bank and IRD numbers are personal information); IRD 7-year record retention; no deadlock (no `40P01`) under the documented lock order.

---

## Component Analysis

### Core Components
| Component | Purpose | Responsibilities |
|---|---|---|
| `modules/team-banking/routes.ts` | HTTP surface | 5 routes, `requireTeamRole('TEAM_ADMIN')`, strict zod, `no-store` |
| `modules/team-banking/service.ts` | Use cases | lock, admin re-check, validate, encrypt, write, audit stamp, enqueue notifications, log |
| `modules/team-banking/repo.ts` | SQL | read masked view, write block, clear block, `team_banking_in_use` call, admin recipients |
| `modules/team-banking/publish-gate.ts` | Exported contract | `isPaidSession`, `assertTeamCanPublishPaidSession`, `checkTeamCanPublishPaidSession`, `mapPublishGateDbError`, `mapBankingDbError` |
| `modules/teams/admin-lock.ts` (new, public surface of teams) | Shared authority | `lockTeamRow(trx, teamId, mode)` (id only, never the invite code), `assertTeamAdminUnderLock(trx, teamId, actorId, mode)` |
| `lib/auth/team-refusals.ts` (new) | Shared refusal logging | the guard `onError` hook (registered once in `buildApp`) and the `refusing()` service wrapper |
| Migration `20261016000100000_team_banking_and_gst_invariants.sql` | P1 backstops | generated flag, all-or-none CHECK, GST CHECKs, `game_session_is_paid`, publish trigger, `team_banking_in_use`, removal trigger, audit columns |
| `packages/shared/src/nz/gst.ts` | Single GST constant | `GST_RATE_BPS`, `gstFraction()` |
| ADR 0016 | Contract record | gate call contract, lock rules, recurrence handling, billing obligations |

### Component Interactions
```
web Server Action -> API route (guard, 403 before body) -> service
  service tx:  teams row lock (PUT/GST: NO KEY UPDATE, DELETE: UPDATE)
               -> assertTeamAdminUnderLock (team_members read)
               -> [DELETE] team_banking_in_use(team)  (plain reads of game_sessions, payments)
               -> validate (@sgm/shared nz) -> encrypt (FieldCrypto) -> UPDATE teams (+ audit stamp)
               -> enqueueEmail(..., { trx, crypto }) per approved admin
               -> COMMIT -> log team.banking.* (ids only)

session-scheduling-engine publish tx:
               assertTeamCanPublishPaidSession (teams FOR KEY SHARE) -> game_sessions FOR UPDATE -> UPDATE status
               DB trigger game_sessions_paid_requires_payout re-checks (KEY SHARE, already held)
```

---

## Q3: What the Akahu credentials are

### Findings (Akahu developer documentation, October 2026)
- Akahu has **no merchant concept and no merchant ID**. Its credentials are: an **App ID Token** (sent as `X-Akahu-Id`, one per Akahu app), an **App Secret** (HTTP Basic with the App ID Token, for app-scoped endpoints), and a **User Access Token** per end user, obtained by sending that user through Akahu's OAuth2 flow. Connected bank accounts are identified by `_id` (`acc_…`).
- A payment (`POST /payments`) moves money **from the paying user's connected account** (`from: acc_…`, which must carry `PAYMENT_FROM` and a covering payment consent) **to a destination given as `to.account_number` and `to.name`**. The payee needs no Akahu credential at all. Payments are asynchronous (`READY`/`PAUSED`, final `SENT`/`DECLINED`/`ERROR`/`CANCELLED`), tracked by the `PAYMENT` webhook, and **the payments endpoint is restricted to apps Akahu has whitelisted**.
- If the destination account is itself connected to the app, Akahu stamps `received_at` and sends `PAYMENT RECEIVED`; that is the only role a payee-side Akahu connection plays, and it is an OAuth connection, not a value someone types.

So in the product's own flow ("Akahu routes all payments directly to the target team's configured bank account", PRODDUCT-OVERVIEW §7), the payer is the player, the app is the platform's single whitelisted Akahu app, and the team is identified only by its **bank account number and account name**. A per-team "Akahu merchant ID" and "Akahu app token" typed into a form do not correspond to anything Akahu issues for this flow. A community team cannot realistically run its own whitelisted Akahu app, and even if it did, an app token and secret cannot pull money from players without each player's user token.

### Options
#### Option 3A: Keep the spec (two typed fields, both required for payout)
- **Pros**: no spec churn; matches the PRODDUCT-OVERVIEW wording.
- **Cons**: asks every admin for values Akahu does not issue for this flow; blocks every paid session behind fields nobody can fill correctly; wallet-and-akahu-billing would have to ignore or migrate them; the "verify at save" question has no answer because there is nothing to verify against.
- **Technical Fit**: Medium. **Complexity**: Low. **Scalability**: n/a.

#### Option 3B: Per-team Akahu app (App ID Token plaintext, App Secret encrypted)
- **Description**: relabel the columns `App ID Token` and `App Secret`, require both.
- **Pros**: maps to real Akahu credential names.
- **Cons**: each team would need its own Akahu app approved for payments; app-level credentials still cannot initiate a payment from a player; verification needs an `AkahuClient` port now.
- **Technical Fit**: Low. **Complexity**: Medium (port, doubles). **Scalability**: Low (per-team Akahu onboarding).

#### Option 3C: The payout destination is the bank account; Akahu app credentials are platform-level (chosen)
- **Description**: `is_payout_configured` means "account name and NZ account number present and valid". This feature neither reads nor writes `akahu_merchant_id` or `akahu_app_token`. The platform's App ID Token and App Secret are environment config owned by wallet-and-akahu-billing (validated at boot, P7). The two Akahu columns stay in the schema untouched (no destructive migration on D-03 columns) and are reserved for wallet-and-akahu-billing. If it wants payee-side receipt tracking, it can add a "connect your team's account" OAuth flow and store the team's user token (envelope) and connected account `_id`. It renames or drops the columns as its own migration.
- **Pros**: asks admins only for what a payment actually needs; nothing to verify at save time (Akahu has no payee-verification endpoint; NZ confirmation-of-payee is out of scope); no `AkahuClient` port now; fewer secrets stored (smaller P4 surface); simpler form.
- **Cons**: departs from the task description wording ("Akahu merchant credentials ... stored encrypted"), so it needs the product owner's OK; it changes about ten ACs (listed in the amendments).
- **Technical Fit**: High. **Complexity**: Low. **Scalability**: High.

### Decision
**Chosen**: Option 3C. Labels: `Name on the account`, `Account number` (copy is the UI doc's call). Format rules for the payout block: name 1 to 100 trimmed characters, no control characters; number per the algorithm doc's validator. **No verification at save time.** The schema needs no extension now; it shrinks the payout block to three columns (`bank_account_name`, `bank_account_number`, `bank_account_last4`).

**Path for wallet-and-akahu-billing when Akahu rejects a payment to the team account** (for example `DECLINED` for an invalid account): billing records the failure on the payment, notifies the team admins, and **never clears the banking columns or `is_payout_configured`**. Clearing them would be a removal that skips the removal guard, and the DB removal trigger (Q4) would refuse it anyway while sessions or payments depend on the account. If billing needs a "destination unhealthy" state, it adds its own column (for example `payout_failed_at`) and decides whether the publish gate should read it. The SQL gate function is the single place to change.

**If the product owner rejects 3C at reconciliation** (fallback, so build does not stall): use 3B's labels with the spec's storage. `akahu_merchant_id` becomes the App ID Token (plaintext, 1 to 255 characters, no whitespace; do not enforce a prefix, because Akahu does not document one), and `akahu_app_token` becomes the App Secret (envelope). Both join the all-or-none block and the generated flag. Still no verification at save time; wallet-and-akahu-billing builds the `AkahuClient` port. Every other decision in this doc is unchanged by the fallback.

---

## Q4: Removal policy, lock protocol and recurrence

### What the spec's protocol gets wrong (verified race analysis)

The spec has the TS gate take `teams FOR SHARE`, removal take `FOR NO KEY UPDATE`, and the `game_sessions` trigger read `teams` without a lock. Row-lock conflicts in PostgreSQL: `KEY SHARE` conflicts only with `UPDATE`; `SHARE` conflicts with `NO KEY UPDATE` and `UPDATE`; `NO KEY UPDATE` conflicts with `SHARE`, `NO KEY UPDATE` and `UPDATE`.

| # | Interleaving (READ COMMITTED) | Spec outcome |
|---|---|---|
| R1 | Gated publish holds `teams FOR SHARE`; removal asks `FOR NO KEY UPDATE` | Removal waits, then sees PUBLISHED and refuses. **Correct.** |
| R2 | **Raw `UPDATE game_sessions SET status='PUBLISHED'`** (no gate): trigger reads `is_payout_configured = true` without a lock and the transaction stays open. Removal locks `teams` (no conflict), reads `game_sessions` (sees DRAFT, because the publish is uncommitted), sets the flag false and commits. The publish commits. | **PUBLISHED paid session with no payout destination. Invariant broken (write skew).** |
| R3 | **Raw `INSERT … status='PUBLISHED'`**: BEFORE trigger reads true; the FK check takes `KEY SHARE` on `teams`, which does not conflict with `NO KEY UPDATE`; removal cannot see the uncommitted row | **Broken (write skew).** |
| R4 | The recurrence materialiser inserts PUBLISHED instances without calling the gate (a consumer bug) | Same as R3. |

The trigger is the backstop for exactly the paths that skip the gate, so a backstop that loses those races does not protect anything. Locking `teams FOR SHARE` inside the trigger would close R2 but reverse the lock order: the trigger runs **after** the `game_sessions` row is locked. PostgreSQL locks the target tuple in `GetTupleForTrigger` before BEFORE ROW UPDATE triggers fire, so the trigger would take `game_sessions → teams`. It would then deadlock against any holder of `teams NO KEY UPDATE`/`UPDATE` that goes on to lock a session, which ADR 0015's canonical order explicitly allows. This is the reverse-lock-order class the team-management critique found.

### The protocol (chosen)

1. **Publish side takes `teams FOR KEY SHARE`**, in both the TS gate and the trigger. `KEY SHARE` is the lock every FK insert into `game_sessions` already takes on `teams`, so taking it from inside a `game_sessions` trigger adds no new lock-order edge that the existing FK did not already create. It conflicts **only** with `FOR UPDATE`.
2. **Removal takes `teams FOR UPDATE` as its first statement**, then reads `team_banking_in_use(team)` in a later statement (a fresh READ COMMITTED snapshot), then clears the block. It never locks or waits on any `game_sessions`, `registrations` or `payments` row afterwards (plain reads only), so it cannot be part of a wait cycle.
3. **Banking PUT and GST PUT keep `FOR NO KEY UPDATE`** (the moderation mutex). A PUT never turns the flag from true to false, so it needs no ordering against publishes. It does not wait for long publish batches, and publishes do not wait for it.
4. **The publish trigger checks only transitions into "published and paid"** (INSERT, or UPDATE where the old row was not published-and-paid for the same team). An already published paid session that stays paid needs no check, because the removal guard makes "published paid implies configured" an invariant, and no lock is taken on every fee tweak or on billing's PUBLISHED → COMPLETED.
5. **Removal-side DB backstop**: a `BEFORE UPDATE OF bank_account_name, bank_account_number, bank_account_last4 ON teams` trigger, `WHEN (OLD.bank_account_number IS NOT NULL AND NEW.bank_account_number IS NULL)`, that first runs `PERFORM 1 FROM teams WHERE id = OLD.id FOR UPDATE` and then refuses with 23514 `teams_banking_in_use` if `team_banking_in_use(OLD.id)`. On the API path the service already holds `FOR UPDATE`, so the self-upgrade does nothing. On a raw-SQL removal (which holds only `NO KEY UPDATE` from its own UPDATE), the upgrade waits out any publisher holding `KEY SHARE`, and the following statement's fresh snapshot sees that publish.
6. **One SQL definition of "in use"**: `team_banking_in_use(p_team uuid) RETURNS boolean STABLE` returns true when the team has a PUBLISHED session for which `game_session_is_paid(...)` is true, **or an unsettled payment** (`payments.status IN ('PENDING','OVERDUE')`). Unsettled payments belong in the guard because post-game payment links and overdue reminders still need the destination after the session is COMPLETED. The `payments` table and statuses exist today with zero rows, so adding them now costs nothing and spares wallet-and-akahu-billing a migration. That feature may widen the predicate (for example to `FAILED`) by replacing this one function. The service calls the same function, so there is one encoding.

### Race table under the chosen protocol
| # | Interleaving | Outcome |
|---|---|---|
| C1 | Gated publish holds `KEY SHARE`; API removal asks `FOR UPDATE` | Removal waits; after the commit its next statement sees PUBLISHED paid, so 409 `banking_in_use` (AC-VERIFY-9) |
| C2 | API removal holds `FOR UPDATE` and commits; gated publish starts | The gate's `KEY SHARE` waits, then reads the new version (false), so 409 `payout_not_configured` |
| C3 | Raw `UPDATE … PUBLISHED` first (holds session row and `KEY SHARE` via the trigger); API removal | Same as C1 |
| C4 | API removal first; raw `UPDATE … PUBLISHED` | Session row locked, trigger's `KEY SHARE` waits on `FOR UPDATE`, `SELECT … FOR KEY SHARE` returns the committed version (false), 23514 |
| C5 | Raw `INSERT … PUBLISHED` vs API removal, either order | As C3 and C4: the trigger's `KEY SHARE` (taken before the FK's own) is the serialisation point |
| C6 | Raw-SQL removal (`UPDATE teams SET bank_…=NULL`) vs any publish | Backstop trigger upgrades to `FOR UPDATE`: as C1 or C2, error 23514 `teams_banking_in_use` |
| C7 | Billing (session `FOR UPDATE` → COMPLETED → INSERT payments) vs removal | Removal sees the session still PUBLISHED (billing uncommitted), or after the commit sees PENDING payments: refused either way. Billing's payment INSERT takes `KEY SHARE` via the FK and simply waits if a removal holds `FOR UPDATE` |
| C8 | Two admins: PUT and DELETE | `NO KEY UPDATE` vs `UPDATE`: serialised; final state is wholly one or the other (AC-ERROR-11) |
| C9 | Publish vs moderation, banking PUT or GST PUT | `KEY SHARE` vs `NO KEY UPDATE`: no conflict, no waiting |
| C10 | registration-and-waitlist allocator (`team_members FOR SHARE` → `game_sessions FOR UPDATE` → registrations) | Never touches `teams` locks except FK `KEY SHARE`; never updates `status`/fees, so the publish trigger does not fire. Compatible |

**Deadlock argument.** Only two transaction kinds hold `teams FOR UPDATE`: invite regenerate and banking removal. Both take it first and then only read or write `teams`/`pgboss.job`. A waits-for edge *into* them (from a `KEY SHARE` requester holding a session row) has no edge *out*, so no cycle exists. The publish trigger's `KEY SHARE` is compatible with every other `teams` mode, so it can only wait on those two. ADR 0016 makes this a rule: **a transaction that takes `teams FOR UPDATE` must take it as its first lock and must not afterwards lock, update, or insert-and-wait on rows of `game_sessions`, `registrations`, `registration_guests` or `payments`.** (A materialiser holding `teams FOR UPDATE` and inserting a session with a racing `(rule, date)` would deadlock; that is why the rule exists.) A second rule: **take the strongest `teams` lock you need first**. A caller that also needs `FOR SHARE` takes it before calling the gate, whose `KEY SHARE` is then a no-op. Lock upgrades happen only on the raw-SQL removal path.

The isolation assumption is READ COMMITTED (as in ADR 0015): the removal's "in use" read and the trigger's queries must take a fresh snapshot after the lock wait. Under REPEATABLE READ the conflict surfaces as 40001 and the caller retries.

### Options considered
#### Option 4A: Refuse removal at service level only, trigger reads `teams` without a lock (spec)
- **Pros**: smallest change. **Cons**: loses R2 to R4; the backstop is advisory. **Technical Fit**: Medium. **Complexity**: Low. **Scalability**: High.
#### Option 4B: Allow removal; let billing fail visibly
- **Pros**: no cross-table guard. **Cons**: players register for and play sessions that cannot be paid for; failure appears after the game, at the worst moment; PENDING payment links lose their destination. **Technical Fit**: Low. **Complexity**: Low. **Scalability**: High.
#### Option 4C: Refuse removal in service and DB, with the `KEY SHARE`/`FOR UPDATE` protocol (chosen)
- **Pros**: closes every interleaving above for gated, raw and future paths; one SQL definition of "in use"; same "service gives the precise error, DB is the backstop, map by `err.constraint`" shape as team-management's last-admin rule; publish never waits on moderation.
- **Cons**: one more trigger and function; removal briefly blocks FK inserts that reference the team (milliseconds; removal is rare); the self-upgrade on raw SQL needs a dedicated test.
- **Technical Fit**: High. **Complexity**: Medium. **Scalability**: High.
#### Option 4D: Removal cancels or unpublishes dependent sessions
- **Cons**: destructive, surprising, and it touches registrations and billing owned by other features. Rejected.

### Evaluation Matrix (Q4)
| Criteria | 4A spec | 4B allow | 4C chosen | 4D cascade |
|---|---|---|---|---|
| Invariant under concurrency | Low (R2, R3) | None | High | High |
| Lock-order safety | High | High | High (proved above) | Low |
| Maintainability | High | High | Medium-High | Low |
| User outcome | Good | Poor | Good | Poor |
| Observability | Medium | Low | High (two named constraints) | Medium |
| Implementation cost | Low | Lowest | Medium | High |

### Decision
**Chosen**: Option 4C. A paid session is refused at publish without a payout destination, and removal is refused while the team has a PUBLISHED paid session or an unsettled payment. Both are enforced in the service and in SQL under the protocol above. Replacing the details (PUT) is always allowed.

### Recurrence materialiser contract (session-scheduling-engine; goes into ADR 0016)
1. Materialise **one instance per transaction** (or a savepoint per instance). For each paid instance that would be PUBLISHED, call `checkTeamCanPublishPaidSession(trx, { teamId, fees })` (non-throwing; same lock as the asserting form) **before** inserting it and before any `game_sessions` lock.
2. If it is refused, **insert the instance as DRAFT** (not skipped). The `(recurring_rule_id, date)` key then exists, so re-runs stay idempotent (`uq_game_sessions_rule_date`). The admin sees the instance in the schedule, and the slot is not silently lost.
3. **Never rely on the trigger for flow control.** A trigger error aborts the transaction; the TS check does not. A 23514 `game_sessions_paid_requires_payout` reaching the materialiser is a bug: log it at `error` and roll back that instance only.
4. Refusal is **not a job failure** (no retry: retries cannot fix configuration). Log `session.recurrence.publish_refused` (`teamId`, `ruleId`, `sessionId`, `reason`) and enqueue at most one admin email per rule per materialisation window (P5, in the same transaction, `idempotencyKey = payout-missing:<ruleId>:<windowStart>`), linking to `/teams/<id>/manage/banking`.
5. On later runs, re-attempt the publish of DRAFT instances **that the materialiser created** (`is_instance_overridden = false`), are still in the future and are inside the publish horizon, through the gate. Instances an admin has touched are left to the admin.
6. Manual publish (UI or endpoint) maps `payout_not_configured` to the banking link (journey doc copy).

---

## Q6: How `is_payout_configured` is derived

### Options
- **6A Stored column, one-way CHECK (spec)**: the flag true requires the block. A row with the block present and the flag false is allowed (drift), so the service must remember to write it. Low cost.
- **6B Stored column, two-way CHECK** `is_payout_configured = (block complete)` plus all-or-none: no drift, but every writer must compute and send a value the DB already knows.
- **6C Generated column (chosen)**: `is_payout_configured boolean GENERATED ALWAYS AS (bank_account_name IS NOT NULL AND bank_account_number IS NOT NULL AND bank_account_last4 IS NOT NULL) STORED`, plus CHECK `teams_payout_details_all_or_none` (the three columns are all NULL or all NOT NULL). No writer can set it (a write fails with 428C9), it cannot drift, and kysely-codegen types it as `GeneratedAlways<boolean>`, so a TypeScript write does not compile. Precedent: D-19's generated `payments.gst_amount`. PostgreSQL 17's `ALTER COLUMN … SET EXPRESSION` lets wallet-and-akahu-billing (or the 3B fallback) extend the expression later without dropping the column.
- **6D Derivation trigger**: hidden writes, a third encoding; rejected.

| Criteria | 6A | 6B | 6C | 6D |
|---|---|---|---|---|
| Drift possible | Yes | No | No | No |
| Writer burden | High | High | None | None |
| Migration cost | None | Low | Medium (drop and re-add column; down migration recomputes) | Medium |
| Readers affected | None | None | None (still a boolean) | None |

**Chosen**: 6C. The up migration drops and re-adds the column (only test and dev rows can exist; no backfill needed because the expression computes it). The down migration drops the generated column, re-adds `boolean NOT NULL DEFAULT false`, and runs `UPDATE teams SET is_payout_configured = (…)`. The ledger key is `column-def:teams.is_payout_configured` (same kind as D-19). The all-or-none CHECK replaces both `teams_payout_requires_banking` and `teams_bank_number_last4_together`. The name is chosen so it sorts after `teams_bank_account_*_envelope`, because PostgreSQL tests CHECKs in name order and the existing plaintext-rejection tests must keep reporting the envelope constraint first.

**Known test breaks** (fix in Phase 1, with the session-instants one): `crypto-columns.int.test.ts` `writeBanking` writes number and last4 without the name (add the name), and the "copied to another row" case writes only the number to team B (write the full block). Any factory that sets `is_payout_configured` directly must instead write the three envelopes (`insertTeam({ payoutConfigured: true })`, already planned).

---

## Q8: Fraud, audit and change notification

### Options
- **8A Structured logs only (spec baseline)**: retention-limited; nobody is told.
- **8B In-transaction email to every approved admin, plus audit columns (chosen)**.
- **8C Step-up re-authentication** (session must be younger than N minutes for banking writes): real protection against a stolen session token, but it needs a new error code, a web re-auth flow (OAuth users bounce through the provider), and a new config value (P7). The spec lists it out of scope.
- **8D Cooling-off** (a new account takes effect after 24 to 48 hours, with a cancel link): the strongest control, but it needs a pending-change table and an apply job. Too much for v1.

### Decision
**Chosen**: 8B; 8C and 8D are recorded as follow-ups. Their trigger is the first platform-wide step-up feature, or any reported payout fraud.
- **Audit columns** (new, ledgered): `teams.banking_updated_at timestamptz`, `teams.banking_updated_by uuid REFERENCES users (id) ON DELETE SET NULL`, CHECK `banking_updated_by IS NULL OR banking_updated_at IS NOT NULL` (the by-column may become NULL on account deletion). Both are written by every banking PUT and DELETE from the injected clock. They are outside the all-or-none block, so they survive a removal and show who removed it. `GET /banking` returns `updatedAt` and `updatedBy: { fullName } | null`; the UI doc decides whether and how to show it.
- **Email** (AC-ASYNC-1 promoted to MUST): on every successful banking PUT and DELETE, one `send-email` job per **approved admin of the team, including the actor**. A single-admin team would otherwise get no notice, and a hijacked session's real owner is exactly who needs it. Jobs are enqueued inside the change transaction (P5) after the UPDATE, `idempotencyKey = banking-change:<teamId>:<changeId>:<userId>` (a UUID per change), on the existing `exclusive` `send-email` queue. **Payloads are sealed** (`enqueueEmail(…, { trx, crypto })`) because they hold the recipient address, names and last 4 digits. Allowed content: team name, actor full name, NZ local time, kind (`saved` / `removed`), which fields changed (names only), the new `ending {last4}` (the same projection admins already see; it is what lets an admin spot a foreign account), and the banking page URL. Never the full number, the account name, an IRD number or a token. Recipients are read under the team lock (`team_members` `APPROVED` + `TEAM_ADMIN`); with the realistic admin counts per team, one job per admin is fine.
- GST changes get no email and no audit columns: they do not move money, and payments snapshot what was charged (Q11).

---

## Q9 (API side): `GLOBAL_ADMIN` access

- **9A No access (chosen)**: all five routes `requireTeamRole('TEAM_ADMIN')` with `allowGlobalAdmin: false`, consistent with ADR 0015's "no global-admin override". A global admin who must help is made an admin of the team through the normal flow, which leaves the membership trail.
- **9B Read-only masked support view**: `allowGlobalAdmin: true` on the two GETs. Cheap, but it widens the audience for bank and IRD data without an access log and is not requested by any persona.
- **9C Full access**: rejected (fraud surface).

**Chosen**: 9A. A later support view must be a separate route (for example `GET /admin/teams/:id/banking-status` returning only `isPayoutConfigured` and `updatedAt`) with its own `admin.access` audit event, not a flag on these routes.

---

## Q10: Where `GST_RATE_BPS` lives

- **10A Here, in `packages/shared/src/nz/gst.ts` (chosen)**: `export const GST_RATE_BPS = 1500` plus `gstFraction(bps): { numerator, denominator }` (bps / (10000 + bps) reduced by gcd, so 1500 gives 3/23). The page copy renders "15%" and "3/23" from it. wallet-and-akahu-billing imports the same constant when it writes `payments.gst_rate_bps`.
- **10B Defer to wallet-and-akahu-billing**: the page would hard-code "3/23" now, giving two sources.
- **10C Environment variable**: a statutory rate is not deployment configuration, and a change needs an effective date, not a redeploy flip.

**Chosen**: 10A. If the rate ever changes, the constant becomes an effective-dated table owned by billing. The DB never hard-codes 1500 (`payments` snapshots the rate per row), so nothing in SQL changes.

---

## Q11: GST number history for tax invoices

- **11A Snapshot at invoice issue** (`payments.invoice_gst_number`, set by `assign_invoice_number`): correct for the printed invoice, but the number could differ from the one in force when GST was charged.
- **11B Append-only `team_gst_history` here**: a second source of truth with temporal lookups; every reader needs "as of" logic.
- **11C Snapshot at charge time on `payments`, beside `gst_registered` and `gst_rate_bps` (chosen)**: the number travels with the snapshot that decided whether GST was charged; it is immutable under the existing `payments_guard_immutable` pattern (add the column to its list), kept for 7 years with the payment, and invoices and exports read it from the payment row.

**Chosen**: 11C, owned by wallet-and-akahu-billing (it writes `payments`); recorded as contract C-BIL-GST in ADR 0016. Its migration adds `payments.gst_number varchar(9)` with `CHECK (NOT gst_registered OR gst_number IS NOT NULL)`, and its charge transaction reads `gst_registered` and `gst_number` **in one statement** from `teams` (a single statement is an atomic snapshot; no lock needed). This feature supports it by guaranteeing, in SQL, that a GST-registered team always has a well-formed number (`teams_gst_registered_requires_gst_number`, `teams_gst_number_format`). It keeps no history and makes neither option harder.

---

## Shared code: `lockTeam`, `findApprovedRole`, the refusal hook

### Team lock and admin re-check
- **Option S1**: import `lockTeam`/`findApprovedRole` from `modules/teams/repo.ts`. Couples a module to another module's private repo, and `lockTeam` selects the **invite code** (a bearer capability) into a module that has no use for it.
- **Option S2**: move them to `lib/`. `lib/` holds platform code with no domain tables; team membership is domain.
- **Option S3 (chosen)**: a new public file of the teams module, `modules/teams/admin-lock.ts` (the same role `membership.ts` plays for registration), exporting:
  - `lockTeamRow(trx, teamId, mode: 'keyShare' | 'share' | 'noKeyUpdate' | 'update'): Promise<boolean>` selects only `id`;
  - `assertTeamAdminUnderLock(trx, teamId, actorId, mode: 'noKeyUpdate' | 'update'): Promise<void>` locks, re-checks `findApprovedRole === 'TEAM_ADMIN'`, and throws `forbidden` for a missing team or a non-admin (same answer, no existence probe). It throws a programming `Error` outside a transaction (`trx.isTransaction`).
  - `findApprovedRole` moves here; `repo.ts` re-exports it so teams code is unchanged. Teams' `lockTeam` (which needs the invite code) stays in `repo.ts`.
  - Rule: modules import only another module's public files (`membership.ts`, `admin-lock.ts`, `publish-gate.ts`), never its `repo.ts` or `service.ts`. A structural test asserts this for `modules/team-banking`.

### `team.action.refused`
- **Option H1**: copy the `onError` hook into the banking routes plugin (two copies drift).
- **Option H2 (chosen)**: move the hook to `lib/auth/team-refusals.ts` as `registerTeamRefusalLogging(app)`, registered **once at the root** in `buildApp` right after `registerAuthPlatform`, and delete it from `teamsRoutes`. Every `teamRole`-policy route in every module then logs the identical event. Move the service-side `refusing()` wrapper there too, so both modules emit the same event shape (`event`, `action`, `actorId`, `teamId`, `reason`). The existing teams log assertions must pass unchanged; that is the regression test.

---

## Logger redaction (camelCase)

**Constraint**: redaction keys are global (learned rule; in team-management the exact-`code` key silently redacted auth's error codes).

**Findings from the collision grep on `main`** (`accountName|accountNumber|account_name|account_number|irdNumber|akahu|appSecret|changedFields` over `apps/api/src`, `apps/api/test`, `apps/web/src`, `packages/shared/src`): no log field uses `accountName`, `accountNumber` or `irdNumber`. `appSecret` appears only in config and the Facebook provider, never as a log field. `akahu_payment_id` exists only as a column (and is already caught by `/^akahu_/i`).

**A spec defect found**: the planned event field `replacedAkahuAppToken` ends in `token`, so the existing `/token$/i` would log it as `[REDACTED]`. The event would then never show what was replaced, and AC-VERIFY-4's field-by-field assertion would fail.

**Design**:
1. Add **exact, anchored** patterns only, matching the API body keys this feature actually uses (the spec's `bankAccount*` would not even match its own body keys `accountName`/`accountNumber`): `/^(bank_?)?account_?(name|number)$/i`, and `/^ird_?number$/i` (replaces `/^ird_number$/i`). Under the 3B fallback, add `/^akahu_?(merchant_?id|app_?token|app_?secret)$/i`. Do **not** add a broad `/^akahu/i`: billing will want `akahuPaymentId` in its logs.
2. Do not change existing patterns. `gstNumber` is not redacted: it is a public business identifier printed on invoices. It is still never logged, because no event carries it.
3. Event fields avoid secret-shaped names: `team.banking.updated` carries `changedFields: Array<'accountName' | 'accountNumber'>` (string values are not key-matched), not `replacedAccountNumber`/`replacedAkahuAppToken`.
4. Unit test (`logger.test.ts`): each new pattern redacts its targets in nested objects, child bindings and `err`-adjacent fields, **and a negative list stays readable**: `statusCode`, `providerCode`, `errorCode`, `teamId`, `actorId`, `userId`, `changedFields`, `gstRegistered`, `accountId`, `isPayoutConfigured`.
5. The PR records the grep command and its result (the learned rule), and Phase 2 runs the whole integration suite after the patterns land.

---

## Observability Architecture

### Logging
- **Library**: the shared pino logger (`lib/logger/logger.ts`), via `request.log` (carries `traceId`/`spanId`).
- **Events** (ids, flags and codes only; never a value):

| Event | Level | Fields |
|---|---|---|
| `team.banking.updated` | info | `teamId`, `actorId`, `firstSetup`, `changedFields` |
| `team.banking.removed` | info | `teamId`, `actorId` |
| `team.gst.updated` | info | `teamId`, `actorId`, `gstRegistered` |
| `team.banking.publish_gate_refused` | info | `teamId`, `reason` (`payout_not_configured`), `source` (`gate` / `trigger`), `actorId` when the caller supplies one |
| `team.action.refused` | warn (403) / info (409, 422) | `action`, `actorId`, `teamId`, `reason` |
| `team.banking.decrypt_failed` | error | `teamId`, `column`, `reason` (`DecryptionError.reason`) |
| `team.banking.notify_enqueued` | debug | `teamId`, `recipients` (count) |

- **Configuration**: unchanged (`LOG_LEVEL`, `LOG_FORMAT`, `LOG_OUTPUT`, `LOG_FILE_PATH`); new redaction patterns are code, not config, because they are security defaults.

### Distributed Tracing
- No new external calls. HTTP spans come from `@fastify/otel`; the email jobs follow the existing `enqueueEmail` path (job context per the existing runner).

| From | To | Protocol | Propagation Method |
|---|---|---|---|
| web Server Action | API `/teams/:id/banking|gst` | HTTP | `traceparent` header (existing api-client) |
| API service | `send-email` queue | pg-boss (same DB transaction) | existing job runner behaviour (trace ids in job context) |

- **Sampling**: unchanged (`OTEL_TRACES_SAMPLER_ARG`).

### Metrics
- **Standard**: `http_requests_total{method, route, status_code}`, `http_request_duration_seconds{method, route}` (existing).
- **Custom**: none in this feature (the project has no custom metrics yet). The refusal and decrypt-failure log events are the alert sources. If metrics land later: `team_banking_publish_refusals_total{source}`, `team_banking_decrypt_failures_total{column}` (no team or user labels).

### Configuration Variables
| Variable | Purpose | Default |
|---|---|---|
| LOG_LEVEL | Log verbosity | info |
| LOG_FORMAT | Output format | json |
| OTEL_EXPORTER_OTLP_ENDPOINT | Collector endpoint | - |
| OTEL_SERVICE_NAME | Service identifier | api / worker |
| OTEL_TRACES_SAMPLER_ARG | Sampling ratio | 1.0 (dev) |

No new variables (P7). The keyring is already validated at boot.

---

## Decision (summary)

| Question | Chosen |
|---|---|
| Q3 Akahu | **3C**: the payout destination is the bank account name and number; Akahu app credentials are platform-level (wallet-and-akahu-billing env); the two Akahu columns are untouched and reserved; no verification at save; billing never clears banking. **Needs product-owner confirmation**; fallback 3B documented |
| Q4 Removal and races | **4C**: refuse removal while a PUBLISHED paid session **or an unsettled payment** exists; publish side `teams FOR KEY SHARE` (gate and trigger), removal `teams FOR UPDATE` first, PUT/GST `FOR NO KEY UPDATE`; removal-side DB trigger with self-upgrade; one SQL function `team_banking_in_use`; trigger checks only transitions into published-and-paid |
| Q4 Recurrence | Check the gate before the insert; a refused instance is inserted as DRAFT; no job failure; one admin email per rule per window; re-attempt materialiser-created DRAFTs |
| Q6 Flag | **6C** generated column + `teams_payout_details_all_or_none` |
| Q8 Fraud | **8B** sealed in-transaction email to every approved admin incl. the actor + `banking_updated_at/by`; step-up and cooling-off deferred |
| Q9 Global admin | **9A** none |
| Q10 GST rate | **10A** `packages/shared/src/nz/gst.ts` |
| Q11 GST number history | **11C** billing snapshots `payments.gst_number` at charge time |
| Shared helpers | `modules/teams/admin-lock.ts` (public), refusal hook and wrapper in `lib/auth/team-refusals.ts` registered once at the root |
| Redaction | exact anchored camelCase patterns; `changedFields` instead of `replaced*Token` |

### Rationale
The deciding fact for Q4 is that the spec's backstop loses exactly the races it exists for (R2, R3). `KEY SHARE` on the publish side is the one mode that serialises against removal without creating a lock edge the FK did not already create, and without making publishes wait on moderation. Q3 follows from Akahu's documented model: the payee is an account number and name, so asking teams for anything else adds secrets and friction without enabling a payment. Q6 and Q8 put the invariant and the audit trail in the database (P1) and the notification on the queue (P5), which is cheaper than the service discipline they replace.

### Trade-offs Accepted
- A banking removal blocks FK inserts referencing that team for its duration (milliseconds; removal is rare and never waits after locking).
- The removal guard is conservative: a publish or cancel in flight makes a removal answer 409, and the admin retries.
- 3C changes the task description's wording; this is accepted only on the product owner's confirmation.
- The generated column costs a drop and re-add in the migration and a codegen type change; in exchange, drift is impossible.
- Every admin gets an email on every banking save, including their own; this noise is acceptable for a rare, high-risk action.

---

## ADR 0016 content (to be written in Phase 3 as `docs/adr/0016-team-banking-and-publish-gate.md`)

- **Status**: Accepted (date of Phase 3). **Task**: team-banking-and-gst. **Source**: this doc, the algorithm doc (paid-session rule), the task file's reconciliation section.
- **Context**: paid sessions need a payout destination; the publish path is not built yet; raw and future paths must not bypass the rule; removal must not strand sessions or payments.
- **Decision**
  - Payout destination = `bank_account_name`, `bank_account_number` (envelopes) and `bank_account_last4`, saved and cleared as one block (`teams_payout_details_all_or_none`). `is_payout_configured` is generated from them. Write-only after save: the full number and the IRD number are never returned. `akahu_merchant_id`/`akahu_app_token` are reserved for wallet-and-akahu-billing (or, under the fallback, the Akahu App ID Token and App Secret).
  - Paid session: `game_session_is_paid(...)` (SQL) and `isPaidSession(fees)` (TS) implement the algorithm doc's rule, kept equal by the shared matrix test.
  - **Gate contract (normative)**: call `assertTeamCanPublishPaidSession(trx, { teamId, fees, log?, actorId? })` (throws 409 `payout_not_configured`) or `checkTeamCanPublishPaidSession(...)` (returns `{ ok } | { ok: false, reason }`) **inside** the transaction that publishes, inserts as PUBLISHED, or raises a published session's fee from free to paid, **before any `game_sessions` lock**. It takes `teams FOR KEY SHARE` until COMMIT. A free session needs no call. Outside a transaction it throws a programming `Error`. READ COMMITTED assumed; under stricter isolation, retry on 40001.
  - **DB backstops**: `game_sessions_paid_requires_payout` (23514) on any transition into published-and-paid when the team is not configured, taking `teams FOR KEY SHARE`; `teams_banking_in_use` (23514) on a removal while `team_banking_in_use(team)`. Map with `mapPublishGateDbError` / `mapBankingDbError` by `err.constraint`; never use them for flow control.
  - **Lock rules**: canonical order unchanged (`teams → team_members → game_sessions → registrations → registration_guests → payments`). Take the strongest `teams` lock you need first. `teams FOR UPDATE` is reserved for leaf transactions (invite regenerate, banking removal): taken first, and afterwards no lock, update or insert-and-wait on session, registration or payment rows.
  - **Removal policy**: refused while the team has a PUBLISHED paid session or a PENDING/OVERDUE payment (`team_banking_in_use`, replaceable by billing); replacement is always allowed.
  - **Recurrence contract**: points 1 to 6 of Q4 above.
  - **Billing obligations** (wallet-and-akahu-billing): C-BIL-PAY: read the destination at payment initiation; on Akahu `DECLINED`/`ERROR`, record it on the payment and notify admins, and never clear banking columns. C-BIL-GST: snapshot `gst_number` with `gst_registered` and `gst_rate_bps` on `payments`, read in one statement. C-BIL-AKAHU: platform App ID Token and App Secret are environment config validated at boot; per-team Akahu columns are its to repurpose or drop. C-BIL-INUSE: widen `team_banking_in_use` if more payment states depend on the destination.
  - **Notifications and audit**: every banking save or removal stamps `banking_updated_at/by` and enqueues a sealed `send-email` per approved admin (including the actor) in the same transaction.
- **Alternatives considered**: 4A (unlocked trigger read: loses R2/R3), 4B, 4D; 3A, 3B; 6A, 6B, 6D; 8A, 8C, 8D; 9B, 9C; 10B, 10C; 11A, 11B.
- **Consequences**: removal briefly blocks FK inserts for the team; publish never waits on moderation; every consuming feature's plan cites the gate contract and lock rules, and its build gate re-checks them.

---

## Migration sketch (`20261016000100000_team_banking_and_gst_invariants.sql`)

Ledger numbers are proposed; the algorithm doc may split D-49.

```sql
-- D-47: generated payout flag and the all-or-none block (Arch Q3 3C, Q6 6C)
ALTER TABLE teams DROP COLUMN is_payout_configured;
ALTER TABLE teams
  ADD COLUMN is_payout_configured boolean NOT NULL GENERATED ALWAYS AS
    (bank_account_name IS NOT NULL AND bank_account_number IS NOT NULL AND bank_account_last4 IS NOT NULL) STORED,
  ADD CONSTRAINT teams_payout_details_all_or_none CHECK (
    (bank_account_name IS NULL) = (bank_account_number IS NULL)
    AND (bank_account_number IS NULL) = (bank_account_last4 IS NULL));

-- D-48: GST settings (algorithm doc owns the format rule)
ALTER TABLE teams
  ADD CONSTRAINT teams_gst_number_format CHECK (gst_number IS NULL OR gst_number ~ '^[0-9]{8,9}$'),
  ADD CONSTRAINT teams_gst_registered_requires_gst_number CHECK (NOT gst_registered OR gst_number IS NOT NULL);

-- D-49: paid-session rule (body per the algorithm doc) and the publish backstop
CREATE FUNCTION game_session_is_paid(...) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ ... $$;
CREATE FUNCTION game_sessions_enforce_payout() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE configured boolean;
BEGIN
  IF NEW.status <> 'PUBLISHED' OR NOT game_session_is_paid(/* NEW fees */) THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'PUBLISHED' AND OLD.team_id = NEW.team_id
     AND game_session_is_paid(/* OLD fees */) THEN RETURN NEW; END IF;      -- already published and paid
  SELECT is_payout_configured INTO configured FROM teams WHERE id = NEW.team_id FOR KEY SHARE;
  IF NOT FOUND THEN RETURN NEW; END IF;                                      -- the FK reports 23503
  IF NOT configured THEN
    RAISE EXCEPTION 'team % has no payout details for a paid published session', NEW.team_id
      USING ERRCODE = '23514', CONSTRAINT = 'game_sessions_paid_requires_payout';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER game_sessions_paid_requires_payout
  BEFORE INSERT OR UPDATE OF status, pricing_structure, fee_flat, fee_male, fee_female, fee_other,
                              fee_beginner, fee_intermediate, fee_advanced, team_id
  ON game_sessions FOR EACH ROW EXECUTE FUNCTION game_sessions_enforce_payout();

-- D-50: removal guard (service + backstop share one definition)
CREATE FUNCTION team_banking_in_use(p_team uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM game_sessions s
                  WHERE s.team_id = p_team AND s.status = 'PUBLISHED' AND game_session_is_paid(/* s fees */))
      OR EXISTS (SELECT 1 FROM payments p WHERE p.team_id = p_team AND p.status IN ('PENDING', 'OVERDUE')) $$;
CREATE FUNCTION teams_guard_banking_removal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM teams WHERE id = OLD.id FOR UPDATE;   -- no-op on the API path; waits out KEY SHARE publishers on raw SQL
  IF team_banking_in_use(OLD.id) THEN                  -- fresh snapshot after the wait (READ COMMITTED)
    RAISE EXCEPTION 'team % payout details are in use', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'teams_banking_in_use';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER teams_guard_banking_removal
  BEFORE UPDATE OF bank_account_name, bank_account_number, bank_account_last4 ON teams
  FOR EACH ROW WHEN (OLD.bank_account_number IS NOT NULL AND NEW.bank_account_number IS NULL)
  EXECUTE FUNCTION teams_guard_banking_removal();

-- D-51: banking audit stamp (Arch Q8)
ALTER TABLE teams
  ADD COLUMN banking_updated_at timestamptz,
  ADD COLUMN banking_updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD CONSTRAINT teams_banking_updated_pair CHECK (banking_updated_by IS NULL OR banking_updated_at IS NOT NULL);
```
Indexes: `team_banking_in_use` runs only on removal; the existing `idx_game_sessions_billing_due` (partial on PUBLISHED) and `idx_payments_team_paid_status (team_id, …)` serve it. No new index. The down migration reverses in order and recomputes the stored flag (Q6).

---

## Implementation Guidelines

1. **Phase 1**: the migration above; `game_session_is_paid` body from the algorithm doc; ledger D-47 to D-51 (`column-def:teams.is_payout_configured`, `column:teams.banking_updated_at`, `column:teams.banking_updated_by`, and `function:` keys for the three new functions so the schema test derives them); regenerate `types.generated.ts` (expect `GeneratedAlways<boolean>`) and `expected-schema.ts`; fix the known breaks (`session-instants.int.test.ts:67`, `crypto-columns.int.test.ts` `writeBanking` and the copied-row case); grep every test for `PUBLISHED` and for `is_payout_configured` writes; `packages/shared/src/nz/gst.ts`.
2. **Phase 2**: `modules/teams/admin-lock.ts` and `lib/auth/team-refusals.ts` first (teams tests must stay green, with the root-registered hook replacing the plugin one), then the banking module. DELETE: `assertTeamAdminUnderLock(trx, teamId, actorId, 'update')` → `SELECT team_banking_in_use($1)` → 409 or clear the block plus the stamp → enqueue notifications → commit → log. PUT/GST: `'noKeyUpdate'`. Wrap the transaction in `mapBankingDbError`. Redaction patterns land with the grep evidence.
3. **Phase 3**: `publish-gate.ts` with `FOR KEY SHARE` via `lockTeamRow(trx, teamId, 'keyShare')` (reading `is_payout_configured` in the same statement); race suite with `waitForLockWaiters` covering C1 to C8, including the raw INSERT (C5) and raw-SQL removal self-upgrade (C6) cases, and asserting no `40P01`; ADR 0016.
4. **Phase 4**: the email copy and the optional "Last changed by" display follow the UI doc; the Server Action never echoes the account number on success.
5. Every service-level check has a DB twin that it maps by `err.constraint`; the service gives the precise error on the normal path, and the DB is the backstop.

## Validation Checklist

- [x] Meets all system requirements (gate holds for gated, raw and future paths; removal cannot strand sessions or payments; masked read-back; admins notified)
- [x] Respects technical constraints (existing columns, envelope CHECKs, READ COMMITTED, no new env vars)
- [x] Addresses non-functional requirements (P1, P2, P4, P5, P7, Privacy Act, 7-year retention via 11C)
- [x] Technically feasible on PostgreSQL 17 (generated column, `SET EXPRESSION` for later change, row-lock modes as analysed)
- [x] Risks identified and acceptable
- [x] Complies with Guiding Principles (no deviation; P1 strengthened relative to the spec)
- [x] Respects established patterns (moderation transaction shape, gate-before-session-lock, map by constraint, sealed email payloads, public module files)
- [x] Observability architecture defined
- [x] Trace context propagation across all service boundaries (no new boundaries)
- [x] Logging strategy consistent with observability-requirements.md and the global-redaction rule
- [x] Metrics strategy follows naming conventions (none new; names reserved)

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Product owner rejects 3C | M | M | Fallback 3B fully specified; only the block columns, form fields and redaction pattern change |
| A consumer takes `teams FOR UPDATE` and then a session lock (deadlock) | L | M | ADR 0016 leaf rule; race suites in each consumer; 40P01 surfaces loudly, never silently |
| The trigger fires on a test path that publishes paid sessions with no banking | H (known) | L | Phase 1 fixture fixes and the grep; `insertTeam({ payoutConfigured })` |
| Self-upgrade semantics in the removal trigger differ from the analysis | L | M | Dedicated C6 test with lock waiters; the API path never relies on the upgrade |
| Generated-column drop and re-add breaks the schema drift test or codegen | M | L | `column-def:` ledger key (D-19 precedent); regenerate both fixtures in Phase 1 |
| New redaction pattern hides an operator field | L | M | Exact anchored patterns, negative-list unit test, recorded grep, full integration run |
| Notification email leaks bank data via `pgboss.job` | L | H | Sealed payloads; AC-ASYNC-1 asserts `pgboss.job.data` holds only `{ idempotencyKey, sealed }` |
| Removal blocked "forever" by a stuck PENDING payment | L | M | Billing owns the predicate (C-BIL-INUSE); replacement via PUT stays available |
| ADR and ledger numbering clash with registration-and-waitlist | M | L | This feature takes ADR 0016 and D-47 to D-51; registration renumbers at its build gate (plan already says so) |

## Next Steps

1. Reconciliation step in the task file: confirm 3C with the product owner (or switch to 3B), and fold the amendments below into the ACs together with the algorithm, journey and UI docs.
2. Run the creative adversarial critique against the branch diff (`--base origin/main --scope branch`), focusing on the Q4 race table.
3. Build Phases 1 to 5 as planned, with the guideline changes above.
4. Notify the session-scheduling-engine and wallet-and-akahu-billing plans of ADR 0016 (gate contract, recurrence contract, C-BIL-*). Registration-and-waitlist's `insertPublishedSession` must build a configured team.

---

## Spec Amendments

Each line: AC or spec section, then the change. "3C" marks amendments that depend on the Q3 confirmation (under the 3B fallback, keep the Akahu fields with the 3B labels instead).

- **Contract / Data persisted (3C)**: the payout block is `bank_account_name`, `bank_account_number`, `bank_account_last4`. `akahu_merchant_id` and `akahu_app_token` are not read or written by this feature. `is_payout_configured` is a generated column (not written). Add `banking_updated_at`, `banking_updated_by` (written by every banking PUT and DELETE).
- **Contract (locks)**: banking PUT and GST PUT lock the team row `FOR NO KEY UPDATE`; **DELETE locks it `FOR UPDATE`** as its first statement. The gate reads `is_payout_configured` under **`FOR KEY SHARE`** (not `FOR SHARE`). The trigger reads `teams` **`FOR KEY SHARE`** (not "without a lock") and fires only on transitions into published-and-paid.
- **Contract (gate API)**: add `checkTeamCanPublishPaidSession` (non-throwing) beside `assertTeamCanPublishPaidSession`; both take `{ teamId, fees, log?, actorId? }`. Add `mapBankingDbError` (`teams_banking_in_use` → 409 `banking_in_use`).
- **Contract (responses, 3C)**: `banking: { isPayoutConfigured, accountName | null, accountNumberLast4 | null, updatedAt | null, updatedBy: { fullName } | null }`. Drop `akahuMerchantId` and `akahuAppTokenSet`.
- **Success Criteria copy (3C)**: drop the Akahu detail rows, field errors and the "Akahu" wording in the status line and section title. The UI doc supplies the replacement copy; `banking_in_use` copy must also cover unsettled payments.
- **AC-HAPPY-1 (3C)**: enter account name and account number; the row holds the three block columns, `is_payout_configured = true`, and `banking_updated_at/by` set.
- **AC-HAPPY-2 (3C)**: change only the account name and leave the number blank; `bank_account_number` and `bank_account_last4` are byte-identical.
- **AC-HAPPY-3 (3C)**: replace the account number (no token).
- **AC-HAPPY-4**: after removal the three block columns are NULL and the generated flag is false; `banking_updated_at/by` record the removal.
- **AC-ERROR-4 (3C)**: drop the merchant ID and token cases.
- **AC-ERROR-8**: the trigger message and constraint are unchanged; add: a raw `INSERT … PUBLISHED` racing a removal is covered by AC-VERIFY-9.
- **AC-ERROR-10**: refused also while the team has a `payments` row in `PENDING` or `OVERDUE`. Add the raw-SQL form: `UPDATE teams SET bank_account_name = NULL, bank_account_number = NULL, bank_account_last4 = NULL` while in use fails with 23514 `teams_banking_in_use`, and `mapBankingDbError` returns `banking_in_use`.
- **AC-ASYNC-1**: priority COULD → **MUST**. Recipients: **every approved admin, including the actor**. Payload sealed (`pgboss.job.data` holds only `{ idempotencyKey, sealed }`). Content may include the new `ending {last4}` and changed field names; never the full number, the account name, IRD or token.
- **AC-VERIFY-1**: replace "flag true with any of the five columns NULL" and the "number without last4" case with: some but not all of name, number, last4 set fails 23514 `teams_payout_details_all_or_none`; a direct write to `is_payout_configured` fails (428C9). (3C) Drop the `akahu_merchant_id` padding case. Add the `teams_banking_in_use` trigger, the `team_banking_in_use` function and the banking audit columns to the ledger (D-47 to D-51).
- **AC-VERIFY-2 (3C)**: the encrypted columns written through the API are `bank_account_name`, `bank_account_number`, `ird_number`; only `bank_account_last4` and `gst_number` appear in plaintext. Fix `crypto-columns.int.test.ts` for the all-or-none CHECK.
- **AC-VERIFY-4**: `team.banking.updated` carries `teamId`, `actorId`, `firstSetup`, `changedFields` (replaces `replacedAccountNumber`/`replacedAkahuAppToken`; `replacedAkahuAppToken` would be redacted by `/token$/i`). Refusal events carry `actorId` only when known (the gate may run in a job). Redaction adds `/^(bank_?)?account_?(name|number)$/i` and `/^ird_?number$/i` (not `bankAccount*` or a broad `akahu*`), with a negative-list test.
- **AC-VERIFY-9**: the gate holds `FOR KEY SHARE`; removal takes `FOR UPDATE`. Add cases: raw `UPDATE … PUBLISHED` and raw `INSERT … PUBLISHED` racing an API removal in both orders, and a raw-SQL removal racing a gated publish (trigger self-upgrade); all end in exactly one refusal and no `40P01`.
- **AC-VERIFY-14**: ADR 0016 also records the `KEY SHARE`/`FOR UPDATE` lock rules, the `team_banking_in_use` definition, the recurrence contract (points 1 to 6) and the billing obligations C-BIL-PAY, C-BIL-GST, C-BIL-AKAHU, C-BIL-INUSE; `techContext.md` Akahu row reads "platform-level app credentials owned by wallet-and-akahu-billing; no per-team Akahu credentials".
- **AC-INTEGRATION-1 (3C)**: drop the token from the round trip.
- **Scope / Dependencies**: add `modules/teams/admin-lock.ts` and `lib/auth/team-refusals.ts` (hook registered once in `buildApp`, removed from `teamsRoutes`); `packages/shared/src/nz/gst.ts` is in scope (Q10).

---

Sources (Akahu research, read 2026-10-16):
- [Akahu: Making a Payment](https://developers.akahu.nz/docs/making-a-payment)
- [Akahu: Accessing Account Data](https://developers.akahu.nz/docs/accessing-account-data)
- [Akahu changelog: new header required X-Akahu-ID](https://developers.akahu.nz/changelog/new-header-required-x-akahu-id)
- [Akahu API reference: authentication](https://developers.akahu.nz/reference/api-akahu-io-authentication)
