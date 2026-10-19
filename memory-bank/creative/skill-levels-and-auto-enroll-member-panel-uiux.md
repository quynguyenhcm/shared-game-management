# UI/UX Decision: Members-row Skill Level and Auto Enroll Controls

**Created**: 2026-10-17
**Status**: DECIDED
**Decision Type**: UI/UX
**Task**: skill-levels-and-auto-enroll (Level 3)
**Answers**: Creative Q5 (row-control layout; where the progress line sits), plus the copy, status-region, focus and date-input rules the spec left open for Phase 5.
**Defers to**: algorithm agent (override resets the counting baseline, same-level save is a no-op, surplus games discarded: the hint copy below assumes the drafted defaults), architecture agent (response shape of the two `PUT` routes), user-journey agent (entry and exit narrative).

Sources read: task file (branch tip: Specification, Creative Q5, Phase 5), `main:productBrief.md`, `main:systemPatterns.md` (Guiding Principles, "Manage area registry and inline confirm"), `apps/web/src/components/teams/{member-list,inline-confirm,option-fieldset,skill-level-field,moderation-button,manage-section,manage-context,use-moderation-action,banking-form}`, `apps/web/src/lib/teams/{manage-view,manage-state,labels,moderation}.ts`, and `memory-bank/creative/team-banking-and-gst-banking-page-uiux.md`. `memory-bank/ux-patterns.md` does not exist on `main`, so the team-management components above are the pattern source.

## User Context

### Target Users
- **Primary**: Team Admin (`TEAM_ADMIN`), a volunteer club organiser who is often on a phone at 360 px. They scan the Members list to see who is at which level, correct a level now and then (a new joiner who under- or over-rated themselves), and switch on Auto Enroll for regulars. They are not technical and do not want to learn what "baseline" means.
- **Secondary**: a second admin who opens the page to check why a member shows a level or an Auto Enroll tag (the provenance line answers "who changed this and when"). Players never see these controls.

### User Goals
1. See at a glance each member's level, who set it, and how far they are from the next one.
2. Change a level with one deliberate action and get unmistakable confirmation on the row.
3. Switch Auto Enroll on or off for a regular, optionally with an end date, without ambiguity about what the end date means.
4. Never lose typed input to an error, and never be blocked by a native browser dialog.

### Use Cases
| Use Case | User | Goal | Frequency |
|----------|------|------|-----------|
| Scan levels and progress | Team Admin | Spot who is near promotion or mis-levelled | Weekly |
| Override a level | Team Admin | Correct a self-assessed level | A few times per season |
| Turn Auto Enroll on (end date or none) | Team Admin | Pre-fill sessions for a regular | Occasional |
| Change only the end date | Team Admin | Extend or shorten a regular's run | Occasional |
| Turn Auto Enroll off | Team Admin | Stop pre-filling a member | Occasional |
| Check provenance | Second admin | Who set this level, and when | Rare |

### Constraints
- **Devices**: desktop and 360 x 740 phone (the two Playwright projects); no horizontal scroll at 360 px; 44 px targets (`min-h-11`); 16 px input text (no iOS zoom).
- **Accessibility**: WCAG 2.1 AA; axe has no serious or critical violation (AC-VERIFY-8); every control has an accessible name that contains its visible label; errors tied to fields with `aria-describedby`; no native `alert`/`confirm`/`<dialog>` (a UAT blocker); meaning never carried by colour alone.
- **Locale**: English only; NZ dates ("17 Oct 2026"); stored instants are UTC and shown in Pacific/Auckland only at the UI boundary (P3); `until` is a calendar date, not an instant.
- **Existing patterns that must be reused** (no new colours, fonts or dependencies): `Tag`, `SECONDARY_BUTTON_CLASS`, `INPUT_CLASS`, `FOCUS_RING`, `OptionFieldset`, `FieldError`/`describedBy`, `FormBanner`, `ManageProvider` open-state reducer (one open panel per section), the `InlineConfirm` disclosure behaviour, `formatManageDate`, Server Actions that never update optimistically and revalidate only on success.
- **Guiding principles**: the API is the authority and the UI never hides a rule it cannot prove (P1); every instant and date goes through one formatter (P3).

## User Flow

