# UI/UX Decision: Session Scheduling Engine (team-admin Sessions pages)

**Created**: 2026-10-20
**Status**: DECIDED
**Decision Type**: UI/UX
**Task**: `session-scheduling-engine` (Level 4), branch `feature/session-scheduling-engine`
**Answers**: creative items C1 (multi-court fast setup at desktop and 360 px), C4 (costing and pricing presentation), C5 (list grouping, Started and Ended labels, banking notice placement, read-only closed sessions), plus the DST choice, fixed-pattern fields, the series-save effect line, the End series confirm and the stale-save state.
**Precedence**: `session-scheduling-engine-binding-reconciliation.md` (BIND) wins over every other doc. Rulings applied here: P-1 (Auto Enroll for every session), P-2 (no player emails, show the registered count), P-3 (series pattern fixed after creation), T-5 (series-edit counts, whole-edit banking refusal), T-6 (End series), T-7 (fees only go down), T-8 (default deadline), T-9 (`fee_flat`), T-10 (DST), T-11 (phase labels), T-12 (stale copy). Where the user-journey doc (UJ) or algorithm doc (ALG) disagrees with BIND, this doc follows BIND and says so.
**Reads**: UJ (journey, states, provisional copy), ALG (J6, J8, J9), ARCH (API fields, `expectedVersion`, `createKey`, 409 bodies), the task file (Invocation Method, AC-VERIFY-8), and the shipped components `inline-confirm`, `manage-section`, `option-fieldset`, `team-form-banner`, `manage-area-nav`, `no-access`, `banking-form`, `banking-section`, `section-pager`, `auth/{text-field,field-message,form-banner,error-summary,submit-button,use-auth-form,styles}`, `lib/teams/{manage-areas,banking-view,labels}`.
**Not found**: `memory-bank/ux-patterns.md` does not exist on this branch, so no UX-pattern file was applied. `memory-bank/productBrief.md`, `systemPatterns.md` and `techContext.md` were consulted only through the task file's citations and the shipped components (Tailwind v4, 16 px inputs, `min-h-11` targets, desktop and 360 x 740 Playwright projects, NZ-only users). Stated assumptions are listed in [Assumptions to confirm](#assumptions-to-confirm).

---

## User Context

### Target Users
- **Primary**: Team Admin (`TEAM_ADMIN`), a volunteer club organiser. Sets up on a laptop on Sunday evening (nine courts, one finishing early, $12 a head). Makes quick changes on a phone at 360 px (cancel a night, add a court, lower a fee). Thinks in whole dollars per head and in "Court 7". Interrupted often. Will not read more than one line of help.
- **Secondary**: a co-admin editing the same session or series (stale-save path). Screen-reader and keyboard-only admins (AC-VERIFY-8). Later features (registration-and-waitlist, billing) only consume what is saved.

### User Goals
1. Set up many courts without typing every row: set count and times once, then fix the exceptions.
2. See what a night will cost per player and set a fee that covers it, without a calculator.
3. Know what a save will do (this date only, or the whole series) before and after pressing it, in numbers.
4. See at a glance which sessions are live, which wait on the admin, and which are over; never lose typed work to a banking refusal.

### Use Cases
| Use Case | User | Goal | Frequency |
|---|---|---|---|
| UC1 Multi-court setup on a new series | Admin, laptop | 9 courts, default 8-10 am, Court 7 ends 9 am | Once per series |
| UC2 Cut one night to 6 courts | Admin, phone | Remove courts on one date, mark it Edited | Monthly |
| UC3 Cost and price a session | Admin | Pick Flat/By sex/By skill, accept or pin a rate | Per session or series |
| UC4 Find what needs me | Admin | Spot banking-refused and edited drafts | Weekly |
| UC5 Change the whole series | Admin | Move to 7 pm, see "4 updated, 1 kept" | Occasional |
| UC6 End a series | Admin | Stop adding dates, optionally cancel published ones | Rare |
| UC7 Cancel a night | Admin, phone | Cancel and be told how many registered | Occasional |
| UC8 Open a closed session | Admin | See why it can't be edited | Occasional |

### Constraints
- **Devices**: desktop and 360 x 740 phone are tested (Playwright projects). Tablet is the desktop layout at 640 px and up. The shell is `max-w-3xl px-4` (`manage/layout.tsx`), so the widest content is 736 px.
- **Accessibility**: axe `critical` and `serious` must be zero on the list, session editor and series editor (AC-VERIFY-8); each court row has labelled start and end inputs; no horizontal page scroll at 360 px; "Apply to all courts" announces through a polite live region. Also WCAG 2.2 AA: 1.4.10 reflow at 320 px, 2.5.8 target size (use `min-h-11`), 3.3.1, 3.3.3, 4.1.3 status messages.
- **Existing patterns that must be followed**:
  - one task per URL; Server Actions with in-place `FormState` errors, or `redirect(..., RedirectType.replace)` with a codes-only `?notice=` stripped after render (`StripAuthParams`);
  - `FormBanner` focused once; `ErrorSummary` plus `FieldError`;
  - `InlineConfirm` disclosures, never `confirm()`, `<dialog>` or `beforeunload`;
  - summary-first with `?edit=` (banking page);
  - `NoAccess` on 403, `sessionExpiredUrl` on 401, `requireUser(here)`;
  - the `returnTo` banking hand-off (`bankingReturnTo` accepts any `/teams/<id>/...` path except the banking page itself, so sessions paths already pass);
  - tokens: `FOCUS_RING`, `INPUT_CLASS`, `BUTTON_CLASS`, `SECONDARY_BUTTON_CLASS`, `LINK_CLASS` from `components/auth/styles.ts`; borders `border-slate-*`, notice `border-blue-800 bg-blue-50`, error `border-red-800 bg-red-50`.
- **Locale**: New Zealand only. Dates "Wed 4 Nov 2026" (`en-NZ`, `Pacific/Auckland`), times "8:00 am". The page says "Times are New Zealand time." once, in the Courts fieldset.
- **Money**: exact. The browser calls the shared `suggestedRate`, `defaultFeeOther` and `Money` helpers from `@sgm/shared`. It never re-implements the formula.

---

## User Flow

### Flow Diagram
```
Area nav "Sessions" ──▶ [List] ──▶ New session ──▶ [Session form, create] ──Save draft──▶ [Editor, draft]
                          │                                   └─Save and publish─▶ (paid: confirm) ─▶ [Editor, published]
                          ├─▶ New recurring series ─▶ [Series form, create] ─Create series─▶ (confirm) ─▶ [Series page: waiting] ─▶ [Series page: sessions]
                          ├─▶ session row ──▶ [Editor: draft | published | read-only summary]
                          └─▶ series row ───▶ [Series page] ─▶ "Edit Wed 4 Nov" ─▶ [Editor, series date] ─▶ "Back to {series}"
                                                       ├─▶ "Change series details" ─▶ [?edit=details form + effect line] ─▶ Save series
                                                       └─▶ "End series" ─▶ confirm (last date, optional cancel) ─▶ [Series page: ended]
Banking refused anywhere ──▶ alert + "Set up banking and GST" (returnTo = the page the admin was on) ──▶ back
```

### Flow Description
1. **Entry**: the area nav (`People · Banking and GST · Sessions`), the banking-hand-off return link, or a row.
2. **Setup**: one form per scope. Fieldset order is Details, Courts, Places, Costing, Pricing, Cancellation deadline. Places moved before Costing, because the suggested rate divides by max players and the page should read top to bottom.
3. **Decision points**: Save draft or Save and publish (paid sessions confirm); Create series (always confirms); cancel (confirm with the registered count); End series (confirm with last date and optional cancel).
4. **Exit**: a focused success banner on the next page, or a read-only summary once a session has started.

### Error States
| Error | Cause | User recovery |
|---|---|---|
| Field errors (422 `validation_failed`) | Missing court time, end before start, duplicate court name, bad money | Error summary focused, each field `aria-invalid`; values kept |
| DST gap or overlap (422 `local_time_*`) | Court or deadline time between 02:00 and 03:00 on a change day | Inline choice buttons under the field (see DST) |
| `series_pattern_fixed` (422) | A fixed field posted on an existing series | Cannot happen from the UI (fields are read-only); the generic banner covers a forged post |
| Banking refused (409 `payout_not_configured`) | Publish, or a free-to-paid series edit reaching published sessions | Verbatim alert, link with `returnTo`; the save part is kept for a session, nothing is saved for a series (T-5) |
| `session_fee_locked` (409) | A fee raise after registrations | Field error under the fee, with "pin the rate" hint |
| `session_started` / `session_not_editable` (409) | A form posted after start, or the session was closed | Page reloads as the read-only summary with the reason focused |
| `session_stale` / `series_stale` (409) | Concurrent change by a co-admin, the materialiser or a series save | Page reloads with the latest values and a focused alert |
| 5xx / no answer | Server or network | `SAVE_FAILED_MESSAGE` / `UNCONFIRMED_MESSAGE`, typed values kept |
| 401 / 403 | Session expired / not an admin | `sessionExpiredUrl(here)` / `NoAccess` |

---

## Options Explored

Four decisions needed real exploration: the multi-court editor (D1), costing and pricing (D2), the series page layout (D3), and the list and notice placement (D4).

### D1. Multi-court editor (C1)

#### Option 1: Defaults block plus one stacked row per court (CHOSEN)
- **Approach**: a setup block ("Number of courts", "Default start", "Default end", "Apply to all courts"), then one row per court with editable name, start and end. Rows are a CSS grid: four columns from 640 px, a two-line card below it. Every row is always visible.
- **Wireframe (desktop)**:
  ```
  ┌ Courts ──────────────────────────────────────────────────────────┐
  │ Times are New Zealand time.                                       │
  │ Number of courts [ 9 ]   Default start [8:00 am]  Default end [10:00 am] │
  │ [Apply to all courts]   Default times are used for new courts.    │
  │ ─────────────────────────────────────────────────────────────── │
  │  Court name      Start        End                                 │
  │  [Court 1     ] [8:00 am ]  [10:00 am]  Remove                    │
  │  [Court 2     ] [8:00 am ]  [10:00 am]  Remove                    │
  │  ...                                                              │
  │  [Court 7     ] [8:00 am ]  [9:00 am ]  Not default   Remove      │
  │  ...                                                              │
  │ [Add court]            9 courts. 8 use the default times.         │
  └──────────────────────────────────────────────────────────────────┘
  ```
