# Product Brief

> Product and project context for development teams. Source documents: `PRODDUCT-OVERVIEW.md`, `database-design.md`, `workflows_state_machine_architecture.md`.

## Project Foundation

- **Project Name**: shared-game-management
- **Objectives**: Deliver a web app for sports session registration and court management with Akahu-integrated payments and NZ GST compliance.
- **Scope**: Teams, membership and moderation, recurring multi-court sessions, registration with FIFO waitlist, cancellation rules, prepaid wallet and post-game billing, GST invoices and exports, admin reporting. Out of scope for now: native mobile apps and subscription billing (`MONTHLY_SUBSCRIPTION`/`QUARTERLY_SUBSCRIPTION` enums exist in the draft schema but have no requirements).
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
- Prepaid wallet per team (max $100 NZD), post-game auto-deduction, Akahu payment links, overdue cron and reminders
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
| Team Admin | `TEAM_ADMIN` (per team) | Banking and GST setup, sessions and pricing, membership approval, skill levels, bans, reminders, exports |
| Global Admin | `GLOBAL_ADMIN` | Platform-wide oversight and payment reminders |

## User Flows

- **Primary Flow**: Player opens "Currently Opening", registers (with optional guests) and is confirmed or waitlisted. After the game, the fee is deducted from the wallet or an Akahu payment link is sent.
- **Onboarding**: Sign up, pick sex, find or join a team with a self-assessed skill level, then wait for admin approval.
- **Key Workflows**: See `workflows_state_machine_architecture.md` (registration gatekeeper, cancellation and promotion, post-game billing, recurrence materialisation).

## Non-Functional Requirements

### Security
- **Authentication**: Email/password plus OAuth 2.0 (Google, Facebook)
- **Authorization**: Global role plus per-team role (RBAC)
- **Encryption**: TLS in transit. Akahu credentials and bank details must be encrypted at rest.

### Data & Privacy
- **Privacy Requirements**: NZ Privacy Act 2020
- **Data Retention**: Keep financial records for 7 years (IRD requirement)

### Internationalization
- **Supported Languages**: English
- **Localization**: NZD currency, NZ date format, Pacific/Auckland timezone

## Integration Points

| System | Purpose | Protocol | Direction |
|--------|---------|----------|-----------|
| Akahu | Direct payments and wallet top-ups to the team's bank account | REST + webhooks | Both |
| Google / Facebook | OAuth sign-in | OAuth 2.0 | Outbound |
| Email provider (TBD) | Reminders, low-credit alerts | SMTP/API | Outbound |

## Open Questions

- [ ] §6 of the overview has the cancellation windows backwards. The workflow doc uses `NOW <= cancellation_deadline` → free, which is taken as correct.
- [ ] Backend choice: Node (Express/NestJS) or Python (FastAPI)?
- [ ] How guests are priced under `BY_SEX` / `BY_SKILL_LEVEL`, since the draft schema stores no guest attributes
- [ ] Payments need a team link (`team_id`) for routing, GST and exports. It's missing in the draft schema.
- [ ] Wallet top-up cap: is $100 a cap on the balance or on each top-up? (Assume cap on balance.)

## Document History

| Date | Author | Changes |
|------|--------|---------|
| 2026-09-29 | Claude (/yay:init) | Initial creation from spec documents |

## Last Refreshed

2026-09-29
