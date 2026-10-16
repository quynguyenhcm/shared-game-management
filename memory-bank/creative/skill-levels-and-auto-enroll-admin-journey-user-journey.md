# User Journey Design: Skill Levels and Auto Enroll (team admin)

**Created**: 2026-10-17
**Status**: DECIDED
**Decision Type**: User Journey
**Task**: `skill-levels-and-auto-enroll` (Level 3). Spec: `memory-bank/tasks/skill-levels-and-auto-enroll.md` on `feature/skill-levels-and-auto-enroll` (approved 2026-10-17 with creative flagged).
**Answers**: the User Journey creative phase (override, Auto Enroll, the asynchronous promotion, error and recovery paths) and Creative Q7 (what players see). It also covers the journey side of Q5 (where the progress line sits, and how the panel behaves after a save).
**Parallel inputs (not decided here)**: Algorithm (what counts as a game, override precedence, surplus games, constants), Architecture (C-GAME-1 and C-SKL-1, selection seam, lock order, job sweep and schedule slot), UI/UX (row and panel layout, control design, final copy). Every place where this journey depends on them is listed in [Dependencies on the parallel creative docs](#dependencies-on-the-parallel-creative-docs). Copy that is not already in the spec is marked **(proposed)**. The UI/UX doc finalises it.
**Basis**: `main` after team-management (PR #4) and team-banking-and-gst (PR #5). Conventions reused from `team-management-teams-user-journey.md`, `team-management-team-admin-uiux.md` and `team-banking-and-gst-payout-setup-user-journey.md`:
- People-page Server Actions that are never optimistic and revalidate only on success.
- One persistent status region per section (`#members-status`).
- `InlineConfirm` disclosure behaviour: one open panel per section, focus into the panel, Escape returns focus, no native dialogs.
- The A7 rule: reload when the server state is known to have changed; keep the input when the outcome is unknown.
- `NoAccess` on 403 and `sessionExpiredUrl` on 401.
- The focus rule "a row leaves its list → focus the section `h2`".

User decisions taken as fixed (2026-10-17):
- An admin may override their own level.
- No level is set at join approval.
- A promotion may lag by up to one day.

---

## Journey Overview

**Feature**: On the People page, a team admin can see each approved member's skill level, where that level came from, and how close the member is to moving up. The admin can set the level directly. They can also put a member on Auto Enroll (with an optional last date) so that, once sessions exist, the member is registered for every new session automatically. Each morning a background job moves members up one level when they have played 40 games for the team in the past year, counted from their last level change.
**Primary Persona**: Team Admin (`TEAM_ADMIN` of one team).
**Journey Type**: **Hybrid.**
- Synchronous for the admin: each save is one request with an immediate answer, shown in place.
- Asynchronous for promotion: a daily job at 05:30 Pacific/Auckland. The admin discovers a promotion by loading the page. Nothing is pushed to them.
- Deferred effect for Auto Enroll: the flag does nothing visible until session-scheduling-engine publishes sessions and calls `selectAutoEnrollees`.
**Orchestration Pattern**: **Dashboard + Detail with progressive disclosure, all within one row.**
- The Members row is the dashboard. It shows the level, its provenance, progress and the Auto Enroll tag, read-only and with no click needed.
- One "Skill and Auto Enroll" disclosure opens a non-modal panel under the row. The panel holds two independent forms.
- The panel **stays open after a successful save**, so an admin can set both things in one visit, and it closes on demand.

### Success Statement
> After watching a new member play, Aroha opens Manage → Members, presses "Skill and Auto Enroll, Priya Patel", picks Advanced, ticks Auto Enroll until the end of term, and saves each. She hears "Skill level for Priya Patel set to Advanced." and then "Auto Enroll on for Priya Patel until 18 Dec 2026.", and the row above now reads "Advanced · Set by Aroha Ngata · 17 Oct 2026 · Highest level · Auto Enroll until 18 Dec 2026". Weeks later a regular quietly moves up overnight, and Aroha sees "Moved up automatically · 3 Nov 2026" the next time she opens the page.

### Honesty constraint: nothing upstream writes games or sessions yet
On `main`, no code writes `registrations` or `game_sessions`. Until registration-and-waitlist, session-scheduling-engine and wallet-and-akahu-billing (which marks sessions `COMPLETED`) ship, three things follow in production:
- **Every progress line reads "0 of 40 games toward {next level}".** That is true. The journey does not hide it, explain it away, or show a "coming soon" state. The panel's rule line (below) tells the admin how games are counted, so an admin who wonders "why is everyone at 0?" can work out the answer: no games have been played through the app yet.
- **No automatic promotion can happen.** The job runs daily and records `scanned`, `promoted = 0`. The provenance "Moved up automatically" appears only in seeded test data.
- **Auto Enroll is stored but has no effect** until sessions are published. The copy describes what Auto Enroll *will do* in conditional terms ("when a session is published"). It never says the member "has been registered" for anything.

---

## Persona Context

### Primary user
- **Who**: Team Admin (productBrief Key Personas: "... membership approval, skill levels, bans ...").
- **Goals**:
  1. Keep levels honest. Under `BY_SKILL_LEVEL` pricing the level sets the fee, and a self-assessed level at join can be wrong in either direction.
  2. Stop chasing regulars every week. "Just put me in every Tuesday until the end of term" becomes one tick and a date.
- **Context**: Often on a phone (360 px), at the venue or just after a session, having just watched people play. Sometimes on a laptop when reviewing the whole member list before a new term.
- **Proficiency**: A volunteer organiser. They are comfortable with the People page (approve, make admin, ban), but they will not read documentation about how promotion works. They need two things on the page itself: what the rule is, and what saving will do (the count restarts, existing fees do not change, and an Auto Enroll player gets charged for games).
- **Mental model**: "The level is my call. The app suggests by moving people up as they play, but I can always correct it." For Auto Enroll: "a standing booking for my regulars".

### Secondary users
- **Player** (the member whose level and Auto Enroll change). In v1 they see nothing new and get no notification ([Q7 decision](#q7-what-players-see-in-v1)). Their level affects what they pay once `BY_SKILL_LEVEL` sessions exist. Auto Enroll will register them, and so make them liable for fees, once the materialiser exists. Both consequences are what the admin-facing copy has to make clear.
- **Co-admin**: sees the same rows. "Set by {name} · {date}" tells them who changed a level last. Every admin is equal (an admin can override another admin's level or their own).
- **Operator** (developer on call): watches `skill.progression.completed` and failed `skill-progression` jobs, and re-runs with `pnpm run jobs:trigger skill-progression`.
- **Downstream features**: session-scheduling-engine (calls `selectAutoEnrollees`), registration-and-waitlist (reads `skill_level` through `assertApprovedMember` for fees; its allocator registers auto-enrollees). The journey hands them the player-facing obligations in [Hand-off notes](#hand-off-notes-for-downstream-features).

---

## Journey Map

### Entry points

| Entry | Context | User intent | Status |
|---|---|---|---|
| "Skill and Auto Enroll" button on each approved Members row (`aria-label="Skill and Auto Enroll, {fullName}"`) | `/teams/<id>/manage` (People area), Members section | "Change this person's level / make them a regular" | MUST (AC-ENTRY-1) |
| The read-only row lines (level, provenance, progress, Auto Enroll tag) | Same row, no click | "Who's at what level, who moved up, who's a regular?" | MUST (AC-ENTRY-1, AC-HAPPY-11) |
| Navigation | My teams (`/teams`) → admin row "Manage" → People → jump list "Members" | Getting to the page | Existing |
| CLI `pnpm run jobs:trigger skill-progression` | Operator terminal | "Run today's promotions now" | MUST (AC-ASYNC-1) |

Not entry points (deliberately):
- **A new manage area.** It would duplicate the Members list (see Option 3).
- **A control on Join requests rows.** User decision: no level at approval.
- **The player-facing team page.** See Q7.

### Discovery

Admins find the control where they already manage people: on the member's row, next to "Make admin" and "Ban". The row lines advertise the feature without a click:
- A level that reads "Self-assessed" invites a check.
- "23 of 40 games toward Intermediate" explains that people move up on their own.
- An "Auto Enroll ..." tag shows who the regulars are.

Nothing on My teams changes. No action is ever *required* of the admin by this feature, so there is nothing to nag about.

### Route and state inventory

| Surface | Kind | Who | State lives in |
|---|---|---|---|
| `/teams/<id>/manage` Members row | server-rendered, `TEAM_ADMIN` only (existing guard) | approved admins of the team | `team_members` via `GET /teams/:id/members` (additive fields) |
| Skill and Auto Enroll panel | client disclosure under the row | same | open/closed in `manage-state` (`open.members = 'skill-<userId>'`); typed values in component state only, never in the URL or browser storage |
| Save skill level / Save Auto Enroll | Server Actions → `PUT` routes | same | `team_members` |
| Promotion | `skill-progression` job, daily 05:30 Pacific/Auckland | worker | `team_members.skill_level`, `skill_level_changed_at` |

No new URL parameters. People-page actions revalidate in place, and this feature follows that pattern rather than the banking page's post/redirect/get (Option 1 rationale).

---

## State Diagrams

### Skill level of one member (what the admin sees on the row)

```
                    approve join request (level = self-assessed, provenance "Self-assessed",
                    baseline = NULL → all games in the last 365 days count)
                                           │
                                           ▼
   ┌──────────────────────────► [LEVEL L, counting]  row: "{L} · {provenance} · {n} of 40 games toward {L+1}"
   │                                   │   │   │
   │      admin saves a DIFFERENT level│   │   │ games reach 40 (sessions COMPLETED, confirmed registrations)
   │      (raise or lower, incl. self) │   │   ▼
   │                                   │   │ [THRESHOLD REACHED, awaiting job]  row: "40 of 40 games toward {L+1}"
   │                                   │   │   │   (proposed: "... Moves up at the next daily update.")
   │                                   │   │   │
   │                                   │   │   │ 05:30 job (or CLI trigger): lock, recount, decide, guarded UPDATE
   │                                   │   │   ▼
   │                                   │   │ [LEVEL L+1, counting from 0]  row: "{L+1} · Moved up automatically · {date}
   │                                   │   │                                     · 0 of 40 games toward {L+2}"
   │                                   │   │                                     (at ADVANCED: "Highest level")
   │                                   │   │
   │                                   │   └─ admin saves the SAME level → no-op, "Priya Patel is already {L}." (nothing reset)
   │                                   ▼
   └───────────── [LEVEL L', counting from 0]  row: "{L'} · Set by {admin} · {date} · 0 of 40 games toward {L'+1}"

   An override made between "threshold reached" and the job run wins. The job recounts under the row lock
   and sees 0 games since the override (AC-VERIFY-5). The admin's choice is never silently undone.
   The job never lowers a level. ADVANCED never moves.
   Ban → the row leaves Members; the level is kept on the row but is no longer shown or used.
```

### Auto Enroll of one member

```
 [OFF] tag: none
   │ tick, Until empty, Save                 tick, Until = D (≥ today NZ), Save
   ▼                                          ▼
 [ON, no end]  tag "Auto Enroll, no end date"   [ON until D]  tag "Auto Enroll until D"
   │  assigned_at = now (back of the order)       │  assigned_at = now (back of the order)
   │                                              │
   │ change/add/clear Until, Save → same place    │ change Until, Save → same place in the order
   │ untick, Save → [OFF], all fields cleared     │ untick, Save → [OFF]
   │                                              │
   │                                              │ calendar passes D (no job, the predicate excludes)
   │                                              ▼
   │                                       [ENDED]  tag "Auto Enroll ended D"
   │                                              │ panel shows the box UNTICKED with a note (proposed):
   │                                              │ "Auto Enroll ended {D}. Turn it on again to keep {first name}
   │                                              │  registered; they'll join the end of the Auto Enroll order."
   │                                              │ tick + new date/none, Save → [ON] with assigned_at = now
   │                                              │   (recommended: an ended assignment counts as off; see Amendment A3)
   ▼                                              ▼
 ban (any state) → flag, date and order cleared in the ban UPDATE; the row moves to "Banned members"
```

### Panel lifecycle (one row)

```
[CLOSED] ──"Skill and Auto Enroll, {name}"──▶ [OPEN] focus → panel heading ("Skill and Auto Enroll for {name}", tabIndex -1)
   ▲                                              │
   │                                              ├─ Save skill level ──▶ pending "Saving…" (aria-disabled)
   │                                              │      ├─ 200 changed / no-op ─▶ message announced once in #members-status,
   │                                              │      │                         shown beside the form; row revalidated;
   │                                              │      │                         panel STAYS OPEN, focus stays on the button
   │                                              │      ├─ 422 ─▶ field error, values kept, panel open
   │                                              │      ├─ 409 / 404 ─▶ stale line, page refreshed, panel closes,
   │                                              │      │               focus → Members h2 (row usually gone)
   │                                              │      ├─ 403 ─▶ page re-renders as NoAccess
   │                                              │      ├─ 401 ─▶ /auth/session-expired?returnTo=/teams/<id>/manage#members
   │                                              │      └─ 5xx / unreachable ─▶ failure line, values kept, panel open, no revalidate
   │                                              ├─ Save Auto Enroll ── same outcomes
   │                                              │
   └──── "Close" / Escape (focus → trigger) ◀─────┤
         opening another row's panel or a Ban confirm in Members closes this one (one open per section)
```

---

## Step-by-Step Journeys

### Journey 1: Override a level (raise, lower, same-level no-op)

#### Step 1: Members section
- **System**: web page `manage/page.tsx` → `GET /teams/:id/members?status=APPROVED` (existing, with the new additive fields).
- **User sees** (per approved row, read-only):
  - name, "(you)", role tag
  - level ("Beginner")
  - provenance: "Self-assessed", "Set by Aroha Ngata · 17 Oct 2026" or "Moved up automatically · 3 Nov 2026"
  - progress: "23 of 40 games toward Intermediate", or "Highest level"
  - Auto Enroll tag, if any
  - the row controls: "Make admin" or "Remove admin", "Ban", and the new "Skill and Auto Enroll".
- **User actions**: press "Skill and Auto Enroll, Priya Patel".
- **Transitions**: open panel (Step 2). Any other open panel or confirm in Members closes.
- **Data flow**: `skillProgress` comes from the same `countQualifyingGames` the job uses (AC-HAPPY-11), so what the row says matches what the next run decides.

#### Step 2: Panel open, skill form
- **User sees**:
  - Panel heading "Skill and Auto Enroll for Priya Patel" (proposed), focused.
  - Fieldset legend "Skill level", with the radios Beginner, Intermediate and Advanced, each with its existing help text. The current level is preselected.
  - A rule line under the radios (proposed): "Members move up one level after 40 games with this team in a year. Priya has 23 of 40 toward Intermediate. Saving a different level restarts her count at 0."
  - A fee line (proposed): "Sessions she has already registered for keep their fee."
  - The button "Save skill level".
- **Why the rule and consequence lines are here**: the override restarts the count (AC-HAPPY-2, AC-HAPPY-6) and does not reprice existing registrations (ADR 0012). Without these lines both are invisible, and both surprise people: an admin "nudging" a member at 38 of 40 wipes 38 games, and a player who is moved up might expect a refund or a new charge. Saying it before Save prevents mistakes better than any confirmation step could (no confirmation is added: the change is reversible with one more save).
- **User actions**: pick a level, then "Save skill level".
- **Feedback**: pending "Saving…" with `aria-disabled` (blocks a double submit).
- **Data flow**: Server Action → `PUT /teams/:id/members/:userId/skill-level { skillLevel }`.

#### Step 3: Result (panel stays open)
- **Raise or lower (200, changed)**:
  - The status region `#members-status` announces "Skill level for Priya Patel set to Advanced." The same text appears beside the form (not a second live region, so screen readers hear it once).
  - The row revalidates to "Advanced · Set by Aroha Ngata · 17 Oct 2026 · Highest level". When lowered, it reads "Intermediate · Set by ... · 0 of 40 games toward Advanced".
  - The rule line in the panel updates to the new count.
  - Focus stays on "Save skill level".
- **Same level (200, unchanged)**: "Priya Patel is already Intermediate." Nothing is reset. The row is unchanged (AC-HAPPY-3).
- **Next actions**: set Auto Enroll in the same panel, "Close", or move to another row.
- **Self-override**: identical on the admin's own row ("(you)"). The provenance then reads "Set by {your name}".

### Journey 2: Auto Enroll

#### Step 1: Auto Enroll form (same panel, below the skill form, separated by its own heading or legend)
- **User sees**:
  - Checkbox "Auto Enroll" with a hint (proposed): "When a session for this team is published, Priya is registered for it automatically. She's charged like any other player unless she withdraws in time. Only turn this on for players who've agreed to it."
  - When ticked, a date input "Until (optional)". Its hint (proposed): "Leave empty to keep it on. Sessions on this date are included."
  - Its `min` is today in Pacific/Auckland. That only helps date pickers; the server validates.
  - The button "Save Auto Enroll".
- **Why the hint names the money consequence**: Auto Enroll turns into a registration, which means a fee and a cancellation deadline once sessions exist. The admin is acting for the player, so the copy asks the admin to have the player's agreement. The app cannot check that agreement, but the copy can make sure the admin has thought about it.
- **Unticking**: the date input hides, and its value is dropped from the submission (never sent with `enabled: false`; AC-ERROR-3 would refuse it anyway). Re-ticking before saving shows the value the admin last typed (component state only).

#### Step 2: Results

| Action | Message (announced in `#members-status`) | Row tag after revalidation | Order (`auto_enroll_assigned_at`) |
|---|---|---|---|
| On with a date | "Auto Enroll on for Priya Patel until 30 Nov 2026." (spec) | "Auto Enroll until 30 Nov 2026" | now (back of the order) |
| On, no date | "Auto Enroll on for Priya Patel, with no end date." (spec) | "Auto Enroll, no end date" | now |
| Change, add or clear the date while on | same two lines as above | updated | **unchanged** (keeps her place, AC-HAPPY-9) |
| Off | "Auto Enroll turned off for Priya Patel." (spec) | none | cleared; existing registrations untouched |
| On again after off | as "on" | as "on" | now (back of the order, AC-HAPPY-10) |
| Saved with nothing changed | proposed: "Nothing to change. Auto Enroll for Priya Patel is already {state}." | unchanged | unchanged |

Off and on again moves a member to the back. That is a real consequence, so the Off result carries a second sentence (proposed): "Turning it on again puts her at the end of the Auto Enroll order." The admin learns this when it is relevant, not in advance as a warning on every row.

#### Step 3: After the Until date passes (no job, no write)
- On any page load after D (comparing D with today in Pacific/Auckland at render), the row tag reads "Auto Enroll ended 30 Nov 2026" (spec). The database row still says `is_auto_enroll = true` and `auto_enroll_until = D`. The selection predicate excludes her for sessions after D (AC-ASYNC-3).
- The panel shows the Auto Enroll box **unticked** with the ended note (proposed): "Auto Enroll ended 30 Nov 2026. Turn it on again to keep Priya registered; she'll join the end of the Auto Enroll order."
- **Why unticked, and why a fresh place in the order** (journey recommendation, needs Algorithm/Architecture confirmation, Amendment A3):
  - A ticked box next to a past date would trap the admin. Pressing "Save Auto Enroll" without noticing the date would fail with "Choose today or a later date." for a state they did not create.
  - For ordering, a member whose standing booking lapsed has not been auto-enrolled in the meantime. Renewing them ahead of members who stayed on continuously would be unfair, and it would also contradict the rule the admin already learned ("off then on goes to the back").
  - So "ended" behaves as "off" in both the panel and the order. The server rule: an `enabled: true` save on a row whose `auto_enroll_until` is before today (NZ) counts as a new assignment, with `assigned_at = now`.
- Unticking and saving an ended Auto Enroll clears the fields: "Auto Enroll turned off for Priya Patel." The "ended" tag disappears. This is an optional tidy-up and never required.

### Journey 3: Automatic promotion (asynchronous)

| Phase | When | Who sees what |
|---|---|---|
| Game completes | billing marks the session `COMPLETED` (future feature; post-game billing polls every 5 min) | Row (next load): "40 of 40 games toward Intermediate". Display is capped at the threshold, never "43 of 40". Proposed second clause: "Moves up at the next daily update." |
| Promotion | 05:30 Pacific/Auckland daily, or an operator's `pnpm run jobs:trigger skill-progression` | Nobody is notified (v1). Logs: `team.member.skill_progressed` per member, `skill.progression.completed` with counts |
| Discovery | the admin's next load of `/teams/<id>/manage` | Row: "Intermediate · Moved up automatically · 3 Nov 2026 · 0 of 40 games toward Advanced" |
| Late correction | any time | The admin overrides as in Journey 1. The provenance becomes "Set by ...", and the count restarts. |

- **Maximum lag**: about one day after `COMPLETED`, which the user accepted. If the worker is down or a run fails, the next run or the retry catches up, because the job is idempotent and recounts. The capped display tells the admin the count is reached, so a delay never looks like a counting bug.
- **One level per run**: a member with 85 games moves up one level only. The surplus is discarded (spec default; the Algorithm doc decides Q3). The row then honestly reads "0 of 40 games toward Advanced". If the Algorithm doc adopts carry-over, only the number changes; the journey stays the same.
- **The "awaiting" clause is a soft statement, not a promise** (Amendment A4). The spec says "nothing is promised in the UI", and the clause stays true even when an override intervenes, because an override also changes the line. If UI/UX or the human prefer the strict reading, drop the clause and keep the cap. The cap is the part that matters.
- **Operator path**: when a run ends `failed` (`failed > 0`, AC-ERROR-7), the operator:
  1. reads `skill.progression.member_failed` (ids and `errorCode`);
  2. fixes the cause or waits for the transient one to pass;
  3. lets the retry run, or runs `pnpm run jobs:trigger skill-progression`.
  Other members were already promoted in the failed run. The failed member is promoted on the next successful run. Admins see nothing, apart from a promotion that may arrive a day later.

### Journey 4: Errors and recovery (summary; details in [Error Handling](#error-handling))
- Non-admin or signed-out: never sees the controls (existing guard). A crafted request gets 403 or 401, before the body is read.
- Target no longer an approved member (banned, or gone) while the panel is open: a member-specific stale line, the page refreshes, the panel closes, focus goes to the Members heading.
- The admin was demoted by a co-admin mid-request: 403, and the page re-renders as `NoAccess`.
- A ban races an Auto Enroll save: the ban always wins in the data. The admin sees either the stale line or, if their save committed first, a success message followed by the row moving to "Banned members" on refresh.
- API unreachable or 5xx: the panel stays open, the values are kept, and the failure line says to try again. Retrying is safe because both saves are idempotent set-to-value requests.
- Validation: a past date gives "Choose today or a later date." beside the field. The typed values are kept.

---

## Q7: What players see in v1

**Recommendation: confirm the draft for v1 (admin-only, no notification).** Add two forward obligations for the features that will make the level and Auto Enroll matter to players, and one optional copy change.

Why admin-only is right for v1:
1. **Nothing consumes the level or Auto Enroll in production yet.** There are no sessions, prices or registrations on `main`. A player who saw "Your level: Intermediate" would learn nothing they could act on, and a promotion notification could not fire (counts are 0).
2. **Downgrades are socially sensitive.** Telling a player "your admin moved you to Beginner" is a club-policy choice, not a product default. If notifications are added later, a promotion is good news but a demotion is a potential argument. That needs a product-owner decision (notify on promotion only? say who changed it?), and it should not be slipped in as a side effect.
3. **There is no player-facing surface yet.** The team page (`/teams/<id>`) shows no skill today, and the player dashboard ("My Registration") is a later feature. Building a "your level" line now would mean designing a surface that player-dashboard will redesign.

What must happen before players are affected (hand-off, recorded in ADR 0017):
- **Fee transparency (registration-and-waitlist).** Wherever a `BY_SKILL_LEVEL` fee is shown to a player, it names the level it is based on. Proposed: "Your fee: $17.00 (Intermediate rate), charged after the game." A level change by an admin or the job is otherwise visible to the player only as an unexplained price change.
- **Auto Enroll visibility (session-scheduling-engine together with registration-and-waitlist).** A member registered by Auto Enroll must be able to see that registration where they see their others (the session page, and later "My Registration"), labelled as automatic. They must also be told by email at least once. Proposed: on the first auto-registration after Auto Enroll is turned on, or on every one, whichever that feature's journey decides. Being charged for a game you were registered for without being told is the kind of surprise this product exists to remove. This feature writes no registration, so the obligation sits with the feature that does.

Optional (COULD, in this feature, a one-line copy change): the join form hint `SKILL_HINT_JOIN` becomes (proposed) "Rate yourself honestly. Team admins see this and can change it later." Players then know at the only point they choose a level that it is not final. The change touches `labels.ts` only.

Rejected for v1:
- `mySkillLevel` on team detail: no decision value yet, and the surface belongs to player-dashboard.
- A promotion email through `send-email`: it would never fire in production yet, and the promotion-versus-demotion policy is open.
- Player requests for Auto Enroll: out of scope in the spec.

---

## Async Handling

### Operation lifecycle (promotion)

| Phase | Duration | User experience |
|---|---|---|
| Trigger | `COMPLETED` session with the member's `CONFIRMED` registration (future features) | Row count increases on the next load; capped at 40 of 40 |
| Processing | daily at 05:30 Pacific/Auckland; one short transaction per member | Nothing shown; the admin is not waiting |
| Completion | same run | Row shows the new level and "Moved up automatically · {date}" on the next load |
| Failure | per member; the run ends `failed` when any member fails, and retries | Admin: possibly a one-day delay. Operator: `skill.progression.member_failed`, failed job in `pgboss.job` |

### Progress communication
- **Admin**: pull only (page loads). No polling, websocket, email or in-app notification, consistent with team-management and the registration journey ("everything else is pull").
- **Persistence**: the provenance line is the record of the most recent change. Older history lives only in logs (spec: no history table). That is acceptable because the admin's question is "why is she at this level now?", and the last change answers it.
- **Operator**: `skill.progression.completed { scanned, promoted, failed }` per run, plus `pgboss.job`.

### Deferred effect (Auto Enroll)
No async work in this feature. The effect happens when session-scheduling-engine publishes a session and calls `selectAutoEnrollees(teamId, sessionDate)`, then `allocator.autoEnrolInSession` in that order (C-SKL-1, C-SAE-1/2). The admin-facing copy uses conditional language until then.

---

## Distributed System Flow

### System boundaries
```
Browser ──Server Action POST──▶ apps/web (manage page, member-list, skill panel, actions.ts)
                                   │ Bearer session, traceparent, internal-auth headers
                                   ▼
                              apps/api modules/skill-levels (routes → service → repo)
                                   │ one transaction: teams FOR NO KEY UPDATE → re-check actor is approved admin
                                   │ → team_members row lock → guarded UPDATE → log event
                                   ▼
                              PostgreSQL 17 (team_members + CHECKs)
                                   ▲
worker (cron 05:30 NZ, exclusive) ─┘ skill-progression: keyset sweep of approved non-ADVANCED members;
                                     per member: lock row → countQualifyingGames → decideProgression → guarded UPDATE
operator ──pnpm run jobs:trigger skill-progression──▶ same queue

future: session-scheduling-engine materialiser ──selectAutoEnrollees (read, no locks)──▶ team_members
                                               └─▶ registration-and-waitlist allocator.autoEnrolInSession (gate: assertApprovedMember)
future: registration-and-waitlist register ──assertApprovedMember──▶ reads skill_level for the fee
```

### Responsibility matrix

| Step | Owner | State storage | Failure handling |
|---|---|---|---|
| Page gate | `proxy.ts`, `requireUser`, API `requireTeamRole('TEAM_ADMIN')` | session cookie | signed out → `/login?returnTo`; 401 → session expired; 403 → `NoAccess` |
| Row lines | API members list (+ `countQualifyingGames`, ≤ 50 per page) | `team_members`, `registrations`, `game_sessions` | page load failure → existing `error.tsx` |
| Panel open/close | web client (`manage-state`) | memory only | needs JavaScript; without it the controls are unusable (same safe failure as Ban) |
| Client validation | web (shared strict schemas) | component state | field error in place |
| Override / Auto Enroll save | API, one transaction | `team_members` | 422 field errors; 409/404 stale; 403 NoAccess; 5xx keep input, no revalidate |
| Promotion | worker job | `team_members`; `pgboss.job` | per-member isolation, run ends failed, retry, idempotent |
| "Ended" Auto Enroll | web render (NZ today vs `until`) + selection predicate | none (derived) | none needed |
| Ban clears Auto Enroll | teams ban `UPDATE` | `team_members` | atomic with the ban |

---

## Error Handling

### Where every error lands and how the admin recovers

| Code (HTTP) | When | Lands on | User sees | Recovery | Input kept |
|---|---|---|---|---|---|
| `validation_failed` (422) `until` | past date (NZ), malformed | panel, field | "Choose today or a later date." beside "Until (optional)", `aria-describedby`; also in `#members-status` | pick a date or clear it | yes, both forms |
| `validation_failed` (422) `skillLevel` | crafted request only (the radio is preselected) | panel, field | "Select a skill level." | pick one | yes |
| strict-body violation (422) | crafted request only | panel | the first field message, or the failure line | reload | yes |
| `membership_state_conflict` (409) / `not_found` (404) | the target was banned, or is otherwise no longer approved, while the panel was open; or a ban committed before the Auto Enroll save | `#members-status`, page refreshed, panel closed, focus → Members `h2` | proposed member-specific line: "{fullName} is no longer an approved member. The list has been refreshed." (Amendment A6; the spec reuses `STALE_MESSAGE`, which talks about a "request") | none needed; the row is in Banned members or gone | n/a (server state known) |
| `forbidden` (403) | actor demoted or banned meanwhile (AC-ERROR-4), or a crafted call by a non-admin | page re-renders as `NoAccess` ("You don't have access to manage this team." + "Back to My teams") | as left | n/a | discarded (correct: they no longer may) |
| `unauthenticated` / `session_expired` (401) | session expired | `/auth/session-expired?returnTo=/teams/<id>/manage#members` | "Your session has expired. Sign in again." | sign in; back on Members with the panel closed | lost (two small fields) |
| 5xx | API answered with an error (transaction rolled back) | panel stays open; failure line beside the form and in `#members-status` | spec AC-ERROR-6: "We couldn't save that. Nothing was changed. Try again." | retry | yes; no revalidation; row not changed |
| unreachable / timeout (status 0) | outcome unknown (may have committed) | same | proposed (Amendment A5): "We couldn't confirm that was saved. Try again; saving the same change twice is safe." Do not say "Nothing was changed", because it may not be true | retry: a repeat level save answers "already {level}"; a repeat Auto Enroll save keeps the place | yes |
| browser offline | any save | same | existing offline line: "You seem to be offline. Check your connection and try again." | retry | yes |

### Races (what the admin experiences)

| Race | Data outcome (spec) | Admin experience |
|---|---|---|
| Two admins override the same member | serialised by the team lock; the later save wins | Both see their own success message. On the next load the row says "Set by {the later admin}". Acceptable: the provenance line shows who won. |
| Admin override vs promotion job | the override is never lost; the job recounts under the lock (AC-VERIFY-5) | The admin's level stands. "Set by" and the count restarted. |
| Ban vs Auto Enroll save, ban first | 409 to the save | the member-specific stale line; the row is now in Banned members |
| Ban vs Auto Enroll save, save first | the ban clears the flag anyway | The saver sees "Auto Enroll on for ...". On the refresh after the ban, the row leaves Members. The success message stays true for the instant it describes. Accepted as rare. |
| Admin demoted mid-request | 403 (AC-ERROR-4) | `NoAccess` page |
| Member moved up while the panel was open | the panel's radio still shows the old level | Saving the old level is treated as a *different* level: it lowers the member back and stamps the override. The message "Skill level for Priya Patel set to Beginner." makes the result explicit, and the revalidated row shows it. The rule line in the panel ("has 40 of 40 toward ...") warns before Save. Accepted; no extra guard (an `expectedLevel` precondition was considered and rejected as over-engineering for a once-a-day event). |

### Partial failure
- **One member's promotion fails mid-sweep**: covered by AC-ERROR-7. Others are promoted, the failed member is retried later, and the admin sees a delayed promotion only.
- **Save committed, response lost**: retry is idempotent (see the 5xx rows above).
- **Panel content lost when another panel opens** (one panel per section): typed but unsaved values are dropped. Accepted because the forms are tiny. Unsaved values are never sent.

### Edge cases

| Case | What happens |
|---|---|
| Admin overrides their own level | allowed (user decision); the provenance reads "Set by {own name}" |
| Sole member (the admin only) | the row has the panel; the "only member so far" line is unchanged |
| Member at ADVANCED | progress line "Highest level"; the panel's rule line reads "Advanced is the highest level." (proposed); Auto Enroll works as usual |
| Member approved today | provenance "Self-assessed"; "0 of 40 games toward {next}" |
| Members list on page 2+ (keyset, 50 per page) | panel works the same; the cursor is kept on revalidation |
| `until` = today | allowed; included for today's sessions; tag "Auto Enroll until {today}" |
| DST change / late evening | "today" is always the Pacific/Auckland calendar date from the injected clock; the "ended" tag flips at NZ midnight |
| Admin sets Auto Enroll for a member with overdue payments | allowed here; the allocator skips or waitlists them per C-SAE-1 (registration-and-waitlist decides; out of this journey) |

---

## Options Explored

### Option 1: Read-only row lines + one disclosure panel with two independent forms, panel stays open (CHOSEN)
- **Orchestration**: the row shows the level, provenance, progress and Auto Enroll tag. "Skill and Auto Enroll" opens a non-modal panel under the row (InlineConfirm-style disclosure). The panel has two forms, each with its own Save and its own result message. It stays open after a success and closes with "Close" or Escape.
- **Wireframe** (360 px, panel open after a level save):
  ```
  ┌──────────────────────────────────┐
  │ Priya Patel            [Member]  │
  │ Advanced                          │
  │ Set by Aroha Ngata · 17 Oct 2026  │
  │ Highest level                     │
  │ Auto Enroll until 30 Nov 2026     │
  │ [ Make admin ]  [ Ban ]           │
  │ [ Skill and Auto Enroll ▴ ]       │ aria-expanded=true
  │ ┌──────────────────────────────┐ │
  │ │ Skill and Auto Enroll for    │ │ ← focused on open
  │ │ Priya Patel                  │ │
  │ │ Skill level                  │ │
  │ │ ( ) Beginner                 │ │
  │ │ ( ) Intermediate             │ │
  │ │ (•) Advanced                 │ │
  │ │ Advanced is the highest      │ │
  │ │ level. Sessions she has      │ │
  │ │ already registered for keep  │ │
  │ │ their fee.                   │ │
  │ │ [ Save skill level        ]  │ │
  │ │ ✓ Skill level for Priya      │ │ (visual echo; announced via #members-status)
  │ │   Patel set to Advanced.     │ │
  │ │ ──────────────────────────── │ │
  │ │ [x] Auto Enroll              │ │
  │ │ When a session for this team │ │
  │ │ is published, Priya is       │ │
  │ │ registered automatically...  │ │
  │ │ Until (optional)             │ │
  │ │ [ 30/11/2026            ]    │ │
  │ │ [ Save Auto Enroll        ]  │ │
  │ │ [ Close                   ]  │ │
  │ └──────────────────────────────┘ │
  └──────────────────────────────────┘
  ```
- **Pros**:
  - Uses the reserved extension point (`memberRowControls`) and the existing disclosure behaviour.
  - The read-only lines answer the common question (who is at what level, who is a regular) with zero clicks.
  - Two Saves mean each result is one unambiguous sentence, a failure in one form never blocks the other, and an Auto Enroll edit can never touch the skill baseline by accident.
  - Staying open supports the common "new member: set level and make a regular" visit.
  - The consequence lines sit next to the button they qualify.
- **Cons**:
  - Two buttons in one panel. An admin might change both and press only one Save. Mitigated: each form is visually grouped, each Save names its form, and the other form keeps its typed value until the panel closes.
  - A tall panel on 360 px.
  - Needs JavaScript (same as Ban).

### Option 2: One combined form with a single "Save"
- **Orchestration**: the same panel with one Save that sends both the level and Auto Enroll.
- **Pros**: one button; matches a "settings" mental model.
- **Cons**:
  - Two `PUT`s behind one button make partial success possible ("level saved, Auto Enroll failed"), and the one result message gets complicated.
  - Re-submitting an unchanged Auto Enroll needs dirty-tracking so that it does not churn the order or emit events.
  - Re-submitting the unchanged level depends on the no-op rule.
  - The result message must describe up to two changes.
  - Error prevention is worse: an admin changing only Auto Enroll still sends a level and could hit a stale-level race (see the race table).

### Option 3: A dedicated "Levels and Auto Enroll" manage area (a table, in `MANAGE_AREAS`)
- **Orchestration**: a third area-nav entry with a sortable table (name, level, provenance, progress, Auto Enroll) and per-row edit.
- **Pros**: good for a term-start review of all members; room for sorting and filters ("regulars only").
- **Cons**:
  - Duplicates the Members list and its pagination, ban interplay and stale handling.
  - Splits "people" decisions across two pages: an admin banning someone would not see they are a regular.
  - More routes and tests.
  - The spec explicitly says no new area.
  - Sorting and bulk edit are out of scope anyway.

### Option 4: Inline auto-saving controls in the row (level select + Auto Enroll switch)
- **Orchestration**: a `<select>` and a toggle switch directly in the row that save on change.
- **Pros**: fewest clicks; fast for power users.
- **Cons**:
  - Accidental changes have real consequences: a mis-tap restarts a member's count, or moves them to the back of the Auto Enroll order, with no Save step to catch it.
  - Save-on-change is poor for keyboard and screen-reader users (arrowing through a select fires changes).
  - The date has nowhere to live.
  - There is no room for the rule and consequence lines.
  - It does not match any existing People-page control.

## Evaluation Matrix

| Criterion | Option 1 Panel, two forms | Option 2 Combined form | Option 3 Separate area | Option 4 Inline auto-save |
|---|---|---|---|---|
| Discoverability | H (on the row, read-only lines advertise it) | H | M (a nav entry; split from People) | H |
| Learnability | H (rule line in place) | M | M | M |
| Efficiency | H (one open, both set, stays open) | H | M (extra navigation) | H |
| Error Prevention | H (explicit Save per concern, consequence lines) | M (partial success, dirty-tracking) | H | L (mis-taps commit) |
| Error Recovery | H (each form fails alone; values kept) | M | H | M |
| Feedback | H (one sentence per save) | M | H | M |
| Consistency | H (InlineConfirm disclosure, `#members-status`, never optimistic) | H | M | L |
| Accessibility | H (fieldset/legend, labelled controls, focus rules) | H | M (table editing) | L |
| Delight | M-H | M | M | M |

## Decision

**Chosen**: Option 1. The row shows the level, provenance, progress and Auto Enroll state read-only. One "Skill and Auto Enroll" disclosure panel per row holds two independent forms with separate Saves. The panel stays open after a successful save and closes with "Close" or Escape. Each save announces one sentence in `#members-status` (echoed visually beside its form). Rule and consequence lines are placed beside each Save. An ended Auto Enroll is shown and treated as off. Promotion is discovered on the next page load. **Q7**: admin-only and no notification in v1, with fee-transparency and Auto Enroll visibility obligations handed to registration-and-waitlist and session-scheduling-engine through ADR 0017.

### Rationale
- **Where the work already is**: admins judge levels while managing people. The row and its reserved control list are where they already approve, promote and ban.
- **Consequences before commitment**: an override restarts the count, and off-then-on loses the member's place in the order. An Auto Enroll can make a player liable for fees. Each of these is stated next to the button that causes it. No confirmation step is added, because every change is reversible with one more save, and the People page reserves confirmations for destructive acts (ban, self-demote, regenerate).
- **Honest async**: the admin is never told a promotion "will" happen on a date. The capped "40 of 40" display and the "Moved up automatically · {date}" provenance are enough. In production, "0 of 40" is shown as the truth it is.
- **Consistency**: server-authoritative, non-optimistic saves with in-place revalidation, one status region per section, the A7 rule, `NoAccess` and session-expired handling. Nothing new to learn.

### Trade-offs accepted
- **Two Save buttons in one panel**: clearer results and isolation win over a single button. Mitigated by grouping and naming.
- **No promotion notification for admins or players**: the admin finds promotions on page load, and the player is not told in v1 (Q7). Mitigated by the provenance line and the downstream obligations.
- **Unsaved values are lost** when another panel opens or the session expires: the forms are tiny.
- **The provenance line shows only the latest change**: history is in the logs only (the spec excludes a history table).
- **A stale panel can lower a member who was just promoted**: rare (it needs a panel left open across 05:30), visible in the result message, and reversible.
- **Needs JavaScript**: same safe failure as Ban.

---

## Implementation Guidelines

### Frontend requirements
1. `manage-view.ts` `memberRowControls`: add `skillControl: { kind: 'panel' }` for every APPROVED row (including admins and yourself). Pending, rejected and banned rows never get it (they are rendered by other lists).
2. `apps/web/src/lib/teams/skill-levels-view.ts`: pure functions for the provenance (`Self-assessed` / `Set by {name} · {date}` / `Moved up automatically · {date}`), progress (cap at the threshold; `Highest level` at ADVANCED; optional awaiting clause), Auto Enroll tag (`until` / `no end date` / `ended {date}`, where ended means `until < todayNZ`), the panel rule line, and the panel's ended state. Dates via `formatManageDate` (NZ). The "today" comparison uses the shared NZ date helper, never the host time zone.
3. `skill-enroll-panel.tsx`: disclosure via `manage-state` (`open.members = 'skill-<userId>'`).
   - Focus: on open, to the panel heading (`tabIndex=-1`). "Close" and Escape return focus to the trigger.
   - Two `<form>`s, each with a `fieldset`/`legend` and its own pending state.
   - Results dispatch `result` to the `members` section **without** `close` on success, so the panel stays open.
   - On 409/404 the result dispatches with `close: true` and focus goes to `#members-heading`.
   - The date input is not submitted while unticked.
4. `actions.ts`: `saveSkillLevelAction`, `saveAutoEnrollAction` (never optimistic; `revalidatePath` only on 200). `moderation.ts` gains the kinds `skill` and `autoEnroll`, mapping:
   - 200 changed / no-op → the spec messages;
   - 409/404 → the member-specific stale line, `refresh: true`, `close: true`;
   - 403 → `NO_ACCESS_HEADING`, refresh;
   - 422 → field errors;
   - 5xx → the AC-ERROR-6 line;
   - status 0 → the unknown-outcome line (Amendment A5).
5. `labels.ts`: the success lines, rule and consequence lines, Auto Enroll hint, ended note, Off second sentence, stale and failure lines (all proposed copy, finalised by UI/UX). Optionally the revised `SKILL_HINT_JOIN`.
6. No `localStorage`/`sessionStorage`, no URL state for the panel.

### Backend requirements (journey-driven; Architecture decides the shapes)
1. `PUT .../skill-level` response must let the web tell "changed" from "already at that level" (for example an `unchanged: true` flag, or comparing `skillChangedAt` before and after). The message differs.
2. `PUT .../auto-enroll`:
   - Same "unchanged" signal.
   - Treat `enabled: true` on a row whose `auto_enroll_until < todayNZ` as a new assignment (`assigned_at = now`) (Amendment A3; Algorithm/Architecture to confirm).
   - Report whether the order position was kept or reset, so the Off/On copy can be exact (optional).
3. `TeamMemberRow.skillProgress`: `games` uncapped from the API. The cap is a display rule. Alternatively the API returns `reached: boolean`.
4. Job:
   - `skill.progression.completed` with `scanned`, `promoted`, `failed`.
   - The run ends failed when `failed > 0`.
   - Operator command documented as `pnpm run jobs:trigger skill-progression` in `docs/getting-started.md`.

### Integration points

| System | Interface | Data exchanged |
|---|---|---|
| teams (web) | `memberRowControls`, `manage-state`, `#members-status`, `NoAccess`, `sessionExpiredUrl` | row controls, panel state, messages |
| teams API | `GET /teams/:id/members` (additive fields) | `skillOverride`, `skillChangedAt`, `autoEnroll`, `skillProgress` |
| skill-levels API | two `PUT` routes | level; `enabled` + `until` |
| worker | `skill-progression` queue | none (no payload) |
| registration-and-waitlist (future) | `assertApprovedMember` → `skillLevel` | fee by level; must name the level to the player |
| session-scheduling-engine (future) | `selectAutoEnrollees` → allocator | ordered user ids; must make auto-registrations visible to players |

---

## Acceptance Criteria (MANDATORY)

The spec's 35 ACs stand except where [Spec Amendments](#spec-amendments) change them. Below are the template's mandatory criteria mapped to spec ids with this journey's refinements. New criteria are marked **new**.

### AC-ENTRY-1: User can find the feature (spec, refined)
**Priority**: MUST
**Given** Aroha, an approved `TEAM_ADMIN` of "Tuesday Smashers", and Priya, an approved member
**When** Aroha opens `/teams/<id>/manage` and looks at Priya's row in Members
**Then** the row shows the level, a provenance line, a progress line, any Auto Enroll tag, and a button "Skill and Auto Enroll" with accessible name "Skill and Auto Enroll, Priya Patel" and `aria-expanded="false"`. Activating it opens the panel, sets `aria-expanded="true"` and focuses the panel heading. Escape and "Close" close it and return focus to the button. Opening it closes any open Ban confirm in Members.
**Verification**:
- [ ] E2E: button present on approved rows (including your own), absent on Join requests and Banned rows (AC-ENTRY-2)
- [ ] E2E: focus in and back; one panel per section
- [ ] E2E: a plain member gets `NoAccess` (AC-ENTRY-3)

### AC-HAPPY-1: User completes the primary journey (spec AC-HAPPY-1 + AC-HAPPY-7, refined)
**Priority**: MUST
**Given** Priya is an approved `BEGINNER` with Auto Enroll off
**When** Aroha:
  1. presses "Skill and Auto Enroll, Priya Patel"
  2. selects "Advanced", presses "Save skill level"
  3. without closing the panel, ticks "Auto Enroll", enters 30 Nov 2026 in "Until (optional)", presses "Save Auto Enroll"
  4. presses "Close"
**Then**:
  - User sees: "Skill level for Priya Patel set to Advanced." after step 2, then "Auto Enroll on for Priya Patel until 30 Nov 2026." after step 3, both announced in `#members-status`. The panel stays open between the saves, and focus is on the pressed Save each time. After step 4, focus is on the trigger and the row reads "Advanced · Set by Aroha Ngata · {today} · Highest level · Auto Enroll until 30 Nov 2026".
  - Data is: as spec AC-HAPPY-1 and AC-HAPPY-7.
  - User can: reopen and change either. Reload shows the same row.
**Verification**:
- [ ] E2E: full flow on desktop and 360 x 740, no native dialog, axe clean (serious/critical)
- [ ] Integration: rows and events as spec
- [ ] E2E (anti-stub): a second member set to Intermediate shows "Intermediate" and "0 of 40 games toward Advanced", not the first member's values

### AC-HAPPY-12 (new): Consequence lines are shown before saving
**Priority**: SHOULD
**Given** Priya is `BEGINNER` with 23 qualifying games
**When** Aroha opens her panel
**Then** the skill form shows the rule line with "23 of 40" and that saving a different level restarts the count at 0, plus the existing-fee line. The Auto Enroll form shows the hint naming automatic registration and charging. When Priya is `ADVANCED`, the rule line says Advanced is the highest level.
**Verification**:
- [ ] Unit: `skill-levels-view` rule-line table (each level, 0/23/40 games)
- [ ] E2E: lines visible in the open panel

### AC-HAPPY-13 (new): An ended Auto Enroll is shown as off and renews at the back of the order
**Priority**: MUST (if Amendment A3 is accepted)
**Given** Priya had Auto Enroll until 30 Nov 2026 and Sam was assigned after her, and today (NZ) is 2 Dec 2026
**When** Aroha loads Members, opens Priya's panel, ticks "Auto Enroll" and saves with no date
**Then** before saving, the row tag reads "Auto Enroll ended 30 Nov 2026" and the panel shows the box unticked with the ended note. After saving, the message is "Auto Enroll on for Priya Patel, with no end date.", `auto_enroll_assigned_at = now`, and `selectAutoEnrollees` returns Sam before Priya.
**Verification**:
- [ ] Integration: assignment reset only when `until < todayNZ` (an `until` of today keeps the place)
- [ ] Unit: view state for ended vs active vs off

### AC-ERROR-1: User recovers from a validation error (spec AC-ERROR-3, refined)
**Priority**: MUST
**Given** the panel is open with Auto Enroll ticked
**When** Aroha enters yesterday's date (NZ) and saves
**Then** "Choose today or a later date." appears beside "Until (optional)" (linked by `aria-describedby`) and in `#members-status`. The ticked box, the typed date and the skill form's selection are kept. The panel stays open. Nothing is written.
**Verification**:
- [ ] E2E: message, values, panel open
- [ ] Integration: 422 `fieldErrors.until`, no column change

### AC-ERROR-2: User recovers from a system error (spec AC-ERROR-6, amended)
**Priority**: MUST
**Given** the panel is open
**When** the API answers 5xx, or is unreachable
**Then** for 5xx: "We couldn't save that. Nothing was changed. Try again." For unreachable or timeout: the unknown-outcome line (Amendment A5). In both cases the panel stays open with the values, the page is not revalidated, and the row is unchanged. A retry after a lost-response commit gives "Priya Patel is already Advanced." (level) or keeps the order (Auto Enroll).
**Verification**:
- [ ] Unit: action mapping for 500, 503 and status 0
- [ ] Integration: repeated identical `PUT`s are idempotent (no second event, `assigned_at` unchanged)

### AC-ERROR-8 (new; journey side of AC-ERROR-2 and AC-ERROR-5): The member changed state while the panel was open
**Priority**: MUST
**Given** Aroha has Priya's panel open, and a co-admin bans Priya
**When** Aroha saves either form
**Then** the API answers 409. `#members-status` shows the member-specific stale line (Amendment A6). The page refreshes, the panel closes, focus moves to the Members heading, and Priya appears under "Banned members" with no Auto Enroll.
**Verification**:
- [ ] Unit: `moderation.ts` mapping (`close: true`, `refresh: true`)
- [ ] E2E (optional): two contexts, ban then save

### AC-ASYNC-1: Admin learns of an automatic promotion (spec AC-ASYNC-1 + AC-HAPPY-4, refined)
**Priority**: MUST
**Given** Priya is `BEGINNER` with 40 qualifying games (seeded), and the job has not yet run
**When** Aroha loads Members, then the job runs (or an operator runs `pnpm run jobs:trigger skill-progression`), then Aroha reloads
**Then** the first load shows "40 of 40 games toward Intermediate" (capped; optional awaiting clause per Amendment A4). After the run, the row shows "Intermediate · Moved up automatically · {date} · 0 of 40 games toward Advanced". No email or push is sent. `skill.progression.completed` reports `promoted = 1`.
**Verification**:
- [ ] Integration: job end to end through `registerJobs` (AC-INTEGRATION-2)
- [ ] Unit: progress display capped for 40, 41 and 85 games
- [ ] Integration (anti-stub): Sam with 39 games is unchanged and shows "39 of 40"

### AC-NAV-1: User navigates away and returns
**Priority**: SHOULD
**Given** the panel is open with unsaved changes
**When** Aroha reloads, follows a jump link, opens another row's panel, or comes back via My teams
**Then** the panel is closed and unsaved values are gone (nothing was sent). Saved changes are shown in the row. No value is in the URL or browser storage. After a session expiry and sign-in, Aroha lands on `/teams/<id>/manage#members`.
**Verification**:
- [ ] E2E: reload closes the panel; the saved row persists
- [ ] Unit: `sessionExpiredUrl` built with `#members`

### AC-INTEGRATION-1: Backend produces real output (spec AC-INTEGRATION-1 and 2 stand)
Real rows, a selection that differs by `sessionDate`, and progression that differs by seeded registrations. The row's progress line comes from the same `countQualifyingGames`. Seeding 23 versus 7 games shows "23 of 40" versus "7 of 40".

---

## Test Scenarios (Derived from Acceptance Criteria)

### Happy path tests
1. AC-ENTRY-1: button on approved rows only; focus in and out; one panel per section.
2. AC-HAPPY-1: level then Auto Enroll in one panel visit; row lines update.
3. Spec AC-HAPPY-2/3: lower (count restarts), same level (no-op message).
4. Spec AC-HAPPY-8/9/10: no date; date change keeps the place; off then on goes to the back.
5. AC-HAPPY-12: consequence lines.
6. AC-HAPPY-13: ended Auto Enroll shown as off; renewal at the back.
7. AC-ASYNC-1: capped "40 of 40", then "Moved up automatically".

### Error scenario tests
1. AC-ERROR-1: past date.
2. AC-ERROR-2: 5xx and unreachable copy; idempotent retry.
3. AC-ERROR-8: banned while the panel is open.
4. Spec AC-ERROR-1/4: non-admin 403 before the body; demoted mid-request → `NoAccess`.
5. Spec AC-ERROR-7: one member fails; the run ends failed; others promoted.

### Edge case tests
1. AC-NAV-1: reload, other panel, session expiry.
2. `until` = today included; flips to "ended" at NZ midnight (injected clock).
3. Self-override on your own row.

## Accessibility Checklist

- [ ] Keyboard: trigger, both forms, both Saves and Close reachable in DOM order; Escape closes; no focus trap (the panel is non-modal)
- [ ] Screen reader: the trigger's accessible name includes the member's name; the panel heading names the member; each form a `fieldset` with `legend`; results announced once via `#members-status` (the in-panel echo is not a live region)
- [ ] Focus: open → panel heading; save → stays on the pressed Save; 409/404 → `#members-heading`; close → trigger
- [ ] Errors: field messages linked with `aria-describedby`; hints (rule line, Until hint) linked to their controls
- [ ] Pending states: "Saving…" with `aria-disabled`
- [ ] No time limits; no native dialogs (UAT constraint)
- [ ] 360 px: no horizontal scroll; panel full width under the row; targets at least 44 px (existing `expectLayoutOk`)
- [ ] Status never colour-only: "Moved up automatically", "ended" and "Highest level" are words

## Analytics & Observability

### Key metrics (from logs; no new pipeline)

| Metric | Purpose | Target |
|---|---|---|
| Overrides per team per month, split raise/lower (`team.member.skill_overridden` from → to) | Self-assessment accuracy; whether the rule fits | Watch; many lowers right after approval suggest join-form copy changes |
| Overrides within 7 days after an automatic promotion of the same member | Whether the 40-game rule matches admins' judgement | Low (< 10% of promotions) once games exist |
| `skill.progression.completed.failed` | Job health | 0 sustained |
| Auto Enroll on/off churn (`team.member.auto_enroll_changed` off followed by on within 1 day) | Admins confused by the order rule | Low |
| 422 on `until` | Date-input friction | Low |

### Instrumentation points
- Existing spec events only (ids, levels, booleans, counts). The journey asks for one extra boolean on `team.member.auto_enroll_changed`: `orderReset` (true when `assigned_at` was set to now). This makes the churn metric and the ended-renewal rule observable without names. If Architecture adds it, also add it to the AC-VERIFY-6 field set.

---

## Hand-off notes for downstream features

To be recorded in ADR 0017 next to C-GAME-1 and C-SKL-1:

1. **Fee transparency (registration-and-waitlist, session page)**: a `BY_SKILL_LEVEL` fee shown to a player names the tier it uses ("(Intermediate rate)", proposed).
2. **Auto-registration visibility (session-scheduling-engine + registration-and-waitlist)**: registrations created by Auto Enroll are visible to the player wherever their registrations are listed, and labelled as automatic. The player is told by email (frequency is that feature's decision). The player can withdraw like any registration, under the normal deadline rules.
3. **Ordering semantics** (if Amendment A3 is accepted): `selectAutoEnrollees` needs no change, because the reset happens at save time.
4. **Schedule slot**: registration-and-waitlist also claims `30 5 * * *` (`registration-ban-reconcile`). The queues are distinct, so pg-boss allows both. The journey only needs promotions before admins' typical morning use (any slot from 05:30 to 07:00 is fine). Architecture decides whether to stagger.

## Dependencies on the parallel creative docs

| Topic | Owner | What this journey needs |
|---|---|---|
| What counts as a game, surplus carry-over | Algorithm (Q1, Q3) | Only the numbers on the progress line change; the journey is unaffected. The rule line wording ("40 games with this team in a year") must match the final rule |
| Override precedence, same-level no-op | Algorithm (Q2) | The journey assumes the spec default (override always applies, restarts the count). If "override pins the level" were chosen, the rule line and the provenance would need a "won't move up automatically" state |
| Ended Auto Enroll = new assignment on renewal | Algorithm / Architecture (Q4) | Amendment A3 |
| Response flags (`unchanged`, `orderReset`), uncapped `games` | Architecture | Exact messages without a second read |
| Schedule slot, sweep | Architecture | Any slot before about 07:00 NZ |
| Layout, final copy, in-panel echo vs status region, "Close" label | UI/UX (Q5) | All "(proposed)" strings; one visible confirmation near the Save without scrolling at 360 px, announced once |

## Validation Checklist

- [x] Journey delivers stated value (honest levels for pricing; regulars pre-filled once sessions exist)
- [x] All personas covered (admin; co-admin via provenance; player via Q7 decision and hand-off; operator via CLI and logs)
- [x] Errors are recoverable (validation, stale target, demotion, ban race, outage, unknown outcome, job failure)
- [x] Async states are clear (capped awaiting count, provenance with date, no false promises; "0 of 40" honest in production)
- [x] Consistent with existing patterns (memberRowControls, InlineConfirm disclosure, `#members-status`, non-optimistic actions, A7, NoAccess)
- [x] Accessible per requirements (no native dialogs, labelled controls, focus rules, 360 px)
- [x] Testable with defined scenarios

## Next Steps

1. Reconciliation step in the task file: fold in the amendments below, together with the Algorithm, Architecture and UI/UX decisions they depend on.
2. Phase 3: response flags (`unchanged`, optional `orderReset`), the ended-renewal rule, and `games` uncapped in `skillProgress`.
3. Phase 2: ADR 0017 gains the hand-off notes (fee transparency, auto-registration visibility, slot).
4. Phase 5: panel stays open after a save; consequence lines; ended state; capped progress; stale and unknown-outcome copy; Playwright for both viewports.

---

## Spec Amendments

These are recommendations for the reconciliation step. The task file is not edited here. "(proposed)" copy becomes final only after the UI/UX doc.

| Id | AC / section | Change |
|---|---|---|
| A1 | Invocation Method (panel) | The panel **stays open after a successful save** and closes with "Close" (rename from "Cancel", since there are two forms) or Escape. Focus stays on the pressed Save. Each result is announced once in `#members-status` and echoed visually beside its form. On 409/404 the panel closes and focus goes to `#members-heading`. |
| A2 | Invocation Method (panel content); new AC-HAPPY-12 (SHOULD) | Skill form shows a rule line with the current count and "Saving a different level restarts her count at 0.", plus "Sessions she has already registered for keep their fee." Auto Enroll checkbox hint names automatic registration, charging and the player's agreement. The Until hint says the date is included. |
| A3 | AC-HAPPY-9/10, AC-ASYNC-3; new AC-HAPPY-13 (MUST if accepted) | An ended Auto Enroll (`until < todayNZ`) is shown with the box **unticked** and an ended note. Saving `enabled: true` on such a row is a **new assignment** (`assigned_at = now`). Changing `until` while still active keeps the place (AC-HAPPY-9 unchanged). Needs Algorithm/Architecture confirmation. |
| A4 | AC-HAPPY-11, AC-ASYNC-1 | Progress display is **capped at the threshold** ("40 of 40 games toward Intermediate", never "43 of 40"). Optional clause "Moves up at the next daily update." (soft statement; drop it if the strict "nothing is promised" reading is preferred). |
| A5 | AC-ERROR-6 | Keep the spec line for a definite 5xx. For an unreachable API or a timeout (outcome unknown, A7 rule), use (proposed) "We couldn't confirm that was saved. Try again; saving the same change twice is safe." instead of claiming "Nothing was changed". |
| A6 | AC-ERROR-2 (web) | Replace the requests-oriented `STALE_MESSAGE` ("Someone else already handled this request...") with a member-specific line (proposed) "{fullName} is no longer an approved member. The list has been refreshed." Panel closes; focus to `#members-heading`. |
| A7 | AC-HAPPY-3, AC-HAPPY-9 | `PUT` responses carry an "unchanged" signal so the web can say "already ..." (skill, spec) and "Nothing to change ..." (Auto Enroll, proposed). The Off message gains "Turning it on again puts her at the end of the Auto Enroll order." (proposed). |
| A8 | Invocation Method (Background) | Operator command documented as `pnpm run jobs:trigger skill-progression` (the root script wrapping `cli jobs trigger`). Flag to Architecture: `registration-ban-reconcile` on `feature/registration-and-waitlist` claims the same `30 5 * * *` slot. |
| A9 | Creative Q7 / Scope | **Confirmed**: admin-only, no player notification in v1. ADR 0017 adds the downstream obligations: fee transparency by tier, and visibility plus an email for auto-registrations. COULD: `SKILL_HINT_JOIN` → "Rate yourself honestly. Team admins see this and can change it later." |
| A10 | AC-VERIFY-6 (optional) | `team.member.auto_enroll_changed` gains `orderReset` (boolean), if Architecture agrees. |