### Flow Diagram
```
My teams -> Manage -> /teams/<id>/manage  (Members section)
   |
   v
 Row: name, role | level + Auto Enroll tag | provenance | progress   [Skill and Auto Enroll]
   |  activate trigger (aria-expanded=true)
   v
 Panel (focus -> its heading)
   +-- Skill level form ----- Save skill level --+-- 200 changed: "Skill level for X set to Y."  (panel stays open, row updates)
   |                                             +-- 200 same:    "X is already Y."
   |                                             +-- 422:         field error, typed value kept
   +-- Auto Enroll form ----- Save Auto Enroll --+-- 200: "Auto Enroll on for X until 30 Nov 2026." / "... with no end date." / "... turned off for X."
   |                                             +-- 422: "Choose today or a later date."
   |                                             +-- 5xx/offline: "We couldn't save that. Nothing was changed. Try again."
   |                                             +-- 404/409: stale message in Members status region, panel closes, list refreshes
   +-- Close (or Escape) -> panel closes, focus returns to the trigger
```

### Flow Description
1. **Entry**: `/teams/<id>/manage`, Members section. Every APPROVED row (admins and yourself included) shows the read-only lines and the trigger.
2. **Read**: the row answers "what level, who set it, how close to the next, is Auto Enroll on" without opening anything.
3. **Open**: "Skill and Auto Enroll" opens a non-modal panel under the row; focus moves to the panel heading.
4. **Act**: each form saves on its own. The panel stays open after a successful save so the admin can do the other form without reopening; the confirmation appears inside the panel next to the button just pressed, and the row above updates after revalidation.
5. **Exit**: Close, Escape, or opening another row's panel or confirm (one open per section). Closing discards unsaved typing.

### Error States
| Error | Cause | User Recovery |
|-------|-------|---------------|
| "Select a skill level." | 422 on `skillLevel` (no radio selected in the request) | Pick a level; the radio group is focused |
| "Choose today or a later date." | `until` before today (NZ), found client-side or by the API (422) | Pick a later date, clear the date, or untick Auto Enroll |
| "Enter a complete date, or clear the field." | Partially typed date (`validity.badInput`; the browser reports `''`, which would otherwise save as "no end date") | Finish the date or press "Clear date" |
| "We couldn't save that. Nothing was changed. Try again." | API down, 5xx, or the browser is offline | Panel stays open with typed values; press Save again |
| Stale list message (`STALE_MESSAGE`) | 404 or 409: the person is no longer an approved member | Message in the Members status region, panel closes, list refreshes, focus goes to the Members heading |
| "You don't have access to manage this team." (`NO_ACCESS_HEADING`) | 403 (rights lost mid-request) | Same region and refresh; the page then shows the no-access view |

## Options Explored

### Option 1: One disclosure panel with two independent forms (the draft)
- **Approach**: One trigger per row opens one panel under the row. The panel holds a "Skill level" form and an "Auto Enroll" form, each with its own Save and its own status line. The row itself carries all read-only facts.
- **Wireframe/Layout** (desktop, row collapsed, then open):
  ```
  +----------------------------------------------------------------------------------+
  | Priya Patel  [Member]                  [Skill and Auto Enroll] [Make admin] [Ban] |
  | Intermediate  [Auto Enroll until 30 Nov 2026]                                     |
  | Set by Aroha Ngata · 17 Oct 2026                                                  |
  | 23 of 40 games toward Advanced                                                    |
  | +------------------------------------------------------------------------------+ |
  | | Skill and Auto Enroll for Priya Patel                                        | |
  | | +-- Skill level -----------------+  +-- Auto Enroll ---------------------+  | |
  | | | (o) Beginner                   |  | [x] Auto Enroll                    |  | |
  | | | (o) Intermediate               |  |     Until (optional)  [30/11/2026] |  | |
  | | | ( ) Advanced                   |  |     [Clear date]                   |  | |
  | | | [Save skill level]             |  | [Save Auto Enroll]                 |  | |
  | | | Skill level for ... set to ... |  | Auto Enroll on for ...             |  | |
  | | +--------------------------------+  +------------------------------------+  | |
  | |                                                              [Close]         | |
  | +------------------------------------------------------------------------------+ |
  +----------------------------------------------------------------------------------+
  ```
- **User Flow**: open, change one form, Save, read the in-panel confirmation, optionally do the other form, Close.
- **Pros**:
  - Reuses the one disclosure pattern the admins already know (focus in, Escape out, one open per section).
  - Each Save changes one thing, so each message is exact and a failure of one never muddies the other (the two `PUT` routes stay one-to-one with the two forms).
  - The same-level no-op (AC-HAPPY-3) and the Auto Enroll order rules (AC-HAPPY-9/10) each map to one clear message.
  - One new tab stop per row, so a 50-row list stays navigable by keyboard.
- **Cons**:
  - Two Save buttons in one panel; an admin who edits both before pressing one loses the other's edit unless it is explained (mitigated by the per-form headings and by not resetting the other form on a save).
  - A tall panel at 360 px (about 520 px with both forms).
