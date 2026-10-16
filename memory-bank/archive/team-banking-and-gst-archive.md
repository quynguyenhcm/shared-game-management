# Archive: Team Banking and GST

## Metadata
- Task: team-banking-and-gst
- Complexity: Level 3
- Status: COMPLETE (archived 2026-10-17). Delivered by a PR to `main` from `feature/team-banking-and-gst` (not stacked).
- Started: 2026-10-16 (task provisioned, `a7eec0a`)
- Completed: 2026-10-17 (final review fixes `20f9978`, reflection `0710146`)
- Roadmap Link: team-banking-and-gst (v1.0.0)
- Branch: `feature/team-banking-and-gst`, built in the main clone (no worktree). Range `origin/main..HEAD`: 100 files, +15,311 / -261, including the spec, creative docs and memory-bank files.

## Summary

A team admin sets the bank account that receives payouts and the team's GST status on a new "Banking and GST" page in the team-admin area (`/teams/<id>/manage/banking`). The account name and number are encrypted and write-only after save. The page shows only the name and "ending 1234".

The feature also exports the publish gate that session-scheduling-engine will call: a paid session cannot be published while the team has no complete bank account or while a failed payout has blocked it. A `game_sessions` trigger enforces the same rule in SQL. Banking cannot be removed while the team has a published paid session or unpaid payments. Every banking change emails all approved admins.

## Requirements

### Original Requirements (roadmap)
- Bank account name and NZ account number validation (bank and branch checks).
- Akahu merchant credentials stored encrypted; `is_payout_configured` flag.
- Gate: paid sessions can't be published until banking is configured.
- GST settings: IRD number, GST registration number, GST-registered toggle (IRD validation).

### As Delivered: the Creative Reconciliation R1-R12 supersedes the spec ACs
The spec's 43 ACs and copy deck were written before creative. These binding rulings change them, and downstream features should read them, not the raw AC text:
- **R1 (user):** the payout destination is the bank account name and number only. The AC parts about the Akahu merchant ID and app token (AC-HAPPY-1/2/3, AC-ERROR-4, AC-VERIFY-2/3/13, AC-INTEGRATION-1) are removed. Akahu has no "merchant ID". Platform Akahu credentials are server configuration owned by wallet-and-akahu-billing, and `teams.akahu_*` are reserved and unused.
- **R2 (user):** one GST number field. The IRD field and its read-back (AC-HAPPY-5, AC-ERROR-6/12, AC-VERIFY-2/3/10 IRD parts) are removed, and `ird_number` is never written.
- **R3 (user):** new `payout_blocked_at`. `is_payout_configured` is a generated column (complete block AND not blocked). New AC-ERROR-15.
- **R4:** lock protocol changes: the gate and trigger take `teams FOR KEY SHARE`, and removal takes `FOR UPDATE` first. Removal is also refused while payments are PENDING or OVERDUE. New contract C-BIL-PAY.
- **R6 (user):** summary first, then "Change" with `?edit=` and `?notice=` codes. No "My teams" hint. Configured status reads "Set up. Paid sessions can be published."
- **R7:** an unreadable block answers 200 with `unreadable: true`, not 500 (AC-ERROR-12).
- **R8:** AC-ASYNC-1 is promoted from COULD to MUST: every admin, the actor included, is emailed with no account values. A per-render `changeKey` provides idempotency, and the audit columns are new.
- **Post-review (2026-10-17):** GST saves also carry `changeKey`; `gstNumber: null` removes a saved number while GST is off; DELETE returns `removed`.

### Success Criteria
- [x] All 43 ACs as amended by R1-R12 (phase reviews PROCEED on all 5 phases; final review ready with fixes, fixes applied).
- [x] AC-INTEGRATION-4 / AC-VERIFY-13: Playwright `team-banking.spec.ts` 14/14 on desktop and 360x740 with axe at Phase 5. **Not re-run after the 2026-10-17 fixes** (needs the manual native stack); the changed GST form and removal notice are unit-tested.

## Implementation

### Approach
Five phases built with `/yay:build --auto`:
1. Schema, validators and shared contracts.
2. Banking and GST API.
3. Publish gate and removal guard (and ADR 0016).
4. Web banking area.
5. E2E, accessibility and docs.

Postgres is the system of record (P1): the all-or-none CHECK, the generated flag, and the triggers on both sides of the gate. TypeScript gives the precise errors on the normal path.

