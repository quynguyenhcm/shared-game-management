---
slug: team-banking-and-gst
legacy_id:
feature: team-banking-and-gst
status: CREATIVE_COMPLETE
---

# team-banking-and-gst: Team Banking and GST

**Complexity**: Level 3 (inherited from team-banking-and-gst)
**Status**: CREATIVE_COMPLETE
**Roadmap**: team-banking-and-gst
**Branch**: feature/team-banking-and-gst
**Worktree**: N/A (main checkout)

## Task Description

Team merchant banking and tax settings (PRODDUCT-OVERVIEW §2, §8).

- Bank account name + NZ account number validation (`XX-XXXX-XXXXXXX-XX`, incl. bank/branch checks)
- Akahu merchant credentials, stored encrypted; `is_payout_configured` flag
- Gate: paid sessions can't be published until banking is configured
- GST settings: IRD number, GST registration number, GST-registered toggle (IRD number validation)

**Depends on**: team-management (merged in PR #4).

**Downstream**: session-scheduling-engine (consumes the publish gate), wallet-and-akahu-billing (consumes the Akahu credentials and GST snapshot per ADR 0012), tax-invoices-and-exports (GST/IRD details on invoices). registration-and-waitlist is planned and designed but gated on session-scheduling-engine.

## Specification

**Feature Type**: End-User Feature
*Note: the user-facing part is a team-admin settings area; the feature also ships a backend publish gate (an exported function plus a database trigger) that session-scheduling-engine will call. That consumer does not exist yet, so the gate is proven by tests, not by a UI.*
**Primary Persona**: Team Admin (`TEAM_ADMIN`, per team) who sets up how the team gets paid and whether it charges GST. Secondary: the developers of session-scheduling-engine (publish gate), wallet-and-akahu-billing (Akahu credentials, GST toggle read at charge time) and tax-invoices-and-exports (GST/IRD details on invoices).
**Creative Exploration Needed**: Yes (see the Creative Exploration Needed section). The NZ bank-number validation tables, the IRD upper bound, the real meaning of the Akahu credentials, the removal policy and the invoice-time GST number history are LOW or MEDIUM confidence; everything else is concrete.

### Invocation Method
- **Location**: a new team-admin area "Banking and GST" at `/teams/<teamId>/manage/banking`, as a new `apps/web/src/app/teams/[teamId]/manage/banking/page.tsx` beside the existing People page (`manage/page.tsx`). Two `ManageSection`s (same component as People): `id="banking"` "Bank account and Akahu" and `id="gst"` "GST". API: five new routes under `/teams/:teamId` (below). Downstream code: the exported `assertTeamCanPublishPaidSession` and `isPaidSession` in `apps/api/src/modules/team-banking/publish-gate.ts`.
- **Element**:
  - Web: a second entry appended to `MANAGE_AREAS` in `apps/web/src/lib/teams/manage-areas.ts` (`{ id: 'banking', label: 'Banking and GST', segment: 'banking' }`). With two entries `manageAreaLinks` returns the nav and `manage/layout.tsx` renders it. Forms are Server Actions in a new `apps/web/src/lib/teams/banking-actions.ts` (`'use server'`, same pattern as `actions.ts`: bearer token from the session cookie, never optimistic, `revalidatePath` only after a successful change). Removal uses the existing `InlineConfirm` (`apps/web/src/components/teams/inline-confirm.tsx`); no native `confirm()` or `<dialog>`.
  - API (new module `apps/api/src/modules/team-banking/{routes,service,repo,publish-gate}.ts`, registered in `buildApp(deps)` with prefix `/teams`; the service takes `{ db, clock, crypto }`, and `deps.crypto` already exists in `app.ts`):
    - `GET /teams/:teamId/banking` and `PUT /teams/:teamId/banking` and `DELETE /teams/:teamId/banking`
    - `GET /teams/:teamId/gst` and `PUT /teams/:teamId/gst`
    - every route: `config: { policy: requireTeamRole('TEAM_ADMIN') }` (`allowGlobalAdmin` off, like the invite-code and moderation routes), strict zod bodies, `cache-control: no-store`.
  - Shared contracts: `packages/shared/src/api/team-banking.ts` (request and response schemas plus a copy deck `BANKING_FIELD_MESSAGES`, same role as `TEAM_FIELD_MESSAGES`); pure validators in new `packages/shared/src/nz/{bank-account,ird-number}.ts` so the web Server Action and the API run the same rules; new error codes `payout_not_configured` (409) and `banking_in_use` (409) in `packages/shared/src/api/errors.ts` and `ERROR_DEFAULTS` in `apps/api/src/lib/http/errors.ts`.
- **Visibility**: the nav entry and both pages are rendered only for an approved `TEAM_ADMIN` of that team. The API is the authority; the page shows what the API answered (401 redirects to sign-in, 403 renders the existing `NoAccess` page, as the People page does).
- **Navigation**: sign in, My teams (`/teams`), "Manage" on a team row, area nav link "Banking and GST".
- **Contract (what the code does)**:
  - Writes always run in one transaction that locks the team row `FOR NO KEY UPDATE` first, re-checks under that lock that the actor is still an approved admin (the route guard ran outside the transaction), then updates. Same shape as `runModeration` in `modules/teams/service.ts`.
  - Banking is saved as one block: account name, account number, Akahu merchant ID, Akahu app token. After a successful `PUT` all five are present and `is_payout_configured = true`; after `DELETE` all five are NULL and the flag is false. There is no half-configured state.
  - On `PUT /banking`, `accountNumber` and `akahuAppToken` may be omitted to keep the stored value (the form shows them as write-only fields); omitting one that is not stored is a 422. Name and merchant ID are always sent.
  - On `PUT /gst`, `gstRegistered` is required; `gstNumber` and `irdNumber` are optional (omitted keeps, `null` clears). The merged result must satisfy: registered implies a GST number.
  - Encryption: `FieldCrypto.encrypt(plaintext, { table: 'teams', column, rowId: teamId })` from `lib/crypto/crypto.ts` (ADR 0005) for `bank_account_name`, `bank_account_number`, `akahu_app_token`, `ird_number`. `bank_account_last4` is written in the same statement via the existing `deriveBankAccountLast4`. No new environment variables.
  - Account number stored form: hyphenated canonical `BB-bbbb-AAAAAAA-SS` or `-SSS` exactly as entered after normalising separators (a 2-digit suffix is not padded in storage; the validator pads to 3 digits for the check). IRD number stored as digits only inside the envelope. GST number stored as digits only (plaintext column; it is printed on tax invoices).
  - Responses (never the secret): banking `{ banking: { isPayoutConfigured, accountName | null, accountNumberLast4 | null, akahuMerchantId | null, akahuAppTokenSet } }`; gst `{ gst: { gstRegistered, gstNumber | null, irdNumberLast3 | null } }`. The account name is decrypted for the admin; the full account number, the token and the full IRD number are never returned after save.
  - Publish gate (new `publish-gate.ts`): `isPaidSession(fees)` (pure, `Money` primitives, no floats) is true when any fee that applies to the session's `pricing_structure` is above zero (`FLAT`: `fee_flat`; `BY_SEX`: `fee_male`, `fee_female`, `fee_other`; `BY_SKILL_LEVEL`: `fee_beginner`, `fee_intermediate`, `fee_advanced`; NULL counts as 0). `assertTeamCanPublishPaidSession(trx, teamId, fees)` does nothing for a free session; for a paid one it reads `teams.is_payout_configured` `FOR SHARE` inside the caller's transaction and throws `AppError('payout_not_configured')` when false. Call contract (to be written as ADR 0016): call it before taking any `game_sessions` lock, same canonical lock order as ADR 0015 (`teams`, `team_members`, `game_sessions`, ...).
  - Database backstop (P1), new migration `db/migrations/20261016000100000_team_banking_and_gst_invariants.sql`: SQL function `game_session_is_paid(...)` (same rule as `isPaidSession`) and a `BEFORE INSERT OR UPDATE OF status, pricing_structure, fee_flat, fee_male, fee_female, fee_other, fee_beginner, fee_intermediate, fee_advanced, team_id` trigger on `game_sessions` that raises SQLSTATE `23514` with constraint name `game_sessions_paid_requires_payout` when `NEW.status = 'PUBLISHED'`, the session is paid and the team's `is_payout_configured` is false. The trigger reads the team row without a lock (the lock order above forbids taking it after a `game_sessions` row; the TS gate's `FOR SHARE` is what serialises against banking removal). `mapPublishGateDbError` turns that violation into the same `payout_not_configured` error (same idea as `mapMembershipDbError`). Table CHECKs added in the same migration: `teams_payout_requires_banking` (flag true implies name, number, last4, merchant ID and token NOT NULL), `teams_bank_number_last4_together` ((number IS NULL) = (last4 IS NULL)), `teams_gst_registered_requires_gst_number`, `teams_gst_number_format` (`^[0-9]{8,9}$`), `teams_akahu_merchant_id_trimmed`. All new constraints are ledgered in `db/schema-deviations.md` (next free D-numbers after D-46) and the expected-schema fixture and `types.generated.ts` are regenerated.
- **Confidence**: HIGH for location, routes, guards, encryption, lock pattern and the DB constraints (all columns and the encryption pattern already exist; the manage-area seam was left for this). MEDIUM for response shape, removal policy and the paid-session definition. LOW for the exact bank-number validation tables, the IRD upper bound and what the Akahu credentials really are (see Creative Exploration Needed).

