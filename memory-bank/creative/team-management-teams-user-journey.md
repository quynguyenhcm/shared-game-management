# User Journey Design: Team Management

**Created**: 2026-10-13
**Status**: DECIDED
**Decision Type**: User Journey
**Task**: `team-management` (Level 3). Spec: `memory-bank/tasks/team-management.md` (approved 2026-10-13).
**Parallel inputs (not decided here)**: the Architecture creative doc (ban seam, membership state-machine policy, invite code, search) and the UI/UX creative doc (team-admin area layout, header nav, skill capture). This document assumes the spec defaults for those and lists every place the journey depends on them in [Dependencies on the parallel creative docs](#dependencies-on-the-parallel-creative-docs).
**Basis**: `main` after auth-and-user-roles. The web conventions this journey reuses are set by `auth-and-user-roles-user-journey.md`: one task per URL, Server Actions with in-place `FormState` errors and `redirect(..., RedirectType.replace)` on success, codes-only notices in the query string with text from a copy deck, `returnTo` validated by `safeReturnTo`, `requireUser(returnTo)` on protected pages, `proxy.ts` sign-in redirect and `no-store`, `FlashNotice`/`StripAuthParams` stripping one-shot codes, the generic E-SYS-2 outage banner, and focus on the error summary. `/` is still the platform-foundation placeholder, so the header is the only global entry point.

---

## Journey Overview

**Feature**: Create a team, find a public team, open a private invite link, ask to join with a self-assessed skill level, see the outcome on My teams, and (as a team admin) approve or reject requests, add or remove admins, ban members and replace the invite link.
**Primary Persona**: Player (`PLAYER`) creating or joining a team, usually on a phone after a link was shared in a group chat. Secondary: Team Admin (`TEAM_ADMIN`, per team) moderating, more often on a laptop.
**Journey Type**: Hybrid, but almost entirely synchronous from the user's side. Every form is Server Action → Fastify API → redirect or in-place result. Two things are asynchronous: (1) the *human* wait between "Request to join" and an admin's decision, which can take days and has **no notification** in v1, and (2) the `member-banned` job after a ban, which the admin never sees (the registration side-effect belongs to registration-and-waitlist; until then the handler is a no-op).
**Orchestration Pattern**: Dedicated single-purpose pages (Find, team page, invite landing, Create, My teams, Manage) with a **status-driven team page** (one URL whose body changes with the caller's membership status) and **My teams as the status hub** that replaces notifications. Create and join use post/redirect/get with a one-shot notice code; moderation on the manage page uses an **in-place result region** with list revalidation.

### Success Statement
> A player opens a shared link or searches "badminton", picks their level, taps "Request to join", and sees "Pending approval" on the team page and on My teams; a team admin sees "2 join requests waiting" on My teams, approves in one tap, and the player's row reads "Member" the next time they look.

---

## Persona Context

### Primary User
- **Who**: Player (`PLAYER`, productBrief Key Personas).
- **Goal**: Get into a team so they can register for sessions. Onboarding flow in productBrief: sign up, pick sex, find or join a team with a self-assessed skill level, then wait for admin approval.
- **Context**: Phone, often inside a messaging app's browser, after a club organiser posts the invite link in a chat. Many are first-time visitors with no account. Some search for a club near them on Find a team.
- **Proficiency**: Casual. Unsure what "Intermediate" means for this club. Does not expect to be told "no", and will not come back to check unless reminded.

### Secondary Users
- **Team Admin** (`TEAM_ADMIN`, per team): the club organiser. Creates the team, shares the link, works through join requests in batches (often on a laptop, sometimes at the venue on a phone), occasionally shares admin duties, rarely bans. All admins are equal; the creator is not special.
- **Team creator before their team exists**: a Player who becomes the first admin. Their journey ends on the manage page with the invite link ready to share.
- **Banned member**: a Player who has lost access. They get no message and never see the reason. Their journey is "something stopped working", and the copy must be plain and final without being hostile.
- **Later features** (registration-and-waitlist, skill-levels-and-auto-enroll, team-banking-and-gst, session-scheduling-engine): consume the membership status, the manage area and the ban seam. The journey keeps space for their sections in the manage area but does not design them.

---

## Journey Map

### Entry Points

| Entry | Context | User intent |
|---|---|---|
| Header "Find a team" | Every page, everyone | "Is there a club I can join?" |
| Header "My teams" | Every page, signed in | "Where do I stand?" / "Anything to approve?" |
| Shared invite link `/teams/join?code=…` | Chat message, email, QR at the venue | "I was told to join this team" |
| Shared team page link `/teams/[teamId]` | Someone copies the address of a public team | "Have a look at this club" |
| My teams "Create a team" (and Find empty state "create your own team") | Signed in | "I run a group and want it here" |
| My teams "Manage" / "{n} join requests waiting" | Signed-in admin | "Deal with the requests" |
| Direct visit to a protected URL while signed out | Bookmark, history | Same as above, sign-in is in the way |

### Page and route inventory

| URL | Kind | Who sees it | Purpose |
|---|---|---|---|
| `/teams/find?q=&after=` | public page, GET form | Everyone (signed-in users see their status per team) | Search public teams |
| `/teams/[teamId]` | page, status-driven | Public team: everyone. Private team: callers with a non-banned row only (else 404) | Team description, the caller's status and the next action |
| `/teams/join?code=` | protected page (`no-store`, `no-referrer`) | Signed in (anonymous → `/login?returnTo=…`) | Invite landing: team preview and join form |
| `/teams` | protected page | Signed in | My teams: every non-banned membership with its status; Create and Find buttons |
| `/teams/new` | protected page | Signed in | Create a team |
| `/teams/[teamId]/manage` | protected page, `TEAM_ADMIN` only | Approved admins of that team | Join requests, Members, Banned members, Invite link (layout: UI/UX doc) |

### Query-string grammar for this feature

`?notice=<code>` only, from the closed list `team_created`, `join_requested`, `self_demoted` (plus the existing `welcome` after sign-up). No `error` codes travel in team URLs: team errors are shown in place by the action that hit them, or are the page's own state (not found, no access, banned, invalid invite). Text comes only from `apps/web/src/lib/teams/labels.ts` (the [Copy deck](#copy-deck)). After render, `StripAuthParams`' sibling removes `notice` from the address bar so a reload does not replay it. `q` and `after` on `/teams/find` are kept (they are the page's state, and Back must work). `code` on `/teams/join` is kept until the user leaves the page (it is the page's input).

### Status-driven team page (`/teams/[teamId]`)

The page asks `GET /teams/:teamId` (optionalSession) and renders by the caller's status. This one table is the heart of the joining journey; the invite landing reuses the same rows.

| Caller | Status label | Body | Primary action |
|---|---|---|---|
| Anonymous, public team | none | Name, description, "{n} members" | "Sign in to ask to join" (→ `/login?returnTo=/teams/[id]`), secondary "New here? Create an account" (→ `/register?returnTo=…`) |
| Signed in, no row, public team | none | as above | Join form: "Your skill level" (none preselected), "Request to join" |
| `PENDING` | Pending approval | "Your request is with the team admins. There's no email for this yet, so check My teams to see the outcome." | Link "Go to My teams" |
| `APPROVED` `MEMBER` | Member | "You're a member of this team." | Link "Go to My teams" |
| `APPROVED` `TEAM_ADMIN` | Admin | "You're an admin of this team." | Link "Manage team" (→ `/manage`) |
| `REJECTED`, public team | Request declined | "Your last request wasn't approved. You can ask again." | Join form (same skill field, none preselected) |
| `REJECTED`, private team | Request declined | "Your last request wasn't approved. To ask again, open the team's invite link. If you don't have it, ask a team admin." | none (see amendment A2) |
| `BANNED`, public team | none | H2 "You can't join this team." | none |
| `BANNED` or no row, private team; any unknown id | n/a | 404 page "We couldn't find that team." | Links "Find a team", "My teams" (signed in) |

Never shown on this page: other members, emails, the invite code, the ban reason, an "Edit" control (out of scope).

### Invite landing (`/teams/join?code=`)

`requireUser('/teams/join?code=…')`, then `POST /teams/invite/lookup { code }`.

| Lookup result | Page shows |
|---|---|
| 200, `myStatus` none or `REJECTED` | Eyebrow "You've been invited to join", H1 team name, description, "{n} members", "Private team" or "Public team" tag, the join form |
| 200, `myStatus` `PENDING` | Same preview, status "Pending approval", the PENDING body from the table above, no form |
| 200, `myStatus` `APPROVED` | Same preview, "You're already a member of this team.", link "Go to team page" |
| 403 `banned_from_team` | H1 "You can't join this team." No team preview, no form (see amendment A3) |
| 404 `invite_invalid` (unknown, malformed, regenerated) | H1 "This invite link doesn't work", body "This invite link is no longer valid. Ask a team admin for a new one.", links "Find a team", "My teams" |
| 401 | `/auth/session-expired?returnTo=/teams/join?code=…` (the code survives the round trip) |
| API down | E-PAGE-1 via `error.tsx`, "Try again" reloads the same URL (code kept) |

### Header states (additions to `SiteHeader`)

| State | Header adds |
|---|---|
| Anonymous | "Find a team" |
| Signed in | "Find a team", "My teams" (`aria-current="page"` on `/teams` and, for "Find a team", on `/teams/find`) |
| API unavailable, cookie present | "Find a team" only (My teams would fail anyway) |

Placement and the 360 px wrap are the UI/UX doc's call; the journey needs both links keyboard-reachable in the first tab stops after the brand and 44 px tall (AC-ENTRY-1).

### `returnTo` for team pages

| Source | `returnTo` |
|---|---|
| `proxy.ts` (no cookie) on `/teams`, `/teams/new`, `/teams/join?code=…`, `/teams/[id]/manage` | path plus query, so the invite code is kept (accepted trade-off, AC-VERIFY-3) |
| Team page "Sign in to ask to join" / "Create an account" | `/teams/[teamId]` |
| Header "Sign in" on any team page | current path and query (existing `headerReturnTo`) |
| Registration success | `withWelcome(returnTo)` → e.g. `/teams/join?code=…&notice=welcome`; `FlashNotice` shows the welcome once |
| Session expiry inside a team action | `/teams/[teamId]/manage` or the page the form was on |

---

### Flow J1: Create a team → manage page (AC-ENTRY-3, AC-HAPPY-1/2, AC-ERROR-1/11)

```
[/teams "Create a team"]──▶[/teams/new]──submit──▶ Server Action ──POST /teams──▶ API
                                 ▲                       │
                     422: field errors in place          │ 201 { team, membership }
                     5xx/offline: E-SYS-2, values kept   ▼
                                 └──────────────── redirect(replace)
                                                  /teams/[id]/manage?notice=team_created
```

1. **Form** (`/teams/new`, H1 "Create a team"): "Team name", "Description (optional)", fieldset "Visibility" (Public: "Anyone can find your team on Find a team and ask to join." / Private: "Hidden from search. People ask to join with your invite link."; both hints end "You approve every request."), fieldset "Your skill level" with hint "Your own level. Team admins see it, and some teams price sessions by level." Nothing preselected. Button "Create team", pending "Creating team…" (`aria-disabled`, blocks a second click).
2. **Validation**: shared zod messages, client-side first, API 422 as the backstop. Error summary "There's a problem" at the top, focused, linking to each field; `<title>` prefixed "Error: ". All values kept.
3. **Success**: history-replacing redirect to `/teams/[id]/manage?notice=team_created`. Notice (role `status`, focused): "Team created. You're its first admin." with a second line: private "Share the invite link below so people can ask to join." / public "It's listed on Find a team. You can also share the invite link below." The second line contains an in-page link "invite link" that moves focus to the Invite link section's "Copy link" button.
4. **Back button** from the manage page goes to `/teams` (the form was replaced). Reopening `/teams/new` shows an empty form.

### Flow J2: Visitor finds a public team, signs in, asks to join (AC-ENTRY-1/2, AC-HAPPY-3/4, AC-ERROR-2/4)

```
Header "Find a team" ─▶ /teams/find?q=badminton ─"View team"─▶ /teams/[T] (anonymous)
   ─"Sign in to ask to join"─▶ /login?returnTo=/teams/[T] ─(sign in / sign up / OAuth)─▶ /teams/[T]
   ─pick level, "Request to join"─▶ POST /teams/[T]/join-requests ─201─▶ redirect(replace) /teams/[T]?notice=join_requested
   ─ later ─▶ header "My teams" ─▶ /teams row "Pending approval" … "Member" (after approval)
```

1. **Find** (`/teams/find`, public): GET form "Search teams" + "Search" (so the URL is shareable and Back restores results). Results are cards: name (link "View team" with accessible name "View team {name}"), description truncated at 160 characters, "{n} members", and for signed-in users a status tag "Admin", "Member" or "Pending approval" (amendment A5). An empty query lists all public teams. Pagination: "Next" (keyset `after`), and on later pages "Back to first page" (amendment A6). Result count is announced through a polite live region on the results heading ("Teams matching "badminton"" / "All public teams").
2. **Team page, anonymous**: no form, so a visitor never picks a level only to lose it at sign-in. "Sign in to ask to join" carries `returnTo=/teams/[T]`.
3. **Sign-in round trip**: existing auth flows. A first-time user registers and lands on `/teams/[T]?notice=welcome` ("Welcome! Your account is ready."), now with the join form.
4. **Join form**: one fieldset "Your skill level" (Beginner, Intermediate, Advanced; hints "New or returning to the sport", "Comfortable with rallies and rules", "Competitive or club-level play"; none preselected), button "Request to join", pending "Sending request…". No skill chosen → "Select your skill level to continue." in place, no request.
5. **Success**: `redirect(replace)` to `/teams/[T]?notice=join_requested` (amendment A1). The page now renders the PENDING row: notice "Request sent. A team admin will review it." (focused, role `status`) and status "Pending approval" with the no-email expectation line. A reload shows the same PENDING page without the notice.
6. **Outcome**: there is no notification. The player sees the outcome when they next open My teams or the team page ("Member", "Request declined"). This is the [async gap](#human-async-the-join-request-wait).

### Flow J3: Private invite link with a sign-in round trip (AC-ENTRY-4, AC-HAPPY-5, AC-ERROR-3/5)

```
Chat link /teams/join?code=C ─(no cookie)─proxy─▶ /login?returnTo=%2Fteams%2Fjoin%3Fcode%3DC
   ─ "Sign in or create an account to answer your team invite." (A10) ─▶ sign in / Create one / Continue with Google
   ─▶ /teams/join?code=C ─lookup─▶ preview + form ─"Request to join"─▶ POST /teams/[P]/join-requests {skillLevel, inviteCode}
   ─201─▶ redirect(replace) /teams/[P]?notice=join_requested   (the code leaves the address bar and this history entry)
```

1. **Anonymous open**: `proxy.ts` redirects; `/login` shows the invite context line (A10, COULD; otherwise the existing "Sign in to continue."). "Don't have an account? Create one", the OAuth buttons and `/register/complete` all carry `returnTo`, so a brand-new user lands back on the invite after picking their sex.
2. **Signed-in open**: `no-store`, `no-referrer`. Lookup by POST so the code never reaches an API log.
3. **Join**: same form as J2; the hidden `inviteCode` field travels in the Server Action body. On success the user lands on the private team's page, which they can now see because they have a non-banned row.
4. **The code after joining**: the replace redirect swaps the invite URL out of the current history entry, so Back goes to wherever the user was before the link (usually the chat app). The code remains in the earlier `/login?returnTo=` history entry (accepted trade-off, AC-VERIFY-3).
5. **Same code for a public team**: identical flow; the preview tag reads "Public team".

### Flow J4: Admin reviews requests and moderates (AC-ENTRY-5, AC-HAPPY-6 to 11, AC-ERROR-6 to 9)

```
Header "My teams" ─▶ /teams row "Rosedale Badminton · Admin · 2 join requests waiting" (A4)
   ─▶ /teams/[T]/manage#join-requests
        Approve / Reject ─────────────▶ moderate action ─POST …/approve|reject─▶ in-place result + lists revalidated
        Members: Make admin / Remove admin / Ban ─(Ban: inline confirm + reason)─▶ same
        Banned members (read only)
        Invite link: Copy link / Generate new link ─(inline confirm)─▶ same
```

1. **Arrive**: from My teams. The manage page H1 "Manage {Team name}", then the sections (layout per UI/UX doc). Section headings carry counts: "Join requests (2)", "Members (14)", "Banned members (1)". Join requests are listed **oldest first** (fairness, A9), each "{Full name}, {Skill level}, requested {d MMM yyyy}" with "Approve" and "Reject" buttons whose accessible names include the person ("Approve Mere Tane").
2. **Approve / Reject**: one tap, no confirmation (both are reversible in effect: a rejected player can ask again, an approved member can be banned). Button shows "Approving…" / "Declining…" while pending; other buttons on that row are `aria-disabled`.
3. **Result region**: every moderation action reports in one page-level result region at the top of the manage content (role `status` for success, `alert` for errors, `tabindex="-1"`, focused after each action because the acted-on row usually moves or disappears). Success copy names the person: "Mere Tane is now a member." / "You declined Mere Tane's request." The lists re-render from the server (`revalidatePath`), never optimistically.
4. **Make admin / Remove admin**: one tap on someone else's row. On **your own** row "Remove admin" opens an inline confirmation "Remove your own admin rights? You'll no longer be able to manage this team." ["Remove my admin rights"] ["Cancel"] (A8). If you are the only admin, your own "Remove admin" is `aria-disabled` with the visible note "A team needs at least one admin. Make another member an admin first."
5. **Ban**: "Ban" on a `MEMBER` row expands an inline panel inside the row: text "Ban {Full name}? They lose access to this team and can't register for its sessions.", textarea "Reason (optional, only team admins see this)" (500 max, live count "{n} of 500 characters" announced only on blur), buttons "Ban member" (destructive) and "Cancel". Focus moves to the panel's text; Escape or "Cancel" closes it and returns focus to "Ban". Only one inline confirmation is open at a time. Admin rows show "Ban" `aria-disabled` with "Remove admin rights from {Full name} before banning them."; your own row has no "Ban".
6. **After a ban**: "{Full name} has been banned." The person is now under "Banned members" (name, "Banned {date}", reason or "No reason given"). There is no unban (v1), and the panel copy does not suggest one.
7. **Self-demotion success**: the actor is no longer an admin, so the manage page would 403. The action redirects (replace) to `/teams/[T]?notice=self_demoted`: "You're no longer an admin of this team." The team page shows the "Member" row.

### Flow J5: Admin replaces the invite link; old-link holders (AC-HAPPY-2/12, AC-ERROR-3)

1. **Invite link section** (every team, public or private): read-only input labelled "Invite link" with the full URL `{WEB_BASE_URL}/teams/join?code=…`, hint "Anyone with this link can ask to join. You still approve every request.", "Copy link" (→ "Link copied" in a polite live region for 3 s; when the Clipboard API is unavailable or refused: "Couldn't copy. Select the link and copy it yourself." and the input text is selected), and "Generate new link".
2. **Regenerate**: inline confirmation "Generate a new link? The old link stops working immediately. People who already asked to join keep their place." ["Generate new link"] ["Cancel"]. Result: "New invite link created. The old link no longer works." Focus goes to the result region; the input shows the new URL.
3. **Old-link holder, signed in**: `/teams/join?code=OLD` → "This invite link doesn't work" / "This invite link is no longer valid. Ask a team admin for a new one." Links "Find a team", "My teams".
4. **Old-link holder, signed out**: has to sign in before seeing that the link is dead (the lookup is authenticated). Accepted trade-off: the alternative is an anonymous lookup endpoint, which the spec rules out.
5. **Already pending with the old code**: unaffected; still "Pending approval" on My teams.

### Flow J6: Rejected and banned players (AC-HAPPY-7/8, AC-HAPPY-11, AC-ERROR-5/10)

- **Rejected**: My teams row "Request declined" with link "Ask again" for a public team (→ `/teams/[T]`, the REJECTED row with the form) or the hint "Ask a team admin for the invite link" for a private team (A2). Re-requesting reuses the row and shows "Pending approval" again. No cooldown (spec default; Architecture doc may change it).
- **Banned**: the team vanishes from My teams. No message is sent. If they open the public team page: "You can't join this team." with no form; private team page: "We couldn't find that team."; any invite link for that team: "You can't join this team." The reason is never shown. Their account and other teams are untouched; the header and session stay as they were.

### Flow J7: My teams (status hub)

`/teams` H1 "My teams". Buttons "Create a team" (primary) and "Find a team". One row per non-banned membership, ordered: rows needing the user first (admin rows with waiting requests), then by team name.

| Row status | Label | Row actions |
|---|---|---|
| `APPROVED` admin | Admin | "Manage" (→ `/manage`); when `pendingRequestCount > 0`: link "{n} join request(s) waiting" (→ `/manage#join-requests`) (A4) |
| `APPROVED` member | Member | team name links to `/teams/[T]` |
| `PENDING` | Pending approval | team name links to `/teams/[T]`; small text "Requested {date}" |
| `REJECTED` | Request declined | "Ask again" (public) / hint (private) |

Status is text, never colour alone. Empty state: "You're not in any teams yet." + "Find a team" and "Create a team".

---

## Step-by-Step Journey (primary path: invited player on a phone, new to the app)

#### Step 1: Open the invite link
- **System**: `proxy.ts` (web).
- **User Sees**: `/login?returnTo=%2Fteams%2Fjoin%3Fcode%3D…` with "Sign in or create an account to answer your team invite." and the OAuth buttons.
- **User Actions**: Continue with Google, or "Create one".
- **Feedback**: provider consent screen, then `/register/complete` (pick sex).
- **Transitions**: account created → redirect to `returnTo` with `notice=welcome`.
- **Data Flow**: `returnTo` in the OAuth state row and binding cookie (auth feature).

#### Step 2: See the invite
- **System**: web `/teams/join` page → API `POST /teams/invite/lookup`.
- **User Sees**: "Welcome! Your account is ready.", "You've been invited to join", H1 "Rosedale Badminton", description, "14 members", "Private team", the skill fieldset and "Request to join".
- **User Actions**: choose a level, submit.
- **Feedback**: "Sending request…"; on a missing level, "Select your skill level to continue." beside the field and in the summary.
- **Transitions**: 201 → Step 3; 409/403/404 → the matching state of the invite table.
- **Data Flow**: `{ skillLevel, inviteCode }` in the Server Action body; `team_members` row `PENDING`.

#### Step 3: Request sent
- **System**: web `/teams/[P]` (status-driven page).
- **User Sees**: "Request sent. A team admin will review it." and "Pending approval", "There's no email for this yet, so check My teams to see the outcome." and "Go to My teams".
- **User Actions**: leave; later open "My teams" from the header.
- **Transitions**: an admin approves (J4).

#### Step 4: Success
- **User Sees**: My teams row "Rosedale Badminton · Member".
- **Value Delivered**: the player is an approved member; every `requireTeamRole('MEMBER')` route for the team answers 200, so registration (next feature) will let them in.
- **Next Actions**: today, the team page; with registration-and-waitlist, "Currently Opening".

---

## Async Handling

### Human async: the join request wait

| Phase | Duration | User experience |
|---|---|---|
| Initiation | Immediate | Team page notice "Request sent. A team admin will review it." and status "Pending approval" |
| Waiting | Hours to days (depends on the admin) | Player: "Pending approval" on the team page, on My teams and as a tag on Find results. Admin: "{n} join requests waiting" on My teams and the count on "Join requests (n)" |
| Decision | Instant when the admin taps | Admin: result region. Player: nothing is pushed |
| Retrieval | Whenever the player looks | My teams row "Member" or "Request declined"; team page row of the same status |

### Progress communication
- **Method**: pull only (page loads). No email, no in-app notification, no polling (spec: notifications out of scope, provider TBD).
- **Mitigations inside scope**: expectation copy on the PENDING state; My teams sorted so actionable rows come first; the admin-side waiting count (A4) so requests do not rot because admins have no prompt either.
- **Persistence**: the membership row is the record. No history of past decisions (spec: no audit history beyond `*_at`/`*_by`).
- **Future hook**: when the email provider lands, the natural notifications are "request approved", "request declined" (no reason) and an admin digest of waiting requests. Not designed here.

### Ban side effect (`member-banned` job)

| Phase | Duration | User experience |
|---|---|---|
| Ban commits | Immediate | Admin: "{Full name} has been banned." Banned user: every team route is 403 from the next request |
| Job runs | Within ~30 s while the worker runs | Nobody sees it. Until registration-and-waitlist ships, the handler only logs `team.member.banned.hook_noop` |
| Job fails permanently | After 3 retries | Operator sees the failed `pgboss.job` and the `team.member.banned.hook_failed` log; the ban itself stands |

The admin confirmation says registrations "are cancelled", which is a promise about the near future, not a progress report. The journey deliberately shows no "cancelling…" state: there is nothing the admin could do with it, and the Architecture doc owns the timing.

---

## Distributed System Flow

### System boundaries
```
Browser ──form POST / GET──▶ apps/web (Next.js: pages, Server Actions, proxy.ts)
                                  │  Authorization: Bearer <session>, traceparent, x-sgm-internal-auth
                                  ▼
                             apps/api (Fastify /teams module) ──▶ PostgreSQL 17 (teams, team_members)
                                  │  ban: status change + pg-boss job in ONE transaction
                                  ▼
                             pgboss.job ──▶ apps/api worker ──▶ MemberBannedHandler (no-op until registration-and-waitlist)
```

### Responsibility matrix

| Step | Owner | State storage | Failure handling |
|---|---|---|---|
| Header links, status labels, copy | web | none (rendered per request) | API down → reduced header (existing pattern) |
| Find search | web page → API `GET /teams/find` | URL (`q`, `after`) | page-level error "We can't load teams right now. Try again in a minute." with "Try again" |
| Protected-page gate | `proxy.ts` then `requireUser` | session cookie | no cookie → `/login?returnTo`; dead cookie → `/auth/session-expired`; API down → `error.tsx` |
| Create / join form validation | web (shared zod) then API (strict zod) | form values in `FormState` | in-place field errors; values kept |
| Create / join write | API, one transaction | `teams`, `team_members` | 409/403/404 → page state; 5xx → E-SYS-2 in place |
| Moderation | API, team-row lock, DB triggers as backstop | `team_members` | stale → 409 + list reload; last admin / admin ban → 409 with guidance; 403 → access page |
| Ban side effect | worker | `pgboss.job` | retry with backoff, then `failed` + error log; ban never undone |
| Invite lookup | API `POST /teams/invite/lookup` | `teams.invite_code` | 404 `invite_invalid` page; 403 `banned_from_team` page |

---

## Error Handling

### Where every error lands and how the user recovers

| Code (HTTP) | Raised by | Lands on | User sees | Recovery | Input kept |
|---|---|---|---|---|---|
| `validation_failed` (422) | create, join, ban reason | same form | summary + field messages | fix fields | all |
| `already_requested` (409) | join (double click, second tab) | same page, re-rendered | PENDING row: "You've already asked to join this team. A team admin will review it." | none needed | n/a |
| `already_member` (409) | join | same page, re-rendered | APPROVED row: "You're already a member of this team." | "Go to My teams" | n/a |
| `banned_from_team` (403) | join, invite lookup | same page / invite page | "You can't join this team." | none | n/a |
| `invite_invalid` (404) | lookup, join with stale code | invite page | "This invite link is no longer valid. Ask a team admin for a new one." | Find a team, My teams | n/a |
| `not_found` (404) | team detail, private join without code, foreign `:userId` | 404 page / manage result region | "We couldn't find that team." / "That person isn't in this team's lists any more. The list has been refreshed." | Find a team / reloaded list | n/a |
| `membership_state_conflict` (409) | approve, reject, promote, demote, ban | manage result region, lists reloaded | approve/reject: "Someone else already handled this request. The list has been refreshed." Others: "Another admin already changed {Full name}'s membership. The list has been refreshed." | act on the fresh list | ban reason discarded (the target changed) |
| `last_team_admin` (409) | demote | manage result region | "A team needs at least one admin. Make another member an admin first." | promote someone first | n/a |
| `team_admin_cannot_be_banned` (409) | ban | manage result region (the button is normally `aria-disabled`, so this is the race case) | "Remove admin rights from {Full name} before banning them." | "Remove admin", then ban | reason kept |
| `forbidden` (403) | any admin route (actor was demoted or banned meanwhile, or never admin) | redirect to `/teams/[T]/manage`, which renders the access page | "You don't have access to manage this team." | "My teams" | n/a |
| `unauthenticated` / `session_expired` (401) | any protected call | `/auth/session-expired?returnTo=<page>` → `/login` | "Your session has expired. Sign in again." | sign in, back to the same page | typed text lost (rare; accepted) |
| `cross_origin_request` (403) | origin check | same page | E-SYS-3 | reload | yes |
| browser offline | client | same page | "You seem to be offline. Check your connection and try again." | retry | yes |
| `internal_error`, `service_unavailable`, timeout, unreachable | any action | same page | forms: "Something went wrong on our side. Your details are still here. Try again in a minute." Buttons without input: "Something went wrong on our side. Try again in a minute." (A13) | retry | yes; no optimistic list change |
| page load failure | any team page | `error.tsx` | E-PAGE-1 "Something went wrong on our side. Try again in a minute." | "Try again" (same URL, `code` kept) | n/a |

**Rule for the manage page (A7)**: if the server state is known to have changed under the admin (409 conflict, 404 target, 403), reload the lists or the page; if the outcome is unknown (5xx, timeout, offline), change nothing and keep what was typed. A retry after an unknown outcome is safe: if the first attempt actually committed, the retry gets `membership_state_conflict` and the reloaded list shows the result.

### Partial failure
- **Create succeeded, response lost**: the team exists but the user stays on the form with E-SYS-2. Retrying creates a second team with the same name, and v1 has no delete. Mitigation inside scope: the pending button blocks double submits, and the E-SYS-2 banner on `/teams/new` gets a second line "If you already see your team on My teams, it was created." with a "My teams" link (A13). An idempotency key is listed as a COULD contract addition for the Architecture doc.
- **Join succeeded, response lost**: retry gets `already_requested`, which renders the PENDING state. No harm.
- **Moderation committed, response lost**: retry → conflict → reloaded list shows the committed result.
- **Ban committed, job failed**: ban stands; operator re-runs the job (AC-ERROR-12). The admin is not told (nothing actionable).

### Edge cases (two admins, two tabs, back button)

| Case | What happens |
|---|---|
| Two admins act on the same request | One commits; the other gets the conflict message with a fresh list (AC-ERROR-9) |
| Two admins demote each other at once (the only two) | One commits; the other gets `last_team_admin`. The demoted one's next action → access page |
| Admin demoted by another admin while on the manage page | Their next action gets 403 → redirect → "You don't have access to manage this team." (AC-ERROR-13, new) |
| Admin banned? | Impossible while admin (DB CHECK); they must be demoted first, then the case above applies |
| Member banned while their team page is open | Next page load: the banned states above; no live push |
| Join in two tabs | Second gets `already_requested` → PENDING view |
| Back after "Request to join" | The form page was replaced; Back leaves the team page. Reopening shows PENDING (dynamic page, `no-store` not required, the data is fresh per request) |
| Back after "Create team" | Lands on `/teams`; the form is not in history |
| Refresh after a moderation action (JS on) | Re-renders the lists; no resubmission (Server Action fetch, not a document POST) |
| Invite link opened by someone already approved | "You're already a member of this team." and a link to the team page |
| Invite link opened while the admin regenerates | Lookup succeeded on the old code; join gets 404 `invite_invalid` → invite-invalid page |
| Rejected player on a private team without the link | Team page tells them to ask an admin for the link (A2) |
| `?notice=` pasted by hand on another page | Unknown or out-of-place codes render nothing |

---

## Options Explored

### Option 1: Dedicated pages, status-driven team page, My teams as status hub, in-place moderation results
- **Orchestration**: single screen per task (spec routes). The team page and the invite landing render by membership status. Create and join use post/redirect/get with a notice code. The manage page keeps the admin on one URL and reports each action in a result region while the server re-renders the lists.
- **Flow summary**: J1–J7 above.
- **Wireframe** (invite landing, 360 px):
  ```
  ┌──────────────────────────────────┐
  │ Shared Game Management  [Sign out]
  │ Find a team · My teams           │
  ├──────────────────────────────────┤
  │ (i) Welcome! Your account is     │ ← role=status (FlashNotice)
  │     ready.             [Dismiss] │
  │ You've been invited to join      │
  │ Rosedale Badminton               │ ← h1
  │ Private team · 14 members        │
  │ Wednesday nights, all levels…    │
  │ ┌ Your skill level ────────────┐ │ ← fieldset/legend
  │ │ ( ) Beginner                 │ │
  │ │     New or returning…        │ │
  │ │ ( ) Intermediate             │ │
  │ │ ( ) Advanced                 │ │
  │ └──────────────────────────────┘ │
  │ [       Request to join        ] │
  └──────────────────────────────────┘
  ```
  Manage page, result region and inline ban (desktop):
  ```
  ┌─────────────────────────────────────────────────────┐
  │ Manage Rosedale Badminton                           │
  │ ┌─────────────────────────────────────────────────┐ │
  │ │ ✓ Mere Tane is now a member.                    │ │ ← result region (focused)
  │ └─────────────────────────────────────────────────┘ │
  │ Join requests (1)                                   │
  │  Sam Ioane, Beginner, requested 11 Oct 2026         │
  │                                [Approve] [Reject]   │
  │ Members (15)                                        │
  │  Aroha Ngata · Admin   [Remove admin]  Ban (n/a)    │
  │  Ben Liu · Member      [Make admin]    [Ban]        │
  │  ┌ Ban Ben Liu? They lose access to this team ──┐   │
  │  │ and their upcoming registrations are …       │   │
  │  │ Reason (optional, only team admins see this) │   │
  │  │ [__________________________________________] │   │
  │  │ [Ban member]  [Cancel]                       │   │
  │  └──────────────────────────────────────────────┘   │
  │ Banned members (1) · Invite link                    │
  └─────────────────────────────────────────────────────┘
  ```
- **Pros**: matches the spec's URLs and ACs; every state has a URL or a deterministic page state, so Playwright and UAT can reach each one; the status table is one function (`labels.ts`) shared by the team page, the invite page, Find and My teams; codes-only URLs are kept; the moderation result names the person without new cookies; the conflict rule makes concurrent admins safe and comprehensible.
- **Cons**: the waiting player has to come back to look (no notifications); the moderation result region needs careful focus handling; one page-level action state for many row forms is a little more client code than plain redirects.

### Option 2: Teams hub with tabs and modals
- **Orchestration**: one `/teams` hub with tabs "My teams", "Find", "Create"; joining and moderation in modal dialogs.
- **Wireframe**:
  ```
  ┌───────────────────────────────────┐
  │ [ My teams ] [ Find ] [ Create ]  │
  │  Rosedale  · Pending approval     │
  │  (Request to join → modal)        │
  └───────────────────────────────────┘
  ```
- **Pros**: everything in one place; quick switching on desktop.
- **Cons**: the invite link and `/teams/find` must still be standalone URLs (spec, `returnTo`), so the hub duplicates them; modals on a 360 px phone with the keyboard open are poor; focus traps for every moderation dialog; tabs need the roving-tabindex pattern; anonymous visitors cannot use two of the three tabs. Contradicts the auth journey's "one task per URL" convention.

### Option 3: Guided onboarding wizard ("Join your first team")
- **Orchestration**: after sign-up, a 3-step stepper: find or paste invite → choose level → confirm, ending on a "waiting for approval" screen; admin side unchanged from Option 1.
- **Wireframe**:
  ```
  Step 1 of 3: Find your team   [search…] or [I have an invite link]
  Step 2 of 3: Your skill level ( ) Beginner ( ) Intermediate ( ) Advanced
  Step 3 of 3: Send request     [Back] [Send request]
  ```
- **Pros**: strong first-run guidance; teaches the approval step.
- **Cons**: most players arrive through an invite link that already names the team, so steps 1 and 3 are friction; the wizard state has to survive the sign-in round trip (more than `returnTo` can carry); a second path to the same outcome doubles the tests; the dashboard that would host "first run" does not exist yet.

### Option 4: Join straight from search results
- **Orchestration**: Option 1, but each Find result card has its own "Request to join" with an inline skill picker; the team page becomes optional.
- **Pros**: one fewer page for players who already know the club.
- **Cons**: skill radios repeated on every card (20 fieldsets on a page) is heavy for screen readers and phones; players request without reading the description; anonymous visitors still need the sign-in hop, after which the card state is gone. Kept only as a future idea.

---

## Evaluation Matrix

| Criterion | Option 1 Pages + status hub | Option 2 Hub + modals | Option 3 Wizard | Option 4 Join from results |
|---|---|---|---|---|
| Discoverability | H | H | H (first run only) | H |
| Learnability | H | M | H | M |
| Efficiency | H (invite: 2 taps after sign-in) | M | L (extra steps on the invite path) | H for search, same for invites |
| Error Prevention | H (form only when joinable; status-driven) | M | M | L (blind requests) |
| Error Recovery | H (each error has a page state; conflict rule) | M (modal state lost on reload) | M (wizard state vs sign-in) | M |
| Consistency (spec routes, auth journey) | H | L | M | M |
| Accessibility | H (native forms, no traps, focus rule) | L (focus traps, small screens) | M | L (many fieldsets) |
| Delight | M (no notifications) | M | H on first run | M |

## Decision

**Chosen**: Option 1, dedicated pages with a status-driven team page, My teams as the status hub, post/redirect/get for create and join, and in-place moderation results with server-revalidated lists. Borrowed from Option 3: expectation-setting copy on the pending state and on the create success notice (what happens next). Option 4 is noted for later.

### Rationale
- The dominant path (invite link from a chat, often to a brand-new user) is the shortest possible: sign in once, pick a level, one button. The code survives the round trip through the existing `returnTo` machinery with no new carrier.
- One status table drives four surfaces (team page, invite page, Find tags, My teams), so a player never sees a join form they cannot use and always sees the same words for the same state.
- Without notifications, the only fair design is to make status cheap to check for players and to make waiting requests visible to admins; My teams does both.
- The manage-page rule "reload when the server changed, keep input when the outcome is unknown" gives concurrent admins correct, explainable outcomes without optimistic UI.
- Follows the auth journey's conventions, so it costs no new primitives beyond the result region.

### Trade-offs accepted
- **No push of outcomes**: players learn of approval or rejection only by looking. Mitigated by expectation copy and the admin waiting count; notifications are a later feature.
- **Dead invite link is discovered after sign-in**: the lookup is authenticated; an anonymous lookup would let anyone test codes without an account. Copy tells them to ask an admin.
- **A rejected player of a private team needs the invite link again**: keeps "private teams are joined only by link" true even after rotation (A2).
- **Duplicate team on a lost create response**: rare; copy points at My teams; idempotency is a COULD for the Architecture doc.
- **Ban reason lost when the target changed under the admin**: correct, because the admin must re-decide on fresh data.
- **Typed text lost on session expiry mid-action**: rare (7-day idle); the user returns to the same page after sign-in.

---

## Copy deck

All strings live in `apps/web/src/lib/teams/labels.ts` (status labels, notices, page errors) and the shared zod schemas in `packages/shared/src/api/teams.ts` (field messages, so the API's 422 and the web show the same text). `{Full name}` comes from the API response or the reloaded list, never from the URL. Dates are Pacific/Auckland, `d MMM yyyy` (e.g. "11 Oct 2026").

### Page titles and headings

| Page | `<title>` | H1 | Intro |
|---|---|---|---|
| `/teams/find` | Find a team – Shared Game Management | Find a team | "Public teams you can ask to join. Private teams share an invite link instead." |
| `/teams` | My teams – Shared Game Management | My teams | none |
| `/teams/new` | Create a team – Shared Game Management | Create a team | "You'll be the team's first admin." |
| `/teams/[id]` | {Team name} – Shared Game Management | {Team name} | description |
| `/teams/join` (valid) | Team invite – Shared Game Management | {Team name} (eyebrow "You've been invited to join") | description |
| `/teams/join` (invalid) | Invite link not valid – Shared Game Management | This invite link doesn't work | "This invite link is no longer valid. Ask a team admin for a new one." |
| `/teams/join` (banned) / team page banned | Team – Shared Game Management | You can't join this team. | none |
| `/teams/[id]/manage` | Manage {Team name} – Shared Game Management | Manage {Team name} | none |
| Not found | Team not found – Shared Game Management | We couldn't find that team. | "It may be private, or the link may be wrong." |
| Manage, not an admin | No access – Shared Game Management | You don't have access to manage this team. | "Only the team's admins can manage it." |

On validation errors the `<title>` is prefixed "Error: ".

### Header, buttons, links, labels, hints

| Key | Text |
|---|---|
| Header | Find a team · My teams |
| Find | Search teams (label) · Search · View team (accessible name "View team {name}") · Next · Back to first page · "{n} members" ("1 member") |
| Find headings | All public teams · Teams matching "{q}" |
| Create | Team name · Description (optional) · Visibility (legend) · Public · Private · Your skill level (legend) · Create team · pending "Creating team…" |
| Visibility hints | Public: "Anyone can find your team on Find a team and ask to join. You approve every request." · Private: "Hidden from search. People ask to join with your invite link. You approve every request." |
| Skill (legend "Your skill level") | Beginner "New or returning to the sport" · Intermediate "Comfortable with rallies and rules" · Advanced "Competitive or club-level play". Create-form hint: "Your own level. Team admins see it, and some teams price sessions by level." Join-form hint: "The team admins see this when they review your request." |
| Join | Request to join · pending "Sending request…" · Sign in to ask to join · New here? Create an account |
| Tags | Private team · Public team |
| Status labels | Admin · Member · Pending approval · Request declined |
| My teams | Create a team · Find a team · Manage · "{n} join request waiting" / "{n} join requests waiting" · Ask again · "Requested {date}" · Go to My teams · Go to team page · Manage team |
| Manage sections | Join requests ({n}) · Members ({n}) · Banned members ({n}) · Invite link |
| Manage rows | "{Full name}, {Skill level}, requested {date}" · Approve · Reject · Make admin · Remove admin · Ban · "Banned {date}" · "No reason given" · pending "Approving…", "Declining…", "Updating…", "Banning…", "Generating…" |
| Ban panel | "Ban {Full name}? They lose access to this team and can't register for its sessions." · Reason (optional, only team admins see this) · "{n} of 500 characters" · Ban member · Cancel |
| Ban disabled note | Remove admin rights from {Full name} before banning them. |
| Self-demote panel | "Remove your own admin rights? You'll no longer be able to manage this team." · Remove my admin rights · Cancel |
| Sole-admin note | A team needs at least one admin. Make another member an admin first. |
| Invite link | Invite link (label) · hint "Anyone with this link can ask to join. You still approve every request." · Copy link · Link copied · "Couldn't copy. Select the link and copy it yourself." · Generate new link |
| Regenerate panel | "Generate a new link? The old link stops working immediately. People who already asked to join keep their place." · Generate new link · Cancel |
| Login context (A10) | Sign in or create an account to answer your team invite. |

### Field errors (422 `validation_failed`, also client-side)

| Field | Condition | Message |
|---|---|---|
| name | blank or whitespace | Enter a team name. |
| name | > 100 | Use 100 characters or fewer. |
| description | > 1000 | Use 1000 characters or fewer. |
| visibility | none | Choose who can find your team. |
| skillLevel | none | Select your skill level to continue. |
| reason (ban) | > 500 | Use 500 characters or fewer. |

### Notices (role `status`, polite)

| ID | Code / trigger | Where | Text |
|---|---|---|---|
| N-TEAM-CREATED | `team_created` | manage | Team created. You're its first admin. + private "Share the invite link below so people can ask to join." / public "It's listed on Find a team. You can also share the invite link below." |
| N-JOIN | `join_requested` | team page | Request sent. A team admin will review it. |
| N-PENDING | PENDING state | team page, invite page | Your request is with the team admins. There's no email for this yet, so check My teams to see the outcome. |
| N-SELF-DEMOTED | `self_demoted` | team page | You're no longer an admin of this team. |
| R-APPROVED | approve result | manage | {Full name} is now a member. |
| R-REJECTED | reject result | manage | You declined {Full name}'s request. |
| R-PROMOTED | promote result | manage | {Full name} is now an admin. |
| R-DEMOTED | demote result | manage | {Full name} is no longer an admin. |
| R-BANNED | ban result | manage | {Full name} has been banned. |
| R-REGENERATED | regenerate result | manage | New invite link created. The old link no longer works. |
| N-COPIED | copy | invite link | Link copied |

### Errors (role `alert`)

| ID | Code | Where | Text |
|---|---|---|---|
| E-TEAM-1 | `already_requested` | team / invite page | You've already asked to join this team. A team admin will review it. |
| E-TEAM-2 | `already_member` | team / invite page | You're already a member of this team. |
| E-TEAM-3 | `banned_from_team` | team / invite page | You can't join this team. |
| E-TEAM-4 | `invite_invalid` | invite page | This invite link is no longer valid. Ask a team admin for a new one. |
| E-TEAM-5 | `not_found` (team) | team page | We couldn't find that team. |
| E-TEAM-6 | `membership_state_conflict` (approve/reject) | manage | Someone else already handled this request. The list has been refreshed. |
| E-TEAM-7 | `membership_state_conflict` (promote/demote/ban) | manage | Another admin already changed {Full name}'s membership. The list has been refreshed. |
| E-TEAM-8 | `not_found` (member) | manage | That person isn't in this team's lists any more. The list has been refreshed. |
| E-TEAM-9 | `last_team_admin` | manage | A team needs at least one admin. Make another member an admin first. |
| E-TEAM-10 | `team_admin_cannot_be_banned` | manage | Remove admin rights from {Full name} before banning them. |
| E-TEAM-11 | `forbidden` (manage) | manage page | You don't have access to manage this team. |
| E-TEAM-12 | find load failure | `/teams/find` | We can't load teams right now. Try again in a minute. (button "Try again") |
| E-SYS-2 | 5xx, timeout, unreachable (forms) | same page | Something went wrong on our side. Your details are still here. Try again in a minute. (on `/teams/new` add: "If you already see your team on My teams, it was created." + "My teams") |
| E-SYS-2b | same (buttons without input) | manage | Something went wrong on our side. Try again in a minute. |

### Empty states

| Where | Text |
|---|---|
| My teams | You're not in any teams yet. + Find a team · Create a team |
| Find, no match | No teams match "{q}". Try a different word, or create your own team. ("create your own team" → `/teams/new`) |
| Find, no public teams | No public teams yet. Create the first one. |
| Join requests | No join requests right now. |
| Members (only you) | You're the only member so far. Share your invite link to bring people in. |
| Banned members | No one has been banned. |

---

## Implementation Guidelines

### Frontend requirements
1. **`apps/web/src/lib/teams/labels.ts`**: `statusView(team, myStatus, role, signedIn)` → `{ label, bodyKey, action }` (the status-driven table, unit-tested once and used by the team page, the invite page, Find tags and My teams); notice and result copy; page error copy.
2. **`apps/web/src/lib/teams/actions.ts`**: `createTeamAction` and `joinTeamAction` follow the auth `FormState` pattern (in-place errors, `redirect(..., replace)` on success with `notice`); `joinTeamAction` maps 409/403/404 to a re-render of the matching status (re-fetch, then return a state the page renders). `moderateAction(previous, formData)` with hidden `op` (`approve|reject|promote|demote|ban|regenerate`) and `userId`: success → `revalidatePath` + `{ result: { code, name } }`; conflict/not_found → `revalidatePath` + `{ error }`; 403 → `redirect` to the manage URL; 401 → `sessionExpiredUrl`; 5xx/offline → `{ error, values }` with no revalidation. Self-demote success → `redirect('/teams/[id]?notice=self_demoted', replace)`.
3. **Manage page client shell**: one `useActionState(moderateAction)` provided through context to every row form and the invite panel; the result region focuses on each new result; only one inline confirmation open at a time; Escape closes it and returns focus.
4. **Proxy**: add `/teams` (exact), `/teams/new`, `/teams/join` and `/teams/*/manage` to the sign-in redirect; `no-store` on all of them; `no-referrer` on `/teams/join`.
5. **Header**: "Find a team" for every state; "My teams" for signed in.
6. **Notice stripping**: extend the stripping effect to team pages (`notice` only; never `q`, `after`, `code`).
7. **`/login` context line** (A10, COULD): when `returnTo` starts with `/teams/join`, show the invite variant instead of "Sign in to continue."
8. **`error.tsx`** for `/teams`, `/teams/new`, `/teams/join`, `/teams/[id]`, `/teams/[id]/manage` (copy the `/account` one).

### Backend requirements (journey-driven; the Architecture doc decides the shapes)
1. `GET /teams/mine`: rows include `pendingRequestCount` when `role = 'TEAM_ADMIN'` (A4, SHOULD).
2. `GET /teams/:teamId`: include `myStatus` and `myRole` for the caller (needed by the status table), including `BANNED` for a public team.
3. `POST /teams/invite/lookup`: a `BANNED` caller gets 403 `banned_from_team` with no team preview (A3).
4. Moderation responses include the target's `fullName` (for the result copy).
5. `GET /teams/:teamId/members`: order `PENDING` by `requested_at, user_id` ascending; `APPROVED` by role (admins first) then `lower(full_name), user_id`; `BANNED` by `banned_at` descending (A9). Counts per status for the section headings (either a count field or a small `counts` call).
6. COULD: idempotency for `POST /teams` (see Partial failure).

### Integration points

| System | Interface | Data exchanged |
|---|---|---|
| auth (web) | `requireUser`, `safeReturnTo`, `loginUrl`, `sessionExpiredUrl`, `withWelcome`, `FormState`, `withOfflineFallback`, `SiteHeader` | session, `returnTo`, welcome notice |
| teams API | `apiClient` team methods (shared zod contracts) | team, membership, members, invite code |
| worker | `member-banned` job | `{ teamId, userId, membershipId, bannedBy, bannedAt }` (not visible to users) |
| registration-and-waitlist (later) | `assertApprovedMember`, `MemberBannedHandler` | membership gate; cancellation on ban |
| team-banking-and-gst, skill-levels-and-auto-enroll, session-scheduling-engine (later) | new sections on the manage area | per their specs |

---

## Acceptance Criteria (MANDATORY)

The spec's ACs stand. Below: the template's mandatory criteria mapped to the spec IDs with the journey's refinements, then the new criteria this journey adds. The template's AC-NAV is expressed as AC-ENTRY-7 to follow the project's canonical prefixes (as in the auth journey's consolidation).

### AC-ENTRY-1: User can find the feature (spec, unchanged)
**Priority**: MUST

**Given** any visitor on `/`, and separately a signed-in user
**When** they look at the header
**Then** both see a keyboard-focusable "Find a team" link to `/teams/find`; only the signed-in user also sees "My teams" to `/teams`; on 360 px the links wrap without horizontal scroll with 44 px targets

**Verification**:
- [ ] E2E: both links exist and navigate
- [ ] E2E: "My teams" absent when signed out
- [ ] E2E: 360 px project, no horizontal scroll

### AC-HAPPY-1: User completes the primary journey (spec AC-HAPPY-4/5, amended by A1)
**Priority**: MUST

**Given** a signed-in user with no row on team T (public) and on team P (private, current code C)
**When** user performs these EXACT steps:
  1. Opens `/teams/[T]`, chooses "Advanced", clicks "Request to join"
  2. Opens `/teams/join?code=C`, chooses "Beginner", clicks "Request to join"
**Then**:
  - User sees: after each, a history-replacing redirect to `/teams/[T]` (resp. `/teams/[P]`) with "Request sent. A team admin will review it.", the status "Pending approval" and "There's no email for this yet, so check My teams to see the outcome."; the address bar no longer contains `code`
  - Data is: one `team_members` row per team, `status='PENDING'`, `role='MEMBER'`, the chosen `skill_level`
  - User can: open My teams and see both rows as "Pending approval"

**Verification**:
- [ ] E2E: both flows end on the team page with the notice and the status
- [ ] E2E: `page.url()` has no `code` after the private join
- [ ] Integration: rows persisted as stated

### AC-ERROR-1: User recovers from validation error (spec AC-ERROR-1/2, unchanged)
**Priority**: MUST

**Given** a user on `/teams/new` or a join form
**When** they submit without a name, visibility or skill level
**Then**:
  - User sees: the error summary "There's a problem" focused, each message beside its field, `<title>` prefixed "Error: "
  - User can: fix and resubmit
  - Progress is: preserved (all typed values and chosen radios)

**Verification**:
- [ ] E2E: messages shown, focus on summary
- [ ] E2E: values kept, resubmit succeeds

### AC-ERROR-2: User recovers from system error (spec AC-ERROR-11, amended by A13)
**Priority**: MUST

**Given** a user on `/teams/new`, a join form, or the manage page with the ban panel open and a reason typed
**When** the API is unreachable, times out or answers 5xx
**Then**:
  - User sees: forms and the ban panel: "Something went wrong on our side. Your details are still here. Try again in a minute."; plain buttons (Approve, Reject, Make admin, Remove admin): "Something went wrong on our side. Try again in a minute."; on `/teams/new` the extra line "If you already see your team on My teams, it was created." with a link
  - User can: retry; a retry of an action that had in fact committed gets the conflict message and a refreshed list
  - Data is: unchanged in the UI (no optimistic list change), typed values and the reason kept, not signed out

**Verification**:
- [ ] E2E: mocked 503 on create, join and ban
- [ ] E2E: retry after a committed-but-lost approve shows E-TEAM-6 and the fresh list

### AC-ASYNC-1: User knows when the async step completes (journey: join decision; spec AC-ASYNC-1 covers the ban job)
**Priority**: MUST

**Given** a user with a `PENDING` request for team T
**When** an admin approves (or rejects) it
**Then**:
  - User notified via: no push (out of scope); the next load of `/teams` shows "Member" (or "Request declined" with "Ask again" for a public team / the invite-link hint for a private team), and `/teams/[T]` shows the same status
  - User finds results at: My teams (header "My teams")
  - User can: open the team page; ask again after a rejection

**Verification**:
- [ ] E2E: approve as admin in context A, reload `/teams` in context B → "Member"
- [ ] E2E: reject → "Request declined" and "Ask again" (public)

### AC-ENTRY-7: Back and refresh never resubmit or show stale forms (new; template AC-NAV-1)
**Priority**: SHOULD

**Given** a user who just created a team, sent a join request, or performed a moderation action
**When** they press Back or reload
**Then**:
  - Progress is: preserved; create and join pages are not in history (replace redirects); reload re-renders the current state with no notice and no resubmission
  - User sees: after Back from the manage page, `/teams`; reopening the team page shows "Pending approval", not the form

**Verification**:
- [ ] E2E: Back after create lands on `/teams`
- [ ] E2E: reload after join shows the PENDING state without "Request sent."

### AC-INTEGRATION-1: Backend produces real output (spec AC-INTEGRATION-1/2, unchanged)
**Priority**: MUST

As written in the spec (real rows, real queue, real race; guards change on the next request). The journey adds the anti-stub check that the manage page lists show the actual requester's name and chosen skill (two different requesters with different levels appear with their own values).

**Anti-stub verification**:
- [ ] Two requests with different names and levels appear as submitted
- [ ] The result region names the person acted on, not a placeholder

### Additional acceptance criteria (new, from this journey)

#### AC-ENTRY-6: Admins see waiting requests on My teams (A4)
**Priority**: SHOULD
**Given** an approved admin of team T with 2 `PENDING` requests, who is also a member of team U
**When** they open `/teams`
**Then** T's row reads "Admin" with "Manage" and a link "2 join requests waiting" to `/teams/[T]/manage#join-requests`; T is listed before U; U's row has neither; with 1 request the text is "1 join request waiting"; with 0 the link is absent

#### AC-ENTRY-8: The invite context survives sign-up, with a clear reason to sign in (A10)
**Priority**: COULD
**Given** an anonymous visitor redirected from `/teams/join?code=C`
**When** `/login` renders
**Then** it shows "Sign in or create an account to answer your team invite." and the "Create one" link and OAuth buttons carry the same `returnTo`; after registering the user lands on `/teams/join?code=C` with "Welcome! Your account is ready."

#### AC-HAPPY-13: The team page always shows the caller's status and only a usable action (status table; A2, A16)
**Priority**: MUST
**Given** a public team T and a private team P, and callers in each state of the status table (anonymous, no row, `PENDING`, `APPROVED` member, `APPROVED` admin, `REJECTED`, `BANNED`)
**When** each opens `/teams/[T]` and `/teams/[P]`
**Then** each sees exactly the label, body and action of the table: anonymous on T sees "Sign in to ask to join" (no form); `REJECTED` on T sees the form; `REJECTED` on P sees the invite-link hint and no form; `BANNED` on T sees "You can't join this team." and no form; no-row and `BANNED` on P get 404 "We couldn't find that team."

#### AC-HAPPY-14: Self-demotion is confirmed and lands on the team page (A8)
**Priority**: SHOULD
**Given** a team with two admins A and B, A on the manage page
**When** A clicks "Remove admin" on their own row
**Then** an inline confirmation appears ("Remove your own admin rights? You'll no longer be able to manage this team."); "Cancel" returns focus to the button with nothing changed; "Remove my admin rights" demotes A and redirects (replace) to `/teams/[T]` with "You're no longer an admin of this team." and the "Member" status; when A is the only admin, the button is `aria-disabled` with "A team needs at least one admin. Make another member an admin first."

#### AC-HAPPY-15: Empty states guide the next step
**Priority**: SHOULD
**Given** a user with no memberships, a search with no match, and a new team with no requests, one member and no bans
**When** they open My teams, search, and open the manage page
**Then** they see the empty-state copy of the copy deck with its links ("Find a team", "Create a team", "create your own team", the invite-link prompt)

#### AC-ERROR-13: An admin who lost admin rights meanwhile is told plainly (A7)
**Priority**: MUST
**Given** admins A and B on the manage page of team T, and B removes A's admin rights
**When** A clicks any moderation button
**Then** the action gets 403 and A is redirected to `/teams/[T]/manage`, which shows "You don't have access to manage this team." with a "My teams" link; no lists render; nothing changed

#### AC-ERROR-14: Moderation outcomes follow the reload-or-keep rule (A7)
**Priority**: MUST
**Given** an admin on the manage page
**When** an action returns `membership_state_conflict` or member `not_found`, and separately a 5xx
**Then** on 409/404 the result region shows E-TEAM-6/7/8 and every list is re-rendered from the server (the stale row shows its current state or is gone; any open ban panel closes); on 5xx nothing in the lists changes, the ban panel stays open with the typed reason, and E-SYS-2 is shown

#### AC-VERIFY-9: Focus and announcements across the team journeys
**Priority**: MUST
**Given** keyboard and screen-reader users (Playwright focus assertions plus axe)
**When** they create, join, and use every manage action
**Then** after a redirect with a notice, focus is on the notice; after a validation error, focus is on the error summary; after each manage action, focus moves to the result region (which has `tabindex="-1"` and the right role); opening an inline confirmation moves focus to its text and Escape/Cancel returns it to the opening button; "Link copied" is announced politely; row buttons have accessible names that include the person ("Approve Mere Tane"); status labels are text, never colour only

---

## Spec amendments

Proposed for the planner to fold into `memory-bank/tasks/team-management.md` (not edited here).

| # | Amends | Change |
|---|---|---|
| A1 | AC-HAPPY-4, AC-HAPPY-5, Success Criteria | A successful join from the team page **or** the invite page redirects (replace) to `/teams/[teamId]?notice=join_requested`, which shows "Request sent. A team admin will review it." and "Pending approval". The invite code leaves the address bar and the current history entry. |
| A2 | Invocation "Visibility"/team page line, AC-HAPPY-8 | The join form appears on `/teams/[teamId]` only for **public** teams (no row or `REJECTED`). Private teams are joined, and re-requested after rejection, only through `/teams/join?code=`. A `REJECTED` caller on a private team page sees "Request declined" and "To ask again, open the team's invite link. If you don't have it, ask a team admin." (Clarifies "a PRIVATE team only to its members", which otherwise reads as offering a join form to people who are already in.) |
| A3 | AC-ERROR-5, invite lookup contract | For a `BANNED` caller, `POST /teams/invite/lookup` returns 403 `banned_from_team` with no team preview, and the page shows only "You can't join this team." Invite page states for `PENDING` (status, no form) and `APPROVED` ("You're already a member of this team." + "Go to team page") are specified. (Depends on the Architecture doc.) |
| A4 | `GET /teams/mine` contract, AC-ENTRY-5 | Admin rows carry `pendingRequestCount`; My teams shows "{n} join request(s) waiting" linking to `/manage#join-requests`, and sorts rows needing action first, then by name. New AC-ENTRY-6 (SHOULD). |
| A5 | AC-ENTRY-2 | Find tags for signed-in users: "Admin", "Member", "Pending approval". No tag for `REJECTED` or `BANNED` (the team page explains). |
| A6 | Invocation "Element" (pagination) | Replace "Previous" with "Back to first page" (the API cursor is forward-only); Back in the browser also works because each page is a URL. Alternative if the Architecture doc adds a backward cursor: keep "Previous". |
| A7 | AC-ERROR-9, AC-ERROR-11 | Manage-page rule: 409/404 → result message plus server re-render of every list (open panels close); 403 → the access page; 401 → session-expired round trip back to the manage page; 5xx/timeout/offline → no list change, typed reason kept. New AC-ERROR-13 (MUST) and AC-ERROR-14 (MUST). Conflict copy gains a member-action variant: "Another admin already changed {Full name}'s membership. The list has been refreshed." |
| A8 | AC-HAPPY-10, AC-ERROR-7 | Your own row: no "Ban"; "Remove admin" opens an inline confirmation and on success redirects (replace) to `/teams/[T]?notice=self_demoted` ("You're no longer an admin of this team."). The sole admin's own "Remove admin" is `aria-disabled` with the last-admin text. New AC-HAPPY-14 (SHOULD). |
| A9 | AC-HAPPY-6, members contract | List order: join requests oldest first; members admins first then by name; banned most recent first. Section headings show counts. Moderation responses include the target's `fullName`. |
| A10 | (auth web, `/login` only) | COULD: invite context line on `/login` when `returnTo` starts with `/teams/join`: "Sign in or create an account to answer your team invite." New AC-ENTRY-8 (COULD). No API auth change. |
| A11 | AC-HAPPY-4 | The PENDING state always shows "Your request is with the team admins. There's no email for this yet, so check My teams to see the outcome." |
| A12 | New ACs | AC-ENTRY-7 (SHOULD, Back/refresh), AC-HAPPY-13 (MUST, status table), AC-HAPPY-15 (SHOULD, empty states), AC-VERIFY-9 (MUST, focus and announcements). |
| A13 | AC-ERROR-11 copy | Forms and the ban panel keep "Something went wrong on our side. Your details are still here. Try again in a minute."; buttons without input use "Something went wrong on our side. Try again in a minute."; `/teams/new` adds "If you already see your team on My teams, it was created." with a link. COULD for the Architecture doc: idempotent `POST /teams`. |
| A14 | AC-HAPPY-1/2 | The `team_created` notice has a second line (public/private variants) with an in-page link to the Invite link section's "Copy link". |
| A15 | AC-HAPPY-11, AC-HAPPY-12 | Ban panel: one open at a time, Escape cancels, focus rules (AC-VERIFY-9), reason counter. Regenerate confirmation adds "People who already asked to join keep their place."; "Copy link" success and failure copy. |
| A16 | `/teams/[teamId]` for anonymous visitors | No join form for anonymous visitors on a public team; instead "Sign in to ask to join" and "New here? Create an account", both with `returnTo=/teams/[teamId]`. |
| A17 | GET `/teams/:teamId` contract | Returns `myStatus` and `myRole` for the caller (including `BANNED` on a public team), which the status table needs. |

## Dependencies on the parallel creative docs

| Topic | Owner | What this journey assumes | If they decide otherwise |
|---|---|---|---|
| Manage area: one page vs sub-routes | UI/UX | One page with four sections and anchors (`#join-requests`, `#members`, `#banned`, `#invite-link`) | Sub-routes: the "{n} join requests waiting" link targets `/manage/requests`; the result region lives in each sub-route; self-demote and 403 landings unchanged |
| Header nav placement | UI/UX | "Find a team" and "My teams" next to the existing items | Any placement that keeps them reachable and 44 px works |
| Skill capture (labels, hints) | UI/UX | Three radios, none preselected, short hints | Hints may change; "none preselected" and the error text are spec |
| Inline confirmation visual pattern | UI/UX | In-row panel, one at a time | Must stay inline (no `window.confirm`), focus rules unchanged |
| Re-request cooldown | Architecture | None | A cooldown adds a REJECTED variant "You can ask again on {date}." and hides the form until then |
| Unban / BANNED terminal | Architecture | Terminal | An unban would add a button to "Banned members" and a result message |
| Lookup for banned callers | Architecture | 403, no preview (A3) | If lookup returns 200 with `myStatus: BANNED`, the page still shows only "You can't join this team." |
| Search semantics, cursor | Architecture | Substring, name order, forward cursor (A6) | Different ranking only changes ordering text; a backward cursor restores "Previous" |
| Ban seam timing | Architecture | Async job; access revoked at commit | A synchronous hook changes nothing visible to users |
| `pendingRequestCount`, `fullName` in responses, list order | Architecture (contracts) | Present (A4, A9) | Without the count, My teams shows only "Manage"; without `fullName`, result copy falls back to name-free text |

---

## Test Scenarios (derived from acceptance criteria)

### Happy path tests
1. AC-ENTRY-1: header links per state, desktop and 360 px.
2. AC-HAPPY-1 (spec AC-HAPPY-4/5 + A1): public and private joins land on the team page, no `code` in the URL.
3. Spec AC-HAPPY-1/2 + A14: create public and private teams; the notice variant; the in-page link focuses "Copy link".
4. AC-ASYNC-1: approval and rejection visible on My teams on next load (two browser contexts).
5. AC-ENTRY-6: waiting count and ordering on My teams.
6. Spec AC-HAPPY-6 to 12: every manage action with its result copy and focus.
7. AC-HAPPY-13: table-driven status view (unit, `labels.test.ts`) plus E2E for anonymous, PENDING, REJECTED-public, REJECTED-private, BANNED.
8. AC-INTEGRATION-3 (spec): the full A-creates / B-joins / A-approves-promotes-demotes-bans / B-reopens journey.

### Error scenario tests
1. AC-ERROR-1: validation on create and join.
2. AC-ERROR-2: mocked 503 on create, join, ban (reason kept), approve.
3. AC-ERROR-13: admin demoted by another admin, then acts → access page.
4. AC-ERROR-14: stale approve in two contexts → E-TEAM-6 and fresh list; stale ban → E-TEAM-7 and panel closed.
5. Spec AC-ERROR-3/5/10: invalid and regenerated codes, banned user on invite and team page, private 404.

### Edge case tests
1. AC-ENTRY-7: Back and reload after create, join and a manage action.
2. AC-HAPPY-14: self-demote confirmation, cancel, sole-admin disabled state.
3. AC-ENTRY-4/8: anonymous invite → register → back on the invite with the welcome notice.
4. AC-HAPPY-15: empty states.
5. Copy link with the Clipboard API denied → fallback message and selected text.

## Accessibility Checklist

- [ ] Keyboard path through create, join and every manage action, including the inline panels (Escape closes)
- [ ] Notices and results announced (`status` / `alert`) and focused as AC-VERIFY-9 states
- [ ] Focus never lost when a row moves to another section (focus goes to the result region)
- [ ] Error summary links to fields; field errors tied with `aria-describedby`
- [ ] Radio groups are `fieldset`/`legend`; none preselected; hints tied to each radio
- [ ] Disabled-with-reason buttons use `aria-disabled` plus visible text (never the `disabled` attribute, which removes them from the tab order)
- [ ] Row buttons' accessible names include the person
- [ ] Status labels are text; colour is decoration only
- [ ] 44 px targets; no horizontal scroll at 360 px; long team names and descriptions wrap
- [ ] No time limits ("Link copied" disappears but is announced once)

## Analytics & Observability

No product analytics exists; the funnel is read from the API's `team.*` events (spec AC-VERIFY-5) and the rows' timestamps.

### Key metrics

| Metric | Source | Purpose | Target |
|---|---|---|---|
| Invite open → join request | web `web.teams.invite_viewed` (no code) vs `team.join.requested` | Invite friction (incl. sign-in drop-off) | > 70 % |
| Join request → decision time | `team_members.requested_at` → `approved_at` / REJECTED update | Is the no-notification gap hurting? | median < 48 h (watch, not a gate) |
| Pending backlog age | count of `PENDING` older than 7 days | Rotting requests | trending down |
| Create → first invite copy | `web.teams.invite_copied` after `team.created` | Does the create notice lead to sharing? | > 50 % |
| Moderation conflict rate | `team.action.refused` with `reason=membership_state_conflict` | Concurrent-admin friction | < 2 % of actions |
| Join errors by code | `team.action.refused` reasons | Quality | `invite_invalid` spikes after regenerations are expected |

### Instrumentation points (web additions, no PII, no codes)
- `web.teams.invite_viewed` with `teamId` and `myStatus` (after a successful lookup).
- `web.teams.invite_copied` with `teamId` (client event posted to a log endpoint only if one exists; otherwise skip, it is a COULD).
- `web.teams.api_failure` with `action` and `status` (mirrors `web.auth.api_failure`).

## Validation Checklist

- [x] Journey delivers stated value (create → share; find or invite → request → status; admin → decide)
- [x] All personas can complete their journey (player, admin, creator; banned member gets a clear end state)
- [x] Errors are recoverable (each has a landing and a next step; unknown outcomes are retry-safe)
- [x] Async states are clear (pending expectation copy; ban job invisible by design)
- [x] Consistent with existing patterns (auth journey conventions)
- [x] Accessible per requirements (AC-VERIFY-7, new AC-VERIFY-9)
- [x] Testable with defined scenarios

## Next Steps

1. Planner folds the [Spec amendments](#spec-amendments) and new ACs into the task file after reconciling with the Architecture and UI/UX docs (dependency table above).
2. Phase 2/3 (API): add `myStatus`/`myRole` on detail, `pendingRequestCount` on mine, `fullName` on moderation responses, list ordering and counts, banned-lookup 403.
3. Phase 4 (web): `labels.ts` status table first (unit-tested), then the team page, invite page, Find, My teams and Create with the copy deck; proxy and header.
4. Phase 5 (manage area): the action-state shell, result region and focus rules, inline panels, self-demote redirect; Playwright journeys J1–J7 on desktop and 360 px; `/yay:uat` walks J2, J3 and J4 as Player and Team Admin.
