# User Journey Design: Wallet and Akahu Billing

**Created**: 2026-10-31
**Status**: DECIDED
**Decision Type**: User Journey
**Task**: `wallet-and-akahu-billing` (Level 4). Spec and plan: `memory-bank/tasks/wallet-and-akahu-billing.md` (spec approved 2026-10-30 with rulings B1-B10 at their defaults; Plan Amendment A1-A8 of 2026-10-31 is binding). Branch `feature/wallet-and-akahu-billing`.
**Answers**: Creative Q5, journey side: the player, team-admin and global-admin journeys; where the registration debt block links (AC-ENTRY-4); the copy of the seven emails; whether this feature's minimum surfaces are enough.
**Binding inputs**: spike `research/wallet-and-akahu-billing-akahu-payment-capability-spike.md` and its handoff (DR-001 to DR-005, OV-1 to OV-3), as cited by A1-A8. Akahu One-Off Payments: the player is redirected to Akahu's hosted `authorisation_url` and comes back to our `redirect_uri`. Statuses are READY → AUTHORISED → SUBMITTED → terminal SENT / CANCELLED (TIMED_OUT, USER_CANCELLED, APP_CANCELLED) / FAILED (REJECTED, BANK_ERROR, BANK_ERROR_INDETERMINATE, INTERNAL_ERROR). Links expire (default 1 h).
**Parallel inputs (not decided here)**: Architecture (routes, the A3 manual block route, the hold resolution route, the apply function, webhook), Algorithm (top-up intent states, hold state, B8/B9 edge cases, the overdue rule for held and blocked payments), UI/UX (layout, components, final control-level copy). Every UI string here is **proposed**. Email copy is proposed in full, because no other creative doc owns it.
**Web conventions reused** (from the registration, banking and session journeys already on `main`): one task per URL; Server Actions with in-place `FormState` errors; post/redirect/get with codes-only `?notice=` and text from `lib/billing/labels.ts`; `requireUser(returnTo)` plus the `proxy.ts` sign-in redirect and `no-store`; `RefreshWhilePending` for pull-based waiting (about 2, 5 and 10 s, no focus move, then a slow-path line); `ConfirmDisclosure` for every confirmation, never a native dialog; the reload-or-keep rule (state known to have changed: reload; outcome unknown: change nothing, keep the input); plain-text emails that start "Hi {first name}," and end "Shared Game Management", with user text folded onto one line.

**Hard constraints carried into every journey**
- **No Akahu link is ever emailed (A5).** Every email links to our own page (`/payments/[id]`, `/teams/[T]/wallet` or a manage page). The Akahu payment is created only when the payer presses the pay or top-up button.
- **The payment page is payer-only.** Another player, a team admin, a global admin and an unknown id all get the same not-found page and the same 404 body.
- **Admin views show no bank details and no email addresses.** They show player names, amounts, dates and statuses only.
- **No native dialogs.** Every confirmation is a `ConfirmDisclosure`.
- **No "You haven't been charged" copy for BANK_ERROR_INDETERMINATE (A2).** That outcome is a hold and is never offered "Try again".

---

## Journey Overview

**Feature**: A player keeps a prepaid wallet per team (capped at $100.00) and tops it up by bank transfer through Akahu. After each game the fee is taken from the wallet if it covers the whole fee. Otherwise the player gets a "Payment due" email linking to a payment page, where they pay through Akahu. Unpaid charges become overdue after their due date, which emails the player and, at 3 or more across all teams, blocks new registrations. Team admins (and global admins) see the team's payments and can send a reminder. When the team's payout account is reported as failing, a global admin marks it. That stops new paid publishes, pauses billing for ended sessions and stops players paying the team until a team admin saves the bank details again.
**Primary Persona**: Player (`PLAYER`, an APPROVED member of the team), usually on a phone and often opening an email link.
**Journey Type**: **Hybrid.** Top-up and pay start synchronously, hand off to Akahu (an external, browser-redirect step that may pass through a bank app), and finish asynchronously (webhook, reconcile sweep, or a re-read on the return page). Post-game billing, overdue and emails are fully asynchronous (worker). Reminders and the payout-failing mark are synchronous admin actions with async email.
**Orchestration Pattern**: **Per-team Dashboard + Detail** (team page line → per-team "Wallet and payments" page → payer-only payment page), **Notification + Action** for every email (always to our page, never to Akahu), a **single-screen status-driven payment page** with a pull-based processing state, a **cross-team "Unpaid payments" list** as the remedy page for the debt block, and a **manage-area table with inline `ConfirmDisclosure`** for admins.

### Success Statement
> A player taps "Wallet: $0.00 · Top up or pay" on their club's page, enters 30, taps "Top up with Akahu", approves the transfer in their bank and lands back on "Balance: $30.00". After the next game they see "Paid from wallet" without doing anything. When their wallet can't cover a game, they get "Payment due: Smash Club, Wed 7 Oct, $17.00, due Sat 10 Oct", tap "Pay now", sign in if asked, tap "Pay $17.00 with Akahu", and come back to "Paid on Wed 7 Oct."

---

## Persona Context

### Primary User
- **Who**: Player (`PLAYER`, productBrief Key Personas; pain point "manual bank transfers"; success metric "few overdue payments").
- **Goal**: Pay for games with as little effort as possible, never twice, and know at any moment what they owe each team.
- **Context**: A phone (360 px), opening a link from an email or the group chat. The Akahu step may switch to the bank's app and come back in a different browser, often an in-app browser where they are not signed in. Plays with one to three teams.
- **Proficiency**: Casual. Knows online banking and "pay by bank" from other NZ sites. Does not know what Akahu is. Will distrust any page that seems to ask for money twice, and will try again quickly if a payment seems stuck. Retrying an indeterminate payment is exactly what the A2 hold must prevent.

### Secondary Users
- **Player whose wallet runs low**: needs a clear early nudge before the wallet stops covering games, and to understand that a wallet too low to cover a fee is not touched at all (no partial deduction).
- **Player with overdue payments, possibly in several teams**: the debt gate counts across teams. The page they are sent to must list every team's overdue payments, including teams they have since left or been banned from, because those still count.
- **Former or banned member with an unpaid charge**: can no longer open the team or its wallet page but must still be able to pay. The payment page and the cross-team unpaid list are payer-scoped, not membership-scoped.
- **Team Admin** (`TEAM_ADMIN`): wants to see who owes what without chasing people by hand, and a one-tap reminder. Is the only person who can confirm whether money actually reached the team's bank account, which makes them useful when a payment is held for checking. Gets the payout-failing and billing-paused emails and fixes the account on the existing Banking and GST page.
- **Global Admin** (`GLOBAL_ADMIN`, platform operations): sends reminders for any team, marks a team's payouts as failing when Akahu, a bank or the team reports it (A3), and resolves payments held as indeterminate (A2). Has no cross-team admin UI until admin-reporting-dashboard, so reaches a team by URL.
- **Later features**: player-dashboard ("Payments & Wallet" tab aggregates the per-team read models across teams), admin-reporting-dashboard (cross-team payments report reusing the reminder action), tax-invoices-and-exports (adds invoice links to payment rows and the payment page later).

---

## Journey Map

### Surface ownership decision (Q5)

