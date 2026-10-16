# UI/UX Decision: Registration Panel (session page) and Restored Ban Confirmation

**Created**: 2026-10-16
**Status**: DECIDED
**Decision Type**: UI/UX
**Task**: registration-and-waitlist (Level 4)
**Answers**: Creative question 5, UI side (panel layout and states, guest form, waitlist rank and "passed over" display, fee and deadline lines, debt-block copy, withdraw and leave-waitlist confirmations, restored `banPrompt`). The page route, ownership and navigation are the user-journey agent's. Promotion and fee rules are the algorithm agent's (spec defaults assumed: first-fit promotion, liability decided at withdrawal). The API shape is the spec's `GET .../registration` response as given.

Sources read: task file (branch tip, Invocation Method, Success Criteria, all cited ACs, creative Q5), `productBrief.md`, `systemPatterns.md`, `techContext.md` (main), `memory-bank/creative/team-management-team-admin-uiux.md`, `apps/web/src/components/teams/{inline-confirm,skill-level-field,option-fieldset,join-team-form,use-moderation-action}.tsx`, `apps/web/src/components/auth/styles.ts`, `apps/web/src/lib/teams/labels.ts`. `memory-bank/ux-patterns.md` does not exist yet, so the team-management UI/UX document and the existing components are the pattern source.

## User Context

