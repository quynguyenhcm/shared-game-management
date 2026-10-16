# UI/UX Decision: Banking and GST Team-Admin Area

**Created**: 2026-10-16
**Status**: DECIDED
**Decision Type**: UI/UX
**Task**: team-banking-and-gst (Level 3)
**Answers**: Creative Q7 (what admins can read back; write-only field behaviour), Q9 UX half (one page or sub-pages; how the area nav marks the current area; a "Banking not set up" hint on My teams), and Q10 copy (final copy table).
**Defers to**: journey agent (discovery, hand-off from the publish refusal), architecture agent (audit, notification, Akahu labels: the spec's labels are used), algorithm agent (validation rules).

Sources read: task file (branch tip, whole), `team-management-team-admin-uiux.md`, `apps/web/src/app/teams/[teamId]/manage/{layout,page}.tsx`, `app/teams/page.tsx`, `components/teams/{inline-confirm,manage-section,manage-context,invite-link-panel,create-team-form,team-form-banner,use-moderation-action}`, `components/auth/{use-auth-form,text-field,form-banner,error-summary,styles}`, `lib/auth/form-state.ts`, `lib/teams/{manage-areas,manage-state,moderation,actions}.ts`, `techContext.md` (main). `memory-bank/ux-patterns.md` does not exist, so the team-management components above are the pattern source. `productBrief.md` and `systemPatterns.md` were not re-read in full: the stack facts used here (Next 16, React 19, Tailwind 4, `.tsx` under `app/**` and `components/**`, `.ts` under `lib/**`) come from `techContext.md` and the files read.

## User Context

### Target Users
- **Primary**: Team Admin (`TEAM_ADMIN`). A volunteer club organiser, often on a phone, who sets this up once (usually while preparing the first paid session) and returns rarely: to fix a typo, rotate the token, or toggle GST. Anxious about typing bank details and unsure what the Akahu fields are. Wants to see that the details were saved without having them displayed back to anyone looking over their shoulder.
- **Secondary**: a second admin of the same team, who opens the page to check that "we are ready to take payments" and is the person most likely to notice an unexpected change. Developers of session-scheduling-engine, who link here from the publish refusal.

### User Goals
1. Get from "Not set up" to "Ready to take payments" in one sitting, without a wizard and without losing typed input to an error.
2. Know what is saved without seeing the secrets again (the full account number, the token, the IRD number).
3. Change one thing (name, merchant ID, GST on or off) without retyping the secrets.
4. Remove banking details deliberately, with a clear consequence, and recover cleanly if something is unreadable.

### Use Cases
| Use Case | User | Goal | Frequency |
|----------|------|------|-----------|
| First-time banking setup | Team Admin | Add name, number, merchant ID, token | Once per team |
| Edit name or merchant ID, keep secrets | Team Admin | Fix a typo | Rare |
| Replace account number and token | Team Admin | New account or rotated token | Rare |
| Remove banking | Team Admin | Stop taking payments | Very rare |
| Register for GST | Team Admin | Add GST number, optionally IRD number | Once, then rare |
| Turn GST off or on | Team Admin | Reflect a registration change | Very rare |
| Recover from unreadable saved details | Team Admin | Re-enter all four | Exceptional |
| Check status | Second admin | See "Ready" | Rare |

### Constraints
- **Devices**: desktop and 360 x 740 phone (the two Playwright projects); no horizontal scroll at 360 px; 44 px tap targets (`min-h-11`); 16 px input text.
- **Accessibility**: AC-VERIFY-13: axe has no critical or serious violation; every input has a visible label; errors linked by `aria-describedby`; focus to the first error or the banner; no native dialogs. WCAG 2.2 AA working target, as in team-management.
- **Languages and locale**: English only. NZ formats (`00-0000-0000000-00`, IRD `123-456-789`).
- **Existing patterns that must be reused** (no new colours, fonts or dependencies): `components/auth/styles.ts` classes; `TextField`, `FieldError`/`describedBy`, `ErrorSummary` (focus on failed submit, "Error: " title prefix), `FormBanner`, `useAuthForm` (client validate, then Server Action, typed values refilled via `defaultValue`, secrets excluded); `ManageSection` (`h2` focus target + persistent `role="status"` region), `ManageProvider` and its `result` events; `InlineConfirm` (disclosure, not a dialog); `SubmitButton`; plain `<a href>` links in the area nav.
- **Guiding principles**: the API is the authority, the UI never hides a rule it cannot prove; P4 (secrets never echoed, never logged); no optimistic updates; `revalidatePath` only after a successful change.

## User Flow

### Flow Diagram
```
My teams --Manage--> /teams/<id>/manage (People)
                        |  area nav: [People] [Banking and GST]
                        v
              /teams/<id>/manage/banking
   +--------------------+----------------------------------+
   | Status line (Not set up | Ready | Needs attention)     |
   +--------------------+----------------------------------+
   | Bank account and Akahu                                 |
   |   (configured: summary list)                           |
   |   form: name, number, merchant ID, token               |
   |      Save --> ok: status "Banking details saved..."    |
   |            --> field errors: ErrorSummary, typed values|
   |                kept (token never), focus on summary    |
   |            --> 5xx: banner, typed values kept, no save |
   |   [Remove banking details] --> InlineConfirm           |
   |        Confirm --> ok: "Banking details removed..."    |
   |                --> 409 banking_in_use: banner, panel   |
   |                    closes, nothing changed             |
   +--------------------------------------------------------+
   | GST                                                    |
   |   summary + form: [x] registered -> GST number,        |
   |   IRD number (optional)  Save --> "GST settings saved."|
   +--------------------------------------------------------+
```

### Flow Description
1. **Entry**: area nav link "Banking and GST" on the People page (the nav now exists because two areas exist), a bookmark, or (later) the link from the publish refusal. Not an admin: the existing `NoAccess` page with no nav and no banking content.
2. **Read**: H1, the one-line status, then the two sections. A configured team sees a summary list first and the (blank-secret) form below; an unconfigured team sees only the form.
3. **Act**: fill, press "Save banking details" or "Save GST settings". Each section saves independently; a GST save never touches banking and the reverse.
4. **Decision points**: leave secrets blank to keep them; register for GST (reveals the GST number field); remove banking (inline confirm).
5. **Exit**: nothing leaves the page. Success is confirmed in the section's status region, and focus lands on that section's heading.

### Error States
| Error | Cause | User Recovery |
|-------|-------|---------------|
| Client validation failure | Empty, wrong shape, check digit, over-length (same shared validators as the API) | `ErrorSummary` takes focus ("There's a problem", one link per field), field errors beside inputs; typed name, number, merchant ID kept; token cleared with a re-enter hint |
| 422 from the API (bank not recognised, check digit, strict body) | Server-side rules the client did not catch | Same presentation as above, from `fieldErrors`; nothing saved |
| 403 on load | Not an approved admin | Existing `NoAccess` page (no nav) |
| 403 on save | Demoted or banned since load | Banner "You don't have access to manage this team." and the page re-renders as `NoAccess` after revalidation |
| 409 `banking_in_use` | A published paid session exists | Banner with the spec copy, confirm panel closes, nothing changed; trigger stays |
| 5xx or network on save | API down | Banner (banking-specific outage copy), typed values kept except the token, no success message, no revalidation |
| 5xx on load | API down | Existing error boundary (`app/teams/error.tsx`) with retry |
| Saved details unreadable (decryption failure) | Missing key id or corrupted bytes | Page still renders: status "Needs attention", recovery notice, all four fields required, no summary values. This requires the API change in Spec Amendments 4; a generic error page would leave the admin with no way to re-enter the details (AC-ERROR-12 says re-entry restores the page) |
| Clipboard, paging | n/a | Not applicable to this page |

## Options Explored

### Option 1: One page, two sections, summary plus an always-visible form (CHOSEN)
- **Approach**: `/manage/banking` holds two `ManageSection`s (`banking`, `gst`). Each section shows a read-back summary when something is saved, and always shows its form directly below with the secret inputs empty. No view/edit modes. The "Remove banking details" control sits under the banking form.
- **Wireframe/Layout** (desktop, configured, Banking section):
  ```
  Banking and GST for Rosedale Badminton                                       (h1)
  Only team admins can see this page. We show only part of your account number,
  and the Akahu app token is never shown again once saved.

  Ready to take payments.                                                      (status line)

  Bank account and Akahu                                                       (h2)
  [status region]   Banking details saved. Paid sessions can now be published.
  ┌─────────────────────────────────────────────────────────────┐
  │ Account name          Rosedale Badminton Club               │
  │ Account number        ending 7800                           │
  │ Akahu merchant ID     merch_8f2k1                           │
  │ Akahu app token       Saved                                 │
  └─────────────────────────────────────────────────────────────┘
  Account name
  [ Rosedale Badminton Club                          ]
  Account number
  Leave blank to keep the saved value. To replace it, use 00-0000-0000000-00.
  [                                                  ]
  Akahu merchant ID
  [ merch_8f2k1                                      ]
  Akahu app token
  Leave blank to keep the saved value.
  [ ••••••••                                         ]  (empty, type=password)
  [Save banking details]
  [Remove banking details]   (secondary button; opens the inline confirm)

  GST                                                                          (h2)
  [status region]
  ┌─────────────────────────────────────────────────────────────┐
  │ GST                   Registered                            │
  │ GST number            123-456-789                           │
  │ IRD number            Saved                                 │
  └─────────────────────────────────────────────────────────────┘
  [x] This team is registered for GST
      Players' prices include GST. GST is worked out as 3/23 ...
      GST number          [ 123-456-789        ]
      IRD number (optional)  Leave blank to keep the saved value.
                          [                    ]
                          [ ] Remove the saved IRD number
  [Save GST settings]
  ```
- **User Flow**: read status, act in place; each save is announced in its own section; a failed save keeps the form as typed.
- **Pros**:
  - Mirrors People (same shell, `ManageSection`, status regions, `InlineConfirm`), so no new interaction vocabulary.
  - No edit-mode state: nothing to forget to open, nothing hidden from the error summary, a failed save leaves the same form on screen.
  - The "leave blank to keep" contract is visible exactly where it applies.
  - Works with the existing `useAuthForm` and `ManageProvider` with small extensions.
- **Cons**:
  - Longer page on a phone when configured (summary, then form).
  - A configured admin sees an editable form they did not ask for (mitigated by the summary and clear hints).
- **Usability**: High. **Accessibility**: High. **Implementation Complexity**: Low to Medium.

### Option 2: Two sub-pages (`/manage/banking` and `/manage/banking/gst`, or a third area "GST")
- **Approach**: banking and GST each get a route; area nav grows to three links.
- **Pros**: short pages; separate loads (a GST read never depends on banking decryption).
- **Cons**: contradicts the spec's pinned single route with two sections (`id="banking"`, `id="gst"`); two Server Action contexts, loading and no-access branches for two small forms; three nav links for one concept ("how the team gets paid"); the status line ("Ready to take payments") would need repeating or be hidden. The decryption-isolation benefit is better got by dropping the IRD decrypt (see Q7).
- **Usability**: Medium. **Accessibility**: High. **Implementation Complexity**: Medium to High.

### Option 3: One page, summary cards with an explicit Edit mode per section
- **Approach**: each section is a read-only card with an "Edit" button that swaps in the form (and "Cancel" back).
- **Pros**: short configured page; accidental edits impossible; matches many settings UIs.
- **Cons**: two modes times two sections is client state the repo does not have today; Edit and Cancel need focus handling (trigger to first field, back to trigger); a validation error must keep the form open across a revalidation; JS-dependent (the form would not exist without it); the hidden form makes "first setup" a two-step (press Edit, then fill) for the most common case.
- **Usability**: Medium. **Accessibility**: Medium (focus choreography). **Implementation Complexity**: Medium to High.

### Option 4: First-time wizard (steps: bank account, Akahu, GST) then a summary page
- **Approach**: a stepper for setup; afterwards the summary-with-edit variant.
- **Pros**: reduces the intimidation of four unfamiliar fields.
- **Cons**: banking is saved as one block (no half-configured state), so steps cannot be saved separately; client state spans steps and must hold typed values but not the token across steps; two UIs to maintain (wizard and settings); the product has no wizard pattern. Overbuilt for four fields.
- **Usability**: Medium. **Accessibility**: Medium. **Implementation Complexity**: High.

### Sub-decision A: how the area nav marks the current area (Q9)
| Variant | How | Verdict |
|---------|-----|---------|
| (a) Client `usePathname` nav in `manage/layout.tsx` | Layout stays shared; nav reads the path | Rejected: the layout renders before any guard, so a non-admin on the `NoAccess` page would see live-looking "People" and "Banking and GST" links that lead back to `NoAccess`. AC-ENTRY-2 says such a caller sees nothing. Adds a client component for what is two links. |
| (b) Per-page nav, current passed as a prop (CHOSEN) | `components/teams/manage-area-nav.tsx` (server component) rendered by each area page after its guard passes: `<ManageAreaNav teamId current="banking" />`. `manageAreaLinks(teamId, MANAGE_AREAS, current)` already takes `currentId`. `layout.tsx` keeps only the `<main>` shell. | Chosen: no client JS, correct on first byte, never shown on `NoAccess`, trivially testable. Costs: each future area page must render it (guarded by a registry test, below) and the nav is briefly absent while `loading.tsx` shows. |
| (c) Parallel route `@nav` or layout prop | Slot-based nav | Rejected: Next layouts cannot receive per-page props; a parallel slot adds `default.tsx` and routing files for two links. |

A cheap guard against a future area forgetting the nav: `manage-areas.test.ts` asserts, for every registry segment, that `app/teams/[teamId]/manage/<segment>/page.tsx` (and `page.tsx` for the root segment) contains `ManageAreaNav` (a file read, no rendering).

### Sub-decision B: "Banking not set up" hint on My teams (Q9)
Decided: **no hint in this feature.** Reasons: it needs a new field on `MineTeamsResponse` (a team-management contract) and a second signal in a row that already carries "Manage" and the pending-requests link; a team that only runs free sessions would carry a permanent nag; the right moment is the publish refusal (session-scheduling-engine), which links straight to this page. Revisit when that feature lands, using the real refusal rate. No `MineTeamsResponse` change in this task.

### Sub-decision C: what admins can read back (Q7)
| Value | Read back | Write-only behaviour |
|-------|-----------|----------------------|
| Account name | Full (decrypted), in the summary and prefilled in the form | Editable, always sent |
| Account number | `ending {last4}` only | Input empty; blank keeps; typed value re-echoed after a validation error (typed in this submit only; never the stored value) |
| Akahu merchant ID | Full, prefilled | Editable, always sent |
| Akahu app token | `Saved` | Input empty (`type=password`); blank keeps; never re-echoed after any error, client or server; a short re-enter hint appears when a token was typed in a failed submit |
| GST number | Full, formatted `123-456-789` (it is public and printed on invoices), prefilled formatted | Editable |
| IRD number | **`Saved` / `Not saved`** (spec: `ending {last3}`; changed, see below) | Input empty; blank keeps; a "Remove the saved IRD number" checkbox sends `null`; typed value re-echoed after a validation error like the account number |

**Why re-echo the account number and IRD number but not the token**: they are identifiers the person typed seconds ago and the most likely thing to be mistyped (a 15 to 16 digit number); forcing a full retype after a check-digit failure is the main way this form fails. The token is a credential, not something a person transcribes by sight, and `type=password` hides it, so a refill would only create a hidden copy in the response; re-pasting is cheap. The echoed values go only into `defaultValue` of the same form, never into a URL, log or cookie, and the page is `no-store`.

**Why IRD shows "Saved" instead of "ending 182"** (my recommendation on the open question "is the IRD last 3 worth a decrypt on every GST page load"): in NZ the GST number is the IRD number, and this page shows the GST number in full beside it, so masking the IRD number's last digits protects nothing and the three digits give the admin nothing they can act on. Dropping the read-back removes the only decrypt on the GST read path, so a key problem can no longer break the GST section (AC-ERROR-12 then concerns the account name only), and it matches how the token is shown. Cost: AC-HAPPY-5 and the copy deck change (Spec Amendments 3). If the product owner wants the last 3 kept, the fallback is a per-field degrade (show "Saved" and log `team.banking.decrypt_failed`) instead of failing the page.

## Evaluation Matrix

(Scores 1 to 5, higher is better.)

| Criteria | Option 1 | Option 2 | Option 3 | Option 4 |
|----------|----------|----------|----------|----------|
| Usability (first setup, fix a typo) | 5 | 3 | 3 | 3 |
| Accessibility (focus, error handling, fewer modes) | 5 | 4 | 3 | 3 |
| Consistency with existing patterns | 5 | 3 | 3 | 2 |
| Responsiveness (360 px) | 4 | 5 | 4 | 3 |
| Performance (one load; decrypt scope) | 4 | 4 | 4 | 4 |
| Implementation effort (5 = easy) | 4 | 3 | 2 | 1 |
| Fit with the spec (pinned route, section ids, ACs) | 5 | 1 | 4 | 2 |
| **Total (of 35)** | 32 | 23 | 23 | 18 |

## Decision

**Chosen**: Option 1 - One page, two sections, summary plus an always-visible form; per-page area nav with the current area as a prop; no My teams hint; IRD number read back as "Saved".

### Rationale
- It is the smallest design that satisfies every AC and reuses the whole People vocabulary: the same `ManageSection`, status regions, `InlineConfirm` and focus rules.
- Always-visible forms make the "leave blank to keep" contract (omit equals keep, an API rule) visible exactly where it applies, and a failed save leaves the same form on screen with the admin's typing intact.
- The per-page nav is the only variant that cannot show area links to someone who is not an admin, and needs no client component.
- Not echoing the token, and not displaying the IRD number or the full account number, follows the privacy intent of the spec (NZ Privacy Act 2020) without making the common typo-fix path painful.

### Trade-offs Accepted
- **Longer configured page on phones**: summary plus form. Mitigated by short summary rows and no extra sections; no jump list is added for two sections.
- **Token must be re-entered after any failed submit that included one**: a deliberate cost. Mitigated by the re-enter hint and by client validation catching most errors before submit (client failures never leave the browser).
- **Nav absent while `loading.tsx` shows**: a small layout shift on navigation between areas. Accepted for the guard-correctness above.
- **JavaScript required**: as with the rest of the manage area (`InlineConfirm` already needs it; the forms use client validation and the GST reveal). Without script nothing destructive can happen.
- **No proactive "removal blocked" state**: the page does not know about published paid sessions (none can exist until session-scheduling-engine ships); the 409 banner is the only signal.

## Design Specifications

### Layout
- **Shell**: the existing `manage/layout.tsx` `<main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8">` (nav moves out of it, see Spec Amendments 1). Page order: `ManageAreaNav`, `h1`, one-line intro, status line, `ManageSection id="banking"`, `ManageSection id="gst"`.
- **Desktop and tablet**: single column, form fields `max-w-xl` inside the section; summary list as a two-column `dl` (`grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1`) inside a `rounded-md border border-slate-300 p-4` box; buttons auto width side by side (`sm:flex-row`, `sm:w-auto`).
- **Mobile (360 px)**: summary `dl` stacks (label above value); inputs full width; Save and Remove buttons full width and stacked (Save first); values and the account name use `break-words`; the GST reveal indents with `pl-0` (no left indent below `sm`).
- **Status line**: a bordered paragraph with a bold lead, text only (not colour only): `<strong>Not set up.</strong> Paid sessions can't be published until you add your bank account and Akahu details.` or `<strong>Ready to take payments.</strong>` or `<strong>Needs attention.</strong> We couldn't read your saved bank details. Enter all four again to fix this.` Border `border-slate-900` for all three states; the text carries the meaning. Red is not used: "Not set up" is a normal initial state, not an error, and red would make a new team look broken.

### Key Components
| Component | Purpose | Behavior |
|-----------|---------|----------|
| `ManageAreaNav` (server) | Area nav with `aria-current` | `<nav aria-label="Team admin areas">` from `manageAreaLinks(teamId, MANAGE_AREAS, current)`; plain `<a>`; current link: `aria-current="page"`, `font-semibold`, thicker underline (`decoration-2`) so it is not colour-only; renders nothing with fewer than two areas |
| `BankingSummary` (server) | Read-back list | `dl`: Account name, Account number `ending 7800`, Akahu merchant ID, Akahu app token `Saved`; omitted when not configured; in the unreadable state shows only the merchant ID (the name is the unreadable value) |
| `BankingForm` (client) | Four inputs, Save, Remove | Uses `useSettingsForm` (below); `TextField` for name, number, merchant ID, token; `ErrorSummary` at the top of the form; hidden `key` from saved values so it remounts with fresh defaults after a successful save |
| `RemoveBankingConfirm` | Removal | `InlineConfirm` with `section="banking"`, `destructive`, `focusOnSuccess` default (the section heading); rendered only when configured |
| `GstSummary` (server) | Read-back | `dl`: GST (Registered or Not registered), GST number `123-456-789` (when saved; when off, labelled "Saved GST number" with the hint "Not used while GST is off."), IRD number `Saved` or `Not saved` |
| `GstForm` (client) | Toggle, GST number, IRD number, Save | Checkbox "This team is registered for GST"; the GST number and IRD number inputs render only while checked (omitted from the submit when hidden, which the API reads as "keep"); `GstFields` child keyed by `form.state` so the checkbox state is re-seeded after each result (React 19 resets the form after an action) |
| `useSettingsForm` (hook) | `useAuthForm` plus section reporting | Wraps the Server Action so the result is also dispatched to `ManageProvider` (`result` event with `section`, message, ok, and `focus: '#<section>-heading'` on success); field errors and typed values stay in `useAuthForm` state |

### Interactions
| Trigger | Action | Feedback |
|---------|--------|----------|
| Press "Save banking details" with client errors | No request | `ErrorSummary` focused; field errors; token cleared and re-enter hint shown if one was typed; number, name, merchant ID refilled |
| Save succeeds | Server Action then `revalidatePath(manage/banking)` | Section status "Banking details saved. Paid sessions can now be published."; focus to the "Bank account and Akahu" heading; form remounts with the saved name and merchant ID, secrets empty; status line flips to "Ready to take payments." |
| Save returns 422 | Same as client errors, from `fieldErrors` | Same |
| Save returns 5xx or offline | Nothing saved, no revalidate | Error banner (banking outage copy), focused once; typed values kept except the token; form not remounted |
| Leave number and token blank on a configured team | Omitted from the body (API keeps them) | Same as a normal save |
| Leave number or token blank on first setup | Client error `Enter the account number.` or `Enter your Akahu app token.` | `ErrorSummary` |
| Press "Remove banking details" | `InlineConfirm` opens under the button, focus to the prompt (existing behaviour); `aria-expanded` on the trigger | Prompt: "Remove banking details? Paid sessions can't be published until you add them again." |
| Confirm removal succeeds | Server Action, revalidate | Status "Banking details removed. Paid sessions can't be published until you add them again."; focus to the banking heading; summary and trigger disappear; form shows empty; status line "Not set up." |
| Confirm removal 409 `banking_in_use` | Nothing changes | Panel closes (terminal failure, see Spec Amendments 11), error banner with the spec copy, focus to the banner; trigger remains |
| Confirm removal 5xx | Nothing changes | Panel stays open (existing behaviour for 5xx), banner "Something went wrong on our side and nothing was removed. Try again in a minute." |
| Cancel or Escape | Panel closes | Focus returns to the trigger; nothing changes |
| Tick "This team is registered for GST" | GST number and IRD fields appear after the checkbox | No focus move (the next Tab stops on the GST number); helper text switches to the registered wording |
| Untick it | Fields disappear (their typed values are dropped) | Helper switches to the off wording; saving sends `gstRegistered=false` only, so the saved GST number and IRD number are kept (AC-HAPPY-6) |
| Save GST with the toggle on and no GST number anywhere | Client error `Enter your GST number to register for GST.` linked to the GST number field | `ErrorSummary` for the GST section |
| Save GST succeeds | Revalidate | Status "GST settings saved."; focus to the "GST" heading |
| Tick "Remove the saved IRD number" | The IRD input disables and empties | Saving sends `irdNumber: null`; summary shows "Not saved" |
| Pending submit | Button `aria-disabled`, label "Saving…" or "Removing…" | Second click ignored (existing `SubmitButton` and confirm behaviour) |

Notes:
- Status regions are the existing persistent `role="status"` region in each `ManageSection` (present empty from first render). Success messages stay until the next action in that section (no auto-dismiss, WCAG 2.2.1).
- **React 19 form reset**: after a Server Action completes React resets the form's uncontrolled inputs to their `defaultValue`s. The existing forms (`create-team-form.tsx`) survive this because they pass `defaultValue={values.x}` taken from the action state, and `useAuthForm` excludes the secret field names. The banking forms follow that rule (`secretFields = ['akahuAppToken']`; the account number and IRD number are not in the secret list because they are echoed on purpose), and fix two traps: (1) after a *successful* save the new defaults are the revalidated props, so the form is `key`ed on the saved values (name, merchant ID, last4, token-set, gst fields) to remount with them; (2) controlled bits (the GST checkbox, the "Remove IRD" checkbox) are re-seeded by keying `GstFields` on `form.state`.
- Server Actions never log field values; log only `action`, `status`, `code` (as `web.teams.api_failure`, same as `actions.ts`).

### Responsive Behavior
| Breakpoint | Changes |
|------------|---------|
| < 640px | Summary `dl` stacks; inputs and buttons full width, stacked; area nav wraps (`flex-wrap`); no left indent for the GST reveal |
| 640-1024px | Summary two columns; buttons side by side; fields `max-w-xl` |
| > 1024px | Same as tablet inside `max-w-3xl` |

### Input attributes
| Field | Attributes |
|-------|-----------|
| Account name | `type=text`, `autoComplete="off"`, `autoCapitalize="words"`, label "Account name" |
| Account number | `type=text`, `inputMode="numeric"`, `autoComplete="off"`, `spellCheck={false}`; hyphens and spaces accepted; no `maxlength`, no input masking (a mask fights paste and the 2- or 3-digit suffix) |
| Akahu merchant ID | `type=text`, `autoComplete="off"`, `spellCheck={false}`, `autoCapitalize="none"` |
| Akahu app token | `type=password`, `autoComplete="new-password"` (see Spec Amendments 5), `spellCheck={false}`, `autoCapitalize="none"`, `autoCorrect="off"`, `data-1p-ignore`, `data-lpignore="true"`; no show/hide control in v1 |
| GST number | `type=text`, `inputMode="numeric"`, `autoComplete="off"`, prefilled formatted |
| IRD number | `type=text`, `inputMode="numeric"`, `autoComplete="off"`, `spellCheck={false}` |

No input has `maxlength` (a too-long value must be explained, as in team-management). `TextField` currently supports only `type` text or email and no `inputMode` or `spellCheck` for other types; extend it (see Implementation Guidelines).

### Accessibility Requirements
- [ ] Keyboard: nav, fields, Save, Remove, confirm panel, Cancel in DOM order; Enter submits; Escape closes the confirm and returns focus to the trigger
- [ ] Screen reader: one `h1`; each section `h2` (focus target); summaries as `dl` with `dt` labels; status regions persistent; errors `role="alert"` focused once; the nav is a `nav` with `aria-label`; `aria-current="page"` on exactly one link
- [ ] Every input has a visible `label` (no placeholder labelling); hints and errors tied with `aria-describedby`; the GST checkbox has its label as the accessible name and its helper text linked
- [ ] Color contrast: reuse `slate-900/700`, `blue-800`, `red-800`; no colour-only state (status line text, bold current link)
- [ ] Focus indicators: `FOCUS_RING` on every control
- [ ] Error messages accessible: summary with links to `#field-<name>`, field errors beside the field, "Error: " title prefix via `ErrorSummary`
- [ ] 44 px targets (`min-h-11`), 16 px input text, no horizontal scroll at 360 px (`break-words` on name and ID values)
- [ ] No native dialogs; `InlineConfirm` is a non-modal `role="group"`
- [ ] Page sets `robots: noindex` and `dynamic = 'force-dynamic'`, response `no-store` (the `/teams/*/manage` proxy rule already covers it; assert it)
- [ ] The token and account number inputs satisfy the attribute table above (AC-VERIFY-13 as amended)

## Implementation Guidelines

### For Developers
1. **Extend, don't fork**: `SectionId` in `lib/teams/manage-view.ts` gains `'banking'` and `'gst'`; `manage-state.ts` `empty()` gains the keys (the reducer record is typed over `SectionId`); `sectionHeadingId` keeps the `<id>-heading` shape. The banking page wraps its content in `ManageProvider`.
2. **Generalise `InlineConfirm` minimally**: it is typed to `ModerationKind` and `sectionFor`, and `useModerationAction` maps API codes through `toModerationResult` (membership copy). Replace the `kind` prop with `section: SectionId` (the three existing call sites pass `sectionFor('ban')` etc.) and give `useModerationAction` the section instead of the kind (rename to `useSectionAction` if desired). Banking actions return the same `{ ok, message, code?, refresh, fieldErrors? }` shape (alias the type as `ActionResult`), built by a banking-specific mapper, not `toModerationResult`.
3. **Terminal-failure close**: add an optional `close?: boolean` to the manage `result` event; the reducer closes the section's open confirm when `event.ok || event.close`. Banking sets `close: true` for `banking_in_use` and `forbidden`; 5xx leaves the panel open.
4. **`useSettingsForm(action, validate, section, secretFields)`**: wraps `useAuthForm`; its action wrapper awaits the Server Action, then dispatches `{ type: 'result', section, message, ok, focus }` when the result carries a `saved` message or a page-level error. Field errors and values stay in `useAuthForm` state. Extend `FormState` locally (`BankingFormState = FormState & { saved?: string }`) rather than editing the auth type.
5. **Server Actions** (`lib/teams/banking-actions.ts`, `'use server'`): `saveBankingAction`, `removeBankingAction`, `saveGstAction`, same shape as `actions.ts` (`requireSession`, `apiClient`, 401 to `sessionExpiredUrl`, never optimistic). Build the body by omitting a blank account number or token (omit equals keep), always sending name and merchant ID; for GST send `gstRegistered`, and `gstNumber` and `irdNumber` only when their inputs were present and non-blank; `irdNumber: null` when "Remove" was ticked. Return `values` without the token. `revalidatePath` only on a 2xx or a 403.
6. **Client validation**: `validateBankingForm(values, { hasSavedNumber, hasSavedToken })` and `validateGstForm(values, { hasSavedGstNumber })` in `lib/teams/banking-view.ts`, calling the shared `nz` validators and `BANKING_FIELD_MESSAGES` (same strings as the API, AC-VERIFY-11). A blank number or token is valid only when a saved value exists; the API stays the authority.
7. **Page** (`manage/banking/page.tsx`): copy the People page skeleton (`requireUser`, session cookie, `apiClient` calls in parallel: `teamDetail`, `bankingGet`, `gstGet`; 401 to sign-in, 403 to `NoAccess`, 422 to `notFound`, other failures to the error boundary). `NoAccess` is shared: move it out of `manage/page.tsx` into `components/teams/no-access.tsx` so both pages use it. Title: `Banking and GST – {team name} – Shared Game Management`. H1: `Banking and GST for {team name}`.
8. **Formatting**: add `formatIrdNumber(digits)` (groups of three from the right: 9 digits `123-456-789`, 8 digits `49-091-850`) to `packages/shared/src/nz/ird-number.ts`; render the GST number with it; `ending {last4}` comes from the API's `accountNumberLast4`.
9. **Area nav**: remove the nav from `manage/layout.tsx`; render `<ManageAreaNav teamId current="people" />` at the top of the People page content (only after its guard passes) and `current="banking"` on the banking page; extend `manage-areas.test.ts` with the file-presence guard.
10. **Keying for remount**: `key` the banking form on `[accountName, merchantId, last4, tokenSet].join('|')` and the GST form on `[registered, gstNumber, irdSet].join('|')`; key `GstFields` on `form.state`.
11. **No My teams change** and no `MineTeamsResponse` change (decision B).
12. **Tests** (Phase 4 and 5): unit tests for `manageAreaLinks` current marking, `validateBankingForm` (blank allowed only when saved), `formatIrdNumber`, banking-actions body building (omit equals keep, token never returned, no revalidate on failure); component tests for the nav (exactly one `aria-current`), the GST reveal (and re-seed after an error), the token field attributes and the unreadable state; Playwright (desktop and 360 px): empty, configured, validation error (typed number kept, token cleared, hint shown), removal confirm (Escape returns focus), no nav on `NoAccess`, axe on each state.

### Component Structure
```
apps/web/src/
├── app/teams/[teamId]/manage/
│   ├── layout.tsx                      (edit: shell only, nav removed)
│   ├── page.tsx                        (edit: renders ManageAreaNav current="people"; NoAccess moves out)
│   └── banking/
│       └── page.tsx                    (new: two ManageSections)
├── components/auth/
│   └── text-field.tsx                  (edit: type 'password', inputMode, spellCheck, autoCorrect passthrough)
├── components/teams/
│   ├── manage-area-nav.tsx             (new, server)
│   ├── no-access.tsx                   (new, extracted from manage/page.tsx)
│   ├── banking-summary.tsx             (new, server)
│   ├── banking-form.tsx                (new, client)
│   ├── gst-summary.tsx                 (new, server)
│   ├── gst-form.tsx                    (new, client; includes GstFields)
│   ├── use-settings-form.ts            (new hook, no JSX)
│   ├── inline-confirm.tsx              (edit: section prop)
│   ├── use-moderation-action.ts        (edit: takes a section)
│   ├── banking-components.test.tsx     (new)
│   └── manage-components.test.tsx      (edit: nav tests)
└── lib/teams/
    ├── banking-actions.ts              (new, 'use server', no JSX)
    ├── banking-actions.test.ts         (new)
    ├── banking-view.ts                 (new: status, validators, summary view model)
    ├── banking-view.test.ts            (new)
    ├── manage-view.ts                  (edit: SectionId)
    ├── manage-state.ts                 (edit: empty() keys, result.close)
    ├── manage-areas.ts                 (edit: second area)
    ├── manage-areas.test.ts            (edit)
    └── labels.ts                       (edit: banking copy)
packages/shared/src/nz/ird-number.ts    (edit: formatIrdNumber)
apps/web/e2e/team-banking.spec.ts       (new)
```
Extensions follow the repo: `.tsx` under `app/**` and `components/**` when rendering, `.ts` under `lib/**` and for the hook, `'use server'` actions in `.ts`, tests co-located.

### Recommended Libraries/Patterns
- No new dependency. Disclosure pattern for confirmation (existing), native `<form action>` with `useAuthForm`, `aria-disabled` rather than `disabled` for pending buttons (existing `BUTTON_CLASS`).
- `dl` for read-back summaries (a first use in the repo; plain Tailwind grid, no component library).
- Defer a "show token" toggle: it needs a second `aria-pressed` control and changes the input `type` (which password managers react to); revisit only if support requests show retyping pain.

## Copy table (final)

Status: **Kept** = spec string unchanged; **Changed** = refined, see the note; **New** = not in the spec's deck. Strings go in `lib/teams/labels.ts` (web) and the shared copy deck (field errors).

| Where | Copy | Status |
|-------|------|--------|
| Area nav | `People` / `Banking and GST` | Kept |
| Page title | `Banking and GST – {team name} – Shared Game Management` | Kept |
| H1 | `Banking and GST for {team name}` | Kept |
| Intro under H1 | `Only team admins can see this page. We show only part of your account number, and the Akahu app token is never shown again once saved.` | New |
| Status, not set up | `Not set up. Paid sessions can't be published until you add your bank account and Akahu details.` (lead `Not set up.` in bold) | Kept |
| Status, ready | `Ready to take payments.` | Kept |
| Status, unreadable | `Needs attention. We couldn't read your saved bank details. Enter all four again to fix this.` | New |
| Section headings | `Bank account and Akahu` / `GST` | Kept |
| Banking section intro | `These details let your team take payments for paid sessions. All four are saved together.` | New |
| Summary labels (dt) | `Account name` / `Account number` / `Akahu merchant ID` / `Akahu app token` | Changed: the spec's colon rows (`Account name: {name}`) become dt/dd pairs |
| Summary values (dd) | `{name}` / `ending {last4}` / `{id}` / `Saved` | Kept (value text) |
| Field labels | `Account name` / `Account number` / `Akahu merchant ID` / `Akahu app token` | Kept |
| Account name hint | `The name on the bank account. Up to 100 characters.` | New |
| Account number hint, first save | `Format 00-0000-0000000-00. Hyphens and spaces are optional.` | New |
| Account number hint, configured | `Leave blank to keep the saved value. To replace it, use the format 00-0000-0000000-00.` | Changed: spec sentence first, format sentence added |
| Merchant ID hint | `From your Akahu account. Up to 255 characters, no spaces.` | New |
| Token hint, first save | `Treated like a password. It is never shown again once saved.` | New |
| Token hint, configured | `Leave blank to keep the saved value.` | Kept |
| Token re-enter hint (after a failed submit that included a token) | `Enter your Akahu app token again. For your security it is not kept in the form after an error.` | New |
| Banking buttons | `Save banking details` (pending `Saving…`) / `Remove banking details` / `Cancel` | Kept (pending new) |
| Removal prompt | `Remove banking details? Paid sessions can't be published until you add them again.` | Kept |
| Removal confirm pending | `Removing…` | New |
| Banking saved | `Banking details saved. Paid sessions can now be published.` | Kept |
| Banking removed | `Banking details removed. Paid sessions can't be published until you add them again.` | Kept |
| `banking_in_use` | `Cancel or complete your published paid sessions before removing the banking details.` | Kept |
| `payout_not_configured` | `Add your team's bank account and Akahu details before publishing a paid session.` | Kept (shown by session-scheduling-engine) |
| Banking save outage | `Something went wrong on our side and nothing was saved. Try again in a minute. You'll need to enter the Akahu app token again.` | Changed: the shared outage line says "Your details are still here", which is false for the token |
| Removal outage | `Something went wrong on our side and nothing was removed. Try again in a minute.` | New |
| 403 on a save | `You don't have access to manage this team.` | Kept (existing `NO_ACCESS_HEADING`) |
| GST toggle label | `This team is registered for GST` | Kept |
| GST helper, toggle on | `Players' prices include GST. GST is worked out as 3/23 of the price. Changing this setting only affects payments taken after you save; existing payments and invoices keep the GST treatment they were charged with.` | Kept (the `3/23` should be derived from the GST rate constant, Q10 owner) |
| GST helper, toggle off | `Turn this on if your team is registered for GST. Changing this setting only affects payments taken after you save; existing payments and invoices keep the GST treatment they were charged with.` | Changed: the spec text says prices include GST, which is untrue while GST is off |
| GST fields | `GST number` / `IRD number (optional)` | Kept |
| GST number hint | `8 or 9 digits. Hyphens and spaces are fine.` | New |
| IRD hint, none saved | `Optional. 8 or 9 digits.` | New |
| IRD hint, saved | `Leave blank to keep the saved value.` | New (same words as the token hint) |
| Remove IRD checkbox | `Remove the saved IRD number` | New |
| GST summary labels | `GST` = `Registered` / `Not registered`; `GST number` = `123-456-789`; `Saved GST number` + `Not used while GST is off.`; `IRD number` = `Saved` / `Not saved` | Changed: IRD `ending {last3}` becomes `Saved` |
| GST save | `Save GST settings` (pending `Saving…`) | New |
| GST saved | `GST settings saved.` | Kept |
| Field errors | `Enter the name on the bank account.` / `Use 100 characters or fewer.` / `Enter the account number.` / `Enter an NZ account number in the format 00-0000-0000000-00.` / `That bank or branch number is not recognised. Check the number and try again.` / `That account number does not look right. Check the digits and try again.` / `Enter your Akahu merchant ID.` / `Enter your Akahu app token.` / `Use 255 characters or fewer.` / `Remove any spaces from this value.` / `Enter an 8 or 9 digit IRD number.` / `That IRD number does not look right. Check the digits and try again.` / `Enter your GST number to register for GST.` / `Enter an 8 or 9 digit GST number.` / `That GST number does not look right. Check the digits and try again.` | Kept (the amendments below ask for the `Use 100/255 characters or fewer.` pair to be distinct constants only if tests need them; no wording change) |
| Error summary heading | `There's a problem` | Kept (existing) |
| Loading | existing `loading.tsx` (`Loading team admin...`) | Kept |

No message echoes a typed value (AC-VERIFY-3 stays true for the web copy).

## Validation Checklist

- [x] Meets all user goals (first setup, keep-secrets edit, replace, remove, GST, recovery)
- [x] Accessible per requirements (AC-VERIFY-13 items mapped; no native dialogs; summaries as `dl`; no colour-only state)
- [x] Consistent with existing patterns (`ManageSection`, `InlineConfirm`, `useAuthForm`, `ErrorSummary`, `FormBanner`, status regions)
- [x] Respects Guiding Principles (API is the authority; secrets never echoed or logged; no optimistic updates; revalidate only after success)
- [x] Responsive across devices (360 px and desktop rules above)
- [x] Performance acceptable (one parallel server load; one decrypt on the page)
- [x] Implementation feasible (no new dependency; small edits to `InlineConfirm`, `TextField`, reducer; three new forms and a nav component)

## Next Steps

1. Reconcile with the other creative docs (the binding reconciliation section in the task file): in particular the unreadable-details API shape (Spec Amendments 4) and the IRD `Saved` change (Spec Amendments 3), which touch the API contract.
2. Phase 1/2 (API) carry the contract changes: `irdNumberSet`, the unreadable flag, `formatIrdNumber`.
3. Phase 4: build the nav move, `SectionId` and reducer edits, `InlineConfirm` section prop, `TextField` extension, the two forms and the page, with the unit and component tests listed above.
4. Phase 5: Playwright journeys and axe on both viewports for each state; add `memory-bank/ux-patterns.md` entries via `/yay:ux-ingest`: write-only field pattern (blank keeps, never re-echo credentials), per-page area nav, terminal-failure close of a confirm.

## Spec Amendments

Minimal and concrete. These are recommendations for the plan; the task file is not edited here.

1. **AC-ENTRY-1 and AC-ENTRY-3 (nav marking)**: the nav is rendered by each area page, not by `manage/layout.tsx`: new server component `components/teams/manage-area-nav.tsx` with a `current` prop; `layout.tsx` keeps only the `<main>` shell; the People page renders `current="people"`, the banking page `current="banking"`. Add: the `NoAccess` page renders no nav (supports AC-ENTRY-2). "The existing People page behaviour and its tests are unchanged apart from the nav now appearing" becomes "unchanged apart from the nav, now rendered by the page". Pinned file list: add `components/teams/manage-area-nav.tsx`, `components/teams/no-access.tsx`.
2. **Success Criteria, configured detail rows**: the four rows render as a `dl` of label and value (`Account name` / `{name}`, `Account number` / `ending {last4}`, `Akahu merchant ID` / `{id}`, `Akahu app token` / `Saved`) rather than colon strings; tests assert the label and value text separately.
3. **IRD read-back (Q7)**: the API returns `irdNumberSet: boolean` instead of `irdNumberLast3`; Success Criteria and AC-HAPPY-5 say `IRD number: Saved` instead of `ending {last3}`; AC-ERROR-12 and AC-VERIFY-10 no longer involve the IRD number on read (the account name is the only decrypt on GET). Add `formatIrdNumber` (groups of three from the right) to `packages/shared/src/nz/ird-number.ts` for the `123-456-789` display. Fallback if the last 3 are kept: degrade that one row to `Saved` on `DecryptionError` rather than failing the page.
4. **AC-ERROR-12 (decrypt failure)**: a 500 leaves the admin on the generic error page with no way to re-enter details, contradicting "a full `PUT /banking` still succeeds and restores the page". Required UX outcome: `GET /banking` answers 200 with `accountName: null` and `unreadable: true` (the mechanism is the architecture agent's call; the outcome is binding), still logs `team.banking.decrypt_failed` with the reason code only, and the page shows the "Needs attention" status and a form with all four fields required. Add an AC for the page state.
5. **AC-VERIFY-13 (input attributes)**: the token input is `type="password"` with `autocomplete="new-password"` (not `off`: browsers ignore `off` on password fields and may autofill the admin's login password) plus `spellcheck="false"`, `data-1p-ignore` and `data-lpignore="true"`; the account number input stays `inputMode="numeric"` with `autocomplete="off"`.
6. **AC-ERROR-1 and AC-ERROR-13 (value retention)**: restate as: after any failed submit the form keeps the typed account name, account number, Akahu merchant ID, GST number and IRD number; never the token (and never any stored value); a failed submit that included a token shows the re-enter hint. Add: Server Actions never log field values.
7. **AC-ERROR-13 copy**: the banking save outage uses its own copy (`Something went wrong on our side and nothing was saved. Try again in a minute. You'll need to enter the Akahu app token again.`); the shared "Your details are still here" line is not used for banking.
8. **Success Criteria, GST helper text**: split into the toggle-on text (spec wording) and a toggle-off text (`Turn this on if your team is registered for GST. Changing this setting only affects payments taken after you save; ...`). The `3/23` in the on-text is derived from the GST rate constant (Q10 owner), not typed.
9. **IRD clearing**: add `Remove the saved IRD number` (checkbox, shown only when one is saved); ticking it sends `irdNumber: null` and disables the input. Add a MUST AC or fold into AC-HAPPY-5: after saving with it ticked the summary shows `IRD number: Not saved` and the stored envelope is NULL.
10. **Copy deck additions**: the intro, status-unreadable, section intro, field hints, re-enter hint, pending labels, GST hints, remove-IRD label, GST summary labels and removal-outage strings in the Copy table above (all `New` or `Changed` rows) join the Success Criteria deck; `labels.ts` carries them.
11. **AC-ERROR-10 (UI side)**: a `banking_in_use` answer closes the removal panel and shows the banner; other 5xx keep it open. Requires `close?: boolean` on the manage `result` event and `section: SectionId` on `InlineConfirm` (replacing `kind`), plus `'banking'` and `'gst'` added to `SectionId` and the reducer's `empty()`; pin these edits (`manage-view.ts`, `manage-state.ts`, `inline-confirm.tsx`, `use-moderation-action.ts`) and extend `components/auth/text-field.tsx` (`type: 'password'`, `inputMode`, `spellCheck`, `autoCorrect`) in the file list.
12. **Q9 closed**: One page with two sections; no sub-pages; no "Banking not set up" hint on My teams and therefore no `MineTeamsResponse` change in this task (revisit with the publish-refusal link in session-scheduling-engine).
13. **AC-ASYNC-1 (other-admin email)**: out of scope for this document (architecture agent). If built, no UI change is needed on this page; the saved status line is enough for the acting admin.
