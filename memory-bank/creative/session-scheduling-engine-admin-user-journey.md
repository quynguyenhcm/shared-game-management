# User Journey Design: Session Scheduling Engine (team admin)

**Created**: 2026-10-20
**Status**: DECIDED
**Decision Type**: User Journey
**Task**: `session-scheduling-engine` (Level 4). Spec: `memory-bank/tasks/session-scheduling-engine.md` (approved 2026-10-20), branch `feature/session-scheduling-engine`.
**Answers**: Creative C2 (series versus instance editing, the "Edited" marker, what a series save reports, the first-materialisation wait, moving between series and instance), C3 (telling players about cancellations and changes), conflict 3 from the admin's view (Auto Enroll for one-off sessions, manual publish of recurring drafts), conflict 8 from the admin's view (the derived "Ended" label, cancel only before start), and the journeys for the banking-refused paths, read-only closed sessions and stale saves.
**Runs beside**: the Algorithm doc (A1-A5, conflicts 2, 5, 6, 10) and the Architecture doc (B1-B5, conflicts 1, 4, 9), written in parallel. Neither existed when this was written. Where the journey depends on their rulings, it is designed for the likely options, and each dependency is listed in [Hand-offs and assumptions to reconcile](#hand-offs-and-assumptions-to-reconcile).
**Consumed by**: the UI/UX doc (C1, C4, C5), which runs after this one. Every copy string here is **provisional**. The UI/UX doc sets final wording, layout and the 360 px behaviour. This doc fixes the states, the transitions, what each state must tell the admin, and which facts the API must return so the copy can be true.
**Basis**: `main` at 1ee4520. Web conventions are reused from `team-management-teams-user-journey.md`, `team-banking-and-gst-payout-setup-user-journey.md` and `skill-levels-and-auto-enroll-admin-journey-user-journey.md`:
- one task per URL;
- Server Actions with in-place `FormState` errors, and `redirect(..., RedirectType.replace)` with a codes-only `?notice=` on success, text from a copy deck, stripped after render (`StripAuthParams`);
- `FormBanner` focused once; `ErrorSummary` plus field errors;
- `InlineConfirm` disclosures, never `confirm()` or `<dialog>`;
- the reload-or-keep rule: reload when the server state is known to have changed, keep the typed input when the outcome is unknown (`SAVE_FAILED_MESSAGE`, `UNCONFIRMED_MESSAGE`, `OUTAGE_MESSAGE` in `apps/web/src/lib/teams/labels.ts`);
- `NoAccess` on 403, `sessionExpiredUrl` on 401, `requireUser(here)`;
- the banking hand-off (`bankingReturnTo`, "Back to your session"), already built on `main`.

`memory-bank/ux-patterns.md` does not exist on `main`.

---

## Journey Overview

**Feature**: A team admin sets up the club's sessions in a new **Sessions** area of the manage pages. They create one-off sessions and recurring series, set up many courts quickly, cost each session, choose how players are priced, publish, change one date without breaking its series, change a whole series, cancel sessions and end series. A background job adds and publishes the series' sessions, and adds members who are on Auto Enroll.

**Primary Persona**: Team Admin (`TEAM_ADMIN`, APPROVED).
**Journey Type**: Hybrid.
- Synchronous: one-off create, save, publish, cancel; instance edit; series edit for sessions that already exist (assumption H3).
- Asynchronous: the first materialisation after a series is created or changed (about 5 s), the daily 03:00 run, the banking-refused drafts and the admin email, and the retry of those drafts once banking is set up.

**Orchestration Pattern**: **Scope-by-URL hub** (Option 1 below).
- A Sessions list.
- A **series page** that shows its sessions first and its details second. The details are a summary until the admin presses "Change series details", which switches to edit mode in the URL (`?edit=details`), as the banking page does.
- One **session editor** page for a one-off session or one date of a series. A scope line at the top says which of the two it is.
- The URL decides what a save changes. No save ever asks "this date or the whole series?".
- Destructive or far-reaching actions (publish a paid session, create a series, cancel, end a series) sit behind `InlineConfirm` prompts that state the consequence in numbers.

### Success Statement
> An admin sets up "Wednesdays at Rosedale" once (nine courts, Court 7 finishing an hour early, $12 a head), confirms that its sessions will open for registration as they are added, and a few seconds later sees five Wednesdays listed as Published. Later they cut one Wednesday to six courts, see it marked "Edited", move the series to 7 pm, and are told "4 upcoming sessions updated. 1 edited session kept its own details." Nothing has to be retyped, and no player is charged for a session they were not told about.

### Journey principles (binding on the UI/UX doc)
1. **The URL is the scope.** The series page changes the series. The session page changes one date. The heading and scope line always name which one.
2. **Banking blocks going live with a charge, never saving.** A refusal from the publish gate never loses typed work. A manual publish saves first. A materialiser refusal saves a draft. A series save is never refused because of banking (assumption H4).
3. **Tell the admin in numbers before and after.** Before a far-reaching action, the prompt says how many sessions or players it affects. After it, the banner repeats the counts.
4. **Copy must stay true in every rollout state.** Until registration-and-waitlist ships, no one can be registered, emailed or auto-enrolled. The copy uses counts the API returns (registrations, emails sent), so it never claims an effect that did not happen.
5. **The Drafts section lists only what waits on the admin.** Banking-refused drafts, edited drafts and the admin's own one-off drafts belong there. Sessions that will publish themselves do not.
6. **Once a session starts, it is locked.** Started, ended, completed and cancelled sessions are read-only and say why in one line.

---

## Persona Context

### Primary User
- **Who**: Team Admin (productBrief Key Personas: "sessions and pricing"). Example: Aroha, a volunteer organiser for a 36-player badminton club that hires 9 courts at Rosedale every Wednesday.
- **Goal**: set the regular night up once, charge enough to cover the court hire, change one night (for example, three courts are lost to a tournament) without wrecking the rest, and open sessions without spreadsheets.
- **Context**: a laptop at home on Sunday evening for setup. A phone at the venue or on the bus for quick changes (a cancellation, an extra court). Interrupted often.
- **Proficiency**: comfortable with the People and Banking pages, and with calendar apps. Has never used a recurrence editor that distinguishes "edited" dates. Will not read help text longer than one line. Thinks about money in whole dollars per head.
- **Mental model**: "The series is my standing booking. A date is one night of it. If I change one night, that night is special. If I change the booking, every normal night follows." Auto Enroll is "my regulars' standing booking" (skill-levels journey).

### Secondary Users
- **Co-admin**: may edit the same session or series at the same time (stale-save path). Receives the materialiser's "bank account needed" email.
- **Player** (APPROVED member): sees nothing from this feature. The player page and the team-page "Upcoming sessions" list belong to registration-and-waitlist (page-ownership Q5). Players are affected by what admins do here: publishing, cancelling and changing sessions, and Auto Enroll registrations. The emails that tell them are **triggered here and written by registration-and-waitlist** (decision C3).
- **Later features**: registration-and-waitlist (allocator port, notifier port, player page), wallet-and-akahu-billing (moves sessions to COMPLETED, which replaces the derived "Ended" label).

---

## Journey Map

### Entry Points

| Entry | Context | User intent | AC |
|---|---|---|---|
| Area nav "Sessions" (`People · Banking and GST · Sessions`) | Every manage page | "Set up or change sessions" | AC-ENTRY-1 |
| "New session" button | Sessions list header | "One night: a tournament, a holiday special" | AC-ENTRY-2, AC-HAPPY-1 |
| "New recurring series" button | Sessions list header | "Our regular night" | AC-ENTRY-2, AC-HAPPY-5 |
| A row in Upcoming, Drafts or Past and cancelled | Sessions list | "Change or cancel this night" | AC-ENTRY-2 |
| A row in Series | Sessions list | "Change the regular night, or see its dates" | AC-ENTRY-2 |
| A session row on the series page | Series page | "Change just this Wednesday" | AC-HAPPY-6 |
| Banking banner link on the list or series page | After a materialiser refusal | "Fix what stopped my sessions going live" | AC-ASYNC-3 |
| Admin email "Sessions not published ... bank account needed" | Inbox | Same as above. Links to `/teams/T/manage/banking` (ADR 0016 recurrence point 5) | AC-ASYNC-3 |
| "Back to your session" on the banking page | After saving banking with `returnTo` | "Go back and publish" | AC-ERROR-1 |

Not entry points in this feature: the player session page (registration-and-waitlist; once it exists, an admin-only "Edit session" link after `RegistrationPanel` is allowed by the slot contract and is a later addition), and the People page (no sessions banner there, as with banking).

### Page inventory and URL grammar

| URL | Scope | States |
|---|---|---|
| `/teams/T/manage/sessions` | Team | L1 list (with sections), L2 banking banner present |
| `/teams/T/manage/sessions/new` | New one-off | N1 empty form, N2 form with errors |
| `/teams/T/manage/sessions/[sessionId]` | One session (one-off or one date of a series) | E1 draft, E2 published (not started), E3 read-only (started, ended, completed, cancelled, expired draft) |
| `/teams/T/manage/sessions/series/new` | New series | S0 empty form, S0e form with errors, S0c create confirm open |
| `/teams/T/manage/sessions/series/[ruleId]` | One series | S1 waiting for sessions, S2 sessions listed, S2b banking drafts, S2r banking ready with drafts, S3 edit mode (`?edit=details`), S4 ended |

Query grammar: `notice` (closed list, see [Copy deck](#copy-deck-provisional)), `edit` (series page only, closed list `details`), and `count`, `edited`, `emailed`, `cancelled` (small integers carried with a notice for the banner counts, validated as integers 0..999, anything else dropped). Counts in the URL are display-only and never trusted for anything else. The alternative is to re-read the counts from the series GET (`lastChange` summary, assumption H3), which the UI/UX doc may prefer.

### State diagrams

#### Lifecycle as the admin sees it (labels, not DB states)

```
                         ┌──────────── Save draft ─────────────┐
[New session form] ──────┤                                     ▼
                         └── Save and publish ──▶ (gate) ──▶ [Published] ──starts_at──▶ [Started] ──ends_at──▶ [Ended]
                                                   │ refused        │                                          │
                                                   ▼                │ Cancel (before start only)               │ billing (later)
                                              [Draft]  ◀────────────┘                                          ▼
                                                   │  Save and publish (gate)                            [Completed]
                                                   │  Cancel ─────────────────▶ [Cancelled]
                                                   └── starts_at passes ──▶ [Not published · date passed] (read-only)

Series dates:
[Series saved] ──job (~5 s)──▶ date added ──gate ok──▶ [Published] ──(as above)
                                     │ gate refused
                                     ▼
                         [Draft · bank account needed] ──banking set up + next run, or "Publish drafts now", or manual Publish──▶ [Published]
                                     │ admin edits it
                                     ▼
                         [Draft · Edited] (never auto-published: ADR 0016 recurrence point 6) ──manual Publish──▶ [Published]
```

"Started" and "Ended" are **derived labels**. The DB status stays PUBLISHED until billing completes the session (conflict 8). The API returns a `phase` (`upcoming`, `started`, `ended`) computed with the server clock, so web and API never disagree (hand-off H8).

If the Algorithm doc adds a publish lead time (assumption H2), a materialised date that is not yet open is labelled **"Scheduled · opens {Mon 26 Oct}"**. It is listed under Upcoming, not Drafts, because it needs nothing from the admin.

#### Series page states

```
[S0 New series form] ──Create series──▶ [S0c confirm: "Create this series? ..."] ──Create series──▶ POST
       ▲                                         │ Keep editing                          │ 422 → S0e (values kept)
       └─────────────────────────────────────────┘                                       ▼
                                                     redirect ?notice=series_created → [S1 waiting]
[S1 waiting] ──auto refresh at ~2 s, 5 s, 10 s (bounded), or "Refresh"──▶ materialisation.state = ready?
       │ yes → [S2 sessions listed] (+ S2b if any banking-refused drafts)
       │ no after ~15 s → [S1 slow: "This is taking longer than usual ..."] (manual Refresh only)
       └ ready, 0 sessions (first date beyond horizon) → [S2 empty: "The first one, {date}, will be added on {date}."]

[S2] ──"Change series details"──▶ [S3 ?edit=details: form + effect line] ──Save series──▶ PUT
                                        │ Cancel → S2                          │ 409 series_stale → S3 reloaded with latest + banner
                                        │                                      │ 422 → S3 (values kept)
                                        ▼                                      ▼
                                                               redirect ?notice=series_saved&count&edited → [S2 + report banner]
                                                               (new dates still to add → S1-style waiting line under the banner)
[S2b banking drafts] ──"Set up banking and GST" (returnTo=series page)──▶ banking page ──save──▶ "Back to your session" ──▶ [S2r]
[S2r banking ready, drafts remain] ──"Publish drafts now"──▶ enqueue rule run ──▶ [S1-style "Publishing the drafts ..."] ──▶ [S2]
[S2] ──"End series" ──▶ confirm (last date, optional "also cancel published after") ──▶ [S4 ended + banner]
[S2] ──a date row "Edit Wed 4 Nov"──▶ session editor (instance scope) ──"Back to {series name}"──▶ [S2]
```

#### Session editor states

```
[E1 draft] ──Save draft──▶ PUT ──▶ ?notice=draft_saved (E1)
    │  ──Save and publish──▶ (paid: confirm "Publish this session? ...") ──▶ PUT then POST /publish
    │                             ├─ ok ──▶ ?notice=published (E2)
    │                             ├─ 409 payout_not_configured ──▶ ?notice=publish_refused_banking (E1; alert focused; link with returnTo)
    │                             ├─ 422 incomplete pricing / no court ──▶ E1 with field errors (the save part already committed: "Draft saved." line + errors)
    │                             └─ 409 session_started ──▶ E3 expired draft
    │  ──Cancel session──▶ confirm ──▶ ?notice=cancelled (E3 cancelled)
[E2 published] ──Save changes──▶ PUT ──▶ ?notice=changes_saved (+ emailed / promoted counts)
    │  ──Cancel session──▶ confirm (states registrations count) ──▶ ?notice=cancelled (E3)
    └─ starts_at passes ──▶ E3 started (next load; a form posted after start gets 409 session_started → reload E3)
Any save: 409 session_stale ──▶ reload with latest values + banner. 409 session_not_editable ──▶ reload E3 + banner.
          5xx ──▶ keep values + SAVE_FAILED_MESSAGE. No answer ──▶ keep values + UNCONFIRMED_MESSAGE.
```

---

## Step-by-Step Journey

### Journey A: One-off session, created and published (AC-HAPPY-1..4, AC-HAPPY-11, AC-ERROR-1, AC-ERROR-2, AC-ERROR-4)

#### Step A1: Sessions list
- **System**: web page `manage/sessions/page.tsx`; API `GET /teams/T/sessions?view=...` and `GET /teams/T/session-series`.
- **User sees**:
  - The area nav with "Sessions" current.
  - H1 "Sessions for {team name}".
  - A one-line intro.
  - The buttons "New session" and "New recurring series", with a hint under them: "A series adds its sessions for you and adds members on Auto Enroll. One-off sessions don't."
  - The sections Upcoming, Drafts, Series, Past and cancelled. Each has an empty-state line when empty.
  - Each session row shows the date (NZ format), the time range from the earliest court start to the latest court end, the location, the court count and a status label. A series date also shows "Series: {series name}" and an "Edited" tag when overridden.
  - The banking banner (state L2) when any series has banking-refused drafts.
- **User actions**: either button, a row, the banner link.
- **Transitions**: to `/new`, `/series/new`, an editor, the series page, or banking.
- **Data**: the API returns, per row, `status`, `phase`, `isInstanceOverridden`, `recurringRuleId` plus series name, `draftReason` (`banking` | `edited` | `admin` | `scheduled` | null), and the start and end range. Sorting: Upcoming and Drafts soonest first, Past most recent first.

#### Step A2: New session form (state N1)
- **System**: `manage/sessions/new/page.tsx`. Nothing is written until a save.
- **User sees**:
  - H1 "New session".
  - Scope line: "One-off session. Members on Auto Enroll aren't added to one-off sessions; they can register themselves once it's published." (conflict 3 decision).
  - The fieldsets Details (location, address, date), Courts, Costing, Pricing, Places (max players, reserved host seats) and Cancellation deadline. The UI/UX doc lays these out (C1, C4).
  - The deadline field pre-filled, with the hint "48 hours before the first court starts. Change it if you need to."
  - Buttons: "Save draft" (secondary) and "Save and publish" (primary).
- **User actions**: fill in the form, "Apply to all courts", per-court overrides, "Use suggested rate", one of the two buttons.
- **Feedback**: the suggested-rate line updates live. "Apply to all courts" announces "Times applied to 9 courts." in a polite live region (AC-VERIFY-8).
- **Transitions**:
  - "Save draft" → `POST /sessions` with a `createKey`, then redirect to `/[sessionId]?notice=draft_saved` (E1).
  - "Save and publish" → for a paid session, the publish confirm opens first (Step A4). Then create, then publish (AC-VERIFY-2 "one-step create-and-publish").
  - 422 → N2: values kept, focus on the error summary (AC-ERROR-2).
- **Data**: `createKey` is a UUID per render, so a double submit creates one row.

#### Step A3: Draft saved (state E1)
- **User sees**:
  - Banner "Draft saved." (focused once).
  - H1 "{Location}, {Wed 4 Nov 2026}".
  - Status line "Draft. Members can't see it until you publish it."
  - The same form, filled in.
  - Buttons "Save draft", "Save and publish", and "Cancel session" (an InlineConfirm trigger, shown after a separator).
- **Value**: the work is safe. The admin can leave and come back from Drafts.

#### Step A4: Save and publish
- **Decision (manual publish always saves first)**: "Save and publish" runs `PUT` with the form values, then `POST /publish`. The admin never has to remember to save before publishing, and a refusal never loses an edit (ADR 0016 manual publish point 1).
- **Paid session**: an InlineConfirm opens under the button:
  - Prompt: "Publish this session? Members can register straight away, and each player is charged after the game: {fee summary}."
  - Fee summary by pricing model: "$12.00 each", "$17.00 male, $16.00 female, $16.00 other", or "$10.00 beginner, $12.00 intermediate, $14.00 advanced".
  - For a series date, the prompt adds: "Members on Auto Enroll will be added to it."
  - Buttons: "Publish session" (pending "Publishing…") and "Keep editing" (see [InlineConfirm dismiss label](#inlineconfirm-dismiss-label)).
- **Free session**: no confirm. Publishing a free session commits no one to pay, so the spec's "confirm when paid" rule holds.
- **Outcomes**:

| API result | Next page | User sees |
|---|---|---|
| PUT ok, publish ok | `/[id]?notice=published` (E2) | "Session published. Members can now register." Status "Published. Members can register." (assumption H10 for the rollout gap) |
| PUT 422 | E1 in place, values kept | Error summary and field errors. Nothing was published |
| PUT ok, publish 409 `payout_not_configured` | `/[id]?notice=publish_refused_banking` (E1) | Alert (role `alert`, focused once) with the API message verbatim, "Add your team's bank account details before publishing a paid session.", and the link "Set up banking and GST" → `/teams/T/manage/banking?returnTo=%2Fteams%2FT%2Fmanage%2Fsessions%2F{id}`. A second line: "Your changes are saved as a draft." (AC-ERROR-1) |
| PUT ok, publish 422 (incomplete pricing, no court) | E1 in place | Field errors naming the missing fee or court, plus the line "Your other changes are saved as a draft." (AC-ERROR-4) |
| PUT ok, publish 409 `session_started` | E3 expired draft | "This session's start time has passed, so it can't be published." |
| PUT or publish 409 `session_stale` | E1 reloaded with the latest values | Stale banner (see [Stale save](#journey-g-stale-save-ac-error-7)) |
| 5xx or no answer | E1 in place, values kept | `SAVE_FAILED_MESSAGE` or `UNCONFIRMED_MESSAGE`. Retrying is safe: a PUT that changes nothing is a no-op, and publish is guarded by `WHERE status = 'DRAFT'` |

#### Step A5: Banking hand-off and back (AC-ERROR-1, ADR 0016)
1. The admin follows "Set up banking and GST". The banking page opens in edit mode, with `returnTo` carried through edit mode, validation errors and the save redirect (already built).
2. After saving, the banner reads "Banking details saved. Paid sessions can now be published." with "Back to your session".
3. "Back to your session" opens the editor (E1) with no notice. The draft is exactly as saved.
4. "Save and publish", then the confirm, then "Session published. Members can now register."

#### Step A6: Published (state E2): success
- **User sees**:
  - Status "Published. Members can register."
  - A registrations line from the API's `activeRegistrationCount` (CONFIRMED plus WAITLISTED registrations): "No one has registered yet." or "{n} players are registered."
  - The form, still editable until the start time.
  - The change-notice line when `n > 0` (Journey E).
  - "Cancel session".
- **Value delivered**: the session is open. With registration-and-waitlist shipped, members see it under "Upcoming sessions" on the team page.
- **Next actions**: "Back to Sessions", "New session", or change capacity (AC-HAPPY-8).

### Journey B: Recurring series, created (AC-HAPPY-5, AC-ASYNC-1..3, C2 first-materialisation wait)

#### Step B1: New series form (state S0)
- **User sees**:
  - H1 "New recurring series".
  - The fieldsets Repeats, Details, Courts, Costing, Pricing, Places, Cancellation deadline.
  - **Repeats fieldset**:
    - "Repeats": Weekly, Every 2 weeks, Monthly.
    - "First session" (a date).
    - "Repeat until (optional)".
    - A derived read-only line that updates as the inputs change: "Every Wednesday from 4 Nov 2026 until 16 Dec 2026", or "Every second Wednesday ...", or "On the first Wednesday of each month ..." (A1 wording).
    - **The weekday is derived from the first date, not typed separately** (assumption H1), so the two can never disagree.
  - Hint under Repeats: "Sessions are added {28} days ahead and published automatically, so members can register as soon as each one appears." (With a lead time, H2: "... and open for registration {7} days before they start.")
  - The deadline hint: "48 hours before the first court starts, for every session in the series."
  - Primary button "Create series".
- **Transitions**:
  - "Create series" validates in the browser with the shared schema. On errors → S0e.
  - Otherwise the create confirm opens (S0c).

#### Step B2: Create confirm (state S0c). Decision: a series publishes, so creating one is confirmed
- **Why**: one-off sessions have a Draft step and a publish confirm. A series has neither: saving it publishes every date inside the horizon within seconds, and (with registration shipped) registers Auto Enroll members, who are then liable for fees. Without a confirm, the most far-reaching action in the feature would be its least guarded.
- **Prompt**: "Create this series? Sessions from {Wed 4 Nov} are added now and published for registration. Members on Auto Enroll are added to each one." For a paid series, it adds: "Each player is charged after the game: {fee summary}." For an unconfigured team with a paid series, it adds: "Your team's bank account isn't set up, so the sessions will be saved as drafts until it is." (The page knows `isPayoutConfigured` from the team load. This is a heads-up only, never a block: principle 2.)
- **Buttons**: "Create series" (pending "Creating…") and "Keep editing".
- **Outcomes**: 201 → redirect `/series/[ruleId]?notice=series_created` (S1). 422 → S0e with values kept (AC-ERROR-2, AC-ERROR-3).

#### Step B3: Waiting for sessions (state S1). C2 first-materialisation wait
- **System**: the rule row and its `recurrence-materialisation` job are committed in one transaction (P5). The series GET returns `materialisation: { state: 'pending' | 'ready', since }`. "Pending" means the rule was created or changed after its last completed per-rule run (hand-off H5).
- **User sees**:
  - Banner "Series created." (focused).
  - H1 "{series name}". The name is derived as "Wednesdays at {location}", "Every second Wednesday at {location}" or "First Wednesday of the month at {location}".
  - The summary line.
  - In the sessions region, a status line (role `status`): "We're adding the sessions in this series. Refresh in a moment." with a "Refresh" link (a plain link to the same URL, so it works without JavaScript).
- **Decision (bounded auto-refresh)**: a small client component refreshes the page (`router.refresh()`) at about 2 s, 5 s and 10 s while the state is pending, then stops.
  - Why not unbounded polling: the existing convention is pull-only, and indefinite polling makes WCAG 2.2.2 harder to meet.
  - Why not manual only: about 5 s is short enough that the admin would otherwise refresh by hand, and a refresh too early teaches them the feature is broken.
  - Focus stays where it was. When the sessions appear, the polite region announces "{n} sessions added."
- **Slow path**: still pending after the last refresh → "This is taking longer than usual. Your series is saved and its sessions will appear here. Refresh in a minute." Manual "Refresh" only. Nothing else is needed: the daily run is the backstop, and operators see failures in `session.recurrence.instance_failed`.
- **Admin navigates away**: nothing is lost. Waiting is server state. Returning to the series page, or seeing the list's Series row, shows the current state (AC-NAV-1).

#### Step B4: Sessions listed (state S2): success
- **User sees**:
  - The summary line: "Weekly on Wednesdays · 8:00 am–10:00 am · 9 courts · $12.00 each · from 4 Nov 2026 · until 16 Dec 2026" (or "no end date").
  - **Sessions in this series**: one row per upcoming date, showing the date, time range, status label (Published, Draft · bank account needed, Draft · Edited, Scheduled · opens {date}, Started, Cancelled), an "Edited" tag where overridden, and a link "Edit {Wed 4 Nov}" (accessible name includes the date).
  - Below the rows, the horizon line: "Sessions are added {28} days ahead. The next one, {Wed 9 Dec}, will be added on {Wed 11 Nov}." (computed by the API from the horizon and the rule; H2). The line is omitted when `recur_until` has been reached.
  - A collapsed disclosure "Past and cancelled sessions in this series ({n})".
  - The details summary with "Change series details".
  - "End series".
- **Zero sessions so far** (the first date is beyond the horizon): "No sessions yet. The first one, {Wed 6 Jan 2027}, will be added on {Wed 9 Dec 2026}."
- **Value delivered**: the regular night exists for the coming weeks and keeps extending itself every night at 03:00.

#### Step B5: Banking-refused drafts (states S2b and S2r; AC-ASYNC-3, AC-ASYNC-4)
- **S2b (team not configured)**:
  - Notice at the top of the series page: "{n} sessions in this series were saved as drafts because your team's bank account isn't set up. Members can't register for them yet." with the link "Set up banking and GST" → `/teams/T/manage/banking?returnTo=<series page path>`.
  - Each such row is labelled "Draft · bank account needed".
  - The Sessions list shows the same banner (L2) above its sections, linking to banking with `returnTo` set to the Sessions list.
  - Every approved admin receives at most one email per rule per run window ([email copy](#materialiser-banking-email-to-admins-provisional)).
- **Return**: after saving banking, "Back to your session" lands on the series page. The label is fixed by the banking page and reads slightly off for a series. That is accepted (trade-off T4).
- **S2r (configured now, drafts remain until the next run)**:
  - Notice: "Your bank account is set up. {n} sessions in this series are still drafts. They'll be published automatically overnight, or you can publish them now."
  - Button "Publish drafts now".
  - The button enqueues the same per-rule materialisation run, which retries unedited drafts through the gate (ADR 0016 recurrence point 6, AC-ASYNC-4). The page then shows the S1-style line "We're publishing the drafts in this series. Refresh in a moment." with the same bounded refresh. Proposed AC-ASYNC-6 (SHOULD).
- **Edited drafts are never auto-published** (ADR 0016 point 6). The row reads "Draft · Edited". Its editor says: "This date has been edited, so it won't be published automatically. Publish it when it's ready." S2r counts them separately: "{e} edited drafts need you to publish them yourself."
- **One-by-one alternative**: any draft can also be published from its editor (Journey A, Step A4). That publish adds Auto Enroll members because the session is part of a series (conflict 3 decision).

### Journey C: One date of a series, edited (AC-HAPPY-6, C2)

#### Step C1: Open a date
- **Entry**: series page row "Edit Wed 4 Nov", or a list row that carries "Series: {series name}".
- **User sees** (session editor, instance scope):
  - A back link at the top: "Back to {series name}".
  - H1 "{Location}, {Wed 4 Nov 2026}".
  - **Scope line**, one of two forms:
    - Unedited: "One date in {series name}. Changes here apply to {Wed 4 Nov} only. Once you save a change, this date is marked Edited and changes to the series won't overwrite it."
    - Edited: "Edited. This date has its own details, so changes to {series name} don't apply to it."
  - The form, pre-filled from the instance.
  - **The date is fixed** on a series date: shown as text, not an input, with "To move this night, cancel it and create a one-off session." (assumption H6).
- **Why a scope line and no toggle**: the admin decides the scope by where they came from. The line confirms it in words, before typing, and is repeated in the save result. A toggle or a save-time "this date or all dates?" question would make the most common action (fix one night) a two-decision action, and a misclick would change the whole series.

#### Step C2: Save
- **Outcomes**:
  - A save that changes something: `is_instance_overridden` becomes true. Banner "Changes saved for {Wed 4 Nov}. This date is now marked Edited." (on the first edit), or "Changes saved." (already edited).
  - **A save that changes nothing** leaves the date unedited and shows "Nothing to change." (AC-ERROR-7's no-op rule, and the skill-levels precedent). Otherwise opening and saving by accident would silently detach a date from its series.
- **Published date with registrations**: the change-notice rules of Journey E apply.
- **Capacity raise on a published date**: AC-HAPPY-8. The banner adds "{k} players moved off the waitlist and were emailed." when the allocator port reports promotions (0 with the no-op port, so no line).
- **Next**: "Back to {series name}". The row now shows the "Edited" tag.
- **Undoing an edit** ("Reset to series") is not offered in v1 (trade-off T2). The edited scope line says what that means, so the admin is not surprised later.

### Journey D: Whole series, changed (AC-HAPPY-7, AC-HAPPY-10, C2 "what a series save reports")

#### Step D1: Change series details (state S3, `?edit=details`)
- **User sees**:
  - The series form, pre-filled.
  - Repeats, First session and the weekday shown as fixed text: "To change the day or how often it repeats, end this series and start a new one." (assumption H7).
  - "Repeat until" editable, but only to extend or clear it (see Step D3).
  - **An effect line above "Save series"**, computed from the per-session `seriesChangeEffect` the series GET returns (hand-off H3):
    > "Your changes will apply to {4} upcoming sessions and to sessions added later. {1} edited session keeps its own details. Past and cancelled sessions don't change."
    - With A3 option (b) it adds: "{2} published sessions that people have registered for keep their current details."
    - With A3 option (c) it adds: "{2} sessions have registered players; we'll email them if the time, place or fees change."
- **Why before save**: this is the moment the admin decides. The same numbers come back after save, so the admin can check that what happened is what they were told.

#### Step D2: Save series
- **Outcomes**:
  - 200 → redirect `?notice=series_saved&count=4&edited=1` → S2.
    - Banner: "Series saved. {4} upcoming sessions updated. {1} edited session kept its own details."
    - Optional lines:
      - "We're emailing registered players about the {2} sessions whose time, place or fees changed." (when the notifier reports emails)
      - "{1} published session wasn't changed because your team's bank account isn't set up." with the banking link (assumption H4)
      - "We're adding the new dates. Refresh in a moment." (only while new dates are pending)
  - **Nothing changed** → "Nothing to change." (no write, no re-materialisation).
  - 409 `series_stale` → S3 reloaded with the latest values and the series stale banner.
  - 422 → S3 with values kept.
- **If propagation is asynchronous** (assumption H3 fallback): the banner is "Series saved. We're updating its upcoming sessions." and, when the run finishes, the series page shows a persistent line "Last change: {4} upcoming sessions updated, {1} edited session kept its own details." until the next change.

#### Step D3: End series (AC-HAPPY-10; A4)
- **Trigger**: "End series" (InlineConfirm with fields).
- **Prompt**: "End this series? No sessions will be added after the last date."
- **Fields**:
  - "Last date" (default today).
  - When published sessions exist after the chosen date, an unticked checkbox "Also cancel the {p} published sessions after this date". Ticking it follows the cancel path for each one (Journey E). With registrations, the label adds "; {n} registered players will be emailed".
  - A line when drafts exist after the date: "{d} draft sessions after this date will be cancelled." (Drafts were never visible to players.)
- **Buttons**: "End series" (destructive, pending "Ending…") and "Keep series".
- **Result**: S4. Banner "Series ended. No new sessions will be added after {date}." plus "{c} sessions after that date were cancelled." when `c > 0`. The summary line becomes "Ended. Last session {date}." The Series row in the list shows "Ended {date}". Instances on or before the last date are untouched.
- **Shortening in the editor**: an earlier "Repeat until" in S3 is refused with the field error "To stop the series sooner, use End series." Destructive effects live behind one prompt only (principle 3).
- **Restarting an ended series** is not offered: "To run it again, create a new series."

### Journey E: Cancelling and changing published sessions, and telling players (AC-HAPPY-9, C3)

#### Decision summary
This feature **decides when players are told and tells the admin**. registration-and-waitlist **writes and sends** the emails, through a notifier port this feature calls inside the same transaction (hand-off H9).

#### Step E1: Cancel
- **Trigger**: "Cancel session". Shown for DRAFT, and for PUBLISHED before `starts_at`. Hidden after the start (conflict 8: cancel only before start, confirmed).
- **Prompt variants** (from `status`, `recurringRuleId`, `activeRegistrationCount` and the notifier capability flag in the session GET):

| Case | Prompt | Confirm button |
|---|---|---|
| One-off draft | "Cancel this draft? It won't be published, and you can't undo this." | "Cancel draft" |
| Series draft | "Cancel {Wed 4 Nov}? The series won't add this date again, and you can't undo this." | "Cancel this date" |
| Published, no registrations | "Cancel this session? No one has registered yet. You can't undo this." | "Cancel session" |
| Published, `n` registrations, notifier active | "Cancel this session? {n} registered players will be emailed that it's cancelled, and no one is charged for it. You can't undo this." | "Cancel session" |
| Published, `n` registrations, notifier not active (fallback) | "Cancel this session? {n} players are registered and won't be told automatically. No one is charged for it. You can't undo this." | "Cancel session" |

  All confirm buttons are destructive style. The dismiss button is "Keep session" (or "Keep draft"). "No one is charged" holds because billing only bills sessions it completes, and a cancelled session never completes (C-BIL-1).
- **Result**: redirect `?notice=cancelled&emailed={k}` → E3 cancelled (read-only).
  - `n = 0`: "Session cancelled. No one had registered."
  - `k > 0`: "Session cancelled. We're emailing the {k} registered players to let them know."
  - `n > 0` and `k = 0`: "Session cancelled. {n} players were registered. Let them know it's cancelled."
- **Registrations are not withdrawn** (C-SSE-4). The player page shows "This session has been cancelled." (registration A10).

#### Step E2: Change a published session with registrations
- **Persistent line above "Save changes"** when `activeRegistrationCount > 0`: "{n} players are registered. If you change the date, times, place, cancellation deadline or fees, we'll email them the new details."
  - If the Algorithm doc refuses fee edits once anyone has registered (conflict 10, the likely default), the fee inputs are read-only with "Fees can't change once players have registered, because they agreed to this price." and "or fees" is dropped from the line.
- **Material fields**:
  - The session date (one-off only; series dates are fixed, H6).
  - The earliest court start or latest court end.
  - Location, address.
  - The cancellation deadline.
  - Fees, if allowed.
- Changing courts, max players or reserved seats without moving the overall time range is **not** material. Capacity raises already email promoted players through registration.
- **Result**: "Changes saved. We're emailing the {k} registered players the new details." when `k > 0`. "Changes saved." otherwise.
- **Lowering capacity**: a hint by "Max players" on a published session: "Lowering this won't remove anyone who's already in." (C-SSE-3: a cut demotes nobody.)

### Journey F: Read-only sessions (AC-ERROR-5, conflict 8)

| Case (derived from `status` and `phase`) | Label in lists | One-line reason at the top of the editor | Actions left |
|---|---|---|---|
| PUBLISHED, `phase = started` | Started | "This session has started, so it can't be changed or cancelled." | Back links |
| PUBLISHED, `phase = ended` | Ended | "This session has ended, so it can't be changed." | Back links |
| COMPLETED | Completed | "This session is complete, so it can't be changed." | Back links |
| CANCELLED | Cancelled | "This session was cancelled, so it can't be changed." | Back links |
| DRAFT, `starts_at` passed | Not published · date passed | "This draft's start time passed before it was published, so it can't be published or changed." | Back links |

- **Layout**: the editor renders the same sections as a read-only summary (description lists, not disabled inputs). Disabled inputs are hard to read at 360 px and are skipped by some screen readers.
- **Where they are listed**:
  - Started sessions stay in **Upcoming** until they end, so a session in progress is easy to find.
  - Ended, Completed, Cancelled and expired drafts are listed in **Past and cancelled**.
- **A form posted across the boundary** (the editor was open when the start passed, or a co-admin cancelled): 409 `session_started` or `session_not_editable` → the page reloads read-only with the reason as a focused banner (state known to have changed).

### Journey G: Stale save (AC-ERROR-7)
- **Trigger**: the session or series changed after the page loaded. The cause may be a co-admin, the materialiser publishing a draft, or a series change updating an unedited date.
- **Result**: 409 `session_stale` (or `series_stale`) with the current state. The page reloads with the latest values, and a focused banner says: "This session changed since you opened it. Review the latest version and save again." (or "This series changed since you opened it. ...").
- **Copy change from the spec**: the spec's "Someone else changed this session" is wrong when the system made the change. The neutral wording works for both.
- **What the admin loses**: their typed values (state known to have changed: reload). Accepted: two admins on the same session at once is rare, and a merge view is out of proportion (trade-off T5).

### Journey H: Auto Enroll as the admin experiences it (conflict 3)

**Chosen rule**: *Every series session adds the members on Auto Enroll once, when it is first published, whoever or whatever publishes it. One-off sessions never do.*

| Path | Auto-enrol? | What the admin is told |
|---|---|---|
| Materialiser publishes a new date | Yes (AC-ASYNC-2) | Create confirm: "Members on Auto Enroll are added to each one." |
| Materialiser re-publishes a banking-refused draft | Yes (AC-ASYNC-4) | S2r notice (implicit) |
| "Publish drafts now" | Yes (same run) | Same |
| **Admin manually publishes a series date** (banking-refused draft, edited draft, scheduled draft published early) | **Yes**, once, in a follow-up transaction or a `session-auto-enrol:<sessionId>` job (C-SKL-1 point 5) | Publish confirm: "Members on Auto Enroll will be added to it." (free sessions get no confirm, so the status line after publishing says it instead: "Published. Members can register. Members on Auto Enroll are being added.") |
| Admin creates and publishes a one-off session | **No** | Scope line on the one-off editor, the hint under "New session", and the amended Auto Enroll hint on the People page |
| Series change that updates already-published dates | No (not a first publish; ADR 0017 point 7, not retroactive) | Nothing extra |

- **Why one-off sessions never auto-enrol**: Auto Enroll means "my regulars' standing booking" (skill-levels journey mental model). One-off sessions are the exceptions: tournaments, holiday specials, a different venue, a different price. Booking regulars into them without asking would charge people for events they never agreed to, and the admin has no way in v1 to withdraw a player for them. ADR 0017 point 6 and workflows §4 also scope auto-enrol to materialisation. The overview's "all newly created game sessions" is the outlier.
- **Why a manually published series date does auto-enrol**: otherwise the same Wednesday would or would not include the regulars depending on whether the admin pressed Publish at 9 pm or the job ran at 3 am. Admins cannot see that difference and would read it as a bug.
- **Consequence for shipped copy**: the People page hint (`skill-enroll-panel.tsx` line 293) says "Adds {name} to new sessions automatically". Amend it to "Adds {name} to new sessions in your recurring series automatically, ..." (task amendment 9).
- **The admin never sees per-member auto-enrol results** in this feature. The roster is registration's COULD. The registrations count on the published editor ("{n} players are registered") shows the outcome once registration ships.

---

## Async Handling

### Operation lifecycle

| Phase | Duration | Admin experience |
|---|---|---|
| Series created or changed | Immediate (one transaction, job enqueued in it) | "Series created." / "Series saved. ..." with counts for existing dates |
| Per-rule materialisation | About 5 s (one poll plus the run) | S1 "We're adding the sessions in this series." Bounded auto-refresh. Can navigate away |
| Slow or stuck run | Beyond about 15 s | "This is taking longer than usual. Your series is saved ..." Manual refresh. The daily run is the backstop |
| Daily run | 03:00 Pacific/Auckland | Nothing to see at the time. New dates appear on the next visit. The horizon line says when the next date will be added |
| Banking refusal | Inside a run | Drafts labelled. Notice on the series page and list. One email per rule per window |
| Banking set up | Admin action | S2r notice. "Publish drafts now", or overnight |
| Auto-enrol | Inside or just after publish | Not shown directly. The registrations count reflects it once registration ships |

### Progress communication
- **Method**: server state read on page load (`materialisation.state`), plus bounded client refresh (about 2 s, 5 s, 10 s). No WebSocket, no indefinite polling, no email on success.
- **Persistence**: the series page always shows the current truth: instances, labels, pending state, and the last change summary (H3 fallback).
- **Missing it**: impossible to miss in a harmful way. A pending state means "not yet added", never "lost". The banking refusal reaches the admin three ways (email, list banner, series notice).

---

## Distributed System Flow

### System boundaries

```
[Web: Server Components + Server Actions]
     │ HTTP (cookie, requireTeamRole TEAM_ADMIN)
     ▼
[API sessions module] ──tx──▶ publish gate (ADR 0016) ──▶ game_sessions FOR UPDATE ──▶ UPDATE
     │        │                                              │
     │        ├─ capacity raise ──▶ SessionAllocatorPort.promoteWaitlist (no-op until registration)
     │        ├─ cancel / material change ──▶ session-change notifier port (no-op until registration) ──▶ send-email jobs (registration's templates)
     │        └─ rule create/edit/"Publish drafts now" ──▶ enqueue recurrence-materialisation (same tx)
     ▼
[pg-boss worker: recurrence-materialisation] ── per date tx: insert DRAFT + courts → gate → publish | keep DRAFT (+ admin email once per rule/window)
     │                                          └─▶ selectAutoEnrollees → SessionAllocatorPort.autoEnrolInSession
     ▼
[DB: game_sessions, session_courts, recurring_session_rules (+ anchor, rule courts, version stamps, materialisation watermark)]
```

### Responsibility matrix

| Step | Owner | State storage | Failure handling (admin view) |
|---|---|---|---|
| Form entry, live suggested rate, apply-to-all | Web client | Component state | Lost on navigation (no autosave, no `beforeunload` native dialog: a UAT blocker). Mitigated by saving early |
| Create / save / publish / cancel | API | DB | 422 field errors kept in form. 409 mapped banners. 5xx keep values |
| Series save and propagation to existing dates | API (assumption H3: synchronous) | DB | Counts in banner. Per-session refusals counted, never fatal |
| Materialisation of new dates | Worker | DB + `pgboss.job` | Pending state. Per-date rollback. Daily backstop |
| Banking refusal | Worker | DRAFT rows + email job | Labels, notices, email |
| Auto-enrol | Worker / follow-up tx / job → allocator port | registrations (registration's) | Invisible to admin. Refusals are skips |
| Player emails on cancel/change | Notifier port → registration | `pgboss.job` | Counts in banner. Fallback copy when the port is a no-op |

---

## Error Handling

| Error | When | Admin sees | Recovery |
|---|---|---|---|
| Validation (422 `validation_failed`) | Any save | Error summary (focused) and field messages. Values kept | Fix and resubmit |
| DST nonexistent/ambiguous court time (422) | Court time 02:xx on a change day | Field message naming the date and offering the representable choice (Algorithm, conflict 6). Provisional: "2:30 am doesn't happen on Sun 27 Sep 2026 because clocks go forward. Use 3:30 am?" / "1:30 am happens twice on Sun 4 Apr 2027 because clocks go back. We'll use the first one." | Accept the offered time or pick another |
| Publish refused, banking (409 `payout_not_configured`) | Manual publish | Alert focused once, verbatim message, link with `returnTo`, "Your changes are saved as a draft." | Banking round trip |
| Publish refused, incomplete (422) | Manual publish | Field errors on the missing fee or courts, "Your other changes are saved as a draft." | Fill in, publish again |
| Started (409 `session_started`) | Publish, capacity edit or cancel after start | Reload read-only with the reason | None needed |
| Not editable (409 `session_not_editable`) | Any write to completed/cancelled | Reload read-only with the reason | None needed |
| Illegal transition (409 `session_state_conflict`) | Double submit across tabs (for example cancel then publish) | Reload with the current state and "This session changed since you opened it. ..." | Review |
| Stale (409 `session_stale` / `series_stale`) | Concurrent change | Reload with latest values and the stale banner | Re-apply changes |
| Series "Repeat until" earlier than today's last date | Series save | Field error "To stop the series sooner, use End series." | End series |
| Network or 5xx | Any write | `SAVE_FAILED_MESSAGE` (definite failure) or `UNCONFIRMED_MESSAGE` (no answer). Values kept | Retry. Retries are safe (`createKey`, no-op saves, guarded transitions) |
| 401 | Any page or write | `sessionExpiredUrl(here)`, returning to the same page | Sign in again |
| 403 | Any page or write | `NoAccess`, no session data | None |
| Materialiser per-date failure | Worker | Nothing directly. That date is missing until a later run. If the slow state persists, refresh later | Operators: `session.recurrence.instance_failed` |

### Partial outcomes
- **Save then publish**: the save part commits even when publishing is refused. The banner says so ("Your changes are saved as a draft.").
- **Series save**: each existing date is its own outcome. The banner counts updated, kept-because-edited, kept-because-registered (A3 option b) and not-updated-because-banking (H4). Nothing is ever half-applied to a single date.
- **End series with "also cancel"**: each cancellation is its own transaction (the cancel path). If one fails, the banner says "Series ended. {c} of {p} sessions after that date were cancelled. Cancel the rest from the list." (a rare transient case).

---

## Options Explored

### Option 1: Scope-by-URL hub (series page plus separate session editor) — CHOSEN
- **Orchestration**: Dashboard + detail. The series page is summary-first with `?edit=details`. One session editor for a one-off session or a series date, told apart by the scope line.
- **Wireframe** (series page, phone width):
  ```
  ┌──────────────────────────────────┐
  │ People · Banking and GST · Sessions
  │ [Series saved. 4 upcoming sessions│
  │  updated. 1 edited session kept   │
  │  its own details.]                │
  │ Wednesdays at Rosedale            │
  │ Weekly · 7:00–9:00 pm · 9 courts  │
  │ $12.00 each · from 4 Nov 2026     │
  │ ── Sessions in this series ──     │
  │ Wed 4 Nov  7–9 pm  Published      │
  │            [Edit Wed 4 Nov]       │
  │ Wed 11 Nov 7–8 pm  Published      │
  │            Edited [Edit Wed 11 Nov]
  │ ...                               │
  │ Next date added on Wed 11 Nov.    │
  │ ▸ Past and cancelled (2)          │
  │ ── Series details ──              │
  │ [Change series details]           │
  │ [End series]                      │
  └──────────────────────────────────┘
  ```
- **Pros**: scope can never be ambiguous (URL, heading, scope line). It reuses the banking page's summary-first and `?edit=` pattern. Each page has one primary action. It works without JavaScript except for the confirms (the same accepted limit as today). It keeps forms short at 360 px.
- **Cons**: one more page hop to edit a date. Two editors share fieldsets (a build cost, not an admin cost).
- **Friction points**: an admin who meant to change the series but opened a date. The scope line and the "Back to {series name}" link catch this before typing.

### Option 2: Unified editor with a save-time scope question (calendar-app pattern)
- **Orchestration**: open any date. On save, choose "This date" / "This and following" / "All dates".
- **Wireframe**:
  ```
  ┌──────────────────────────────────┐
  │ Wed 4 Nov · Rosedale              │
  │ [form ...]                        │
  │ Save changes to:                  │
  │ (•) This date only                │
  │ ( ) This and later dates          │
  │ ( ) Every date in the series      │
  │ [Save]                            │
  └──────────────────────────────────┘
  ```
- **Pros**: familiar from Google Calendar. One editor. "This and following" is powerful.
- **Cons**:
  - The scope is decided after typing, so a wrong radio silently rewrites many published, registered sessions.
  - "This and following" needs series splitting, which the schema and the Algorithm doc do not support.
  - A required choice on the most common action.
  - It cannot show "Edited" consistently, because the series defaults are edited from an instance.
  - Calendar apps use a modal for the question, which is against convention here.
- **Best for**: personal calendars with no money or registrations attached.

### Option 3: Inline series grid (edit dates as rows on the series page)
- **Orchestration**: the series page is a table of dates with editable cells (time, courts, places, rate) and a "Series defaults" row on top.
- **Wireframe**:
  ```
  ┌───────────────────────────────────────────────┐
  │ Defaults  7:00–9:00  9 courts  36  $12.00      │
  │ Wed 4 Nov [7:00][9:00] [9]   [36] [$12.00] ✓   │
  │ Wed 11 Nov[7:00][8:00]*[6]*  [24]*[$12.00] ✓   │
  └───────────────────────────────────────────────┘
  ```
- **Pros**: very fast for power users. Overrides are visible per field.
- **Cons**:
  - Per-court times do not fit a row.
  - Unusable at 360 px.
  - Needs a per-field override mask (not the existing boolean; A3).
  - Spreadsheet-style editing with many inputs is heavy for screen readers.
  - Silent writes per cell clash with the PRG/notice conventions.
- **Best for**: desktop power admins. Not for v1.

### Option 4: Create wizard (stepper) plus Option 1 editors
- **Orchestration**: "New session" and "New recurring series" become 4-step wizards (Details → Courts → Costing and pricing → Review and publish). Editing uses Option 1.
- **Wireframe**:
  ```
  ┌──────────────────────────────────┐
  │ Step 2 of 4: Courts               │
  │ Number of courts [9]              │
  │ Default 8:00–10:00 [Apply to all] │
  │ ...                               │
  │            [Back] [Next]          │
  └──────────────────────────────────┘
  ```
- **Pros**: a guided first setup. The review step is a natural place for the create confirm.
- **Cons**:
  - Two layouts for the same fields (create versus edit).
  - Step state must live somewhere (server drafts or client), which conflicts with "nothing written until Save".
  - Back/forward and 401 mid-wizard need extra handling.
  - Repeat edits gain nothing.
  - The costing fieldset needs the court count and max players from different steps.
- **Best for**: very first-time admins. The single form with clear fieldsets and an inline confirm gives most of the benefit.

## Evaluation Matrix

| Criterion | Option 1 Hub | Option 2 Save-time scope | Option 3 Grid | Option 4 Wizard + hub |
|---|---|---|---|---|
| Discoverability | H | H | M | H |
| Learnability | H | M | L | H |
| Efficiency (repeat use) | M-H | H | H (desktop) | M |
| Error prevention (wrong scope, accidental publish) | H | L | M | H |
| Error recovery | H | L | M | M |
| Feedback (scope and outcome always clear) | H | M | M | H |
| Consistency with existing patterns | H | L | L | M |
| Accessibility (keyboard, screen reader, 360 px) | H | M | L | M |
| Fit with schema and A3 default (whole-instance override) | H | L | L | H |

## Decision

**Chosen**: Option 1, the scope-by-URL hub, together with these sub-decisions:

- **C2 (series versus instance)**: **Chosen**:
  - The URL decides the scope. Each page has a scope line in words.
  - The "Edited" tag appears on rows and in the editor's scope line. It is set only by a save that changes something.
  - A series save reports counts before (the effect line) and after (the banner): updated, kept because edited, and the A3-dependent kept or emailed counts.
  - The first-materialisation wait is a server `materialisation.state` with a bounded auto-refresh and a manual link, a slow-path message, and a "first date will be added on" line when nothing is due yet.
  - Navigation runs from series rows "Edit {date}" to the session editor, and back through "Back to {series name}".
- **C3 (telling players)**: **Chosen**:
  - This feature calls a session-change notifier port inside the cancel and material-change transactions. It defines which fields count as material.
  - registration-and-waitlist implements the port: recipients, templates and idempotency keys (hand-off H9).
  - A no-op default logs until then.
  - The admin is told in counts in the prompt and the banner, with honest fallback copy when no emails were sent.
- **Conflict 3 (admin view)**: **Chosen**:
  - Series sessions auto-enrol once on first publish, by any path, including the admin's manual publish of a series date.
  - One-off sessions never auto-enrol.
  - The admin sees the rule in the one-off scope line, the list hint, the create-series confirm, the series-date publish confirm, and the amended People-page hint.
- **Banking-refused paths**: **Chosen**:
  - Manual publish saves first, then shows the verbatim alert, the `returnTo` link and "Your changes are saved as a draft."
  - Materialiser drafts are labelled "Draft · bank account needed". The series notice and list banner link to banking with `returnTo`, and an email is sent once per rule per window.
  - After banking is set up, the S2r notice offers "Publish drafts now" (re-runs the rule).
  - Edited drafts are labelled "Draft · Edited", and the admin is told they must publish them.
  - A series create confirm warns, without blocking, when banking is missing.
- **Derived labels and read-only sessions**: **Chosen**:
  - The API computes `phase`, which gives Started and Ended.
  - Cancel is only offered before the start.
  - Started sessions are fully read-only (task amendment 7).
  - Read-only pages render a summary, not disabled inputs, with a one-line reason.
- **Stale save**: **Chosen**: reload the latest values with neutral copy ("This session changed since you opened it. ...").
- **Series create**: **Chosen**: confirmed with an InlineConfirm that states that sessions publish automatically and that Auto Enroll applies.
- **Series day, frequency and first date**: **Chosen**: fixed once created; end the series and start a new one to change them (assumption H7). "Repeat until" can only be extended or cleared in the editor. Shortening goes through End series.

### Rationale
- Admins in this product act for other people's money and places. The design spends its friction where a mistake is expensive: a wrong scope, publishing a paid series, cancelling a session people registered for. It removes friction where mistakes are cheap: saving drafts, fixing one night, waiting a few seconds for dates.
- It reuses every pattern admins already know from People and Banking (area nav, summary-first with `?edit=`, `InlineConfirm`, focused banners, the `returnTo` hand-off), so no new interaction model has to be learnt.
- It keeps copy true in every rollout state (registration not yet shipped, no-op ports, unconfigured banking), which the earlier features' journeys treated as a hard rule.

### Trade-offs accepted
- **T1. An extra hop to edit one date** (series → date). Acceptable: it is the price of a scope that cannot be misread, and the hop also carries the "Back to {series name}" anchor.
- **T2. No "Reset to series" for an edited date** in v1. Mitigation: the scope line says so before the first save. A later feature can add it once A3 settles how resets interact with registrations.
- **T3. Day, frequency and first date are fixed after creation.** Mitigation: End series plus New recurring series takes one minute, and the prompt says so. This avoids A4's hardest cases (moving published, registered sessions to new weekdays).
- **T4. "Back to your session" reads oddly when returning to a series page.** The label belongs to the merged banking page. Accepted for v1. A later copy tweak could vary it by target.
- **T5. A stale save loses the admin's typed values.** Rare. A merge view is out of proportion.
- **T6. Bounded auto-refresh is a small step away from "pull-only".** Bounded (three refreshes), announced politely, focus preserved, with a manual link as the no-JS path.
- **T7. Players hear about cancellations only once registration-and-waitlist ships the notifier.** Before that, no registrations can exist, so no player can be missed. The fallback copy covers a registration build that ships the allocator without the notifier.

---

## Implementation Guidelines

### Frontend requirements
1. **Pages**: list, `/new`, `/[sessionId]`, `/series/new`, `/series/[ruleId]` (with `?edit=details`). Each renders `ManageAreaNav current="sessions"` only after its guard passes.
2. **View model** (`lib/teams/sessions-view.ts`):
   - status label from `status` + `phase` + `draftReason` + `isInstanceOverridden`;
   - scope line (one-off / series unedited / series edited);
   - series name;
   - effect line and report banner from counts;
   - cancel prompt variant;
   - notice codes → copy deck;
   - all pure and unit-tested.
3. **Actions** (`lib/teams/sessions-actions.ts`):
   - "Save and publish" = PUT then POST publish, with the outcome table of Step A4;
   - the create-and-publish variant on `/new`;
   - series create, save, end and "Publish drafts now";
   - cancel;
   - error mapping to the notice codes and banners above.
4. **Components**:
   - a client `RefreshWhilePending` (bounded refresh, polite announcement);
   - a context-free `InlineConfirm` with a configurable dismiss label and optional fields (date, checkbox), extracted from the manage-specific one (registration's UI/UX made the same request);
   - read-only summary renderers for E3.
5. **No `beforeunload` prompts and no native dialogs** (UAT Required-severity rule).

### Backend requirements (what the journey needs the API to return)
1. **Session GET**:
   - `status`, `phase` (`upcoming` | `started` | `ended`);
   - `isInstanceOverridden`, `recurringRuleId` and series name;
   - `draftReason` (`banking` | `edited` | `admin` | `scheduled` | null);
   - `activeRegistrationCount` (a read-only count of CONFIRMED + WAITLISTED registrations; 0 until registration ships);
   - `notifiesRegistrants: boolean` (notifier capability);
   - `feesLocked: boolean` (conflict 10, if adopted);
   - the version stamp.
2. **Series GET**:
   - the rule and its derived description;
   - instances with `seriesChangeEffect` (`will_update` | `edited` | `closed` | `has_registrations` | `needs_banking`);
   - `materialisation: { state, since }`;
   - `nextDateAddedOn` and `nextDate` (horizon line);
   - the banking-draft counts (`bankingDrafts`, `editedDrafts`);
   - `isPayoutConfigured`;
   - `lastChange` summary (H3 fallback);
   - the version stamp.
3. **Write responses** carry the counts the banners need:
   - series save: `updated`, `keptEdited`, `keptRegistered`, `keptBanking`, `emailedSessions`;
   - cancel: `emailed`;
   - change: `emailed`, `promoted`;
   - end series: `cancelled`, `failed`.
4. **Endpoint**: `POST /teams/:teamId/session-series/:ruleId/publish-drafts` (or the same effect via a field on PUT), which enqueues the per-rule run (AC-ASYNC-6). The idempotency key per rule means double clicks enqueue one run.
5. **Auto-enrol on manual publish of a series date**: a follow-up transaction that has not locked the session, or a `session-auto-enrol:<sessionId>` job enqueued in the publish transaction (Architecture B2/B3 choose). It runs exactly once per session.
6. **Notifier port**: called inside the cancel transaction and inside any update of a PUBLISHED session whose material fields changed (including series propagation per date). Payload `{ teamId, sessionId, kind: 'cancelled' | 'details_changed', changed: readonly MaterialField[] }`. It returns `{ emailed: number }`. The no-op logs `session.notify.port_noop` with `sessionId`, `kind` and `registrations`.

### Integration points

| System | Interface | Data exchanged |
|---|---|---|
| Banking page (merged) | `?returnTo=` (validated by `bankingReturnTo`) | Editor, series or list path; "Back to your session" link |
| Publish gate (merged) | `assertTeamCanPublishPaidSession` / `checkTeamCanPublishPaidSession` | Pricing structure and fees → ok / `payout_not_configured` |
| skill-levels (merged) | `selectAutoEnrollees` | `{ teamId, sessionDate }` → ordered entries |
| registration-and-waitlist (later) | `SessionAllocatorPort` (`promoteWaitlist`, `autoEnrolInSession`); **new** session-change notifier port | Session ids, material fields → emailed counts, promoted counts |
| send-email (merged) | `enqueueEmail` in the materialiser transaction | Admin "bank account needed" email, key `payout-missing:<ruleId>:<windowStart>` |

---

## Hand-offs and assumptions to reconcile

| # | Depends on | Assumption made here | If the ruling differs |
|---|---|---|---|
| H1 | Algorithm A1 (anchor) / Architecture conflict 9 | The weekday is derived from "First session" (the anchor). `day_of_week` is stored but never typed separately. Monthly is described as "the {nth} {weekday} of each month" | If Monthly means day-of-month, the derived line reads "On the {4th} of each month". If a separate day field is kept, validate that it matches the first date |
| H2 | Algorithm A2 (horizon, lead time) | Horizon 28 days (env). No lead time: dates publish as they are added | With a lead time: the label "Scheduled · opens {date}" in Upcoming, hint copy "... open for registration {N} days before they start", and an early manual publish allowed (auto-enrols) |
| H3 | Algorithm A3 + Architecture B1 | Series save updates existing unedited future dates **synchronously** in the request, so the banner carries counts. New dates come from the job | If asynchronous: banner "Series saved. We're updating its upcoming sessions." plus a persistent `lastChange` summary on the series page |
| H4 | Algorithm A3/conflict 10 + Architecture | A series save is never refused because of banking. A published date the gate refuses (free → paid) keeps its old values and is counted "not updated because your team's bank account isn't set up". Re-saving the series after banking setup re-applies (propagation = "make unedited future dates match the rule", which is idempotent) | If the ruling refuses the whole save: alert with the banking link, `returnTo` set to the series page, and the warning "Your changes haven't been saved." (the typed values are lost if the admin follows the link, which is worse) |
| H5 | Architecture B1/conflict 9 | A materialisation watermark per rule (for example a `materialised_version` against the rule's version) exposes `materialisation.state` | Any equivalent signal works. Without one, the page can only show the static "Refresh in a moment" line |
| H6 | Algorithm A4 | A series date's date cannot be changed. Move = cancel the date + one-off session | If dates can move, the scope line and material-change rules apply as for a one-off session |
| H7 | Algorithm A4 | Day, frequency and first date are fixed after creation. "Repeat until" can only be extended or cleared in the editor. Shortening goes through End series | If changes are allowed, S3 gains a warning line with counts of dates that move, are cancelled or are kept, behind the "Save series" confirm |
| H8 | Architecture | `phase` is computed by the API from its injected clock | The web must not compute it from the browser clock |
| H9 | registration-and-waitlist (in flight) | That feature accepts the session-change notifier obligation (recipients CONFIRMED + WAITLISTED, templates in `modules/registrations/emails.ts`, keys `session-cancelled:<sessionId>` and `session-changed:<sessionId>:<version>`) and adds it to its plan beside R17. C-SSE-4's "no allocator call" stays true: the notifier is a separate port and writes no registrations | If registration declines, the fallback copy stays permanently, and the prompt says players won't be told automatically. Record the gap in ADR 0019 |
| H10 | Architecture conflict 1 (rollout gap) | v1.0.0 ships with registration-and-waitlist, so "Members can now register." is true in production | If this feature ships to production first: use "Session published." only, and drop Auto Enroll claims from the confirms until the allocator is injected (`autoEnrolAvailable` flag) |
| H11 | Algorithm A4 | End series: drafts after the last date are cancelled. Published ones are kept unless the admin ticks "Also cancel ..." | Swap the confirm lines to match the ruling. The counts approach stays |
| H12 | Algorithm conflict 10 | Fee edits are refused on a published session with active registrations (`feesLocked`) | If allowed with a warning: the fee inputs stay editable, and "or fees" stays in the change-notice line |
| H13 | UI/UX | The context-free `InlineConfirm` gains a `dismissLabel` ("Keep session", "Keep editing", "Keep series") and optional fields | A "Cancel" dismiss next to "Cancel session" is ambiguous and must not ship |

---

## Copy deck (provisional)

The UI/UX doc finalises. Codes are `?notice=` values. Spec strings are marked (spec) and should only change for a reason given here.

### Sessions list
| Key | Copy |
|---|---|
| H1 | Sessions for {team name} |
| Intro | Set up one-off sessions or a series that repeats. Members can register once a session is published. |
| Create hint | A series adds its sessions for you and adds members on Auto Enroll. One-off sessions don't. |
| Buttons | New session · New recurring series (spec) |
| Sections | Upcoming · Drafts · Series · Past and cancelled (spec) |
| Empty Upcoming | No upcoming sessions. Published sessions appear here. |
| Empty Drafts | No drafts. |
| Empty Series | No recurring series yet. |
| Empty Past | Nothing here yet. |
| Labels | Published · Started · Ended · Completed · Cancelled · Draft · Draft · bank account needed · Draft · Edited · Scheduled · opens {date} · Not published · date passed |
| Tags | Edited · Series: {series name} |
| Series row status | Active · Ended {date} · Adding sessions… |
| Banking banner | Some sessions weren't published because your team's bank account isn't set up. · link: Set up banking and GST |

### Session editor
| Key | Copy |
|---|---|
| H1 new / existing | New session · {Location}, {Wed 4 Nov 2026} |
| Scope: one-off | One-off session. Members on Auto Enroll aren't added to one-off sessions; they can register themselves once it's published. |
| Scope: series, unedited | One date in {series name}. Changes here apply to {Wed 4 Nov} only. Once you save a change, this date is marked Edited and changes to the series won't overwrite it. |
| Scope: series, edited | Edited. This date has its own details, so changes to {series name} don't apply to it. |
| Back link | Back to {series name} · Back to Sessions |
| Fixed date (series) | To move this night, cancel it and create a one-off session. |
| Status: draft | Draft. Members can't see it until you publish it. |
| Status: edited draft | This date has been edited, so it won't be published automatically. Publish it when it's ready. |
| Status: banking draft | This session wasn't published because your team's bank account isn't set up. · link: Set up banking and GST |
| Status: published | Published. Members can register. |
| Status: published, auto-enrol in progress | Published. Members can register. Members on Auto Enroll are being added. |
| Registrations line | No one has registered yet. · {n} players are registered. |
| Change notice | {n} players are registered. If you change the date, times, place, cancellation deadline or fees, we'll email them the new details. |
| Fees locked | Fees can't change once players have registered, because they agreed to this price. |
| Capacity hint (published) | Lowering this won't remove anyone who's already in. |
| Deadline hint | 48 hours before the first court starts. Change it if you need to. |
| Buttons | Save draft · Save and publish · Save changes · Cancel session |
| Publish prompt | Publish this session? Members can register straight away, and each player is charged after the game: {fee summary}. [+ series: Members on Auto Enroll will be added to it.] |
| Publish buttons | Publish session / Publishing… · Keep editing |
| `draft_saved` | Draft saved. (spec) |
| `published` | Session published. Members can now register. (spec; H10) |
| `publish_refused_banking` | Add your team's bank account details before publishing a paid session. (spec, verbatim API) · Your changes are saved as a draft. · link: Set up banking and GST (spec) |
| Publish incomplete | Your other changes are saved as a draft. (+ field errors) |
| `changes_saved` | Changes saved. [+ We're emailing the {k} registered players the new details.] [+ {p} players moved off the waitlist and were emailed.] |
| `instance_saved_first` | Changes saved for {Wed 4 Nov}. This date is now marked Edited. |
| `nothing_changed` | Nothing to change. |

### Cancel
| Key | Copy |
|---|---|
| Prompts | see Journey E table |
| Dismiss | Keep session · Keep draft |
| `cancelled` (n=0) | Session cancelled. No one had registered. |
| `cancelled` (k>0) | Session cancelled. We're emailing the {k} registered players to let them know. |
| `cancelled` (n>0, k=0) | Session cancelled. {n} players were registered. Let them know it's cancelled. |
| `cancelled` (draft) | Draft cancelled. |

### Read-only reasons
| Case | Copy |
|---|---|
| Started | This session has started, so it can't be changed or cancelled. |
| Ended | This session has ended, so it can't be changed. |
| Completed | This session is complete, so it can't be changed. |
| Cancelled | This session was cancelled, so it can't be changed. |
| Expired draft | This draft's start time passed before it was published, so it can't be published or changed. |

### Series
| Key | Copy |
|---|---|
| H1 new | New recurring series |
| Repeats options | Weekly · Every 2 weeks · Monthly |
| Fields | First session · Repeat until (optional) |
| Derived line | Every {Wednesday} from {4 Nov 2026}[ until {16 Dec 2026}] · Every second {Wednesday} from … · On the {first} {Wednesday} of each month from … |
| Publish hint | Sessions are added {28} days ahead and published automatically, so members can register as soon as each one appears. |
| Deadline hint | 48 hours before the first court starts, for every session in the series. |
| Create prompt | Create this series? Sessions from {Wed 4 Nov} are added now and published for registration. Members on Auto Enroll are added to each one. [+ Each player is charged after the game: {fee summary}.] [+ Your team's bank account isn't set up, so the sessions will be saved as drafts until it is.] |
| Create buttons | Create series / Creating… · Keep editing |
| `series_created` | Series created. (spec) |
| Waiting | We're adding the sessions in this series. Refresh in a moment. (spec) · link: Refresh |
| Waiting done (announced) | {n} sessions added. |
| Slow | This is taking longer than usual. Your series is saved and its sessions will appear here. Refresh in a minute. |
| None yet | No sessions yet. The first one, {Wed 6 Jan 2027}, will be added on {Wed 9 Dec 2026}. |
| Horizon line | Sessions are added {28} days ahead. The next one, {Wed 9 Dec}, will be added on {Wed 11 Nov}. |
| Summary | {Weekly on Wednesdays} · {7:00 pm–9:00 pm} · {9} courts · {$12.00 each} · from {4 Nov 2026} · until {16 Dec 2026} / no end date |
| Edit link | Change series details |
| Fixed fields | To change the day or how often it repeats, end this series and start a new one. |
| Effect line | Your changes will apply to {u} upcoming sessions and to sessions added later. {e} edited sessions keep their own details. Past and cancelled sessions don't change. [+ A3 variants] |
| Save button | Save series |
| `series_saved` | Series saved. {u} upcoming sessions updated. {e} edited sessions kept their own details. [+ We're emailing registered players about the {s} sessions whose time, place or fees changed.] [+ {b} published sessions weren't changed because your team's bank account isn't set up.] [+ We're adding the new dates. Refresh in a moment.] |
| Async fallback | Series saved. We're updating its upcoming sessions. · Last change: {u} upcoming sessions updated, {e} edited sessions kept their own details. |
| Shorten refused | To stop the series sooner, use End series. |
| Stale | This series changed since you opened it. Review the latest version and save again. |
| Banking notice (S2b) | {n} sessions in this series were saved as drafts because your team's bank account isn't set up. Members can't register for them yet. · link: Set up banking and GST (spec, with count) |
| Banking ready (S2r) | Your bank account is set up. {n} sessions in this series are still drafts. They'll be published automatically overnight, or you can publish them now. [+ {e} edited drafts need you to publish them yourself.] · button: Publish drafts now |
| Publishing drafts | We're publishing the drafts in this series. Refresh in a moment. |
| End trigger / prompt | End series · End this series? No sessions will be added after the last date. |
| End fields | Last date · Also cancel the {p} published sessions after this date[; {n} registered players will be emailed] · {d} draft sessions after this date will be cancelled. |
| End buttons | End series / Ending… · Keep series |
| `series_ended` | Series ended. No new sessions will be added after {date}. (spec) [+ {c} sessions after that date were cancelled.] |
| Ended state | Ended. Last session {date}. To run it again, create a new series. |

### Stale and shared
| Key | Copy |
|---|---|
| Session stale | This session changed since you opened it. Review the latest version and save again. (replaces spec) |
| Outage / failed / unconfirmed | `OUTAGE_MESSAGE`, `SAVE_FAILED_MESSAGE`, `UNCONFIRMED_MESSAGE` (existing) |
| Apply to all (live) | Times applied to {n} courts. |

### People page (amended, merged feature)
| Key | Copy |
|---|---|
| Auto Enroll hint | Adds {name} to new sessions in your recurring series automatically, in the order Auto Enroll was switched on. Sessions still follow the usual capacity and payment rules, so {name} is charged like any other player. Only turn this on for players who have agreed to it. |

### Materialiser banking email to admins (provisional)
- **Subject**: Sessions not published for {team name}: bank account needed
- **Body**:
  > Hi {first name},
  >
  > The series "{series name}" added {n} paid sessions for {team name}, but they were saved as drafts because the team doesn't have a bank account set up. Members can't register for them yet.
  >
  > Set up banking and GST: {WEB_BASE_URL}/teams/{teamId}/manage/banking
  >
  > Once it's set up, the drafts are published automatically overnight, or you can publish them now from the series page: {WEB_BASE_URL}/teams/{teamId}/manage/sessions/series/{ruleId}
  >
  > You're getting this because you're an admin of {team name}.
- **Rules**: no amounts, no bank values, no member names. One per rule per run window (`payout-missing:<ruleId>:<windowStart>`).

---

## Acceptance Criteria

The task file's ACs stand. This section (1) maps each journey step to them, and (2) gives the journey-level criteria that are new or amended. Proposed IDs take the next free number in each family. Renumber them if the Algorithm or Architecture docs propose ACs with the same numbers.

### Step-to-AC map

| Journey step | Task ACs |
|---|---|
| A1 list, sections, labels, banner | AC-ENTRY-1, AC-ENTRY-2 (amended: labels, Started in Upcoming), AC-ASYNC-3 |
| A2-A3 create and draft | AC-HAPPY-1, 2, 3, 11, AC-ERROR-2, 3 |
| A4 save and publish | AC-HAPPY-4 (amended: saves first; create-and-publish on `/new`), AC-ERROR-4, AC-VERIFY-2 |
| A5 banking hand-off | AC-ERROR-1 |
| A6 published | AC-HAPPY-4, AC-HAPPY-8 |
| B1-B2 series create and confirm | AC-HAPPY-5 (amended: weekday derived, create confirm) |
| B3-B4 waiting and listed | proposed AC-ASYNC-5, AC-HAPPY-5, AC-ASYNC-1 |
| B5 banking drafts | AC-ASYNC-3, AC-ASYNC-4, proposed AC-ASYNC-6 |
| C1-C2 date edit | AC-HAPPY-6 (amended: no-op does not mark Edited; scope line; fixed date) |
| D1-D2 series change | AC-HAPPY-7 (amended: effect line + report) |
| D3 end series | AC-HAPPY-10 (amended: confirm with counts; shortening refused in editor) |
| E1-E2 cancel and change | AC-HAPPY-9 (amended: prompt variants), proposed AC-HAPPY-13 |
| F read-only | AC-ERROR-5 (amended: all edits refused after start), proposed AC-ERROR-10 |
| G stale | AC-ERROR-7 (amended copy) |
| H Auto Enroll | AC-ASYNC-2, proposed AC-HAPPY-12 |
| Navigation and return | proposed AC-NAV-1, AC-NAV-2 |
| End to end | AC-INTEGRATION-3 (amended walk) |

### AC-HAPPY-12 (proposed): Series sessions auto-enrol on first publish by any path; one-off sessions never do
**Priority**: MUST
**Given** team T with members on Auto Enroll, a series date S1 that is DRAFT because of a banking refusal (banking since set up), an edited DRAFT series date S2, and a one-off DRAFT session O
**When** the admin publishes S1, S2 and O from their editors
**Then**:
  - after each of S1 and S2 is PUBLISHED, `selectAutoEnrollees` is called with that session's `date` and the allocator port receives exactly one `autoEnrolInSession` call per session. The call runs in a follow-up transaction that has not locked the session, or in a `session-auto-enrol:<sessionId>` job enqueued in the publish transaction (C-SKL-1 point 5).
  - O's publish triggers no selection and no port call.
  - a later materialiser run or a second publish attempt does not call it again for S1 or S2.
  - the publish confirm of S1/S2 contains "Members on Auto Enroll will be added to it." and O's editor shows the one-off scope line.

**Verification**:
- [ ] Integration: recording allocator double sees one call each for S1, S2, none for O, none on re-run
- [ ] Component: one-off scope line, series publish prompt text

### AC-HAPPY-13 (proposed): Cancelling or materially changing a published session triggers the notifier and tells the admin in counts
**Priority**: MUST
**Given** a PUBLISHED, not-started session with `n` active registrations (seeded through the factories), a recording notifier double returning `{ emailed: k }`, and separately the no-op notifier
**When** the admin cancels it, or saves a change to its start time, location, address, deadline or (if allowed) fees
**Then**:
  - the notifier is called once inside the same transaction, after the session update, with `kind` and the changed material fields.
  - it is not called for a change only to courts, max players or reserved seats that leaves the time range unchanged, nor for DRAFT sessions.
  - the banner shows the matching variant ("No one had registered." / "We're emailing the {k} registered players ..." / "{n} players were registered. Let them know it's cancelled.").
  - the cancel prompt shows the matching variant before confirming.
  - no `registrations` row changes (C-SSE-4).
  - the no-op logs `session.notify.port_noop` with `sessionId`, `kind`, `registrations`, and no email addresses.

**Verification**:
- [ ] Integration: double sees the call in-transaction (rollback leaves no call effect), fields correct, no call for non-material edits
- [ ] Unit: banner and prompt variant selection
- [ ] E2E: cancel with 0 registrations shows "No one had registered."

### AC-ASYNC-5 (proposed): The admin sees the series' sessions arrive, or knows why they haven't
**Priority**: MUST
**Given** the admin has just created or changed a series
**When** the series page loads before the per-rule run has completed
**Then**:
  - the API reports `materialisation.state = 'pending'` and the page shows "We're adding the sessions in this series. Refresh in a moment." with a working "Refresh" link.
  - with JavaScript, the page refreshes itself at most three times within about 15 s, then announces "{n} sessions added." politely when the state becomes ready, without moving focus.
  - if still pending after the last refresh, it shows the slow-path message and stops refreshing.
  - when the run has completed but no date is inside the horizon, it shows "No sessions yet. The first one, {date}, will be added on {date}."

**Verification**:
- [ ] Integration: `materialisation.state` pending before the job, ready after
- [ ] Component: bounded refresh count, live-region text, slow-path text, none-yet text
- [ ] E2E: series create → waiting line → instances listed within 15 s with the worker running

### AC-ASYNC-6 (proposed): "Publish drafts now" retries banking-refused drafts on demand
**Priority**: SHOULD
**Given** a series with unedited banking-refused DRAFT dates in the future, and an edited DRAFT date, after the team has set up banking
**When** the admin opens the series page and chooses "Publish drafts now"
**Then**:
  - the page shows the S2r notice with both counts before the action.
  - the action enqueues one per-rule materialisation run (a double click enqueues one) and the page shows "We're publishing the drafts in this series. Refresh in a moment."
  - after the run, the unedited drafts are PUBLISHED through the gate (AC-ASYNC-4) with auto-enrol, and the edited draft stays DRAFT, labelled "Draft · Edited".

**Verification**:
- [ ] Integration: one job per rule under double submit; edited draft untouched
- [ ] E2E: covered by the amended AC-INTEGRATION-3 walk

### AC-ERROR-10 (proposed): Started, ended and expired sessions are labelled and read-only with a reason
**Priority**: MUST
**Given** sessions that are PUBLISHED and started, PUBLISHED and ended, COMPLETED, CANCELLED, and DRAFT with a past start
**When** the admin opens the Sessions list and each editor
**Then**:
  - the API returns `phase` from its clock, and the list labels them Started (in Upcoming), Ended, Completed, Cancelled and "Not published · date passed" (in Past and cancelled).
  - each editor renders a read-only summary (no inputs, no Save, Publish or Cancel) with the matching one-line reason.
  - a form posted to any of them answers 409 (`session_started` or `session_not_editable`) and the page reloads read-only with the reason focused.

**Verification**:
- [ ] Unit: label and reason selection from `status` + `phase`
- [ ] Integration: every write after `starts_at` refused (amended AC-ERROR-5)
- [ ] Component: read-only render has no form controls

### AC-NAV-1 (proposed): Leaving and returning never loses saved work or waiting state
**Priority**: SHOULD
**Given** the admin saved a draft, or created a series that is still materialising
**When** they navigate to another manage area and come back through the area nav and the list
**Then** the draft opens from Drafts exactly as saved, and the series page shows its current state (pending or listed). Unsaved typed values are not kept, and no native "leave page?" dialog appears.

**Verification**:
- [ ] E2E: navigate away and back for both

### AC-NAV-2 (proposed): The banking hand-off returns to where it started (editor, series page or list)
**Priority**: MUST
**Given** a banking refusal shown on the session editor, the series page (S2b) or the Sessions list (L2)
**When** the admin follows "Set up banking and GST", saves banking and chooses "Back to your session"
**Then** they land on the page they started from (the `returnTo` is that page's path, accepted by `bankingReturnTo`). On the editor, "Save and publish" now succeeds. On the series page, the S2r notice and "Publish drafts now" are shown.

**Verification**:
- [ ] Unit: `returnTo` built for each of the three pages and accepted by `bankingReturnTo`
- [ ] E2E: editor round trip (AC-ERROR-1) and series round trip (AC-INTEGRATION-3)

### Amended task ACs (journey parts)
- **AC-HAPPY-4**:
  - "Save and publish" saves the form first, then publishes.
  - On a refusal the save stands, and the banner adds "Your changes are saved as a draft."
  - `/new` offers "Save and publish" as create then publish.
  - A free session publishes without a confirm. A paid one confirms with the fee summary.
- **AC-HAPPY-5**:
  - The weekday is derived from "First session".
  - "Create series" opens an InlineConfirm stating that sessions publish automatically, that Auto Enroll applies, the fee summary, and the banking heads-up when not configured.
- **AC-HAPPY-6**:
  - A save that changes nothing leaves `is_instance_overridden` false and shows "Nothing to change."
  - The editor shows the instance scope line, and the series date is not editable.
- **AC-HAPPY-7**:
  - Before saving, the series editor shows the effect line computed from `seriesChangeEffect`.
  - After saving, the banner shows the same counts (`updated`, `keptEdited`, plus the A3/H4 counts).
- **AC-HAPPY-9**: the cancel prompt and banner follow the Journey E variants. The dismiss label is "Keep session" or "Keep draft".
- **AC-HAPPY-10**:
  - The End series confirm has "Last date", the draft-cancel line and the optional "Also cancel the {p} published sessions after this date".
  - The banner adds the cancelled count.
  - An earlier "Repeat until" in the series editor is refused with "To stop the series sooner, use End series."
- **AC-ENTRY-2**: rows carry the derived labels and tags. Started sessions stay in Upcoming until `ends_at`. The list shows the banking banner when banking-refused drafts exist.
- **AC-ERROR-5**: after `starts_at`, every edit is refused with 409 `session_started`, not only capacity edits and cancel. The editor is a read-only summary.
- **AC-ERROR-7**: the copy becomes "This session changed since you opened it. Review the latest version and save again." (and the series equivalent).
- **AC-INTEGRATION-3**: the walk becomes:
  1. create the 3-court weekly paid series through the create confirm;
  2. see the waiting line, then drafts labelled "Draft · bank account needed" with the S2b notice and the email in Mailpit;
  3. "Set up banking and GST" from the series page, save, "Back to your session";
  4. S2r, then "Publish drafts now", then Published;
  5. edit one date's capacity (marked "Edited");
  6. change the series start time and see "… 1 edited session kept its own details.";
  7. cancel one date, see "Session cancelled. No one had registered."

---

## Test Scenarios (derived from the criteria above)

### Happy path
1. AC-ENTRY-1/2: nav, sections, labels, empty states.
2. AC-HAPPY-1..4: one-off create, draft, save and publish (paid with confirm, free without).
3. AC-HAPPY-5 + AC-ASYNC-5: series create confirm, waiting state, instances listed.
4. AC-HAPPY-6/7: date edit marks Edited (and a no-op does not), series save effect line and report.
5. AC-HAPPY-12: auto-enrol on manual publish of series dates, not one-off.
6. AC-ASYNC-6: "Publish drafts now".

### Error scenarios
1. AC-ERROR-1 + AC-NAV-2: banking refusal round trips from the editor and the series page.
2. AC-ERROR-2/3/4: field errors, DST, incomplete pricing after save-then-publish.
3. AC-ERROR-5 + AC-ERROR-10: read-only views and 409s across the start boundary.
4. AC-ERROR-7: stale save with neutral copy.
5. AC-HAPPY-13: cancel and change notifier variants, including the no-op fallback.

### Edge cases
1. First date beyond the horizon ("No sessions yet ...").
2. Slow materialisation (worker stopped): slow-path message, refresh stops.
3. Edited banking draft not auto-published, labelled, counted separately.
4. End series with published sessions after the date, ticked and unticked.
5. AC-NAV-1: leave and return.

---

## Accessibility Checklist

- [ ] Keyboard: every control in DOM order, including the court rows, "Apply to all courts", confirms (Escape closes and returns focus to the trigger) and the series rows' "Edit {date}" links (unique accessible names).
- [ ] Screen reader: the scope line is the first text after the H1 and is not a tooltip. Notices are `role="status"` (alerts `role="alert"`) and focused once. The bounded refresh announces "{n} sessions added." politely without moving focus. "Apply to all courts" announces the count.
- [ ] Labels are text, never colour alone ("Edited", "Draft · bank account needed", "Ended").
- [ ] Read-only sessions use description lists, not disabled inputs.
- [ ] No time limits. The auto-refresh is bounded and does not move focus. The manual "Refresh" link is always present.
- [ ] Errors: summary focused, each field `aria-invalid` with `aria-describedby` to its message.
- [ ] No native dialogs, no `beforeunload`.
- [ ] 360 px: the UI/UX doc's responsibility. The journey keeps one primary action per page so it fits.

## Analytics & Observability

There is no analytics backend. Measures come from the structured logs in AC-VERIFY-6, with these fields proposed:

| Metric | Source | Target |
|---|---|---|
| One-off completion (created → published) | `session.created`, `session.published` (`source: 'manual' \| 'materialiser'`) | Most drafts published within a day |
| Banking refusals | `session.publish_refused`, `session.recurrence.publish_refused` | Falling to zero after first setup |
| Time to first instances | `session.series.created` → first `session.recurrence.instance_created` per `ruleId` (`trigger: 'rule' \| 'cron' \| 'operator'` on `run_completed`) | Under 15 s at p95 |
| Series save impact | `session.series.updated` with `updated`, `keptEdited`, `keptRegistered`, `keptBanking` | Observed; drives the T2 "Reset to series" decision |
| Stale saves | `session.updated` refusals with `errorCode: 'session_stale'` | Rare |
| Notifier gap | `session.notify.port_noop` with `registrations > 0` | Zero once registration ships |
| Manual-publish auto-enrol | `session.auto_enrol.completed` with `source: 'manual_publish'` | One per manually published series date |

## Validation Checklist

- [x] The journey delivers the stated value (set up once, change one night, change the series, publish safely)
- [x] All personas: admin, co-admin (stale, email), player (told through the notifier, never auto-booked into one-offs)
- [x] Every error is recoverable without retyping saved work
- [x] Async states are visible, bounded and honest
- [x] Consistent with People, Banking and skill-levels patterns
- [x] Accessible per the checklist above
- [x] Testable: each new or amended criterion has its verification

## Next Steps

1. The UI/UX doc lays out the list, both editors, the court table (C1), costing and pricing (C4), labels and read-only summaries (C5) at desktop and 360 px, and finalises the copy deck above.
2. Reconcile H1-H13 against the Algorithm and Architecture docs in the task's binding reconciliation.
3. Send H9 (notifier port) and the manual-publish auto-enrol rule to registration-and-waitlist as plan amendments beside R16/R17.

---

## Amendments to the task file

Proposed for the creative reconciliation. The task file was not edited.

1. **Scope Boundaries, In scope**: add "the session-change notifier port (calls from the cancel and material-change transactions, material-field classification, no-op default, admin-facing counts)". **Out of scope**: replace "Emailing registered players when a session is cancelled or changed (open question C3)" with "Player email templates, recipients and sending for cancellations and changes (registration-and-waitlist implements the notifier port; hand-off H9)".
2. **New ACs**: AC-HAPPY-12 (series auto-enrol on any first publish, never one-off), AC-HAPPY-13 (notifier and admin counts), AC-ASYNC-5 (waiting state), AC-ASYNC-6 SHOULD ("Publish drafts now"), AC-ERROR-10 (labels and read-only), AC-NAV-1 SHOULD, AC-NAV-2 MUST, as written above.
3. **Amended ACs**: AC-ENTRY-2, AC-HAPPY-4, 5, 6, 7, 9, 10, AC-ERROR-5, AC-ERROR-7 (copy), AC-INTEGRATION-3 (walk), as listed under "Amended task ACs".
4. **Invocation Method, Element**:
   - Buttons on the session editor become "Save draft", "Save and publish", "Save changes" (published) and "Cancel session".
   - The series page is summary-first with "Change series details" (`?edit=details`) and "Publish drafts now".
   - The series form asks "Repeats", "First session" and "Repeat until" (no separate weekday input).
   - Confirmations use a context-free `InlineConfirm` with a configurable dismiss label.
5. **Success Criteria copy**:
   - The stale message becomes neutral.
   - The materialiser banking notice carries a count.
   - Add the cancel banner variants and the series report banner.
6. **API** (MEDIUM, final shape in Architecture):
   - the session GET adds `phase`, `draftReason`, `activeRegistrationCount`, `notifiesRegistrants`, `feesLocked`;
   - the series GET adds `materialisation`, per-instance `seriesChangeEffect`, `nextDate`/`nextDateAddedOn`, draft counts, `isPayoutConfigured`, `lastChange`;
   - write responses carry the counts listed under Backend requirements;
   - new `POST /teams/:teamId/session-series/:ruleId/publish-drafts`.
7. **AC-ERROR-5 / conflict 8**:
   - Cancel is allowed only before `starts_at` (confirmed).
   - Every edit after `starts_at` is refused with `session_started`, because a court change after the start moves `ends_at`, which billing reads.
   - Started sessions are listed under Upcoming with the label "Started" until `ends_at`, then under Past and cancelled as "Ended".
8. **AC-VERIFY-6 events**:
   - add `session.notify.port_noop`;
   - add `source` to `session.published` and `session.auto_enrol.completed`;
   - add `trigger` to `session.recurrence.run_completed`;
   - add the count fields to `session.series.updated`.
9. **Cross-feature copy on `main`**: amend the Auto Enroll hint in `apps/web/src/components/teams/skill-enroll-panel.tsx` (line 293) and its test in `manage-components.test.tsx` to say "new sessions in your recurring series". Add to the Phase 5 file list.
10. **Hand-off to registration-and-waitlist** (record in ADR 0019 "Offered contracts", and send as a plan amendment):
    - implement the session-change notifier port (H9);
    - acknowledge that a manual publish of a series date calls `autoEnrolInSession` once (follow-up transaction or a `session-auto-enrol:<sessionId>` job).
11. **Creative Phases**: mark the User Journey phase complete with this output, and list H1-H13 for the build-gate reconciliation.
