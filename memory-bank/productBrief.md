# Product Brief

> Product and project context for development teams. Source documents: `PRODDUCT-OVERVIEW.md`, `database-design.md`, `workflows_state_machine_architecture.md`.

## Project Foundation

- **Project Name**: shared-game-management
- **Objectives**: Deliver a web app for sports session registration and court management with Akahu-integrated payments and NZ GST compliance.
- **Scope**: Teams, membership and moderation, recurring multi-court sessions, registration with FIFO waitlist, cancellation rules, prepaid wallet and post-game billing, GST invoices and exports, admin reporting. Out of scope for now: native mobile apps and subscription billing (`MONTHLY_SUBSCRIPTION`/`QUARTERLY_SUBSCRIPTION` enums exist in the draft schema but have no requirements). Also not yet built: live Akahu payments and verification of team bank details (the live Akahu adapter is pending its gate; see wallet-and-akahu-billing) and PDF tax invoices (tax-invoices-and-exports).
- **Repository Structure**: Greenfield. Only spec documents at the root so far; layout to be decided in `platform-foundation`.
- **Key Stakeholders**: Quy Nguyen (owner)

## Git Configuration
- **Repository**: Yes
- **Provider**: GitHub
- **CLI Available**: none (`gh` not installed)
- **Remote URL**: https://github.com/quynguyenhcm/shared-game-management.git
- **Default Branch**: main
- **Metadata Branch**: main
- **Routing Mode**: classic
- **Sync Automation**: none
- **Archive Strategy**: push-and-pr

## Product Overview

- **Name**: Shared Game Management (working title)
- **Value Proposition**: Lets social sports groups (e.g. badminton clubs) schedule court sessions, fill them fairly and collect fees straight into the team's bank account, without spreadsheets or chasing payments by hand.
- **Product Type**: Web app (SaaS)
- **Stage**: Concept

## Key Functionality

- Self-registration (email/password, Google, Facebook) with a required sex selection
- Team creation, public discovery, private invite links, join approval, skill levels, banning, auto-enrol
- Recurring multi-court sessions with single-date overrides, cost-based suggested rates, and flat, by-sex or by-skill pricing
- Registration with up to 2 guests, FIFO waitlist, overdue-debt blocking, and deadline-based cancellation fees
- Prepaid wallet per team (balance capped at $100 NZD), post-game auto-deduction when the wallet covers the fee, pay-by-bank payments through Akahu for the rest (the live Akahu adapter is pending; the platform runs on a fake payment adapter until then), overdue marking, payment reminders, and a low-credit alert below $20 NZD
- Payment holds and payout blocks: a payment whose bank outcome is unclear is held for review rather than marked paid or unpaid; a team whose bank account Akahu cannot pay is blocked from new paid publishes until its account is fixed
- Team banking and GST settings: a team admin sets the bank account that receives payouts and whether the team is GST-registered. Paid sessions cannot be published until banking is set up, and, once payouts are live (wallet-and-akahu-billing), a payout account that Akahu rejects blocks new paid publishes until it is fixed. The account name and number are encrypted and write-only after save, and every approved admin of the team, including the one who made the change, is emailed when they change. Akahu verification of the account is a future feature (wallet-and-akahu-billing).
- NZ GST (15%, 3/23 split), PDF tax invoices, and IRD-ready CSV/Excel exports
- Player dashboard (Currently Opening, My Registration, Payments & Wallet) and an admin master report

## Markets Serviced

- **Primary Market**: Community and social sports clubs
- **Geographic Focus**: New Zealand (NZD, NZ bank account format, IRD/GST, Akahu)

## Key Personas

### Primary Users

| Persona | Role | Goals | Pain Points | Success Metrics |
|---------|------|-------|-------------|-----------------|
| Player | `PLAYER` | Find and join teams, register for sessions, pay easily | Missing out on full sessions, manual bank transfers | Registration completed in under 30s, few overdue payments |

### Administrators/Operators

| Persona | Role | Responsibilities |
|---------|------|------------------|
| Team Admin | `TEAM_ADMIN` (per team) | Banking and GST setup, sessions and pricing, membership approval, skill levels, bans, payment reminders, resolving held payments for the team's account, exports |
| Global Admin | `GLOBAL_ADMIN` | Platform-wide oversight, payment reminders for any team, setting a payout block, and resolving held payments for support |

## User Flows