- **Wireframe (360 px)**:
  ```
  ┌ Courts ──────────────────────────┐
  │ Times are New Zealand time.      │
  │ Number of courts                 │
  │ [ 9                            ] │
  │ Default start                    │
  │ [ 8:00 am                      ] │
  │ Default end                      │
  │ [ 10:00 am                     ] │
  │ [ Apply to all courts          ] │
  │ Default times are used for new   │
  │ courts.                          │
  │ ┌ Court 1 ─────────────────────┐ │
  │ │ Court name                   │ │
  │ │ [Court 1            ] [Remove]│ │
  │ │ Start          End           │ │
  │ │ [8:00 am ]     [10:00 am]    │ │
  │ └──────────────────────────────┘ │
  │ ┌ Court 7 ─────── Not default ─┐ │
  │ │ ...        Start 8:00 am     │ │
  │ │            End   9:00 am     │ │
  │ └──────────────────────────────┘ │
  │ 9 courts. 8 use the default.     │
  │ [ Add court                    ] │
  └──────────────────────────────────┘
  ```
- **User Flow**: set count 9, default 8-10, Apply, change Court 7's end. Four edits and one tap for the whole night.
- **Pros**:
  - Matches the spec Element text and AC-VERIFY-8 literally: one row per court with labelled start and end.
  - Every court is visible, so what is saved is what is shown.
  - Works without a mode switch; the same component serves the series template and a single date.
- **Cons**:
  - 9 rows is about 1,100 px tall at 360 px.
  - "Number of courts" and Add/Remove overlap (kept in sync on purpose).
- **Usability**: High. **Accessibility**: High. **Implementation Complexity**: Medium.

#### Option 2: Defaults plus an exceptions list (sparse)
- **Approach**: show only the default times and a list of courts that differ ("Court 7 ends 9:00 am"). Courts that match the default are implied.
- **Pros**: very short at 360 px for the common case.
- **Cons**:
  - The saved model is one row per court, so the UI hides rows the admin cannot name or rename.
  - Per-court names ("Show court") and removing a court do not fit.
  - AC-VERIFY-8 and the spec name a per-court table with labelled inputs.
  - Two ways to express the same court set doubles the edge cases.
- **Usability**: Medium. **Accessibility**: Medium. **Implementation Complexity**: High.

#### Option 3: Range groups ("Courts 1-6: 8-10 am; Court 7: 8-9 am")
- **Approach**: groups of courts that share times, each group a row with a "from-to" court range.
- **Pros**: compact and quick for regular patterns.
- **Cons**: range editing is its own mini-language (split a group, merge two). Overlapping ranges need validation. Court names beyond numbers do not fit. No precedent in this product.
- **Usability**: Medium. **Accessibility**: Medium. **Implementation Complexity**: High.

#### Option 4: Spreadsheet-style table with copy-down
- **Approach**: a real `<table>` with a "copy down" button on the first row's cells.
- **Pros**: familiar to power users. Real table semantics.
- **Cons**: needs horizontal scroll or a card fallback below 640 px, which means two layouts anyway. "Copy down" per cell is more controls than one Apply button. A scrolling table at 360 px fails the no-horizontal-scroll AC.
- **Usability**: Medium. **Accessibility**: Medium. **Implementation Complexity**: Medium.

#### Evaluation (D1)
| Criteria | Opt 1 Defaults + rows | Opt 2 Exceptions | Opt 3 Range groups | Opt 4 Table + copy-down |
|---|---|---|---|---|
| Usability | High | Medium | Medium | Medium |
| Accessibility | High | Medium | Medium | Medium |
| Consistency (spec, AC-VERIFY-8, banking forms) | High | Low | Low | Medium |
| 360 px | Medium-High (tall, no scroll) | High | Medium | Low |
| Performance (up to 20 rows) | High | High | High | High |
| Implementation | Medium | High | High | Medium |

**Chosen: Option 1.** The height at 360 px is the accepted cost (see Trade-offs). Two things keep it usable: Start and End sit side by side so each court is two input lines, and the summary line plus "Not default" tag say where the exceptions are.

### D2. Costing and pricing presentation (C4)

#### Option A: Costing (inputs and suggestion) then Pricing (model first, rate and fees inside it), with a follow/pin state on the rate (CHOSEN)
- **Approach**:
  - The **Costing** fieldset holds "Court hire (total)", "Extra expenses" and the read-only suggestion line.
  - The **Pricing** fieldset opens with the model radio group (Flat rate, By sex, By skill level) and then shows only that model's fee inputs.
  - Flat rate: a "Rate per player" input. It follows the suggestion until the admin types, then it is pinned (T-9: NULL means follow). A "Use suggested rate" button appears only while pinned.
  - By sex or By skill: each fee input is empty on first reveal and filled from the final rate (ALG J9, A5), with a single "Fill all with the suggested rate" button. `fee_other` shows `min(male, female)` and tracks it until edited.
- **Wireframe (desktop)**:
  ```
  ┌ Costing ────────────────────────────────────────────────────────┐
  │ Court hire (total)  $[ 180.00 ]   Extra expenses  $[ 20.00 ]      │
  │ Suggested rate: $12.00 per player. Court hire plus extras,        │
  │ divided by max players (18), rounded up to the next dollar.       │
  └──────────────────────────────────────────────────────────────────┘
  ┌ Pricing ────────────────────────────────────────────────────────┐
  │ (•) Flat rate   ( ) By sex   ( ) By skill level                   │
  │ Rate per player  $[ 12.00 ]                                       │
  │ Following the suggested rate. It changes when costs or max        │
  │ players change.                                                   │
  └──────────────────────────────────────────────────────────────────┘
  ```
- **Wireframe (360 px)**: both fieldsets are single columns. Money inputs are full width with the "$" as an `aria-hidden` prefix inside the same bordered box. The model radios stack, one per row, `min-h-11`, with their help line under each (`OptionFieldset` pattern).
- **Pros**:
  - One place per number. The rate lives with the other fees, so a By-sex session never shows an unused "Rate per player" field.
  - The suggestion stays visible above the fee inputs it informs.
  - The follow/pin state is shown in words and is the same on all three models.
- **Cons**: moves "Rate per player" from Costing (spec Element text) to Pricing; the task-file amendment says so.
- **Usability**: High. **Accessibility**: High. **Implementation Complexity**: Medium.

#### Option B: As the spec words it (rate input in Costing; Pricing radios only reveal fee inputs)
- **Pros**: matches the spec sentence exactly.
- **Cons**: for By sex and By skill the rate field is shown but unused, and then two places hold fees. The admin cannot tell whether "Rate per player" matters.
- **Usability**: Low-Medium. **Accessibility**: Medium. **Implementation Complexity**: Low.

#### Option C: One "Money" fieldset with a sticky per-player summary card
- **Pros**: everything in one block; a live card could show total cost, break-even and the chosen fee.
- **Cons**: a sticky card steals screen at 360 px; a live-updating card would need `aria-live` and would chatter on each keystroke; a larger component with no precedent.
- **Usability**: Medium. **Accessibility**: Low-Medium. **Implementation Complexity**: High.

#### Evaluation (D2)
| Criteria | A Costing + Pricing | B Spec literal | C One Money fieldset |
|---|---|---|---|
| Usability | High | Low-Medium | Medium |
| Accessibility | High | Medium | Low-Medium |
| Consistency (OptionFieldset, T-9) | High | Medium | Low |
| 360 px | High | High | Low |
| Performance | High | High | Medium |
| Implementation | Medium | Low | High |

**Chosen: Option A.**

### D3. Series page layout

