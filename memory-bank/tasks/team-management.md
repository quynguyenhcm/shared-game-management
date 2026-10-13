---
slug: team-management
legacy_id:
feature: team-management
status: BUILD_COMPLETE
---

# team-management: Team Management

**Complexity**: Level 3 (inherited from team-management)
**Status**: BUILD_COMPLETE
**Roadmap**: team-management
**Branch**: feature/team-management
**Worktree**: N/A (main checkout)

## Task Description

Team creation, discovery, membership and moderation (PRODDUCT-OVERVIEW §2).

- Any user can create a team (name, description, `PUBLIC`/`PRIVATE`); creator becomes `TEAM_ADMIN`
- "Find a Team" search page `/teams/find` (public teams only)
- Private teams via invite link `/teams/join?code=XYZ` (unique token, regenerable)
- Join request requires a self-assessed skill level → `PENDING`; admin approve/reject
- Promote/demote team admins
- Ban member (`BANNED`): revokes access, blocks future registrations, cancels active registrations and triggers waitlist promotion (hook into registration-and-waitlist). A team admin can't be banned until they are demoted.

**Depends on**: auth-and-user-roles

## Specification

**Feature Type**: End-User Feature
**Primary Persona**: Player (`PLAYER`) who creates a team or asks to join one, and Team Admin (`TEAM_ADMIN`, per team) who reviews join requests, manages admins and bans members. Secondary: the later features (registration-and-waitlist, skill-levels-and-auto-enroll, team-banking-and-gst, session-scheduling-engine) that consume the membership state, the `TEAM_ADMIN` guard and the ban seam this feature delivers.
**Creative Exploration Needed**: Yes (see the Creative Exploration Needed section below). The ban side-effect seam and the team-admin area layout are LOW confidence; the rest is concrete.

*Note: this feature also delivers cross-cutting infrastructure (the membership state machine, the ban event seam and the approved-member gate that registration-and-waitlist must call). Those structural checks are written as `AC-VERIFY`, `AC-ASYNC` and `AC-INTEGRATION` criteria inside this End-User spec.*

*Basis for this draft* (read from `main`, which already contains platform-foundation and auth-and-user-roles):
- `teams` and `team_members` already exist (`db/migrations/20260929000300000_teams.sql`, `20260929000400000_team_members.sql`). `teams`: `name varchar(255) NOT NULL`, `description text`, `visibility team_visibility NOT NULL DEFAULT 'PUBLIC'`, `invite_code varchar(100) UNIQUE NOT NULL`, `created_by uuid REFERENCES users`, banking and GST columns (owned by team-banking-and-gst, not touched here). `team_members`: `role team_role DEFAULT 'MEMBER'`, `status membership_status DEFAULT 'PENDING'`, `skill_level skill_tier NOT NULL DEFAULT 'BEGINNER'`, `requested_at`, `approved_at`, `approved_by`, `banned_at`, `banned_by`, `ban_reason`, `UNIQUE(team_id, user_id)`; indexes `idx_teams_visibility` and `idx_team_members_user_team (user_id, team_id, status)`. Enums `team_visibility`, `team_role`, `membership_status`, `skill_tier` are mirrored in `packages/shared/src/types/enums.ts`. **No team table work is needed, but several invariants are missing and must be added by a new reversible migration** (listed in AC-VERIFY-2).
- Hazards found in the existing schema: `skill_level` silently defaults to `BEGINNER` (the API must never rely on it; the skill choice is explicit); nothing stops `role = 'TEAM_ADMIN'` on a `PENDING`/`REJECTED`/`BANNED` row, nothing stops a team from losing its last admin, and nothing guards the status transitions or stamps the approval and ban columns.
- The registration tables **already exist** as schema (`registrations`, `registration_guests`, `game_sessions`; ledger D-10 to D-14, including the waitlist locking contract: every enqueue/withdraw/promote first runs `SELECT ... FROM game_sessions WHERE id = $1 FOR UPDATE`) but no registration or waitlist **code** exists. Cancelling a banned member's registrations and promoting the waitlist is registration-and-waitlist's business logic (fees, FIFO, guests, notifications). This feature therefore exposes a seam and does not write to `registrations`.
- Auth platform already in place and reused as is (`docs/adr/0013`): `requireTeamRole('TEAM_ADMIN' | 'MEMBER', { teamIdParam, allowGlobalAdmin })` reads `team_members` with `status = 'APPROVED'` fresh on every request (`apps/api/src/lib/auth/guards.ts`), default-deny route policy, `request.auth.userId`, `AppError` + the shared `ErrorCode` list (a closed list in `packages/shared/src/api/errors.ts`, so new codes must be added there and in `ERROR_DEFAULTS`), `safeReturnTo` (accepts `/teams/join?code=...`), `SiteHeader`, `proxy.ts` protected-path redirect, `requireUser()` in web pages, `AuthCard` and the Tailwind class strings in `apps/web/src/components/auth/styles.ts`, `buildAuthTestApp` and `insertTeam`/`insertTeamMember` test factories.
- Logger redaction (`apps/api/src/lib/logger/logger.ts`) masks a query parameter named `code` but has **no key pattern for `inviteCode` / `invite_code`**; one must be added.
- The web has no team pages yet; `apps/web/src/app/page.tsx` is still the platform-foundation placeholder (player dashboard arrives later), so team entry points live in the `SiteHeader` and on new `/teams*` pages.

### Invocation Method
- **Location**: Web app (Next.js App Router, `apps/web/src/app/teams/`). New pages:
  - `/teams/find` public "Find a team" search (anonymous allowed; signed-in users also see their own status per team).
  - `/teams` "My teams" (protected): the caller's teams and their status, plus the "Create a team" button.
  - `/teams/new` "Create a team" form (protected).
  - `/teams/[teamId]` team page: name, description, member count, and the join form when the caller may ask to join (a `PUBLIC` team for anyone; a `PRIVATE` team only to its members).
  - `/teams/join?code=XYZ` invite landing (protected; `Cache-Control: no-store`, `Referrer-Policy: no-referrer`): shows the team behind the code with the same join form.
  - `/teams/[teamId]/manage` team-admin area (protected, `TEAM_ADMIN` only): sections "Join requests", "Members", "Banned members", "Invite link". Layout is LOW confidence (see Creative Exploration Needed).
  - API (Fastify module `apps/api/src/modules/teams/{routes,service,repo}.ts`, registered in `buildApp`; every route declares a policy, see AC-VERIFY-1):
    - `POST /teams` (authenticated) body `{ name, description?, visibility, skillLevel }` -> 201 `{ team, membership }`
    - `GET /teams/find?q=&after=` (optionalSession) -> `{ teams: [{ id, name, description, memberCount, myStatus }], nextCursor }`, `PUBLIC` teams only
    - `GET /teams/mine` (authenticated) -> `{ teams: [{ id, name, visibility, role, status }] }` (rows with status `BANNED` are omitted)
    - `GET /teams/:teamId` (optionalSession) -> team detail for a `PUBLIC` team, or for a `PRIVATE` team only when the caller has a non-banned membership row; otherwise 404 `not_found`
    - `POST /teams/invite/lookup` (authenticated) body `{ code }` -> `{ team: { id, name, description, visibility, memberCount }, myStatus }`; unknown or regenerated code -> 404 `invite_invalid` (POST so the code never appears in a URL the API logs)
    - `POST /teams/:teamId/join-requests` (authenticated) body `{ skillLevel, inviteCode? }` -> 201 `{ membership: { status: 'PENDING', skillLevel } }`; `inviteCode` is required for a `PRIVATE` team
    - `GET /teams/:teamId/members?status=PENDING|APPROVED|BANNED&after=` (`requireTeamRole('TEAM_ADMIN')`) -> `{ members: [{ userId, fullName, role, status, skillLevel, requestedAt, approvedAt, bannedAt, banReason }], nextCursor }` (no email)
    - `POST /teams/:teamId/members/:userId/approve`, `/reject`, `/promote`, `/demote`, `/ban` (body `{ reason? }` on ban) (`requireTeamRole('TEAM_ADMIN')`) -> 200 `{ member }`
    - `GET /teams/:teamId/invite-code` and `POST /teams/:teamId/invite-code/regenerate` (`requireTeamRole('TEAM_ADMIN')`) -> `{ inviteCode }`
- **Element**: `SiteHeader` (`apps/web/src/components/site-header-links.tsx`) gains a "Find a team" link for everyone and a "My teams" link for signed-in users. Page controls and labels: Find page field "Search teams" and button "Search", result link "View team", pagination links "Previous" and "Next"; create form fields "Team name", "Description (optional)", a `fieldset` legend "Visibility" with radios "Public" and "Private" (none preselected), a `fieldset` legend "Your skill level" with radios "Beginner", "Intermediate", "Advanced" (none preselected), button "Create team"; join form `fieldset` legend "Your skill level" (same radios, none preselected) and button "Request to join"; My teams buttons "Create a team", "Find a team", per-row link "Manage" (admins only); manage area buttons "Approve", "Reject", "Make admin", "Remove admin", "Ban", "Ban member", "Cancel", "Copy link", "Generate new link". Status labels on My teams: "Admin", "Member", "Pending approval", "Request declined".
- **Visibility**: "Find a team" always visible. "My teams" only when signed in. "Manage" only on rows where the caller is an approved `TEAM_ADMIN` (the API is the real check). "Request to join" only when the caller has no membership row, or a `REJECTED` one.
- **Navigation**: `/` -> header "Find a team" -> `/teams/find` -> "View team" -> `/teams/[teamId]` -> "Request to join". Signed in: header "My teams" -> `/teams` -> "Create a team" -> `/teams/new` -> after create, `/teams/[teamId]/manage`. Invite: shared link `/teams/join?code=XYZ`; an anonymous visitor goes to `/login?returnTo=%2Fteams%2Fjoin%3Fcode%3DXYZ` and returns to it after sign-in. Admin: `/teams` -> "Manage" -> `/teams/[teamId]/manage`. Anonymous visits to `/teams`, `/teams/new`, `/teams/join` and `/teams/[teamId]/manage` redirect to `/login?returnTo=<path>` (`proxy.ts` `PROTECTED` gets exact `/teams` plus the `/teams/new`, `/teams/join` prefixes and the manage pattern; the pages call `requireUser`).
- **Confidence**: MEDIUM overall. API surface and guard wiring HIGH (mirrors the auth module and the existing `requireTeamRole`). Public pages MEDIUM. Team-admin area layout and header nav LOW (creative).

