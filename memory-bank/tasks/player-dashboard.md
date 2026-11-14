---
slug: player-dashboard
feature: player-dashboard
status: PLANNING_COMPLETE
---

# player-dashboard: Player Dashboard

**Complexity**: Level 2
**Status**: PLANNING_COMPLETE
**Roadmap**: player-dashboard
**Branch**: feature/player-dashboard
**Worktree**: /Users/admin/yay-wt/shared-game-management/feature-player-dashboard

## Task Description

Player-facing three-tab dashboard (PRODUCT-OVERVIEW §3).

1. **Currently Opening**: upcoming published sessions across joined teams (team, court schedule, address, rate, seats left, Register button)
2. **My Registration**: DateTime, payment status (`PAID`/`PENDING`/`OVERDUE`), team, address, total fee
3. **Payments & Wallet**: balance per team + Top Up Credit (max $100), accordions Overdue/Pending/Paid with Akahu links and PDF invoice downloads

**Depends on**: wallet-and-akahu-billing (Phases 1-6 merged in PR #9; live Akahu, Phase 4b, is not live yet), tax-invoices-and-exports (merged in PR #10: PDF downloads).

**Complexity rationale**: UI composition over APIs delivered by earlier features; clear requirements, few design decisions → Level 2.

---

## Specification

**Feature Type**: End-User Feature
**Primary Persona**: Player (`PLAYER`): finds and joins teams, registers for sessions, pays easily (productBrief "Key Personas"). Success metric carried over: registration in under 30 s, few overdue payments.
**Creative Exploration Needed**: No. The four open choices (court-schedule depth, top-up inline vs link-through, one-tap Register, post-login landing) each have a recommended default below and are listed under "Creative Exploration Needed" for a human ruling, not for a design phase.

*Note: spec drafted by the Spec Writer agent from the repo at `feature/player-dashboard` (cut from `origin/main` 5a3ae86). Every "reused" item below was verified in code; every "new" item is flagged.*

### Invocation Method

- **Location**: new web route `/dashboard` (`apps/web/src/app/dashboard/page.tsx`, a Server Component, `export const dynamic = 'force-dynamic'`, `robots: { index: false }`, wrapped in the existing `TeamShell`). The page title is `Dashboard – Shared Game Management`; the `h1` is `Dashboard`.
- **Element**:
  - A **Dashboard** link in the signed-in site header (`apps/web/src/components/site-header-links.tsx`), placed first in the link group: `Dashboard`, `Find a team`, `My teams`, `Account`. It carries `aria-current="page"` on `/dashboard`. Only the `signed_in` header state gets it (the `unavailable` and `anonymous` states are unchanged).
  - Three tab links in a `<nav aria-label="Dashboard">` under the `h1`, rendered exactly like `ManageAreaNav` (server component, `<ul>` of `<a>`, current tab `aria-current="page"` plus `font-semibold decoration-2`, no client JS, no `role="tab"`): **Currently Opening**, **My Registration**, **Payments & Wallet**.
- **Visibility**: any signed-in user (a user with no team sees empty states). Signed-out: `proxy.ts` adds `/dashboard` to `PROTECTED` (cookie-less redirect to `loginUrl({ returnTo })`, `cache-control: no-store`), and the page calls `requireUser(here)` for the real check.
- **Navigation**: header `Dashboard` (from any page) -> `/dashboard` (tab `Currently Opening`). Tabs are plain URLs, so they work without JS and survive reload and back/forward:
  - `/dashboard` and `/dashboard?tab=opening` -> Currently Opening (default)
  - `/dashboard?tab=registrations` -> My Registration
  - `/dashboard?tab=payments` -> Payments & Wallet
  - An unknown `tab` value renders the default tab (never a 404 or 500). Only the active tab's data is loaded.
- **Confidence**: HIGH for route, nav pattern and protection (copied from `ManageAreaNav`, `proxy.ts` `PROTECTED`, `/payments` page). MEDIUM for header placement (see open question 8).

**API surface: reused vs new** (the only new endpoints are the cross-team aggregates that do not exist today)

| Tab | Endpoint / component | Status |
|---|---|---|
| all | `apiClient.mineTeams` -> `GET /teams/mine` (filter `status === 'APPROVED'`) | REUSED (Tab 3 only) |
| 1 Currently Opening | `GET /me/sessions/open` | **NEW** (cross-team, caller-scoped; needs team name, address, caller's own rate, `canRegister`; the per-team `GET /teams/:teamId/sessions/upcoming` returns none of team name, address or fee, and N teams x 10 sessions x `.../registration` would be N+1) |
| 1 | Register / View registration -> existing player session page `/teams/:teamId/sessions/:sessionId` (`playerSessionPath`), `RegistrationPanel`, `registerForSession` Server Action | REUSED (link-through; no registration write from the dashboard) |
| 2 My Registration | `GET /me/registrations` | **NEW** (no cross-team registrations list exists; payment status needs a join to `payments`) |
| 2 | `PaymentStatusTag`, `paymentTag`, `groupLine`, `formatWhen`, `/payments/:paymentId` | REUSED |
| 3 Payments & Wallet | `apiClient.wallet(teamId, {})` -> `GET /teams/:teamId/wallet`, once per APPROVED team, in parallel | REUSED (fan-out, bounded by the caller's approved teams; the ledger page in the response is ignored) |
| 3 | `apiClient.myUnpaidPayments` -> `GET /payments/me?status=UNPAID` (50 per page, `nextCursor`) | REUSED |
| 3 | `GET /payments/me?status=PAID` (the same route, `MyPaymentsQuery.status` gains `'PAID'`; same `UnpaidPaymentsResponse` shape grouped by team, ordered `paid_at desc, id desc`, 50 per page) | **NEW (additive extension of an existing route)**; the per-team `GET /teams/:teamId/payments/me` is not usable for a cross-team Paid list |
| 3 | `walletState`, `balanceLine`, `headroomLine`, `walletFullLine`, `money`, `canPayRow`, `groupPayments`, `PaymentRow` (`components/billing/payments-list.tsx`), `PaymentStatusTag`, `DownloadInvoiceLink`, `DownloadErrorNotice`, `myDocumentPath`, `billingErrorLines`, `PAYMENTS_LOAD_FAILED`, `NO_PAYMENTS` | REUSED |
| 3 | Top up -> existing `/teams/:teamId/wallet#wallet` (`TopUpForm`, `startTopUpAction`) | REUSED (link-through) |
| 3 | Pay now ("Akahu link") -> existing `/payments/:paymentId` (`startPaymentAction`) | REUSED (link-through) |
| 3 | PDF invoice / receipt -> existing Next route `GET /payments/:paymentId/invoice?returnTo=` (`myDocumentPath(row.id, returnTo)`) gated by `row.document.available` | REUSED (no new download route) |

Reality checks that shape the design:

1. **There is no stored "Akahu link".** `MyPaymentRow` carries no URL, and `authorisation_url` is a sealed envelope (P4). The only place a payment attempt starts is `POST /payments/:paymentId/attempts`, called from the payment page. So "direct Akahu payment links" are specified as the existing **Pay now** link to `/payments/:paymentId`, and the dashboard itself never calls Akahu or the payments gateway.
2. **Live Akahu (Phase 4b) is not live.** `PAYMENTS_ADAPTER=akahu` refuses to boot and the fake is refused in production (`apps/api/src/lib/config/config.ts`, `lib/akahu/config.ts`); the fake runs in dev and the `sgm-e2e` stack. The dashboard adds **no** provider-availability flag, hides nothing and claims nothing. Top up and Pay now are links into pages that already degrade honestly (`payment_provider_unavailable` -> "We couldn't reach Akahu. Nothing has been charged. Try again in a few minutes."). When Phase 4b ships, the dashboard changes nothing.
3. **A payment exists only after a game ends** (post-game billing). An upcoming registration therefore has no payment row, so "payment status" for it is "Not billed yet", never a fabricated PENDING.

### Success Criteria

- **User sees**:
  - Tab 1: one card per upcoming PUBLISHED session across the teams where they are APPROVED, soonest first: team name, location, date and time window, address, their own fee, places left, and a button (`Register`, `Join waitlist`, `View registration` or `View session`).
  - Tab 2: every registration (Upcoming, then Past) with date and time, payment status tag, team, address and total fee.
  - Tab 3: a wallet card per approved team (`Balance: $12.50`, the headroom line showing the $100.00 cap, `Top up credit`), then three native accordions `Overdue`, `Pending`, `Paid` with `Pay now` links and `Download tax invoice` / `Download receipt` links (labels come from `DownloadInvoiceLink` by `document.kind`).
- **Verifiable at**: `/dashboard`, `/dashboard?tab=registrations`, `/dashboard?tab=payments` on the `sgm-e2e` stack (`docker-compose.e2e.yml`, fake adapter), and via `app.inject` integration tests of `GET /me/sessions/open`, `GET /me/registrations`, `GET /payments/me?status=PAID`.
- **Data persisted**: none. The feature is read-only: **no migration, no write path, no new table** (migration count unchanged; `types.generated.ts` unchanged). Money and instants come from existing columns (`game_sessions`, `registrations`, `payments`, `player_credits`, `payment_documents`). A build-time check (not a schema change) confirms the `registrations (user_id, ...)` access path is indexed or the row counts per user are bounded; add an index by forward migration only if `EXPLAIN` says a seq scan on a realistic fixture (see open question 9).
- **Observable within**: immediate on every load (`force-dynamic`, API `cache-control: no-store`). Settlement happens elsewhere (webhook, `akahu-sync`); the dashboard shows the new state on the next load and does not poll.

### Acceptance Criteria

#### AC-ENTRY-1: A signed-in player finds the dashboard from the header
**Priority**: MUST
**Given** a signed-in player on any page (for example `/teams`)
**When** they look at the main navigation
**Then** the first link is `Dashboard` (44 px target, visible focus ring) and activating it opens `/dashboard` with the `Currently Opening` tab current (`aria-current="page"`) and the `h1` `Dashboard`; the `anonymous` and `unavailable` header states are unchanged

#### AC-ENTRY-2: The three tabs are URL-driven links that work without JavaScript
**Priority**: MUST
**Given** the player is on `/dashboard`
**When** they follow `My Registration` and then `Payments & Wallet` with JavaScript disabled
**Then** the URL becomes `/dashboard?tab=registrations` and then `/dashboard?tab=payments`, each shows only its own section, exactly one tab link has `aria-current="page"`, reload and the back button return to the same tab, and `/dashboard?tab=bogus` renders `Currently Opening` with status 200

#### AC-ENTRY-3: A signed-out visitor is sent to sign in and returned to the same tab
**Priority**: MUST
**Given** a visitor with no session cookie
**When** they open `/dashboard?tab=payments`
**Then** `proxy.ts` redirects to `/login?returnTo=%2Fdashboard%3Ftab%3Dpayments` with `cache-control: no-store`, and after sign-in they land on that tab; a dead cookie goes through `sessionExpiredUrl('/dashboard?tab=payments')` (same `returnTo`) rather than an error page

#### AC-HAPPY-1: Currently Opening lists real upcoming sessions across all the player's teams
**Priority**: MUST
**Given** a player APPROVED in teams A and B (and PENDING in team C), where A has two PUBLISHED sessions, B has one, C has one, and A also has a DRAFT, a CANCELLED and a started session
**When** they open `/dashboard`
**Then** exactly the three published, not-yet-started sessions of A and B appear, soonest first, ties by session id; none of C's, the DRAFT, the CANCELLED or the started one appears; each card shows: team name (link to `/teams/:teamId`), location as the card heading, `Wed 7 Oct, 8:00 pm to 10:00 pm` (Pacific/Auckland, from `startsAt` and `endsAt`; day and start time only when `endsAt` is null), the full `address`, the caller's own fee (`FLAT`: `$12.00 per person`; `BY_SEX`: `Your fee: $12.00`; `BY_SKILL_LEVEL`: `Your fee: $12.00 (Intermediate)`; unpriced: `The fee isn't set for this session yet.`), and the existing `seatsLine` (`3 of 8 places left · 2 on the waitlist`, `Full · 2 on the waitlist`); values equal the API response field for field (stub detection: the integration test seeds distinct values per session and asserts each rendered string)

#### AC-HAPPY-2: The session button reflects what the player can do, and registration stays on the existing page
**Priority**: MUST
**Given** Currently Opening cards in each state
**When** the player reads and uses the button
**Then** the button is an anchor to `playerSessionPath(teamId, sessionId)` with a 44 px target and an accessible name that starts with its visible text plus the session (`Register<span class="sr-only"> for {location}, {when}</span>`): `Register` when `me` is null, `canRegister` and `seatsLeft > 0`; `Join waitlist` when `me` is null, `canRegister` and `seatsLeft === 0`; `View registration` plus the tag (`You're in` or `Waitlist #n`) when `me` is set; `View session` (secondary style) when `canRegister` is false for any `blockedReason`. When `overdueCount >= 1` a banner above the list says `debtMessage(overdueCount)` and links `Go to Payments & Wallet` to `/dashboard?tab=payments`. Following `Register` reaches the existing `RegistrationPanel`, and after registering there the session shows `You're in` on the dashboard card on the next load

#### AC-HAPPY-3: My Registration lists every registration with date, payment status, team, address and total fee
**Priority**: MUST
**Given** a player with a CONFIRMED registration in an upcoming session (no payment yet), a WAITLISTED one, a past CONFIRMED one that was billed and is OVERDUE, a past one that is PAID from the wallet, a late-withdrawal one (fee billed, PENDING), and a free (EARLY) withdrawal
**When** they open `/dashboard?tab=registrations`
**Then** the page shows an `Upcoming` section (soonest first) and a `Past` section (newest first, 20 per page, `Show more` follows `nextCursor`); each card shows: location heading, team name, `formatWhen(startsAt)`, address, `groupLine(guestCount)`, the registration state (`You're in`, `Waitlist #n`, `Late withdrawal`, `Session cancelled`), the payment tag from the existing `paymentTag` (`Paid from wallet`, `Paid`, `Due Sat 10 Oct`, `Overdue since Sat 10 Oct`, `Under review`; `FAILED` reads as pending, as on the wallet page), and the total (`Total fee: $24.00` from `payment.amount` when billed, otherwise `Estimated total: $24.00` from the server's party estimate, or `The fee isn't set for this session yet.`); an unbilled CONFIRMED row shows the tag `Not billed yet`, a WAITLISTED row `Charged only if you get a place.`; the free EARLY withdrawal is not listed; a billed row also links `View payment` to `/payments/:paymentId`; every card links `View session`

#### AC-HAPPY-4: Payments & Wallet shows the balance per team and the one allowed next step
**Priority**: MUST
**Given** a player APPROVED in teams A (balance $12.50, headroom $87.50), B (balance $100.00, headroom $0.00), C (an open top-up) and D (a held top-up)
**When** they open `/dashboard?tab=payments`
**Then** under the heading `Wallet` there is one card per approved team in `mineTeams` order, each with the team name linking to `/teams/:teamId/wallet`, `Balance: $12.50` (`balanceLine`) and exactly one state line from the existing `walletState`: `You can top up to $87.50 more (wallet limit $100.00).` with a `Top up credit` link to `/teams/:teamId/wallet#wallet` (A); `Your wallet is full.` with no top-up link (B); the `startedLine` text with a `View wallet` link (C); the held heading with a `View wallet` link (D); no amount, headroom or cap is computed in the web layer (P2); the link text is `Top up credit` with `<span class="sr-only"> for {team}</span>`

#### AC-HAPPY-5: Overdue, Pending and Paid accordions carry Pay now and invoice downloads
**Priority**: MUST
**Given** a player with one OVERDUE and two PENDING payments (one of them under review) in team A, one PENDING in team B, and a PAID-from-wallet and a PAID-via-Akahu payment (both above $0.00) plus a $0.00 PAID one
**When** they open `/dashboard?tab=payments` and expand each accordion
**Then** three native `<details>` accordions appear in the order `Overdue (1)`, `Pending (3)`, `Paid (3)` (count in the summary; `<summary>` is a 44 px target; Overdue and Pending are `open` by default when non-empty, Paid is closed); inside each, rows are grouped under a team `h4`; every row is the existing `PaymentRow` (location and day, `money(amount)`, `PaymentStatusTag`, `Late withdrawal fee` reason when applicable); `Pay now` links to `/payments/:paymentId` and appears only when `canPayRow` (never on Paid, held or payout-blocked rows, which show `HOLD_ROW_PLAYER` / `PAYOUT_BLOCKED_PLAYER`); the download link appears exactly when `document.available` (the $0.00 row has none) and its href is `myDocumentPath(id, '/dashboard?tab=payments')`; following it returns the PDF (`application/pdf`) for that payment only

#### AC-HAPPY-6: Every paid game's invoice stays reachable and unpaid history pages
**Priority**: MUST
**Given** a player with 120 PAID payments across teams and 60 unpaid ones
**When** they use `Show more` in the Paid accordion (`?tab=payments&paidCursor=<opaque>`) and in the Overdue/Pending accordions (`&unpaidCursor=<opaque>`)
**Then** `GET /payments/me?status=PAID` returns pages of 50 ordered `paid_at desc, id desc` grouped by team, `Show more` appears while `nextCursor` is non-null and is absent on the last page, no row repeats or is skipped across pages, the cursors are opaque and independent of each other, and the page URL keeps the other accordion's cursor

#### AC-HAPPY-7: The new endpoints return only the caller's own data, from real queries
**Priority**: MUST
**Given** two players with overlapping teams on a real PostgreSQL database (`*.int.test.ts`, `app.inject`, cloned DB)
**When** player 1 calls `GET /me/sessions/open`, `GET /me/registrations` and `GET /payments/me?status=PAID`
**Then** responses contain no row of player 2 (no guest names, no other player's payment or registration, no email, no bank detail, no `authorisation_url`); `GET /me/sessions/open` includes a team only while the caller is APPROVED (a PENDING, REJECTED or BANNED row contributes nothing, and banning mid-test removes the team's sessions on the next call); `GET /me/registrations` has no membership filter so a banned player still sees their own history; unauthenticated calls are 401; every response has `cache-control: no-store`; money is a 2-dp `MoneyString` and instants are ISO UTC; `openapi.yaml` is regenerated and the drift check passes; the new module is read-only (a structural test like `modules/registrations/boundaries.test.ts` fails on any insert/update/delete) and is added to `vitest.config.ts` `include`

#### AC-HAPPY-8: The dashboard meets the project's accessibility and responsive conventions in every state
**Priority**: MUST
**Given** the Playwright projects `desktop` and `360 x 740` on the `sgm-e2e` stack
**When** the `scan` helper runs on each tab, each accordion state (open and closed) and each empty state
**Then** axe reports no critical or serious violation, there is no horizontal scroll at 360 px, every link, button and `<summary>` is at least 44 px high, focus order follows reading order (tabs, banner, cards), no information relies on colour alone, and the current tab, the wallet state and the payment state are available to screen readers as text

#### AC-ERROR-1: A failed read degrades only its own section
**Priority**: MUST
**Given** the player opens a tab while one API read fails with a 5xx or is unreachable
**When** the page renders
**Then** the page and the tab nav still render; Tab 1 shows `We can't load sessions right now. Try again in a minute.`; Tab 2 shows `We can't load your registrations right now. Try again in a minute.`; in Tab 3 a failed `GET /teams/:teamId/wallet` replaces only that team's card body with `We can't load this wallet right now. Try again in a minute.` and a failed payments read replaces the accordions with `PAYMENTS_LOAD_FAILED`; nothing is guessed or shown as `$0.00`; each failure logs `web.dashboard.api_failure` with action, status and code only (no amount, id list or token); a 401 on any read redirects to `sessionExpiredUrl(here)` with the tab preserved

#### AC-ERROR-2: The dashboard never starts a payment, so an unavailable provider cannot break it
**Priority**: MUST
**Given** no live payment provider (production today, or the fake adapter told to fail the next create)
**When** the player uses `Top up credit` or `Pay now` from the dashboard and then submits on the destination page
**Then** the dashboard itself makes no call to `POST .../top-ups` or `POST .../attempts` and shows no provider-status claim; the destination page shows the existing copy (`payment_provider_unavailable`: `We couldn't reach Akahu. Nothing has been charged. Try again in a few minutes.`), the dashboard renders normally on return, and no dashboard string says Akahu is, or is not, live

#### AC-ERROR-3: A failed invoice download lands back on Payments & Wallet with the existing notice
**Priority**: MUST
**Given** a payment whose document is not available (`invoice_not_available`), still pending (`invoice_pending`) or whose route fails (`service_unavailable`)
**When** the player follows its download link on the dashboard
**Then** the route answers `303` to `/dashboard?tab=payments&download_error=<code>`, the page renders `DownloadErrorNotice` for that code above the accordions, the accordions are intact, and the notice code carries no name, amount or file name

#### AC-ERROR-4: Empty states say what to do next
**Priority**: MUST
**Given** a player in each empty situation
**When** they open each tab
**Then** Tab 1 with no APPROVED team shows `Join a team to see its open sessions here.` and a link `Find a team` to `/teams/find`; Tab 1 with teams but no open session shows `No sessions are open for registration right now.`; Tab 2 with none shows `You haven't registered for any sessions yet.` and a link `See open sessions` to `/dashboard`; Tab 3 with no APPROVED team shows `Join a team to get a wallet.` and `Find a team`; Tab 3 with a team but no payments shows `NO_PAYMENTS` (`No payments yet. Charges appear here after a game.`) in place of the accordions while the wallet cards still render; an empty accordion shows `Nothing overdue.`, `Nothing pending.` or `No paid games yet.`

#### AC-ERROR-5: Held and payout-blocked payments are never offered for payment
**Priority**: MUST
**Given** an unpaid payment with `onHold: true`, and another whose team has `payoutBlocked: true`
**When** the player views them in the Overdue or Pending accordion or on the My Registration card
**Then** neither shows `Pay now`; the held row shows `We're checking this payment with your bank.` and the tag `Under review`, the blocked row shows `This team can't receive payments right now. We've told the team admins.`, and following `View payment` shows the existing payment-page state

#### AC-ERROR-6: A malformed or stale query parameter never breaks the page
**Priority**: SHOULD
**Given** `?tab=` unknown, `?paidCursor=` or `?unpaidCursor=` garbage, or a `?cursor=` that is no longer valid
**When** the page loads
**Then** an unknown tab shows the default tab; a cursor the API refuses (422) shows the first page of that list with the rest of the page intact and no 500; an overlong or non-string parameter is ignored (the `firstParam` helper)

#### AC-ASYNC-1: A top-up or payment still with the bank is shown honestly and settles on the next load
**Priority**: MUST
**Given** an open top-up (`pendingTopUp.outcome === 'processing'`), a held top-up, and a payment whose latest attempt is processing
**When** the player opens Payments & Wallet before and after the provider confirms (webhook and `akahu-sync`)
**Then** before: the wallet card shows `Top-up of $20.00 started Wed 7 Oct, 8:00 pm. Finish it at Akahu, or it will close by itself.` with `View wallet`, and the payment row shows its existing tag; the dashboard does not poll or auto-refresh (the wallet page owns `RefreshWhilePending` and the Akahu return lands there via `?topUp=<id>`); after: a reload shows the credited balance and the payment as `Paid` with its invoice link, with no stale value served from any cache

#### AC-ASYNC-2: A session that has ended but is not billed yet is not an error
**Priority**: SHOULD
**Given** a CONFIRMED registration whose session has ended but the billing sweep has not produced a payment
**When** the player opens My Registration, and again after billing runs
**Then** before billing the card shows the tag `Not billed yet` and `Estimated total: $X`, with no payment link and no error; after billing it shows the real payment tag and `Total fee` from `payment.amount`, in `Past`; an overdue transition (`daily-overdue`) appears as `Overdue since <date>` on the next load

### Scope Boundaries

- **In scope**:
  - Route `/dashboard` with three URL-driven tabs, the header link, and `proxy.ts` protection.
  - Two new read-only aggregate endpoints (`GET /me/sessions/open`, `GET /me/registrations`) with shared zod schemas in a new `packages/shared/src/api/dashboard.ts`, API module `apps/api/src/modules/player-dashboard/` (routes, read model, service; reuses `feeColumnsOf`, `unitFee`, `estimateTotal`, `decideAccess`, `isRegistrationOpen`, `countOverdueByUser` and `readOnly` snapshot reads from `modules/registrations`), `apiClient` methods, OpenAPI regeneration, and the `status=PAID` extension of `GET /payments/me` (`listPayerPaid` in `modules/billing/player-repo.ts`, the service method in `player.ts`).
  - Web: `apps/web/src/components/dashboard/*` (tabs nav, open-session cards, registration cards, wallet cards, accordions), `apps/web/src/lib/dashboard/{paths,labels,view}.ts` (pure view models, table-tested; copy deck in one file), one small refactor exporting the existing `PaymentRow` from `components/billing/payments-list.tsx` so the accordions reuse it unchanged.
  - Tests: unit tests of the pure view models and components (Vitest, in `apps/web/src/lib/**` already measured); integration tests on real PostgreSQL for the three endpoints; Playwright `apps/web/e2e/player-dashboard.spec.ts` on the separate `sgm-e2e` stack (`docker-compose.e2e.yml`, `PAYMENTS_ADAPTER=fake`) for desktop and 360 px with axe, no-horizontal-scroll and 44 px checks. Setup goes through the API (sessions created and published with the admin bearer token, people sign in through the real form); the only direct DB writes allowed are those `billing.spec.ts` already uses to age a payment to OVERDUE or end a session.
  - Doc updates at build: `techContext.md`, `systemPatterns.md` (read-model pattern, no-JS tabs and accordions), `productBrief.md` (player dashboard now exists), and the `vitest.config.ts` coverage include list.
- **Out of scope**:
  - Any live Akahu behaviour, a provider-availability flag, storing or showing a payment URL, and anything for Phase 4b.
  - Registering, withdrawing, topping up or paying from the dashboard itself (all remain on the existing session, wallet and payment pages).
  - Wallet ledger activity (stays on `/teams/:teamId/wallet`), admin payments, the admin master report, new invoice routes or PDF rendering, notifications, real-time updates, polling, and a new migration.
  - Changing `/` (the health-check home page) or the post-login default landing (open question 5).
  - Per-court rows for a session (open question 1), guest names in any list, and exports.
  - Subscription billing.
- **Dependencies**:
  - wallet-and-akahu-billing (PR #9: wallet, payments, `payments/me`, payment page; live Akahu pending) and tax-invoices-and-exports (PR #10: `MyPaymentRow.document`, `myDocumentPath`, `DownloadInvoiceLink`).
  - registration-and-waitlist (session read model, player session page) and team-management (`GET /teams/mine`, membership status).
  - `packages/shared`: `MyPaymentRow`, `UnpaidPaymentsResponse`, `PaymentDocumentRef`, `RegistrationBlockedReason`, `moneyStringSchema`.
- **NFR implications**:
  - P1 Postgres is the system of record (read-only here); P2 money is exact (`MoneyString` from the API, formatted with `formatNZD`, never summed or parsed to `number` in web; a source scan of `lib/dashboard/**` bans `parseFloat` and `number` money); P3 UTC in the API and Pacific/Auckland conversion only in web formatters; P5 not applicable (no async side effect added).
  - Observability: structured `log.warn('web.dashboard.api_failure', …)`, no `console.*`, no sensitive data in logs; the API routes carry the standard trace context.
  - Security: every query is scoped by the authenticated user id; a team's data is included only through the caller's APPROVED membership; responses are `no-store`; no email, bank detail, payment token or other player's name leaves the API.
  - Privacy/retention: nothing is stored or deleted.
  - Performance: Tab 1 and Tab 2 are one API call each; Tab 3 is `mine` then wallets in parallel plus two payments reads; each read has a 50-row or 20-row page bound; the response size is bounded by `hasMore`/`nextCursor`.
  - Accessibility: axe no critical/serious, 360 px, 44 px targets, native `<details>` and links so everything works without JS.
  - Observed project gate: `pnpm run ci` (lint, typecheck, `test:coverage` at 80%, build); E2E runs outside `ci`.

### Creative Exploration Needed

Specification is concrete. No design phase is needed.

**Human ruling (2026-11-14, spec review):** approved with every default below. Explicitly confirmed: Q1 time window only (no per-court rows for players); Q2 `Top up credit` links to the wallet page (no embedded `TopUpForm`); Q5 post-login landing unchanged (follow-up task). Q3, Q4, Q6, Q7, Q8 and Q10 take their stated defaults; Q9 stays a build-time check (Phase 1).

Confidence by field: route, tab pattern, protection, Tab 3 composition and invoice reuse HIGH; new endpoint shapes and the `status=PAID` extension MEDIUM; "court schedule" depth LOW (open question 1).

**Open questions for the human**

1. **Court schedule (LOW confidence).** The player read models expose only `startsAt`/`endsAt`; per-court `identifier`/`startTime`/`endTime` (`SessionCourtResponse`) is admin-only today. Default used: show the session's date and time window. Alternative: add a `courts` array to the open-sessions row and list each court's time (extends what players can see; small extra join).
2. **Top Up Credit (MEDIUM).** Default used: a per-team `Top up credit` link to the existing wallet page, with the $100 cap shown on the card. Alternative: embed the existing `WalletSummary`/`TopUpForm` per team (N forms, N idempotency keys; Akahu still returns to the wallet page).
3. **"Instant" Register button (MEDIUM).** Default used: link to the existing session page, where guests, debt block and waitlist wording already live. Alternative: a one-tap `Register` (just me) Server Action using `registerForSession` with `guests: []`, plus a `Register with guests` link.
4. **Which registrations are "all" (MEDIUM).** Default: CONFIRMED, WAITLISTED, and WITHDRAWN with a late fee owed; EARLY (free) withdrawals are hidden; a CANCELLED session's registration shows in Past as `Session cancelled`. Confirm, or include free withdrawals.
5. **Landing (MEDIUM).** Should sign-in without a `returnTo` land on `/dashboard` instead of `/`? Not done here: it would change `landing.ts`, the auth E2E expectations and the `/` health page. Recommended as a small follow-up.
6. **Wallet fan-out vs aggregate (MEDIUM).** Default: `mine` plus one `GET /teams/:teamId/wallet` per approved team (existing endpoints; each also returns an unused ledger page). Alternative: a new `GET /me/wallets` (one query, balances and headroom only). Worth it only if teams per player can exceed roughly 10; is there a membership cap?
7. **Paid list shape (MEDIUM).** Default: cross-team Paid via `status=PAID`, 50 per page, `Show more`. The wallet page instead caps Paid at 10 with a "Show older paid games" link; the dashboard does not copy that cap. Confirm.
8. **Header (MEDIUM).** `Dashboard` first in the signed-in links, and omitted in the `unavailable` state. Confirm placement and whether `/teams` ("My teams") should link to it.
9. **Index (build-time check).** Confirm `registrations` has a usable access path by `user_id` (no index was visible in the generated types); add one by forward migration only if needed.
10. **Naming.** `GET /me/sessions/open` and `GET /me/registrations` follow `/payments/me` and `/auth/me`; confirm or choose another namespace.

## Test Strategy

### Approach
- **Emphasis**: balanced (systemPatterns default). Integration tests on real PostgreSQL prove caller scoping and query semantics of the new endpoints; pure view-model unit tests carry the copy and state mapping; one Playwright spec proves the entry-to-success journey.
- **Target test count**: about 45 across three phases. Above the Level 2 guide of 20 because the feature spans three new read paths, three tabs with distinct state matrices, and the project's mandatory E2E/a11y gate; each test maps to an AC.

### File Organization
- **New test files**:
  - `apps/api/test/integration/player-dashboard-api.int.test.ts`: `GET /me/sessions/open`, `GET /me/registrations` (scoping, filtering, ordering, paging, 401, no-store).
  - `apps/api/src/modules/player-dashboard/boundaries.test.ts`: read-only structural guard (no insert/update/delete), modelled on `modules/registrations/boundaries.test.ts`.
  - `packages/shared/src/api/dashboard.test.ts`: zod schema round trips.
  - `apps/web/src/lib/dashboard/view.test.ts`: tab parsing, card/button/tag/total view models, empty states, money source scan (no `parseFloat`/`number` money).
  - `apps/web/src/components/dashboard/dashboard-components.test.tsx`: tab nav `aria-current`, accordion counts/open state, wallet card states, error-section rendering.
  - `apps/web/e2e/player-dashboard.spec.ts`: Playwright journey on `sgm-e2e`, desktop + 360 px, axe/no-scroll/44 px.
- **Extend existing**:
  - `apps/api/test/integration/*` for `GET /payments/me?status=PAID` (extend the file that already covers `payments/me` UNPAID; build agent locates it with grep).
  - `apps/web/src/lib/api-client-billing.test.ts` / `api-client.test.ts` for the new client methods.
  - `apps/web/src/components/billing/billing-components.test.tsx` only if exporting `PaymentRow` changes behaviour (it should not).

### What NOT to Test
- Registration, top-up, payment and invoice-download behaviour on destination pages: covered by existing `registrations`, `billing`, `invoices` tests; the dashboard only links to them (assert hrefs, not destination internals beyond the E2E path).
- `types.generated.ts` and `openapi.yaml` contents: covered by tsc and the drift check.
- Live Akahu: out of scope; the fake adapter is the only provider in tests.

### Per-Phase Test Guidance
- Phase 1 (API): ~18 tests. AC-HAPPY-1 filtering (APPROVED only; PUBLISHED, not started; DRAFT/CANCELLED/started/PENDING-team excluded; ordering ties by id), caller fee per pricing mode, `me`/`canRegister`/`blockedReason`/`overdueCount`; AC-HAPPY-3 registration set (CONFIRMED, WAITLISTED, late WITHDRAWN; EARLY withdrawal hidden; cancelled session in Past), payment join and estimate, Upcoming/Past split and 20-per-page cursor; AC-HAPPY-6 `status=PAID` order `paid_at desc, id desc`, 50 per page, no repeat/skip; AC-HAPPY-7 two-player isolation, ban mid-test, 401, `no-store`, MoneyString/ISO; boundaries test; shared schema tests.
- Phase 2 (Web): ~22 tests. AC-ENTRY-1/2/3 (header link, tab parsing incl. bogus tab, proxy protection with `returnTo`), AC-HAPPY-2 button matrix and debt banner, AC-HAPPY-3/4/5 view models (tags, totals, wallet state lines, accordion grouping/counts/open defaults, `Pay now` only when `canPayRow`, download link only when `document.available`), AC-ERROR-1/3/4/5/6 (per-section failure copy, download error notice, empty states, held/payout-blocked rows, bad cursors), AC-ASYNC-1/2 render states, money source scan.
- Phase 3 (E2E): ~4 Playwright tests × 2 projects. Header → `/dashboard`; Currently Opening card → Register on session page → `You're in` on reload; My Registration after billing (aged OVERDUE via the direct DB writes `billing.spec.ts` already uses); Payments & Wallet wallet card, accordions, `Pay now` href, PDF download returning `application/pdf`; axe/no-horizontal-scroll/44 px on every tab, accordion state and empty state (AC-HAPPY-8); signed-out redirect with `returnTo` (AC-ENTRY-3).

## Implementation Roadmap

### New Source Files (pin path + extension)
- [ ] `packages/shared/src/api/dashboard.ts` — zod schemas + types for `OpenSessionsResponse`, `MyRegistrationsResponse` (+ query schemas)
- [ ] `packages/shared/src/api/dashboard.test.ts` — schema tests
- [ ] extend `packages/shared/src/api/billing.ts` — `MyPaymentsQuery.status` gains `'PAID'`
- [ ] extend `packages/shared/src/index.ts` (or the api barrel) — export dashboard schemas
- [ ] `apps/api/src/modules/player-dashboard/routes.ts` — `GET /me/sessions/open`, `GET /me/registrations` (auth, no-store)
- [ ] `apps/api/src/modules/player-dashboard/service.ts` — compose read model with fee/access helpers from `modules/registrations`
- [ ] `apps/api/src/modules/player-dashboard/repo.ts` — read-only queries (snapshot `readOnly` reads)
- [ ] `apps/api/src/modules/player-dashboard/boundaries.test.ts` — read-only guard
- [ ] extend `apps/api/src/modules/billing/player-repo.ts` — `listPayerPaid`
- [ ] extend `apps/api/src/modules/billing/player.ts` + `player-routes.ts` — `status=PAID`
- [ ] extend `apps/api/src/app.ts` (`buildApp`) — register the module
- [ ] `db/migrations/<utc>_registrations_user_index.sql` — ONLY if the Q9 check shows no usable `registrations(user_id)` access path (forward migration, with Down)
- [ ] `apps/api/test/integration/player-dashboard-api.int.test.ts`
- [ ] extend `vitest.config.ts` — add `apps/api/src/modules/player-dashboard/**` to coverage `include`
- [ ] extend `apps/web/src/lib/api-client.ts` — `openSessions`, `myRegistrations`, `myPaidPayments`
- [ ] `apps/web/src/lib/dashboard/paths.ts` — tab URLs, cursor params, `returnTo` for downloads
- [ ] `apps/web/src/lib/dashboard/labels.ts` — copy deck (all dashboard strings)
- [ ] `apps/web/src/lib/dashboard/view.ts` — pure view models (tab parse, cards, buttons, tags, totals, wallet states, accordion groups)
- [ ] `apps/web/src/lib/dashboard/view.test.ts`
- [ ] `apps/web/src/app/dashboard/page.tsx` — Server Component, `force-dynamic`, `requireUser`, active-tab-only loading
- [ ] `apps/web/src/components/dashboard/dashboard-tabs.tsx` — tab nav (ManageAreaNav pattern)
- [ ] `apps/web/src/components/dashboard/open-sessions-tab.tsx`
- [ ] `apps/web/src/components/dashboard/registrations-tab.tsx`
- [ ] `apps/web/src/components/dashboard/payments-tab.tsx` — wallet cards + `<details>` accordions
- [ ] `apps/web/src/components/dashboard/dashboard-components.test.tsx`
- [ ] extend `apps/web/src/components/billing/payments-list.tsx` — export `PaymentRow` (no behaviour change)
- [ ] extend `apps/web/src/components/site-header-links.tsx` — `Dashboard` link first (signed_in only)
- [ ] extend `apps/web/src/proxy.ts` — add `/dashboard` to `PROTECTED`
- [ ] `apps/web/e2e/player-dashboard.spec.ts`
- [ ] extend `memory-bank/{techContext,systemPatterns,productBrief}.md`, `docs/getting-started.md` if it lists player pages

### Phases
- [ ] Phase 1: API read models — shared dashboard schemas; `player-dashboard` module (`GET /me/sessions/open`, `GET /me/registrations`); `status=PAID` on `GET /payments/me`; Q9 index check (migration only if needed); OpenAPI regen + drift; coverage include; integration + boundaries tests. ACs: HAPPY-1 (data), HAPPY-3 (data), HAPPY-6, HAPPY-7, ASYNC-2 (data).
- [ ] Phase 2: Web dashboard — `/dashboard` page, tab nav, header link, proxy protection, three tabs from pure view models, `PaymentRow` export, per-section error handling, empty states, download-error notice. ACs: ENTRY-1/2/3, HAPPY-1..5, ERROR-1..6, ASYNC-1/2 (render).
- [ ] Phase 3: E2E, accessibility and docs — `player-dashboard.spec.ts` on the `sgm-e2e` stack (desktop + 360 px, axe, no-scroll, 44 px), full entry-to-success journey with concrete spec values; memory-bank and docs updates. ACs: HAPPY-8 plus the end-to-end proof of ENTRY-1, HAPPY-2, HAPPY-5, ERROR-3, ERROR-4.

Final phase delivers the complete entry-to-success flow: header `Dashboard` → `/dashboard` → each tab's success state as specified.

### Observability Requirements
- **Applies**: Yes (new HTTP handlers, new web API calls) → reference `observability-requirements.md` during build.
- **Logging**: API routes use the request logger with trace context; web logs `web.dashboard.api_failure` (action, status, code only). No amounts, ids lists, names or tokens; no `console.*`.
- **Tracing**: standard Fastify/OTel request spans; web API client propagates W3C trace context as existing calls do.
- **Metrics**: none new.

### API Requirements
- **REST API**: Yes → load `api-rest-requirements.md` during build. New `GET /me/sessions/open`, `GET /me/registrations`; additive `status=PAID` on `GET /payments/me`.
- **OpenAPI Spec**: regenerated `openapi.yaml` (drift check must pass; re-check the verifier did not revert it before commit).

### Dependencies
- Phase 2 depends on Phase 1 (client methods + schemas). Phase 3 depends on Phase 2.
- Merged: wallet-and-akahu-billing Phases 1-6 (PR #9), tax-invoices-and-exports (PR #10), registration-and-waitlist, team-management. No dependency on Akahu Phase 4b.

## Creative Phases

- None required (Level 2, spec approved with all fields HIGH/MEDIUM after rulings; the LOW court-schedule field was ruled: time window only).

---

## Execution State

**Build Status**: IDLE
**Current Phase**: BUILD
**Current Step**: Planning complete
**Can Resume**: NO

### Active Sub-Agents
(none)

### Completed Steps
- Spec Writer Agent: COMPLETE (2026-11-14) — Specification section; taxonomy lint CLEAN (19 ACs)
- Human spec review: APPROVED with defaults (2026-11-14)
- Implementation plan: COMPLETE (2026-11-14) — 3 phases