| Surface | Owner | Decision |
|---|---|---|
| Team page line "Wallet: {balance} · Top up or pay" on `/teams/[teamId]` (APPROVED members only) | **this feature** | **Confirmed.** It is the only in-app way to the wallet before player-dashboard ships, so AC-ENTRY-1 depends on it. It stays after player-dashboard ships: per-team context is where players think about a team's money. |
| `/teams/[teamId]/wallet` "Wallet and payments" (per team; balance, top-up, activity, this team's payments) | **this feature** | **Confirmed.** It is the return target for top-ups. A wallet belongs to one (player, team), so the page is per team. |
| `/payments/[paymentId]` payment page (payer only) | **this feature** | **Confirmed.** It is the target of every payment email and the only place a pay attempt starts. |
| `/teams/[teamId]/manage/payments` "Payments" manage area | **this feature** | **Confirmed.** It is the team admin's list and the reminder action. A global admin may open it for any team. This journey also puts the two GLOBAL_ADMIN-only operations controls here (mark payouts as failing, resolve a held payment), because it is the one billing page a global admin can already open. |
| `/payments` "Unpaid payments" (cross-team, payer only; PENDING, OVERDUE and held payments of the caller in every team) | **this feature (new in this doc)** | **Added.** It is the debt-block link target (AC-ENTRY-4, below). It is deliberately a single list with no tabs, no wallet balances and no paid history, which keeps it out of player-dashboard's scope. |
| Cross-team "Payments & Wallet" tab | player-dashboard | **It aggregates and does not replace.** It reads the same read models. When it ships, `/payments` may redirect to it or embed the same `UnpaidPaymentsList` component, so links in old emails and the debt block keep working. The per-team wallet page, the team-page line and the payment page stay. |
| Cross-team admin payments report | admin-reporting-dashboard | Reuses `POST .../reminders` and the row "Send reminder" component. |

**Slot contract for player-dashboard** (record in ADR 0020):
1. `/payments/[id]` remains the only place a pay attempt starts. Dashboards link to it and never call `POST /payments/:id/attempts` themselves.
2. `/teams/[T]/wallet` remains the only place a top-up starts, because it is the Akahu return target.
3. `/payments` keeps answering: either the list itself or a redirect to the dashboard tab filtered to unpaid.

### AC-ENTRY-4 decision: where the debt block links

The block reads "You have {n} overdue payments across your teams. Pay them before registering for more sessions. If you think this is wrong, ask your team admin." (existing `debtMessage`). It gains a link **"See your overdue payments"** to **`/payments`**.

Why `/payments` (cross-team) and not the current team's wallet page:
- `countOverdueByUser` counts OVERDUE across **all** the user's teams (C-BIL-2), so the overdue payments may all be in other teams. A link to this team's wallet could show "No payments due" next to a message saying they owe three. That is a broken promise at the exact moment the player is blocked.
- A former or banned member's debt still counts, but they can no longer open that team's wallet page (membership-gated). `/payments` is payer-scoped, so it lists those payments too.
- A link to the oldest overdue payment fixes only one of the three and does not tell the player how many remain.

Consequence (spec addition, flagged): a new read route **`GET /payments/me?status=UNPAID`** (`authenticated()`, caller-scoped across teams, no team guard) returning `{ payments: [{ id, team: { id, name }, sessionStartsAt, location, amount, status, dueDate, held }] }`, and `proxy.ts` `PROTECTED` gains `/payments` as well as `/payments/*`.

### Entry Points

| Entry | Context | User intent |
|---|---|---|
| Team page line "Wallet: $12.50 · Top up or pay" | `/teams/[T]`, next to "Upcoming sessions", APPROVED only | "How much credit do I have? Top up." |
| Same line with a debt suffix (SHOULD): "Wallet: $12.50 · 2 payments due" | Same, when the caller has PENDING or OVERDUE payments in T | "I owe this team something" |
| "Payment due" / "Overdue" / "Reminder" email → "Pay now" `{WEB}/payments/[id]` | Inbox, usually a phone | "Pay this game" |
| "Running low" email → `{WEB}/teams/[T]/wallet` | Inbox | "Top up before the next game" |
| Registration debt block → "See your overdue payments" `/payments` | Session page, blocked from registering | "What do I owe, and where?" |
| Akahu return `{WEB}/payments/[id]?return=1` or `{WEB}/teams/[T]/wallet?topUp=<id>` | After the bank step, possibly another browser | "Did it work?" |
| Manage area nav "Payments" `/teams/[T]/manage/payments` | Team admin: header "My teams" → team → "Manage" | "Who hasn't paid?" |
| "Payout failing" / "Billing paused" email → `{WEB}/teams/[T]/manage/banking` | Team admin's inbox | "Fix the bank account" |
| Typed URL `/teams/[T]/manage/payments` | Global admin | "Remind this player", "mark payouts as failing", "resolve a held payment" |
| Signed-out visit to any protected URL above | Any | Sign in first: `/login?returnTo=<path with query>` and back |

### Page and route inventory

| URL | Who | Purpose |
|---|---|---|
| `/teams/[T]` (existing, new line) | APPROVED members | Wallet line → wallet page |
| `/teams/[T]/wallet` (new, protected) | APPROVED members of T | Balance, headroom, top-up, wallet activity, this team's payments; Akahu return target for top-ups |
| `/payments/[id]` (new, protected) | The payer only, member or not | One charge: details, pay, processing, result; Akahu return target for payments |
| `/payments` (new, protected) | Any signed-in user, their own rows | Unpaid payments across all teams |
| `/teams/[T]/manage/payments` (new area) | TEAM_ADMIN of T; GLOBAL_ADMIN | Team payments table, reminders; GLOBAL_ADMIN operations panel |

`?notice=` codes (closed list, text in `lib/billing/labels.ts`, stripped after render): wallet page `top_up_cancelled_by_you`; manage page `reminder_sent`, `payout_marked_failing`, `hold_resolved_paid`, `hold_resolved_released`. Top-up and payment outcomes are **not** notices. They are derived from persisted state on every render (the `?topUp=` and `?return=1` parameters only choose which item's state to show), so a refresh never loses them and a forged parameter shows nothing that isn't true.

---

### Player-visible states of one charge (payment + its latest attempt)

```
                    bill-session (worker)
                           │
          ┌────────────────┴─────────────────┐
   wallet covers fee                  wallet doesn't cover (or no wallet)
          │                                  │
  [PAID · PREPAID_CREDIT]            [DUE: PENDING, no attempt] ──email "Payment due"
  "Paid from wallet"                         │
  (low-credit email if < $20)                │ payer taps "Pay {amt} with Akahu"
                                             ▼
                                  [ATTEMPT OPEN: READY] ── the player is at Akahu
                                    │        │      │
                     abandon/back   │  authorise    │ USER_CANCELLED / TIMED_OUT / APP_CANCELLED
                     (no outcome)   │        ▼      ▼
                     "Continue      │  [PROCESSING: AUTHORISED/SUBMITTED]
                      with Akahu"   │        │                     [DUE again + "You cancelled" /
                                    │        ├── SENT ──────────▶ [PAID · PER_GAME] "Paid on {date}." + email
                                    │        ├── FAILED/REJECTED|BANK_ERROR|INTERNAL_ERROR
                                    │        │        ──▶ [DUE again + "didn't go through. You haven't been charged."]
                                    │        └── FAILED/BANK_ERROR_INDETERMINATE
                                    │                 ──▶ [HELD: "We're checking this payment with your bank"]
                                    │                       │ GLOBAL_ADMIN resolves
                                    │                       ├── money arrived ──▶ [PAID]
                                    │                       └── it didn't ─────▶ [DUE again]
                                    ▼
             daily-overdue at 04:00 after due_date (not while HELD or team blocked; see Spec conflicts)
                                    ▼
                        [OVERDUE] "Overdue since {date}" ── email "Overdue"; same pay flow; OVERDUE → PAID
```

Overlay states that override the pay action on any unpaid charge:
- **Team payouts failing** (`payout_blocked_at` set): "This team can't receive payments right now. We've told the team admins." No pay button, no top-up form.
- **Unknown Akahu status** (A2 unknown branch): treated as PROCESSING for the player, and logged.

### Step-by-step journeys

#### J1: Top up a wallet (AC-ENTRY-1, AC-HAPPY-1, AC-ERROR-1, 2, 3, 7, AC-ASYNC-2)

| # | System | User sees | User does | Transition |
|---|---|---|---|---|
| 1 | Web (server component) → API `GET /teams/T/wallet` | Team page: "Wallet: $0.00 · Top up or pay" | Taps it | → `/teams/T/wallet` |
| 2 | Web → API `GET .../wallet`, `GET .../payments/me` | `h1` "Wallet and payments" · "Balance: $0.00" · "You can top up to $100.00 more (wallet limit $100.00)." · field "Top-up amount (NZD)" (`inputmode="decimal"`) · button "Top up with Akahu" · hint "You'll approve a bank transfer to {Team} with Akahu. Your wallet pays for future games automatically." | Types "30", taps the button | Server Action |
| 3 | Web Server Action → API `POST .../wallet/top-ups {amount, idempotencyKey}`. API tx1 commits the intent; then, **outside any lock**, it calls Akahu create (payee = T's account, decrypted in memory); tx2 records `_id` and `authorisation_url` | Button shows "Starting…" (disabled, `aria-busy`) | Waits about 1-2 s | 201 → Server Action `redirect(redirectUrl)` (303) to Akahu |
| 4 | Akahu hosted page, then the bank (web or app) | Akahu: choose bank, log in, approve "$30.00 to {Team account name}" | Approves (or cancels, or closes the tab) | Akahu → browser to `redirect_uri` `/teams/T/wallet?topUp=<id>` |
| 5 | Web → API `GET .../wallet` (the API re-reads an open top-up from Akahu on this read and applies the result through the shared apply function, by our stored `_payment` id only; the URL's `topUp` id just selects which intent to describe) | One of: **credited** "Top-up received. Balance: $30.00" and activity line "Top-up +$30.00 · balance $30.00"; **processing** "Processing your top-up. This usually takes under a minute." + "Refresh" (`RefreshWhilePending`); **cancelled** "You cancelled the top-up. You haven't been charged." + form; **failed** "Your top-up didn't go through. You haven't been charged." + form; **held** (J7) | Nothing, or "Refresh" | Webhook / reconcile resolve processing → next render |
| 6 | Same | Slow path after the third refresh: "Your bank hasn't confirmed yet. We'll email you when it does." | Can leave | "Top-up received" email when SENT is applied |

Details and decisions:
- **Quick amounts (COULD, UI/UX decides)**: chips "$20", "$50", "Fill to $100.00" (showing the headroom), each only when it is at most the headroom. They fill the field and do not submit.
- **Validation (AC-ERROR-1)**: inline under the field, linked by `aria-describedby`, typed value kept. Over headroom: "You can top up at most $15.00." Under B1 minimum: "The smallest top-up is $1.00." Not a money amount: "Enter an amount in dollars and cents, like 20 or 20.50." No intent is created and Akahu is not called.
- **Full wallet**: the form is replaced by "Your wallet is full." (headroom 0.00).
- **Open top-up (one per wallet, AC-ERROR-2)**: with an open READY top-up the form is replaced by "You started a top-up of $30.00 at 7:42 pm." + **"Continue with Akahu"**. The 409 `top_up_in_progress` returns the same redirect, so a second tab or a double tap takes the player back to the same Akahu page and never creates a second one. With AUTHORISED or SUBMITTED it shows the processing state and no button. An abandoned READY top-up closes when Akahu reports TIMED_OUT (expiry set by architecture; this journey recommends **30 minutes** so a player who wandered off is not locked out for the 1-hour default), and the form comes back.
- **Akahu unavailable (AC-ERROR-7)**: the form stays with the typed amount and a banner: "We couldn't reach Akahu. Nothing has been charged. Try again in a few minutes." The next tap uses a new key and works.
- **Team payouts failing**: the form is replaced by "This team can't receive payments right now. We've told the team admins." (spec addition: the top-up route refuses with 409 `payout_not_configured`, see conflicts).
- **Top-ups and charges already due**: under the form, when the player has unpaid charges in this team: "Top-ups pay for future games. To pay a charge that's already due, use Pay now below." A top-up does not settle an existing PER_GAME charge (no "pay from wallet" in scope), and this line stops players topping up and then wondering why the charge is still due.
- **Session expiry or browser switch on return**: the bank app may reopen the return URL in another browser. `proxy.ts` sends a signed-out return to `/login?returnTo=%2Fteams%2FT%2Fwallet%3FtopUp%3D<id>` and back, landing on step 5. The webhook and reconcile complete the top-up even if the player never returns.

#### J2: After a game, the wallet covers the fee (AC-HAPPY-2, AC-HAPPY-7)
1. Worker: the `post-game-billing` sweep (every 5 min) enqueues `bill-session`. One transaction completes the session, writes PAID `PREPAID_CREDIT` and `AUTO_DEDUCTION`, and enqueues the low-credit email only if the new balance is under $20.00 (B5: every such deduction).
2. The player does nothing. The next visit to the wallet page shows the Payments row "{Location}, {Wed 7 Oct} · $17.00 · Paid from wallet" and the activity line "Game at {Location}, {Wed 7 Oct} −$17.00 · balance $13.00".
3. If under $20.00: the "running low" email arrives within about 30 s and links to the wallet page (J1).
No email is sent for a covered deduction that leaves $20.00 or more. That is deliberate: no noise per game, and the activity list is the record.

#### J3: After a game, the wallet doesn't cover it: pay by link (AC-HAPPY-3, 4, AC-ENTRY-2, AC-ERROR-3, 10, AC-ASYNC-2)

| # | System | User sees | User does |
|---|---|---|---|
| 1 | Worker `bill-session`: PENDING `PER_GAME`, `due_date` = billing instant + 72 h (B2), sealed "Payment due" email in the same tx | Email "Payment due: Smash Club, Wed 7 Oct, $17.00, due Sat 10 Oct" | Taps "Pay now" |
| 2 | `proxy.ts` (signed out) → `/login?returnTo=%2Fpayments%2F<id>` → back | Sign-in page, then the payment page | Signs in |
| 3 | Web → API `GET /payments/:id` (payer-scoped) | `h1` "Payment to {Team}" · "{Location}, {Wed 7 Oct}, {7:00 pm}" · lines "You $17.00" / "Guest 1 $17.00" (positions, no guest names needed) · "Total $17.00 (includes GST of $2.22)" only for a GST-registered team · status "Due Sat 10 Oct, 7:12 pm" · button "Pay $17.00 with Akahu" · hint "You'll approve a bank transfer to {Team} with Akahu." | Taps the button |
| 4 | Server Action → API `POST /payments/:id/attempts {idempotencyKey}` → tx1 attempt row → Akahu create outside locks (payee = T's account **now**, B10) → tx2 | "Starting…" | Redirected to Akahu |
| 5 | Akahu / bank | Approve the transfer | Approves |
| 6 | Akahu → `/payments/:id?return=1`; the API re-reads the open attempt from Akahu on this read and applies the result | **Paid**: "Paid on Wed 7 Oct." (date of `paid_at`) + "Payment received" email. **Processing**: "Processing your payment. This usually takes under a minute." + Refresh, then the slow path "Your bank hasn't confirmed yet. We'll email you when it does." **Failed**: "Your payment didn't go through. You haven't been charged." + "Try again" (the pay button relabelled). **Cancelled**: "You cancelled the payment. You haven't been charged." + "Pay $17.00 with Akahu". **Held**: J7 | — |
| 7 | — | After Paid, if other unpaid charges remain anywhere: "You have {n} more unpaid payments." → `/payments` | — |

Rules:
- **Second tab, double tap, back button (AC-ERROR-10)**: while an attempt is READY the page shows "You started paying at 7:42 pm." + **"Continue with Akahu"** (the 409 `payment_in_progress` redirect). While AUTHORISED or SUBMITTED it shows the processing state with no button. A PAID payment shows "Paid on {date}." and the attempts route answers 409 `payment_settled`. The UI never offers a second live attempt.
- **Payer-only**: anyone else, signed in or not after sign-in, sees the not-found page "We couldn't find that payment." / "It may have been removed, or the link may be for a different account." with a "My teams" link. The second sentence helps a household member who opened the email while signed in as someone else, without confirming the payment exists.
- **Former or banned member**: the page works the same. The payment page is not membership-gated, and the email link is the way back in.
- **Team payouts failing**: the pay button is replaced by "This team can't receive payments right now. We've told the team admins." The status and due line stay.
- **Akahu unavailable**: the same banner as J1. The button stays and the next tap works.
- **Free-of-charge party (B7)**: a $0.00 PAID row appears in the list as "{Location}, {date} · $0.00 · No charge" and is never emailed.

#### J4: Overdue (AC-HAPPY-8, AC-HAPPY-9, AC-ENTRY-4)
1. Worker `daily-overdue` at 04:00 Pacific/Auckland: PENDING with `due_date <= now` → OVERDUE, and one "Overdue" email in the same tx (B6: once, at the transition).
2. Wallet page row: "Overdue since Sat 10 Oct" (text tag, listed first) · "Pay now". The team-page line suffix shows "· 1 payment overdue" (SHOULD).
3. At 3 or more overdue across all teams, the session page's registration panel shows the debt block with **"See your overdue payments"** → `/payments`.
4. `/payments`: `h1` "Unpaid payments". The list is grouped "Overdue" then "Due", each row "{Team} · {Location}, {Wed 7 Oct} · $17.00 · Overdue since Sat 10 Oct · Pay now". Held rows read "Checking with your bank" with no pay link. Empty: "You have no unpaid payments." Intro when blocked: "You can register again once you have fewer than 3 overdue payments."
5. Pay one (J3). OVERDUE → PAID. On the next load of the session page the panel shows the register form again if the count is now under 3 (AC-HAPPY-9). After paying, the payment page's "You have {n} more unpaid payments." link returns the player to the list, so clearing several debts is a loop of list → pay → back.

#### J5: Team admin sends a reminder (AC-ENTRY-3, AC-HAPPY-10, AC-ERROR-8)

| # | User sees | User does |
|---|---|---|
| 1 | Manage → area nav "Payments" → `h1` "Payments" · filter (radio group as links) "Unpaid" (default) / "Paid" / "All" | Picks the filter if needed |
| 2 | Table (cards at 360 px): Player · Session "Wed 7 Oct" · Amount · Status tag ("Due Sat 10 Oct" / "Overdue since Sat 10 Oct" / "Paid Sat 10 Oct" / "Paid from wallet" / "Checking with bank") · "Last reminder: {Thu 8 Oct, 9:15 am}" or "Not reminded" · "Send reminder" on PENDING and OVERDUE rows only | Taps "Send reminder" on Ana's row |
| 3 | `ConfirmDisclosure` opens inline under the row: "Email Ana a reminder for $17.00?" buttons "Send reminder" / "Cancel" | Confirms |
| 4 | Server Action → `POST .../reminders {changeKey}` → 202. Page reloads with the row "Reminder sent 9:15 am", focus on the row status (polite announcement) | — |

- **Cooldown (B6, one per payment per 24 h)**: within 24 h the button is replaced by "Reminder sent {Thu 8 Oct, 9:15 am}. You can send another after {Fri 9 Oct, 9:15 am}." so the UI never invites a 409. If a 409 `reminder_too_soon` still happens (another admin, two tabs), the row shows the same text after reload.
- **Settled meanwhile**: 409 `payment_settled` → reload. The row is now under "Paid", with the line "This payment was paid before your reminder was sent."
- **Held rows**: no reminder (the player may already have paid).
- **Payouts failing**: reminders are hidden for the whole team (the player couldn't pay anyway). The page shows the notice from J6.
- **Paid-from-wallet rows** appear under "Paid" and "All" only.
- **Never shown**: email addresses, bank details, Akahu ids, attempt history, payment links.

#### J5g: Global admin sends a reminder
- Reaches `/teams/[T]/manage/payments` by typed URL (no cross-team UI until admin-reporting-dashboard). **SHOULD**: the team page shows a "Manage payments" link to GLOBAL_ADMIN callers who are not team admins of T, so a global admin who searched for the team can get there.
- The area nav shows only the areas the caller can open. A GLOBAL_ADMIN who is not a team admin of T sees no area nav (Banking and GST does not allow global admins), plus a context line "You're viewing {Team} as a global admin." The UI/UX doc finalises this.
- The reminder flow is identical to J5. The reminder email does not say who sent it ("{Team} asked us to remind you").

#### J6: Payouts failing (A3 manual mark) and billing paused (B8) (AC-ERROR-4, AC-ERROR-5)

**Trigger (A3)**: no Akahu status means "destination account rejected", so a person decides. Ops learns outside the app (Akahu support, a bank notice, or a team admin saying the money isn't arriving).

| # | Actor | System | Sees | Does |
|---|---|---|---|---|
| 1 | GLOBAL_ADMIN | `/teams/[T]/manage/payments`, section **"Payout account (global admins only)"** | "Payments to this team are going through." · button "Mark payouts as failing" | Taps it |
| 2 | GLOBAL_ADMIN | `ConfirmDisclosure` with a required field "Reason (for the audit log, no account details)", max 500 chars | "Mark {Team}'s payouts as failing? New paid sessions can't be published, billing for ended sessions pauses, and players can't pay this team or top up until a team admin saves the bank account again. We'll email the {n} team admins." / "Mark as failing" / "Cancel" | Enters a reason, confirms |
| 3 | API (architecture designs the route; one transaction: `teams FOR NO KEY UPDATE`, set `payout_blocked_at` if null, audit row, one sealed email per approved admin) | Reload: "Marked as failing on {Thu 8 Oct, 9:20 am}. The team admins have been emailed." The button is gone (idempotent: marking again changes nothing) | — |
| 4 | Team admins | Email "Payments to {Team}'s bank account are failing" → Banking and GST page | Existing blocked notice "Payments to the account ending 1234 failed. Check the account number and save it again." | Re-saves (or corrects) the account |
| 5 | System | Saving banking clears `payout_blocked_at` (existing ADR 0016 behaviour) | Banking page "ready" state | — |
| 6 | Worker | The next 5-minute sweep bills every session held while blocked (B8), oldest first. Players get their normal deduction, low-credit and payment-due outcomes | Payments area notice disappears; new rows appear | — |

While blocked:
- **Team admins** see, at the top of the Payments area: "Payouts are failing, so billing is paused. Players aren't being charged for sessions that have ended, and they can't pay or top up. Fix the bank account in Banking and GST." (link). Each session that ends while blocked sends one "Billing is paused" email per admin (B8, per-session key).
- **Players** see on the payment page, the wallet page and `/payments` rows: "This team can't receive payments right now. We've told the team admins." No pay button, no top-up form. Their existing charges keep their due dates (see the conflict on overdue while blocked).
- **Publishing** a paid session answers 409 `payout_not_configured` with the existing session-form message.
- **No unmark action in v1.** A mistaken mark is undone by a team admin re-saving the banking details (one save, the omit-to-keep number). Ops asks the team admin to do it. Recorded as a trade-off. Architecture may add a GLOBAL_ADMIN "Clear" that calls the same clear path, but it is not required here.
- **An attempt already at Akahu** keeps its payee (fixed at create). If it reaches SENT it is applied normally. The block stops only new attempts and top-ups.

#### J7: Held payment or top-up (A2, FAILED/BANK_ERROR_INDETERMINATE)

The bank cannot say whether the money moved. Akahu will never report it again, so a person must check. The design goal is that the player does not pay twice and is not punished while we check.

| Actor | Where | Sees | Can do |
|---|---|---|---|
| Player | Payment page, `/payments` row, wallet page | "We're checking this payment with your bank. Please don't pay it again. We'll email you when it's sorted, usually within 2 working days." No pay button, no "You haven't been charged" | Nothing. Link "Questions? Ask your team admin." |
| Player | Wallet page (held top-up) | "We're checking your top-up of $30.00 with your bank. You can't start another top-up until this is sorted. We'll email you." The form is hidden (one open top-up per wallet also protects the cap) | Nothing |
| Player | Email (sent when the hold is applied) | "We're checking your payment to {Team}" (copy below) | — |
| Team admin | Payments area row | Status "Checking with bank" · line "The player's bank didn't confirm this payment. If $17.00 from Ana arrived in your account on or after Wed 7 Oct, tell us." No reminder | Tells ops (outside the app in v1) |
| Global admin | Payments area, section **"Payments being checked (global admins only)"**: one row per held payment or top-up (player, amount, started, Akahu payment id for support) | Two actions per row, each a `ConfirmDisclosure` with a required note: **"Money arrived: mark paid"** ("Mark Ana's $17.00 payment as paid? Only do this if the team or Akahu confirmed the money arrived.") and **"Money didn't arrive: let them pay again"** | Resolves |
| System | Resolution transaction (architecture/algorithm design the route) | Paid: payment PAID (or top-up credited once), "Payment received" email. Released: attempt closed, payment payable with its existing due date (see conflicts), "Your payment to {Team} didn't go through" email with the "We checked with your bank" line | — |

Held payments are never retried automatically, never offered "Try again", never reminded and (recommended) never moved to OVERDUE while held.

#### J8: Extra money received (B3: over-cap credit, duplicate SENT, SENT for a locally closed attempt)
- Nothing is silently clamped. The money is already in the team's account; v1 does not refund in the app.
- Player: email "We received an extra payment from you", plus on the payment or wallet page: "We received {amount} more than you owed. It's in {Team}'s bank account, and the team admins have been asked to refund you."
- Team admins: email "A payment to {Team} needs a refund", plus in the Payments area a row under a "Needs a refund" heading: "{Player} · {amount} · {reason: Paid twice for Wed 7 Oct / Top-up over the $100.00 wallet limit}". In v1 they mark it handled outside the app; a "Refunded" action is left to a later feature.

---

## Async Handling

### Operation lifecycle

| Operation | Initiation (sync) | Processing | Completion signal | Where the result lives |
|---|---|---|---|---|
| Post-game billing | `ends_at` passes (no user action) | 5-min sweep + `bill-session`; done within 10 min of `ends_at` | Email (due or low credit) within ~30 s of commit; none for a covered fee ≥ $20 left | Wallet page Payments + activity; payment page |
| Top-up | Tap "Top up with Akahu" → 303 to Akahu (~1-2 s) | Player at Akahu (seconds to minutes); SUBMITTED usually under a minute | Return page re-read; webhook; `akahu-reconcile` (one interval + age threshold); "Top-up received" email | `/teams/T/wallet?topUp=<id>` and the activity list |
| Pay a charge | Tap "Pay {amt} with Akahu" | Same | Return page; webhook; reconcile; "Payment received" email | `/payments/[id]`, wallet page, `/payments` |
| Overdue | 04:00 job | — | "Overdue" email | Row tag "Overdue since…"; debt block |
| Reminder | Admin confirms | Email job | Row "Reminder sent {time}" (sync); player email ~30 s | Payments area |
| Payout mark | Global admin confirms | Email jobs | Page notice (sync); admin emails ~30 s | Payments area, Banking page |
| Hold | Akahu reports INDETERMINATE | Human check (target 2 working days) | Resolution email | Payment/wallet page, Payments area |

### Progress communication
- **Method**: pull only. A server re-read on the return page (the fastest truth path), then `RefreshWhilePending` refreshes at about 2, 5 and 10 s, then the slow-path line and an email promise. No websockets, no polling beyond that.
- **Persistence**: every outcome is derived from stored state (payment status, latest attempt or top-up and its outcome), so it survives a refresh, a browser switch or a late return. The return parameters only pick which item to describe.
- **Promise kept**: "We'll email you when it does" is backed by the "Payment received" / "Top-up received" emails (sent on every SENT) and by the "didn't go through" email for any failure after the player authorised at their bank (spec addition, see conflicts).

---

## Distributed System Flow

### System boundaries
```
 Browser ──HTTPS──▶ Web (Next.js server components + Server Actions) ──HTTP──▶ API (Fastify)
    │                                                                       │   │
    │  303 to authorisation_url                       tx1 intent ──▶ PostgreSQL ◀── tx2 _id/url
    ▼                                                                       │
 Akahu hosted page ─▶ Bank (web/app) ─▶ redirect_uri back to Web            │ create / re-read / cancel
    ▲                                                                       ▼   (never under a lock)
    └──────────────────────────────────────────────────────────────────  Akahu API
 Akahu ──POST /webhooks/akahu (signed)──▶ API: verify, persist, enqueue, 2xx < 10 s
                                                │
 pg-boss worker: post-game-billing → bill-session; daily-overdue; akahu-reconcile; apply-akahu-result
                                                │ (re-read Akahu = truth; one shared apply function)
                                                ▼
                                   send-email (sealed payloads) ─▶ SMTP / Mailpit ─▶ inbox
```

### Responsibility matrix

| Step | Owner | State storage | Failure handling (user-visible) |
|---|---|---|---|
| Top-up form validation | Web + API (API is the check) | none until valid | Inline field error, value kept |
| Intent create (tx1) | API `wallet` | `wallet_top_ups` / `payment_attempts` | 409 open intent → "Continue with Akahu" |
| Akahu create | API `lib/akahu`, outside tx | Akahu | 503 → banner; intent closed; retry with a new key |
| Record `_id`/URL (tx2) | API | intent row | If tx2 fails after create: the reconcile/orphan job cancels the READY payment; the player sees the banner and retries |
| Authorisation | Akahu + bank | Akahu | Cancel/abandon → closed on TIMED_OUT or USER_CANCELLED |
| Return re-read | API on page read | intent + payment/wallet | Akahu down → stays processing; slow path |
| Webhook | API, then worker job | intent + payment/wallet | Bad signature 401, no change; key fetch fails 5xx (Akahu retries) |
| Reconcile | Worker | same | Stuck → `akahu.reconcile.stuck` warn (ops) |
| Billing | Worker `bill-session` | session, payments, ledger | Whole-session rollback; retry; B8 hold when blocked |
| Overdue | Worker `daily-overdue` | payments | Idempotent per day |
| Emails | `send-email` | pg-boss (sealed) | Retries; idempotency key from the cause |
| Reminder / payout mark / hold resolve | API `billing`, admin routes | payments / teams / audit | 409 cooldown/settled; idempotent replays |

---

## Error Handling

### Error states

| Error | When | User sees | Recovery |
|---|---|---|---|
| Top-up over headroom / invalid / under minimum | Submit | Field error ("You can top up at most $15.00.") | Edit and resubmit; value kept |
| Top-up already open | Submit, second tab | "You started a top-up of $30.00 at 7:42 pm." + "Continue with Akahu" | Continue, or wait for expiry |
| Pay attempt already open | Tap pay again | "You started paying at 7:42 pm." + "Continue with Akahu" | Continue |
| Already paid | Tap pay on a stale page | Reload → "Paid on {date}." | None needed |
| Akahu unavailable (timeout, 5xx, network) | Start top-up or pay | "We couldn't reach Akahu. Nothing has been charged. Try again in a few minutes." | Tap again later |
| API/web outage | Any page | Existing `OUTAGE_MESSAGE` | Retry |
| Player cancels at Akahu | Return | "You cancelled the payment. You haven't been charged." / "You cancelled the top-up…" | Pay / top up again |
| Bank declines (REJECTED, BANK_ERROR, INTERNAL_ERROR) | Return or later | "Your payment didn't go through. You haven't been charged." + "Try again"; email if it happens after the player authorised | Try again, possibly another bank |
| Indeterminate | Return or later | Hold copy (J7) | Wait; ops resolves |
| Team payouts failing | Any pay/top-up | "This team can't receive payments right now. We've told the team admins." | Team admin re-saves banking |
| Not the payer / unknown id | Open `/payments/[id]` | Not-found page | "My teams" |
| Not a member | Open wallet page | "You need to be a member of this team to use its wallet." | Join the team; pay charges via `/payments` |
| Reminder too soon / settled / other team / member caller | Admin action | Cooldown line / moved to Paid / not-found / `NoAccess` | None needed |
| Webhook forged/replayed | Server only | Nothing | — |

### Partial failure
- **Billing** is one transaction per session: either the whole session is completed and billed with its emails, or nothing is written and the job retries (AC-ERROR-9). Players never see a half-billed session.
- **Akahu create succeeded but our tx2 failed** (or the response timed out): the player never received the URL, so that Akahu payment cannot be paid. The intent is closed, the orphan is cancelled or left to expire, and the player sees the unavailable banner and retries (DR-005).
- **Money moved but we can't tell** (INDETERMINATE): hold (J7). **Money arrived twice or over the cap**: J8.

### Edge cases
- **A player in several teams** has separate wallets. Credit in team A never pays team B, and the wallet page says which team it is for in the heading context ("Smash Club").
- **A player who left the team** keeps unpaid charges payable through email links and `/payments`. Their wallet balance is not visible (refunds out of scope; noted for operations).
- **A late withdrawal charge** reads "Late withdrawal fee" on the payment page, the row and the email (AC-HAPPY-6).
- **Billing backlog at first deploy (B9)**: many "Payment due" emails at once, oldest first. The operations guide warns team admins beforehand. Each email names its session date, so players can tell them apart.
- **A long worker outage**: billing is late but correct. Due dates count from the billing instant (B2), so players never get less than 72 h to pay.

---

## Options Explored

### Option 1: Per-team hub only (the spec draft)
- **Orchestration**: Dashboard + Detail per team: team-page line → `/teams/[T]/wallet` → `/payments/[id]`; Payments manage area for admins. The debt block links to the current team's wallet page.
- **Wireframe** (360 px wallet page):
  ```
  ┌──────────────────────────────┐
  │ Smash Club                   │
  │ Wallet and payments          │
  │ Balance: $13.00              │
  │ You can top up to $87.00 more│
  │ Top-up amount (NZD) [_____]  │
  │ [ Top up with Akahu ]        │
  │ ── Payments ──               │
  │ Overdue                      │
  │ Highbury, Wed 7 Oct $17.00   │
  │ Overdue since Sat 10 Oct     │
  │ [ Pay now ]                  │
  │ Paid                         │
  │ Highbury, Wed 30 Sep $17.00  │
  │ Paid from wallet             │
  └──────────────────────────────┘
  ```
- **Pros**: smallest scope; matches how players think about one club; no overlap with player-dashboard.
- **Cons**: the debt block can point to a page with nothing overdue (debts elsewhere), which breaks trust at the moment the player is blocked; former or banned members can't find their debts in-app; three teams means three pages to clear a block.
- **Friction points**: AC-ENTRY-4 cannot honestly be met.

### Option 2: Per-team hub + payer-only payment page + one cross-team "Unpaid payments" list (CHOSEN)
- **Orchestration**: Option 1 plus `/payments`, a single unpaid list across teams, payer-scoped, linked from the debt block, the payment page after paying, and each wallet page ("All your unpaid payments").
- **Wireframe** (`/payments`, 360 px):
  ```
  ┌──────────────────────────────┐
  │ Unpaid payments              │
  │ You can register again once  │
  │ you have fewer than 3 overdue│
  │ ── Overdue ──                │
  │ Smash Club                   │
  │ Highbury, Wed 7 Oct · $17.00 │
  │ Overdue since Sat 10 Oct     │
  │ [ Pay now ]                  │
  │ Net Gains                    │
  │ Eden, Mon 5 Oct · $12.00     │
  │ Checking with your bank      │
  │ ── Due ──                    │
  │ ...                          │
  └──────────────────────────────┘
  ```
- **Pros**: the debt block always lands on the debts it counts; works for former and banned members; clearing a block is one loop; one small read route; becomes player-dashboard's Payments tab content or a redirect to it, so no throwaway work.
- **Cons**: one extra page and route beyond the spec; a slight overlap with player-dashboard (kept to unpaid only, no tabs, no balances).

### Option 3: A cross-team wallet hub now (`/wallet` listing every team's balance, top-up and payments)
- **Pros**: one place for everything money-related; best for players in many teams.
- **Cons**: this is player-dashboard's "Payments & Wallet" tab built early (scope creep into an L2 feature); top-ups still need per-team return URLs and per-team payee context, so the hub would still deep-link per team; more surface for the same ACs.

### Option 4: Pay without sign-in through bearer-token links in emails (pay-flow variant)
- **Pros**: the fewest taps from email to Akahu; no sign-in in an in-app browser.
- **Cons**: a capability in every email and URL (forwarded emails pay or reveal someone else's charge); conflicts with the payer-only 404 rule and the Q2 default; it still must not be an Akahu link (A5), so it only saves the sign-in. Sign-in friction is mitigated instead by `returnTo` and the long-lived session. Left to architecture Q2; this journey assumes the authenticated page.

## Evaluation Matrix

| Criterion | Opt 1 Per-team only | Opt 2 Per-team + unpaid list | Opt 3 Cross-team hub | Opt 4 Bearer links |
|---|---|---|---|---|
| Discoverability | M | H | H | H |
| Learnability | H | H | M | H |
| Efficiency | M | H | H | H |
| Error prevention | M | H | M | L |
| Error recovery | L (debt block dead end) | H | H | M |
| Consistency (with registration/banking patterns, player-dashboard split) | H | H | L | L |
| Accessibility | H | H | M | H |
| Scope fit (this feature vs later features) | H | M-H | L | M |

## Decision

**Chosen**: Option 2: per-team hub (team-page line, `/teams/[T]/wallet`), payer-only `/payments/[id]`, the Payments manage area with GLOBAL_ADMIN operations panels, plus a cross-team unpaid list at `/payments` as the debt-block target.

### Rationale
- The debt gate is cross-team, so its remedy page must be cross-team. That is the deciding point against Option 1.
- Keeping the wallet per team matches the data model (one wallet per player and team) and the top-up return. It also matches how players think ("my Smash Club credit").
- Every email lands on our own page, so a block, a banking change (B10) or an expired Akahu link never strands a player with a dead or wrong link (A5).
- The admin operations controls (A3 mark, A2 hold resolution) go on a page global admins can already open, behind role-gated sections, with no new admin console.

### Trade-offs accepted
- **An extra page and read route** (`/payments`, `GET /payments/me`). Kept minimal and handed to player-dashboard by the slot contract.
- **No "pay a due charge from wallet credit".** Mitigated by the explanatory line under the top-up form and in the payment-due email. A candidate enhancement for later.
- **No in-app unmark of a payout block.** A team admin re-save clears it.
- **Hold resolution needs a person** (target 2 working days). Mitigated by the "don't pay again" copy, no overdue while held (recommended) and a resolution email.
- **Sign-in on the way to paying.** Mitigated by `returnTo` preserving `?return=1` and the session lifetime.

---

## Email copy (proposed, plain text)

Shared rules: plain text like `registrations/emails.ts` and `team-banking/emails.ts`. Subject and body fold user text (team, location, names) onto one line. Dates use `formatNzDay` ("Wed 7 Oct") and times `formatNzTime`, in Pacific/Auckland. Amounts use `formatNZD`. Every link is `{WEB_BASE_URL}` + our path, **never an Akahu URL**. Emails with a payment link are sealed with FieldCrypto. No bank account name or digits, no other player's name (except in admin emails about that player), no email addresses. The idempotency key comes from the cause. Sign-off "Shared Game Management".

### 1. Payment due (template `payment-due`; key `payment-due:<paymentId>`)
**Subject**: `Payment due: {Team}, {Wed 7 Oct}, {$17.00}, due {Sat 10 Oct}`
```
Hi {first name},

Thanks for playing with {Team} at {Location} on {Wed 7 Oct}.
{one of:
  Your {Team} wallet ({$10.00}) didn't cover this game, so we haven't taken anything from it.
  This game wasn't paid from a wallet, because you don't have credit with {Team}.}
{for a late withdrawal instead of "Thanks for playing…":
  Late withdrawal fee for {Location} on {Wed 7 Oct}. You withdrew after the free cancellation deadline and nobody from the waitlist took your place.}

Amount: {$17.00}{ (you and 1 guest)}
Due by: {Sat 10 Oct, 7:12 pm}

Pay now (you'll sign in, then pay by bank transfer with Akahu):
{WEB}/payments/{paymentId}

Top up your {Team} wallet to have future games paid automatically:
{WEB}/teams/{teamId}/wallet

Shared Game Management
```

### 2. Low credit (template `low-credit`; key `low-credit:<deductionId>`)
**Subject**: `Your {Team} wallet is running low ({$18.00})`
```
Hi {first name},

We took {$17.00} from your {Team} wallet for {Location} on {Wed 7 Oct}. Your balance is now {$18.00}.

If your balance doesn't cover a game, we won't take anything from it. You'll get a payment link instead, due 3 days after the game.

Top up your wallet:
{WEB}/teams/{teamId}/wallet

Shared Game Management
```

### 3. Overdue (template `payment-overdue`; key `payment-overdue:<paymentId>`)
**Subject**: `Overdue: {Team}, {$17.00}`
```
Hi {first name},

Your payment of {$17.00} for {Location} on {Wed 7 Oct} was due by {Sat 10 Oct, 7:12 pm} and hasn't been paid.

Pay now:
{WEB}/payments/{paymentId}

Players with 3 or more overdue payments, across all their teams, can't register for new sessions until they pay.
{when the user now has 3 or more: You have {3} overdue payments, so you can't register for new sessions right now. See them all: {WEB}/payments}

Shared Game Management
```

### 4. Manual reminder (template `payment-reminder`; key `payment-reminder:<paymentId>:<changeKey>`)
**Subject**: `Reminder: {$17.00} for {Team}, {Wed 7 Oct}`
```
Hi {first name},

{Team} asked us to remind you about your payment of {$17.00} for {Location} on {Wed 7 Oct}.
{It's due by Sat 10 Oct, 7:12 pm. | It was due by Sat 10 Oct, 7:12 pm and is now overdue.}

Pay now:
{WEB}/payments/{paymentId}

If you paid in the last few minutes, you can ignore this email.

Shared Game Management
```

### 5. Payment received (template `payment-received`; keys `payment-received:<paymentId>` and `top-up-received:<topUpId>`)
**Subject (charge)**: `Payment received: {Team}, {$17.00}`
```
Hi {first name},

We received your payment of {$17.00} for {Location} on {Wed 7 Oct}. It was paid to {Team} by bank transfer on {Sat 10 Oct, 6:03 pm}.
{after a hold: We checked with your bank and your payment went through.}

View the payment:
{WEB}/payments/{paymentId}

Shared Game Management
```
**Subject (top-up variant)**: `Top-up received: {Team} wallet, {$30.00}`
```
Hi {first name},

Your top-up of {$30.00} to your {Team} wallet went through. Your balance is now {$30.00}.
Your wallet pays for your {Team} games automatically after each game.

View your wallet:
{WEB}/teams/{teamId}/wallet

Shared Game Management
```
(Not sent for a `PREPAID_CREDIT` deduction or a B7 $0.00 row.)

### 6. Payout blocked (admins; template `payout-blocked`; key `payout-blocked:<teamId>:<payout_blocked_at>:<adminId>`)
**Subject**: `Payments to {Team}'s bank account are failing`
```
Hi {admin first name},

Payments to {Team}'s bank account aren't going through.

Until this is fixed:
- new paid sessions can't be published,
- sessions that have ended aren't billed, so players aren't charged for them yet,
- players can't pay {Team} or top up their {Team} wallets.

Check the bank account name and number and save them again:
{WEB}/teams/{teamId}/manage/banking

Saving the bank details lifts the block. Sessions that ended in the meantime are billed automatically within about 10 minutes.

Shared Game Management
```

### 7. Billing paused (admins; template `billing-paused`; key `billing-paused:<sessionId>:<adminId>`)
**Subject**: `Billing is paused: {Team}, {Wed 7 Oct}`
```
Hi {admin first name},

The session at {Location} on {Wed 7 Oct} has ended, but we can't bill it because payments to {Team}'s bank account are failing. Nobody has been charged for it yet.

Fix the bank account:
{WEB}/teams/{teamId}/manage/banking

After you save it, this session is billed automatically within about 10 minutes.

Shared Game Management
```

### Additional notices this journey needs (flagged for reconciliation; see conflicts)
**8. Payment not completed** (template `payment-not-completed`; sent only for a failure **after the player authorised** at their bank (AUTHORISED or SUBMITTED reached), or when ops releases a hold; never for an abandoned READY attempt; key `payment-not-completed:<attemptId>`)
Subject: `Your payment to {Team} didn't go through` (top-up: `Your top-up to your {Team} wallet didn't go through`)
```
Hi {first name},

Your bank didn't complete your payment of {$17.00} for {Location} on {Wed 7 Oct}. You haven't been charged.
{after a hold: We checked with your bank: the payment didn't go through.}
The payment is still due by {Sat 10 Oct, 7:12 pm}.

Try again:
{WEB}/payments/{paymentId}

Shared Game Management
```
**9. Payment being checked** (template `payment-held`; key `payment-held:<attemptId>`)
Subject: `We're checking your payment to {Team}`
```
Hi {first name},

Your bank couldn't confirm whether your payment of {$17.00} for {Location} on {Wed 7 Oct} went through.

Please don't pay it again. We're checking with the bank and will email you when it's sorted, usually within 2 working days. This payment won't become overdue while we check.

See the payment:
{WEB}/payments/{paymentId}

Shared Game Management
```
**10. Extra payment (B3)**: player: `We received an extra payment from you` ("We received {$17.00} more than you owed for {what}. The money is in {Team}'s bank account, and we've asked the team admins to refund you."). Admins: `A payment to {Team} needs a refund` ("{Player full name} paid {$17.00} that we couldn't use: {paid twice for Wed 7 Oct | a top-up over the $100.00 wallet limit}. The money is in {Team}'s bank account. Please refund it to them directly. We haven't added it to their wallet. See: {WEB}/teams/{teamId}/manage/payments").

---

## Implementation Guidelines

### Frontend Requirements
1. `apps/web/src/app/teams/[teamId]/page.tsx`: wallet line for APPROVED members; SHOULD debt suffix; SHOULD "Manage payments" for a non-admin GLOBAL_ADMIN.
2. `/teams/[teamId]/wallet`: wallet section (balance, headroom, form or full/open/held/blocked replacement), activity list (newest first, `nextCursor` "Show more"), Payments grouped Overdue / Due / Paid, link "All your unpaid payments" → `/payments`. Return state from `?topUp=`.
3. `/payments/[paymentId]`: state machine above. `RefreshWhilePending` for processing. Not-found for 404.
4. `/payments`: `UnpaidPaymentsList` (reusable by player-dashboard).
5. `/teams/[teamId]/manage/payments`: filter, table/cards, `ConfirmDisclosure` reminder, blocked notice, GLOBAL_ADMIN-only "Payout account" and "Payments being checked" sections, "Needs a refund" list.
6. `registration-panel` debt block: link "See your overdue payments" → `/payments`.
7. `lib/billing/labels.ts`: all copy above. `lib/billing/wallet-view.ts` / payment view: pure state → view functions, table-tested. Server Actions redirect (303) to Akahu only with the API-returned `redirectUrl`, never one built from user input.

### Backend Requirements
1. The spec routes plus `GET /payments/me?status=UNPAID` (cross-team, payer-scoped).
2. The read routes for an open intent re-read Akahu (outside locks) and apply via the shared function, so the return page is the fast path.
3. The attempt and top-up routes refuse with 409 `payout_not_configured` when the team is blocked; attempts also refuse while the payment is held (409 `payment_held`, new code).
4. `GET /payments/:id` and the wallet read expose the latest attempt or top-up **outcome kind** (`processing | cancelled | failed | held | none`), not raw Akahu statuses.
5. A GLOBAL_ADMIN mark-payouts-failing route (A3) and a resolve-hold route (A2), both audited with a required note, both idempotent.
6. Payments list rows expose `held` and the "needs refund" records (B3).

### Integration Points

| System | Interface | Data exchanged |
|---|---|---|
| Akahu | REST create / re-read / cancel; signed webhook | amount, payee (decrypted per call), `redirect_uri`, `_id`, `authorisation_url`, status, `status_reason` |
| Registrations | `countOverdueByUser` (read); debt block link | overdue count |
| Team banking | `payout_blocked_at`, `is_payout_configured`, banking save clears the block | block flag |
| Notifier / `send-email` | sealed jobs | the ten templates |
| player-dashboard (later) | read models, `/payments` slot | rows |

---

## Acceptance Criteria (MANDATORY)

These journey criteria refine the spec ACs (cited). Spec ACs remain the contract. These add the journey-specific behaviour decided here.

### JAC-ENTRY-1: The debt block leads to every overdue payment, across teams
**Priority**: SHOULD (spec AC-ENTRY-4)
**Given** a member with 2 OVERDUE payments in team A and 1 in team B (a team they were later banned from)
**When** they open a session page of team A and follow "See your overdue payments"
**Then** `/payments` lists all three under "Overdue", each with its team name and "Pay now", from `GET /payments/me?status=UNPAID`
**Verification**:
- [ ] E2E: link present in the debt block, lands on `/payments`
- [ ] Integration: the route returns cross-team rows for the caller only, including a team where the caller is BANNED
- [ ] E2E: anonymous → `/login?returnTo=%2Fpayments`

### JAC-HAPPY-1: Email to paid, through sign-in and Akahu
**Priority**: MUST (spec AC-HAPPY-3, AC-HAPPY-4, AC-ENTRY-2)
**Given** B's PENDING $17.00 payment and the fake adapter
**When** B (signed out) follows "Pay now" in the Mailpit email, signs in, taps "Pay $17.00 with Akahu", completes the fake Akahu step and returns to `/payments/[id]?return=1`
**Then** the page shows "Paid on {date}." (or the processing state, then that), a "Payment received" email arrives, and the email contained no Akahu URL
**Verification**:
- [ ] E2E: full flow on desktop and 360 px
- [ ] Integration: email body has only `{WEB}` links; the job payload is sealed
- [ ] E2E: success state rendered

### JAC-HAPPY-2: Top-up round trip with the return state derived from storage
**Priority**: MUST (spec AC-HAPPY-1, AC-ASYNC-2)
**Given** member A with $0.00
**When** A tops up $30.00 and returns to `/teams/T/wallet?topUp=<id>`, then reloads, then opens the page without the parameter
**Then** the result ("Top-up received. Balance: $30.00" or processing, then credited) is the same on every load, and a forged `?topUp=<other id>` shows the normal page with no result line
**Verification**:
- [ ] E2E: return, reload, forged id

### JAC-ERROR-1: An open attempt is continued, never duplicated
**Priority**: MUST (spec AC-ERROR-2, AC-ERROR-10)
**Given** a READY attempt (or top-up) opened in tab 1
**When** the player taps pay (or top up) in tab 2
**Then** tab 2 shows "You started paying at {time}." with "Continue with Akahu", which goes to the same Akahu payment; the fake adapter recorded one create
**Verification**:
- [ ] Integration: one create call; 409 carries the existing redirect
- [ ] E2E: "Continue with Akahu" rendered

### JAC-ERROR-2: Failure and cancellation copy is truthful; indeterminate is held
**Priority**: MUST (spec AC-ERROR-3, A2)
**Given** fake outcomes USER_CANCELLED, FAILED/REJECTED and FAILED/BANK_ERROR_INDETERMINATE
**When** the player returns
**Then** they see respectively "You cancelled the payment. You haven't been charged." with a pay button; "Your payment didn't go through. You haven't been charged." with "Try again"; and "We're checking this payment with your bank. Please don't pay it again…" with **no** pay button and **no** "haven't been charged"; the held case enqueues `payment-held` once and the attempts route answers 409 `payment_held`
**Verification**:
- [ ] Unit: view function table over outcome kinds
- [ ] Integration: held refusal; one email
- [ ] E2E: three states rendered

### JAC-ERROR-3: Akahu unavailable keeps the player's input
**Priority**: MUST (spec AC-ERROR-7)
**Given** the fake adapter failing
**When** the player submits a $30.00 top-up
**Then** the banner "We couldn't reach Akahu. Nothing has been charged. Try again in a few minutes." shows, the field still reads 30.00, and a second submit after recovery succeeds
**Verification**:
- [ ] E2E with an injected failure; retry works

### JAC-ASYNC-1: The player is told the outcome after leaving
**Priority**: MUST (spec AC-ASYNC-2, AC-ASYNC-4)
**Given** a player who authorised and closed the browser
**When** the webhook (or reconcile) applies SENT, or a failure after authorisation
**Then** one "Payment received" / "Top-up received" email, or one "didn't go through" email, is enqueued in the applying transaction with the cause key; an abandoned READY attempt that times out sends nothing
**Verification**:
- [ ] Integration: email per outcome; none for abandoned READY; replay sends nothing

### JAC-ADMIN-1: Reminder controls never invite a refusal
**Priority**: MUST (spec AC-HAPPY-10, AC-ERROR-8)
**Given** an OVERDUE payment reminded 1 hour ago and a held payment
**When** a team admin opens Payments
**Then** the first row shows "Reminder sent {time}. You can send another after {time}." and no button; the held row shows "Checking with bank" and no button
**Verification**:
- [ ] Unit: row view table
- [ ] E2E: reminder → "Reminder sent {time}"

### JAC-ADMIN-2: Payouts marked failing stop paying, top-ups and reminders, and admins are told
**Priority**: MUST (spec AC-ERROR-4 as amended by A3, AC-ERROR-5)
**Given** team T with an unpaid payment and an ended unbilled session
**When** a GLOBAL_ADMIN marks payouts as failing with a reason
**Then** each approved admin gets one "Payments to {Team}'s bank account are failing" email (no account details); the payment page and wallet page show "This team can't receive payments right now. We've told the team admins." with no pay or top-up control; the Payments area shows the paused notice and hides reminders; the next sweep sends one "Billing is paused" email per admin for the session; after a team admin re-saves banking, the session is billed by the next sweep
**Verification**:
- [ ] Integration: one transaction, idempotent re-mark, audit row with the reason, emails
- [ ] E2E: player and admin views; a TEAM_ADMIN cannot see the mark control

### JAC-NAV-1: Return after a browser switch or expired session
**Priority**: SHOULD
**Given** a player returning from Akahu signed out
**When** `/payments/[id]?return=1` loads
**Then** they go to `/login?returnTo=%2Fpayments%2F<id>%3Freturn%3D1` and back to the processing or paid state
**Verification**:
- [ ] E2E: cleared cookies before return

### JAC-INTEGRATION-1: Emails carry real, input-specific content
**Priority**: MUST
**Given** two billed sessions with different teams, locations, dates and amounts (one a late withdrawal)
**When** the payment-due emails are rendered
**Then** each subject and body carries its own team, location, date, amount and due instant; the late withdrawal reads "Late withdrawal fee"; no placeholder text; no Akahu host; links are `/payments/<that id>`
**Anti-stub verification**:
- [ ] Different input → different output
- [ ] No "TODO", "sample", "{" left in rendered text

## Test Scenarios (derived)
- Happy: JAC-HAPPY-1, JAC-HAPPY-2, J2 (deduction row and activity line), JAC-ENTRY-1, JAC-ASYNC-1.
- Errors: JAC-ERROR-1, 2, 3, JAC-ADMIN-1, JAC-ADMIN-2.
- Edge: JAC-NAV-1, former member pays via email link, B7 "No charge" row, full wallet, over-headroom field error.

## Accessibility Checklist
- [ ] Every step keyboard-operable; the Akahu redirect is a form submit, not a script-only action.
- [ ] Processing and result lines are in a `role="status"` polite region; `RefreshWhilePending` never moves focus.
- [ ] Field errors linked by `aria-describedby` and announced; value kept.
- [ ] Status tags are text ("Overdue since…", "Paid from wallet", "Checking with bank"), never colour alone.
- [ ] `ConfirmDisclosure` for reminder, mark-failing and hold resolution; focus moves into the disclosure and back to the row after.
- [ ] 44 px targets, no horizontal scroll at 360 px (table becomes cards).
- [ ] No time limit on our pages. Akahu's link expiry is explained by "Continue with Akahu" turning back into "Pay" after it lapses, with nothing lost.

## Analytics & Observability

| Metric (from logs; no exporter yet) | Purpose | Target |
|---|---|---|
| Top-up completion: `wallet.topup.started` → `credited` | Funnel health | > 85% |
| Link payment within due: `payment-due` → PAID before `due_date` | Pay flow health | > 80% |
| Overdue rate: OVERDUE / PER_GAME | Product KPI ("few overdue payments") | < 10% |
| Return-page resolution: share of SENT first applied by the return re-read | Fast-path health | > 70% |
| Holds open > 2 working days | Ops SLA | 0 |
| `akahu.reconcile.stuck` | Integration health | 0 |

Instrumentation points: the plan's `billing.*`, `wallet.*`, `akahu.*` events, plus `billing.payout.marked` (actor id, team id; the reason stays in the audit row, not the log), `billing.hold.applied` / `billing.hold.resolved` (outcome), `billing.unpaid_list.viewed` (count only). Never amounts tied to emails, never links.

## Validation Checklist
- [x] Journey delivers stated value (pay once, into the right account, minimal effort)
- [x] All personas can complete their journeys (player, former member, team admin, global admin)
- [x] Errors are recoverable, and the indeterminate case is safe
- [x] Async states are clear and persistent, and every "we'll email you" promise has an email
- [x] Consistent with registration and banking patterns (PRG, notices, `ConfirmDisclosure`, `RefreshWhilePending`)
- [x] Accessible per AC-VERIFY-9
- [x] Testable (JAC list maps to spec ACs)

## Spec conflicts and additions (for the Creative Reconciliation)
1. **AC-ENTRY-4 target needs a cross-team route.** Add `/payments` and `GET /payments/me?status=UNPAID` (authenticated, caller-scoped, no team guard); `proxy.ts` protects `/payments`.
2. **Overdue while held or blocked.** AC-HAPPY-8 flips every PENDING past `due_date`. A held payment may already be paid, and a blocked team cannot be paid, yet both would count toward the cross-team debt gate. Recommendation: `daily-overdue` skips payments that are held or whose team has `payout_blocked_at` set. A payment released from a hold or unblocked keeps its due date, so if it is already past due it flips at the next 04:00 run. The algorithm doc decides whether to grant a grace period. It needs a ruling, because it narrows AC-HAPPY-8.
3. **"We'll email you when it does" (AC-ASYNC-2) has no email for top-ups or failures.** Add the top-up variant of "Payment received" and the "Payment not completed" notice (only after authorisation). Otherwise change the slow-path copy. The seven-email list grows to ten templates once J7 and B3 are included (`payment-held`, `extra-payment` player and admin).
4. **Processing copy mismatch.** The Success Criteria say "Processing your top-up…" and AC-ASYNC-2 says "Processing your payment…". This doc uses "top-up" on the wallet page and "payment" on the payment page.
5. **A2 hold has no resolution route or surface in the spec.** This doc proposes GLOBAL_ADMIN "Money arrived: mark paid" / "Money didn't arrive: let them pay again" in the Payments area, audited, with emails. Architecture designs the route. A new error code `payment_held` is needed for the attempts route.
6. **A3 manual mark placement.** It sits in the Payments area (the global admin cannot open Banking and GST), with a required audit reason. There is no unmark (a team admin re-save clears the block).
7. **Block scope beyond publishing.** The spec's player copy implies paying is stopped. This doc also stops new top-ups and pay attempts (409 `payout_not_configured`) and hides reminders. Top-ups create no `payments` row, so C-BIL-PAY does not cover them today. Architecture should extend the check to both intent routes.
8. **B3 notifications** are required by ruling B3 but not among the seven emails. Drafted as notice 10.
9. **Manage area nav for a non-admin GLOBAL_ADMIN.** Show only openable areas (none besides Payments) and a "viewing as a global admin" line. The UI/UX doc confirms this.
10. **No "pay a due charge from the wallet".** In scope as the spec says. The journey adds explanatory copy, and it is a candidate for a later enhancement.
11. **Read model needs an outcome kind** for the latest attempt or top-up (`processing | cancelled | failed | held`), beyond the spec's `attempt: { status, startedAt }`.
12. **Attempt expiry**: this doc recommends a 30-minute `expires_at` for attempts and top-ups, so abandoned ones release quickly. Architecture fixes the value.

---

NEW_TERMS_INTRODUCED:
- **Unpaid payments page** (`/payments`): payer-scoped, cross-team list of the caller's PENDING, OVERDUE and held payments; the debt-block link target; handed to player-dashboard by slot contract.
- **Held (payment or top-up)** / UI tag **"Checking with bank"**: the A2 BANK_ERROR_INDETERMINATE state as users see it; not payable, not reminded, not retried, resolved by a GLOBAL_ADMIN.
- **Hold resolution**: the GLOBAL_ADMIN action with two outcomes, "Money arrived: mark paid" and "Money didn't arrive: let them pay again".
- **Mark payouts as failing**: the GLOBAL_ADMIN action that triggers the ADR 0016 R3 transaction (A3).
- **Outcome kind**: the read-model summary of the latest attempt or top-up (`processing | cancelled | failed | held | none`).
- **Payment not completed notice**: an email sent only when a failure follows the player's authorisation at their bank, or when a hold is released.
- **Needs a refund** list: B3 records shown to team admins in the Payments area.
- Error code **`payment_held`** (409 on `POST /payments/:id/attempts`).