### Success Criteria
- **User sees** (exact copy; no message ever echoes what the user typed):
  - Area nav link: `Banking and GST`. Page title: `Banking and GST – {team name} – Shared Game Management`. H1: `Banking and GST for {team name}`.
  - Status line, not configured: `Not set up. Paid sessions can't be published until you add your bank account and Akahu details.`; configured: `Ready to take payments.`
  - Configured detail rows: `Account name: {name}`, `Account number: ending {last4}`, `Akahu merchant ID: {id}`, `Akahu app token: Saved`. Account number and token inputs are empty on the edit form with the hint `Leave blank to keep the saved value.`
  - Save banner (banking): `Banking details saved. Paid sessions can now be published.` After removal: `Banking details removed. Paid sessions can't be published until you add them again.` GST: `GST settings saved.`
  - Removal prompt (InlineConfirm): `Remove banking details? Paid sessions can't be published until you add them again.` with buttons `Remove banking details` and `Cancel`.
  - GST section: toggle label `This team is registered for GST`; fields `GST number`, `IRD number (optional)`; saved view shows the GST number as `123-456-789` and the IRD number as `ending 182`; helper text `Players' prices include GST. GST is worked out as 3/23 of the price. Changing this setting only affects payments taken after you save; existing payments and invoices keep the GST treatment they were charged with.`
  - Field errors (`BANKING_FIELD_MESSAGES`): `Enter the name on the bank account.` / `Use 100 characters or fewer.` / `Enter the account number.` / `Enter an NZ account number in the format 00-0000-0000000-00.` / `That bank or branch number is not recognised. Check the number and try again.` / `That account number does not look right. Check the digits and try again.` / `Enter your Akahu merchant ID.` / `Enter your Akahu app token.` / `Use 255 characters or fewer.` / `Remove any spaces from this value.` / `Enter an 8 or 9 digit IRD number.` / `That IRD number does not look right. Check the digits and try again.` / `Enter your GST number to register for GST.` / `Enter an 8 or 9 digit GST number.` / `That GST number does not look right. Check the digits and try again.`
  - API error messages: `payout_not_configured`: `Add your team's bank account and Akahu details before publishing a paid session.` `banking_in_use`: `Cancel or complete your published paid sessions before removing the banking details.`
- **Verifiable at**: `/teams/<teamId>/manage/banking` (web); `GET /teams/:teamId/banking` and `/gst` (API); the `teams` row in Postgres; the gate through `assertTeamCanPublishPaidSession` and an `UPDATE game_sessions SET status = 'PUBLISHED'`; log lines `team.banking.updated`, `team.banking.removed`, `team.gst.updated`, `team.banking.publish_gate_refused`, `team.banking.decrypt_failed`.
- **Data persisted** (all on the existing `teams` row, `id = :teamId`):

  | Column | Content written | Notes |
  |---|---|---|
  | `bank_account_name` | envelope, AAD `sgm:v1:teams.bank_account_name:<teamId>` | trimmed, 1 to 100 characters, no control characters |
  | `bank_account_number` | envelope, AAD `...bank_account_number:<teamId>` | canonical `BB-bbbb-AAAAAAA-SS[S]`, passes bank/branch and check-digit rules |
  | `bank_account_last4` | `char(4)` digits | last 4 digits of the whole number via `deriveBankAccountLast4`; NULL together with the number |
  | `akahu_merchant_id` | plaintext, trimmed | 1 to 255 characters, no whitespace or control characters |
  | `akahu_app_token` | envelope, AAD `...akahu_app_token:<teamId>` | 1 to 255 characters, no whitespace or control characters |
  | `is_payout_configured` | `true` after `PUT /banking`, `false` after `DELETE` | DB CHECK ties it to the five columns above |
  | `gst_registered` | boolean | true requires `gst_number` |
  | `gst_number` | plaintext digits only | 8 or 9 digits, IRD check-digit rules |
  | `ird_number` | envelope of digits only, AAD `...ird_number:<teamId>` | optional, IRD check-digit rules |

  No new tables. No change to `payments`, `game_sessions` columns or `team_members`.
- **Observable within**: immediate (synchronous request; the page is revalidated after a successful save). The optional change-notification email (AC-ASYNC-1) is observable within about one worker poll.

### Acceptance Criteria

#### AC-ENTRY-1: Team admin finds Banking and GST from the manage area
**Priority**: MUST
**Given** a signed-in approved `TEAM_ADMIN` of a team, on `/teams/<teamId>/manage`
**When** they look at the team-admin area nav
**Then** the nav is rendered (two areas now exist) with links `People` and `Banking and GST`; following `Banking and GST` opens `/teams/<teamId>/manage/banking` showing the status line, the "Bank account and Akahu" section and the "GST" section, with the page title and H1 from Success Criteria

#### AC-ENTRY-2: Anyone who is not an approved admin of this team sees nothing
**Priority**: MUST
**Given** a signed-out visitor, a `PLAYER` with no membership, a PENDING, REJECTED, BANNED or plain APPROVED `MEMBER` of this team, an admin of a different team, and a `GLOBAL_ADMIN` with no admin membership here
**When** each requests the banking page or any of the five API routes
**Then** signed-out gets 401 (the web redirects to sign-in with a return path); every other caller gets 403 from the guard before the body is parsed (the web renders the existing `NoAccess` page); no banking or GST value appears in any of those responses

#### AC-ENTRY-3: The nav shows which area is current
**Priority**: SHOULD
**Given** an admin on the banking page, then on the People page
**When** the area nav is read by a screen reader and by sight
**Then** exactly one link carries `aria-current="page"` and it is the page they are on (today `manage/layout.tsx` calls `manageAreaLinks(teamId)` without a current id, so People would always be marked); the nav is keyboard operable and does not overflow at 360 px; the existing People page behaviour and its tests are unchanged apart from the nav now appearing

#### AC-HAPPY-1: Admin sets up banking for the first time
**Priority**: MUST
**Given** an admin of a team with no banking details (`is_payout_configured = false`)
**When** they enter account name, a valid NZ account number, an Akahu merchant ID and an Akahu app token and press `Save banking details`
**Then** the response is 200, the page shows the save banner, the status `Ready to take payments.`, `Account number: ending {last4}` and `Akahu app token: Saved` (no full number, no token); the `teams` row holds the five columns as in Data persisted with `is_payout_configured = true`; each encrypted column decrypts to exactly what was entered under its AAD

#### AC-HAPPY-2: Admin changes name or merchant ID and keeps the saved number and token
**Priority**: MUST
**Given** a configured team
**When** the admin changes only the account name and the Akahu merchant ID and leaves account number and token blank
**Then** 200; name and merchant ID are updated; the stored `bank_account_number`, `bank_account_last4` and `akahu_app_token` are byte-identical to before; `is_payout_configured` stays true

#### AC-HAPPY-3: Admin replaces the account number and the token
**Priority**: MUST
**Given** a configured team
**When** the admin submits a new valid account number and a new token
**Then** both columns hold new envelopes (sealed with the currently active key) that decrypt to the new values, `bank_account_last4` matches the new number, the old values are gone from the row, and the flag stays true

#### AC-HAPPY-4: Admin removes banking details
**Priority**: MUST
**Given** a configured team with no published paid session
**When** the admin opens `Remove banking details`, confirms in the inline prompt
**Then** `bank_account_name`, `bank_account_number`, `bank_account_last4`, `akahu_merchant_id`, `akahu_app_token` are all NULL and `is_payout_configured = false`; the page shows the removal banner and the not-set-up status with an empty form; Cancel and Escape return focus to the trigger and change nothing

#### AC-HAPPY-5: Admin registers the team for GST
**Priority**: MUST
**Given** a team with `gst_registered = false`
**When** the admin turns on `This team is registered for GST`, enters a valid GST number (hyphens and spaces allowed) and optionally a valid IRD number, and saves
**Then** `gst_registered = true`, `gst_number` holds the digits only, `ird_number` holds an envelope of the digits (if given), the page shows the GST number as `123-456-789` and the IRD number as `ending {last3}`, and the banner `GST settings saved.` is shown

#### AC-HAPPY-6: Turning GST off or on never touches existing payments
**Priority**: MUST
**Given** a team with an existing `payments` row snapshotted with `gst_registered = true` and `gst_rate_bps = 1500` (ADR 0012)
**When** the admin turns GST off, then on again
**Then** the team row follows the toggle, `gst_number` is kept while off, and the `payments` row's `gst_registered`, `gst_rate_bps`, `gst_amount` and `subtotal_amount` are unchanged (this feature writes nothing to `payments`)

#### AC-HAPPY-7: The publish gate lets configured teams and free sessions through
**Priority**: MUST
**Given** (a) a team with `is_payout_configured = true` and a paid session, and (b) a team with no banking and a free session (all applicable fees 0.00 or NULL)
**When** `assertTeamCanPublishPaidSession` runs in a transaction for each, and the session is then set to `PUBLISHED` by SQL
**Then** both resolve without error and both updates succeed; for case (b) `isPaidSession` is false

#### AC-ERROR-1: A malformed account number is refused in place
**Priority**: MUST
**Given** an admin submitting the banking form
**When** the account number has the wrong digit counts (not 2-4-7-2 or 2-4-7-3 digits), letters, or is empty on first save
**Then** 422 `validation_failed` with `fieldErrors.accountNumber` set to the format message (or `Enter the account number.` when absent); nothing is written, previously saved values are untouched; the web form re-renders with the typed name, number and merchant ID kept and focus on the first error (the token is never echoed back)

#### AC-ERROR-2: An unknown bank or branch is refused with its own message
**Priority**: MUST
**Given** a well-formed 15 or 16 digit number whose bank code is not in the table or whose branch is outside that bank's ranges
**When** it is submitted
**Then** 422 with `fieldErrors.accountNumber = ['That bank or branch number is not recognised. Check the number and try again.']`; nothing written

#### AC-ERROR-3: A failing check digit is refused
**Priority**: MUST
**Given** a number with a known bank and branch whose weighted check fails
**When** it is submitted
**Then** 422 with the check-digit message; nothing written

#### AC-ERROR-4: Missing or malformed required banking fields are refused per field
**Priority**: MUST
**Given** a first save, or any save
**When** the name is blank or over 100 characters, or the merchant ID or token is blank, over 255 characters or contains whitespace or control characters, or the body is not JSON
**Then** 422 with the matching message under `fieldErrors.accountName`, `akahuMerchantId` or `akahuAppToken`; all failing fields are reported together; nothing written

#### AC-ERROR-5: The client cannot set server-owned fields
**Priority**: MUST
**Given** a `PUT /banking` or `PUT /gst` body containing `isPayoutConfigured`, `bankAccountLast4`, `teamId`, `role` or any unknown key
**When** it is sent
**Then** 422 (strict schema, `_form` error without naming the key); the row is unchanged

#### AC-ERROR-6: An invalid IRD or GST number is refused
**Priority**: MUST
**Given** the GST form
**When** an IRD number or GST number is not 8 or 9 digits after removing hyphens and spaces, is outside the accepted range, or fails the IRD check digit (primary weights, then secondary weights; a second check digit of 10 is invalid)
**Then** 422 with `fieldErrors.irdNumber` or `fieldErrors.gstNumber` carrying the format message or the "does not look right" message; nothing written, `gst_registered` unchanged