### Success Criteria
- **User sees**: After "Create team" the browser lands on `/teams/[teamId]/manage` with the notice "Team created. You're its first admin." After "Request to join" the team page shows "Request sent. A team admin will review it." and status "Pending approval". After an admin approves, the requester's `/teams` row reads "Member" on the next load. After "Ban member" the admin sees "{Full name} has been banned." and the person moves to "Banned members"; the banned user's next request to any team-scoped admin or member route returns 403.
- **Verifiable at**: the pages above; `GET /teams/mine`, `GET /teams/:teamId/members`; the database rows below; `pgboss.job` for the `member-banned` job; structured log lines `team.*` (AC-VERIFY-5).
- **Data persisted**: `teams` (`name` trimmed, `description`, `visibility`, `invite_code` server-generated, `created_by`); `team_members` (`role`, `status`, `skill_level` self-assessed, `requested_at`, `approved_at`, `approved_by`, `banned_at`, `banned_by`, `ban_reason`); a `member-banned` pg-boss job row per ban. A new migration (D-40 onwards in `db/schema-deviations.md`) adds the missing invariants (AC-VERIFY-2). No other tables are written.
- **Observable within**: Immediate for create, join, approve, reject, promote, demote, regenerate and for the loss of access on ban. The `member-banned` job row exists at the moment the ban commits; the worker processes it within 30 s while the worker runs (the registration side-effect itself belongs to registration-and-waitlist).

### Acceptance Criteria

**Entry points**

#### AC-ENTRY-1: Find a team and My teams are reachable from every page
**Priority**: MUST
**Given** any visitor, and separately a signed-in user
**When** they open `/` or any page
**Then** the header shows a keyboard-focusable "Find a team" link (-> `/teams/find`) for both, and "My teams" (-> `/teams`) only for the signed-in user; on a 360 px viewport the links wrap without horizontal scroll and keep 44 px tap targets

#### AC-ENTRY-2: Find a team is public and lists only public teams
**Priority**: MUST
**Given** teams exist with visibility `PUBLIC` and `PRIVATE`
**When** an anonymous visitor opens `/teams/find`
**Then** the page shows the field "Search teams" with a "Search" button and a list of `PUBLIC` teams only, each with name, description (truncated at 160 characters), "{n} members" (count of `APPROVED` members) and a "View team" link; no `PRIVATE` team appears in the page or the API response; a signed-in user additionally sees "Pending approval" or "Member" on teams they already relate to

#### AC-ENTRY-3: Create a team is reachable from My teams and sends anonymous users to sign in
**Priority**: MUST
**Given** a signed-in user on `/teams`, and an anonymous visitor
**When** the user clicks "Create a team", and the visitor opens `/teams/new` directly
**Then** the user reaches `/teams/new` showing the create form; the visitor is redirected to `/login?returnTo=%2Fteams%2Fnew` and, after signing in, lands on `/teams/new`

#### AC-ENTRY-4: A private invite link survives the sign-in round trip
**Priority**: MUST
**Given** an anonymous visitor who opens `/teams/join?code=<valid code>`
**When** they sign in (or create an account) from the redirect
**Then** they land on the same `/teams/join?code=<valid code>` (the `returnTo` passes `safeReturnTo`) and see the team name, description and the join form, with `Cache-Control: no-store` and `Referrer-Policy: no-referrer` on that page

#### AC-ENTRY-5: The manage area is offered to admins only
**Priority**: MUST
**Given** a user who is an approved `TEAM_ADMIN` of team A and an approved `MEMBER` of team B
**When** they open `/teams`
**Then** team A's row has a "Manage" link to `/teams/[A]/manage` and team B's row has none; opening `/teams/[B]/manage` directly shows a "You don't have access to manage this team." page (the API answered 403) and never renders the member lists

**Happy paths**

#### AC-HAPPY-1: Player creates a public team and becomes its admin
**Priority**: MUST
**Given** a signed-in user on `/teams/new`
**When** they enter Team name "Rosedale Badminton", Description "Wednesday nights, all levels welcome", choose Public and "Intermediate", and click "Create team"
**Then** `POST /teams` returns 201; in one transaction `teams` gets one row (`visibility='PUBLIC'`, `created_by` = the user, a server-generated `invite_code`) and `team_members` gets one row (`role='TEAM_ADMIN'`, `status='APPROVED'`, `skill_level='INTERMEDIATE'`, `approved_at` set, `approved_by` = the user); the browser lands on `/teams/[teamId]/manage` (history-replacing redirect) showing "Team created. You're its first admin."; the team appears in `/teams/find` immediately

#### AC-HAPPY-2: Player creates a private team and gets an invite link
**Priority**: MUST
**Given** a signed-in user on `/teams/new`
**When** they create a team with Private visibility
**Then** the team does not appear in `/teams/find` or in any search result, `/teams/[teamId]/manage` shows the "Invite link" section with the full URL `{WEB_BASE_URL}/teams/join?code=<invite_code>`, a "Copy link" button and a "Generate new link" button

