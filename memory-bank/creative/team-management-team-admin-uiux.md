# UI/UX Decision: Team-Admin Area, Header Navigation and Skill Capture

**Created**: 2026-10-13
**Status**: DECIDED
**Decision Type**: UI/UX
**Task**: team-management (Level 3)
**Answers**: Creative Q2 (team-admin area IA and UX, header navigation) and Q6 (creator and requester skill capture)

Sources read: task file (branch tip), `productBrief.md`, `systemPatterns.md` (main), `apps/web/src/components/auth/*`, `site-header*.tsx`, `flash-notice.tsx`, `app/account/page.tsx`. `memory-bank/ux-patterns.md` does not exist yet, so the existing auth components are the pattern source.

## User Context

### Target Users
- **Primary**: Team Admin (`TEAM_ADMIN`, per team). A volunteer club organiser, often on a phone between other tasks, who reviews join requests, promotes helpers, bans a problem member and shares an invite link. Wants to finish an action in two taps and be sure it worked. Not technical.
- **Secondary**: Player (`PLAYER`) creating a team or asking to join one. Needs to state a skill level honestly without feeling judged. Also the later-feature authors (banking, skills, sessions) who must plug into the admin area without redesigning it.

### User Goals
1. Clear the join-request queue quickly (approve or reject with the person's skill level visible).
2. Share and, when leaked, replace the invite link without breaking existing members or pending requests.
3. Moderate safely: ban only when meant, never lock the team out of its own admins, understand why an action is blocked.
4. Players: say their own skill level once, explicitly, with no silent default.

### Use Cases
| Use Case | User | Goal | Frequency |
|----------|------|------|-----------|
| Review join requests | Team Admin | Approve or reject | Several times a week per active team |
| Copy invite link | Team Admin | Share in a group chat | Once at creation, then occasionally |
| Promote or demote a helper | Team Admin | Delegate or remove admin rights | Rare |
| Ban a member | Team Admin | Remove a problem member | Rare, high stakes |
| Regenerate invite link | Team Admin | Invalidate a leaked link | Rare, high stakes |
| Create team with own skill level | Player | Start a team | Once per team |
| Request to join with skill level | Player | Ask to join | Once per team |
| Find a team / My teams from the header | Anyone / signed-in | Navigate while `/` is a placeholder | Every session |

### Constraints
- **Devices**: desktop and 360 x 740 phone (Playwright projects); no horizontal scroll at 360 px; 44 px tap targets (`min-h-11`).
- **Accessibility**: axe `critical` is a UAT blocker (AC-VERIFY-7); labels on every input, `fieldset`/`legend` radios, `aria-describedby` errors, status not colour-only, no native browser dialogs (`window.confirm` is a blocker). WCAG 2.2 AA is the working target (productBrief gives no explicit level; the auth feature already targets it).
- **Languages and locale**: English only; dates in Pacific/Auckland, NZ format (P3).
- **Existing patterns**: Tailwind class strings in `components/auth/styles.ts` (`INPUT_CLASS`, `BUTTON_CLASS`, `SECONDARY_BUTTON_CLASS`, `LINK_CLASS`, `FOCUS_RING`), `FormBanner` (notice `role="status"` / error `role="alert"` focused once), `ErrorSummary` ("There's a problem", links to `#field-<name>`), `SexField` (fieldset, none preselected, first radio `id="field-<name>"`), `useAuthForm` (client validate, then Server Action, keeps typed values), `AuthCard` (`max-w-sm` single task), `FlashNotice`/`StripAuthParams` (one-time notice via query param, stripped), `account/page.tsx` (sections with `aria-labelledby`, `h2 text-lg font-semibold`). Teams use the same tokens; no new colours or fonts.
- **Guiding principles**: P3 (Auckland display only at the UI boundary). The API stays the authority; the UI never hides a rule it cannot prove (a hidden button is not a guard).

## User Flow

### Flow Diagram
```
My teams (/teams) --"Manage"--> /teams/[id]/manage
Create team --success--> /teams/[id]/manage?notice=team_created
                              |
        +---------------------+------------------------+--------------------+
        v                     v                        v                    v
  Join requests          Members                  Invite link         Banned members
  Approve / Reject       Make admin / Remove      Copy link           (read-only list)
        |                admin / Ban              Generate new link
        |                     |                        |
        |            Ban or self-demote:         Regenerate:
        |            [Ban] -> inline panel       [Generate new link] -> inline panel
        |            reason + [Ban member]/[Cancel]  [Generate new link]/[Cancel]
        v                     v                        v
   row leaves list,      row moves/changes,       new URL shown, focus on URL field,
   status line says      status line says         status line says so
   what happened         what happened
```

### Flow Description
1. **Entry**: "Manage" on a `/teams` row (admins only), the post-create redirect, or a bookmark. Anonymous goes to `/login?returnTo=...` (`proxy.ts` + `requireUser`). A non-admin sees the no-access page.
2. **Scan**: page title "Manage {Team name}"; an "On this page" jump list shows the four sections with a pending-request count.
3. **Act**: one-tap actions (Approve, Reject, Make admin, Remove admin) apply at once and are announced. Destructive or irreversible actions (Ban, Generate new link, removing your own admin rights) open an inline confirmation under the row or section.
4. **Confirm / cancel**: confirm runs the Server Action; Cancel or Escape closes the panel and returns focus to its trigger.
5. **Exit**: the admin leaves via the header or "Back to My teams". There is no wizard; every action is independently complete.

### Error States
| Error | Cause | User Recovery |
|-------|-------|---------------|
| 403 on page load | Not an approved admin of this team (also an unknown team id; identical body) | No-access page: "You don't have access to manage this team." and a "Back to My teams" link; member lists never render (AC-ENTRY-5) |
| 409 `membership_state_conflict` | Another admin handled the row first | Banner "Someone else already handled this request. The list has been refreshed." (list revalidated) |
| 409 `team_admin_cannot_be_banned` | Target is an admin | Prevented in the UI (disabled Ban with visible reason); if it still happens (stale list) the banner shows the same sentence and the list refreshes |
| 409 `last_team_admin` | Sole admin demotes themselves, or race | Banner "A team needs at least one admin. Make another member an admin first." |
| 404 `not_found` on an action | Member row vanished | Same banner as the stale conflict; list refreshed |
| 5xx or network | API down | Banner "Something went wrong on our side. Your details are still here. Try again in a minute." The open confirm panel and typed reason stay; no optimistic change; no sign-out (AC-ERROR-11) |
| 403 on an action | The admin was demoted meanwhile | The page re-renders as the no-access page after the action settles (`revalidatePath`) |
| Clipboard blocked | Browser denies `navigator.clipboard` | Status "Couldn't copy automatically. The link is selected, copy it manually." and the read-only field is selected |
| Reason over 500 chars | Ban form | Field error "Use 500 characters or fewer." beside the textarea (same field-error pattern as the auth forms) |

## Options Explored

### Option 1: One page, four stacked sections (spec default)
- **Approach**: `/teams/[teamId]/manage` renders "Join requests", "Members", "Banned members", "Invite link" top to bottom. Nothing else is planned; later features would add more stacked sections or their own pages ad hoc.
- **Wireframe/Layout** (desktop):
  ```
  ┌──────────────────────────────────────────────┐
  │ Manage Rosedale Badminton                    │
  │ Join requests                                │
  │  Ana Lee  Intermediate  requested 3 Oct      │
  │                          [Approve] [Reject]  │
  │ Members ...                                  │
  │ Banned members ...                           │
  │ Invite link ...                              │
  └──────────────────────────────────────────────┘
  ```
- **User Flow**: scroll; act in place.
- **Pros**:
  - Simplest: one route, one data load, no navigation state; matches the plan's pinned `manage/page.tsx`.
  - Join requests are first, which is the most frequent task.
  - Works without client routing; fully server-rendered.
- **Cons**:
  - A long page for a big team; the invite link (needed right after create) sits at the bottom.
  - No agreed seam for banking, skills and sessions; each later feature would negotiate the layout again.
  - Without jump links a phone user scrolls past 25 members to reach "Invite link".
- **Usability**: Medium. **Accessibility**: High. **Implementation Complexity**: Low.

### Option 2: Sub-routes with tabs (`/manage/requests`, `/manage/members`, `/manage/invite`)
- **Approach**: a manage layout with a tab-like nav; each section is its own page with its own fetch.
- **Wireframe/Layout**:
  ```
  ┌──────────────────────────────────────────────┐
  │ Manage Rosedale Badminton                    │
  │ [Requests 3] [Members] [Invite] [Banned]     │
  ├──────────────────────────────────────────────┤
  │ (one section only)                           │
  └──────────────────────────────────────────────┘
  ```
- **User Flow**: pick a tab, act, switch tab. After create, land on `/manage/invite` or `/manage/requests`?
- **Pros**:
  - Short pages; each loads only its list; deep-linkable.
  - Natural slot for future areas as more tabs.
- **Cons**:
  - Four routes, four loading and error boundaries and four `no-access` branches for what is today a few small lists (a social club has tens of members).
  - Moving a person (approve moves Requests to Members, ban moves Members to Banned) happens across pages, so the admin cannot see the result of an action without switching tabs.
  - Tab semantics (`role="tablist"`) are easy to get wrong; link-style nav is fine but then it is not a tab UI; the extra navigation costs taps on a phone.
  - Conflicts with the spec text "one /manage area with four sections" and the pinned file list.
- **Usability**: Medium (extra taps, results hidden). **Accessibility**: Medium (tab semantics) to High (plain nav links). **Implementation Complexity**: High.

### Option 3: One "People" page with a jump list, inside a manage layout that is the plug-in seam for later areas (CHOSEN)
- **Approach**: `/teams/[teamId]/manage` is the "People" area: Join requests, Members, Invite link, Banned members, on one server-rendered page with an "On this page" jump list. A `manage/layout.tsx` plus a small registry (`lib/teams/manage-areas.ts`) defines the admin area's areas. Today it holds one entry, so the area nav is not rendered (a one-link nav is noise). Later features append entries (`/manage/banking`, `/manage/sessions`) and the nav appears automatically; per-member skill overrides plug into the member row's action slot instead of a new page. Lists are keyset-paged by section with "Next" links that keep the fragment.
- **Wireframe/Layout**: see Design Specifications.
- **User Flow**: land, read the jump list, act in place; results appear in the same view (a request approved today shows in Members right below).
- **Pros**:
  - Cause and effect are visible on one page (approve then see the member appear).
  - Cheap now (Option 1) with a defined seam later (Option 2's benefit without its cost).
  - Jump list fixes the long-page problem on phones; the invite section is one tap away.
  - One data load; one no-access branch; matches pinned files plus a layout.
- **Cons**:
  - A very large team makes the page tall (mitigated by 25-per-section paging).
  - The layout and registry are small speculative structure (about 20 lines), justified by three known downstream features.
  - No name filter on members in v1 (see Trade-offs).
- **Usability**: High. **Accessibility**: High. **Implementation Complexity**: Low to Medium.

### Option 4: Members table with a side panel for every action
- **Approach**: one combined data table (all statuses, filter chips) and a drawer holding actions and confirmations for the selected row.
- **Wireframe/Layout**:
  ```
  ┌───────────────────────────────┬──────────────┐
  │ [All|Requests|Members|Banned] │ Ana Lee      │
  │ Name   Level   Status         │ [Approve]    │
  │ ...                           │ [Reject]     │
  └───────────────────────────────┴──────────────┘
  ```
- **Pros**: scales to large rosters; familiar admin pattern.
- **Cons**: needs a table or grid with proper keyboard semantics, a drawer with focus trapping (a modal in effect), and on 360 px the drawer becomes a full-screen modal; heavy for tens of rows; the confirmation is no longer "inline". Overbuilt for the personas and scale.
- **Usability**: Medium. **Accessibility**: Low to Medium (drawer focus management, table semantics). **Implementation Complexity**: High.

## Evaluation Matrix

| Criteria | Option 1 | Option 2 | Option 3 | Option 4 |
|----------|----------|----------|----------|----------|
| Usability (two-tap actions, visible results) | 3 | 3 | 5 | 3 |
| Accessibility | 4 | 3 | 5 | 2 |
| Consistency with existing patterns | 5 | 3 | 5 | 2 |
| Responsiveness (360 px) | 3 | 4 | 4 | 2 |
| Performance (one load vs many) | 4 | 4 | 4 | 3 |
| Implementation effort (5 = easy) | 5 | 2 | 4 | 1 |
| Fit for later features | 2 | 4 | 5 | 3 |
| **Total (of 35)** | 26 | 23 | 32 | 16 |

(Scores 1 to 5, higher is better.)

## Decision

**Chosen**: Option 3 - One "People" page with a jump list, inside a manage layout that is the plug-in seam for later areas.

### Rationale
- The admin's loop is "see request, decide, see the person appear in the right list". One page keeps that loop visible. Sub-routes split it across pages for a roster of tens of people.
- A phone organiser needs the invite link right after creating a team. The jump list ("Invite link") plus the stable section ids make that one tap.
- Later features have defined homes: banking and sessions become areas (`/manage/banking`, `/manage/sessions`, each gets the shared nav automatically once there are two areas); skill overrides become one more control in the member row (the row's action area is an array of actions, not hard-coded buttons). No later feature has to restructure this page.
- Confirmations are inline disclosure panels, so they work at 360 px, are keyboard-friendly, are not modals and cannot be mistaken for native dialogs (UAT blocker).
- The decision follows existing patterns (`FormBanner`, field errors, `LINK_CLASS`, `min-h-11`) rather than adding components other pages would not share.

### Trade-offs Accepted
- **No member name filter in v1**: the API contract (`status`, `after`) has none, and clubs have tens of members. Mitigation: keyset paging at 25, and a `q` parameter can be added later without changing the layout (a search field would sit under the "Members" heading).
- **Jump links, not tabs**: a long page remains for large teams. Mitigation: paging, and "Next" links keep the section fragment.
- **The confirm panel needs JavaScript**: with JS off, Ban and Generate new link cannot be opened (Approve, Reject, Make admin and Remove admin are plain forms and still work). Accepted: it is an admin tool, and the safer failure is "cannot do the destructive thing". A `<details>` element would work without JS but its `summary` is not exposed as `role="button"`, which contradicts the spec's button labels and the test selectors.
- **Layout and registry are built before they are needed**: about 20 lines, and they remove a three-feature negotiation.

## Design Specifications

### Layout
- **Page chrome**: the manage page is wider than `AuthCard` (`max-w-sm` is for single-task forms): `<main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8">`, matching the header's `max-w-3xl`. Create and join forms keep `AuthCard`.
- **Desktop (above 1024 px) and tablet**: single column up to 768 px. Rows are two-column: identity left, actions right-aligned (`sm:flex-row sm:items-start sm:justify-between`). Section headings `h2 text-lg font-semibold`, `<section aria-labelledby>`, 32 px apart.
- **Mobile (360 px)**: rows stack: identity, then actions as a wrapping row (`flex flex-wrap gap-2`, each button `min-h-11`, buttons `flex-1` when they would otherwise leave a lone button). Confirm panels are full width inside the row. No horizontal scroll; names and reasons use `break-words`; the invite URL sits in a read-only input that scrolls inside itself.

Desktop wireframe:
```
Shared Game Management   Find a team  My teams  Account     Signed in as Quy N.  [Sign out]
────────────────────────────────────────────────────────────────────────────────────────────
[notice] Team created. You're its first admin.                                      (status)

Manage Rosedale Badminton                                                           (h1)
Public team · 12 members

On this page:  Join requests (3) | Members | Invite link | Banned members

Join requests                                                                       (h2)
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Ana Lee                                                       [Approve Ana Lee] [Reject] │
│ Intermediate · requested 3 Oct 2026                                                      │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ Ben Tran                                                       [Approve]        [Reject] │
│ Beginner · requested 5 Oct 2026                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                                              Next 25 requests >

Members                                                                             (h2)
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Quy Nguyen (you)  Admin                                       [Remove admin]             │
│ Intermediate                                                                             │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ Cam Ng  Admin                                [Remove admin]   [Ban] (aria-disabled)      │
│ Advanced                                     Remove admin rights from Cam Ng before      │
│                                              banning them.                               │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ Dee Park  Member                             [Make admin]     [Ban]                      │
│ Beginner                                     ┌───────────────────────────────────────┐   │
│                                              │ Ban Dee Park? They lose access to this│   │
│                                              │ team and their upcoming registrations │   │
│                                              │ are cancelled.                        │   │
│                                              │ Reason (optional, only team admins    │   │
│                                              │ see this)                             │   │
│                                              │ [________________________________]    │   │
│                                              │ [Ban member] [Cancel]                 │   │
│                                              └───────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────────────────┘

Invite link                                                                         (h2)
Share this link to invite people. Anyone who opens it can ask to join; you still approve them.
[ https://app.example/teams/join?code=...........................  ] [Copy link]
[Generate new link]

Banned members                                                                      (h2)
Banned members lose access to this team and can't ask to join again.
  Eli Fox · banned 9 Oct 2026 · Reason: Repeated no-shows
```

360 px wireframe:
```
┌──────────────────────────────┐
│ Shared Game Management [Sign │
│                         out] │
│ Find a team  My teams Account│
│ Signed in as Quy Nguyen      │
├──────────────────────────────┤
│ [Team created. You're its    │
│  first admin.]               │
│ Manage Rosedale Badminton    │
│ Public team · 12 members     │
│ On this page                 │
│ Join requests (3)  Members   │
│ Invite link  Banned members  │
│                              │
│ Join requests                │
│ ┌──────────────────────────┐ │
│ │ Ana Lee                  │ │
│ │ Intermediate             │ │
│ │ requested 3 Oct 2026     │ │
│ │ [Approve    ] [Reject   ]│ │
│ └──────────────────────────┘ │
│ Members                      │
│ ┌──────────────────────────┐ │
│ │ Dee Park  Member         │ │
│ │ Beginner                 │ │
│ │ [Make admin ] [Ban      ]│ │
│ │ ┌──────────────────────┐ │ │
│ │ │ Ban Dee Park? They...│ │ │
│ │ │ Reason (optional...) │ │ │
│ │ │ [__________________] │ │ │
│ │ │ [Ban member        ] │ │ │
│ │ │ [Cancel            ] │ │ │
│ │ └──────────────────────┘ │ │
│ └──────────────────────────┘ │
│ Invite link                  │
│ [ https://app.../teams/jo... ]│
│ [Copy link                  ]│
│ [Generate new link          ]│
└──────────────────────────────┘
```

### Header navigation (while `/` is a placeholder)
- The header carries primary links that stay valid when `/` becomes the dashboard: "Find a team" (everyone), "My teams" (signed in), "Account" (existing).
- Structure per state (DOM and tab order: brand, primary links, signed-in text, Sign out or auth actions):
  - **Anonymous**: brand, "Find a team", "Sign in", "Create account". 360 px: row 1 brand and "Create account"; row 2 "Find a team", "Sign in".
  - **Signed in**: brand, "Find a team", "My teams", "Account", then "Signed in as {name}" and "Sign out". 360 px: row 1 brand and "Sign out"; row 2 the three links (wrap allowed); row 3 "Signed in as {name}" truncated (`min-w-0 truncate`). From `sm`: one wrapping row, text and sign-out on the right.
  - **Unavailable**: brand, "Find a team", "Account" (never "Sign in" to a possibly signed-in user, as today).
- Links use `LINK_CLASS` (44 px). `aria-current="page"` on the exact matching page (`/teams/find`, `/teams`, `/account`), consistent with the existing `current()` helper. Links go inside the existing `<nav aria-label="Main">`.
- The brand link to `/` stays as is; the placeholder page needs no change (the header is the entry point per spec).

### Key Components
| Component | Purpose | Behavior |
|-----------|---------|----------|
| `ManageJumpNav` | "On this page" list of four anchors | `<nav aria-label="On this page">`, links `#requests`, `#members`, `#invite`, `#banned`; request count badge as text "(3)" or "(25+)" when a next page exists; links `LINK_CLASS`, wrap at 360 px |
| `ManageSection` | Heading, live status region, empty state, pager | `<section id aria-labelledby>`; `h2` has `tabIndex={-1}` (focus target after a row leaves); contains one persistent `role="status"` region; empty state paragraph; `SectionPager` |
| `JoinRequestList` | Pending rows | Row: name, skill, "requested {date}" (`<time dateTime>`), [Approve] [Reject]; no confirm (reject is re-requestable, AC-HAPPY-8) |
| `MemberList` | Approved rows | Row: name, role text "Admin"/"Member" (text badge, not colour only), "(you)" on own row, skill; actions slot: [Make admin] or [Remove admin], [Ban]; later features add controls to the same slot |
| `BannedList` | Banned rows, read-only | Name, "banned {date}", "Reason: ..." or "No reason given."; reason text rendered as text (escaped), `whitespace-pre-line break-words` |
| `InlineConfirm` | The one confirmation pattern | Trigger button (`aria-expanded`, `aria-controls`) + panel `role="group"` `aria-labelledby` the prompt; used by Ban, Generate new link, and removing your own admin rights; see Interactions |
| `InviteLinkPanel` | URL, Copy link, Generate new link | Read-only input labelled "Invite link" (selects all on focus), [Copy link], [Generate new link] with `InlineConfirm`; live status |
| `SectionPager` | Keyset "Next" and "Back to start" | Plain links (`?membersAfter=<cursor>#members`); no JS needed; `aria-label` "Next members" etc. |
| `SkillLevelField` | Fieldset radios, none preselected | See Q6 below |
| `CreateTeamForm`, `JoinTeamForm` | Forms using `useAuthForm`, `ErrorSummary`, `FormBanner` | As the auth forms |
| `NoAccess` (inside `manage/page.tsx`) | 403 state | `<h1>` "You don't have access to manage this team."; link "Back to My teams" |

### Interactions
| Trigger | Action | Feedback |
|---------|--------|----------|
| Approve (request row) | Server Action; row leaves "Join requests", appears in "Members" after revalidate | Section status: "{Name} has been approved." Focus moves to the "Join requests" heading |
| Reject | Row leaves "Join requests" | "{Name}'s request was declined." Focus to the heading |
| Make admin | Role becomes admin, row stays | "{Name} is now a team admin." Focus stays on the same slot (button becomes "Remove admin") |
| Remove admin (another admin) | Role becomes member, row stays | "{Name} is no longer a team admin." Focus stays in the slot |
| Remove admin (yourself) | Opens `InlineConfirm`: "Remove your own admin rights? You'll lose access to this page." [Remove admin] [Cancel] | On success: redirect to `/teams` with the notice "You're no longer an admin of {Team name}." (own access is gone) |
| Ban (trigger) | Opens `InlineConfirm` below the row; focus moves to the prompt paragraph (`tabIndex={-1}`) so the screen reader reads it | `aria-expanded="true"` on the trigger; only one confirm open per section (opening another closes it) |
| Ban member (confirm) | Server Action with optional reason | Panel closes and the row leaves "Members"; status "{Name} has been banned."; the row appears in "Banned members"; focus to the "Members" heading |
| Cancel or Escape | Closes the panel | Focus returns to the trigger; typed reason is discarded |
| Ban on an admin row | Nothing happens (`aria-disabled="true"`, not removed); reason text is visible under the button and linked with `aria-describedby` | "Remove admin rights from {Name} before banning them." |
| Copy link | `navigator.clipboard.writeText(url)` | Status "Link copied." (visible for the section, announced politely); on failure the field is selected and "Couldn't copy automatically. The link is selected, copy it manually." |
| Generate new link (trigger) | Opens `InlineConfirm`: "Generate a new link? The old link stops working immediately." | Focus to the prompt |
| Generate new link (confirm) | Server Action; new code | URL field updates; focus moves to the URL field (the changed content); status "New invite link generated. The old link no longer works." |
| Action while pending | Button gets `aria-disabled`, label "Approving..." etc.; second click ignored | Prevents double submits (AC-ERROR-4 spirit); no layout shift |
| Server error | Section banner (`FormBanner kind="error"`, focused once per result); the confirm panel stays open with typed reason on 5xx | Messages in Error States |
| Concurrent change | 409 `membership_state_conflict` | Banner copy above; list refreshed (`revalidatePath`) |

Notes:
- Status regions are present in the DOM from first render (empty) so the first announcement is read. Notices persist until the next action in that section; they do not auto-dismiss (WCAG 2.2.1).
- Buttons keep short visible names ("Approve", "Ban") with a longer accessible name that starts with the visible text: `aria-label="Approve {Name}"`, `"Reject {Name}"`, `"Make admin, {Name}"`, `"Remove admin, {Name}"`, `"Ban {Name}"` (WCAG label-in-name: the accessible name must contain the visible text). Playwright `getByRole('button', { name: 'Approve' })` still matches by substring.
- The confirmation is not a modal: no focus trap, no `aria-modal`, no backdrop; the rest of the page stays reachable. Panels are `role="group"`, not `alertdialog`, because nothing is blocked.
- Visual style: confirm panel `rounded-md border-2 border-slate-900 bg-slate-50 p-4`; the destructive confirm uses `bg-red-800 text-white`; both carry the action name in text, so meaning is not colour only.

### Responsive Behavior
| Breakpoint | Changes |
|------------|---------|
| < 640px | Header on three rows; rows stack; actions wrap (`flex-wrap`, min 44 px height); confirm buttons stack full width; jump list wraps; invite input and buttons stack |
| 640-1024px | Header one wrapping row; rows two-column (identity / actions); confirm buttons side by side |
| > 1024px | Same as tablet inside `max-w-3xl`; no extra columns (a wide second column adds nothing for this content) |

### Accessibility Requirements
- [ ] Keyboard: every control reachable in DOM order; Enter/Space activate; Escape closes an open confirm; jump links move focus to the section (give each `section` `tabIndex={-1}` or use the heading, so the fragment target receives focus)
- [ ] Screen reader: one `h1`, `h2` per section, lists as `<ul>` with `aria-labelledby`; status in persistent `role="status"` regions; errors in `role="alert"` focused once; disabled Ban described by visible text
- [ ] Contrast: reuse `slate-900/700` text, `blue-800` links, `red-800` on white (all AA); no colour-only status
- [ ] Focus indicators: `FOCUS_RING` on every interactive element, including the summary-less disclosure buttons
- [ ] Error messages: field errors beside the field and in `ErrorSummary` (create/join); row-action errors in the section banner
- [ ] 44 px minimum targets (`min-h-11`), 16 px text (`text-base`) in inputs; no horizontal scroll at 360 px
- [ ] Page titles: "Manage {Team name}", "Find a team", "My teams", "Create a team"; "Error: " prefix on validation failures via `ErrorSummary`
- [ ] No `window.confirm`, `alert` or `prompt` anywhere

## Q6: Skill capture (create and join forms)

### Field design
- One shared component, `SkillLevelField`, rendered on both forms. Fieldset legend **"Your skill level"**, three radios **Beginner**, **Intermediate**, **Advanced**, input `name="skillLevel"`, values `BEGINNER` / `INTERMEDIATE` / `ADVANCED`, none preselected. The first radio carries `id="field-skillLevel"` (error-summary target), as `SexField` does.
- Required. Error text, beside the legend and in the summary: **"Select your skill level to continue."** (AC-ERROR-1/2). The button stays enabled so the summary explains (existing rule X9).
- Never preselect, including on a re-request after rejection and after a failed submit that had no choice; a failed submit refills the previous choice (`defaultValue`).
- Each option has a one-line description, linked with `aria-describedby` on its radio and rendered outside the `<label>` so the accessible name stays exactly "Beginner", "Intermediate", "Advanced" (tests `getByLabel('Beginner')` stay stable):
  - Beginner: "New to the sport or still learning the basics."
  - Intermediate: "You play regularly and know the game well."
  - Advanced: "Experienced and competitive."
  (Sport-agnostic; the product's first market is badminton but teams may play other sports.)
- Hint under the legend (class `text-sm text-slate-700`, id `field-skillLevel-hint`):
  - **Create form**: "Your own level as a player. Team admins can see it."
  - **Join form**: "Rate yourself honestly. The team admin sees this when they review your request."
  - The create hint and the existing `SexField` hint ("Some teams set session prices by sex.") use the same pattern; do not promise pricing behaviour here (not built yet).
- Layout: radios stacked, each row `min-h-11`, description beneath the label indented to the label text (`pl-8`) so it does not fall under the radio on 360 px.
- Visibility fieldset on the create form follows the same pattern: legend "Visibility", radios "Public" and "Private" with descriptions "Anyone can find your team in Find a team and ask to join." and "Only people with your invite link can find it and ask to join."; hint "You can't change this after the team is created." (true in v1: editing visibility is out of scope.) Error: "Choose who can find your team." Order of fields on the create form: Team name, Description (optional), Visibility, Your skill level, [Create team].
- Field help for text inputs: Team name "Up to 100 characters." Description "Up to 1000 characters." No `maxlength` attribute (it would truncate silently and bypass the message required by AC-ERROR-1).
- Join form location: on `/teams/[teamId]` and `/teams/join`, heading "Ask to join {Team name}", then `SkillLevelField` and the primary button "Request to join". After success: banner "Request sent. A team admin will review it." and status "Pending approval"; the form is replaced by the status (focus stays on the banner region, which is `role="status"`).

## Implementation Guidelines

### For Developers
1. Reuse `components/auth/styles.ts`, `FormBanner`, `ErrorSummary`, `FieldError`/`describedBy`, `useAuthForm`; copy the `SexField` structure for `SkillLevelField`. Add one `StripParams` (or generalise `StripAuthParams`) for `notice=team_created`.
2. Build the manage page as a Server Component: `requireUser(...)`, then in parallel `GET /teams/:id`, `GET /teams/:id/members?status=PENDING`, `...=APPROVED`, `...=BANNED`, `GET /teams/:id/invite-code`. A 403 from any of them renders `NoAccess` and nothing else. Render lists only after the guard passed.
3. Actions are Server Actions in `lib/teams/actions.ts` (`approveMember`, `rejectMember`, `promoteMember`, `demoteMember`, `banMember`, `regenerateInviteCode`, `createTeam`, `requestToJoin`) returning `{ ok, message?, fieldErrors?, code? }`; each ends with `revalidatePath` of the manage page and maps API codes (409/403/5xx) to the copy below via `labels.ts`. Never optimistic.
4. Approve, Reject, Make admin and Remove admin (others) are plain `<form action>` buttons (work without JS). `InlineConfirm` is a small client component.
5. Keep action definitions in an array on each row so later features add controls (skill override) without touching row layout.
6. Keyset paging: `requestsAfter`, `membersAfter`, `bannedAfter` search params; links include the fragment (`#members`); "Back to start" link removes the param. Page size 25.
7. Dates: one helper in `labels.ts` formatting with `Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Pacific/Auckland' })`, rendered inside `<time dateTime>`.
8. Add `export const dynamic = 'force-dynamic'` and `Cache-Control: no-store` for `/teams/[teamId]/manage` (it contains the invite code).

### Copy (exact strings, to live in `lib/teams/labels.ts`)
| Where | Copy |
|-------|------|
| Created notice (query `notice=team_created`) | "Team created. You're its first admin." |
| Approve | "{Name} has been approved." |
| Reject | "{Name}'s request was declined." |
| Promote | "{Name} is now a team admin." |
| Demote | "{Name} is no longer a team admin." |
| Self-demote notice on `/teams` | "You're no longer an admin of {Team name}." |
| Ban prompt | "Ban {Name}? They lose access to this team and can't register for its sessions." |
| Ban reason label | "Reason (optional, only team admins see this)" |
| Ban buttons | trigger "Ban", confirm "Ban member", "Cancel" |
| Ban success | "{Name} has been banned." |
| Admin ban blocked | "Remove admin rights from {Name} before banning them." |
| Self-demote prompt | "Remove your own admin rights? You'll lose access to this page." |
| Last admin | "A team needs at least one admin. Make another member an admin first." |
| Regenerate prompt | "Generate a new link? The old link stops working immediately." |
| Regenerate buttons | trigger "Generate new link", confirm "Generate new link", "Cancel" |
| Regenerate success | "New invite link generated. The old link no longer works." |
| Copy | "Link copied." / "Couldn't copy automatically. The link is selected, copy it manually." |
| Stale | "Someone else already handled this request. The list has been refreshed." |
| 5xx / network | "Something went wrong on our side. Your details are still here. Try again in a minute." |
| Reason too long | "Use 500 characters or fewer." |
| Empty: Join requests | "No join requests right now. New requests appear here." |
| Empty: Members (only you) | "You're the only member so far. Share the invite link to bring people in." with a link "Go to Invite link" (`#invite`) |
| Empty: Banned members | "No banned members." |
| Banned intro | "Banned members lose access to this team and can't ask to join again." |
| Invite intro (public team) | "Share this link to invite people. Anyone who opens it can ask to join; you still approve them. This team is also listed in Find a team." |
| Invite intro (private team) | "Only people with this link can find and ask to join this team. You still approve them." |
| No access | "You don't have access to manage this team." with link "Back to My teams" |
| Loading (`loading.tsx`) | `role="status"` "Loading team admin..." |
| Skill error | "Select your skill level to continue." |

### Component Structure
```
apps/web/src/
├── app/teams/
│   ├── page.tsx                         (My teams; "Manage" link on admin rows)
│   ├── find/page.tsx
│   ├── new/page.tsx
│   ├── join/page.tsx
│   └── [teamId]/
│       ├── page.tsx
│       └── manage/
│           ├── layout.tsx               (area shell; renders area nav only when >1 area)
│           ├── page.tsx                 (People area: four sections)
│           ├── loading.tsx
│           └── error.tsx                (same pattern as app/account/error.tsx)
├── components/teams/
│   ├── skill-level-field.tsx
│   ├── create-team-form.tsx
│   ├── join-team-form.tsx
│   ├── team-search.tsx
│   ├── manage-jump-nav.tsx
│   ├── manage-section.tsx
│   ├── join-request-list.tsx
│   ├── member-list.tsx                  (pinned name; approved rows and actions)
│   ├── banned-list.tsx
│   ├── inline-confirm.tsx               (client; the only confirmation pattern)
│   ├── invite-link-panel.tsx            (client; copy + regenerate)
│   └── section-pager.tsx
├── components/site-header-links.tsx     (extend)
└── lib/teams/
    ├── actions.ts                       (Server Actions, no JSX)
    ├── labels.ts                        (status labels, copy, date helper)
    ├── manage-areas.ts                  (area registry: People now; banking/sessions later)
    ├── actions.test.ts
    └── labels.test.ts
```
Every file extension above follows `systemPatterns.md` Code Organization (`.tsx` for rendering under `app/**` and `components/**`; `.ts` under `lib/**`; `.test.ts` co-located).

### Recommended Libraries/Patterns
- No new dependency. Disclosure pattern (button with `aria-expanded` and `aria-controls`) for `InlineConfirm`; native `<form action>` for one-tap actions; `navigator.clipboard` with a select-the-field fallback; `useActionState` as in `useAuthForm`.
- `aria-disabled` rather than `disabled` for blocked or pending actions (stays focusable and describable; matches `BUTTON_CLASS`'s `aria-disabled:` styles).

## Spec amendments

These are recommendations for the plan and spec; the task file is not edited here.

1. **Section order**: Join requests, Members, **Invite link**, Banned members (spec lists Banned members third). Banned is the rarest and read-only; invite is needed right after create. Section ids: `requests`, `members`, `invite`, `banned`.
2. **Extra files** beyond the pinned list: `app/teams/[teamId]/manage/{layout,loading,error}.tsx`, `components/teams/{manage-jump-nav,manage-section,join-request-list,banned-list,inline-confirm,section-pager}.tsx`, `lib/teams/manage-areas.ts`. `member-list.tsx` keeps only the approved list.
3. **Members endpoint**: fixed page size 25 and server ordering (PENDING by `requestedAt` ascending so the longest-waiting is first; APPROVED admins first then `lower(fullName)`, `userId`; BANNED by `bannedAt` descending). Optional but recommended: add `adminCount` to the `GET /teams/:teamId/members` response (or a flag per row) so the UI can show "Remove admin" as blocked proactively for the last admin. Without it the UI relies on the 409 `last_team_admin` banner (acceptable fallback).
4. **Self-demote confirmation**: removing your own admin rights uses the same inline confirm (the spec only names Ban and Generate new link); on success redirect to `/teams` with "You're no longer an admin of {Team name}."
5. **Copy additions**: the approve, reject, promote, demote, copy, empty-state, no-access and conflict strings listed above (spec only gives ban, regenerate, created and request-sent copy). Add them to the AC wording or to `labels.ts` tests.
6. **Caching**: `/teams/[teamId]/manage` is `Cache-Control: no-store` (it embeds the invite code); the spec only requires it on `/teams/join`. Reflect in `proxy.test.ts`.
7. **Header**: "Account" and "Signed in as {name}" keep their labels; the nav reflows (three rows at 360 px) and `site-header.test.tsx` needs cases for each state (anonymous, signed in, unavailable) including "Find a team" and "My teams". AC-ENTRY-1's "links wrap without horizontal scroll" is met by the two-row layout described.
8. **Skill field**: field name `skillLevel`; per-option helper text and hint as specified; no preselection even when re-requesting after rejection (AC-HAPPY-8 implies a new choice). Visibility fieldset gets the same descriptive pattern.
9. **Create success notice**: delivered as `?notice=team_created` on the redirect and stripped client-side after mount (same mechanism as `StripAuthParams`), not a stored flash.
10. **Ban button for admins**: `aria-disabled` plus visible explanatory text linked via `aria-describedby` (consistent with AC-ERROR-6; stated explicitly so tests assert the text, not a tooltip).
11. **No filter in v1**: member lists have paging only; a name filter is deferred (additive later).

## Validation Checklist

- [x] Meets all user goals (queue, share link, safe moderation, honest skill capture)
- [x] Accessible per requirements (AC-VERIFY-7 items mapped above; no native dialogs; inline confirms)
- [x] Consistent with existing patterns (auth components and class strings, `FormBanner`, `SexField` structure)
- [x] Respects Guiding Principles (P3 date display at the UI boundary; the API remains the authority for every rule; UI never relies on hidden controls)
- [x] Responsive across devices (360 px wireframes and breakpoints)
- [x] Performance acceptable (one parallel server load; 25-row pages; no client data fetching)
- [x] Implementation feasible (no new dependency; one small client component for confirms and one for the invite panel)

## Next Steps

1. Fold the spec amendments into the plan (Phase 4 header and forms; Phase 5 manage area) and extend the pinned file list.
2. Phase 4: implement `SkillLevelField`, the create and join forms, header links and `labels.ts` (copy table above) with unit tests for labels and form validation.
3. Phase 5: implement `manage/layout.tsx`, the registry, `InlineConfirm`, lists and `InviteLinkPanel`; write Playwright journeys (desktop and 360 px) including axe scans, Escape-to-cancel, and focus assertions after Ban and Generate new link.
4. Add `memory-bank/ux-patterns.md` (via `/yay:ux-ingest`) entries for: inline confirmation (disclosure, not dialog), row action slot, status-region and focus rules, so later admin areas follow them.
5. Revisit a members name filter and the dashboard link (`/`) when the player dashboard feature lands.
