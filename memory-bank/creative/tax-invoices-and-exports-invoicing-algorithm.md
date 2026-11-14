# Algorithm Decision: Tax Periods, GST of an Inclusive Total, and Income Export Generation

**Created**: 2026-11-10
**Status**: DECIDED
**Decision Type**: Algorithm
**Task**: `tax-invoices-and-exports` (Level 3), design questions 5 and 6; rulings H4, H8, H11, H12 at their defaults
**Phases affected**: Phase 1 (period helpers, `gstOfInclusive`, contracts), Phase 4 (income exports)

## Problem Statement

Four connected algorithms are needed:

1. **Period resolution**: turn a team admin's choice (a custom date range, a GST return period or an NZ financial year, all expressed as Pacific/Auckland calendar dates) into one half-open UTC instant range `[from, to)`. Every instant must fall in exactly one period of each kind, including across daylight-saving changes and leap days.
2. **GST of an inclusive total**: a TypeScript `gstOfInclusive(Money, rateBps)` that is identical, to the cent and for every input, to the Postgres generated column `payments.gst_amount`.
3. **Export generation**: read exactly the team's `status = 'PAID'` payments with `paid_at` in `[from, to)`, in a deterministic order, with bounded memory. Refuse an export that is too large (never truncate it), and include $0.00 and not-yet-numbered payments sensibly.
4. **Export encoding and reconciliation**: one row shape for CSV and XLSX, with no sensitive data and with formula-injection neutralisation, plus summary totals that reconcile exactly to the rows using only `Money` arithmetic.

## Inputs & Outputs

### Inputs
| Name | Type | Size/Range | Source |
|------|------|------------|--------|
| Period request | discriminated union: `custom {from, to}`, `gst {cadence, end}`, `fy {year}` | one per request | export route query (validated by a shared zod schema) |
| Today | `LocalDate` (NZ) | one | `instantToLocal(clock.now()).date`, the injected API clock, read once |
| Format | `'csv' \| 'xlsx'` | one | query |
| Team id | uuid | one | route param, already passed through the `TEAM_ADMIN` guard |
| Payment rows | `payments` joined to `users`, `registrations`, `game_sessions` and the invoice snapshot | 0 to the row cap per export | Postgres, index `idx_payments_team_paid_status (team_id, paid_at, status)` |
| Inclusive total and rate | `Money`, integer bps 0..10000 | `amount` 0..99,999,999.99; bps 1500 or 0 in practice | `payments.amount`, `payments.gst_rate_bps` |

### Outputs
| Name | Type | Description |
|------|------|-------------|
| `LocalDateRange` | `{ from: LocalDate; to: LocalDate }` | inclusive NZ calendar dates (what people read and what labels print) |
| `InstantRange` | `{ from: Date; to: Date }` | half-open UTC range used by SQL (`paid_at >= from AND paid_at < to`) |
| `PeriodDescriptor` | `{ kind, range, label, fileStem }` | the resolved period, a human label and a file-name-safe stem |
| GST split | `{ total, gst, subtotal }: Money` | `gst = round_half_up(total * bps / (10000 + bps))`, `subtotal = total - gst` |
| Export file | `Uint8Array` + content type + file name | CSV (RFC 4180) or XLSX ("Payments" and "Summary" sheets) |
| `ExportSummary` | counts and `Money` totals | count, invoiced count, $0.00 count, awaiting-number count, Σ subtotal, Σ GST, Σ total |
| Refusals | `422 validation_failed` (field errors), `422 export_too_large` | input invalid, or more rows than the cap |

### Edge Cases
1. **A payment at 31 March 23:59:59.999 NZDT or 1 April 00:00 NZDT**: the first is in the old financial year, the second in the new one. **Correction to the spec:** AC-HAPPY-8 and AC-VERIFY-3 say "1 April 2027 00:00:00 **NZST**". That instant is in **NZDT** (UTC+13). NZ daylight saving ends on the first Sunday in April at 03:00, so 1 April at midnight is always NZDT (verified for 2020-2040 with the ICU zone data). The financial-year boundary is `2027-03-31T11:00:00Z`. The tests must use that instant, and the AC wording should be fixed.
2. **The DST changeover weekend inside a period** (last Sunday in September, first Sunday in April): period boundaries are midnights, which never coincide with an NZ changeover, so boundaries are unaffected. The period simply lasts 1 hour more or less than `days × 24 h`.
3. **29 February**: month ends are derived as "first day of next month minus one day", so there is no month-length table. Two-monthly Jan-Feb 2028 ends on 29 Feb; Jan-Feb 2027 ends on 28 Feb; 2100 is not a leap year and 2000 is.
4. **A period that crosses the calendar year** (odd alignment Dec-Jan): it is labelled by its end month (`2027-01`), and its start is 1 Dec of the previous year.
5. **Many payments with the same `paid_at`**: a wallet `bill-session` sets `paid_at = now()` for the whole session in one transaction, so ties of 30-60 rows are normal. The order breaks ties by invoice number, then id.
6. **A PAID payment with no invoice number yet** (job queued, dead-lettered, or paid before this feature): included, with an empty invoice-number cell, and counted in the Summary as "awaiting invoice number". The export never issues invoices (exports persist nothing).
7. **A PAID $0.00 payment** (ruling B7): included, with 0.00 in all three money columns, an empty invoice-number cell and an empty payment-method cell. Counted separately in the Summary (AC-ERROR-5).
8. **A team that changed GST registration inside the period**: rows carry their own snapshot (`gst_registered`, `gst_rate_bps`, `gst_number`). The Summary lists each distinct snapshot GST number, and "Not registered" when none.
9. **An empty range**: a valid file with a header row only, and a Summary of zeros (AC-ERROR-3). This is not an error.
10. **Exactly the row cap**: allowed. One more row is refused.
11. **Totals beyond `MONEY_MAX`** (Σ > 99,999,999.99, impossible in practice): refused as `export_too_large`, never thrown as a 500.
12. **Hostile text** (`=HYPERLINK(...)`, `+1 Smith`, `@cmd`, leading tab or CR, full-width `＝`): neutralised with a leading `'` in both formats. The stored value is unchanged.
13. **Today is 1 April NZ but still 31 March UTC** (for example `2027-03-31T11:30Z`): the current financial year is 2027-28, because "today" is always the NZ date of the clock.

## Constraints

