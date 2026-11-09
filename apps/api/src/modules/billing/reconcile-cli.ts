/**
 * `cli billing reconcile` (wallet-and-akahu-billing Phase 6; AC-VERIFY-12): a read-only SQL check that the wallet ledger and the
 * payments agree, reporting every discrepancy by id. It writes nothing and prints no email, bank detail or Akahu payment id.
 *
 *   - WALLET_BALANCE_SUM:  a wallet's `balance` differs from the sum of its `credit_transactions.amount`;
 *   - WALLET_BALANCE_TAIL: no ledger row of the wallet carries `resulting_balance = balance` (the ledger's last row does);
 *   - LEDGER_CHAIN_BREAK:  a ledger row whose starting balance (`resulting_balance - amount`) cannot be reached from 0.00
 *                          through the wallet's own rows (catches a detached row, and a detached cycle the sum check misses);
 *   - LEDGER_CHAIN_FORK:   a wallet where some balance is left by more or fewer rows than arrive at it (beyond the chain's
 *                          start at 0.00 and its one end), so the rows cannot form one sequence (repeated balances cannot
 *                          hide this, there being no sequence column); one line per unbalanced point;
 *   - DEDUCTION_UNPAID:    an `AUTO_DEDUCTION` with no PAID `PREPAID_CREDIT` payment for the same registration and amount;
 *   - PER_GAME_NO_AKAHU:   a PAID `PER_GAME` payment without an Akahu payment id;
 *   - TOPUP_NO_AKAHU:      a `TOPUP` ledger row without an Akahu payment id.
 *
 * "Latest `resulting_balance`" is found by the balance chain, never by timestamp: `credit_transactions.created_at` is the
 * transaction start time, so two rows of one wallet can share or invert it (Phase 2 note). Top-up holds (HELD intents, CR-15) are
 * listed as informational lines and never affect the exit code.
 */

export interface SqlRunner {
  query(text: string): Promise<{ readonly rows: readonly unknown[] }>;
}

export type DiscrepancyKind =
  | 'WALLET_BALANCE_SUM'
  | 'WALLET_BALANCE_TAIL'
  | 'LEDGER_CHAIN_BREAK'
  | 'LEDGER_CHAIN_FORK'
  | 'DEDUCTION_UNPAID'
  | 'PER_GAME_NO_AKAHU'
  | 'TOPUP_NO_AKAHU';

export interface Discrepancy {
  readonly kind: DiscrepancyKind;
  /** The wallet, ledger row or payment the finding is about. */
  readonly id: string;
  /** Money amounts only (never a person or a bank detail). */
  readonly detail: string;
}

export interface TopUpHold {
  readonly id: string;
  readonly teamId: string;
  readonly amount: string;
  readonly holdReason: string;
  readonly heldAt: string;
}

export interface ReconcileReport {
  readonly discrepancies: readonly Discrepancy[];
  readonly holds: readonly TopUpHold[];
}

interface IdRow {
  readonly id: string;
}
interface BalanceRow extends IdRow {
  readonly balance: string;
  readonly ledger_sum?: string;
}
interface AmountRow extends IdRow {
  readonly amount: string;
}
interface ForkRow extends IdRow {
  readonly at: string;
  readonly leaving: string;
  readonly reaching: string;
}
interface HoldRow extends IdRow {
  readonly team_id: string;
  readonly amount: string;
  readonly hold_reason: string | null;
  readonly held_at: string | null;
}

const SAME_WALLET = `c.user_id = w.user_id AND c.team_id = w.team_id`;

const SQL_BALANCE_SUM = `
  SELECT w.id, w.balance::text AS balance, coalesce(sum(c.amount), 0)::text AS ledger_sum
    FROM player_credits w
    LEFT JOIN credit_transactions c ON ${SAME_WALLET}
   GROUP BY w.id, w.balance
  HAVING w.balance <> coalesce(sum(c.amount), 0)
   ORDER BY w.id`;

