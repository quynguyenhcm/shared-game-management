## Spike Card: Official Docs
**Work slug**: wallet-and-akahu-billing   |   **Status**: DEGRADED
**run_id**: 20261030-ac067d8f6863
**framing_sha**: ac067d8f6863
**approved_depth**: deep
**approved_lanes**: docs, oss-production, practitioner-discourse, codebase
**MCP used**: FALLBACK (WebSearch/WebFetch)
**mcp_servers_available**: none (context7 unavailable)
**fallback_used**: yes
**Sources consulted**: 14
**Retrieval date (all rows)**: 2026-10-30. `source_tool: webfetch` unless noted `websearch`. Note: WebFetch returns a model-summarised view of each page, not raw text; quote-level details should be re-checked against the live page before they become test fixtures.

### Findings
| Source | Type | Evidence Grade | Key Finding | Implications |
|--------|------|----------------|-------------|--------------|
| [One-Off Payments](https://developers.akahu.nz/docs/oneoff-payments) (webfetch, 2026-10-30) | doc | A | "One-off payments don't require account connectivity and can operate as a stand-alone payment solution." Create payment, get `authorisation_url`, payer picks bank + consents, returns to app. App token + app secret, HTTP Basic, base `https://api.payments.akahu.io/`. No user token mentioned. | RQ1: no per-player OAuth connection or stored token needed. Platform-level app credential fits ADR 0016; no per-player encrypted token table. |
| [Making a One-Off Payment](https://developers.akahu.nz/docs/oneoff-payments-making-a-payment) (webfetch, 2026-10-30) | doc | A | `POST /v1/one-off-payments`. Required: `amount`, `redirect_uri`, `payee.name`, `payee.account_number` (NZ BECS). Optional: payee/payer `particulars/code/reference`, `webhook_uri`, `expires_at` (15 min to 1 yr, default 1 h), `redirect_mode: deep_link`, `payer.*` constraints. Response `_id`, `authorisation_url`, `expires_at`. | Payee is supplied per payment as name + number: matches the team-account-as-payee model. Per-payment `webhook_uri` means no global webhook registration step. |
| [CreateOneOffPayment API ref](https://developers.akahu.nz/reference/createoneoffpayment) (webfetch, 2026-10-30) | doc | A | Amount 0.01 to 1,000,000 NZD; payee name 2-70 chars; references max 12 chars; payer.bank enum anz/asb/bnz/kiwibank/nzhl/westpac/demo_bank. 400 issue codes incl. `invalid_payee`, `invalid_payer`, `single_limit_exceeded`, `bank_limit_exceeded`, `invalid_bank`. 401/403. No mention of payee approval. | `invalid_payee` at create time is the only documented payee-rejection signal (synchronous). Validate team name/number against these formats at payout-details entry. Idempotency not documented for this endpoint. |
| [One-Off Payment Lifecycle](https://developers.akahu.nz/docs/oneoff-payments-lifecycle) (webfetch, 2026-10-30) | doc | A | Statuses: READY, AUTHORISED, SUBMITTED (PENDING, SETTLEMENT_IN_PROGRESS) non-terminal; SENT, CANCELLED (TIMED_OUT, USER_CANCELLED, APP_CANCELLED), FAILED (REJECTED, BANK_ERROR, BANK_ERROR_INDETERMINATE, INTERNAL_ERROR) terminal. | RQ2: success = SENT; user cancel = CANCELLED/USER_CANCELLED; failure = FAILED/*. No documented code for "destination account rejected"; closest is FAILED/REJECTED (bank or Akahu fraud check). Cannot safely map REJECTED to `teams.payout_blocked_at` without confirmation. BANK_ERROR_INDETERMINATE needs a reconcile-by-polling path. |
| [Monitoring One-Off Payment Progress](https://developers.akahu.nz/docs/oneoff-payments-monitoring-progress) (webfetch, 2026-10-30) | doc | A | Webhook: POST JSON, one type `ONE_OFF_PAYMENT_STATUS_UPDATE`; fields `type`, `_payment`, `status`, optional `status_reason{code,message}`, `emitted_at`. Headers `X-Akahu-Payments-Signature` (base64), `X-Akahu-Payments-Signing-Key` (key id). RSA-SHA256 over raw body; public key via `GET /v1/webhooks/keys/{keyId}`, cache it. 2xx within 10 s; retried up to 20 times with exponential backoff (intervals unstated). Order not guaranteed (use `emitted_at`); scheduled status check recommended; poll `GET /v1/one-off-payments/{paymentId}`. | RQ3: payload carries no unique event id; dedupe key must be derived (`_payment` + `status` + `status_reason.code`, or `emitted_at`). Re-read the payment on each webhook (status transitions are idempotent-by-state) plus a reconciliation poll. Raw-body route required. Payload is small enough that re-read is the safe model. |
| [GetWebhookSigningKey ref](https://developers.akahu.nz/reference/getwebhooksigningkey.md) (webfetch, 2026-10-30) | doc | A | `GET https://api.payments.akahu.io/v1/webhooks/keys/{keyId}` returns `{keyId, publicKey}` (PEM). Auth scheme `AppSecret`. Key ids come from `x-akahu-payments-signing-key`. | Key fetch needs app credentials; cache keyed by id, refetch on unknown id. Rotation policy for payments keys not documented. |
| [Enduring API Webhooks reference](https://developers.akahu.nz/docs/reference-webhooks) (webfetch, 2026-10-30) | doc | A | Different (enduring-API) scheme: `X-Akahu-Signature`/`X-Akahu-Signing-Key`, RSA-SHA256 PKCS1, key at `api.akahu.io/v1/keys/{keyID}` (key in `item`), cache ~12 h, wipe cache on key id change, 200 within 5 s, retries up to a day, webhooks may be disabled after multi-day failures, no unique event id. Payment events there are for enduring `/payments` (PAYMENT UPDATE, PAYMENT RECEIVED). | Two webhook dialects exist (different headers, host, timeouts, retry). Implement only the one-off-payments dialect; do not copy enduring-API samples blindly. Doc itself points enduring page for code samples, a trap for copy-paste. |
| [App Accreditation](https://developers.akahu.nz/docs/app-accreditation) (webfetch, 2026-10-30) | doc | A | One-off payments are Tier 1: sign a contract, background due diligence, privacy notice review, limited app review; contact hello@akahu.nz. Production release requires accreditation; accreditation removes sandbox restrictions. First review free, later reviews $1,000. No lead time stated. No marketplace/facilitator/third-party-payee rule stated. | RQ4: approval is a gating Phase 4 schedule risk with unknown lead time; start the Akahu contract/due-diligence in parallel. Third-party-payee/facilitator terms are not addressed in docs, so must be confirmed in the contract. |
| [Pricing](https://www.akahu.nz/pricing) (webfetch, 2026-10-30) | vendor page | D | Indicative $0.15 per successful one-off payment request (charged only when bank initiates), pay-as-you-go, no minimum listed; final pricing confirmed by sales. Undated page. | Fee model is per-success fixed amount (no percentage); treat as indicative. Decide who bears the fee (team, player, platform). Vendor marketing so capped at D. |
| [Demo Bank](https://developers.akahu.nz/docs/demo-bank) (webfetch, 2026-10-30) | doc | A | One-off payments supported in Demo Bank on official connection. Amount-triggered outcomes: 5.02 internal error, 5.03 bank error, 5.04 indeterminate bank error, 5.15 insufficient funds (REJECTED on official connection), 5.20/5.22 30 s delay, 5.23/5.24 180 s delay. Cancellation not documented. Payee must be a real NZ account number (demo numbers fail with 400). "Does not fully mimic live connections." | RQ4: sandbox can produce real FAILED/REJECTED, BANK_ERROR, BANK_ERROR_INDETERMINATE and delayed-settle fixtures. Not documented: USER_CANCELLED, TIMED_OUT (can be induced by short `expires_at` of 15 min), destination-rejected. AC-INTEGRATION-1 fixtures for those need live/support confirmation or must be labelled synthetic. |
| [Payee Verification](https://developers.akahu.nz/docs/payee-verification) (webfetch, 2026-10-30) | doc | A | Static/dynamic payee model (INLINE; VERIFICATION_TOKEN, CLIENT_VERIFIED, NONE) is described for enduring payments; page says nothing on one-off payments. | Do not assume enduring-payment payee restrictions apply to one-off. Confirm with Akahu that arbitrary name+number payees are allowed under the Tier 1 contract. |
| [Enduring Payments (open banking)](https://developers.akahu.nz/docs/official-open-banking-payments) (websearch snippet, 2026-10-30) | doc | B | Akahu ends pay-anyone enduring consents; payees must be pre-registered at consent; suggested workaround is two-leg (collect into a trust account, then pay out). Migration to official open banking targeted 31 May 2026. Snippet only, page not fully read. | Enduring payments are the wrong product for this use case (payee restrictions, per-user consent). One-off is the fit. Two-leg trust-account model is the fallback if one-off third-party payee is refused. |
| [Rate Limits](https://developers.akahu.nz/docs/reference-rate-limits) (webfetch, 2026-10-30) | doc | A | Global + endpoint limits, 429 with exponential backoff; extra limit only on `POST /v1/payments` (200/user/min). Policy may change without notice. | No documented limit for `/v1/one-off-payments`; implement 429 backoff in the adapter. |
| [Idempotent Requests](https://developers.akahu.nz/docs/idempotent-requests) (webfetch, 2026-10-30) | doc | A | `Idempotency-Key` header, 24 h retention, 422 on payload mismatch, 409 while in flight; listed only for `/payments` (enduring). | Not documented for `/v1/one-off-payments`: assume absent. Idempotency must be ours: persist the attempt row, then call create once; never retry create blindly after timeout (would produce a second authorisation link, harmless until paid, but dedupe on our side). |
| [Docs index](https://developers.akahu.nz/docs) (webfetch, 2026-10-30) | doc | A | One-off payments pages exist alongside enduring; no dedicated transfers page; no pricing page in index; `llms.txt` index exists. | Pricing/limits live outside docs; support contact required. |

### TRAP Candidates
- Two incompatible webhook dialects (payments vs enduring: header names, key host, timeout 10 s vs 5 s, retry up to 20 vs a day); copying enduring-API verification code would fail or use the wrong key endpoint.
- No unique webhook event id and unguaranteed ordering: naive "process each webhook once by id" dedupe is impossible; handlers must be state-idempotent.
- No documented "destination account rejected" status/code: mapping FAILED/REJECTED to `teams.payout_blocked_at` could block a team on a player-side bank rejection or an Akahu fraud check.
- Accreditation (Tier 1 contract, due diligence, app review) gates production with unstated lead time; docs are silent on facilitator/third-party-payee rules (pay-anyone was removed for enduring payments, so a similar tightening for one-off is plausible).
- Payee verification model is documented only for enduring payments; one-off third-party payee acceptance is implied by the API shape but not stated.

### Open Questions
- Does Tier 1 accreditation permit a platform to name arbitrary team bank accounts (name + number) as payees, with the platform not being the account owner (marketplace/facilitator rules, liability)? Support/contract only.
- Approval/onboarding lead time and sandbox credential availability (docs: "credentials will be provided"; contact hello@akahu.nz).
- Which status/code does Akahu return when the payee account is closed/invalid/refuses credit: synchronous `invalid_payee` at create, or async FAILED/REJECTED or BANK_ERROR? Needs sandbox (not covered by listed Demo Bank triggers) or support.
- Per-payment and daily numeric limits (`single_limit_exceeded`, `bank_limit_exceeded` thresholds; `GET /v1/connections` mentioned for bank limits) and whether the app-level cap exists.
- Key rotation/cache guidance for the payments signing key (enduring page says 12 h; payments page just "cache it"); webhook host for key fetch (`api.payments.akahu.io` per payments docs vs `api.akahu.io` per enduring docs, use the former).
- Basic-auth versus `AppSecret` scheme exact header format in the API reference (docs landing says HTTP Basic with app token/secret; API ref does not show the header).
- Whether `USER_CANCELLED` can be simulated in Demo Bank; whether `meta`/our own reference can be attached to correlate webhooks (none documented; correlate via `_payment` id stored at create).
- Final fee (indicative $0.15 per successful request) and who bears it.
- Is `payer.release_account_details` / payer reference useful for reconciling the player to the payment? Behaviour on privacy notice review.

### API Constraints
| Constraint | Detail | Source |
|------------|--------|--------|
| Product | `POST https://api.payments.akahu.io/v1/one-off-payments`; app token/secret (Basic), no payer connection or user token | docs/oneoff-payments (webfetch) |
| Amount | 0.01 to 1,000,000 NZD, 2 dp; bank limits enforced (`single_limit_exceeded`, `bank_limit_exceeded`) | reference/createoneoffpayment (webfetch) |
| Field formats | payee name 2-70 chars; account `NN-NNNN-NNNNNNN-NN(N)`; particulars/code/reference max 12 chars `[A-Za-z0-9 -_]` | reference/createoneoffpayment (webfetch) |
| Expiry | default 1 h; `expires_at` between 15 min and 1 year; unauthorised payments become CANCELLED/TIMED_OUT | docs/oneoff-payments-making-a-payment (webfetch) |
| Supported payer banks | anz, asb, bnz, kiwibank, nzhl, westpac, demo_bank (enum) | reference/createoneoffpayment (webfetch) |
| Statuses | READY, AUTHORISED, SUBMITTED, SENT, CANCELLED, FAILED with reason codes above; SENT/CANCELLED/FAILED terminal | docs/oneoff-payments-lifecycle (webfetch) |
| Webhook | type `ONE_OFF_PAYMENT_STATUS_UPDATE`; headers `X-Akahu-Payments-Signature`/`-Signing-Key`; RSA-SHA256 on raw body; 2xx within 10 s; up to 20 retries, exponential; unordered; no event id | docs/oneoff-payments-monitoring-progress (webfetch) |
| Signing key | `GET /v1/webhooks/keys/{keyId}` on payments host returns `{keyId, publicKey}` PEM; cache | reference/getwebhooksigningkey (webfetch) |
| Rate limit | 429 + backoff; documented numeric cap only for enduring `POST /v1/payments` (200/user/min); may change without notice | docs/reference-rate-limits (webfetch) |
| Idempotency | `Idempotency-Key` documented for `/payments` only (24 h); not documented for one-off create | docs/idempotent-requests (webfetch) |
| Accreditation | Tier 1 (contract, due diligence, privacy review, limited app review) required before production; first review free, re-review $1,000; lead time unstated | docs/app-accreditation (webfetch) |
| Fee | indicative $0.15 per successful request (grade D, vendor page) | akahu.nz/pricing (webfetch) |
| Sandbox | Demo Bank amount triggers 5.02, 5.03, 5.04, 5.15, 5.20-5.24; no cancel simulation; payee must be real NZ number | docs/demo-bank (webfetch) |
| Deprecation | pay-anyone enduring consents removed; official open banking migration targeted 2026-05-31 (enduring only) | docs/official-open-banking-payments (websearch snippet) |

### Capability matrix (DRP-001 input)
| Need | One-off payments API | Verdict basis |
|------|----------------------|---------------|
| Payer not pre-connected | Yes (documented) | A |
| Third-party payee by name + number | Yes in API schema; accreditation terms unconfirmed | A (schema) / open (terms) |
| Platform-level credential only | Yes (app token + secret) | A |
| Hosted redirect consent | Yes (`authorisation_url`) | A |
| Signed webhooks | Yes (RSA-SHA256) | A |
| Destination-rejected signal | Not documented | open |
| Sandbox for all failure modes | Partial | A |

Answer to DRP-002 trigger: result for Akahu is positive-but-conditional (open items: third-party-payee terms, destination-rejected mapping, lead time). Caller decides whether to run DRP-002.
