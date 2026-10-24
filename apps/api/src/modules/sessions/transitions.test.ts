import { describe, expect, it } from 'vitest';
import {
  FIXTURE_NOW,
  FIXTURE_STARTS_AT,
  SESSION_ACTION_ROWS,
} from '../../../test/fixtures/session-transitions.ts';
import { decideSessionAction } from './transitions.ts';

describe('decideSessionAction (AC-ERROR-5, AC-ERROR-6; T-11)', () => {
  it('has a fixture row for every action x status x timing', () => {
    expect(SESSION_ACTION_ROWS).toHaveLength(4 * 4 * 4);
  });

  it.each(
    SESSION_ACTION_ROWS.map((row) => [`${row.action} ${row.status} ${row.timing}`, row] as const),
  )('%s', (_name, row) => {
    const decision = decideSessionAction(
      row.action,
      { status: row.status, startsAt: FIXTURE_STARTS_AT[row.timing] },
      FIXTURE_NOW,
    );
    expect(decision).toEqual(row.expected);
  });

  it('reads only the injected clock: the same session flips at its start instant', () => {
    const state = { status: 'PUBLISHED', startsAt: new Date('2026-10-21T06:00:00.000Z') } as const;
    const justBefore = new Date('2026-10-21T05:59:59.999Z');
    const atStart = new Date('2026-10-21T06:00:00.000Z');
    expect(decideSessionAction('cancel', state, justBefore)).toEqual({
      ok: true,
      next: 'CANCELLED',
    });
    expect(decideSessionAction('cancel', state, atStart)).toEqual({
      ok: false,
      error: 'session_started',
    });
  });

  it('does not mutate its inputs', () => {
    const startsAt = new Date('2026-10-21T06:00:00.000Z');
    const state = Object.freeze({ status: 'DRAFT' as const, startsAt });
    decideSessionAction('publish', state, FIXTURE_NOW);
    expect(startsAt.toISOString()).toBe('2026-10-21T06:00:00.000Z');
  });
});
