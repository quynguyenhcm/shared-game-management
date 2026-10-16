# User Journey Design: Registration and Waitlist

**Created**: 2026-10-16
**Status**: DECIDED
**Decision Type**: User Journey
**Task**: `registration-and-waitlist` (Level 4). Spec: `memory-bank/tasks/registration-and-waitlist.md` (approved 2026-10-14), branch `feature/registration-and-waitlist`.
**Answers**: Creative Q5 (invocation surface, journey side) and the user-facing consequences of Q1 (a waitlisted group that doesn't fit) and Q3 (fees at and after the deadline).
**Parallel inputs (not decided here)**: the Algorithm doc (promotion rule, fee semantics; this doc assumes the spec defaults: first-fit, liability decided once at withdrawal, promote after the deadline), the Architecture doc (locks, jobs, endpoint shapes) and the UI/UX doc (layout, components, final control-level copy). Every copy string here is **proposed**; the UI/UX doc finalises it. Every dependency is listed in [Dependencies on the parallel creative docs](#dependencies-on-the-parallel-creative-docs).
**Basis**: `main` after team-management (PR #4). Web conventions reused from `team-management-teams-user-journey.md` and `auth-and-user-roles-user-journey.md`: one task per URL; Server Actions with in-place `FormState` errors and `redirect(..., RedirectType.replace)` on success; codes-only `?notice=` with text from a copy deck in `lib/<feature>/labels.ts`, stripped after render; `requireUser(returnTo)` plus `proxy.ts` sign-in redirect and `no-store`; `FormBanner` focused once; the outage line `OUTAGE_MESSAGE`; the reload-or-keep rule (state known to have changed: reload; outcome unknown: change nothing, keep input); `InlineConfirm` disclosures, never native dialogs; pull-only status (no polling). `memory-bank/ux-patterns.md` does not exist yet.

---

## Journey Overview

**Feature**: An approved member finds an upcoming session of their team, registers alone or with up to two guests, and is either confirmed or put on the waitlist as a whole group. Waitlisted groups are moved in automatically when places free up and are emailed. Players withdraw (free before the deadline; after it, free only if the waitlist refills the place) or leave the waitlist (always free), and can register again. Three or more overdue payments block new registrations. A team admin's ban cancels the member's upcoming registrations in the background.
**Primary Persona**: Player (`PLAYER`, APPROVED member of the team), usually on a phone, often the night before or the day of the game.
**Journey Type**: Hybrid. Register, withdraw and leave-waitlist are synchronous (one transaction, result on the next page render). Being moved off the waitlist is synchronous for the system but asynchronous for the promoted player (email within ~30 s, or the next page load). Ban cancellation is asynchronous (job within ~30 s; daily sweep as backstop).
**Orchestration Pattern**: **Dashboard + Detail**: an "Upcoming sessions" list on the team page leads to a **status-driven session page** whose registration panel is a single screen with **progressive disclosure** (guest fieldsets appear on demand) and **inline confirmation** for withdrawals. Post/redirect/get with a one-shot notice code after every action. Promotion uses **Notification + Action** (email that deep-links to the same page).

### Success Statement
> A player taps "My teams", their club, then "Wed 28 Oct, 7:00 pm", keeps "Just me", taps "Register" and reads "You're in." in under 30 seconds; when a session is full they tap "Join waitlist", are told they'll be moved in automatically, and later get an email "You're in: Smash Club, Wed 28 Oct" that opens the same page showing "You're in."

---

## Persona Context

### Primary User
- **Who**: Player (`PLAYER`, productBrief Key Personas; success metric "Registration completed in under 30s").
- **Goal**: Secure a place for themselves and maybe a partner or a friend, without missing out on full sessions, and without surprise fees.
- **Context**: Phone (360 px), often inside a messaging app after the organiser posts "sessions are up". Checks again the day before. Plans change late (traffic, injury), so withdrawing near the start is common.
- **Proficiency**: Casual. Knows "waitlist" from restaurants and airlines; does not know the club's cancellation rule; reads one line, not paragraphs. Will feel cheated by any fee they did not see coming.

### Secondary Users
- **Waitlisted player**: has no control over when they are moved in. Their consent to "you'll be moved in automatically and the fee applies" must be given at the moment they join the waitlist, because the move can happen after the free cancellation deadline (Q3c).
- **Passed-over waitlisted group** (head of queue, group of 3, only 1 place free): sees free places but stays waiting while a smaller group behind them is moved in (first-fit, Q1). Needs an honest explanation, not silence.
- **Late withdrawer**: needs to know, before confirming, whether they'll be charged, and after confirming, what actually happened.
- **Team Admin** (`TEAM_ADMIN`): registers like any member (same panel). Bans a member from the manage page; the restored confirmation tells them the member's upcoming registrations will be cancelled. Never sees a "cancelling..." progress state.
- **Banned member**: gets no email. Next visit to a session page or the team page shows the no-access state.
- **Later features**: session-scheduling-engine (admin session surfaces; calls `promoteWaitlist` on capacity raises, which sends the same promotion email), player-dashboard ("Currently Opening" links to the same session page), wallet-and-akahu-billing (the debt-block message points at its payment links).

---

## Journey Map

### Page ownership decision (Q5)

| Surface | Owner | Why |
|---|---|---|
| `/teams/[teamId]/sessions/[sessionId]` (player session page: summary + registration panel) | **registration-and-waitlist** (unconditionally) | Every player-facing action on a session is a registration action. session-scheduling-engine has no plan and its roadmap scope is admin-facing (setup, costing, recurrence). Making ownership conditional ("if SSE ships none") leaves two features each assuming the other builds it. |
| "Upcoming sessions" section on `/teams/[teamId]` (APPROVED members only) | **registration-and-waitlist** | Without it the session page is reachable only from the promotion email or a typed URL, and AC-ENTRY-1 is untestable through the UI. Its rows carry registration data (places left, your status), so it is a registration read model, and player-dashboard's "Currently Opening" later reuses the same read model across teams. |
| Admin session surfaces (create, edit, publish, cancel, capacity) under `/teams/[teamId]/manage/sessions` | session-scheduling-engine | Fits the team-management manage-area registry (`lib/teams/manage-areas.ts`): a second area makes the area nav appear automatically. |
| "Currently Opening" (cross-team) | player-dashboard | Links to the same session page; adds no registration controls of its own beyond a link. |

**Slot contract for session-scheduling-engine** (to record in ADR 0016 and in SSE's plan):
1. The session page is composed of two independent server components: `SessionSummary` (heading, date and time range, location, address, team link) and `RegistrationPanel` (places, fee, deadline, the caller's state, the form and actions). Each takes only `{ teamId, sessionId }` and fetches its own data (`RegistrationPanel` from `GET .../registration`).
2. SSE may replace `SessionSummary` or add sections **after** `RegistrationPanel` (for example admin-only "Edit session" links), but the panel stays the first section after the summary and keeps its own `?notice=` codes.
3. SSE must not add a second register or withdraw control anywhere. The panel is the only place a registration changes in the UI.

### Entry Points

| Entry | Context | User intent |
|---|---|---|
| Team page `/teams/[teamId]`, section "Upcoming sessions" (new) | Header "My teams" → team row → team page | "What's on, and is there room?" |
| Promotion email link `{WEB_BASE_URL}/teams/[T]/sessions/[S]` | Email after being moved off the waitlist | "Confirm I'm in, check the time" |
| Shared session link | Organiser pastes a session URL in the group chat | "Register for this one" |
| Signed-out visit to any of the above | Bookmark, chat link | Same, sign-in first: `proxy.ts` → `/login?returnTo=/teams/[T]/sessions/[S]` → back |
| Later: player-dashboard "Currently Opening" | Dashboard | Same page |
| Manage page "Ban" (admin) | `/teams/[T]/manage`, member row | "Remove this person" |

### Page and route inventory (additions)

| URL | Kind | Who sees it | Purpose |
|---|---|---|---|
| `/teams/[teamId]` | existing page, new section | "Upcoming sessions" only for APPROVED callers (MEMBER, TEAM_ADMIN) | List of the next 10 PUBLISHED sessions that have not started, each linking to its page |
| `/teams/[teamId]/sessions/[sessionId]` | new protected page (`no-store`) | APPROVED members of T; everyone else gets the no-access or not-found state | Session summary and the registration panel |

`?notice=` codes for the session page (closed list, text in `lib/registrations/labels.ts`, stripped after render): `registered`, `registered_waitlisted_instead`, `waitlisted`, `waitlisted_confirmed_instead`, `withdrawn_free`, `withdrawn_replaced`, `withdrawn_charged`, `left_waitlist`. No `error` codes travel in URLs.

### Team page: "Upcoming sessions" section

Rendered under the member/admin status line, only when `myStatus = APPROVED`.

| Element | Content (proposed) |
|---|---|
| Heading | `h2` "Upcoming sessions" |
| Row (link, whole row tappable, 44 px) | "Wed 28 Oct, 7:00 pm · Highbury Courts" |
| Row second line | places line, same grammar as the panel: "3 of 10 places left" / "Full · 2 on the waitlist" / "1 of 10 places left · 2 on the waitlist" |
| Row status tag (text, not colour) | "You're in" / "Waitlist #2" / none |
| Footer when more than 10 | "Showing the next 10 sessions." (no paging in v1) |
| Empty | "No sessions are open for registration right now." |
| Load failure of the section only | "We can't load sessions right now. Try again in a minute." (the rest of the team page still renders) |

Sessions that have started, DRAFT, COMPLETED and CANCELLED sessions are not listed.

### Status-driven session page (`/teams/[teamId]/sessions/[sessionId]`)

`requireUser(here)`, then `GET /teams/:T/sessions/:S/registration`. The page renders `SessionSummary` and, below it, `RegistrationPanel` in exactly one of these states (first matching row wins):

| # | Condition | Status line (role `status` region) | Body | Actions |
|---|---|---|---|---|
| P1 | 404 (unknown id, DRAFT, other team's session) | page heading "We couldn't find that session." | "It may have been removed, or the link may be wrong." | Links "Back to {team}" when the team is visible, "My teams" |
| P2 | 403 (non-member, PENDING, REJECTED, BANNED) | "You need to be a member of this team to register." | none | Link "Go to My teams" |
| P3 | `status = CANCELLED` | "This session has been cancelled." | none | none |
| P4 | `now >= starts_at` or `COMPLETED` | "Registration is closed." | caller's final state if any ("You were registered.", "You were on the waitlist.", withdrawn fee line) | none |
| P5 | active CONFIRMED | "You're in." | party line ("You + 2 guests: Ana, Guest 2"), "You were moved off the waitlist on {date, time}." if `promotedAt`, deadline line, change-guests hint | "Withdraw" (InlineConfirm) |
| P6 | active WAITLISTED | "You're on the waitlist (#{rank}). We'll email you if a place opens up." | party line; auto-move consent line; passed-over line when places are free but too few (see J4); after-deadline line | "Leave waitlist" (InlineConfirm) |
| P7 | `overdueCount >= 3`, no active registration | "You have {n} overdue payments across your teams. Pay them before registering for more sessions." | "Your payment links are in the reminder emails we sent you." (until player-dashboard ships "Payments & Wallet", then a link) | none |
| P8 | public capacity 0 | "This session has no public places." | none | none |
| P9 | WITHDRAWN, session open | withdrawn line by kind (see below) | the register form again | form |
| P10 | no registration, session open | none | places, fee, deadline lines, register form | "Register" / "Join waitlist" |

Withdrawn line (P9, P4), derived from the persisted `withdrawalKind` and `withdrawalFeeDue`:
- EARLY, or leaving the waitlist: "You withdrew from this session. You won't be charged." / "You left the waitlist."
- LATE, `feeDue = false`: "You withdrew from this session. A player from the waitlist took your place, so you won't be charged."
- LATE, `feeDue = true`: "You withdrew from this session. The {fee} fee will be charged after the game."
- BANNED: never rendered (the caller is 403).

Never shown on this page: other players' names, who took a place, guest names of anyone else, raw `queue_position`, the ban reason.

### State diagram (one player's registration for one session)

```
[Team page: Upcoming sessions] --tap row--> [Session page]
                                                 |
        +----------------------+-----------------+------------------+-------------------+
        |                      |                 |                  |                   |
   [P1 not found]       [P2 no access]    [P3/P4 closed]    [P7 debt block]    [P10 open: form]
                                                                                        |
                                    +-------------------- Register / Join waitlist -----+
                                    |                                                   |
                       party fits free places                               party doesn't fit
                       (server decides)                                     (server decides)
                                    v                                                   v
                              [P5 CONFIRMED] <---- moved in (async to user) ---- [P6 WAITLISTED]
                                    |              withdrawal / ban / capacity          |
                 Withdraw (confirm) |                                                   | Leave waitlist (confirm)
        +---------------+-----------+--------------+                                    |
        |               |                          |                                    |
   now <= deadline   now > deadline,          now > deadline,                           |
   (EARLY, free)     waitlist refills         nobody fits                               |
        |            (LATE, free)             (LATE, fee due)                           |
        v               v                          v                                    v
                           [P9 WITHDRAWN + form] <-------------------------------------+
                                    |
                                    +-- Register again --> CONFIRMED / WAITLISTED (fee-due rule: see A11)

Any state --starts_at passes--> [P4 read-only]      Ban (admin) --job <=30 s--> registration WITHDRAWN (BANNED), page [P2]
```

### Flow J1: First-time registrant, alone (AC-ENTRY-1, AC-HAPPY-1)

```
My teams → team row → team page "Upcoming sessions" → "Wed 28 Oct, 7:00 pm · Highbury Courts" (3 of 10 places left)
  → session page P10: places "3 of 10 places left", fee "Fee: $17.00 per person, charged after the game",
    deadline "Free cancellation until Mon 26 Oct, 7:00 pm", "Bringing guests?" = "Just me", "Total: $17.00", [Register]
  → Server Action → POST .../registrations {guests: []} → 201 CONFIRMED
  → redirect(here?notice=registered, replace) → notice "You're in." (focused) → panel P5, places "2 of 10 places left"
```
Taps from "My teams": 4 (team, session, Register). No confirmation step for registering: it is reversible for free until the deadline, and the deadline line is on screen before the tap.

### Flow J2: Registrant with guests (AC-HAPPY-2, AC-ERROR-4, AC-ERROR-5)

```
P10 → choose "Me + 2 guests" → fieldsets "Guest 1" and "Guest 2" appear, focus moves to "Guest 1" legend
  → each: Sex (none preselected), Skill level (none preselected), "Name (optional)"
  → "Total: $51.00" updates (BY_SEX/BY_SKILL: "Your fee: $17.00. Guests are charged by their own sex/skill level." and the total is shown as an estimate)
  → button label recomputed: "Register" if 3 <= places left, else "Join waitlist"
  → submit → 201 → notice "You're in." / "You're on the waitlist (#n)..."
```
- Sex and skill are asked for every guest, even on FLAT sessions (the DB requires both; billing prices guests later). Hint under the "Bringing guests?" legend (proposed): "We ask each guest's sex and skill level because some sessions are priced by them."
- A group that can never fit: "Me + 2 guests" is `aria-disabled` with the hint "This session has {capacity} public places, so a group of 3 can't register." (AC-ERROR-4).
- Missing guest field: 422 → error summary "There's a problem" + "Choose Guest 2's skill level." beside the field; choices and names kept (AC-ERROR-5).
- To change guests later: withdraw and register again (out of scope to edit). The P5 hint says so (proposed): "Need to change your guests? Withdraw and register again. If the session is full by then, you'll join the waitlist."

### Flow J3: Waitlisted player and their promotion (AC-HAPPY-3, AC-HAPPY-4, AC-ASYNC-1, AC-ASYNC-4)

```
P10 with "Full · 2 on the waitlist" → button "Join waitlist"
  hint under the button (consent, proposed): "If a place opens up, you'll be moved in automatically and the fee will apply.
                                              Leave the waitlist any time if you can't play."
  → 201 WAITLISTED → notice "You're on the waitlist (#3). We'll email you if a place opens up." → P6
... later, a confirmed player withdraws (or is banned, or an admin raises capacity) ...
  → in the same transaction: this registration becomes CONFIRMED, promoted_at = now, send-email job enqueued
  → worker delivers within ~30 s: subject "You're in: Smash Club, Wed 28 Oct"
  → player taps the link → (sign-in round trip if needed) → P5 "You're in." + "You were moved off the waitlist on Mon 26 Oct, 9:14 pm."
```
- Without the email the player still sees the change on any page load: the team page row tag changes from "Waitlist #1" to "You're in".
- Nobody is emailed about their own register or withdraw. A passed-over group is not emailed (nothing happened to them).
- P6 after the deadline adds (proposed): "The free cancellation deadline has passed. If you're moved in, the fee applies. If you then can't play, withdraw: you won't be charged if someone from the waitlist takes your place."

### Flow J4: Passed-over waitlisted group (AC-HAPPY-9; rule: Algorithm doc, first-fit assumed)

Situation: group A (3 people) is #1, group B (1 person) is #2; one place frees up; B is moved in, A stays #1.

| Who | Sees |
|---|---|
| A (P6) | "You're on the waitlist (#1). We'll email you if a place opens up." plus, only while `seatsLeft > 0` and `seatsLeft < partySize` (proposed): "{seatsLeft} place is free, but your group needs 3. Smaller groups behind you can take free places; you keep your place at the front of the queue." |
| A, alternative they can choose | The same line ends with: "To take a free place now, leave the waitlist and register with fewer guests." Shown only when the caller's party minus guests would fit (`seatsLeft >= 1`). Leaving costs the queue position, which the P6 leave prompt says. |
| B | Promotion email and P5, as J3 |
| Anyone else | Places line "1 of 10 places left · 1 on the waitlist" (both parts, never "Full" while places are free) |

If the Algorithm doc picks **block** instead of first-fit, the passed-over line becomes "A place is free, but your group needs 3. You're first in the queue; nobody behind you can take it." and the places line shows "Full · {n} on the waitlist" whenever the waitlist is non-empty (free places are held). The journey works with either; only the copy and the button rule change.

### Flow J5: Early withdrawal (AC-ENTRY-3, AC-HAPPY-4)

```
P5 → [Withdraw] → InlineConfirm opens under the button, focus on the prompt:
     "Withdraw from this session? You won't be charged."  [Withdraw] [Cancel]
  → Server Action → POST .../registrations/me/withdraw {expectLate: false} → 200 EARLY
  → redirect(here?notice=withdrawn_free) → notice "You've withdrawn. You won't be charged." → P9 (withdrawn line + form)
```
The withdrawer never learns who took their place (`replacedBy` is only `waitlist | nobody`).

### Flow J6: Late withdrawal, three fee outcomes (AC-HAPPY-5, AC-HAPPY-6; semantics: Algorithm doc)

The confirm prompt is chosen from the server's live preview (`me.lateWithdrawalPreview`, amendment A6), so the player knows before confirming:

| Preview | Prompt (proposed) | Confirm button |
|---|---|---|
| `replaced` (a waitlisted group fits the places you'd free) | "The free cancellation deadline has passed. Someone on the waitlist can take your place, so you shouldn't be charged. We'll confirm once you've withdrawn." | "Withdraw" |
| `charged` (nobody fits) | "The free cancellation deadline has passed and no one on the waitlist can take your place, so you'll be charged {fee} after the game." | "Withdraw and pay {fee}" (destructive style) |
| unavailable (fallback) | spec wording: "The free cancellation deadline has passed. If a waitlisted player takes your place you won't be charged. Otherwise you'll be charged {fee}." | "Withdraw" |

Result, decided atomically by the server and always the truth (the preview can be overtaken by a race of seconds):

| Outcome | Notice | Persisted P9 line |
|---|---|---|
| EARLY (deadline not yet passed) | "You've withdrawn. You won't be charged." | "You withdrew from this session. You won't be charged." |
| LATE, a waitlisted group moved in (fully or, per Algorithm Q3a default, partly) | "You've withdrawn. A player from the waitlist took your place, so you won't be charged." | same, past tense |
| LATE, nobody moved in | "You've withdrawn. No one could take your place, so the {fee} fee will be charged after the game." | "The {fee} fee will be charged after the game." |

`{fee}` is the estimate from the session's fees for the whole party; billing computes the final amount. A later refill by a newcomer does not remove the fee (Algorithm Q3b default); the P9 line does not promise otherwise.

**Deadline passes while the confirm is open** (page loaded at 6:58 pm, deadline 7:00 pm, confirm at 7:01 pm): the Server Action sends `expectLate: false`; the API refuses with 409 `cancellation_terms_changed` and changes nothing; the page re-renders with the late prompt already open and the banner "The free cancellation deadline passed while this page was open. Check the new terms before you withdraw." (amendment A5). The reverse (prompt said late, server finds it early) proceeds as EARLY, which only helps the player.

### Flow J7: Leaving the waitlist (AC-HAPPY-7)

```
P6 → [Leave waitlist] → "Leave the waitlist? You'll lose your place in the queue." [Leave waitlist] [Cancel]
  → POST .../withdraw → 200 → notice "You've left the waitlist." → P9
```
Always free, before or after the deadline; nobody is moved in; the others' ranks close up on screen (positions are not renumbered in the DB).

### Flow J8: Registering again (AC-HAPPY-8)

P9 shows the withdrawn line above the normal form. Registering again works like J1/J2: the group goes to the back of the waitlist if it doesn't fit. Fee-due exception (A11, decided by the Algorithm doc): the journey recommends that a player whose late withdrawal left them liable may register again only when their group would be confirmed; otherwise the form shows "The session is full. Because you withdrew after the free cancellation deadline, you can only register again while places are free." and no "Join waitlist" button. Reason: under the spec as written, re-registering onto the waitlist resets `withdrawal_fee_due` and, if never moved in, the fee disappears.

### Flow J9: Debt block (AC-ERROR-1)

P7 replaces the form. The message counts overdue payments across all teams (workflows §1), so it says "across your teams" to avoid "but I've paid this club". Withdraw and leave-waitlist stay available on existing registrations, and P5/P6 show no debt message. Until player-dashboard ships "Payments & Wallet", the message points at billing's reminder emails; afterwards it becomes a link "Go to Payments & Wallet". Until wallet-and-akahu-billing writes `OVERDUE`, nobody in production sees P7.

### Flow J10: Closed and cancelled sessions (AC-ERROR-2)

P3/P4 are read-only. A form or confirm submitted after `starts_at` gets 409 `session_not_open`; the page re-renders as P4 with "Registration is closed." (state known to have changed: reload). Registering after the deadline but before the start is allowed; P10 then shows "The free cancellation deadline has passed. If you withdraw later you may be charged." above the button.

### Flow J11: Losing membership mid-flow (AC-ERROR-7)

The page rendered P10; an admin bans the player before they tap Register. The registration transaction's `assertApprovedMember` refuses → 403 → the Server Action redirects to the same URL, which renders P2 "You need to be a member of this team to register." Typed guest details are discarded (the user can no longer act). A ban that commits after the registration commits is handled by the ban job (J12).

### Flow J12: Admin bans a member (AC-HAPPY-10)

```
/teams/[T]/manage → member row [Ban] → InlineConfirm (restored prompt):
  "Ban {Full name}? They lose access to this team and can't register for its sessions. Their upcoming registrations will be cancelled."
  reason field → [Ban member]
  → result region "{Full name} has been banned."   (unchanged; no progress state)
  ... member-banned job (<= 30 s): each future PUBLISHED session: registration WITHDRAWN (BANNED, no fee) → FIFO promotion → promoted players emailed
  ... banned member: no email; next visit to the team page or a session page → no-access states
```
Sessions that already started keep the member's registration (billing decides). If the job fails permanently, the daily sweep re-enqueues it; the admin is not told (nothing actionable), operators see `team.member.banned.hook_failed`.

### Flow J13: Outage (AC-ERROR-8)

Register or withdraw gets 5xx, a timeout or no answer: the panel shows `OUTAGE_MESSAGE` "Something went wrong on our side. Your details are still here. Try again in a minute." in a focused error banner, keeps guest choices and names (and keeps the withdraw confirm open), and changes nothing on screen. A retry after an outcome that actually committed gets `already_registered` or `not_registered`, which reload the page into the true state with a neutral notice (see Error Handling). Page load failure: `error.tsx` E-PAGE-1 "Something went wrong on our side. Try again in a minute." with "Try again".

---

## Step-by-Step Journey (primary path: member on a phone registers with one guest)

#### Step 1: Find the session
- **System**: web `/teams/[T]` (server component) → API `GET /teams/:T` and `GET /teams/:T/sessions/upcoming`
- **User Sees**: team name, "Member", "Upcoming sessions" with rows "Wed 28 Oct, 7:00 pm · Highbury Courts / 3 of 10 places left"
- **User Actions**: tap a row
- **Feedback**: navigation
- **Transitions**: → session page
- **Data Flow**: session ids, places, the caller's status per session (no other players' data)

#### Step 2: Choose who's coming
- **System**: web `/teams/[T]/sessions/[S]` → `GET .../registration`
- **User Sees**: summary; "3 of 10 places left"; "Fee: $17.00 per person, charged after the game"; "Free cancellation until Mon 26 Oct, 7:00 pm"; "Bringing guests?" (Just me selected); "Total: $17.00"; [Register]
- **User Actions**: pick "Me + 1 guest"; fill Guest 1 sex and skill, optional name
- **Feedback**: "Guest 1" fieldset appears and receives focus; total becomes "$34.00"; button label stays "Register" (2 <= 3)
- **Transitions**: submit
- **Data Flow**: client state only until submit

#### Step 3: Register
- **System**: Server Action → `POST .../registrations` → one transaction (debt read, member gate, session lock, allocator, rows)
- **User Sees**: button "Registering..." (`aria-disabled`, double taps ignored)
- **Feedback**: redirect to `?notice=registered`
- **Transitions**: 201 → Step 4; 4xx/5xx → in place (Error Handling)
- **Data Flow**: `registrations` CONFIRMED, `guest_count 1`, one `registration_guests` row

#### Step 4: Success
- **User Sees**: notice "You're in." (focused, `role="status"`); panel P5: "You + 1 guest: Ana", "Free cancellation until Mon 26 Oct, 7:00 pm", [Withdraw]; places "1 of 10 places left"
- **Value Delivered**: a place for two, with the cancellation terms visible
- **Next Actions**: "Back to Smash Club" (team page shows the tag "You're in"); withdraw later if plans change

---

## Async Handling

### Operation lifecycle

| Operation | Initiation | Processing | Completion | Where the result lives |
|---|---|---|---|---|
| Register / withdraw / leave waitlist | Tap, confirm where destructive | One transaction, < 300 ms p95 | Redirect with notice | The panel state (P5/P6/P9), persisted |
| Promotion of another player caused by my withdrawal | Same transaction as the withdrawal | n/a | My notice says only "a player from the waitlist took your place" | Their registration |
| Being promoted (waitlisted player's view) | Someone else's withdrawal, a ban job, or an admin raising capacity | Email job enqueued in the promoting transaction; worker sends within ~30 s | Email "You're in: ..." | P5 with "You were moved off the waitlist on ..."; team page tag "You're in" |
| Ban cancellation | Admin confirms ban (sync) | `member-banned` job, one session per transaction, within ~30 s | Nobody is notified except promoted players | Withdrawn rows (BANNED); sweep backstop daily 05:30 |

### Progress communication
- **Method**: email for promotions only; everything else is pull (page loads). No polling, no websocket, no in-app notification centre (consistent with team-management).
- **Can the promoted player miss it?** Yes (spam folder, late promotion). Mitigations: (1) consent copy at the moment of joining the waitlist; (2) the P6 after-deadline reminder; (3) the team page tag; (4) the email repeats the cancellation terms. The decision to stop promoting N hours before start is the Algorithm doc's (Q3c); this journey works either way, and if a cut-off is chosen, P6 gains "The waitlist closes at {time}. If you haven't been moved in by then, you won't play and won't be charged."
- **Persistence**: the registration row is the record (`registered_at`, `promoted_at`, `withdrawn_at`, `withdrawal_kind`, `withdrawal_fee_due`). No history list in v1; player-dashboard "My Registration" adds one later.

### Promotion email (AC-ASYNC-1; proposed copy, plain text like `modules/auth/emails.ts`)

Subject: `You're in: {Team name}, {Wed 28 Oct}` (team name folded to one line).

```
Hi {Full name},

A place opened up, so you've been moved off the waitlist for {Team name}. You're in{, with your 2 guests}.

When:  Wed 28 Oct 2026, 7:00 pm to 9:00 pm
Where: {Location}, {Address}
Fee:   {$17.00 per person} ({$51.00 for your group}), charged after the game.
       [BY_SEX/BY_SKILL: "Estimated fee for your group: {$51.00}, charged after the game."]

[before the deadline]
Can't make it? Withdraw on the session page before {Mon 26 Oct, 7:00 pm} and you won't be charged.

[after the deadline]
The free cancellation deadline ({Mon 26 Oct, 7:00 pm}) has passed. You joined the waitlist on {Sat 24 Oct}, and waitlisted players are moved in automatically when a place opens up. If you can't play, withdraw on the session page as soon as you can: you won't be charged if someone from the waitlist takes your place, otherwise the fee applies.

Session page:
{WEB_BASE_URL}/teams/{teamId}/sessions/{sessionId}

Shared Game Management
```

- The before/after branch is chosen from the promoting transaction's single `now`, not at send time.
- Guest names are not included (privacy; the guests may not have consented to email processing). Group size is.
- `idempotencyKey` `registration-promoted:<registrationId>:<promoted_at epoch ms>`, tag `template: registration-promoted`. No secret in the body, so the payload is not sealed.
- A banned member is never emailed. A capacity raise by an admin (SSE) produces the same email.

---

## Distributed System Flow

### System boundaries
```
Browser ──GET / Server Action──▶ apps/web (session page, team page section, proxy.ts, lib/registrations/actions.ts)
                                      │ Bearer session, traceparent, internal hop headers
                                      ▼
                                 apps/api /teams/:T/sessions/:S/registration(s) ──▶ PostgreSQL 17
                                      │  one transaction: debt read → assertApprovedMember (FOR SHARE)
                                      │  → game_sessions FOR UPDATE → registrations → registration_guests
                                      │  → enqueueEmail(..., { trx }) for each promotion
                                      ▼
                                 pgboss.job ──▶ worker: send-email (promotion) ──▶ Notifier (Mailpit in dev/CI)
                                              ──▶ worker: member-banned (real handler) ──▶ same allocator, per session
                                              ──▶ cron 05:30 registration-ban-reconcile ──▶ re-enqueue member-banned
```

### Responsibility matrix

| Step | Owner | State storage | Failure handling |
|---|---|---|---|
| Upcoming list | web team page → API `GET /teams/:T/sessions/upcoming` | none (per request) | section-only error line; team page still renders |
| Page gate | `proxy.ts` (cookie) then `requireUser` | session cookie | no cookie → `/login?returnTo`; dead cookie → `/auth/session-expired?returnTo`; API down → `error.tsx` |
| Panel state | API `GET .../registration` | `registrations`, `game_sessions`, `payments` (count) | 403 → P2; 404 → P1; 5xx → `error.tsx` |
| Form validation | web (shared zod) then API (strict zod) | `FormState` | in-place field errors, values kept |
| Register / withdraw | API, one transaction, D-14 lock | `registrations`, `registration_guests` | 409/403/422 → page state or in place; 5xx → `OUTAGE_MESSAGE`, keep input |
| Intent vs outcome | web Server Action (hidden `intent` field, never sent to the API) | none | mismatch → the "instead" notice codes |
| Promotion email | API (enqueue in trx) → worker | `pgboss.job` | rollback leaves no job; transient → retry; permanent → `failed` + log |
| Ban cancellation | worker, real handler | `registrations` | per-session commits; transient retry; permanent `NonRetryableJobError`; daily sweep |

---

## Error Handling

### Error states (where each lands and how the user recovers)

| Code (HTTP) | Raised by | Lands on | User sees (proposed) | Recovery | Input kept |
|---|---|---|---|---|---|
| `validation_failed` (422) | register | same form | summary + "Choose Guest {n}'s sex." / "...skill level." / "Use 100 characters or fewer." | fix fields | all |
| `party_exceeds_capacity` (422) | register (race: capacity cut) | same form | "This session has {capacity} public places, so a group of {party} can't register." | fewer guests | all |
| `overdue_payments` (403) | register | reload → P7 | debt message | pay (billing) | n/a |
| `forbidden` (403) | any | reload → P2 | "You need to be a member of this team to register." | My teams | discarded |
| `not_found` (404) | any | reload → P1 | "We couldn't find that session." | back to team | n/a |
| `session_not_open` (409) | register, withdraw | reload → P3/P4 | "Registration is closed." / "This session has been cancelled." | none | n/a |
| `already_registered` (409) | register (double tap, second tab, retry after lost response) | reload → P5/P6 | notice "You're already registered for this session." above the true state | none needed | n/a |
| `not_registered` (409) | withdraw (second tab, retry) | reload → P9/P10 | notice "You're not registered for this session." above the true state (P9 shows the persisted fee line) | none needed | n/a |
| `cancellation_terms_changed` (409, new) | withdraw with `expectLate: false` after the deadline | reload, late confirm open | "The free cancellation deadline passed while this page was open. Check the new terms before you withdraw." | read and confirm again | n/a |
| `fee_due_waitlist_refused` (409, new, if A11 adopted) | register onto the waitlist after a fee-due late withdrawal | reload → P9 | "The session is full. Because you withdrew after the free cancellation deadline, you can only register again while places are free." | wait for a free place | n/a |
| `unauthenticated` / `session_expired` (401) | any | `/auth/session-expired?returnTo=<session page>` | "Your session has expired. Sign in again." | sign in, back | lost (accepted) |
| 5xx, timeout, unreachable | any action | same page | `OUTAGE_MESSAGE` | retry | yes; no optimistic change |
| offline | client | same page | "You seem to be offline. Check your connection and try again." | retry | yes |

**Rule (reload-or-keep, from team-management A7)**: state known to have changed (409, 403, 404) → redirect to the same URL and render the true state; outcome unknown (5xx, timeout, offline) → change nothing, keep everything typed. Retrying is always safe because register and withdraw are refused, not repeated, once they have committed.

### Partial failure
- **Register committed, response lost**: retry → `already_registered` → P5/P6 shows the result. No duplicate, no second queue position.
- **Withdraw committed, response lost**: retry → `not_registered` → P9 shows the persisted fee outcome, so the player still learns whether they'll be charged.
- **Promotion committed, email failed permanently**: the player is CONFIRMED; the page and the team page tag show it. Operators see `notification.failed`. Accepted (the email is a courtesy; the page is the record).
- **Ban committed, job failed**: ban stands; sweep re-enqueues within a day; registrations meanwhile still hold places (accepted in ADR 0015).

### Edge cases

| Case | What happens |
|---|---|
| "Register" tapped but the last place went a second earlier | Server waitlists the group; notice `registered_waitlisted_instead`: "The last places were taken while you were registering. You're on the waitlist (#{rank}). We'll email you if a place opens up." |
| "Join waitlist" tapped but a place freed meanwhile | Server confirms; notice `waitlisted_confirmed_instead`: "A place opened up while you were registering. You're in." |
| Two tabs, register in both | Second gets `already_registered` |
| Two tabs, withdraw in both | Second gets `not_registered`; no second promotion |
| Back after register | Form page was replaced; Back leaves the session page. Reopening shows P5 (`no-store`) |
| Refresh after a notice | Notice stripped; the state remains |
| Deadline passes while the late/early prompt is open | J6, `cancellation_terms_changed` |
| Session starts while the page is open | Next action → `session_not_open` → P4 |
| Promoted after the deadline, doesn't see the email | Liable as any confirmed player (Algorithm Q3c). Consent was given at join time (A4); P6 reminded them after the deadline |
| Promotion email link opened after the session started | P4 "Registration is closed." with "You were registered." |
| Promotion email link opened by a since-banned member | P2 |
| Waitlisted head group passed over | J4 copy |
| Admin of the team registers | Same panel; admins have no extra registration powers in v1 |
| GLOBAL_ADMIN who is not a member | P2 (no override) |

---

## Options Explored

### Option 1: Upcoming list on the team page + status-driven session page with an inline panel (Dashboard + Detail, progressive disclosure)
- **Orchestration**: list → detail; one screen per session; guest fieldsets revealed on demand; InlineConfirm for withdraw and leave; PRG with notice codes; email deep link for promotions.
- **Flow Summary**: J1 to J13 above.
- **Wireframe** (360 px):
  ```
  ┌──────────────────────────────────┐
  │ ← Smash Club                     │
  │ Highbury Courts, Wed 28 Oct 2026 │
  │ 7:00 pm to 9:00 pm               │
  │ 12 Highbury Rd, Auckland         │
  ├──────────────────────────────────┤
  │ 3 of 10 places left              │
  │ Fee: $17.00 per person,          │
  │   charged after the game         │
  │ Free cancellation until          │
  │   Mon 26 Oct, 7:00 pm            │
  │                                  │
  │ Bringing guests?                 │
  │ (•) Just me                      │
  │ ( ) Me + 1 guest                 │
  │ ( ) Me + 2 guests                │
  │ ┌ Guest 1 ─────────────────────┐ │
  │ │ Sex  ( )M ( )F ( )Other      │ │
  │ │ Skill ( )Beg ( )Int ( )Adv   │ │
  │ │ Name (optional) [__________] │ │
  │ └──────────────────────────────┘ │
  │ Total: $34.00                    │
  │ [          Register           ]  │
  └──────────────────────────────────┘
  ```
- **Pros**: one URL per session (shareable, deep-linkable from email and dashboard); state always visible and persisted; matches the team page's status-driven pattern and the manage page's InlineConfirm; "Just me" is one tap; consent and fee lines sit next to the button.
- **Cons**: this feature takes on the team-page list and the session page (scope growth); one more tap than registering straight from a list.

### Option 2: Register straight from the team page list
- **Orchestration**: each upcoming row has an inline "Register" button; guests via an expandable row; withdraw from the row.
- **Wireframe**:
  ```
  ┌──────────────────────────────────┐
  │ Upcoming sessions                │
  │ Wed 28 Oct, 7 pm · Highbury      │
  │ 3 of 10 left        [Register ▾] │
  │ Fri 30 Oct, 6 pm · Eden          │
  │ Full · 2 waiting [Join waitlist] │
  └──────────────────────────────────┘
  ```
- **Pros**: fewest taps for "Just me"; one page.
- **Cons**: fee, deadline and waitlist-consent lines don't fit a row, so players register without seeing the terms (the late-fee surprise this feature must avoid); guest fieldsets inside list rows are hard on a phone and for screen readers; no page for the promotion email to land on; ten rows × confirm panels × notices is a heavy client island; player-dashboard would have to copy it.

### Option 3: Registration wizard `/teams/[T]/sessions/[S]/register` (Who's coming → Review terms → Done)
- **Orchestration**: stepper, step 2 an explicit "I understand the cancellation terms" review.
- **Wireframe**:
  ```
  ┌──────────────────────────────────┐
  │ Step 2 of 3: Check the terms     │
  │ You + 1 guest · Total $34.00     │
  │ Free cancellation until Mon 26.. │
  │ If full, you'll join the wait... │
  │        [Back]  [Register]        │
  └──────────────────────────────────┘
  ```
- **Pros**: strongest consent moment; simple per-step validation.
- **Cons**: 3 screens for a reversible, usually free action; breaks the 30 s goal for repeat weekly use; step state must survive navigation; registered/withdrawn states still need a session page, so it adds pages without removing any.

### Option 4: Panel only; wait for session-scheduling-engine and player-dashboard to provide the way in
- **Orchestration**: this feature ships `RegistrationPanel` and a bare page at the URL; discovery is the email link or a pasted URL until SSE/player-dashboard add lists.
- **Pros**: smallest scope; no overlap with later features.
- **Cons**: the core loop is unreachable through the UI (AC-ENTRY-1 and AC-INTEGRATION-4 need typed URLs); a seeded session nobody can find; ownership of the page and list stays ambiguous between two unplanned features.

---

## Evaluation Matrix

| Criterion | Option 1: list + session page | Option 2: register in list | Option 3: wizard | Option 4: panel only |
|---|---|---|---|---|
| Discoverability | H | H | M | L |
| Learnability | H | M | H | M |
| Efficiency | H (4 taps from My teams) | H (2-3 taps) | L (6+ taps) | L |
| Error Prevention (surprise fees) | H (terms beside the button, server preview) | L (terms hidden) | H | H once found |
| Error Recovery | H (reload-or-keep, persisted state) | M | M (step state) | H |
| Consistency | H (team page and manage patterns) | M | L (no wizard pattern yet) | H |
| Accessibility | H (fieldsets, one form per page) | L (nested forms in rows) | H | H |
| Fit for later features | H (dashboard links in; SSE slots in) | L (dashboard would copy it) | M | M |

---

## Decision

**Chosen**: Option 1 - Upcoming sessions on the team page + status-driven session page with an inline registration panel

### Rationale
- Fees are the trust risk of this feature. Option 1 puts the fee, the deadline and the waitlist consent next to the button that commits to them, and adds a server-computed late-withdrawal preview so nobody confirms a withdrawal without knowing whether they'll pay.
- One URL per session gives the promotion email, the shared chat link, the team page and player-dashboard the same landing place, and that page always shows the persisted truth, which makes every retry and race recoverable by reloading.
- It reuses the team-management journey's patterns (status table, PRG notices, InlineConfirm, reload-or-keep, pull-only status), so players and the build agents meet nothing new.
- Owning the player session page and the team-page list removes a dependency on two features that have no plan, and splits ownership cleanly by persona: players' session surfaces belong here, admins' belong to session-scheduling-engine.

### Trade-offs Accepted
- **Scope grows** by one read endpoint (`GET /teams/:T/sessions/upcoming`) and one team-page section. Mitigation: no paging (next 10), same read model player-dashboard reuses.
- **No push for promotions other than email**: a player who ignores email learns on the next page load. Mitigation: consent copy, after-deadline reminder, team page tag.
- **The late-withdrawal preview can be overtaken** by a race of seconds. Mitigation: the prompt says "We'll confirm once you've withdrawn", and the result notice and persisted line are always the server's truth.
- **The withdraw body gains one field** (`expectLate`) to protect consent when the deadline passes with the page open. Accepted: strict body, one extra 409.
- **InlineConfirm is coupled to the manage area** (`useManage`, moderation kinds). The UI/UX doc must extract a context-free confirm disclosure that both areas use; the behaviour (disclosure, not dialog; focus on prompt; Escape cancels) stays identical.

---

## Copy deck (proposed; the UI/UX doc finalises control-level copy)

All strings live in `apps/web/src/lib/registrations/labels.ts`, except the ban prompt (`lib/teams/labels.ts`) and the email (`apps/api/src/modules/registrations/emails.ts`).

| Key | Text |
|---|---|
| Team page section | "Upcoming sessions" |
| Upcoming row | "{Wed 28 Oct, 7:00 pm} · {Location}" |
| Upcoming row tags | "You're in" / "Waitlist #{rank}" |
| Upcoming empty | "No sessions are open for registration right now." |
| Upcoming more | "Showing the next 10 sessions." |
| Upcoming load error | "We can't load sessions right now. Try again in a minute." |
| Back link | "← {Team name}" (accessible name "Back to {Team name}") |
| Places | "{n} of {capacity} places left" / "Full · {w} on the waitlist" / "{n} of {capacity} places left · {w} on the waitlist" |
| Fee (FLAT) | "Fee: {$17.00} per person, charged after the game" |
| Fee (BY_SEX / BY_SKILL) | "Your fee: {$17.00}, charged after the game" + "Guests are charged by their own sex" / "...skill level" |
| Deadline | "Free cancellation until {Mon 26 Oct, 7:00 pm}" / "The free cancellation deadline has passed." |
| After-deadline register hint | "The free cancellation deadline has passed. If you withdraw later you may be charged." |
| Guests legend / hint | "Bringing guests?" / "We ask each guest's sex and skill level because some sessions are priced by them." |
| Total | "Total: {$34.00}" (estimate wording for BY_SEX/BY_SKILL: "Estimated total: {$34.00}") |
| Buttons | "Register" / "Join waitlist" / pending "Registering..." |
| Waitlist consent hint | "If a place opens up, you'll be moved in automatically and the fee will apply. Leave the waitlist any time if you can't play." |
| CONFIRMED | "You're in." |
| Promoted line | "You were moved off the waitlist on {Mon 26 Oct, 9:14 pm}." |
| Party line | "Just you" / "You + {n} guest(s): {names or 'Guest {n}'}" |
| Change-guests hint | "Need to change your guests? Withdraw and register again. If the session is full by then, you'll join the waitlist." |
| WAITLISTED | "You're on the waitlist (#{rank}). We'll email you if a place opens up." |
| WAITLISTED after deadline | "The free cancellation deadline has passed. If you're moved in, the fee applies. If you then can't play, withdraw: you won't be charged if someone from the waitlist takes your place." |
| Passed over | "{n} place(s) free, but your group needs {party}. Smaller groups behind you can take free places; you keep your place at the front of the queue." (+ " To take a free place now, leave the waitlist and register with fewer guests." when applicable) |
| Withdraw prompt, early | "Withdraw from this session? You won't be charged." |
| Withdraw prompt, late, replaced | "The free cancellation deadline has passed. Someone on the waitlist can take your place, so you shouldn't be charged. We'll confirm once you've withdrawn." |
| Withdraw prompt, late, charged | "The free cancellation deadline has passed and no one on the waitlist can take your place, so you'll be charged {fee} after the game." / button "Withdraw and pay {fee}" |
| Leave prompt | "Leave the waitlist? You'll lose your place in the queue." |
| Notices | `registered` "You're in." · `waitlisted` "You're on the waitlist (#{rank}). We'll email you if a place opens up." · `registered_waitlisted_instead` "The last places were taken while you were registering. You're on the waitlist (#{rank}). We'll email you if a place opens up." · `waitlisted_confirmed_instead` "A place opened up while you were registering. You're in." · `withdrawn_free` "You've withdrawn. You won't be charged." · `withdrawn_replaced` "You've withdrawn. A player from the waitlist took your place, so you won't be charged." · `withdrawn_charged` "You've withdrawn. No one could take your place, so the {fee} fee will be charged after the game." · `left_waitlist` "You've left the waitlist." |
| Withdrawn lines | see P9 above |
| Debt block | "You have {n} overdue payments across your teams. Pay them before registering for more sessions." + "Your payment links are in the reminder emails we sent you." |
| No public places | "This session has no public places." |
| Closed / cancelled | "Registration is closed." / "This session has been cancelled." |
| No access | "You need to be a member of this team to register." + "Go to My teams" |
| Not found | "We couldn't find that session." + "It may have been removed, or the link may be wrong." |
| Terms changed | "The free cancellation deadline passed while this page was open. Check the new terms before you withdraw." |
| Fee-due rejoin (A11) | "The session is full. Because you withdrew after the free cancellation deadline, you can only register again while places are free." |
| Ban prompt (restored) | "Ban {Full name}? They lose access to this team and can't register for its sessions. Their upcoming registrations will be cancelled." |
| Ban result | "{Full name} has been banned." (unchanged) |

`{rank}`, `{n}`, `{fee}` come from the API; money through `formatNZD`, instants through `formatNzDateTime` (Pacific/Auckland) only at render.

---

## Implementation Guidelines

### Frontend Requirements
1. `apps/web/src/app/teams/[teamId]/sessions/[sessionId]/page.tsx` (owned here): `requireUser(here)`, uuid check on both params, `SessionSummary` + `RegistrationPanel`, `StripAuthParams`, notice via `FormBanner focusOnMount`, `<title>` "{Location}, {Wed 28 Oct} – Shared Game Management", `not-found` and P2 rendering.
2. `apps/web/src/app/teams/[teamId]/page.tsx`: add `UpcomingSessions` section for APPROVED callers; its failure is contained to the section.
3. `apps/web/src/components/registrations/{session-summary,registration-panel,register-form,guest-fieldset,upcoming-sessions}.tsx`; `apps/web/src/lib/registrations/{labels,actions,panel-view}.ts`. `panel-view.ts` is the pure P1-P10 status table (unit-tested once, like `teamPageView`).
4. Server Actions: `register(formData)` (hidden `intent` = `register | waitlist`, compared with the outcome to pick the notice; not sent to the API), `withdraw(formData)` (hidden `expectLate`), redirect with `RedirectType.replace` and a notice code; 409/403/404 → redirect to the same URL; 422 → `FormState`; 5xx → `OUTAGE_MESSAGE`.
5. `proxy.ts`: add a `TEAM_SESSION` regex `/teams/<uuid>/sessions/<uuid>` to `isProtected` (sign-in redirect keeps `returnTo`, and `no-store`).
6. Generalise `InlineConfirm` into a context-free confirm disclosure (UI/UX doc), used by the manage area and the panel.
7. Update `banPrompt` in `lib/teams/labels.ts` (+ tests, `manage-components.test.tsx`, `e2e/teams.spec.ts`).

### Backend Requirements
1. `GET /teams/:teamId/sessions/upcoming` (`requireTeamRole('MEMBER')`): next 10 PUBLISHED sessions with `starts_at > now`, ordered by `(starts_at, id)`: `{ sessions: [{ id, startsAt, endsAt, location, publicCapacity, seatsLeft, waitlistLength, me: null | { status, waitlistRank } }], hasMore }`.
2. `GET .../registration` additions: `me.lateWithdrawalPreview: 'replaced' | 'charged' | null` (non-null only for an active CONFIRMED registration after the deadline; computed by the pure `decideAllocation` dry run, no lock), `me.partySize`, and `blockedReason` gains `no_public_places` and `fee_due_waitlist` (if A11).
3. `POST .../registrations/me/withdraw` body `{ expectLate: boolean }` (strict); 409 `cancellation_terms_changed` when the registration is CONFIRMED, `now > cancellation_deadline` and `expectLate` is false.
4. Promotion email builder `modules/registrations/emails.ts` (`buildPromotionEmail`), enqueued in the promoting transaction, before/after branch from the transaction's `now`.

### Integration Points

| System | Interface | Data Exchanged |
|---|---|---|
| session-scheduling-engine | Slot contract above; `promoteWaitlist(trx, sessionId, now)` | Sessions; capacity raises cause promotions and the same emails |
| player-dashboard | Link to `/teams/[T]/sessions/[S]`; reuse of the upcoming read model | Session ids, places, my status |
| wallet-and-akahu-billing | `listBillableRegistrations`; OVERDUE count; reminder emails referenced by the debt copy | Liability, overdue count |
| team-management | `assertApprovedMember`, ban seam, `banPrompt`, InlineConfirm | Membership status |
| Notifier (send-email) | `enqueueEmail(..., { trx })` | Promotion email |

---

## Acceptance Criteria (MANDATORY)

These restate the journey's must-pass behaviour against the spec ACs; spec IDs are kept where unchanged and new ones are listed in [Spec Amendments](#spec-amendments).

### AC-ENTRY-1: User can find the feature
**Priority**: MUST

**Given** an APPROVED member of team T, and PUBLISHED sessions S1 (Wed 28 Oct, 7:00 pm, Highbury Courts, 3 of 10 places left) and S2 of T that start in the future
**When** they open "My teams" from the header, tap T, and look under "Upcoming sessions"
**Then** they see one row per session ordered by start time ("Wed 28 Oct, 7:00 pm · Highbury Courts", "3 of 10 places left"), each a link to `/teams/[T]/sessions/[S]`; opening S1 shows the places, fee and deadline lines, "Bringing guests?" with "Just me" preselected and a "Register" button

**Verification**:
- [ ] E2E: section and rows exist and link to the session page
- [ ] E2E: a PENDING, REJECTED or anonymous caller sees no "Upcoming sessions" section
- [ ] E2E: a signed-out visitor to the session URL returns there after sign-in

### AC-HAPPY-1: User completes the primary journey
**Priority**: MUST

**Given** S with public capacity 10, 7 places taken, FLAT `fee_flat 17.00`, and a member with 0 OVERDUE payments
**When** user performs these EXACT steps:
  1. Open `/teams/[T]/sessions/[S]`
  2. Choose "Me + 1 guest"; Guest 1: Female, Intermediate, name "Ana"
  3. Check "Total: $34.00"; tap "Register"
**Then**:
  - User sees: notice "You're in." (focused), panel "You + 1 guest: Ana", "1 of 10 places left", "Withdraw"
  - Data is: one CONFIRMED `registrations` row with `guest_count 1` and one `registration_guests` row (FEMALE, INTERMEDIATE, 'Ana')
  - User can: withdraw; go back to the team page, whose row shows "You're in"

**Verification**:
- [ ] E2E: complete flow from team page to success
- [ ] Integration: rows persisted as above
- [ ] E2E: success notice and P5 state displayed; reload keeps P5 without the notice

### AC-ERROR-1: User recovers from validation error
**Priority**: MUST

**Given** the register form with "Me + 2 guests" and Guest 2's skill level not chosen
**When** the user taps "Register"
**Then**:
  - User sees: error summary "There's a problem" with "Choose Guest 2's skill level." linked to the field, and the same message beside it
  - User can: choose the level and register
  - Progress is: preserved (guest count, Guest 1 choices and name, Guest 2 sex)

**Verification**:
- [ ] E2E: error message displays and is tied by `aria-describedby`
- [ ] E2E: fixing it registers
- [ ] E2E: typed values kept

### AC-ERROR-2: User recovers from system error
**Priority**: MUST

**Given** a CONFIRMED player with the withdraw confirmation open
**When** the API answers 503 (mocked) on withdraw
**Then**:
  - User sees: "Something went wrong on our side. Your details are still here. Try again in a minute."
  - User can: tap "Withdraw" again in the still-open confirmation
  - Data is: unchanged by the failed call; if a first attempt had committed, the retry yields `not_registered` and the page shows the persisted fee outcome

**Verification**:
- [ ] E2E: error handling with mocked failure, no optimistic state change
- [ ] Integration: retry after a committed withdrawal is refused, not repeated

### AC-ASYNC-1: User knows when async operation completes
**Priority**: MUST

**Given** player B WAITLISTED (#1) for S, and player A CONFIRMED
**When** A withdraws before the deadline
**Then**:
  - B notified via: email "You're in: {Team name}, {Wed 28 Oct}" delivered within 30 s (Mailpit), containing the time, location, address, fee, "Can't make it? Withdraw on the session page before {deadline} and you won't be charged." and the session link; after the deadline, the after-deadline paragraph instead
  - B finds results at: `/teams/[T]/sessions/[S]` ("You're in." + "You were moved off the waitlist on {date, time}.") and the team page tag "You're in"
  - B can: withdraw

**Verification**:
- [ ] E2E: email appears in Mailpit with the link
- [ ] E2E: link lands on P5 with the promoted line
- [ ] Integration: email job enqueued in the promoting transaction; rollback leaves none

### AC-NAV-1: User can navigate away and return
**Priority**: SHOULD

**Given** a player who registered (or withdrew) and is on the result page
**When** they press Back, then reopen the session from the team page, or reload
**Then**:
  - Progress is: the persisted state (P5/P6/P9); no form is resubmitted; the one-shot notice is not replayed
  - User sees: the current state, with the fee outcome of a withdrawal derived from the stored row

**Verification**:
- [ ] E2E: Back and reload after register and after withdraw
- [ ] E2E: `?notice=` stripped after render

### AC-INTEGRATION-1: Backend service produces REAL output
**Priority**: MUST

**Given** a session with public capacity 2, player A CONFIRMED with 1 guest (Female, Beginner), player B WAITLISTED alone, clock after the deadline
**When** A withdraws, and in a second fixture the same happens with no B
**Then**:
  - First fixture: A's notice is `withdrawn_replaced`, B is CONFIRMED with `promoted_at` equal to the withdrawal's `now`, and B's email contains the after-deadline paragraph with B's own join date and the session's real location and address
  - Second fixture: A's notice is `withdrawn_charged` with "$34.00" computed from the session's fee and party size, and `withdrawal_fee_due` is true
  - Changing `fee_flat` to 20.00 changes the message to "$40.00"; no placeholder text appears

**Anti-stub verification**:
- [ ] Output specific to the input (fee, party, dates)
- [ ] Output changes when the fee or party changes
- [ ] No "TODO", "sample" or "test" strings in emails or notices

### Additional Acceptance Criteria
New criteria from this journey (AC-ENTRY-4, AC-HAPPY-11 to 13, AC-ERROR-10 to 12) are written out in [Spec Amendments](#spec-amendments) so the spec stays the single list.

---

## Test Scenarios (Derived from Acceptance Criteria)

### Happy Path Tests
1. AC-ENTRY-1 / AC-ENTRY-4: Upcoming list visible to members only; rows link to the session page; sign-in round trip
2. AC-HAPPY-1: register with one guest to CONFIRMED
3. Waitlist join shows the consent hint; WAITLISTED state; leave waitlist with the queue prompt
4. AC-ASYNC-1: promotion email before and after the deadline; landing on P5 with the promoted line
5. Late withdrawal: preview `replaced` and `charged` prompts; matching notices and persisted lines
6. Restored ban prompt; banned member's registrations withdrawn within 30 s; promoted player emailed

### Error Scenario Tests
1. AC-ERROR-1: guest field errors keep input
2. AC-ERROR-2: outage on register and withdraw keeps input, no optimistic change
3. `cancellation_terms_changed`: deadline passes with the early prompt open
4. Intent mismatch notices (`registered_waitlisted_instead`, `waitlisted_confirmed_instead`)
5. Debt block P7 with "across your teams"; withdraw still allowed
6. Closed vs cancelled copy; 403 P2; 404 P1

### Edge Case Tests
1. AC-NAV-1: Back, reload, stripped notices
2. Passed-over head group copy (first-fit), places line with both parts
3. Second tab register/withdraw → `already_registered` / `not_registered` re-render the true state
4. Fee-due re-registration rule (if A11 adopted)

---

## Accessibility Checklist

- [ ] Keyboard: team page rows, radios, guest fieldsets, Register, Withdraw/Leave, confirm and Cancel reachable in DOM order; Escape closes the confirm and returns focus to its trigger
- [ ] Screen reader: one `h1` (session heading); panel `section` with `aria-labelledby`; persistent `role="status"` region for the state line; notices focused once via `FormBanner`; errors in `role="alert"` + summary
- [ ] Focus management: choosing guests moves focus to the "Guest 1" legend; opening a confirm focuses its prompt; after redirect the notice receives focus
- [ ] Error messages associated with inputs (`aria-describedby`), and `aria-disabled` "Me + 2 guests" described by its visible hint
- [ ] Loading: pending button label "Registering..." / "Withdrawing...", `aria-disabled`, announced
- [ ] No time limits on any step; the deadline is information, never a countdown that forces action
- [ ] Status never colour-only ("You're in" / "Waitlist #2" are text tags); 44 px targets; no horizontal scroll at 360 px
- [ ] No native dialogs anywhere (InlineConfirm disclosure)

---

## Analytics & Observability

### Key Metrics

| Metric | Purpose | Target |
|---|---|---|
| Register completion (session page view with form → 201) | Success measurement | > 85% of form views by members without an active registration |
| Time from session page load to 201 | Efficiency (productBrief: < 30 s) | p50 < 15 s, p90 < 30 s |
| Waitlist promotion rate | Waitlist value | Tracked, no target |
| Late withdrawals that end fee-due vs replaced | Fee fairness | Tracked; spikes trigger a copy review |
| `cancellation_terms_changed` and intent-mismatch counts | Race frequency | Low single digits per week |
| Refusal rate by reason | Quality | `validation_failed` < 5% of submits |

### Instrumentation Points
- API (spec AC-VERIFY-6): `registration.created`, `registration.withdrawn` (`withdrawalKind`, `feeDue`, `promotedCount`), `registration.promoted`, `registration.refused` (`reason` adds `cancellation_terms_changed`, `fee_due_waitlist_refused`), `registration.ban_reconcile.completed`. Ids only.
- Web: `web.registrations.api_failure` (`action`, `status`, `code`) on 5xx only, like `web.teams.api_failure`. No names, emails or guest names.
- Email: existing `notification.sent` / `notification.failed` with `idempotencyKey` (`registration-promoted:...`, ids only).

---

## Dependencies on the parallel creative docs

| Topic | Owner | This doc assumes | If it differs |
|---|---|---|---|
| Promotion rule (Q1) | Algorithm | first-fit; head keeps position; newcomers confirmed only when no waitlisted group fits | swap the passed-over copy and the places-line rule (J4 gives the block variant) |
| Partial refill fee (Q3a) | Algorithm | no fee | `withdrawn_replaced` notice gains a partial variant |
| Later refill (Q3b) | Algorithm | withdrawer still charged | P9 fee line changes |
| Promotion after deadline (Q3c) | Algorithm | promote until start | add the cut-off line to P6 and the email |
| Re-registration after fee-due withdrawal (A11) | Algorithm | refuse waitlisting | drop A11 and its copy; accept the loophole explicitly in ADR 0016 |
| `lateWithdrawalPreview`, `expectLate`, upcoming endpoint | Architecture | shapes in Backend Requirements | journey unchanged if equivalent fields exist |
| Panel layout, InlineConfirm extraction, guest fieldsets without JS, final copy | UI/UX | Option 1 wireframe | copy keys stay; text may change |

---

## Validation Checklist

- [x] Journey delivers stated value (a place, with the terms visible)
- [x] All personas can complete their journey (player, waitlisted, passed-over, late withdrawer, admin, banned)
- [x] Errors are recoverable (reload-or-keep; refused-not-repeated retries)
- [x] Async states are clear (email + page + team tag for promotions; ban is silent by design)
- [x] Consistent with existing patterns (status table, PRG notices, InlineConfirm, pull-only)
- [x] Accessible per AC-VERIFY-8
- [x] Testable with defined scenarios

## Next Steps

1. Reconcile with the Algorithm, Architecture and UI/UX docs in the task file's reconciliation section (A5, A6, A11 need sign-off).
2. Record the page-ownership split and slot contract in ADR 0016 and hand it to session-scheduling-engine's plan.
3. Phase 3 adds the upcoming endpoint, `expectLate` and the preview; Phase 5 builds the page, the team-page section and the copy deck; Phase 6 E2E follows AC-INTEGRATION-4 with the upcoming list as the entry.

---

## Spec Amendments

| # | AC / section | Change |
|---|---|---|
| A1 | Scope Boundaries; Invocation Method (Location, Navigation) | Move "the session list on the team page" from out of scope to in scope. This feature owns the player session page `/teams/[teamId]/sessions/[sessionId]` unconditionally (drop "if session-scheduling-engine ships no player page" and the LOW-confidence note) and an "Upcoming sessions" section on `/teams/[teamId]` for APPROVED members. Navigation becomes "My teams → team → Upcoming sessions row → session page". Session-scheduling-engine owns admin session surfaces under `/teams/[T]/manage/sessions` and follows the slot contract (`SessionSummary` + `RegistrationPanel`, one registration control only). |
| A2 | New **AC-ENTRY-4** (MUST); Invocation API list | `GET /teams/:teamId/sessions/upcoming` (`requireTeamRole('MEMBER')`, add to AC-VERIFY-1) returns the next 10 PUBLISHED sessions with `starts_at > now`, ordered by `(starts_at, id)`, each with `publicCapacity`, `seatsLeft`, `waitlistLength` and `me: null | { status, waitlistRank }`, plus `hasMore`. The team page renders them for APPROVED callers only, with the empty and section-error lines; PENDING, REJECTED, BANNED and anonymous callers see no section. |
| A3 | AC-ENTRY-1 | Add "reached from the team page's Upcoming sessions row" to the When clause; `proxy.ts` protects `/teams/<uuid>/sessions/<uuid>` by regex (sign-in redirect with `returnTo`, `no-store`). |
| A4 | AC-HAPPY-3; AC-ENTRY-3 (WAITLISTED state) | The "Join waitlist" button carries the consent hint "If a place opens up, you'll be moved in automatically and the fee will apply. Leave the waitlist any time if you can't play."; after the deadline the WAITLISTED state adds the after-deadline line (copy deck). |
| A5 | AC-HAPPY-4/5/6 and new **AC-ERROR-10** (MUST) | Withdraw body becomes strict `{ expectLate: boolean }`. When a CONFIRMED registration is withdrawn with `now > cancellation_deadline` and `expectLate = false`, the API returns 409 `cancellation_terms_changed` (new code in `errors.ts`, `ERROR_DEFAULTS`, `registration.refused` reasons) and changes nothing; the page re-renders with the late confirmation open and the banner "The free cancellation deadline passed while this page was open. Check the new terms before you withdraw." `expectLate = true` with an early outcome proceeds as EARLY. Leaving the waitlist ignores the flag. |
| A6 | AC-HAPPY-5/6 confirm prompts; `GET .../registration` (SHOULD) | Add `me.lateWithdrawalPreview: 'replaced' \| 'charged' \| null` (non-null only for an active CONFIRMED registration after the deadline, from a lock-free `decideAllocation` dry run). The late prompt uses the `replaced` / `charged` variants from the copy deck ("Withdraw and pay {fee}" for `charged`); the spec's conditional wording stays as the fallback. The result notice remains the server's truth. |
| A7 | AC-HAPPY-9 (web side) and the seats line in Invocation Method | When `seatsLeft > 0` and the waitlist is non-empty, the places line reads "{n} of {capacity} places left · {w} on the waitlist". A WAITLISTED caller whose party exceeds `seatsLeft > 0` sees the passed-over line (copy deck). No email to a passed-over group. |
| A8 | AC-HAPPY-1/2/3 (new **AC-HAPPY-11**, MUST) | The Server Action posts a hidden `intent` (`register` / `waitlist`, never sent to the API). When the outcome differs, the notice is `registered_waitlisted_instead` ("The last places were taken while you were registering. You're on the waitlist (#{rank})...") or `waitlisted_confirmed_instead` ("A place opened up while you were registering. You're in."). |
| A9 | AC-ERROR-1 copy | "You have {n} overdue payments across your teams. Pay them before registering for more sessions." + "Your payment links are in the reminder emails we sent you." (becomes a "Payments & Wallet" link when player-dashboard ships). |
| A10 | AC-ERROR-2 and AC-ERROR-4 (page side); new **AC-ERROR-11** (MUST) | A CANCELLED session shows "This session has been cancelled." (API code stays `session_not_open`). Public capacity 0: `blockedReason 'no_public_places'`, the panel shows "This session has no public places." and no form. Unknown, DRAFT and other-team ids render "We couldn't find that session." / "It may have been removed, or the link may be wrong." with links back to the team (when visible) and My teams. |
| A11 | AC-HAPPY-8 (pending the Algorithm doc; new **AC-ERROR-12** if adopted) | Close the fee-dodging path: a registrant whose row is `WITHDRAWN` with `withdrawal_fee_due = true` may register again only if the party would be CONFIRMED; otherwise 409 `fee_due_waitlist_refused` with "The session is full. Because you withdrew after the free cancellation deadline, you can only register again while places are free.", nothing written, and `withdrawal_fee_due` stays true. If the Algorithm doc rejects this, ADR 0016 must record the accepted loophole. |
| A12 | AC-HAPPY-7 prompt | Leave prompt becomes "Leave the waitlist? You'll lose your place in the queue." |
| A13 | AC-ASYNC-1 email body; new **AC-HAPPY-12** (SHOULD) | Body adds the opening line "A place opened up, so you've been moved off the waitlist for {Team name}. You're in{, with your {n} guests}.", the time range, the group fee ("{$17.00 per person} ({$51.00} for your group)" or "Estimated fee for your group: ..."), and after the deadline "You joined the waitlist on {date}, and waitlisted players are moved in automatically when a place opens up." No guest names. Tag `template: registration-promoted`. |
| A14 | AC-ASYNC-4; AC-HAPPY-4/5/6 (new **AC-HAPPY-13**, MUST) | After any withdrawal, the persisted WITHDRAWN state (not only the one-shot notice) shows the fee outcome derived from `withdrawalKind` and `withdrawalFeeDue` (copy deck "Withdrawn lines"), so a reload, a second tab or a retry after a lost response still tells the player whether they'll be charged. |
| A15 | AC-HAPPY-10; AC-VERIFY-8; Invocation "Reused as is" | Ban success message stays "{Full name} has been banned." (no progress state). `InlineConfirm` is not reusable as is (it depends on `useManage` and moderation kinds): extract a context-free confirm disclosure used by both the manage area and the panel, with identical behaviour. |