#### Option 1: Sessions first, details second; edit mode is form-first (`?edit=details`) (CHOSEN)
- **Approach** (UJ's hub, specified here): the view shows heading, summary, banking notice, the sessions, the horizon line, a Past disclosure, the details summary with "Change series details" and, last, "End series". With `?edit=details` the form comes first and the sessions list is replaced by the effect line.
- **Wireframe (desktop, view)**:
  ```
  ┌ People · Banking and GST · Sessions ─────────────────────────────┐
  │ [Series saved. 4 upcoming sessions updated. 1 edited session kept │
  │  its own details.]                                                │
  │ Wednesdays at Rosedale                                            │
  │ Weekly on Wednesdays · 8:00 am-10:00 am · 9 courts · $12.00 each  │
  │ from 4 Nov 2026 · no end date                                     │
  │ ── Sessions in this series ──                                     │
  │  Wed 4 Nov    8:00-10:00 am  Published              Edit Wed 4 Nov│
  │  Wed 11 Nov   8:00-9:00 am   Published  Edited      Edit Wed 11 Nov│
  │  Wed 18 Nov   8:00-10:00 am  Draft · bank account needed  Edit ... │
  │  Sessions are added 28 days ahead. The next, Wed 9 Dec, will be   │
  │  added on Wed 11 Nov.                                             │
  │  ▸ Past and cancelled sessions in this series (2)                 │
  │ ── Series details ──                                              │
  │  Repeats Weekly on Wednesdays · First session 4 Nov 2026 · ...    │
  │  [Change series details]                                          │
  │ ─────────────────────────────────────────────────────────────── │
  │  [End series]                                                     │
  └──────────────────────────────────────────────────────────────────┘
  ```
- **Wireframe (360 px, view)**: one column; each date row is two lines (date and time on line one, label chips then a full-width "Edit Wed 4 Nov" link on line two); the details block is a stacked `dl`.
- **Pros**: the admin's usual job is checking and fixing dates, so those lead. In edit mode the effect line replaces the list, so there is no way to click into a date with an unsaved form. Matches the banking page's summary-first pattern.
- **Cons**: details are one tap away from the sessions.
- **Usability**: High. **Accessibility**: High. **Implementation Complexity**: Low-Medium.

#### Option 2: Tabs "Sessions | Details"
- **Pros**: both always one tap away.
- **Cons**: a tablist needs roving focus and `aria-controls` panels; the tab state belongs in the URL for the stale and banking hand-offs; a banner lands in whichever tab is hidden. The existing manage area has no tabs.
- **Usability**: Medium-High. **Accessibility**: Medium. **Implementation Complexity**: Medium.

#### Option 3: Two columns at desktop (sessions left, details right), stacked on mobile
- **Pros**: everything visible on a wide screen.
- **Cons**: the shell is 768 px, so two columns leave about 340 px each; date rows with chips and an Edit link would wrap badly. The edit form would not fit the right column.
- **Usability**: Medium. **Accessibility**: Medium-High. **Implementation Complexity**: Medium.

#### Option 4: Details form always open on top, sessions below
- **Pros**: no mode switch.
- **Cons**: a form that is always editable invites accidental saves, and its effect line is shown permanently. It buries the sessions under 8 fieldsets at 360 px. It disagrees with P-3, where most of the form is read-only after creation.
- **Usability**: Low-Medium. **Accessibility**: Medium. **Implementation Complexity**: Low.

#### Evaluation (D3)
| Criteria | 1 Sessions first | 2 Tabs | 3 Two columns | 4 Form on top |
|---|---|---|---|---|
| Usability | High | Medium-High | Medium | Low-Medium |
| Accessibility | High | Medium | Medium-High | Medium |
| Consistency | High | Low | Low | Medium |
| 360 px | High | High | Medium | Low |
| Performance | High | High | High | High |
| Implementation | Low-Medium | Medium | Medium | Low |

**Chosen: Option 1.**

### D4. List grouping and banking-notice placement (C5)

#### Option 1: Four sections with flat rows; one page-level notice above the sections (CHOSEN)
- Sections: Upcoming, Drafts, Series, Past and cancelled (spec). Rows are `<li>` cards, not a table. The banking notice is one bordered block under the create buttons.
- **Pros**: the notice is above the fold at 360 px, shown once, never duplicated per row; rows read well at any width; reuses `ManageSection`.
- **Cons**: the notice is not next to the draft rows it explains. Each such row carries its own label, which closes the gap.
- **Usability**: High. **Accessibility**: High. **Implementation Complexity**: Low.

#### Option 2: One chronological table with filter chips
- **Cons**: a table does not fit 360 px without turning into cards anyway. Filters add state. It breaks the spec's four sections. **Usability**: Medium. **Accessibility**: Medium. **Complexity**: Medium.

#### Option 3: Banking notice inside the Drafts section (and again on the series page)
- **Cons**: at 360 px the Drafts section sits below a long Upcoming list, so the one thing blocking sessions going live is off-screen. **Usability**: Low-Medium. **Accessibility**: High. **Complexity**: Low.

**Chosen: Option 1.** (Option 3's section-level placement is used on the *series* page, where the notice sits directly above that series' sessions.)

---

## Decision

**Chosen**: D1 Option 1 (defaults plus stacked rows), D2 Option A (Costing then Pricing, follow/pin rate), D3 Option 1 (sessions first, form-first edit mode), D4 Option 1 (four sections, one page-level notice).

### Rationale
- The product spends admin friction where a mistake costs money or tells players the wrong thing (publish confirm, create-series confirm, cancel and End series prompts with counts) and removes it elsewhere (apply-to-all, follow-the-suggestion, one-tap fill, drafts).
- Each design reuses a pattern admins already know from People and Banking, so nothing new has to be learned: area nav, summary-first with `?edit=`, `InlineConfirm`, focused banners, the `returnTo` hand-off.
- Everything is real text, never colour alone, so it passes axe and works with a screen reader. The court rows and the DST buttons each carry their own accessible names.

### Trade-offs Accepted
- **Tall court list at 360 px (about 120 px per court).** Mitigation: summary line, "Not default" tag, "Number of courts" for fast changes, no horizontal scroll. A 9-court night is two screens of scrolling, which is acceptable for a once-per-series setup.
- **Changing "Number of courts" down drops the last rows without undo.** Mitigation: applied on blur or Enter (not per keystroke), announced ("Removed Court 9 and Court 8. 7 courts."). The rows are unsaved, so nothing saved is lost.
- **A stale save loses what was typed (T-5/UJ T5).** Mitigation: the banner says so in one line instead of hiding it.
- **"Rate per player" moves to Pricing.** Mitigation: amendment to the task's Element text.
- **Series details are one tap from the sessions list.** Mitigation: the summary is on the page; the link is the first control after it.
- **No "Reset to series" and no "Skip a date" (ALG J7).** Deferred, as UJ T2 decided. The edited scope line says what Edited means before the first save.

---

## Design Specifications

### Layout

All pages sit in `ManageLayout` (`max-w-3xl`, `gap-8`). Each renders `ManageAreaNav current="sessions"` after its guard passes, wrapped in `ManageProvider` (needed by `InlineConfirm` and `ManageSection`). Titles follow `"{Page} – {Team} – Shared Game Management"` with `robots: noindex`.

- **Desktop (above 1024 px) and tablet (640-1024 px)**: single column. Fieldsets stack with `gap-6`. Inside a fieldset, short inputs sit in a grid (`sm:grid-cols-2`, courts `sm:grid-cols-[1fr_9rem_9rem_auto]`). Buttons are `sm:w-auto` and left-aligned in a row.
- **Mobile (below 640 px)**: everything stacks. Every input and button is full width and `min-h-11`. Court rows become cards. Date rows on the list wrap to two lines.

#### Sessions list (`/teams/T/manage/sessions`), desktop
```
┌ People · Banking and GST · Sessions ─────────────────────────────────┐
│ [notice banner, if ?notice=]                                           │
│ Sessions for Rosedale Badminton                                        │
│ Set up one-off sessions or a series that repeats. Members can register │
│ once a session is published.                                           │
│ [New session] [New recurring series]                                   │
│ Members on Auto Enroll are added to every session when it's published. │
│ ┌ Some sessions weren't published because your team's bank account ──┐ │
│ │ isn't set up.   Set up banking and GST                              │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ Upcoming                                                                │
│  Wed 4 Nov 2026, 8:00-10:00 am     Rosedale · 9 courts                  │
│      [Published] [Series: Wednesdays at Rosedale]                       │
│  Sat 7 Nov 2026, 9:00 am-1:00 pm   Albany Hall · 4 courts  [Draft...]   │
│ Drafts / Series / Past and cancelled ...                                │
└────────────────────────────────────────────────────────────────────────┘
```
#### Sessions list, 360 px
```
┌──────────────────────────────────┐
│ People · Banking and GST · Sessions
│ Sessions for Rosedale Badminton  │
│ Set up one-off sessions or a ... │
│ [ New session                  ] │
│ [ New recurring series         ] │
│ Members on Auto Enroll are added │
│ to every session when it's       │
│ published.                       │
│ ┌ Some sessions weren't ───────┐ │
│ │ published because your team's│ │
│ │ bank account isn't set up.   │ │
│ │ Set up banking and GST       │ │
│ └──────────────────────────────┘ │
│ Upcoming                         │
│ ┌──────────────────────────────┐ │
│ │ Wed 4 Nov 2026               │ │
│ │ 8:00-10:00 am · Rosedale     │ │
│ │ 9 courts                     │ │
│ │ [Published] [Edited]         │ │
│ │ Series: Wednesdays at Rosedale│ │
│ └──────────────────────────────┘ │
└──────────────────────────────────┘
```
- The whole card's first line is the link to the editor (`<a>` text "Wed 4 Nov 2026, 8:00-10:00 am"). The rest is plain text, so each row has one tab stop.
- Section order and contents:
  - **Upcoming**: PUBLISHED with `phase` `upcoming` or `started`, soonest first. A started session stays here, labelled **Started**, until it ends (T-11).
  - **Drafts**: DRAFT with a future start, soonest first. Labels: "Draft", "Draft · bank account needed", "Draft · publishes overnight", "Draft · Edited". Only what waits on the admin belongs here.
  - **Series**: every rule, newest first.
  - **Past and cancelled**: `phase = ended`, COMPLETED, CANCELLED and expired drafts ("Not published · date passed"), most recent first.
- Each section is `ManageSection` with its empty-state line, `SectionPager` ("Next", "Back to start") at 25 rows per page, keyset cursors in `?upcoming=`, `?drafts=`, `?past=`.
- **Series rows**: name, one-line summary, status ("Active", "Ended 16 Dec 2026", "Adding sessions…"), and "{n} upcoming" text. The row's first line links to the series page.
- **Banking notice**: a bordered `<aside aria-labelledby>` (`border-2 border-slate-900 p-4`, same look as the banking-page status block, not `role="status"` because it is page content and not a result). Shown only when a row has `draftReason = 'banking'` and the team is not payout-configured. The link is `/teams/T/manage/banking?returnTo=<list path>`.

#### Session editor (`/new`, `/[sessionId]`), desktop
```
┌ People · Banking and GST · Sessions ─────────────────────────────────┐
│ ‹ Back to Wednesdays at Rosedale                    (series date only) │
│ [Draft saved.]                                                          │
│ Rosedale, Wed 4 Nov 2026                                                │
│ One date in Wednesdays at Rosedale. Changes here apply to Wed 4 Nov     │
│ only. Once you save a change, this date is marked Edited and changes    │
│ to the series won't overwrite it.                                       │
│ Draft. Members can't see it until you publish it.                       │
│ ┌ Details ─────────────────────────────────────────────────────────┐   │
│ │ Location [..............]  Address [..............]                │   │
│ │ Date  [4 Nov 2026]          (series date: "Wed 4 Nov 2026" as text) │   │
│ └──────────────────────────────────────────────────────────────────┘   │
│ ┌ Courts ┐ ┌ Places ┐ ┌ Costing ┐ ┌ Pricing ┐ ┌ Cancellation deadline ┐ │
│ [Save draft]  [Save and publish]                                        │
│ ───────────────────────────────────────────────────────────────────── │
│ [Cancel session]                                                        │
└────────────────────────────────────────────────────────────────────────┘
```
- Order of the page: back link (series dates only), banner, H1, scope line (first text after the H1), status line (with registrations count when published), the form, and, below a separator, "Cancel session".
- **Details**: Location (required text), Address (text), Date (`type="date"`, one-off only). A series date shows its date as text with "To move this night, cancel it and create a one-off session."
- **Places**: "Max players" (integer, at least 1) and "Reserved host seats" (integer, 0 up to max). On a published session, the hint under Max players is "Lowering this won't remove anyone who's already in."
- **Cancellation deadline**: a two-option radio group. "Default: 48 hours before the first court starts" with a computed readout "Currently Mon 2 Nov, 8:00 am", or "A specific date and time" revealing a Date and a Time input. Choosing the default sends `cancellationDeadline: null` (T-8). A series form shows only the static line.
- **Buttons**: draft or new: "Save draft" (secondary), "Save and publish" (primary). Published: "Save changes". The publish confirm opens under the buttons. Primary action is rightmost on desktop and first (top) at 360 px, in line with `InlineConfirm` order.

#### Session editor, published, 360 px (key parts)
```
┌──────────────────────────────────┐
│ ‹ Back to Wednesdays at Rosedale │
│ Rosedale, Wed 11 Nov 2026        │
│ Edited. This date has its own    │
│ details, so changes to           │
│ Wednesdays at Rosedale don't     │
│ apply to it.                     │
│ Published. Members can register. │
│ 12 players are registered. We    │
│ don't email them about changes,  │
│ so let them know if you change   │
│ the date, times, place,          │
│ cancellation deadline or fees.   │
│ ┌ Pricing ─────────────────────┐ │
│ │ Pricing: By sex              │ │
│ │ Players have registered, so  │ │
│ │ fees can only be lowered.    │ │
│ │ Male   $[ 17.00 ]            │ │
│ └──────────────────────────────┘ │
│ [ Save changes                 ] │
│ ──────────────────────────────── │
│ [ Cancel session               ] │
└──────────────────────────────────┘
```

#### Publish confirm (in-form panel), 360 px
```
┌ Save and publish ─────────────────┐   button, aria-expanded
│ ┌──────────────────────────────┐ │
│ │ Publish this session? Members│ │   prompt (focus lands here)
│ │ can register straight away,  │ │
│ │ and each player is charged   │ │
│ │ after the game: $12.00 each. │ │
│ │ Members on Auto Enroll will  │ │
│ │ be added to it.              │ │
│ │ [ Publish session ]          │ │
│ │ [ Keep editing    ]          │ │
│ └──────────────────────────────┘ │
└──────────────────────────────────┘
```

#### Read-only session summary (started, ended, completed, cancelled, expired draft)
```
┌ ‹ Back to Sessions ───────────────────────────────────────────────┐
│ Rosedale, Wed 4 Nov 2026                                            │
│ ┌ This session has started, so it can't be changed or cancelled. ┐ │
│ [Started]  [Series: Wednesdays at Rosedale]                         │
│ Details      Location Rosedale · Address 1 Court Rd · Date Wed 4 Nov│
│ Courts       Court   Start      End                                 │
│              Court 1 8:00 am    10:00 am   (a real <table>, 3 columns)│
│ Places       Max players 18 · Reserved host seats 2                 │
│ Costing      Court hire $180.00 · Extra expenses $20.00             │
│ Pricing      Flat rate $12.00 each                                  │
│ Cancellation deadline  Mon 2 Nov, 8:00 am                           │
│ ‹ Back to Sessions   ‹ Back to Wednesdays at Rosedale               │
└────────────────────────────────────────────────────────────────────┘
```
- The page is `dl` groups under `h2`s, never disabled inputs. The courts use a real table (three short columns fit 360 px). The reason sits in a bordered block, with no live-region role (it is page content).
- No Save, Publish or Cancel is rendered. A form posted across the boundary answers 409 and reloads this view with the reason as a focused alert.

#### Series page, 360 px (view)
```
┌──────────────────────────────────┐
│ People · Banking and GST · Sessions
│ [Series saved. 4 upcoming        │
│  sessions updated. 1 edited      │
│  session kept its own details.]  │
│ Wednesdays at Rosedale           │
│ Weekly on Wednesdays             │
│ 8:00 am-10:00 am · 9 courts      │
│ $12.00 each · from 4 Nov 2026    │
│ · no end date                    │
│ ┌ 2 sessions in this series were │
│ │ saved as drafts because your   │
│ │ team's bank account isn't set  │
│ │ up. Members can't register for │
│ │ them yet.                      │
│ │ Set up banking and GST         │
│ └────────────────────────────────┘
│ Sessions in this series          │
│ ┌ Wed 4 Nov, 8:00-10:00 am ─────┐│
│ │ [Published]                   ││
│ │ Edit Wed 4 Nov                ││
│ └───────────────────────────────┘│
│ Sessions are added 28 days ahead.│
│ The next one, Wed 9 Dec, will be │
│ added on Wed 11 Nov.             │
│ ▸ Past and cancelled sessions in │
│   this series (2)                │
│ Series details                   │
│ Repeats        Weekly on Wed     │
│ First session  4 Nov 2026        │
│ Repeat until   No end date       │
│ [ Change series details        ] │
│ ──────────────────────────────── │
│ [ End series                   ] │
└──────────────────────────────────┘
```
- **Waiting state** (`materialisation.state = pending`): the Sessions region shows `role="status"` "We're adding the sessions in this series. Refresh in a moment." with a "Refresh" link (a plain link to the same URL, so it works without script). `RefreshWhilePending` refreshes at about 2 s, 5 s and 10 s, announces "{n} sessions added." politely when the state flips, then stops. If it is still pending afterwards the text becomes "This is taking longer than usual. Your series is saved and its sessions will appear here. Refresh in a minute."
- **Banking drafts (S2b/S2r)**: the notice sits directly above the sessions list. S2r adds the button "Publish drafts now".

#### Series form, edit mode (`?edit=details`), desktop
```
┌ ‹ Back to series ──────────────────────────────────────────────────┐
│ Change series details                                               │
│ Wednesdays at Rosedale                                              │
│ ┌ Repeats ─────────────────────────────────────────────────────┐   │
│ │ Repeats        Weekly on Wednesdays              (read-only)   │   │
│ │ First session  4 Nov 2026                        (read-only)   │   │
│ │ To change the day or how often it repeats, end this series and │   │
│ │ start a new one.                                               │   │
│ │ Repeat until (optional) [16 Dec 2026]                          │   │
│ │ You can extend or clear this date. To stop the series sooner,  │   │
│ │ use End series.                                                │   │
│ └────────────────────────────────────────────────────────────────┘   │
│ Details / Courts / Places / Costing / Pricing (same fieldsets)       │
│ Cancellation deadline: 48 hours before the first court starts, for   │
│ every session in the series.                                         │
│ ┌ Your changes will apply to 4 upcoming sessions and to sessions ──┐ │
│ │ added later. 1 edited session keeps its own details. Started,    │ │
│ │ past and cancelled sessions don't change.                        │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ [Save series]   Cancel                                               │
└─────────────────────────────────────────────────────────────────────┘
```

#### Series form, create (`/series/new`), 360 px
```
┌──────────────────────────────────┐
│ New recurring series             │
│ ┌ Repeats ─────────────────────┐ │
│ │ (•) Weekly                   │ │
│ │     Every week on the same   │ │
│ │     day as the first session.│ │
│ │ ( ) Every 2 weeks            │ │
│ │ ( ) Monthly                  │ │
│ │ First session                │ │
│ │ [ 4 Nov 2026               ] │ │
│ │ Repeat until (optional)      │ │
│ │ [                          ] │ │
│ │ Every Wednesday from         │ │
│ │ 4 Nov 2026                   │ │
│ │ Sessions are added 28 days   │ │
│ │ ahead and published          │ │
│ │ automatically, so members can│ │
│ │ register as soon as each one │ │
│ │ appears.                     │ │
│ └──────────────────────────────┘ │
│ Details / Courts / Places /      │
│ Costing / Pricing                │
│ 48 hours before the first court  │
│ starts, for every session in the │
│ series.                          │
│ [ Create series                ] │  opens the confirm panel
└──────────────────────────────────┘
```
- **Monthly**: when "Monthly" is chosen, the derived line shows the ordinal ("On the first Wednesday of each month from 4 Nov 2026"). Only when the first date is both the 4th and the last of its weekday (ALG J6, V12/V13) does a radio pair appear: "Which one? (•) 4th Wednesday ( ) Last Wednesday". A 5th-weekday first date shows the fixed line "29 Nov 2026 is the 5th Sunday, so it repeats on the last Sunday of each month." (27 Sep 2026 is the 4th and last Sunday, so it gets the 4th/Last choice instead.) The ordinal and weekday are derived from the first date; the form never asks for them separately.
- **After creation** (P-3): Repeats and First session become `dl` rows with the fixed-pattern sentence. "Repeat until" has `min` set to the saved value when one exists and cannot be set earlier (shortening is End series, T-6). An empty value clears it.

#### End series confirm (series page, 360 px)
```
┌ End series ──────────────────────┐   trigger, aria-expanded
│ ┌──────────────────────────────┐ │
│ │ End this series? No sessions │ │
│ │ will be added after the last │ │
│ │ date.                        │ │
│ │ Last date                    │ │
│ │ [ 20 Oct 2026              ] │ │
│ │ 2 unedited draft sessions    │ │  role="status" (polite), updates
│ │ after this date will be      │ │  when the date changes
│ │ deleted. 1 edited draft and  │ │
│ │ 3 published sessions after   │ │
│ │ this date will be kept.      │ │
│ │ [ ] Also cancel the 3        │ │
│ │     published sessions after │ │
│ │     this date                │ │
│ │ [ End series ] [ Keep series ]│ │
│ └──────────────────────────────┘ │
└──────────────────────────────────┘
```
- Ticking the checkbox changes the status text to "…and the 3 published sessions will be cancelled." and, when players are registered for them, adds "9 players are registered for them. We won't email them, so let them know."
- Unticked, published sessions after the date are kept, as T-6 says.

#### Stale-save state (`?notice=stale` / `series_stale`)
```
┌──────────────────────────────────┐
│ ┌ ! Error: This session changed ┐│   FormBanner kind="error",
│ │ since you opened it. Review   ││   role="alert", focused once
│ │ the latest version and save   ││
│ │ again. Your unsaved changes   ││
│ │ were not kept.                ││
│ └───────────────────────────────┘│
│ Rosedale, Wed 11 Nov 2026        │   page re-fetched: latest values
│ [form with latest values]        │
└──────────────────────────────────┘
```
- Implemented as a redirect to the same page with a codes-only `?notice=session_stale` (or `series_stale`, keeping `?edit=details`), because the page then re-reads the row and the form shows exactly what the server holds. The banner is an error banner, so it takes focus once.

### Key Components
| Component | Purpose | Behavior |
|---|---|---|
| `SessionForm` | One-off create, one-off edit, series-date edit | Controlled state. Sends `createKey` (create) or `expectedVersion` (edit). Buttons carry `name="intent"` (`draft`, `publish`, `save`). Scope line, status line and fixed date come from props |
| `SeriesForm` | Series create and edit | Same fieldsets with a `PatternFieldset`. `mode='create'` or `'edit'`. Effect line and Create confirm in-form |
| `CourtTable` | C1 | Defaults block plus a list of court rows; owns the polite live region; exposes row state through a reducer |
| `CostingFieldset` | C4 costing | Court hire, extras, read-only suggestion line, host-seat caveat |
| `PricingFieldset` | C4 pricing | Model radios (`OptionFieldset`), Flat/By sex/By skill inputs, follow/pin rate, fill button, fee-locked variant |
| `DeadlineFieldset` | Cancellation deadline | Default or specific; static line in the series form |
| `DstChoice` | T-10 | Per-field buttons under a time field with a gap or overlap error |
| `ConfirmPanel`, `InlineConfirm` | Confirms | Presentational panel (in-form confirms) plus the existing form-owning wrapper |
| `SessionList` | List sections, series rows, series date rows | Server component; `SectionPager` per section |
| `SessionSummary` | Read-only view | `dl` and table, one reason line |
| `RefreshWhilePending` | Waiting state | Bounded `router.refresh()`; polite announcements |
| `EndSeriesConfirm` | T-6 | `InlineConfirm` with children: date, checkbox, impact status |

### Interactions
| Trigger | Action | Feedback |
|---|---|---|
| "Apply to all courts" | Sets every row's start and end to the defaults (names untouched) | Polite region: "Times applied to 9 courts." Focus stays on the button |
| Number of courts committed (blur or Enter) | Adds rows with the default times, or removes rows from the end | Polite: "Court table has 9 courts." or "Removed Court 9 and Court 8. 7 courts." |
| "Add court" | Appends a row named with the lowest unused "Court n" | Polite: "Court 10 added." Focus moves to its name input |
| Row "Remove" | Removes the row (hidden when one court remains) | Polite: "Court 7 removed. 8 courts." Focus moves to the previous row's name input (or the next, if first) |
| Default time changed after rows exist | Nothing changes in the rows | Hint under the button becomes "Default times changed. Apply to all courts to update the 9 rows." (not live) |
| Costing or max players edited | Suggestion line updates (not live) | Rate input follows the suggestion while unpinned |
| Type in Rate per player | Pins the rate | Status text changes to "Custom rate. It won't change when costs change." and "Use suggested rate" appears |
| "Use suggested rate" | Unpins; focus returns to the rate input | Status text reverts; polite: "Following the suggested rate." |
| Model radio changed | Reveals that model's inputs; first reveal pre-fills from the final rate; other model's values are kept in state, not posted | Inputs appear after the group in DOM order |
| "Save draft" | Posts `intent=draft` | Redirect with `?notice=draft_saved`, focused banner |
| "Save and publish", free | Posts `intent=publish` | Redirect `?notice=published` |
| "Save and publish", paid | Opens the confirm panel (focus to the prompt; Escape closes and returns focus to the trigger) | Publish posts `intent=publish` |
| Confirm "Publish session" | PUT then publish; pending label "Publishing…" | Outcome table (UJ A4) with the copy below |
| "Cancel session" | Opens the `InlineConfirm` | Confirm label per variant; dismiss "Keep session" or "Keep draft" |
| DST gap choice button | Sets the field to the chosen time and clears its error | Polite: "Court 3 start set to 3:30 am. Save again to apply." Focus returns to the time input |
| DST overlap button | Sets a hidden `disambiguation` for that field and clears its error | Polite: "Court 3 start will use the first 2:30 am." Focus returns to the input |
| End series date changed | Recomputes the impact lines | `role="status"` text updates |
| Series page pending | Refresh at about 2, 5, 10 s | Polite "{n} sessions added." |

### DST choice (T-10, ALG J8)
- Appears directly under the time input that failed (court start or end, or the deadline time). It is a `fieldset`-less group (`role="group"`, `aria-labelledby` the message) after the field's `FieldError`, and the input's `aria-describedby` includes both.
- **Gap** (court time or deadline time that does not exist). Example date and times come from `dstOptions`:
  - Message: "2:30 am doesn't happen on Sun 27 Sep 2026, because clocks go forward an hour at 2 am."
  - Two buttons: "Use 3:30 am" and "Use 1:30 am" (from `shiftedForward` and `shiftedBackward`).
- **Overlap, court time**: only the earlier option exists.
  - Message: "2:30 am happens twice on Sun 4 Apr 2027, because clocks go back an hour at 3 am. We'll use the first one."
  - One button: "Use the first 2:30 am (NZDT)".
- **Overlap, cancellation deadline**: both options are storable. Buttons: "Use the first 2:30 am (NZDT)" and "Use the second 2:30 am (NZST)".
- A series template whose court lies wholly inside 02:00-03:00 gets a plain field error (no choice): "A court that runs only between 2 and 3 am can't be set up as a series, because that hour is skipped when clocks go forward. Choose different times."
- The abbreviation (NZDT or NZST) is taken from the option's instant offset (+13 or +12), never hard-coded to a date.
- UJ's sample overlap text used "1:30 am" on 4 Apr 2027. The overlap hour in New Zealand is 2:00-2:59 am, so the copy above uses 2:30 am. The view function takes the time from the 422 body, so it stays right if the API changes.

### Responsive Behavior
| Breakpoint | Changes |
|---|---|
| < 640px | One column. Court rows are cards (name and Remove on line one, Start and End side by side on line two, each with a visible label). List and series date rows wrap to two or three lines. Buttons full width, primary first. Section pagers stack. No horizontal scroll at 360 px; long location names `break-words` |
| 640-1024px | Court rows become one line (`sm:grid-cols-[1fr_9rem_9rem_auto]`) with column headers (`aria-hidden`; each input keeps its own label with `sm:sr-only`). Money inputs pair up (Court hire, Extras). Buttons `sm:w-auto` in a row |
| > 1024px | Same as tablet; the shell caps at `max-w-3xl`, so nothing gets wider. No multi-column page layout (D3 option 3 rejected) |

### Accessibility Requirements
- [ ] Keyboard: every control reachable in DOM order; confirms open and close with Enter and Escape and return focus to their trigger; the series "Edit {date}" links are unique by visible text; the court count commits on Enter without submitting the form.
- [ ] Screen reader: the scope line is the first text after the H1 and is plain text, not a tooltip; each court row is `role="group"` named by its court name; each start and end input has an accessible name that contains the visible label ("Court 7 start", "Court 7 end").
- [ ] Status messages: success banners `role="status"`, errors `role="alert"` and focused once; "Apply to all courts", add, remove and DST choice results use one persistent `role="status"` `aria-live="polite"` region per form (`aria-atomic="true"`), present from first render.
- [ ] Live updates are never per keystroke: the suggestion line, the deadline readout and the End series impact text are not live (the End series impact is a polite status that updates on the date `change` event only).
- [ ] Colour is never the only signal: labels are text chips with a border ("Edited", "Draft · bank account needed", "Ended"); errors carry "Error:" and the `!` icon via `FieldError`.
- [ ] Contrast WCAG AA: text `text-slate-900` on white, hint `text-slate-700`, error `text-red-800`, links `text-blue-800`; chips use `border-slate-500 text-slate-900` (muted chips use `text-slate-700`, still 7:1 on white).
- [ ] Focus indicators: every control uses `FOCUS_RING`; the focus target of a banner or confirm prompt uses `tabIndex={-1}` plus `FOCUS_RING`.
- [ ] Errors: `ErrorSummary` focused on a failed submit, linking to each field id (`field-<name>`, `court-<key>-start`); each invalid field `aria-invalid="true"` with `aria-describedby` to its message.
- [ ] Target size: every button, link and radio row is at least 44 px tall (`min-h-11`); the court "Remove" is a text button, not an icon.
- [ ] Reflow: no horizontal scroll at 360 px and none at 320 px; long names wrap.
- [ ] Time limits: none. The bounded auto-refresh is three refreshes, never moves focus, and the "Refresh" link is always there.
- [ ] No native dialogs and no `beforeunload` prompts (UAT Required-severity rule).
- [ ] Read-only sessions are `dl` and `table` markup, never disabled inputs.
- [ ] `autocomplete="off"` on money, court-name and time inputs; `inputMode="decimal"` on money, `inputMode="numeric"` on counts; `type="time"` and `type="date"` for times and dates (native pickers); 16 px text so iOS does not zoom.
- [ ] axe `critical` and `serious` = 0 on the list, the editor (draft, published, read-only) and the series page and form at desktop and 360 x 740 (AC-VERIFY-8).

---

## Copy deck (final)

Codes are `?notice=` values. A `{n}` in a sentence takes a singular variant when `n = 1` (written once, "1 player is registered"); `sessions-view.ts` owns a `plural()` helper. Dates are "Wed 4 Nov 2026", times "8:00 am". Strings marked (spec) keep the task file's wording; "(BIND)" marks a change forced by the binding doc.

### Sessions list
| Key | Copy |
|---|---|
| H1 | Sessions for {team name} |
| Intro | Set up one-off sessions or a series that repeats. Members can register once a session is published. |
| Create hint | Members on Auto Enroll are added to every session when it's published. (BIND P-1; replaces UJ's "One-off sessions don't.") |
| Buttons | New session · New recurring series (spec) |
| Sections | Upcoming · Drafts · Series · Past and cancelled (spec) |
| Empty Upcoming | No upcoming sessions. Published sessions appear here. |
| Empty Drafts | No drafts. |
| Empty Series | No recurring series yet. |
| Empty Past | Nothing here yet. |
| Status labels | Published · Started · Ended · Completed · Cancelled (BIND T-11) |
| Draft labels | Draft · Draft · bank account needed · Draft · publishes overnight · Draft · Edited · Not published · date passed |
| Tags | Edited · Series: {series name} |
| Series row status | Active · Ended {date} · Adding sessions… |
| Series row detail | {n} upcoming |
| Banking notice | Some sessions weren't published because your team's bank account isn't set up. · link: Set up banking and GST |
| Page link | Next · Back to start (existing `SectionPager`) |