### Target Users
- **Primary**: Player (`PLAYER`, an APPROVED member). A club regular on a phone, usually in a chat thread or an email link, who wants a place for Thursday night in a few taps ("registration completed in under 30 s" is the persona's success metric). Most of the time they register alone. Sometimes they bring a friend or two and must say who they are. They need to know three things without reading much: am I in, what will it cost me, and what happens if I can't come.
- **Secondary**: Team Admin, who bans a member and needs the confirmation to say what that does to the member's upcoming sessions. A promoted player arriving from an email link is a third entry: they land on the same panel and must understand a place was given to them, possibly after the free-cancellation deadline.

### User Goals
1. Get a place (or a fair spot in the queue) in one or two taps when alone, and in one short form when bringing guests.
2. Understand the money before committing: per-person fee, group total, "charged after the game", and what a late withdrawal costs.
3. Know exactly where they stand later: in, waitlisted (and how far back), withdrawn (and whether a fee applies), or blocked (and why).
4. Withdraw or leave the waitlist without fear of an accidental or surprise charge.
5. (Admin) Ban someone knowing their upcoming registrations will be cancelled.

### Use Cases
| Use Case | User | Goal | Frequency |
|----------|------|------|-----------|
| Register alone | Player | Take a place | Weekly, most common |
| Register with 1 or 2 guests | Player | Take places for the group | Occasional |
| Join the waitlist (full or group too big) | Player | Queue fairly | When sessions fill |
| Check "am I in?" | Player | See status, rank, fee | Often (reopened from email or chat) |
| Arrive after promotion | Player | Understand "You're in." and any late-fee exposure | Occasional |
| Withdraw before the deadline | Player | Free cancel | Occasional |
| Withdraw after the deadline | Player | Cancel knowing the fee rule | Rare, high stakes |
| Leave the waitlist | Player | Stop waiting | Occasional |
| Re-register after withdrawing | Player | Change party size | Rare |
| Blocked by 3+ overdue payments | Player | Understand, find the way out | Rare |
| Ban a member | Team Admin | Remove a problem member | Rare, high stakes |

### Constraints
- **Devices**: desktop and 360 x 740 phone (the two Playwright projects). No horizontal scroll at 360 px; 44 px minimum targets (`min-h-11`); 16 px text in inputs.
- **Accessibility**: axe `critical` blocks UAT (AC-VERIFY-8). WCAG 2.2 AA is the working target (the product brief names no level; auth and team-management already target it). Specifically: `fieldset`/`legend` radio groups, errors tied by `aria-describedby` and summarised in `ErrorSummary`, status never colour-only, no native dialogs, persistent live regions for status, labels contain visible text.
- **Locale**: English only. NZD via `formatNZD`, dates via `formatNzDateTime` in Pacific/Auckland at the UI boundary only (P3).
- **Existing patterns to match**: `INPUT_CLASS`, `BUTTON_CLASS`, `SECONDARY_BUTTON_CLASS`, `LINK_CLASS`, `FOCUS_RING` (`components/auth/styles.ts`); `OptionFieldset` (fieldset, hint, per-option help tied by `aria-describedby`, first radio `id="field-<name>"`); `ErrorSummary` and `FieldError`; `useAuthForm` (client validation, Server Action, typed values retained); `TeamFormBanner`; `InlineConfirm` (disclosure, not a dialog, Escape cancels, one open per section); the manage-area status-region and focus rules (persistent `role="status"`, focus to the section heading after a row changes); copy lives in a pure `labels.ts` with one test file.
- **Guiding principles**: P1 (the API and DB are the authority, the UI never relies on a hidden control), P2 (money never as `number`; fee estimates come from `Money`/`MoneyString` helpers), P3 (UTC to Auckland only for display).
- **Privacy**: guest names are shown to the registrant only. A withdrawer never learns who took their place. The panel never shows anyone else's name or party size.

## User Flow

### Flow Diagram
```
Email link / session list / returnTo after sign-in
                    |
                    v
        /teams/[teamId]/sessions/[sessionId]
                    |
   +----------------+-------------------------------------------+
   | panelView(response, now) picks ONE state                    |
   +--+----------+-----------+-----------+-----------+-----------+
      |          |           |           |           |
      v          v           v           v           v
  Register    Registered  Waitlisted  Withdrawn   Blocked / Closed / Not a member
  form        "You're in" "#rank"     (+fee note)  (no form, reason + way out)
      |          |           |           |
      | party size / guests  | Withdraw  | Leave     register again (if open)
      v          v           v
  [Register] or [Join waitlist]     InlineConfirm (early / late / waitlist wording)
      |                              |  Confirm -> Server Action -> API
      v                              v
  CONFIRMED or WAITLISTED         WITHDRAWN (+ promoted someone) -> state card + note
```

### Flow Description
1. **Entry**: signed-in member opens the session page (link, list or promotion email). Anonymous goes to `/login?returnTo=...` and comes back. The server component fetches `GET .../registration` once and renders exactly one state. No client data fetching.
2. **Read**: the panel opens with an outcome card (only when a registration exists), then three summary lines (places, fee, cancellation deadline), then the action area.
3. **Register**: "Just me" is preselected, so a solo player presses "Register" once. Choosing "Me + 1 guest" or "Me + 2 guests" inserts guest fieldsets directly after the party group; the next Tab stop is Guest 1. The total and the likely outcome ("goes on the waitlist") update in a live line. The button reads "Register" or "Join waitlist" from the same prediction.
4. **Result**: a Server Action calls the API, the page revalidates, the form is replaced by the outcome card, and focus moves to the "Registration" heading while the persistent status region announces the change. If the real outcome differs from the prediction (a race), the note says so.
5. **Withdraw / leave**: the button opens an inline confirmation whose wording depends on early vs late, on whether anyone is waiting, and on whether a group is involved. Confirm runs the action, then focus goes to the heading.
6. **Exit**: nothing to dismiss. The player leaves via the header or the page's back link.

### Error States
| Error | Cause | User Recovery |
|-------|-------|---------------|
| 401 on load | Session expired | Redirect to `/login?returnTo=...` (existing `requireUser`) |
| 403 on load | Not an approved member (non-member, pending, rejected, banned, other team's admin) | "You need to be a member of this team to register." plus link "View team page"; no session details, no form (AC-ENTRY-2) |
| 404 on load | Draft, unknown or other team's session | Existing teams not-found page, identical body |
| 5xx on load | API down | Panel replaced by "We can't load registration right now. Try again in a minute." with the page header intact (`error.tsx` for the panel segment) |
| 403 `overdue_payments` | 3+ OVERDUE payments | Page re-renders to the debt-block state (no form). The block copy tells the player what to do |
| 409 `already_registered` | Second tab, double submit | "You're already registered for this session." and the page shows the current state (revalidated) |
| 409 `not_registered` | Second withdraw click | "You're not registered for this session." and the page shows the current state |
| 409 `session_not_open` | Session started or closed while the page was open | "Registration for this session is closed." and the page shows the closed state |
| 422 `party_exceeds_capacity` | Party can never fit | API message; the form keeps the chosen guests; the over-size option is already disabled for a fresh load |
| 422 `validation_failed` | Missing guest sex/skill, name over 100, direct API call | Field errors beside each field and in the summary; typed values stay |
| 403 `forbidden` on action | Banned between render and submit (AC-ERROR-7) | "You need to be a member of this team to register." and the page re-renders as not-a-member |
| Deadline crossed while the confirm is open | The player read "free" wording that is now stale | The action does not withdraw. The confirm re-opens with the late wording (AC-ERROR-10, new) |
| 5xx / network on action | API down | `OUTAGE_MESSAGE` in the status region; the form keeps party, guest choices and names; no optimistic change; the confirm stays open |

## Options Explored

### Option 1: One stacked panel, state-driven, with inline disclosure (CHOSEN)
- **Approach**: `RegistrationPanel` is a Server Component. A pure `panelView(response, now)` (mirroring `teamPageView`) selects one state. The panel is `outcome card, summary lines, action area`. Two small client islands: `RegisterForm` (party, guests, live total, submit) and `WithdrawConfirm` (a disclosure built on a shared core extracted from `InlineConfirm`). A thin client shell holds the persistent status region and the transient notes from action results.
- **Wireframe/Layout** (desktop, open session, bringing 1 guest):
  ```
  Registration                                                       (h2)
  ──────────────────────────────────────────────────────────────────────
  • 3 of 10 places left
  • Fee: $17.00 per person, charged after the game
  • Free cancellation until Wed 5 Oct, 7:00 pm

  Bringing guests?                                         (fieldset)
   ( ) Just me   (•) Me + 1 guest   ( ) Me + 2 guests

  ┌ Guest 1 ───────────────────────────┐
  │ Sex      (•) Male ( ) Female ( ) Other │
  │ Skill    ( ) Beginner (•) Intermediate ( ) Advanced │
  │ Name (optional) [____________________]  │
  └─────────────────────────────────────┘
  Total: $34.00 for 2 people
  [ Register ]
  ```
- **User Flow**: solo: one tap on "Register". Guests: choose party size, fill Guest fieldsets, confirm total, press the button.
- **Pros**:
  - Fastest path for the 80% case (solo): no extra step, the default is already selected.
  - Everything the player needs to decide (places, fee, deadline, total) is visible at once, on one screen, on a phone.
  - Server-rendered state is reload-safe and email-link-safe; no client fetching.
  - No new interaction patterns: fieldset radios, summary, disclosure confirm, status regions.
- **Cons**:
  - The form is a little long with two guests on a phone (about 650 px of form, scrolling is fine).
  - Always asking guest sex and skill adds fields even for FLAT sessions.
  - `InlineConfirm` is coupled to the manage context, so a presentational core must be extracted.
- **Usability**: High. **Accessibility**: High. **Implementation Complexity**: Low to Medium.

### Option 2: Step-by-step flow (party size, then guest details, then review, then confirm)
- **Approach**: a three-step form on the same page or sub-route with Next/Back and a final review screen showing the total.
- **Wireframe/Layout**:
  ```
  Step 1 of 3: Who is coming?     [ Next ]
  Step 2 of 3: Guest details      [ Back ] [ Next ]
  Step 3 of 3: Review and register [ Back ] [ Register ]
  ```
- **User Flow**: every registrant, including solo, goes through at least two screens.
- **Pros**:
  - Short screens; a review step reduces mistaken registrations.
  - Natural place to show the total.
- **Cons**:
  - Penalises the common solo case with extra taps against a 30-second success metric.
  - Needs step state, back-navigation and focus handling for no gain on a form with three fields per guest.
  - Registration is cheap to undo (free before the deadline), so a review gate protects little.
- **Usability**: Medium. **Accessibility**: Medium (step focus management). **Implementation Complexity**: Medium to High.

### Option 3: Modal or drawer registration dialog
- **Approach**: the panel shows a summary and a "Register" button. The button opens a modal (or bottom sheet on phones) that holds party size, guests and the submit.
- **Wireframe/Layout**:
  ```
  [summary lines]  [ Register ]  ->  ┌ Register ─────────┐
                                     │ party / guests     │
                                     │ [Cancel] [Register]│
                                     └────────────────────┘
  ```
- **User Flow**: tap Register, fill the dialog, submit.
- **Pros**:
  - Clean summary view; the form is out of the way until needed.
- **Cons**:
  - A dialog needs a focus trap, `aria-modal`, scroll lock and a stacked confirmation inside it. The project's pattern is explicitly non-modal inline disclosure, and native or dialog-like surfaces blocked UAT in team-management.
  - An extra tap for everyone; guest fields inside a sheet on a 740 px phone with the keyboard open is cramped.
  - Does not help error recovery (typed values and the summary are hidden behind the dialog).
- **Usability**: Medium. **Accessibility**: Low to Medium. **Implementation Complexity**: High.

### Option 4: Two-path entry (a one-tap "Register" for solo, "Register with guests" opens the form)
- **Approach**: the primary button registers alone immediately. A secondary link or button, "Bring guests", reveals the party form.
- **Wireframe/Layout**:
  ```
  [summary lines]
  [ Register ]        Bringing guests? [ Add guests ]
  ```
- **User Flow**: solo is one tap with no visible form; guests need a second path.
- **Pros**:
  - Visually the lightest default; the solo tap is as fast as Option 1.
- **Cons**:
  - Two submit paths that mean different things (a solo tap cannot be corrected once pressed; a player who forgot guests registers alone and must withdraw and re-register).
  - Guests are less discoverable than a visible "Bringing guests?" group; the "Join waitlist" vs "Register" label has to be decided before the player has said how many are coming.
  - Two different forms to test and keep consistent, with no speed gain over a preselected "Just me".
- **Usability**: Medium. **Accessibility**: Medium to High. **Implementation Complexity**: Medium.

## Evaluation Matrix

| Criteria | Option 1 Stacked | Option 2 Steps | Option 3 Dialog | Option 4 Two-path |
|----------|------------------|----------------|-----------------|-------------------|
| Usability (solo speed, clarity of cost and state) | 5 | 3 | 3 | 4 |
| Accessibility | 5 | 3 | 2 | 4 |
| Consistency with existing patterns | 5 | 3 | 1 | 3 |
| Responsiveness (360 px) | 4 | 4 | 3 | 4 |
| Performance (one server load, small islands) | 5 | 4 | 4 | 5 |
| Implementation effort (5 = easy) | 4 | 2 | 1 | 3 |
| **Total (of 30)** | **28** | 19 | 14 | 23 |

(Scores 1 to 5, higher is better.)

## Decision

**Chosen**: Option 1 - One stacked, state-driven panel with inline disclosure confirmations.

### Rationale
- The player's job is "get a place, know what it costs, know where I stand". Option 1 puts all three on one screen without a step, a dialog or a hidden path, and keeps the preselected "Just me" so a solo registration is one tap.
- Every state is a pure function of the GET response and the server clock (`panelView`), which is reload-safe, testable as a table, and identical whether the player arrives from the list, an email or `returnTo`.
- It reuses the disclosure confirmation the team admin area already established (not a modal, so UAT-safe) and the fieldset, error summary and status-region conventions. No new colours, fonts or dependencies.
- Option 2's review step guards something that is free to undo. Option 3 conflicts with the project's no-dialog rule. Option 4 adds a second submit path with a mistake mode.

### Trade-offs Accepted
- **Always ask each guest's sex and skill, even on FLAT sessions.** The database requires both (`NOT NULL`), and inventing defaults would write false data (P1). The cost is two radio groups per guest. Mitigation: compact inline radio rows, one honest sentence of explanation, and the total line so the player sees why it matters on BY_SEX / BY_SKILL_LEVEL sessions. If this friction shows in use, the follow-up is a migration that makes both nullable for FLAT-priced sessions, not UI defaults.
- **The button label and total are predictions.** The server decides the outcome. A race can turn "Register" into a waitlist spot (or the reverse). Mitigation: the result note states the difference in plain words.
- **No focus jump when guest fieldsets appear.** The spec asked for focus to move to "Guest 1". Moving focus on a radio change breaks arrow-key selection ("Me + 2 guests" cannot be reached after "Me + 1 guest") and is a context change on input (WCAG 3.2.2). Instead the fieldsets are inserted immediately after the party group, so the next Tab lands in Guest 1, and the live total line announces the change. See Spec Amendments.
- **A panel segment fails as a unit.** One GET feeds the whole panel; a 5xx shows one error state instead of a partial panel. Acceptable for a single small read.
- **Rank is "n-th group", not "n-th person".** The panel says how many groups are ahead, not how many people, because sizes of other registrants are private.
- **Withdrawn-state copy after the fact is neutral for a late leave**: the GET carries no "was waitlisted" flag, so a late withdrawn row says "You won't be charged" rather than "a player took your place". The transient result message after the action carries the specific wording.

## Design Specifications

### Layout
- **Placement**: the panel is a `<section aria-labelledby="registration-heading">` inside the session page's `max-w-3xl` main column, below the session header. The panel owns the three summary lines; the page header owns title, date, location and address (user-journey agent).
- **Order inside the panel**: heading, outcome card (only when a registration exists or the user is blocked or closed), summary lines, action area (form or withdraw/leave).
- **Desktop (above 1024 px) and tablet**: single column up to 768 px. The party group is one row of three radios. Guest fieldsets sit side by side from `sm` (`sm:grid-cols-2`). Buttons are content-width from `sm`.
- **Mobile (360 px)**: everything stacks. Party radios stack (each `min-h-11`). Guest fieldsets are full width, one under the other. Sex radios fit one row; skill radios wrap to two rows (`flex flex-wrap gap-x-6`). The submit and confirm buttons are full width. Confirm panels are full width inside the action area. Long names use `break-words`.

States (360 px wireframes; the desktop layout is the same content in wider rows):

Open, alone, seats free:
```
┌──────────────────────────────┐
│ Registration                 │
│ • 3 of 10 places left        │
│ • Fee: $17.00 per person,    │
│   charged after the game     │
│ • Free cancellation until    │
│   Wed 5 Oct, 7:00 pm         │
│ Bringing guests?             │
│ (•) Just me                  │
│ ( ) Me + 1 guest             │
│ ( ) Me + 2 guests            │
│ Total: $17.00 for 1 person   │
│ [Register                   ]│
└──────────────────────────────┘
```

Full (or group too big): button and live line change:
```
│ • Full · 3 on the waitlist   │
│ ...                          │
│ This group goes on the       │
│ waitlist. You're only        │
│ charged if you get a place.  │
│ [Join waitlist              ]│
```

Registered with the withdraw confirmation open (late, waitlist non-empty):
```
┌──────────────────────────────┐
│ Registration                 │
│ ┌──────────────────────────┐ │
│ │ You're in.               │ │
│ │ Your group: you + 2      │ │
│ │ guests (3 places)        │ │
│ │ • Guest 1: Ana, Female,  │ │
│ │   Intermediate           │ │
│ │ • Guest 2: Male, Beginner│ │
│ └──────────────────────────┘ │
│ • Fee: $51.00 for your group │
│   of 3, charged after game   │
│ • The free cancellation      │
│   deadline has passed.       │
│ [Withdraw                   ]│
│ ┌ (role=group) ────────────┐ │
│ │ The free cancellation    │ │
│ │ deadline has passed. If a│ │
│ │ waitlisted player takes  │ │
│ │ your place you won't be  │ │
│ │ charged. Otherwise you'll│ │
│ │ be charged $51.00 for    │ │
│ │ your group of 3.         │ │
│ │ [Withdraw (red)         ]│ │
│ │ [Cancel                 ]│ │
│ └──────────────────────────┘ │
└──────────────────────────────┘
```

Waitlisted, passed over (a free seat exists but this group is bigger):
```
│ ┌──────────────────────────┐ │
│ │ You're on the waitlist   │ │
│ │ (#1). We'll email you if │ │
│ │ a place opens up.        │ │
│ │ You're first in line.    │ │
│ │ Your group of 3 needs 3  │ │
│ │ places together and 1 is │ │
│ │ free. Smaller groups     │ │
│ │ behind you may get places│ │
│ │ first; you keep your     │ │
│ │ spot at the front.       │ │
│ │ To get a place now,      │ │
│ │ register with 1 person.  │ │
│ │ Leaving the waitlist     │ │
│ │ loses your spot.         │ │
│ └──────────────────────────┘ │
│ [Leave waitlist             ]│
```

Withdrawn with a fee, session still open:
```
│ ┌──────────────────────────┐ │
│ │ You withdrew from this   │ │
│ │ session after the free   │ │
│ │ cancellation deadline and│ │
│ │ no one took your place,  │ │
│ │ so the $51.00 fee will be│ │
│ │ charged after the game.  │ │
│ └──────────────────────────┘ │
│ summary lines + register form again │
```

Debt-blocked (no form, no payments link yet):
```
│ ┌──────────────────────────┐ │
│ │ You have 3 overdue       │ │
│ │ payments. Pay them before│ │
│ │ registering for more     │ │
│ │ sessions. If you think   │ │
│ │ this is wrong, ask your  │ │
│ │ team admin.              │ │
│ └──────────────────────────┘ │
│ summary lines (read-only)    │
```

Closed: outcome card (if any) plus "Registration is closed." and summary lines; no form, no buttons.

### Key Components
| Component | Purpose | Behavior |
|-----------|---------|----------|
| `RegistrationPanel` (server) | Fetch result in, one state out | Calls `panelView(response, now)`; renders heading, `OutcomeCard`, `SessionSummary`, then the action area for that state |
| `RegistrationShell` (client) | Persistent status region and transient notes | Wraps the panel body in one always-mounted `<div role="status" aria-live="polite">` that contains the outcome card and a `PanelNote`; the form and buttons are outside the live region. Provides context for action results (`message`, `ok`, `focus`) |
| `OutcomeCard` (server) | The player's current state in words | Headline plus detail lines: in, waitlisted (rank, groups ahead, passed-over explanation), withdrawn (fee outcome), blocked, closed. Text is the signal, never colour alone |
| `SessionSummary` (server) | Three summary lines | `<ul aria-label="Registration details">`: places, fee (with a nested fee list for BY_SEX and BY_SKILL_LEVEL), cancellation deadline |
| `RegisterForm` (client) | Party size, guests, total, submit | Controlled state for party and every guest field (survives React 19's post-action form reset), client validation, `ErrorSummary`, one submit button |
| `GuestFieldset` | One guest's details | `fieldset` legend "Guest {n}" containing the Sex group, the Skill level group and "Name (optional)"; ids `field-guest{n}Sex`, `field-guest{n}Skill`, `field-guest{n}Name` |
| `ChoiceGroup` | Compact radio group | `fieldset`/`legend`, options in a wrapping row, `min-h-11` labels, optional per-option `disabled` plus visible hint tied by `aria-describedby`, error and hint slots |
| `PartyTotal` (inside `RegisterForm`) | Total and predicted outcome | `role="status"` line "Total: {sum} for {n} people" plus the waitlist sentence when the group does not fit; uses the shared pure estimator |
| `WithdrawConfirm` (client) | Withdraw or Leave waitlist | Trigger button plus the shared confirm disclosure; wording from `withdrawPrompt(...)` |
| `ConfirmDisclosure` (client, extracted) | Presentational core of `InlineConfirm` | Trigger `aria-expanded`/`aria-controls`, `role="group"` panel, focus to prompt on open, Escape and Cancel return focus to the trigger; no manage-area context. `InlineConfirm` is rebuilt on top of it |
| `panelView` (lib) | State table | Pure function `(response, now) -> { kind, ... }` for open, full, registered, waitlisted, withdrawn, debt_blocked, closed, no_places, not_member; one table-driven unit test |

### Interactions
| Trigger | Action | Feedback |
|---------|--------|----------|
| Choose "Me + n guests" | Guest fieldsets for 1..n appear immediately after the party group; removed guests' typed values are kept in memory and return if the player picks the larger group again | No focus change. Live line: "Total: $34.00 for 2 people." Next Tab stop is Guest 1 |
| Choose a guest's sex or skill | Total recomputes (BY_SEX and BY_SKILL_LEVEL) | Live line updates; until every guest has the needed value the line says "Total so far: $17.00. Choose each guest's sex to see the rest." |
| Party does not fit the free seats | Button label flips to "Join waitlist" | Live line adds "This group goes on the waitlist. You're only charged if you get a place." |
| Party can never fit (size over public capacity) | That party option is `disabled` | Visible hint under the group: "This session has {capacity} public places, so a group of {n} can't register." |
| Press "Register" / "Join waitlist" with a field missing | No request. The summary appears and takes focus | `ErrorSummary` "There's a problem" with links to `#field-guest1Sex` etc.; field errors beside the fields |
| Press "Register" / "Join waitlist" (valid) | Server Action; button `aria-disabled`, label "Registering..." / "Joining waitlist..." | Page revalidates; outcome card replaces the form; focus to "Registration" heading; status region announces |
| Result differs from prediction | Same | Note above the card: "Places filled up while you were choosing, so you're on the waitlist." or "A place opened up, so you're in." |
| "Withdraw" / "Leave waitlist" | Opens the confirm disclosure; focus moves to the prompt text | `aria-expanded="true"`; the prompt says early or late wording, group size, and the fee rule |
| Confirm | Server Action re-checks the deadline against the wording shown (see Error States), then withdraws | Outcome card updates; the transient note gives the specific result; focus to heading |
| Cancel or Escape | Closes the disclosure | Focus returns to the trigger |
| Deadline crossed while open | No withdrawal; the confirm re-renders with the late wording and a one-line note | "The free cancellation deadline passed while you were reading. Check the details and confirm again." |
| Action in flight | Confirm and submit are `aria-disabled`, second activation ignored | No layout shift |
| 5xx / offline | Status region shows `OUTAGE_MESSAGE` | Form values and the open confirm stay; no sign-out |

Notes:
- The status wrapper is mounted from first render (empty or holding the outcome card), so the first change is announced. It contains the outcome card and notes only, never the form, so typing is never announced.
- Notices do not auto-dismiss (WCAG 2.2.1). They clear on the next action or navigation.
- Buttons keep short visible names with a longer accessible name that starts with the visible text when needed, e.g. "Withdraw from this session" (visible "Withdraw"), "Leave waitlist".
- Confirmation is not a modal: no focus trap, no `aria-modal`, rest of the page reachable. The confirm button is destructive red with its action name in text.

### Responsive Behavior
| Breakpoint | Changes |
|------------|---------|
| < 640px | One column; party radios stacked; guest fieldsets stacked; skill radios wrap to two rows; submit and confirm buttons full width; outcome and summary lines wrap; no horizontal scroll at 360 px |
| 640-1024px | Party radios in one row; guest fieldsets two columns; buttons content-width; confirm buttons side by side |
| > 1024px | Same as tablet inside `max-w-3xl`; no extra columns (the content has no wide form) |

### Accessibility Requirements
- [ ] Keyboard: all controls reachable in DOM order (heading, outcome, summary, party group, guests, total, button); Enter and Space activate; Escape closes an open confirm; arrow keys move within every radio group because focus never jumps on change
- [ ] Screen reader: `fieldset`/`legend` for the party group, each guest, and each guest's Sex and Skill groups; the outcome card sits inside one persistent `role="status"` region; the total line is its own `role="status"`; errors in `ErrorSummary` (focused once) and beside fields via `aria-describedby`; disabled party option described by visible text
- [ ] Contrast: reuse `slate-900/700`, `blue-800` links, `red-800` destructive; no colour-only status: every state has a headline in words ("You're in.", "You're on the waitlist (#3).", "Registration is closed.")
- [ ] Focus indicators: `FOCUS_RING` on every interactive element
- [ ] Error messages: field errors tied by `aria-describedby`, listed in the summary, typed values retained, errors never cleared by a failed submit
- [ ] Targets: every radio label, button and link is at least 44 px tall; text inputs 16 px; no `maxlength` attribute (the 100-character message must be reachable)
- [ ] Reflow: no horizontal scroll at 360 px; guest names use `break-words`
- [ ] No `window.confirm`, `alert` or `prompt`
- [ ] Page titles unchanged (owned by the session page)

### Panel states in words (what each shows)
| State (`panelView.kind`) | When | Outcome card | Action area |
|--------------------------|------|--------------|-------------|
| `open` | PUBLISHED, `now < starts_at`, no active registration, `overdueCount < 3`, party of 1 fits public capacity, not withdrawn | none | Register form |
| `confirmed` | CONFIRMED, before start | "You're in." plus group lines; promoted note if `promotedAt` | "Withdraw" |
| `waitlisted` | WAITLISTED, before start | "You're on the waitlist (#n)..." plus groups ahead and the passed-over explanation | "Leave waitlist" |
| `withdrawn` | WITHDRAWN, before start | Fee outcome from `withdrawalKind` and `withdrawalFeeDue` | Register form again (if not debt-blocked) |
| `debt_blocked` | no active registration, `overdueCount >= 3` | Debt message | none |
| `no_places` | public capacity is 0 | "This session has no public places." | none |
| `closed` | `now >= starts_at`, or COMPLETED or CANCELLED | Registration state in the past tense if any, then "Registration is closed." | none |
| `not_member` | 403 from the API | "You need to be a member of this team to register." | Link "View team page" |
| `load_error` | 5xx | "We can't load registration right now. Try again in a minute." | none |

An active registration beats the debt block: a registered player with 3+ overdue payments sees the normal confirmed or waitlisted state and can withdraw (withdrawal is never blocked by debt, AC-ERROR-1).

### Fee, seats and deadline lines
| Line | FLAT | BY_SEX / BY_SKILL_LEVEL |
|------|------|-------------------------|
| Fee | "Fee: $17.00 per person, charged after the game." | "Your fee: $20.00, charged after the game." then a nested list "Fees depend on sex: Male $20.00, Female $17.00, Other $18.00 (you: Male)" or "Fees depend on skill level: Beginner $15.00, Intermediate $17.00, Advanced $20.00 (you: Intermediate)". Guests are charged by their own sex or skill level |
| Fee when registered | "Fee: $51.00 for your group of 3, charged after the game." | Same wording with the estimated sum |
| Fee when waitlisted | "Charged only if you get a place." appended | same |
| Seats | "{n} of {capacity} places left" ; "{n} of {capacity} places left · {w} on the waitlist" when some seats are free and a group is waiting (those groups are bigger than the free seats) ; "Full · {w} on the waitlist" | same |
| Deadline | "Free cancellation until {Wed 5 Oct, 7:00 pm}." (inside `<time dateTime>`) or "The free cancellation deadline has passed." | same |
| Late-registration heads-up | Above the button, when `now > cancellation_deadline`: "The free cancellation deadline has passed. If you withdraw later you may be charged." | same |

"Place" always means a person (the registrant or a guest). The waitlist count is a count of sign-ups, which can be a group.

### Guest form details
- **Party group**: legend "Bringing guests?" radios "Just me" (preselected), "Me + 1 guest", "Me + 2 guests". Hint: "Everyone needs a place. Your whole group is confirmed or waitlisted together."
- **Guest fieldset** (legend "Guest 1", "Guest 2"):
  - Sex: Male, Female, Other (none preselected), inline radio row.
  - Skill level: Beginner, Intermediate, Advanced (none preselected), inline wrapping row, hint "Beginner is still learning the basics, Intermediate plays regularly, Advanced is experienced and competitive." (the same descriptions as `SKILL_OPTIONS`, joined, not repeated per option).
  - Name (optional): text input, hint "Only you and team admins see this name." No `maxlength` attribute.
  - Group hint above the first guest: "Sex and skill level are needed for every guest, even when the price is the same for everyone."
- **Retained values**: party size, guest sex, skill and name live in client state and are submitted from it, so React 19's form reset after an action never clears them. Server field errors map `guests.{i}.sex` to `field-guest{n}Sex` and so on.
- **Order**: the guest fieldsets are the next DOM siblings after the party group, so Tab order and reading order are party, Guest 1, Guest 2, total, button.

### Waitlist rank and the passed-over case
| Situation | What the card says |
|-----------|--------------------|
| Waitlisted, rank 1, no free seats | "You're on the waitlist (#1). We'll email you if a place opens up." and "You're first in line." |
| Waitlisted, rank n > 1 | The same headline and "{n-1} group(s) ahead of you." ("1 group is ahead of you." / "2 groups are ahead of you.") |
| Waitlisted and free seats exist (so this group is larger than the free seats, and smaller groups behind may be offered places first) | The above, plus: "Your group of {size} needs {size} places together and {free} {is/are} free. Smaller groups behind you may get places first; you keep your spot at the front." and, when `free >= 1`: "To get a place now, register with {free} or fewer people. Leaving the waitlist loses your spot." |
| Rank moves up between visits | No history is shown; the player sees the current rank. The email is the notification for a promotion |

The explanation uses only data already in the GET response (`waitlistRank`, `guestCount`, `seatsLeft`). Sizes and names of other groups are never shown. The "register with fewer people" tip is information, not a button: re-registering means leaving first, and the player decides.

## Implementation Guidelines

### For Developers
1. **Server vs client**: `RegistrationPanel`, `OutcomeCard`, `SessionSummary` and `panelView` are server-side and pure. Only `RegisterForm`, `WithdrawConfirm`, `ConfirmDisclosure` and `RegistrationShell` are `'use client'`. The panel fetch uses the same pattern as the manage page (`requireUser`, bearer token via `api-client`, `Cache-Control: no-store`, `dynamic = 'force-dynamic'`).
2. **One state function**: `panelView(response, now)` in `lib/registrations/view.ts` returns `{ kind, ... }`; all copy comes from `lib/registrations/labels.ts`. The server component contains no conditionals beyond switching on `kind`. Test it as one table (one row per state, including the debt-beats-nothing and registered-beats-debt rows).
3. **Server Actions** in `lib/registrations/actions.ts` (`'use server'`, no JSX): `registerAction(prev, formData)` and `withdrawAction(prev, formData)`, each returning `{ ok, status?, waitlistRank?, message?, fieldErrors?, code?, refresh }` and ending with `revalidatePath` of the session page on success and on 409. Never optimistic; a 5xx keeps the form and the open confirm. Map codes to copy through `labels.ts` (table below). The register action maps flat field names (`guest1Sex`, `guest1Skill`, `guest1Name`, `guest2...`) to the API's `guests: [{ sex, skillLevel, displayName }]` and trims the name (empty becomes absent).
4. **Typed-value retention**: keep party and guest fields in `useState` inside `RegisterForm`; build the submitted `FormData` from that state. If `useAuthForm` can carry flat names without change, reuse it for submit, `ErrorSummary` focus and `clientFailure`; otherwise wrap the same pieces. Do not rely on `defaultValue` after a React 19 action, because the form is reset.
5. **Fee estimate**: a pure `estimateTotal(fees, pricingStructure, registrant, guests)` using `Money` helpers (no `number` arithmetic, P2) in `packages/shared/src/registrations/fees.ts`, imported by both the API (`fees.ts` tests) and the web form. The web value is labelled an estimate on BY_SEX and BY_SKILL_LEVEL sessions.
6. **Withdraw action re-check**: before calling `POST .../me/withdraw`, the action reads `GET .../registration` and compares the classification (`now <= cancellationDeadline`) with the `expectedKind` hidden field rendered with the prompt. A mismatch returns `{ ok: false, code: 'deadline_changed' }` without withdrawing. The preferred long-term fix is an optional `expectedKind` on the withdraw body so the API compares inside the transaction (architecture agent's call; the web re-check is the floor).
7. **`ConfirmDisclosure`**: extract the presentational part of `InlineConfirm` (trigger, panel, focus, Escape, destructive style, pending label) into `components/teams/confirm-disclosure.tsx`; `InlineConfirm` composes it and keeps its manage-context wiring unchanged, so existing manage tests stay green. `WithdrawConfirm` composes the same core with the registration status context. Allow a "single open" scope of one (there is one confirm per panel).
8. **Focus**: after a successful register or withdraw, focus `#registration-heading` (`tabIndex={-1}`); after Cancel or Escape, the trigger; after a failed submit, `ErrorSummary`; never on party change.
9. **Dates and money**: `formatNzDateTime` and `formatNZD` only; `<time dateTime>` with the UTC instant. No `Intl` or `Date` arithmetic in the component (P3). `now` for `panelView` comes from the server clock once per render.
10. **Do not hide a control as a guard**: the form and buttons are conveniences, the API enforces every rule (hidden form for debt or closed, but the routes still refuse).
11. **Ban copy**: change `banPrompt` and the ban success message in `lib/teams/labels.ts` (and `moderation.ts` where the success text is built) and update the four places that assert the old wording (see Spec Amendments).
12. **Add `/teams/*/sessions/*` to `proxy.ts` `PROTECTED`**, with `Cache-Control: no-store` on the session page (it contains the player's guests).

### Copy (exact strings, to live in `apps/web/src/lib/registrations/labels.ts`; `{}` are inserted values)
| Where | Copy |
|-------|------|
| Panel heading | "Registration" |
| Seats, free | "{n} of {capacity} places left" |
| Seats, free with a waiting group | "{n} of {capacity} places left · {w} on the waitlist" |
| Seats, full | "Full · {w} on the waitlist" |
| Fee, FLAT | "Fee: {fee} per person, charged after the game." |
| Fee, BY_SEX / BY_SKILL_LEVEL | "Your fee: {fee}, charged after the game." |
| Fee list intro, BY_SEX | "Fees depend on sex. Guests are charged by their own sex." |
| Fee list intro, BY_SKILL_LEVEL | "Fees depend on skill level. Guests are charged by their own skill level." |
| Fee list row | "{Male}: {fee}" with " (you)" appended on the player's row |
| Fee, registered | "Fee: {total} for your group of {n}, charged after the game." (solo: "Fee: {fee}, charged after the game.") |
| Fee, waitlisted suffix | "Charged only if you get a place." |
| Deadline, before | "Free cancellation until {Wed 5 Oct, 7:00 pm}." |
| Deadline, after | "The free cancellation deadline has passed." |
| Late registration heads-up | "The free cancellation deadline has passed. If you withdraw later you may be charged." |
| Party legend | "Bringing guests?" |
| Party hint | "Everyone needs a place. Your whole group is confirmed or waitlisted together." |
| Party options | "Just me", "Me + 1 guest", "Me + 2 guests" |
| Party option disabled hint | "This session has {capacity} public places, so a group of {n} can't register." |
| Guest group hint | "Sex and skill level are needed for every guest, even when the price is the same for everyone." |
| Guest legend | "Guest {n}" |
| Guest sex legend / error | "Sex" / "Choose Guest {n}'s sex." |
| Guest skill legend / hint / error | "Skill level" / "Beginner is still learning the basics, Intermediate plays regularly, Advanced is experienced and competitive." / "Choose Guest {n}'s skill level." |
| Guest name label / hint / error | "Name (optional)" / "Only you and team admins see this name." / "Use 100 characters or fewer." |
| Total, FLAT | "Total: {sum} for {n} people." (solo: "Total: {sum} for 1 person.") |
| Total, BY_* complete | "Estimated total: {sum} for {n} people." |
| Total, BY_* incomplete | "Total so far: {sum}. Choose each guest's {sex or skill level} to see the rest." |
| Waitlist prediction | "This group goes on the waitlist. You're only charged if you get a place." |
| Submit buttons | "Register" / "Join waitlist"; pending "Registering..." / "Joining waitlist..." |
| Registered headline | "You're in." |
| Group line | "Your group: you + {n} guest(s) ({places} places)" |
| Guest line | "Guest {n}: {name, or nothing}, {Sex}, {Skill}" (name omitted when empty) |
| Promoted note | "You were moved off the waitlist on {Wed 5 Oct, 7:00 pm}." |
| Promoted after the deadline | "The free cancellation deadline has passed. If you can't play, withdraw here: you won't be charged if someone from the waitlist takes your place, otherwise the fee applies." |
| Waitlisted headline | "You're on the waitlist (#{rank}). We'll email you if a place opens up." |
| Waitlisted position | rank 1: "You're first in line." ; rank n: "1 group is ahead of you." / "{n-1} groups are ahead of you." |
| Passed over | "Your group of {size} needs {size} places together and {free} {is/are} free. Smaller groups behind you may get places first; you keep your spot at the front." |
| Passed-over tip | "To get a place now, register with {free} or fewer people. Leaving the waitlist loses your spot." |
| Withdrawn, EARLY or LATE with no fee | "You withdrew from this session. You won't be charged." |
| Withdrawn, LATE with fee due | "You withdrew from this session after the free cancellation deadline and no one took your place, so the {fee} fee will be charged after the game." (group: "...the {fee} fee for your group of {n} will be charged after the game.") |
| Debt block | "You have {n} overdue payments. Pay them before registering for more sessions. If you think this is wrong, ask your team admin." |
| No public places | "This session has no public places." |
| Closed | "Registration is closed." |
| Closed, waitlisted | "The session has started and you didn't get a place. Registration is closed." |
| Closed, COMPLETED | "This session has finished. Registration is closed." |
| Closed, CANCELLED | "This session was cancelled." |
| Not a member | "You need to be a member of this team to register." with link "View team page" |
| Panel load error | "We can't load registration right now. Try again in a minute." |
| Panel loading (`loading.tsx`) | `role="status"` "Loading registration..." |
| Withdraw trigger | "Withdraw" (accessible name "Withdraw from this session") |
| Withdraw prompt, early | "Withdraw from this session? You won't be charged." Group: "Withdraw from this session? This withdraws your whole group (you and {n} guest(s)). You won't be charged." |
| Withdraw prompt, late, nobody waiting | "The free cancellation deadline has passed and no one is waiting for a place, so you'll be charged {fee}. Withdraw anyway?" Group: "...so you'll be charged {fee} for your group of {n}. Withdraw anyway?" |
| Withdraw prompt, late, waitlist non-empty | "The free cancellation deadline has passed. If a waitlisted player takes your place you won't be charged. Otherwise you'll be charged {fee}." Group: "...Otherwise you'll be charged {fee} for your group of {n}. This withdraws your whole group." |
| Withdraw confirm / cancel | "Withdraw" / "Cancel"; pending "Withdrawing..." |
| Leave waitlist trigger / prompt | "Leave waitlist" / "Leave the waitlist? You won't be charged. If you change your mind you can join again, but you'll go to the back of the line." |
| Leave confirm / cancel | "Leave waitlist" / "Cancel"; pending "Leaving..." |
| Deadline changed (re-check) | "The free cancellation deadline passed while you were reading. Check the details below and confirm again." |
| Result, registered | "You're in." |
| Result, waitlisted | "You're on the waitlist (#{rank}). We'll email you if a place opens up." |
| Result, race to waitlist | "Places filled up while you were choosing, so you're on the waitlist (#{rank}). We'll email you if a place opens up." |
| Result, race to a place | "A place opened up, so you're in." |
| Result, withdrawn early | "You've withdrawn. You won't be charged." |
| Result, withdrawn late, replaced | "You've withdrawn. A player from the waitlist took your place, so you won't be charged." |
| Result, withdrawn late, nobody | "You've withdrawn. No one could take your place, so the {fee} fee will be charged after the game." |
| Result, left waitlist | "You've left the waitlist." |
| Error, already registered | "You're already registered for this session." |
| Error, not registered | "You're not registered for this session." |
| Error, session closed | "Registration for this session is closed." |
| Error, forbidden | "You need to be a member of this team to register." |
| Error, outage | `OUTAGE_MESSAGE` ("Something went wrong on our side. Your details are still here. Try again in a minute.") |
| Ban prompt (`banPrompt`, final) | "Ban {Full name}? They lose access to this team and can't register for its sessions. Their upcoming registrations will be cancelled." |
| Ban success (final) | "{Full name} has been banned. Their upcoming registrations are being cancelled." |

### Component Structure
```
apps/web/src/
├── app/teams/[teamId]/sessions/[sessionId]/
│   ├── page.tsx                         (minimal session page if the scheduling engine ships none: heading + panel)
│   ├── loading.tsx
│   └── error.tsx                        (panel load error, same pattern as app/teams/error.tsx)
├── components/registrations/
│   ├── registration-panel.tsx           (server: fetch result in, panelView out)
│   ├── registration-shell.tsx           (client: persistent status region, PanelNote, action-result context)
│   ├── outcome-card.tsx                 (server: state headline and detail lines)
│   ├── session-summary.tsx              (server: places, fee, deadline lines)
│   ├── register-form.tsx                (client: party, guests, PartyTotal, submit)
│   ├── guest-fieldset.tsx               (one guest: sex, skill, name)
│   ├── choice-group.tsx                 (compact inline radio group)
│   ├── withdraw-confirm.tsx             (client: Withdraw / Leave waitlist on the confirm core)
│   ├── registrations-components.test.tsx
│   └── registration-panel.test.tsx
├── components/teams/
│   ├── confirm-disclosure.tsx           (client: extracted presentational core)
│   └── inline-confirm.tsx               (existing; recomposed on confirm-disclosure.tsx, behaviour unchanged)
└── lib/registrations/
    ├── actions.ts                       (Server Actions, no JSX)
    ├── labels.ts                        (copy deck above, plural and date helpers)
    ├── view.ts                          (panelView: the state table)
    ├── validation.ts                    (client guest validation, flat field names)
    ├── actions.test.ts
    ├── labels.test.ts
    ├── view.test.ts
    └── validation.test.ts
packages/shared/src/registrations/
├── fees.ts                              (estimateTotal / unitFeeFor, Money only)
└── fees.test.ts
```
Every extension follows `systemPatterns.md` Code Organization: `.tsx` for rendering under `app/**` and `components/**`; `.ts` for hooks, helpers and actions under `lib/**` and `packages/shared`; `.test.ts` co-located; component tests `.test.tsx` as `teams-components.test.tsx` does.

### Recommended Libraries/Patterns
- No new dependency. `useActionState` as in `useAuthForm`; native `<form action>`; disclosure confirm (button with `aria-expanded` and `aria-controls`); persistent `role="status"` region; `ErrorSummary` for client and server validation.
- `aria-disabled` for pending buttons (as `BUTTON_CLASS` styles it); native `disabled` for a party radio that can never be chosen (an `aria-disabled` radio can still be selected by arrow keys).
- Table-driven tests for `panelView`, `withdrawPrompt` (early, late with and without waitlist, group or solo), the fee and total lines and the result-message chooser. One Playwright axe scan per state (open, full, registered, waitlisted, withdrawn with and without fee, debt-blocked, closed) on both projects.

## Validation Checklist

- [x] Meets all user goals (one-tap solo registration, visible cost, visible state, safe withdrawal, informed ban)
- [x] Accessible per requirements (fieldset/legend, `aria-describedby`, 44 px, no colour-only status, 360 px, no native dialogs; focus rule amended for radio-group safety)
- [x] Consistent with existing patterns (auth styles, `OptionFieldset` conventions, `ErrorSummary`, disclosure confirm, status regions, `labels.ts` deck)
- [x] Respects Guiding Principles and component architecture in systemPatterns.md (P1 API is the authority, P2 money via `Money`, P3 display-only Auckland; Server Component with small client islands)
- [x] Responsive across devices (wireframes and breakpoints above)
- [x] Performance acceptable (one server fetch; client islands hold form state and a pure estimate)
- [x] Implementation feasible (no new dependency; one extraction from `InlineConfirm`; one shared pure fee function)

## Next Steps

1. Fold the Spec Amendments into the task file's ACs, and the extra files into the Phase 5 file list.
2. Phase 5: build `panelView` and `labels.ts` first (pure, table-tested), then `ConfirmDisclosure` extraction with the manage tests unchanged, then `RegisterForm`/`GuestFieldset`/`ChoiceGroup`, the server pieces, and the Server Actions.
3. Phase 5: restore the ban copy (`banPrompt` and the success line) and update the four assertion sites in the same commit.
4. Phase 6: Playwright journeys including the deadline-crossing case, the passed-over card and a 360 px pass for each panel state, with axe scans.
5. Run `/yay:ux-ingest` after this feature so `ux-patterns.md` records the confirm-disclosure core, the persistent outcome region and the "no focus jump on radio change" rule.
6. When player-dashboard ships, replace the debt-block "ask your team admin" tail with a link to the Payments tab (one `labels.ts` and `OutcomeCard` change).

## Spec Amendments

AC id to change (minimal and concrete). The task file is not edited here.

1. **AC-VERIFY-8 (guest focus)**: replace "guest fieldsets are announced when they appear (focus moves to 'Guest 1')" with "focus does not move when the party size changes; the guest fieldsets are the next siblings after the party group so the next Tab stop is 'Guest 1'; the total line (`role="status"`) announces the change; on a failed submit focus moves to the error summary". Reason: moving focus on a radio change breaks arrow-key selection and is a context change on input.
2. **AC-VERIFY-8 (confirmations)**: "confirmations use `InlineConfirm`" becomes "confirmations use the inline disclosure pattern (`ConfirmDisclosure`, the presentational core extracted from `InlineConfirm`; `InlineConfirm` is coupled to the manage area context)". Add files `components/teams/confirm-disclosure.tsx` to the plan.
3. **AC-ENTRY-1, AC-HAPPY-2**: the line reads "Total: {sum}" for FLAT sessions and "Estimated total: {sum}" for BY_SEX and BY_SKILL_LEVEL, with the people count ("for 3 people"); incomplete guest choices show "Total so far: ..."; add the waitlist prediction sentence and the Register/Join waitlist label flip as part of the live total status.
4. **AC-ENTRY-1 (seats line)**: add the variant "{n} of {capacity} places left · {w} on the waitlist" when seats are free and a group is waiting. Fee line gains the fee list for BY_SEX and BY_SKILL_LEVEL (all three values, the player's own row marked "(you)"). The `GET` response must therefore expose every per-type fee (`session.fees`) and a per-registration `estimatedTotal` for an existing party (including a withdrawn row).
5. **AC-HAPPY-3, AC-ASYNC-4 (waitlisted display)**: the waitlisted card also shows "You're first in line." or "{n-1} group(s) ahead of you.", and, when `seatsLeft >= 1`, the passed-over explanation and tip. No API change (uses `waitlistRank`, `guestCount`, `seatsLeft`).
6. **AC-HAPPY-4, AC-HAPPY-5, AC-HAPPY-6 (withdraw prompts)**: prompts gain group wording when `guestCount > 0` ("This withdraws your whole group (you and {n} guests)") and the late prompt splits by waitlist: when `waitlistLength == 0` the prompt states the charge outright ("...no one is waiting for a place, so you'll be charged {fee}. Withdraw anyway?"), otherwise the AC-HAPPY-5 wording. Fee strings say "for your group of {n}" when guests exist. AC-HAPPY-7's prompt adds "You won't be charged. If you change your mind you can join again, but you'll go to the back of the line." and is the same before and after the deadline.
7. **AC-HAPPY-4 to 7 (persistent withdrawn state)**: the withdrawn card text is: EARLY or LATE with `withdrawalFeeDue = false` -> "You withdrew from this session. You won't be charged."; LATE with fee due -> the fee sentence. The "A player from the waitlist took your place" wording appears only in the transient result message (the GET cannot tell a late leave from a late withdrawal).
8. **New AC-ERROR-10 (deadline crossed while the confirm is open)**: Given the withdraw confirm rendered with the early wording and the clock then passes `cancellation_deadline`, when the player confirms, then nothing is withdrawn, the confirm re-opens with the late wording and the note "The free cancellation deadline passed while you were reading. Check the details below and confirm again." (web re-check of the classification; optionally also an `expectedKind` on the withdraw body so the API compares inside the transaction, architecture agent's decision).
9. **AC-ERROR-4**: "the 'Me + 2 guests' option is `aria-disabled` with that hint" becomes "the over-size party option is natively `disabled` with the hint as visible text tied by `aria-describedby`". When public capacity is 0 the form is not rendered: "This session has no public places."
10. **AC-ERROR-2 (closed copy)**: add "The session has started and you didn't get a place. Registration is closed." for a waitlisted player after start, "This session has finished. Registration is closed." for COMPLETED, and "This session was cancelled." for CANCELLED (what happens to registrations on cancel remains session-scheduling-engine's).
11. **AC-ERROR-1 (debt copy)**: the page shows the API message plus "If you think this is wrong, ask your team admin." (no payments link until player-dashboard). The API string is unchanged. A registered or waitlisted player with 3+ overdue payments still sees their registration and the withdraw action.
12. **AC-ASYNC-4 (promoted after the deadline)**: when `promotedAt > cancellationDeadline` the card also shows "The free cancellation deadline has passed. If you can't play, withdraw here: you won't be charged if someone from the waitlist takes your place, otherwise the fee applies."
13. **AC-ERROR-5**: keep the API `fieldErrors` keys (`guests.{i}.sex` etc.); the web maps them to ids `field-guest{n}Sex`, `field-guest{n}Skill`, `field-guest{n}Name`; typed values are retained by controlled client state (React 19 resets uncontrolled forms after an action).
14. **AC-ENTRY-2 (page copy)**: the non-member message is followed by a link "View team page" (`/teams/[teamId]`).
15. **AC-HAPPY-10 (ban copy)**: confirm the AC's prompt as final: "Ban {Full name}? They lose access to this team and can't register for its sessions. Their upcoming registrations will be cancelled." Add the success message "{Full name} has been banned. Their upcoming registrations are being cancelled." (eventual cancellation, so present continuous). Update `banPrompt` and the success text in `lib/teams/labels.ts` and `moderation.ts`, plus the assertions in `labels.test.ts`, `moderation.test.ts`, `manage-components.test.tsx` and `e2e/teams.spec.ts`.
16. **Plan, Phase 5 file list**: add `app/teams/[teamId]/sessions/[sessionId]/{loading,error}.tsx`, `components/registrations/{registration-shell,outcome-card,session-summary,choice-group,withdraw-confirm}.tsx`, `components/teams/confirm-disclosure.tsx`, `lib/registrations/{view,validation}.ts`, `packages/shared/src/registrations/fees.ts` (shared pure estimator so API and web agree, P2), and their tests. Add the web paths to the coverage gate (already AC-VERIFY-9).
17. **Flag for the algorithm agent (not decided here)**: AC-HAPPY-8 resets `withdrawal_fee_due` on re-registration. A player who withdrew late with no replacement can re-register onto the waitlist (liability cleared) and then leave the waitlist for free, erasing the fee. The UI makes no promise about this either way; the rule should be settled alongside creative question 3.