- **Usability**: High
- **Accessibility**: High
- **Implementation Complexity**: Medium

### Option 2: One combined form with a single "Save"
- **Approach**: The panel is one `<form>` with the radios, the checkbox and the date, and one "Save changes" button.
- **Wireframe/Layout**:
  ```
  | Skill and Auto Enroll for Priya Patel          |
  |  (o) Beginner (o) Intermediate ( ) Advanced    |
  |  [x] Auto Enroll   Until [30/11/2026]          |
  |  [Save changes]                    [Close]     |
  ```
- **User Flow**: change anything, press one Save; one message summarises.
- **Pros**:
  - One Save button; shorter panel.
  - An admin cannot "lose" the other half of an edit.
- **Cons**:
  - The API has two routes (spec); one Save means two sequential requests with partial-failure states ("level saved, Auto Enroll failed") that need their own copy and recovery.
  - The message has to be assembled from up to two outcomes ("already Intermediate" plus "Auto Enroll on until...") and is harder to announce clearly.
  - An accidental open-and-save re-sends an unchanged level and unchanged Auto Enroll, adding noise and risk (the no-op path must be perfect).
  - A single validation error blocks an unrelated change.
- **Usability**: Medium
- **Accessibility**: Medium
- **Implementation Complexity**: Medium (a coordinator for two requests and partial failure)

### Option 3: Two disclosures per row ("Skill level" and "Auto Enroll")
- **Approach**: Two separate triggers on each row, each opening a small single-purpose panel.
- **Wireframe/Layout**:
  ```
  | Priya Patel [Member]                                   |
  | Intermediate [Auto Enroll until 30 Nov 2026]            |
  | Set by Aroha Ngata · 17 Oct 2026                        |
  | 23 of 40 games toward Advanced                          |
  | [Skill level] [Auto Enroll] [Make admin] [Ban]          |
  ```
- **User Flow**: pick the relevant button, small panel, Save.
- **Pros**:
  - Each panel is short; nothing to misread.
  - Strictest match of one control, one purpose.
- **Cons**:
  - Four controls per row; at 360 px the row becomes a stack of four full-width buttons and doubles in height.
  - Two tab stops per row plus Make admin and Ban: heavy for keyboard and screen-reader users scanning 50 rows.
  - One-open-per-section means switching between the two panels of one member closes the first, which is the same cost as Option 1's Close without the benefit of seeing both at once.
- **Usability**: Medium
- **Accessibility**: Medium
- **Implementation Complexity**: Medium (two panel components and two trigger labels)

### Option 4: A dedicated "Members and levels" area in `MANAGE_AREAS`
- **Approach**: A third area page (next to People and Banking) listing members as a table with a level selector and an Auto Enroll toggle per row.
- **Wireframe/Layout**:
  ```
  [People] [Banking and GST] [Members and levels]
  | Name           | Level   | Provenance | Progress | Auto Enroll |
  ```
- **User Flow**: navigate to the area, find the member again, edit inline.
- **Pros**:
  - Room for a roomy comparison table and later bulk edits.
  - Keeps the People rows lighter.
- **Cons**:
  - Duplicates the member list on a second page; the admin must find the person twice.
  - A wide table does not fit 360 px without a card layout that recreates Option 1 anyway.
  - Splits the "who is in my team" tasks (ban, make admin) from "what level are they", which are done together when reviewing a new joiner.
  - Contradicts the spec's Invocation Method ("no new page and no new entry in `MANAGE_AREAS`") and adds a nav entry for a small feature.
- **Usability**: Medium
- **Accessibility**: Medium (data table plus per-row controls)
- **Implementation Complexity**: High

## Evaluation Matrix

| Criteria | Option 1 | Option 2 | Option 3 | Option 4 |
|----------|----------|----------|----------|----------|
| Usability | High | Medium | Medium | Medium |
| Accessibility | High | Medium | Medium | Medium |
| Consistency (with `InlineConfirm`, manage page) | High | High | High | Low |
| Responsiveness (360 px) | Medium-High | High | Low | Low |
| Performance | High (panel mounted only when open) | High | High | Medium (second page, same data) |
| Implementation effort | Medium | Medium | Medium | High |

## Decision

**Chosen**: Option 1 - one disclosure panel with two independent forms, with the refinements below.