"Draft · publishes overnight" is shown for an unedited banking-refused draft once the team has set up banking (the run after the setup publishes it). Showing "bank account needed" then would be false.

### Session editor
| Key | Copy |
|---|---|
| H1 new / existing | New session · {Location}, {Wed 4 Nov 2026} |
| Scope: one-off | One-off session. When you publish it, members on Auto Enroll are added to it. (BIND P-1) |
| Scope: series, unedited | One date in {series name}. Changes here apply to {Wed 4 Nov} only. Once you save a change, this date is marked Edited and changes to the series won't overwrite it. |
| Scope: series, edited | Edited. This date has its own details, so changes to {series name} don't apply to it. |
| Back links | Back to {series name} · Back to Sessions |
| Fixed date | To move this night, cancel it and create a one-off session. |
| Status: draft | Draft. Members can't see it until you publish it. |
| Status: edited draft | This date has been edited, so it won't be published automatically. Publish it when it's ready. |
| Status: banking draft | This session wasn't published because your team's bank account isn't set up. · link: Set up banking and GST |
| Status: banking draft, now configured | This session is still a draft. It will be published overnight, or you can publish it now. |
| Status: published | Published. Members can register. |
| Status: published, just now | Published. Members can register. Members on Auto Enroll are being added. (shown for `?notice=published`) |
| Registrations line | No one has registered yet. · {n} players are registered. |
| Change notice (n > 0) | {n} players are registered. We don't email them about changes, so let them know if you change the date, times, place, cancellation deadline or fees. (BIND P-2) |
| Fees locked | Fees can only be lowered: a player has registered or still owes a late-withdrawal fee. (BIND T-7; reworded in registration-and-waitlist Phase 1, ADR 0018 D-85 widening) |
| Fee over the limit | This is higher than the current fee. Fees can only be lowered once a player has registered or still owes a late-withdrawal fee. |
| Capacity hint (published) | Lowering this won't remove anyone who's already in. |
| Buttons | Save draft · Save and publish · Save changes · Cancel session |
| Publish prompt | Publish this session? Members can register straight away, and each player is charged after the game: {fee summary}. Members on Auto Enroll will be added to it. (BIND P-1: every session) |
| Publish buttons | Publish session / Publishing… · Keep editing |
| Fee summary | $12.00 each · $17.00 male, $16.00 female, $16.00 other · $10.00 beginner, $12.00 intermediate, $14.00 advanced |
| `draft_saved` | Draft saved. (spec) |
| `published` | Session published. Members can now register. (spec) |
| `publish_refused_banking` | Add your team's bank account details before publishing a paid session. (spec, verbatim from the API) · Your changes are saved as a draft. · link: Set up banking and GST |
| Publish incomplete | Your other changes are saved as a draft. (+ field errors) |
| `changes_saved` | Changes saved. |
| `changes_saved` (material, n = 0) | Changes saved. No one had registered. |
| `changes_saved` (material, n > 0) | Changes saved. {n} players were registered. Let them know about the change. (BIND P-2) |
| `changes_saved` + promoted | … {k} players moved off the waitlist. (only when the allocator reports k > 0) |
| `instance_saved_first` | Changes saved for {Wed 4 Nov}. This date is now marked Edited. |
| `nothing_changed` | Nothing to change. |
| `session_stale` | This session changed since you opened it. Review the latest version and save again. Your unsaved changes were not kept. (BIND T-12; second sentence added by this doc) |
| `session_started` | This session has started, so it can't be changed or cancelled. |
| `session_not_editable` | This session can't be changed any more. |