#### AC-ERROR-7: GST registration requires a GST number
**Priority**: MUST
**Given** a team with no `gst_number` (or a request that clears it)
**When** the admin saves with `gstRegistered = true`
**Then** 422 with `fieldErrors.gstNumber = ['Enter your GST number to register for GST.']`; and a raw SQL `UPDATE teams SET gst_registered = true` with no number fails with 23514 `teams_gst_registered_requires_gst_number`

#### AC-ERROR-8: A paid session cannot be published without banking
**Priority**: MUST
**Given** a team with `is_payout_configured = false` and a paid session (DRAFT)
**When** `assertTeamCanPublishPaidSession` runs, or, bypassing it, `UPDATE game_sessions SET status = 'PUBLISHED'` or an `INSERT` with `status = 'PUBLISHED'` runs
**Then** the function throws `AppError('payout_not_configured')` (409, copy from Success Criteria); the raw SQL fails with 23514 `game_sessions_paid_requires_payout` and `mapPublishGateDbError` turns it into the same error; the session stays DRAFT; a `team.banking.publish_gate_refused` log line is written with `teamId` and the reason only

#### AC-ERROR-9: The gate is re-evaluated at every publish, so removed banking blocks later publishes
**Priority**: MUST
**Given** a team that was configured, published a paid session, then removed banking after that session completed (or never had one published)
**When** a different paid DRAFT session is published afterwards, and when a paid session is edited to raise a free published session's fee above zero
**Then** both are refused as in AC-ERROR-8; sessions already PUBLISHED, COMPLETED or CANCELLED are not changed or re-published by the removal

#### AC-ERROR-10: Banking cannot be removed while a paid session is published
**Priority**: MUST
**Given** a team with at least one `PUBLISHED` paid session
**When** the admin (or the API) removes the banking details
**Then** 409 `banking_in_use` with its copy; the row is unchanged; replacing details (AC-HAPPY-2 and AC-HAPPY-3) stays allowed; removal succeeds when the only sessions are free, DRAFT, CANCELLED or COMPLETED

#### AC-ERROR-11: A demoted, banned or concurrent admin cannot write
**Priority**: MUST
**Given** an admin whose rights are removed (demoted or banned) after the page loaded but before submit, and two admins saving banking at the same moment
**When** the stale admin submits; when both submits race
**Then** the stale submit is 403 under the team-row lock and writes nothing; the two racing saves serialise, the final row is wholly one of the two submissions (never a mix of fields), and the flag and CHECKs hold

#### AC-ERROR-12: A decryption failure is surfaced safely and is recoverable
**Priority**: MUST
**Given** a stored envelope whose key id is no longer in the keyring or whose bytes are corrupted
**When** an admin loads the banking page (account name) or the GST section (IRD number)
**Then** the API answers 500 `internal_error` with the safe shared message, logs `team.banking.decrypt_failed` with `teamId` and the `DecryptionError` reason code only (no ciphertext, no key id, no plaintext); the web shows its error page; a full `PUT /banking` with all four fields still succeeds and restores the page

#### AC-ERROR-13: An unavailable API never looks like a save
**Priority**: SHOULD
**Given** the API answers 5xx or is unreachable during a save or removal
**When** the Server Action completes
**Then** the form shows the generic failure banner, keeps the typed values except the token, shows no success banner, and the page is not revalidated as if changed

#### AC-ERROR-14: One team's admin cannot read or change another team's settings
**Priority**: MUST
**Given** an admin of team A and the id of team B (existing, or a random uuid)
**When** they call any of the five routes with team B's id, or craft the Server Action with it
**Then** 403 for both an existing and a non-existing team (same answer, no existence probe); team B's row is untouched

#### AC-ASYNC-1: Other admins are told when banking details change
**Priority**: COULD
**Given** a team with two or more approved admins
**When** one admin saves or removes banking details
**Then** a `send-email` job per other admin is enqueued in the same transaction as the change (P5, idempotency key per change and recipient), the email says who changed it and when and carries no bank detail, token or IRD number, and `pgboss.job.data` holds none of them; a rolled-back change leaves no job

#### AC-VERIFY-1: Database invariants exist, hold from raw SQL and migrate both ways
**Priority**: MUST
**Given** the new migration applied to a cloned test database
**When** raw SQL attempts each violation: flag true with any of the five columns NULL; number without last4 or last4 without number; `gst_registered` with NULL `gst_number`; `gst_number` of 7 or 10 digits or with letters; a padded or empty `akahu_merchant_id`
**Then** each fails with 23514 and the named constraint; the existing plaintext-write rejection (`teams_*_envelope`) still holds; migrate, rollback `--all`, migrate gives an identical schema (`schema.int.test.ts`); `expected-schema.ts` and `types.generated.ts` are updated and drift tests pass; every new constraint, function and trigger has a D-number entry in `db/schema-deviations.md`

#### AC-VERIFY-2: No banking or tax secret is stored in readable form
**Priority**: MUST
**Given** a team saved through the real API with a known account name, account number, token and IRD number
**When** the whole row is read as text (`t::text`) and searched for each secret in plain, hex, base64 and base64url forms (the method in `crypto-columns.int.test.ts`)
**Then** none is found (only `bank_account_last4` and the plaintext `akahu_merchant_id` and `gst_number` appear); each envelope starts `v1.<activeKeyId>.`; an envelope copied to another row or column fails authentication; the four columns are added to `crypto-columns.int.test.ts`

#### AC-VERIFY-3: Secrets are never returned and responses are not cacheable
**Priority**: MUST
**Given** responses from `GET`, `PUT` and `DELETE` on both resources, and their error bodies (422, 403, 409, 500)
**When** each serialised body is searched for the full account number (with and without hyphens), the token, the full IRD number and any ciphertext
**Then** none appears; `GET`/`PUT`/`DELETE` carry `cache-control: no-store`; validation messages never contain what was typed

#### AC-VERIFY-4: Logs carry ids and flags, never banking or tax values
**Priority**: MUST
**Given** log capture (`test/helpers/log-capture.ts`) across a success, each validation failure, a gate refusal, a removal refusal and a decrypt failure
**When** every captured line is searched for the account name, number digits, token and IRD number, and the events are checked field by field
**Then** no value appears anywhere (message, fields, `err`); each event carries its documented fields (`team.banking.updated`: `teamId`, `actorId`, `replacedAccountNumber`, `replacedAkahuAppToken`; `team.banking.removed`: `teamId`, `actorId`; `team.gst.updated`: `teamId`, `actorId`, `gstRegistered`; refusals: `teamId`, `actorId`, `reason`); the logger redaction in `lib/logger/logger.ts` gains camelCase forms (`bankAccount*`, `irdNumber`, `akahu*`; today only snake_case is matched, and `akahuAppToken` is caught only by `/token$/`) with a unit test, and, per the learned rule, every existing `log.*` call and log assertion is grepped for a colliding field name before the patterns land (result noted in the PR)

#### AC-VERIFY-5: Every new route is default-deny and documented
**Priority**: MUST
**Given** the route-policy enumeration (`listRoutePolicies`) and the OpenAPI generator
**When** the app builds with the new module
**Then** each of the five routes declares `requireTeamRole('TEAM_ADMIN')` with `allowGlobalAdmin` false (a route without a policy fails `buildApp`); the 401/403 answer arrives before body validation; `apps/api/openapi.yaml` is regenerated and the drift check passes

#### AC-VERIFY-6: The NZ bank-account validator is correct against independent vectors
**Priority**: MUST
**Given** `packages/shared/src/nz/bank-account.ts` with its bank/branch range table and per-algorithm weights as data, with a header citing the source document and its date (IRD RWT/NRWT specification, bank and branch data on pp. 10 and 11, 2014, and the Payments NZ branch register) and the algorithm selection rule (including the `AB` rule: algorithm A when the account base is below 990000, else B)
**When** a table-driven unit suite runs
**Then** it covers: separators (hyphens, spaces, none), 2- and 3-digit suffix (padded to 3 for the check, the 18-digit weighted string `bank + branch + "0" + account + "0" + suffix`), every algorithm class present in the table (A to G and X), the AB boundary (989999 and 990000), valid vectors from the published source for each class, single-digit corruptions that must fail, unknown bank code, branch just below and above a range, and lengths 14 and 17; no vector is produced by running the implementation itself

#### AC-VERIFY-7: The IRD validator is correct including the secondary weights
**Priority**: MUST
**Given** `packages/shared/src/nz/ird-number.ts` (primary weights 3,2,7,6,5,4,3,2; remainder 0 gives 0, else 11 minus remainder; a result of 10 recomputes with 7,4,3,2,5,2,7,6; a second 10 is invalid; the base is padded to 8 digits)
**When** the unit suite runs
**Then** it passes `49-091-850` (primary weights, check digit 0) and `136-410-132` (needs the secondary weights, check digit 2), rejects a corrupted check digit, a second-10 case, 7 and 10 digit inputs, letters, and values just outside the accepted numeric range, and accepts hyphens and spaces; the range bounds are named constants with a source comment

#### AC-VERIFY-8: `isPaidSession` and the SQL function agree on every fee combination
**Priority**: MUST
**Given** a shared fixture matrix over `pricing_structure` (`FLAT`, `BY_SEX`, `BY_SKILL_LEVEL`) x fees (NULL, `0.00`, `0.01`, a large amount) x which fees are set, including fees set for a structure that does not apply
**When** the TS function and `game_session_is_paid(...)` are evaluated on the matrix
**Then** they agree on every row; a fee for an inapplicable structure never makes a session paid; no `parseFloat`, `toFixed` or `Math.round` is used (the repo lint rules pass)

#### AC-VERIFY-9: Gate, removal and publish serialise without deadlock
**Priority**: MUST
**Given** an open transaction that ran `assertTeamCanPublishPaidSession` (holding the team row `FOR SHARE`) and a concurrent `DELETE /banking`
**When** the removal is issued, then the publish transaction commits (lock-waiter helper `test/helpers/lock-waiters.ts`)
**Then** the removal waits until the publish commits, then re-checks `banking_in_use` and refuses; a publish that starts after the removal commits is refused; the lock order is `teams`, `team_members`, `game_sessions` throughout; no deadlock or `40P01`