#### AC-HAPPY-3: Visitor finds a team by searching
**Priority**: MUST
**Given** public teams "Rosedale Badminton", "Albany Badminton" and "North Shore Netball"
**When** the visitor searches "badminton" (any letter case)
**Then** only the two badminton teams are listed, ordered by name (case-insensitive) then id, 20 per page with a stable keyset "Next" link when more exist; `%`, `_` and `\` typed in the query are matched literally (escaped), and an empty query lists all public teams

#### AC-HAPPY-4: Player requests to join a public team with a skill level
**Priority**: MUST
**Given** a signed-in user with no membership row on public team T, on `/teams/[T]`
**When** they choose "Advanced" and click "Request to join"
**Then** `POST /teams/[T]/join-requests` returns 201; `team_members` has one row (`status='PENDING'`, `role='MEMBER'`, `skill_level='ADVANCED'`, `requested_at` set, no `approved_*` or `banned_*`); the page shows "Request sent. A team admin will review it." and the status "Pending approval"; the team shows under "My teams" as "Pending approval"

#### AC-HAPPY-5: Player requests to join a private team through the invite link
**Priority**: MUST
**Given** a signed-in user opening `/teams/join?code=<current code of private team P>`
**When** they choose a skill level and click "Request to join"
**Then** `POST /teams/invite/lookup` first returned the team preview, then the join request returned 201 with a `PENDING` row exactly as in AC-HAPPY-4, and the same confirmation is shown; the same code also works for a `PUBLIC` team's invite link

#### AC-HAPPY-6: Admin approves a join request
**Priority**: MUST
**Given** an approved `TEAM_ADMIN` on `/teams/[T]/manage` with a `PENDING` request listed under "Join requests" as "{Full name}, {Skill level}, requested {date}"
**When** they click "Approve"
**Then** the row becomes `status='APPROVED'` with `approved_at` and `approved_by` set, the request leaves "Join requests" and appears under "Members" with the self-assessed skill level unchanged, and the requester's next call to a `requireTeamRole('MEMBER')` route for T succeeds without re-login

#### AC-HAPPY-7: Admin rejects a join request
**Priority**: MUST
**Given** the same list
**When** they click "Reject"
**Then** the row becomes `status='REJECTED'`, the person leaves "Join requests", the requester's `/teams` row reads "Request declined", and their team-scoped member routes still return 403

#### AC-HAPPY-8: A rejected player can ask again
**Priority**: SHOULD
**Given** a user whose row for team T is `REJECTED`
**When** they open `/teams/[T]` and submit "Request to join" with a skill level
**Then** the same row (the `UNIQUE(team_id, user_id)` row is reused, no second row) returns to `PENDING` with the new `skill_level`, a fresh `requested_at` and cleared `approved_at`/`approved_by`; an admin sees it under "Join requests" again

#### AC-HAPPY-9: Admin promotes a member to team admin
**Priority**: MUST
**Given** an approved `MEMBER` listed under "Members"
**When** an admin clicks "Make admin"
**Then** `role` becomes `TEAM_ADMIN` (status stays `APPROVED`), the person is labelled "Admin", and their very next request to a `requireTeamRole('TEAM_ADMIN')` route for T returns 200

#### AC-HAPPY-10: Admin demotes another admin
**Priority**: MUST
**Given** a team with two approved admins
**When** one clicks "Remove admin" on the other
**Then** the other's `role` becomes `MEMBER` (still `APPROVED`), they are labelled "Member", and their next request to a `TEAM_ADMIN` route returns 403 while `MEMBER` routes still return 200; all admins have equal powers (the creator is not special)

#### AC-HAPPY-11: Admin bans a member
**Priority**: MUST
**Given** an approved `MEMBER` under "Members"
**When** an admin clicks "Ban", optionally types a reason in "Reason (optional, only team admins see this)" (at most 500 characters) and clicks "Ban member" in the inline confirmation "Ban {Full name}? They lose access to this team and can't register for its sessions." (no native browser dialog)
**Then** in one transaction the row becomes `status='BANNED'` with `banned_at` = now, `banned_by` = the admin, `ban_reason` = the trimmed text or null, and a `member-banned` job is enqueued (AC-ASYNC-1); the admin sees "{Full name} has been banned." and the person appears under "Banned members" (name, banned date, reason); the banned user's next call to any `requireTeamRole` route for T returns 403, `/teams` no longer lists T for them, and `GET /teams/[T]` shows them the public team page (if public) with no join form and "You can't join this team."

#### AC-HAPPY-12: Admin regenerates the invite link
**Priority**: MUST
**Given** a team with invite code C1 and an existing `PENDING` request made with it
**When** an admin clicks "Generate new link" and confirms "Generate a new link? The old link stops working immediately." with "Generate new link"
**Then** `teams.invite_code` becomes a new unique value C2, a lookup or join with C1 now returns 404 `invite_invalid`, C2 works, the `PENDING` request and every member are unaffected, and the new URL is shown

**Errors and recovery**

#### AC-ERROR-1: Invalid team input names the field and keeps what was typed
**Priority**: MUST
**Given** a signed-in user on `/teams/new`
**When** they submit with a blank or whitespace-only name ("Enter a team name."), a name over 100 characters ("Use 100 characters or fewer."), a description over 1000 characters ("Use 1000 characters or fewer."), no visibility ("Choose who can find your team."), or no skill level ("Select your skill level to continue.")
**Then** the API returns 422 `validation_failed` with `fieldErrors`, each message appears beside its field and in the error summary linked with `aria-describedby`, the typed values stay, nothing is created, and a body containing `inviteCode`, `createdBy`, `role` or any unknown field is rejected with 422 (strict schema)

#### AC-ERROR-2: A join request without a skill level is refused
**Priority**: MUST
**Given** a user on a team page or invite page
**When** they submit "Request to join" with nothing chosen
**Then** the web blocks it with "Select your skill level to continue." (no request), and a direct API call without `skillLevel` returns 422 `validation_failed`; no `team_members` row is created and the DB default `BEGINNER` is never used

#### AC-ERROR-3: Unknown, regenerated or missing invite codes fail without leaking teams
**Priority**: MUST
**Given** a signed-in user
**When** they look up or join with a code that is unknown, malformed, or was replaced by a regeneration, or join a `PRIVATE` team by id without its code
**Then** lookup returns 404 `invite_invalid` and the page shows "This invite link is no longer valid. Ask a team admin for a new one."; joining a private team by id without a valid code returns 404 `not_found` with the same body as a team id that does not exist, so a private team's existence cannot be probed

#### AC-ERROR-4: Duplicate requests and existing members get a clear message
**Priority**: MUST
**Given** a user whose row is `PENDING` or `APPROVED` for team T
**When** they submit "Request to join" again (including double-clicks and a second tab)
**Then** the API returns 409 `already_requested` ("You've already asked to join this team. A team admin will review it.") or 409 `already_member` ("You're already a member of this team."), no second row exists, and the page shows the matching status instead of the form

#### AC-ERROR-5: A banned player cannot ask to join again
**Priority**: MUST
**Given** a user whose row for team T is `BANNED`
**When** they call `POST /teams/[T]/join-requests` (with or without a valid invite code) or open the invite link
**Then** the API returns 403 `banned_from_team`, the page shows "You can't join this team.", the row is unchanged, and no join form is rendered

#### AC-ERROR-6: A team admin cannot be banned until demoted
**Priority**: MUST
**Given** an approved `TEAM_ADMIN` target (including another admin, never oneself)
**When** an admin calls `POST /teams/[T]/members/[userId]/ban`
**Then** the API returns 409 `team_admin_cannot_be_banned`, the UI shows "Remove admin rights from {Full name} before banning them." (the "Ban" button is `aria-disabled` for admins with that text), the row is unchanged, no job is enqueued, and a raw SQL attempt to set `status='BANNED'` on a `TEAM_ADMIN` row fails with SQLSTATE 23514; after "Remove admin" the ban succeeds

#### AC-ERROR-7: A team can never lose its last admin
**Priority**: MUST
**Given** a team with exactly one approved admin
**When** that admin demotes themselves, or two admins demote each other at the same moment
**Then** the sole-admin case returns 409 `last_team_admin` ("A team needs at least one admin. Make another member an admin first."); in the simultaneous case exactly one demotion commits and the other returns 409 `last_team_admin` (per-team serialisation by locking the team row, plus a deferred DB constraint trigger as the backstop, proven by a deterministic race test, not a sleep)

#### AC-ERROR-8: Only the team's own admins can moderate, and the guard answers before validation
**Priority**: MUST
**Given** callers who are anonymous, a `PENDING`, `REJECTED` or `BANNED` member, an approved `MEMBER`, a non-member, a `GLOBAL_ADMIN` who is not a member, and an admin of a different team
**When** each calls any admin route of team T (members list, approve, reject, promote, demote, ban, invite code, regenerate), including with an invalid body
**Then** the anonymous caller gets 401 `unauthenticated`, every other caller gets 403 `forbidden` before body validation (never a 422) and with the identical body for an existing and a non-existing team, and nothing changes (`allowGlobalAdmin` is not set on these routes in v1)

#### AC-ERROR-9: Stale or cross-team actions are refused, not applied
**Priority**: MUST
**Given** an admin acting on a row another admin already changed, or on a `:userId` that belongs to a different team or does not exist
**When** they click "Approve", "Reject", "Make admin", "Remove admin" or "Ban" on the stale row, or call the API with a foreign `:userId`
**Then** an action that does not match the row's current state returns 409 `membership_state_conflict` ("Someone else already handled this request. The list has been refreshed.") and the list reloads; a user id with no `team_members` row in team T returns 404 `not_found` (the target is always looked up by `(team_id, user_id)`, never by `user_id` alone), and a concurrent approve and reject of one request commits exactly one outcome

#### AC-ERROR-10: Private teams never leak
**Priority**: MUST
**Given** a `PRIVATE` team and a caller with no membership row (anonymous or signed in), and a caller whose row is `BANNED`
**When** they call `GET /teams/[P]`, `/teams/find` with the team's exact name, or open `/teams/[P]` in the browser
**Then** the API returns 404 `not_found` and the page shows "We couldn't find that team."; the team is absent from `find` results and from member counts of any other page; `invite_code` is never present in any response except the two `TEAM_ADMIN` invite-code routes

#### AC-ERROR-11: Service unavailable is survivable and never half-applies
**Priority**: MUST
**Given** a user on `/teams/new`, a team page, or the manage area
**When** the API is unreachable, times out or answers 5xx on submit or on an admin action
**Then** the page shows "Something went wrong on our side. Your details are still here. Try again in a minute.", keeps every typed value (and the chosen radios), the admin list is not changed optimistically, and the user is not sent to `/login` or signed out

#### AC-ERROR-12: A failing ban side-effect never undoes or delays the ban
**Priority**: MUST
**Given** a ban has committed and the `member-banned` handler throws (transient error, then in a second run a permanent error)
**When** the worker runs the job
**Then** the membership stays `BANNED` and access stays revoked; a transient failure is retried with the existing backoff (`retryLimit 3`); a permanent failure ends the job in `failed` with an error log (`event: team.member.banned.hook_failed`, `teamId`, `userId`, no PII) so an operator can see it and re-run it; the admin's ban response was already 200

#### AC-ERROR-15: Retrying a create whose response was lost never makes a second team
**Priority**: MUST
**Given** the create form rendered a hidden `idempotencyKey` (UUID v4, new per form render), and a `POST /teams` with that key has committed but the response never reached the browser
**When** the same player resubmits the same form (same key)
**Then** the API returns 200 with the team already created and its membership, and no second `teams` row exists. The key is stored as `teams.create_idempotency_key` (unique on `(created_by, create_idempotency_key)`, migration D-46). A concurrent double submit with one key yields exactly one team, proven by a race test. The same key sent by a different user is an ordinary new create. A missing or malformed key is 422.

**Async behaviour and the registration seam**

#### AC-ASYNC-1: The ban event is durable and committed with the ban (P5)
**Priority**: MUST
**Given** an admin bans a member
**When** `POST /teams/[T]/members/[userId]/ban` runs
**Then** the status change and the `member-banned` job (queue registered in `apps/api/src/jobs/registry.ts`, `exclusive` policy, `singletonKey = member-banned:<membershipId>`, strict zod payload `{ teamId, userId, membershipId, bannedBy, bannedAt }` with no name or email) commit in one transaction: a ban that rolls back leaves no job, and a job never exists without its `BANNED` row

#### AC-ASYNC-2: The ban handler is an idempotent, replaceable port with a safe default
**Priority**: MUST
**Given** the `member-banned` job is delivered at least once (replay after completion, worker crash)
**When** the worker runs it
**Then** it calls the injected `MemberBannedHandler` port (`apps/api/src/modules/teams/ban-hook.ts`, wired in `apps/api/src/jobs/bootstrap.ts`); the default handler used until registration-and-waitlist ships logs `team.member.banned.hook_noop` with `teamId` and `userId` and succeeds; a second delivery of the same job has no additional effect for a handler that follows the contract; the contract (recorded in an ADR) says the handler must select by current state (every active registration of that user in that team's sessions), take the `game_sessions ... FOR UPDATE` lock of ledger D-14 per session, cancel without a late-withdrawal fee, promote the next waitlisted registrant, and be safe to re-run as a backfill over all `BANNED` rows

#### AC-ASYNC-3: Access is revoked the moment the ban commits, before any job runs
**Priority**: MUST
**Given** a ban has committed and the worker is stopped
**When** the banned user calls any team-scoped route, or any code calls the exported membership gate `assertApprovedMember(trx, teamId, userId)` (`apps/api/src/modules/teams/membership.ts`, takes `FOR SHARE` on the `team_members` row so it serialises with a concurrent ban)
**Then** the route returns 403 and the gate throws `forbidden`, with no dependency on the job having run; this gate is the contract registration-and-waitlist and auto-enroll must call inside their registration transaction, which is how "blocks future registrations" is delivered without touching registration code

**Structural, security and grounded checks**

#### AC-VERIFY-1: Every team route has an explicit policy and the expected one
**Priority**: MUST
**Given** the fully built Fastify app
**When** a test enumerates `listRoutePolicies(app)` for the `/teams` routes
**Then** each declares a policy and they are exactly: `POST /teams`, `GET /teams/mine`, `POST /teams/invite/lookup`, `POST /teams/:teamId/join-requests` -> `authenticated`; `GET /teams/find`, `GET /teams/:teamId` -> `optionalSession`; `GET /teams/:teamId/members`, `.../members/:userId/{approve|reject|promote|demote|ban}`, `GET /teams/:teamId/invite-code`, `POST /teams/:teamId/invite-code/regenerate` -> `teamRole('TEAM_ADMIN')` with `allowGlobalAdmin: false`; no team route is `public`

#### AC-VERIFY-2: The membership rules are enforced by the database, reversibly and ledgered
**Priority**: MUST
**Given** one new migration (`db/migrations/<utc-timestamp>_team_membership_rules.sql`)
**When** `pnpm run test:integration` runs
**Then** the migrate, `rollback --all`, migrate round trip yields an identical schema; `db/schema-deviations.md` has entries (D-40 onwards, each with a Source) for every new constraint, trigger, function and index; `types.generated.ts` still matches codegen; and raw SQL proves each rule: `CHECK (role <> 'TEAM_ADMIN' OR status = 'APPROVED')` (an admin cannot be `PENDING`, `REJECTED` or `BANNED`, 23514); `status = 'BANNED'` requires `banned_at` and `banned_by` and any other status requires them NULL (23514); `status = 'APPROVED'` requires `approved_at` and `approved_by` (23514); a status-transition trigger allows only `PENDING -> APPROVED|REJECTED`, `REJECTED -> PENDING` and `APPROVED -> BANNED` (`BANNED` is terminal in v1, 23000); a deferred constraint trigger refuses a commit that leaves a team with no approved admin when an approved admin row was demoted or deleted (skipped when the team row itself is deleted); `teams.name` not blank, `char_length(description) <= 1000`, `invite_code ~ '^[A-Za-z0-9_-]{32,100}$'`; a partial index `(lower(name), id) WHERE visibility = 'PUBLIC'` backs the Find page and `(team_id, status, role)` backs the admin lists. The `insertTeamMember` factory in `apps/api/test/helpers/factories.ts` is updated to stamp `approved_*`/`banned_*` so the existing auth guard tests keep passing

#### AC-VERIFY-3: Invite codes are strong, unique and never leak
**Priority**: MUST
**Given** the invite-code generator
**When** codes are generated and the endpoints, logs and headers are inspected
**Then** each code is at least 256 bits from `crypto.randomBytes` encoded base64url (43 characters, inside the DB format CHECK), a unique-violation (23505) on insert is retried with a new code, the code appears only in the two admin invite-code responses, in the invite lookup/join request bodies and in the `/teams/join` URL, and never in any log line: a new key pattern for `inviteCode`/`invite_code` is added to the logger redaction in `apps/api/src/lib/logger/logger.ts` (the query parameter `code` is already masked by exact name) and a log-capture test proves it for lookup, join, regenerate and the not-found path; known accepted trade-off: the code also travels inside the `returnTo` query of `/login` during the sign-in round trip (it only lets someone *ask* to join, an admin still approves)

#### AC-VERIFY-4: Search is correct, bounded and index-friendly
**Priority**: SHOULD
**Given** the Find a team query
**When** it runs against several hundred seeded teams
**Then** only `PUBLIC` teams are returned, matching is case-insensitive substring on `name` or `description` with `LIKE` wildcards escaped, the order is `(lower(name), id)` with a keyset cursor (no `OFFSET`), page size is 20, the member count is computed with one aggregate (no per-row query), and the plan for the name ordering uses the partial index

#### AC-VERIFY-5: Team actions are observable and carry no PII
**Priority**: MUST
**Given** the log capture helper (`apps/api/test/helpers/log-capture.ts`)
**When** create, join, approve, reject, promote, demote, ban, regenerate and every refused action above run
**Then** each emits one structured event (`team.created`, `team.join.requested`, `team.member.approved|rejected|promoted|demoted|banned`, `team.invite.regenerated`, and `team.action.refused` with `reason`) carrying `teamId`, `actorId` and, where relevant, `userId` and a `traceId`, and no line contains an email, full name, `ban_reason`, invite code or session token

#### AC-VERIFY-6: Contracts are shared, strict and documented
**Priority**: MUST
**Given** the new request and response schemas in `packages/shared/src/api/teams.ts` (exported from `packages/shared/src/index.ts`) and the new error codes `invite_invalid` (404), `already_requested` (409), `already_member` (409), `banned_from_team` (403), `team_admin_cannot_be_banned` (409), `last_team_admin` (409) and `membership_state_conflict` (409)
**When** `pnpm run typecheck`, `pnpm run test` and `pnpm run openapi` run
**Then** the Fastify routes and the web `apiClient` import the same zod schemas, request bodies are strict, every new code is in the shared `ErrorCode` list and in `ERROR_DEFAULTS` with a safe message that never echoes input, and `apps/api/openapi.yaml` is regenerated and passes the drift test with the bearer requirement on every non-public route

#### AC-VERIFY-7: The pages are accessible and work on a phone
**Priority**: MUST
**Given** the Playwright projects (desktop and 360 x 740) with `@axe-core/playwright`
**When** the Find, My teams, Create, team, invite and manage pages are scanned in their main states
**Then** there are no axe violations of impact `critical`; every input has a label, radio groups are `fieldset`/`legend`, errors are tied by `aria-describedby`, status is not colour-only, buttons and links are at least 44 px high, ban and regenerate confirmations are inline (never `window.confirm`), and no page scrolls horizontally

#### AC-VERIFY-8: The new module is inside the coverage gate and the root commands stay green
**Priority**: SHOULD
**Given** the 80 % gate in `vitest.config.ts` and `apps/api/src/coverage-gate.test.ts`
**When** `pnpm run ci` runs
**Then** `apps/api/src/modules/teams/**` and `apps/web/src/lib/teams/**` are added to the measured set and meet 80 % lines, functions, branches and statements, and lint, typecheck, test, coverage and build all pass

#### AC-INTEGRATION-1: The ban seam is proven against real rows, a real queue and a real race
**Priority**: MUST
**Given** a real cloned Postgres, a real pg-boss producer and worker, and a recording test handler registered through the `MemberBannedHandler` port
**When** a ban runs over HTTP (`buildAuthTestApp`), once with an existing `registrations` row inserted by the test for the banned user (the table exists; the test only inserts the row, it implements no waitlist logic), once with a handler that fails once, and once with a registration insert racing the ban (the insert holds `assertApprovedMember` under `FOR SHARE` before the ban's `FOR UPDATE`)
**Then** the handler receives exactly the payload of AC-ASYNC-1 from a real `pgboss.job` row, sees the registration through its own query by current state, a redelivery is harmless, the failed run is retried to success, and in the race the registration that committed before the ban is visible to the handler while one attempted after the ban is refused by the gate (no registration can slip between the two); the test file states in a header comment that it is the contract test registration-and-waitlist's handler must also pass

#### AC-INTEGRATION-2: Moderation changes drive the existing guards on the next request
**Priority**: MUST
**Given** real sessions and real `team_members` rows through `buildAuthTestApp` and the guard fixture routes of the auth module
**When** a player is approved, promoted, demoted and banned in turn
**Then** `requireTeamRole('MEMBER')` and `requireTeamRole('TEAM_ADMIN')` change their answers (200/403) on the very next request each time with no re-login, matching AC-HAPPY-6, AC-HAPPY-9, AC-HAPPY-10 and AC-HAPPY-11, and `GET /auth/me` and the session stay valid throughout (a ban removes team access, not the account)

#### AC-INTEGRATION-3: The full journey works in a real browser on both viewports
**Priority**: SHOULD
**Given** the Compose stack with `AUTH_FAKE_OAUTH=true` and Playwright (`apps/web/e2e/teams.spec.ts`)
**When** user A creates a private team, copies the invite link, user B opens it while signed out, signs in, requests to join with "Beginner", A approves, A promotes B, A demotes B, A bans B, and B reopens the invite link
**Then** every step shows the copy above, B ends on "You can't join this team." with no join form, and the run passes on the desktop and the 360 x 740 project with no critical axe violations

### Scope Boundaries
- **In scope**:
  - Create team (name, description, visibility, creator's self-assessed skill level; creator becomes approved `TEAM_ADMIN`), server-generated invite code, regenerate code.
  - Public search page `/teams/find`, team page, "My teams", invite landing `/teams/join?code=`.
  - Join request with a required self-assessed skill level (`PENDING`), admin approve/reject, re-request after rejection, promote/demote admins with the last-admin rule, ban with its rules.
  - The membership state machine and invariants in the database (new migration), the `teams` API module, shared zod contracts and error codes, web pages and Server Actions, `apiClient` methods, header links, `proxy.ts` additions, logger redaction for the invite code, OpenAPI regeneration, coverage-gate and doc updates (`systemPatterns.md`, `techContext.md`, ADR for the ban seam).
  - The ban seam only: the committed `BANNED` state, the `member-banned` queue and job, the `MemberBannedHandler` port with a no-op default, and the exported `assertApprovedMember` gate.
- **Out of scope**:
  - Cancelling a banned member's registrations, waitlist promotion, any write to `registrations` or `registration_guests`, and the registration-time membership check itself (registration-and-waitlist implements the handler and calls the gate).
  - Skill override by admins, auto-progression and auto-enrol UI or logic (skill-levels-and-auto-enroll; this feature only stores the self-assessed `skill_level`). Banking, Akahu and GST settings (team-banking-and-gst, which will add sections to the manage area). Session creation (session-scheduling-engine).
  - Editing a team's name, description or visibility after creation; deleting or archiving a team; transferring ownership; leaving a team; removing a member without banning; unban (`BANNED` is terminal in v1, pending a product decision); banning a `PENDING` or `REJECTED` person.
  - A member roster visible to non-admin members, member emails or any contact details in the admin lists.
  - Email or in-app notifications to requesters or admins (provider is TBD; status is visible on "My teams"); an audit history of status changes beyond the current row's `*_at`/`*_by` columns.
  - `GLOBAL_ADMIN` moderation of teams (`allowGlobalAdmin` stays off), a per-user cap or throttle on team creation or join requests, rate limiting of invite lookups (256-bit codes are not guessable), the player dashboard, any change to the auth module beyond the shared error codes.
- **Dependencies**: auth-and-user-roles (COMPLETE, merged to `main`): guards, `request.auth`, `safeReturnTo`, `SiteHeader`, error shape, test harness. platform-foundation: `teams`/`team_members` tables, Kysely, pg-boss producer and worker (`apps/api/src/jobs/*`), `createTestDatabase()`, web `api-client.ts`, Playwright setup. Downstream consumers: registration-and-waitlist (ban handler, `assertApprovedMember`), skill-levels-and-auto-enroll (`team_members.skill_level`, `is_auto_enroll`, the member list), team-banking-and-gst and session-scheduling-engine (`requireTeamRole('TEAM_ADMIN')`, the manage area).
- **NFR implications**:
  - Security (productBrief: global plus per-team RBAC): default-deny policies, guard-before-validation, IDOR-safe lookups by `(team_id, user_id)`, no existence leaks for private teams, CSRF through the existing Origin checks and `SameSite=Lax`, strict bodies so a client cannot set `role`, `status` or `invite_code`.
  - Privacy (NZ Privacy Act 2020): admins see full name, self-assessed skill and ban reason only; no email in lists; `ban_reason` is visible to team admins only and never to the banned user or in logs.
  - Accessibility and responsiveness: see AC-VERIFY-7 (UAT treats axe `critical` as a blocker).
  - Observability: `team.*` events with `teamId`/`actorId`/`userId`/`traceId` only (AC-VERIFY-5). Config: no new environment variables expected (the invite URL uses the existing `WEB_BASE_URL`).
  - Time: timestamps are UTC `timestamptz`; the web shows dates in Pacific/Auckland (P3).
  - Performance: no hard gate; Find page p95 under 300 ms at several hundred public teams is the working target (AC-VERIFY-4).

### Creative Exploration Needed
Yes. Questions for `/yay:creative`, in order of risk:
1. **Ban side-effect seam architecture (LOW confidence).** The ACs above assume the recommended default: ban commits state and enqueues a `member-banned` job in one transaction (P5), the handler is a replaceable port with a no-op default, and "revokes access and blocks future registrations" is delivered synchronously by the committed status plus the `assertApprovedMember` gate. Alternatives to weigh: (a) a synchronous in-transaction hook so cancellation commits with the ban (strongest "immediately", but couples the ban transaction to registration code and its D-14 session locks, and a failing handler would block moderation), (b) the job approach above (eventual cancellation within seconds, race-free because any registration that committed before the ban is visible to the job), (c) a hybrid. Also decide: ADR number and location of the contract, whether a backfill sweeper for `BANNED` rows ships now or with registration-and-waitlist, and what status and fee semantics the cancellation uses (`WITHDRAWN`, no late fee) so the two features agree.
2. **Team-admin area information architecture and UX (LOW confidence).** One `/teams/[teamId]/manage` page with four sections (assumed) versus sub-routes (`/manage/requests`, `/manage/members`, `/manage/invite`); where banking, skill overrides and sessions will plug in later; list pagination and filtering for large teams; the inline confirmation pattern for ban and regenerate; header navigation ("Find a team" and "My teams" in the header while `/` is still a placeholder).
3. **Membership state machine policy (MEDIUM).** Confirm: re-request after rejection allowed immediately (no cooldown); `BANNED` terminal with no unban in v1; ban allowed only from `APPROVED`; all admins equal with the creator not special; last-admin rule enforced by team-row lock plus a deferred trigger.
4. **Invite-code design (MEDIUM).** One code for public and private teams; rotation invalidates the old code but not pending requests; the code in the `returnTo` query as an accepted trade-off versus a short-lived cookie handoff.
5. **Search semantics (MEDIUM).** Substring `ILIKE` on name and description with a partial btree index (assumed, fine at MVP scale) versus `pg_trgm` or full-text search; ordering by name versus by member count.
6. **Creator and requester skill capture (MEDIUM).** The create form asks the creator for their own skill level (required, none preselected) because `skill_level` is `NOT NULL DEFAULT 'BEGINNER'` and later `BY_SKILL_LEVEL` pricing would otherwise silently price the creator as a beginner.

### Implementation Guide Required
No. Every acceptance criterion is auto-verifiable. The ban-seam contract for registration-and-waitlist is written down in the ADR produced by creative question 1.

## Test Strategy

### Approach
- **Emphasis**: balanced, leaning integration. The membership state machine, the invariants and the ban seam are proven against real PostgreSQL 17 and a real pg-boss queue (P1, P5). Pure logic is unit-tested: zod contracts, invite-code generation, the transition table, search-term normalisation, the web form validation and the status-label mapping. Playwright covers the web journeys on the desktop and 360 px projects, with axe scans.
- **Target test count**: about 105 across 5 phases. That is above the 20-test guideline because the spec has 43 ACs, and about half of them are authorization or state-machine negatives that each need their own case. Integration tests carry most of these through `app.inject`. The transition table and the route-policy table are table-driven unit tests, so each counts as one file but many cases.

### File Organization
- **New test files**:
  - `packages/shared/src/api/teams.test.ts`: strict bodies reject `role`, `status` and `inviteCode`; name trim and length; skill level required; cursor shape.
  - `apps/api/src/modules/teams/invite-code.test.ts`: 256-bit entropy, URL-safe alphabet, uniqueness retry.
  - `apps/api/src/modules/teams/transitions.test.ts`: table-driven over every `(status, role, action)` pair. Covers allowed moves, `BANNED` terminal, ban only from `APPROVED` non-admin, and demote blocked for the last admin.
  - `apps/api/src/modules/teams/member-banned.test.ts`: the no-op default handler, port replacement, and the idempotency key.
  - `apps/api/test/integration/teams-schema.int.test.ts`: the new migration's CHECKs and triggers, the deferred last-admin trigger, guarded transitions, stamp columns and the migrate/rollback round trip (AC-VERIFY-2).
  - `apps/api/test/integration/teams-api.int.test.ts`: create, find, mine, detail, invite lookup and regenerate, join requests, and private-team non-leak (AC-HAPPY-1 to 5 and 12, AC-ERROR-1 to 5 and 10).
  - `apps/api/test/integration/teams-moderation.int.test.ts`: approve, reject, re-request, promote, demote and ban; the guard runs before validation; cross-team and stale actions; the next-request guard effect (AC-HAPPY-6 to 11, AC-ERROR-6 to 9, AC-INTEGRATION-2).
  - `apps/api/test/integration/teams-ban-seam.int.test.ts`: the job commits with the ban; a failing handler retries without undoing the ban; `assertApprovedMember` with `FOR SHARE` races a concurrent ban, using a `registrations` row as fixture (AC-ERROR-12, AC-ASYNC-1 to 3, AC-INTEGRATION-1).
  - `apps/api/test/integration/teams-logs.int.test.ts`: `team.*` events, invite code and `ban_reason` absent from logs (AC-VERIFY-3 and 5).
  - `apps/web/src/lib/teams/actions.test.ts`: Server Actions map API errors to field messages and keep what was typed.
  - `apps/web/src/lib/teams/labels.test.ts`: status to label mapping and notice copy.
  - `apps/web/e2e/teams.spec.ts`: AC-INTEGRATION-3 journeys on desktop and mobile, with axe scans (AC-VERIFY-7).
- **Extend existing**:
  - `apps/api/src/lib/auth/policy.test.ts`: every team route has its expected policy (AC-VERIFY-1).
  - `apps/api/src/lib/logger/logger.test.ts`: `inviteCode` and `invite_code` redaction.
  - `apps/api/src/lib/http/errors.test.ts`: the 7 new error codes and their statuses.
  - `apps/api/src/jobs/registry.test.ts`: the `member-banned` queue.
  - `apps/api/src/openapi.test.ts`: drift.
  - `apps/api/src/coverage-gate.test.ts`: `modules/teams/**` is in the gate (AC-VERIFY-8).
  - `apps/api/test/integration/auth-guards.int.test.ts`: only if a guard change is needed; none is expected.
  - `apps/api/test/integration/schema.int.test.ts` and `enum-parity.int.test.ts`: the new constraints.
  - `apps/web/src/lib/api-client.test.ts`: team methods.
  - `apps/web/src/proxy.test.ts`: the `/teams` protected paths and `no-store` on `/teams/join`.
  - `apps/web/src/components/site-header.test.tsx`: the "Find a team" and "My teams" links.

### What NOT to Test
- Registration cancellation and waitlist promotion: these are out of scope. Only the port contract and the job are tested here.
- `requireTeamRole` internals: auth-and-user-roles covers them. Here we test only that each team route uses the right guard and policy.
- Visual styling of the team pages: UAT covers it. Tests assert labels, roles, messages and the AC-VERIFY-7 layout checks only.
- `types.generated.ts`: tsc and the existing codegen drift test check it.

### Per-Phase Test Guidance
- **Phase 1** (about 20 tests): new migration CHECKs (an admin must be `APPROVED`; the stamp columns match the status), transition trigger rejections, the deferred last-admin trigger, migrate/rollback round trip, enum parity, shared zod contracts, error-code parity, logger redaction of the invite code, and the factory stamping the new columns.
- **Phase 2** (about 28 tests):
  - Invite-code generation.
  - Create team: the creator becomes an `APPROVED` `TEAM_ADMIN` with their chosen skill level.
  - Validation errors name the field.
  - Find returns `PUBLIC` teams only, uses bounded pagination and treats `%`/`_` as literal text.
  - Mine omits `BANNED` rows.
  - A `PRIVATE` team detail returns 404 for non-members.
  - Invite lookup returns 404 `invite_invalid` for an unknown or regenerated code.
  - Join request becomes `PENDING`.
  - Errors: `already_requested`, `already_member`, `banned_from_team`, and a missing `inviteCode` on a private team.
  - Regenerate invalidates the old code but keeps pending requests.
  - Route policies.
- **Phase 3** (about 30 tests):
  - Approve, reject, re-request after a rejection, promote and demote.
  - Error codes: `last_team_admin`, `team_admin_cannot_be_banned` and `membership_state_conflict`.
  - Ban from `APPROVED`.
  - Guard ordering: 403 before a 400.
  - Cross-team `userId` gives 404.
  - The guard result changes on the next request with no re-login.
  - The member list never includes email.
  - The ban commits the `member-banned` job in the same transaction; a rollback leaves neither.
  - Handler idempotency and retry.
  - `assertApprovedMember` under a concurrent ban.
  - `team.*` log events.
- **Phase 4** (about 15 tests): the header links; the proxy protects `/teams`, `/teams/new`, `/teams/join` and the manage pattern; `/teams/join` is `no-store` and `no-referrer`; the `returnTo` round trip keeps the code; api-client team methods; Server Actions error mapping; skill radios have none preselected; status labels.
- **Phase 5** (about 12 tests):
  - The manage area: Server Actions for every moderation button, and the inline confirm for ban and regenerate.
  - Playwright on desktop and mobile:
    - Create a private team, copy the invite, and a second user joins through the code.
    - The admin approves, promotes, demotes and bans.
    - The banned user loses access.
    - Search for a public team.
  - axe scans of every team page.
  - OpenAPI drift.
  - The coverage gate includes `modules/teams/**`.

## Implementation Roadmap

### Implementation Plan

#### Overview
Build teams as the second `modules/<feature>` slice on top of the auth platform. The membership state machine is enforced by the database (P1) and mirrored by a pure transition table in the service. The API stays the authority, through `requireTeamRole('TEAM_ADMIN')` with no global-admin override. Ban is a committed status change plus a durable `member-banned` job and a replaceable handler port (P5), and an exported `assertApprovedMember` gate is ready for registration-and-waitlist. The ban seam shape and the admin-area layout are provisional until `/yay:creative` settles them; Phases 3 and 5 follow the creative docs.

#### Requirements
- **Functional**: create a team (the creator becomes an approved admin with a self-assessed skill level), public search, My teams, team page, invite landing and regenerate, join requests with a required skill level, approve or reject, re-request after rejection, promote or demote with the last-admin rule, ban (approved non-admins only; `BANNED` is terminal).
- **Non-functional**:
  - Default-deny policies and guard-before-validation.
  - IDOR-safe lookups and no existence leaks for private teams.
  - Strict bodies.
  - The invite code is redacted from logs and served with `no-store`/`no-referrer`.
  - No email in admin lists.
  - axe critical issues block UAT.
  - `team.*` structured events.
  - Find p95 under 300 ms at several hundred teams.

#### Component Analysis
- **New**:
  - Teams module (`apps/api/src/modules/teams/`): routes, service, repo, transitions, invite code, the member-banned port and job, and the approved-member gate.
  - Shared team contracts (`packages/shared/src/api/teams.ts`).
  - Membership-invariants migration.
  - Web team pages, components and `lib/teams`.
  - ADR 0015 for the ban seam contract.
- **Affected**:
  - `apps/api/src/app.ts`: register the module and inject the handler port.
  - `apps/api/src/jobs/{registry,bootstrap}.ts`: the `member-banned` queue.
  - `apps/api/src/lib/logger/logger.ts`: invite-code redaction.
  - `packages/shared/src/api/errors.ts`: 7 codes plus `ERROR_DEFAULTS`.
  - `packages/shared/src/index.ts`
  - `apps/api/test/helpers/factories.ts`: `insertTeamMember` stamps the new columns.
  - `db/schema-deviations.md`: D-40 onwards.
  - `apps/api/src/lib/db/types.generated.ts`
  - `apps/api/openapi.yaml`
  - `vitest.config.ts` coverage list.
  - Web: `apps/web/src/proxy.ts`, `apps/web/src/lib/api-client.ts`, `apps/web/src/components/site-header-links.tsx`.
  - Docs: `systemPatterns.md`, `techContext.md`.

#### Dependencies & Risks
- **Risk**: The ban seam contract drifts from what registration-and-waitlist needs. **Mitigation**: the creative architecture phase decides it, ADR 0015 records it, and AC-INTEGRATION-1 exercises it against a real `registrations` fixture.
- **Risk**: The deferred last-admin trigger deadlocks with concurrent demotes. **Mitigation**: take the team-row lock first in every admin-changing transaction, and add a 20-way race test in Phase 3.
- **Risk**: The new CHECKs fail on existing rows. **Mitigation**: the only rows are from tests or dev seeds; the migration validates and the round-trip test covers it.
- **Risk**: The invite code appears in `returnTo` during login. **Mitigation**: this is an accepted trade-off (creative question 4 may change it). Redaction plus `no-referrer` limits the exposure.
- **Dependency**: auth-and-user-roles (merged). Downstream consumers are registration-and-waitlist and skill-levels-and-auto-enroll.

#### Observability Requirements
- **Applies**: Yes. Reference `context/observability-requirements.md` during build.
- **Logging**:
  - Events: `team.created`, `team.join_requested`, `team.member_approved`, `team.member_rejected`, `team.admin_promoted`, `team.admin_demoted`, `team.member_banned`, `team.invite_regenerated` and `team.member_banned_handled`.
  - Fields: `teamId`, `actorId`, `userId` and `traceId` only. No names, invite codes or `ban_reason`.
- **Tracing**: existing HTTP and pg-boss spans; the job carries `traceparent` from the ban request.
- **Metrics**: none beyond the standard HTTP metrics.
- **Configuration**: no new environment variables (the invite URL uses `WEB_BASE_URL`).

#### API Requirements - REST
- **Involves REST API**: Yes.
- **OpenAPI Spec Location**: `apps/api/openapi.yaml`, generated and drift-tested.
- **Endpoints Affected**: the 14 `/teams*` routes listed in the Invocation Method.
- **Build Phase**: load `context/api-rest-requirements.md`.
- **GraphQL**: No.

### New Source Files (pin path + extension)
- [ ] `db/migrations/20261013000100000_team_membership_invariants.sql`: CHECKs, transition trigger, deferred last-admin trigger, partial search index (`.sql`)
- [ ] `packages/shared/src/api/teams.ts`: zod request and response contracts (`.ts`)
- [ ] `packages/shared/src/api/teams.test.ts` (`.test.ts`)
- [ ] `apps/api/src/modules/teams/routes.ts`: route registration and policies
- [ ] `apps/api/src/modules/teams/service.ts`: create, join, moderation and invite use cases
- [ ] `apps/api/src/modules/teams/repo.ts`: Kysely queries with team-row locks
- [ ] `apps/api/src/modules/teams/transitions.ts`: pure membership transition table
- [ ] `apps/api/src/modules/teams/invite-code.ts`: 256-bit URL-safe code generator
- [ ] `apps/api/src/modules/teams/member-banned.ts`: `MemberBannedHandler` port, no-op default, job payload
- [ ] `apps/api/src/modules/teams/approved-member.ts`: exported `assertApprovedMember(trx, teamId, userId)` gate
- [ ] `apps/api/src/jobs/member-banned.ts`: pg-boss handler that calls the port
- [ ] `apps/api/src/modules/teams/{invite-code,transitions,member-banned}.test.ts`
- [ ] `apps/api/test/integration/teams-{schema,api,moderation,ban-seam,logs}.int.test.ts`
- [ ] `docs/adr/0015-team-membership-and-ban-seam.md`
- [ ] `apps/web/src/lib/teams/actions.ts`: Server Actions (no JSX, `.ts`)
- [ ] `apps/web/src/lib/teams/labels.ts`: status labels and notice copy (`.ts`)
- [ ] `apps/web/src/lib/teams/{actions,labels}.test.ts`
- [ ] `apps/web/src/app/teams/page.tsx`: My teams
- [ ] `apps/web/src/app/teams/find/page.tsx`
- [ ] `apps/web/src/app/teams/new/page.tsx`
- [ ] `apps/web/src/app/teams/join/page.tsx`
- [ ] `apps/web/src/app/teams/[teamId]/page.tsx`
- [ ] `apps/web/src/app/teams/[teamId]/manage/page.tsx` (sub-routes if the UI/UX creative decides so)
- [ ] `apps/web/src/components/teams/skill-level-field.tsx`: fieldset radios, none preselected
- [ ] `apps/web/src/components/teams/create-team-form.tsx`
- [ ] `apps/web/src/components/teams/join-team-form.tsx`
- [ ] `apps/web/src/components/teams/team-search.tsx`
- [ ] `apps/web/src/components/teams/member-list.tsx`: approve, reject, promote, demote and ban with inline confirm
- [ ] `apps/web/src/components/teams/invite-link-panel.tsx`
- [ ] `apps/web/e2e/teams.spec.ts`
- [ ] extend: `packages/shared/src/api/errors.ts`, `packages/shared/src/index.ts`, `apps/api/src/app.ts`, `apps/api/src/jobs/{registry,bootstrap}.ts`, `apps/api/src/lib/logger/logger.ts`, `apps/api/test/helpers/factories.ts`, `apps/api/src/lib/db/types.generated.ts`, `apps/api/openapi.yaml`, `db/schema-deviations.md`, `vitest.config.ts`, `apps/web/src/proxy.ts`, `apps/web/src/lib/api-client.ts`, `apps/web/src/components/site-header-links.tsx`

### Phases
- [x] **Phase 1: Schema invariants and shared contracts**: the migration (D-40 onwards), regenerated types, zod contracts, 7 error codes, logger redaction and the factory update. ACs: AC-VERIFY-2, AC-VERIFY-3 (redaction) and AC-VERIFY-6.
- [x] **Phase 2: Teams API, discovery and joining**: create, find, mine, detail, invite lookup/get/regenerate, join requests, route policies and `team.*` logs. ACs: AC-HAPPY-1 to 5 and 12, AC-ERROR-1 to 5, 10 and 11, AC-VERIFY-1 and 4.
- [x] **Phase 3: Moderation API and ban seam** (follows the architecture creative doc): members list, approve/reject/re-request/promote/demote/ban, the `member-banned` queue and job, the handler port, `assertApprovedMember`, and ADR 0015. ACs: AC-HAPPY-6 to 11, AC-ERROR-6 to 9 and 12, AC-ASYNC-1 to 3, AC-INTEGRATION-1 and 2, AC-VERIFY-5.
- [x] **Phase 4: Web discovery, create and join pages**: header links, `/teams/find`, `/teams`, `/teams/new`, `/teams/[teamId]`, `/teams/join`, proxy, api-client and Server Actions. ACs: AC-ENTRY-1 to 4, plus the web side of AC-HAPPY-1 to 5.
- [x] **Phase 5: Team-admin area, E2E and docs** (follows the UI/UX creative doc): the manage area, Playwright journeys with axe, OpenAPI regeneration, coverage gate, and `systemPatterns.md`/`techContext.md` updates. This phase delivers the complete entry-to-success flow. ACs: AC-ENTRY-5, the web side of AC-HAPPY-6 to 12, AC-VERIFY-7 and 8, AC-INTEGRATION-3.

## Creative Phases

- [x] **User Journey Design**: `memory-bank/creative/team-management-teams-user-journey.md`. Chosen: dedicated, status-driven pages. One status table drives the team page, the invite page, Find and My teams. My teams stands in for notifications. Create and join redirect after posting; moderation reports in place. Spec amendments: A1–A17.
- [x] **Architecture Design**: `memory-bank/creative/team-management-membership-architecture.md`. Chosen:
  - Q1 1B: the BANNED row and the `member-banned` job commit together. The `MemberBannedHandler` port is a no-op for now, and the `assertApprovedMember` FOR SHARE gate blocks new registrations. No sweeper in this feature; registration-and-waitlist owns reconciliation. Cancellation sets `WITHDRAWN` and charges no fee.
  - Q3 3B: the state machine is enforced by the DB, through CHECKs, a transition trigger and deferred last-admin triggers (D-40 to D-45). The team row is locked first.
  - Q4 4A: one rotating 256-bit code. `returnTo` is masked in logs.
  - Q5 5A: ILIKE over a partial `(lower(name), id)` index, with a two-way cursor.
  - Spec amendments: A1–A13.
- [x] **UI/UX Design**: `memory-bank/creative/team-management-team-admin-uiux.md`. Chosen:
  - Q2: one "People" manage page with a jump list, inside `manage/layout.tsx`, plus a `manage-areas.ts` registry where later areas plug in. An `InlineConfirm` disclosure pattern replaces native dialogs.
  - Q6: a shared `SkillLevelField` with none preselected and per-option help text.
  - Spec amendments: 1–11.

### Creative Reconciliation (binding for build)
Where the three docs disagree, these rulings apply. The build reads all three docs' amendment tables as part of the spec.
- **Manage list page size**: 50 rows per section, from Architecture A13, which owns the API contract. This replaces UI/UX's 25.
- **List order**: pending oldest first; members admins first, then by name; banned newest first. All three docs agree.
- **Find pagination**: keep "Previous" and "Next". Architecture A8 adds `prevCursor`, so Journey A6's "Back to first page" does not apply to Find. Manage-section pagers keep UI/UX's "Next" / "Back to start".
- **Self-demote**: inline confirm, then redirect to `/teams/[teamId]` (the caller is still a member) with the notice "You're no longer an admin of {Team name}." This merges Journey A8's target with UI/UX's copy.
- **Manage section order**: Join requests, Members, Invite link, Banned members (UI/UX amendment 1).
- **Response fields**:
  - `GET /teams/mine` adds `pendingRequestCount` (Journey A4).
  - `GET /teams/:teamId` adds `myStatus` and `myRole` (Journey A17).
  - The members list adds `adminCount` (UI/UX amendment 3), which drives the proactive last-admin hint.
  - Moderation responses include `fullName` (Journey A9).
- **Banned-caller invite lookup**: 403 `banned_from_team` with no preview (Journey A3). This is consistent with Architecture.
- **Private-team joining**: only through the invite link (Journey A2, Architecture A9).
- **No-store pages**: `/teams/join` and `/teams/[teamId]/manage` (UI/UX amendment 6).
- **File names**: from Architecture A1, so `modules/teams/ban-hook.ts`, `modules/teams/membership.ts` and `jobs/member-banned.ts`. Add UI/UX amendment 2's extra web files to the New Source Files list at build.
- **Event names**: dotted `team.*` names from Architecture A11, which replace the underscore list in the Observability section.
- **Ban copy** (user decision, 2026-10-13, from critique finding 1): the confirmation reads "Ban {Full name}? They lose access to this team and can't register for its sessions." The "are cancelled" wording in the UI/UX wireframe and the Journey rationale is superseded. registration-and-waitlist adds cancellation wording when it ships the real `MemberBannedHandler` and the reconciliation sweep that re-enqueues bans the no-op handled (Architecture A4). This must go into that feature's plan.
- **Invite rotation race** (critique finding 2): this reverses the Architecture Q4 rule that a join racing a regenerate may succeed. The join transaction locks the team row `FOR SHARE` (which conflicts with regenerate's `FOR UPDATE`) and compares `inviteCode` to `teams.invite_code` under that lock. A rotation that commits first therefore makes the old code fail (`invite_invalid` or `not_found`, per A9). Add a deterministic join-versus-regenerate race test to `teams-api.int.test.ts` (Phase 2).
- **Create idempotency** (user decision, from critique finding 3): AC-ERROR-15. The create form carries a hidden `idempotencyKey`, and `POST /teams` returns the existing team on a replay. Add the column, the unique index and ledger D-46 in the Phase 1 migration; add the replay and race tests in Phase 2. Journey A13's "check My teams" copy stays only as a fallback for a 5xx with no reply.

### Design Critique (advisory)
- **Backend**: codex, run with `adversarial-review --base origin/main --scope branch`. Verdict: needs-attention.
- **Summary**: the ban over-promised cancellation, invite rotation had a race window, and create was not retry-safe.
- **Findings, all resolved by the rulings above**:
  - [high] The ban said registrations are cancelled while the shipped handler does nothing. Resolved with honest copy.
  - [high] Invite regeneration had a TOCTOU hole against immediate invalidation. Resolved with the `FOR SHARE` lock and a race test.
  - [medium] A lost create response could produce a permanent duplicate team. Resolved with an idempotency key (AC-ERROR-15).

---

## Execution State

**Build Status**: COMPLETE
**Current Phase**: 5 of 5
**Auto-Build Mode**: YES
**Current Step**: Phase 5 complete (committed); all phases built
**Step Started**: 2026-10-13
**Can Resume**: NO
**Resume From**: /yay:reflect team-management

### Halt State
(none)

### Deviations
<!-- - Phase <N> | <file:line/artifact> | <rationale> -->
- Phase 2 | apps/api/src/modules/teams/service.ts (join) | The banned check runs before the private-team code check, so a BANNED caller with no code gets 403 `banned_from_team`, not 404. Accepted: AC-ERROR-5 says "with or without a valid invite code", and a banned user already knows the team.
- Phase 3 | apps/api/src/modules/teams/service.ts (moderate) | AC-ERROR-7 vs Amendment A10: for two admins demoting each other at the same instant, A10 wins; the loser's in-transaction actor re-check gives 403 `forbidden`, not 409. Sole-admin and self-demote races still give 409 `last_team_admin`. Accepted.
- Phase 3 | apps/api/src/modules/teams/membership-errors.ts | `keys_immutable` (unreachable via API) maps to 409 `membership_state_conflict`. Accepted as defensive.
- Phase 3 | apps/api/src/jobs/member-banned.ts | Payload/row mismatch logs `team.member.banned.hook_failed` (reason membership_mismatch) and throws NonRetryableJobError; small addition beyond the architecture doc. Accepted.
- Phase 2 | apps/api/src/modules/teams/service.ts (regenerate) | Adds a team-row lock and an approved-admin re-check inside the transaction, which goes beyond the spec. Accepted as hardening that follows the lock-order rule.

- Phase 4 | apps/web/src/lib/teams/labels.ts, components/teams/skill-level-field.tsx | Journey vs UI/UX copy conflict on skill help/hints and Visibility hint: UI/UX Q6 wins (it owns those fields). Accepted.
- Phase 4 | apps/web/src/components/teams/create-team-form.tsx | The extra outage line "If you already see your team on My teams, it was created." is omitted; the idempotency key makes retry safe. Accepted.
- Phase 4 | apps/web/src/lib/teams/actions.ts (join) | Terminal join errors (already_requested, already_member, banned_from_team, invite_invalid, not_found) replace the form with a status banner and do not redirect. Accepted.
- Phase 4 | apps/web/src/app/teams/** | `?notice=` banner uses role=status and is not auto-focused as the journey describes; Phase 5 may add focus. Manage links target /teams/[id]/manage (#requests anchor, UI/UX ids) which 404 until Phase 5. proxy no-store covers all protected team paths (superset). Accepted.

### Phase 1 Build Log
- TDD: 45 new tests (RED 44 failing, then GREEN); unit 473/473, integration 199/199, lint/typecheck/build PASS (verifier).
- Code review: APPROVED (0 blocking). Applied rec 1 (Find cursor max length 700). Deferred: logger exact `code` body-key redaction (rec 2) for Phase 2 when lookup route lands; Phase 3 error mapper must key on `err.constraint` for 23000 guards.
- D-46: `teams.create_idempotency_key uuid NULL` + `UNIQUE (created_by, create_idempotency_key)` (`uq_teams_created_by_idempotency_key`).
- Guard & Recovery Log: empty (guard PASS first try).

### Phase 2 Build Log
- TDD: ~49 new tests (RED 49 failing, then GREEN); unit 487/487, integration 235/235, typecheck/lint/build PASS (verifier). Coverage gate incl. modules/teams/** passes.
- Code review: APPROVED (0 blocking). Recs: R1 pin create-replay-with-different-body behaviour; R2 private-team member posting join without code gets 404 not_found (Phase 4 web must not rely on 409); R3 optional throttle on lookup/join.
- Carry-overs done: AC-ERROR-15 idempotency + race tests; join FOR SHARE vs regenerate FOR UPDATE with deterministic race tests; mine.pendingRequestCount, detail.myStatus/myRole; banned lookup 403; logger exact `code` redaction (log field renamed errorCode in errors.ts); 100-char non-ASCII cursor round trip.
- Notes for later phases: regenerate must be POSTed with no body/content-type (Fastify 422 on empty JSON); malformed non-UUID teamId on public route is 422; team.action.refused for guard 403s on admin routes to be finished in Phase 3; Phase 3 error mapper keys on err.constraint; Phase 3 policy test to add teamRole expectations.
- Guard & Recovery Log: see commit guard result.

### Phase 3 Build Log
- TDD: RED confirmed (12 failing unit entries, 3 failing integration files), then GREEN; unit 605/605, integration 275/275, lint/typecheck/build PASS (verifier, sequential re-run; first parallel run had load-related timing timeouts in DST/previewSchedule tests, not phase-related). Coverage gate passes.
- Code review: APPROVED (0 blocking). Applied rec 1 (guard-403 log only logs UUID-shaped teamId). Open recs: extract listMembers SQL builder when next touched; openapi.yaml was regenerated by `pnpm run openapi` (confirm Phase 5 only re-runs it).
- Built: members list (50/page, adminCount), approve/reject/promote/demote/ban routes, `member-banned` queue + job, `MemberBannedHandler` port (no-op), `assertApprovedMember`, `cli jobs trigger member-banned`, ADR 0015, guard-403 `team.action.refused` events.
- Guard & Recovery Log: see commit guard result.

### Phase 4 Build Log
- TDD: RED confirmed (17 failing in extended suites + 4 new suites unloadable), then GREEN; ~85 new web tests. Verifier: unit 686/686, integration 275/275, coverage gate PASS, typecheck/lint/build PASS.
- Code review: APPROVED (0 blocking). Recs (non-blocking): single session resolution on team page; bound q/after in find page; deterministic fieldError order. Server components under app/teams have no unit tests (Phase 5 e2e to cover invite landing and replace-redirect).
- Built: header links, proxy rules, api-client team methods, Server Actions (createTeamAction, joinTeamAction), labels/validation, pages /teams, /teams/find, /teams/new, /teams/[teamId], /teams/join, components/teams/*. Regenerate client method left for Phase 5.
- Guard & Recovery Log: see commit guard result.

### Phase 5 Build Log
- TDD: RED confirmed (27 failing + 2 suites unloadable), then GREEN; ~78 new web unit tests. Verifier: 1038/1038 (763 unit + 275 integration), coverage gate PASS (modules/teams/** and lib/teams included; 97.65% lines), lint/typecheck/build/openapi drift PASS.
- E2E: apps/web/e2e/teams.spec.ts EXECUTED by the TDD agent, 8/8 pass (desktop + 360x740), run natively (API, worker, prod `next start`, AUTH_FAKE_OAUTH=true, temp DB), not via Compose; not part of `ci`. Not covered in e2e: 5xx keep-panel path and self-demote success (unit-tested only).
- Code review: APPROVED (0 blocking). Non-blocking recs: extract shared `callManageApi` helper in actions.ts; per-user id for the self-demote InlineConfirm; map manage `detail` 404/403 to notFound().
- Built: manage layout + People page, manage-areas registry, InlineConfirm, moderation Server Actions, apiClient manage methods, notice auto-focus, systemPatterns/techContext updates.
- Guard & Recovery Log: see commit guard result.

### Final Review
**Final Review Backend**: AUTO FINAL REVIEW BACKEND: codex — usable
- **Verdict**: ready to merge with fixes; 0 Critical, 0 Important.
- **Minor 1, FIXED post-build**: `logger.ts` now redacts any field named exactly `code`. That hides the error code on the `auth.oauth.link_conflict` events at `oauth-service.ts:364` and `:427`. Rename those fields to `errorCode`. Fixed: both fields renamed to `errorCode`; the `auth-oauth.int.test.ts` link-conflict test now asserts `errorCode` (fails without the fix, passes with it).
- **Minor 2**: a refusal from the in-transaction actor re-check (A10), or from `lockTeam` finding no team, logs `team.action.refused` twice: once from the routes.ts `onError` hook and once from the service's `refusing()`.
- **Minor 3**: carried-over review notes:
  - A create replay with the same key but a different body returns the original team.
  - `callManageApi` duplication in actions.ts.
  - The self-demote InlineConfirm has no per-user id.
  - The `listMembers` SQL builder could be extracted.
- **Minor 4**: a team name made of control characters can produce a Find cursor longer than `CURSOR_MAX_LENGTH` (700).
- **Minor 5**: the admin routes' OpenAPI responses don't list 401/403.

### Deviations (Phase 5)
- Phase 5 | apps/web/src/components/teams/* | No jsdom in the repo, so InlineConfirm keyboard/focus behaviour is covered by a pure reducer, static-markup ARIA tests and the Playwright run. Approve/Reject/Make admin are plain form actions; confirm panels and messages need JS. Accepted.
- Phase 5 | apps/web/src/app/teams/[teamId]/manage | No separate manage/error.tsx; app/teams/error.tsx covers it. Accepted.

### Active Sub-Agents
- User Journey Design (opus): COMPLETE
- Architecture Design (opus): COMPLETE
- UI/UX Design (sonnet): COMPLETE

### Completed Steps
- User Journey Creative Design: COMPLETE (2026-10-13) - Output: memory-bank/creative/team-management-teams-user-journey.md
- Architecture Creative Design: COMPLETE (2026-10-13) - Output: memory-bank/creative/team-management-membership-architecture.md
- UI/UX Creative Design: COMPLETE (2026-10-13) - Output: memory-bank/creative/team-management-team-admin-uiux.md
- Design Critique: CREATIVE CRITIQUE: codex — usable; verdict needs-attention, 3 findings resolved (ban copy, invite race lock, create idempotency AC-ERROR-15)
- Step 0.1: Task provisioned on feature/team-management
- Step 3: Spec Writer Agent (sonnet) - COMPLETE; taxonomy lint CLEAN; human approved 2026-10-13
- Step 4-5: Codebase analysis and implementation plan - COMPLETE (5 phases)