### Key Components
1. **Schema**
   - `db/migrations/20261016000100000_team_banking_and_gst_invariants.sql`:
     - staged cleanup of old partial rows, then CHECKs added `NOT VALID` and validated;
     - `payout_blocked_at`, audit columns, generated `is_payout_configured`;
     - `game_session_is_paid` and `team_banking_in_use`;
     - publish trigger `game_sessions_paid_requires_payout`;
     - removal trigger `teams_guard_banking_removal` (constraint `teams_banking_in_use`).
   - `20261016000200000_team_banking_change_keys.sql`: `banking_change_keys uuid[]`, the newest 32 keys.
   - Ledger D-47 to D-54 in `db/schema-deviations.md`.
2. **NZ validators** in `packages/shared/src/nz/`:
   - `bank-account.ts`: bank ID plus weighted modulus per IRD *Payroll Calculations & Business Rules Specification 2026-27* section 7. No branch ranges; legacy bank IDs are refused; the suffix is padded to 3.
   - `ird-number.ts`: range 10,000,000 to 200,000,000, with secondary weights only when the primary result is 10.
   - `gst.ts`: `GST_RATE_BPS = 1500`.
   - Test vectors trace to IRD worked examples or hand arithmetic.
3. **Shared contracts:** `packages/shared/src/api/team-banking.ts` (strict zod requests, masked responses, `RemoveBankingResponse`, `BANKING_FIELD_MESSAGES`). Error codes `payout_not_configured` and `banking_in_use`.
4. **API module** `apps/api/src/modules/team-banking/` (`routes`, `service`, `repo`, `publish-gate`, `errors`, `emails`):
   - five `TEAM_ADMIN` routes, all `no-store`;
   - saves lock the team row `FOR NO KEY UPDATE` and re-check the admin;
   - sealed per-admin `send-email` jobs in the same transaction;
   - every committed request claims its `changeKey`, a no-op included.
   - Shared helpers: `modules/teams/admin-lock.ts` and `lib/auth/team-refusals.ts` (one refusal log per refusal).
   - Anchored global redaction `/^(bank_?)?account_?(name|number)$/i`.
5. **Publish gate:** `isPaidSession` (Money only, fails closed) with a 117-row TS/SQL parity matrix, and `check/assertTeamCanPublishPaidSession` (`teams FOR KEY SHARE`).
6. **Web:**
   - `apps/web/src/app/teams/[teamId]/manage/banking/page.tsx`;
   - `components/teams/{banking-*,gst-*,manage-area-nav,no-access}.tsx`;
   - `lib/teams/{banking-actions,banking-view,manage-areas}.ts`;
   - `InlineConfirm` generalised to a `section` id;
   - the manage-area nav moved per page and now marks the current area.
7. **Decision record:** `docs/adr/0016-team-banking-and-publish-gate.md`. It covers the gate contract, the recurrence contract, C-BIL-PAY, the `payout_blocked_at` obligation on billing, the `returnTo` hand-off, the paid rule, the GST number snapshot at charge time, and an annual April review of the `nz/*` tables.

### Design Decisions
- **Payout destination:** bank account only (R1).
- **GST number:** one field (R2).
- **Payout block:** a failed payout blocks publishing until the admin saves again (R3).
- **Removal:** refused while the payout destination is still needed, enforced in SQL too (R4).
- **Editing:** summary, then Change (R6).
- **Change email:** sealed, sent to all admins, and idempotent per render (R8).
- **Validation:** IRD 2026-27 rules, not the offline 2014 document (R9).

References:
- `memory-bank/creative/team-banking-and-gst-nz-validation-algorithm.md`
- `memory-bank/creative/team-banking-and-gst-banking-architecture.md`
- `memory-bank/creative/team-banking-and-gst-payout-setup-user-journey.md`
- `memory-bank/creative/team-banking-and-gst-banking-page-uiux.md`
- The binding rulings in the task file's "Creative Reconciliation" section.

## Testing
- Unit: 884 to 1030 over the build, including the validator vector suites, the paid-session matrix, the contracts, and the web actions and components.
- Integration: 304 to 357 (35 files): `team-banking-{schema,upgrade,api,gate,logs}`, plus extended crypto-columns, schema and session-instants tests.
  - The race suite uses lock waiters, no sleeps: gate against removal, raw UPDATE and INSERT against removal, and C-BIL-PAY against removal on a COMPLETED session, each in both orders.
  - 354/354 three runs in a row at Phase 5 (no flakiness); 357/357 after the final fixes.