#### AC-VERIFY-10: Rotated keys still read, and writes use the active key
**Priority**: SHOULD
**Given** a row sealed with an older key id, then `ENCRYPTION_ACTIVE_KEY_ID` flipped with both keys still in the keyring
**When** the admin loads the page and then saves
**Then** the page reads correctly (the account name decrypts), `needsRotation` is true for the old envelopes, and a save writes envelopes with the new key id; the re-encrypt runbook in `docs/getting-started.md` still applies unchanged

#### AC-VERIFY-11: Shared contracts, error codes and copy are single-sourced
**Priority**: MUST
**Given** `packages/shared/src/api/team-banking.ts`, `packages/shared/src/api/errors.ts` and `ERROR_DEFAULTS`
**When** typecheck and the shared and web unit tests run
**Then** the Fastify routes and the web `api-client` import the same zod schemas; the two new error codes are in `ErrorCode` and `ERROR_DEFAULTS` (the `Record<ErrorCode, ...>` type makes a missing entry a compile error); the web shows the copy deck strings from Success Criteria verbatim; the web Server Action and the API run the same `nz` validators and give the same field messages for the same input

#### AC-VERIFY-12: Quality gates stay green and cover the new code
**Priority**: MUST
**Given** the new files
**When** `pnpm run ci` runs
**Then** lint, typecheck, tests and build pass; `apps/api/src/modules/team-banking/**` and `packages/shared/src/nz/**` are added to the coverage `include` list in `vitest.config.ts` and meet 80% lines, functions, branches and statements; no `console.*` in `apps/api/src`; no hard-coded configuration

#### AC-VERIFY-13: The banking page is accessible, responsive and safe to type secrets into
**Priority**: MUST
**Given** Playwright journeys on the desktop project and the 360 x 740 project (`apps/web/e2e/team-banking.spec.ts`)
**When** the page is walked in its empty, configured, validation-error and removal-confirm states
**Then** axe-core reports no critical or serious violation; every input has a visible label and errors are linked by `aria-describedby` with focus moved to the first error or the banner; there is no horizontal scroll at 360 px; no native browser dialog appears; the token input is `type="password"` with `autocomplete="off"` and `spellcheck="false"`; the account number input is `inputMode="numeric"` with `autocomplete="off"`; the page sets `robots: noindex` and `dynamic = 'force-dynamic'`

#### AC-VERIFY-14: The decisions are recorded where later features will find them
**Priority**: SHOULD
**Given** the finished feature
**When** the docs are reviewed
**Then** `docs/adr/0016-team-banking-and-publish-gate.md` states the gate contract (call before any `game_sessions` lock, `FOR SHARE`, the trigger backstop, the paid-session rule, how the recurrence job must handle a refusal), the field semantics and what is write-only; `systemPatterns.md`, `techContext.md` (Akahu row: credentials stored, no client yet) and `productBrief.md` are updated by the build Documentation agent

#### AC-INTEGRATION-1: The real stack stores and returns what was submitted
**Priority**: MUST
**Given** `app.inject` over a cloned Postgres with the real `createCrypto` keyring (no mocked crypto)
**When** an admin `PUT`s banking and GST, and the test then reads the `teams` row with raw SQL and decrypts each envelope with the AAD
**Then** every decrypted value equals what was sent, `GET` returns only the masked forms, and the sequence works through the real route guard (a session created with the auth test helper), not a stubbed `request.auth`

#### AC-INTEGRATION-2: The gate behaves identically on real `game_sessions` rows
**Priority**: MUST
**Given** a team, a DRAFT paid session with courts (so the instant triggers run) and a DRAFT free session, built with the test factories
**When** each is published by raw `UPDATE`, with and without banking, and through `assertTeamCanPublishPaidSession`
**Then** the TS gate and the trigger agree; the session-instant triggers still derive `starts_at` and `ends_at`; an `INSERT` already `PUBLISHED` follows the same rule

#### AC-INTEGRATION-3: Bank-number vectors come from the published source, not from the code under test
**Priority**: MUST
**Given** the validator's test vectors
**When** a reviewer traces any three of them
**Then** each traces to an example or rule in the cited IRD or Payments NZ document (or a real-format number checked by hand against the published algorithm), recorded beside the vector with its source; none was generated by calling the validator

#### AC-INTEGRATION-4: Browser journeys prove the entry points on both viewports
**Priority**: SHOULD
**Given** the Compose stack with `AUTH_FAKE_OAUTH=true` and the worker running (not part of `pnpm run ci`, like `teams.spec.ts`)
**When** an admin signs in, opens Manage, follows `Banking and GST`, saves banking, saves GST and removes banking, and a plain member requests the same URL
**Then** each step shows the Success Criteria copy on desktop and at 360 px, the member sees the no-access page, and no request leaves the stack for Akahu (no Akahu client exists in this feature)

### Scope Boundaries
- **In scope**:
  - Banking and GST settings API, shared contracts, validators, copy deck, and the manage-area page with Server Actions.
  - Encrypted storage of account name, account number, Akahu app token and IRD number through the existing field crypto; `is_payout_configured` kept in step with the stored block.
  - The exported publish gate (`isPaidSession`, `assertTeamCanPublishPaidSession`, `mapPublishGateDbError`), its SQL function and trigger backstop, and the table CHECKs.
  - The removal guard (`banking_in_use`), logging events, logger redaction for camelCase keys, new error codes, ADR 0016, ledger entries, coverage-gate additions.
  - A small shared constant for the GST rate (basis points) only if creative decides it lives here (see question 10).
- **Out of scope**:
  - Calling Akahu (verifying credentials, payment links, webhooks, payout checks): wallet-and-akahu-billing. `is_payout_configured` here means "details present and well-formed", not "verified live".
  - Calculating GST, charging, wallet and snapshot writes (ADR 0012 snapshot is written by wallet-and-akahu-billing; this feature only owns the live `teams.gst_registered`, `gst_number`, `ird_number` it reads).
  - Tax invoices, PDF and exports (tax-invoices-and-exports), including any history of GST numbers (question 11).
  - Creating, editing or publishing sessions and the publish UI or endpoint (session-scheduling-engine); this feature supplies only the gate and the error code. Surfacing the gate error with a link to `/teams/<id>/manage/banking` is that feature's job.
  - Checking that the account name matches the account, live IRD or GST lookups, several accounts per team, subscription billing.
  - `GLOBAL_ADMIN` support access (question 9), step-up re-authentication, a key-rotation CLI, team deletion.
- **Dependencies**: team-management (merged): `requireTeamRole`, `findApprovedRole` and `lockTeam` in `modules/teams/repo.ts` (reuse or move to a shared place), the manage area registry and `InlineConfirm`, the `team.action.refused` hook pattern (the hook in `teamsRoutes` is plugin-scoped, so the banking module needs its own copy or a shared helper); platform-foundation: `FieldCrypto` and keyring (ADR 0005), `Money` primitives (ADR 0009), `teams` columns and `game_sessions` (D-03, D-04), ADR 0012 payment snapshot. Consumers (not built): session-scheduling-engine must call the gate before any `game_sessions` lock and handle a refusal in the recurrence job (a materialised `PUBLISHED` paid instance will hit the trigger); wallet-and-akahu-billing reads `teams` credentials under a team-row `FOR SHARE`; tax-invoices-and-exports reads `gst_number`.
- **NFR implications**: P1 (constraints and trigger in SQL, TS only shapes errors), P2 (no float money in `isPaidSession`), P4 (AES-256-GCM envelopes with key id, plaintext never logged even on error), P7 (no new env vars; the keyring is already validated at boot). NZ Privacy Act 2020: bank details and IRD numbers are personal information, so they are write-only after save and masked. Accessibility: axe clean at desktop and 360 px. Observability: structured `team.banking.*` events with `traceId` from the request logger. Retention: overwriting banking details keeps no history (financial history lives in `payments`, which snapshot GST treatment); see question 11 for the GST number.

### Creative Exploration Needed
1. **NZ bank-account validation tables (LOW)**. The structure is settled (bank 2, branch 4, account 7, suffix 2 or 3 digits; weighted modulus check on an 18-digit string; algorithms A to G modulus 11 for A to E and 10 for F and G, X always passes; AB selection at 990000). I could not confirm the weight arrays or the per-bank branch ranges from an official source in this pass; only secondary summaries of the IRD RWT/NRWT specification (2014, pp. 10 and 11) were reachable. Decide: the authoritative source to transcribe (IRD spec plus the Payments NZ branch register), how to treat a bank code or branch added after 2014 (reject as unrecognised, which blocks a legitimate team, or accept on check digit alone), whether the 2-digit suffix is stored as typed (spec default) or padded, and what `bank_account_last4` shows for a 2-digit suffix (the existing helper takes the last 4 digits of the whole number, so `...-00` shows `2300`). Do not copy LGPL or GPL reference implementations; use them only as an offline cross-check.
2. **IRD range and the GST number relationship (LOW/MEDIUM)**. Check digit rules are confirmed (see AC-VERIFY-7). The numeric range is not: python-stdnum and two other libraries use more than 10,000,000 and less than 150,000,000; Oracle's HCM documentation says 200,000,000. A wrongly rejected real number blocks a team, a wrongly accepted one still needs a valid check digit, so the spec leans permissive; confirm against Inland Revenue. In NZ the GST number is the IRD number, yet the schema has both columns and `gst_number` is plaintext while `ird_number` is encrypted, so saving the same value in both defeats the encryption. Decide: keep two fields with `gst_number` treated as public (it is printed on invoices) and `ird_number` optional (spec default), or a single field.
3. **What the Akahu credentials are (LOW)**. The schema has `akahu_merchant_id` (plaintext) and `akahu_app_token` (encrypted). Akahu's own model (app ID, app secret, user tokens) may not map one-to-one, and wallet-and-akahu-billing may need more than two values. Decide the labels, the format rules (the spec only requires trimmed, 1 to 255 characters, no whitespace), whether a verification call belongs at save time (needs an `AkahuClient` port and test doubles now) or later with a documented path for wallet-and-akahu-billing to clear `is_payout_configured` on an authentication failure.
4. **Removal policy and recurrence (MEDIUM)**. The spec refuses removal while a paid session is `PUBLISHED` (service-level) and backstops only the publish side in SQL. Alternatives: allow removal and rely on billing failing visibly, or add a DB trigger on `teams` for the removal side. Also decide what the recurrence materialiser should do when a generated paid instance is refused (skip with a visible failure, create as DRAFT); that is a session-scheduling-engine contract to put into ADR 0016.
5. **Definition of a paid session (MEDIUM)**. The spec uses the fee columns that apply to `pricing_structure`. `custom_player_rate` and `calculated_rate_per_player` are excluded on the assumption that the scheduling engine writes the resulting fee into the fee columns; session-scheduling-engine may need to adjust the rule (the SQL function and the TS function change together, guarded by the parity test).
6. **How `is_payout_configured` is derived (MEDIUM)**. The spec keeps the stored column, written by the service, with a one-way CHECK. A generated column (drop and re-add, codegen change) or a derivation trigger would remove the chance of drift. Pick one.
7. **What admins can read back (MEDIUM)**. Spec: full account name, account number last 4 only, token never, IRD last 3 (needs a decrypt on read), merchant ID and GST number in full; secrets are not echoed back into a failed form (the account number is, so a typo can be fixed; the token never). Confirm, including whether the IRD last 3 is worth a decrypt on every GST page load.
8. **Change notification and audit (LOW/MEDIUM)**. Changing the payout account is the obvious fraud move for a compromised admin session. The spec carries the email to other admins as a COULD (AC-ASYNC-1) and keeps only structured logs as audit. Decide whether to build the email, add `banking_updated_at` and `banking_updated_by` columns, or require a fresh sign-in before banking changes.
9. **Who else can see it, and UX placement (MEDIUM)**. `GLOBAL_ADMIN` has no access by default, in line with ADR 0015's "no global-admin override"; a read-only masked support view may be wanted later. UX: one page with two sections (spec default, matches People) versus two sub-pages; how the area nav marks the current page when the layout cannot read the path (client nav with `usePathname`, per-page nav, or a layout prop); whether My teams should hint "Banking not set up" for admins (needs a field on `MineTeamsResponse`).
10. **Where the GST rate constant lives (MEDIUM)**. The UI copy states the 3/23 treatment and the 15% rate must come from one constant. Decide whether `GST_RATE_BPS = 1500` is introduced here (for example `packages/shared/src/nz/gst.ts`) or by wallet-and-akahu-billing, with this page importing it either way.
11. **GST number history for invoices (MEDIUM, cross-feature)**. `payments` snapshots `gst_registered` and the rate but not the GST number, and this feature overwrites `gst_number` in place. A tax invoice reprinted years later (7-year retention) would show the current number, not the one in force. Decide whether tax-invoices-and-exports snapshots the number at issue time or this feature keeps an append-only history table; this feature should at least not make the second option harder.

