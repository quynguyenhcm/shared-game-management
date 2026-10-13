# User Journey Design: Auth and User Roles

**Created**: 2026-10-06
**Status**: DECIDED
**Decision Type**: User Journey
**Task**: `auth-and-user-roles` (Level 3). Spec: `memory-bank/tasks/auth-and-user-roles.md` (approved).
**Binding inputs**: `auth-and-user-roles-architecture.md` (DECIDED) and `auth-and-user-roles-algorithm.md` (DECIDED). This document does not re-decide anything in them. It defines the journey layer that sits on top: screens, transitions, redirects, copy, focus and recovery. Where the inputs disagree with each other or with the spec, the resolution is listed in [Contradictions resolved](#contradictions-resolved).
**Basis**: the stacked worktree (platform-foundation + this task). The web shell today is `layout.tsx` (no header), `page.tsx` (API status line) and `api-client.ts` (`health()` only). Styling is Tailwind 4 with no component library. Next 16.3, React 19.3. There is no `ux-patterns.md` yet, so the form, banner and focus conventions below become the reference for later features.

---

## Journey Overview

**Feature**: Self-registration and sign-in by email/password, Google and Facebook; required sex choice once per user; password reset by email; sign-out; protected-page redirect with `returnTo`; session expiry; connecting and disconnecting sign-in methods; role guards for admins.
**Primary Persona**: Player (`PLAYER`), often on a phone at the venue.
**Journey Type**: Hybrid. Forms are synchronous (Server Action → API → redirect). OAuth is a cross-system redirect round trip (web → provider → web callback → API). Password reset is asynchronous (job queue → email → link, often opened on another device).
**Orchestration Pattern**: Dedicated single-purpose pages (one task per URL) with OAuth-first layout, progressive-enhancement Server Actions, a shared code-based notice and error framework, and `returnTo` carried end to end.

### Success Statement
> A player taps "Continue with Google" (or types an email and password), picks a sex once, and is back on the page they wanted within a minute, with the header saying "Signed in as {name}". Every failure leaves them on a page that says what happened and offers the next step.

---

## Persona Context

### Primary User
- **Who**: Player (`PLAYER`, productBrief Key Personas).
- **Goal**: Get into the app quickly to find a team and register for sessions. Onboarding flow: sign up, pick sex, find or join a team (team step arrives with `team-management`).
- **Context**: Often on a phone at the venue or on the bus, after someone shares a link in a Facebook Messenger group chat. Patchy mobile data or shared venue Wi-Fi (many players behind one NAT address). Sometimes the link opens inside the Facebook or Instagram in-app browser.
- **Proficiency**: Casual. Expects "Continue with Google" to just work, forgets which method they used last time, uses password managers and autofill on the phone.

### Secondary Users
- **Team Admin** (`TEAM_ADMIN` per team): same sign-in journey. Their difference is downstream: team-scoped pages and API routes check approved membership on every request. This feature only reserves the denial copy.
- **Global Admin** (`GLOBAL_ADMIN`): same sign-in journey. Role is granted by an operator through the CLI. `/account` shows a "Platform admin" label so the operator can confirm the grant took effect.
- **Operator** (developer): runs `users set-role` in a terminal. The CLI output is part of the copy deck.

---

## Contradictions resolved

Resolutions applied throughout this document. The planner should copy the AC-related ones into the task file.

| # | Conflict | Sources | Resolution |
|---|---|---|---|
| X1 | The architecture's first `ErrorCode` draft used different codes from the algorithm decision table for the OAuth email conflict, the link conflict and the expired pending sign-up (old spellings listed in the Consolidation log) | Architecture `ErrorCode` list and Q6 flow vs algorithm decision table | **Algorithm codes win** (the architecture explicitly hands Q3/Q4 codes to the algorithm doc): `oauth_account_exists`, `identity_in_use`, `provider_already_connected`, `link_session_mismatch`, `signup_expired`, `oauth_email_missing`, `oauth_email_unverified`, `too_many_requests`. The single authoritative `ErrorCode` list (with HTTP statuses, plus `service_unavailable` for 503) now lives in the architecture doc, "Shared HTTP error shape"; this doc uses only codes from it. |
| X2 | AC-ERROR-8 and algorithm S4 put the email in the message ("An account already exists for {email}"), but the architecture says flash messages travel only as codes in the query string and arbitrary text is never reflected | Spec, algorithm S4, architecture Q2 | Keep codes-only URLs. The callback (and the completion action for C4) sets a short-lived web cookie `sgm_flash` (HttpOnly, SameSite=Lax, Path=/, Max-Age 60) holding only the conflicting email as returned by the API. `/login?error=oauth_account_exists` reads it to fill `{email}`. If the cookie is absent (reload after 60 s), the page shows the email-free variant: "An account already exists for the email address on your {Provider} account. …". No email ever appears in a URL. |
| X3 | AC-ERROR-2 shows "Use at least 10 characters." for both too-short and too-long passwords | Spec vs algorithm step B | Too long gets "Use at most 128 characters." (algorithm). Length is counted in code points after NFKC. |
| X4 | AC-ERROR-4: "the same limit applies per client address" (5) vs address limit 20; message "Try again in {n} minutes." vs singular rule | Spec vs algorithm Q7 | Algorithm wins: 20 per address, singular "minute" when n = 1. |
| X5 | AC-ERROR-8 link "to `/login`" vs algorithm "Sign in" → `/login?returnTo=%2Faccount` plus "Forgot your password?" | Spec vs algorithm S4 | Algorithm wins. The callback also lands the user on `/login?…&returnTo=%2Faccount`, so the sign-in form right below the banner already returns to `/account` to connect the provider. |
| X6 | AC-ERROR-9 Facebook copy (no retry) vs algorithm 4A copy with "Try Facebook again" | Spec vs algorithm Q4 | Algorithm wins. The retry button needs a `rerequest` flag on `POST /auth/oauth/facebook/authorize` (contract addition C-1 below). |
| X7 | AC-ENTRY-5: `/login` and `/register` redirect to `/` when signed in; AC-ENTRY-4 asks to "bring them back" | Spec | Redirect to the validated `returnTo` when present, else `/`. The "signed in" test uses `getCurrentUser()` (a real API check), **never cookie presence**: a dead cookie that still exists in the browser would otherwise bounce `/login` → `/` → … and lock the user out of the sign-in page. |
| X8 | Architecture's OAuth flow redirects errors to `/login?error=<code>&provider=…` with no `returnTo`, and the state row's `return_to` is unknown to the web when the state is invalid; link-intent errors have no defined landing | Architecture Q6 | The web keeps its own landing context in the `sgm_oauth` binding cookie, whose one schema is defined in the architecture doc ("Browser-binding cookie `sgm_oauth`"): `<state>.<ctx>` with `ctx = { v: 1, r, i }`. Only the state component is compared (constant time); `r` is re-validated with `safeReturnTo`; `i` is an untrusted hint that only picks the error landing, while the `oauth_states` row stays authoritative. Sign-in errors land on `/login?error=…&provider=…&returnTo=<r>`, link errors on `/account?error=…&provider=…`. Accepted by the architecture (C-2). |
| X9 | AC-ENTRY-3 "the form cannot be submitted until a sex option is chosen" could be read as a disabled button | Spec | A disabled submit button explains nothing to screen-reader or sighted users. Interpretation: the submit button stays enabled; client-side validation (same shared zod messages) blocks the request and shows "Select your sex to continue." in the error summary and beside the field. The server's 422 remains the backstop when JavaScript is off. |
| X10 | Algorithm says a malformed email at login gets the generic 401 and at forgot gets a silent 202 | Algorithm edge-case table | API behaviour stays as the algorithm says. The **web** checks email syntax with the shared `normaliseEmail` before calling the API on all three forms and shows "Enter a valid email address." A syntax check says nothing about whether an account exists, and it stops a typo like `aroha@gmail` from burning a throttle slot or sending the user to wait for an email that will never come. |
| X11 | AC-HAPPY-7 does not say where sign-out lands | Spec | Lands on `/login?notice=signed_out` ("You've signed out."). On a shared phone at the venue the next player can sign in straight away. |
| X12 | R1 disconnects Google and Facebook on every completed reset (user decision D1), and the player would otherwise only be told afterwards | Algorithm R1 as amended by D1 | Warn before as well as after. `/account` shows the warning beside "Set a password" whenever a provider is connected (no `emailVerified` check: no provider assertion exempts an identity), and the reset form hint and the reset email say that a new password disconnects Google and Facebook sign-in. After the reset, the `/login` notice names the removed providers and carries `returnTo=/account` so signing in lands where they can reconnect. |
| X13 | `returnTo` could point at an auth page (`/login?returnTo=%2Fregister`), causing loops or a "signed in, now look at the sign-in page" landing | Not covered | `safeReturnTo` maps `/login`, `/register`, `/register/complete`, `/forgot-password`, `/reset-password` and anything under `/auth/` to `/`. Added to AC-ERROR-13. |
| X14 | `GET /auth/session-expired` deletes the session cookie on any GET, so a cross-site `<img src>` could sign a user out | Architecture route handler | The handler deletes the cookie only after `GET /auth/me` with that cookie returns 401. With a live session it just redirects to `returnTo`. |

Non-journey naming, settled in the 2026-10-06 consolidation and used in all four files: `used_at` on every single-use table; intent values `signin`/`link`; `link_user_id`; `auth_sessions.user_agent varchar(512)`; `revoked_reason` kept (`logout`, `password_reset`, `replaced`); `fieldErrors`.

---

## Journey Map

### Entry Points

| Entry | Context | User intent |
|---|---|---|
| Header "Create account" | Every page when signed out | "I'm new" |
| Header "Sign in" | Every page when signed out | "I have an account" |
| Protected URL (today `/account`; later dashboard, team pages) | Shared link, bookmark, browser history | "Show me this", auth is in the way |
| `/login?notice=session_expired&returnTo=…` | Session died (idle 7 d, absolute 30 d, revoked) | "Carry on where I was" |
| Reset email link `/reset-password?token=…` | Inbox, often on the phone | "Let me back in" |
| `/account` "Connect Google/Facebook", "Set a password" | Signed in | "Add another way in" |
| Terminal `users set-role` | Operator | "Make this person an admin" |

### Page and route inventory

| URL | Kind | Who sees it | Purpose |
|---|---|---|---|
| `/login` | page (RSC + Server Actions) | Signed out (signed in → `returnTo` or `/`) | Sign in by any method; landing for every sign-in-side notice and error |
| `/register` | page | Signed out (signed in → `returnTo` or `/`) | Create an account by password or start OAuth |
| `/register/complete` | page | Holder of a live `sgm_pending` cookie | First-time OAuth: confirm name, choose sex |
| `/forgot-password` | page (two states: form, sent) | Anyone (signed in: email prefilled) | Request a reset link |
| `/reset-password?token=` | page | Anyone holding a link | Set a new password |
| `/account` | protected page | Signed in | Details and sign-in methods |
| `/auth/callback/[provider]` | route handler, no UI | Provider redirect | Finish OAuth and redirect |
| `/auth/session-expired?returnTo=` | route handler, no UI | `requireUser` on a dead session | Clear the dead cookie, redirect to `/login` |
| `/` | page | Everyone | Home (placeholder until `player-dashboard`) |

### Query-string grammar (all notices and errors travel as codes)

`?notice=<code>` | `?error=<code>` + `&provider=google|facebook` (lowercase, enum-checked) + `&removed=FACEBOOK,GOOGLE` (enum-checked list, reset only) + `&returnTo=<path>`. Unknown codes are ignored and render nothing. Text comes only from `apps/web/src/lib/auth/messages.ts` (the [Copy deck](#copy-deck)). After the page renders, a small client effect removes `notice` and `error` from the address bar with `history.replaceState` (keeping `returnTo`), so a reload does not replay "Password updated."

### Header states (`SiteHeader`)

| State | How it is determined | Header shows |
|---|---|---|
| Anonymous | No session cookie (no API call made) | Brand link "Shared Game Management" → `/`; links "Sign in" and "Create account" (primary style) |
| Signed in | Cookie and `getCurrentUser()` returns a user | "Signed in as {fullName}", link "Account", button "Sign out" |
| Dead cookie | Cookie present, `/auth/me` → 401 | Same as anonymous (the cookie is cleared later by `/auth/session-expired` or replaced at the next sign-in; Server Components cannot delete it) |
| API unreachable, cookie present | `/auth/me` network error, timeout or 5xx | Brand and an "Account" link only. Never "Sign in", which would tell a signed-in user they are signed out. |
| Pending OAuth sign-up | `sgm_pending` only | Same as anonymous |
| Signing out | Sign-out action pending | Button reads "Signing out…" and is `aria-disabled` |

- Header "Sign in" and "Create account" carry `returnTo` so a visitor comes back to the page they were reading: the current path and query on ordinary pages, the page's existing `returnTo` on auth pages, nothing on `/`. This is a small client component using `usePathname()`/`useSearchParams()` inside the server `SiteHeader`.
- Current page link gets `aria-current="page"`.
- Mobile (< 640 px): two rows. Row 1: brand left, primary action right ("Create account" or "Sign out"). Row 2: secondary items ("Sign in", or "Signed in as {fullName}" truncated with CSS ellipsis plus "Account"). CSS truncation keeps the full text in the DOM for tests and screen readers.
- `GLOBAL_ADMIN` gets nothing extra in the header (no admin UI yet).

### `returnTo` end to end

| Stage | Where it lives | Rule |
|---|---|---|
| **Sources** | `proxy.ts` (no cookie on a protected path) → `/login?returnTo=<path+query>`; `requireUser(returnTo)` → `/auth/session-expired?returnTo=…`; header links; OAuth conflict (S4/C4) forces `/account`; R1 notice forces `/account`; L0 forces `/account` | Always encoded with `encodeURIComponent` |
| **Carriers** | Query string between `/login` ⇄ `/register` ⇄ `/forgot-password` cross-links; hidden `<input name="returnTo">` in every auth form; OAuth state row `return_to` (API); `oauth_pending_signups.return_to`; web `sgm_oauth` payload `r` (X8) | Each hop re-validates with `safeReturnTo` |
| **Sinks** | Password sign-in success, registration success, OAuth `signed_in`, `/auth/oauth/complete` success, already-signed-in redirect on `/login` and `/register`, `/auth/session-expired` live-session shortcut | `redirect(safeReturnTo(r), RedirectType.replace)` |
| **Dropped on purpose** | The reset email link (crosses devices and inboxes); sign-out; `/account` link actions (always back to `/account`) | After a reset the user lands on `/` unless R1 applies (then `/account`) |
| **Validation** | Shared `safeReturnTo` | Single leading `/`, no `\`, no control chars, no `//` after decoding, same origin; **auth-page paths map to `/` (X13)**; anything else → `/` |

---

### Flow F1: Register with email and password (AC-ENTRY-3, AC-HAPPY-1, AC-ERROR-1/2)

```
[Header "Create account" or /login "Create one"]
    │
    ▼
[/register  form: Full name, Email, Password, Sex]──[signed in?]──► redirect returnTo or /
    │  (OAuth buttons on top → F3/F4)
    ▼  submit "Create account"
[client validation]──fail──► error summary + field errors (no request)
    │ pass
    ▼
[Server Action registerAction → POST /auth/register]
    ├──201──► set session cookie → redirect(returnTo or "/" + notice=welcome, replace)
    ├──409 email_taken──► same page, banner + links, password cleared
    ├──422 validation_failed──► same page, field errors from fieldErrors
    ├──403 cross_origin_request──► banner (reload)
    └──network / 5xx──► banner "Something went wrong…", all fields kept except password
```

#### Step 1: Register form
- **System**: web RSC `/register`; `GET /auth/providers` for the buttons.
- **User sees** (mobile order, top to bottom): H1 "Create your account"; "Continue with Google", "Continue with Facebook" (each only if enabled); divider "or"; Full name (hint "As your team will see it."); Email (hint "We'll send password reset links here."); Password with "Show password" toggle (hint "At least 10 characters. Avoid common passwords."); fieldset "Sex" with hint "Some teams set session prices by sex." and radios Male / Female / Other, none selected; button "Create account"; "Already have an account? Sign in".
- **User actions**: fill and submit; start OAuth; go to sign in (keeps `returnTo`).
- **Feedback**: button label "Creating account…" with `aria-disabled` while pending; an `aria-live="polite"` region announces "Creating account…".
- **Transitions**: success → `returnTo` or `/`; errors stay on the page.
- **Data**: `{ fullName, email, password, sex }` plus hidden `returnTo`; the strict schema rejects any extra field (no `role`).

#### Step 2: Success
- **User sees**: the destination page, header "Signed in as Aroha Ngata", and on any page a dismissible notice "Welcome! Your account is ready." (`FlashNotice`, role `status`).
- **Value delivered**: an account and a live session. **Next actions**: "Account" in the header; later, find a team.

### Flow F2: Sign in with email and password (AC-ENTRY-2/4/5/6, AC-HAPPY-2, AC-ERROR-3/4/11/13)

```
[/login?returnTo=…]──[signed in?]──► redirect returnTo or /
    │
    ▼ submit "Sign in"
[client: email syntax, password non-empty]──fail──► field errors
    ▼
[loginAction → POST /auth/login]
    ├──200──► set cookie → redirect(returnTo or "/", replace)
    ├──401 invalid_credentials──► banner, email kept, password cleared, focus banner
    ├──429 too_many_attempts──► banner with {n} minutes + recovery links
    └──network / 5xx / 503 (throttle store down)──► banner "Something went wrong…"
```

- **User sees**: H1 "Sign in"; context line "Sign in to continue." when a non-root `returnTo` is present and there is no other notice; notice or error banner (if any) directly under the H1; OAuth buttons; "or"; Email; Password with "Show password"; link "Forgot your password?" (under the password field, carries `returnTo`); button "Sign in"; "Don't have an account? Create one".
- **Feedback**: "Signing in…" while pending.
- **401 copy**: "Incorrect email or password." plus a second line when any provider is enabled: "If you signed up with Google or Facebook, use those buttons instead." The second line is the same for every request, so it reveals nothing about the account.
- **429 copy**: "Too many sign-in attempts. Try again in {n} minutes." plus "You can reset your password now, or continue with Google or Facebook." (links to `/forgot-password?returnTo=…`; the provider sentence only names enabled providers). The form stays usable: blocked attempts are not counted and do not extend the block.

### Flow F3: First-time OAuth sign-up (AC-HAPPY-3/4, AC-ERROR-7/9/14; algorithm S2–S5, C1–C5)

```
[/login or /register]─click "Continue with Google"
    ▼
[startOAuthAction → POST /auth/oauth/google/authorize {returnTo}]──fail──► banner on same page
    ▼ set sgm_oauth=<state>.<ctx>; redirect(authorizationUrl)
[Google consent]──deny──► callback ?error=access_denied ─► /login?error=oauth_cancelled
    ▼ approve
[/auth/callback/google]
    ├─ cookie missing/mismatch ─┬─ live session ─► "/" (silent; replay or back button)
    │                           └─ no session ──► /login?error=oauth_state_invalid&provider=google&returnTo=r
    ▼ POST /auth/oauth/google/callback {state, code}
    ├─ S1 signed_in ─────────────► F4
    ├─ S2 oauth_email_missing ───► /login?error=oauth_email_missing&provider=…&returnTo=r
    ├─ S3 oauth_email_unverified ► /login?error=oauth_email_unverified&provider=google&returnTo=r
    ├─ S4 oauth_account_exists ──► set sgm_flash(email); /login?error=oauth_account_exists&provider=…&returnTo=%2Faccount
    ├─ provider_unavailable ─────► /login?error=provider_unavailable&provider=…&returnTo=r
    └─ S5 pending_signup ────────► set sgm_pending (900 s); /register/complete
                                        ▼
[/register/complete]  GET /auth/oauth/pending (X-Pending-Signup)
    ├─ no cookie / 4xx (expired, consumed) ─┬─ live session ─► returnTo or "/"   (finished in another tab)
    │                                       └─ otherwise ───► /login?error=signup_expired
    ▼ form: name (prefilled, editable), sex
[completeSignupAction → POST /auth/oauth/complete]
    ├─ C1 422 ──► same page, field errors (pending still valid)
    ├─ C2 400 signup_expired ─┬─ live session ─► returnTo or "/"
    │                         └─ otherwise ───► /login?error=signup_expired
    ├─ C3 200 signed_in ──► delete sgm_pending, set cookie, redirect returnTo (no welcome: account existed)
    ├─ C4 409 oauth_account_exists ──► delete sgm_pending, set sgm_flash, /login?error=…&returnTo=%2Faccount
    └─ C5 201 ──► delete sgm_pending, set cookie, redirect(returnTo or "/" + notice=welcome, replace)
```

#### `/register/complete` screen
- **User sees**: H1 "Finish signing up"; intro "You're signing up with {Provider} as {email}."; Full name (prefilled from the provider, editable, required); fieldset "Sex" (same hint and radios as `/register`, none selected); button "Finish sign-up"; secondary button "Use a different account".
- **"Use a different account"**: a Server Action that deletes `sgm_pending` and redirects to `/login` (no API call; the pending row expires and is cleaned up). It covers the "wrong Google account" case.
- **Timing**: no countdown. Fifteen minutes is far more than the step needs. If the user wanders off, C2 handles it.
- **Header**: signed-out state. Clicking "Sign in" abandons the pending sign-up (harmless).

### Flow F4: Returning OAuth user (AC-HAPPY-5; algorithm S1)

Same start as F3. Callback outcome `signed_in` → web sets the session cookie and redirects to `returnTo` or `/` (replace). No `/register/complete`, no notice (the header change confirms it). The same "Continue with …" buttons on `/register` sign in returning users, which is why the buttons say "Continue" and not "Sign up".

### Flow F5: Forgot and reset password (AC-ENTRY-6, AC-HAPPY-6, AC-ERROR-5/6/16, AC-ASYNC-1/2, AC-INTEGRATION-1)

```
[/login "Forgot your password?"] or [/account "Set a password"] or [429 / 409 recovery links]
    ▼
[/forgot-password form: Email]  (signed in: prefilled with own email)
    ▼ "Send reset link"  (client: email syntax)
[forgotAction → POST /auth/password/forgot]
    ├─ 202 ──► same URL, "sent" state (identical for known/unknown emails)
    ├─ 429 too_many_requests ──► banner with {n} minutes
    └─ network / 5xx ──► banner, email kept
          ║ async: token + send-email job commit together → worker → inbox (≤ 30 s in dev)
          ▼
[Email "Reset your Shared Game Management password"] ─ link ─► /reset-password?token=…  (any device)
    ▼ (COULD: POST /auth/password/reset/check on load → invalid link shown before typing)
[form: New password]  "Set new password"
    ├─ 422 ──► field error, token NOT consumed
    ├─ 400 invalid_or_expired_token ──► banner + "Request a new link"
    └─ 200 {removedProviders} ──► delete this browser's session cookie (all sessions revoked)
          ├─ removed = [] ──► /login?notice=password_updated
          └─ removed ≠ [] ──► /login?notice=password_updated&removed=FACEBOOK&returnTo=%2Faccount
```

- **Sent state**: H1 "Check your email"; "If an account exists for that email, we've sent a reset link." (exact AC text); "We sent it to {typed email}. The link works once and expires in 60 minutes."; "Didn't get it after a few minutes? Check your spam folder, then send another link."; button "Send another link" (resubmits the same email; the API's 60-second floor silently absorbs fast repeats and the page is identical); link "Use a different email" (back to the form); link "Back to sign in" (keeps `returnTo`). Echoing the typed email is the same for real and unknown accounts, so it reveals nothing, and it lets the user spot a typo.
- **Reset form**: H1 "Set a new password"; New password with "Show password" and hint "At least 10 characters. Avoid common passwords. Setting a new password signs you out on all your devices and disconnects any Google or Facebook sign-in."; button "Set new password". No "confirm password" field: show/hide does the same job with less typing on a phone.
- **OAuth-only players** use the same flow to add a password (algorithm). From `/account` the entry is "Set a password".
- **Every reset evicts Google and Facebook** (R1 as amended by user decision D1): `removedProviders` lists every provider identity the account had, whatever Google once asserted about the email, so the R1 landing applies to anyone with a connected provider.
- **Signed-in user opens a reset link** (common: phone already signed in): allowed. On success the action also deletes this browser's session cookie, because the API revoked every session.

### Flow F6: Sign out (AC-HAPPY-7)

Header button "Sign out" (a form posting a Server Action) → `POST /auth/logout` with the bearer → the web deletes the cookie **whatever the API answered** (204, dead session, network error) → `redirect('/login?notice=signed_out', replace)`. Sign-out never shows an error. If the API was unreachable, the server row stays until idle expiry, but this browser no longer holds the token. The web logs a warning.

### Flow F7: Protected page and session expiry (AC-ENTRY-4, AC-ERROR-11, AC-ASYNC-4)

```
GET /account
  ├─ proxy.ts: no cookie ──► /login?returnTo=%2Faccount        (context line "Sign in to continue.")
  ▼ cookie present
requireUser('/account') → GET /auth/me
  ├─ 200 ──► render
  ├─ 401 (unauthenticated | session_expired) ──► /auth/session-expired?returnTo=%2Faccount
  │        route handler: GET /auth/me again ─ 401 ─► delete cookie ─► /login?returnTo=%2Faccount&notice=session_expired
  │                                           └ 200 ─► redirect returnTo (X14)
  └─ network / 5xx ──► account/error.tsx: "We can't load this page right now" + "Try again" (no redirect, no sign-out)
```

- **Session dies during a Server Action on a protected page** (for example "Connect Google" after 8 idle days): the action gets 401 and redirects to `/auth/session-expired?returnTo=<page>`. Same banner. Unsaved form input is lost; that is acceptable for the one-button actions in this feature. Later features with long forms should keep drafts.
- **Public page with a dead cookie**: the header shows the anonymous state; no banner (nothing the user asked for failed).

### Flow F8: Connect and disconnect sign-in methods on `/account` (AC-HAPPY-11/12, AC-ERROR-17, AC-ASYNC-5; algorithm L0–L4)

```
/account ─ "Connect Google" ─► linkAction → POST /auth/identities/google/link
    ├─ 401 ─► /auth/session-expired?returnTo=%2Faccount
    ▼ set sgm_oauth (i='link'); redirect(authorizationUrl)
[Google consent] ─► /auth/callback/google ─► POST …/callback (Bearer forwarded)
    ├─ L4 linked ─────────────► /account?notice=linked&provider=google      (+ security email queued)
    ├─ L1 already linked ─────► /account?notice=already_linked&provider=google
    ├─ L2 identity_in_use ────► /account?error=identity_in_use&provider=google
    ├─ L3 provider_already_connected ─► /account?error=provider_already_connected&provider=google
    ├─ L0 link_session_mismatch / session_expired ─► /login?error=link_session_mismatch&provider=google&returnTo=%2Faccount
    └─ row 0 (cancel, state, outage) ─► /account?error=<code>&provider=google   (link-context copy)

/account ─ "Disconnect" (Google) ─► unlinkAction → DELETE /auth/identities/GOOGLE
    ├─ 204 ─► /account?notice=unlinked&provider=google
    └─ 409 last_sign_in_method ─► /account?error=last_sign_in_method
```

- **`/account` sees**: H1 "Your account". Section "Details": Name, Email, Sex (read-only), and "Platform admin" for `GLOBAL_ADMIN`. Section "Sign-in methods": a list with one row per method, in the order Email and password, Google, Facebook. A provider row appears when the provider is enabled **or** the user already has it connected. Each row shows the method name, a status ("Connected" or "Not connected") and one action:
  - Google or Facebook, not connected: "Connect Google" / "Connect Facebook".
  - Any connected method: "Disconnect" (accessible name "Disconnect Google"). With only one method left the button is `aria-disabled="true"` and the row explains "You need at least one way to sign in."
  - Email and password, not connected: link "Set a password" → `/forgot-password?returnTo=%2Faccount` with the help text "We'll email you a link to set one." When any provider is connected, the R1 warning follows: "For your security, setting a password this way also disconnects {Facebook}. You can reconnect it straight after."
  - Section "Sign out": the same button as in the header.
- **No disconnect confirmation step**: disconnecting is reversible in two clicks, does not sign the user out, and the last method cannot be removed. A confirm step would add friction to a COULD AC for no safety gain.

### Flow F9: Operator grants a global role (AC-HAPPY-10)

`pnpm --filter @sgm/api exec tsx --env-file-if-exists=../../.env src/cli.ts users set-role aroha.ngata@example.com GLOBAL_ADMIN`

| Case | stdout / stderr | Exit |
|---|---|---|
| Success | `Updated user 7f3c…-…: role is now GLOBAL_ADMIN` | 0 |
| Already that role | `User 7f3c…: role is already GLOBAL_ADMIN (no change)` | 0 |
| Unknown email | `No user found with email aroha.ngata@example.com. Nothing changed.` | 1 |
| `TEAM_ADMIN` | `Invalid role "TEAM_ADMIN". Use GLOBAL_ADMIN or PLAYER. Team admins are assigned per team, not globally.` | 1 |
| Other bad role | `Invalid role "<value>". Use GLOBAL_ADMIN or PLAYER.` | 1 |

The email is normalised before lookup, so any letter case works. The user's existing session sees the new role on its next request. `/account` then shows "Platform admin".

### Flow F10: Authorization denial (AC-HAPPY-8/9, AC-ERROR-11/12)

API-only in this feature. Reserved web copy for when later features call guarded routes:
- 403 `forbidden` → "You don't have permission to do that." On a page: H1 "You don't have access to this page", text "If you think you should, ask your team admin.", link "Go to the home page".
- A team membership that is pending, rejected or banned gets the same 403 text. The guard reveals nothing about team state, and team-management will add membership-specific pages.

---

## Step-by-Step Journey (primary path: first-time player on a phone, Google)

#### Step 1: Arrive
- **System**: web (`proxy.ts`, RSC).
- **User sees**: the shared link, for example a protected team page. No cookie, so the proxy sends them to `/login?returnTo=%2Fteams%2F…`, which shows "Sign in to continue."
- **User actions**: "Continue with Google" (top of the page, no typing).
- **Feedback**: the button reads "Redirecting to Google…" and both provider buttons become `aria-disabled`, which prevents a double tap from starting two flows and breaking the state cookie binding.
- **Transitions**: `startOAuthAction` → redirect to Google.
- **Data flow**: `returnTo` → API state row and `sgm_oauth` payload.

#### Step 2: Consent at Google
- **System**: Google.
- **User sees**: Google's account chooser and consent.
- **Transitions**: approve → callback; cancel → `/login?error=oauth_cancelled&provider=google&returnTo=…` ("Google sign-in was cancelled."), with the form and buttons ready.

#### Step 3: Callback (invisible)
- **System**: web route handler → API → Postgres.
- **User sees**: nothing (sub-second redirect; a slow provider gives at most 5 s plus the API time).
- **Transitions**: S5 → `/register/complete`.

#### Step 4: Finish signing up
- **System**: web RSC + `GET /auth/oauth/pending`.
- **User sees**: "You're signing up with Google as aroha@gmail.com.", the name prefilled, Sex unselected.
- **User actions**: tap Female → "Finish sign-up".
- **Feedback**: "Finishing…".
- **Data flow**: `{ pendingToken (cookie), fullName, sex }` → user + identity + session in one transaction.

#### Step 5: Success
- **User sees**: the page from Step 1, header "Signed in as Aroha Ngata", notice "Welcome! Your account is ready."
- **Value delivered**: signed in and back where they started. Time budget: about 4 taps and under a minute.
- **Next actions**: continue on the page; "Account" to add a password or Facebook.

---

## Async Handling

### Operation lifecycle (password reset email)

| Phase | Duration | User experience |
|---|---|---|
| Initiation | Immediate (202, no SMTP wait) | "Check your email" state, with the address echoed and the 60-minute expiry |
| Processing | Seconds (Mailpit within 30 s in dev; Postmark later) | User leaves the page or switches to the mail app. Nothing on screen needs polling. |
| Completion | n/a | The email arrives. The link works on any device and browser (no binding cookie). |
| Failure (transient) | Retries with backoff | Invisible; still exactly one email |
| Failure (permanent) | Job ends `failed`, error logged | The user sees no email. Recovery: "Send another link" (new token and job) or another sign-in method. The page tells them to check spam and resend. The response is identical whatever happened, so nothing more can be shown without revealing whether the account exists. |

### Progress communication
- **Method**: none in-app (enumeration resistance forbids it); expectation-setting copy on the sent page.
- **Persistence**: none for the user. Operators see `pgboss.job` state.

### Security notice email (AC-ASYNC-5, from the algorithm)
Queued in the link transaction. The user sees "{Provider} connected. You can now sign in with it." in-app at once; the email is a safety net for someone who didn't connect it themselves.

---

## Distributed System Flow

### System boundaries
```
Browser ──HTTPS──► web (Next 16: RSC, Server Actions, route handlers, proxy.ts)
   ▲  cookies: __Host-sgm_session, __Host-sgm_oauth, __Host-sgm_pending, __Host-sgm_flash (https)
   │                 │ Bearer + traceparent + user-agent + x-sgm-internal-auth (+ x-sgm-client-ip)
   │ 302 redirects    ▼
   │             api (Fastify, internal) ──► PostgreSQL 17 (users, identities, sessions, tokens,
   │                 │                          oauth_states, oauth_pending_signups, auth_throttle, pgboss.job)
   │                 └──► Google / Facebook (token + profile, 5 s timeout)
   └── Google/Facebook consent ──302──► web /auth/callback/[provider]
worker ── send-email ──► Mailpit / Postmark ──► player's inbox ──link──► web /reset-password
```

### Responsibility matrix

| Step | Owner | State storage | Failure handling |
|---|---|---|---|
| Form input and client checks | Browser (client component) | React state | Inline errors, no request |
| Auth actions (register, login, forgot, reset, complete, sign out, link, unlink) | web Server Actions | none (stateless) | Map `ErrorResponse.code` → copy deck; network or 5xx → generic banner; inputs kept except passwords |
| Session cookie, OAuth binding, pending token, flash email | web | HttpOnly cookies | Missing or mismatched → defined landing (tables above) |
| Credentials, sessions, roles, throttle, tokens | API | Postgres | Shared error shape; 429 with `Retry-After`; 503 if the throttle store is down (fail closed) |
| OAuth state, pending sign-up | API | Postgres, single use | 400 codes → `/login` or `/account` landings |
| Provider exchange | API → provider | none | `provider_unavailable` (timeout or 5xx), `oauth_state_invalid` (rejected or invalid response) |
| Reset email | worker | `pgboss.job` | Retry with backoff; permanent failure logged; user resends |
| `returnTo` | web and API | query, hidden input, state row, pending row, cookie payload | `safeReturnTo` at every hop |

---

## Error Handling

### Where every error lands and how the user recovers

| Code (HTTP) | Raised by | Lands on | User sees (see Copy deck) | Recovery offered | Input kept |
|---|---|---|---|---|---|
| `validation_failed` (422) | register, complete, reset, forgot | same page | Error summary + field messages | Fix the fields | All but password fields |
| `email_taken` (409) | register | `/register` | E-REG-1 | "Sign in instead" (`/login?returnTo=…`), "Reset your password" (`/forgot-password?returnTo=…`) | Name, email, sex |
| `invalid_credentials` (401) | login | `/login` | E-LOGIN-1 | Retry; "Forgot your password?"; provider buttons | Email |
| `too_many_attempts` (429) | login | `/login` | E-LOGIN-2 | Wait n minutes; reset (clears the email counter); OAuth | Email |
| `too_many_requests` (429) | forgot | `/forgot-password` | E-FORGOT-1 | Wait n minutes | Email |
| `invalid_or_expired_token` (400) | reset | `/reset-password` | E-RESET-1 | "Request a new link" → `/forgot-password` | n/a (form hidden) |
| `oauth_cancelled` (400) | callback | `/login` (sign-in) / `/account` (link) | E-OAUTH-1 / E-LINK-1 | Buttons are right there | n/a |
| `oauth_state_invalid` (400) or binding mismatch | web callback / API | `/login` / `/account`; **signed-in and no cookie → `/` silently** | E-OAUTH-2 / E-LINK-2 | Try again; hint to use the main browser | n/a |
| `provider_unavailable` (502) | callback | `/login` / `/account` | E-OAUTH-3 / E-LINK-3 | Try again; email and password | n/a |
| `provider_not_enabled` (404) | authorize / callback | `/login` | E-OAUTH-4 | Other methods | n/a |
| `oauth_email_missing` (422) | callback S2 | `/login` | E-OAUTH-5 (Facebook) / E-OAUTH-6 (Google) | "Try Facebook again" (rerequest); other methods | n/a |
| `oauth_email_unverified` (422) | callback S3 | `/login` | E-OAUTH-7 | Other methods | n/a |
| `oauth_account_exists` (409) | callback S4, complete C4 | `/login?returnTo=%2Faccount` | E-OAUTH-8 (email from `sgm_flash`) | Sign in below, then connect on `/account`; "Forgot your password?" | n/a |
| `signup_expired` (400) | complete C2, missing `sgm_pending` | `/login` (or `returnTo` if a live session exists) | E-OAUTH-9 | OAuth buttons right there | n/a |
| `link_session_mismatch` (403) / `session_expired` at link callback | callback L0 | `/login?returnTo=%2Faccount` | E-LINK-4 | Sign in, then Connect again | n/a |
| `identity_in_use` (409) | callback L2 | `/account` | E-LINK-5 | Use the other account, or disconnect it there | n/a |
| `provider_already_connected` (409) | callback L3 | `/account` | E-LINK-6 | Disconnect first | n/a |
| `last_sign_in_method` (409) | unlink | `/account` | E-ACCT-1 | Connect another method first | n/a |
| `unauthenticated` / `session_expired` (401) | any protected call | `/auth/session-expired` → `/login` | N-SESSION | Sign in → back to `returnTo` | n/a |
| `forbidden` (403) | role or team guard | page-level 403 | E-AUTHZ-1 | Home link | n/a |
| `cross_origin_request` (403) | origin checks | same page | E-SYS-3 | Reload | Yes |
| network (browser offline) | client | same page | E-SYS-1 | Retry | Yes |
| `internal_error` (500), `service_unavailable` (503), API unreachable, timeout | any | same page (forms) / `error.tsx` (pages) | E-SYS-2 / E-PAGE-1 | Retry | Yes (not passwords) |
| unknown code | any | same page | E-SYS-2 | Retry | Yes |

### Partial failure
- **OAuth completed at Google but our callback failed** (API down): no user, no session; the state row may be consumed. The user lands on `/login` with E-OAUTH-3 and starts again (new state).
- **Sign-up created but redirect lost** (connection drop after 201): the cookie was set in the same response, so the next page load shows the signed-in header. Resubmitting the form gives `email_taken`, whose links lead to sign-in. With the cookie live, `/login` redirects to `/`.
- **Reset succeeded but the response was lost**: the token is used. Resubmitting shows "This reset link is invalid or has expired." while the new password already works. Copy E-RESET-1 includes "If you just set a new password, try signing in with it."

### Edge cases (two tabs, back button, expiry)

| Case | What happens | Why it is acceptable or how it is handled |
|---|---|---|
| Back button after sign-in | All post-auth redirects use `RedirectType.replace`, so the auth form is not in history. If the user reaches `/login` anyway, the server redirects to `returnTo` or `/` (X7). Auth and protected pages are dynamic, so `Cache-Control: no-store` keeps bfcache from showing stale forms. | AC-ENTRY-7 |
| Back button into the callback URL | Binding cookie already deleted. With a live session → `/` silently. Without → E-OAUTH-2. The API never runs the state twice. | AC-ERROR-7 replay rule |
| Back after sign-out to `/account` | `no-store`; the request has no cookie → `/login?returnTo=%2Faccount` | |
| Two tabs start OAuth at once | The second start overwrites `sgm_oauth`; the first tab's return fails the binding check with E-OAUTH-2 ("Please try again"), and retrying works. | Rare; one binding cookie per browser is the architecture's design |
| Same pending sign-up finished in two tabs | Tab A completes (C5) and deletes `sgm_pending`. Tab B submits: no cookie, but a live session → lands on `returnTo` signed in. No error. | AC-ENTRY-8 |
| Two separate pending sign-ups for one Google account (two browsers) | First C5 creates the user; the second gets C3 and is signed in as that user | Algorithm C3 |
| Pending older than 15 min | `sgm_pending` Max-Age (900 s) equals the TTL, so the cookie is usually already gone → E-OAUTH-9 on reload or submit | AC-ERROR-14 |
| Facebook login opens the Facebook app and returns in another browser | No binding cookie there → E-OAUTH-2 with the hint "open this page in your device's main browser" | Known mobile OAuth behaviour |
| Google inside the Facebook/Instagram in-app browser | Google refuses embedded webviews on its own page (`disallowed_useragent`); our callback is never reached. So the web detects in-app browsers from the user agent and shows N-INAPP above the Google button. | AC-VERIFY-13 |
| Reset link opened twice / in two tabs | First succeeds; second shows E-RESET-1 | Guarded single use |
| Reset link opened while signed in on that device | Allowed; on success the browser's session cookie is deleted with all other sessions | F5 |
| Sign out in tab A, keep using tab B | Tab B's next navigation has no cookie → anonymous header; protected pages → `/login?returnTo=…` | |
| Session idle-expired while the cookie still exists | Public pages: anonymous header. Protected pages: `/auth/session-expired` → N-SESSION. | Architecture trade-off (cookie lives to the absolute expiry) |
| Signed in while a stale `sgm_pending` exists | `/register/complete` is driven by the pending cookie only; completing replaces the session (`signin` intent ignores the current session) | Rare; consistent with algorithm |
| API down when opening `/login` | No cookie: form renders; `GET /auth/providers` fails → OAuth buttons hidden and banner N-UNAVAILABLE shown; submit gives E-SYS-2 | AC-ERROR-18 |

---

## Options Explored

### Option 1: Dedicated single-purpose pages, OAuth-first, code-based notices (plan's routes, refined)
- **Orchestration**: single screen per task; each form is a progressive-enhancement Server Action; every outcome is a redirect with a code or an in-place error state.
- **Flow summary**: `/login`, `/register`, `/register/complete`, `/forgot-password`, `/reset-password`, `/account`; cross-links carry `returnTo`; OAuth buttons above the email form.
- **Wireframe** (`/login`, 360 px):
  ```
  ┌──────────────────────────────────┐
  │ Shared Game Management  [Create account]
  │ Sign in                          │
  ├──────────────────────────────────┤
  │ Sign in                          │  ← h1
  │ Sign in to continue.             │
  │ ┌──────────────────────────────┐ │
  │ │ (i) Your session has expired.│ │  ← role=status
  │ │     Sign in again.           │ │
  │ └──────────────────────────────┘ │
  │ [ G   Continue with Google     ] │
  │ [ f   Continue with Facebook   ] │
  │ ───────────── or ─────────────── │
  │ Email                            │
  │ [______________________________] │
  │ Password              [Show]     │
  │ [______________________________] │
  │ Forgot your password?            │
  │ [           Sign in            ] │
  │ Don't have an account? Create one│
  └──────────────────────────────────┘
  ```
- **Pros**: matches the spec's URLs and ACs one to one; each page has one job, one H1 and one primary button; works without JavaScript; every redirect target is a plain URL that E2E tests and the code-only notice rule can address; OAuth's full-page redirects fit naturally; the reset link lands on its own page.
- **Cons**: more page files; switching between sign-in and sign-up is a page load (mitigated by cross-links that keep `returnTo`).

### Option 2: Single adaptive "identifier-first" page
- **Orchestration**: one `/auth` page. Step 1 asks for the email; the system then shows a password field (account exists) or the registration fields (new email).
- **Wireframe**:
  ```
  ┌────────────────────────────┐
  │ Sign in or create account  │
  │ Email [_________________]  │
  │ [ Continue ]               │
  │ ── or ──  [Google] [FB]    │
  └────────────────────────────┘
        ▼ (exists?)
  [Password]   or   [Name, Password, Sex]
  ```
- **Pros**: one entry for people who forget whether they have an account; modern feel.
- **Cons**: branching on account existence is an **enumeration oracle**, directly against AC-ERROR-3, AC-ERROR-6 and AC-VERIFY-10; it adds a step for everyone; it contradicts the spec's URLs and the header's two links; OAuth-only accounts make "account exists, show password" wrong.

### Option 3: Modal auth over the current page (Next intercepting and parallel routes)
- **Orchestration**: header links open `/login` as a modal over the current page through an intercepted route, with full pages as the fallback on direct load.
- **Wireframe**:
  ```
  ┌───────────── page (dimmed) ──────────────┐
  │   ┌─────────── Sign in ──────────[x]─┐   │
  │   │ [Google] [Facebook]  ── or ──    │   │
  │   │ Email / Password  [Sign in]      │   │
  │   └──────────────────────────────────┘   │
  └──────────────────────────────────────────┘
  ```
- **Pros**: keeps visual context, so `returnTo` matters less for header-initiated sign-ins.
- **Cons**: OAuth leaves the page anyway, so the context is lost for the fastest path; two render paths per form (modal and page), each with its own focus trap and tests; poor on small phones (keyboard plus modal); protected-page redirects and reset links still need full pages; more Next routing machinery for a v1 with one protected page.

### Option 4: One combined page with "Sign in" / "Create account" tabs
- **Orchestration**: `/login` and `/register` render the same component with a tab switch (client-side swap, URL updated).
- **Wireframe**:
  ```
  ┌────────────────────────────────┐
  │ [ Sign in ] [ Create account ] │
  │ [Google] [Facebook] ── or ──   │
  │ (fields for the active tab)    │
  └────────────────────────────────┘
  ```
- **Pros**: instant switching; typed email carried across; one place for OAuth buttons.
- **Cons**: an accessible tab pattern for forms (roving tabindex, `aria-controls`, focus on switch) is more work than two links; a tab swap is easy to miss on mobile ("why does this form want my sex?"); per-tab error state and notices get tangled; little gain over cross-links.

---

## Evaluation Matrix

| Criterion | Option 1 Dedicated pages | Option 2 Identifier-first | Option 3 Modal | Option 4 Tabs |
|---|---|---|---|---|
| Discoverability | H | M | H | H |
| Learnability | H | M | M | M |
| Efficiency | H (OAuth first; ~4 taps) | M (extra step) | M (OAuth leaves the modal) | H |
| Error Prevention | H | L (enumeration; branch confusion) | M | M |
| Error Recovery | H (every error has a URL landing) | M | M (two render paths) | M |
| Consistency (spec URLs, ACs, architecture) | H | L | M | M |
| Accessibility | H (one H1, native forms, no traps) | M | L (focus trap, small screens) | M |
| Implementation cost | Low | Medium | High | Medium |

## Decision

**Chosen**: Option 1, dedicated single-purpose pages, with OAuth-first layout, code-based notices and errors, `returnTo` carried end to end, and the refinements in this document (X7 real-session redirect, X8 landing context in the binding cookie, `FlashNotice`, `sgm_flash` for the conflict email). One idea is borrowed from Option 4: the typed email can follow the user between `/login`, `/register` and `/forgot-password` (COULD: `sessionStorage` key `sgm:auth-email`, client-only, never in a URL).

### Rationale
- Lowest friction for the primary persona: on a phone the fastest path (OAuth) is at the top of every entry page and needs no typing; the only form after it is two taps (sex, "Finish sign-up").
- Every outcome, including the 15 OAuth decision rows, maps to a URL with a code. That fits the architecture's codes-only notice rule, works without JavaScript, and makes each state reachable by E2E tests and UAT.
- It is the only option that keeps the enumeration properties of AC-ERROR-3/6 and AC-VERIFY-10 intact without special cases.
- It matches the spec's URLs and the plan's files, so the build pays no rework.

### Trade-offs accepted
- **Switching between sign-in and sign-up is a page load.** Cross-links keep `returnTo` (and optionally the typed email), so nothing is lost.
- **A user who signed up by password and later clicks Google sees the conflict page** (algorithm trade-off). The landing is pre-set to return to `/account`, so it is sign in, then one tap on "Connect Google".
- **Two OAuth flows started at once in one browser break the first one.** The message says "Please try again", which works.
- **No in-app progress for reset email delivery.** Enumeration resistance forbids it. The sent page sets expectations and offers resend.
- **The R1 eviction still surprises a few users.** It is warned about on `/account` before, and explained on `/login` after with a direct route back to reconnect.

---

## Copy deck

All user-facing strings. `{Provider}` is "Google" or "Facebook". `{n}` is `max(1, ceil(Retry-After / 60))`, with "minute" when n = 1 and "minutes" otherwise. Page messages live in `apps/web/src/lib/auth/messages.ts`; field messages live in the shared zod schemas (`packages/shared/src/api/auth.ts`) so web and API show the same text. API `error.message` strings mirror this deck for context-free codes; tests assert the web text.

### Page titles and headings

| Page | `<title>` | H1 | Intro / context line |
|---|---|---|---|
| `/login` | Sign in – Shared Game Management | Sign in | "Sign in to continue." (only with a non-root `returnTo` and no other notice) |
| `/register` | Create account – Shared Game Management | Create your account | none |
| `/register/complete` | Finish signing up – Shared Game Management | Finish signing up | "You're signing up with {Provider} as {email}." |
| `/forgot-password` (form) | Reset your password – Shared Game Management | Reset your password | "Enter the email you signed up with and we'll send you a link to set a new password." |
| `/forgot-password` (sent) | Check your email – Shared Game Management | Check your email | see F5 |
| `/reset-password` | Set a new password – Shared Game Management | Set a new password | none |
| `/account` | Your account – Shared Game Management | Your account | none |
| Protected page, API down | Something went wrong – Shared Game Management | We can't load this page right now | E-PAGE-1 |
| 403 page (reserved) | No access – Shared Game Management | You don't have access to this page | E-AUTHZ-1 |

When a form returns validation errors, the `<title>` is prefixed with "Error: ".

### Header, buttons, links, labels, hints

| Key | Text |
|---|---|
| Brand | Shared Game Management |
| Header (signed out) | Sign in · Create account |
| Header (signed in) | Signed in as {fullName} · Account · Sign out |
| Buttons | Create account · Sign in · Continue with Google · Continue with Facebook · Finish sign-up · Use a different account · Send reset link · Send another link · Set new password · Connect Google · Connect Facebook · Disconnect · Sign out · Try Facebook again · Try again |
| Pending labels | Creating account… · Signing in… · Redirecting to {Provider}… · Finishing… · Sending… · Saving… · Signing out… · Connecting… · Disconnecting… |
| Links | Forgot your password? · Don't have an account? Create one · Already have an account? Sign in · Back to sign in · Use a different email · Request a new link · Sign in instead · Reset your password · Set a password · Go to the home page |
| Divider | or |
| Labels | Full name · Email · Password · New password · Sex (legend) · Male · Female · Other |
| Hints | Full name: "As your team will see it." · Email (register): "We'll send password reset links here." · Password (register): "At least 10 characters. Avoid common passwords." · New password: "At least 10 characters. Avoid common passwords. Setting a new password signs you out on all your devices and disconnects any Google or Facebook sign-in." · Sex: "Some teams set session prices by sex." |
| Password toggle | Show password / Hide password (`aria-pressed`) |
| Error summary heading | There's a problem |
| `/account` | Section headings "Details", "Sign-in methods", "Sign out" · method names "Email and password", "Google", "Facebook" · statuses "Connected" / "Not connected" · "Platform admin" · last-method note "You need at least one way to sign in." · set-password help "We'll email you a link to set one." · R1 warning "For your security, setting a password this way also disconnects {Provider list}. You can reconnect it straight after." |

### Field errors (422 `validation_failed`, `fieldErrors`; also shown by client validation)

| Field | Condition | Message |
|---|---|---|
| fullName | empty | Enter your name. |
| fullName | > 255 | Use 255 characters or fewer. |
| email | empty | Enter your email address. |
| email | malformed | Enter a valid email address. |
| password (login) | empty | Enter your password. |
| password (set) | < 10 code points | Use at least 10 characters. |
| password (set) | > 128 code points | Use at most 128 characters. |
| password (set) | common or equals email / local part | This password is too common or too easy to guess. Choose a different one. |
| sex | none selected | Select your sex to continue. |

### Notices (role `status`, polite)

| ID | Code | Where | Text |
|---|---|---|---|
| N-SESSION | `session_expired` | `/login` | Your session has expired. Sign in again. |
| N-SIGNOUT | `signed_out` | `/login` | You've signed out. |
| N-RESET | `password_updated` | `/login` | Password updated. Sign in with your new password. |
| N-RESET-R1 | `password_updated` + `removed` | `/login` | Password updated. For your security we disconnected {Provider list} from this account. Sign in and reconnect it from your Account page. |
| N-WELCOME | `welcome` | any page (`FlashNotice`) | Welcome! Your account is ready. |
| N-LINKED | `linked` | `/account` | {Provider} connected. You can now sign in with it. |
| N-ALREADY | `already_linked` | `/account` | {Provider} is already connected. |
| N-UNLINKED | `unlinked` | `/account` | {Provider} disconnected. You can connect it again at any time. (Email and password: "Email and password sign-in disconnected.") |
| N-CONTEXT | (non-root `returnTo`) | `/login` | Sign in to continue. |
| N-INAPP | (in-app browser UA) | above the Google button | Google sign-in doesn't work inside the Facebook or Instagram app. Open this page in your browser (use the app's menu, then "Open in browser"), or use another sign-in method. |
| N-UNAVAILABLE | (`GET /auth/providers` failed) | `/login`, `/register` | Sign-in is having trouble right now. Google and Facebook buttons will be back shortly. You can still try email and password. |

`{Provider list}`: "Facebook", "Google", or "Facebook and Google".

### Errors (role `alert`)

| ID | Code | Where | Text | Actions |
|---|---|---|---|---|
| E-REG-1 | `email_taken` | `/register` | An account with this email already exists. If you signed up with Google or Facebook, use that button to sign in. | Sign in instead · Reset your password |
| E-LOGIN-1 | `invalid_credentials` | `/login` | Incorrect email or password. / If you signed up with Google or Facebook, use those buttons instead. (second line only when a provider is enabled) | |
| E-LOGIN-2 | `too_many_attempts` | `/login` | Too many sign-in attempts. Try again in {n} minutes. / You can reset your password now, or continue with Google or Facebook. | Reset your password |
| E-FORGOT-1 | `too_many_requests` | `/forgot-password` | Too many requests. Try again in {n} minutes. | |
| E-RESET-1 | `invalid_or_expired_token` | `/reset-password` | This reset link is invalid or has expired. If you just set a new password, try signing in with it. | Request a new link · Back to sign in |
| E-OAUTH-1 | `oauth_cancelled` | `/login` | {Provider} sign-in was cancelled. | |
| E-OAUTH-2 | `oauth_state_invalid` | `/login` | We couldn't verify that sign-in attempt. Please try again. / If it keeps happening, open this page in your device's main browser rather than inside another app. | |
| E-OAUTH-3 | `provider_unavailable` | `/login` | {Provider} is unavailable right now. Try again, or sign in with email and password. | |
| E-OAUTH-4 | `provider_not_enabled` | `/login` | {Provider} sign-in isn't available. Use another sign-in method. | |
| E-OAUTH-5 | `oauth_email_missing`, facebook | `/login` | Facebook didn't share an email address, which we need to create your account. Try again and allow access to your email, or use Google or email and password instead. | Try Facebook again (rerequest) |
| E-OAUTH-6 | `oauth_email_missing`, google | `/login` | Google didn't share an email address we can use. Use another sign-in method. | |
| E-OAUTH-7 | `oauth_email_unverified` | `/login` | Google says this email address isn't verified. Verify it with Google or use another method. | |
| E-OAUTH-8 | `oauth_account_exists` | `/login?returnTo=%2Faccount` | An account already exists for {email}. Sign in with your existing method, then connect {Provider} from your Account page. (no `sgm_flash`: "…for the email address on your {Provider} account…") | Sign in (`/login?returnTo=%2Faccount`) · Forgot your password? (`/forgot-password?returnTo=%2Faccount`) |
| E-OAUTH-9 | `signup_expired` | `/login` | Your sign-up session expired. Please start again. | |
| E-LINK-1 | `oauth_cancelled` (link) | `/account` | Connecting {Provider} was cancelled. | |
| E-LINK-2 | `oauth_state_invalid` (link) | `/account` | We couldn't verify that attempt to connect {Provider}. Please try again. | |
| E-LINK-3 | `provider_unavailable` (link) | `/account` | {Provider} is unavailable right now. Try connecting again later. | |
| E-LINK-4 | `link_session_mismatch` / `session_expired` at link | `/login?returnTo=%2Faccount` | Sign in again to connect {Provider}. | |
| E-LINK-5 | `identity_in_use` | `/account` | That {Provider} account is already connected to a different account. | |
| E-LINK-6 | `provider_already_connected` | `/account` | Your account already has a {Provider} sign-in. Disconnect it first to connect a different one. | |
| E-ACCT-1 | `last_sign_in_method` | `/account` | You can't disconnect your only sign-in method. Connect another one first. | |
| E-AUTHZ-1 | `forbidden` | page / action | You don't have permission to do that. (page body: "If you think you should, ask your team admin.") | Go to the home page |
| E-SYS-1 | (browser offline / action fetch failed) | same page | You seem to be offline. Check your connection and try again. | |
| E-SYS-2 | `internal_error`, `service_unavailable`, timeout, API unreachable, unknown code | same page | Something went wrong on our side. Your details are still here. Try again in a minute. | |
| E-SYS-3 | `cross_origin_request` | same page | This request was blocked because it didn't come from this site. Reload the page and try again. | |
| E-PAGE-1 | protected page load failed | `error.tsx` | Something went wrong on our side. Try again in a minute. | Try again |

### Emails

**Password reset** (template `password-reset`, AC-INTEGRATION-1). Subject: `Reset your Shared Game Management password`. Text body:
```
Hi {fullName},

We received a request to reset the password for your Shared Game Management account.

Set a new password:
{WEB_BASE_URL}/reset-password?token={token}

This link expires in 60 minutes and can be used once. Setting a new password signs you out on all your devices and disconnects any Google or Facebook sign-in from your account.

If you didn't request this, ignore this email. Your password won't change.

Shared Game Management
```

**Sign-in method connected** (template `identity-linked`, algorithm AC-ASYNC-5). Subject: `{Provider} sign-in connected to your Shared Game Management account`. Text body:
```
Hi {fullName},

{Provider} sign-in was connected to your Shared Game Management account. You can now sign in with {Provider}.

If this wasn't you, reset your password now: {WEB_BASE_URL}/forgot-password
Resetting your password signs out every device and disconnects Google and Facebook sign-in, including this one.

Shared Game Management
```

---

## Implementation Guidelines

### Frontend requirements
1. **Form primitives** (`apps/web/src/components/auth/`): `AuthCard` (single column, `max-w-sm`, 16 px gutter), `OAuthButtons` (enabled providers, in-app hint, pending lock), `TextField`, `PasswordField` (show/hide), `SexField` (fieldset and legend, radios with the whole label as a ≥ 44 px tap target), `ErrorSummary`, `FormBanner` (notice or error by code), `SubmitButton` (`useFormStatus`, pending label, `aria-disabled`, no double submit).
2. **State**: forms are client components around Server Actions with `useActionState`; the action returns `{ fieldErrors?, error?: { code, retryAfter?, email? }, values }` for in-place errors and calls `redirect()` for every navigation. Password fields are never echoed back.
3. **Server Action wrapper** catches client-side rejection of the action call (offline) and shows E-SYS-1.
4. **Redirects**: every post-auth redirect is `redirect(target, RedirectType.replace)`. `/login` and `/register` redirect signed-in users using `getCurrentUser()` (X7).
5. **Callback route handler**: delete `sgm_oauth`, parse it with the shared codec (`packages/shared/src/auth/oauth-binding.ts`, schema in the architecture doc), compare only the state component in constant time, apply the landing tables in F3 and F8, set `sgm_session`, `sgm_pending` or `sgm_flash` as needed.
6. **`FlashNotice`** in `layout.tsx` (client, inside `Suspense`) renders `notice=welcome` on any page and strips it. Auth pages render their own codes server-side and strip them after mount.
7. **Mobile input attributes**: email `type="email" inputmode="email" autocomplete="email"` (`username` on `/login`), `autocapitalize="none" autocorrect="off" spellcheck="false"`; password `autocomplete="current-password"` (login) or `new-password` (register, reset); full name `autocomplete="name" autocapitalize="words"`; inputs at least 16 px font so iOS does not zoom; no `autofocus` (it pops the keyboard over the OAuth buttons).
8. **In-app browser detection** (`apps/web/src/lib/auth/in-app-browser.ts`): server-side user-agent test for `FBAN|FBAV|FB_IAB|Instagram|Messenger` → N-INAPP.

### Backend requirements (journey-driven contract additions, accepted in the 2026-10-06 consolidation; C-7 stays COULD)
- **C-1** `POST /auth/oauth/:provider/authorize` accepts `{ returnTo?, rerequest?: boolean }`; `rerequest` is honoured only for Facebook (`auth_type=rerequest`), ignored otherwise.
- **C-2** Binding cookie payload: `sgm_oauth = <state>.<ctx>` exactly as defined once in the architecture doc ("Browser-binding cookie `sgm_oauth`": format, 1024-byte limit, state-only constant-time compare, `r` through `safeReturnTo`, `i` an untrusted hint, tamper/expiry/replay behaviour, interop tests). No API change (X8).
- **C-3** `GET /auth/oauth/pending` and `POST /auth/oauth/complete` responses include `returnTo` from the pending row; the web callback redirects to `/register/complete` with no query.
- **C-4** `GET /auth/identities` returns `{ identities: [{ provider, connectedAt, lastUsedAt }], enabledProviders: { google, facebook } }`. No `emailVerified` flag: after D1 the R1 warning depends only on whether a provider is connected.
- **C-5** A 409 `oauth_account_exists` response (callback S4, complete C4) includes the conflicting email in `error.message` or an `error.email` field that only the web server reads, so the web can set `sgm_flash`. (The browser never sees the API body.)
- **C-6** `POST /auth/password/reset` returns `{ removedProviders: ('GOOGLE'|'FACEBOOK')[] }`: every provider identity the account had before the reset (R1 per D1), possibly empty (algorithm step G).
- **C-7** (COULD) `POST /auth/password/reset/check { token }` → 204 or 400 `invalid_or_expired_token`, public, no hashing, no consumption; lets `/reset-password` show E-RESET-1 before the user types.

### Integration points

| System | Interface | Data exchanged |
|---|---|---|
| Google | OAuth redirect (browser) + token/ID token (API) | `sub`, email, `email_verified`, name |
| Facebook | OAuth redirect (browser, optional `auth_type=rerequest`) + Graph `/me` (API) | id, email (may be absent), name |
| Mail (Mailpit / Postmark) | `send-email` job | Reset and identity-linked emails |
| API ⇄ web | JSON + bearer | `ErrorResponse` codes drive every landing in this doc |

---

## Acceptance Criteria (MANDATORY)

The spec's ACs (with the architecture and algorithm amendments) remain the contract; the consolidated wording lives in `memory-bank/tasks/auth-and-user-roles.md`. The criteria below are the journey layer: amended wording for existing IDs where this design changes behaviour, and new IDs continuing the spec's numbering with the project's canonical prefixes (accessibility and mobile checks are `AC-VERIFY-*`, navigation is `AC-ENTRY-*`). The AC impact list at the end summarises them.

### AC-ENTRY-1: User can find the feature (amended)
**Priority**: MUST
**Given** a visitor without a session on `/` or any public page
**When** they look at the header
**Then** they see the links "Sign in" (→ `/login`) and "Create account" (→ `/register`), keyboard-focusable with visible labels; on any page other than `/` and the auth pages, both links carry `returnTo` set to the current path and query; on auth pages they carry the page's existing `returnTo`
**Verification**:
- [ ] E2E: links exist and are focusable by Tab
- [ ] E2E: on `/account`'s redirect target `/login?returnTo=%2Faccount`, the header "Create account" href contains `returnTo=%2Faccount`
- [ ] E2E: no `returnTo` on `/`

### AC-HAPPY-1: User completes the primary journey (journey refinement)
**Priority**: MUST
**Given** a visitor on `/register?returnTo=%2Faccount`
**When** they:
  1. type Full name "Aroha Ngata", Email "Aroha.Ngata@Example.com", Password "kowhai-court-27"
  2. choose Female
  3. click "Create account"
**Then**:
  - User sees `/account` (the `returnTo`), the header "Signed in as Aroha Ngata", and the notice "Welcome! Your account is ready."
  - Data: one `users` row (`aroha.ngata@example.com`, `FEMALE`, `PLAYER`), one PASSWORD identity (`$argon2id$`), one `auth_sessions` row
  - Browser history: pressing Back does not show the registration form
**Verification**:
- [ ] E2E: complete flow from entry to success
- [ ] Integration: rows as above
- [ ] E2E: notice shown once, gone after reload

### AC-ERROR-1: Duplicate email recovery (amended)
**Priority**: MUST
**Given** an account for `aroha.ngata@example.com`
**When** a visitor registers with `AROHA.NGATA@example.com`
**Then** the page shows "An account with this email already exists. If you signed up with Google or Facebook, use that button to sign in." with links "Sign in instead" (`/login?returnTo=…`) and "Reset your password" (`/forgot-password?returnTo=…`); Full name, Email and Sex stay filled, Password is cleared; focus moves to the error banner
**Verification**:
- [ ] E2E: message, links, preserved fields, focus on banner

### AC-ERROR-18: Service unavailable is survivable (new)
**Priority**: MUST
**Given** a visitor on `/register`, `/login`, `/forgot-password`, `/reset-password` or `/register/complete`
**When** the API is unreachable, times out or answers 5xx/503 on submit
**Then** the page shows "Something went wrong on our side. Your details are still here. Try again in a minute.", keeps every non-password field, and nothing is created; on a protected page load, the user sees "We can't load this page right now" with "Try again" and is **not** redirected to `/login` or signed out; with a session cookie present and the API down, the header shows no "Sign in" link
**Verification**:
- [ ] E2E: API stopped (or route mocked) → banner and preserved fields
- [ ] E2E: `/account` with the API down → error page, cookie still present

### AC-ERROR-7: OAuth recovery keeps the user's place (amended)
**Priority**: MUST
Add to the spec text: "Messages name the provider used ('{Provider} sign-in was cancelled.', '{Provider} is unavailable right now. Try again, or sign in with email and password.'). The error landing keeps the original `returnTo`, so a successful retry still lands there. A replayed callback URL with no binding cookie redirects a signed-in user to `/` with no message and shows 'We couldn't verify that sign-in attempt. Please try again.' to anyone else; in neither case is the state consumed twice. When the flow was started from `/account` to connect a provider, these errors land on `/account` with 'Connecting {Provider} was cancelled.', 'We couldn't verify that attempt to connect {Provider}. Please try again.' or '{Provider} is unavailable right now. Try connecting again later.'"
**Verification**:
- [ ] E2E (fake provider): `error=access_denied` from `/login?returnTo=%2Faccount` → `/login?…returnTo=%2Faccount` with the message; retry lands on `/account`
- [ ] E2E: revisit the used callback URL while signed in → `/`

### AC-ERROR-14: Expired or duplicated pending sign-up (amended)
**Priority**: MUST
Add: "A missing `sgm_pending` cookie is treated as expired. If the browser already has a live session (the same sign-up was finished in another tab), submitting or reloading `/register/complete` lands on `returnTo` or `/` signed in, with no error. 'Use a different account' clears the pending sign-up and returns to `/login`."
**Verification**:
- [ ] E2E: two tabs on `/register/complete`; submit in A, then in B → B lands signed in
- [ ] E2E: "Use a different account" → `/login`; revisiting `/register/complete` → expired message

### AC-ASYNC-1: User knows what happens after requesting a reset (journey refinement)
**Priority**: MUST
**Given** a visitor on `/forgot-password`
**When** they submit any syntactically valid email
**Then** the page changes to "Check your email" with "If an account exists for that email, we've sent a reset link.", "We sent it to {typed email}. The link works once and expires in 60 minutes.", a "Send another link" button, "Use a different email" and "Back to sign in"; the page is byte-for-byte identical (apart from the echoed email) for known and unknown accounts; for a real account the email reaches Mailpit within 30 s
**Verification**:
- [ ] E2E: sent state for known and unknown emails (DOM equal after masking the email)
- [ ] E2E: Mailpit message, link opens `/reset-password`

### AC-ENTRY-7: Back button and already-signed-in visits never show a stale auth form (new)
**Priority**: SHOULD
**Given** a user who just signed in, registered, finished OAuth sign-up or reset their password
**When** they press the browser Back button, or open `/login` or `/register` directly (with or without `returnTo`)
**Then** they never see a usable sign-in or sign-up form while signed in: history entries were replaced, and the server redirects signed-in visits to the validated `returnTo` or `/`; a browser holding only a **dead** session cookie is shown the `/login` form, not redirected
**Verification**:
- [ ] E2E: sign in, Back → not on `/login`
- [ ] E2E: `/login?returnTo=%2Faccount` while signed in → `/account`
- [ ] Integration (web): expired session cookie + `/login` → form renders (no redirect loop)

### AC-ENTRY-8: Finished-elsewhere and replays resolve to the signed-in state (new)
**Priority**: SHOULD
**Given** a first-time OAuth sign-up open on `/register/complete` in two tabs, or a used OAuth callback URL still in the browser history
**When** tab B submits or reloads after tab A finished, or a signed-in browser revisits the used callback URL
**Then** the browser lands on the validated `returnTo` or `/`, signed in, with no error message, and no OAuth state or pending sign-up is used twice
**Verification**: overlaps the amended AC-ERROR-7 and AC-ERROR-14; listed separately so UAT walks both two-tab cases.

### AC-INTEGRATION-1: Real email, real link, used once (unchanged)
The reset email text in the [Copy deck](#emails) meets the spec's required phrases ("If you didn't request this, ignore this email.", the 60-minute expiry, the link prefix).

### AC-HAPPY-13: Sign-out and welcome confirmations (new)
**Priority**: SHOULD
**Given** a signed-in user
**When** they click "Sign out"
**Then** they land on `/login` with "You've signed out." even if the API is unreachable (the cookie is deleted either way); and after a successful registration (password or OAuth completion) the destination page shows "Welcome! Your account is ready." once
**Verification**:
- [ ] E2E: sign out → `/login` with the notice; header anonymous
- [ ] E2E: sign out with the API route mocked to fail → same result, cookie gone

### AC-ERROR-20: OAuth email conflict shows the email without putting it in a URL (new)
**Priority**: MUST
**Given** the S4 or C4 conflict for `aroha.ngata@example.com` via Facebook
**When** the user lands on `/login`
**Then** the URL is `/login?error=oauth_account_exists&provider=facebook&returnTo=%2Faccount` (no email in it), the banner reads "An account already exists for aroha.ngata@example.com. Sign in with your existing method, then connect Facebook from your Account page.", and signing in with the form on that page lands on `/account`; after 60 s a reload shows the variant without the address
**Verification**:
- [ ] E2E (fake provider): URL has no `@`; banner text; sign-in lands on `/account`

### AC-VERIFY-11: Focus and announcements across the journey (new)
**Priority**: MUST
**Given** any auth page used with a keyboard and a screen reader
**When** a submit fails validation, a server error returns, or a page loads with a notice or error code
**Then**: on validation failure focus moves to an error summary ("There's a problem") whose items link to each invalid field, each field has `aria-invalid="true"` and `aria-describedby` pointing at its message and hint, and the `<title>` starts with "Error: "; on a single server error (401, 409, 429, 5xx) focus moves to the error banner (`role="alert"`, `tabindex="-1"`); a notice present on page load (`role="status"`) sits directly after the H1 and does not steal focus, while an error present on page load receives focus once; pending submits announce their pending label through a polite live region; the Sex radio group is a `fieldset` with legend "Sex" and is fully operable with arrow keys; no information is conveyed by colour alone; axe-core reports no critical or serious violations on every auth page and on `/account`
**Verification**:
- [ ] E2E: keyboard-only register with a missing sex → focus on the summary; follow its link → focus on the first radio
- [ ] E2E: `/login?error=oauth_cancelled&provider=google` → focus on the banner
- [ ] E2E: axe scan of `/login`, `/register`, `/register/complete`, `/forgot-password` (both states), `/reset-password`, `/account`

### AC-VERIFY-12: Phone-friendly forms (new)
**Priority**: SHOULD
**Given** a 360 × 740 viewport
**When** the player opens `/login`, `/register` or `/register/complete`
**Then** OAuth buttons appear above the email form, there is no horizontal scroll, inputs use at least 16 px text, every tap target (buttons, radio labels, links in banners) is at least 44 × 44 px, email inputs use `type="email"` with `autocapitalize="none"`, password inputs carry the right `autocomplete` value and a "Show password" toggle, and no field is auto-focused
**Verification**:
- [ ] E2E (mobile project): layout checks and attribute assertions

### AC-VERIFY-13: In-app browser hint for Google (new)
**Priority**: SHOULD
**Given** a request whose user agent identifies the Facebook, Messenger or Instagram in-app browser
**When** `/login` or `/register` renders with Google enabled
**Then** the hint "Google sign-in doesn't work inside the Facebook or Instagram app. Open this page in your browser (use the app's menu, then "Open in browser"), or use another sign-in method." appears directly above "Continue with Google"; ordinary browsers do not show it
**Verification**:
- [ ] Unit: UA classifier fixtures
- [ ] E2E: page with a Facebook in-app UA shows the hint

---

## Test Scenarios (derived from acceptance criteria)

### Happy path tests
1. AC-ENTRY-1: header links and `returnTo` propagation.
2. AC-HAPPY-1: register with `returnTo`, welcome notice, Back behaviour.
3. AC-HAPPY-3/4/5 (spec) through the fake provider, including the in-place `/register/complete` 422 (C1).
4. AC-ASYNC-1: forgot sent state, Mailpit link, reset, R1 variant via fake Facebook link.
5. AC-HAPPY-13: sign-out landing and welcome once.

### Error scenario tests
1. AC-ERROR-1, AC-ERROR-18, AC-ERROR-20.
2. AC-ERROR-7 sign-in and link contexts, with `returnTo` kept.
3. Every row in [Where every error lands](#where-every-error-lands-and-how-the-user-recovers) has at least one web-level test asserting landing URL and text (table-driven over `messages.ts`).

### Edge case tests
1. AC-ENTRY-7: Back after sign-in; signed-in `/login`; dead-cookie `/login` (no loop).
2. AC-ENTRY-8 / AC-ERROR-14: two tabs on `/register/complete`; callback replay while signed in.
3. `/auth/session-expired` with a live session does not delete the cookie (X14).
4. AC-VERIFY-11, AC-VERIFY-12/13.

## Accessibility Checklist

- [x] Keyboard navigation through every page; logical tab order (OAuth buttons, then fields, then submit, then cross-links)
- [x] Screen reader announcements: `role="alert"` for errors, `role="status"` for notices, polite live region for pending labels
- [x] Focus management: error summary or banner on failure; first-load errors focused once; no focus traps; no autofocus
- [x] Error messages tied to inputs with `aria-describedby`; `aria-invalid`; summary links target the field ids (radio group: first radio)
- [x] Loading states announced, with no double submit
- [x] No time limits the user must beat: the 15-minute pending window and 60-minute reset link are generous and recoverable in one step
- [x] Page `<title>` per page, prefixed "Error: " on validation failure
- [x] Icons in provider buttons `aria-hidden`; button text carries the meaning
- [x] Errors marked with an icon and the visually hidden word "Error:", never colour alone

## Analytics & Observability

No web telemetry backend exists; the funnel is read from the API's structured events (architecture) plus the two new ones below.

### Key metrics

| Metric | Purpose | Target |
|---|---|---|
| Password registration completion (`auth.register{provider=PASSWORD}` ÷ register submits) | Form friction | > 90% |
| First-time OAuth completion (C5 ÷ `pending_signup` outcomes) | `/register/complete` friction | > 85% |
| Time from OAuth start to completed sign-up | Persona goal (under a minute) | p50 < 45 s |
| Conflict rate (`auth.oauth.conflict` ÷ OAuth callbacks) | Revisit 3C if high (algorithm) | < 5% |
| Facebook missing-email rate | Revisit 4C if high (algorithm) | < 5% of first-time Facebook callbacks |
| Throttled sign-ins (`auth.login.failed reason=throttled_*`) | Venue NAT false positives | Investigate any `throttled_address` spike |
| `oauth_state_invalid` rate | In-app browser and app-switch problems | < 2% of callbacks |

### Instrumentation points (additions)
- `auth.oauth.pending.created` (API, `provider`): fired at S5, so pending abandonment = created − completed.
- `auth.oauth.callback.landing` (web log, `outcome` code, `provider`, `intent`; no PII): fired by the callback route handler, giving the binding-mismatch rate, which the API never sees.

## Validation Checklist

- [x] Journey delivers stated value (signed in on the intended page in about four taps)
- [x] All personas can complete it (Player via every method; admins via the same path; operator via CLI)
- [x] Every error has a landing page, a message and a next step
- [x] Async states are clear (reset sent state, resend, spam hint)
- [x] Consistent with the binding architecture and algorithm decisions (contradictions listed and resolved)
- [x] Accessible per the spec's NFR (AC-VERIFY-11)
- [x] Testable: every landing is a URL plus a code plus a copy-deck string

---

## AC impact

**Amend** (proposed wording above, summarised here):
1. **AC-ENTRY-1**: header links carry `returnTo` (current path and query; on auth pages the existing `returnTo`; none on `/`).
2. **AC-ENTRY-3**: "the form cannot be submitted" means client-side validation blocks the request and shows "Select your sex to continue." in the summary and beside the field (X9); same on `/register/complete`.
3. **AC-ENTRY-5**: signed-in visits to `/login` and `/register` redirect to the validated `returnTo` or `/`; "signed in" means `GET /auth/me` succeeds, and a dead cookie gets the form (X7).
4. **AC-HAPPY-1 / AC-HAPPY-3 / AC-HAPPY-4**: after creating an account the destination shows "Welcome! Your account is ready." once; landing honours `returnTo` (the pending row's for OAuth).
5. **AC-HAPPY-6**: after the reset, this browser's session cookie is deleted; every reset removes all Google and Facebook identities (R1 per D1), and with removals the landing is `/login?notice=password_updated&removed=…&returnTo=%2Faccount`.
6. **AC-HAPPY-7**: lands on `/login` with "You've signed out."; the cookie is deleted even when the API call fails.
7. **AC-HAPPY-11/12**: `/account` lists only enabled or already-connected providers; "Set a password" for accounts without a PASSWORD identity; disconnect has no confirmation step; success notices "{Provider} connected. You can now sign in with it." and "{Provider} disconnected. You can connect it again at any time."; the last-method row explains "You need at least one way to sign in."
8. **AC-ERROR-1**: helper sentence and link labels "Sign in instead" / "Reset your password"; links carry `returnTo`; sex is also preserved; focus moves to the banner.
9. **AC-ERROR-2**: too-long password message "Use at most 128 characters." (X3), plus the algorithm's common-password case.
10. **AC-ERROR-3**: second line "If you signed up with Google or Facebook, use those buttons instead." when a provider is enabled; email kept, password cleared.
11. **AC-ERROR-4**: algorithm wording plus the recovery line "You can reset your password now, or continue with Google or Facebook."; singular "minute".
12. **AC-ERROR-7**: provider-named messages, `returnTo` kept, signed-in replay → `/` silently, link-context variants on `/account` (above).
13. **AC-ERROR-8**: algorithm wording; landing `/login?error=oauth_account_exists&provider=…&returnTo=%2Faccount`; the email comes from the 60-second `sgm_flash` cookie, never the URL (X2, new AC-ERROR-20).
14. **AC-ERROR-9**: algorithm wording and "Try Facebook again" (needs C-1).
15. **AC-ERROR-11**: the `/auth/session-expired` handler deletes the cookie only when `GET /auth/me` confirms 401 (X14); API outages on protected pages show an error page, not a sign-in redirect.
16. **AC-ERROR-13**: `returnTo` pointing at an auth page (`/login`, `/register`, `/register/complete`, `/forgot-password`, `/reset-password`, `/auth/*`) is treated as `/` (X13).
17. **AC-ERROR-14**: missing cookie = expired; finished-in-another-tab → signed-in landing; "Use a different account" (above).
18. **AC-ERROR-6**: the web rejects a syntactically invalid email with "Enter a valid email address." before calling the API (the API's uniform 202 is unchanged) (X10). The sent page echoes the typed email and offers "Send another link".
19. **Spec code list**: use only the codes in the architecture doc's authoritative `ErrorCode` list, which adopts the algorithm's codes (X1).

**Add**: AC-ERROR-18 (MUST, service unavailable), AC-ERROR-20 (MUST, conflict email not in URL), AC-VERIFY-11 (MUST), AC-ENTRY-7 (SHOULD), AC-ENTRY-8 (SHOULD), AC-HAPPY-13 (SHOULD), AC-VERIFY-12 (SHOULD), AC-VERIFY-13 (SHOULD), and optionally AC-ERROR-19 (COULD): "`/reset-password` checks the token on load (C-7) and shows 'This reset link is invalid or has expired.' before any password is typed."

**Contract additions** (accepted in the 2026-10-06 consolidation): C-1 `rerequest`, C-2 binding-cookie payload (schema in the architecture doc), C-3 `returnTo` in pending/complete responses, C-4 identities response shape, C-5 conflict email for the web server (`error.email`), C-6 `removedProviders`; C-7 reset check stays COULD (spec AC-ERROR-19).

## Page and file changes vs the plan's New Source Files

Legend: **+** add, **=** confirmed, **~** extend.

- = all planned pages: `apps/web/src/app/{login,register,register/complete,forgot-password,reset-password,account}/page.tsx`, `apps/web/src/app/auth/callback/[provider]/route.ts`, `apps/web/src/components/site-header.tsx`
- = (from architecture) `apps/web/src/app/auth/session-expired/route.ts`, `apps/web/src/lib/auth/{cookies,messages,session,actions}.ts`
- **+** `apps/web/src/components/site-header-links.tsx`: client part of the header (`returnTo` from the current URL, `aria-current`)
- **+** `apps/web/src/components/flash-notice.tsx`: global one-time notice (`welcome`) and param stripping
- **+** `apps/web/src/components/auth/{auth-card,oauth-buttons,text-field,password-field,sex-field,error-summary,form-banner,submit-button}.tsx`: form primitives (the reference for later forms)
- **+** `apps/web/src/components/auth/{login-form,register-form,complete-signup-form,forgot-password-form,reset-password-form,sign-in-methods}.tsx`: client forms wired to the Server Actions
- **+** `apps/web/src/app/account/error.tsx`: protected-page outage view (E-PAGE-1); later protected routes copy it
- **+** `apps/web/src/lib/auth/in-app-browser.ts` (+ `in-app-browser.test.ts`)
- **+** `packages/shared/src/auth/oauth-binding.ts` (+ test): encode, parse and validate the `sgm_oauth` value (C-2; shared so the API can test interop)
- **+** `apps/web/src/lib/auth/client-address.ts` (+ test): client address from `X-Forwarded-For` with `WEB_TRUSTED_PROXY_HOPS` (architecture "Client address trust boundary")
- **+** `apps/web/src/lib/auth/landing.ts` (+ test): pure mapping from callback and action outcomes to redirect URLs (the landing tables in F3, F8 and the error table), so the 25-odd landings are unit-tested once
- ~ `packages/shared/src/auth/return-to.ts`: auth-page exclusion (X13)
- ~ `packages/shared/src/api/auth.ts`: field messages from the copy deck; `rerequest`; identities response shape
- ~ `apps/api/src/modules/auth/emails.ts`: both email templates from the copy deck
- ~ `apps/web/e2e/auth.spec.ts`: journey scenarios above; add a mobile Playwright project (360 × 740) and an axe scan (`@axe-core/playwright`, dev dependency)
- (COULD) API route `POST /auth/password/reset/check` in `modules/auth/routes.ts`

## Next Steps

1. Done (2026-10-06): the AC impact list and contract additions are folded into `memory-bank/tasks/auth-and-user-roles.md`, X8 and C-5 are acknowledged in the architecture doc, and the naming is settled.
2. Phase 4 (web password flows): build the form primitives, `messages.ts` from the copy deck, `landing.ts`, header states, `FlashNotice`, `/account` without OAuth rows, AC-VERIFY-11 and AC-VERIFY-12.
3. Phase 5 (OAuth): callback landings, the shared `oauth-binding.ts` codec, `/register/complete`, link rows on `/account`, the in-app hint, AC-ERROR-20.
4. Phase 6: Playwright journeys for every flow in this document (desktop and mobile projects) plus the axe scans; `/yay:uat` walks F1–F8 with the Player persona on a phone viewport.

## Consolidation (2026-10-06)

Reconciled with the architecture and algorithm docs, the spec, the codex design critique and the user's decisions D1 and D2. The **Chosen** journey (Option 1, dedicated single-purpose pages) is unchanged.

- **R1 eviction (user decision D1, critique finding 1)**: every completed reset disconnects all Google and Facebook sign-in. Updated F5 (new bullet), X12 (warning shown whenever a provider is connected, no `emailVerified` check), the reset form hint, the reset email and the identity-linked email copy, C-4 (dropped `emailVerified`) and C-6 (`removedProviders` = every provider the account had). The success copy N-RESET-R1 is unchanged.
- **Binding cookie (D2, finding 3)**: X8, C-2 and implementation guideline 5 now reference the single `sgm_oauth` schema in the architecture doc; the codec moved from `apps/web/src/lib/auth/oauth-binding.ts` to `packages/shared/src/auth/oauth-binding.ts`.
- **Client address (D2, finding 2)**: the system-boundary diagram shows `x-sgm-internal-auth`; `apps/web/src/lib/auth/client-address.ts` added to the file list.
- **Error contract (D2, finding 4)**: X1 points to the authoritative `ErrorCode` list in the architecture doc (retired codes: `pending_signup_expired` → `signup_expired`, `oauth_email_conflict` → `oauth_account_exists`, `identity_already_linked` → `identity_in_use`); `service_unavailable` (503) added to the error table and E-SYS-2.
- **AC ids remapped to canonical prefixes**: AC-A11Y-1 → AC-VERIFY-11, AC-MOBILE-1 → AC-VERIFY-12, AC-MOBILE-2 → AC-VERIFY-13, AC-NAV-1 → AC-ENTRY-7, AC-NAV-2 → AC-ENTRY-8 (now with Given/When/Then). AC-ERROR-19 (C-7) is in the spec as COULD.
- **Naming settled** (the paragraph under the contradictions table): `used_at`, `signin`/`link`, `link_user_id`, `user_agent varchar(512)`, `revoked_reason` kept, `fieldErrors`. The earlier spellings `consumed_at`, `SIGN_IN`/`LINK`, `bound_user_id`, 255 and `fields` are retired.
- **Contract additions** C-1 to C-6 accepted; C-7 stays COULD.
