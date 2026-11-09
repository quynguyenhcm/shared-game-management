## Research Objectives
Resolve creative question 1 of wallet-and-akahu-billing ("Akahu capability and integration shape", LOW confidence), which gates build Phase 4. Establish, from Akahu's current documentation and sandbox, whether a platform-level Akahu app can take a one-off payment from a player's NZ bank account to the team's bank account (payee = account name + number, third-party, non-user-owned) without an enduring per-player connection, and what the payment status lifecycle, webhook contract, limits/fees/approval lead time are. If Akahu cannot, identify which NZ pay-by-bank provider can, under ADR 0016's platform-level-credentials constraint.

## Research Questions
1. Does Akahu support a one-off payment to an arbitrary third-party NZ account (payee = name + number) from a payer who has NOT previously connected their bank (hosted/redirect consent per payment), or is a per-player OAuth connection with a stored user token required before the payment API can debit them? Which Akahu product (payments API, payment requests/links, PISP via API Centre standards) is the right fit, and is the platform-level app credential enough?
2. What is Akahu's payment status lifecycle, and which statuses/error codes mean success, failure, user cancellation, and "destination account rejected" (the trigger for `teams.payout_blocked_at`, AC-ERROR-4)?
3. What is the webhook contract: event types, payload, signature header and algorithm, key retrieval/rotation, retry schedule, unique event id, and does the payload suffice or must we re-read the payment (AC-ERROR-6, AC-ASYNC-3)?
4. What are the limits (per-payment, daily), fees, sandbox capabilities (can it simulate decline/cancel/destination rejection?), the app approval process and lead time, and any restriction on paying non-user-owned accounts or on collecting for third parties (marketplace/facilitator rules)?
5. If Akahu cannot do (1), which NZ pay-by-bank provider (Blink Pay, Windcave account-to-account, Worldline, POLi successor, others) supports a platform-held credential paying out to many team bank accounts via hosted redirect plus signed webhooks, with comparable status/webhook/limits detail?

## Ambiguity Profile
| Dimension | Level | Key Question |
|-----------|-------|--------------|
| Technical feasibility | HIGH | Can Akahu debit a non-connected payer and credit a third-party account in one hosted flow, with a platform app only? |
| Existing-solutions | HIGH | Which Akahu product, or failing that which NZ A2A provider, fits "platform collects, team account is payee, no per-team credentials"? |
| Architecture | HIGH | Does the answer force a per-player encrypted token table, our own `/payments/[id]` page driving an Akahu flow vs. an Akahu-hosted link, and what is the webhook-vs-re-read model? |
| Safety/compliance | MEDIUM | Do Akahu/API Centre rules, app approval, or facilitator/third-party-payee restrictions constrain this model; webhook signature and key-rotation trust? |
| Effort-estimation | MEDIUM | What is the approval/onboarding lead time (schedule risk to Phase 4) and the cost of the adapter plus fixtures? |
| Data/evaluation | MEDIUM | Can the sandbox reproduce decline, cancel and destination-rejected so AC-INTEGRATION-1 fixtures are real, not invented? |
| Integration/codebase | MEDIUM | Fit with ADR 0016 (platform credentials, team account as payee, no per-team creds), P4 (encrypt any stored token, decrypt payee in memory only), P5 (no Akahu call under a DB lock; domain write + enqueue in one tx), raw-body webhook route. Known and documented, so only the fit check is open. |
_Omitted (low ambiguity): Requirements (spec approved 2026-10-30, rulings B1-B10 accepted at defaults)_

## Activated Lanes  (Spike Depth: deep)
Depth rule: 3 HIGH dimensions (technical feasibility, existing-solutions, architecture) gives `deep`. The question is narrow and vendor-specific, so the lane set is trimmed to what can answer it.