## Test Strategy

### Approach
- **Emphasis**: balanced, weighted to unit tests for the validators and to integration tests for storage and the gate.
  - The NZ bank-account and IRD validators are pure, table-driven unit suites with vectors traced to published sources (AC-VERIFY-6, 7, AC-INTEGRATION-3).
  - Encryption at rest, masking, the CHECKs, the publish trigger and the lock races run against real PostgreSQL 17 with the real keyring (P1, P4).
  - Playwright covers the manage-area page on desktop and 360 px with axe.
- **Target test count**: about 90 across 5 phases. That is above the 20-test guideline because the spec has 43 ACs, two validators that each need a vector table, and a TS/SQL parity matrix for the paid-session rule (one file, many rows).
- **Load-sensitive tests**: race tests use `waitForLockWaiters`, never sleeps. Re-run timing-only failures sequentially before treating them as regressions (`testing-injected-clock`).

### File Organization
- **New test files**:
  - `packages/shared/src/nz/bank-account.test.ts`: format, separators, suffix padding, every algorithm class, the AB boundary, bank/branch ranges, corruptions; each vector records its source.
  - `packages/shared/src/nz/ird-number.test.ts`: primary and secondary weights, second-10 invalid, range bounds, lengths, separators.
  - `packages/shared/src/api/team-banking.test.ts`: strict bodies, omit-to-keep and `null`-to-clear semantics, copy deck.
  - `apps/api/src/modules/team-banking/publish-gate.test.ts`: `isPaidSession` matrix (Money only).
  - `apps/api/test/integration/team-banking-schema.int.test.ts`: the CHECKs, `game_session_is_paid` parity with the TS matrix, the publish trigger on INSERT and UPDATE, migrate/rollback round trip.
  - `apps/api/test/integration/team-banking-api.int.test.ts`: routes, policies, guard before validation, masking, write-only fields, `no-store`, cross-team 403, stale-admin 403, the racing saves, decrypt failure, key rotation.
  - `apps/api/test/integration/team-banking-gate.int.test.ts`: the gate and trigger on real sessions, `banking_in_use`, and the gate-versus-removal race with lock waiters.
  - `apps/api/test/integration/team-banking-logs.int.test.ts`: event fields asserted field by field, with no values anywhere (`logging-redaction-global`).
  - `apps/web/src/lib/teams/banking-actions.test.ts`: Server Action error mapping, typed values kept except the token, no revalidate on failure.
  - `apps/web/e2e/team-banking.spec.ts`: AC-INTEGRATION-4 and AC-VERIFY-13.
- **Extend existing**:
  - `apps/api/test/integration/crypto-columns.int.test.ts`: the four columns written through the real API (AC-VERIFY-2).
  - `apps/api/src/lib/logger/logger.test.ts`: camelCase redaction patterns, plus a collision check over existing log fields.
  - `apps/api/src/lib/auth/policy.test.ts` or the route-policy enumeration test: five new routes.
  - `apps/api/src/lib/http/errors.test.ts`: `payout_not_configured` and `banking_in_use`.
  - `apps/api/src/openapi.test.ts` and `apps/api/src/coverage-gate.test.ts`.
  - `apps/api/test/integration/schema.int.test.ts` and `apps/api/test/fixtures/expected-schema.ts`: new constraints, function and trigger.
  - `apps/web/src/lib/teams/manage-areas.test.ts`: the second area and the current-area marking.
  - `apps/web/src/components/teams/manage-components.test.tsx`: nav rendering.
  - `apps/web/src/proxy.test.ts`: `/teams/*/manage/banking` is no-store and protected (already covered by the manage pattern; assert it).

### What NOT to Test
- `FieldCrypto` internals (envelope format, AES-GCM, keyring parsing): covered by platform-foundation. Here we test that the right columns go through it with the right AAD.
- `requireTeamRole` and `findApprovedRole` internals: covered by auth and team-management. Here we test that every route uses them and that the re-check runs under the lock.
- Akahu itself: no Akahu client exists in this feature (out of scope). The E2E only asserts that no request leaves the stack.
- Session publishing UI or endpoints: session-scheduling-engine. The gate is tested through its exported function and raw SQL on factory-built sessions.
- Visual styling: covered by UAT.

### Per-Phase Test Guidance
- **Phase 1** (about 30 tests):
  - Bank-account and IRD vector suites.
  - Shared zod contracts and the copy deck.
  - The new error codes.
  - CHECKs from raw SQL.
  - Migrate/rollback round trip; regenerated types and expected schema.
  - `isPaidSession` matrix and SQL function parity.
- **Phase 2** (about 25 tests):
  - Banking and GST routes: policies, guard before validation, cross-team 403.
  - Saving behaviour: first save, omit-to-keep byte-identical, replace with the active key, removal, GST toggle leaving `payments` untouched.
  - Errors: 422 per field, strict bodies, stale-admin 403 under the lock, racing saves never mixing fields, decrypt failure, key rotation.
  - Data exposure: masking and `no-store`; no secret in any body or log; camelCase redaction plus the collision check.
- **Phase 3** (about 15 tests):
  - The gate on free, paid, configured and unconfigured cases.
  - The trigger on INSERT and UPDATE; the `mapPublishGateDbError` mapping.
  - Re-evaluation after removal; `banking_in_use`.
  - The gate-versus-removal race with lock waiters; lock order and no 40P01.
- **Phase 4** (about 12 tests): manage-area nav with the current area marked, Server Action mapping, page states (empty, configured, error, removal confirm), write-only inputs, no-store and noindex. Also the change-notification email if creative promotes AC-ASYNC-1.
- **Phase 5** (about 8 tests): Playwright journeys on both viewports with axe, the coverage gate, and doc checks.

## Implementation Roadmap

### Implementation Plan

#### Overview
Build team banking and GST as a new `modules/team-banking` slice, alongside teams. The columns already exist on `teams` (platform-foundation D-03), so the migration adds only CHECKs, a paid-session SQL function and a publish trigger on `game_sessions`. Writes follow team-management's moderation shape: lock the team row, re-check the admin, update, log ids only. Secrets go through the existing `FieldCrypto` and are write-only after save. The publish gate is exported for session-scheduling-engine and backstopped in SQL, and ADR 0016 records the contract.

#### Requirements
- **Functional**: the spec's 43 ACs. Key rules:
  - **Banking**: saved as one block, with `is_payout_configured` tied to it; omit-to-keep for the number and the token; removal is refused while a paid session is PUBLISHED.
  - **GST**: registered requires a GST number, and changes never touch `payments`.
  - **Validation**: NZ bank and IRD numbers checked by shared validators.
  - **Publish gate**: paid sessions are refused without payout configured, in both TS and SQL.
- **Non-functional**:
  - Integrity and secrets: P1 (SQL constraints and trigger), P2 (no float money), P4 (encrypted and never logged), P7 (no new env vars).
  - Privacy: masking under the NZ Privacy Act 2020.
  - Accessibility: axe-clean at 360 px.
  - Observability: `team.banking.*` events.

#### Component Analysis
- **New components**:
  - `packages/shared/src/nz/{bank-account,ird-number}.ts`: pure validators.
  - `packages/shared/src/api/team-banking.ts`: contracts and the copy deck.
  - `apps/api/src/modules/team-banking/{routes,service,repo,publish-gate}.ts`.
  - The migration.
  - `apps/web/src/app/teams/[teamId]/manage/banking/page.tsx`.
  - `apps/web/src/lib/teams/banking-actions.ts`.
  - Banking form components.
  - ADR 0016.
- **Affected components**:
  - `apps/api/src/app.ts`: registers the module.
  - `apps/api/src/lib/logger/logger.ts`: camelCase redaction. This is a global change, so grep every caller first.
  - `apps/api/src/lib/http/errors.ts` and `packages/shared/src/api/errors.ts`: the new codes.
  - `apps/web/src/lib/teams/manage-areas.ts` and `apps/web/src/app/teams/[teamId]/manage/layout.tsx`: the second area and current-area marking.
  - `apps/api/src/modules/teams/repo.ts`: `lockTeam` and `findApprovedRole`, reused or moved to a shared place (creative architecture).
  - `vitest.config.ts`: coverage includes.
  - `db/schema-deviations.md`: D-47 onwards.
  - `expected-schema.ts`, `types.generated.ts` and `openapi.yaml`.