- E2E: `apps/web/e2e/team-banking.spec.ts` 14/14 at Phase 5.
- The coverage gate passes: 1387 tests, 96.35% statements, 90.43% branches. `team-banking/**` and `nz/**` measure 99% or more.
- Lint, typecheck, build and OpenAPI drift all pass.

## Files Changed (by area)
- `db/migrations/` (2), `db/schema-deviations.md`
- `packages/shared/src/nz/` (validators, GST constant), `packages/shared/src/api/{team-banking,errors}.ts`
- `apps/api/src/modules/team-banking/` (new), `apps/api/src/modules/teams/{admin-lock,repo,routes,service}.ts`, `apps/api/src/lib/{auth/team-refusals,logger/logger,crypto/crypto,http/errors}.ts`, `apps/api/src/app.ts`, `apps/api/openapi.yaml`, `apps/api/.kysely-codegenrc.json`
- `apps/api/test/{integration,helpers,fixtures}/` (banking scene, payment stand-in, paid-session matrix, factories)
- `apps/web/src/app/teams/[teamId]/manage/{banking/page.tsx,layout.tsx,page.tsx}`, `apps/web/src/components/teams/`, `apps/web/src/lib/{teams,api-client}`, `apps/web/e2e/team-banking.spec.ts`
- `docs/adr/0016-team-banking-and-publish-gate.md`; `.gitignore`/`.prettierignore` (`.vitest/`)

## Lessons Learned
- **The pre-build pipeline did the most valuable work:** the plan-time code check, four parallel creative agents and the scoped Codex critique.
  - The plan-time check caught the `session-instants` break and the ADR/ledger numbering clash.
  - The creative agents found that IRD's 2014 spec is offline, that Akahu has no merchant ID, and a removal-vs-publish race.
  - The critique found 4 high-severity issues before any code.
- **The rules learned from team-management worked:** the critique scope was correct, the reconciliation was binding, and the redaction collision grep ran first, so there was no redaction regression.
- **The one escaped Important defect repeats team-management's pattern.** Per-phase reviews checked "is this finding fixed", not "does the invariant hold on every return path": a save that changed nothing never claimed its `changeKey`. Only the final whole-branch review caught it.
- **Degraded gates must be ledgered and closed later.** Phase 3 had no Codex verdict, an integration re-run was skipped, and one orchestrator handed back early.
- **Spec text that a reconciliation overrides should be marked superseded**, or later readers inherit obsolete criteria. The Requirements section above does this.

Consolidated into:
- `agent-rules/_learned/review-process-plan-claims.md`: evidence 4, with return-path and superseded-AC bullets.
- `logging-redaction-global.md`: evidence 2.
- `testing-integration-db-isolation.md`: evidence 2.
- New: `api-write-idempotency.md` and `db-derived-flags-and-gates.md`.

Reference: `memory-bank/reflection/team-banking-and-gst-reflection.md`

## References
- Task: `memory-bank/tasks/team-banking-and-gst.md`
- Reflection: `memory-bank/reflection/team-banking-and-gst-reflection.md`
- Creative: `memory-bank/creative/team-banking-and-gst-{nz-validation-algorithm,banking-architecture,payout-setup-user-journey,banking-page-uiux}.md`
- ADR: `docs/adr/0016-team-banking-and-publish-gate.md`

## Follow-up
- **Before merge (recommended):** re-run `apps/web/e2e/team-banking.spec.ts` on the final head. The recipe is in `techContext.md` under Testing, Banking journeys.
- **session-scheduling-engine** must follow ADR 0016:
  - call the gate before any `game_sessions` lock;
  - insert a refused recurring instance as DRAFT;
  - show the `payout_not_configured` hand-off link with `returnTo`;
  - write the final rate into the applicable fee column(s).
- **wallet-and-akahu-billing** must:
  - follow C-BIL-PAY (`teams FOR KEY SHARE` and a configuration check before any payment insert);
  - set `payout_blocked_at` when a payout to the destination fails, and never clear the banking columns;
  - snapshot `payments.gst_number` at charge time.
- **registration-and-waitlist** (designed, build-gated): renumber its ADR to 0017 and its ledger entries to the next free D-number after D-54. Its `insertPublishedSession` must create a team with `insertTeam({ payoutConfigured: true })`.
- **Platform hardening item:** pg error `detail` is logged unredacted through `stdSerializers.err`. This predates this feature, and no banking path reaches it.
- **Annual April review:** check the `nz/*` bank table and IRD constants against the new IRD specification.
