# Agentic Coding Prompt: Sports Registration & Court Management App

Build a sports session registration and court management web application using React/Next.js (Tailwind CSS), Node.js (Express/NestJS) or Python (FastAPI), and PostgreSQL, fully integrated with the Akahu Open Banking payment gateway (New Zealand).

---

## System Architecture & Core Requirements

### 1. Self-Registration & User Roles
* **Roles:** `GLOBAL_ADMIN`, `TEAM_ADMIN`, `PLAYER`.
* Players self-register directly via Email/Password, Google OAuth, or Facebook OAuth.
* Users must select their sex (`MALE`, `FEMALE`, `OTHER`) upon account registration.

### 2. Dynamic Team Creation, Discovery, Moderation, Banking & Skill Levels
* **Team Creation:** Any registered user can create a team by defining Team Name, Description, and Visibility (`PUBLIC` or `PRIVATE`). The creator becomes `TEAM_ADMIN`.
* **Team Merchant Banking:** Team Admins must configure their NZ Bank Account details (Account Name & Account Number in NZ format `XX-XXXX-XXXXXXX-XX`) and Akahu merchant credentials so incoming player payments route directly to the team's bank account. Paid game sessions cannot be published until banking details are linked.
* **Team Discovery:** Public teams are indexed on a searchable "Find a Team" page (`/teams/find`). Private teams are hidden and accessible only via direct share links containing a unique invite token (`/teams/join?code=XYZ`).
* **Team Membership & Skill Level Selection:** Requesting to join a team requires selecting an initial self-assessed skill level (`BEGINNER`, `INTERMEDIATE`, or `ADVANCED`). Joining creates a `PENDING` request for Team Admin approval.
* **Skill Overrides & Auto-Progression:** Team Admins can review, approve, reject, or manually override member skill levels. Completing 40 games for a specific team in the trailing 365 days automatically advances the member's team skill level to the next tier (`BEGINNER` -> `INTERMEDIATE` -> `ADVANCED`).
* **Team Moderation & Banning:** Team Admins can ban a member (`status = 'BANNED'`). Banning immediately revokes team access, blocks future registrations, and cancels active session registrations (triggering waitlist promotion). Team Admins cannot ban other Team Admins without demoting them first.
* **Auto-Enrollment:** Team Admins can flag members for "Auto Enroll" with an optional `auto_enroll_until` date. Auto-enrolled members are automatically registered for all newly created game sessions hosted by that team up to their "Until" date.

### 3. Player Dashboard Interface (3 Core Tabs)
Upon logging in, players access three primary tabs:
1. **Tab 1: "Currently Opening":** Displays all upcoming active game sessions open for registration across joined teams with team name, court schedule, address, pricing rate, available seats, and an instant "Register" button.
2. **Tab 2: "My Registration":** Lists all player registrations with DateTime, Payment Status (`PAID`, `PENDING`, `OVERDUE`), Team Name, Location Address, and Total Fee.
3. **Tab 3: "Payments & Wallet":** Displays prepaid wallet balance per team with a "Top Up Credit" button (maximum $100.00 NZD balance), alongside categorized transaction accordions (`Overdue`, `Pending`, `Paid`) with direct Akahu payment links and downloadable PDF tax invoices.