- **Component interactions**: web Server Action → API route (team guard, TEAM_ADMIN) → service transaction → `lockTeam FOR NO KEY UPDATE` → admin re-check → validate with the shared `nz` validators → encrypt with `FieldCrypto` → update `teams` → log. Downstream, session-scheduling-engine calls `assertTeamCanPublishPaidSession` (the team row `FOR SHARE`) before any `game_sessions` lock, and the trigger backstops a raw publish.

#### Implementation Strategy
Critical path: the validators and migration (Phase 1), then the API (Phase 2), the gate (Phase 3), then the web (Phase 4). The gate depends only on Phase 1, so Phases 2 and 3 can be reviewed independently.

#### Dependencies & Risks
- **Risk**: wrong bank or branch tables reject real accounts. **Mitigation**: creative Q1 picks the source and the policy for unknown codes; vectors trace to the published source (AC-INTEGRATION-3).
- **Risk**: the global camelCase redaction hides fields other features log, as happened in team-management. **Mitigation**: grep every `log.*` call and log assertion before adding patterns; run the whole integration suite in Phase 2.
- **Risk**: the Akahu credential shape changes when billing is designed. **Mitigation**: creative Q3; keep the storage a two-field block that a later migration can extend; no Akahu call here.
- **Risk**: the trigger on `game_sessions` breaks existing tests that publish paid sessions. **Confirmed at plan time**: `insertSession` defaults to FLAT `fee_flat 17.00` on a team with no banking, and `apps/api/test/integration/session-instants.int.test.ts:67` publishes such a session expecting 23514 `game_sessions_instants_when_live`. A BEFORE trigger fires before CHECK constraints, so it would see `game_sessions_paid_requires_payout` instead. **Mitigation**: in Phase 1, `insertTeam` gains a `payoutConfigured` option (valid envelopes through the test keyring) and that test configures banking or uses a free session. Phase 1 also greps every test for PUBLISHED and runs the full integration suite. registration-and-waitlist's planned `insertPublishedSession` must create a configured team (note for its build gate).
- **Risk**: ADR and ledger numbering clash with registration-and-waitlist, which also planned ADR 0016 and D-47+. **Mitigation**: this feature builds first and keeps ADR 0016 and D-47 onwards. registration-and-waitlist renumbers to ADR 0017 and the next free D-number at its build gate.
- **External dependency**: none at runtime. NZ bank-branch data is transcribed at build time.

#### Observability Requirements
- **Applies**: Yes. Load `context/observability-requirements.md` during build.
- **Logging**:
  - `team.banking.updated` (`teamId`, `actorId`, `replacedAccountNumber`, `replacedAkahuAppToken`).
  - `team.banking.removed`.
  - `team.gst.updated` (`gstRegistered`).
  - `team.banking.publish_gate_refused`.
  - `team.banking.decrypt_failed` (reason code only).
  - The existing `team.action.refused` pattern for 403 and 409.
  - No values, ever. Error codes are logged as `errorCode`, never `code` (global redaction).
- **Tracing**: existing HTTP spans; no new external calls.
- **Metrics**: none beyond standard HTTP.
- **Configuration**: no new env vars.

#### API Requirements - REST
- **Involves REST API**: Yes.
- **OpenAPI spec location**: `apps/api/openapi.yaml` (generated, drift-tested). Include 401, 403, 409 and 422 responses on every route.
- **Endpoints**: `GET`, `PUT` and `DELETE /teams/:teamId/banking`; `GET` and `PUT /teams/:teamId/gst`.
- **Auth**: `requireTeamRole('TEAM_ADMIN')`, `allowGlobalAdmin` false, plus the admin re-check under the team lock.
- **Build phase**: load `context/api-rest-requirements.md`.
- **GraphQL**: No.

### New Source Files (pin path + extension)
- [ ] `db/migrations/20261016000100000_team_banking_and_gst_invariants.sql`: CHECKs, `game_session_is_paid`, publish trigger (D-47 onwards)
- [ ] `packages/shared/src/nz/bank-account.ts` (+ `.test.ts`): NZ bank-account normalise and validate, tables as data with a source header
- [ ] `packages/shared/src/nz/ird-number.ts` (+ `.test.ts`): IRD/GST number normalise and validate
- [ ] `packages/shared/src/nz/gst.ts`: `GST_RATE_BPS`, only if creative Q10 places it here
- [ ] `packages/shared/src/nz/index.ts`: barrel, exported from `packages/shared/src/index.ts`
- [ ] `packages/shared/src/api/team-banking.ts` (+ `.test.ts`): zod contracts and `BANKING_FIELD_MESSAGES`
- [ ] `apps/api/src/modules/team-banking/routes.ts`
- [ ] `apps/api/src/modules/team-banking/service.ts`
- [ ] `apps/api/src/modules/team-banking/repo.ts`
- [ ] `apps/api/src/modules/team-banking/publish-gate.ts` (+ `.test.ts`): `isPaidSession`, `assertTeamCanPublishPaidSession`, `mapPublishGateDbError`
- [ ] `apps/api/test/integration/team-banking-{schema,api,gate,logs}.int.test.ts`
- [ ] `docs/adr/0016-team-banking-and-publish-gate.md`
- [ ] `apps/web/src/app/teams/[teamId]/manage/banking/page.tsx`
- [ ] `apps/web/src/lib/teams/banking-actions.ts` (+ `.test.ts`): Server Actions (`'use server'`, `.ts`, no JSX)
- [ ] `apps/web/src/components/teams/banking-form.tsx`
- [ ] `apps/web/src/components/teams/gst-form.tsx`
- [ ] `apps/web/e2e/team-banking.spec.ts`
- [ ] extend: `apps/api/src/app.ts`, `apps/api/src/lib/logger/logger.ts` (+ test), `apps/api/src/lib/http/errors.ts`, `packages/shared/src/api/errors.ts`, `packages/shared/src/index.ts`, `apps/api/src/lib/db/types.generated.ts`, `apps/api/test/fixtures/expected-schema.ts`, `apps/api/test/helpers/factories.ts`, `apps/api/test/integration/crypto-columns.int.test.ts`, `apps/api/openapi.yaml`, `db/schema-deviations.md`, `vitest.config.ts`, `apps/web/src/lib/teams/manage-areas.ts` (+ test), `apps/web/src/app/teams/[teamId]/manage/layout.tsx`, `apps/web/src/lib/teams/labels.ts`

### Phases
- [x] **Phase 1: Schema, validators and shared contracts**: the migration (CHECKs, `game_session_is_paid`, publish trigger, D-47 onwards), the NZ bank and IRD validators with sourced vectors, zod contracts and copy deck, the two error codes, regenerated types and expected schema, and factory updates for the new trigger (`insertTeam({ payoutConfigured })`, fix `session-instants.int.test.ts:67`, full integration run). ACs: AC-VERIFY-1, 6, 7, 8 (SQL side), 11, AC-INTEGRATION-3.
- [x] **Phase 2: Banking and GST API**: module, routes, service (lock, re-check, encrypt, mask), logging, and camelCase redaction with the collision grep. ACs: AC-HAPPY-1 to 6 (API), AC-ERROR-1 to 7, 11, 12, 14, AC-VERIFY-2, 3, 4, 5, 10, AC-INTEGRATION-1.
- [x] **Phase 3: Publish gate and removal guard**: `isPaidSession`, `assertTeamCanPublishPaidSession`, `mapPublishGateDbError`, `banking_in_use`, the race tests, and ADR 0016. ACs: AC-HAPPY-7, AC-ERROR-8, 9, 10, AC-VERIFY-8, 9, AC-INTEGRATION-2.
- [ ] **Phase 4: Web banking area**: the manage-area nav with the current area marked, the banking page with both sections, Server Actions, the removal `InlineConfirm` and write-only inputs. Also the change-notification email if creative promotes AC-ASYNC-1. ACs: AC-ENTRY-1 to 3, web side of AC-HAPPY-1 to 5, AC-ERROR-13, (AC-ASYNC-1).
- [ ] **Phase 5: E2E, accessibility and docs**: Playwright journeys on both viewports with axe, the coverage gate, and updates to `systemPatterns.md`, `techContext.md` and `productBrief.md`. This phase delivers the complete entry-to-success flow. ACs: AC-VERIFY-12, 13, 14, AC-INTEGRATION-4.

## Creative Phases

Level 3 with LOW-confidence items, so creative is required.
- [x] **Algorithm Design** (required): Q1, Q2, Q5. Status: complete, `memory-bank/creative/team-banking-and-gst-nz-validation-algorithm.md`.
- [x] **Architecture Design** (required), complete, `memory-bank/creative/team-banking-and-gst-banking-architecture.md`: Akahu credential semantics and whether to verify at save time (Q3); the removal policy and the recurrence contract for ADR 0016 (Q4); deriving `is_payout_configured` (Q6); change notification, audit columns or step-up re-auth (Q8); `GLOBAL_ADMIN` access (Q9, API side); where the GST rate constant lives (Q10); GST number history for invoices (Q11); where `lockTeam` and `findApprovedRole` live once a second module needs them.
- [x] **User Journey Design** (required for Level 3): setup, replace, remove, GST, and the publish-refusal hand-off. Status: complete, `memory-bank/creative/team-banking-and-gst-payout-setup-user-journey.md`.
- [x] **UI/UX Design** (required): Q7, Q9 (UX) and copy. Status: complete, `memory-bank/creative/team-banking-and-gst-banking-page-uiux.md`.
- **Reconciliation step**: after the parallel creative docs return, write one binding reconciliation section here before build (learned rule: review-process-plan-claims).