Material fields for the "Let them know" line: date (one-off only), earliest court start, latest court end, location, address, cancellation deadline, fees. A save that changes only courts inside the same time range, max players or host seats is not material and shows plain "Changes saved."

### Courts, costing, pricing, deadline
| Key | Copy |
|---|---|
| Courts legend | Courts |
| Courts hint | Times are New Zealand time. |
| Number of courts | Number of courts |
| Default start / end | Default start · Default end |
| Apply button | Apply to all courts |
| Defaults hint | Default times are used for new courts. |
| Defaults changed | Default times changed. Apply to all courts to update the {n} rows. |
| Apply result (live) | Times applied to {n} courts. |
| Count result (live) | Court table has {n} courts. · Removed {names}. {n} courts. |
| Add / remove | Add court · Remove (accessible name "Remove {court name}") |
| Add / remove result (live) | {Court 10} added. · {Court 7} removed. {n} courts. |
| Row labels | Court name · Start · End (accessible names "{name} start", "{name} end") |
| Row tag | Not default |
| Summary line | {n} courts. {m} use the default times. · {n} courts. All use the default times. |
| Court errors | Enter a start time. · Enter an end time. · End must be after start. · Court names must be different. · Enter a court name. |
| Courts error summary | Add at least one court. |
| Places legend, fields | Places · Max players · Reserved host seats |
| Costing legend | Costing |
| Court hire | Court hire (total) |
| Court hire hint | Optional. Leave blank for a free session. |
| Extra expenses | Extra expenses |
| Suggestion | Suggested rate: {$12.00} per player. Court hire plus extras, divided by max players ({18}), rounded up to the next dollar. |
| Suggestion, incomplete | Enter max players to see a suggested rate. |
| Host-seat caveat (reserved seats > 0) | Reserved host seats aren't charged, so this rate won't quite cover the full cost. (BIND T-9 note) |
| Costing locked hint | Raising court hire or extras would raise a rate that follows the suggestion. Set a custom rate to keep the current fee. (T-7, ALG pin guidance) |
| Pricing legend | Pricing |
| Model options | Flat rate · By sex · By skill level (spec) |
| Model help | Everyone pays the same. · One fee for men, one for women, one for other. · One fee per skill level. |
| Flat rate field | Rate per player |
| Following | Following the suggested rate. It changes when costs or max players change. |
| Pinned | Custom rate. It won't change when costs change. · button: Use suggested rate |
| Pinned result (live) | Following the suggested rate. |
| By sex fields | Male · Female · Other · hint under Other: Starts as the lower of the other two until you change it. |
| By skill fields | Beginner · Intermediate · Advanced |
| Fill button | Fill all with the suggested rate |
| Pricing, locked | Pricing: {model name} (static text, no radios) |
| Money errors | Enter an amount like 12.00. · Amount can't be negative. |
| Deadline legend | Cancellation deadline |
| Deadline options | Default: 48 hours before the first court starts · A specific date and time |
| Deadline readout | Currently {Mon 2 Nov, 8:00 am}. |
| Deadline fields | Date · Time |
| Deadline error | The deadline must be before the first court starts. |
| Series deadline | 48 hours before the first court starts, for every session in the series. |