- **Team Banking Setup**: A team admin opens "Banking and GST" from the team's manage area, enters the bank account name and number, and saves. The team is then ready to take payments. A later change can keep the saved account number by leaving that field blank. Removing banking is refused while a paid session is published or a payment is outstanding.
- **Primary Flow**: Player opens "Currently Opening", registers (with optional guests) and is confirmed or waitlisted. After the game, the fee is deducted from the wallet or an Akahu payment link is sent.
- **Wallet top-up**: A player opens their team's wallet, enters an amount up to the $100 limit, and pays it to the team's bank account through Akahu. The balance is credited once the payment is confirmed, and the page shows "Processing" until then. Wallet credit can only be used for that team's game fees.
- **Paying a charge**: A player who lacks the wallet balance for a game gets an email with a link to the payment page. The page is for that player only, and a payment is never marked paid twice. A charge that is not paid by its due date (72 hours after the game is billed) becomes overdue, and the player and admins are told.
- **Admin reminders and payments**: A team admin (or a global admin) sees the team's unpaid payments and can send a reminder, at most once a day per payment. Held payments are resolved by the team's admins or a global admin.
- **Onboarding**: Sign up, pick sex, find or join a team with a self-assessed skill level, then wait for admin approval.
- **Key Workflows**: See `workflows_state_machine_architecture.md` (registration gatekeeper, cancellation and promotion, post-game billing, recurrence materialisation).

## Non-Functional Requirements

### Security
- **Authentication**: Email/password plus OAuth 2.0 (Google, Facebook)
- **Authorization**: Global role plus per-team role (RBAC)
- **Encryption**: TLS in transit. Akahu credentials and bank details must be encrypted at rest. Team bank account name and number are encrypted at rest and shown masked (last 4 digits) after save; the team's GST number is not secret, since it is printed on invoices.
- **Payments**: a payment page is visible only to the player who owes the charge (a uniform not-found for anyone else). Akahu webhooks are accepted only with a valid signature over the raw body, and a webhook is treated as a signal that the platform checks with Akahu before any change. Payment emails link to the payment page, which needs sign-in, and never carry a bank detail or a payment token.
- **Notifications on sensitive change**: every approved admin of the team, including the one who made the change, is emailed when banking details change or are removed. The email names who changed them and when, and contains no account name or digits.

### Data & Privacy
- **Privacy Requirements**: NZ Privacy Act 2020
- **Data Retention**: Keep financial records for 7 years (IRD requirement). Payment, ledger, top-up and payout-block records are kept under this rule and are never deleted by the application.

### Internationalization
- **Supported Languages**: English
- **Localization**: NZD currency, NZ date format, Pacific/Auckland timezone

## Integration Points

| System | Purpose | Protocol | Direction |
|--------|---------|----------|-----------|
| Akahu (One-Off Payments) | Pay-by-bank payments and wallet top-ups, paid to the team's bank account. **Not live yet**: the live adapter is pending its gate (Akahu's written answer on third-party team payees, sandbox credentials and a signed sandbox webhook). Until then a fake adapter runs in development and tests | REST + webhooks | Both |
| Google / Facebook | OAuth sign-in | OAuth 2.0 | Outbound |
| Email provider (TBD) | Reminders, low-credit alerts | SMTP/API | Outbound |

## Open Questions

- [ ] §6 of the overview has the cancellation windows backwards. The workflow doc uses `NOW <= cancellation_deadline` → free, which is taken as correct.
- [ ] Backend choice: Node (Express/NestJS) or Python (FastAPI)?
- [ ] How guests are priced under `BY_SEX` / `BY_SKILL_LEVEL`, since the draft schema stores no guest attributes
- [ ] Payments need a team link (`team_id`) for routing, GST and exports. It's missing in the draft schema.
- [x] Wallet top-up cap: is $100 a cap on the balance or on each top-up? Resolved: a cap on the balance (ruling B1, approved 2026-10-30). The minimum top-up is $1.00.
- [ ] Akahu go or no-go on third-party team payees, payee-verification liability, first-payment holds and distinct-payee caps (Akahu's written answer to MVE-001, pending). It gates the live adapter and ADR 0020's acceptance.

## Document History

| Date | Author | Changes |
|------|--------|---------|
| 2026-09-29 | Claude (/yay:init) | Initial creation from spec documents |
| 2026-10-16 | Claude (team-banking-and-gst, Phase 5) | Added team banking and GST capability, paid-session publish gate, change notification, write-only bank details |
| 2026-11-05 | Claude (wallet-and-akahu-billing, Phase 6 docs) | Added the wallet, post-game billing, payments and payout-block capabilities and their user flows. Akahu is an integration point with the live adapter pending (Phase 4b); not live |

## Last Refreshed

2026-11-05