const SQL_BALANCE_TAIL = `
  SELECT w.id, w.balance::text AS balance
    FROM player_credits w
   WHERE EXISTS (SELECT 1 FROM credit_transactions c WHERE ${SAME_WALLET})
     AND NOT EXISTS (SELECT 1 FROM credit_transactions c WHERE ${SAME_WALLET} AND c.resulting_balance = w.balance)
   ORDER BY w.id`;

// Each ledger row is a step from `resulting_balance - amount` to `resulting_balance`. The rows of a sound wallet form one
// path from 0.00 to `balance` (an Eulerian path): every step's start is reachable from 0.00 (CHAIN_BREAK) and every balance
// is left as often as it is reached, bar one extra leaving 0.00 and one extra reaching the end (CHAIN_FORK). With the tail
// check (the end is `balance`) these are exact. `UNION` makes the walk terminate: balances are bounded (0.00 to 100.00).
const SQL_CHAIN_BREAK = `
  WITH RECURSIVE reach (user_id, team_id, at) AS (
    SELECT DISTINCT user_id, team_id, 0.00::numeric(10,2) FROM credit_transactions
    UNION
    SELECT c.user_id, c.team_id, c.resulting_balance
      FROM reach r
      JOIN credit_transactions c
        ON c.user_id = r.user_id AND c.team_id = r.team_id AND c.resulting_balance - c.amount = r.at)
  SELECT c.id, c.amount::text AS amount
    FROM credit_transactions c
   WHERE NOT EXISTS (SELECT 1 FROM reach r
                      WHERE r.user_id = c.user_id AND r.team_id = c.team_id
                        AND r.at = c.resulting_balance - c.amount)
   ORDER BY c.id`;

// Shape only: the one sound shape is no unbalanced point, or exactly +1 at 0.00 and -1 at one end. Whether that end equals
// `balance` is the tail check's finding, so a drifted balance is not reported twice.
const SQL_CHAIN_FORK = `
  WITH steps AS (
    SELECT w.id, c.resulting_balance - c.amount AS at, 1 AS leaving, 0 AS reaching
      FROM player_credits w JOIN credit_transactions c ON ${SAME_WALLET}
    UNION ALL
    SELECT w.id, c.resulting_balance, 0, 1
      FROM player_credits w JOIN credit_transactions c ON ${SAME_WALLET}),
  unbalanced AS (
    SELECT id, at, sum(leaving) AS leaving, sum(reaching) AS reaching
      FROM steps
     GROUP BY id, at
    HAVING sum(leaving) <> sum(reaching))
  SELECT u.id, u.at::text AS at, u.leaving::text AS leaving, u.reaching::text AS reaching
    FROM unbalanced u
   WHERE NOT EXISTS (SELECT 1 FROM unbalanced s
                      WHERE s.id = u.id
                     GROUP BY s.id
                    HAVING count(*) = 2
                       AND count(*) FILTER (WHERE s.at = 0.00 AND s.leaving - s.reaching = 1) = 1
                       AND count(*) FILTER (WHERE s.at <> 0.00 AND s.leaving - s.reaching = -1) = 1)
   ORDER BY u.id, u.at`;

const SQL_DEDUCTION_UNPAID = `
  SELECT c.id, c.amount::text AS amount
    FROM credit_transactions c
   WHERE c.transaction_type = 'AUTO_DEDUCTION'
     AND NOT EXISTS (SELECT 1 FROM payments p
                      WHERE p.registration_id = c.registration_id AND p.billing_type = 'PREPAID_CREDIT'
                        AND p.status = 'PAID' AND p.amount = -c.amount)
   ORDER BY c.id`;

const SQL_PER_GAME_NO_AKAHU = `
  SELECT id, amount::text AS amount
    FROM payments
   WHERE billing_type = 'PER_GAME' AND status = 'PAID' AND coalesce(akahu_payment_id, '') = ''
   ORDER BY id`;