### Series
| Key | Copy |
|---|---|
| H1 new / edit | New recurring series · Change series details |
| Repeats legend | Repeats |
| Repeats options | Weekly · Every 2 weeks · Monthly |
| Repeats help | Every week on the same day as the first session. · Every second week on the same day. · The same weekday each month, for example the 2nd Wednesday. |
| Fields | First session · Repeat until (optional) |
| Derived line | Every {Wednesday} from {4 Nov 2026}[ until {16 Dec 2026}] · Every second {Wednesday} from … · On the {first} {Wednesday} of each month from … |
| Monthly picker | Which one? · 4th {Wednesday} · Last {Wednesday} |
| Monthly, 5th weekday | {29 Nov 2026} is the 5th {Sunday}, so it repeats on the last {Sunday} of each month. |
| Publish hint | Sessions are added {28} days ahead and published automatically, so members can register as soon as each one appears. |
| Create prompt | Create this series? Sessions from {Wed 4 Nov} are added now and published for registration. Members on Auto Enroll are added to each one. [+ Each player is charged after the game: {fee summary}.] [+ Your team's bank account isn't set up, so the sessions will be saved as drafts until it is.] |
| Create buttons | Create series / Creating… · Keep editing |
| `series_created` | Series created. (spec) |
| Waiting | We're adding the sessions in this series. Refresh in a moment. (spec) · link: Refresh |
| Waiting done (live) | {n} sessions added. |
| Slow | This is taking longer than usual. Your series is saved and its sessions will appear here. Refresh in a minute. |
| None yet | No sessions yet. The first one, {Wed 6 Jan 2027}, will be added on {Wed 9 Dec 2026}. |
| Horizon line | Sessions are added {28} days ahead. The next one, {Wed 9 Dec}, will be added on {Wed 11 Nov}. |
| Summary | {Weekly on Wednesdays} · {8:00 am-10:00 am} · {9} courts · {$12.00 each} · from {4 Nov 2026} · until {16 Dec 2026} / no end date |
| Sessions heading | Sessions in this series |
| Past disclosure | Past and cancelled sessions in this series ({n}) |
| Edit date link | Edit {Wed 4 Nov} |
| Details heading, link | Series details · Change series details |
| Fixed fields | To change the day or how often it repeats, end this series and start a new one. (BIND P-3) |
| Repeat until hint | You can extend or clear this date. To stop the series sooner, use End series. |
| Shorten refused | To stop the series sooner, use End series. |
| Effect line | Your changes will apply to {u} upcoming sessions and to sessions added later. [{e} edited sessions keep their own details.] [{r} published sessions have a player who has registered or still owes a late-withdrawal fee, so fees on them can only be lowered.] Started, past and cancelled sessions don't change. |
| Effect line, none upcoming | Your changes will apply to sessions added later. |
| Save button | Save series / Saving… · link Cancel |
| `series_saved` | Series saved. {u} upcoming sessions updated. [{e} edited sessions kept their own details.] |
| `series_saved`, nothing upcoming | Series saved. Sessions added later will use the new details. |
| Skip lines | {n} sessions were left as they are because they have started or closed. · {n} published sessions were left as they are because their cancellation deadline has passed. · {n} published sessions kept their current fees because a player has registered or still owes a late-withdrawal fee, and fees can only be lowered. (BIND T-5 reasons) |
| Adding lines | We're adding the new dates. Refresh in a moment. |
| `series_nothing_changed` | Nothing to change. |
| Series banking refusal | Add your team's bank account details before publishing a paid session. (verbatim) · Nothing was saved. · link: Set up banking and GST (BIND T-5, whole-edit refusal) |
| `series_stale` | This series changed since you opened it. Review the latest version and save again. Your unsaved changes were not kept. |
| Banking notice (S2b) | {n} sessions in this series were saved as drafts because your team's bank account isn't set up. Members can't register for them yet. · link: Set up banking and GST (spec, with count) |
| Banking ready (S2r) | Your bank account is set up. {n} sessions in this series are still drafts. They'll be published automatically overnight, or you can publish them now. [{e} edited drafts need you to publish them yourself.] · button: Publish drafts now |
| Publishing drafts | We're publishing the drafts in this series. Refresh in a moment. |
| End trigger, prompt | End series · End this series? No sessions will be added after the last date. |
| End field | Last date |
| End impact | {d} unedited draft sessions after this date will be deleted. · {e} edited drafts and {p} published sessions after this date will be kept. · …and the {p} published sessions will be cancelled. · {n} players are registered for them. We won't email them, so let them know. |
| End checkbox | Also cancel the {p} published sessions after this date |
| End buttons | End series / Ending… · Keep series |
| `series_ended` | Series ended. No new sessions will be added after {date}. (spec) [+ {c} sessions after that date were cancelled.] [+ {n} players were registered for them. Let them know.] |
| End partial | Series ended. {c} of {p} sessions after that date were cancelled. Cancel the rest from the list. |
| Ended state | Ended. Last session {date}. To run it again, create a new series. |

