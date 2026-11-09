/**
 * The A2 status mapping and nothing else: Akahu `status` / `status_reason` to a provider-neutral `GatewayOutcome`.
 * Fixture: `apps/api/test/fixtures/akahu-status-matrix.ts` (vendor-doc-derived, re-read at the Phase 4 gate).
 */
import type { GatewayOutcome } from './gateway.ts';

const NOT_CHARGED: GatewayOutcome = { kind: 'NOT_CHARGED' };
const UNRECOGNISED: GatewayOutcome = { kind: 'UNRECOGNISED' };

const FAILED_REASONS: Readonly<Record<string, GatewayOutcome>> = {
  REJECTED: NOT_CHARGED,
  BANK_ERROR: NOT_CHARGED,
  INTERNAL_ERROR: NOT_CHARGED,
  BANK_ERROR_INDETERMINATE: { kind: 'INDETERMINATE' },
};

export function mapAkahuStatus(status: string, reason: string | null): GatewayOutcome {
  switch (status) {
    case 'READY':
      return { kind: 'OPEN', phase: 'AWAITING_PAYER' };
    case 'AUTHORISED':
    case 'SUBMITTED':
    case 'SETTLEMENT_IN_PROGRESS':
      return { kind: 'OPEN', phase: 'IN_FLIGHT' };
    case 'SENT':
      return { kind: 'SUCCEEDED' };
    case 'CANCELLED':
      return NOT_CHARGED;
    case 'FAILED':
      return (
        (reason !== null && Object.hasOwn(FAILED_REASONS, reason)
          ? FAILED_REASONS[reason]
          : undefined) ?? UNRECOGNISED
      );
    default:
      return UNRECOGNISED;
  }
}
