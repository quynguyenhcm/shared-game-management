import { describe, expect, it } from 'vitest';
import type { LocalDate } from '@sgm/shared';
import { decideAutoEnrolChange, decideOverride, type AutoEnrolState } from './decisions.ts';

const BASELINE = new Date('2026-10-10T00:00:00.123Z');

describe('decideOverride (AC-HAPPY-1..3, Binding Reconciliation decision 4)', () => {
  const current = { skillLevel: 'BEGINNER', changedAt: BASELINE } as const;
  const expecting = {
    expectedSkillLevel: 'BEGINNER',
    expectedChangedAt: BASELINE.toISOString(),
  } as const;

  it('changes a different level when the panel saw the current state', () => {
    expect(decideOverride(current, { skillLevel: 'ADVANCED', ...expecting })).toEqual({
      kind: 'change',
      from: 'BEGINNER',
      to: 'ADVANCED',
    });
    expect(
      decideOverride(
        { skillLevel: 'INTERMEDIATE', changedAt: null },
        { skillLevel: 'BEGINNER', expectedSkillLevel: 'INTERMEDIATE', expectedChangedAt: null },
      ),
    ).toEqual({ kind: 'change', from: 'INTERMEDIATE', to: 'BEGINNER' });
  });

  it('is stale when the level or the baseline instant differs from what the panel saw', () => {
    for (const seen of [
      { expectedSkillLevel: 'INTERMEDIATE', expectedChangedAt: BASELINE.toISOString() },
      { expectedSkillLevel: 'BEGINNER', expectedChangedAt: null },
      { expectedSkillLevel: 'BEGINNER', expectedChangedAt: '2026-10-10T00:00:00.124Z' },
    ] as const) {
      expect(
        decideOverride(current, { skillLevel: 'ADVANCED', ...seen }),
        JSON.stringify(seen),
      ).toEqual({ kind: 'stale' });
    }
    expect(
      decideOverride(
        { skillLevel: 'BEGINNER', changedAt: null },
        { skillLevel: 'ADVANCED', ...expecting },
      ),
    ).toEqual({ kind: 'stale' });
  });

  it('compares the baseline at millisecond precision in any ISO spelling', () => {
    expect(
      decideOverride(current, {
        skillLevel: 'ADVANCED',
        expectedSkillLevel: 'BEGINNER',
        expectedChangedAt: '2026-10-10T13:00:00.123+13:00',
      }).kind,
    ).toBe('change');
  });

  it('is a no-op when the member already has the level, whatever the panel saw (a retried save is safe)', () => {
    expect(decideOverride(current, { skillLevel: 'BEGINNER', ...expecting })).toEqual({
      kind: 'noop',
    });
    expect(
      decideOverride(current, {
        skillLevel: 'BEGINNER',
        expectedSkillLevel: 'ADVANCED',
        expectedChangedAt: null,
      }),
    ).toEqual({ kind: 'noop' });
  });
});

describe('decideAutoEnrolChange (AC-HAPPY-7..10, AC-HAPPY-13, AC-ERROR-3)', () => {
  const today = '2026-12-02' as LocalDate;
  const now = new Date('2026-12-01T20:00:00.000Z');
  const earlier = new Date('2026-10-01T00:00:00.000Z');
  const off: AutoEnrolState = { enabled: false, until: null, assignedAt: null };
  const on = (until: string | null): AutoEnrolState => ({
    enabled: true,
    until: until as LocalDate | null,
    assignedAt: earlier,
  });
  const ctx = { todayNz: today, now };

  it.each([
    [
      'off -> on with a date: new assignment',
      off,
      { enabled: true, until: '2026-12-30' },
      { kind: 'set', next: { enabled: true, until: '2026-12-30', assignedAt: now } },
    ],
    [
      'off -> on without a date: new assignment',
      off,
      { enabled: true, until: null },
      { kind: 'set', next: { enabled: true, until: null, assignedAt: now } },
    ],
    [
      'on -> on with only a new date: keeps its place',
      on(null),
      { enabled: true, until: '2026-12-30' },
      { kind: 'set', next: { enabled: true, until: '2026-12-30', assignedAt: earlier } },
    ],
    [
      'on -> on clearing the date: keeps its place',
      on('2026-12-30'),
      { enabled: true, until: null },
      { kind: 'set', next: { enabled: true, until: null, assignedAt: earlier } },
    ],
    [
      'on until today -> on: still active, keeps its place',
      on('2026-12-02'),
      { enabled: true, until: null },
      { kind: 'set', next: { enabled: true, until: null, assignedAt: earlier } },
    ],
    [
      'ended (until before today) -> on: a new assignment at the back',
      on('2026-12-01'),
      { enabled: true, until: null },
      { kind: 'set', next: { enabled: true, until: null, assignedAt: now } },
    ],
    [
      'on -> off: clears all three columns',
      on('2026-12-30'),
      { enabled: false, until: null },
      { kind: 'set', next: off },
    ],
    [
      'ended -> off: an optional tidy-up that clears',
      on('2026-11-30'),
      { enabled: false, until: null },
      { kind: 'set', next: off },
    ],
    ['off -> off: no-op', off, { enabled: false, until: null }, { kind: 'noop' }],
    [
      'unchanged on -> on: no-op',
      on('2026-12-30'),
      { enabled: true, until: '2026-12-30' },
      { kind: 'noop' },
    ],
    [
      'on -> on with today as the date: allowed',
      on(null),
      { enabled: true, until: '2026-12-02' },
      { kind: 'set', next: { enabled: true, until: '2026-12-02', assignedAt: earlier } },
    ],
    [
      'an end date before today (NZ) is refused',
      off,
      { enabled: true, until: '2026-12-01' },
      { kind: 'invalid_until' },
    ],
  ] as const)('%s', (_name, current, input, expected) => {
    expect(decideAutoEnrolChange(current, input, ctx)).toEqual(expected);
  });
});
