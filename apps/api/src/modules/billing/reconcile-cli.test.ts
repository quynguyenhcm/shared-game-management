import { describe, expect, it } from 'vitest';
import {
  formatReconcileReport,
  reconcileExitCode,
  runBillingReconcile,
  type ReconcileReport,
  type SqlRunner,
} from './reconcile-cli.ts';

const clean: ReconcileReport = { discrepancies: [], holds: [] };
const dirty: ReconcileReport = {
  discrepancies: [
    { kind: 'WALLET_BALANCE_SUM', id: 'w-1', detail: 'balance=14.00 ledger_sum=13.00' },
    { kind: 'TOPUP_NO_AKAHU', id: 'c-9', detail: 'amount=20.00' },
  ],
  holds: [
    {
      id: 'h-1',
      teamId: 't-1',
      amount: '10.00',
      holdReason: 'INDETERMINATE',
      heldAt: '2026-11-10',
    },
  ],
};

describe('reconcile report formatting and exit code', () => {
  it('prints an OK summary and exits 0 when nothing disagrees', () => {
    expect(formatReconcileReport(clean)).toEqual([
      'billing reconcile: OK, 0 discrepancies (0 top-up hold(s))',
    ]);
    expect(reconcileExitCode(clean)).toBe(0);
  });

  it('prints one line per discrepancy by id, hold lines as information, and exits 1', () => {
    expect(formatReconcileReport(dirty)).toEqual([
      'DISCREPANCY WALLET_BALANCE_SUM id=w-1 balance=14.00 ledger_sum=13.00',
      'DISCREPANCY TOPUP_NO_AKAHU id=c-9 amount=20.00',
      'INFO top-up hold id=h-1 team=t-1 amount=10.00 reason=INDETERMINATE held_at=2026-11-10',
      'billing reconcile: 2 discrepancy(ies) (1 top-up hold(s))',
    ]);
    expect(reconcileExitCode(dirty)).toBe(1);
  });

  it('a hold alone never fails the check', () => {
    expect(reconcileExitCode({ discrepancies: [], holds: dirty.holds })).toBe(0);
  });
});

describe('runBillingReconcile', () => {
  it('maps each query to its kind, only ever issues SELECTs, and tolerates a null hold reason', async () => {
    const statements: string[] = [];
    const db: SqlRunner = {
      query: (text) => {
        statements.push(text);
        if (text.includes('ledger_sum'))
          return Promise.resolve({ rows: [{ id: 'w', balance: '2.00', ledger_sum: '1.00' }] });
        if (text.includes('FROM wallet_top_ups')) {
          return Promise.resolve({
            rows: [{ id: 'h', team_id: 't', amount: '5.00', hold_reason: null, held_at: null }],
          });
        }
        return Promise.resolve({ rows: [] });
      },
    };
    const report = await runBillingReconcile(db);
    expect(report.discrepancies).toEqual([
      { kind: 'WALLET_BALANCE_SUM', id: 'w', detail: 'balance=2.00 ledger_sum=1.00' },
    ]);
    expect(report.holds[0]).toMatchObject({ id: 'h', holdReason: 'unknown', heldAt: 'unknown' });
    // Plain SELECTs or read-only WITH queries (the chain checks); never a write.
    expect(statements.every((text) => /^\s*(SELECT|WITH)\b/i.test(text))).toBe(true);
    expect(statements.some((text) => /\b(INSERT|UPDATE|DELETE)\b/i.test(text))).toBe(false);
    // The ledger tail is found by the balance chain, never by timestamp (created_at is the transaction start).
    expect(statements.some((text) => text.includes('created_at'))).toBe(false);
  });
});