### Design Critique (advisory)
- **Backend**: codex (`adversarial-review --base origin/main --scope branch`), 2026-10-16. Log: `.claude-logs/codex-critique-team-banking-20261016.log` (local).
- **Verdict**: needs-attention. The removal and payment-creation race is still open, and the four docs don't yet define one contract for payout fields, GST fields, notification or UI state.
- **Findings**:
  - high · A removal can commit while an uncommitted payment waits on the team foreign key, for a session that is already COMPLETED (architecture doc, lines 120-136).
  - high · Option 3C (drop team-supplied Akahu credentials) is treated as chosen without product approval and contradicts the task, UI and journey docs (architecture doc, lines 88-99).
  - high · The validator accepts some wrong branches, and nothing revokes publish eligibility when payouts to the account fail (algorithm doc, lines 159-171).
  - high · The GST data model differs across the docs: one field in the algorithm doc, two everywhere else (algorithm doc, lines 256-275).
  - medium · The generated column and its all-or-none CHECK have no plan for existing partial rows (architecture doc, lines 180-197).
  - medium · The UI doc (forms always shown) and the journey doc (`?edit=` URL state) define incompatible editing models (UI/UX doc, lines 94-160).
  - medium · The change email's content (whether it shows the account ending) and its retry idempotency are unresolved (architecture doc, lines 209-213).
- **Resolution**: see Creative Reconciliation.

### Creative Reconciliation (binding for build)

Where this section and a creative doc or an AC disagree, this section wins. Build agents apply these rulings when they reach the affected AC. Decisions the user made on 2026-10-16 are marked **(user)**.

**R1 · The payout destination is the bank account only (Q3, option 3C) (user).**
- Teams enter the account name and account number only.
- The platform's Akahu app credentials are server configuration owned by wallet-and-akahu-billing.
- This feature never reads or writes `akahu_merchant_id` or `akahu_app_token`. They stay reserved for billing, and their existing redaction and envelope CHECKs are unchanged.
- The payout block is `bank_account_name` (encrypted), `bank_account_number` (encrypted) and `bank_account_last4`.
- No Akahu call is made at save time.
- Removed everywhere: the merchant ID and token fields, their copy and validation messages, `akahuAppTokenSet`, `akahuMerchantId`, and the token cases in AC-ERROR-4, AC-HAPPY-1/2/3, AC-VERIFY-2/3/13 and AC-INTEGRATION-1. The 3B fallback is not built.

**R2 · One GST number field (Q2, option G2) (user).**
- The GST section has a toggle and a single `GST number` field, with the hint "This is your IRD number."
- `gst_number` is stored as plaintext canonical digits with no leading zero, and CHECK `^[1-9][0-9]{7,8}$`.
- This feature never writes `ird_number`.
- Removed: the IRD field, `irdNumber` in the request, `irdNumberLast3` and `irdNumberSet` in the response, the "Remove the saved IRD number" control, the IRD decrypt and unreadable paths, and IRD from AC-HAPPY-5, AC-ERROR-6/12, AC-VERIFY-2/3/10.
- The validator still applies the IRD check-digit and range rules to the GST number.
- Turning GST off keeps the saved number.

**R3 · A failed payout destination blocks publishing until fixed (user). Fixes critique high #3.**
- New column `teams.payout_blocked_at timestamptz NULL`.
- `is_payout_configured` becomes a generated column: true when name, number and last4 are all set AND `payout_blocked_at IS NULL` (architecture Q6, extended).
- Saving banking details always clears `payout_blocked_at`. Removing them clears it too.
- ADR 0016 obliges wallet-and-akahu-billing to set `payout_blocked_at` (under the team-row lock) when Akahu declines a payout because of the destination account, and never to clear or change the banking columns.
- Page states:
  - status line when blocked: "Needs attention. Payments to the account ending {last4} failed. Check the account number and save it again."
  - `GET /banking` returns `payoutBlocked: boolean`.
- New AC-ERROR-15 (MUST): with `payout_blocked_at` set, the gate and the trigger refuse a paid publish, and a save clears the block.

**R4 · Lock protocol (architecture Q4, option 4C). Fixes critique high #1.**
- The architecture doc's design is binding:
  - the gate and the `game_sessions` publish trigger take `teams FOR KEY SHARE`;
  - PUT banking and PUT GST take `FOR NO KEY UPDATE`;
  - DELETE banking takes `teams FOR UPDATE` as its first statement and only reads afterwards;
  - the `teams` BEFORE UPDATE trigger `teams_banking_in_use` backstops raw-SQL removal.
- Removal is refused while the team has a PUBLISHED paid session or a PENDING or OVERDUE payment, through one SQL function `team_banking_in_use` that the service also calls.
- **Added contract C-BIL-PAY (ADR 0016):** every payment-creation path takes `teams FOR KEY SHARE` and checks `is_payout_configured` before inserting any payment row. This includes post-game payment links for an already-COMPLETED session. A removal therefore either waits for that payment and then refuses, or commits first so the payment path sees no banking and fails cleanly.
- AC-VERIFY-9 adds both orderings of this race against a COMPLETED session, using a test-only payment stand-in that follows C-BIL-PAY.
- The lock order across features stays `teams → team_members → game_sessions → registrations`. The registration allocator never locks `teams` stronger than `KEY SHARE`.

**R5 · Migration strategy for existing rows. Fixes critique medium #5.**
- The migration first cleans up rows the old schema allowed:
  - a partial banking block (some of name, number or last4 missing) is cleared to all-NULL and logged in a `NOTICE` count;
  - `gst_registered = true` with no `gst_number` becomes false;
  - a `gst_number` that fails the format CHECK is set to NULL.
- New CHECKs are added `NOT VALID`, then `VALIDATE CONSTRAINT`d in the same migration.
- The rollback restores the plain `is_payout_configured` column.
- An upgrade test runs from a pre-feature database seeded with every partial shape.
- Phase 1 also fixes `crypto-columns.int.test.ts` (`writeBanking` and the copied-row case) and `session-instants.int.test.ts:67`.

**R6 · Editing model: summary, then Change (user). Fixes critique medium #6.**
- The journey doc's model is binding:
  - **Nothing saved:** the form shows directly.
  - **Saved:** a read-only summary (`dl` pairs) with "Change banking details" / "Change GST settings". Edit mode is `?edit=banking|gst`. "Remove banking details" appears only in summary view.
  - **Saves:** successful saves redirect with `?notice=` codes (`banking_saved`, `banking_updated`, `banking_account_changed`, `banking_removed`, `gst_saved`).
- From the UI/UX doc:
  - the per-page `ManageAreaNav` with a `current` prop, with no nav on `NoAccess`;
  - an extracted `no-access.tsx`;
  - write-only behaviour: blank keeps the saved number, the typed number is re-echoed after a 422;
  - `inputMode=numeric` for the account number;
  - the outage copy;
  - the GST helper split by toggle state, with "3/23" derived from `GST_RATE_BPS`;
  - the text-led status line;
  - the copy table, unless this section overrides it.
- `returnTo` hand-off from a refused publish (journey AC-ENTRY-4, SHOULD), validated as the journey doc specifies.
- **No hint on My teams** (UI/UX doc). The publish-refusal hand-off is the discovery path, so `MineTeamsResponse` doesn't change. Journey AC-ENTRY-5 is dropped.
- Configured status copy: "Set up. Paid sessions can be published." (journey doc: nothing is verified with Akahu).
- `InlineConfirm` is generalised to take a `section` id (UI/UX amendment 11). registration-and-waitlist later extracts `ConfirmDisclosure` from the generalised version.

**R7 · Unreadable details (AC-ERROR-12).**
- `GET /banking` answers 200 with `accountName: null, unreadable: true` and logs `team.banking.decrypt_failed`.
- The page shows "Needs attention" and a form where name and number are required.
- A full save restores the page.

**R8 · Change notification (architecture Q8 with journey content rules). Fixes critique medium #7.**
- AC-ASYNC-1 becomes MUST.
- On every banking save that changes something, and on removal, a `send-email` job per approved admin (the actor included) is enqueued in the same transaction.
- The email names who changed it and when and links to the page. It contains **no account name or digits**.
- Idempotency: the form carries a hidden per-render `changeKey` uuid (the team-create D-46 pattern). The job key is `banking-changed:<teamId>:<changeKey>:<recipientId>`, and a replayed request with the same `changeKey` enqueues nothing new.
- A save that changes nothing (same values) writes nothing and sends no email.
- No email for GST changes.
- New audit columns `banking_updated_at` and `banking_updated_by`, shown as "Last changed by {name} on {date}" in the summary.
- Step-up sign-in is deferred.

**R9 · Validators and the paid rule (algorithm doc, binding).**
- **Source:** IRD *Payroll Calculations & Business Rules Specification 2026-27* §6.1/§7. The Payments NZ register is a cross-check only.
- **Bank account checks:** bank ID plus weighted modulus. No branch ranges. Unknown banks are refused, and so are legacy IDs 07, 09, 26, 28, 29, 33 and 35.
- **Bank account storage:** stored as `BB-bbbb-AAAAAAA-SSS` (suffix padded to 3 digits). `last4` comes from the account base.
- **The last-4 helper:** `deriveBankAccountLast4`'s rule moves to `packages/shared/src/nz/bank-account.ts`, and the API helper delegates to it.
- **IRD/GST range:** 10,000,000 to 200,000,000 inclusive. Secondary weights apply only when the primary result is 10. The 150000026 erratum is pinned as rejected.
- **Paid rule:** the fee columns that apply to the session's `pricing_structure`, with NULL counted as 0 and a session paid only when a fee is above 0. The SQL twin fails closed.
- **Review:** an annual April review of the `nz/*` tables is recorded in ADR 0016.

**R10 · Shared code, logging and constants (architecture doc, binding).**
- `modules/teams/admin-lock.ts` provides `lockTeamRow` and `assertTeamAdminUnderLock`, and `findApprovedRole` moves there.
- `lib/auth/team-refusals.ts` is registered once in `buildApp`.
- Redaction gains only the anchored patterns `/^(bank_?)?account_?(name|number)$/i` (no IRD pattern is needed under R2). The collision grep on `main` was clean.
- Log events use `changedFields` instead of the `replaced*` fields, which `/token$/` would have redacted.
- `GST_RATE_BPS` lives in `packages/shared/src/nz/gst.ts`.
- **Q11:** wallet-and-akahu-billing snapshots `payments.gst_number` at charge time (ADR 0016 contract).
- No `GLOBAL_ADMIN` access.

**R11 · Ledger, ADR and phase impact.**
- Ledger D-47 onward covers the cleanup, the CHECKs, the generated column, `payout_blocked_at`, the audit columns, `team_banking_in_use`, both triggers and `game_session_is_paid`.
- ADR 0016 is `docs/adr/0016-team-banking-and-publish-gate.md`. It includes the gate contract, the recurrence contract (gate before insert, refused instance as DRAFT, at most one admin email per rule per run window), C-BIL-PAY, `payout_blocked_at`, the `returnTo` hand-off, the paid rule, and the GST number snapshot.
- Phase 2 gains the audit columns and the change email; the email moves out of Phase 4.