### 4. Multi-Court Session Setup, Costing & Recurrence Engine
* **Recurrent Session Engine:** Allows Team Admins to schedule recurring games (e.g., Weekly on Wednesdays) with an optional `recur_until` date. A background worker generates concrete session instances up to the "Until" date.
* **Single-Instance Overrides:** Team Admins can edit any specific date instance in a recurring series (adjust courts, modify capacity, alter start/end times, or adjust player rates) without breaking the rest of the series.
* **Session Configuration:** Stores location name, full street address (e.g., "12B John Glenn Avenue, Rosedale, Auckland 0632")[cite: 1], date, cancellation deadline (defaults to 48h prior to session start)[cite: 1], max capacity (`max_players`), and reserved host seats (`reserved_seats`).
* **Multi-Court Setup:** UI provides a fast setup allowing admins to bulk-apply default start/end times across all courts simultaneously, with inline overrides per court (e.g., Courts 1-2: 8am-10am; Court 7: 8am-9am; Court 9: 9am-10am).
* **Costing & Auto-Rate Suggestion:** Admin inputs total court hire cost and extra expenses (e.g., shuttlecocks). System calculates a suggested break-even player rate: `ceil((total_court_cost + extra_expenses) / max_players)`.
* **Editable Rate Field:** The suggested rate is rendered in an editable text input. The Team Admin can adjust and save the final rate, which is used to generate payment requests post-game.
* **Pricing Models:** Supports `FLAT`, `BY_SEX` (e.g., $17 Male / $16 Female)[cite: 1], or `BY_SKILL_LEVEL` (`BEGINNER`, `INTERMEDIATE`, `ADVANCED`).

### 5. Registration, Enqueuing & Debt Control
* **Capacity Calculation:** `Public Capacity = max_players - reserved_seats`.
* **Guest Registrations:** Primary registrants can add up to 2 guests (+1, +2)[cite: 1]. The entire group is enqueued together.
* **FIFO Waitlist:** When registrations reach `max_players`[cite: 1], subsequent registrants are automatically placed on a FIFO waitlist with a sequential `queue_position`[cite: 1]. If a confirmed slot frees up, the first waitlisted player is automatically promoted to `CONFIRMED`.
* **Debt Enforcement:** Prior to processing a new registration, the system checks the user's overdue count. If the user has >= 3 `OVERDUE` payments, registration is blocked with a prompt to settle outstanding balances first.

### 6. Cancellation Rules Engine
* **Early Withdrawal (<= 48h before session):** Status set to `WITHDRAWN`, $0 fee generated, promote 1st waitlisted player.
* **Late Withdrawal (> 48h before session):** Status set to `WITHDRAWN`. If waitlist is NOT empty, promote 1st waitlisted player (fee assigned to new player). If waitlist IS empty, auto-generate a payment record for the withdrawing player.

### 7. Prepaid Wallet & Automated Post-Game Billing (Akahu Gateway)
* **Prepaid Wallet Top-Up:** Players can top up prepaid credits up to $100.00 NZD maximum per team via Akahu Direct Payment.
* **Payment Destination Routing:** Akahu routes all payments (direct or wallet top-up) directly to the target team's configured bank account[cite: 1].
* **Auto-Deduction Engine:** Post-game (at max court end_time), if the player has sufficient credit balance, the system automatically deducts the fee and marks the payment as `PAID` (`PREPAID_CREDIT`).
* **Low Credit Alert:** If the wallet balance drops below $20.00 NZD after an auto-deduction, send an automated "Low Credit Reminder" notification to top up.
* **Direct Akahu Fallback:** If wallet balance is insufficient, fallback to generating an Akahu direct payment link with a 3-day due date.
* **Daily automated cron job** sets unpaid items to `OVERDUE` after 3 days and dispatches reminder notifications.
* **Admin Action:** Team/Global Admins can manually trigger an immediate payment reminder email for any specific overdue/pending payment from the admin view.

### 8. New Zealand Tax & GST Compliance Module
* **GST Support:** Team Admins can input their IRD Number, GST Registration Number, and toggle GST status.
* **Automated GST Splits:** Auto-calculate 15% GST component on all paid transactions for GST-registered teams (`GST = Total * 3 / 23`).
* **IRD-Ready Financial Exports:** Allow Team Admins to export CSV/Excel income reports filtered by custom date ranges or standard NZ financial periods (e.g., GST bi-monthly periods, Apr 1 – Mar 31 Financial Year).
* **Tax Receipts:** Generate downloadable PDF Tax Invoices/Receipts for players containing IRD numbers and GST breakdowns.

### 9. Admin Master Reporting Dashboard
* Filterable, searchable, and sortable master view of all player registrations across sessions.
* **Filters & Search:** Sort/search by Date Range, Player Name/Email, and Payment Status (`PAID`, `PENDING`, `OVERDUE`).