### Cancel and read-only
| Key | Copy |
|---|---|
| Prompt, one-off draft | Cancel this draft? It won't be published, and you can't undo this. · confirm: Cancel draft · dismiss: Keep draft |
| Prompt, series draft | Cancel {Wed 4 Nov}? The series won't add this date again, and you can't undo this. · confirm: Cancel this date · dismiss: Keep draft |
| Prompt, published, n = 0 | Cancel this session? No one has registered yet. You can't undo this. [Series: + The series won't add this date again.] · confirm: Cancel session · dismiss: Keep session |
| Prompt, published, n > 0 | Cancel this session? {n} players are registered. We won't email them, so let them know. No one is charged for it. You can't undo this. (BIND P-2) |
| `cancelled`, draft | Draft cancelled. |
| `cancelled`, n = 0 | Session cancelled. No one had registered. |
| `cancelled`, n > 0 | Session cancelled. {n} players were registered. Let them know it's cancelled. (BIND P-2) |
| Read-only: started | This session has started, so it can't be changed or cancelled. |
| Read-only: ended | This session has ended, so it can't be changed. |
| Read-only: completed | This session is complete, so it can't be changed. |
| Read-only: cancelled | This session was cancelled, so it can't be changed. |
| Read-only: expired draft | This draft's start time passed before it was published, so it can't be published or changed. |
| Summary headings | Details · Courts · Places · Costing · Pricing · Cancellation deadline |

### Shared
`OUTAGE_MESSAGE`, `SAVE_FAILED_MESSAGE`, `UNCONFIRMED_MESSAGE` (existing in `lib/teams/labels.ts`).

---

## Implementation Guidelines

