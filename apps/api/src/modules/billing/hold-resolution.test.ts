/**
 * The provider gate of a hold resolution (CR-26, H2): the fresh Akahu read is taken first, outside any lock, and a definite
 * provider answer wins over the person's. Table-driven; database effects are proved in
 * `test/integration/hold-resolution.int.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { GatewayOutcome } from '../../lib/akahu/gateway.ts';
import { decideHoldGate, type HoldGate } from './hold-resolution.ts';

type Fresh =
  { readonly kind: GatewayOutcome['kind']; readonly amountMatches: boolean } | 'not_found';

describe('decideHoldGate (CR-26)', () => {
  it.each<['RECEIVED' | 'NOT_RECEIVED', Fresh, HoldGate]>([
    // A SENT for the intent's amount: the provider settles it through the funnel; the manual answer is refused either way.
    ['RECEIVED', { kind: 'SUCCEEDED', amountMatches: true }, 'PROVIDER_APPLIES'],
    ['NOT_RECEIVED', { kind: 'SUCCEEDED', amountMatches: true }, 'PROVIDER_APPLIES'],
    // A SENT for another amount: money did move, so "not received" is refused; "received" goes on with an observed amount.
    ['NOT_RECEIVED', { kind: 'SUCCEEDED', amountMatches: false }, 'PROVIDER_REFUSES'],
    ['RECEIVED', { kind: 'SUCCEEDED', amountMatches: false }, 'PROCEED'],
    // Akahu says definitely not charged: "received" contradicts it; "not received" agrees and is recorded.
    ['RECEIVED', { kind: 'NOT_CHARGED', amountMatches: true }, 'PROVIDER_REFUSES'],
    ['NOT_RECEIVED', { kind: 'NOT_CHARGED', amountMatches: true }, 'PROCEED'],
    // Still indeterminate (or nothing usable): the person decides.
    ['RECEIVED', { kind: 'INDETERMINATE', amountMatches: true }, 'PROCEED'],
    ['NOT_RECEIVED', { kind: 'INDETERMINATE', amountMatches: true }, 'PROCEED'],
    ['RECEIVED', { kind: 'UNRECOGNISED', amountMatches: true }, 'PROCEED'],
    ['NOT_RECEIVED', 'not_found', 'PROCEED'],
  ])('%s with a fresh %j -> %s', (outcome, fresh, gate) => {
    expect(decideHoldGate({ outcome, fresh })).toBe(gate);
  });
});
