# Algorithm Decision: NZ bank-account validation, IRD/GST number validation, paid-session rule

**Created**: 2026-10-16
**Status**: DECIDED
**Decision Type**: Algorithm
**Task**: team-banking-and-gst (Level 3)
**Covers**: Creative Exploration Needed Q1 (bank-account tables and policy), Q2 (IRD range and the GST/IRD relationship), Q5 (definition of a paid session)

## Summary of decisions

| Question | Chosen | One line |
|---|---|---|
| Q1 source | IRD *Payroll Calculations & Business Rules Specification 2026-27* §7 | A current IRD document (24 Mar 2026) holds the bank-ID table, all eight weight rows and three worked examples. It replaces the unreachable 2014 RWT/NRWT spec. |
| Q1 branch policy | **Check bank ID only, no branch ranges** | IRD's own 2026 rule. The 2014 branch ranges would reject real branches today (Westpac 03 now runs to branch 7355; the 2014 table stopped at 1999). |
| Q1 unknown bank | **Reject as unrecognised** | No algorithm is defined for an unknown bank, so there is nothing to check against. New bank IDs are rare and appear in IRD's annual April update. |
| Q1 suffix storage | **Pad to 3 digits** (`BB-bbbb-AAAAAAA-SSS`) | IRD says the suffix is right-justified and zero-filled, so `00` and `000` are the same account. Each account gets one stored form. |
| Q1 `last4` | **Last 4 digits of the 7-digit account base** | `01-0902-0068389-00` shows `ending 8389`, not `8900`/`9000`. Uses the existing `deriveBankAccountLast4` on the account part only. |
| Q2 range | **10,000,000 to 200,000,000 inclusive** | Stated by both 2026-27 IRD specifications and the IRD notice of 10 Feb 2026. python-stdnum's 150,000,000 limit is out of date. |
| Q2 check digit | Use the secondary weights **only when the primary result is 10** | This is the step text in both IRD documents. One IRD worked example (150000026) contradicts it and is treated as an erratum. |
| Q2 GST vs IRD | **One number: the GST number.** No separate IRD-number field | IRD: "Your GST number will be the same as your IRD number." This is data minimisation under the Privacy Act. Needs spec-owner sign-off; if refused, fall back to the spec default. |
| Q5 paid rule | **Paid when any fee column that applies to `pricing_structure` is > 0**; `custom_player_rate` and `calculated_rate_per_player` don't count | This matches what billing charges (`unit_fee` comes from `s.fee_*`). The SQL function fails closed on an unknown structure. |

---

## Primary-source research log (2026-10-16)

| # | Source | URL | Status | What it confirmed |
|---|---|---|---|---|
| S1 | Inland Revenue, *Payroll Calculations & Business Rules Specification, 1 April 2026 to 31 March 2027*, v1.0, dated 24 March 2026 (cover marked "[EXTERNAL IN-CONFIDENCE]" but publicly downloadable) | https://www.ird.govt.nz/-/media/project/ir/home/documents/digital-service-providers/software-providers/payroll-calculations-business-rules-specifications/payroll-calculations-and-business-rules-specification.pdf?modified=20260401012317 | **Fetched and read** (text extracted locally from the PDF) | §6 / §6.1 IRD number validation (p. 97–98): range `< 10-000-000 or > 200-000-000` invalid, primary weights 3,2,7,6,5,4,3,2, secondary 7,4,3,2,5,2,7,6, second-10 invalid, worked examples 49091850, 35901981, 150000026 (see erratum), 9125568. **§7 Bank account number validation (pp. 99–103)**: field sizes, bank-ID → algorithm table, AB rule ("below 00990000 → A, otherwise B"), weight table A–G and X with moduli, the E/G digit-folding rule, worked examples for A, D and G. Change log V0.2 (3 Nov 2025): "6.1 Updated IRD number upper limit". |
| S2 | Inland Revenue, *Payday Filing File Upload Specification, 1 April 2026 to 31 March 2027*, v1.1 (July 2026) | https://www.ird.govt.nz/-/media/project/ir/home/documents/digital-service-providers/iir-file-upload-specification/payday-filing-file-upload-specification-2026-2027.pdf?modified=20260713005039 | **Fetched and read** | §5.8 IRD number validation (pp. 66–68): identical steps and range. Its Example 3 is **136410132**: primary result 10, secondary gives 2, matches. This is consistent with the step text. Change log V0.1 18/09/2025 "Added new section on IRD number validation". |
| S3 | Inland Revenue news, "Increase to IRD number validation upper limit", 10 Feb 2026 | https://www.ird.govt.nz/updates/news-folder/2026/increase-to-ird-number-validation-upper-limit | **Fetched** | "The maximum valid IRD number will increase from 150,000,000 to 200,000,000." "They will remain 9 digits." It says nothing about a change to the check-digit algorithm, and says the change is part of IRD's annual updates. |
| S4 | Inland Revenue, "Register for GST" (last updated 14 Sep 2026) | https://www.ird.govt.nz/gst/registering-for-gst/register-for-gst | **Fetched** | "Your GST number will be the same as your IRD number." |
| S5 | Payments NZ, Bank Branch Register, edition 25 Sep 2026 (CSV, ~2,200 rows, updated monthly) | https://www.paymentsnz.co.nz/resources/industry-registers/bank-branch-register/ (CSV: `.../download/csv/`) | **Fetched and summarised by bank** (not stored) | Active bank IDs are exactly 01, 02, 03, 04, 05, 06, 08, 10–25, 27, 30, 31, 38, 88. That is the **same set as the S1 table**. Example branch spans: 01 = 0001–6150, 03 = 0031–7355, 04 = 2014–2024, 05 = 8884–8889, 10 = 5165–5169, 38 = 9000–9499, 88 = 8800–8805. Terms of use were **not read**, and we do not redistribute the register. |
| S6 | IRD RWT/NRWT Specification 2014 / 2019 (the source the spec assumed) | `www.classic.ird.govt.nz/resources/.../2019+RWT-NRWT+Specification+v1.0.pdf` (from the Spectrum.Ird README, MIT) | **Not reachable** (host `classic.ird.govt.nz` no longer resolves: ENOTFOUND) | Superseded by S1 for our purposes. |
| X1 | `stdnum` npm 1.11.3 `src/nz/bank.ts` (port of python-stdnum; it cites "RWT/NRWT spec 2014, pp. 10 and 11") | https://app.unpkg.com/stdnum@1.11.3/files/src/nz/bank.ts | Read for cross-checking only. **No code copied.** | Its 18-position weight rows A–G and X and moduli are **identical** to S1. Its 2014 branch ranges include banks 09 (E), 26/28/29 (G), 33 (F) and 35, which are no longer in S1 or S5. It lacks banks 04, 05, 10 and 88. It caps bank 01 at 1899 and bank 03 at 1999, while S5 shows 01 up to 6150 and 03 up to 7355. |
| X2 | python-stdnum `stdnum.nz.ird` (LGPL) and the `nz-ird-validator`/`weird` libraries | arthurdejong.org (fetch blocked by a bot wall; seen through search snippets only) | Cross-check only | Range `10,000,000 < n < 150,000,000`, which is out of date compared with S1–S3. Same weights. |
| X3 | Oracle HCM 25D readiness note | https://docs.oracle.com/en/cloud/saas/readiness/hcm/25d/hure-25d/25D-hr-wn-f42077.htm | Fetched | "now set from 10-000-000 to 200-000-000". Agrees with S1–S3. |

