/**
 * Every documented Akahu One-Off Payment status / status_reason pair and its provider-neutral outcome
 * (wallet-and-akahu-billing A2, architecture Q1a). Replayed by `lib/akahu/status.test.ts` and reused by contract tests.
 *
 * PROVENANCE: vendor-doc-derived. Built from the Akahu Payments documentation as read through the spike digests;
 * not captured from a sandbox. Re-read against the live pages at the Phase 4 gate (A7), where sandbox-real rows join.
 */
import type { GatewayOutcome } from '../../src/lib/akahu/gateway.ts';

export const AKAHU_STATUS_MATRIX_PROVENANCE = 'vendor-doc-derived' as const;

export interface AkahuStatusRow {
  readonly status: string;
  readonly reason: string | null;
  readonly outcome: GatewayOutcome;
  readonly documented: boolean;
}

const open = (phase: 'AWAITING_PAYER' | 'IN_FLIGHT'): GatewayOutcome => ({ kind: 'OPEN', phase });

export const AKAHU_STATUS_MATRIX: readonly AkahuStatusRow[] = [
  { status: 'READY', reason: null, outcome: open('AWAITING_PAYER'), documented: true },
  { status: 'AUTHORISED', reason: null, outcome: open('IN_FLIGHT'), documented: true },
  { status: 'SUBMITTED', reason: null, outcome: open('IN_FLIGHT'), documented: true },
  { status: 'SETTLEMENT_IN_PROGRESS', reason: null, outcome: open('IN_FLIGHT'), documented: true },
  { status: 'SENT', reason: null, outcome: { kind: 'SUCCEEDED' }, documented: true },
  {
    status: 'CANCELLED',
    reason: 'USER_CANCELLED',
    outcome: { kind: 'NOT_CHARGED' },
    documented: true,
  },
  { status: 'CANCELLED', reason: 'EXPIRED', outcome: { kind: 'NOT_CHARGED' }, documented: true },
  { status: 'CANCELLED', reason: null, outcome: { kind: 'NOT_CHARGED' }, documented: true },
  { status: 'FAILED', reason: 'REJECTED', outcome: { kind: 'NOT_CHARGED' }, documented: true },
  { status: 'FAILED', reason: 'BANK_ERROR', outcome: { kind: 'NOT_CHARGED' }, documented: true },
  {
    status: 'FAILED',
    reason: 'INTERNAL_ERROR',
    outcome: { kind: 'NOT_CHARGED' },
    documented: true,
  },
  {
    status: 'FAILED',
    reason: 'BANK_ERROR_INDETERMINATE',
    outcome: { kind: 'INDETERMINATE' },
    documented: true,
  },
  // Unknown pairs: left open and logged, never guessed (A2).
  { status: 'TELEPORTED', reason: null, outcome: { kind: 'UNRECOGNISED' }, documented: false },
  {
    status: 'FAILED',
    reason: 'NEW_BANK_REASON',
    outcome: { kind: 'UNRECOGNISED' },
    documented: false,
  },
];