### Performance Requirements
- **Export latency**: at the row cap (50,000 rows), CSV under 5 s and XLSX under 10 s end to end on the api container. A typical financial year (≈ 3,000 rows) under 500 ms. These are budgets for the design, not wall-clock test assertions (PR #9 lesson).
- **Memory budget**: rows are never all in memory. The working set is one fetch page (1,000 rows) plus the encoded output (≤ ≈ 10 MB CSV at the cap).
- **Period helpers**: O(1) per call (a few `localToInstant` probes). The option lists are O(years) and O(periods) with tiny constants.
- **Invoice render**: not this document (architecture and UI/UX). `gstOfInclusive` is O(1) bigint arithmetic.

### Scale Requirements
- **Current data size**: the productBrief gives no volumes. Working assumption, consistent with the billing algorithm doc: tens of teams, typically 2 sessions a week × ~30 payers ≈ **3,100 PAID payments per team per year**. A busy multi-court team (daily sessions × ~60 payers) ≈ **22,000 per year**. Guests are lines, not payments, so they do not add rows.
- **Expected growth**: 10x more teams changes nothing per export, because every export is scoped to one team and bounded by the cap.
- **Peak load**: a handful of concurrent exports (team admins near a GST due date: the 28th of the month after a period ends, or 7 May for a March period). An export holds one pooled connection for its duration.

### Other Constraints
- **P1**: `status = 'PAID' ⇔ paid_at IS NOT NULL` is a CHECK (`payments_paid_at_iff_paid`). The filter still names `status = 'PAID'` explicitly (AC-VERIFY-2).
- **P2**: `Money` only. The billing source scan bans `Number(`, `parseFloat`, `.toFixed(`, `Math.` and money-named fields typed `number`. The one place a `Money` must become an IEEE double (an XLSX numeric cell) is a single, declared, test-proven exemption (see D4).
- **P3**: every NZ-date-to-instant conversion goes through `localToInstant` / `instantToLocal`. SQL receives instants as parameters and does no time-zone arithmetic.
- **P5**: an export enqueues nothing and writes nothing.
- **P7**: the row cap and the range limit are environment configuration, validated at boot.
- **Security**: no email, bank detail, `payment_link_token` (now `payment_reference`, which is not secret), Akahu id or GST snapshot of a different team ever reaches a row.
- **Testing**: CPU-heavy sweeps get explicit timeouts and no wall-clock assertions. The clock is injected.

## Options Explored

The work splits into four decisions. Options are given per decision. The complexity tables follow.

### Decision D1: Period model and resolution

**IRD facts used (sources at the end):**
- Two-monthly GST returns have two alignments: periods ending in **odd** months (Jan, Mar, May, Jul, Sep, Nov) and periods ending in **even** months (Feb, Apr, Jun, Aug, Oct, Dec). IRD's archived commentary on the GST Amendment Act (No 2) 1988 names them category A (odd) and category B (even) [IRD-1]. IRD's 2006 provisional-tax alignment article gives the odd set for "a March balance date taxpayer who accounts for GST on a two-monthly basis (ending January, March, May, July, September, and November)" [IRD-2]. IRD now requires the filing frequency to be aligned with the income-tax balance date, which is 31 March for most [IRD-3]. **So odd-month alignment is the right default** for a club with a 31 March balance date. The category letters come from archived 1988 commentary, so the UI must name months, never "category A/B".
- **Six-monthly** filing is open to anyone with sales under $500,000 in any 12-month period [IRD-3], which covers almost every community club. With a 31 March balance date the periods end on 30 September and 31 March (aligned to the balance date [IRD-3]; the exact months for other balance dates are the accountant's to confirm).
- **Monthly** filing is compulsory only above $24 million [IRD-3], so it is irrelevant to the market. It is reachable through Custom range anyway.

#### Option 1A: Separate ad-hoc functions per period kind
- **Approach**: `financialYear(y)`, `gstTwoMonthOdd(endYm)`, `gstTwoMonthEven(endYm)`, each building its own date arithmetic and conversion.
- **Pseudocode**:
  ```
  gstTwoMonthOdd(y, m): assert m odd; from = (m == 1 ? (y-1, 12, 1) : (y, m-1, 1)); to = lastDay(y, m)
  ```
- **Time Complexity**: O(1) best, average and worst.
- **Space Complexity**: O(1).
- **Data Structures**: none.
- **Pros**: very little code for exactly the two alignments the spec names.
- **Cons**: the month-arithmetic and conversion code is duplicated in each function, so the year-crossing and leap-year handling can drift between them. Six-monthly would be a third copy. No single partition property to test.
- **Best For**: a fixed, tiny set of kinds.
- **Worst For**: adding six-monthly, or proving that the periods tile time.

#### Option 1B: One generic "N-month period anchored on an end month" model plus a financial year, with one conversion path (chosen)
- **Approach**: a cadence is `{ months: 1 | 2 | 6, anchorEndMonth: 1..12 }`. A month ends a period when `(month - anchorEndMonth) mod months == 0`. The financial year is its own function (12 months ending in March). All kinds produce a `LocalDateRange`, and **one** function turns any `LocalDateRange` into an `InstantRange`.
- **Pseudocode**:
  ```
  monthIndex(y, m) = y*12 + (m-1)                       // integer month count, no Date
  periodContaining(date, {months, anchorEndMonth}):
      i   = monthIndex(date.y, date.m)
      r   = mod((anchorEndMonth - 1) - mod(i, 12), months)   // months until the period's end month
      end = i + r ; start = end - months + 1
      return { from: firstDay(start), to: addLocalDays(firstDay(end + 1), -1) }
  periodEndingIn(y, m, cadence):                        // for a selected "end" value
      require mod(m - anchorEndMonth, months) == 0 else INVALID_PERIOD_END
      return periodContaining(firstDay(monthIndex(y, m)), cadence)
  financialYear(startYear) = { from: (startYear, 4, 1), to: (startYear+1, 3, 31) }
  financialYearOf(date) = date.m >= 4 ? date.y : date.y - 1
  toInstantRange({from, to}, tz = APP_TIME_ZONE):
      return { from: localToInstant(from,               '00:00', DST_POLICY.DERIVED, tz),
               to:   localToInstant(addLocalDays(to, 1), '00:00', DST_POLICY.DERIVED, tz) }
  ```
- **Time Complexity**: O(1) best, average and worst (two `localToInstant` calls, each a constant number of `Intl` probes).
- **Space Complexity**: O(1).
- **Data Structures**: `LocalDateRange`, `InstantRange`, `GstCadence` presets.
- **Pros**: one month-arithmetic and one conversion path. Year-crossing (Dec-Jan) falls out of the modulo. Six-monthly costs nothing. The tiling property (`to(k) == from(k+1)`) can be tested for every cadence at once.
- **Cons**: a slightly more abstract API. It needs a modulo that is correct for negatives (write `mod(a, n) = ((a % n) + n) % n`).
- **Best For**: several period kinds over one partition proof.
- **Worst For**: nothing relevant.

#### Option 1C: Resolve periods in SQL (`date_trunc`, `AT TIME ZONE`)
- **Approach**: send the period kind and key to SQL, then compute bounds with `make_date(...) AT TIME ZONE 'Pacific/Auckland'`.
- **Time Complexity**: O(1).
- **Space Complexity**: O(1).
- **Data Structures**: none.
- **Pros**: no TS conversion.
- **Cons**: breaks P3 (the single TS conversion point). Creates a second implementation that needs its own parity test against `time.ts`. The labels and the UI lists still need TS, so the logic would exist twice.
- **Best For**: SQL-only reporting.
- **Worst For**: this codebase.

**Why `DST_POLICY.DERIVED` ('compatible') is correct for midnight, not just convenient**: the start of local day D is the earliest instant whose local date is D. If midnight falls in a spring-forward gap, 'compatible' shifts forward to the transition instant, which is that earliest instant. If midnight is ambiguous (fall-back), 'compatible' takes the earlier occurrence, which is also that earliest instant. NZ never changes at midnight, so in practice the result is always `unique`, but the rule stays correct if the rules ever change. A property test pins it (see Testing): `startOfDay(D)` has local date D, and `startOfDay(D) - 1 ms` has local date D-1.

### Decision D2: `gstOfInclusive(Money, rateBps)`

The verified column expression (`pg_get_expr`, 2026-11-10) is `round(((amount * (gst_rate_bps)::numeric) / ((10000 + gst_rate_bps))::numeric), 2)`.

#### Option 2A: Exact rational HALF_UP through `multiplyByRatio` (chosen)
- **Approach**: `gst = multiplyByRatio(total, BigInt(rateBps), BigInt(10000 + rateBps), 'HALF_UP')`; `subtotal = subtract(total, gst)`.
- **Pseudocode**:
  ```
  gstOfInclusive(total: Money, rateBps: number): Money
      require Number.isInteger(rateBps) && 0 <= rateBps <= 10000   (else MoneyValidationError INVALID_RATIO)
      if rateBps == 0: return ZERO
      return multiplyByRatio(total, BigInt(rateBps), BigInt(10000 + rateBps), 'HALF_UP')
  splitInclusive(total, rateBps) = { total, gst: g, subtotal: subtract(total, g) }
  ```
- **Time Complexity**: O(1) best, average and worst (bigint multiply, divide, remainder).
- **Space Complexity**: O(1).
- **Data Structures**: none.
- **Pros**: the exact rational value is rounded once. HALF_UP means away from zero, as in Postgres `round(numeric)`, so negatives (future credit notes) also agree. It reuses the audited `money.ts` primitive.
- **Cons**: it differs in form from SQL, which divides first at about 16 significant digits and then rounds. Equality must therefore be argued and tested (below).
- **Best For**: exactness.
- **Worst For**: nothing.

#### Option 2B: Emulate Postgres numeric division scale, then round
- **Approach**: reproduce `select_div_scale` (at least 16 significant digits), round half-up to that scale, then round to 2 dp.
- **Time Complexity**: O(1).
- **Space Complexity**: O(1).
- **Data Structures**: none.
- **Pros**: mirrors SQL step for step.
- **Cons**: it couples us to Postgres internals and is complex. It is unnecessary given the proof below.
- **Best For**: rates whose quotients sit within 1e-12 of a half cent (none exist in the allowed domain).
- **Worst For**: maintenance.

#### Option 2C: `gstFraction` (3/23) then `multiplyByRatio`
- **Approach**: reduce bps/(10000+bps) by gcd, then multiply by the reduced fraction.
- **Time Complexity**: O(log bps) for the gcd.
- **Space Complexity**: O(1).
- **Data Structures**: none.
- **Pros**: matches the "3/23" wording.
- **Cons**: `gstFraction` returns `number`s and needs conversion. Reducing the fraction changes nothing because rounding is on the exact rational anyway.
- **Best For**: display text ("3/23").
- **Worst For**: nothing in particular. It is just redundant.

**Why 2A always equals the column.** Let `c` be the amount in cents and `d = 10000 + bps`. The exact GST in cents is `c·bps/d`. Double rounding (SQL's intermediate division, then `round(…, 2)`) can differ from one exact rounding only if the exact value lies within the intermediate rounding error of a half-cent tie without being one.
- The distance from a tie is `|2·c·bps − d·(2k+1)| / (2d)` cents. When it is not zero, it is at least `1/(2d) ≥ 1/40000` cent = 2.5e-7 dollars.
- Postgres divides at no fewer than 16 significant digits. For amounts up to 99,999,999.99 the quotient has at most 8 integer digits, so the intermediate error is at most 5e-9 dollars, which is less than 2.5e-7. So 2A equals SQL everywhere.
- At 1500 bps, ties are impossible: `6c = 23(2k+1)` would need 23 | c, and then the left side is even while the right side is odd. The nearest approach is exactly 1/46 cent.
- Exact ties do exist at other rates (2000 bps when c ≡ 3 (mod 6), 10000 bps when c is odd). There the intermediate division is exact, both sides round the tie away from zero, and they agree.
- **Verified 2026-11-10 against the dev database**: 30,603 values (cents −200..10,000 at 1500, 2000 and 10000 bps) gave 0 mismatches. The maximum amount gives 13,043,478.26 on both sides.

### Decision D3: Export read strategy

All options use the same filter, order and preflight:
```
WHERE p.team_id = $team AND p.status = 'PAID' AND p.paid_at >= $from AND p.paid_at < $to
ORDER BY p.paid_at ASC, p.invoice_number ASC NULLS LAST, p.id ASC
```

#### Option 3A: One unpaged query, rows buffered in memory
- **Approach**: `SELECT …` with no limit, materialise all rows, then encode.
- **Pseudocode**: `rows = await query.execute(); return writer.encode(rows)`
- **Time Complexity**:
  - Best: O(n log n) for the DB sort and O(n) to encode, on a small range.
  - Average: O(n log n).
  - Worst: O(n log n) at the cap.
- **Space Complexity**: O(n) JS objects (≈ 1 KB each with Dates, bigints and strings, so ≈ 50 MB at the cap) plus the output.
- **Data Structures**: an array of rows.
- **Pros**: simplest. The repo's admin list uses this shape (with a limit).
- **Cons**: violates the spec NFR ("without loading the rows into memory at once"). Memory grows with n, and the cap check needs a separate count anyway.
- **Best For**: small fixed result sets.
- **Worst For**: the cap case and concurrent exports.

#### Option 3B: Keyset pages within one REPEATABLE READ snapshot
- **Approach**: repeat `… AND (p.paid_at, p.invoice_number IS NULL, coalesce(p.invoice_number, 0), p.id) > ($t, $nullFlag, $n, $id) AND p.paid_at >= $t ORDER BY … LIMIT 1000` until a short page.
- **Pseudocode**:
  ```
  pos = null
  loop: page = select(... after pos ... limit 1000); emit(page); if page.length < 1000 break; pos = keyOf(last(page))
  ```
- **Time Complexity**:
  - Best: O(n) when the planner uses `idx_payments_team_paid_status` with an Incremental Sort on the `paid_at` prefix, plus LIMIT.
  - Average: O(n + n/P · tieGroup).
  - Worst: O(n²/P) if the planner falls back to a full top-N sort of the remaining range for every page (50 pages × up to 50k rows).
- **Space Complexity**: O(P) rows.
- **Data Structures**: a keyset position `(paid_at text µs, nullFlag, number, id)`.
- **Pros**: it uses the repo's established keyset pattern (`lib/http/cursor.ts`) and needs no cursor state in the database.
- **Cons**: the nullable middle sort key forces an awkward four-part tuple. Its performance depends on the planner choosing Incremental Sort. The `paid_at` text must keep microseconds. Snapshot consistency with the preflight still needs one long transaction, so it saves no connection time.
- **Best For**: paging across separate HTTP requests (not this case).
- **Worst For**: one-shot, ordered, bounded scans.

#### Option 3C: A server-side SQL cursor (`DECLARE … CURSOR` / `FETCH`) inside one REPEATABLE READ READ ONLY transaction (chosen)
- **Approach**: open one read-only REPEATABLE READ transaction, so the preflight and the rows see the same snapshot. Run the preflight aggregate first. If `count > cap`, roll back and answer 422. Otherwise `DECLARE income_export NO SCROLL CURSOR FOR <the ordered select>` (Kysely compiles the select, bind parameters included) and `FETCH FORWARD 1000` until fewer than 1,000 rows come back. Encode each page into the writer as it arrives.
- **Pseudocode**:
  ```
  exportIncome(db, team, range: InstantRange, writer, limits):
    db.transaction().setIsolationLevel('repeatable read') [+ READ ONLY].execute(trx =>
      SET LOCAL statement_timeout = limits.statementTimeout
      pre = SELECT count(*), coalesce(sum(amount),0)::text, coalesce(sum(gst_amount),0)::text,
                   coalesce(sum(subtotal_amount),0)::text,
                   count(*) FILTER (WHERE amount = 0), count(*) FILTER (WHERE invoice_number IS NULL AND amount > 0),
                   array_agg(DISTINCT gst_number) FILTER (WHERE gst_number IS NOT NULL)
              FROM payments WHERE <filter>
      if pre.count > limits.maxRows: throw ExportTooLarge          // nothing written yet
      summary = parseSummary(pre)                                  // parseMoney; OUT_OF_RANGE → ExportTooLarge
      writer.begin(meta, summary)
      DECLARE income_export NO SCROLL CURSOR FOR <ordered select with joins>
      acc = new Reconciler()
      loop:
        page = FETCH FORWARD 1000 FROM income_export
        rows = page.map(toExportRow)                               // pure, Money only
        acc.addAll(rows); writer.writeRows(rows)
        if page.length < 1000: break
      CLOSE income_export
      acc.assertEquals(summary)                                    // count and three Σ; mismatch → 500, file discarded
    )
    return writer.finish()                                          // bytes, sent with Content-Length
  ```
- **Time Complexity**:
  - Best: O(log N + n) for the preflight index range scan, plus O(n) for the cursor when n is small and sorts in memory.
  - Average: O(n log n) for one sort of the result, plus O(n) to fetch and encode.
  - Worst: O(n log n) at the cap (an external merge sort if the result exceeds `work_mem`, ≈ 10 MB at 50k rows).
- **Space Complexity**: O(P) rows in the app (P = 1,000), the encoded output O(bytes), and O(n) in the DB sort (spilling to disk is allowed).
- **Data Structures**: a portal (the cursor), the page array, a `Reconciler` (count plus three `Money` accumulators), and the writer's chunk list.
- **Pros**: the order is exactly the spec's, including NULLS LAST, with one sort and no dependence on the planner. Memory is bounded by the page. The preflight and the rows share a snapshot, so the Summary equals the row sums by construction (and the `Reconciler` re-proves it). The cap is refused before any byte is produced. No new dependency: plain SQL. Bind parameters in `DECLARE` **verified 2026-11-10** with `pg` against the dev database.
- **Cons**: a pattern new to the repo. It holds one pooled connection and one transaction for the whole export (≈ 0.1-5 s), and the connection is idle in the transaction while TypeScript encodes a page.
- **Best For**: one-shot ordered scans of bounded size.
- **Worst For**: paging across requests (cursors are per transaction).

#### Option 3D: Streaming with `pg-query-stream` / Kysely `.stream()`
- **Approach**: configure the Kysely Postgres dialect with `pg-cursor` and iterate rows.
- **Time Complexity**: same as 3C.
- **Space Complexity**: O(batch).
- **Data Structures**: a Node stream.
- **Pros**: idiomatic streaming.
- **Cons**: a new dependency (`pg-cursor`) and a change to the shared dialect configuration that affects every module. No behavioural advantage over 3C.
- **Best For**: many streaming consumers.
- **Worst For**: one feature.

**Output transport (applies to 3B-3D)**: stream bytes to HTTP as rows arrive, or **spool** the encoded output and send it once complete (chosen). Spooling costs ≤ ≈ 10 MB at the cap. In exchange it guarantees that no partial file is ever delivered (any failure after the preflight is a clean 5xx with the JSON error body instead of a truncated download). It also gives an exact `Content-Length`, and the Next proxy (architecture lane) stays a simple pass-through. True streaming is listed under Optimization Opportunities and only becomes worth it if the cap rises well past 50k.

### Decision D4: Row shape, encoding and reconciliation

#### Option 4A: CSV with detail rows plus trailing summary lines
- **Approach**: append "Total,…" lines after the data rows in the CSV.
- **Time Complexity**: O(n).
- **Space Complexity**: O(1) extra.
- **Data Structures**: none.
- **Pros**: totals are visible in a CSV.
- **Cons**: breaks imports, filters and pivot tables (the summary looks like data). Breaks AC-INTEGRATION-3 (the "Payments" sheet must equal the CSV). The summary columns do not match the row columns.
- **Best For**: printouts.
- **Worst For**: accounting imports.

#### Option 4B: CSV is a pure table. XLSX has an identical "Payments" sheet plus a "Summary" sheet. One format-agnostic row builder and one text-cell encoder serve both writers (chosen)
- **Approach**: `toExportRow(dbRow)` produces typed cells: `text`, `money`, `date` (ISO text) and `flag`. Each writer only serialises typed cells. Neutralisation happens in the shared text-cell encoder, so both formats carry identical text.
- **Time Complexity**: O(n · c) with c = 11 columns.
- **Space Complexity**: O(P) for the page, plus the output.
- **Data Structures**: `ExportRow` (a tuple of typed cells in column order) and `ColumnSpec[]`.
- **Pros**: parity by construction. The period label goes in the file name and the Summary sheet (AC-HAPPY-7). The CSV stays importable.
- **Cons**: a CSV user gets no totals inside the file (the XLSX has them, and the docs say so).
- **Best For**: both consumers.
- **Worst For**: nothing relevant.

#### Option 4C: Format-specific builders (CSV and XLSX each shape rows)
- **Approach**: each writer reads the DB row and shapes its own cells.
- **Time Complexity**: O(n · c).
- **Space Complexity**: O(P).
- **Data Structures**: two shapers.
- **Pros**: each format can be tuned.
- **Cons**: two code paths that can drift (AC-INTEGRATION-3 would catch the drift late), and the neutralisation rule would be duplicated.
- **Best For**: formats that genuinely differ.
- **Worst For**: parity.

## Complexity Comparison

### D1 (periods)
| Metric | 1A ad-hoc | 1B generic (chosen) | 1C SQL |
|--------|-----------|---------------------|--------|
| Time (Best/Avg/Worst) | O(1) | O(1) | O(1) |
| Space | O(1) | O(1) | O(1) |
| Implementation | Simple, duplicated | Simple, single path | Medium + parity test |

### D2 (GST)
| Metric | 2A exact (chosen) | 2B emulate PG | 2C via gstFraction |
|--------|-------------------|---------------|--------------------|
| Time | O(1) | O(1) | O(log bps) |
| Space | O(1) | O(1) | O(1) |
| Implementation | Trivial | Complex | Simple, redundant |

### D3 (read strategy), n = matching rows, N = team's payments, P = 1,000
| Metric | 3A buffer all | 3B keyset | 3C SQL cursor (chosen) | 3D pg-cursor |
|--------|---------------|-----------|------------------------|--------------|
| Time (Best) | O(log N + n) | O(log N + n) | O(log N + n) | O(log N + n) |
| Time (Avg) | O(n log n) | O(n) with incremental sort | O(n log n) | O(n log n) |
| Time (Worst) | O(n log n) | O(n²/P) planner-dependent | O(n log n) | O(n log n) |
| App memory | O(n) | O(P) | O(P) | O(P) |
| Snapshot-consistent with preflight | if in one tx | only in one tx | yes (one RR tx) | yes (one RR tx) |
| Implementation | Simple | Medium (nullable tuple key) | Simple (plain SQL) | Simple + new dependency |

### D4 (encoding)
| Metric | 4A CSV + summary lines | 4B shared typed rows (chosen) | 4C per-format builders |
|--------|------------------------|-------------------------------|------------------------|
| Time | O(n·c) | O(n·c) | O(n·c) |
| Space | O(P) | O(P) | O(P) |
| Implementation | Simple, breaks parity | Simple | Medium, duplicated rules |

## Performance Projection

At the working scale (typical team: 3,100 rows per financial year; busy team: 22,000; cap: 50,000):

| Step | Typical FY (3.1k) | Busy FY (22k) | Cap (50k) | App memory |
|------|-------------------|---------------|-----------|------------|
| Preflight aggregate (index range scan on `(team_id, paid_at)`) | 2-5 ms | 10-20 ms | 20-40 ms | O(1) |
| Cursor: joins (users, registrations, game_sessions, snapshot) + one sort | 10-30 ms | 80-200 ms | 200-500 ms | DB side |
| FETCH 1,000 × ⌈n/1000⌉ round trips | 4 × ~2 ms | 22 × ~3 ms | 50 × ~3 ms | 1 page ≈ 1 MB |
| Row shaping (2 `instantToLocal` per row ≈ 5-10 µs each, memoised per distinct instant) | 30-60 ms | 0.2-0.4 s | 0.5-1 s | O(P) |
| CSV encode (≈ 160 B/row) | 10 ms, 0.5 MB | 60 ms, 3.5 MB | 150 ms, 8 MB | output |
| XLSX encode (library dependent; streaming writer assumed) | 50-150 ms | 0.5-1.5 s | 1.5-4 s, ≈ 3 MB zipped | output + library |
| **Total** | **≈ 0.1-0.3 s** | **≈ 0.5-2 s** | **≈ 1.5-5 s** | **≤ ≈ 15 MB** |

## Decision

**Chosen**:
- **D1 → Option 1B** (a generic N-month cadence anchored on an end month, plus the financial year, with one `LocalDateRange → InstantRange` conversion using `DST_POLICY.DERIVED`).
- **D2 → Option 2A** (`multiplyByRatio(total, bps, 10000 + bps, 'HALF_UP')`).
- **D3 → Option 3C** (preflight aggregate, cap refusal, then a server-side SQL cursor in one REPEATABLE READ READ ONLY transaction, pages of 1,000, output spooled and sent with `Content-Length`).
- **D4 → Option 4B** (a pure CSV table, an XLSX "Payments" sheet identical to it plus a "Summary" sheet, one typed row builder and one text-cell encoder).

**Chosen values**: row cap **50,000** (`INCOME_EXPORT_MAX_ROWS`). Maximum range **2,557 days inclusive, i.e. 7 years** (`INCOME_EXPORT_MAX_RANGE_DAYS`), which changes the spec's proposed 5 years. Fetch page 1,000 (a constant).

### Rationale
- **Periods (1B)**: one modulo formula covers both two-monthly alignments, the Dec-Jan year crossing and six-monthly at no extra cost. One conversion path makes the partition property (each instant in exactly one period) a single test across all cadences. It keeps P3 intact: SQL only sees instants.
- **GST (2A)**: an exact single rounding is provably equal to the column for every allowed input (see the proof in D2, confirmed empirically), and it reuses the reviewed `money.ts` primitive. There is nothing to emulate.
- **Read strategy (3C)**: the spec requires bounded memory, exact deterministic order, refusal-not-truncation and totals that reconcile. The preflight and the cursor share one snapshot, so the Summary (SQL `SUM` of the stored per-payment rounded values, as AC-VERIFY-2 requires) cannot disagree with the rows even while issuance or billing commit concurrently. The cap check happens before any output exists. The cursor gives the spec's exact order with NULLS LAST in one sort, with no dependence on the planner. Keyset (3B) has no advantage here: it also needs one long transaction for the snapshot, and it adds a nullable four-part key plus planner risk.
- **Spooling** buys "never a partial file" and simple proxy semantics for ≤ ≈ 10 MB.
- **Row cap 50,000**: a busy team's full financial year (≈ 22k) fits with more than 2x headroom, and a typical team's whole 7-year retention window (≈ 22k) fits in one export. At the cap the output is ≈ 8 MB of CSV and the export takes ≈ 5 s, inside one request. Above that, XLSX generation time and the Next proxy's buffering start to matter.
- **Range limit 7 years (2,557 days)**: the cap, not the range, is the resource guard. The range limit exists to refuse obviously wrong input at once with no database hit, and 7 years matches the IRD record-keeping period (productBrief), so an admin can export the whole retention window when the row count allows. Any 7 consecutive years contain at most 2 leap days (7×365+2 = 2,557), so any 7 consecutive financial years are accepted. The spec's 5 years would refuse a legitimate full-retention export with no performance benefit.
- **Encoding (4B)**: parity between CSV and XLSX holds by construction, and the neutralisation rule exists in exactly one place.

### Trade-offs Accepted
- **One pooled connection is held per export for its duration** (≤ ≈ 5 s at the cap). It is acceptable at a handful of concurrent exports. Mitigations: `SET LOCAL statement_timeout` and `SET LOCAL idle_in_transaction_session_timeout` on the export transaction (30 s defaults) so a stuck export cannot pin a connection. A per-process export semaphore is listed as an optimization if it is ever needed.
- **Up to ≈ 15 MB of spooled output per concurrent export** in the api process. Fine at the expected concurrency. It is bounded because the cap bounds the output.
- **A CSV carries no totals or period label inside the file.** The file name carries the period. The XLSX Summary carries the totals and the label. `docs/getting-started.md` says so.
- **XLSX money cells are IEEE doubles.** Every value with ≤ 15 significant digits round-trips exactly (99,999,999.99 has 10), so the stored decimal is what Excel shows. The conversion lives in one declared function with a round-trip test, and it is the single, named exemption from the P2 source scan.
- **Dates are ISO `YYYY-MM-DD` text in both formats, not Excel date serials.** The cost is that Excel's date filters treat them as text. In return, CSV/XLSX parity is exact, there is no locale-dependent parsing (`dd/mm/yyyy` in a CSV is misread by US-locale Excel), and there are no serial-number time-zone pitfalls. ISO text still sorts correctly.
- **Six-monthly is offered in the helper and, as a recommendation, in the UI.** Its exact months for non-March balance dates are not modelled (only the Mar/Sep preset), and Custom range covers the rest.

## Implementation Details

### Assumptions about the parallel lanes (to reconcile; I do not own these)
- **Architecture**:
  - A frozen invoice snapshot exists per issued payment (assumed `payment_invoices` keyed by `payment_id`, with `buyer_name`, `description`, `document_kind`, `invoice_number`). The export LEFT JOINs it.
  - **Precedence rule**: when a payment has an issued document, the export's payer-name and description cells come from the snapshot (so the export matches the invoice). Otherwise they come from the live `users.full_name`, the game, and `registrations.status` (`WITHDRAWN` → late-withdrawal wording), built by the **same** `describePayment()` function the document model uses.
  - The displayed number uses the architecture's formatter for the document kind (`formatInvoiceNumber` → `INV-000123`, or a receipt prefix if H2's follow-up adds one).
  - The XLSX library must offer a row-at-a-time (streaming) writer, or the cap must be re-derived from the measured memory per row.
  - Whether the CSV gets a UTF-8 BOM is the architecture's H7 call. **My recommendation is to include the BOM**, because team admins open the file in Excel and macrons otherwise become mojibake. The writer takes `bom: boolean`.
  - Route names, the Next proxy and the options read are the architecture's.
- **UI/UX** owns the form, the option labels, the default selection and the post-download state. This document supplies the lists and the `defaultGstPeriod` helper.
- **User Journey** owns the end-to-end flows. Nothing here constrains them beyond the refusal semantics.

### Data Structures
| Structure | Purpose | Operations Used |
|-----------|---------|-----------------|
| `LocalDateRange { from, to }` (inclusive) | what labels and validation speak | construct O(1), `diffLocalDays` O(1) |
| `InstantRange { from, to }` (half-open) | the SQL filter | `toInstantRange` O(1) |
| `GstCadence { months: 1\|2\|6; anchorEndMonth }` + presets `TWO_MONTHLY_ODD {2,1}`, `TWO_MONTHLY_EVEN {2,2}`, `SIX_MONTHLY_MAR_SEP {6,3}` | period arithmetic | `periodContaining` / `periodEndingIn` O(1) |
| `PeriodDescriptor { kind, range, label, fileStem }` | file name and Summary label | O(1) |
| `ExportRow` (typed cell tuple) / `ColumnSpec[]` | the format-agnostic row | build O(c) |
| `Reconciler { count, Σtotal, Σgst, Σsubtotal }` (`Money`) | proves rows equal the preflight | `add` O(1) per row |
| `IncomeExportWriter` | library-agnostic output | `begin`, `writeRows`, `finish` |
| SQL cursor `income_export` | ordered paged read | FETCH O(P) |

### Shared API (`packages/shared/src/tax/periods.ts`, barrel `tax/index.ts`)
```ts
export interface LocalDateRange { readonly from: LocalDate; readonly to: LocalDate }   // inclusive
export interface InstantRange   { readonly from: Date; readonly to: Date }             // [from, to)

export interface GstCadence { readonly months: 1 | 2 | 6; readonly anchorEndMonth: number }
export const GST_CADENCES = {
  TWO_MONTHLY_ODD:  { months: 2, anchorEndMonth: 1 },  // ends Jan, Mar, May, Jul, Sep, Nov (31 March balance date)
  TWO_MONTHLY_EVEN: { months: 2, anchorEndMonth: 2 },  // ends Feb, Apr, Jun, Aug, Oct, Dec
  SIX_MONTHLY_MAR_SEP: { months: 6, anchorEndMonth: 3 }, // ends Mar, Sep
} as const;
export type GstCadenceId = keyof typeof GST_CADENCES;  // wire values: '2m-odd' | '2m-even' | '6m-mar-sep' mapped in api/invoices.ts

export function financialYear(startYear: number): LocalDateRange;          // 1 Apr startYear .. 31 Mar startYear+1
export function financialYearOf(date: LocalDate): number;                  // start year
export function formatFinancialYear(startYear: number): string;            // '2026-27'
export function parseFinancialYear(label: string): number;                 // '2026-27' → 2026; rejects '2026-28', year < 2000
export function gstPeriodContaining(date: LocalDate, cadence: GstCadence): LocalDateRange;
export function gstPeriodEndingIn(yearMonth: string, cadence: GstCadence): LocalDateRange; // 'YYYY-MM'; INVALID_PERIOD_END if not an end month
export function previousGstPeriod(period: LocalDateRange, cadence: GstCadence): LocalDateRange; // UI default helper
export function toInstantRange(range: LocalDateRange, timeZone?: string): InstantRange;    // DST_POLICY.DERIVED at 00:00
export function inclusiveDays(range: LocalDateRange): number;              // to - from + 1
export function listFinancialYears(input: { today: LocalDate; yearsWithPayments: readonly number[] }): number[]; // desc, ∪ current
export function listGstPeriods(input: { today: LocalDate; firstPaidDate: LocalDate | null; cadence: GstCadence; maxRangeDays: number }): LocalDateRange[]; // desc
export function describePeriod(request: ResolvedPeriodRequest): PeriodDescriptor;
```
`time.ts` gains one small, P3-neutral export: `diffLocalDays(a: LocalDate, b: LocalDate): number` (UTC epoch-day difference, the same `utcMs` arithmetic as `addLocalDays`).

### Export request and resolution (contract in `packages/shared/src/api/invoices.ts`; route owned by architecture)
**Recommended (a plan change)**: a discriminated query resolved **on the server** with the shared helpers, so an "unknown financial year" is an API 422 as AC-ERROR-3 says and the label in the file is always true:
```
?format=csv|xlsx&period=custom&from=YYYY-MM-DD&to=YYYY-MM-DD
?format=csv|xlsx&period=gst&cadence=2m-odd|2m-even|6m-mar-sep&end=YYYY-MM
?format=csv|xlsx&period=fy&year=2026-27
```
All three kinds become one `LocalDateRange` before any query, so the server still has one range semantics. (Fallback if the architecture keeps `from`/`to` only: the Next layer resolves presets with the same helpers, and the label is recovered with a pure `classifyRange`. A range equal to a financial year or a cadence period is unique, because an end month's parity fixes the alignment.)

**Validation order** (each failure is `422 validation_failed` with field errors; nothing is read before step 6):
1. Strict schema: unknown keys, unknown `format`, `period` or `cadence` → field error.
2. `parseLocalDate` for `from`/`to` (rejects `2027-02-30`). `parseFinancialYear` for `year`. `YYYY-MM` plus `gstPeriodEndingIn` for `end`.
3. `to < from` → `to`: "The end date can't be before the start date".
4. `from > today` → `from`: "The start date can't be in the future" (future-only). A range that ends in the future is allowed and simply contains nothing after now. For `fy` and `gst`, a period whose start is after today is "unknown" for that field.
5. `inclusiveDays > MAX_RANGE_DAYS` → `to`: "Choose a range of 7 years or less".
6. Read the preflight. `count > MAX_ROWS`, or a Σ outside the `Money` range → `422 export_too_large` ("Choose a shorter range").

`today` = `instantToLocal(clock.now()).date`, read once per request.

### Option lists for the form (supplied to the UI; read endpoint per architecture)
- **Financial years** (AC-HAPPY-8: "years that contain at least one PAID payment plus the current one"):
  1. `first = SELECT min(paid_at) FROM payments WHERE team_id=$1 AND status='PAID'`. This is an index-only probe, O(log N).
  2. Candidates are `financialYearOf(first) .. financialYearOf(today)` (≤ 8 in practice). TS computes their `InstantRange`s.
  3. One query: `SELECT i FROM unnest($starts::timestamptz[], $ends::timestamptz[]) WITH ORDINALITY AS c(s, e, i) WHERE EXISTS (SELECT 1 FROM payments WHERE team_id=$1 AND status='PAID' AND paid_at >= c.s AND paid_at < c.e)`. That is O(Y log N).
  4. Pass the result to `listFinancialYears`, which adds the current year and sorts descending.
- **GST periods for a cadence**: contiguous, newest first, from the period containing `firstPaidDate` (or the current period if there is none) to the current period, trimmed to periods starting within `MAX_RANGE_DAYS` of today. That is at most 42 two-monthly entries. Empty periods are listed on purpose (a nil GST return is still a return). **Default selection: `previousGstPeriod(current)`**, the period most recently ended, which is the one being filed. Alignment default: `TWO_MONTHLY_ODD`.
- Server returns `{ today, firstPaidDate, financialYearsWithPayments }`. The lists are computed by the shared helpers so the web and the API cannot disagree. "Today" comes from the API's injected clock, so E2E clock control applies to the form too.

### Export columns (`ColumnSpec`, in order; header text final with UI/UX)
| # | Header | Type | Source | Notes |
|---|--------|------|--------|-------|
| 1 | Invoice number | text | snapshot / `payments.invoice_number` via the architecture formatter | empty for $0.00 and not-yet-issued |
| 2 | Paid date | date (ISO text) | `instantToLocal(paid_at).date` | NZ local |
| 3 | Game date | date (ISO text) | `instantToLocal(game_sessions.starts_at).date` | empty if no registration (subscription rows; none exist) |
| 4 | Payer | text | snapshot `buyer_name`, else `users.full_name` | neutralised |
| 5 | Description | text | snapshot, else `describePayment()` ("Game fee" / "Late withdrawal fee", location, date, guests) | neutralised. Wording is UI/UX's, the function is shared with the document model |
| 6 | Subtotal | money | `payments.subtotal_amount` | stored, never recomputed |
| 7 | GST | money | `payments.gst_amount` | stored |
| 8 | Total | money | `payments.amount` | stored |
| 9 | GST registered | flag | `payments.gst_registered` | `Yes`/`No` |
| 10 | Payment method | text | `billing_type`: `PREPAID_CREDIT` → `wallet`; otherwise `amount > 0` → `bank`; `amount = 0` → empty | H11 neutral wording |
| 11 | Reference | text | `payments.payment_reference` (`SGM` + 8 characters) | **added (plan change)**: not secret (D-89), it is the bank-statement reference, so admins can match bank lines. It is not an Akahu id or a token |

Never selected: `users.email`, any `team_banking` column, `payment_attempts.*`, `akahu_payment_id`, `authorisation_url`, `credit_transactions.*`. A structural test asserts the select list against an allow list.

### Summary sheet (XLSX), from the preflight (equal to the row sums)
Team name (the current `teams.name`, labelled as such), the GST number(s) (distinct non-null `payments.gst_number` in range, formatted per H6, or "Not registered"), the period label and its NZ dates, "Basis: payments received, by paid date. Wallet top-ups are not included." (H4 default made explicit), the generated-at NZ date-time, the row count, the counts of invoiced, $0.00 and awaiting-number rows, Σ Subtotal, Σ GST and Σ Total. Every cell is a value. There are no formulas.

### Text-cell neutralisation (one function, used by both writers)
```
FORMULA_TRIGGERS = { '=', '+', '-', '@', '\t', '\r', '＝' (U+FF1D), '＋' (U+FF0B), '－' (U+FF0D), '＠' (U+FF20) }
neutraliseText(s): return s.length > 0 && FORMULA_TRIGGERS.has(s[0]) ? "'" + s : s
```
- It is applied by **column type**, not by value: to every `text` cell, and never to `money`, `date` or `flag` cells, so a number is never corrupted.
- The trigger set is the OWASP CSV-injection list plus the full-width forms that some spreadsheet locales evaluate.
- Applying it in XLSX too (where string cells are never formulas) keeps the two formats identical and protects a user who re-saves the XLSX as CSV.
- The stored value is unchanged.

**CSV (RFC 4180)**: UTF-8 (optional BOM), CRLF line endings, one header row. A field is quoted when it contains `,`, `"`, CR or LF, or has leading or trailing whitespace, and `"` is doubled inside quotes. Money is `toMoneyString` (`23.00`).

**XLSX**: money cells are numeric with number format `0.00`, written from `xlsxNumberFromMoney(m)`. This is the single declared P2 exemption, in `income-exports/xlsx.ts`, listed by name in the source-scan allow list with its reason. Do not dodge the scan with unary `+`. Dates and text are string cells. No formulas, no external links, no macros, no defined names.

### Writer interface (library-agnostic)
```ts
interface IncomeExportWriter {
  readonly contentType: string;            // text/csv; charset=utf-8 | application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
  readonly extension: 'csv' | 'xlsx';
  begin(meta: PeriodDescriptor & { teamName: string }, summary: ExportSummary): Promise<void>;
  writeRows(rows: readonly ExportRow[]): Promise<void>;     // called once per fetched page, in order
  finish(): Promise<Uint8Array>;                            // complete file; throws → nothing is sent
}
```
The summary is known at `begin` (from the preflight), so a streaming XLSX writer can place the Summary sheet first or last.

**File name**: `income_<team-slug>_<fileStem>.<ext>`. `team-slug` is NFKD with diacritics stripped, `[a-z0-9-]`, at most 40 characters. `fileStem` is `2027-06-01_to_2027-06-15`, `gst_2027-04_to_2027-05` or `fy_2026-27`. Sent as `filename="…"` (ASCII) plus `filename*=UTF-8''…`.

### Algorithm Steps
1. **Validate and resolve** the request into a `LocalDateRange` and a `PeriodDescriptor` (steps 1-5 above). Pure, using `today` from the clock.
2. **Convert** to an `InstantRange` with `toInstantRange` (the one P3 conversion).
3. **Open** a REPEATABLE READ READ ONLY transaction with `statement_timeout` and `idle_in_transaction_session_timeout` (SET LOCAL).
4. **Preflight** the aggregate. Refuse when over the cap or out of range, and roll back with nothing produced.
5. **Begin** the writer with meta and summary.
6. **DECLARE** the cursor, then **FETCH 1000** in a loop. For each page, `toExportRow` (with `instantToLocal` memoised per distinct instant within the export), add it to the `Reconciler`, and pass it to `writer.writeRows`.
7. **Close** the cursor. Assert `Reconciler == summary` (count, Σtotal, Σgst, Σsubtotal) and `Σsubtotal + Σgst == Σtotal`. A mismatch is a 500 and the spool is discarded.
8. **Commit** (read-only), then `finish()`, then respond with 200, `Content-Length`, `Content-Disposition`, `cache-control: no-store`. Log `income_export.generated` with team id, period kind, format and row count only.

### Edge Case Handling
| Edge Case | Handling |
|-----------|----------|
| Payment at 31 Mar 23:59:59.999 NZDT / 1 Apr 00:00 NZDT | `paid_at < to` excludes exactly `2027-03-31T11:00:00Z` from FY 2026-27, and `>= from` includes it in 2027-28 |
| `paid_at` exactly on `to` | excluded (half-open). It belongs to the next period |
| Dec-Jan two-monthly period | the modulo gives the end month Jan, and the start is 1 Dec of the previous year |
| Feb in a leap year | month end = `addLocalDays(firstOfNextMonth, -1)` |
| DST change inside the period | no effect on boundaries. The span is days×24 h ± 1 h. A financial year is always exactly days×24 h (one gap and one overlap) |
| Ties on `paid_at` | `invoice_number ASC NULLS LAST, id ASC` |
| Not-yet-numbered PAID payment | included, number empty, counted "awaiting invoice number" |
| $0.00 PAID | included, all money 0.00, number empty, method empty, counted separately |
| Mixed registration in the period | per-row snapshot. Summary lists distinct GST numbers |
| No rows | header-only CSV. Summary of zeros. 200 |
| Count = cap / cap + 1 | 200 / 422 `export_too_large` |
| Σ beyond `MONEY_MAX` | `parseMoney` OUT_OF_RANGE → 422 `export_too_large` |
| Concurrent issuance or billing commit during the export | invisible. The RR snapshot is fixed at the first query, and the preflight equals the rows |
| Hostile names or locations | `neutraliseText` on text columns. RFC 4180 quoting |
| Subscription `billing_type` row (none can exist) | method `bank` if amount > 0. Game date empty. No crash |

### Error Handling
| Error Condition | Response |
|-----------------|----------|
| Schema, date, ordering, future or range-length failure | `422 validation_failed` with `fieldErrors`. No DB read |
| Unknown or non-end GST month, or unknown FY label | `422 validation_failed` on `end` / `year` |
| Count over the cap, or Σ out of range | `422 export_too_large` ("Choose a shorter range"). Nothing produced |
| `statement_timeout` / `idle_in_transaction` fires | 500 via the error handler. Nothing sent. Logged with the trace id |
| Reconciler mismatch (a bug) | 500, file discarded, error log with counts only (no amounts or names) |
| Writer throws in `finish` | 500, nothing sent |
| Not `TEAM_ADMIN` / other team | 403 before any of the above (the architecture's guard) |

## Performance Expectations

### At Current Scale
- Expected latency: typical financial year ≈ 0.1-0.3 s; busy financial year ≈ 0.5-2 s; GST period ≈ under 100 ms.
- Memory usage: ≈ 1 MB page plus ≤ 4 MB output for a busy financial year.
- Throughput: export frequency is low (around GST due dates). One connection per in-flight export.

### At 10x Scale
- Expected latency: unchanged per export (it is per team and capped). At most ≈ 5 s at the cap.
- Memory usage: ≤ ≈ 15 MB per concurrent export.
- Bottlenecks: XLSX encoding at the cap, pool connections if many admins export at once, and the Next proxy's buffering of a ≈ 8 MB body.

### Optimization Opportunities
- Stream the output to HTTP after the preflight (only if the cap rises well past 50k). It needs an abort-on-error protocol through the Next proxy.
- A per-process export semaphore (for example 2 concurrent; excess answered 429 with Retry-After) if pool pressure ever shows up in metrics.
- A covering partial index `(team_id, paid_at, invoice_number, id) WHERE status = 'PAID'` if the sort shows up in plans. Not needed at these sizes.
- Cache the NZ offset per UTC hour bucket for row shaping (NZ changes on the hour). Only do this inside `time.ts` and keep its single conversion point, and only if profiling shows `Intl` cost.

## Validation Checklist

- [x] Meets latency requirements (single request at the cap; ≈ 5 s budget)
- [x] Meets memory requirements (O(page) rows; ≤ ≈ 15 MB per export)
- [x] Handles all edge cases (table above)
- [x] Scales to expected data size (busy financial year 22k; cap 50k; 7-year range)
- [x] Implementation feasible (plain SQL cursor and bind parameters verified; `money.ts` and `time.ts` reused)
- [x] Respects Guiding Principles and data flow patterns in systemPatterns.md (P1 filter on DB-guaranteed columns; P2 one declared exemption; P3 single conversion point; P5 no writes; P7 env limits)

## Testing Strategy

### Unit Tests
**`packages/shared/src/tax/periods.test.ts`** (pure; injected `today`; the sweep has an explicit `60_000` ms timeout, as in `time.test.ts`)
- Financial year: `financialYear(2026)` = 2026-04-01..2027-03-31. `financialYearOf` for 2027-03-31 → 2026 and for 2027-04-01 → 2027. `formatFinancialYear(1999)` = '1999-00', `(2099)` = '2099-00'. `parseFinancialYear` rejects '2026-28', '2026/27', '26-27' and years before 2000.
- Instants (corrected per Edge Case 1):

  | Local | Instant |
  |-------|---------|
  | FY 2027-28 `from` | `2027-03-31T11:00:00.000Z` (NZDT) |
  | 31 Mar 2027 23:59:59 | `2027-03-31T10:59:59Z`, inside FY 2026-27 |
  | 1 Jun 2027 00:00 NZST | `2027-05-31T12:00:00Z`, the odd boundary Apr-May / Jun-Jul |
  | 1 Dec 2026 00:00 NZDT | `2026-11-30T11:00:00Z`, the odd boundary Oct-Nov / Dec-Jan |
  | 1 Jan 2027 00:00 NZDT | `2026-12-31T11:00:00Z`, the even boundary Nov-Dec / Jan-Feb (DST_VECTORS row 20) |
  | 29 Feb 2028 | inside the even Jan-Feb 2028 period, whose `to` is `2028-02-29T11:00:00Z` |
  | Jan-Feb 2027 | ends 2027-02-28 |
  | Feb 2100 | ends on the 28th. Feb 2000 ends on the 29th |
- Both alignments: for every month of 2026-2028, `gstPeriodContaining` returns a 2-month range ending in the right parity. Dec 2026 under odd → 2026-12-01..2027-01-31. `gstPeriodEndingIn('2027-04', ODD)` → INVALID_PERIOD_END. Six-monthly Mar/Sep: 2026-10-01..2027-03-31.
- DST: periods containing the changeover days in `DST_VECTORS` (2026-09-27, 2027-04-04, 2027-09-26, 2028-04-02) have span `days×24h ∓ 1h`. Every financial year 2026-2035 has span exactly `days×24h`.
- **Partition sweep (property)**: for each cadence and the financial year over 2026-2032, consecutive periods satisfy `to(k) === from(k+1)`. For instants every 15 minutes across each DST weekend, ±1 ms around every boundary, and every hour of 2026-2028, exactly one period of each cadence contains the instant, **and** `instantToLocal(t).date ∈ [range.from, range.to]` ⇔ `t ∈ [from, to)` (this ties the AC's "NZ-local paid date on or between" to the half-open SQL filter).
- Start-of-day property: for every day 2026-2030, `toInstantRange({from: D, to: D}).from` has local date D, and 1 ms earlier has local date D-1. Run with `TZ=UTC` and `TZ=America/New_York` through the existing TZ-independence probe.
- Lists: `listFinancialYears` with no payments → [current]; with payments in 2026 and 2028 at today 2029-05 → [2029, 2028, 2026] (no gap filling). Today `2027-03-31T11:30Z` → current FY 2027-28. `listGstPeriods` covers firstPaid..current, newest first, at most 42 entries. `previousGstPeriod` is the default.
- Validation: 2027-02-30, to < from, from in the future, 2,557 days accepted, 2,558 refused, single-day range accepted.

**`packages/shared/src/nz/gst.test.ts`** (extend)
- AC-HAPPY-10 vectors: 0.01→0.00, 0.50→0.07, 1.00→0.13, 5.00→0.65, 10.00→1.30, 12.00→1.57, 23.00→3.00, 37.00→4.83, and subtotal + GST = total each time. bps 0 → GST 0 and subtotal = total. bps −1, 10001 and 1.5 → INVALID_RATIO. Negative totals round away from zero (−0.50 → −0.07).

**`apps/api/src/modules/income-exports/*.test.ts`** (pure)
- `neutraliseText`: each of the 10 triggers gets a `'` prefix. `"Smith"`, `" =x"` (leading space) and an empty string are unchanged. It is never applied to money cells (a −0.05 money value would stay unprefixed).
- CSV: RFC 4180 quoting for `Hōhepa's, "Club"` with an embedded newline. CRLF. BOM on/off. Macrons survive a UTF-8 round trip. Column order equals `ColumnSpec`.
- `toExportRow`: snapshot precedence vs live values; `$0.00` → empty number and method; PREPAID_CREDIT → `wallet`; late withdrawal wording; no field outside the allow list.
- `Reconciler`: sums with `Money`, and a mismatch throws.
- `xlsxNumberFromMoney`: for every cent 0..10,000, plus 1,000 seeded-random values up to `MONEY_MAX` and `MONEY_MAX` itself, the shortest decimal form of the double equals `toMoneyString` with trailing zeros normalised.

### Integration Tests (real PostgreSQL; `apps/api/test/integration/`)
- **GST parity (`gst-parity.int.test.ts`, or inside the existing billing-money suite)**:
  - Read `pg_get_expr` for `payments.gst_amount` and evaluate **that exact expression text** over `(VALUES …) AS v(amount numeric(10,2), gst_rate_bps smallint)`, so the matrix tests the column's own formula and cannot drift from it.
  - The matrices:

    | Matrix | Rate | Amounts |
    |--------|------|---------|
    | A | 1500 bps | every cent 0..10,000 (AC-VERIFY-1), 1,000 seeded-random cents up to 9,999,999,999, and the edges 2299/2300/2301/4599/4600/4601/`MONEY_MAX` |
    | B, ties | 2000 bps | c ≡ 3 (mod 6) up to 1,000 |
    | B, ties | 10000 bps | every odd cent up to 1,001 |
    | C, rate sweep | every bps 0..10,000 | {1, 3, 7, 23, 46, 1150, 2300, 9,999,999,999} |
    | D, negatives | 1500, 2000, 10000 | −1..−200 cents |
  - Plus real inserted `payments` rows for the AC-HAPPY-10 vectors, read back from `gst_amount` / `subtotal_amount`. Give it an explicit `timeout: 60_000`.
- **`income-exports.int.test.ts`**:
  - **Filter exactness (AC-VERIFY-2)**: the fixture has PAID, PENDING, OVERDUE and FAILED payments, another team's PAID payment, `paid_at` at `from - 1µs`, `from`, `to - 1µs` and `to`, and a wallet top-up. Rows = exactly the expected ids. The Summary equals a direct `SELECT sum(...)`.
  - **Order**: 5 payments sharing one `paid_at` with numbers 3, 1, null, 2 and null (two different ids) come out as 1, 2, 3, then the two nulls by id.
  - **AC-HAPPY-6/7/8 via HTTP**: custom 2027-06-01..15. The GST odd period Apr-May 2027 equals the custom range with the same dates (same row set). FY 2026-27 with payments at `2027-03-31T10:59:59.999Z` (in) and `2027-03-31T11:00:00Z` (out).
  - **Cap**: with `INCOME_EXPORT_MAX_ROWS=5` injected through config, 5 rows → 200 and 6 → 422 `export_too_large`, with no file body.
  - **Snapshot consistency**: start an export, hold it after the preflight (a test hook or `waitForLockWaiters`-style barrier on a second connection), commit a new in-range PAID payment from another connection, then release. The export's rows and Summary exclude it and the Reconciler passes. Run it in both orders (commit before the preflight → included). No sleeps.
  - **XLSX read-back (AC-INTEGRATION-3)**: an independent reader parses the Payments sheet. Cell for cell it equals the parsed CSV (money compared through `toMoneyString(parseMoney(String(cell)))`). The Summary equals the Reconciler. The workbook has no `<f>`, no external links and no `vbaProject`.
  - **Sensitive data (AC-VERIFY-5)**: seeded email, bank and Akahu values never appear in the bytes of either format (raw byte scan).
  - **Options**: FY list = years with payments ∪ current. The first paid date comes from the index-only probe.

### Performance Tests
- No wall-clock assertions (PR #9 lesson). One integration test seeds 50,000 PAID rows for one team (bulk `INSERT … SELECT generate_series`, its own cloned database, `timeout: 120_000`). It asserts a successful CSV and XLSX export and that the heap growth sampled during the export stays below 64 MB, which is load-insensitive. It also records the duration as an informational log line.
- A query-plan test (`EXPLAIN (FORMAT JSON)`) asserts that the preflight uses `idx_payments_team_paid_status` (a range scan, not a seq scan) on the seeded team.

## Next Steps

1. **Phase 1**:
   - Add `gstOfInclusive` / `splitInclusive` to `nz/gst.ts` with the unit vectors, and the parity matrix in an integration file.
   - Create `tax/periods.ts` + `tax/index.ts` + tests, and add `diffLocalDays` to `time.ts`.
   - Add the export query schema (the discriminated union) to `api/invoices.ts`.
   - Add `packages/shared/src/tax/**` to the `vitest.config.ts` coverage include list.
   - Add `INCOME_EXPORT_MAX_ROWS` (50,000) and `INCOME_EXPORT_MAX_RANGE_DAYS` (2,557) to the zod config. Both are positive integers, with upper bounds of 200,000 and 3,660.
2. **Phase 4**:
   - `income-exports/repo.ts`: the preflight and the cursor in one RR READ ONLY transaction.
   - `rows.ts` (`ColumnSpec`, `toExportRow`, `neutraliseText`, `Reconciler`), `csv.ts`, and `xlsx.ts` (the declared money exemption plus the source-scan allow-list entry).
   - The route: validation order, 422s, spool, headers.
   - The options read. The integration tests above. `income-exports/**` added to coverage.
3. Fix the AC-HAPPY-8 and AC-VERIFY-3 wording (1 April 00:00 is NZDT), change AC-ERROR-3's "5 years" to "7 years", and add the Reference column to AC-HAPPY-6's column list.
4. ADR 0021: record the cap, the range limit, the read strategy, the neutralisation rule, the XLSX number exemption and the GST-period sources below.

## Sources (IRD)
- [IRD-1] Inland Revenue, archived legislative commentary, "Part II — Goods and Services Tax Amendment Act (No 2) 1988" (PIB 174, May 1988): category A two-monthly periods end Jan/Mar/May/Jul/Sep/Nov, category B end Feb/Apr/Jun/Aug/Oct/Dec. https://www.taxtechnical.ird.govt.nz/pib-reviews/archived-legislative-commentary/gst/part-ii-goods-and-services-tax-amendment-act-no-2-1988. *Archived. Use for the month sets only, not the category labels or thresholds.*
- [IRD-2] Inland Revenue Tax Technical, "Aligning provisional tax payments with GST" (Taxation (Depreciation, Payment Dates Alignment, FBT and Miscellaneous Provisions) Act 2006): "a March balance date taxpayer who accounts for GST on a two-monthly basis (ending January, March, May, July, September, and November)". https://www.taxtechnical.ird.govt.nz/new-legislation/act-articles/taxation-depreciation-payment-dates-alignment-fbt-and-miscellaneous-provisions-act-2006-2006-no-3-/aligning-provisional-tax-payments-with-gst
- [IRD-3] Inland Revenue, "Changing your GST filing frequency" (current): monthly is compulsory over $24 million; two-monthly is open to anyone under $24 million; six-monthly is open to anyone under $500,000; "You must align your GST filing frequency with your income tax balance date … In most cases this will be 31 March." https://www.ird.govt.nz/gst/changing-your-filing-frequency-or-accounting-basis/changing-your-gst-filing-frequency
- Not retrieved: the current text of GST Act 1985 s15 (legislation.govt.nz returned 403). The accountant should confirm the current statutory wording as part of AC-VERIFY-9.