### For Developers
1. **Pages are Server Components** that mirror `manage/banking/page.tsx`: `z.uuid()` check on ids, `requireUser(here)`, `readCookie('session')`, one parallel API load, 401 to `sessionExpiredUrl(here)`, 403 to `NoAccess`, 422 to `notFound()`, other failures throw. Wrap the body in `ManageProvider`, render `<StripAuthParams />` and `<ManageAreaNav current="sessions" />` after the guards. Pass `createKey={randomUUID()}` (a new key per render, like banking's `changeKey`) to create forms.
2. **Forms hold their inputs in controlled state**, not `defaultValue`, because React 19 resets uncontrolled fields after a form action. Use one pure reducer (`session-form-state.ts`) for the whole form: details, `courts[]` (each with a stable client `key`, so removing a row keeps the others' state), places, costing, pricing (`rateMode: 'follow' | 'pinned'`, fee strings, `lastRevealedModel`), deadline. Validation reuses the shared zod contracts through `useAuthForm`-style submit.
3. **Posting**: courts post as `courts.{i}.identifier|startTime|endTime`; the server action rebuilds the DTO. The Save buttons are `<button type="submit" name="intent" value="draft|publish|save">`. The server action reads `intent`. A publish confirm panel is part of the main form (the confirm button is another `type="submit" name="intent" value="publish"`).
4. **Outcome handling** is in `sessions-actions.ts`. Success and known-state failures `redirect(path?notice=<code>&..., RedirectType.replace)` with codes-only params (counts as integers 0..999, otherwise dropped); validation and banking refusals return `FormState` (values kept); 5xx and offline return `SAVE_FAILED_MESSAGE` or `UNCONFIRMED_MESSAGE` and keep the form. The 409 `session_stale` / `series_stale` redirect carries `notice=session_stale|series_stale` (keep `edit=details` on the series page). Counts shown in banners come from the write response (`updated`, `unchanged`, `skipped{...}`, `registered`, `cancelled`), not from reading the page again.
5. **Money and the suggestion** come from `@sgm/shared` (`suggestedRate`, `defaultFeeOther`, `Money`). `CostingFieldset` parses typed strings with the shared money parser and renders the shared formatter, so web and API agree to the cent. Never use floats.
6. **`phase` and labels come from the API** (T-11). The web never compares a session's start to the browser clock. `sessions-view.ts` maps `status`, `phase`, `draftReason`, `isInstanceOverridden` and `isPayoutConfigured` to the label, the section and the read-only reason.
7. **Time formatting** uses `Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland' })`; the deadline readout and the DST labels use the shared NZ time helpers (`nzLocalToUtc` and offset), never `Date` arithmetic on local strings.
8. **Section ids**: widen `SectionId` in `lib/teams/manage-view.ts` with `'sessions'`, `'session'` and `'series'`. The list, the editor and the series page each render one `ManageSection` with its id so `InlineConfirm` reports into a status region and its `h2` is the focus target.
9. **No client-only logic hides a rule**: the API stays the authority (fixed pattern fields, fee locks, started sessions). The UI renders read-only controls or messages from the GET (`feesLocked`, `phase`) and handles the 409 and 422 anyway.
10. **Tests** (Phase 5): pure view-model tests table-driven from the copy deck (every label, notice, prompt and reason); component tests for the court reducer (apply, count change, add, remove, focus targets, live text), the rate follow and pin transitions, the DST buttons, `ConfirmPanel` and `InlineConfirm` dismiss labels; page tests for guards; E2E with axe on desktop and 360 x 740 (AC-VERIFY-8).

### InlineConfirm change (UJ H13)
`apps/web/src/components/teams/inline-confirm.tsx` today has a hard-coded dismiss button "Cancel", a `section` typed to the five People and banking ids, and only hidden fields plus an optional reason textarea. It is changed in two backward-compatible steps:

1. **Add `dismissLabel?: string`** (default `'Cancel'`). The dismiss button renders `{dismissLabel}`. Existing callers (member-list, invite-link-panel, banking-section) do not change, and their tests keep passing. Every Sessions confirm passes an explicit label, so "Cancel" never sits beside "Cancel session":

   | Confirm | Trigger | Confirm button | `dismissLabel` |
   |---|---|---|---|
   | Cancel a draft | Cancel session | Cancel draft / Cancel this date | Keep draft |
   | Cancel a published session | Cancel session | Cancel session | Keep session |
   | End series | End series | End series | Keep series |
   | Publish (in-form panel) | Save and publish | Publish session | Keep editing |
   | Create series (in-form panel) | Create series | Create series | Keep editing |

2. **Add `children?: ReactNode`**, rendered inside the confirm's `<form>` between the hidden fields and the button row. Named inputs in `children` (the End series date and checkbox) are submitted with the action. A structural test asserts that no Sessions confirm renders a dismiss button named "Cancel".

3. **Extract `ConfirmPanel`** from the same file: the presentational panel (`role="group"`, `aria-labelledby` the prompt, prompt focused on open, Escape calls `onDismiss`, the dismiss button) with no form and no context. `InlineConfirm` becomes `ConfirmPanel` plus its own form. `SessionForm` and `SeriesForm` use `ConfirmPanel` directly, so "Save and publish" and "Create series" can submit the whole main form. `ConfirmPanel`'s open state is local to the form (`useState`), and Escape and focus return follow the shipped behaviour.

4. **Widen `section: SectionId`** to include `'sessions' | 'session' | 'series'` (see guideline 8).

### Component Structure
```
apps/web/src/
├── app/teams/[teamId]/manage/sessions/
│   ├── page.tsx                          ← list: notice banner, header, buttons, banking notice, SessionList
│   ├── new/page.tsx                      ← SessionForm mode="create"
│   ├── [sessionId]/page.tsx              ← SessionForm (draft, published) or SessionSummary (closed)
│   └── series/
│       ├── new/page.tsx                  ← SeriesForm mode="create"
│       └── [ruleId]/page.tsx             ← series view, or SeriesForm mode="edit" when ?edit=details
├── components/teams/
│   ├── session-form.tsx                  ← one-off and series-date editor; fieldset order; buttons; publish ConfirmPanel
│   ├── series-form.tsx                   ← series create and edit; PatternFieldset; effect line; create ConfirmPanel
│   ├── court-table.tsx                   ← defaults block, court rows, live region
│   ├── costing-fieldset.tsx              ← court hire, extras, suggestion line
│   ├── pricing-fieldset.tsx              ← model radios, rate follow and pin, By sex, By skill
│   ├── deadline-fieldset.tsx             ← default or specific date and time
│   ├── dst-choice.tsx                    ← gap and overlap buttons
│   ├── pattern-fieldset.tsx              ← Repeats, first session, monthly picker, derived line (create) / read-only rows (edit)
│   ├── session-list.tsx                  ← list sections, series rows, series date rows, banking notice
│   ├── session-summary.tsx               ← read-only dl and courts table
│   ├── series-summary.tsx                ← details dl, Change series details, End series, Publish drafts now
│   ├── end-series-confirm.tsx            ← InlineConfirm with date, checkbox and impact status
│   ├── refresh-while-pending.tsx         ← bounded refresh and polite announcement
│   ├── use-session-form.ts               ← useReducer wiring, submit, focus handling (hook)
│   ├── inline-confirm.tsx                ← EXTEND: dismissLabel, children, ConfirmPanel, SectionId widened
│   ├── session-components.test.tsx       ← court table, pricing, DST, confirms, list, summary
│   └── inline-confirm.test.tsx           ← or add cases to manage-components.test.tsx (dismiss labels)
└── lib/teams/
    ├── sessions-view.ts                  ← labels, grouping, scope lines, copy deck, notices, counts, formatters (pure)
    ├── sessions-view.test.ts
    ├── session-form-state.ts             ← pure reducer for the controlled form (courts, pricing, deadline)
    ├── session-form-state.test.ts
    ├── sessions-actions.ts               ← Server Actions and API error mapping
    ├── sessions-actions.test.ts
    ├── manage-areas.ts                   ← EXTEND: append { id: 'sessions', label: 'Sessions', segment: 'sessions' }
    └── manage-view.ts                    ← EXTEND: SectionId adds 'sessions' | 'session' | 'series'
```
Extensions follow `apps/web` conventions: components `.tsx` (imports written with `.tsx`/`.ts` suffix as in the shipped files), hooks and pure libs `.ts`, pages `page.tsx`.

### Recommended Libraries/Patterns
- **No new libraries.** The time and date inputs are native (`type="time"`, `type="date"`), which gives mobile pickers for free and avoids a heavy date library. Money and time maths come from `@sgm/shared`.
- **`useActionState` with `FormState`** (via the `useAuthForm` shape) for the main forms; `useModerationAction` through `InlineConfirm` for confirms. Both are shipped.
- **`router.refresh()` in `RefreshWhilePending`** with three timeouts and a `visibilitychange` guard, no polling library.
- **A single `aria-live="polite"` region per form** (`CourtTable` owns it; `PricingFieldset` and `DstChoice` receive an `announce(message)` callback), so announcements do not stack.

---

## Assumptions to confirm
1. **Blank court hire means $0.00 (a free session).** The Court hire hint depends on it; confirm against AC-HAPPY-2 and the `suggestedRate` signature.
2. **The API returns `isPayoutConfigured` on the list GET** (UJ already requires it on the series GET) so "Draft · publishes overnight" can be chosen without a second call.
3. **The series GET instance rows carry `activeRegistrationCount`** so the End series impact can state registered players for the dates after the chosen last date. If it is not returned, the registered-players sentence is dropped and the checkbox label carries no player count.
4. **The list GET supports keyset paging** (`limit`, `cursor`, `next`) per view, which `SectionPager` needs. If it does not, Past and cancelled shows the latest 25 only, and the amendment adds paging.
5. **`seriesChangeEffect` supplies per-instance values for `will_update`, `edited`, `closed` and `has_registrations`.** `needs_banking` is no longer used (BIND T-5).
6. **`bankingReturnTo` accepts the sessions paths** (it accepts any `/teams/<id>/...` path except the banking page, so this holds today).

---

## Validation Checklist

- [x] Meets all user goals: fast multi-court setup, a visible and pinnable rate, scope stated before and after every save, drafts and notices that say what needs the admin
- [x] Accessible per requirements: AC-VERIFY-8 items are each in the checklist above
- [x] Consistent with existing patterns: area nav, `ManageSection`, `FormBanner`, `ErrorSummary`, `OptionFieldset`, `SectionPager`, summary-first `?edit=`, `InlineConfirm`, `returnTo`
- [x] Respects BIND: P-1, P-2, P-3, T-5 to T-12 applied; overrides of UJ and ALG listed
- [x] Responsive across 360 px, tablet and desktop, with a wireframe for each key surface
- [x] Performance acceptable: no client libraries added; court reducer is O(rows) with at most 20 rows; pages are server-rendered
- [x] Implementation feasible: every component maps to a pinned file or a named addition

## Next Steps

1. Apply the amendments below to the task file (done by the orchestrator, not here).
2. Phase 5 builds `session-form-state.ts` and `sessions-view.ts` first (pure, table-tested), then the fieldsets, then the forms and pages.
3. The Phase 6 E2E walk adds: 9-court setup with a Court 7 exception at desktop and 360 px, the rate follow and pin states, the DST gap choice, the series effect line, End series with the checkbox ticked, and the stale-save banner.
4. After build, `/yay:uat` walks the journey; `memory-bank/ux-patterns.md` should then be scaffolded with: dismiss labels never "Cancel" beside a "Cancel ..." action; confirm panels inside forms use `ConfirmPanel`; read-only records use `dl` and tables.

---

## Amendments to the task file

Proposed. The task file was not edited.

1. **Invocation Method, Element** (Costing and Pricing): replace the sentence about the editable "Rate per player" input and "Use suggested rate" in the Costing fieldset with: the **Costing** fieldset holds "Court hire (total)", "Extra expenses" and a read-only suggestion line; the **Pricing** fieldset holds the model radios and, for Flat rate, "Rate per player", which follows the suggestion until typed (pinned) and has a "Use suggested rate" button while pinned; By sex and By skill show one input per fee and a "Fill all with the suggested rate" button. Fieldset order becomes Details, Courts, Places, Costing, Pricing, Cancellation deadline.
2. **Invocation Method, Element** (Courts): add "Number of courts" applying on blur or Enter, the live "Court table has {n} courts." announcement, a "Not default" tag and a summary line; "Add court" appends the lowest unused "Court n".
3. **Invocation Method, Element** (deadline): "Cancellation deadline" is a two-option group, "Default: 48 hours before the first court starts" (sends `null`, T-8) or "A specific date and time". The series form shows the default only.
4. **Invocation Method, Element** (series): the form asks "Repeats" (Weekly, Every 2 weeks, Monthly), "First session" and "Repeat until (optional)", with no separate weekday field. A Monthly first date that is both the 4th and the last weekday shows "Which one? 4th / Last". After creation, Repeats and First session are read-only rows with the fixed-pattern sentence; "Repeat until" can only be extended or cleared. Cross-reference BIND P-3.
5. **Invocation Method, Pages** table: the series page is summary-first (sessions, then details), with "Change series details" (`?edit=details`, form-first, sessions hidden, effect line shown), "Publish drafts now" and "End series". Session editor buttons are "Save draft", "Save and publish", "Save changes", "Cancel session".
6. **Success Criteria, copy**: replace with this doc's copy deck. In particular: the stale message is "This session changed since you opened it. Review the latest version and save again. Your unsaved changes were not kept."; cancel and change banners carry the registered count (P-2), with no emailed wording anywhere; the publish and create confirms say "Members on Auto Enroll will be added to it" for every session (P-1); the one-off scope line is "One-off session. When you publish it, members on Auto Enroll are added to it."
7. **UJ amendment 9 (People-page Auto Enroll hint) is withdrawn.** BIND P-1 keeps the shipped hint in `skill-enroll-panel.tsx`; do not add that file to the Phase 5 list.
8. **UJ AC-HAPPY-12 and AC-HAPPY-13**: AC-HAPPY-12 must read "every session, one-off or series, auto-enrols on its first publish" (P-1). AC-HAPPY-13 loses the notifier double and becomes: cancel and material-change banners and prompts show the registered count variants (0, n) and no email is enqueued.
9. **New Source Files (pin path + extension)**: add `apps/web/src/components/teams/{deadline-fieldset,dst-choice,pattern-fieldset,session-summary,series-summary,end-series-confirm,refresh-while-pending}.tsx`, `apps/web/src/components/teams/use-session-form.ts`, `apps/web/src/lib/teams/session-form-state.ts` and the test files named in the Component Structure. Add to "extend": `apps/web/src/components/teams/inline-confirm.tsx` (dismissLabel, children, ConfirmPanel, SectionId) and `apps/web/src/lib/teams/manage-view.ts` (SectionId).
10. **AC-VERIFY-8**: add to the Then clause that the DST choice buttons, the rate follow and pin status and the End series impact text are covered by the same axe scan states, and that "Number of courts" does not submit the form on Enter.
11. **API requirements (MEDIUM)**: the list GET returns `isPayoutConfigured`, supports `limit`/`cursor`/`next` per view, and each row carries `phase`, `draftReason`, `isInstanceOverridden`, series name; the series GET instance rows carry `activeRegistrationCount`; every write response returns the counts named in `copy` (`updated`, `unchanged`, `skipped.{edited,started,closed,deadlinePassed,feeLocked}`, `registered`, `cancelled`, `failed`). The 422 `dstOptions` entries include the option's `localTime` and its instant so the web can print NZDT or NZST.
12. **Creative Phases**: mark the UI/UX phase complete with this output. Record D1 (defaults plus stacked rows), D2 (Costing then Pricing, follow/pin), D3 (sessions-first series page, form-first edit mode) and D4 (four sections, one page-level notice) as decided, and list "Reset to series" and "Skip a date" (ALG J7) as deferred.
13. **UAT / ux-patterns**: the first `/yay:uat` run should seed `memory-bank/ux-patterns.md` with the three rules in Next Steps item 4.