### What could not be confirmed

1. **The 2014 IRD RWT/NRWT spec itself** (the spec's assumed source) is offline. It is no longer needed: S1 is newer and is the document IRD currently maintains.
2. **IRD Example 3 in S1 (150000026) contradicts S1's own step text.** The primary sum is 17, so the primary check digit is 11 − 6 = 5 (not 10). Under the steps, the number goes straight to the comparison (5 ≠ 6) and is **invalid**. The example instead runs the secondary weights because of the mismatch. S2 (a later edition, July 2026) gives the same steps with a consistent Example 3 (136410132), and S3 announces no algorithm change. **Treated as an erratum in S1.** Not confirmed with IRD. Optional follow-up: ask IRD through the gateway support portal.
3. **S1's formatted-number rows in bank Examples 1 and 3 show 19 digits** (an extra trailing suffix digit). The sums printed under them use exactly 18 terms, and both examples reproduce with 18 positions (176 and 30). These are layout typos.
4. **Algorithms C, E and G have no bank in the current table.** S1 notes that "Algorithm C is not currently used by the banks". E and G are only used by the bank IDs that dropped out after 2014. Their weights are still published, so we transcribe them, but only the weighted-sum function can reach them.
5. **Payments NZ register licence/terms**: not read. Irrelevant to the chosen design (we only use bank IDs, which S1 also publishes).
6. **What Akahu expects as the payout account format** (2- or 3-digit suffix): not researched; this belongs to wallet-and-akahu-billing. Padding to 3 digits loses nothing, because the 2-digit form can be recovered by dropping a leading `0` when it is present.

---

## Problem Statement

Three pure functions, used by both the web Server Action and the API (`packages/shared/src/nz/*`), and one SQL twin:

1. `parseNzBankAccount(input)`: normalise, check the shape, check the bank, check the weighted modulus. Returns the canonical form and display parts, or a reason code.
2. `parseIrdNumber(input)`: normalise, check the shape, the range and the mod-11 check (primary, then secondary when the primary result is 10). Returns canonical digits or a reason code. Used for the GST number.
3. `isPaidSession(fees)` (`apps/api/src/modules/team-banking/publish-gate.ts`) and `game_session_is_paid(...)` (SQL): must agree on every input.

## Inputs & Outputs

### Inputs
| Name | Type | Size/Range | Source |
|---|---|---|---|
| Account number | `string` (untrusted form text) | 15–16 digits plus separators. Zod caps it at 40 chars before parsing | Banking form / `PUT /banking` |
| GST number | `string` | 8–9 digits plus separators. Zod caps it at 20 chars | GST form / `PUT /gst` |
| Session fees | `{ pricingStructure: PricingType; feeFlat … feeAdvanced: Money \| null }` | 7 nullable `Money` values, each within ±99,999,999.99 | Caller (session-scheduling-engine) / `game_sessions` row |

### Outputs
| Name | Type | Description |
|---|---|---|
| `NzBankAccountResult` | `{ ok: true; value: NzBankAccount } \| { ok: false; reason: 'required' \| 'format' \| 'unknown_bank' \| 'check_digit' }` | `NzBankAccount = { canonical: 'BB-bbbb-AAAAAAA-SSS'; bank; branch; account; suffix; algorithm; last4 }` |
| `IrdNumberResult` | `{ ok: true; value: IrdNumber } \| { ok: false; reason: 'required' \| 'format' \| 'range' \| 'check_digit' }` | `IrdNumber` is a branded string of canonical digits (no leading zero, 8 or 9 digits) |
| `isPaidSession` | `boolean` | True when any fee that applies is > 0.00 |

Reason codes map to `BANKING_FIELD_MESSAGES` in `packages/shared/src/api/team-banking.ts`. The validators never build a message, so no message can echo what was typed (AC-VERIFY-3).

### Edge Cases
1. Empty or whitespace only: `required`.
2. Wrong group lengths (`1-902-68389-0`, the 3-digit branch in IRD's own example `01-902-0068389-00`) or 14 or 17 bare digits: `format`. The copy asks for `00-0000-0000000-00`, so we do not right-justify short groups.
3. Non-ASCII digits (Arabic-Indic or full-width), letters, `+`, `.`, `/`: `format`.
4. Mixed separators (`01 0902-0068389 00`): accepted. Separator runs are any of ASCII space/tab, `-`, U+2010–U+2015 (dashes pasted from documents) and U+2212.
5. Bank `26` with digits valid under G (IRD Example 3): `unknown_bank`, because bank 26 is no longer in the table.
6. Base exactly 990000 on an AB bank: algorithm B. Base 989999: algorithm A.
7. Bank 31: algorithm X, always valid.
8. Account base `0000000`: no special case; the result depends on the algorithm. IRD does not forbid it.
9. GST `049-091-850` and `49-091-850`: both canonicalise to `49091850`.
10. GST number check-valid but out of range (`09999996`, `200000005`): `range`.
11. Paid rule: fees set on a structure that does not apply never count. A negative fee counts as not paid (see Q5).

## Constraints

### Performance Requirements
- **Maximum latency**: irrelevant at this scale. Each validator does about 18 integer multiply-adds after an O(L) scan of an input of at most 40 chars, so it runs in well under 1 µs. The gate is 3 comparisons. The binding constraint is correctness, not speed.
- **Throughput**: banking saves happen a few times per team per year.
- **Memory / bundle**: the module ships in `@sgm/shared`, which the web app imports. A table of 28 bank entries plus 8 weight rows is under 1 KB. A full branch register would be 30–60 KB of data and would need a monthly refresh (Q1 Option 3).

### Scale Requirements
- Data: one account and one GST number per team. Fee matrix of about 120 rows in tests.
- Growth: none that matters. Over time the inputs change (new bank IDs, the IRD upper limit), not their volume. **Maintenance cadence is the real scale factor**: IRD republishes both specs every April.

### Other Constraints
- P1: the SQL function and CHECKs are the backstop. P2: `isPaidSession` uses `Money`/bigint only. No `parseFloat`/`toFixed`/`Math.round`.
- Isomorphic: no Node APIs in `packages/shared/src/nz/*`.
- No LGPL/GPL code copied. Tables are transcribed from S1, which states facts (numbers), not code.
- Vectors must trace to S1/S2 or to hand arithmetic shown in this document (AC-INTEGRATION-3).

---

## Q1: NZ bank-account validation

### Algorithm (common to all options)

From S1 §7: the account is laid out as bank (2), branch (4), **account base (8)** and **suffix (4)**, each right-justified and zero-filled, giving 18 digits. With our 7-digit account input that is `bank + branch + "0" + account + suffix.padStart(4, "0")`, which equals the spec's `bank + branch + "0" + account + "0" + suffix3`. Algorithm X has modulus 1. For E and G, each product is replaced by its digit sum, applied twice (49 → 13 → 4). The sum must be ≡ 0 (mod 11 for A–E, mod 10 for F and G).

Weight table, transcribed from S1 p. 101 (identical to X1):

| Alg | Bank | Branch | Account base (8) | Suffix (4) | Mod | Fold | Used by (S1 table) |
|---|---|---|---|---|---|---|---|
| A | 0 0 | 6 3 7 9 | 0 0 10 5 8 4 2 1 | 0 0 0 0 | 11 | no | AB banks, base < 990000 |
| B | 0 0 | 0 0 0 0 | 0 0 10 5 8 4 2 1 | 0 0 0 0 | 11 | no | AB banks, base ≥ 990000 |
| C | 3 7 | 0 0 0 0 | 9 1 10 5 3 4 2 1 | 0 0 0 0 | 11 | no | none ("not currently used") |
| D | 0 0 | 0 0 0 0 | 0 7 6 5 4 3 2 1 | 0 0 0 0 | 11 | no | 08 |
| E | 0 0 | 0 0 0 0 | 0 0 0 0 5 4 3 2 | 0 0 0 1 | 11 | yes | none today (was 09) |
| F | 0 0 | 0 0 0 0 | 0 1 7 3 1 7 3 1 | 0 0 0 0 | 10 | no | 25 |
| G | 0 0 | 0 0 0 0 | 0 1 3 7 1 3 7 1 | 0 3 7 1 | 10 | yes | none today (was 26, 28, 29) |
| X | all 0 | | | | 1 | no | 31 |

Bank-ID table (S1 pp. 99–100, matching the S5 register of 25 Sep 2026 exactly): **AB** for 01, 02, 03, 04, 05, 06, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 27, 30, 38, 88. **D** for 08. **F** for 25. **X** for 31.

```
function parseNzBankAccount(input):
    s = input.trim()
    if s == "": return fail("required")
    groups = s.split(/[\s\-‐-―−]+/)
    if groups.length == 1 and /^[0-9]{15,16}$/: bank, branch, account, suffix = s[0:2], s[2:6], s[6:13], s[13:]
    elif groups.length == 4 and lengths are (2,4,7,2|3) and all /^[0-9]+$/: bank, branch, account, suffix = groups
    else: return fail("format")
    entry = NZ_BANK_IDS[bank] ?? return fail("unknown_bank")
    alg = entry == "AB" ? (int(account) < NZ_AB_THRESHOLD ? "A" : "B") : entry
    if not weightedSumOk(alg, bank + branch + "0" + account + suffix.padStart(4, "0")): return fail("check_digit")
    suffix3 = suffix.padStart(3, "0")
    return ok({ canonical: bank-branch-account-suffix3, bank, branch, account, suffix: suffix3, algorithm: alg,
                last4: deriveBankAccountLast4(account) })   // account base only

function weightedSumOk(alg, digits18):          // exported for the function-level vectors (C, E, G)
    { weights, modulus, fold } = NZ_BANK_ALGORITHMS[alg]
    sum = Σ i in 0..17: p = weights[i] * digit(i); fold ? digitSum(digitSum(p)) : p
    return sum % modulus == 0
```

(`deriveBankAccountLast4` lives in `apps/api/src/lib/crypto/crypto.ts`, but `packages/shared` can't import from `apps/api`. The shared module computes `account.slice(-4)` itself, and the API keeps calling `deriveBankAccountLast4(parsed.account)` when writing the column. Both give the same result. The architecture agent decides where the helper lives.)

### Option 1: 2014 IRD table with per-bank branch ranges (spec default)
- **Approach**: transcribe bank → (algorithm, branch ranges[]) from the 2014 spec (pp. 10–11). Reject a branch outside its bank's ranges.
- **Time**: O(1); a range scan over at most 4 ranges per bank. **Space**: O(B·R) ≈ 60 ranges.
- **Pros**: matches the spec as written; catches some branch typos for B, D and F banks, whose branch digits are not weighted.
- **Cons**: **the source is offline (S6)**, so the transcription could only come from LGPL-derived secondary code (forbidden). **It is provably stale**: the S5 register has live branches outside the 2014 ranges (01 up to 6150 against a cap of 1899; 03 up to 7355 against a cap of 1999), and live banks 04, 05, 10 and 88 have no 2014 entry. A team at Westpac branch 03-7355 or China Construction Bank 05 would be **blocked from setting up payouts**, and there is no workaround in the UI.
- **Best for**: nothing current. **Worst for**: any bank that has opened branches since 2014.

### Option 2: Bank-ID table from the current IRD spec; no branch ranges (**chosen**)
- **Approach**: S1's 28-entry bank → algorithm table, the AB rule, and the 8 weight rows. The branch must be 4 digits and is otherwise unchecked. This is what IRD itself now specifies: "The actual branch numbers in use change from time to time, and are included in the Bank Branch Register, which gets updated monthly."
- **Time**: Best/Avg/Worst O(L), where L ≤ 40 input chars; the modulus step is 18 fixed operations. **Space**: O(1), about 1 KB of constants.
- **Pros**: an authoritative, current, reachable source with worked examples; cross-checked against S5; no stale branch data to block real accounts; the table changes only when a bank ID changes, which is rare (the newest IDs 05, 10 and 88 date from the 2010s). For the AB banks (25 of 28 IDs, covering ANZ, BNZ, Westpac, ASB, Kiwibank and TSB), algorithm A weights the branch digits (6, 3, 7, 9), so most branch typos still fail the check for typical accounts (base < 990000).
- **Cons**: a typo in the branch of a B, D or F account (base ≥ 990000, bank 08, bank 25), or one that happens to keep the A sum ≡ 0, passes. The "bank or branch not recognised" message can only fire for the bank.
- **Best for**: a settings form where a false reject is a hard block and a false accept is caught later by the bank or Akahu at payout.
- **Worst for**: a use that needs the branch to exist (for example showing the branch name). We have none.

### Option 3: Snapshot of the Payments NZ register (exact branch set) plus a refresh script
- **Approach**: generate `bank-branches.generated.ts` from the S5 CSV (about 2,200 `BB-bbbb` keys, or compressed contiguous ranges). Reject a branch that is not in the set. A `scripts/refresh-bank-branches.ts` regenerates it monthly.
- **Time**: O(1) set lookup. **Space**: O(N), N ≈ 2,200 keys, which is 30–60 KB in the shared bundle (or about 300 compressed ranges at roughly 3 KB).
- **Pros**: the strongest typo detection; it would allow showing the branch name.
- **Cons**: a new operational duty (a monthly refresh that nobody will own until billing exists); the register's terms of use weren't reviewed (S5), and we would be redistributing it; any new branch is blocked until the next refresh; it adds bundle size to the web app. All of that for marginal value: a branch typo that lands on another real branch still passes, and Akahu verifies the account at payout anyway.
- **Best for**: a payments product doing direct credits itself. **Worst for**: this feature, where "configured" means "well-formed" (spec Scope, Out of scope).

### Option 4: Accept any bank ID on the check digit alone (guess AB for unknown banks)
- **Approach**: like Option 2, but an unknown bank falls back to the AB rule (or X).
- **Pros**: never blocks a new bank.
- **Cons**: applying an algorithm the bank doesn't use is wrong, not lenient. A new bank on its own algorithm would fail anyway, while a mistyped bank ID (`32` for `12`) would be accepted when the AB maths happens to pass. The X fallback disables the check entirely.
- **Rejected.**

### Complexity Comparison (Q1)

| Metric | Opt 1 (2014 ranges) | Opt 2 (bank ID, IRD 2026) | Opt 3 (register snapshot) | Opt 4 (no bank table) |
|---|---|---|---|---|
| Time (best/avg/worst) | O(L) / O(L) / O(L) | O(L) / O(L) / O(L) | O(L) / O(L) / O(L) | O(L) |
| Space | ~60 ranges | 28 + 8×18 ints | ~2,200 keys | 8×18 ints |
| False-reject risk (real account) | **High** (proven) | Low (new bank ID only) | Medium (new branch until refresh) | None |
| False-accept risk (typo) | Low–medium | Medium for B/D/F branches | Low | Medium–high |
| Maintenance | Unsourceable | Annual (each April, with IRD's spec) | Monthly | None |
| Implementation | Medium | **Simple** | Medium + script | Simple |

### Unknown bank or branch added after the source date
- **Branch**: never rejected (Option 2), so new branches are always accepted.
- **Bank ID**: **rejected as `unknown_bank`**. Reasons: (a) there is no algorithm to apply (Option 4 shows guessing is wrong); (b) bank IDs change about once every few years and S1 is reissued every April; (c) the failure is explicit and support can diagnose it ("bank or branch not recognised"), unlike a silent mis-validation. The data module records its source edition (see Data shape), and the annual review (Next Steps) is the mitigation.
- **Legacy IDs** (07, 09, 26, 28, 29, 33, 35): rejected. They are absent from both S1 and S5.

### Suffix storage
**Pad to 3 digits.** S1 §7: "values are right justified, and the fields padded with zeroes". Suffix `00` and `000` are the same account. The full number is write-only after save (never shown back), so storing it "as typed" has no UX value, while a single canonical form gives one representation per account. That helps any future comparison, a payment file, and the `last4` derivation. If Akahu needs a 2-digit suffix, the payout adapter strips one leading zero when the suffix is `0SS` (wallet-and-akahu-billing's call). This reverses the spec default ("2-digit suffix is not padded in storage").

### `bank_account_last4`
**The last 4 digits of the 7-digit account base**, so `01-0902-0068389-00` gives `8389`.
- The spec default (last 4 digits of the whole string) gives `8900` for `…-00` and `9000` for `…-000`: the same account shows two different values, and half the digits are suffix zeros the admin won't recognise. People identify NZ accounts by the account base; the suffix tells sub-accounts apart (00 cheque, 01 savings). The trade-off is that two sub-accounts of one base show the same `ending 8389`. That's acceptable: it's a recognition hint, not an identifier.
- Implementation: `deriveBankAccountLast4(parsed.account)`. The existing helper is reused unchanged and its existing tests stay valid. Only its input changes, from the whole number to the account base.

### Decision (Q1)

**Chosen**: Option 2, the bank-ID table and weights from IRD *Payroll Calculations & Business Rules Specification 2026-27* §7 (S1), cross-checked against the Payments NZ Bank Branch Register of 25 Sep 2026 (S5). No branch ranges. Unknown bank IDs are rejected. The suffix is stored padded to 3 digits. `last4` is taken from the account base.

**Rationale**: it is the only option whose source is current, reachable and authoritative. It is IRD's own present-day rule. It is the only option that does not demonstrably block real NZ accounts. Its residual weakness (branch typos on B, D and F accounts) is covered downstream by Akahu and the bank at payout.

**Trade-offs accepted**:
- Branch typos on non-A accounts pass. Mitigation: the account name and `ending {last4}` shown after save; the change-notification email (Q8, architecture); live verification in wallet-and-akahu-billing.
- A new bank ID is blocked until the table is updated. Mitigation: annual review, a one-line data change, and a clear error.
- AC-ERROR-2's "branch outside that bank's ranges" case disappears (see Spec Amendments).

---

## Q2: IRD/GST number

### Algorithm (S1 §6.1 = S2 §5.8)

```
function parseIrdNumber(input):
    s = input.trim(); if s == "": fail("required")
    digits = s.replace(/[\s\-‐-―−]/g, "")
    if not /^[0-9]{8,9}$/.test(digits): fail("format")
    n = Number(digits)                                  // ≤ 999,999,999 < 2^53: exact; integer, not money
    if n < IRD_NUMBER_MIN or n > IRD_NUMBER_MAX: fail("range")     // 10,000,000 … 200,000,000 inclusive
    canonical = String(n)                               // strips one leading zero: "049091850" → "49091850"
    base8 = canonical.slice(0, -1).padStart(8, "0"); supplied = canonical.at(-1)
    c = mod11(base8, [3,2,7,6,5,4,3,2])
    if c == 10: c = mod11(base8, [7,4,3,2,5,2,7,6]); if c == 10: fail("check_digit")
    return c == supplied ? ok(canonical) : fail("check_digit")

mod11(base8, w): r = Σ base8[i]*w[i] mod 11; return r == 0 ? 0 : 11 − r
```

Complexity: O(L) for L ≤ 20 chars, then 16 fixed multiply-adds; constant space.

### Range options
| Option | Bounds | Evidence | Verdict |
|---|---|---|---|
| R1 python-stdnum / older libraries | 10,000,000 < n < 150,000,000 (exclusive) | X2; IRD's *old* limit | **Rejected.** It would reject valid numbers issued above 150M, which IRD says it is now issuing ("already issued range", S1/S3). Test: `150000009` must pass. |
| R2 IRD 2026-27 | 10,000,000 ≤ n ≤ 200,000,000 | S1, S2 (identical text: "< 10-000-000 or > 200-000-000 then the number is invalid"), S3, X3 | **Chosen.** |
| R3 no upper bound (8–9 digits + check digit) | n ≥ 10,000,000 | none | Rejected. It would avoid the annual update, but departs from IRD's published rule and from AC-ERROR-6. The extra false accepts are negligible either way. R2 wins on conformance, and its maintenance happens alongside Q1's annual review. |

Constants: `IRD_NUMBER_MIN = 10_000_000`, `IRD_NUMBER_MAX = 200_000_000` with a source comment naming S1 §6.1 and the 10 Feb 2026 notice. The comparison is inclusive at both ends. Neither bound itself passes the check (10000000 → computed 9; 200000000 → computed 5), so inclusive versus exclusive is unobservable except through these tests.

### Secondary-weight trigger: step text vs S1 Example 3
| Option | Rule | Consequence |
|---|---|---|
| T1 (**chosen**) | Use the secondary weights only when the primary result is 10 (S1 and S2 step text; S2 Example 3 136410132; X1, X2) | 150000026 is **invalid** (primary 5 ≠ 6). |
| T2 | Use the secondary weights whenever the primary doesn't match (S1 Example 3 only) | 150000026 valid. Every number gets two chances, which roughly doubles the share of random typos accepted (~1/11 to ~2/11). It contradicts the normative steps in both documents. |

T1 is chosen. The 150000026 vector is recorded in the test suite as **rejected**, with a comment citing this document's erratum note, so the interpretation is pinned and visible. If IRD confirms T2, it's a one-line change plus that vector.

### GST number vs IRD number

S4: "Your GST number will be the same as your IRD number." Schema: `gst_number varchar(20)` plaintext, `ird_number` encrypted.

| Option | Shape | Privacy | Product fit | Complexity |
|---|---|---|---|---|
| G1 two independent fields (spec default) | `gst_number` plaintext (required when registered); `ird_number` encrypted, optional | For a registered team the two hold the **same value**, so encrypting `ird_number` protects nothing (the plaintext copy sits next to it, and it is printed on every invoice anyway). For an unregistered team, `ird_number` is often **a person's own IRD number** (a club run by one organiser) and is collected with **no consumer in this product**. | Matches the wording of PRODUCT-OVERVIEW §8 | Two validators wired, a decrypt on every GST page load (for `ending 182`), mismatch states (IRD ≠ GST) that are errors by definition |
| G2 **one field: the GST number** (chosen) | `gst_number` plaintext, canonical digits; `ird_number` not written by this feature (remains NULL) | Collects only what an invoice needs (Privacy Act 2020 IPP 1, data minimisation). The value is public by design once registered. | Tax invoices need the "GST registration number" and nothing else. A non-registered supplier issues no tax invoice, so an IRD number on its receipts has no legal function. GST *branch* registrations, where a number can differ from the entity's IRD number, still work, because what we store is the number to print. | Simplest: one validator call, no decrypt on read, no mismatch state |
| G3 one field, IRD number primary, GST derived | Admin enters "IRD number" once; it is stored encrypted in `ird_number`, and when registered it is copied to `gst_number` | The same plaintext copy as G1 once registered; encryption only while unregistered, for a value nothing uses | Wrong for GST branches | Copy logic and a decrypt when toggling |

**Chosen (pending spec-owner sign-off at reconciliation)**: **G2**. The form has `This team is registered for GST` and `GST number` (the UI agent may add "(this is your IRD number)" as helper text). `ird_number` is left NULL and unused. The column, its envelope CHECK and its redaction stay in place, so a future feature that truly needs an encrypted IRD number can use them without a migration.
**Fallback if the spec owner keeps §8's two inputs**: G1 exactly as the spec specifies. Both fields use `parseIrdNumber`.
**Assumptions deferred to others**: whether `gst_number` is cleared when GST is turned off (spec AC-HAPPY-6 keeps it) is an architecture/UX call. The algorithm side is indifferent.

### Canonical GST number form
**Digits, numeric value, no leading zero**: `049-091-850` and `49 091 850` both store `49091850`. Display groups in threes from the right: `49-091-850`, `136-410-132`. This matches IRD forms ("8 digit numbers start in the second box") and AC-VERIFY-7's `49-091-850`. The DB CHECK tightens to `^[1-9][0-9]{7,8}$` so a zero-padded duplicate form can't be written by raw SQL.

### Decision (Q2)
**Chosen**: R2 (inclusive 10,000,000 to 200,000,000, named constants), T1 (secondary only when the primary result is 10), G2 (single GST number; no IRD-number field), canonical digits without a leading zero.
**Trade-offs accepted**: IRD will raise the upper limit again someday, so this is an annual review item. G2 departs from the wording of PRODUCT-OVERVIEW §8 and needs explicit sign-off.

---

## Q5: Paid-session rule

### Grounding
- `game_sessions` (migration `20260929000600000`): `fee_flat`, `fee_male`, `fee_female`, `fee_other`, `fee_beginner`, `fee_intermediate`, `fee_advanced`, `custom_player_rate`, `calculated_rate_per_player` (all `numeric(10,2)`, nullable, **no non-negative CHECK**). The BY_SEX CHECK requires male, female and other to be non-null.
- Billing (platform-foundation algorithm, `bill-session` handler): `unit_fee from s.fee_*` with a basis from `pricing_structure`. `payment_line_items.applied_basis` is tied to the structure by CHECK. **Billing never reads `custom_player_rate` or `calculated_rate_per_player`.**
- PRODUCT-OVERVIEW §4: `calculated_rate_per_player` is the suggestion `ceil((court + extras) / max_players)`; the "editable rate field … is used to generate payment requests". In the schema that final rate has to land in the fee columns for billing to charge it.
- Purpose of the gate: **money must have somewhere to go**. A session needs payout banking exactly when billing could produce a positive charge.

### Options

#### Option P1: Fee columns that apply to `pricing_structure`, paid when any is > 0 (**chosen**)
- **Approach**: `FLAT → {fee_flat}`, `BY_SEX → {fee_male, fee_female, fee_other}`, `BY_SKILL_LEVEL → {fee_beginner, fee_intermediate, fee_advanced}`. NULL counts as 0. Paid when any applicable fee is > 0.00.
- **Time/Space**: O(1), at most 3 comparisons.
- **Pros**: the same rule as billing, so the gate is exact (no false block, no false pass with respect to what will be charged). Stale fees on an inapplicable structure (an admin switched from BY_SEX to FLAT) don't block a free session.
- **Cons**: depends on session-scheduling-engine writing the editable rate into the fee columns (a contract recorded in ADR 0016).

#### Option P2: Any of the 7 fee columns > 0, regardless of structure
- **Pros**: conservative. **Cons**: a free FLAT session with leftover `fee_male = 17.00` from an earlier BY_SEX edit is blocked, which contradicts AC-VERIFY-8 ("a fee for an inapplicable structure never makes a session paid"). It doesn't match billing. **Rejected.**

#### Option P3: P1 plus `custom_player_rate` (and/or `calculated_rate_per_player`) > 0
- **Pros**: anticipates a scheduling engine that stores the final rate only in `custom_player_rate`.
- **Cons**: billing wouldn't charge that rate, so the gate would demand banking for a session that bills $0.00. `calculated_rate_per_player` is only a suggestion (always > 0 when costs exist, even for a deliberately free session), so including it would block legitimate free sessions. If the scheduling engine wants billing to read `custom_player_rate`, both billing and the gate must change together, which the parity test enforces. **Rejected; recorded as the change path.**

#### Option P4: P1, but "≠ 0" (negative counts as paid)
- **Pros**: fail-closed on nonsense data. **Cons**: a negative fee produces no payout (nothing flows to the team), so it isn't the gate's job. Negative fees are a data-validity problem that a `fee_* >= 0` CHECK should prevent (recommended to session-scheduling-engine, which owns fee editing). **Rejected for the gate**; the parity matrix pins negative = not paid in both languages.

### Complexity Comparison (Q5)
| Metric | P1 | P2 | P3 | P4 |
|---|---|---|---|---|
| Time | O(1), ≤ 3 compares | O(1), 7 | O(1), ≤ 4–5 | O(1), ≤ 3 |
| Matches billing | **Yes** | No | No | Yes except negatives |
| AC-VERIFY-8 compatible | Yes | No | Yes | Yes |

### Decision (Q5)
**Chosen**: P1.

```ts
// apps/api/src/modules/team-banking/publish-gate.ts
type FeeKey = 'feeFlat' | 'feeMale' | 'feeFemale' | 'feeOther' | 'feeBeginner' | 'feeIntermediate' | 'feeAdvanced';
export type SessionFees = { readonly pricingStructure: PricingType } & { readonly [K in FeeKey]: Money | null };
const APPLICABLE_FEES: Readonly<Record<PricingType, readonly FeeKey[]>> = {   // Record ⇒ a new enum value is a compile error
  FLAT: ['feeFlat'],
  BY_SEX: ['feeMale', 'feeFemale', 'feeOther'],
  BY_SKILL_LEVEL: ['feeBeginner', 'feeIntermediate', 'feeAdvanced'],
};
export function isPaidSession(fees: SessionFees): boolean {
  return APPLICABLE_FEES[fees.pricingStructure].some((k) => { const v = fees[k]; return v !== null && gt(v, ZERO); });
}
```

```sql
-- Same rule as isPaidSession (parity-tested). Not STRICT: NULL fees are meaningful (= 0).
-- Unknown structure → true (fail closed: demands banking rather than silently passing).
CREATE FUNCTION game_session_is_paid(
  pricing_structure pricing_type, fee_flat numeric, fee_male numeric, fee_female numeric, fee_other numeric,
  fee_beginner numeric, fee_intermediate numeric, fee_advanced numeric) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE pricing_structure
    WHEN 'FLAT'           THEN coalesce(fee_flat, 0) > 0
    WHEN 'BY_SEX'         THEN coalesce(fee_male, 0) > 0 OR coalesce(fee_female, 0) > 0 OR coalesce(fee_other, 0) > 0
    WHEN 'BY_SKILL_LEVEL' THEN coalesce(fee_beginner, 0) > 0 OR coalesce(fee_intermediate, 0) > 0
                               OR coalesce(fee_advanced, 0) > 0
    ELSE true
  END $$;
```

`numeric(10,2)` can't hold sub-cent values, and `Money` is integer cents, so `> 0` and `> 0n` agree exactly. No rounding site exists.

**Contract for ADR 0016 (session-scheduling-engine)**: the rate an admin saves (the suggestion or the edited value) must be written to the fee column(s) that apply to the chosen structure. `custom_player_rate` and `calculated_rate_per_player` are informational. If billing is ever changed to read another column, `isPaidSession`, `game_session_is_paid` and the parity fixture change in the same PR. Recommended (not in this feature): `CHECK (fee_* >= 0)` on `game_sessions` and `recurring_session_rules`.

### Parity fixture matrix (AC-VERIFY-8)
One fixture module (for example `apps/api/test/fixtures/paid-session-matrix.ts`) imported by the unit test (TS) and the integration test (SQL, evaluated in **one** query via `unnest`/`VALUES`, about 120 rows in one round trip). Values are `MoneyString` literals. TS parses them with `parseMoney`; SQL casts them with `::numeric(10,2)`.

| Block | Rows | Construction | Expected (literal, hand-written rule, not derived from the code) |
|---|---|---|---|
| M1 single fee | 3 structures × 7 columns × {NULL, `0.00`, `0.01`, `-0.01`, `99999999.99`} = **105** | Only one column set; the rest NULL | `paid = (column ∈ APPLICABLE[structure]) AND value ∈ {0.01, 99999999.99}` |
| M2 all applicable zero, one inapplicable large | 3 | e.g. FLAT, `fee_flat = 0.00`, `fee_male = 99999999.99` | false |
| M3 all NULL | 3 | | false |
| M4 one applicable 0.01, others 0.00 | 3 (BY_SEX uses `fee_other` as the paid one, to prove `fee_other` counts) | | true |
| M5 BY_SEX table-valid zeros | 1 | `fee_male = fee_female = fee_other = 0.00` (satisfies the BY_SEX CHECK) | false |
| M6 mixed negative/positive | 2 | BY_SKILL_LEVEL `-5.00, 0.00, 0.01` → true; `-5.00, 0.00, 0.00` → false | as stated |

Assertions: TS = expected, SQL = expected, TS = SQL on every row. An integration subset (M2, M4, M5, plus a FLAT paid row) also runs through the real `game_sessions` trigger. BY_SEX table rows must set all three sex fees because of the CHECK.

---

## Performance Projection

| Function | Expected latency | Memory |
|---|---|---|
| `parseNzBankAccount` | < 1 µs | ~1 KB constants |
| `parseIrdNumber` | < 1 µs | constant |
| `isPaidSession` / `game_session_is_paid` | < 1 µs / negligible in the trigger | constant |

At 10x (or 1000x) scale nothing changes: the validators are per-request and O(1). The only "bottleneck" is data staleness, which the annual review handles.

## Implementation Details

### Data shape (`packages/shared/src/nz/bank-account.ts`)
```ts
/**
 * NZ bank account validation tables.
 * Source: Inland Revenue, "Payroll Calculations & Business Rules Specification, 1 April 2026 to
 * 31 March 2027", v1.0 (24 March 2026), section 7 "Bank account number validation", pp. 99-103:
 * bank ID → algorithm table, the AB rule, and the weight table. Transcribed by hand. Bank IDs
 * cross-checked against the Payments NZ Bank Branch Register, edition 25 Sep 2026. No branch ranges:
 * IRD defers branch validity to that monthly register (see creative doc
 * team-banking-and-gst-nz-validation-algorithm.md, Q1). Review every April when IRD republishes.
 */
export const NZ_BANK_SOURCE = {
  document: 'IRD Payroll Calculations & Business Rules Specification 2026-27 v1.0, s7 pp.99-103',
  bankIdsCrossChecked: 'Payments NZ Bank Branch Register 2026-09-25',
} as const;

export type NzBankAlgorithm = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'X';
interface AlgorithmSpec { readonly weights: readonly number[]; readonly modulus: 1 | 10 | 11; readonly foldDigits: boolean }
// 18 weights each: bank(2) branch(4) account base(8) suffix(4). Asserted length 18 by a unit test.
export const NZ_BANK_ALGORITHMS: Readonly<Record<NzBankAlgorithm, AlgorithmSpec>> = { /* rows from the table above */ };

export const NZ_AB_THRESHOLD = 990_000; // "below 00990000 then apply algorithm A, otherwise apply algorithm B"
export const NZ_BANK_IDS: Readonly<Record<string, 'AB' | 'D' | 'F' | 'X'>> = {
  '01': 'AB', '02': 'AB', '03': 'AB', '04': 'AB', '05': 'AB', '06': 'AB', '08': 'D',
  '10': 'AB', '11': 'AB', '12': 'AB', '13': 'AB', '14': 'AB', '15': 'AB', '16': 'AB', '17': 'AB',
  '18': 'AB', '19': 'AB', '20': 'AB', '21': 'AB', '22': 'AB', '23': 'AB', '24': 'AB', '25': 'F',
  '27': 'AB', '30': 'AB', '31': 'X', '38': 'AB', '88': 'AB',
};
```
Look up with `Object.hasOwn(NZ_BANK_IDS, bank)` (no prototype keys). The weights are small integers, not money, so P2 doesn't apply.

### `packages/shared/src/nz/ird-number.ts`
`IRD_NUMBER_MIN`, `IRD_NUMBER_MAX`, `IRD_PRIMARY_WEIGHTS`, `IRD_SECONDARY_WEIGHTS` as `as const` arrays, each with a source comment (S1 §6.1 and S2 §5.8; the 10 Feb 2026 notice). `formatIrdNumber(canonical)` groups in threes from the right.

### Algorithm Steps
1. Trim and check for empty → `required`.
2. Split on separator runs or strip separators → shape check → `format`.
3. Bank: table lookup → `unknown_bank`. IRD: numeric range → `range`.
4. Weighted modulus → `check_digit`.
5. Build the canonical form and display parts.

Order matters for the copy: format → bank/range → check digit. Each failure returns one reason; the first failing step wins.

### Edge Case Handling
| Edge case | Handling |
|---|---|
| IRD-style short groups `01-902-0068389-00` | `format` (we require 2-4-7-2/3; the copy shows that format) |
| 2-digit suffix | Padded to 4 for the sum, stored padded to 3 |
| Base 990000 on an AB bank | B |
| Bank 08 with base ≥ 990000 | D (the AB rule applies only to AB banks) |
| Bank 31 | X, valid |
| Legacy bank 09/26/28/29/33/35/07 | `unknown_bank` |
| GST `049091850` | Canonical `49091850` |
| GST 9 digits above 200M | `range` |
| GST primary and secondary both 10 | `check_digit` |
| Fees for an inapplicable structure | Ignored |
| Negative fee | Not paid (both languages) |
| Unknown `pricing_structure` in SQL | Paid (fail closed); TS can't reach this (compile-time `Record`) |

### Error Handling
| Error condition | Response |
|---|---|
| Any validator failure | `{ ok: false, reason }` → zod `superRefine` adds the copy-deck message for that reason under the field; 422 `validation_failed` |
| Non-string input | zod rejects before the validator runs |
| The validator throwing | Not expected (no I/O, no parsing that throws); a bug surfaces as a 500 via the normal handler |

## Validation Checklist
- [x] Meets latency requirements (sub-microsecond)
- [x] Meets memory requirements (~1 KB)
- [x] Handles all edge cases above
- [x] Scales to expected data size
- [x] Implementation feasible (pure TS + one SQL function)
- [x] Respects P1 (SQL twin + CHECKs), P2 (`Money` only in the gate), P4 (no value in reasons/messages/logs)

## Testing Strategy

### Bank-account vectors (each traced; none produced by the validator)
Sums use the 18-position layout. "IRD Ex n" = S1 §7 worked example n. "Hand" = arithmetic shown here, checked against the S1 weight table.

| # | Input | Alg | Trace | Expected |
|---|---|---|---|---|
| A1 | `01-0902-0068389-00` | A | IRD Ex 1: branch 9·3+2·9=45; base 6·5+8·8+3·4+8·2+9·1=131; 176 = 11×16 | valid, last4 `8389`, canonical `01-0902-0068389-000` |
| A2 | `12-3040-0123455-00` | A | Hand: branch 3·6+4·7=46; base 1·10+2·5+3·8+4·4+5·2+5·1=75; 121 = 11×11 | valid |
| A3 | `38-9000-0989999-00` | A (AB boundary, A side) | Hand: branch 9·6=54; base 9·10+8·5+9·8+9·4+9·2+9·1=265; 319 = 11×29. (Under B: 265 ≡ 1) | valid |
| A4 | `01-0111-0990000-00` | B (boundary, B side) | Hand: under B base 9·10+9·5=135 ≡ 3 → invalid; under A it would be 135+19=154 = 11×14 → valid. Proves B is used at exactly 990000 | `check_digit` |
| A-c1 | `01-0902-0068388-00` | A | A1 with last digit −1: 175 ≡ 10 | `check_digit` |
| A-c2 | `01-0902-0068398-00` | A | A1 with 8 and 9 swapped: 177 ≡ 1 | `check_digit` |
| A-c3 | `01-0903-0068389-00` | A | A1 with a branch typo: +9 → 185 ≡ 9 (A weights the branch) | `check_digit` |
| B1 | `38-9000-0990008-00` | B | Hand: 9·10+9·5+8·1=143 = 11×13. (Under A: 197 ≡ 10) | valid |
| B2 | `12-3040-0990008-00` | B | Same base as B1 with a different bank and branch: 143. B ignores the branch | valid |
| B3 | `01-0001-9999993-00` | B | Hand: 9·(10+5+8+4+2)+3·1=264 = 11×24 | valid |
| B-c | `01-0001-9999994-00` | B | 265 ≡ 1 | `check_digit` |
| D1 | `08-6523-1954512-001` | D | IRD Ex 2: 1·7+9·6+5·5+4·4+5·3+1·2+2·1=121 = 11×11 | valid, canonical keeps `001` |
| D2 | `08-6501-1000004-00` | D | Hand: 1·7+4·1=11 | valid |
| D3 | `08-6599-0000701-00` | D | Hand: 7·3+0·2+1·1=22 | valid |
| D4 | `08-6501-0990000-00` | D (no AB rule) | Hand: 9·6+9·5=99 = 11×9. (Under B: 135 ≡ 3) | valid |
| D-c | `08-6523-1954513-001` | D | 122 ≡ 1 | `check_digit` |
| F1 | `25-2500-0000055-00` | F | Hand: 5·3+5·1=20 ≡ 0 (mod 10) | valid |
| F2 | `25-2570-1234569-00` | F | Hand: 1·1+2·7+3·3+4·1+5·7+6·3+9·1=90 | valid |
| F3 | `25-2500-0000055-123` | F | Suffix weight 0 → 20 (3-digit suffix) | valid |
| F-c | `25-2570-1234567-00` | F | 88 ≡ 8 | `check_digit` |
| X1–X3 | `31-2825-1234567-00`, `31-2840-0000001-001`, `31-2830-9999999-99` | X | Modulus 1 (S1 Note 2: "always verifies … to be valid") | valid |
| U1 | `26-2600-0320871-032` | (G) | IRD Ex 3: valid under G (sum 30), but bank 26 is not in the S1 table | `unknown_bank` |
| U2 | `09-0000-0001234-003` | (E) | Valid under E (33) but bank 09 is legacy | `unknown_bank` |
| U3 | `07-0000-0000000-00`, `99-0001-0000001-00` | | Not in the table | `unknown_bank` |
| F-sep | `01 0902 0068389 00`, `010902006838900`, `0109020068389000`, `01–0902–0068389–00` (en dash) | A | Same as A1 | valid, same canonical |
| F-bad | 14 or 17 bare digits, `01-902-0068389-00`, `0l-0902-0068389-00` (letter l), `01-0902-0068389-0000`, `''` | | Shape | `format` / `required` |

Function-level `weightedSumOk(alg, digits18)` vectors for classes no current bank uses:
| # | Digits (as account) | Alg | Trace | Expected |
|---|---|---|---|---|
| G1 | `26-2600-0320871-032` | G | IRD Ex 3: folded products 9,5,6,4,1 + suffix 3,2 = 30 | true |
| G2 | `26-2600-0000001-009` | G | Hand: 1·1 + 9·1 = 10 | true |
| G3 | `29-2150-0000070-006` | G | Hand: 7·7=49→13→4; 6·1=6; 10. A single fold gives 19 and no fold gives 55, both false, so this proves the double fold | true |
| G-c | `26-2600-0320871-033` | G | 31 | false |
| E1 | `09-0000-0001234-003` | E | Hand: 1·5+2·4+3·3+4·2=30; +3·1 = 33 | true |
| E2 | `09-0000-0009999-008` | E | Hand: 45→9, 36→9, 27→9, 18→9 = 36; +8 = 44. Without the fold: 134 ≡ 2 | true |
| E3 | `09-0000-0000011-006` | E | Hand: 1·3+1·2=5; +6 = 11 | true |
| E-c | `09-0000-0009999-009` | E | 45 | false |
| C1–C3 | `01-0000-0000004-00`, `04-0000-0000005-00`, `01-0000-1000003-00` | C | Hand: bank 1·7=7 +4 = 11; bank 4·7=28 +5 = 33; 7 + 1·1 (base pos 2) + 3 = 11 | true |
| C-c | `01-0000-0000005-00` | C | 12 | false |
| W | every row | all | `weights.length === 18`; modulus ∈ {1, 10, 11}; fold only for E and G | structural |

### IRD/GST vectors
| # | Input | Trace | Expected |
|---|---|---|---|
| I1 | `49-091-850` | S1/S2 Ex 1: 154 ≡ 0 → 0 | valid, canonical `49091850` |
| I2 | `35901981` | S1/S2 Ex 2: 142 ≡ 10 → 1 | valid |
| I3 | `136-410-132` | S2 Ex 3: primary 89 ≡ 1 → 10; secondary 75 ≡ 9 → 2 | valid |
| I4 | `9125568` | S1/S2 Ex 4 (below range); 7 digits, so our format step fires first | `format` |
| I5 | `150000009` | Hand: 1·3+5·2=13 ≡ 2 → 9. Above the old 150M limit | valid |
| I6 | `10000009` | Hand: base 01000000: 1·2=2 → 9. Lowest check-valid number ≥ min | valid |
| I7 | `199999990` | Hand: 3 + 9·(2+7+6+5+4+3+2) = 264 ≡ 0 → 0 | valid |
| I8 | `09999996` | Hand: check-valid (primary 243 ≡ 1 → 10; secondary 225 ≡ 5 → 6) but 9,999,996 < 10,000,000 | `range` |
| I9 | `200000005` | Hand: 2·3=6 → 5, check-valid but > 200,000,000 | `range` |
| I10 | `10000051` | Hand: base 01000005: primary 1·2+5·2=12 ≡ 1 → 10; secondary 1·4+5·6=34 ≡ 1 → 10 | `check_digit` (second 10) |
| I11 | `49091851`, `136410133` | Corrupted check digit | `check_digit` |
| I12 | `150000026` | S1 Ex 3 erratum (primary gives 5 ≠ 6; the steps never reach the secondary weights) | `check_digit`, with a comment citing this doc |
| I13 | `049 091 850` | Leading zero + spaces | valid, canonical `49091850` |
| I14 | `1234567890`, `12a45678`, `''` | Shape | `format` / `required` |

### Paid-session tests
The parity matrix above, plus: TS `isPaidSession` never receives `number` (type-level test or lint), and the repo lint rules forbidding `parseFloat`/`toFixed`/`Math.round` pass.

### Performance Tests
None needed; constant-time pure functions.

## Next Steps
1. Phase 1: write `nz/bank-account.ts` and `nz/ird-number.ts` with the data shape above, then the vector suites (RED first), with each vector's source in a `source:` field.
2. Phase 1: write `game_session_is_paid` per the SQL above, then the parity fixture and the single-query SQL evaluation.
3. Phase 3: `isPaidSession` per the TS above; the ADR 0016 contract text (rate written into the fee columns; non-negative CHECK recommendation).
4. Add an **annual April review** item (techContext or ADR 0016 "Maintenance"): re-read IRD §6.1/§7 in the new payroll spec, update `NZ_BANK_IDS`, `IRD_NUMBER_MAX` and the source strings, and compare bank IDs with the current Payments NZ register.
5. Reconciliation: get spec-owner sign-off on G2. If refused, apply only the G1 fallback (no IRD-related amendments).

---

## Spec Amendments

| AC / section | Change |
|---|---|
| Invocation Method, "Account number stored form" | Replace with: canonical `BB-bbbb-AAAAAAA-SSS` (**suffix zero-padded to 3**). Accepted input: four groups 2-4-7-(2\|3) separated by spaces or dashes, or 15/16 bare digits. |
| Invocation Method, "GST number stored as digits only" | Add: canonical numeric digits without a leading zero (8 or 9 digits); displayed in groups of three from the right (`49-091-850`). |
| Invocation Method, publish gate | Add: `custom_player_rate` and `calculated_rate_per_player` never count; negative fees count as not paid; `game_session_is_paid` is `IMMUTABLE`, not `STRICT`, `ELSE true`. Constraint `teams_gst_number_format` becomes `^[1-9][0-9]{7,8}$`. |
| Data persisted, `bank_account_number` / `bank_account_last4` | Number: canonical with a 3-digit suffix. last4: "last 4 digits of the 7-digit **account base** (`deriveBankAccountLast4(parsed.account)`)", e.g. `01-0902-0068389-00` → `8389`. |
| AC-ERROR-1 | "not 2-4-7-2 or 2-4-7-3 digit groups, or 15/16 digits without separators". Short groups such as `01-902-…` are a format error. |
| AC-ERROR-2 | Replace "whose bank code is not in the table or whose branch is outside that bank's ranges" with "whose bank code is not in the IRD 2026-27 bank-ID table (including legacy codes 07, 09, 26, 28, 29, 33, 35)". Branch numbers are not range-checked. |
| AC-ERROR-6 | "outside the accepted range" → "below 10,000,000 or above 200,000,000". |
| AC-VERIFY-1 | `gst_number` raw-SQL rejects also cover a leading-zero value (`049091850`). |
| AC-VERIFY-6 | Source header: "IRD Payroll Calculations & Business Rules Specification 2026-27 v1.0, §7 pp. 99–103; bank IDs cross-checked against the Payments NZ Bank Branch Register 25 Sep 2026" (replaces "RWT/NRWT … pp. 10 and 11, 2014"). Coverage: the classes reachable through the bank table (A, B, D, F, X) at the validator level; **all eight** rows (A–G, X) at the `weightedSumOk` level, including E/G single- and double-fold vectors. Remove "branch just below and above a range". Add "legacy bank IDs rejected" and "IRD Ex 3 (bank 26) is `unknown_bank` at the top level". Vectors as listed in this doc. |
| AC-VERIFY-7 | Range constants `IRD_NUMBER_MIN = 10_000_000`, `IRD_NUMBER_MAX = 200_000_000`, inclusive, sourced to S1 §6.1 / S2 §5.8 / the IRD notice of 10 Feb 2026. Add vectors `35901981`, `150000009`, `10000009`, `199999990` (valid), `09999996` and `200000005` (range), `10000051` (second 10), and `150000026` rejected as a documented erratum. |
| AC-VERIFY-8 | Matrix definition: blocks M1–M6 of this doc (105 single-fee rows over {NULL, 0.00, 0.01, −0.01, 99999999.99} plus 12 combination rows); SQL evaluated in one query; a negative fee is not paid. |
| AC-INTEGRATION-3 | "the cited IRD or Payments NZ document" → "IRD Payroll Calculations & Business Rules Specification 2026-27 §6.1/§7 or the Payday Filing File Upload Specification 2026-27 §5.8 (worked examples), or hand arithmetic recorded beside the vector". |
| **G2, only if the spec owner signs off** | Success Criteria GST section: drop the `IRD number (optional)` field and `ending 182`; drop the two IRD field messages. Response `gst: { gstRegistered, gstNumber \| null }` (drop `irdNumberLast3`). `PUT /gst` body `{ gstRegistered, gstNumber? }`. Data persisted: `ird_number` "not written by this feature (stays NULL)". AC-HAPPY-5: drop the IRD clauses. AC-ERROR-6: drop `fieldErrors.irdNumber`. AC-ERROR-12: drop the GST-section decrypt case. AC-VERIFY-2: three encrypted columns, not four. AC-VERIFY-3: drop "the full IRD number" (keep the logger redaction pattern `irdNumber` as defence in depth). Creative Q7: the IRD last-3 decrypt question disappears. |
| ADR 0016 (AC-VERIFY-14) | Add: the paid rule mirrors billing's `s.fee_*` basis; scheduling must persist the final rate into the applicable fee column(s); recommend `fee_* >= 0` CHECKs (owned by session-scheduling-engine); annual April review of the `nz/*` tables and constants. |