### Rationale
- **The trigger is the only new thing on the row.** The row already carries the role tag, "Make admin" or "Remove admin", and "Ban". One more button keeps the row to one extra tab stop and one extra full-width button at 360 px (Option 3 would add two). Read-only facts (level, provenance, progress, Auto Enroll tag) live on the row, so scanning the list needs no clicks.
- **Two forms, because there are two routes and two decisions.** Each Save reports one outcome in plain words, with no partial-failure state (Option 2) and no way for a validation error in the date to block a level change.
- **The progress line stays on the row**, not in the panel. The admin's scanning task ("who is close to 40?") is across many members; hiding it behind a click would defeat it, and AC-ENTRY-1 and AC-HAPPY-11 require the row to show it. To keep the row short it is a single `text-sm` line.
- **The confirmation appears in the panel, next to the button just pressed**, rather than in the Members section's status region at the top of a possibly 50-row list. At 360 px that region is off-screen when the admin is on row 30. The Members status region is kept for the cases where the row itself goes away (stale, no access).
- **No confirmation dialog for turning Auto Enroll off.** It is reversible and touches no registration; the cost (losing your place in the order) is stated in a hint beside the checkbox instead of behind a prompt.

### Trade-offs Accepted
- **Two Save buttons in one panel.** Mitigated by a visible heading per form ("Skill level", "Auto Enroll"), buttons named for what they save ("Save skill level", "Save Auto Enroll"), and by not resetting the other form after a save. An admin who edits both and presses only one keeps the other's edit in the form until Close.
- **Taller panel on a phone.** Mitigated by stacking, 44 px rows, and short help text. Closing is one tap and Escape works with a keyboard.
- **The panel stays open after success.** This differs from `InlineConfirm` (a confirm closes on success because its job is done). Here the panel is a workspace with two forms; closing after the first save would make a two-step edit cost two openings. Spec wording ("the panel reports ...") already assumes it stays open.
- **Needs JavaScript.** Same as `InlineConfirm`; the safe failure is "cannot change a level", not a wrong change.

## Design Specifications

