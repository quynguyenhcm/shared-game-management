# Architecture Decision: Billing Engine, Wallet Ledger and Akahu Gateway

**Created**: 2026-10-31
**Status**: DECIDED (Q1 live-adapter parts conditional on the A1 go/no-go, see [Conditionality](#conditionality-a1-go-no-go))
**Decision Type**: Architecture
**Task**: `wallet-and-akahu-billing` (Level 4). Spec, rulings B1-B10 (approved at defaults 2026-10-30) and the binding **Plan Amendment 2026-10-31 A1-A8** in `memory-bank/tasks/wallet-and-akahu-billing.md` on `feature/wallet-and-akahu-billing`. Where the amendment and the spec disagree, the amendment wins; where this document changes either, the change is listed in [Spec and Plan Conflicts](#spec-and-plan-conflicts).
**Resolves**: Q1 (gateway port, live and fake adapters, config and env names, the tx1 / inline create / tx2 flow, webhook verification per A4, the GLOBAL_ADMIN "mark payout blocked" action per A3), Q2 (payment link identity and what `payment_link_token` holds), Q4 (ledger enforcement, lock order, `bill-session` granularity, module split and single-writer test, the shared `applyAkahuResult`, the D-87+ migration contents, ADR 0020 outline).
**Not decided here**: Q3 (top-up intent states, expiry, B3 overflow and duplicate recording) and Q6 (B8/B9 edge cases, departed members, long outages) belong to the algorithm doc; the HELD state's ops surface and copy belong to the algorithm and journey docs (A2). This design gives each of them a fixed structural slot (state classes, partial uniques, single writers, lock positions) so they can choose names and rules without touching concurrency.
**Basis**: `main` at `0e291fc`. Principles P1-P7 (`memory-bank/systemPatterns.md`). ADR 0004, 0007, 0009, 0012, 0015, 0016, 0018, 0019. Spike `akahu-payment-capability` (approved; DR-001..DR-005 treated as provisional inputs and finalised below) and its handoff. Code read: `modules/sessions/locks.ts`, `modules/registrations/{billing-handoff,boundaries.test,repo}.ts`, `modules/teams/admin-lock.ts`, `jobs/{registry,bootstrap,schedules,send-email}.ts`, `lib/config/config.ts`, `lib/auth/policy.ts`, `lib/logger/logger.ts`, `lib/telemetry/trace-context.ts`, `modules/auth/providers/provider.ts` (`FetchLike`, `providerFetch`), `app.ts`, migrations `20260929000800000_wallet`, `…000900000_payments_and_invoicing`, `…001000000_indexes`, `20261016000100000_team_banking_and_gst_invariants`, `20261020000100000_session_scheduling` (D-75, D-81), `db/schema-deviations.md` (last row D-86), `test/helpers/payment-stand-in.ts`.

---

## Context

### System Requirements
- Every ended PUBLISHED session becomes COMPLETED and is billed exactly once, from `listBillableRegistrations` only, one payment per returned registration, priced from the registration snapshot (C-BIL-1..3). Nothing is half-billed (AC-ERROR-9).
- A covered fee is deducted from the wallet in full (PAID, `PREPAID_CREDIT`, one `AUTO_DEDUCTION`); otherwise a PENDING `PER_GAME` payment is created, due at billing instant + 72 h (B2). All-or-nothing (no partial deduction).
- Wallet per `(user, team)`, balance 0.00-100.00 (B1), top-up through Akahu, ledger with resulting balances, reconciliation.
- Pay-by-bank through Akahu One-Off Payments: platform app credential, team account as payee per call, our page redirects to `authorisation_url` (A1). Webhook verified per A4, treated as a signal, truth re-read from Akahu (A4, A5). Status mapping per A2 including the BANK_ERROR_INDETERMINATE hold.
- `daily-overdue` is the only OVERDUE writer (C-BIL-2). Manual reminders by TEAM_ADMIN and GLOBAL_ADMIN with a 24 h cooldown (B6).
- Payout block (ADR 0016 R3) is triggered manually by a GLOBAL_ADMIN (A3), under `teams FOR NO KEY UPDATE`, never touching the banking columns.
- Every payment-creation path honours C-BIL-PAY (`teams FOR KEY SHARE`, `is_payout_configured` first, insert nothing on failure).

### Technical Constraints
- **C-ALL-1**: billing never writes `registrations`; the lock order in `LOCK_ORDER` is extended, not reinvented.
- **D-75**: the session lifecycle trigger allows PUBLISHED -> COMPLETED; a COMPLETED row is immutable except `version`, `updated_at` and a cut series link.
- `payments_guard_immutable` freezes the snapshot; `status`, `paid_at`, `akahu_payment_id`, `due_date` stay writable. `payment_lines_match_header` is deferred to COMMIT.
- `credit_transactions` already has `fk_credit_tx_wallet` (wallet row must exist first), the 0-100 CHECKs and one AUTO_DEDUCTION per registration.
- Akahu facts (spike, digests only): no idempotency key on one-off create; no webhook event id; unordered delivery, up to 20 retries, 2xx within 10 s; signature `X-Akahu-Payments-Signature` (base64 RSA-SHA256 over raw bytes) with key id in `X-Akahu-Payments-Signing-Key`, key from `GET /v1/webhooks/keys/{keyId}`; cancel only in READY; no documented destination-rejected signal; payee fixed at create; link expiry 15 min to 1 yr.
- The API is reached today only through the web (`API_INTERNAL_URL`); there is no public API ingress (ADR 0007 leaves hosting open, spike U12).
- No raw-body parser and no outbound `traceparent` instrumentation exist; `providerFetch` has a 5 s timeout and no retries.
- Global log redaction redacts keys ending in `token` and `secret`, and the exact key `code` (learned rule `logging-redaction-global`).
- A1 go/no-go: Phases 1-3 must not depend on the live adapter.

### Non-Functional Requirements
- `bill-session` for 30 registrations under 2 s; wallet and payment reads p95 under 300 ms.
- Session COMPLETED and billed within 10 minutes of `ends_at` (5-minute sweep plus job latency).
- P1 integrity (transitions, ledger, cap, idempotency in SQL), P2 money (`Money` only), P3 time (one `now` after locks), P4 (payee decrypted in memory per call; stored Akahu URLs sealed), P5 (every side effect via pg-boss in the triggering transaction; no provider call under a lock), P7 (fail-fast config, adapter by env).
- Privacy: no bank details, emails, Akahu credentials, signatures or raw webhook bodies in logs or job payloads.

---

## Component Analysis

### Core Components

| Component | Purpose | Responsibilities |
|-----------|---------|------------------|
| `lib/akahu/gateway.ts` | Provider port | `PaymentsGateway` (create, get, cancel) and `WebhookKeyResolver` interfaces; provider-neutral result types; `GatewayOutcome` |
| `lib/akahu/status.ts` | A2 vocabulary mapping (pure) | Akahu `status` + `status_reason` -> `GatewayOutcome`; the only file that knows Akahu status strings |
| `lib/akahu/client.ts` + `live-adapter.ts` | Thin REST client (DR-002) | `FetchLike` over `api.payments.akahu.io`; auth header; manual `traceparent`; 429 backoff on reads only; `Money` parsing at the boundary; never retries a create |
| `lib/akahu/fake-adapter.ts` | Deterministic test/dev adapter | Stateless, id-encoded outcomes (works across the API and worker processes); in-process control overlay for tests; recorded calls |
| `lib/akahu/webhook-signature.ts` + `key-cache.ts` | A4 verification | Key-id allow-list, single-flight, positive and negative cache, fetch cap, `crypto.verify` over raw bytes; tri-state result (valid, invalid, unavailable) |
| `lib/akahu/config.ts` + `index.ts` | Factory | `createPaymentsGateway(config, deps)` chooses adapter by `PAYMENTS_ADAPTER` |
| `modules/team-banking/payout-gate.ts` (new public file) | C-BIL-PAY helper | `lockTeamForPayment(trx, teamId)`: `teams FOR KEY SHARE` + `is_payout_configured`; payee ciphertexts for the caller to decrypt after commit |
| `modules/billing/engine.ts` + `engine-repo.ts` | Post-game engine | Sweep selection, `billSession` (one transaction per session), COMPLETED transition (only writer) |
| `modules/billing/charge.ts` | Pure decisions | Fee per party (shared `unitFee`), deduct-or-link (`gte(balance, total)`), B7 zero party, B5 low-credit, B2 due date (via `packages/shared/src/billing/due-date.ts`) |
| `modules/billing/payments-repo.ts` | **Only writer of `payments` and `payment_line_items`** | Insert charge with GST snapshot in one statement; guarded `markPaid`, `markOverdue`; payer-scoped and team-scoped reads |
| `modules/billing/attempts.ts` + `attempts-repo.ts` | Pay-link attempts | tx1 / create / tx2 orchestration; only writer of `payment_attempts` |
| `modules/billing/apply-akahu-result.ts` | The one apply function | Resolve intent by stored provider id, re-read, map, apply under locks; dispatch to attempts or wallet top-ups |
| `modules/billing/overdue.ts` | `daily-overdue` | Only caller of `markOverdue`; overdue emails |
| `modules/billing/reminders.ts` | Manual reminders | Cooldown (B6), replay by `changeKey`, only writer of `payment_reminders` |
| `modules/billing/payout-block.ts` | R3 transaction | `blockPayout(trx, …)`; only writer of `teams.payout_blocked_at` outside team-banking and of `payout_block_events` |
| `modules/billing/{routes,webhook-routes,service,errors,emails}.ts` | HTTP + email builders | Payment, attempt, admin list, reminder, payout-block and webhook routes |
| `modules/wallet/ledger.ts` | **Only writer of `player_credits` and `credit_transactions`** | `ensureWallet`, `lockWallets(sorted)`, `debit`, `credit`; no decisions |
| `modules/wallet/top-up.ts` + `top-up-repo.ts` | Top-up intents | tx1 / create / tx2; `applyTopUpOutcome`; only writer of `wallet_top_ups` |
| `modules/wallet/{routes,service,read-model,errors}.ts` | Wallet API | `GET …/wallet`, `POST …/wallet/top-ups`, `GET …/payments/me` (read through billing's public read) |
| `jobs/{post-game-billing,bill-session,daily-overdue,akahu-sync,akahu-reconcile}.ts` | Job handlers | Thin adapters to the module functions |

### Component Interactions

```
                       cron */5                    cron 0 4 * * *          cron */15
                          |                             |                       |
                 post-game-billing sweep          daily-overdue           akahu-reconcile sweep
                          | enqueue bill-session:<id>   |                       | enqueue akahu-sync:<akahuId>
                          v                             v                       v      (also closes orphan CREATED intents)
                    bill-session ----> billing/engine   billing/overdue     akahu-sync job ---+
                          |               |  uses              |                           |
                          |               +--> billing/charge (pure)                       v
                          |               +--> team-banking/payout-gate          billing/apply-akahu-result
                          |               +--> registrations/billing-handoff        |  re-read via PaymentsGateway.get
                          |               +--> wallet/ledger (debit)                |  +--> billing/attempts-repo + payments-repo (PAID)
                          |               +--> billing/payments-repo (insert)       |  +--> wallet/top-up-repo + wallet/ledger (credit)
                          |               +--> send-email (enqueue, same tx)        |
                                                                                    ^
 Browser -> web -> API  POST /payments/:id/attempts ----tx1--> gateway.create --tx2-+ (no lock held during create)
                        POST /teams/:t/wallet/top-ups ---tx1--> gateway.create --tx2
                        GET  /payments/:id, GET /teams/:t/wallet  (open intent, stale) -> enqueue akahu-sync
 Akahu ----------------> POST /webhooks/akahu: verify (key cache) -> lookup intent -> enqueue akahu-sync -> 200
 GLOBAL_ADMIN ----------> POST /teams/:t/payout-block -> billing/payout-block (teams FOR NO KEY UPDATE)
```

Dependency direction is one way: `billing -> wallet -> platform`, both `-> lib/akahu`, `billing -> registrations/billing-handoff.ts` (public file), `billing, wallet -> team-banking/payout-gate.ts` (public file). `wallet` never imports `billing`; `lib/akahu` imports no module.

---

## Options Explored

### Q1a: Gateway port shape

#### Option 1: One port, provider-neutral outcomes, vendor mapping inside `lib/akahu` (chosen)
- **Description**: `PaymentsGateway` with `createPayment`, `getPayment`, `cancelPayment`, plus a separate `WebhookKeyResolver`. The adapter returns the raw Akahu `status`/`status_reason` (kept for records and logs) **and** a `GatewayOutcome` computed by the pure `lib/akahu/status.ts`. Domain code branches only on `GatewayOutcome`; the A2 table lives in one file with a fixture.
- **Pros**: billing and wallet never see Akahu vocabulary; the fake produces outcomes without re-implementing A2; the A2 table is table-tested once; a U1-negative vendor swap replaces `lib/akahu` only.
- **Cons**: two vocabularies (raw and outcome) to keep consistent; the mapping is "vendor knowledge" that some would put in the domain.
- **Technical Fit**: High (mirrors `Notifier` and the OAuth `Provider` adapters). **Complexity**: Low. **Scalability**: High.

#### Option 2: Port returns raw Akahu statuses; mapping inside `applyAkahuResult`
- **Description**: the adapter is a transport; A2 lives in the billing module.
- **Pros**: one place for "what happens to a payment"; literal reading of A2 ("status mapping in the shared apply function").
- **Cons**: Akahu strings leak into two modules (attempts and top-ups); the fake must emit Akahu strings; a vendor swap touches domain code.
- **Technical Fit**: Medium. **Complexity**: Low. **Scalability**: Medium.

#### Option 3: No port; modules call the Akahu client directly, tests stub `fetch`
- **Pros**: least code.
- **Cons**: Phases 1-3 would depend on the live client (violates A1's go/no-go); tests become HTTP-fixture-heavy everywhere; AC-VERIFY-8's adapter switch has nothing to switch.
- **Technical Fit**: Low. **Complexity**: Low. **Scalability**: Low.

### Q1b: Fake adapter and how test/dev payments complete across processes

The API process creates payments; the worker (sync, reconcile) re-reads them. An in-memory fake loses state across that boundary.

#### Option 1: In-memory fake only
- **Cons**: the worker's fake knows no payment, so E2E (AC-INTEGRATION-4, worker running) cannot complete a payment. Rejected.

#### Option 2: Standalone fake Akahu server (Compose service) + live adapter pointed at it
- **Pros**: exercises the live client and signature verification end to end.
- **Cons**: a second service to build and maintain before Phase 4 exists; Phases 1-3 would then depend on the live adapter (A1); the fake server must sign webhooks with a committed key.
- **Complexity**: Medium-High.

#### Option 3: Stateless deterministic fake with id-encoded outcomes, plus an in-process control overlay (chosen)
- **Description**: `createPayment` returns `providerPaymentId = fake_<scenario>_<amountCents>_<createdAtMs>_<rand>` and `authorisationUrl = redirectUri` (the consent step is "approved instantly"). `getPayment` derives status from the id and the injected clock: scenario from the amount like Akahu's Demo Bank (5.03 -> FAILED/BANK_ERROR, 5.04 -> FAILED/BANK_ERROR_INDETERMINATE, 5.15 -> FAILED/REJECTED, 5.20 -> stays SUBMITTED, 5.30 -> CANCELLED/USER_CANCELLED, any other amount -> SENT). Integration tests additionally inject a `FakeControl` (fail the next create with timeout / 5xx / `invalid_payee` / `single_limit_exceeded`; script a status sequence for an id; a `beforeCreate` probe; recorded calls without payee digits). The webhook key resolver of the fake is a static map; tests inject a generated RSA pair.
- **Pros**: works across processes with no shared state; Phases 1-5 run with no Akahu account; E2E covers success and decline; the probe hook proves "no lock held during create" (AC-ERROR-7).
- **Cons**: the browser never sees a consent page in E2E; the webhook path is covered by integration tests only (signed fixtures), not by Playwright.
- **Technical Fit**: High. **Complexity**: Low. **Scalability**: n/a.

### Q1c: Create flow (A5 binds the shape; the choices are its failure semantics)

#### Option 1: tx1 intent -> inline create outside any transaction -> tx2 record (chosen; A5)
- **Description**: tx1 takes the locks, checks C-BIL-PAY and the one-open rule, inserts the intent `CREATED`, commits. The create runs with no transaction open on the request's connection. tx2 is a guarded `UPDATE … WHERE status = 'CREATED'` that stores the Akahu id, the sealed `authorisation_url`, `expires_at`, and moves to `AWAITING_PAYER` (or straight to the mapped state when Akahu returns a later status). Failure semantics:
  - definite refusal (`invalid_payee`, `invalid_payer`, `single_limit_exceeded`, `bank_limit_exceeded`, other 4xx) -> tx2 closes the intent `NOT_CHARGED` with `close_reason = CREATE_REFUSED` and the provider code -> 422/409 per code (see error table);
  - ambiguous (timeout, network, 5xx, 429 on create) -> tx2 closes `NOT_CHARGED` / `CREATE_UNKNOWN` -> 503 `payment_provider_unavailable`. No blind retry. An orphan Akahu payment may exist in READY, but we never received its URL, so nobody can authorise it, and it expires (`expires_at` is always set, default 30 min);
  - process crash between tx1 and tx2 -> the intent stays `CREATED`; `akahu-reconcile` closes `CREATED` intents older than `AKAHU_RECONCILE_MIN_AGE_SECONDS` as `NOT_CHARGED` / `ORPHANED`;
  - tx2 finds the row no longer `CREATED` (reconcile closed it first) -> best-effort `cancelPayment` and 503.
- **Pros**: synchronous redirect as the spec's routes require; no lock during the Akahu call; every outcome is a durable row.
- **Cons**: a request holds an HTTP call of up to the create timeout; the orphan READY payment is left to expire.

#### Option 2: Queue the create; page polls for the redirect URL
- **Cons**: polling UI on every payment; adds a state; the first-principles review already rejected it (spike "Revised" row). Rejected.

#### Option 3: Create inside tx1
- **Cons**: violates P5 and AC-ERROR-7 (provider call under a lock). Rejected.

### Q1d: Return-page confirmation path (how the player sees the result promptly)

#### Option 1: Display only; rely on webhook and reconcile
- **Cons**: with a 15-minute reconcile and a delayed or failed webhook, the player waits; in E2E there is no webhook at all.

#### Option 2: `GET` re-reads Akahu inline and applies
- **Cons**: an outbound call on a read path breaks the 300 ms p95; GET with a provider call is abusable for rate budget.

#### Option 3: `GET` enqueues a sync job when an open intent is stale (chosen)
- **Description**: `GET /payments/:id` and `GET /teams/:teamId/wallet` (payer or wallet owner only) enqueue `akahu-sync` (`stately`, `singletonKey = akahu-sync:<akahuPaymentId>`) when the caller's intent is open and `last_synced_at` is older than 5 s. They never call Akahu. The worker's job re-reads and applies. `RefreshWhilePending` on the page picks up the result on the next load.
- **Pros**: reads stay fast; the same apply path as webhook and reconcile; the `stately` key and `last_synced_at` throttle collapse refresh storms to one Akahu read per 5 s per intent; works with the stateless fake in E2E.
- **Cons**: a GET with a side effect (an enqueue). Recorded in ADR 0020 as deliberate: it changes no domain state directly, is idempotent, and is scoped to the caller's own intent.

#### Option 4: Explicit `POST …/sync` endpoint called by the return page
- **Cons**: a page render issuing a POST; a new route per intent type; same effect as option 3.

### Q1e: Webhook ingress and verification

Verification follows A4 (no options on the cryptography itself). The options are where verification runs and how the request reaches it.

#### Option 1: Verify in the API on `POST /webhooks/akahu`, reached by a single public path routed to the API at the edge (chosen)
- **Description**: an encapsulated Fastify plugin registers `POST /webhooks/akahu` with `publicRoute()` and a route-scoped `addContentTypeParser('application/json', { parseAs: 'buffer' })`, `bodyLimit` 16 KiB. The host routes exactly that public path to the API component (deployment item, U12). If the host cannot expose a single API path, the fallback is a byte-exact relay route handler in the web app (`apps/web/src/app/webhooks/akahu/route.ts`: reads `arrayBuffer()`, forwards the two signature headers and `content-type` unchanged to `API_INTERNAL_URL`, returns the API's status). Verification stays in the API in both cases.
- **Pros**: the verifier sits next to the key cache, the DB and the queue; the API stays otherwise private.
- **Cons**: one deployment rule to add; the relay fallback adds a hop inside the 10 s budget.

#### Option 2: Verify in the web app and call an internal API endpoint
- **Cons**: the key cache and Akahu credentials would live in the web container (secret sprawl); two trust boundaries. Rejected.

#### Option 3: Expose the whole API publicly
- **Cons**: widens the attack surface to every route for one endpoint. Rejected.

### Q1f: GLOBAL_ADMIN "mark payout blocked" (A3)

#### Option 1: Route + append-only audit table, reusing one R3 transaction function (chosen)
- **Description**: `POST /teams/:teamId/payout-block` with `requireGlobalRole('GLOBAL_ADMIN')`, strict body `{ reason: PayoutBlockReason, akahuPaymentId?: string, changeKey: uuid }`. One function `blockPayout(trx, { teamId, actorUserId, reason, akahuPaymentId, changeKey, now })` in `modules/billing/payout-block.ts`: `teams FOR NO KEY UPDATE`, replay check by `(team_id, change_key)`, set `payout_blocked_at = now` only when NULL, insert one `payout_block_events` row, enqueue one email per approved admin (idempotency `payout-blocked:<teamId>:<eventId>`), and enqueue `akahu-cancel` for the team's intents in `AWAITING_PAYER` (best effort; cancel succeeds only in READY). A future automatic trigger (`invalid_payee` if MVE-003 proves it) calls the same function with `actorUserId = NULL` and `reason = AKAHU_INVALID_PAYEE`. No free-text field: `reason` is an enum (`AKAHU_REPORTED_ACCOUNT_PROBLEM`, `FUNDS_RETURNED`, `TEAM_REQUESTED`, `OTHER`) and the optional evidence is an Akahu payment id, so no bank digits can be typed into the audit row.
- **Pros**: auditable (who, when, why, evidence) and survives the block being cleared by a banking re-save; replay-safe; one R3 path for manual and future automatic triggers.
- **Cons**: a new table and enum.

#### Option 2: Stamp columns on `teams` (`payout_blocked_by`, `payout_blocked_reason`)
- **Cons**: a banking re-save clears the block and would have to clear or keep these, losing history; team-banking's columns would gain billing-owned fields.

#### Option 3: CLI only (`cli billing block-payout`)
- **Cons**: needs DB access for ops; no actor identity; no audit row unless added anyway.

There is no "unblock" action: re-saving the banking details (team admin) clears `payout_blocked_at`, as today (ADR 0016).

### Q2: Payment link identity and what `payment_link_token` holds

#### Option 1: Authenticated, payer-only `/payments/[id]`; the token column becomes a short, non-secret payment reference (chosen)
- **Description**: the email link is `/payments/<paymentId>`; the API route is `authenticated()` and the repo query is `WHERE id = $1 AND user_id = $caller` (uniform 404, no lookup by id alone). The column is renamed `payment_reference` and holds `SGM` + 8 Crockford base32 characters (11 chars, unique), generated at billing time. It is sent as the Akahu payee `reference` on every attempt for that payment, so each deposit on the team's bank statement names the payment it settles, and the admin payments list can show it. Top-ups get their own `reference` in the same format. Knowing a reference grants nothing.
- **Pros**: no bearer capability in email or URL; a departed member can still pay (the route is `authenticated()`, not a team role); team admins can match bank-statement lines to payments (a real reconciliation need: many identical $17.00 deposits); the column name stops implying a secret (a `…token` key is redacted from every log line by the global rules, which would hide a value ops need).
- **Cons**: a sign-in step before paying; a rename migration and factory change (no production rows exist; billing has never run).

#### Option 2: Bearer `payment_link_token` link usable without sign-in
- **Pros**: one click to pay.
- **Cons**: a capability in email, browser history and referrers; must be treated like the invite code (constant-time compare, never logged, rotation); a forwarded email lets anyone see the player's debt and team; the debt gate and payer scoping get a second identity model. Rejected.

#### Option 3: Keep `payment_link_token` as an unused 256-bit random value
- **Pros**: no rename.
- **Cons**: a NOT NULL UNIQUE column with no purpose; misleading name. Rejected.

### Q4a: Ledger invariant enforcement

#### Option 1: Trigger-maintained balance (chosen)
- **Description**: the application only `INSERT`s `credit_transactions` (with its computed `resulting_balance`). A `BEFORE INSERT` trigger locks the wallet row (`FOR NO KEY UPDATE`; free when the caller already holds it), refuses unless `NEW.resulting_balance = balance + NEW.amount` (23514, constraint `credit_transactions_balance_chain`), then sets `player_credits.balance = NEW.resulting_balance`. `player_credits` gets a guard: insert only with `balance = 0.00`; `balance` may change only from inside the ledger trigger (`pg_trigger_depth() > 1`); `user_id`/`team_id` immutable; no delete. `credit_transactions` becomes append-only (reuses `reject_modification`). Type rules as CHECKs: `TOPUP` has `amount > 0`, `akahu_payment_id` and `wallet_top_up_id` set, `registration_id` NULL; `AUTO_DEDUCTION` has `amount < 0` and `registration_id` set; `REFUND` refused by CHECK in v1 (B3 default). Partial unique: one `TOPUP` per `akahu_payment_id`, one per `wallet_top_up_id`.
- **Pros**: "balance = latest `resulting_balance` = running sum from 0" holds by construction for every writer including raw SQL (AC-VERIFY-2); the TypeScript writer cannot drift; no deferred trigger.
- **Cons**: one trigger hop per movement (negligible); the trigger-depth guard is a known but slightly unusual idiom (documented in the ledger row).

#### Option 2: Guarded write in `ledger.ts` plus a deferred consistency trigger
- **Description**: the app updates the balance and inserts the row; a deferred constraint trigger checks the chain at COMMIT.
- **Cons**: two writes that must agree; raw SQL can still update `balance` directly unless a second guard is added; errors surface at COMMIT, far from the cause.

#### Option 3: Application-only guarded write; reconciliation CLI detects drift
- **Cons**: fails AC-VERIFY-2 (the DB must refuse) and P1. Rejected.

### Q4b: Lock order position of the new tables

#### Option 1: Wallet after `payments` (the spec and plan default)
- **Description**: `… -> registration_guests -> payments -> player_credits`.
- **Cons**: `payments.billing_type` is immutable (`payments_guard_immutable`) and is decided by the wallet balance (PREPAID_CREDIT vs PER_GAME). The balance must therefore be read **under the wallet lock before** the payment row is inserted. Locking the wallet after inserting the payment would mean deciding on an unlocked balance (a concurrent deduction from another session could make a PREPAID decision wrong) or inserting and then changing an immutable column. Rejected.

#### Option 2: Wallet and intents between `registration_guests` and `payments` (chosen)
- **Description**: `teams -> recurring_session_rules -> team_members -> game_sessions -> registrations -> registration_guests -> wallet_top_ups -> player_credits -> payments -> payment_attempts`. Multiple wallets in one transaction are locked in ascending `(user_id)` order (all of a session's wallets are in one team).
- **Path check** (every path that holds two of these):
  - `bill-session`: `teams` KEY SHARE -> `game_sessions` FOR UPDATE (hand-off re-takes it FOR SHARE; registrations read unlocked) -> `player_credits` (sorted) -> `payments` (insert only) -> `credit_transactions` (insert; trigger re-locks the held wallet). In order.
  - Top-up start (tx1): `teams` KEY SHARE -> `team_members` FOR SHARE (`assertApprovedMember`) -> `wallet_top_ups` insert. In order.
  - Top-up apply: `wallet_top_ups` FOR NO KEY UPDATE -> `player_credits` (`ensureWallet` + lock) -> `credit_transactions` insert. In order.
  - Attempt start (tx1): `teams` KEY SHARE -> `payments` FOR NO KEY UPDATE -> `payment_attempts` insert. In order.
  - Attempt apply: unlocked lookup of the attempt's `payment_id` -> `payments` FOR NO KEY UPDATE -> `payment_attempts` FOR NO KEY UPDATE. In order (the apply never locks the attempt before its payment).
  - `daily-overdue`: set-based guarded `UPDATE payments` only; holds no wallet, intent or session lock.
  - Reminder: `team_members` FOR SHARE (actor re-check) -> `payments` FOR NO KEY UPDATE -> `payment_reminders` insert. In order.
  - Payout block: `teams` FOR NO KEY UPDATE -> `payout_block_events` insert; admin list read unlocked. Does not conflict with `bill-session`'s `KEY SHARE` (ADR 0016: deliberate).
  - Banking removal: `teams` FOR UPDATE -> `team_banking_in_use` reads `game_sessions`, `payments`, `wallet_top_ups` unlocked.
  - FK checks: inserting `payments` and `credit_transactions` takes `KEY SHARE` on the referenced `registrations` row after the wallet lock. `KEY SHARE` conflicts only with `FOR UPDATE` and key changes, which no registration path takes (registrations are never deleted and updates are `NO KEY`), so this inversion cannot wait. Recorded in ADR 0020 as an order-inverting key-share, like ADR 0018's unlocked O6 read.
- **Pros**: every path is in order; the deduction decision is made under the lock that the write needs anyway.
- **Cons**: differs from the spec's AC-VERIFY-3 sentence and plan principle 2 (see conflicts).

#### Option 3: Wallet first, before `game_sessions`
- **Cons**: `bill-session` would need to know its wallets before locking the session, i.e. read the hand-off before the lock that makes it final. Rejected.

### Q4c: `bill-session` transaction granularity

#### Option 1: One transaction per session (chosen)
- **Description**: complete + all payments + deductions + emails commit together (`SET LOCAL lock_timeout = '5s'`; 55P03/40P01 rethrown as retryable so the job's backoff retries the whole session). 30 registrations is about 120 short statements, comfortably under 2 s.
- **Pros**: AC-ERROR-9 (never half-billed) by construction; a replay sees COMPLETED and does nothing; `UNIQUE(registration_id)` is a second guard.
- **Cons**: a big session holds its wallets for the whole transaction; one bad registration fails the session (visible, retried, `billing.session.failed`).

#### Option 2: One transaction per registration, completion first
- **Cons**: COMPLETED before all charges exist (a crash leaves a completed, partially billed session that the sweep no longer selects); needs a "billing in progress" marker on a row D-75 makes immutable. Rejected.

#### Option 3: Chunked (N registrations per transaction)
- **Cons**: the problems of option 2 plus chunk bookkeeping, for no measured need.

### Q4d: Module split and single writers

#### Option 1: `modules/billing` + `modules/wallet` + `lib/akahu`, one writer file per table (chosen)
- **Description**: billing owns `payments` end to end (engine inserts, apply marks PAID, overdue marks OVERDUE) through one repo file; wallet owns the ledger and top-ups; the shared apply lives in billing and dispatches to `wallet/top-up.ts` for top-ups. A structural test pins every writer.
- **Pros**: matches the plan's file list; one writer file per money table is easy to grep; no dependency cycle.
- **Cons**: billing is the largest module in the repo (~20 files).

#### Option 2: Three modules (`billing` engine, `payments` attempts/apply/webhook/reminders, `wallet`)
- **Pros**: smaller modules.
- **Cons**: `payments` rows are written by two modules (engine insert and status updates) unless one exports a writer to the other, which is option 1 with an extra boundary.

#### Option 3: One module
- **Cons**: the ledger's single writer is harder to state; wallet reads and billing writes mix.

### Q4e: The shared apply function

#### Option 1: Signal -> enqueue `akahu-sync` -> job re-reads -> guarded apply (chosen)
- **Description**: the webhook, reconcile and return pages all **enqueue** `akahu-sync` (`stately`, `singletonKey = akahu-sync:<akahuPaymentId>`), payload `{ akahuPaymentId, source }`. The job calls `applyAkahuResult`. One queued plus one active job per id means a webhook arriving during a run queues exactly one trailing re-read, so a newer status is never lost.
- **Pros**: one code path, one place for idempotency; the webhook answers in milliseconds (no Akahu call except a possible key fetch); natural backpressure.
- **Cons**: about 2 s polling latency added to every confirmation.

#### Option 2: Apply inline in the webhook request
- **Cons**: a key fetch (up to 3 s) plus a re-read (up to 5 s) plus a transaction can pass Akahu's 10 s; a failure mid-way relies on Akahu's retries. Rejected.

---

## Evaluation Matrix

Scores 1 (poor) to 5 (best). Chosen options in bold.

| Criteria | Q1a **1** port + outcome | Q1a 2 raw | Q1b **3** stateless fake | Q1b 2 fake server | Q1d **3** enqueue on GET | Q1d 2 inline GET | Q2 **1** auth + reference | Q2 2 bearer |
|----------|-----|-----|-----|-----|-----|-----|-----|-----|
| Scalability | 5 | 4 | 4 | 4 | 5 | 3 | 5 | 5 |
| Maintainability | 5 | 3 | 5 | 3 | 4 | 4 | 5 | 3 |
| Performance | 5 | 5 | 5 | 4 | 5 | 2 | 5 | 5 |
| Security | 5 | 5 | 4 | 4 | 5 | 3 | 5 | 2 |
| Observability | 4 | 4 | 4 | 5 | 5 | 4 | 5 | 4 |
| Implementation cost | 4 | 5 | 5 | 2 | 4 | 4 | 4 | 3 |

| Criteria | Q4a **1** trigger ledger | Q4a 2 deferred check | Q4b **2** wallet before payments | Q4b 1 after | Q4c **1** per session | Q4c 2 per registration | Q4e **1** enqueue sync | Q4e 2 inline |
|----------|-----|-----|-----|-----|-----|-----|-----|-----|
| Scalability | 4 | 4 | 4 | 4 | 4 | 5 | 5 | 3 |
| Maintainability | 5 | 3 | 5 | 2 | 5 | 2 | 5 | 3 |
| Performance | 5 | 5 | 5 | 5 | 4 | 4 | 4 | 4 |
| Security / integrity | 5 | 4 | 5 | 2 | 5 | 2 | 5 | 4 |
| Observability | 4 | 3 | 4 | 4 | 5 | 3 | 5 | 4 |
| Implementation cost | 4 | 3 | 4 | 4 | 5 | 3 | 4 | 4 |

---

## Observability Architecture

### Logging
- **Library**: the existing pino logger (`lib/logger/logger.ts`) with trace bindings; no `console`.
- **Format**: structured JSON with `traceId`, `spanId`, `service`, `version`; amounts as `MoneyString`; ids only.
- **Events** (field names grepped against the global redaction keys before use, learned rule `logging-redaction-global`; error codes logged as `errorCode`/`sqlState`, never `code`):

| Event | Level | Fields |
|-------|-------|--------|
| `billing.sweep.enqueued` | info | `count`, `oldestEndsAt` |
| `billing.session.completed` | info | `sessionId`, `teamId`, `payments`, `deducted`, `linked`, `zero`, `durationMs` |
| `billing.session.skipped` | debug | `sessionId`, `reason` (`already_completed`, `not_published`, `not_ended`) |
| `billing.session.blocked` | warn | `sessionId`, `teamId` (B8 hold) |
| `billing.session.failed` | error | `sessionId`, `errorClass`, `sqlState` |
| `billing.overdue.marked` | info | `count` |
| `billing.reminder.sent` / `.refused` | info | `paymentId`, `teamId`, `actorId`, `reason` |
| `billing.payout.blocked` | warn | `teamId`, `actorId`, `blockReason`, `eventId`, `alreadyBlocked` |
| `billing.attempt.started` / `.closed` / `.held` | info / info / warn | `attemptId`, `paymentId`, `akahuPaymentId`, `outcome`, `closeReason` |
| `billing.payment.paid` | info | `paymentId`, `attemptId`, `amount` |
| `wallet.topup.started` / `.credited` / `.closed` / `.overflow` | info / info / info / warn | `topUpId`, `amount`, `resultingBalance`, `closeReason` |
| `akahu.request` | info (warn on non-2xx) | `operation` (`create`, `get`, `cancel`, `key`), `httpStatus`, `durationMs`, `outcome` |
| `akahu.webhook.accepted` / `.rejected` / `.ignored` / `.unmatched` | info / warn / info / info | `reason`, `akahuPaymentId` (accepted, unmatched), `signingKeyIdHash` (never the raw id) |
| `akahu.sync.applied` | info | `akahuPaymentId`, `source`, `fromStatus`, `toStatus`, `providerStatus`, `providerStatusReason` |
| `akahu.sync.anomaly` | error | `akahuPaymentId`, `kind` (`amount_mismatch`, `late_success`, `duplicate_success`, `not_found`) |
| `akahu.reconcile.stuck` | warn | `intentKind`, `intentId`, `ageSeconds` |

- **Never logged**: payee name or account number (decrypted only inside the create call), `AKAHU_APP_TOKEN`/`AKAHU_APP_SECRET`, `authorisation_url`, the signature and signing-key header values, raw webhook bodies, email addresses, payment references in email payloads. The logger's `REDACT_PATHS` gains `req.headers["x-akahu-payments-signature"]` and `req.headers["x-akahu-payments-signing-key"]` (A4). `authorisationUrl` and `payeeAccountNumber` are added to the field patterns.

### Distributed Tracing
- **SDK**: OpenTelemetry (existing `lib/telemetry`). **Propagation**: W3C Trace Context.
- **Service Boundaries**:

| From | To | Protocol | Propagation Method |
|------|-----|----------|-------------------|
| web | API | HTTP | `traceparent` header (existing `api-client.ts`) |
| API / worker | Akahu Payments API | HTTPS | `traceparent` injected manually from `currentTrace()` (DR-002; no outbound instrumentation exists); client span `akahu POST /v1/one-off-payments` etc. |
| Akahu | API webhook | HTTPS | none from Akahu: the route starts a root span `akahu.webhook`; the enqueued `akahu-sync` job carries that trace context (existing job trace propagation) |
| API | pg-boss (`akahu-sync`, `send-email`) | Postgres | trace context in job payload metadata (existing `lib/jobs` pattern) |
| `post-game-billing` sweep | `bill-session` | Postgres | sweep trace context carried into each job |
| `akahu-reconcile` | `akahu-sync` | Postgres | sweep trace context carried into each job |

- **Sampling**: `OTEL_TRACES_SAMPLER_ARG` (existing; 1.0 dev, production ratio set at deployment).

### Metrics
- No metrics exporter exists yet (ADR 0013/0015/0018 precedent). Names reserved and asserted in a naming test so the later exporter uses them:
  - `billing_sessions_billed_total{outcome}` (`completed`, `blocked`, `failed`)
  - `billing_payments_total{billing_type}` (`PREPAID_CREDIT`, `PER_GAME`)
  - `billing_overdue_marked_total`
  - `akahu_requests_total{operation,outcome}` and `akahu_request_duration_seconds{operation}`
  - `akahu_webhooks_total{outcome}` (`accepted`, `rejected`, `ignored`, `unmatched`, `unavailable`)
  - `akahu_intents_open{kind}` (gauge from the reconcile sweep)
- Labels never carry user, team, payment or Akahu ids.

### Configuration Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `LOG_LEVEL` | Log verbosity | info |
| `LOG_FORMAT` | Output format | json |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector endpoint | - |
| `OTEL_SERVICE_NAME` | Service identifier | - |
| `OTEL_TRACES_SAMPLER_ARG` | Sampling ratio | 1.0 (dev) |
| `PAYMENTS_ADAPTER` | `akahu` or `fake` (A6) | `fake`; `fake` refused when `NODE_ENV=production` |
| `AKAHU_APP_TOKEN` | Akahu app id token (platform credential) | required iff `akahu` |
| `AKAHU_APP_SECRET` | Akahu app secret | required iff `akahu` |
| `AKAHU_PAYMENTS_API_URL` | Payments API base | `https://api.payments.akahu.io`; https required in production, and the host must end in `.akahu.io` in production |
| `AKAHU_WEBHOOK_URL` | Absolute public URL sent as `webhook_uri` (no query string) | required iff `akahu`; https in production |
| `AKAHU_PAYMENT_EXPIRY_MINUTES` | `expires_at` for every create | 30 (15-120) |
| `AKAHU_RECONCILE_MIN_AGE_SECONDS` | Age before reconcile re-reads an intent or closes a `CREATED` orphan | 120 (60-3600; must exceed the create timeout) |
| `AKAHU_RECONCILE_STUCK_AFTER_SECONDS` | Age after which an open intent logs `akahu.reconcile.stuck` | 21600 (3600-604800) |

Fixed constants (code, like `PROVIDER_TIMEOUT_MS`, in `lib/akahu/constants.ts`): create timeout 8 s, read/cancel timeout 5 s, key fetch timeout 3 s, key cache TTL 24 h, negative cache TTL 10 min, key fetch cap 6 per minute per process, sync throttle 5 s, 429 backoff for reads (honour `Retry-After`, max 2 retries). Config issues name the variable, never the value; `.env.example` and `docs/getting-started.md` list every variable.

---

## Decision

### Q1a. Gateway port: **Option 1** (port with provider-neutral outcomes)

```ts
// lib/akahu/gateway.ts (provider-neutral; no Akahu strings)
export type GatewayOutcome =
  | { readonly kind: 'OPEN'; readonly phase: 'AWAITING_PAYER' | 'IN_FLIGHT' }
  | { readonly kind: 'SUCCEEDED' }
  | { readonly kind: 'NOT_CHARGED' }        // CANCELLED/*, FAILED/{REJECTED,BANK_ERROR,INTERNAL_ERROR}
  | { readonly kind: 'INDETERMINATE' }      // FAILED/BANK_ERROR_INDETERMINATE -> hold (A2)
  | { readonly kind: 'UNRECOGNISED' };      // unknown status or reason -> leave open, log (A2)

export interface ProviderPayment {
  readonly providerPaymentId: string;
  readonly amount: Money;
  readonly providerStatus: string;          // raw, for records and logs
  readonly providerStatusReason: string | null;
  readonly outcome: GatewayOutcome;
}

export type CreatePaymentResult =
  | { readonly ok: true; readonly payment: ProviderPayment; readonly authorisationUrl: string }
  | { readonly ok: false; readonly kind: 'refused'; readonly providerCode: CreateRefusalCode }
  | { readonly ok: false; readonly kind: 'unavailable' };   // timeout, network, 5xx, 429: ambiguous

export interface PaymentsGateway {
  readonly adapter: 'akahu' | 'fake';
  createPayment(input: {
    readonly amount: Money;
    readonly payee: { readonly name: string; readonly accountNumber: string };  // plaintext, in memory only
    readonly reference: string;          // payment_reference or top-up reference (<= 12 chars)
    readonly redirectUri: string;
    readonly webhookUri: string;
    readonly expiresAt: Date;
  }): Promise<CreatePaymentResult>;
  getPayment(providerPaymentId: string): Promise<ProviderPayment | 'not_found'>;  // throws GatewayUnavailableError
  cancelPayment(providerPaymentId: string): Promise<'cancelled' | 'not_cancellable'>;
  readonly webhookKeys: WebhookKeyResolver;
}

export interface WebhookKeyResolver {
  /** 'unknown' is cacheable; a thrown GatewayUnavailableError is transient (webhook answers 503). */
  resolve(keyId: string): Promise<KeyObject | 'unknown'>;
}
```

- `lib/akahu/status.ts` holds the A2 table and nothing else; `apps/api/test/fixtures/akahu-status-matrix.ts` lists every documented status/reason pair plus two unknowns, replayed by the unit test. `SENT` is the only `SUCCEEDED`; `SETTLEMENT_IN_PROGRESS` is `OPEN/IN_FLIGHT`.
- The live client parses amounts at the boundary without floats: response amounts are validated as decimal text (`^\d+(\.\d{1,2})?$` on the JSON source text via the `JSON.parse` reviver `context.source`, falling back to `String(value)` validation) and converted with `parseMoney`; request amounts are emitted with `JSON.rawJSON(toMoneyString(amount))`. Both APIs exist in the repo's Node version; re-confirm at the Phase 4 gate.
- The payee name is normalised to Akahu's charset and 2-70 length by `lib/akahu/payee.ts` (pure; rules re-read from the live docs at the Phase 4 gate, A7). A name that cannot be normalised is a local `payee_unusable` refusal: no Akahu call, the intent closes `NOT_CHARGED/CREATE_REFUSED`, the player sees the payout-problem copy, and ops is alerted by `billing.attempt.closed` with `closeReason = payee_unusable`. It does **not** set `payout_blocked_at` (A3: only the GLOBAL_ADMIN action does).
- The auth header (HTTP Basic vs `AppSecret` scheme) and signature padding stay unknowns (U5) behind the client; MVE-005 settles them before the live adapter is built (A7).

### Q1b. Fake adapter: **Option 3** (stateless, id-encoded, plus an in-process control overlay)
- `PAYMENTS_ADAPTER=fake` is the default outside production and the only adapter Phases 1-3 need. `createPaymentsGateway` refuses `fake` in production at config time (P7, AC-VERIFY-8).
- E2E (`apps/web/e2e/billing.spec.ts`) runs with the fake: success at $17.00, decline at $5.15 (a fixture session fee), "processing" at $5.20.
- Recorded calls hold amount, reference, redirect and webhook URIs and a `payeeAccountLast4` only, so a test can assert "the payee is T's account" without the digits ever entering a snapshot.

### Q1c. Create flow: **Option 1** (tx1 / inline create / tx2, A5)

Attempt start, `POST /payments/:paymentId/attempts` (`authenticated()`, payer only), strict body `{ idempotencyKey: uuid }`:
1. Unlocked read: payment by `(id, user_id = caller)`; none -> 404 `not_found` (same body for every non-payer).
2. **tx1** (`lock_timeout` 3 s): `lockTeamForPayment(trx, payment.teamId)` (`teams FOR KEY SHARE`; `is_payout_configured` false -> 409 `payout_not_configured`, nothing inserted); `payments FOR NO KEY UPDATE` by `(id, user_id)`; PAID -> 409 `payment_settled`; an attempt with this `idempotencyKey` -> replay its answer; a blocking attempt (open or HELD; the partial unique index is the backstop, 23505 mapped) -> 409 `payment_in_progress` with `{ redirectUrl | null }` or 409 `payment_on_hold`; insert attempt `CREATED` (`amount = payment.amount`, `reference = payment.payment_reference`); read the payee ciphertexts in the same statement as the team lock; commit.
3. Outside any transaction: decrypt payee (FieldCrypto, in memory), `gateway.createPayment` with `redirectUri = ${WEB_BASE_URL}/payments/<id>?return=1`, `webhookUri = AKAHU_WEBHOOK_URL`, `expiresAt = now + AKAHU_PAYMENT_EXPIRY_MINUTES`. The plaintext goes out of scope right after the call.
4. **tx2**: guarded `UPDATE payment_attempts … WHERE id = $1 AND status = 'CREATED'` per the failure semantics above, then answer 201 `{ redirectUrl }`. tx2 does not touch `payments`: `payments.akahu_payment_id` is written only when the payment becomes PAID, because it names the Akahu payment that settled it.

Top-up start, `POST /teams/:teamId/wallet/top-ups` (`requireTeamRole('MEMBER')`), is the same shape: tx1 takes `teams FOR KEY SHARE` + payout check, `assertApprovedMember` (`team_members FOR SHARE`), reads the balance (unlocked: only credits raise it, and the one-open-top-up index means no other credit can be in flight for this wallet), checks B1 minimum and headroom (422 with the limit), replays by `(user_id, team_id, idempotency_key)`, inserts `CREATED` (23505 on the one-open index -> 409 `top_up_in_progress` with the open one), commits; create; tx2. The credit itself happens only in `applyAkahuResult` on `SUCCEEDED`, which re-checks the cap under the wallet lock (B3 path decided by the algorithm doc; the ledger never clamps).

**Error codes added** to `packages/shared/src/api/errors.ts`: `payment_settled` (409), `payment_in_progress` (409), `payment_on_hold` (409), `top_up_in_progress` (409), `payment_provider_unavailable` (503), `payment_provider_refused` (422; carries a stable `reason`: `amount_over_bank_limit`, `payer_bank_unavailable`, `payee_unusable`), `reminder_too_soon` (409). `payout_not_configured` and `not_found` are reused.

### Q1d. Return pages: **Option 3** (GET enqueues `akahu-sync` for the caller's stale open intent)
- `GET /payments/:id` and `GET /teams/:teamId/wallet` enqueue at most one sync per intent per 5 s and never call Akahu.
- `akahu-sync` handler stamps `last_synced_at` in its own transaction after the re-read, so the throttle reflects real reads.

### Q1e. Webhook: **Option 1** (verify in the API; single public path)

`POST /webhooks/akahu` (`publicRoute()`, raw body, 16 KiB limit). Order of checks, each with its answer:

| Step | Check | Failure answer | Log |
|------|-------|----------------|-----|
| 1 | Both headers present; `X-Akahu-Payments-Signing-Key` matches `^[A-Za-z0-9_-]{1,128}$`; signature is base64 of a plausible length | 401 | `akahu.webhook.rejected reason=missing_header / bad_key_id / bad_signature_format` |
| 2 | `keys.resolve(keyId)`: positive cache hit, else single-flight fetch `GET {AKAHU_PAYMENTS_API_URL}/v1/webhooks/keys/{encodeURIComponent(keyId)}` (fixed host, app credential), subject to the per-process fetch cap; negative cache 10 min for `unknown` (404 or 4xx) | `unknown` -> 401; fetch timeout / 5xx / 429 / cap reached -> **503** (Akahu retries) | `rejected reason=unknown_key`; `unavailable reason=key_fetch_failed / key_fetch_capped` |
| 3 | `crypto.verify('sha256', rawBody, key, signatureBytes)` (padding confirmed by MVE-005) | 401 | `rejected reason=signature_mismatch` |
| 4 | Parse JSON (non-strict object: unknown fields ignored); `type === 'ONE_OFF_PAYMENT_STATUS_UPDATE'`; `_payment` is a string | 200 (Akahu must not retry a signed but unusable event) | `ignored reason=malformed / other_type` |
| 5 | Look up the intent by stored `akahu_payment_id` in `payment_attempts`, then `wallet_top_ups` (unlocked read). `webhook_uri` query parameters are never read | none found -> 200 | `unmatched` |
| 6 | Enqueue `akahu-sync` (`source: 'webhook'`) | enqueue failure -> 503 | `accepted` |

- The body's `status` is never trusted; it is logged as `hintStatus` only. Replays and duplicates enqueue a sync that finds nothing to change (AC-ERROR-6).
- The key-id value is logged only as a short SHA-256 prefix (`signingKeyIdHash`) so a hostile id cannot inject log content.

### Q1f. Manual payout block: **Option 1** (route + `payout_block_events` + one R3 function)
- `POST /teams/:teamId/payout-block`, `requireGlobalRole('GLOBAL_ADMIN')` (not a team role: the actor is ops, and a TEAM_ADMIN must not be able to block their own payouts as a way to stop collections), strict body as above, answers 200 `{ payoutBlockedAt, alreadyBlocked }`; 404 for an unknown team; replay by `changeKey` returns the first answer.
- Placement in the UI is for the UI/UX doc; the recommended minimum is a GLOBAL_ADMIN-only control in the Payments manage area (which a GLOBAL_ADMIN can already open) using `ConfirmDisclosure`, plus `cli billing block-payout` for ops scripts that calls the same service with an operator-supplied actor id.
- The player-facing copy "This team can't receive payments right now. We've told the team admins." is driven by `is_payout_configured = false` on the payment read model and by the 409 from the attempt route.

### Q2. Payment link identity: **Option 1**
- Email link `/payments/<paymentId>`; route `authenticated()`; repo scoped by payer; uniform 404.
- `payments.payment_link_token` is renamed `payment_reference` (`varchar(12)`, UNIQUE, format CHECK `^SGM[0-9A-HJKMNP-TV-Z]{8}$`, immutable via `payments_guard_immutable`), generated by `modules/billing/reference.ts` (`crypto.randomBytes`, Crockford base32, retry on 23505 up to 3 times inside the billing transaction via a savepoint). `wallet_top_ups.reference` uses the same generator and format.

### Q4a. Ledger enforcement: **Option 1** (trigger-maintained balance)

### Q4b. Lock order: **Option 2**

```
teams -> recurring_session_rules -> team_members -> game_sessions -> registrations -> registration_guests
      -> wallet_top_ups -> player_credits -> payments -> payment_attempts
```
- `LOCK_ORDER` in `modules/sessions/locks.ts` gains the three entries; ADR 0020 records the positions and the FK key-share inversion; the lock-order test asserts the constant.
- Several wallets in one transaction: `ledger.lockWallets(trx, teamId, userIds)` sorts ascending and issues one `SELECT … ORDER BY user_id FOR NO KEY UPDATE`.

### Q4c. `bill-session`: **Option 1** (one transaction per session)

Handler steps (payload `{ sessionId }` only):
1. Unlocked read of the session's `team_id` and paid-ness inputs.
2. Transaction, `SET LOCAL lock_timeout = '5s'`:
   1. `lockTeamForPayment` (`teams FOR KEY SHARE`, read `is_payout_configured`).
   2. `lockSession` (`game_sessions FOR UPDATE`); not PUBLISHED -> no-op (`billing.session.skipped`).
   3. `now = clock.now()` (once, after the locks); `now < ends_at` -> no-op.
   4. `listBillableRegistrations(trx, sessionId, now)`.
   5. If the session is paid, the list is non-empty and payout is not configured: B8 hold (claim `billing_hold_notices (session_id, payout_blocked_at)`; if the claim is new, enqueue one "Billing is paused" email per approved admin), commit, return. The exact B8 predicate (for example a list whose every total is $0.00) is the algorithm doc's.
   6. Guarded `UPDATE game_sessions SET status = 'COMPLETED' WHERE id = $1 AND status = 'PUBLISHED'` (`engine-repo.ts`, the only COMPLETED writer). The hand-off returns the same list for a COMPLETED session, so completing first is safe and makes the update the idempotency gate.
   7. Pure `charge.ts`: per registration, per-party fees from the snapshot and the session `fee_*` columns (`unitFee`), total, and B7 zero.
   8. `ledger.lockWallets` for the registrations with a non-zero total that have a wallet row (no wallet = balance 0, nothing to lock; no wallet row is created by billing).
   9. Per registration in hand-off order: decide (`gte(balance, total)` -> PREPAID_CREDIT/PAID; else PER_GAME/PENDING with `due_date` from B2); `payments-repo.insertCharge` (one `INSERT … SELECT` that reads `teams.gst_registered` and `gst_number` and writes the rate from `GST_RATE_BPS`, so the snapshot comes from one statement), line items; for PREPAID, `ledger.debit` (`AUTO_DEDUCTION`, `registration_id`), then the B5 low-credit decision; enqueue emails (`payment-due:<paymentId>` sealed; `low-credit:<creditTransactionId>`).
3. Commit. Constraint failures (`payment_lines_match_header`, `credit_transactions_balance_chain`, 23505) are permanent (`NonRetryableJobError`, `billing.session.failed`); lock timeouts and deadlocks are retryable.

The sweep selects `status = 'PUBLISHED' AND ends_at <= now ORDER BY ends_at, id LIMIT 500` (new partial index `idx_game_sessions_published_ends_at`) and enqueues `bill-session` with `singletonKey = bill-session:<id>` on a new `exclusive` queue. B9 pacing beyond oldest-first is the algorithm doc's.

### Q4d. Modules: **Option 1**, with these single writers (pinned by `modules/billing/boundaries.test.ts`, which scans all of `apps/api/src` like the registrations test)

| Table or column | Only writer file | Only importer of the writer |
|-----------------|------------------|-----------------------------|
| `payments` (insert, status, `paid_at`, `akahu_payment_id`) and `payment_line_items` | `modules/billing/payments-repo.ts` | `insertCharge`: `engine.ts`; `markPaid`: `apply-akahu-result.ts` (and the HELD ops path); `markOverdue`: `overdue.ts` |
| `game_sessions.status = 'COMPLETED'` | `modules/billing/engine-repo.ts` | `engine.ts` |
| `payment_attempts` | `modules/billing/attempts-repo.ts` | `attempts.ts`, `apply-akahu-result.ts`, reconcile |
| `payment_reminders` | `modules/billing/reminders.ts` | routes / service |
| `teams.payout_blocked_at` (set), `payout_block_events` | `modules/billing/payout-block.ts` | billing service, CLI |
| `billing_hold_notices` | `modules/billing/engine-repo.ts` | `engine.ts` |
| `player_credits`, `credit_transactions` | `modules/wallet/ledger.ts` | `engine.ts` (debit), `wallet/top-up.ts` (credit) |
| `wallet_top_ups` | `modules/wallet/top-up-repo.ts` | `wallet/top-up.ts` |

Grep tests (AC-VERIFY-11): the literal `'OVERDUE'` assigned to `payments.status` appears only in `payments-repo.ts#markOverdue`, imported only by `overdue.ts`; `'COMPLETED'` assigned to `game_sessions.status` appears only in `engine-repo.ts`; no file under `modules/billing`, `modules/wallet` or `lib/akahu` writes `registrations`; `lib/akahu` imports no `modules/*`; `wallet` imports no `billing`; gateway `createPayment`/`getPayment`/`cancelPayment` are called only from `attempts.ts`, `wallet/top-up.ts`, `apply-akahu-result.ts`, the reconcile sweep and `payout-block.ts`'s cancel job.

### Q4e. Shared apply: **Option 1** (`applyAkahuResult` via the `akahu-sync` job)

```
applyAkahuResult({ db, gateway, jobs, clock, logger }, { akahuPaymentId, source })
  1. intent := unlocked lookup by stored akahu_payment_id (attempts, then top-ups); none -> 'unmatched' (no-op)
  2. view := gateway.getPayment(akahuPaymentId)          // outside any transaction; throws -> job retry
     'not_found' -> akahu.sync.anomaly kind=not_found, leave intent as is
  3. view.amount != intent.amount -> HOLD (anomaly amount_mismatch); never credit or mark PAID
  4. transaction:
       attempt: payments FOR NO KEY UPDATE -> payment_attempts FOR NO KEY UPDATE
       top-up:  wallet_top_ups FOR NO KEY UPDATE -> (on SUCCEEDED) ledger.ensureWallet + lock
     now := clock.now()
     by view.outcome (A2), each a guarded, state-monotonic transition (terminal states are absorbing):
       OPEN          -> intent CREATED|AWAITING_PAYER -> AWAITING_PAYER|IN_FLIGHT; payment unchanged
       SUCCEEDED     -> attempt: intent -> SUCCEEDED; payment PENDING|OVERDUE -> PAID (paid_at = now,
                        akahu_payment_id); "Payment received" email (payment-received:<paymentId>)
                        top-up:  intent -> SUCCEEDED; ledger.credit TOPUP (cap re-checked; B3 path from the
                        algorithm doc if it would exceed 100.00)
                        intent already terminal, or payment already PAID -> B3 record (anomaly late_success /
                        duplicate_success) + notify per algorithm doc; never PAID twice, never invent credit
       NOT_CHARGED   -> intent -> NOT_CHARGED (close_reason from provider status); payment stays payable
       INDETERMINATE -> intent -> HELD; payment stays PENDING|OVERDUE but not payable (the HELD row blocks a
                        new attempt through the partial unique index); ops flagged (A2)
       UNRECOGNISED  -> no transition; akahu.sync.applied toStatus=unchanged at warn
     stamp provider_status, provider_status_reason, last_synced_at
```
- Every caller (webhook, reconcile, GET throttle) only enqueues; the job is the one caller of `applyAkahuResult`. Concurrent jobs for the same id are serialised by `stately` and, if two still overlap (a redelivery during an active run), by the row locks and guarded transitions (AC-INTEGRATION-3: one PAID, one TOPUP).
- Reconcile (`akahu-reconcile`, `*/15 * * * *`, interval sweep): (a) closes `CREATED` intents older than the min age as `NOT_CHARGED/ORPHANED`; (b) enqueues `akahu-sync` for open intents older than the min age whose `last_synced_at` is older than a backoff (min age, then hourly after 1 h); (c) logs `akahu.reconcile.stuck` past the stuck age. HELD intents are **not** re-read (INDETERMINATE is terminal at Akahu; reconcile cannot resolve it, A4 condition 2).

### Q4f. Migration D-87 onwards (one reversible file, `db/migrations/<utc>_wallet_and_billing.sql`)

| Ledger | Contents |
|--------|----------|
| D-87 | `payments_guard_status` BEFORE UPDATE trigger: allowed `PENDING -> PAID`, `PENDING -> OVERDUE`, `OVERDUE -> PAID`, same-status; `PAID` terminal; nothing enters `FAILED` (B4 default); 23000, constraint `payments_status_transition`. TS twin `packages/shared/src/billing/payment-status.ts`, fixture `apps/api/test/fixtures/payment-transitions.ts` |
| D-88 | `payments.gst_number varchar(9)`; CHECK `payments_gst_number_iff_registered` (`gst_registered = (gst_number IS NOT NULL)` and the `teams` format); added NOT VALID then VALIDATE; `payments_guard_immutable` replaced to include `gst_number` and `payment_reference` (down restores the old body) |
| D-89 | Rename `payment_link_token` -> `payment_reference`; cleanup step regenerates any value that does not match the new format (dev and test rows only; production has none); `ALTER TYPE varchar(12)`; format CHECK; UNIQUE kept |
| D-90 | Enum `payment_intent_status` (`CREATED`, `AWAITING_PAYER`, `IN_FLIGHT`, `SUCCEEDED`, `NOT_CHARGED`, `HELD`; final names and any extra terminal state for B3 from the algorithm doc), enum `intent_close_reason` |
| D-91 | `payment_attempts`: `id`, `payment_id` FK RESTRICT, `idempotency_key uuid`, `amount numeric(10,2) > 0`, `status`, `close_reason`, `akahu_payment_id varchar(64) UNIQUE`, `authorisation_url_enc` (FieldCrypto envelope, AAD `sgm:v1:payment_attempts.authorisation_url:<id>`), `provider_status`, `provider_status_reason`, `expires_at`, `last_synced_at`, `created_at`, `closed_at`, anomaly columns (from algorithm doc); UNIQUE `(payment_id, idempotency_key)`; partial unique `uq_payment_attempts_one_blocking (payment_id) WHERE status IN ('CREATED','AWAITING_PAYER','IN_FLIGHT','HELD')`; stamp CHECKs (`akahu_payment_id` set iff past `CREATED` unless closed at create; `closed_at` iff terminal); status guard trigger with TS twin (matrix from the algorithm doc); index on open intents by `created_at` |
| D-92 | `wallet_top_ups`: same shape with `user_id`, `team_id` (FKs RESTRICT), `reference` (format CHECK, UNIQUE), `amount` CHECK 1.00-100.00 (B1); UNIQUE `(user_id, team_id, idempotency_key)`; partial unique `uq_wallet_top_ups_one_blocking (user_id, team_id) WHERE status IN (open, HELD)`; status guard trigger |
| D-93 | Ledger: `credit_transactions.wallet_top_up_id` FK; type CHECKs (`credit_transactions_type_shape`, `REFUND` refused in v1); partial uniques `uq_credit_tx_topup_akahu_payment`, `uq_credit_tx_topup_intent`; `credit_transactions_ledger_chain` BEFORE INSERT trigger (chain check + balance write); `credit_transactions_append_only` (`reject_modification`); `player_credits_guard` (insert at 0.00, balance only from the ledger trigger, keys immutable, no delete) |
| D-94 | `team_banking_in_use` replaced: adds `OR EXISTS (open or HELD wallet_top_ups for the team)` (A8). `FAILED` is not added (B4: never set). Service, trigger and the parity test change together (AC-VERIFY-11) |
| D-95 | `payment_reminders` (append-only: `id`, `payment_id`, `actor_user_id`, `kind` (`MANUAL`), `change_key uuid`, `created_at`; UNIQUE `(payment_id, change_key)`; index `(payment_id, created_at DESC)`) |
| D-96 | Enum `payout_block_reason`; `payout_block_events` (append-only: `id`, `team_id`, `actor_user_id` NULL only for a future automatic trigger, `reason`, `akahu_payment_id`, `change_key`, `created_at`; UNIQUE `(team_id, change_key)`) |
| D-97 | `billing_hold_notices (session_id, payout_blocked_at)` PK, claim table for the B8 once-per-block-episode email (pattern of D-81 `payout_notice_claims`) |
| D-98 | Indexes: `idx_game_sessions_published_ends_at (ends_at) WHERE status = 'PUBLISHED'`; `idx_payments_pending_due (due_date) WHERE status = 'PENDING'`; `idx_payments_team_status_due (team_id, status, due_date)` |

- **D-75 allowlist: no widening.** Billing writes a session row once, in the PUBLISHED -> COMPLETED update, which the matrix already allows; the B8 hold writes a claim row, not the session. ADR 0020 records "no widening" explicitly (ADR 0019 asked for it to be recorded either way).
- `LOCK_ORDER` constant change and the regenerated `types.generated.ts` ship with the migration in Phase 1.
- Every object above is a ledger row; `schema.int.test.ts` round-trips `db:rollback` / `db:migrate`.

### ADR 0020 outline (`docs/adr/0020-wallet-and-akahu-billing.md`)

1. Status: Proposed; becomes Accepted only after Akahu's written MVE-001 answer (A1). If that answer brings a payee-verification liability term, the human rules on verifying team bank details at save time first.
2. Context: the product needs collection into each team's account; ADR 0016 (platform credentials, C-BIL-PAY, R3, GST snapshot), ADR 0018 (C-BIL-1..3, C-ALL-1), ADR 0019 (COMPLETED via billing, D-75), ADR 0004, 0009, 0012; the spike and its overrides OV-1..OV-3.
3. Decision, provider: Akahu One-Off Payments, platform app credential, payee per call at payment time (B10), redirect from our pages; no per-player or per-team Akahu credentials; thin client, no SDK; the port and the fake; env names.
4. Decision, money flow: billing engine (one transaction per session, completion first, C-BIL-PAY first), deduct-or-link, B1-B10 as ruled, all-or-nothing.
5. Decision, ledger: trigger-maintained balance; type shapes; append-only.
6. Decision, lock order: the extended `LOCK_ORDER`, multi-wallet sorting, the FK key-share inversion.
7. Decision, intents and apply: tx1 / create / tx2, one blocking intent per payment and per wallet, the A2 mapping including HELD, sync job, reconcile, sync-on-GET exception.
8. Decision, webhook: A4 conditions, ingress (single public path; relay fallback), answer codes.
9. Decision, R3: manual GLOBAL_ADMIN trigger (amends ADR 0016 R3's "when Akahu declines" to "when ops records a payout problem"); `payout_block_events`; REJECTED never blocks.
10. Decision, payment identity: authenticated payer-only page; `payment_reference`.
11. Contracts this ADR exports: C-WAL-1 (only `wallet/ledger.ts` writes the ledger; balance maintained by trigger), C-BIL-4 (only `daily-overdue` writes OVERDUE; only `bill-session` writes COMPLETED; `payments` rows are written only through `payments-repo.ts`), C-BIL-5 (read models for player-dashboard and admin-reporting-dashboard: `GET …/payments/me`, `GET /teams/:teamId/payments`, the reminder route), C-INV-1 (for tax-invoices-and-exports: the snapshot including `gst_number`; this feature never sets `is_tax_invoice_issued`).
12. Akahu contract citations with retrieval dates and fixture provenance labels (sandbox-real, vendor-doc-derived, synthetic) (AC-INTEGRATION-1, A7).
13. Consequences and one-way doors (funds-flow model, the deployed migration, the Akahu contract), D-75 "no widening", rejected alternatives (enduring payments, SDK, bearer links, per-registration billing, wallet after payments).

### Rationale
The port with neutral outcomes isolates the one unproven dependency (Akahu, conditional on U1) behind a boundary the rest of the feature never crosses, which is what lets Phases 1-3 proceed under A1. The trigger-maintained ledger and the extended lock order put the money invariants in the database (P1) and make every concurrent path deadlock-free by construction, with the wallet locked before the payment because the payment's billing type depends on it. Enqueue-to-sync gives one apply path for three signal sources and keeps both the webhook and the page reads fast. The authenticated payment page removes a bearer capability from email, and the freed column becomes a reference that team admins need to match bank deposits.

### Trade-offs Accepted
- **The wallet sits before `payments` in the lock order**, contrary to the spec's AC-VERIFY-3 sentence. Acceptable because the immutable `billing_type` makes the other order unsound; the race tests stay the same.
- **A GET can enqueue a job.** Acceptable: no domain write, caller-scoped, throttled, idempotent; documented in ADR 0020.
- **E2E never shows a consent page and never exercises the webhook.** Acceptable: the webhook is covered by signed-fixture integration tests and the sandbox smoke test (AC-INTEGRATION-1); E2E proves the page journeys.
- **Up to ~2 s extra confirmation latency** (job polling). Acceptable against the "next page load" expectation and `RefreshWhilePending`.
- **One transaction per session holds that session's wallets for its duration.** Acceptable at 30 registrations under 2 s; a top-up credit for the same wallet waits at most that long.
- **A sign-in before paying.** Acceptable; it is the spec's default and the web already returns to `returnTo`.
- **A rename migration for `payment_reference`.** Acceptable because no production rows exist; it removes a misleading capability name.

### Conditionality (A1 go/no-go)
- Phases 1-3 use only the port, the fake, config validation, the schema and the engine. Selecting `PAYMENTS_ADAPTER=akahu` before the Phase 4 live adapter exists fails boot with the named error `PAYMENTS_ADAPTER=akahu is not available in this build`.
- The intent tables (D-90..D-92) encode the one-off lifecycle. If MVE-001 is negative, they need a follow-up migration (accepted in A1); the ledger, engine, reminders, overdue job, reference and lock order are provider-neutral.
- ADR 0020 stays Proposed until the MVE-001 answer; Phase 4 also needs MVE-002 and MVE-005 (A7).

---

## Implementation Guidelines

1. **Phase 1 ships** the D-87..D-98 migration, the `LOCK_ORDER` change, shared contracts (`packages/shared/src/api/billing.ts`, `billing/{payment-status,due-date}.ts`), the error codes, `lib/akahu/{gateway,status,fake-adapter,webhook-signature,key-cache,config,constants,payee}.ts` (the live client and adapter wait for Phase 4), config validation for every variable, and the factories (`insertWallet` must now insert at 0.00 and move the balance through `credit_transactions`, because the guard refuses a direct balance; update `insertPaymentRows` for `payment_reference`).
2. **No provider call under a transaction.** Gateway calls appear only outside `db.transaction()` callbacks. AC-ERROR-7 test: the fake's `beforeCreate` probe queries `pg_stat_activity` for `idle in transaction` backends of the app pool and fails the test if any exists.
3. **Replace the stand-in.** `team-banking-gate.int.test.ts` races the real `bill-session` (both orders) and the real attempt and top-up tx1 against a banking removal; `payment-stand-in.ts` is deleted if no other suite uses it.
4. **Decrypt late, forget early.** Payee plaintext exists only between tx1's commit and the create call's return, in a local variable; it is never passed to a logger, an error message, a job payload or the fake's recorded calls (last 4 only).
5. **Seal what needs sealing.** `payment-due`, `overdue`, `reminder` and `payment-received` emails carry the `/payments/<id>` link and are enqueued with `{ crypto }` (AC-ASYNC-4). `authorisation_url` is stored only as a FieldCrypto envelope and decrypted only to answer `payment_in_progress`.
6. **Webhook plugin is encapsulated.** Register it with its own `addContentTypeParser` inside `app.register(async (scoped) => …)` so no other route sees a Buffer body; a test proves a normal JSON route still parses objects.
7. **Key cache is per process and bounded.** At most 32 positive keys and 256 negative ids (LRU); single-flight by key id; the fetch cap is a token bucket; tests inject the clock.
8. **Money at the edge.** No `number` for amounts anywhere in `lib/akahu`; `JSON.rawJSON` for requests and source-text parsing for responses; the existing ESLint bans apply to the new paths.
9. **One `now` per operation, after locks.** The engine, apply, overdue and reminders read the injected clock once inside their transaction after the lock prologue (`testing-injected-clock`).
10. **Observability first.** Add the two signature headers to `REDACT_PATHS` and `authorisationUrl`, `payeeAccountNumber`, `payeeName` to the field patterns before any webhook or client code logs; assert the redaction in `billing-logs.int.test.ts`.
11. **Ingress is a deployment task.** `docs/getting-started.md` documents the single public path `/webhooks/akahu` -> API, the relay fallback, and that `AKAHU_WEBHOOK_URL` must point at it; dev and CI use no webhook (fake adapter) except a tunnel for the sandbox smoke test (U12).
12. **Coverage include** gains `apps/api/src/modules/{billing,wallet}/**`, `apps/api/src/lib/akahu/**`, `packages/shared/src/billing/**` and the new jobs in the phase that creates them.

## Validation Checklist

- [x] Meets all system requirements (C-BIL-1..3, B1-B10 defaults, A1-A8)
- [x] Respects technical constraints (C-ALL-1, D-75 unchanged, immutable snapshot, Akahu contract facts)
- [x] Addresses non-functional requirements (2 s billing, fast reads via enqueue-on-GET, P1-P7)
- [x] Technically feasible (every mechanism has an in-repo precedent: guard triggers, claim tables, `stately` queues, adapter factories, `FetchLike`)
- [x] Risks identified and acceptable (below)
- [x] Complies with Guiding Principles in systemPatterns.md: P1 (ledger, transitions, intents, uniques in SQL), P2 (`Money` at the Akahu boundary), P3 (one `now` after locks; UTC instants), P4 (payee decrypted in memory; `authorisation_url` sealed), P5 (no provider call under a lock; every side effect via pg-boss in the triggering transaction; the create is an inline call between transactions, as A5 requires, and its safety net is the queued reconcile), P6 (no new root scripts; `jobs:trigger` and `cli billing` subcommands only), P7 (fail-fast config, adapter by env, fake refused in production). No deviation.
- [x] Respects established patterns in systemPatterns.md (single-writer structural test, guard trigger + TS twin + fixture, claim table, adapter behind an interface, default-deny route policy, `ConfirmDisclosure`)
- [x] Observability architecture defined
- [x] Trace context propagation across all service boundaries (manual `traceparent` to Akahu; webhook root span carried into jobs)
- [x] Logging strategy consistent with observability-requirements.md
- [x] Metrics strategy follows naming conventions (reserved, low-cardinality labels)

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Akahu refuses third-party team payees or imposes a liability term (U1) | M | H | Port + fake keep Phases 1-3 independent; ADR 0020 stays Proposed; intent tables may need a follow-up migration (accepted in A1) |
| Signature bytes differ from the digest (padding, header format, U5) | M | M | Fail-safe design: a verification outage costs latency only (reconcile + sync-on-GET); MVE-005 fixture before Phase 4 |
| Attacker cycles fake key ids to burn Akahu rate budget | M | M | Key-id allow-list, URL-encoding, negative cache, single-flight, per-process fetch cap, 503 when capped |
| BANK_ERROR_INDETERMINATE debits the player and a retry double-charges | L | H | HELD blocks new attempts in SQL (partial unique includes HELD); no "not charged" copy; ops path from algorithm doc |
| Deadlock between billing, top-up credit, reminders and banking removal | L | H | Extended lock order with a path-by-path check; sorted multi-wallet locks; races in both orders with `waitForLockWaiters` |
| Orphan READY payment after an ambiguous create is paid | L | M | We never received its URL, so it cannot be authorised; `expires_at` always set (30 min); payee reference ties any surprise SENT to the payment for B3 |
| Late SENT for a closed or HELD intent, or a second SENT for a PAID payment | L | M | Terminal states absorbing; anomaly rows + B3 notification; never PAID twice, never invent credit |
| Payout block arrives while a session is being billed | M | L | Deliberate per ADR 0016: KEY SHARE vs NO KEY UPDATE do not conflict; new attempts re-check `is_payout_configured`; READY attempts cancelled best effort |
| Webhook ingress not available on the host (API private) | M | M | Single path routing; byte-exact web relay fallback; reconcile and sync-on-GET keep money correct without webhooks |
| Ledger trigger-depth guard misunderstood by a later feature | L | M | Ledger row and ADR 0020 C-WAL-1; refusal message names `wallet/ledger.ts` |
| `insertWallet` fixture change breaks existing suites that seed balances | M | L | Factory moves the balance through a `TOPUP` row with a synthetic intent; Phase 1 updates all callers |

## Next Steps

1. Reconcile with the algorithm doc (intent state names and matrix, B3 recording shape, HELD ops path, B8 predicate, B9 pacing) and the UI/UX and journey docs (GLOBAL_ADMIN payout-block placement, `payment_on_hold` and `payment_provider_refused` copy, showing `payment_reference`) in the task file's Creative Reconciliation section.
2. Record the spec and plan conflicts below as a plan amendment.
3. Phase 1: migration D-87..D-98, `LOCK_ORDER`, shared contracts, config, port, fake, factories, structural tests.
4. Phase 2: engine (replacing `payment-stand-in.ts` in the gate race), ledger debit, emails, ADR 0020 draft (Proposed).
5. Phase 4 gate: MVE-001 (go), MVE-002, MVE-005; re-read byte-level Akahu details from the live pages; then the live client and adapter.

## Spec and Plan Conflicts

| # | Source | Spec or plan says | This decision | Why |
|---|--------|-------------------|---------------|-----|
| 1 | AC-VERIFY-3; plan principle 2 | "writes `payments`, then locks the wallet row"; order `… -> payments -> player_credits` | Wallet locked **before** the payment insert; order `… -> registration_guests -> wallet_top_ups -> player_credits -> payments -> payment_attempts` | `payments.billing_type` is immutable and depends on the locked balance |
| 2 | Data persisted; AC-HAPPY-10 | `payment_link_token` 256-bit random; reminder columns `last_reminder_at`, `reminder_count` stamped on `payments` | `payment_reference` (11-char non-secret code, renamed column); reminders in append-only `payment_reminders`, `lastReminderAt` derived | Q2 decision; audit of who sent a cross-team reminder; `payments` keeps one writer |
| 3 | Invocation Method (API list) | No payout-block route | `POST /teams/:teamId/payout-block` (`requireGlobalRole('GLOBAL_ADMIN')`) and `cli billing block-payout` | A3 |
| 4 | Plan config | `AKAHU_ADAPTER`, `AKAHU_APP_ID`, `AKAHU_API_BASE_URL`, `AKAHU_WEBHOOK_*`, `AKAHU_RECONCILE_AGE_SECONDS` | `PAYMENTS_ADAPTER`, `AKAHU_APP_TOKEN`, `AKAHU_APP_SECRET`, `AKAHU_PAYMENTS_API_URL`, `AKAHU_WEBHOOK_URL`, `AKAHU_PAYMENT_EXPIRY_MINUTES`, `AKAHU_RECONCILE_MIN_AGE_SECONDS`, `AKAHU_RECONCILE_STUCK_AFTER_SECONDS` | A6; Akahu's own credential names; no signing-key env (keys are fetched) |
| 5 | Jobs list | `akahu-reconcile` re-reads and applies | New `akahu-sync` queue (`stately`) does every apply; reconcile, webhook and GETs enqueue it | One apply path; trailing re-read never lost |
| 6 | Reads | GET routes are reads | `GET /payments/:id` and `GET …/wallet` may enqueue `akahu-sync` for the caller's stale open intent | Prompt return-page result with the stateless fake and delayed webhooks |
| 7 | AC-ERROR-4 (amended by A3) | Trigger is manual | Same, plus the trigger also enqueues best-effort cancels of the team's READY intents | Stops new money reaching a known-bad account where possible |
| 8 | Plan (`team_banking_in_use`) | "may be widened" | Widened to open or HELD top-ups; not to FAILED | A8; B4 |
| 9 | New error codes | Spec lists `payment_settled`, `payment_in_progress`, `top_up_in_progress`, `payment_provider_unavailable`, `reminder_too_soon` | Adds `payment_on_hold`, `payment_provider_refused` | A2 HELD; definite create refusals are not outages |
| 10 | New tables | `wallet_top_ups`, `payment_attempts` | Adds `payment_reminders`, `payout_block_events`, `billing_hold_notices` | Audit, A3, B8 once-per-episode email |
| 11 | ADR 0016 R3 | "When Akahu declines a payout because of the destination account" | ADR 0020 amends the trigger to the manual action (OV-3, A3) | No documented Akahu signal |
| 12 | Hosting (ADR 0007) | API reached only through the web | One public path `/webhooks/akahu` routed to the API (or the web relay fallback) | Akahu must reach the verifier |

No conflict with B1-B10 or A1-A8: each is implemented as ruled, with the A1 go/no-go preserved.

---

NEW_TERMS_INTRODUCED:
- **Payment attempt**: one Akahu one-off payment started from `/payments/[id]` against a payment; row in `payment_attempts`.
- **Top-up intent**: one Akahu one-off payment started from the wallet page to add credit; row in `wallet_top_ups`.
- **Intent** (generic): a payment attempt or a top-up intent.
- **Blocking intent**: an intent that is open (`CREATED`, `AWAITING_PAYER`, `IN_FLIGHT`) or `HELD`; at most one per payment and one per wallet, enforced by partial unique indexes.
- **HELD**: intent state for FAILED/BANK_ERROR_INDETERMINATE or an amount mismatch; the payment stays unpaid but cannot be paid again until ops resolves it.
- **Gateway outcome**: the provider-neutral result (`OPEN`, `SUCCEEDED`, `NOT_CHARGED`, `INDETERMINATE`, `UNRECOGNISED`) that the Akahu adapter maps from Akahu's status and reason.
- **Payment reference**: a short, non-secret, unique code (`SGM` + 8 base32 characters) on each payment and top-up, sent to Akahu as the bank-statement reference.
- **Payout block event**: an append-only audit row recording a GLOBAL_ADMIN (or future automatic) payout block.
- **Billing hold**: B8 state where an ended paid session stays PUBLISHED because its team cannot receive payments; its notice is claimed once per block episode in `billing_hold_notices`.
- **Sync (akahu-sync)**: the job that re-reads one Akahu payment and applies it through `applyAkahuResult`; every signal source enqueues it.
