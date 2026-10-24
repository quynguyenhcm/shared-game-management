import { describe, expect, it } from 'vitest';
import { SessionStatus } from '../types/enums.ts';
import { SESSION_TRANSITION_MATRIX } from '../../../../apps/api/test/fixtures/session-transitions.ts';
import { SESSION_TRANSITIONS, isTerminal } from './lifecycle.ts';

describe('SESSION_TRANSITIONS (AC-ERROR-6)', () => {
  it('has a fixture row for every ordered pair of statuses', () => {
    expect(SESSION_TRANSITION_MATRIX).toHaveLength(16);
    const pairs = SessionStatus.flatMap((from) => SessionStatus.map((to) => `${from}>${to}`));
    expect(SESSION_TRANSITION_MATRIX.map((r) => `${r.from}>${r.to}`).sort()).toEqual(pairs.sort());
  });

  it.each(SESSION_TRANSITION_MATRIX.map((r) => [`${r.from} -> ${r.to}`, r] as const))(
    '%s',
    (_name, row) => {
      // A same-status write is not a transition: the table never lists it and the trigger accepts it.
      const listed = SESSION_TRANSITIONS[row.from].includes(row.to);
      if (row.from === row.to) {
        expect(listed).toBe(false);
        expect(row.allowed).toBe(true);
      } else {
        expect(listed).toBe(row.allowed);
      }
    },
  );

  it('allows exactly the four documented moves', () => {
    const moves = SessionStatus.flatMap((from) =>
      SESSION_TRANSITIONS[from].map((to) => `${from}>${to}`),
    );
    expect(moves.sort()).toEqual([
      'DRAFT>CANCELLED',
      'DRAFT>PUBLISHED',
      'PUBLISHED>CANCELLED',
      'PUBLISHED>COMPLETED',
    ]);
  });

  it('COMPLETED and CANCELLED are terminal, DRAFT and PUBLISHED are not', () => {
    expect(SessionStatus.filter(isTerminal)).toEqual(['COMPLETED', 'CANCELLED']);
    for (const status of SessionStatus) {
      expect(isTerminal(status)).toBe(SESSION_TRANSITIONS[status].length === 0);
    }
  });
});
