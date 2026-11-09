# UI/UX Decision: Wallet, Payment Page and Payments Manage Area

**Created**: 2026-10-31
**Status**: DECIDED
**Decision Type**: UI/UX
**Task**: wallet-and-akahu-billing (Level 4)
**Answers**: Creative Q5, UI half (the per-team wallet page, team-page entry line, `/payments/[paymentId]`, the Payments manage area, processing and error states, status copy, the debt-block link target as a proposed default).
**Defers to**: the user-journey agent (final debt-link target, the seven emails' copy; see "Reconciliation flags"), the architecture and algorithm agents (read-model additions and the hold/overflow state designs listed in "Reconciliation flags").
**Binding inputs honoured**: Spec ACs (AC-ENTRY-1..4, AC-ASYNC-2, AC-ERROR-1/3/4/7, AC-VERIFY-9), rulings B1-B10 at their defaults, Plan Amendment A1-A8 (in particular A2: `FAILED/BANK_ERROR_INDETERMINATE` is a **hold**: not payable, no new attempt, no "You haven't been charged" copy).

Sources read: the task file (whole), `techContext.md` (main), `team-banking-and-gst-banking-page-uiux.md` (pattern source for form, error and status-region conventions), `confirm-disclosure.tsx`, `refresh-while-pending.tsx`, `manage-areas.ts`, `components/auth/styles.ts`, the team page (`app/teams/[teamId]/page.tsx`) and the registration debt-block text (`lib/registrations/view.ts`, `labels.ts`). `memory-bank/ux-patterns.md` does not exist; `systemPatterns.md` and `productBrief.md` were not re-read in full: stack facts come from `techContext.md` and the files above (Next 16, React 19, Tailwind 4, `.tsx` under `app/**` and `components/**`, `.ts` under `lib/**`, no new dependencies, no new colours or fonts beyond the Tailwind slate/red/amber/green scale already used).

## User Context

### Target Users
- **Primary: the Player** (APPROVED member). A casual club player, usually on a phone, who is paying a few dollars to a volunteer-run team. Wants to know "what do I owe, is it handled, did my money go through". Anxious about being charged twice and about bank redirects. Arrives either by tapping "Pay now" in an email (cold, one task) or from the team page (browsing).
- **Secondary: the Team Admin** (and Global Admin). A volunteer organiser, often on a phone at the venue, who wants a short list of who still owes, and one safe button to nudge them. Must not see emails or bank details (spec: names only).
- **Tertiary: ops (Global Admin)** who may see held payments; no separate ops UI in this feature (flagged).

### User Goals
1. Player: top up the wallet without exceeding the cap, and see the balance change.
2. Player: pay an outstanding charge in two taps and be sure it is settled exactly once.
3. Player: understand every state (processing, declined, held, team cannot receive payments) without guessing whether money moved.
4. Admin: see who has not paid, and remind one person without risking a spammy double-send.
5. Everyone: nothing is conveyed by colour alone; everything works at 360 px with one thumb.

### Use Cases
| Use Case | User | Goal | Frequency |
|----------|------|------|-----------|
| Check balance from team page | Player | See wallet and enter wallet page | Weekly |
| Top up | Player | Add $10-$100 | Monthly |
| Pay a charge from an email | Player | Settle one game | After each unpaid game |
| Return from Akahu (processing) | Player | Confirm it went through | Same as above |
| Retry after decline | Player | Pay again | Occasional |
| See held / blocked states | Player | Know what to do (wait) | Rare |
| Review ledger and payments | Player | Understand deductions | Occasional |
| Review unpaid list | Team Admin | Know who owes | Weekly |
| Send a reminder | Team Admin | Nudge one player | Weekly |
| Follow the debt-block link | Player (3+ overdue) | Find and pay overdue charges | Rare, high-value |

### Constraints
- **Devices**: desktop and 360 x 740 phone (Playwright projects). No horizontal page scroll at 360 px; every control and link at least 44 px (`min-h-11`); 16 px input text.
- **Accessibility**: AC-VERIFY-9 (axe: no critical or serious; visible label on the amount field; error announced and linked with `aria-describedby`; status tags are text; confirmations use `ConfirmDisclosure`, never a native dialog). WCAG 2.2 AA target, as in team-management and banking.
- **Languages**: English only; NZ dates ("Wed 7 Oct") and NZD via `formatNZD`; display zone Pacific/Auckland, stored UTC.
- **Reuse (no new dependencies)**: `components/auth/styles.ts` classes (`BUTTON_CLASS`, `SECONDARY_BUTTON_CLASS`, `LINK_CLASS`, `INPUT_CLASS`, `FOCUS_RING`); `TextField`, `FieldError`/`describedBy`, `ErrorSummary`, `FormBanner`, `useAuthForm`; `ManageSection` (h2 focus target + persistent `role="status"` region); `ConfirmDisclosure`; `RefreshWhilePending` (needs generalising, see Implementation); `MANAGE_AREAS`/`manageAreaLinks`; `apiClient` through Server Actions.
- **Principles**: the API is the authority (UI never hides a rule it cannot prove); no optimistic money updates; `revalidatePath` only after success; secrets (payment links, tokens, bank details) never rendered or logged.

## User Flow

### Flow Diagram
```
Email "Pay now" ──> /payments/{id} ──(anon)──> /login?returnTo=... ──┐
Team page "Wallet: $x · Top up or pay" ──> /teams/{t}/wallet          │
Debt block link ──> /payments (cross-team unpaid list, proposed) ─────┤
                                                                      v
 WALLET PAGE                                   PAYMENT PAGE
  Balance, headroom                             Summary + line items
  Top-up form ──Server Action──> Akahu ──┐      "Pay $17.00 with Akahu" ──Server Action──> Akahu ──┐
  Payments (Overdue/Pending/Paid)        │                                                         │
  Ledger (cursor)                        │                                                         │
        ^                                │             ^                                           │
        └── /wallet?topUp={id} <─────────┘             └── /payments/{id}?return=1 <───────────────┘
              processing -> credited / still waiting / declined / overflow
                                  processing -> Paid / still waiting / declined / HOLD

 ADMIN: Manage > Payments (filter Unpaid|Paid|All) > "Send reminder" > ConfirmDisclosure > "Reminder sent {time}"
```

### Flow Description
1. **Entry (player)**: team page line, email link (sign-in bounce preserves `returnTo`), wallet page "Pay now", debt-block link.
2. **Act**: type an amount or press the pay button. Both are Server Actions that call the API, then `redirect()` the browser to the Akahu URL returned. The browser leaves the site.
3. **Return**: Akahu returns to `?topUp=<id>` or `?return=1`. The page renders whatever the API says right now (credited, paid, still open, declined, held), never an assumed success.
4. **Decision points**: amount (error loop), pay vs. continue an open attempt, try again after a decline.
5. **Exit**: settled ("Paid on {date}.", new balance) or a stated next step (wait for an email, try again, ask the team).
6. **Admin**: filter, scan, press "Send reminder" on one row, confirm in place, read "Reminder sent {time}".

### Error States
| Error | Cause | User recovery / presentation |
|-------|-------|------------------------------|
| Amount empty / not a number / below $1.00 / above headroom (422 or client) | AC-ERROR-1, B1 | `ErrorSummary` takes focus, field error linked via `aria-describedby`, typed value kept; copy in the copy table |
| 409 `top_up_in_progress` | second tab or double submit | Banner "You already have a top-up in progress." plus the processing panel on refresh |
| 503 `payment_provider_unavailable` | Akahu down (AC-ERROR-7) | Banner (`role="alert"`, takes focus): "We couldn't reach Akahu. Nothing has been charged. Try again in a few minutes."; typed value kept; new idempotency key issued for the retry |
| 409 `payment_settled` | paid in another tab | Page re-renders as settled: "Paid on {date}." |
| 409 `payment_in_progress` | open attempt exists | Not an error to the user: the action follows the returned redirect ("Continue with Akahu") |
| Akahu declined/cancelled/errored (A2: CANCELLED, FAILED/REJECTED, BANK_ERROR, INTERNAL_ERROR) | AC-ERROR-3 | Notice "Your payment didn't go through. You haven't been charged." plus "Try again" |
| FAILED/BANK_ERROR_INDETERMINATE (A2 hold) | bank outcome unknown | **Hold** notice, no pay button, no "haven't been charged" (copy below) |
| Team payout blocked (AC-ERROR-4) | ops marked payout blocked (A3) | Player: "This team can't receive payments right now. We've told the team admins." Pay and top-up controls hidden |
| 403 on wallet routes | not an APPROVED member | "You need to be a member of this team to use its wallet." |
| 404 payment | not the payer, unknown id | Existing not-found page, identical for every cause |
| Reminder 409 `payment_settled` | paid meanwhile | Page-level status "That payment has already been paid." and the row refreshes |
| Reminder 409 `reminder_too_soon` (B6) | within 24 h | Row message: "A reminder was already sent {time}. You can send another after {time}." |
| Reminder 404 / 403 | wrong team / demoted | `NoAccess` re-render (existing) / banner "You don't have access to manage this team." |
| 5xx on load | API down | Existing error boundary with retry; the team-page wallet line degrades (see below) |

## Options Explored

### Option 1: Purpose-built pages per audience, wallet page stacked top-to-bottom (CHOSEN)
- **Approach**: Four surfaces, one job each. (a) a one-line wallet link on the team page; (b) `/teams/[teamId]/wallet`: Wallet section (balance, headroom, top-up or full or open-top-up state), Payments section (Overdue, Pending, Paid groups), then a Ledger section; (c) `/payments/[paymentId]`: one payment, one primary action; (d) `/teams/[teamId]/manage/payments`: admin table in the existing manage shell. A small cross-team `/payments` list serves the debt-block link (default, flagged).
- **Wireframe/Layout** (wallet page, 360 px single column; desktop is the same column at `max-w-2xl`):
  ```
  ┌──────────────────────────────────────────┐
  │ Wallet and payments for Rosedale (h1)     │
  │ ← Back to Rosedale                        │
  ├──────────────────────────────────────────┤
  │ Wallet (h2)                               │
  │ Balance: $12.50                           │
  │ You can top up to $87.50 more             │
  │ (wallet limit $100.00).                   │
  │ Top-up amount (NZD)                       │
  │ Between $1.00 and $87.50.                 │
  │ [ 20.00                              ]    │
  │ [ Top up with Akahu                  ]    │
  │ You'll leave this site to approve the     │
  │ payment with your bank through Akahu.     │
  ├──────────────────────────────────────────┤
  │ Payments (h2)                             │
  │ Overdue (h3)                              │
  │  Rosedale, Wed 7 Oct         $17.00       │
  │  [Overdue since Sat 10 Oct]  [Pay now]    │
  │ Pending (h3)                              │
  │  ...  [Due Sat 17 Oct]       [Pay now]    │
  │ Paid (h3)                                 │
  │  ...  [Paid from wallet]                  │
  ├──────────────────────────────────────────┤
  │ Wallet activity (h2)                      │
  │  Thu 8 Oct  Game fee, Wed 7 Oct  −$17.00  │
  │             Balance $13.00                │
  │  Mon 5 Oct  Top-up               +$30.00  │
  │             Balance $30.00                │
  │  [Show older activity]                    │
  └──────────────────────────────────────────┘
  ```
- **User Flow**: as the flow diagram. Linear, no tabs; the wallet page answers "how much do I have, what do I owe, what happened" in reading order.
- **Pros**:
  - Matches the approved spec's page inventory and every AC wording one to one.
  - No new interaction vocabulary: forms, banners, `ConfirmDisclosure`, `ManageSection` all exist.
  - Server-rendered, works without script (links for Refresh and pagination); each state is a real URL state (`?topUp=`, `?return=1`, `?cursor=`).
  - The email "Pay now" lands on a page with exactly one job.
- **Cons**:
  - The wallet page is long on a phone when all three sections have content (mitigated: order is balance first, owed second, history last; ledger paginates).
  - A player with debts in several teams needs the cross-team list (small extra page).
- **Usability**: High. **Accessibility**: High. **Implementation Complexity**: Medium.

### Option 2: Tabbed wallet hub (Wallet | Payments | Activity tabs)
- **Approach**: Same data, one URL, three tabs (ARIA tablist) so the page is short on a phone.
- **User Flow**: land on Wallet tab; switch to Payments to pay; Activity for the ledger.
- **Pros**:
  - Short viewport per tab; familiar app-like feel.
- **Cons**:
  - New interaction pattern (tablist roving tabindex, panel focus) the project has not used; extra a11y and test surface (AC-VERIFY-9 scans every tab state).
  - Hides overdue payments behind a tab: the most urgent item (a debt that blocks registration) is not visible on arrival.
  - Processing states (`?topUp=`) need tab-routing logic.
  - player-dashboard is already scoped to own the three-tab cross-team view; duplicating that idiom here invites a clash.
- **Usability**: Medium. **Accessibility**: Medium (tablist done well is fine; done badly is a classic failure). **Implementation Complexity**: Medium to High.

### Option 3: Payments-first list with the top-up in a drawer/modal
- **Approach**: Page is a card "Balance $12.50 [Top up]" then the payments list; "Top up" opens a modal drawer with the form.
- **User Flow**: tap Top up, fill the form in the drawer, continue to Akahu.
- **Pros**:
  - Compact page; the debts get top billing.
- **Cons**:
  - Modal/drawer contradicts the project's rule (UAT blocker class: "no native dialogs"; non-modal disclosure is the house pattern, `ConfirmDisclosure` is explicitly non-modal). A bespoke focus trap is new code to get wrong.
  - Error placement and the open-top-up state are harder inside a drawer (field error + `ErrorSummary` focus + returning focus on close).
  - Hides the cap/headroom explanation the spec wants inline above the form (AC-ENTRY-1).
- **Usability**: Medium. **Accessibility**: Low to Medium. **Implementation Complexity**: High.

### Sub-decision: admin list at 360 px
| Variant | Description | Verdict |
|---------|-------------|---------|
| A. Table with horizontal scroll container | Real `<table>`, scroll inside a wrapper | Rejected: scroll hides the action column; AC-VERIFY-9 "no horizontal scroll" and a thumb-scrolled action are poor |
| B. Duplicate DOM (table at >= 640 px, card list below, CSS-toggled) | Two renderings, one hidden | Fallback only: duplicate ids/state, doubled tests, `getByRole` ambiguity |
| C. One semantic `<table>` that reflows into stacked rows below 640 px (CHOSEN) | Native table elements with explicit `role` attributes restored (`table`, `rowgroup`, `row`, `columnheader`, `cell`) so removing `display: table-*` keeps the semantics; at < 640 px each row is a bordered block, `thead` is visually hidden (still read), each cell shows a visible `data-label` prefix | Chosen: one DOM, real columns on desktop, stacked rows on phones. If axe or a screen-reader pass flags the reflow, fall back to B |

## Evaluation Matrix

| Criteria | Option 1 (pages) | Option 2 (tabs) | Option 3 (drawer) |
|----------|------------------|-----------------|-------------------|
| Usability | High: reading order = urgency | Medium: debts hidden behind a tab | Medium: modal indirection for the main action |
| Accessibility | High: existing patterns, links, no focus traps | Medium: tablist semantics to build and scan | Low-Medium: focus trap, return focus, errors in overlay |
| Consistency | High: banking/People pages, `ManageSection`, `ConfirmDisclosure` | Low: new idiom, collides with player-dashboard tabs | Low: introduces a modal |
| Responsiveness | High: single column; long but scannable | High | Medium |
| Performance | High: server-rendered, no client JS beyond forms and refresh | Medium: client tab state | Medium |
| Implementation | Medium (about 10 components) | Medium-High | High |

## Decision

**Chosen**: Option 1, with admin list variant C (one reflowing table) and a proposed cross-team `/payments` list for the debt-block link.

### Rationale
- **Urgency first.** The most important thing to a player is "is anything overdue and how do I fix it"; Option 1 places Overdue directly under the balance, with a 44 px "Pay now" at the row.
- **Every state is a URL.** `?topUp=<id>`, `?return=1`, `?cursor=<c>` and the admin `?status=` filter make states testable, linkable and script-optional, which also makes the AC-ASYNC-2 and AC-VERIFY-9 scans straightforward.
- **No new idioms.** Nothing here needs a dialog, tablist or client router state; the confirm is the existing disclosure, errors use the banking page's `ErrorSummary` + `aria-describedby` contract.
- **Honest about uncertainty.** A2 means "declined" and "unknown" are different outcomes; the design gives them different copy and different actions, so a player never retries into a possible double charge.

### Trade-offs Accepted
- **Long wallet page on phones**: acceptable because sections are ordered by urgency and the ledger is last and paginated; no tabs.
- **One extra page (`/payments`) for the debt link** (default, flagged): a minimal grouped list, designed so player-dashboard can later replace or wrap it. If the journey agent prefers linking to the session's team wallet page, the fallback is a one-line change (see flags).
- **Reflowed table relies on explicit ARIA roles**: mitigated by an axe + keyboard pass in AC-VERIFY-9 and fallback B.
- **Open top-up cannot be cancelled by the player in v1** (no API in the spec): mitigated by "Continue with Akahu" and the expiry message (flag R5).

## Design Specifications

### Layout
- **Desktop (>= 1024 px)**: content column `max-w-2xl` (wallet, payment page, as the team page and banking page) left-aligned under the header; the admin Payments page uses the manage shell width and shows a real table (columns: Player, Session, Amount, Status, Last reminder, Action).
- **Tablet (640-1024 px)**: same as desktop; the admin table keeps columns, "Status" cell stacks the tag above "Due {date}".
- **Mobile (< 640 px, 360 x 740 target)**: single column, 16 px gutters, full-width buttons (`w-full`, `sm:w-auto` as `BUTTON_CLASS`); wallet rows are two lines (title + amount; tag + action); the admin table reflows to stacked rows.

### Surface 1: Team-page wallet line
- Rendered for `myStatus === 'APPROVED'` only, directly above `UpcomingSessions`, fetched like upcoming (its failure never takes the page down).
- One link spanning the line (min-h-11, `LINK_CLASS`): "Wallet: $12.50 · Top up or pay" (accessible name = visible text). If the wallet call fails: "Wallet and payments" (no balance, no error shown). No overdue count on this line (the wallet endpoint does not carry it; see flag R6).

### Surface 2: `/teams/[teamId]/wallet`
- **Structure**: `h1` "Wallet and payments for {Team}", back link "Back to {Team}", then three `ManageSection`-style sections (`h2` focus targets, a persistent `role="status"` region each): "Wallet", "Payments", "Wallet activity".
- **Wallet section states** (exactly one of):
  | State | Condition | Content |
  |-------|-----------|---------|
  | Top-up form | headroom > 0, no open top-up, payout ok | Balance, headroom sentence, form |
  | Full | headroom = 0.00 | "Balance: $100.00", "Your wallet is full." (form removed) |
  | Open / processing | `pendingTopUp` open or `?topUp=<id>` | Processing panel (below); form removed |
  | Payout blocked | team payout blocked | Balance only plus "This team can't receive payments right now. We've told the team admins." (form removed) |
  | Overflow notice (B3) | last top-up closed as over-cap | Notice above the form: "Your top-up of $30.00 arrived but would have taken your wallet over $100.00, so it wasn't added. The team admins have been told. Ask them about a refund." (needs API flag R4) |
- **Balance line**: `<p>` "Balance: $12.50" in `text-2xl font-semibold`; headroom `<p>` "You can top up to $87.50 more (wallet limit $100.00)." Both come from `GET /teams/:id/wallet`, never derived client-side.
- **Top-up form** (`useAuthForm` + Server Action; `TextField`): label "Top-up amount (NZD)" (visible, above input); hint `id=topup-hint` "Between $1.00 and $87.50." (min = B1 $1.00; max = headroom; both formatted by `formatNZD`); input `type="text" inputmode="decimal" autocomplete="off" enterkeyhint="go"`, `aria-describedby="topup-hint [topup-error]"`, `aria-invalid` on error. Trust line under the button: "You'll leave this site to approve the payment with your bank through Akahu. The money goes to {Team}'s bank account. Wallet credit can only be used for {Team}'s game fees." (copy item flagged R8 for human confirmation: refunds and withdrawals are out of scope).
- **Processing panel** (replaces form; `RefreshWhilePending`, generalised): `role="status" aria-live="polite"`, never moves focus. Initial: "Processing your top-up. This usually takes under a minute." + "Refresh" link. After three self-refreshes still open: "Your bank hasn't confirmed yet. We'll email you when it does." On credit: balance updates and the region announces "Your top-up of $30.00 has been added." On decline/cancel (`topUp` closed unsuccessfully): notice "Your top-up didn't go through. You haven't been charged." and the form returns. When the top-up is open but the player left Akahu (no `?topUp=`): "Top-up of $30.00 started {time}. Finish it at Akahu, or it will close by itself." with a "Continue with Akahu" button (Server Action re-posts the same idempotency key to obtain the redirect; flag R5).
- **Payments section**: `<h3>` groups in order Overdue, Pending, Paid; empty groups are omitted; none at all: "No payments yet. Charges appear here after a game." Each row is a `<li>` in a `<ul>` per group:
  - Line 1: "{Location}, {Wed 7 Oct}" (`font-medium`, wraps, `break-words`) and the amount right-aligned (`tabular-nums`).
  - Line 2: status tag, optional reason text ("Late withdrawal fee"), then (unpaid only) "Pay now" link styled as a 44 px button linking `/payments/[id]`.
  - Paid group shows at most the latest 10 plus a note "Showing your latest 10 paid games." (API caps at 50; flag R7).
- **Wallet activity**: `<ul>` newest first. Each `<li>`: date ("Thu 8 Oct"), description, signed amount ("+$30.00", "−$17.00", using the true minus sign), and second line "Balance $13.00". Descriptions: `TOPUP` "Top-up"; `AUTO_DEDUCTION` "Game fee, {Location}, {Wed 7 Oct}" (needs session location and start in the item, flag R2); `REFUND` "Refund". Pagination: "Show older activity" is a plain link `?cursor=<nextCursor>` (server-rendered; keeps earlier rows via cursor chain is NOT done: the next page replaces the list and shows a "Back to newest" link; avoids unbounded DOM and needs no client state). Empty: "No wallet activity yet."

### Surface 3: `/payments/[paymentId]`
- **Header**: `h1` "Payment for {Location}, {Wed 7 Oct}". Under it a definition list (`<dl>`): Team, Game ("{Wed 7 Oct}, {time}, {Location}"), Amount, "Includes GST of $2.22" (only when `gstAmount > 0`), Due ("Sat 10 Oct" or "Overdue since Sat 10 Oct"), Status (tag).
- **Line items** (`<h2>` "What you're paying for"): a small table (real `<table>`, 2 columns, fits 360 px): "You" / "Guest 1" / "Guest 2" with the basis label and fee; footer row "Total". Basis labels: `FLAT` "Flat fee"; `SEX_MALE`/`SEX_FEMALE`/`SEX_OTHER` "Men's / Women's / Other rate"; `SKILL_BEGINNER`/`INTERMEDIATE`/`ADVANCED` "Beginner / Intermediate / Advanced level". Late-withdrawal payments add one line above: "Late withdrawal fee: you withdrew after the deadline and the place wasn't filled."
- **State matrix** (one primary region under the dl; exactly one applies):
  | State | Trigger | Content | Primary action |
  |-------|---------|---------|----------------|
  | Pending | PENDING, no open attempt | "Due Sat 10 Oct." | `PayButton` "Pay $17.00 with Akahu" |
  | Overdue | OVERDUE, no open attempt | "Overdue since Sat 10 Oct. Pay it to register for more games." (last sentence only if the player has 3+ overdue, from the debt count; otherwise omit) | same button |
  | Attempt open, player left Akahu | open attempt, no `?return=1` | "You started a payment at {time}. If you finished it at your bank, it can take a minute to show here." | "Continue with Akahu" (follows the existing attempt's redirect) |
  | Processing after return | `?return=1` and attempt open | "Processing your payment. This usually takes under a minute." + Refresh; then "Your bank hasn't confirmed yet. We'll email you when it does." No pay button | none |
  | Paid (wallet) | PAID, `PREPAID_CREDIT` | "Paid from your wallet on {date}." | none |
  | Paid (Akahu) | PAID, `PER_GAME` | "Paid on {date}." | none |
  | No charge | PAID, amount $0.00 (B7) | "There's no charge for this game." | none |
  | Declined / try again | latest attempt closed unsuccessfully, none open, not held | "Your payment didn't go through. You haven't been charged." | `PayButton` labelled "Try again" |
  | **Hold** (A2) | latest attempt `FAILED/BANK_ERROR_INDETERMINATE` | Heading "We're checking this payment with your bank." Body: "We can't tell yet whether it went through. Please don't pay again. We'll email you as soon as we know." No "haven't been charged" wording anywhere. | none (button absent, not disabled, so nothing can be pressed) |
  | Payout blocked | team payout blocked | "This team can't receive payments right now. We've told the team admins." | none |
  | Provider unavailable | action returned 503 | Banner above the button: "We couldn't reach Akahu. Nothing has been charged. Try again in a few minutes." | button stays; new idempotency key |
  | Not found | non-payer, unknown id | Existing not-found page, same for all causes; extra line "If you were sent this link, sign in with the account you registered with." and a link to "My teams" | n/a |
- **Priority when states overlap** (renderer order): not-found > paid > hold > payout blocked > processing (`?return=1`, attempt open) > open attempt > declined > overdue > pending. Hold wins over payout blocked on a conflict because it is the one that forbids a second payment.
- **PayButton**: Server Action posts `{ idempotencyKey }`, then `redirect(redirectUrl)`. `BUTTON_CLASS`, full width on phone, label "Pay {amount} with Akahu". Idempotency key: a client `useState(() => crypto.randomUUID())` held in a hidden input, reused on double click or a second submit of the same render, regenerated after any failed result. Pending: `aria-disabled="true"` with label "Taking you to Akahu…" (the existing `aria-disabled` + `preventDefault` pattern, so focus is kept; never `disabled`). Below the button: "You'll leave this site to approve the payment with your bank through Akahu."

### Surface 4: `/teams/[teamId]/manage/payments`
- Registered as `{ id: 'payments', label: 'Payments', segment: 'payments' }` appended to `MANAGE_AREAS` (nav order: People, Banking and GST, Sessions, Payments); the page renders `ManageAreaNav` with `currentId="payments"` after its guard passes; MEMBER gets existing `NoAccess` (no nav). The guard uses `allowGlobalAdmin: true`.
- `h1` "Payments for {Team}". Intro: "People who still owe a game fee are listed here. We show names only." Filter: `<nav aria-label="Filter payments">` of three links "Unpaid" (default), "Paid", "All" (`?status=`), current link gets `aria-current="true"` and a heavier underline plus bold weight (not colour alone); each link min-h-11. Filters map to the API: Unpaid = `UNPAID`, Paid = `PAID`, All = no filter.
- **Table** (variant C): columns Player (full name), Session ("Wed 7 Oct"), Amount, Status (tag + "Due Sat 10 Oct" line), Last reminder ("Reminder sent Thu 29 Oct, 2:14 pm" or "No reminder yet"), Action. At < 640 px each row is a bordered block with labelled lines: "Player: Priya Shah", "Session: Wed 7 Oct", "Amount: $17.00", "Status: Overdue since Sat 10 Oct", "Last reminder: ...", then the action button full width.
- **Send reminder**: `ConfirmDisclosure` per unpaid row (PENDING or OVERDUE only; PAID rows have no action cell content). Trigger label "Send reminder", `triggerAriaLabel` "Send reminder to Priya Shah for $17.00, Wed 7 Oct" (starts with the visible label, WCAG 2.5.3). Prompt: "Email Priya a reminder for $17.00?" (first name only, per spec). Confirm "Send reminder", pending "Sending…", dismiss "Cancel" (a reminder panel does not need the explicit-label rule, but the shared component's default is acceptable here since there is no sibling "Cancel" action). Only one confirm open per page (page-level state in a small client provider). Form action carries a hidden `changeKey` uuid generated when the panel opens and kept until success.
- **After success**: panel closes; the row's last-reminder cell reads "Reminder sent {time}"; a page-level `role="status"` region (persistent, visually placed under the filter) announces "Reminder sent to Priya for $17.00."; focus returns to the row's trigger, which is now in the cooldown state below, so focus is never lost.
- **Cooldown** (B6, 24 h): when `lastReminderAt` is within 24 h the trigger renders as an `aria-disabled="true"` secondary button (focusable, does nothing) with `aria-describedby` pointing at the text "Reminder sent {time}. You can send another after {time}." (the cooldown length is a shared constant, never typed in the UI). If the server still answers 409 `reminder_too_soon` (clock skew, another admin), the same text is shown for the row.
- **Held payments** (A2): a row whose payment is on hold shows tag "Under review" and no "Send reminder" (a "pay now" nudge is wrong while an outcome is unknown); the row carries the line "Waiting on the bank. Nothing to do yet." (needs `onHold` on the list row, flag R1).
- **Empty states**: Unpaid: "No unpaid payments. Everyone is up to date."; Paid: "No paid payments yet."; All: "No payments yet. They appear here after a session ends." Pagination: "Show more" link `?cursor=`.
- **Payout blocked**: if the team is payout-blocked, a notice at the top links to Banking and GST: "Payments to your bank account are failing. Update your banking details." (reuses the banking page's existing blocked notice wording; no account digits). Requires `payoutBlocked` in the list response (flag R3).

### Surface 5: Debt-block link (DEFAULT, for reconciliation)
- In the registration panel, the existing message "You have {n} overdue payments. Pay them before registering for more sessions." gains an inline link on the sentence's trailing words: "Pay your overdue payments" -> **`/payments`** (new small page, below). The link is a `LINK_CLASS` anchor on its own line under the message (44 px target) so the message text stays untouched (existing tests keep passing).
- **`/payments` (cross-team, minimal)**: `h1` "Your payments". Lists the caller's unpaid payments across all teams, grouped by team (`h2` team name), Overdue before Pending within a team, rows identical to the wallet page's rows ("Pay now" to `/payments/[id]`). Empty: "You have no unpaid payments." with a link to My teams. Needs `GET /payments/me?status=UNPAID` (flag R6); it is intentionally unstyled-simple so player-dashboard can supersede it.
- **Fallback if the journey agent rules otherwise**: link to `/teams/[teamId]/wallet#payments` for the session's team only (works when the debt is in that team; misleads when it is elsewhere). The panel text is the same in both.

### Status tags (text, never colour alone)
A tag is a rounded border with text; colour only reinforces. Text colours meet AA on their tints (slate-900 on white, red-900 on red-50, amber-900 on amber-50, green-900 on green-50, each with a 1 px border in the same family).
| Condition | Tag text | Tint | Notes |
|-----------|----------|------|-------|
| PAID, PREPAID_CREDIT | "Paid from wallet" | green | |
| PAID, PER_GAME, amount > 0 | "Paid" | green | page adds "on {date}" in prose |
| PAID, amount $0.00 | "No charge" | slate | B7 |
| PENDING | "Due Sat 10 Oct" | amber | date in the tag, so the due date is never colour-coded |
| OVERDUE | "Overdue since Sat 10 Oct" | red | "since" date = `due_date` |
| Hold (A2) | "Under review" | slate | no pay action anywhere |
| Late withdrawal reason | extra line "Late withdrawal fee" | none | plain text beside the tag, not a second tag |

Dates in tags use `Intl` with `Pacific/Auckland` ("Sat 10 Oct"); an instant within today reads "today" only in the reminder cell ("Reminder sent 2:14 pm"), otherwise a short date plus time.

### Copy table (final strings; error copy is `Error: ` prefixed in the summary title as the project does)
| Where | Condition | Copy |
|-------|-----------|------|
| Top-up field | empty | "Enter an amount, for example 20.00." |
| Top-up field | not a money value (letters, 12.345, negative) | "Enter an amount in dollars and cents, for example 20.00." |
| Top-up field | below minimum (B1) | "The smallest top-up is $1.00." |
| Top-up field | above headroom (AC-ERROR-1) | "You can top up at most $15.00." |
| Top-up banner | 409 `top_up_in_progress` | "You already have a top-up in progress. It will show here once your bank confirms it." |
| Top-up / pay banner | 503 | "We couldn't reach Akahu. Nothing has been charged. Try again in a few minutes." |
| Top-up / pay banner | generic 5xx / network | "Something went wrong on our side. Nothing has been charged. Try again in a few minutes." |
| Wallet page | 403 | "You need to be a member of this team to use its wallet." |
| Processing | open | "Processing your payment. This usually takes under a minute." (+ "Refresh") |
| Processing | still open after refreshes | "Your bank hasn't confirmed yet. We'll email you when it does." |
| Credited | | "Your top-up of $30.00 has been added." |
| Declined | | "Your payment didn't go through. You haven't been charged." (top-up variant: "Your top-up didn't go through. You haven't been charged.") |
| Hold | | "We're checking this payment with your bank. We can't tell yet whether it went through. Please don't pay again. We'll email you as soon as we know." |
| Payout blocked (player) | | "This team can't receive payments right now. We've told the team admins." |
| Settled | wallet / Akahu | "Paid from your wallet on {date}." / "Paid on {date}." |
| Admin reminder prompt | | "Email {first name} a reminder for {amount}?" |
| Admin reminder success | | "Reminder sent to {first name} for {amount}." (status region) |
| Admin reminder too soon | 409 | "A reminder was already sent {time}. You can send another after {time}." |
| Admin reminder settled | 409 | "That payment has already been paid." |

### Key Components
| Component | Purpose | Behavior |
|-----------|---------|----------|
| `WalletLine` (inside team page, `wallet-summary.tsx` export) | Entry link | Single 44 px link; degrades without balance on failure |
| `WalletSummary` (`wallet-summary.tsx`) | Balance, headroom, state switch (form / full / processing / blocked / overflow) | Server component given the `GET wallet` read model |
| `TopUpForm` (`top-up-form.tsx`) | Amount entry | `useAuthForm` + Server Action; client validation with shared `parseMoney`/`lt`/`subtract`; keeps typed value; `ErrorSummary` focus on failed submit |
| `PaymentsList` (`payments-list.tsx`) | Grouped Overdue/Pending/Paid rows | Used by wallet page and `/payments`; rows are `<li>` with tag and "Pay now" |
| `PaymentStatusTag` (`payment-status-tag.tsx`) | One source of tag text and tint | Pure; takes status, billingType, amount, dueDate, hold flag; copy from `lib/billing/labels.ts` |
| `PayButton` (`pay-button.tsx`) | Start or continue an attempt | Server Action + external `redirect`; `aria-disabled` pending; reused idempotency key |
| `LedgerList` (`ledger-list.tsx`, new) | Wallet activity | `<ul>`, signed amounts, `?cursor=` link |
| `PaymentDetail` (`payment-detail.tsx`, new) | Payment page body: dl, line items, state matrix | Pure server component over the `GET /payments/:id` model + searchParams |
| `AdminPaymentsTable` (`admin-payments-table.tsx`, new) | Reflowing table | Native table with explicit roles; renders `ReminderConfirm` in the action cell |
| `ReminderConfirm` (`reminder-confirm.tsx`) | Per-row reminder | `ConfirmDisclosure` + cooldown state; focus returns to trigger |
| `ProcessingNotice` (generalised `refresh-while-pending.tsx`) | Waiting state for top-ups and payments | `RefreshWhilePending` takes `texts` props instead of importing sessions copy |
| `DebtLink` (inline in `registration-panel.tsx`) | Debt-block link | `LINK_CLASS` anchor to `/payments` |

### Interactions
| Trigger | Action | Feedback |
|---------|--------|----------|
| Submit top-up, valid | Server Action POST top-up, `redirect(redirectUrl)` | Button reads "Taking you to Akahu…", `aria-disabled`; browser leaves |
| Submit top-up, invalid | Client validation (shared) blocks the call | `ErrorSummary` focus, field error under the label via `aria-describedby`, typed value kept |
| Top-up 409/503 | Server Action returns result | Banner takes focus; value kept; fresh idempotency key |
| Press "Pay $17.00 with Akahu" | POST attempt, `redirect` | Same pending behaviour; double press reuses key |
| Return `?return=1` | Page loads current truth | `role="status"` text; three self-refreshes (about 2, 5, 10 s), no focus move, tab-hidden skip |
| State flips to paid/credited | Refresh result | Region announces; no focus move |
| "Try again" | New attempt (new key) | As pay |
| Admin filter link | Navigate `?status=` | Page reloads; `aria-current` updates; focus follows normal navigation (h1) |
| "Send reminder" | Open disclosure; prompt takes focus (existing behaviour) | Other open confirm closes |
| Confirm reminder | Server Action POST with `changeKey` | Button "Sending…"; on success panel closes, row text and status region update, focus to trigger |
| Escape / Cancel | Close panel | Focus returns to trigger (existing) |
| Show older activity / Show more | Link with cursor | Normal navigation; focus on the page h1 |

### Responsive Behavior
| Breakpoint | Changes |
|------------|---------|
| < 640 px | Single column, full-width buttons, wallet rows two-line, admin table reflows to labelled stacked rows, line-items table stays two columns, filter links wrap in a flex row with 44 px height, no horizontal scroll at 360 px (long location and player names use `break-words`) |
| 640-1024 px | Buttons `sm:w-auto`, admin table shows columns, status cell stacks tag over due line |
| > 1024 px | Content `max-w-2xl` (wallet, payment) and manage-shell width (admin table) |

### Focus management (summary)
- **Page load**: no scripted focus (Next navigation focuses the document); `RefreshWhilePending` never moves focus (AC-ASYNC-2).
- **Failed submit**: `ErrorSummary` takes focus (title "Error: ..."); each summary link targets its field; the field error is linked with `aria-describedby`.
- **Server failure banner** (503, 5xx, 409): `FormBanner` with `role="alert"` takes focus (`tabIndex=-1`), as on the banking page.
- **Success returning to the same page** (reminder): focus to the row trigger; announcement in the persistent status region.
- **Redirects** (to Akahu): none needed; on return the page is a fresh load.
- **Disclosure**: existing `ConfirmDisclosure` behaviour (prompt focus on open, trigger focus on dismiss).

### Accessibility Requirements
- [ ] Keyboard: every control reachable in DOM order; no focus traps; Escape closes a reminder confirm.
- [ ] Screen reader: `h1` per page, `h2` per section, `h3` per payment group; amount field has a visible `<label>`; hint and error both in `aria-describedby`; status regions are persistent `role="status"` elements; reflowed admin table keeps explicit roles and a (visually hidden) header row; icon-free so nothing is unlabeled.
- [ ] Contrast WCAG AA for text, tags (checked on tints), focus ring (`FOCUS_RING`), and disabled-looking `aria-disabled` buttons (opacity 60% only on the pending label, which remains readable; contrast verified at build).
- [ ] Targets: all links, buttons, filter links and "Pay now" at least 44 px (`min-h-11`); inline text links get `LINK_CLASS`.
- [ ] Not colour alone: tags carry text ("Overdue since ..."), signs (+/−) on ledger amounts, `aria-current` plus weight on the filter.
- [ ] No native dialogs; reminder confirm is `ConfirmDisclosure`.
- [ ] Reduced motion: no animation is introduced.
- [ ] Axe scanned in each state (empty, pending, processing, paid, overdue, hold, error, full wallet) on desktop and 360 x 740 (AC-VERIFY-9).

## Implementation Guidelines

### For Developers
1. **Server-render everything**; client components only for forms (`top-up-form.tsx`, `pay-button.tsx`), the refresh notice, and the reminder disclosure. Server Actions in `lib/billing/actions.ts` call `apiClient`, map errors (422 field errors, 409 codes, 503) to the `form-state` shape, and `redirect()` to `redirectUrl` only on success; `revalidatePath` only after a successful reminder.
2. **Copy lives in `lib/billing/labels.ts`** (pure `.ts`, unit-tested): tag text, basis labels, every string in the copy table, date helpers (Pacific/Auckland). Components contain no literals for status or error copy.
3. **View models in `lib/billing/wallet-view.ts`**: pure functions turning API read models into a render state: `walletState(wallet, searchParams)`, `paymentState(payment, searchParams)` implementing the documented priority order, `groupPayments`, `reminderCooldown(lastReminderAt, now)`. These are the table-tested units.
4. **Money**: only `formatNZD`, `parseMoney`, `lt`, `subtract` from `packages/shared`; never `number`/`toFixed`. Client validation reuses the same functions the API schema uses so the messages agree.
5. **Generalise `RefreshWhilePending`**: replace the import of `sessions-view` copy with props (`pendingText`, `slowText`, `doneText`, `delaysMs`); keep the sessions caller passing its current strings; add tests so the series behaviour is unchanged.
6. **Idempotency keys** generated client-side per render and regenerated after any failed result; never derived from amount or time.
7. **Reflowing table**: native `<table>` with explicit `role` attributes on `table`, `thead`, `tbody`, `tr`, `th`, `td`; Tailwind `max-sm:block`/`max-sm:grid`; `thead` `max-sm:sr-only`; cells use `data-label` rendered by `before:content-[attr(data-label)]`. Fall back to a duplicated `<ul>` rendering if axe or a manual screen-reader pass reports a problem.
8. **Proxy and nav**: `proxy.ts` `PROTECTED` gains `/teams/*/wallet`, `/payments` and `/payments/*` (with `returnTo`); `MANAGE_AREAS` gains `payments` and `manage-areas.test.ts` is extended; `NoAccess` guard for the admin page uses `allowGlobalAdmin`.
9. **Never render** payment links, tokens, bank details or email addresses; the player page shows no Akahu id.
10. **Hold is a first-class render state** (test it): no pay button in the DOM, no "haven't been charged" substring anywhere on the page (a test asserts the absence).

### Component Structure
```
apps/web/src/
├── app/
│   ├── teams/[teamId]/
│   │   ├── page.tsx                       ← extend: WalletLine above UpcomingSessions
│   │   ├── wallet/
│   │   │   ├── page.tsx
│   │   │   └── page.test.tsx
│   │   └── manage/payments/
│   │       ├── page.tsx
│   │       └── page.test.tsx
│   └── payments/
│       ├── page.tsx                       ← cross-team unpaid list (debt-block default)
│       ├── page.test.tsx
│       └── [paymentId]/
│           ├── page.tsx
│           └── page.test.tsx
├── components/billing/
│   ├── wallet-summary.tsx
│   ├── top-up-form.tsx
│   ├── payments-list.tsx
│   ├── payment-status-tag.tsx
│   ├── pay-button.tsx
│   ├── reminder-confirm.tsx
│   ├── ledger-list.tsx                    ← added to the plan list
│   ├── payment-detail.tsx                 ← added
│   └── admin-payments-table.tsx           ← added
├── components/teams/refresh-while-pending.tsx   ← generalise (props for copy)
├── components/registrations/registration-panel.tsx ← debt-block link
└── lib/
    ├── billing/
    │   ├── actions.ts
    │   ├── labels.ts
    │   ├── wallet-view.ts
    │   ├── actions.test.ts
    │   ├── labels.test.ts
    │   └── wallet-view.test.ts
    └── teams/manage-areas.ts              ← add { id: 'payments', label: 'Payments', segment: 'payments' }
```
> Extensions follow `techContext.md`: `.tsx` under `app/**` and `components/**`, `.ts` (no JSX) under `lib/**`, tests colocated.

### Recommended Libraries/Patterns
- No new dependencies. `Intl.DateTimeFormat` with `timeZone: 'Pacific/Auckland'` for all display dates.
- The banking page's `useAuthForm` + `ErrorSummary` + `FormBanner` contract for forms; `ManageSection` for status regions; `ConfirmDisclosure` for confirms.
- Test with the existing Vitest component style plus Playwright + axe for AC-VERIFY-9 states, including a Playwright assertion for scroll width at 360 px on each scanned state.

## Reconciliation flags (for the orchestrator)

Read-model additions this design needs from architecture/algorithm (none change scope; each is a small field):
- **R1 Hold state**: `GET /payments/:id` `attempt.status` must distinguish `OPEN | CLOSED_FAILED | HELD` (A2); `GET /teams/:id/payments` rows need `onHold: boolean`; `POST .../reminders` must refuse held payments (409, e.g. `payment_on_hold`). The algorithm doc owns the hold semantics and any ops surface.
- **R2 Ledger descriptions**: ledger items need `session: { location, startsAt } | null`, not just `sessionId`.
- **R3 Payout blocked**: `GET wallet`, `GET /payments/:id` and the admin list need `payoutBlocked: boolean` (or equivalent) so the UI can hide pay/top-up and show the right notice without a failed call.
- **R4 Overflow/duplicate (B3)**: the wallet read model needs a way to show a recently closed top-up that arrived over cap (`lastTopUp: { status, amount, closedReason }`), else the player never sees the B3 notice.
- **R5 Abandoned top-up**: an open top-up hides the form, so a player who bailed at Akahu is stuck until expiry; algorithm Q3 must define expiry (UI copy above assumes "closes by itself") and ideally a "Continue" (idempotent re-post returns the redirect) and a player-side "Cancel top-up" (SHOULD, not in the spec's route list).
- **R6 Debt-block link (journey agent decides)**: default proposed here is a minimal cross-team `/payments` list backed by a new `GET /payments/me?status=UNPAID` (caller's unpaid payments across teams, with `teamName`). Fallback: link to the session team's `/teams/[teamId]/wallet#payments`. Either satisfies AC-ENTRY-4 only if the chosen page lists the overdue payments with "Pay now"; the fallback does not when the debt is in another team. Also decide whether emails link to `/payments/[id]` (as spec) and whether the team-page line should show an overdue count (needs a field on the wallet read model).
- **R7 Pagination of payments/me**: the spec route has no cursor; the UI assumes the API caps at the 50 newest and the wallet page shows the latest 10 paid. Confirm or add a cursor.
- **R8 Copy needing a human glance**: "Wallet credit can only be used for {Team}'s game fees" (asserts a no-withdrawal policy that is only implied by scope boundaries), and "The money goes to {Team}'s bank account" (true per A1).
- **R9 `RefreshWhilePending` is coupled to sessions copy** (`sessions-view.ts`); generalising it is a prerequisite for Phase 5.
- **R10 Emails**: the payment email's link and the "Reminder" email's copy must use the same state vocabulary ("Due Sat 10 Oct", "Overdue since ...") so a player sees the same words in the email and on the page.

## Validation Checklist

- [x] Meets all user goals (top up, pay, understand states, admin remind, 360 px)
- [x] Accessible per requirements (AC-VERIFY-9 items specified per state)
- [x] Consistent with existing patterns (banking page contracts, `ConfirmDisclosure`, `ManageSection`, manage-area registry)
- [x] Respects the plan's component list (six named components kept; three added and flagged) and A1-A8 (hold state, no Akahu link in emails, payee unseen)
- [x] Responsive across devices (single column; reflowing admin table)
- [x] Performance acceptable (server-rendered, script only for forms/refresh/disclosure)
- [x] Implementation feasible (no new dependencies; one component generalised)

## Next Steps

1. Reconcile flags R1-R10 with the architecture, algorithm and user-journey docs in the Creative Reconciliation section of the task file (debt-link target R6 first, because it changes the page inventory).
2. Add the three extra components and `app/payments/page.tsx` to the plan's New Source Files if R6 default is accepted.
3. Phase 5 starts with the pure view-model and labels tests (`wallet-view.test.ts`, `labels.test.ts`), including the hold-state "no 'haven't been charged'" assertion and the state-priority table.
4. Build `AdminPaymentsTable` first against axe at 360 px to settle variant C vs fallback B early.

NEW_TERMS_INTRODUCED: Hold state (UI render state for A2 `BANK_ERROR_INDETERMINATE`, tag "Under review"); Open-attempt notice ("You started a payment at {time}", "Continue with Akahu"); Cross-team payments list (`/payments`, the proposed debt-block target); Reflowing table (native table with explicit ARIA roles that stacks below 640 px); Cooldown state (aria-disabled "Send reminder" within the B6 24-hour window); No-charge tag ("No charge" for a PAID $0.00 B7 row); `payoutBlocked` / `onHold` (proposed read-model flags R1, R3).
