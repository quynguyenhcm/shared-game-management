import { describe, expect, it } from 'vitest';
import {
  formFeeSummary,
  initialSessionForm,
  sessionFormReducer,
  validateSessionForm,
} from './session-form-state.ts';
import { sessionFixture } from './sessions-fixtures.ts';

describe('formFeeSummary (the fee sentence of the publish and create confirms)', () => {
  it('is the suggested rate for a flat session that follows it, and the pinned rate once typed', () => {
    const state = initialSessionForm(sessionFixture());
    expect(formFeeSummary(state)).toBe('$12.00 each');
    const pinned = sessionFormReducer(state, { type: 'type_rate', value: '13.50' });
    expect(formFeeSummary(pinned)).toBe('$13.50 each');
  });

  it('lists the by-sex and by-skill fees, with Other following the lower of the other two', () => {
    const bySex = initialSessionForm(
      sessionFixture({
        pricingStructure: 'BY_SEX',
        feeFlat: null,
        feeMale: '17.00',
        feeFemale: '16.00',
        feeOther: '16.00',
      }),
    );
    expect(formFeeSummary(bySex)).toBe('$17.00 male, $16.00 female, $16.00 other');
    const bySkill = initialSessionForm(
      sessionFixture({
        pricingStructure: 'BY_SKILL_LEVEL',
        feeFlat: null,
        feeBeginner: '10.00',
        feeIntermediate: '12.00',
        feeAdvanced: '14.00',
      }),
    );
    expect(formFeeSummary(bySkill)).toBe('$10.00 beginner, $12.00 intermediate, $14.00 advanced');
  });

  it('is null for a free session, so the confirm and the publish button skip the charge sentence', () => {
    const free = initialSessionForm(
      sessionFixture({
        courtCost: '0.00',
        extraExpenses: '0.00',
        feeFlat: '0.00',
        calculatedRatePerPlayer: '0.00',
      }),
    );
    expect(formFeeSummary(free)).toBeNull();
  });
});

describe('validateSessionForm with the publish intent (AC-ERROR-4: no incomplete pricing reaches the gate)', () => {
  const bySexMissing = (): ReturnType<typeof initialSessionForm> =>
    initialSessionForm(
      sessionFixture({
        pricingStructure: 'BY_SEX',
        feeFlat: null,
        feeMale: '17.00',
        feeFemale: null,
        feeOther: null,
      }),
    );

  it('saving a draft allows a fee to be blank', () => {
    expect(validateSessionForm(bySexMissing(), 'session')).toEqual({});
    expect(validateSessionForm(bySexMissing(), 'session', 'draft')).toEqual({});
  });

  it('publishing needs every fee the model reads (Other follows the lower of the two)', () => {
    const errors = validateSessionForm(bySexMissing(), 'session', 'publish');
    expect(errors.feeFemale).toEqual(['Enter an amount like 12.00.']);
    expect(errors.feeOther).toBeUndefined();
    expect(errors.feeMale).toBeUndefined();
  });

  it('a flat session never lacks a fee, so publishing it passes', () => {
    expect(validateSessionForm(initialSessionForm(sessionFixture()), 'session', 'publish')).toEqual(
      {},
    );
  });
});