**R12 · Other amendments adopted as written in the creative docs**, except where R1-R11 override:
- algorithm doc: amendment table;
- architecture doc: lock, gate API (`checkTeamCanPublishPaidSession`, `mapBankingDbError`), AC-ERROR-10 copy mentioning unpaid payments, AC-VERIFY-1/4/9/14;
- journey doc: AC-HAPPY-1 to 4 behaviour, AC-ERROR-10 panel handling, AC-ERROR-13 raised to MUST, AC-VERIFY-13 extra states;
- UI/UX doc: amendments 1, 2, 5, 6, 7, 8, 10, 11.

Precedence: R1-R11 first, then the doc that owns the question (algorithm: Q1/Q2/Q5; architecture: Q3/Q4/Q6/Q8/Q9-API/Q10/Q11; journey: flow and hand-off; UI/UX: layout and copy).

---

## Execution State

**Build Status**: RUNNING
**Current Phase**: 4 of 5 (Phases 1-3 complete)
**Auto-Build Mode**: YES
**Current Step**: Phase 3 committed; Phase 4 next
**Step Started**: 2026-10-16
**Can Resume**: YES
**Creative Reconciliation**: binding. Build agents apply R1-R12 over the spec ACs.
**Creative Critique**: CREATIVE CRITIQUE: codex — usable (needs-attention; 4 high + 3 medium, all resolved in the reconciliation)

### Active Sub-Agents
- Algorithm Design: COMPLETE
- Architecture Design: COMPLETE
- User Journey Design: COMPLETE
- UI/UX Design: COMPLETE

### Completed Steps
- Step 0.1: Task provisioned on feature/team-banking-and-gst
- Step 3: Spec Writer Agent (sonnet) - COMPLETE; taxonomy lint CLEAN (43 ACs); human approved 2026-10-16
- Step 4-5: Codebase analysis and implementation plan - COMPLETE (5 phases, Level 3); plan-time check found the session-instants test break
- Algorithm Creative Design: COMPLETE (2026-10-16) - Output: memory-bank/creative/team-banking-and-gst-nz-validation-algorithm.md
- Architecture Creative Design: COMPLETE (2026-10-16) - Output: memory-bank/creative/team-banking-and-gst-banking-architecture.md
- User Journey Creative Design: COMPLETE (2026-10-16) - Output: memory-bank/creative/team-banking-and-gst-payout-setup-user-journey.md
- UI/UX Creative Design: COMPLETE (2026-10-16) - Output: memory-bank/creative/team-banking-and-gst-banking-page-uiux.md
- Step 4.5: Codex design critique - COMPLETE (needs-attention, 7 findings)
- Creative Reconciliation: COMPLETE (2026-10-16); user chose bank-account-only payout (3C), a single GST number (G2), payout_blocked_at, and summary-then-Change editing
- Phase 1 (Schema, validators, shared contracts): COMPLETE (2026-10-16) - 884 unit + 304 integration passing; lint/typecheck/build PASS; Codex review clean. Ledger D-47..D-53. Handoff for later phases: `payoutBlockFor`/`testFieldCrypto`/`insertTeam({payoutConfigured})` in test factories; `apps/api/test/fixtures/paid-session-matrix.ts` for the phase-3 TS twin; teams trigger `teams_guard_banking_removal` raises 23514 constraint `teams_banking_in_use` (map by err.constraint); `is_payout_configured` is generated (insert/update typed never); `deriveBankAccountLast4` now delegates to shared (last4 from the account base).
- Phase 2 (Banking and GST API): COMPLETE (2026-10-16) - 890 unit + 328 integration passing; lint/typecheck/build PASS; Codex review P1 (replay) and coordinator review items fixed. Ledger D-54. Handoff for later phases: module `apps/api/src/modules/team-banking/` (routes, service, repo, emails, errors); `assertTeamAdminUnderLock` in `modules/teams/admin-lock.ts` (shared with teams); `refusing()` and `registerTeamRefusalLogging` in `lib/auth/team-refusals.ts` (registered once in `buildApp`; a WeakSet stops the hook re-logging an error `refusing` already logged); `mapBankingDbError` in `team-banking/errors.ts` (Phase 3 adds `mapPublishGateDbError` beside it, keyed on `err.constraint`); `repo.isBankingInUse` calls SQL `team_banking_in_use` (the one predicate for removal and Phase 3); test helper `apps/api/test/helpers/banking-scene.ts` (person, team, body, put/get/delete, `bankingEmailJobs`); every response from the five routes carries `Cache-Control: no-store`; the web client (Phase 4) must send a fresh `changeKey` uuid per form render and reuse it on retry; a replayed key returns 200 with the current state and sends nothing.
- Phase 3 (Publish gate and removal guard): COMPLETE (2026-10-16) - 897 unit + 354 integration passing (26 new in `team-banking-gate.int.test.ts`); lint/typecheck/build/coverage PASS; review PROCEED (Anthropic-side; Codex produced no verdict). No schema change. Handoff: `publish-gate.ts` (`isPaidSession`, `checkTeamCanPublishPaidSession`, `assertTeamCanPublishPaidSession(trx, {teamId, pricingStructure, fees, log?, actorId?})`), `mapPublishGateDbError` in `errors.ts`, test-only `test/helpers/payment-stand-in.ts`, ADR 0016 (gate contract, recurrence, C-BIL-PAY, `payout_blocked_at`, `returnTo`, paid rule, GST snapshot, April review). Phase 4 must validate `returnTo` per ADR 0016 (`safeReturnTo`, same-team `/teams/<id>/` prefix, not the banking page itself). `systemPatterns.md`/`techContext.md` updates are left to Phase 5.

### Halt State
(none)

### Deviations
<!-- Per entry: - Phase <N> | <file:line/artifact> | <rationale>. -->
- Phase 1 | db/migrations/20261016000100000_team_banking_and_gst_invariants.sql | cleanup order reversed vs R5 (null malformed gst_number first, then deregister numberless teams) so the CHECKs validate.
- Phase 1 | same migration | no CHECK tying payout_blocked_at to a banking block (neither R3 nor architecture doc defines one); service clears it on save/removal.
- Phase 1 | apps/api/.kysely-codegenrc.json | override types the generated is_payout_configured as never for insert/update.
- Phase 1 | packages/shared/src/nz/ird-number.test.ts | IRD spec example 150000026 is rejected under both weight sets (check digit 5, not 6); conclusion unchanged from creative doc.
- Phase 1 | same migration (removal trigger) | trigger named `teams_guard_banking_removal`; it raises constraint `teams_banking_in_use` (the R4 name). Map errors by `err.constraint`. Accepted by the phase reviewer.
- Phase 1 | packages/shared/src/api/team-banking.ts | copy-deck strings beyond the UI/UX deck (`accountNameTooLong`, `changeKeyInvalid`, `accountNumberUnknownBank`, IRD range reusing the check-digit message). Phase 4 must check the wording against the UI/UX copy table. Accepted by the phase reviewer.
- Phase 1 | apps/api/test/integration/teams-schema.int.test.ts (~line 470) | the rollback test now rolls back 2 migrations because the new migration is newest. The assertion is not weakened. Accepted by the phase reviewer.
- Phase 2 | apps/api/src/modules/team-banking/service.ts | an identical re-save is a no-op unless payout_blocked_at is set; then it clears the block, stamps the audit columns, emails "saved again" (changedFields []) and logs changedFields [] (intended per R3).
- Phase 2 | apps/api/src/modules/team-banking/service.ts | DELETE has no changeKey (the contract has none): the server generates a uuid, and a second removal is a 200 no-op with no email.
- Phase 2 | apps/api/src/modules/team-banking/service.ts | the `team.banking.decrypt_failed` log also carries a constant `column` field. It may log more than once per request (the same block is opened for the check and the read); noise only, no value is logged.
- Phase 2 | apps/api/src/modules/team-banking/errors.ts | `mapBankingDbError` lives in the team-banking module, not `lib/http/errors.ts`.
- Phase 2 | apps/api/src/modules/team-banking/routes.ts | an onSend hook sets `Cache-Control: no-store` on every response from the five routes.
- Phase 2 | apps/api/src/lib/auth/team-refusals.ts | schema-level 422s (zod body validation) are not logged as `team.action.refused`. The stale-admin 403 used to log twice (service plus global hook, as in team-management); it now logs once.
- Phase 2 | db/migrations/20261016000200000_team_banking_change_keys.sql | review-driven (Codex P1): `teams.banking_change_keys uuid[]` (newest 32 keys, ledger D-54, reversible) makes the change key a durable replay claim under the team lock. A single last-key column was rejected: it cannot recognise a replay after a different admin saved in between. Removal appends its server key too.
- Phase 2 | apps/api/src/modules/team-banking/service.ts | review-driven (R7): a save that omits the account number while the stored number is unreadable or absent answers 422 `accountNumberRequired`, so an unreadable block is replaced only by a full save. The name is always in the request, so an unreadable name needs no extra rule.
- Phase 2 | apps/api/test/integration/teams-schema.int.test.ts, team-banking-upgrade.int.test.ts | rollback counts raised by one (3 and 2) because D-54 is now the newest migration; assertions not weakened.
- Phase 3 | apps/api/src/modules/team-banking/publish-gate.ts | gate takes the architecture doc's object form `(trx, {teamId, pricingStructure, fees, log?, actorId?})`, not positional `(trx, teamId, fees)`: the paid rule needs the pricing structure.
- Phase 3 | apps/api/test/integration/team-banking-gate.int.test.ts | a raw INSERT as PUBLISHED can never commit (the instants CHECK fails first), so "INSERT succeeds when configured" and the "INSERT first, removal queued" race are asserted as the refusal/no-queue outcome; "removal first, INSERT queued" is a real race and passes.
- Phase 3 | apps/api/test/integration/team-banking-api.int.test.ts:173 | replaced an unsafe `expect.any(String)` (Phase 2 lint failure on a clean checkout) with a typeof check; behaviour unchanged.
- Phase 3 | publish-gate.ts | review hardening: `Object.hasOwn` guard so prototype-key structure strings fail closed.
- Phase 2 | apps/api/openapi.yaml | no 500 is documented on the five routes: no route in the spec documents one (the global error schema covers it). A malformed team id answers the global error body, covered by a test.
