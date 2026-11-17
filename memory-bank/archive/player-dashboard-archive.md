# Archive: Player Dashboard

## Metadata
- Task: player-dashboard
- Complexity: Level 2
- Started: 2026-11-14
- Completed: 2026-11-17
- Roadmap Link: player-dashboard (v1.0.0)
- Branch: feature/player-dashboard

## Summary
Signed-in players get one page at `/dashboard`, linked first in the header, with three tabs:
- **Currently Opening:** published, not-started sessions across their approved teams, with fee, places left and the next step: Register, Join waitlist, View registration or View session.
- **My Registration:** Upcoming and Past registrations with their state, payment tag and total, or an estimate before billing.
- **Payments & Wallet:** a wallet card per team (balance, one state line, and Top up credit linking to `/teams/:teamId/wallet#wallet`), then Overdue, Pending and Paid accordions built from the existing `PaymentRow`, so Pay now and the invoice download appear exactly as on the billing pages.

The page works without JavaScript. Tabs come from the URL and the accordions are native `<details>`. It only reads data: there is no write path and no migration.

Human rulings (2026-11-14):
- Q1: show the session's time window only.
- Q2: Top up credit links to the wallet page.
- Q5: the post-login landing page is unchanged.
- Other questions take their defaults.

## Solution
Built autonomously (`/yay:build --auto`) in 3 phases. Each phase passed its compliance review (PROCEED).
1. **API read models (`85f8931`):**
   - `apps/api/src/modules/player-dashboard/` (read-only, guarded by `boundaries.test.ts`).
   - `GET /me/sessions/open` returns `{sessions, hasMore, overdueCount}`, capped at 50.
   - `GET /me/registrations` returns Upcoming plus Past, 20 per page with a cursor; a bad cursor is a 422.
   - `status=PAID` on `GET /payments/me` (`listPayerPaid`). The per-team route answers 422 for PAID.
   - The existing `idx_registrations_user` index already serves the registrations read.
2. **Web dashboard (`1a6a63a`):**
   - `/dashboard` page and the components in `components/dashboard/*`.
   - Pure view models in `lib/dashboard/{paths,labels,view}.ts`. A source scan bans parseFloat, Number(, toFixed, Math.* and console.
   - The page is protected in `proxy.ts`, with `no-store` on every cookie-less redirect.
   - Each section fails on its own, with its own error line.
3. **E2E, accessibility and docs (`0c2a69b`):** `apps/web/e2e/player-dashboard.spec.ts` on the separate `sgm-e2e` stack (desktop and 360 px, axe, no horizontal scroll, 44 px targets), plus the docs and memory-bank updates.

**Post-review fix (`79fd2dd`):** this resolves the final review's Important #1 (human ruling 2026-11-17, server totals).
- `GET /payments/me` returns `counts {overdue, pending, paid}`: the caller's whole totals on either list.
- The accordion titles use these totals instead of counting the loaded page's rows.
- The unpaid Show more appears once, and Paid stays open after its own Show more.

## Testing
- 4364/4364 tests pass, with 96.42% statement coverage.
- Typecheck, lint, build and the OpenAPI drift check pass.
- Playwright passed 10/10 at Phase 3. It was not re-run after the counts fix, because the seeded data fits one page and the expected titles are unchanged.
- Integration tests run on real PostgreSQL. They prove the totals on every page of 120 PAID and 60 PENDING payments, and that another player's payments are excluded.

## Files Changed
- API: `apps/api/src/modules/player-dashboard/*`, `apps/api/src/modules/billing/{player,player-repo,player-routes}.ts`, `apps/api/src/modules/registrations/read-model.ts`, `apps/api/openapi.yaml`.
- Shared: `packages/shared/src/api/{dashboard,billing}.ts`.
- Web: `apps/web/src/app/dashboard/*`, `apps/web/src/components/dashboard/*`, `apps/web/src/lib/dashboard/*`, `apps/web/src/proxy.ts`, the header links, and the `PaymentRow` export.
- Tests: `apps/api/test/integration/player-dashboard-api.int.test.ts`, `payment-attempts.int.test.ts`, component and view tests, and `apps/web/e2e/player-dashboard.spec.ts`.
- Docs: `docs/getting-started.md` (an e2e run recipe), `techContext.md`, `systemPatterns.md`, `productBrief.md`.

## Notes
- **Deviations:** the full ledger is in `memory-bank/tasks/player-dashboard.md`. In short:
  - Currently Opening is capped at 50 sessions.
  - Only free early withdrawals are hidden.
  - Any failed payments read replaces the whole Overdue/Pending/Paid area.
  - AC-ERROR-3 is tested end to end for `invoice_not_available` only.
- **Learnings:** consolidated into `agent-rules/_learned/review-process-plan-claims.md` and `api-write-idempotency.md`, which was promoted to medium.
  - Phase reviewers must list the learned rules they checked.
  - A deviation that contradicts a rule is never "polish".
  - Totals come from the API, added in the API phase.
  - A shared business rule is extracted into one function before it gets a third copy.
- **Reflection:** `memory-bank/reflection/player-dashboard-reflection.md`.

## Follow-up
1. Extract the rule "the snapshot prices a CONFIRMED row or an owed late fee" into one tested function. It is currently in `player-dashboard/service.ts` twice and in `registrations/read-model.ts` once.
2. Currently Opening: show a line when `hasMore` is true, meaning more than 50 open sessions.
3. Put a row cap on Upcoming in `GET /me/registrations`.
4. `seatsLineOf` in `lib/dashboard/view.ts` duplicates `seatsLine`; import it instead.
5. Rename or split the `listMyUnpaidPayments` operationId, which now also serves PAID.
6. Later unpaid pages show only that page's rows (cursor paging without accumulation).
7. Post-login landing on `/dashboard` (Q5, out of scope).