const SQL_TOPUP_NO_AKAHU = `
  SELECT id, amount::text AS amount
    FROM credit_transactions
   WHERE transaction_type = 'TOPUP' AND coalesce(akahu_payment_id, '') = ''
   ORDER BY id`;

const SQL_HOLDS = `
  SELECT id, team_id, amount::text AS amount, hold_reason::text AS hold_reason, held_at::text AS held_at
    FROM wallet_top_ups
   WHERE status = 'HELD'
   ORDER BY held_at, id`;

async function rowsOf<T>(db: SqlRunner, text: string): Promise<readonly T[]> {
  return (await db.query(text)).rows as readonly T[];
}

/** Runs every check. Only SELECTs; safe against a live database. */
export async function runBillingReconcile(db: SqlRunner): Promise<ReconcileReport> {
  const discrepancies: Discrepancy[] = [];
  for (const row of await rowsOf<BalanceRow>(db, SQL_BALANCE_SUM)) {
    discrepancies.push({
      kind: 'WALLET_BALANCE_SUM',
      id: row.id,
      detail: `balance=${row.balance} ledger_sum=${row.ledger_sum ?? ''}`,
    });
  }
  for (const row of await rowsOf<BalanceRow>(db, SQL_BALANCE_TAIL)) {
    discrepancies.push({
      kind: 'WALLET_BALANCE_TAIL',
      id: row.id,
      detail: `balance=${row.balance}`,
    });
  }
  for (const row of await rowsOf<ForkRow>(db, SQL_CHAIN_FORK)) {
    discrepancies.push({
      kind: 'LEDGER_CHAIN_FORK',
      id: row.id,
      detail: `at=${row.at} leaving=${row.leaving} reaching=${row.reaching}`,
    });
  }
  const amountChecks: readonly [DiscrepancyKind, string][] = [
    ['LEDGER_CHAIN_BREAK', SQL_CHAIN_BREAK],
    ['DEDUCTION_UNPAID', SQL_DEDUCTION_UNPAID],
    ['PER_GAME_NO_AKAHU', SQL_PER_GAME_NO_AKAHU],
    ['TOPUP_NO_AKAHU', SQL_TOPUP_NO_AKAHU],
  ];
  for (const [kind, text] of amountChecks) {
    for (const row of await rowsOf<AmountRow>(db, text)) {
      discrepancies.push({ kind, id: row.id, detail: `amount=${row.amount}` });
    }
  }
  const holds = (await rowsOf<HoldRow>(db, SQL_HOLDS)).map((row): TopUpHold => ({
    id: row.id,
    teamId: row.team_id,
    amount: row.amount,
    holdReason: row.hold_reason ?? 'unknown',
    heldAt: row.held_at ?? 'unknown',
  }));
  return { discrepancies, holds };
}

/** The terminal report: one line per finding (ids and amounts), informational hold lines, then a summary. */
export function formatReconcileReport(report: ReconcileReport): string[] {
  const lines: string[] = [];
  for (const finding of report.discrepancies) {
    lines.push(`DISCREPANCY ${finding.kind} id=${finding.id} ${finding.detail}`);
  }
  for (const hold of report.holds) {
    lines.push(
      `INFO top-up hold id=${hold.id} team=${hold.teamId} amount=${hold.amount} reason=${hold.holdReason} held_at=${hold.heldAt}`,
    );
  }
  lines.push(
    report.discrepancies.length === 0
      ? `billing reconcile: OK, 0 discrepancies (${report.holds.length} top-up hold(s))`
      : `billing reconcile: ${report.discrepancies.length} discrepancy(ies) (${report.holds.length} top-up hold(s))`,
  );
  return lines;
}

/** 0 when the ledger and payments agree, 1 on any discrepancy. Holds never change it. */
export function reconcileExitCode(report: ReconcileReport): 0 | 1 {
  return report.discrepancies.length === 0 ? 0 : 1;
}
