/**
 * The pure registration status table, replayed against the shared matrix fixture that
 * `registrations-schema.int.test.ts` runs as raw SQL against the `registrations_guard_update` trigger (D-64),
 * so the SQL and TypeScript encodings of the status moves cannot drift.
 */
import { RegistrationStatus } from '@sgm/shared';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_REGISTRATION_TRANSITIONS,
  REGISTRATION_TRANSITION_MATRIX,
} from '../../../test/fixtures/registration-transitions.ts';
import { ALLOWED_TRANSITIONS, canTransition } from './transitions.ts';

describe('canTransition agrees with the shared matrix', () => {
  it('covers every ordered pair of distinct statuses (6) and allows exactly five of them', () => {
    expect(REGISTRATION_TRANSITION_MATRIX).toHaveLength(6);
    expect(REGISTRATION_TRANSITION_MATRIX.filter((pair) => pair.allowed)).toHaveLength(5);
  });

  it.each(REGISTRATION_TRANSITION_MATRIX)('$from -> $to is allowed: $allowed', (pair) => {
    expect(canTransition(pair.from, pair.to)).toBe(pair.allowed);
  });

  it('never demotes CONFIRMED to WAITLISTED', () => {
    expect(canTransition('CONFIRMED', 'WAITLISTED')).toBe(false);
  });

  it('allows a same-status update (it is not a transition)', () => {
    for (const status of RegistrationStatus) expect(canTransition(status, status)).toBe(true);
  });

  it('exports the same edge list as the fixture', () => {
    expect([...ALLOWED_TRANSITIONS].map(([a, b]) => `${a}>${b}`).sort()).toEqual(
      ALLOWED_REGISTRATION_TRANSITIONS.map(([a, b]) => `${a}>${b}`).sort(),
    );
  });
});
