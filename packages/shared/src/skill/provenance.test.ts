import { describe, expect, it } from 'vitest';
import { deriveSkillProvenance } from './index.ts';

const AT = '2026-10-17T01:02:03.456Z';
const LATER = '2026-11-03T16:30:00.000Z';

describe('deriveSkillProvenance (derived from the override stamps and the baseline, never stored)', () => {
  it('is self-assessed while the level has never changed', () => {
    expect(deriveSkillProvenance({ skillOverride: null, skillChangedAt: null })).toEqual({
      kind: 'self',
    });
  });

  it('is "set by admin" when the last change is the override (one instant wrote both)', () => {
    expect(
      deriveSkillProvenance({
        skillOverride: { byName: 'Aroha Ngata', at: AT },
        skillChangedAt: AT,
      }),
    ).toEqual({ kind: 'admin', byName: 'Aroha Ngata', at: AT });
  });

  it('is "moved up automatically" when the level changed after any override, or without one', () => {
    expect(deriveSkillProvenance({ skillOverride: null, skillChangedAt: LATER })).toEqual({
      kind: 'auto',
      at: LATER,
    });
    expect(
      deriveSkillProvenance({
        skillOverride: { byName: 'Aroha Ngata', at: AT },
        skillChangedAt: LATER,
      }),
    ).toEqual({ kind: 'auto', at: LATER });
  });

  it('treats the instants as instants, not strings (an equal time in another spelling is still the override)', () => {
    expect(
      deriveSkillProvenance({
        skillOverride: { byName: 'Aroha Ngata', at: '2026-10-17T01:02:03.456Z' },
        skillChangedAt: '2026-10-17T14:02:03.456+13:00',
      }),
    ).toMatchObject({ kind: 'admin' });
  });
});
