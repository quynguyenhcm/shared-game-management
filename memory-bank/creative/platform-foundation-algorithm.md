# Algorithm Decision: Platform Foundation (money, DST/session instants, invoice numbers, fee snapshot and guests)

**Created**: 2026-09-29
**Status**: DECIDED
**Decision Type**: Algorithm
**Task**: `platform-foundation` (Level 4). Spec: `memory-bank/tasks/platform-foundation.md`
**Resolves**: Creative Q6, Q7, Q9, Q11 (numbering kept; ACs reference it).
**Stack constraints**: `memory-bank/creative/platform-foundation-architecture.md` → "Constraints handed to Algorithm Design" (C-1 … C-12 below refer to that list).
**Database target**: **PostgreSQL 17** (user decision 2026-09-29, superseding the spec's 15). All DDL, images (`postgres:17`) and version notes below are for 17. See [PostgreSQL 17 notes](#postgresql-17-notes) for which 16/17 features were used, and which were considered and rejected.

> **Governing principles**: P1–P7 from the task's Architectural Plan. `systemPatterns.md` is still the template. The ones that matter most here: **P1** DB constraints are the source of truth. **P2** Money never touches binary floating point. **P3** UTC `timestamptz` inside, Pacific/Auckland only at the edges. **P5** at-least-once jobs, so handlers must be idempotent.

> **Evidence gathered for this document (2026-09-29)**
> - Pacific/Auckland transitions, computed with Node 24.19 / ICU 78.3 / tzdata 2026b by scanning every 15 min: DST ends **2026-04-05** (`2026-04-04T14:00Z`, +13→+12). DST starts **2026-09-27** (`2026-09-26T14:00Z`, 02:00 NZST → 03:00 NZDT, +12→+13). DST ends **2027-04-04** (`2027-04-03T14:00Z`, 03:00 NZDT → 02:00 NZST). DST starts **2027-09-26** (`2027-09-25T14:00Z`). DST ends **2028-04-02**, starts **2028-09-24**. All are Sundays, which matches the rule (last Sunday of September, first Sunday of April).
> - The prototype of the chosen conversion algorithm produced byte-identical output under `TZ=UTC` and `TZ=America/New_York`. An exhaustive round-trip of every 15-minute local slot from 2026 to 2028 gave 0 mismatches, 12 nonexistent slots and 12 ambiguous slots, as expected.
> - PostgreSQL 17 docs, §B.2: a nonexistent local time is *"assigned the UTC offset that prevailed … just before the transition"*, and an ambiguous one is *"assigned the UTC offset that prevailed just after the transition"*. **So native PG resolves the ambiguous 2027-04-04 02:30 to the later instant (14:30Z).** That differs from the policy chosen below, so the SQL mirror must override it (see Q7).
> - PostgreSQL 17 docs, `MERGE`: concurrent inserts can raise a unique violation, and the docs recommend `INSERT … ON CONFLICT` instead. `MERGE … RETURNING` is new in 17.
> - IRD, "How taxable supply information for GST works" (ird.govt.nz, checked 2026-09-29): the required content per value band (≤ $200, $200–$1,000, > $1,000) is seller name and GST number, date, description, consideration and GST amount/statement, plus buyer details over $1,000. **Nothing about an invoice number, unique identifier or sequential numbering.** Records are kept 7 years. *This is not legal advice. Confirm with an NZ chartered accountant before tax-invoices-and-exports ships (flagged as UNVERIFIED-LEGAL).*

---

## Problem Statement

The foundation must give every downstream feature four things.

1. An exact NZD money representation and one rounding rule, shared by browser and Node, with a DB column type that can't drift.
2. A Pacific/Auckland wall-clock ↔ UTC-instant policy that resolves the DST gap and overlap explicitly, plus indexed session instants for the 5-minute billing sweep.
3. A per-team invoice-number allocator, assigned per payment, that is correct under concurrency (including two issuers racing on the same payment) and callable inside the caller's Kysely transaction.
4. A payment fee-snapshot and guest model. It must price FLAT, BY_SEX (including sex `OTHER`) and BY_SKILL_LEVEL for a registrant and up to 2 guests, make replayed billing a no-op through natural unique keys, split GST per payment, tie every payment to its registration's user and session's team in the DB, and survive 7-year retention.

## Inputs & Outputs

### Inputs
| Name | Type | Size/Range | Source |
|------|------|------------|--------|
| Money from DB | `string` (`'17.50'`) | NUMERIC(10,2): ±99,999,999.99 | node-postgres (NUMERIC stays a string, C-1) |
| Money from API/UI | `string` | 0–2 dp, ≤ 8 integer digits | JSON body / form field |
| Ratio operands | `bigint` numerator/denominator | e.g. 3/23, 1/max_players | domain code |
| Local date | `'YYYY-MM-DD'` | 2000–2100 | DB `DATE` (string parser, C-4), UI |
| Local time | `'HH:MM[:SS]'` | 00:00–24:00 | DB `TIME`, UI |
| Instant | JS `Date` / ISO-8601 `…Z` | — | DB `timestamptz`, API |
| Payment ID for invoices | `uuid` | 1 payment per call (team derived from the payment) | caller's transaction |
| Registration + ≤ 2 guests + session fees | rows | ≤ ~60 registrations per session | billing job |

### Outputs
| Name | Type | Description |
|------|------|-------------|
| `Money` | branded `bigint` (integer cents) | arithmetic value; never a JS `number` |
| `MoneyString` | branded `string` `'-?\d+\.\d{2}'` | DB and wire form |
| Instant | `Date` / `timestamptz` | UTC; `game_sessions.starts_at/ends_at` maintained by DB trigger |
| Display strings | `string` | `$1,234.56`, `03/04/2027`, `8:00 pm` |
| Invoice number | `integer` (+ display `INV-000123`) | per team, gapless across committed transactions |
| Payment + line items | rows | immutable fee snapshot; GST as a generated column |

### Edge Cases
1. `"17.505"`, `"abc"`, `NaN`, `Infinity`, `17.5` (number) → typed `MoneyValidationError`, never rounded or coerced (AC-ERROR-5).
2. `99999999.99` round-trips through PG exactly. `100000000.00` → `OUT_OF_RANGE`.
3. GST 3/23 never produces a rounding tie (proof in Q6), so the rounding mode matters only for other ratios.
4. `2026-09-27 02:30` does not exist; `2027-04-04 02:30` occurs twice. Resolution depends on context: user input is rejected, derived times use `compatible`.
5. A session with no courts has NULL instants and can't leave `DRAFT`.
6. A court ending at midnight (`end_time = '24:00'`) resolves to 00:00 on the next local day.
7. Concurrent first-ever invoice allocation for a team (no counter row yet) → exactly one insert, and the rest update.
8. A transaction that allocated an invoice number then rolled back → the number is reused (no gap).
8a. Two issuers racing to assign an invoice number to the **same** payment → the second blocks on the payment row lock, then fails because the number is already set. The counter advances by exactly 1 (Q9, critique finding 3).
9. A replayed `bill-session` job → no second payment, no second wallet deduction.
10. A guest row count that disagrees with `guest_count` → `23514` at COMMIT (a deferred check).
11. A BY_SEX session and a party of sex `OTHER` → billed at the session's `fee_other` with basis `SEX_OTHER` (spec-owner decision 2026-09-29; see Q11). A BY_SEX session without `fee_other` can't be saved.
12. A payment or credit transaction whose user or team differs from its registration's → `23503` (composite FK; critique finding 1).
13. Two concurrent waitlist enqueues computing the same `queue_position` → the second fails with `23505` (partial unique index; critique finding 2).

---

## Constraints

### Performance Requirements
- **Latency**: no product SLA. Library calls must be negligible next to one DB round-trip (well under 1 ms). The billing of one session (≤ ~60 registrations) must commit in < 1 s, so pg-boss `expireInSeconds` (900) is never at risk.
- **Throughput**: registration bursts of hundreds per minute at most. Billing runs every 5 min. Invoice issuance is at most tens per team per session.
- **Memory**: constant per operation.

### Scale Requirements
- **Current**: hundreds to low thousands of users, tens of teams, about 10–50 sessions per team per month.
- **Growth**: 10× over 2 years (tens of thousands of payments per year; about 250k rows over the 7-year retention).
- **Peak concurrency**: 20 parallel allocations in the AC-VERIFY-9 test. Real contention per team stays in single digits.

### Other Constraints
- C-1/C-2: NUMERIC comes back as a string; codegen must be overridden so a JS `number` can't be inserted.
- C-3: `money` and `time` are isomorphic (browser + Node 24), with no native `Temporal` and no Node-only APIs.
- C-4/C-5: DATE and TIME arrive as strings, the DB runs with `TimeZone=UTC`, `timestamp without time zone` columns are banned, and the sweep needs an indexed `ends_at`.
- C-6: node-pg-migrate runs one SQL file per transaction. Enum values can't be added and used in the same file.
- C-7: the allocator is a single SQL call inside the caller's transaction. The test pool must be ≥ 21.
- C-8/C-9: natural unique keys for idempotent billing; RESTRICT FKs on financial tables.
- C-10: new enums are mirrored in `packages/shared/src/types/enums.ts`.
- C-11: cron DST behaviour is separate. No schedule fires between 02:00 and 02:59 local time.

---

## Options Explored

### Q6: Money representation and rounding

#### Option 6A: `NUMERIC(10,2)` in DB + decimal library (`big.js` / `decimal.js`) in TS
- **Approach**: keep the draft columns. TS wraps a `Big` in a branded type. Arithmetic uses the library, and rounding uses `Big.roundHalfUp`.
- **Pseudocode**: `gst = new Big(total).times(3).div(23).round(2, Big.roundHalfUp)`
- **Time Complexity**: O(d) per op, where d is the number of digits (≤ 12), so effectively O(1). Division is O(DP) iterations (`Big.DP` = 20 by default).
- **Space Complexity**: O(d) per value (an array of digits per object).
- **Data Structures**: arbitrary-precision decimal object.
- **Pros**: matches the draft; well-tested library; division precision is configurable.
- **Cons**: a runtime dependency in the browser bundle (big.js ≈ 6 kB, decimal.js ≈ 32 kB). Objects aren't comparable with `===`, and serialising a `Big` to JSON silently produces a string. Division produces unbounded-scale intermediates, so someone must remember to round. `Big` also accepts numbers (`new Big(0.1)`) unless the constructor is wrapped.
- **Best For**: many currencies, or arbitrary scales.
- **Worst For**: a single 2-dp currency with a handful of operations.

#### Option 6B: `BIGINT` integer cents in DB + `bigint` cents in TS
- **Approach**: change every money column to `BIGINT` (cents). TS uses `bigint`. SQL reports divide by 100 at display.
- **Time Complexity**: O(1) per op.
- **Space Complexity**: O(1).
- **Pros**: arithmetic is exact in both tiers; no decimal library.
- **Cons**: **diverges from `database-design.md` on every money column** (about 25 columns become deviations). Every ad-hoc SQL report, CSV export and admin query must remember `/100.0`, and one `/100` without `.0` truncates. AC-VERIFY-10's literals (`100.00`) become `10000`. The DB `CHECK` literals become unreadable, and a wrong scale is one forgotten multiplication away. INT8 comes back from the driver as a string anyway (C-1).
- **Best For**: high-volume ledgers that never do SQL-side reporting.
- **Worst For**: a schema that has to match a draft and feed IRD-ready exports written in SQL.

#### Option 6C (hybrid): `NUMERIC(10,2)` in DB and on the wire as a 2-dp string; branded `bigint` cents in TS
- **Approach**: the DB keeps the draft's `DECIMAL(10,2)` (no deviation; SQL reports stay readable; PG `round(numeric)` does the same rounding as TS). The driver returns `'17.50'`, which the repository parses into `Money = bigint & brand` (integer cents). All TS arithmetic is exact integer arithmetic with explicit rounding in the two functions that divide. Values leave TS as a canonical `MoneyString` (`'17.50'`) for the DB and JSON.
- **Pseudocode**:
  ```
  parseMoney(s):            // strict
      require typeof s == 'string' and s matches /^-?(0|[1-9]\d{0,7})(\.\d{1,2})?$/
      cents = BigInt(intPart) * 100n + BigInt(fracPart.padEnd(2,'0'))
      return sign * cents
  multiplyByRatio(m, num, den, mode):
      require den > 0n
      x = m * num
      q = x / den ; r = x % den          // bigint: truncates toward zero
      return roundQuotient(q, r, den, mode)
  roundQuotient(q, r, den, mode):
      if r == 0n: return q
      positive = (r > 0n)                // sign of the exact quotient (den > 0)
      HALF_UP: return |2r| >= den ? q + (positive ? 1n : -1n) : q   // half away from zero == PG round()
      CEIL:    return positive ? q + 1n : q
      FLOOR:   return positive ? q : q - 1n
  ```
- **Time Complexity**: Best/Average/Worst O(1). Values are ≤ 34 bits, and intermediates are ≤ 48 bits with a 4-digit numerator.
- **Space Complexity**: O(1).
- **Data Structures**: `bigint` (cents), with branded `string` for I/O.
- **Pros**: no dependency; exact. `bigint` and `number` can't be mixed. That is a compile error and a runtime `TypeError`, so a float can't sneak in. `JSON.stringify(bigint)` throws, so a Money can never reach the wire without `toMoneyString`. `===` works. No schema deviation. TS HALF_UP equals PG `round(numeric, 2)` (half away from zero).
- **Cons**: two representations (string for I/O, bigint for arithmetic), and repositories must convert. That is the same boundary 6A needs. `bigint` can't go through `structuredClone`-less paths such as a React Server Component → client prop. Such props must be sent as `MoneyString`, which is the rule anyway.
- **Best For**: one fixed-scale currency across two runtimes with a SQL reporting tier.
- **Worst For**: multi-currency with varying scales (not a requirement).

#### Option 6D: `NUMERIC(10,2)` + JS `number` cents (safe integers)
- **Approach**: like 6C, but `Money = number & brand` holding integer cents.
- **Pros**: fastest; JSON-friendly.
- **Cons**: `money * 0.15` still compiles if someone unwraps the brand. `Math.round` of a negative half rounds toward +∞ (`Math.round(-2.5) = -2`), which disagrees with PG. Division produces floats that must be re-rounded. That is exactly the float exposure P2 forbids.
- **Worst For**: any code path that divides.

**Rounding mode sub-question (applies to 6A/6C/6D):**

| Mode | Behaviour | Agrees with PG `round(numeric)`? | Relevance |
|---|---|---|---|
| **HALF_UP (half away from zero)** | 2.225 → 2.23, −2.225 → −2.23 | **Yes** | Commercial and invoice convention; what accountants' spreadsheets do |
| HALF_EVEN (banker's) | 2.225 → 2.22 | No. PG has no built-in numeric half-even, so SQL-side reports would disagree with the app | Removes bias only over large aggregates of tie cases |
| CEIL / FLOOR | directional | via `ceil`/`floor` | CEIL is needed for the rate suggestion (the spec says `ceil`) |

**GST never ties.** For a total of T cents, GST = 3T/23. The fractional part is k/23 with k ∈ {0…22}, and 23 is odd, so it can never be exactly ½. HALF_UP and HALF_EVEN therefore give identical GST for every possible amount. The mode choice only affects other ratios (splits, percentages), where agreeing with SQL is the deciding factor.

### Q7: DST policy, cancellation deadline, session instants and library

**7-i. Library for tz math (isomorphic, no native Temporal)**

| Option | Approach | Bundle (gz) | Disambiguation control | Notes |
|---|---|---|---|---|
| **7A. Hand-rolled on `Intl.DateTimeFormat`** (offset probe) | Read the wall clock with `formatToParts` (cached formatter, `hourCycle:'h23'`). Resolve local → instant by probing offsets at L−24h and L+24h and keeping the candidates that round-trip. | 0 (about 150 LOC) | Full: `compatible/earlier/later/reject` | The same algorithm ports line for line to plpgsql, so parity with the DB trigger holds by construction |
| 7B. `temporal-polyfill` (FullCalendar) | `PlainDateTime.toZonedDateTime(tz, {disambiguation})` | about 20 kB | Full (spec semantics) | A forward path to native Temporal. A dependency in the browser for about 5 functions, and the SQL mirror is still hand-written |
| 7C. Luxon | `DateTime.fromObject(…, {zone})` | about 23 kB | **None per call.** Gaps shift forward implicitly and overlap resolution is implicit | Can't express `reject` without re-deriving it by hand |
| 7D. `@date-fns/tz` (`TZDate`) | Date subclass with zone | about 2–5 kB | None per call | Implicit resolution; `Date` subclass semantics are easy to misuse with local getters |

- **Complexity (7A)**: `localToInstant` is O(1). It makes at most 4 `formatToParts` calls (2 offset probes + 2 candidate validations), about 5–20 µs with the formatter cached, O(1) space. `instantToLocal` makes 1 call. Correctness assumes at most one offset transition within ±24 h of any instant, which holds for every IANA zone in current use and trivially for Pacific/Auckland (2 per year, about 6 months apart).
- **Complexity (7B)**: the same O(1). A larger constant at first call (polyfill init) plus bundle cost.

**7-ii. Resolution policy for nonexistent and ambiguous local times**

| Option | Nonexistent `2026-09-27 02:30` | Ambiguous `2027-04-04 02:30` | Assessment |
|---|---|---|---|
| **P-a Context-dependent, explicit per call**: user input → `reject`; derived → `compatible` | reject → `NonexistentLocalTimeError` / compatible → `2026-09-26T14:30:00Z` (03:30 NZDT) | reject → `AmbiguousLocalTimeError` / compatible → `2027-04-03T13:30:00Z` (earlier, NZDT) | A person gets told; a machine never fails a job. `compatible` = RFC 5545 §3.3.5 = Temporal default = java.time `ZonedDateTime.of` |
| P-b Always `compatible` | 14:30Z silently | 13:30Z silently | An admin can create a session at a time that doesn't exist without noticing |
| P-c Always `reject` | error | error | A recurrence rule at 02:30 would fail materialisation twice a year and break the job |
| P-d PostgreSQL-native (`AT TIME ZONE`) | 14:30Z (offset before) | **14:30Z (later, standard time)** | Differs from RFC 5545/Temporal on overlap. There's no reject option, and it's implicit |

**7-iii. "Cancellation deadline defaults to 48 h prior"**

| Option | `starts_at` = `2027-04-05 19:00 NZST` (`07:00Z`) | Assessment |
|---|---|---|
| **Absolute duration: `starts_at − 48 h`** | `2027-04-03T07:00:00Z` = **03/04/2027 8:00 pm NZDT** | Matches the spec word "hours" and the AC-VERIFY-15 vector. Monotonic, computable in SQL without a zone (`- interval '48 hours'`), and the player's notice period is exactly 48 h |
| Same wall clock 2 days earlier | `2027-04-03 19:00 NZDT` = `2027-04-03T06:00:00Z` | Gives 49 h of notice on the DST-end weekend and 47 h on the DST-start weekend; needs disambiguation |

**7-iv. Where session instants come from (C-5)**

| Option | Approach | Complexity | Correctness risk |
|---|---|---|---|
| S1 Compute at query time | The sweep joins `session_courts`, takes `max(end_time)` and applies `AT TIME ZONE` | O(S·C) per sweep, where S is PUBLISHED sessions and C is courts. **Not indexable** | PG-native overlap = later, which contradicts the policy (P-d) |
| S2 App-computed stored columns | The session service recomputes `starts_at/ends_at` with the TS module on every date or court edit | O(C) per edit; the sweep is O(log S + k) via index | **Any code path that forgets to recompute bills at the wrong time**, with nothing catching it |
| **S3 DB-maintained stored columns** | `game_sessions.starts_at/ends_at timestamptz` are recomputed by triggers from `date` and `min(start_time)`/`max(end_time)` through `nz_local_to_utc(date, time, 'compatible')`, a plpgsql port of 7A. App writes are overwritten | O(C) per edit (C ≤ ~10, index on `session_courts(session_id)`); sweep O(log S + k) | Two implementations of one algorithm, guarded by a TS↔SQL parity test over the vector table and all 96 slots of each transition day |
| S4 Per-court instants | `session_courts.starts_at/ends_at` replace TIME | O(1) per court | Diverges from the draft; the recurrence engine still thinks in wall-clock |

### Q9: Per-team invoice-number allocation

#### Option 9A: Gapless counter row, upserted inside the caller's transaction
- **Approach**: a `team_invoice_counters(team_id PK, last_number)` row per team. `allocate_invoice_number(team_id)` does `INSERT … ON CONFLICT (team_id) DO UPDATE SET last_number = last_number + 1 RETURNING last_number`. The row lock is held until the caller commits or rolls back, which serialises allocations per team. A rollback undoes the increment, so committed numbers are gapless.
- **Pseudocode**:
  ```
  allocate(team):                              -- inside caller's txn
      upsert counter(team) +1 → n              -- row lock until COMMIT/ROLLBACK
      return n
  caller: begin; ...; n = allocate(team); update payments set invoice_number = n ...; commit
  ```
- **Time Complexity**: O(log T) per call (PK B-tree lookup, T = teams). Best/avg/worst are the same except for lock waits: a waiter blocks for the lock holder's *remaining transaction time*.
- **Space Complexity**: O(T) rows.
- **Pros**: gapless (among committed transactions); unique by construction; one statement; transactional; no DDL per team. `ON CONFLICT` makes the first-ever allocation race-safe with no seeding step.
- **Cons**: serialises same-team issuers for the rest of each transaction. A long transaction that allocates early blocks others, so allocate last and keep transactions short.
- **Best For**: low per-team contention (ours).
- **Worst For**: thousands of allocations per second per team.

#### Option 9B: One PostgreSQL `SEQUENCE` per team (`CREATE SEQUENCE invoice_seq_<team>` on team creation)
- **Time Complexity**: O(1) `nextval`, lock-free.
- **Pros**: no serialisation.
- **Cons**: `nextval` is **non-transactional**, so every rollback leaves a permanent gap. It needs dynamic DDL at runtime (team creation), which is against "no DDL at boot or runtime". Sequences pollute `pg_dump` and the AC-VERIFY-5 schema diff, and the name has to be looked up dynamically (`nextval(format(...))`). Also 1 sequence per team means T catalog objects.
- **Worst For**: anything needing gapless numbers or a clean schema dump.

#### Option 9C: `MAX(invoice_number) + 1` under a per-team advisory lock
- **Approach**: `pg_advisory_xact_lock(hashtextextended(team_id::text, 0))`, then `SELECT coalesce(max(invoice_number),0)+1 FROM payments WHERE team_id=$1`.
- **Time Complexity**: O(log P) with an index on `(team_id, invoice_number)`.
- **Pros**: no extra table; also gapless.
- **Cons**: a hash-collision lock can serialise unrelated teams (rare). It's easy to call the MAX without the lock (the correctness depends on a convention, not on the schema). Advisory locks are invisible in the schema (P1).

#### Option 9D: `MERGE … RETURNING` counter (PostgreSQL 17)
- **Approach**: the same counter table as 9A, with `MERGE INTO team_invoice_counters … WHEN MATCHED THEN UPDATE … WHEN NOT MATCHED THEN INSERT … RETURNING last_number`.
- **Cons**: per the PG 17 docs, `MERGE` does not do speculative insertion. Two concurrent first allocations for a new team can raise `23505`, and the docs point to `INSERT … ON CONFLICT` for this case. It has no advantage over 9A. **Rejected**, and recorded because the PG 17 upgrade invited it.

**IRD requirement (answering Q9's "confirm")**: the IRD taxable-supply-information rules (checked 2026-09-29) list no invoice number and no sequential or gapless requirement (see Evidence above). Gapless numbering is therefore **our choice**, not a legal need. It is cheap here and makes the ledger easy for an accountant to audit. **UNVERIFIED-LEGAL**: tax-invoices-and-exports should get an accountant's sign-off.

### Q11: Fee snapshot and guest model

**Guest model**

| Option | Shape | Max-2 guard | Count consistency | Extensibility |
|---|---|---|---|---|
| **G1 `registration_guests` child table** | `(registration_id, position 1..2, sex, skill_level, display_name?)` | `CHECK (position BETWEEN 1 AND 2)` + `UNIQUE(registration_id, position)`: declarative | `guest_count` kept (draft conformance) and checked by a **deferred constraint trigger** (`count = guest_count` and positions contiguous) | Changing the limit is a CHECK edit. Guests get IDs that line items can reference (RESTRICT) |
| G2 Positional columns `guest{1,2}_sex`, `guest{1,2}_skill` on `registrations` | one row | Implicit (only 2 slots) | Plain immediate CHECKs tying nullness to `guest_count` | Adding a guest attribute or slot needs 2 columns and CHECK rewrites. Line items can't FK a guest |
| G3 `guests JSONB` array | one row | `jsonb_array_length ≤ 2` CHECK | CHECK on length | No enum typing for sex or skill inside JSON; parity guards (C-10) can't see it |

Complexity: G1's deferred check is O(g) with g ≤ 2 per touched registration, run once per modified row at COMMIT. G2 is O(1). Both are negligible, so the decision rests on correctness and extensibility.

**Fee snapshot**

| Option | Shape | Idempotency key | GST | Constraint power |
|---|---|---|---|---|
| F1 Snapshot columns on `payments` | `registrant_basis, registrant_fee, guest1_basis, guest1_fee, guest2_…` | `UNIQUE(registration_id)` | per payment | Positional; `amount = sum` is a plain CHECK. But 3×(basis, sex, skill, fee) = 12 nullable columns with nullness CHECKs, and it can't grow beyond 2 guests |
| **F2 `payments` header + `payment_line_items`** (one line per party) | header: team, registration, pricing structure, GST snapshot, amount; lines: `party_position 0..2`, basis, sex/skill snapshot, `unit_fee` | `UNIQUE(registration_id)` on payments + `UNIQUE(payment_id, party_position)` on lines | per payment, as a generated column on the header | Line-level CHECKs (basis matches structure and attributes). `amount = Σ unit_fee` by deferred constraint trigger |
| F3 `fee_snapshot JSONB` on payments | free-form | `UNIQUE(registration_id)` | per payment | Money inside JSON is a JSON *number* (float) or unchecked text, **violating P2 at the storage layer**. There are no FKs or enum types, and SQL exports need `jsonb_path` for every report |

Complexity: F2 is O(p) per payment insert, with p ≤ 3 lines. The deferred sum check is O(p) with an index on `payment_line_items(payment_id)`. Reports are one join. F1 is O(1). F3 is O(1) but pays its cost in reporting.

---

## Complexity Comparison

| Metric | 6A Big.js | 6B BIGINT | **6C NUMERIC+bigint** | 7A **Intl probe** | 7B polyfill | **9A counter** | 9B seq/team | **G1+F2** | G2+F1 |
|---|---|---|---|---|---|---|---|---|---|
| Time (best) | O(1)* | O(1) | O(1) | O(1) | O(1) | O(log T) | O(1) | O(p) | O(1) |
| Time (avg) | O(1)* | O(1) | O(1) | O(1), about 10 µs | O(1) | O(log T) + lock wait | O(1) | O(p) | O(1) |
| Time (worst) | O(DP) div | O(1) | O(1) | O(1), 4 Intl calls | O(1) | + holder's remaining txn time | O(1) | O(p) | O(1) |
| Space | O(digits) | O(1) | O(1) | O(1) + 1 cached formatter | about 20 kB bundle | O(T) | O(T) catalog objects | O(p) rows | O(1) |
| Gapless / exact | exact | exact | exact | — | — | **gapless** | gaps on rollback | — | — |
| Implementation | Simple | Simple (plus many deviations) | Simple | Medium (well-tested) | Simple | Simple | Medium (dynamic DDL) | Medium (2 deferred triggers) | Simple |

\* digits ≤ 12, so effectively constant.

## Performance Projection

At the expected scale (10× growth: about 50k payments per year, 350k over 7 years, about 2k sessions per year, T ≤ 500 teams):

| Option | Expected latency | Memory |
|---|---|---|
| 6C money op | < 1 µs | a few bigints |
| 7A `localToInstant` | 5–20 µs (cached `Intl.DateTimeFormat`; first construction about 0.2 ms) | 1 formatter per zone |
| S3 trigger recompute on a court edit | < 0.5 ms (≤ 10 court rows, indexed) | — |
| Billing sweep query `ends_at <= now()` on a partial index | < 1 ms (k ≈ 0–5 due rows) | — |
| 9A allocation, uncontended | about 0.1–0.3 ms (one index lookup + HOT update) | — |
| 9A, 20-way contention (test) | the last waiter ≈ 20 × holder transaction time (about 20 × 2 ms = 40 ms) | 20 connections |
| F2 payment + 3 lines + deferred checks | < 1 ms per registration; about 60 ms per 60-player session | — |

---

## Decision

### Q6: **Chosen: Option 6C.** `NUMERIC(10,2)` in the DB, a 2-dp decimal **string** on the wire, and branded **`bigint` cents** in TS. Rounding is **HALF_UP (half away from zero)** for ratio operations and **CEIL to whole dollars** for the rate suggestion.

**Rationale**
- No schema deviation for money: all draft money columns stay `DECIMAL(10,2)`, and SQL exports and reports stay readable and correct. The spec's AC literals (`100.00`, `99999999.99`) work as written.
- Exactness with zero dependencies in the browser bundle. The bigint brand is the strongest available type-level guard (AC-VERIFY-14): mixing it with `number` fails at compile time *and* throws at runtime, and `JSON.stringify` refuses it, so values can only leave through `toMoneyString`.
- HALF_UP is identical to PostgreSQL `round(numeric, s)`, so any SQL-side computation (the generated GST column, export queries) agrees with the app to the cent. For GST 3/23 the mode is provably irrelevant (no ties). HALF_EVEN is **not offered**, so nobody can pick a mode that disagrees with SQL.
- The rate suggestion `ceil((court_cost + extra_expenses) / max_players)` is read as **whole dollars**: `ceil` yields an integer, and club rates are whole dollars ($16/$17 in the overview). The primitive takes the unit explicitly, so session-scheduling-engine can switch to cents without touching the money module.

**Trade-offs accepted**
- There are two representations (`MoneyString` for I/O, `Money` for arithmetic). Mitigation: conversion only in `money.ts` and repositories, the Kysely types force it (below), and the zod schemas at the API edge do it automatically.
- `bigint` can't be passed as a React Server Component prop. Mitigation: the rule is "`MoneyString` across every serialisation boundary", which the type checker enforces through the zod contracts.

### Q7: **Chosen: 7A** (hand-rolled `Intl` offset probe in `@sgm/shared/time`) + **P-a** (explicit disambiguation per call: `reject` for user input, `compatible` for derived times) + **absolute 48 h** deadline default + **S3** (DB-trigger-maintained `starts_at/ends_at`, with a plpgsql mirror of the same algorithm).

**Rationale**
- **7A over 7B**: the module needs about 6 zone operations. 7A adds 0 kB to the browser. It is verified against the exact 2026–2028 transitions, and it ports line for line to plpgsql, which S3 needs anyway. Parity is tested by construction, not assumed from two different libraries. The API uses Temporal's disambiguation vocabulary, so replacing the internals with native Temporal later is a private change.
- **P-a**: a person typing a time that doesn't exist, or that happens twice, should be asked, not silently corrected. Recurrence materialisation and derived instants must never fail twice a year. `compatible` is the cross-industry convention (RFC 5545, Temporal, java.time): a gap shifts forward by its length, and an overlap takes the earlier (first) occurrence. The architecture's "no cron in 02:00–02:59" rule is the scheduler's version of the same concern.
- **Absolute 48 h**: it matches the spec's wording and the AC-VERIFY-15 vector, gives players exactly the promised notice, and needs no disambiguation. The deadline is stored as an instant and always *displayed* as a local instant, so there's no ambiguity for the user. `sameWallClockDaysBefore` is still provided for features that want calendar semantics.
- **S3**: P1. A missed recompute path in the app (S2) would bill at the wrong time with no guard. With triggers, the DB is the only writer of the instants, so every code path, including raw SQL and future features, gets them right. The sweep uses a partial index.
- **Overriding PG's native overlap rule**: plain `(date + time) AT TIME ZONE 'Pacific/Auckland'` would give `2027-04-03T14:30Z` (later) for the ambiguous vector, while TS `compatible` gives `13:30Z`. `nz_local_to_utc` uses the probe algorithm and never relies on PG's implicit resolution.

**Trade-offs accepted**
- Wall-clock ↔ instant conversion now also exists in one SQL function, not only "in the time module and the UI" (the AC-VERIFY-15 wording). This is a justified refinement of P3: the conversion is still in exactly one algorithm with two ports, and the parity test fails if they diverge. The AC wording is updated below.
- Both implementations depend on host tzdata (browser/Node ICU and the PG server). NZ rules have been unchanged since 2007. The parity and vector tests run in CI against `postgres:17` and Node 24, so a tzdata divergence fails the build.
- Courts may not cross midnight, except that `end_time = '24:00'` means midnight. A deviation is recorded. A later feature can add `end_day_offset` if overnight sessions appear.

### Q9: **Chosen: 9A, assigned per payment.** A gapless per-team counter row, upserted by `assign_invoice_number(payment_id)` inside the caller's transaction. The function locks the payment row first, refuses a payment that already has a number, derives `team_id` from the payment (never from the caller), bumps the counter, sets the number and verifies that exactly one row was updated. Stored as `payments.invoice_number INTEGER`, with `UNIQUE(team_id, invoice_number)` and a set-once guard. Display `INV-000123`. *(Revised 2026-09-29: the original team-keyed `allocate_invoice_number(team_id)` let two issuers of the same payment each bump the counter, leaking a number; critique finding 3.)*

**Rationale**: it is the only option that is unique and gapless, transactional (C-7), declarative (a table the schema dump and conformance test can see), and needs no runtime DDL. `ON CONFLICT` handles the first-allocation race, which MERGE (9D) does not. The contention cost is irrelevant at our volume: one issuer per team at a time, holding the lock for milliseconds.

**Display format**: `INV-` + the number zero-padded to 6 digits (`INV-000123`), never truncated (`INV-1234567` after 999,999). There is no team prefix in v1. Each team is a separate supplier, identified on the invoice by its legally required name and GST number, and a team prefix would add a mutable input to an immutable document. tax-invoices-and-exports may add an optional, frozen-after-first-use `teams.invoice_prefix` additively.

**Trade-offs accepted**: allocations for the same team are serialised until commit. Mitigation: allocate as the **last** statement before COMMIT, set `SET LOCAL lock_timeout = '5s'` in issuing transactions, and never allocate for two teams in one transaction (lock-order deadlocks become impossible). Lock order inside the function is always payment row → team counter row, so two issuers can't deadlock each other. Numbers are gapless only among committed transactions. An issued invoice is never deleted (RESTRICT and immutability triggers), so there are no gaps from deletes either. Voiding and credit notes belong to tax-invoices-and-exports and must not reuse numbers.

### Q11: **Chosen: G1 + F2.** A `registration_guests` child table (position 1..2, sex, skill), with a deferred equality check against `registrations.guest_count`. A `payments` header carrying `team_id` and a GST snapshot, with GST and subtotal as **STORED generated columns**. `payment_line_items` holds one immutable row per party (position 0 = registrant) with the applied basis, attribute snapshot and unit fee. Idempotency keys: `UNIQUE(payments.registration_id)`, `UNIQUE(payment_line_items.payment_id, party_position)`, and a partial unique index on `credit_transactions(registration_id) WHERE transaction_type = 'AUTO_DEDUCTION'`, plus the guarded session transition.

**Ownership chain (revised 2026-09-29, critique finding 1)**: PostgreSQL enforces that a payment's `user_id`/`team_id` equal its registration's user and its session's team. `game_sessions UNIQUE (id, team_id)`; `registrations.team_id NOT NULL` with composite FK `(session_id, team_id) → game_sessions(id, team_id)`; `registrations UNIQUE (id, user_id, team_id)`; `payments` and `credit_transactions` each carry composite FK `(registration_id, user_id, team_id) → registrations(id, user_id, team_id)`, `MATCH SIMPLE`, `ON DELETE RESTRICT`. `payments.registration_id` stays nullable, because out-of-scope subscription payments have no registration and MATCH SIMPLE skips the check when it is NULL. `credit_transactions.registration_id` is NULL for top-ups. `credit_transactions (user_id, team_id) → player_credits(user_id, team_id)` ties every wallet movement to the wallet it changes. A mismatch fails with `23503`.

**Waitlist position safety (revised 2026-09-29, critique finding 2)**: `CREATE UNIQUE INDEX uq_registrations_waitlist_position ON registrations (session_id, queue_position) WHERE status = 'WAITLISTED'`, alongside the existing CHECK that `queue_position IS NOT NULL` iff `status = 'WAITLISTED'`. Foundation ships the index and the documented contract. The allocator belongs to registration-and-waitlist, which **must** follow this locking strategy: every enqueue, withdraw and promote first runs `SELECT … FROM game_sessions WHERE id = $1 FOR UPDATE`; enqueue then assigns `coalesce(max(queue_position), 0) + 1` over the session's WAITLISTED rows under that lock; promotion takes the lowest `queue_position`. A code path that skips the lock gets `23505` instead of a silent FIFO violation.

**BY_SEX and sex `OTHER` (spec-owner decision 2026-09-29, critique finding 4)**: `fee_other NUMERIC(10,2)` is added to `game_sessions` and `recurring_session_rules`, and `SEX_OTHER` to `fee_basis`. When `pricing_structure = 'BY_SEX'`, `fee_male`, `fee_female` and `fee_other` must all be non-null (CHECK on both tables). The line-item CHECK maps sex `OTHER` → `SEX_OTHER`. The default value is `LEAST(fee_male, fee_female)`, applied by session-scheduling-engine's UI/service when an admin picks BY_SEX (a constraint handed to that feature), and admin-editable. The DB does not compute the default, so an explicit admin value is never overwritten.

**Rationale**
- The workflows doc bills per confirmed registration including guests. One line per party is the natural shape for FLAT, BY_SEX and BY_SKILL_LEVEL, prints directly on a tax invoice, and supports reports such as "revenue by skill tier" with a plain `GROUP BY`.
- Idempotency comes from the schema, not the job runner (C-8): a replayed `bill-session` hits the guarded `PUBLISHED → COMPLETED` transition first. Even without that, `INSERT … ON CONFLICT (registration_id) DO NOTHING` returns no row and the handler skips the wallet deduction.
- GST as a generated column (`round(amount * gst_rate_bps / (10000 + gst_rate_bps), 2)`, which is 3/23 at 1500 bps) makes a wrong GST amount on a tax record **impossible** (P1). It uses PG `round(numeric)` = HALF_UP, so it agrees with `money.multiplyByRatio(total, 3n, 23n, 'HALF_UP')`. `subtotal = amount − gst`, so `subtotal + gst = amount` holds exactly. GST is computed **once per payment** on the GST-inclusive total, not per line, so a sum of rounded lines can never disagree with the rounded total. IRD's $200–$1,000 band accepts "GST-inclusive amount + standard-rate statement" or all three figures, and both are available.
- `gst_rate_bps` is snapshotted per payment, so a future rate change can't alter historic records.
- G1 over G2: guests get stable IDs that line items reference with RESTRICT (7-year retention covers the guest attributes that justified a fee), and the limit of 2 is a single CHECK.

**Trade-offs accepted**
- Two deferred constraint triggers (guest count, and line sum = amount) report at **COMMIT**, not at the statement. Tests that use rollback isolation must run `SET CONSTRAINTS ALL IMMEDIATE` (see Testing Strategy). Errors are raised with SQLSTATE `23514` and a named constraint, so callers see a normal check violation.
- `guest_count` is denormalised to keep draft conformance. The deferred check makes drift impossible to commit.
- ~~Open product question: BY_SEX + sex `OTHER`~~ **Resolved 2026-09-29** by the spec owner: `fee_other` column + `SEX_OTHER` basis, default `LEAST(fee_male, fee_female)` (see above). Recorded as a schema deviation from `database-design.md`.
- `registrations.team_id` duplicates `game_sessions.team_id` so the composite FKs can reference it. The composite FK makes drift impossible, and the app sets it from the session on insert.

---

## Implementation Details

### Q6: Money module (`packages/shared/src/money/money.ts`)

```ts
declare const moneyBrand: unique symbol;
declare const moneyStringBrand: unique symbol;

/** Integer cents, NZD. Only created by this module. */
export type Money = bigint & { readonly [moneyBrand]: 'NZD_CENTS' };
/** Canonical DB/wire form: /^-?(0|[1-9]\d{0,7})\.\d{2}$/  e.g. '17.50', '-0.05', '0.00'. */
export type MoneyString = string & { readonly [moneyStringBrand]: 'NZD_2DP' };

export type RoundingMode = 'HALF_UP' | 'CEIL' | 'FLOOR';   // HALF_UP = half away from zero (== PG round(numeric))
export type RoundingUnit = 'CENT' | 'DOLLAR';

export const MONEY_MAX: Money;          // 9_999_999_999n  (99,999,999.99 = DECIMAL(10,2) max)
export const MONEY_MIN: Money;          // -9_999_999_999n
export const ZERO: Money;

export type MoneyErrorCode =
  | 'NOT_A_STRING'        // number (incl. NaN, Infinity, 17.5), null, object…
  | 'INVALID_FORMAT'      // 'abc', '1e3', ' 1.00', '+1', '.50', '01.00', '1,000.00'
  | 'TOO_MANY_DECIMALS'   // '17.505'
  | 'OUT_OF_RANGE'        // beyond ±99,999,999.99, incl. after arithmetic
  | 'DIVISION_BY_ZERO'
  | 'INVALID_RATIO';      // denominator <= 0n
export class MoneyValidationError extends Error {
  readonly name = 'MoneyValidationError';
  constructor(readonly code: MoneyErrorCode, message: string);
}

// Construction / conversion
export function parseMoney(input: unknown): Money;            // accepts 0–2 dp strings; '17.5' → 1750n; '-0.00' → 0n
export function isMoneyString(input: unknown): input is MoneyString;
export function moneyFromCents(cents: bigint): Money;         // range-checked
export function toCents(m: Money): bigint;
export function toMoneyString(m: Money): MoneyString;         // always 2 dp
export function formatNZD(m: Money): string;                  // '$17.50', '-$5.00', '$1,234.56' (manual, locale-independent)

// Arithmetic (all results range-checked → OUT_OF_RANGE)
export function add(a: Money, b: Money): Money;
export function subtract(a: Money, b: Money): Money;
export function negate(a: Money): Money;
export function sum(items: readonly Money[]): Money;           // [] → ZERO
export function multiplyByInteger(m: Money, n: bigint): Money;
export function multiplyByRatio(m: Money, numerator: bigint, denominator: bigint, mode: RoundingMode): Money; // mode REQUIRED
export function divideByInteger(m: Money, divisor: bigint, mode: RoundingMode, unit: RoundingUnit): Money;   // mode+unit REQUIRED

// Comparison
export function compare(a: Money, b: Money): -1 | 0 | 1;
export function eq(a: Money, b: Money): boolean;   // plus lt, lte, gt, gte, isZero, isNegative, min, max

// zod (packages/shared/src/money/zod.ts): wire contracts use strings, never JSON numbers
export const moneyStringSchema: z.ZodType<MoneyString>;       // strict 2-dp on responses
export const moneyInputSchema: z.ZodType<Money>;              // 0–2 dp string → Money on requests (parseMoney)
```

**Kysely / codegen typing (C-2, refines the architecture's wording)**: every `numeric` column is generated as `ColumnType<MoneyString, MoneyString, MoneyString>`, and the generated GST/subtotal columns as `GeneratedAlways<MoneyString>`. The branded *string* is the DB type and the branded *bigint* is the arithmetic type. Repositories convert with `parseMoney(row.amount)` and `toMoneyString(m)`. A JS `number` or a plain `string` can't be inserted without the helper. The conformance test asserts that **every `numeric` column in `public` is `numeric(10,2)`** and that **no `real`/`double precision` column exists**, so "all numerics are money" is enforced. A future non-money numeric must be added to an explicit allowlist and codegen override. Aggregates: `SUM(numeric(10,2))` returns 2 dp and parses fine. `AVG` must be wrapped in `round(…, 2)` in SQL, otherwise `parseMoney` throws `TOO_MANY_DECIMALS` (loud by design).

**Lint guard (AC-VERIFY-14, in addition to the type brand)**: `eslint.config.mjs` `no-restricted-syntax` / `no-restricted-properties` for `packages/shared/src/money/**`, `apps/api/src/modules/**` and `apps/web/src/**`: ban `parseFloat`, `Number.parseFloat`, `.toFixed(`, `Math.round|ceil|floor` applied to identifiers matching `/(amount|fee|price|total|balance|gst|subtotal|cost|rate)/i`, and `Number(` on the same pattern. `@typescript-eslint/no-unsafe-*` (type-checked config) stops `any` from laundering a number into a `Money`.

**Wire format**: request and response money fields are JSON strings with exactly 2 dp (`"amount": "17.50"`) and never JSON numbers. Requests may send 0–2 dp (`"17.5"`); responses always send 2. OpenAPI: `type: string, pattern: '^-?(0|[1-9]\d{0,7})\.\d{2}$', example: '17.50'`.

**Rounding rules with worked examples** (verified by prototype):

| Operation | Input | Exact | Result | Notes |
|---|---|---|---|---|
| GST (inclusive) `multiplyByRatio(t, 3n, 23n, 'HALF_UP')` | $17.00 (1700¢) | 221.739…¢ | **$2.22**; subtotal **$14.78** | BY_SEX male fee from the overview |
| GST | $16.00 | 208.695…¢ | **$2.09**; subtotal **$13.91** | female fee |
| GST | $115.00 | 1500¢ | **$15.00**; subtotal $100.00 | exact |
| GST | $12.00 | 156.52…¢ | **$1.57**; subtotal $10.43 | |
| GST | $1.00 | 13.04¢ | **$0.13** | |
| GST | $0.01 | 0.13¢ | **$0.00** | |
| Rate suggestion `divideByInteger(add(court, extra), BigInt(maxPlayers), 'CEIL', 'DOLLAR')` | $120 court + $12 shuttles, 12 players → $132.00/12 | $11.00 | **$11.00** | the brief's vector |
| Rate suggestion | $130 + $12, 12 players → $142.00/12 | $11.833… | **$12.00** | |
| Rate suggestion | $120 + $0, 14 players | $8.571… | **$9.00** | |
| Rate suggestion | $120.01 + $12, 12 players | $11.0008… | **$12.00** | whole-dollar ceil is sensitive to 1¢ (intended: never under break-even) |
| HALF_UP tie, non-GST ratio | $0.05 × 1/2 | 2.5¢ | **$0.03** | half away from zero |
| HALF_UP negative tie | −$0.05 × 1/2 | −2.5¢ | **−$0.03** | matches PG `round(-0.025, 2) = -0.03` |
| `0.10 + 0.10 + 0.10` | — | — | **`'0.30'`** exactly | AC-VERIFY-14 |
| Parse/format | `'17.50'` | — | `formatNZD` → **`$17.50`** | AC-VERIFY-14 |
| Parse | `'17.505'` / `'abc'` / `NaN` / `Infinity` / `17.5` | — | `TOO_MANY_DECIMALS` / `INVALID_FORMAT` / `NOT_A_STRING` ×3 | AC-ERROR-5 |

GST lives in the DB as a generated column (Q11) and, when needed in TS (previews), as a call to `multiplyByRatio`. The formula owner remains team-banking-and-gst; foundation fixes only the primitive and the rounding rule.

### Q7: Time module (`packages/shared/src/time/time.ts`)

```ts
export const APP_TIME_ZONE = 'Pacific/Auckland' as const;   // constant, not configurable (architecture)

declare const localDateBrand: unique symbol;
declare const localTimeBrand: unique symbol;
export type LocalDate = string & { readonly [localDateBrand]: true };  // 'YYYY-MM-DD', calendar-valid
export type LocalTime = string & { readonly [localTimeBrand]: true };  // 'HH:MM' | 'HH:MM:SS'; '24:00' allowed only as an end-of-day marker

export type Disambiguation = 'compatible' | 'earlier' | 'later' | 'reject';   // Temporal vocabulary
export const DST_POLICY = { USER_INPUT: 'reject', DERIVED: 'compatible' } as const satisfies Record<string, Disambiguation>;

export type LocalResolution =
  | { kind: 'unique'; instant: Date }
  | { kind: 'nonexistent'; shiftedForward: Date; shiftedBackward: Date; gapMinutes: number }
  | { kind: 'ambiguous'; earlier: Date; later: Date };

export type TimeErrorCode = 'INVALID_LOCAL_DATE' | 'INVALID_LOCAL_TIME' | 'INVALID_TIME_ZONE'
  | 'INVALID_INSTANT' | 'NONEXISTENT_LOCAL_TIME' | 'AMBIGUOUS_LOCAL_TIME';
export class TimeValidationError extends Error { readonly name = 'TimeValidationError'; readonly code: TimeErrorCode }
export class NonexistentLocalTimeError extends TimeValidationError { readonly shiftedForward: Date; readonly shiftedBackward: Date }
export class AmbiguousLocalTimeError  extends TimeValidationError { readonly earlier: Date; readonly later: Date }

// Parsing / validation
export function parseLocalDate(input: unknown): LocalDate;         // rejects '2026-02-30', '2026-9-7'
export function parseLocalTime(input: unknown): LocalTime;         // rejects '25:00', '24:01', '7pm'
export function assertTimeZone(name: unknown): string;             // Intl RangeError → INVALID_TIME_ZONE (AC-ERROR-5)
export function parseIsoInstant(input: unknown): Date;             // requires 'Z' or ±HH:MM; NaN → INVALID_INSTANT
export function toIsoInstant(d: Date): string;                     // wire: '2027-04-03T07:00:00.000Z'

// Conversion (the only place wall-clock ↔ instant happens in TS)
export function resolveLocal(date: LocalDate, time: LocalTime, timeZone?: string): LocalResolution;
export function localToInstant(date: LocalDate, time: LocalTime, disambiguation: Disambiguation, timeZone?: string): Date; // disambiguation REQUIRED
export function instantToLocal(instant: Date, timeZone?: string): { date: LocalDate; time: LocalTime; utcOffsetMinutes: number };

// Arithmetic
export function addHours(instant: Date, hours: number): Date;                   // absolute (hours must be an integer)
export const CANCELLATION_DEADLINE_DEFAULT_HOURS = 48;
export function defaultCancellationDeadline(startsAt: Date): Date;              // startsAt − 48 h absolute
export function addLocalDays(date: LocalDate, days: number): LocalDate;        // calendar days (recurrence: weekly = +7)
export function sameWallClockDaysBefore(instant: Date, days: number, disambiguation: Disambiguation): Date;

// Display (NZ edge formatting; manual from fields, independent of ICU locale strings)
export function formatNzDate(x: Date | LocalDate): string;      // 'DD/MM/YYYY'
export function formatNzTime(instant: Date): string;            // 'h:mm am|pm'  e.g. '8:00 pm'
export function formatNzDateTime(instant: Date): string;        // '03/04/2027 8:00 pm'
```

**Core algorithm (7A)** as implemented and verified:
```
wallMs(ms)   = Date.UTC(fields of formatToParts(new Date(ms)) in timeZone, hourCycle 'h23')   // cached formatter per zone
offsetMs(ms) = wallMs(ms) − ms
resolve(date, time):
    L = Date.UTC(y, m−1, d, H, M, S)                   // wall clock read "as if UTC"; '24:00' rolls to next day
    oBefore = offsetMs(L − 24h); oAfter = offsetMs(L + 24h)
    cands = unique({L − oBefore, L − oAfter}) filtered by offsetMs(c) == L − c, sorted
    1 cand  → unique
    2 cands → ambiguous(earlier = cands[0], later = cands[1])
    0 cands → nonexistent(shiftedForward = L − oBefore, shiftedBackward = L − oAfter, gap = oAfter − oBefore)
localToInstant: unique → it; ambiguous → earlier|later|reject(Ambiguous); compatible = earlier
                nonexistent → compatible|later = shiftedForward; earlier = shiftedBackward; reject → NonexistentLocalTimeError
```
**Rule**: the module never calls local-zone `Date` getters or the multi-argument `new Date(y, m, d)` constructor. An ESLint `no-restricted-properties` rule in `packages/shared/src/time/**` bans `getHours/getDate/getDay/getMonth/getFullYear/getTimezoneOffset/setHours/…` and `Date.parse`, which makes host-TZ independence structural.

**Where each policy applies**

| Context | Policy | Owner |
|---|---|---|
| Admin enters or edits a session or court time, or a rule default time (API validation) | `DST_POLICY.USER_INPUT` = `reject`. The 422 body names the date and offers `shiftedForward`/`earlier`/`later` as options | session-scheduling-engine |
| Recurrence materialisation (`addLocalDays` then convert) | `DERIVED` = `compatible` | session-scheduling-engine |
| `game_sessions.starts_at/ends_at` (DB trigger) | `compatible`, via `nz_local_to_utc` | foundation (DB) |
| Default cancellation deadline | absolute `starts_at − 48 h` (no disambiguation needed) | foundation primitive; applied by session-scheduling-engine |
| Display of any stored instant | instant → local is always unique | UI |

**DST test-vector table** (AC-VERIFY-15; all verified. "c" = compatible. The last column is the display of the instant):

| # | Local input (Pacific/Auckland) | Classification | `compatible` | `earlier` | `later` | `reject` |
|---|---|---|---|---|---|---|
| 1 | 2026-07-01 19:00 (NZST) | unique | `2026-07-01T07:00:00Z` | same | same | same |
| 2 | 2026-10-07 19:00 (NZDT) | unique | `2026-10-07T06:00:00Z` | same | same | same |
| 3 | 2026-09-27 01:59 | unique (last NZST minute) | `2026-09-26T13:59:00Z` | same | same | same |
| 4 | 2026-09-27 02:00 | **nonexistent** (gap 60 min) | `2026-09-26T14:00:00Z` (03:00 NZDT) | `2026-09-26T13:00:00Z` | `2026-09-26T14:00:00Z` | `NonexistentLocalTimeError` |
| 5 | **2026-09-27 02:30** | **nonexistent** | **`2026-09-26T14:30:00Z`** (03:30 NZDT) | `2026-09-26T13:30:00Z` | `2026-09-26T14:30:00Z` | **`NonexistentLocalTimeError`** |
| 6 | 2026-09-27 02:59 | nonexistent | `2026-09-26T14:59:00Z` | `2026-09-26T13:59:00Z` | `2026-09-26T14:59:00Z` | error |
| 7 | 2026-09-27 03:00 | unique (first NZDT minute) | `2026-09-26T14:00:00Z` | same | same | same |
| 8 | 2026-09-27 04:00 | unique | `2026-09-26T15:00:00Z` (= AC-ASYNC-2 cron vector) | same | same | same |
| 9 | 2027-04-04 01:59 | unique | `2027-04-03T12:59:00Z` | same | same | same |
| 10 | 2027-04-04 02:00 | **ambiguous** | `2027-04-03T13:00:00Z` | `2027-04-03T13:00:00Z` | `2027-04-03T14:00:00Z` | `AmbiguousLocalTimeError` |
| 11 | **2027-04-04 02:30** | **ambiguous** | **`2027-04-03T13:30:00Z`** (NZDT) | `2027-04-03T13:30:00Z` | `2027-04-03T14:30:00Z` (NZST; **PG-native result**) | **`AmbiguousLocalTimeError`** |
| 12 | 2027-04-04 02:59 | ambiguous | `2027-04-03T13:59:00Z` | `2027-04-03T13:59:00Z` | `2027-04-03T14:59:00Z` | error |
| 13 | 2027-04-04 03:00 | unique | `2027-04-03T15:00:00Z` | same | same | same |
| 14 | 2027-04-04 04:00 | unique | `2027-04-03T16:00:00Z` (= AC-ASYNC-2 cron vector) | same | same | same |
| 15 | 2027-04-05 19:00 (NZST) | unique | `2027-04-05T07:00:00Z` | same | same | same |
| 16 | 48 h before #15 (absolute) | — | `2027-04-03T07:00:00Z` → displays **`03/04/2027 8:00 pm`** (NZDT) | | | |
| 17 | Same wall clock 2 days before #15 (`sameWallClockDaysBefore`, c) | unique | `2027-04-03T06:00:00Z` → `03/04/2027 7:00 pm` (differs from #16 by 1 h) | | | |
| 18 | 2027-09-26 02:30 | nonexistent | `2027-09-25T14:30:00Z` | `2027-09-25T13:30:00Z` | `2027-09-25T14:30:00Z` | error |
| 19 | 2028-04-02 02:30 | ambiguous | `2028-04-01T13:30:00Z` | `2028-04-01T13:30:00Z` | `2028-04-01T14:30:00Z` | error |
| 20 | 2026-12-31 23:30 / 2027-01-01 00:00 | unique (year rollover) | `2026-12-31T10:30:00Z` / `2026-12-31T11:00:00Z` | | | |
| 21 | 2026-07-01 `24:00` (end-of-day) | unique | `2026-07-01T12:00:00Z` (= 2026-07-02 00:00 NZST) | | | |
| 22 | instant `2026-09-26T14:00:00Z` → local | — | `27/09/2026 3:00 am`, offset +780 | | | |
| 23 | instant `2027-04-03T13:30:00Z` and `…14:30:00Z` → local | — | both `04/04/2027 2:30 am`; offsets +780 / +720 | | | |

The whole table runs twice (`TZ=UTC` and `TZ=America/New_York`), and the results must be identical. The same rows 1–15 and 18–21 (the `compatible` and `reject` columns) run against `nz_local_to_utc` in `postgres:17` as the parity test.

**Session instants DDL (migration 6, `_game_sessions_and_courts.sql`)**

```sql
-- Up Migration
-- Offset of Pacific/Auckland at an instant, independent of the session TimeZone GUC.
CREATE FUNCTION nz_utc_offset(ts timestamptz) RETURNS interval
  LANGUAGE sql STABLE STRICT PARALLEL SAFE
  AS $$ SELECT (ts AT TIME ZONE 'Pacific/Auckland') - (ts AT TIME ZONE 'UTC') $$;

-- Port of the TS offset-probe algorithm. Never relies on PG's implicit gap/overlap rule
-- (PG picks the LATER instant for overlaps; our 'compatible' picks the EARLIER one).
-- NB: uses '24 hours' (absolute), never '1 day' (timestamptz ± 'N days' is DST-aware in the session zone).
CREATE FUNCTION nz_local_to_utc(local_date date, local_time time, disambiguation text)
  RETURNS timestamptz LANGUAGE plpgsql STABLE STRICT PARALLEL SAFE AS $$
DECLARE
  l          timestamptz := (local_date + local_time) AT TIME ZONE 'UTC';  -- wall clock read as UTC ('24:00' → next day)
  off_before interval    := nz_utc_offset(l - interval '24 hours');
  off_after  interval    := nz_utc_offset(l + interval '24 hours');
  c_before   timestamptz := l - off_before;
  c_after    timestamptz := l - off_after;
  ok_before  boolean     := nz_utc_offset(c_before) = off_before;
  ok_after   boolean     := nz_utc_offset(c_after)  = off_after;
BEGIN
  IF disambiguation NOT IN ('compatible','earlier','later','reject') THEN
    RAISE EXCEPTION 'invalid disambiguation %', disambiguation USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF ok_before AND ok_after AND c_before <> c_after THEN            -- ambiguous (overlap)
    IF disambiguation = 'reject' THEN
      RAISE EXCEPTION 'ambiguous local time % % in Pacific/Auckland', local_date, local_time
        USING ERRCODE = 'invalid_datetime_format';
    END IF;
    RETURN CASE WHEN disambiguation = 'later' THEN greatest(c_before, c_after)
                ELSE least(c_before, c_after) END;               -- compatible | earlier
  ELSIF ok_before THEN RETURN c_before;
  ELSIF ok_after  THEN RETURN c_after;
  END IF;
  -- nonexistent (gap)
  IF disambiguation = 'reject' THEN
    RAISE EXCEPTION 'nonexistent local time % % in Pacific/Auckland', local_date, local_time
      USING ERRCODE = 'invalid_datetime_format';
  END IF;
  RETURN CASE WHEN disambiguation = 'earlier' THEN c_after ELSE c_before END;  -- compatible|later = shift forward
END $$;

ALTER TABLE game_sessions                      -- (shown as ALTER for readability; lives in the CREATE TABLE)
  ADD COLUMN starts_at timestamptz,            -- DB-maintained; app writes are overwritten
  ADD COLUMN ends_at   timestamptz,
  ADD CONSTRAINT game_sessions_instants_when_live
      CHECK (status IN ('DRAFT','CANCELLED') OR (starts_at IS NOT NULL AND ends_at IS NOT NULL)),
  ADD CONSTRAINT game_sessions_deadline_before_start
      CHECK (starts_at IS NULL OR cancellation_deadline <= starts_at),
  ADD CONSTRAINT game_sessions_max_players_positive CHECK (max_players > 0),
  ADD CONSTRAINT game_sessions_reserved_seats_range CHECK (reserved_seats BETWEEN 0 AND max_players),
  ADD COLUMN fee_other numeric(10,2),          -- BY_SEX rate for sex OTHER (deviation; default LEAST(fee_male, fee_female) set by session-scheduling-engine)
  ADD CONSTRAINT game_sessions_by_sex_fees_present
      CHECK (pricing_structure <> 'BY_SEX' OR (fee_male IS NOT NULL AND fee_female IS NOT NULL AND fee_other IS NOT NULL)),
  ADD CONSTRAINT uq_game_sessions_id_team UNIQUE (id, team_id);   -- target of registrations' composite FK (ownership chain)
-- status: the draft's `status session_status DEFAULT 'DRAFT'` gains NOT NULL (deviation).
-- team_id: gains NOT NULL (it is part of the ownership chain; deviation).

ALTER TABLE session_courts
  ADD CONSTRAINT session_courts_time_order
      CHECK (start_time < time '24:00' AND end_time > start_time);  -- no midnight crossing; '24:00' = midnight end

CREATE FUNCTION game_sessions_derive_instants() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT nz_local_to_utc(NEW.date, min(sc.start_time), 'compatible'),
         nz_local_to_utc(NEW.date, max(sc.end_time),   'compatible')
    INTO NEW.starts_at, NEW.ends_at
    FROM session_courts sc WHERE sc.session_id = NEW.id;    -- no courts → NULL, NULL (STRICT)
  RETURN NEW;
END $$;
CREATE TRIGGER game_sessions_derive_instants
  BEFORE INSERT OR UPDATE ON game_sessions
  FOR EACH ROW EXECUTE FUNCTION game_sessions_derive_instants();

CREATE FUNCTION session_courts_touch_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    UPDATE game_sessions SET ends_at = NULL WHERE id = OLD.session_id;  -- BEFORE trigger recomputes
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') AND (TG_OP = 'INSERT' OR NEW.session_id IS DISTINCT FROM OLD.session_id
                                       OR NEW.start_time <> OLD.start_time OR NEW.end_time <> OLD.end_time) THEN
    UPDATE game_sessions SET ends_at = NULL WHERE id = NEW.session_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER session_courts_touch_session
  AFTER INSERT OR UPDATE OR DELETE ON session_courts
  FOR EACH ROW EXECUTE FUNCTION session_courts_touch_session();

-- Billing sweep (T3): WHERE status = 'PUBLISHED' AND ends_at <= now()
CREATE INDEX idx_game_sessions_billing_due ON game_sessions (ends_at) WHERE status = 'PUBLISHED';
CREATE UNIQUE INDEX uq_game_sessions_rule_date ON game_sessions (recurring_rule_id, date)
  WHERE recurring_rule_id IS NOT NULL;   -- AC-VERIFY-12 (a plain UNIQUE also works: NULLs are distinct)

-- Down Migration
DROP INDEX IF EXISTS uq_game_sessions_rule_date; DROP INDEX IF EXISTS idx_game_sessions_billing_due;
DROP TRIGGER IF EXISTS session_courts_touch_session ON session_courts;
DROP FUNCTION IF EXISTS session_courts_touch_session();
DROP TRIGGER IF EXISTS game_sessions_derive_instants ON game_sessions;
DROP FUNCTION IF EXISTS game_sessions_derive_instants();
-- (table drops follow in the real file)
DROP FUNCTION IF EXISTS nz_local_to_utc(date, time, text); DROP FUNCTION IF EXISTS nz_utc_offset(timestamptz);
```
Notes:
- The same time-order CHECK applies to `recurring_session_rules (default_start_time, default_end_time)`.
- `recurring_session_rules` (migration 5) gets the same `fee_other numeric(10,2)` column and the same `…_by_sex_fees_present` CHECK, so a materialised session always inherits a complete BY_SEX fee set.
- Kysely types `starts_at`/`ends_at` as `ColumnType<Date | null, never, never>`, so an insert or update from TS won't compile.
- Deleting a session cascades its courts, and the court trigger's UPDATE then matches 0 rows, which is harmless.
- Ordering rule for callers: insert courts *before* moving a session out of `DRAFT`.

### Q9: Invoice allocator (migration 9, `_payments_and_invoicing.sql`)

```sql
-- Up Migration
CREATE TABLE team_invoice_counters (
  team_id     uuid PRIMARY KEY REFERENCES teams(id) ON DELETE RESTRICT,
  last_number integer NOT NULL CHECK (last_number >= 1),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Call ONLY inside the transaction that issues the invoice; gapless because the counter bump
-- rolls back with it. Keyed by PAYMENT: team_id is derived here, never passed by the caller.
-- Lock order is always payment row → team counter row (no deadlock between issuers).
CREATE FUNCTION assign_invoice_number(p_payment_id uuid) RETURNS integer
  LANGUAGE plpgsql VOLATILE STRICT AS $$
DECLARE v_team uuid; v_existing integer; v_n integer; v_rows integer;
BEGIN
  SELECT team_id, invoice_number INTO v_team, v_existing
    FROM payments WHERE id = p_payment_id
     FOR UPDATE;                                     -- serialises issuers of the same payment
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment % not found', p_payment_id USING ERRCODE = 'no_data_found';          -- P0002
  END IF;
  IF v_existing IS NOT NULL THEN                     -- the losing racer lands here after the winner commits
    RAISE EXCEPTION 'payment % already has invoice number %', p_payment_id, v_existing
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'payments_invoice_number_set_once';  -- 23000
  END IF;
  INSERT INTO team_invoice_counters AS c (team_id, last_number) VALUES (v_team, 1)
  ON CONFLICT (team_id) DO UPDATE SET last_number = c.last_number + 1, updated_at = now()
  RETURNING c.last_number INTO v_n;                  -- row lock on the team counter until COMMIT/ROLLBACK
  UPDATE payments
     SET invoice_number = v_n, invoice_issued_at = now(), is_tax_invoice_issued = true
   WHERE id = p_payment_id AND invoice_number IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN                                -- defensive: raising aborts the txn, so the counter bump rolls back
    RAISE EXCEPTION 'payment %: expected 1 row updated, got %', p_payment_id, v_rows
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'payments_invoice_number_set_once';
  END IF;
  RETURN v_n;
END $$;                                              -- NULL payment id → NULL (STRICT); caller treats as a bug

-- On payments (full DDL in Q11):
--   invoice_number integer, invoice_issued_at timestamptz,
--   CONSTRAINT payments_invoice_number_positive CHECK (invoice_number IS NULL OR invoice_number >= 1),
--   CONSTRAINT payments_invoice_issued_consistent CHECK (is_tax_invoice_issued = (invoice_number IS NOT NULL)
--                                                        AND (invoice_number IS NULL) = (invoice_issued_at IS NULL)),
--   CONSTRAINT uq_payments_team_invoice_number UNIQUE (team_id, invoice_number)   -- NULLs distinct: many un-invoiced rows OK

-- Down Migration
DROP FUNCTION IF EXISTS assign_invoice_number(uuid);
DROP TABLE IF EXISTS team_invoice_counters;
```

**Caller pattern (Kysely, inside the caller's transaction; C-7)**:
```ts
await db.transaction().execute(async (trx) => {
  // ... all other work first ...
  await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
  // One statement: locks the payment, derives its team, bumps the counter and sets the number.
  // Throws (23000, payments_invoice_number_set_once) if the payment is already invoiced.
  const { rows: [row] } = await sql<{ n: number }>`SELECT assign_invoice_number(${paymentId}) AS n`.execute(trx); // INT4 → number
  return row!.n;
});   // COMMIT releases the payment and counter row locks; any error rolls the counter back
```
**Display**: `formatInvoiceNumber(n: number): string` in `@sgm/shared` → `'INV-' + String(n).padStart(6, '0')`. It requires a positive integer.

### Q11: Guests, payments, line items (migrations 7, 8 and 9)

New enum (in migration 1, with the others; mirrored in `enums.ts` in this order, C-10):
```sql
CREATE TYPE fee_basis AS ENUM ('FLAT','SEX_MALE','SEX_FEMALE','SEX_OTHER','SKILL_BEGINNER','SKILL_INTERMEDIATE','SKILL_ADVANCED');
```

**Migration 7, `_registrations_and_guests.sql`**
```sql
CREATE TABLE registrations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid NOT NULL,                                                    -- was CASCADE (retention; payments hang off it)
  team_id        uuid NOT NULL,                                                    -- new: = the session's team (ownership chain)
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  guest_count    integer NOT NULL DEFAULT 0
                 CONSTRAINT registrations_guest_count_range CHECK (guest_count BETWEEN 0 AND 2),  -- AC-VERIFY-7 (-1, 3 → 23514)
  status         registration_status NOT NULL,
  queue_position integer CHECK (queue_position IS NULL OR queue_position >= 1),
  registered_at  timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_registrations_session_user UNIQUE (session_id, user_id),             -- AC-VERIFY-7
  CONSTRAINT uq_registrations_id_user_team UNIQUE (id, user_id, team_id),           -- target of payments/credit_transactions composite FKs
  CONSTRAINT fk_registrations_session_team FOREIGN KEY (session_id, team_id)
      REFERENCES game_sessions (id, team_id) ON DELETE RESTRICT,                     -- registration team = session team (23503)
  CONSTRAINT registrations_queue_position_iff_waitlisted
      CHECK ((status = 'WAITLISTED') = (queue_position IS NOT NULL))
);

-- FIFO safety (critique finding 2). The allocator is registration-and-waitlist's and MUST, for every
-- enqueue / withdraw / promote: SELECT … FROM game_sessions WHERE id = $1 FOR UPDATE; then
-- enqueue = coalesce(max(queue_position), 0) + 1 over WAITLISTED rows; promote = lowest queue_position.
-- This index turns any path that skips the lock into a 23505 instead of a duplicate position.
CREATE UNIQUE INDEX uq_registrations_waitlist_position
  ON registrations (session_id, queue_position) WHERE status = 'WAITLISTED';

CREATE TABLE registration_guests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id uuid NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,  -- blocked anyway once billed (line-item RESTRICT)
  position        smallint NOT NULL CONSTRAINT registration_guests_position_range CHECK (position BETWEEN 1 AND 2),
  sex             user_sex   NOT NULL,
  skill_level     skill_tier NOT NULL,
  display_name    varchar(100),                                                   -- optional; minimal PII
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_registration_guests_position UNIQUE (registration_id, position)
);

-- guest_count = number of guest rows, positions contiguous (1 or 1,2). Checked at COMMIT.
CREATE FUNCTION check_registration_guest_count() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r_id uuid; expected integer; actual integer; max_pos integer;
BEGIN
  -- IF branches, not one CASE: plpgsql resolves every NEW/OLD field in an expression, and
  -- registrations has no registration_id column.
  IF TG_TABLE_NAME = 'registrations' THEN r_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN r_id := OLD.registration_id;
  ELSE r_id := NEW.registration_id;
  END IF;
  SELECT guest_count INTO expected FROM registrations WHERE id = r_id;
  IF NOT FOUND THEN RETURN NULL; END IF;                       -- registration deleted in same txn
  SELECT count(*), coalesce(max(position), 0) INTO actual, max_pos
    FROM registration_guests WHERE registration_id = r_id;
  IF actual <> expected OR max_pos <> expected THEN
    RAISE EXCEPTION 'registration %: guest_count % but % guest row(s) (max position %)', r_id, expected, actual, max_pos
      USING ERRCODE = 'check_violation', CONSTRAINT = 'registration_guest_count_matches';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER registration_guest_count_matches_r
  AFTER INSERT OR UPDATE OF guest_count ON registrations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_registration_guest_count();
CREATE CONSTRAINT TRIGGER registration_guest_count_matches_g
  AFTER INSERT OR UPDATE OR DELETE ON registration_guests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_registration_guest_count();
-- registration_guests.registration_id is immutable (BEFORE UPDATE trigger raises if changed), so a guest can't be moved.
```

**Migration 8, `_wallet.sql`** (money-relevant parts only)
```sql
-- player_credits.balance numeric(10,2) NOT NULL DEFAULT 0.00
--   CONSTRAINT player_credits_balance_range CHECK (balance BETWEEN 0.00 AND 100.00)   -- AC-VERIFY-10
-- user_id / team_id: NOT NULL REFERENCES … ON DELETE RESTRICT                          -- AC-VERIFY-11
-- credit_transactions: user_id, team_id NOT NULL … ON DELETE RESTRICT;
--   registration_id … ON DELETE RESTRICT (was SET NULL: a deduction must keep its link);
--   CHECK (amount <> 0.00); resulting_balance CHECK (resulting_balance BETWEEN 0.00 AND 100.00)
-- Ownership chain (critique finding 1):
--   CONSTRAINT fk_credit_tx_registration_owner FOREIGN KEY (registration_id, user_id, team_id)
--     REFERENCES registrations (id, user_id, team_id) MATCH SIMPLE ON DELETE RESTRICT,  -- replaces the single-column FK; NULL registration (top-up) skips it
--   CONSTRAINT fk_credit_tx_wallet FOREIGN KEY (user_id, team_id)
--     REFERENCES player_credits (user_id, team_id) ON DELETE RESTRICT                   -- every movement belongs to an existing wallet
--   (wallet-and-akahu-billing must create the player_credits row, balance 0.00, before the first transaction)
CREATE UNIQUE INDEX uq_credit_tx_auto_deduction_per_registration
  ON credit_transactions (registration_id) WHERE transaction_type = 'AUTO_DEDUCTION';  -- idempotent wallet deduction
```

**Migration 9, `_payments_and_invoicing.sql`**
```sql
CREATE TABLE payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id)         ON DELETE RESTRICT,   -- was CASCADE
  team_id               uuid NOT NULL REFERENCES teams(id)         ON DELETE RESTRICT,   -- gap fix (AC-VERIFY-8)
  registration_id       uuid,                                                            -- was SET NULL; NULL only for subscriptions (out of scope); FK below
  billing_type          billing_type   NOT NULL DEFAULT 'PER_GAME',
  -- fee snapshot (header)
  pricing_structure     pricing_type   NOT NULL,
  gst_registered        boolean        NOT NULL,
  gst_rate_bps          smallint       NOT NULL CHECK (gst_rate_bps BETWEEN 0 AND 10000),   -- 1500 = 15%
  amount                numeric(10,2)  NOT NULL CHECK (amount >= 0.00),                     -- GST-inclusive total
  gst_amount            numeric(10,2)  GENERATED ALWAYS AS
                          (round(amount * gst_rate_bps / (10000 + gst_rate_bps), 2)) STORED,  -- 3/23 at 1500 bps; HALF_UP
  subtotal_amount       numeric(10,2)  GENERATED ALWAYS AS
                          (amount - round(amount * gst_rate_bps / (10000 + gst_rate_bps), 2)) STORED,
  -- lifecycle
  status                payment_status NOT NULL DEFAULT 'PENDING',
  payment_link_token    varchar(255)   UNIQUE NOT NULL,
  akahu_payment_id      varchar(255),
  due_date              timestamptz    NOT NULL,
  paid_at               timestamptz,
  is_tax_invoice_issued boolean        NOT NULL DEFAULT FALSE,
  invoice_number        integer,
  invoice_issued_at     timestamptz,
  created_at            timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT payments_gst_rate_iff_registered CHECK (gst_registered = (gst_rate_bps > 0)),
  CONSTRAINT payments_paid_at_iff_paid        CHECK ((status = 'PAID') = (paid_at IS NOT NULL)),
  CONSTRAINT payments_invoice_number_positive CHECK (invoice_number IS NULL OR invoice_number >= 1),
  CONSTRAINT payments_invoice_issued_consistent
      CHECK (is_tax_invoice_issued = (invoice_number IS NOT NULL)
             AND (invoice_number IS NULL) = (invoice_issued_at IS NULL)),
  CONSTRAINT uq_payments_team_invoice_number  UNIQUE (team_id, invoice_number),          -- AC-VERIFY-9
  CONSTRAINT uq_payments_registration         UNIQUE (registration_id),                  -- idempotent billing key (C-8)
  CONSTRAINT fk_payments_registration_owner   FOREIGN KEY (registration_id, user_id, team_id)
      REFERENCES registrations (id, user_id, team_id) MATCH SIMPLE ON DELETE RESTRICT    -- payer = registrant, team = session team (23503);
                                                                                        -- NULL registration (subscription) skips the check
);
CREATE INDEX idx_payments_team_paid_status ON payments (team_id, paid_at, status);        -- AC-VERIFY-8
-- draft indexes idx_payments_user_status, idx_payments_paid_at_status kept

CREATE TABLE payment_line_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id            uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  party_position        smallint NOT NULL CHECK (party_position BETWEEN 0 AND 2),         -- 0 = registrant
  registration_guest_id uuid REFERENCES registration_guests(id) ON DELETE RESTRICT,
  pricing_structure     pricing_type NOT NULL,                                            -- = header (checked in deferred trigger)
  applied_basis         fee_basis    NOT NULL,
  party_sex             user_sex     NOT NULL,                                            -- snapshot at charge time
  party_skill_level     skill_tier   NOT NULL,                                            -- snapshot (team_members.skill_level for registrant)
  unit_fee              numeric(10,2) NOT NULL CHECK (unit_fee >= 0.00),                  -- GST-inclusive
  created_at            timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT uq_payment_line_items_party UNIQUE (payment_id, party_position),
  CONSTRAINT payment_line_items_guest_link CHECK ((party_position = 0) = (registration_guest_id IS NULL)),
  CONSTRAINT payment_line_items_basis_matches CHECK (
       (pricing_structure = 'FLAT'           AND applied_basis = 'FLAT')
    OR (pricing_structure = 'BY_SEX'         AND ((party_sex = 'MALE'   AND applied_basis = 'SEX_MALE')
                                               OR (party_sex = 'FEMALE' AND applied_basis = 'SEX_FEMALE')
                                               OR (party_sex = 'OTHER'  AND applied_basis = 'SEX_OTHER')))  -- unit_fee = session fee_other
    OR (pricing_structure = 'BY_SKILL_LEVEL' AND ((party_skill_level = 'BEGINNER'     AND applied_basis = 'SKILL_BEGINNER')
                                               OR (party_skill_level = 'INTERMEDIATE' AND applied_basis = 'SKILL_INTERMEDIATE')
                                               OR (party_skill_level = 'ADVANCED'     AND applied_basis = 'SKILL_ADVANCED'))))
);
CREATE INDEX idx_payment_line_items_payment ON payment_line_items (payment_id);

-- amount = Σ unit_fee; header/line structure agree; guest lines belong to the payment's registration at the same position.
CREATE FUNCTION check_payment_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payments%ROWTYPE; line_sum numeric; n_lines integer; bad integer; p_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN p_id := NEW.id; ELSE p_id := NEW.payment_id; END IF;
  SELECT * INTO p FROM payments WHERE id = p_id;
  IF NOT FOUND OR p.registration_id IS NULL THEN RETURN NULL; END IF;       -- subscription rows: no lines
  SELECT coalesce(sum(unit_fee), 0), count(*) INTO line_sum, n_lines FROM payment_line_items WHERE payment_id = p_id;
  SELECT count(*) INTO bad FROM payment_line_items li
    LEFT JOIN registration_guests g ON g.id = li.registration_guest_id
   WHERE li.payment_id = p_id
     AND (li.pricing_structure <> p.pricing_structure
          OR (li.party_position > 0 AND (g.registration_id <> p.registration_id OR g.position <> li.party_position)));
  IF n_lines = 0 OR line_sum <> p.amount OR bad > 0
     OR NOT EXISTS (SELECT 1 FROM payment_line_items WHERE payment_id = p_id AND party_position = 0) THEN
    RAISE EXCEPTION 'payment %: amount % vs % line(s) summing % (% inconsistent)', p_id, p.amount, n_lines, line_sum, bad
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_lines_match_header';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payment_lines_match_header_p AFTER INSERT ON payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_payment_lines();
CREATE CONSTRAINT TRIGGER payment_lines_match_header_l AFTER INSERT ON payment_line_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_payment_lines();

-- Immutability (P1, 7-year records): snapshot columns never change; invoice number is set-once; lines are append-only.
CREATE FUNCTION payments_guard_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.user_id, NEW.team_id, NEW.registration_id, NEW.pricing_structure, NEW.gst_registered,
      NEW.gst_rate_bps, NEW.amount, NEW.created_at)
     IS DISTINCT FROM
     (OLD.user_id, OLD.team_id, OLD.registration_id, OLD.pricing_structure, OLD.gst_registered,
      OLD.gst_rate_bps, OLD.amount, OLD.created_at)
     OR (OLD.invoice_number IS NOT NULL AND
         (NEW.invoice_number, NEW.invoice_issued_at) IS DISTINCT FROM (OLD.invoice_number, OLD.invoice_issued_at)) THEN
    RAISE EXCEPTION 'payment % fee snapshot / invoice number is immutable', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_guard_immutable BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_guard_immutable();

CREATE FUNCTION reject_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER payment_line_items_append_only BEFORE UPDATE OR DELETE ON payment_line_items
  FOR EACH ROW EXECUTE FUNCTION reject_modification();
```

**Idempotent `bill-session` handler shape** (owned by wallet-and-akahu-billing; fixed here so the keys fit):
```
tx (one per session):
  s = UPDATE game_sessions SET status='COMPLETED'
        WHERE id=$1 AND status='PUBLISHED' AND ends_at <= now() RETURNING *      -- guard 1: replay → 0 rows → return
  for r in CONFIRMED registrations of s ORDER BY id:                             -- stable lock order
      lines  = price(r, guests(r), s)      -- per party: basis from s.pricing_structure + party sex/skill; unit_fee from s.fee_*
      total  = money.sum(lines.unit_fee)
      wallet = SELECT … FROM player_credits WHERE user_id=r.user_id AND team_id=s.team_id FOR UPDATE
      mode   = wallet.balance >= total ? PREPAID_CREDIT/PAID : PER_GAME/PENDING
      p = INSERT INTO payments(user_id=r.user_id, team_id=r.team_id, …)
            ON CONFLICT (registration_id) DO NOTHING RETURNING id                    -- guard 2; ownership FK rejects any other user/team
      if p is null: continue
      INSERT payment_line_items (…)                                              -- guard 3: UNIQUE(payment_id, party_position)
      if PREPAID_CREDIT: UPDATE player_credits …; INSERT credit_transactions(AUTO_DEDUCTION)  -- guard 4: partial unique
      else: jobs.enqueue('create-payment-link', {paymentId}, {trx, singletonKey:'payment-link:'+p})  -- external call outside txn
commit   -- deferred checks run here
```

### Data Structures
| Structure | Purpose | Operations Used |
|-----------|---------|-----------------|
| `bigint` cents (branded) | exact money arithmetic | + − × and ÷ with explicit rounding, all O(1) |
| Cached `Intl.DateTimeFormat` per zone (`Map<string, DateTimeFormat>`) | wall-clock read of an instant | `formatToParts` O(1) |
| `team_invoice_counters` (PK B-tree) | per-team gapless counter | upsert O(log T), row lock |
| Partial B-tree `game_sessions(ends_at) WHERE status='PUBLISHED'` | billing sweep | range scan O(log S + k) |
| `UNIQUE(registration_id)`, `UNIQUE(payment_id, party_position)`, partial unique on credit tx | idempotency | index probe O(log P) |
| Composite FKs `(registration_id, user_id, team_id)` and `(session_id, team_id)` | ownership chain | index probe O(log R) per insert |
| Partial unique `registrations(session_id, queue_position) WHERE status='WAITLISTED'` | FIFO position safety | index probe O(log W) |
| Deferred constraint triggers | cross-row invariants at COMMIT | O(g) and O(p), both ≤ 3 |

### Algorithm Steps (build order)
1. `money.ts` + tests (pure; Phase 4).
2. `time.ts` + vector tests under two host TZs (pure; Phase 4).
3. Migration 1 adds `fee_basis`. Migrations 6, 7, 8, 9 as above (Phase 3). `enums.ts` gets `FeeBasis`.
4. kysely-codegen overrides: numeric → `MoneyString`; `date` → `LocalDate`; `time` → `LocalTime`; `starts_at/ends_at` → read-only.
5. Integration tests: SQL parity with the vector table, the allocator concurrency test, guest and line-item constraints, immutability.

### Edge Case Handling
| Edge Case | Handling |
|-----------|----------|
| `'17.505'`, `'abc'`, NaN, Infinity, number input | `MoneyValidationError` (`TOO_MANY_DECIMALS` / `INVALID_FORMAT` / `NOT_A_STRING`) |
| Arithmetic overflow beyond DECIMAL(10,2) | `OUT_OF_RANGE` in TS; `22003` numeric overflow in PG |
| Divide by 0 players | `DIVISION_BY_ZERO` in TS; `max_players > 0` CHECK in DB |
| Nonexistent/ambiguous user-entered time | `reject`, then 422 with candidate instants |
| Same, in recurrence or trigger | `compatible` (forward / earlier) |
| Invalid zone name | `InvalidTimeZoneError` (`INVALID_TIME_ZONE`) |
| `end_time = '24:00'` | resolves to next-day 00:00; `start_time` can't be 24:00 |
| Session with no courts | instants NULL; can't be PUBLISHED or COMPLETED (CHECK) |
| First invoice for a team, 20 concurrent callers (20 distinct payments) | `ON CONFLICT` speculative insert: one inserts, 19 update in turn, giving {1..20} |
| Two issuers, same payment | the second waits on the payment row lock, then raises `23000` (`payments_invoice_number_set_once`); counter advanced by exactly 1 |
| Allocating transaction rolls back | the counter increment rolls back too, so the number is reused |
| Payment or credit transaction with another user's / team's registration | `23503` (composite FK) |
| Registration whose `team_id` ≠ its session's team | `23503` (composite FK) |
| Two concurrent enqueues with the same `queue_position` | one commits, the other gets `23505` (partial unique index) |
| Replayed `bill-session` | the session guard returns 0 rows. The unique keys are a second line of defence |
| Guest rows ≠ `guest_count` | `23514` `registration_guest_count_matches` at COMMIT (or at the statement with `SET CONSTRAINTS … IMMEDIATE`) |
| Late-withdrawal fee then re-registration of the same `(session,user)` row | `UNIQUE(registration_id)` means post-game billing skips it (already charged). Flag to registration-and-waitlist |
| BY_SEX + sex OTHER | billed at `fee_other` with basis `SEX_OTHER`; a BY_SEX session or rule with NULL `fee_other` → `23514` |
| Session fee edited after billing | the payment and lines are a snapshot, so they're unaffected (AC-VERIFY-8). Updating payment snapshot columns → `23000` |

### Error Handling
| Error Condition | Response |
|-----------------|----------|
| Money parse or range errors | typed `MoneyValidationError.code`; API maps to 422 with a field path |
| Time validation errors | typed `TimeValidationError.code` (subclasses carry candidate instants); API maps to 422 |
| `nz_local_to_utc(..., 'reject')` in SQL | SQLSTATE `22007` (invalid_datetime_format); never used by the triggers |
| Allocator lock wait > `lock_timeout` | SQLSTATE `55P03`; the job retries (at-least-once) or the API returns 503 with retry |
| Deferred check failures | SQLSTATE `23514` with named constraint at COMMIT; the transaction rolls back |
| Immutable-row edits | SQLSTATE `23000` |
| `assign_invoice_number` on an already-invoiced payment | SQLSTATE `23000`, constraint `payments_invoice_number_set_once`; the caller's transaction rolls back (counter included) |
| `assign_invoice_number` on an unknown payment | SQLSTATE `P0002` (no_data_found) |
| Ownership mismatch (payment, credit transaction, registration) | SQLSTATE `23503` |
| Duplicate waitlist position | SQLSTATE `23505` on `uq_registrations_waitlist_position` |

---

## PostgreSQL 17 notes

| Feature (version) | Used? | Where / why |
|---|---|---|
| `postgres:17` image, `-c timezone=UTC` | **Yes** | Compose, CI service container, integration tests. AC-VERIFY-2 checks for `PostgreSQL 17.` |
| `MERGE … RETURNING` (17) | **Evaluated, rejected** | Q9 option 9D. MERGE can raise `23505` on a concurrent first insert; `INSERT … ON CONFLICT … RETURNING` is race-free and the docs recommend it |
| `MERGE … WHEN NOT MATCHED BY SOURCE` (17) | Not used | Could sync a guest set in one statement. Not needed with ≤ 2 rows |
| `UNIQUE NULLS NOT DISTINCT` (15+) | **Evaluated, not needed** | `uq_payments_registration` must allow many NULLs (future subscription rows); `uq_payments_team_invoice_number` must allow many un-invoiced NULLs; guest and line positions are NOT NULL. The default NULLS DISTINCT is correct everywhere |
| `transaction_timeout` GUC (17) | **Recommended (optional)** | Set on job transactions (e.g. `SET LOCAL transaction_timeout = '60s'` in the `bill-session` handler), so a stuck transaction can't hold a team's invoice counter lock indefinitely. Complements `lock_timeout` on the waiter side. Don't set it at role level, because migrations would hit it |
| STORED generated columns (12+) | **Yes** | `payments.gst_amount`, `subtotal_amount`. Virtual generated columns are PG 18, not available |
| `pg_input_is_valid()` (16) | Test-only (optional) | The parity test can assert that every canonical `MoneyString` produced by TS is valid `numeric(10,2)` input |
| Timezone behaviour (§B.2) | Unchanged 15→17 | Native overlap = later, so we override it in `nz_local_to_utc` |

Nothing in this document is PG-17-only except the optional `transaction_timeout`. The design is portable to 18.

---

## Performance Expectations

### At Current Scale
- Money ops < 1 µs; time conversion about 10 µs; allocator about 0.2 ms; session trigger < 0.5 ms; billing about 1 ms per registration.
- Memory: constant per call. One cached formatter per zone.
- Throughput: each far above need. Allocator ≈ 1 / (holder transaction time) per team, about 100–500 per second per team.

### At 10x Scale
- Latency is unchanged (all O(1) or O(log n) index probes). The sweep index keeps only PUBLISHED rows.
- Memory: about 350k payments and 700k line items over 7 years, around 200 MB with indexes. Trivial.
- Bottleneck: same-team invoice issuance during long transactions (the counter row lock). Mitigation: allocate last, `lock_timeout`, short issuing transactions.

### Optimization Opportunities
- Batch invoice issuance: `assign_invoice_numbers(payment_ids uuid[])` locking the payments in id order and taking a contiguous range (`last_number + k`) for bulk issuance, as one counter-lock acquisition.
- If per-team issuance ever needs parallelism, switch that team's invoices to 9B-style sequences and accept gaps. IRD doesn't require gapless numbering (see Evidence).
- Swap the 7A internals for native `Temporal` once all target browsers ship it. The public API already uses its vocabulary.

---

## Validation Checklist

- [x] Meets latency requirements: all operations are microseconds to about 1 ms. There are no SLAs, and every step is far below the job expiry and HTTP budgets.
- [x] Meets memory requirements: constant per call.
- [x] Handles all edge cases (table above), including the DST gap and overlap, midnight end, first-allocation race, rollback reuse, replay, and count drift.
- [x] Scales to the expected data size: index-backed, with no scans on hot paths.
- [x] Implementation feasible: the vectors and algorithm were prototyped in Node 24 (host-TZ independent, exhaustive 3-year round-trip). All SQL uses documented PG 17 features.
- [x] Respects the Guiding Principles and data flow patterns:
  - **P1**: CHECKs, generated GST, deferred invariants, immutability triggers and RESTRICT FKs.
  - **P2**: bigint cents, string wire format, no float column allowed.
  - **P3**: `timestamptz` only. The conversion lives in one algorithm with two ports under a parity test, which is a documented refinement of "only in this module".
  - **P5**: natural idempotency keys and the guarded transition.
  - No conflict with P4, P6 or P7.

## Testing Strategy

### Unit Tests (`packages/shared/src/money/money.test.ts`, `packages/shared/src/time/time.test.ts`)
- Money: parse/format `'17.50'` → `$17.50`; `0.10 × 3 = '0.30'`; the GST table ($17 → 2.22, $16 → 2.09, $115 → 15.00, $0.01 → 0.00); rate table (11.00, 12.00, 9.00, 12.00); HALF_UP ± ties; CEIL/FLOOR with negatives; range edges (±99,999,999.99; +0.01 → `OUT_OF_RANGE`); the rejects `'17.505'`, `'abc'`, NaN, Infinity, `17.5`, `'1e3'`, `' 1.00'`, `'01.00'`; `JSON.stringify(money)` throws; a type test (`// @ts-expect-error add(money, 1)`).
- Money property test: for random cents T ∈ [0, 10⁷], `gst + subtotal == T` and `gst == round-half-up(3T/23)` computed independently with bigint rationals; also confirm no ties exist.
- Time: vector table rows 1–23, run by a Vitest project variant under `TZ=UTC` and `TZ=America/New_York` (two `test` invocations via `cross-env`/`env` in the script, or `process.env.TZ` set before import in a forked pool). Exhaustive 15-min round-trip for 2026–2028: 0 mismatches, exactly 12 nonexistent and 12 ambiguous slots. `formatNzDate`/`formatNzTime`/`formatNzDateTime` (`03/04/2027 8:00 pm`); `InvalidTimeZoneError` for `'Mars/Olympus'`; `parseLocalDate('2026-02-30')` → error; `defaultCancellationDeadline` vector #16 vs `sameWallClockDaysBefore` #17.

### Integration Tests (`apps/api/test/integration/*.int.test.ts`, against `postgres:17`)
- `money-roundtrip`: insert and select `99999999.99`, `0.00`, `-0.01` (where allowed); `100000000.00` → `22003`.
- `time-parity`: `SELECT nz_local_to_utc(d, t, p)` for vector rows 1–15 and 18–21 × {`compatible`, `reject`} equals TS; also all 96 quarter-hour slots on 2026-09-27 and 2027-04-04. A contrast assertion documents that plain `AT TIME ZONE` gives `14:30Z` for row 11.
- `session-instants`: insert a session plus courts 19:00–21:00 and 20:00–22:00 → `starts_at`/`ends_at` are correct. Editing a court time, changing the date or deleting a court recomputes them. A direct `UPDATE … SET ends_at = …` is overwritten. A PUBLISHED session without courts → `23514`.
- `invoice-number` (AC-VERIFY-9): 20 concurrent `BEGIN; SELECT assign_invoice_number(<payment_i>); pg_sleep(0.01); COMMIT` for 20 distinct team-A payments on 20 dedicated connections (pool max ≥ 21) gives exactly {1..20}; team B ×3 gives {1,2,3}. Rollback-reuse: assign → ROLLBACK → assign returns the same number. **Same-payment race**: two connections call `assign_invoice_number(P)` concurrently → one commits a number, the other raises `23000` (`payments_invoice_number_set_once`), and `team_invoice_counters.last_number` has advanced by exactly 1 (the next payment gets the next number, no gap). A duplicate `(team_id, invoice_number)` → `23505`, while the same number for another team is accepted. Changing an issued number → `23000`.
- `registrations-guests` (AC-VERIFY-7): duplicate `(session,user)` → `23505`; `guest_count` −1 / 3 → `23514`; position 3 → `23514`; `guest_count=2` with 1 guest row → `23514` at COMMIT; `guest_count=1` with only position 2 → `23514`. Tests on a rolled-back transaction first run `SET CONSTRAINTS registration_guest_count_matches_r, registration_guest_count_matches_g IMMEDIATE`. Registration `team_id` ≠ session team → `23503`.
- `registrations-waitlist` (AC-VERIFY-19): two WAITLISTED rows with the same `(session_id, queue_position)` → `23505`; the same position for a CONFIRMED row is fine (partial index); WAITLISTED without a position, or CONFIRMED with one → `23514`. Multi-connection: two connections each `BEGIN; INSERT … queue_position = 1 …` for the same session, both COMMIT → exactly one `23505`.
- `payments-snapshot` (AC-VERIFY-8): insert without `team_id` → `23502`; generated GST for $17.00 at 1500 bps = 2.22 and subtotal 14.78; `gst_registered=false` with bps 1500 → `23514`; lines summing ≠ amount → `23514` at COMMIT; a BY_SEX line whose basis doesn't match the party's sex → `23514`; `UPDATE game_sessions SET fee_flat = …` → the payment re-reads unchanged; `UPDATE payments SET amount` → `23000`; `DELETE` line → `23000`; a second payment for the same registration → `23505` / `ON CONFLICT DO NOTHING` returns 0 rows. **Ownership**: a payment whose `user_id` ≠ the registration's user → `23503`; whose `team_id` ≠ the registration's (session's) team → `23503`; same two checks on `credit_transactions` with a `registration_id` → `23503`. **BY_SEX + OTHER**: a BY_SEX session with `fee_other` NULL → `23514`; an OTHER registrant line (`SEX_OTHER`, `unit_fee = fee_other`) and an OTHER guest line both commit, and the payment amount equals their sum.
- Retention (AC-VERIFY-11): deleting a user or team with payments, credit transactions or counters → `23503`.
- Conformance additions: every `numeric` column in `public` is `numeric(10,2)`; there are no `float4`/`float8` columns; there are no `timestamp without time zone` columns.

### Performance Tests
- Micro-benchmark in the unit suite (reported, not gated): 10⁵ `localToInstant` calls in < 2 s; 10⁶ money ops in < 1 s.
- An allocator with 20-way contention completes in < 2 s (gated loosely, to detect lock leaks).

## Next Steps

1. The planner applies the AC wording changes and re-pins below to `memory-bank/tasks/platform-foundation.md`, and marks Algorithm creative complete.
2. Phase 3: migrations 1 (`fee_basis`), 6, 7, 8 and 9 as specified; `db/schema-deviations.md` entries (listed below); codegen overrides; `enums.ts` `FeeBasis`.
3. Phase 4: `money.ts`, `money/zod.ts`, `time.ts`, `invoice.ts` (`formatInvoiceNumber`), with tests.
4. ADRs 0009 (money), 0010 (time/DST), 0011 (invoice numbering, including the IRD finding and the UNVERIFIED-LEGAL flag), 0012 (fee snapshot and guests).
5. Hand these constraints to downstream owners: **session-scheduling-engine** defaults `fee_other` to `LEAST(fee_male, fee_female)` when BY_SEX is chosen (admin-editable); **registration-and-waitlist** follows the session-row `FOR UPDATE` waitlist locking contract (Q11) and owns the re-registration-after-late-fee edge; **wallet-and-akahu-billing** creates the `player_credits` row before the first credit transaction. Get accountant confirmation of the invoice numbering and GST presentation before tax-invoices-and-exports ships.

**Schema deviations to record** (each with its source): `fee_basis` enum (Q11); `registration_guests`, `payment_line_items`, `team_invoice_counters` tables (task gap list, Q9/Q11); `game_sessions.starts_at/ends_at` plus triggers, `nz_utc_offset`, `nz_local_to_utc` (Q7, arch C-5); `payments.team_id`, `pricing_structure`, `gst_registered`, `gst_rate_bps`, `invoice_number`, `invoice_issued_at`, and GST/subtotal becoming generated columns (AC-VERIFY-8/9, Q11); `UNIQUE(payments.registration_id)`, `UNIQUE(team_id, invoice_number)`, partial unique on `credit_transactions` (C-8); FKs CASCADE/SET NULL → RESTRICT on payments, credit_transactions, player_credits, registrations (AC-VERIFY-11); `guest_count` CHECK 0–2 plus NOT NULL, balance CHECK 0–100 (AC-VERIFY-7/10); time-order CHECKs on courts and rules, `max_players > 0`, `reserved_seats` range, `game_sessions.status NOT NULL`, `queue_position` iff WAITLISTED (Q7/Q11, P1); `idx_game_sessions_billing_due` (partial), `idx_payments_team_paid_status`, `idx_payment_line_items_payment` (AC-VERIFY-8, Q4 T3); `assign_invoice_number(payment_id)` (Q9, critique finding 3); ownership chain: `game_sessions.team_id NOT NULL` + `UNIQUE(id, team_id)`, new `registrations.team_id NOT NULL` + composite FK to `game_sessions(id, team_id)` + `UNIQUE(id, user_id, team_id)`, composite FKs from `payments` and `credit_transactions` to `registrations(id, user_id, team_id)` (replacing their single-column `registration_id` FKs), `credit_transactions (user_id, team_id) → player_credits` (critique finding 1); `uq_registrations_waitlist_position` partial unique index (critique finding 2); `fee_other` on `game_sessions` and `recurring_session_rules`, `SEX_OTHER` in `fee_basis`, BY_SEX fees-present CHECKs (spec-owner decision 2026-09-29, critique finding 4).

---

## Revisions (2026-09-29)

Spec-owner decisions on the Codex design critique (task file → Design Critique):
- **Finding 1 (critical), ownership chain**: added `game_sessions UNIQUE(id, team_id)`, `registrations.team_id NOT NULL` with a composite FK to the session, `registrations UNIQUE(id, user_id, team_id)`, and composite `MATCH SIMPLE` FKs from `payments` and `credit_transactions`, plus `credit_transactions → player_credits`. `payments.registration_id` stays nullable for out-of-scope subscription rows. New negative tests (`23503`).
- **Finding 2 (high), FIFO waitlist**: added `uq_registrations_waitlist_position` and the session-row `FOR UPDATE` locking contract for registration-and-waitlist. New multi-connection test (exactly one `23505`).
- **Finding 3 (high), invoice race**: `allocate_invoice_number(team_id)` replaced by `assign_invoice_number(payment_id)`, which locks the payment, refuses a set number (`23000`), derives the team, bumps the counter and checks for exactly 1 updated row. Caller pattern, edge cases and tests updated.
- **Finding 4 (high), BY_SEX + OTHER**: the open question is closed. `fee_other` on sessions and rules, `SEX_OTHER` basis, fees-present CHECK, default `LEAST(fee_male, fee_female)` handed to session-scheduling-engine.
- **Finding 5 (medium), AC-ASYNC-3 wording**: no change here. The at-least-once and domain-idempotency design (Q11 guards) already matched; the AC was reworded in the task file.
