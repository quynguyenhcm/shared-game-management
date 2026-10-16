# User Journey Design: Team Banking and GST (payout setup)

**Created**: 2026-10-16
**Status**: DECIDED
**Decision Type**: User Journey
**Task**: `team-banking-and-gst` (Level 3). Spec: `memory-bank/tasks/team-banking-and-gst.md` on `feature/team-banking-and-gst` (approved 2026-10-16).
**Answers**: the User Journey creative phase (first-time setup, replace, remove, GST toggle, the publish-refusal hand-off) plus the journey side of Creative Q7, Q8 and Q9.
**Parallel inputs (not decided here)**: Architecture (Akahu credential semantics, audit columns, step-up re-auth, how `is_payout_configured` is derived, the email build decision on the API side), Algorithm (bank-account and IRD validation rules, unknown-branch policy), UI/UX (layout, control-level design, final copy). Every place this journey depends on them is listed in [Dependencies on the parallel creative docs](#dependencies-on-the-parallel-creative-docs). All copy below that is not already in the spec's Success Criteria is marked **(proposed)** and is the UI/UX doc's to finalise.
**Basis**: `main` after team-management (PR #4). Conventions reused from `team-management-teams-user-journey.md` and `team-management-team-admin-uiux.md`: one task per URL, Server Actions with in-place `FormState` errors, `redirect(..., RedirectType.replace)` with a codes-only `?notice=` on success, `StripAuthParams` stripping one-shot codes, `FormBanner` focused once, `ErrorSummary` and field errors, `InlineConfirm` as the only confirmation, the A7 rule ("reload when the server state is known to have changed, keep input when the outcome is unknown"), `NoAccess` on 403, `sessionExpiredUrl` on 401, and the security-notice email pattern from auth (`buildIdentityLinkedEmail`, enqueued in the same transaction).

---

## Journey Overview

**Feature**: A team admin tells the app where player payments go (bank account name and number, Akahu merchant ID and app token) and whether the team charges GST (GST registration, GST number, optional IRD number). They can change or remove those details later. Paid sessions cannot be published until banking is set up; the publish screen (session-scheduling-engine, not built) sends the admin here and back.
**Primary Persona**: Team Admin (`TEAM_ADMIN`, per team). A volunteer club organiser, usually on a laptop for this task because it means copying numbers from a banking app and an Akahu account. Not technical. Nervous about typing bank details into a website.
**Journey Type**: Synchronous for the admin (every save is one request with an immediate answer). Two asynchronous parts: (1) the security email to the team's admins after a banking change (P5 job, seconds), and (2) the human hand-off from a refused publish, which spans two features and possibly two sessions (the admin may need to fetch Akahu details first).
**Orchestration Pattern**: One page with two independent sections. Each section is **summary-first once something is saved** and **form-first when nothing is saved**. Edit mode is URL state (`?edit=banking` / `?edit=gst`). Saves and removal use post/redirect/get with a notice code. Removal uses `InlineConfirm`. A just-in-time hand-off (`?returnTo=`) connects the publish refusal to this page and back.

### Success Statement
> An admin who tried to publish a paid session is told why it was refused, follows "Set up banking and GST", types four values once, sees "Banking details saved. Paid sessions can now be published." with a "Back to your session" link, and publishes; their co-admins get an email saying who changed the payout details and when.

---

## Persona Context

### Primary User
- **Who**: Team Admin (`TEAM_ADMIN`, productBrief Key Personas: "Banking and GST setup, sessions and pricing, ...").
- **Goal**: Get paid sessions published, with money landing in the club's own account. For a minority of clubs, also get GST right on invoices.
- **Context**: Mostly a laptop at home, with the banking app and the Akahu dashboard open in other tabs. Sometimes a phone (360 px) when fixing a typo or removing details. First visit is usually triggered by a refused publish, not by curiosity.
- **Proficiency**: Can copy and paste an account number. Does not know what a check digit is. Does not know whether the club is GST-registered (most social clubs are not; the GST threshold is well above their turnover) and should not feel pushed to register.

### Secondary Users
- **Co-admin**: another `TEAM_ADMIN` of the same team. Did not make the change, but must be able to notice a payout change they did not expect (the obvious fraud move for a compromised admin session) and act on it.
- **Admin of a free-only team**: never charges. Must not be nagged or blocked; banking is optional for them.
- **Downstream developers**: session-scheduling-engine must implement the refusal hand-off defined here ([Hand-off contract](#hand-off-contract-for-session-scheduling-engine)); wallet-and-akahu-billing will later be able to report "Akahu didn't accept these details" into this page.
- **Everyone else** (members, other teams' admins, `GLOBAL_ADMIN`): see nothing (AC-ENTRY-2, AC-ERROR-14). There is no support view in v1.

---

## Journey Map

### Entry Points

| Entry | Context | User intent | Status |
|---|---|---|---|
| Area nav link "Banking and GST" on any manage page | Admin is already in Manage | "Set up or check how we get paid" | MUST (spec AC-ENTRY-1) |
| "Set up banking and GST" link in the publish-refusal message, with `returnTo` | session-scheduling-engine's publish screen, after a 409 `payout_not_configured` | "Fix what stopped me publishing, then go back" | Contract defined here; link built by session-scheduling-engine. This page's `returnTo` support is built now (new AC-ENTRY-4) |
| "Set up banking and GST" link on the My teams admin row while not set up | `/teams`, the admin's status hub | "What still needs doing for my team?" | SHOULD (new AC-ENTRY-5) |
| Link in the banking-change email | Co-admin's inbox | "Was this change expected? Let me check" | SHOULD (with AC-ASYNC-1) |
| Direct URL / bookmark `/teams/<id>/manage/banking` | Any | Same as nav | Protected by `proxy.ts` and `requireUser` |

Not an entry point: the team-created notice. That notice already does one job (share the invite link); the first admin's next move is inviting people, and banking only matters when the first paid session is published. The People page also gets no banner: it would need a banking read on every People load and couples People to decrypt failures.

### Discovery decision (what tells a new admin they need banking)

1. **Just-in-time is the primary path.** The moment banking matters is a refused publish. That refusal names the reason and links straight to the form, then back. Nothing earlier is needed for the admin to succeed.
2. **One quiet ambient cue** on My teams: an admin row whose team is not set up shows a neutral link "Set up banking and GST" next to "Manage". It is a link, not a warning, has no colour, and does not change the row order (rows with waiting join requests stay first). Free-only teams see a link they can ignore. The API change is one boolean on admin rows of `GET /teams/mine` (`payoutConfigured`, read from the plaintext `teams.is_payout_configured`, no decrypt), the same shape as `pendingRequestCount`.
3. **The area nav** appears on every manage page now that there are two areas (spec).
4. **The banking page explains optionality**: the intro says banking is only needed to charge for sessions, so a free-only admin who lands here is not alarmed.

Rejected: a banner on the People page (extra API call and decrypt coupling on the most-used admin page), a step in team creation (most admins do not have Akahu details at hand and many teams are free), sorting not-set-up rows first on My teams (it would push real work, waiting join requests, down).

### Page and route inventory

| URL | Kind | Who sees it | Purpose |
|---|---|---|---|
| `/teams/<id>/manage/banking` | protected page, `TEAM_ADMIN` only, `no-store`, `noindex`, `force-dynamic` | Approved admins of that team | Both sections in their summary or empty state |
| `…/banking?edit=banking#banking` | same page, banking section in edit mode | same | Change banking details |
| `…/banking?edit=gst#gst` | same page, GST section in edit mode | same | Change GST settings |
| `…/banking?notice=<code>` | same page after a successful write (PRG) | same | One-shot banner, stripped after mount |
| `…/banking?returnTo=<path>` | same page reached from a refused publish | same | Carries the way back; kept across edit, save and validation errors |

Query grammar: `edit` (closed list `banking`, `gst`; anything else is ignored), `notice` (closed list below), `returnTo` (validated by `safeReturnTo` and additionally required to start with `/teams/<sameTeamId>/` and not to point at `/manage/banking` itself; otherwise dropped silently). Only one section is in edit mode at a time.

Notice codes (text from `labels.ts`; the account ending is read from the fresh page load, never from the URL):

| Code | When | Banner text |
|---|---|---|
| `banking_saved` | first save (was not set up) | Banking details saved. Paid sessions can now be published. (spec) |
| `banking_updated` | save while set up, account number kept | Banking details updated. (proposed) |
| `banking_account_changed` | save while set up, account number replaced | Banking details updated. Payments now go to the account ending {last4}. (proposed) |
| `banking_removed` | removal | Banking details removed. Paid sessions can't be published until you add them again. (spec) |
| `gst_saved` | GST save | GST settings saved. (spec) |

When the change email is built (AC-ASYNC-1), the three banking notices that change payout details get a second line: "We've emailed the team's admins about this change." (proposed). When `returnTo` is present, `banking_saved` gets a link "Back to your session" (proposed) pointing at `returnTo`.

---

## State Diagrams

### Banking section

```
                    ┌──────────────────────── page load (GET /banking) ───────────────────────┐
                    ▼                                  ▼                                       ▼
          [NOT SET UP: form shown]           [SET UP: summary shown]                [UNREADABLE: re-entry form]
           status: "Not set up..."            status: "Set up..."                    "We can't read the saved..."
                    │                                  │                                       │
     Save banking details                 ┌────────────┼─────────────────┐            Save (all four required)
                    │                     │            │                 │                     │
          ┌─────────┼─────────┐   "Change banking   "Remove banking      (nothing)             │
          │         │         │     details"          details"                                 │
        422       5xx/0      200    (?edit=banking)     │                                      │
   field errors  E-SYS-2      │           │        [CONFIRMING: InlineConfirm]                 │
   values kept   values kept  │           ▼             │          │           │               │
   (no token)   (no token)    │    [EDITING: form,   confirm      Cancel/Esc   │               │
          │         │         │     name + merchant  │            → SET UP,    │               │
          └──stay───┘         │     ID prefilled,    │            focus back   │               │
                              │     number + token   ├── 200 ─▶ redirect ?notice=banking_removed ─▶ [NOT SET UP]
                              │     blank "Leave     ├── 409 banking_in_use ─▶ [SET UP] + error banner, panel closed
                              │     blank to keep")  └── 5xx/0 ─▶ panel stays open, E-SYS-2b
                              │           │
                              │    Save / Cancel (link back, edit cleared)
                              ▼           ▼
            redirect(replace) ?notice=banking_saved | banking_updated | banking_account_changed  ─▶ [SET UP]
                                   (+ returnTo kept; "Back to your session" link when present)

   Any write: 401 ─▶ /auth/session-expired?returnTo=<this URL incl. edit and returnTo>
              403 ─▶ page re-renders as NoAccess (demoted or banned meanwhile)
```

### GST section

```
[NOT REGISTERED summary] ──"Change GST settings"──▶ [EDITING] ──save 200──▶ ?notice=gst_saved ─▶ [REGISTERED summary]
[REGISTERED summary]     ──"Change GST settings"──▶ [EDITING] ──save 200──▶ ?notice=gst_saved ─▶ [NOT REGISTERED summary]
                                                        │
                                                 422 (no GST number, bad number) ─▶ stay, field errors, values kept
```

"Not registered" is a real, normal state, not "not set up": the section never shows a call to action or a warning for it. GST does not affect publishing.

### Cross-feature: publish refusal and return (hand-off)

```
[Session editor, paid session, DRAFT] ──Publish──▶ API 409 payout_not_configured (session stays DRAFT, draft kept)
     │
     ▼
[Editor: alert "Add your team's bank account and Akahu details before publishing a paid session."
         link "Set up banking and GST" → /teams/<id>/manage/banking?returnTo=<editor path>]
     │
     ▼
[Banking page: NOT SET UP form, returnTo carried] ──Save──▶ ?notice=banking_saved&returnTo=…
     │
     ▼
[Banner "Banking details saved. Paid sessions can now be published." + "Back to your session"]
     │
     ▼
[Session editor] ──Publish──▶ 200 PUBLISHED
```

---

## Step-by-Step Journey (primary path: first-time setup from a refused publish)

#### Step 1: Publish is refused (session-scheduling-engine, future)
- **System**: session-scheduling-engine's publish action calls `assertTeamCanPublishPaidSession` (or hits the trigger) and gets 409 `payout_not_configured`.
- **User Sees**: the editor stays put with every value kept; an alert (role `alert`, focused): "Add your team's bank account and Akahu details before publishing a paid session." and a link "Set up banking and GST".
- **User Actions**: follow the link, or save as draft and leave.
- **Feedback**: the session is still a draft (the editor says so).
- **Transitions**: link → Step 2 with `returnTo=<editor path>`.
- **Data Flow**: none written by the refusal (session stays DRAFT; `team.banking.publish_gate_refused` log line).

#### Step 2: Banking page, not set up
- **System**: web page `manage/banking` → API `GET /teams/:id/banking` and `GET /teams/:id/gst` in parallel (TEAM_ADMIN guard).
- **User Sees**: area nav (People, Banking and GST, current marked); H1 "Banking and GST for {team name}"; intro (proposed) "Players pay session fees straight into this account through Akahu. You only need this if your team charges for sessions."; status "Not set up. Paid sessions can't be published until you add your bank account and Akahu details."; section "Bank account and Akahu" with a short "You'll need" list (proposed: "the name and number of the team's bank account", "your Akahu merchant ID and app token") and the form shown directly (no extra click); section "GST" in its summary state "This team is not registered for GST." with "Change GST settings".
- **User Actions**: type account name, account number, Akahu merchant ID, Akahu app token; press "Save banking details".
- **Feedback**: pending "Saving…" with `aria-disabled` (blocks a second submit).
- **Transitions**: 200 → Step 3; 422 → field errors in place (Step 2 again, values kept except the token); 5xx/offline → E-SYS-2 in place.
- **Data Flow**: Server Action validates with the shared `nz` validators, then `PUT /teams/:id/banking`. The token is never written back into form state.

#### Step 3: Saved
- **System**: Server Action `redirect(replace)` to `…/banking?notice=banking_saved&returnTo=…`.
- **User Sees**: banner (role `status`, focused) "Banking details saved. Paid sessions can now be published." with "Back to your session" (only with `returnTo`) and, once AC-ASYNC-1 ships, "We've emailed the team's admins about this change."; status line "Set up. Paid sessions can be published." (proposed, see Spec Amendments); summary rows "Account name: {name}", "Account number: ending {last4}", "Akahu merchant ID: {id}", "Akahu app token: Saved"; "Change banking details" and "Remove banking details".
- **Value Delivered**: the team can publish paid sessions.
- **Next Actions**: "Back to your session"; "Change GST settings" if the club is GST-registered.
- **Async**: one `send-email` job per approved admin (including the actor) committed with the change.

#### Step 4: Back to the session (future)
- **User Sees**: the editor with the draft; "Publish" now succeeds.

### Flow B: Replace details (omit-to-keep)

1. From the summary, "Change banking details" (a link to `?edit=banking#banking`; works without JavaScript, Back leaves edit mode).
2. The form shows account name and merchant ID prefilled; account number and app token empty with the hint "Leave blank to keep the saved value." (spec) and, beside the number, the saved ending in the label hint (proposed: "Saved number ends {last4}. Leave blank to keep it."). Helper text (proposed, confirm with wallet-and-akahu-billing): "Changes apply to payments taken after you save."
3. "Save banking details" → PRG with `banking_updated`, or `banking_account_changed` when a new number was typed (the acting admin is told exactly where money now goes). "Cancel" is a link back to the summary (edit cleared, nothing sent).
4. A validation error keeps edit mode, keeps the typed number (so a typo can be fixed) and drops the typed token; the token field shows the field error only if a token was required.

### Flow C: Remove

1. From the summary, "Remove banking details" (InlineConfirm trigger, secondary style). Not shown in edit mode, so remove and save never sit side by side.
2. Prompt (spec): "Remove banking details? Paid sessions can't be published until you add them again." Buttons "Remove banking details" (destructive) and "Cancel". Focus moves to the prompt; Cancel or Escape returns focus to the trigger and changes nothing.
3. 200 → PRG `banking_removed`; the section returns to the not-set-up form, empty.
4. 409 `banking_in_use` → the panel closes (server state is known and unchanged), the section error banner (role `alert`, focused) says (proposed, replaces the spec copy): "You have published paid sessions, so banking details can't be removed yet. Cancel those sessions or wait until they've finished. To switch to a different account, use Change banking details instead." The summary is unchanged. When session-scheduling-engine ships, it adds a link to the team's published sessions.
5. 5xx/offline → the panel stays open, E-SYS-2b "Something went wrong on our side. Try again in a minute."; nothing changed.

### Flow D: GST

1. From the summary, "Change GST settings" (`?edit=gst#gst`).
2. Form: checkbox "This team is registered for GST" (spec), "GST number" prefilled when one is saved (it is public: it is printed on invoices), "IRD number (optional)" always empty with the hint "Leave blank to keep the saved number (ending {last3})." when one is saved, plus a checkbox "Remove the saved IRD number" shown only when one is saved (proposed; sends `irdNumber: null`). Helper text (spec): "Players' prices include GST. GST is worked out as 3/23 of the price. Changing this setting only affects payments taken after you save; existing payments and invoices keep the GST treatment they were charged with."
3. Blank-field semantics differ on purpose and are made visible: the GST number is shown, so emptying it means "clear it" (allowed only while not registered); the IRD number is never shown, so blank means "keep". The hint on the IRD field states that.
4. Save → PRG `gst_saved`; summary shows "Registered for GST", "GST number: 123-456-789", "IRD number: ending 182" (spec formats), or "This team is not registered for GST." with a saved GST number still listed as "GST number on file: 123-456-789" (proposed) so turning it back on later is one tick.
5. No confirmation for the toggle: player prices do not change (they are GST-inclusive) and the helper text states the forward-only effect.

### Flow E: Saved details can't be read (decrypt failure)

1. `GET /banking` cannot open an envelope (key retired from the keyring, corrupted bytes). The page must not become a dead end, because re-entering the details is the only thing the admin can do.
2. User sees (proposed): status "We can't read the saved banking details. Enter them again to keep them up to date." and the form in re-entry mode: all four fields empty and required (no omit-to-keep hint). Paid publishing is not blocked by this (the flag is unchanged); ops are alerted by `team.banking.decrypt_failed`.
3. Save → normal `banking_updated` / `banking_account_changed` flow; the page reads normally afterwards.
4. GST equivalent: the IRD line reads (proposed) "We can't read the saved IRD number. Enter it again or remove it." and the GST form works as usual.

This needs `GET` to answer 200 with an `unreadable` marker instead of 500 (see Spec Amendments, AC-ERROR-12).

---

## Hand-off contract for session-scheduling-engine

To be written into ADR 0016 by this feature so the next feature finds it (AC-VERIFY-14).

1. **Draft is never lost.** A refused publish leaves the session DRAFT with every edited field saved (or kept in the form if publish is a separate request). The admin must not retype a session because banking was missing.
2. **Message.** Show the API's `payout_not_configured` message verbatim from the shared copy deck: "Add your team's bank account and Akahu details before publishing a paid session." in an alert region on the editor, focused once.
3. **Link.** "Set up banking and GST" → `/teams/<teamId>/manage/banking?returnTo=<url-encoded path of the editor>`. The path must start with `/teams/<teamId>/`. Only an admin can publish, and only an admin can open banking, so the link never leads to NoAccess.
4. **Return.** The banking page keeps `returnTo` across edit mode, validation errors and the save redirect, and shows "Back to your session" in the `banking_saved` banner. It never redirects automatically: the admin should see the confirmation and may also want to set GST.
5. **Recurrence refusal (async).** When the materialiser refuses a paid occurrence because banking was removed or never set up, the series view shows (proposed) "Some sessions weren't published because banking details are missing." with the same link. Never fail silently. Exact behaviour (skip, or create as DRAFT) is the Architecture doc's and ADR 0016's.
6. **Removal side.** The `banking_in_use` message should gain a link to the team's published paid sessions once that list exists.

---

## Trust and fraud: what admins are told

| Who | When | What they learn | Channel |
|---|---|---|---|
| Acting admin | Every banking save or removal | What happened; on an account change, the new ending ("Payments now go to the account ending {last4}."); that admins were emailed | Page banner (sync) |
| Every approved admin of the team, **including the actor** | Banking added, updated or removed | Team name, who made the change, when (Pacific/Auckland), which parts changed (bank account number, account name, Akahu details) or "removed"; a link to the banking page; what to do if unexpected. No account number, ending, merchant ID, token or IRD number | Email (`send-email` job, same transaction, P5) |
| Co-admin visiting the page | Any time | "Last changed {d MMM yyyy} by {name}" under the banking summary (proposed; only if Architecture adds audit columns) | Page |
| Ops | Every change and refusal | `team.banking.*` events with ids and flags only | Logs |

Why the actor is emailed too: a sole-admin team has no co-admin, and the most likely attacker is someone with a stolen session for that very admin. An email to the account owner is the same protection auth already gives for a newly linked Google or Facebook identity.

GST changes are not emailed: they do not move money and are reversible with no loss.

Email copy (proposed, plain text, same style as `buildIdentityLinkedEmail`; names folded to one line):

- Subject: `Payout details changed for {team name}` (removed: `Payout details removed for {team name}`)
- Body:
  ```
  Hi {recipient name},

  {actor name} changed the payout details for {team name} on {d MMM yyyy} at {h:mm a}.
  What changed: {the bank account number | the account name | the Akahu details} (joined with "and").
  [removed variant: {actor name} removed the payout details for {team name} on ... Paid sessions can't be published until they're added again.]

  Check the details: {webBaseUrl}/teams/{teamId}/manage/banking

  If you weren't expecting this, check the details now and replace them if they're wrong. On the People page you can remove admin rights from anyone who shouldn't have them. If you made this change yourself, you don't need to do anything.

  Shared Game Management
  ```
  For the actor, the first line reads "You changed the payout details for {team name} ..." and the advice line becomes "If this wasn't you, reset your password now and ask another admin to check the details."
- Idempotency key `team-banking-changed:<teamId>:<changeId>:<recipientUserId>` where `changeId` identifies the write (for example the new `banking_updated_at` or a generated id; Architecture's call). A rolled-back change leaves no job.

Step-up re-authentication before a banking change: not recommended for v1 by this journey (it costs a full retype, the email covers detection, and sessions are already short-lived on idle). If the Architecture doc adds it, the journey hook is: Save or Remove answers 401 `reauth_required` → redirect to `/login?returnTo=<banking URL with edit and returnTo>` with the context line (proposed) "Sign in again to change your team's payout details."; typed values are lost (the token would be anyway).

---

## Async Handling

### Change-notification email

| Phase | Duration | User experience |
|---|---|---|
| Initiation | Immediate, same transaction as the change | Acting admin sees the save banner, with "We've emailed the team's admins about this change." |
| Processing | About one worker poll (seconds) | Nothing shown; the acting admin has already moved on |
| Completion | Email arrives | Each admin reads who changed what and when, with a link to the page |
| Failure | After 3 retries | Job stays `failed` in `pgboss.job`; the change stands; no user-facing message (nothing actionable) |

`pgboss.job.data` holds no banking value (the email carries none). Names and team name are not secrets; no sealing needed beyond what `enqueueEmail` already does.

### Human async: the publish hand-off

| Phase | Duration | User experience |
|---|---|---|
| Refusal | Immediate | Editor alert with the link; draft kept |
| Gathering details | Minutes to days (admin may need to create or find Akahu credentials) | The admin can leave; the draft and the My teams link "Set up banking and GST" are the reminders |
| Setup | One form | Banner with "Back to your session" when they came through the link |
| Retry publish | One click | Success |

If the admin leaves and comes back later through My teams or the nav, `returnTo` is gone; the banner simply has no back link. Acceptable: the draft is in the sessions list.

### Progress communication
- Pull only for the admin (page loads), push only through the change email. No polling, no in-app notifications (none exist yet).

---

## Distributed System Flow

### System Boundaries
```
Browser ──GET page / Server Action POST──▶ apps/web (manage/banking page, banking-actions.ts)
                                              │ Bearer session, traceparent, internal-auth headers
                                              ▼
                                         apps/api modules/team-banking (routes → service → repo)
                                              │ one transaction: lock teams row FOR NO KEY UPDATE,
                                              │ re-check admin, validate, FieldCrypto.encrypt, UPDATE teams,
                                              │ enqueue send-email per admin (AC-ASYNC-1), log
                                              ▼
                                         PostgreSQL 17 (teams; CHECKs; pgboss.job)
                                              │
                                              ▼
                                         worker ──send-email──▶ Notifier (SMTP / Mailpit)

session-scheduling-engine (future) ──assertTeamCanPublishPaidSession (teams FOR SHARE)──▶ same teams row
                                     └─ refusal → editor alert → link to /manage/banking?returnTo=…
```

### Responsibility Matrix

| Step | Owner | State storage | Failure handling |
|---|---|---|---|
| Page gate | `proxy.ts`, `requireUser`, API guard | session cookie | no cookie → `/login?returnTo`; 401 → session expired; 403 → `NoAccess` |
| Read summary | API `GET /banking`, `GET /gst` | `teams` row (decrypt name, IRD) | decrypt failure → 200 `unreadable` → re-entry state (amended); 5xx → `error.tsx` |
| Edit mode | web | URL `?edit=` | unknown value ignored |
| Client validation | web (shared `nz` validators) | `FormState` | in-place field errors, values kept, token dropped |
| Save / remove | API, one transaction | `teams` row | 422 field errors; 409 `banking_in_use` banner; 403 NoAccess; 5xx keep input, no revalidate |
| Confirmation of success | web PRG | URL `?notice=` (stripped) | n/a |
| Way back to publish | web | URL `?returnTo=` (validated) | invalid → dropped silently |
| Change email | worker | `pgboss.job` | retry with backoff, then `failed`; change stands |
| Publish gate | API (future caller) + DB trigger | `teams.is_payout_configured` | 409 `payout_not_configured` → hand-off |

---

## Error Handling

### Where every error lands and how the admin recovers

| Code (HTTP) | Raised by | Lands on | User sees | Recovery | Input kept |
|---|---|---|---|---|---|
| `validation_failed` (422) | banking or GST save | same form, edit mode kept | `ErrorSummary` "There's a problem" + field messages from `BANKING_FIELD_MESSAGES`; `<title>` prefixed "Error: " | fix fields | name, number, merchant ID, GST and IRD numbers; **never the token** |
| omit-to-keep with nothing stored (422) | banking save | same form | "Enter the account number." / "Enter your Akahu app token." | type it | as above |
| unknown bank/branch (422) | banking save | same form | "That bank or branch number is not recognised. Check the number and try again." (wording depends on the Algorithm doc's unknown-branch policy) | check the number against the banking app | yes |
| strict-body violation (422 `_form`) | crafted request only | form banner | generic "There's a problem" line | reload | n/a |
| `banking_in_use` (409) | remove | banking section banner, panel closed, summary unchanged | proposed copy in Flow C | cancel or let sessions finish, or replace instead | n/a |
| `payout_not_configured` (409) | publish (future) | session editor | spec copy + "Set up banking and GST" | hand-off | draft kept |
| `forbidden` (403) | any read or write (demoted, banned, other team) | page re-renders as `NoAccess` ("You don't have access to manage this team." + "Back to My teams") | as left | n/a | typed values discarded (correct: they no longer may) |
| `unauthenticated` / `session_expired` (401) | any | `/auth/session-expired?returnTo=<banking URL incl. edit and returnTo>` | "Your session has expired. Sign in again." | sign in, back in edit mode | typed values lost (rare; token is never kept anyway) |
| decrypt failure | `GET /banking` or `/gst` | same page, re-entry state (amended AC-ERROR-12) | Flow E copy | re-enter | n/a |
| `internal_error`, `service_unavailable`, timeout, unreachable | save | same form | E-SYS-2 "Something went wrong on our side. Your details are still here. Try again in a minute." (the token field is empty again; the hint under it says "Enter the app token again." (proposed) only when it had been typed) | retry | all but token; no success banner; no revalidate |
| same | remove | panel stays open | E-SYS-2b "Something went wrong on our side. Try again in a minute." | retry | n/a |
| browser offline | any write | same | "You seem to be offline. Check your connection and try again." | retry | as 5xx |
| page load failure | page | `error.tsx` | E-PAGE-1 "Something went wrong on our side. Try again in a minute." | "Try again" (same URL, `edit`/`returnTo` kept) | n/a |

### Partial failure and retries
- **Save committed, response lost**: the retry sends the same values. With a typed number and token it simply writes them again (idempotent in effect); with omitted fields it keeps them. Safe. One extra change email may go out (different change id); acceptable.
- **Remove committed, response lost**: the retry answers 200 on an already-empty row (the service should treat "nothing to remove" as success, not 404) or the reload shows the empty form. Either way the admin ends in NOT SET UP. (Architecture to confirm idempotent `DELETE`.)
- **Change committed, email job failed**: the change stands; ops see the failed job.

### Edge cases

| Case | What happens |
|---|---|
| Two admins edit banking at once | Writes serialise under the team lock; the later save wins as a whole block (AC-ERROR-11). Both admins get the change emails, so the overwritten admin learns of it. If Architecture adds `banking_updated_at`, a stale-edit check could answer 409 "Another admin changed these details while you were editing. Check them below and save again." (optional; not required by this journey) |
| Admin demoted while the edit form is open | Save → 403 → `NoAccess`. Nothing written |
| Banking removed by a co-admin while this admin is in edit mode with blanks | Save → 422 "Enter the account number." / "Enter your Akahu app token." (nothing stored to keep). The form shows the not-set-up hint after reload |
| Paid session published between page load and Remove | Remove → 409 `banking_in_use` (gate holds the team row `FOR SHARE`; AC-VERIFY-9) |
| Reload after save | The notice was stripped; the summary renders without the banner; no resubmission (PRG) |
| Back after save | The edit URL was replaced; Back goes to where the admin was before the banking page |
| `returnTo` pointing at another team or off-site | Dropped silently; no "Back to your session" link |
| Admin types secrets on a shared computer | No value is stored in browser storage; the token input is `type="password"`, `autocomplete="off"`; the page is `no-store` |
| GST on, then banking removed | Allowed; GST is independent of payout |
| Free-only team never sets up banking | Nothing is blocked; My teams shows a quiet link; free sessions publish (AC-HAPPY-7) |

---

## Options Explored

### Option 1: One page, summary-first sections, URL edit mode, PRG notices, just-in-time hand-off (CHOSEN)
- **Orchestration**: single page with two independent sections. Form-first when empty, summary-first once saved; "Change …" links set `?edit=`; saves redirect with a notice code; removal through `InlineConfirm`; `returnTo` for the publish hand-off; a quiet My teams link.
- **Wireframe** (desktop, set up, just saved from a hand-off):
  ```
  ┌───────────────────────────────────────────────────────────────┐
  │ People | Banking and GST*                     (area nav)       │
  │ ┌───────────────────────────────────────────────────────────┐ │
  │ │ Banking details saved. Paid sessions can now be published.│ │ ← role=status, focused
  │ │ We've emailed the team's admins about this change.        │ │
  │ │ Back to your session                                      │ │
  │ └───────────────────────────────────────────────────────────┘ │
  │ Banking and GST for Rosedale Badminton                 (h1)   │
  │ Set up. Paid sessions can be published.                       │
  │                                                               │
  │ Bank account and Akahu                                 (h2)   │
  │   Account name: Rosedale Badminton Club Inc                   │
  │   Account number: ending 0023                                 │
  │   Akahu merchant ID: merchant_123                             │
  │   Akahu app token: Saved                                      │
  │   Last changed 16 Oct 2026 by Aroha Ngata   (if audit cols)   │
  │   [Change banking details]  [Remove banking details]          │
  │                                                               │
  │ GST                                                    (h2)   │
  │   This team is not registered for GST.                        │
  │   [Change GST settings]                                       │
  └───────────────────────────────────────────────────────────────┘
  ```
  Edit mode (360 px):
  ```
  ┌──────────────────────────────┐
  │ Bank account and Akahu       │
  │ Account name                 │
  │ [Rosedale Badminton Club Inc]│
  │ Account number               │
  │ Saved number ends 0023.      │
  │ Leave blank to keep it.      │
  │ [__________________________] │
  │ Akahu merchant ID            │
  │ [merchant_123______________] │
  │ Akahu app token              │
  │ Leave blank to keep the      │
  │ saved value.                 │
  │ [••••••____________________] │
  │ Changes apply to payments    │
  │ taken after you save.        │
  │ [ Save banking details     ] │
  │ [ Cancel                   ] │
  └──────────────────────────────┘
  ```
- **Pros**: the summary is the trust surface (where money goes, at a glance) and cannot be changed by a stray keystroke; empty teams get the form with zero extra clicks; edit mode in the URL works without JavaScript, survives validation errors and session-expiry round trips, and gives Back sane behaviour; PRG matches create/join and gives a single, testable banner per outcome; the hand-off needs only one query parameter.
- **Cons**: one extra click to edit once set up; PRG plus `edit` and `returnTo` parameters is more URL state than the People page uses; the banner variants add a few copy keys.

### Option 2: Always-open forms with in-place results (spec's literal reading)
- **Orchestration**: both sections are always forms; saved values sit beside them; results appear in a section status region with `revalidatePath`, like the People page.
- **Wireframe**:
  ```
  Bank account and Akahu
   Saved: ending 0023 · token Saved
   Account name [Rosedale…]  Account number [      ] (leave blank to keep)
   Merchant ID [merchant_123]  App token [      ] (leave blank to keep)
   [Save banking details]  [Remove banking details]
  ```
- **Pros**: fewest clicks for an edit; one pattern with the People page's in-place results; no URL state.
- **Cons**: blank write-only fields on every visit look like missing data to a nervous admin; save and remove side by side; a configured page is mostly inputs, so "where does our money go?" is harder to read; after a successful save the form stays filled and it is less obvious that it worked; the hand-off still needs `returnTo`.

### Option 3: Guided setup wizard (Bank account → Akahu → GST → Review), then a summary page
- **Orchestration**: "Set up payments" opens a 3-step stepper with a review step; later edits go through the same wizard or a separate edit page.
- **Wireframe**:
  ```
  Step 1 of 3: Bank account   Name [   ]  Number [   ]          [Next]
  Step 2 of 3: Akahu          Merchant ID [   ]  App token [   ] [Back] [Next]
  Step 3 of 3: Review         ending 0023 · token Saved          [Back] [Save]
  ```
- **Pros**: strong first-time guidance; a review step before money is routed.
- **Cons**: the token has to travel across steps (hidden fields or server-side draft state for a secret); GST is optional and independent, so forcing it into the sequence misleads most clubs; replace and remove need a second path anyway; four values do not need three steps; more routes, more tests; the review step duplicates what the post-save summary already shows.

### Option 4: Banking as a required step in team creation
- **Orchestration**: create team → "How will your team get paid?" step (skippable) → manage page.
- **Pros**: every admin sees it once, early.
- **Cons**: lengthens the create-to-invite path that the team-management journey optimised; most admins do not have Akahu details at that moment; free-only teams are pushed to skip something that sounds required; a skipped step is forgotten exactly as an unseen page is.

---

## Evaluation Matrix

| Criterion | Option 1 Summary-first + hand-off | Option 2 Always-open forms | Option 3 Wizard | Option 4 Step in create |
|---|---|---|---|---|
| Discoverability | H (just-in-time link, nav, My teams) | H (same entries) | M (needs a CTA) | H once, then L |
| Learnability | H | M (blank-means-keep on every visit) | H | M |
| Efficiency | H first time (form shown), M edit (one click) | H | L | M |
| Error Prevention | H (summary not editable, remove apart from save) | M | H | M |
| Error Recovery | H (URL state survives errors and re-auth; re-entry state) | M | M (multi-step secret state) | M |
| Feedback | H (one banner per outcome, account ending on change) | M | H | M |
| Consistency | H (PRG like create/join, InlineConfirm, NoAccess) | H (People-page results) | L (no wizard pattern yet) | M |
| Accessibility | H (plain links and forms, no traps) | H | M (stepper focus management) | M |
| Delight / trust | H (clear "where money goes", hand-off back) | M | M | L |

## Decision

**Chosen**: Option 1, one page with summary-first sections, URL-driven edit mode, post/redirect/get notices, `InlineConfirm` removal, and a just-in-time hand-off from the publish refusal with `returnTo`; one quiet "Set up banking and GST" link on My teams; change emails to every admin of the team. Borrowed from Option 3: the "You'll need" list in the empty state. Borrowed from Option 2: when nothing is saved, the form is shown straight away.

### Rationale
- Admins arrive here because something was refused. The shortest path is: reason, link, four fields, confirmation, back. Option 1 is exactly that, and everything else (nav, My teams) is a secondary way in.
- Bank details are where trust is won or lost. A read-only summary with the account ending, kept apart from the edit form and from removal, answers "where does our money go?" at a glance and prevents accidental edits.
- URL edit mode and PRG reuse the project's existing primitives (`notice` codes, `StripAuthParams`, `safeReturnTo`, `sessionExpiredUrl`) and work without JavaScript; only removal needs script, as on the People page.
- Telling every admin, including the actor, about payout changes is cheap (the identity-linked email is the template) and is the only fraud signal a sole-admin team can have.

### Trade-offs Accepted
- **One extra click to edit** once set up. Acceptable: edits are rare and deliberate.
- **No automatic return after setup**: the admin clicks "Back to your session". They see the confirmation first and can set GST.
- **`returnTo` is lost if the admin leaves mid-hand-off**: the draft is still in the sessions list.
- **"Set up" does not mean "verified"**: no Akahu call exists in this feature, so the status line avoids promising working payments (amended copy). wallet-and-akahu-billing can add a "couldn't connect" state later.
- **Free-only teams see a "Set up banking and GST" link on My teams**: neutral wording, no colour, no reordering.
- **Typed values are lost on session expiry** and the token is never kept on any error: re-typing a secret is the safe default.

---

## Implementation Guidelines

### Frontend Requirements
1. `apps/web/src/app/teams/[teamId]/manage/banking/page.tsx`: parallel `GET /banking` and `GET /gst`; 401 → `sessionExpiredUrl(here incl. query)`; 403 → `NoAccess` (reuse the People page component); renders each section by state (`not_set_up`, `set_up`, `unreadable`; GST `registered`, `not_registered`) and by `edit`; validates `returnTo` (`safeReturnTo` + same-team prefix); `StripAuthParams` for `notice` only (keep `edit`, `returnTo`).
2. `manage-areas.ts`: second entry; `manage/layout.tsx` marks the current area (AC-ENTRY-3; UI/UX decides the mechanism).
3. `apps/web/src/lib/teams/banking-actions.ts`: `saveBankingAction`, `removeBankingAction`, `saveGstAction`. Validate with the shared `nz` validators first; on success `redirect(buildUrl(bankingPath, { notice, returnTo }), RedirectType.replace)`; on 422 return `{ fieldErrors, values }` without `akahuAppToken`; on 409 `banking_in_use` return the error with the panel closed; on 403 redirect to the banking path (renders `NoAccess`); on 401 `sessionExpiredUrl`; on 5xx/0 return values without the token and do not revalidate. The action decides `banking_saved` vs `banking_updated` vs `banking_account_changed` from the API response (`wasConfigured`, `replacedAccountNumber`; see Backend 2).
4. `labels.ts`: the notice codes above in `noticeText` (account ending passed from the page load), status lines, summary row formatters, `You'll need` list, the revised `banking_in_use` line.
5. `InlineConfirm` is typed to `ModerationKind` and `useModerationAction` today; generalise it (an action prop and a section id) or add a thin banking variant. UI/UX and build decide; the behaviour stays identical.
6. My teams (`app/teams/page.tsx`): when `isAdmin && team.payoutConfigured === false`, add a link "Set up banking and GST" (accessible name includes the team name) to `/teams/<id>/manage/banking`, after "Manage". `sortMyTeams` is unchanged.
7. No `localStorage`/`sessionStorage` for any field. Token input `type="password"`, `autocomplete="off"`, `spellcheck="false"`; account number `inputMode="numeric"`, `autocomplete="off"` (AC-VERIFY-13).

### Backend Requirements (journey-driven; Architecture decides shapes)
1. `GET /banking` and `GET /gst`: on a decrypt failure answer 200 with an `unreadable: true` marker (banking) / `irdNumberUnreadable: true` (GST) and null masked fields, log `team.banking.decrypt_failed`; never 500 for that case.
2. `PUT /banking` response: add `wasConfigured` and `replacedAccountNumber` booleans (or equivalent) so the web picks the right banner without a second read.
3. `DELETE /banking` on an already-empty row: 200 (idempotent), no email.
4. `GET /teams/mine`: admin rows carry `payoutConfigured: boolean` from `teams.is_payout_configured` (no decrypt).
5. Change email: in the save and remove transactions, `enqueueEmail` one message per approved `TEAM_ADMIN` of the team (actor included), template `team-banking-changed`, idempotency key per change and recipient; body per the copy above; no banking value in the message, job data or logs.
6. Optional, only if Architecture adds `banking_updated_at`/`banking_updated_by`: return `lastChangedAt` and `lastChangedByName` in `GET /banking` for the summary line.

### Integration Points

| System | Interface | Data exchanged |
|---|---|---|
| auth (web) | `requireUser`, `safeReturnTo`, `sessionExpiredUrl`, `FormState`, `StripAuthParams`, `FormBanner`, `ErrorSummary` | session, `returnTo`, notices |
| team-banking API | `apiClient` banking/GST methods (shared zod contracts) | masked banking and GST views; writes |
| teams API | `GET /teams/mine` | `payoutConfigured` on admin rows |
| worker | `send-email` job | recipient, subject, plain text (no banking values) |
| session-scheduling-engine (future) | `payout_not_configured` 409 and the hand-off link contract | `teamId`, `returnTo` path |
| wallet-and-akahu-billing (future) | may report invalid Akahu credentials | a future "couldn't connect" state on this page (not designed here) |

---

## Acceptance Criteria (MANDATORY)

The spec's ACs stand except where [Spec Amendments](#spec-amendments) change them. Below, the template's mandatory criteria mapped to spec ids with this journey's refinements; new criteria are marked **new**.

### AC-ENTRY-1: Team admin finds Banking and GST from the manage area (spec, unchanged)
**Priority**: MUST
**Given** a signed-in approved `TEAM_ADMIN` on `/teams/<teamId>/manage`
**When** they look at the area nav
**Then** links "People" and "Banking and GST"; following the second opens `/teams/<teamId>/manage/banking` with the title, H1, status line and both sections
**Verification**:
- [ ] E2E: both links exist, the second navigates, `aria-current` on the right one (AC-ENTRY-3)
- [ ] E2E: a plain member gets `NoAccess` on the same URL

### AC-ENTRY-4 (new): The banking page honours a hand-off `returnTo`
**Priority**: SHOULD
**Given** an admin of a team with no banking
**When** they open `/teams/<id>/manage/banking?returnTo=/teams/<id>/sessions/<sid>/edit` (any path under `/teams/<id>/`), save valid banking details, and separately open it with `returnTo=https://evil.example/`, `returnTo=/teams/<otherId>/x` and `returnTo=/teams/<id>/manage/banking`
**Then** the first lands on `…/banking?notice=banking_saved&returnTo=…` and the banner has a link "Back to your session" to that path; `returnTo` survives a 422 and edit mode; the three invalid values produce no link and no error
**Verification**:
- [ ] Unit: `returnTo` validation table (same team prefix, not self, `safeReturnTo` rules)
- [ ] E2E: link present after save; absent for the invalid values

### AC-ENTRY-5 (new): My teams tells an admin their team isn't set up for payments
**Priority**: SHOULD
**Given** an admin of team A (no banking) and team B (banking set up), and a plain member of team A
**When** each opens `/teams`
**Then** the admin's row for A shows a link "Set up banking and GST" to `/teams/<A>/manage/banking` (accessible name includes the team name); row B does not; the member's row does not; row order is unchanged from `sortMyTeams`; `GET /teams/mine` carries `payoutConfigured` on admin rows only
**Verification**:
- [ ] Unit: My teams rendering cases
- [ ] Integration: `payoutConfigured` present for admin rows only, no decrypt performed

### AC-HAPPY-1: Admin sets up banking for the first time (spec, refined)
**Priority**: MUST
**Given** an admin of a team with `is_payout_configured = false`
**When** user performs these EXACT steps:
  1. Opens `/teams/<id>/manage/banking` (form is already shown, no "Change" click)
  2. Types account name `Rosedale Badminton Club Inc`, a valid NZ account number, merchant ID `merchant_123`, app token `tok_abc123`
  3. Presses "Save banking details"
**Then**:
  - User sees: a history-replacing redirect to `…/banking?notice=banking_saved`, banner "Banking details saved. Paid sessions can now be published." focused, the summary rows ("Account number: ending {last4}", "Akahu app token: Saved"), "Change banking details" and "Remove banking details"; the `notice` is stripped from the address bar
  - Data is: as spec AC-HAPPY-1
  - User can: change or remove; reload shows the summary without the banner
**Verification**:
- [ ] E2E: full flow on desktop and 360 px
- [ ] Integration: row and envelopes as spec
- [ ] E2E: no token or full number anywhere in the DOM after save

### AC-HAPPY-2/3: Change details, keep or replace the secret fields (spec, refined)
**Priority**: MUST
**Given** a configured team
**When** the admin clicks "Change banking details" (URL gains `edit=banking`), changes the name only and saves; then repeats with a new account number
**Then** the first shows "Banking details updated."; the second "Banking details updated. Payments now go to the account ending {new last4}."; both return to the summary; storage as spec AC-HAPPY-2 and 3
**Verification**:
- [ ] E2E: both banners
- [ ] Integration: byte-identical envelopes on keep (spec)

### AC-HAPPY-4: Remove (spec, refined)
**Priority**: MUST
**Given** a configured team with no published paid session
**When** the admin opens "Remove banking details" from the summary, confirms
**Then** redirect with `banking_removed`, banner (spec), empty not-set-up form; Cancel/Escape as spec; the remove trigger is not present in edit mode
**Verification**:
- [ ] E2E: confirm, cancel, Escape, focus return

### AC-ERROR-1: Validation error recovery (spec AC-ERROR-1 to 4, refined)
**Priority**: MUST
**Given** an admin in the banking form (first save or edit mode)
**When** they submit `12-3456-789` as the account number and a token
**Then** `ErrorSummary` focused, field message "Enter an NZ account number in the format 00-0000-0000000-00.", the typed name, number and merchant ID kept, the token field empty, edit mode and `returnTo` kept, nothing written
**Verification**:
- [ ] E2E: message, focus, values, token empty
- [ ] Unit: Server Action never returns `akahuAppToken` in `values`

### AC-ERROR-13: System error recovery (spec, refined)
**Priority**: MUST (raised from SHOULD: an outage that looks like a save would leave a team believing it can take payments)
**Given** an admin saving banking, saving GST, or confirming removal
**When** the API answers 5xx or is unreachable
**Then** E-SYS-2 (forms) or E-SYS-2b (removal, panel stays open); no success banner; no redirect; typed values kept except the token
**Verification**:
- [ ] Unit: action mapping with a mocked failure
- [ ] E2E (optional): API stopped mid-flow

### AC-ERROR-10: Removal refused while paid sessions are published (spec, refined)
**Priority**: MUST
**Given** a team with a published paid session
**When** the admin confirms removal
**Then** the panel closes, the section banner (role `alert`, focused) shows the revised `banking_in_use` copy, the summary is unchanged, and "Change banking details" still works
**Verification**:
- [ ] Integration: 409 and row unchanged (spec)
- [ ] Unit/E2E: banner copy and panel closed

### AC-ERROR-12: Unreadable saved details lead to re-entry, not a dead end (spec, amended)
**Priority**: MUST
**Given** a stored envelope that cannot be decrypted
**When** the admin opens the banking page
**Then** `GET /banking` answers 200 with `unreadable: true` and null masked fields, logs `team.banking.decrypt_failed` (reason code only); the page shows the re-entry state with all four fields required; saving all four restores the normal summary; the GST section shows its IRD-unreadable line and still works
**Verification**:
- [ ] Integration: 200 shape, log fields, no secret in body
- [ ] E2E or component test: re-entry state renders and saves

### AC-ASYNC-1: Every admin is told when payout details change (spec, amended)
**Priority**: SHOULD (raised from COULD)
**Given** a team with approved admins Aroha (actor) and Ben
**When** Aroha saves (first time, update, account change) or removes banking details
**Then** in the same transaction one `send-email` job per approved admin, Aroha included; each email names the team, the actor, the Auckland date and time, which parts changed or "removed", and links to the banking page; no account number, ending, merchant ID, token or IRD number appears in the email, `pgboss.job.data` or logs; a rolled-back change leaves no job; GST saves send nothing; the save banner adds "We've emailed the team's admins about this change."
**Verification**:
- [ ] Integration: jobs per recipient, idempotency keys, rollback leaves none
- [ ] Unit: email builder text for actor and non-actor, update/change/remove variants, name folding
- [ ] Integration (anti-stub): two different changes produce different "what changed" lines

### AC-ENTRY-6 (new; the template's AC-NAV-1): Edit mode and hand-off survive navigation
**Priority**: SHOULD
**Given** an admin in `?edit=banking&returnTo=…`
**When** they press Back, reload, or hit a session expiry and sign in again
**Then** Back leaves edit mode; reload keeps edit mode with empty write-only fields; after re-sign-in they return to the same URL (edit and `returnTo` kept) with typed values gone; no field value is ever stored in browser storage
**Verification**:
- [ ] E2E: Back and reload
- [ ] Unit: `sessionExpiredUrl` built from the full banking URL

### AC-INTEGRATION-1: Real output (spec AC-INTEGRATION-1 stands)
Real stack, real keyring, decrypted values equal input, `GET` masked, different input gives different `last4` and banner.

---

## Test Scenarios (Derived from Acceptance Criteria)

### Happy Path Tests
1. AC-ENTRY-1, 3: nav present, current area marked.
2. AC-HAPPY-1: first-time setup from the empty form.
3. AC-HAPPY-2/3: update with and without a new account number (banner variants).
4. AC-HAPPY-4: removal.
5. AC-HAPPY-5: GST registration, IRD kept and removed via the checkbox.
6. AC-ENTRY-4: hand-off `returnTo` link after save.
7. AC-ASYNC-1: emails per admin.

### Error Scenario Tests
1. AC-ERROR-1 to 7: field errors, token never echoed.
2. AC-ERROR-10: `banking_in_use` banner.
3. AC-ERROR-11: stale admin → `NoAccess`.
4. AC-ERROR-12: unreadable → re-entry.
5. AC-ERROR-13: outage keeps input.

### Edge Case Tests
1. AC-ENTRY-6: Back, reload, session expiry.
2. AC-ENTRY-5: My teams link only for admins of unconfigured teams.
3. Invalid `returnTo` values produce no link.

## Accessibility Checklist

- [ ] Keyboard: every control in DOM order; "Change …" are links; Escape closes the remove panel and returns focus
- [ ] Screen reader: one `h1`, `h2` per section; banners in `role="status"` / `role="alert"`, focused once; summary rows as a description list (`dl`) so label and value are read together
- [ ] Focus: after PRG the banner is focused; arriving in edit mode moves focus to the section heading (fragment target, `tabIndex={-1}`); after a 422 the `ErrorSummary` is focused
- [ ] Errors linked with `aria-describedby`; the "Leave blank to keep" hints linked to their inputs
- [ ] Loading announced (`loading.tsx` `role="status"`)
- [ ] No time limits beyond the session's idle expiry; no native dialogs
- [ ] 360 px: no horizontal scroll; account number and token inputs full width; buttons `min-h-11`
- [ ] Status is never colour-only ("Set up", "Not set up" are words)

## Analytics & Observability

### Key Metrics (from logs; no new metrics pipeline)

| Metric | Purpose | Target |
|---|---|---|
| Refusal → setup conversion: `team.banking.publish_gate_refused` followed by `team.banking.updated` for the same team within 24 h | Hand-off works | > 70% once session-scheduling-engine ships |
| 422 rate on first banking save, by field | Validator or copy friction (especially unknown branch) | Watch; investigate any branch-code spike |
| `team.banking.decrypt_failed` count | Key management health | 0 |
| `send-email` failures for `team-banking-changed` | Fraud signal delivery | 0 sustained |

### Instrumentation Points
- `team.banking.updated` gains `wasConfigured` and `viaHandoff` (true when the Server Action carried a valid `returnTo`) so the conversion can be measured without new events. Ids and booleans only.
- Existing spec events otherwise unchanged.

## Dependencies on the parallel creative docs

| Topic | Owner | What this journey needs |
|---|---|---|
| Akahu credential labels, format and "where to find them" | Architecture (Q3) | The field labels, the "You'll need" list wording, and the helper "Changes apply to payments taken after you save." are placeholders until Q3 settles what the two values are |
| Verify at save time? | Architecture (Q3) | If verified, add a pending state and an "Akahu didn't accept these details" field error; the status could then say "Ready to take payments." truthfully |
| Audit columns | Architecture (Q8) | Enables "Last changed {date} by {name}", the email's change id, and the optional stale-edit 409 |
| Step-up re-auth | Architecture (Q8) | Journey hook defined above; journey recommends not in v1 |
| Change email | Architecture (Q8) | Journey decision: build it (SHOULD), recipients include the actor |
| Decrypt-failure response shape | Architecture | 200 with `unreadable` (amended AC-ERROR-12) |
| Unknown bank/branch policy | Algorithm (Q1) | The 422 message wording; if "accept on check digit alone", that message only fires for unknown bank codes |
| Layout, control design, final copy, current-area marking, InlineConfirm generalisation | UI/UX (Q7, Q9) | Every "(proposed)" string, the summary `dl`, the IRD removal control |

## Validation Checklist

- [x] Journey delivers stated value (paid sessions publishable; money routed to the team's account)
- [x] All personas can complete it (admin; co-admin informed; free-only admin not blocked or nagged)
- [x] Errors are recoverable (including decrypt failure, which the spec left as a dead end)
- [x] Async states are clear (email; publish hand-off with a way back)
- [x] Consistent with existing patterns (PRG notices, InlineConfirm, NoAccess, A7 rule, security-notice email)
- [x] Accessible per requirements (no traps, no native dialogs, 360 px)
- [x] Testable with defined scenarios

## Next Steps

1. Reconciliation step in the task file: fold the amendments below, together with the Architecture, Algorithm and UI/UX decisions they depend on.
2. Phase 2: `GET` degraded `unreadable` shape, `PUT` response flags, idempotent `DELETE`, `payoutConfigured` on `GET /teams/mine`, the change email in the write transactions.
3. Phase 3: write the hand-off contract into ADR 0016.
4. Phase 4: the page states (empty, summary, edit, unreadable), PRG notices, `returnTo`, My teams link, InlineConfirm generalisation.
5. Phase 5: Playwright for the summary, edit, re-entry, hand-off and removal-refused states on both viewports.

---

## Spec Amendments

Recommendations for the reconciliation step; the task file is not edited here. "(proposed)" copy is final only after the UI/UX doc.

| AC / section | Change |
|---|---|
| Invocation Method, Contract | Successful writes `redirect(replace)` to `/teams/<id>/manage/banking?notice=<code>` (keeping `returnTo`) instead of in-place `revalidatePath`. Notice codes: `banking_saved`, `banking_updated`, `banking_account_changed`, `banking_removed`, `gst_saved`. Edit mode is URL state `?edit=banking|gst`. |
| Success Criteria, status line (configured) | "Ready to take payments." → "Set up. Paid sessions can be published." (proposed): nothing is verified with Akahu in this feature. Keep the spec text only if Architecture adds save-time verification. |
| Success Criteria, banners | Add `banking_updated` "Banking details updated." and `banking_account_changed` "Banking details updated. Payments now go to the account ending {last4}." (proposed). `banking_saved` keeps the spec text and gains "Back to your session" when `returnTo` is valid. With AC-ASYNC-1 built, payout banners add "We've emailed the team's admins about this change." |
| Success Criteria, `banking_in_use` copy | → "You have published paid sessions, so banking details can't be removed yet. Cancel those sessions or wait until they've finished. To switch to a different account, use Change banking details instead." (proposed) |
| Success Criteria, page intro (new) | "Players pay session fees straight into this account through Akahu. You only need this if your team charges for sessions." (proposed, wording subject to Q3) |
| AC-ENTRY-4 (new, SHOULD) | Banking page accepts and validates `returnTo` (same team prefix, not self, `safeReturnTo`), keeps it through edit, 422 and save, and shows "Back to your session" after `banking_saved`. |
| AC-ENTRY-5 (new, SHOULD) | `GET /teams/mine` admin rows carry `payoutConfigured`; My teams shows "Set up banking and GST" on unconfigured admin rows; order unchanged. |
| AC-ENTRY-6 (new, SHOULD) | Edit mode and `returnTo` survive reload and the session-expiry round trip; Back leaves edit mode; no field value in browser storage. |
| AC-HAPPY-1 | Not-set-up state shows the form directly; success is the PRG banner plus the read-only summary. |
| AC-HAPPY-2, AC-HAPPY-3 | Edits start from "Change banking details" (`?edit=banking`); banner variant per whether the account number was replaced. `PUT /banking` response adds `wasConfigured` and `replacedAccountNumber`. |
| AC-HAPPY-4 | "Remove banking details" lives in the summary view only (not in edit mode). `DELETE` on an already-empty row answers 200 with no email. |
| AC-HAPPY-5 | Add: a saved IRD number can be removed through an explicit "Remove the saved IRD number" control (sends `irdNumber: null`); the IRD input is write-only with a "Leave blank to keep the saved number (ending {last3})." hint; when GST is off, the summary still lists a saved GST number. |
| AC-ERROR-10 | Web: the InlineConfirm panel closes, the revised copy shows in a focused `role="alert"` section banner, summary unchanged. |
| AC-ERROR-12 | `GET /banking` and `GET /gst` answer **200** with an `unreadable` marker (null masked fields) instead of 500 on a decrypt failure, so the re-entry form is reachable; the web requires all four banking fields in that state. Log event unchanged. |
| AC-ERROR-13 | Priority SHOULD → MUST; also covers removal (panel stays open, E-SYS-2b). |
| AC-ASYNC-1 | Priority COULD → SHOULD. Recipients: every approved `TEAM_ADMIN` including the actor. Content as in [Trust and fraud](#trust-and-fraud-what-admins-are-told) (who, when, which parts, link, what to do; no banking values). GST saves send no email. Template `team-banking-changed`, idempotency key per change and recipient. |
| AC-VERIFY-4 | `team.banking.updated` adds `wasConfigured` and `viaHandoff` (booleans). |
| AC-VERIFY-13 | Walk the summary, edit, unreadable (re-entry), hand-off (`returnTo`) and removal-refused states as well, on both viewports. |
| AC-VERIFY-14 | ADR 0016 includes the [hand-off contract](#hand-off-contract-for-session-scheduling-engine) (draft kept, message, link with `returnTo`, no auto-return, recurrence refusal surfaced on the series). |
