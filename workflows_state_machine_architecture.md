# Application Workflows & State Machine Architecture

This document details the core business workflows, decision trees, and state machine transitions for the Sports Session Platform.

---

## 1. Registration Gatekeeper & Capacity Workflow

When a player attempts to register for a game session, the system evaluates their overdue debt status before checking court capacity and queuing rules.

```
+-------------------------------------------------------------+
|               User Clicks "Register" Button                 |
+-------------------------------------------------------------+
                              |
                              v
             /---------------------------------\
            /   Check Overdue Debt Count:       \
           /    COUNT(payments WHERE status =    \
          <     'OVERDUE' AND user_id = USER)     >
           \                                     /
            \-----------------------------------/
                              |
              +---------------+---------------+
              |                               |
       Count >= 3                       Count < 3
              |                               |
              v                               v
+---------------------------+   /---------------------------\
| BLOCK REGISTRATION        |  /    Check Seat Availability: \
| Prompt player to clear    | <     Seats Requested + Claimed >
| overdue transactions first|  \    <= Public Capacity?       /
+---------------------------+   \---------------------------/
                                              |
                              +---------------+---------------+
                              |                               |
                             YES                              NO
                              |                               |
                              v                               v
               +---------------------------+   +---------------------------+
               | Status: CONFIRMED         |   | Status: WAITLISTED        |
               | Seat secured for game     |   | Assign next FIFO queue    |
               +---------------------------+   | position index            |
                                               +---------------------------+
```

---

## 2. Cancellation & Waitlist Promotion Rules Engine

When a player requests a withdrawal, fees and waitlist promotions are determined based on whether the request occurs before or after the cancellation cutoff deadline (defaults to 48 hours prior to game start).

```
+-------------------------------------------------------------+
|               Player Requests Cancellation                  |
+-------------------------------------------------------------+
                              |
                              v
             /---------------------------------\
            /    Is NOW <= Cancellation         \
           <     Deadline?                       >
            \    (Default: 48 hours prior)      /
             \---------------------------------/
                              |
              +---------------+---------------+
              |                               |
             YES                              NO
              |                               |
              v                               v
+---------------------------+   +---------------------------+
| Status: WITHDRAWN         |   | Status: WITHDRAWN         |
| Fee: $0.00 (No Charge)    |   |                           |
|                           |   | Check Waitlist Status:    |
| Auto-promote 1st player   |   | Is Waitlist Non-Empty?    |
| on FIFO Waitlist          |   +---------------------------+
+---------------------------+                 |
                              +---------------+---------------+
                              |                               |
                             YES                              NO
                              |                               |
                              v                               v
               +---------------------------+   +---------------------------+
               | Promote 1st Waitlisted    |   | Auto-Generate Payment     |
               | Player to CONFIRMED       |   | Record for Withdrawing    |
               | Fee assigned to new player|   | Player                    |
               +---------------------------+   +---------------------------+
```

---

## 3. Post-Game Auto-Billing & Wallet Deduction Workflow

When a game session reaches its end time (calculated as the maximum `end_time` among all courts for that session), the post-game billing engine runs automatically.

```
+-------------------------------------------------------------+
|      Game Session Ends (NOW >= MAX(court.end_time))         |
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
|          Transition game_sessions.status -> COMPLETED       |
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
|       Iterate Over Each CONFIRMED Player Registration       |
+-------------------------------------------------------------+
                              |
                              v
             /---------------------------------\
            /    Does Player Have Credit        \
           <     Balance >= Session Total Fee?   >
            \                                   /
             \---------------------------------/
                              |
              +---------------+---------------+
              |                               |
             YES                              NO
              |                               |
              v                               v
+---------------------------+   +---------------------------+
| Deduct Fee from Wallet    |   | Generate Akahu Direct     |
| Payment Status -> PAID    |   | Payment Link              |
| Billing Type -> PREPAID   |   | Due Date = NOW + 3 Days   |
+---------------------------+   +---------------------------+
              |                               |
              v                               v
  /-----------------------\     /---------------------------\
 /  Remaining Balance      \   /   Webhook Received Within   \
<   < $20.00 NZD?           > <    3 Days?                    >
 \                         /   \                             /
  \-----------------------/     \---------------------------/
              |                               |
      +-------+-------+               +-------+-------+
      |               |               |               |
     YES              NO             YES              NO
      |               |               |               |
      v               v               v               v
+-----------+   +-----------+   +-----------+   +-----------+
| Send Low  |   | Finished  |   | Status:   |   | Status:   |
| Credit    |   +-----------+   | PAID      |   | OVERDUE   |
| Alert     |                   +-----------+   | Increment |
+-----------+                                   | Overdue   |
                                                | Counter   |
                                                +-----------+
```

---

## 4. Recurrent Session & Auto-Enrollment Materialization

Background worker workflow for generating future session instances and auto-enrolling pre-approved team members.

```
+-------------------------------------------------------------+
|    Cron Worker Runs (Weekly / On New Session Rule Creation) |
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
| Fetch Active recurring_session_rules WHERE recur_until >=   |
| NOW() or recur_until IS NULL                                |
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
| Generate Concrete game_sessions & session_courts Rows       |
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
| Fetch team_members WHERE is_auto_enroll = TRUE AND          |
| (auto_enroll_until >= session.date OR auto_enroll_until IS NULL)|
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
| Enroll Players in Order of Auto-Enroll Assignment Date      |
| - If within Capacity -> Status: CONFIRMED                   |
| - If over Capacity   -> Status: WAITLISTED                  |
+-------------------------------------------------------------+
```