### Layout
- **Desktop (>= 1024 px)**: row as today (info left, controls right: Skill and Auto Enroll, then Make admin or Remove admin, then Ban). The panel spans the full row width under the info and controls; the two forms sit side by side (`lg:grid-cols-2`, `gap-4`).
- **Tablet (640-1023 px)**: row as today; the panel is full width with the forms stacked, skill form first.
- **Mobile (< 640 px)**: everything stacks. Row order: name line, level and tag line, provenance, progress, then the control buttons (each full width, `min-h-11`), then the panel. Buttons in the panel are full width.
- **Reading order** (visual equals DOM): name, "(you)", role tag; level; Auto Enroll tag; provenance; progress; "Skill and Auto Enroll"; "Make admin"/"Remove admin"; "Ban"; panel.
- **Row structure change**: the `<li>` becomes `flex flex-col gap-3` with (a) the existing flex row (info and controls) and (b) the panel as a full-width sibling below it. The trigger sits in the controls cluster and the panel at `<li>` level; they share open state through `ManageProvider` (`open.members === 'skill-<userId>'`), the same reducer `InlineConfirm` uses, so opening any other member control (Ban confirm, another row's panel) closes this one.

### Row read-only block (`MemberSkillSummary`)
```
Priya Patel  [Member]
Skill level: Intermediate   [Auto Enroll until 30 Nov 2026]
Set by Aroha Ngata · 17 Oct 2026
23 of 40 games toward Advanced
```
- Line 2: `<p>` with an `sr-only` prefix "Skill level: " and the level in `font-medium text-base`; the Auto Enroll `Tag` follows in the same flex-wrap line, so it drops under the level at 360 px.
- Lines 3 and 4: `<p className="text-sm text-slate-700">` (about 10:1 on white; text is 14 px, fine for AA).
- Nothing relies on colour: the Auto Enroll states differ in words ("until", "no end date", "ended").

### Key Components
| Component | Purpose | Behavior |
|-----------|---------|----------|
| `MemberSkillSummary` | Row read-only block | Pure render of the view-model strings: level, provenance, progress, tag |
| `SkillEnrollTrigger` | Row button "Skill and Auto Enroll" | `SECONDARY_BUTTON_CLASS sm:w-auto`; `aria-expanded`, `aria-controls="<id>-panel"`, `aria-label="Skill and Auto Enroll, {fullName}"`; toggles the shared open state |
| `SkillEnrollPanel` | Non-modal `role="group"` under the row | Mounted only when open; heading `h3` is the focus target (`tabIndex={-1}`); Escape and Close close it and return focus to the trigger |
| `SkillLevelForm` | Skill level form | `OptionFieldset` (legend "Skill level") with admin-voiced options, current level preselected, hidden `teamId`, `userId`, `fullName`, `currentLevel`; "Save skill level" |
| `AutoEnrollForm` | Auto Enroll form | Checkbox "Auto Enroll", conditional date field "Until (optional)" with "Clear date", hidden `teamId`, `userId`, `fullName`; "Save Auto Enroll" |
| `FormStatus` (per form) | Result line | A persistent `role="status"` element, empty on mount, filled with the success message; errors use `FormBanner kind="error"` (focused) and `FieldError` |

### Exact copy
**Row (view model in `lib/teams/skill-levels-view.ts`)**

| Item | Copy |
|------|------|
| Trigger | "Skill and Auto Enroll" (accessible name "Skill and Auto Enroll, Priya Patel") |
| Provenance, never changed | "Self-assessed" |
| Provenance, admin override | "Set by {adminName} · {d MMM yyyy}" (the date is `skillOverride.at` in Pacific/Auckland) |
| Provenance, automatic | "Moved up automatically · {d MMM yyyy}" (`skillChangedAt`) |
| Provenance, override actor unknown (account removed) | "Set by a former admin · {date}" |
| Progress | "{n} of 40 games toward {Next level}" where `n` is capped at 40 and 40 comes from `required` (`SKILL_PROGRESSION_GAMES`), never a literal |
| Progress at the top level | "Highest level" |
| Tag, until set and not past | "Auto Enroll until {d MMM yyyy}" |
| Tag, no end date | "Auto Enroll, no end date" |
| Tag, past end date | "Auto Enroll ended {d MMM yyyy}" |
| Tag, off | no tag |

**Panel**

| Item | Copy |
|------|------|
| Panel heading | "Skill and Auto Enroll for {fullName}" |
| Skill legend | "Skill level" |
| Skill hint | "Used for pricing by skill level. Saving a different level restarts the count toward the next one." |
| Skill options (help is third person, not the player-facing "You play regularly...") | Beginner: "New to the sport or still learning the basics." Intermediate: "Plays regularly and knows the game well." Advanced: "Experienced and competitive." |
| Skill button | "Save skill level" (pending: "Saving…") |
| Auto Enroll checkbox | "Auto Enroll" |
| Auto Enroll hint | "Adds {firstName} to new sessions automatically, in the order Auto Enroll was switched on. Sessions still follow the usual capacity and payment rules." (use `fullName` when no first name is available) |
| Turning off a saved-on member (shown while the box is unticked and was saved on) | "Turning this off removes {fullName}'s place in the Auto Enroll order. Turning it on again puts them at the end." |
| Ended notice (saved on, `until` before today; neutral text, not an error) | "Auto Enroll ended {d MMM yyyy}. Choose a new end date, clear the date, or turn Auto Enroll off." |
| Date label | "Until (optional)" |
| Date hint | "The last day Auto Enroll applies, in NZ time. Leave empty for no end date." |
| Clear button | "Clear date" (shown only when the field has a value) |
| Auto Enroll button | "Save Auto Enroll" (pending: "Saving…") |
| Close button | "Close" |

**Results (live-region text)**

| Outcome | Copy |
|---------|------|
| Level changed | "Skill level for Priya Patel set to Advanced." |
| Level unchanged | "Priya Patel is already Intermediate." |
| Auto Enroll on, with date | "Auto Enroll on for Priya Patel until 30 Nov 2026." |
| Auto Enroll on, no date | "Auto Enroll on for Priya Patel, with no end date." |
| Auto Enroll off | "Auto Enroll turned off for Priya Patel." |
| `skillLevel` invalid | "Select a skill level." |
| `until` in the past | "Choose today or a later date." |
| `until` partly typed | "Enter a complete date, or clear the field." |
| 5xx, offline | "We couldn't save that. Nothing was changed. Try again." (`SAVE_FAILED_MESSAGE`, next to `OUTAGE_MESSAGE` in `labels.ts`) |
| 404, 409 | `STALE_MESSAGE` (Members status region) |
| 403 | `NO_ACCESS_HEADING` (Members status region) |

### Status region placement
- Each form owns one `role="status"` element placed directly under its Save button. It is rendered on first render of the panel (empty), then filled, so the first message is announced. Messages persist until the next action in that form (no auto-dismiss, WCAG 2.2.1). A new submit clears that form's message first so a repeated identical result is announced again.
- Success is never also written to the Members section's status region (no double announcement). That region is used only when the row goes away: stale (404/409) and no-access (403), because the panel unmounts.
- Failures: a `FormBanner kind="error"` at the top of the form that failed (existing component; takes focus on each new failure), plus inline `FieldError` for 422 field errors. Typed values stay.
- Only one form shows a message at a time: saving the other form clears the first form's message.

### The "Until (optional)" date input
- **Element**: native `<input type="date">` with a visible label, `INPUT_CLASS`, `aria-describedby` pointing at the hint (and the error when present), and `min={todayNz}`. The browser renders the locale format (dd/mm/yyyy for en-NZ devices); the hint avoids showing a format string that could disagree with the device.
- **`todayNz`**: computed on the server in `page.tsx` from the injected clock via the shared time helpers (P3) and passed down as a `YYYY-MM-DD` string. It is used for `min`, for the "ended" test on the tag, and for the client pre-check. It is advisory: the API is the authority (AC-ERROR-3). A page left open past midnight can disagree, in which case the API's 422 shows the same message.
- **Visibility**: shown only while the box is ticked (it follows the checkbox in DOM order, so no focus or live-region handling is needed). Unticking hides it and leaves it out of the submission, which satisfies the API rule that `until` with `enabled: false` is refused. The typed value is kept in component state, so re-ticking restores it.
- **NZ date**: "today" and "ended" are judged on the Pacific/Auckland calendar date, never the device's. The end date is inclusive: a session dated on the `until` day is still enrolled (AC-ASYNC-3), which the hint states.
- **Past dates**: `min` stops the picker offering them, but a typed past date is still possible. On submit a client pre-check (`validateUntil(value, todayNz)`) returns "Choose today or a later date." with no request. The same message arrives from a 422. An already-past saved date (ended) is shown, with the neutral "ended" notice, and is not an error until the admin presses Save without changing it.
- **Partially typed dates**: browsers report `''` for an incomplete date, which would silently save as "no end date". On submit, `input.validity.badInput === true` produces "Enter a complete date, or clear the field." and no request.
- **Clearing**: the "Clear date" button (`type="button"`, visible text equals accessible name) empties the field and returns focus to the date input. It appears only when there is a value. Saving with an empty date is "no end date" and the message says so. This is also the only reliable clear on desktop Chrome and iOS Safari, which have no built-in clear control.
- **Format of the saved date in copy**: `until` is a calendar date, not an instant. Do not pass it to `formatManageDate` unchanged (that formatter parses an ISO instant and applies Pacific/Auckland). Add `formatCalendarDate('2026-11-30')` that formats with `timeZone: 'UTC'`, so no timezone can shift the day.

### Interactions
| Trigger | Action | Feedback |
|---------|--------|----------|
| Activate "Skill and Auto Enroll" | Open the panel (closes any other open panel or confirm in Members) | `aria-expanded=true`; focus moves to the panel heading |
| Escape inside the panel, or "Close" | Close the panel | Focus returns to that row's trigger; typed values are discarded |
| Native date picker open and Escape | The browser closes the picker first; a second Escape closes the panel | None needed |
| Choose a radio, "Save skill level" | Server Action then `PUT .../skill-level`, revalidate on success | Button reads "Saving…" and is `aria-disabled` (not `disabled`, so focus stays); live region announces the result; the row updates; focus stays on the button |
| Tick or untick "Auto Enroll" | Show or hide the date field and the turn-off hint | None announced (the new content follows the checkbox in reading order) |
| "Clear date" | Empty the date | Focus to the date input |
| "Save Auto Enroll" | Server Action then `PUT .../auto-enroll` with `{ enabled, until }` | As above |
| Either Save while the other form is saving | Ignored | Both Save buttons are `aria-disabled` while either is pending (writes are serialised per row) |
| Save with a validation error | No request (client) or 422 (API) | `FieldError` under the field, `aria-invalid="true"`, focus to the first invalid field |
| 5xx or offline | No change, no revalidation | `FormBanner` focused with `SAVE_FAILED_MESSAGE`; typed values kept |
| 404/409/403 | Revalidate | Members status region message; panel closes; focus to `#members-heading` |

### Focus management
- **Open**: focus goes to the panel heading (an `h3` with `tabIndex={-1}`, named by `aria-labelledby` on the group), exactly like `InlineConfirm`'s prompt.
- **Tab order inside**: heading (programmatic only), skill radios (one tab stop, arrows inside), Save skill level, Auto Enroll checkbox, date, Clear date (when shown), Save Auto Enroll, Close.
- **After success**: focus does not move; the pressed Save button keeps focus and the live region speaks. This is the one deliberate difference from `useModerationAction`, which moves focus to the section heading because its row leaves the list.
- **After failure**: focus to the error banner (existing `FormBanner` behaviour), or the first invalid field for 422.
- **Row disappears** (stale, banned elsewhere): the panel unmounts with the row; focus is sent to `#members-heading` via the existing one-shot focus request, because the trigger no longer exists.
- **Panel state across revalidation**: the open state lives in `ManageProvider` and the panel's inputs are uncontrolled or hold local state keyed by `userId`, so a successful save and revalidate does not close or reset the panel. Re-key only the inner field wrappers (never the `<form>` or the button) by the saved value so a revalidate that changes the saved level or date refreshes the defaults without remounting the focused button.

### Responsive Behavior
| Breakpoint | Changes |
|------------|---------|
| < 640px | One column; row lines and controls stacked; all buttons full width; panel full width; forms stacked; date input full width at 16 px |
| 640-1023px | Row info left, controls right as today; panel full width, forms stacked |
| >= 1024px | Panel forms side by side in two columns; `sm:w-auto` buttons; panel `max-w-4xl` is not needed (the row is already bounded by the page container) |

### Accessibility Requirements
- [ ] Keyboard navigation: trigger, panel contents and Close reachable and operable with keyboard only; Escape closes; no keyboard trap
- [ ] Screen reader: trigger announces name and expanded state; panel is a named group; each form has a legend or heading; each Save result is announced from a live region that existed before the message
- [ ] Colour contrast AA: reuse existing classes only; `text-slate-700` on white and `bg-slate-50` for secondary text; error text `text-red-800`
- [ ] Focus indicators visible: `FOCUS_RING` on every control including the radios, checkbox and the programmatic heading
- [ ] Error messages accessible: `aria-invalid`, `aria-describedby` to `FieldError`, banner focused for non-field errors
- [ ] Label in name: visible "Skill and Auto Enroll" and "Clear date" are contained in their accessible names
- [ ] 44 px minimum tap targets for the trigger, both Save buttons, Close, Clear date, radios and the checkbox row
- [ ] Meaning not by colour alone; no timed messages; no native dialog; no motion
- [ ] Only one panel is mounted at a time (one open per section), so `OptionFieldset`'s name-derived ids (`field-skillLevel`, `skillLevel-beginner-help`) never duplicate in the DOM; if a second panel is ever allowed, pass an id prefix

## Implementation Guidelines

### For Developers
1. **Row layout**: change the `member-list.tsx` `<li>` to a column with the existing flex row on top and the panel below. Add `skillControl: { kind: 'panel' }` to `memberRowControls` (so the rule "approved rows only" stays unit-tested in one place), and render `MemberSkillSummary` under the name line. Update the file's header comment: the reserved extension point is now used.
2. **Open state**: reuse the `ManageProvider` reducer with id `skill-${userId}` in section `members`. `SkillEnrollTrigger` and `SkillEnrollPanel` read the same `manage.open.members`; no new reducer event.
3. **Server Actions**: add `setSkillLevelAction` and `setAutoEnrollAction` to `apps/web/src/lib/teams/actions.ts` (they send the bearer token like the moderation actions). Extend `ModerationResult` with an optional `noop?: boolean` is unnecessary: compute "already {Level}" in the action by comparing the submitted level with a hidden `currentLevel` field and the API's returned `member.skillLevel`; if the API later returns a `changed` flag, prefer it. The mapping lives in `skill-levels-view.ts` as `toSkillResult(kind, result, context)`, mirroring `toModerationResult` (5xx and offline to `SAVE_FAILED_MESSAGE` with `refresh: false`; 404/409 to `STALE_MESSAGE`; 403 to `NO_ACCESS_HEADING`; 422 field errors passed through).
4. **Hook**: `use-skill-panel-action.ts` wraps `useActionState` like `useModerationAction` but returns the result to the form (local status and field errors) and only dispatches to the Members section region for stale and no-access results (with `close: true` and a focus request to `#members-heading`). It shares a `pending` flag across the panel's two forms (lift it into `SkillEnrollPanel` context or props).
5. **Client pre-checks** in `skill-levels-view.ts`: `validateUntil(value, badInput, todayNz)` returning a field message or `null`. The API still validates (AC-ERROR-3).
6. **Copy**: add `SAVE_FAILED_MESSAGE`, `SKILL_OVERRIDE_OPTIONS` (third-person help) and the hint strings to `labels.ts`; put row copy builders (`skillProvenance`, `skillProgressLine`, `autoEnrollTag`) and result builders in `skill-levels-view.ts`; a single `formatCalendarDate` for `until` (UTC formatting).
7. **Progress cap**: display `Math.min(games, required)`; never print "43 of 40" and never promise a promotion time (AC-ASYNC-1). Use `required` from the API field, not the literal 40 (AC-VERIFY-4 grep guard).
8. **No native dialogs**; no `maxlength`-style silent truncation; no optimistic updates; revalidate only on success.

### Component Structure
```
apps/web/src/components/teams/
├── member-list.tsx                 ← edit: li layout, MemberSkillSummary, trigger, panel
├── member-skill-summary.tsx        ← read-only level, provenance, progress, tag (no state)
├── skill-enroll-panel.tsx          ← SkillEnrollTrigger, SkillEnrollPanel, SkillLevelForm, AutoEnrollForm
├── use-skill-panel-action.ts       ← action hook for the panel's forms
├── manage-components.test.tsx      ← extend: disclosure, focus return, field errors, status regions
apps/web/src/lib/teams/
├── skill-levels-view.ts            ← provenance, progress, tag, result copy, validateUntil, formatCalendarDate
├── skill-levels-view.test.ts
├── actions.ts                      ← edit: setSkillLevelAction, setAutoEnrollAction
├── labels.ts                       ← edit: SAVE_FAILED_MESSAGE, SKILL_OVERRIDE_OPTIONS, hints
├── manage-view.ts                  ← edit: memberRowControls gains skillControl
apps/web/src/app/teams/[teamId]/manage/page.tsx   ← edit: pass todayNz
apps/web/e2e/skill-levels.spec.ts   ← desktop + 360 x 740, axe, no native dialog
```
> Hooks are `.ts` and components `.tsx` per `systemPatterns.md` Code Organization Patterns (`components/**` renders JSX in `.tsx`; `lib/**` is `.ts`; the hook has no JSX, so it is `.ts` even though it sits under `components/`, matching `use-moderation-action.ts`).

### Recommended Libraries/Patterns
- No new dependency. Native `<input type="date">` (platform pickers on phones, free keyboard entry, no localisation bundle) with explicit pre-checks; a date-picker library would add weight and a11y risk.
- React 19 `useActionState` as in `useModerationAction`; `aria-disabled` for pending as in `ModerationButton`.
- `OptionFieldset` unchanged, fed `SKILL_OVERRIDE_OPTIONS`.

## Validation Checklist

- [x] Meets all user goals (scan, override, Auto Enroll with or without date, no lost input)
- [x] Accessible per requirements (no dialogs, labelled controls, live regions, focus rules)
- [x] Consistent with existing patterns (InlineConfirm disclosure, ManageProvider, OptionFieldset, FormBanner)
- [x] Respects Guiding Principles and component architecture in `systemPatterns.md` (P1 API authority, P3 dates at the boundary)
- [x] Responsive across devices (stack at 360 px, two columns on desktop)
- [x] Performance acceptable (panel mounted only when open; no client fetch)
- [x] Implementation feasible (one new panel file, one summary file, one view file, additive edits)

## Spec Copy and Behaviour Changes (for the parent task file)

1. **Success message location**: the Success Criteria say the message appears "in the Members status region"; AC-HAPPY-1/3/7/8/10 say "the panel reports". Decision: the message appears in a per-form status line inside the panel. The Members status region is used only for stale (404/409) and no-access (403) results.
2. **Panel stays open after a successful save** (spec was silent; `InlineConfirm` closes on success). Focus stays on the pressed Save button.
3. **Skill option help is third person** (`SKILL_OVERRIDE_OPTIONS`), not the player-facing "You play regularly..." from `SKILL_OPTIONS`.
4. **New strings**: panel heading, skill hint, Auto Enroll hint, turn-off hint, ended notice, date hint, "Clear date", "Close", "Enter a complete date, or clear the field.", "Set by a former admin · {date}".
5. **Progress line is capped** at the required count ("40 of 40 games toward Advanced", never "43 of 40") and takes the number from `skillProgress.required`.
6. **Auto Enroll form** drops the date from the request when the box is unticked; a partly typed date is refused client-side; an ended date is displayed with a neutral notice.
7. **Row**: a new `skillControl` in `memberRowControls`; the `<li>` changes to a column layout so the panel can span the row.
8. **Server-rendered `todayNz`** is passed to the panel for `min` and the "ended" test.
9. **Same-level detection** uses a hidden `currentLevel` field (client comparison) unless the architecture doc adds a `changed` flag to the 200 body, which would be preferable.

## Next Steps

1. Algorithm and architecture docs confirm: override resets the baseline (hint wording), `SkillProgress.required`, `skillOverride.byName` nullability for removed admins, optional `changed` flag.
2. Phase 5 build: view model and copy first (unit-tested), then panel and hook, then e2e on both viewports with axe.
3. During UAT, check: a long member name at 360 px, a past typed date, a partial date, tick-untick-tick, offline save, a stale row (ban in another tab), and keyboard-only operation.