| Lane | Status | Reason |
|------|--------|--------|
| Academic / SOTA | SKIP | Vendor-API capability question; no scholarly literature bears on it. Open Banking / API Centre standards are covered by Official Docs. |
| OSS / Production | ACTIVATE | Existing-solutions HIGH, Technical feasibility HIGH: Akahu SDKs/sample apps, real-world webhook verification code, marketplace-style integrations, failure modes. |
| Practitioner Discourse | ACTIVATE | (default-on) Effort-estimation and Safety MEDIUM: approval lead time, "works in sandbox, fails in prod" reports, provider switching stories. |
| Official Docs | ACTIVATE | Existing-solutions HIGH, Safety MEDIUM, Integration MEDIUM: primary source. Akahu API docs (payments, webhooks, auth), API Centre standards, alternative providers' docs. Retrieval dates must be recorded (AC-INTEGRATION-1). |
| Internal / Codebase | ACTIVATE | (default-on) Integration/Architecture: confirm ADR 0016, `teams.akahu_*` reserved columns, `payments`/`payment_attempts` shape, raw-body route, FieldCrypto, config/fail-fast fit for whichever shape wins. |

## Deep Research Probes
| probe_id | research_question | ambiguity_dimension | insufficiency_rationale | expected_output_shape | recommended_run_mode |
|----------|-------------------|---------------------|-------------------------|-----------------------|----------------------|
| DRP-001 | Exactly which Akahu product and flow can pay a third-party NZ account (name + number) from a non-pre-connected payer, with what authentication (app token only vs. user token), statuses, webhook signature scheme, limits and approval gate? | technical feasibility / architecture | Akahu docs may be gated, partial or changed; payer-connection requirement and approval terms may only be discoverable via sandbox or support contact. Lanes may return contradictory or stale signals. | Capability matrix (flow vs. requirements), status/webhook contract table with doc citations and retrieval dates, list of questions that need Akahu support or sandbox confirmation | human-assist (sandbox access and Akahu contact needed) |
| DRP-002 | If Akahu cannot, which NZ pay-by-bank providers (Blink Pay, Windcave A2A, Worldline, POLi successor) support platform-held credentials paying many third-party team accounts via hosted redirect and signed webhooks? | existing-solutions | Provider docs are often behind sales/partner portals; sparse public detail; thin MCP coverage. Only needed if DRP-001 returns a negative or conditional answer. | Build-vs-buy map: per provider, payee model, redirect/webhook/status contract, fees, onboarding, fit to ADR 0016 | agent-run (run only if DRP-001 is negative or conditional) |

## MCP Availability
Best-effort probe by tool-list inspection (no arxiv, github-search or context7 tools are present in this session; treated as unavailable).

| Server | Status | Affected lane |
|--------|--------|---------------|
| arxiv | UNAVAILABLE | Academic / SOTA (lane skipped, no impact) |
| github-search | UNAVAILABLE | OSS / Production to WebSearch/WebFetch fallback |
| context7 | UNAVAILABLE | Official Docs to WebFetch fallback (Akahu docs are a hosted site, WebFetch suits) |
Other note: pycharm and rider MCP servers failed to connect (irrelevant to this spike). WebSearch/WebFetch are deferred tools and must be loaded via ToolSearch by lane agents. Degraded mode: yes (3 of 3 optional servers unavailable); does not block.

## Recommendation
proceed, because the Akahu integration shape is LOW confidence, gates Phase 4 and every Akahu-facing AC, and the three HIGH dimensions are only answerable from vendor docs/sandbox. Suggested narrowing at the gate: keep Academic skipped, and run DRP-002 only if DRP-001 is not a clear positive. Human prerequisite: an Akahu developer account/sandbox (also a Phase 4 schedule risk).

Sources read: `memory-bank/tasks/wallet-and-akahu-billing.md` (Specification, Scope Boundaries, Creative Exploration Needed, AC-ERROR-4/6, AC-INTEGRATION-1, build gate), `memory-bank/techContext.md` (first 80 lines), `memory-bank/systemPatterns.md` (first 80 lines, P1-P7). `productBrief.md` was not read (framing did not need it; spec already encodes personas/NFRs).
