import type { DstOptionsEntry, SeriesResponse, SessionResponse } from '@sgm/shared';
import { describe, expect, it } from 'vitest';
import {
  COURT_APPLY_ID,
  COURT_COUNT_ID,
  RATE_FIELD_ID,
  courtCountKeyAction,
  courtFieldId,
  courtSummary,
  courtTableReducer,
  derivePattern,
  deadlineRequest,
  feeOtherText,
  finalRate,
  initialCourtTable,
  initialSessionForm,
  errorOrder,
  isNotDefault,
  mapServerFieldErrors,
  lockedFeeErrors,
  parseDstField,
  rateFieldText,
  sessionFormReducer,
  suggestionOf,
  validateCourts,
  validateSessionForm,
  type CourtTableState,
  type SessionFormState,
} from './session-form-state.ts';

const names = (state: CourtTableState): string[] => state.rows.map((row) => row.identifier);

function nineCourtsUnapplied(): CourtTableState {
  let state = initialCourtTable();
  state = courtTableReducer(state, { type: 'set_default', which: 'start', value: '08:00' });
  state = courtTableReducer(state, { type: 'set_default', which: 'end', value: '10:00' });
  state = courtTableReducer(state, { type: 'set_count_text', value: '9' });
  return courtTableReducer(state, { type: 'commit_count' });
}

/** The UC1 flow: defaults, the count, then Apply to all courts so Court 1 takes the defaults too. */
function nineCourts(): CourtTableState {
  return courtTableReducer(nineCourtsUnapplied(), { type: 'apply_all' });
}

describe('court table reducer (UI/UX D1: defaults block plus one row per court)', () => {
  it('starts with one blank court named Court 1', () => {
    const state = initialCourtTable();
    expect(names(state)).toEqual(['Court 1']);
    expect(state.countText).toBe('1');
    expect(state.live).toBeNull();
  });

  it('committing a higher count adds rows with the default times and announces "Court table has n courts."', () => {
    const state = nineCourtsUnapplied();
    expect(names(state)).toHaveLength(9);
    expect(names(state)[8]).toBe('Court 9');
    expect(
      state.rows.slice(1).every((row) => row.startTime === '08:00' && row.endTime === '10:00'),
    ).toBe(true);
    expect(state.rows[0]?.startTime).toBe('');
    expect(state.live?.text).toBe('Court table has 9 courts.');
    expect(state.countText).toBe('9');
  });

  it('typing the count changes nothing until it is committed (blur or Enter)', () => {
    const state = courtTableReducer(initialCourtTable(), { type: 'set_count_text', value: '5' });
    expect(state.rows).toHaveLength(1);
    expect(state.countText).toBe('5');
  });

  it('committing a lower count drops rows from the end and says which', () => {
    let state = nineCourtsUnapplied();
    state = courtTableReducer(state, { type: 'set_count_text', value: '7' });
    state = courtTableReducer(state, { type: 'commit_count' });
    expect(names(state)).toHaveLength(7);
    expect(state.live?.text).toBe('Removed Court 9 and Court 8. 7 courts.');
    state = courtTableReducer(state, { type: 'set_count_text', value: '4' });
    state = courtTableReducer(state, { type: 'commit_count' });
    expect(state.live?.text).toBe('Removed Court 7, Court 6 and Court 5. 4 courts.');
  });

  it.each(['', '0', '-2', 'abc', '2.5', '51'])(
    'a count of "%s" is not applied and the box reverts to the real number of rows',
    (value) => {
      let state = nineCourts();
      state = courtTableReducer(state, { type: 'set_count_text', value });
      state = courtTableReducer(state, { type: 'commit_count' });
      expect(state.rows).toHaveLength(9);
      expect(state.countText).toBe('9');
    },
  );

  it('apply to all courts copies the defaults to every row, keeps names, and focus stays put', () => {
    let state = nineCourts();
    expect(state.defaultsChanged).toBe(false);
    state = courtTableReducer(state, {
      type: 'set_row',
      key: state.rows[6]!.key,
      field: 'endTime',
      value: '09:00',
    });
    state = courtTableReducer(state, { type: 'set_default', which: 'end', value: '11:00' });
    expect(state.defaultsChanged).toBe(true);
    state = courtTableReducer(state, { type: 'apply_all' });
    expect(state.rows.every((row) => row.endTime === '11:00')).toBe(true);
    expect(names(state)[6]).toBe('Court 7');
    expect(state.defaultsChanged).toBe(false);
    expect(state.live?.text).toBe('Times applied to 9 courts.');
    expect(state.focus).toBeNull();
  });

  it('add court appends the lowest unused "Court n", announces it and focuses its name input', () => {
    let state = nineCourts();
    state = courtTableReducer(state, { type: 'remove', key: state.rows[2]!.key });
    state = courtTableReducer(state, { type: 'add' });
    expect(names(state)[8]).toBe('Court 3');
    expect(state.live?.text).toBe('Court 3 added.');
    expect(state.focus?.id).toBe(courtFieldId(state.rows[8]!.key, 'name'));
    expect(state.countText).toBe('9');
  });

  it('remove drops the row, announces the new count, and focuses the previous row (or the next if first)', () => {
    let state = nineCourts();
    const keys = state.rows.map((row) => row.key);
    state = courtTableReducer(state, { type: 'remove', key: keys[6]! });
    expect(names(state)).not.toContain('Court 7');
    expect(state.live?.text).toBe('Court 7 removed. 8 courts.');
    expect(state.focus?.id).toBe(courtFieldId(keys[5]!, 'name'));
    state = courtTableReducer(state, { type: 'remove', key: keys[0]! });
    expect(state.focus?.id).toBe(courtFieldId(keys[1]!, 'name'));
  });

  it('never removes the last court', () => {
    const state = initialCourtTable();
    expect(courtTableReducer(state, { type: 'remove', key: state.rows[0]!.key })).toBe(state);
  });

  it('keeps each row stable by key when another row is removed, and editing a time clears its DST choice', () => {
    let state = nineCourts();
    const keep = state.rows[4]!;
    state = courtTableReducer(state, { type: 'remove', key: state.rows[1]!.key });
    expect(state.rows.find((row) => row.key === keep.key)?.identifier).toBe('Court 5');
    state = courtTableReducer(state, {
      type: 'set_row',
      key: keep.key,
      field: 'startTime',
      value: '02:30',
    });
    expect(state.rows.find((row) => row.key === keep.key)?.startTime).toBe('02:30');
  });

  it('summarises how many courts use the default times and tags the exceptions', () => {
    let state = nineCourts();
    expect(courtSummary(state)).toBe('9 courts. All use the default times.');
    const seven = state.rows[6]!;
    state = courtTableReducer(state, {
      type: 'set_row',
      key: seven.key,
      field: 'endTime',
      value: '09:00',
    });
    expect(courtSummary(state)).toBe('9 courts. 8 use the default times.');
    expect(isNotDefault(state, state.rows[6]!)).toBe(true);
    expect(isNotDefault(state, state.rows[0]!)).toBe(false);
    expect(courtSummary(initialCourtTable())).toBe('1 court. All use the default times.');
  });

  it('exposes stable DOM ids for the count box, the apply button and each row input', () => {
    expect(COURT_COUNT_ID).toBe('court-count');
    expect(COURT_APPLY_ID).toBe('court-apply');
    expect(courtFieldId('c3', 'start')).toBe('field-court-c3-start');
  });
});

describe('Number of courts: Enter commits and never submits the form (AC-VERIFY-8)', () => {
  it('Enter is claimed (preventDefault) and commits', () => {
    const calls: string[] = [];
    const handled = courtCountKeyAction({
      key: 'Enter',
      preventDefault: () => calls.push('prevented'),
    });
    expect(handled).toBe('commit');
    expect(calls).toEqual(['prevented']);
  });

  it('other keys are left alone', () => {
    const calls: string[] = [];
    expect(courtCountKeyAction({ key: '5', preventDefault: () => calls.push('x') })).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('court validation (copy deck "Court errors")', () => {
  const row = (key: string, identifier: string, startTime: string, endTime: string) => ({
    key,
    identifier,
    startTime,
    endTime,
  });

  it('is clean for valid courts', () => {
    expect(validateCourts([row('a', 'Court 1', '08:00', '10:00')])).toEqual({});
  });

  it.each([
    [row('a', 'Court 1', '', '10:00'), 'court-a-start', 'Enter a start time.'],
    [row('a', 'Court 1', '08:00', ''), 'court-a-end', 'Enter an end time.'],
    [row('a', 'Court 1', '10:00', '10:00'), 'court-a-end', 'End must be after start.'],
    [row('a', '  ', '08:00', '10:00'), 'court-a-name', 'Enter a court name.'],
  ])('%j names %s with "%s"', (court, field, message) => {
    expect(validateCourts([court])[field]).toEqual([message]);
  });

  it('rejects duplicate names on the second row', () => {
    const errors = validateCourts([
      row('a', 'Court 1', '08:00', '10:00'),
      row('b', 'Court 1', '08:00', '10:00'),
    ]);
    expect(errors['court-b-name']).toEqual(['Court names must be different.']);
  });

  it('allows an end of 24:00 (end of day)', () => {
    expect(validateCourts([row('a', 'Court 1', '22:00', '24:00')])).toEqual({});
  });
});

function blank(): SessionFormState {
  return initialSessionForm();
}

function costed(): SessionFormState {
  let state = blank();
  state = sessionFormReducer(state, { type: 'set_places', field: 'maxPlayers', value: '18' });
  state = sessionFormReducer(state, { type: 'set_costing', field: 'courtCost', value: '180.00' });
  return sessionFormReducer(state, { type: 'set_costing', field: 'extraExpenses', value: '20.00' });
}

describe('rate follow and pin (UI/UX D2 option A, T-9)', () => {
  it('computes the suggestion with the shared formula and follows it', () => {
    const state = costed();
    expect(suggestionOf(state)?.toString()).toBe('1200');
    expect(rateFieldText(state)).toBe('12.00');
    expect(state.pricing.rateMode).toBe('follow');
    const more = sessionFormReducer(state, {
      type: 'set_places',
      field: 'maxPlayers',
      value: '16',
    });
    expect(rateFieldText(more)).toBe('13.00');
  });

  it('has no suggestion until max players is a whole number of 1 or more', () => {
    expect(suggestionOf(blank())).toBeNull();
    expect(rateFieldText(blank())).toBe('');
  });

  it('typing a rate pins it, and it no longer changes when costs change', () => {
    let state = sessionFormReducer(costed(), { type: 'type_rate', value: '15.00' });
    expect(state.pricing.rateMode).toBe('pinned');
    state = sessionFormReducer(state, { type: 'set_costing', field: 'courtCost', value: '400.00' });
    expect(rateFieldText(state)).toBe('15.00');
    expect(finalRate(state)?.toString()).toBe('1500');
  });

  it('clearing the rate box goes back to following', () => {
    let state = sessionFormReducer(costed(), { type: 'type_rate', value: '15.00' });
    state = sessionFormReducer(state, { type: 'type_rate', value: '' });
    expect(state.pricing.rateMode).toBe('follow');
  });

  it('"Use suggested rate" unpins, announces it and returns focus to the rate input', () => {
    let state = sessionFormReducer(costed(), { type: 'type_rate', value: '15.00' });
    state = sessionFormReducer(state, { type: 'use_suggested_rate' });
    expect(state.pricing.rateMode).toBe('follow');
    expect(rateFieldText(state)).toBe('12.00');
    expect(state.live.text).toBe('Following the suggested rate.');
    expect(state.focus?.id).toBe(RATE_FIELD_ID);
  });
});

describe('pricing reveal and fill (ALG J9: UI-only pre-fill from the final rate)', () => {
  it('first reveal of By sex fills male and female from the final rate; other tracks the lower of the two', () => {
    let state = sessionFormReducer(costed(), { type: 'set_model', model: 'BY_SEX' });
    expect(state.pricing.feeMale).toBe('12.00');
    expect(state.pricing.feeFemale).toBe('12.00');
    expect(feeOtherText(state)).toBe('12.00');
    state = sessionFormReducer(state, { type: 'set_fee', field: 'feeMale', value: '17.00' });
    state = sessionFormReducer(state, { type: 'set_fee', field: 'feeFemale', value: '16.00' });
    expect(feeOtherText(state)).toBe('16.00');
    state = sessionFormReducer(state, { type: 'set_fee', field: 'feeOther', value: '14.00' });
    state = sessionFormReducer(state, { type: 'set_fee', field: 'feeMale', value: '20.00' });
    expect(feeOtherText(state)).toBe('14.00');
  });

  it('first reveal of By skill level fills all three, and a later switch keeps what was typed', () => {
    let state = sessionFormReducer(costed(), { type: 'set_model', model: 'BY_SKILL_LEVEL' });
    expect(state.pricing.feeBeginner).toBe('12.00');
    state = sessionFormReducer(state, { type: 'set_fee', field: 'feeBeginner', value: '10.00' });
    state = sessionFormReducer(state, { type: 'set_model', model: 'FLAT' });
    state = sessionFormReducer(state, { type: 'set_model', model: 'BY_SKILL_LEVEL' });
    expect(state.pricing.feeBeginner).toBe('10.00');
  });

  it('reveals empty inputs when there is no rate to fill from', () => {
    const state = sessionFormReducer(blank(), { type: 'set_model', model: 'BY_SEX' });
    expect(state.pricing.feeMale).toBe('');
  });

  it('"Fill all with the suggested rate" fills every fee of the active model and announces it', () => {
    let state = sessionFormReducer(costed(), { type: 'set_model', model: 'BY_SKILL_LEVEL' });
    state = sessionFormReducer(state, { type: 'set_fee', field: 'feeAdvanced', value: '99.00' });
    state = sessionFormReducer(state, { type: 'fill_all' });
    expect([
      state.pricing.feeBeginner,
      state.pricing.feeIntermediate,
      state.pricing.feeAdvanced,
    ]).toEqual(['12.00', '12.00', '12.00']);
    expect(state.live.text).toBe('All fees set to $12.00.');
  });
});

function publishedSession(
  overrides: Partial<Record<keyof SessionResponse, unknown>> = {},
): SessionResponse {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    teamId: '7f3c2b1a-1111-4222-8333-444455556666',
    recurringRuleId: null,
    status: 'PUBLISHED',
    phase: 'upcoming',
    date: '2026-11-04',
    location: 'Rosedale',
    address: '1 Court Rd',
    maxPlayers: 18,
    reservedSeats: 2,
    courtCost: '180.00',
    extraExpenses: '20.00',
    calculatedRatePerPlayer: '12.00',
    customPlayerRate: null,
    pricingStructure: 'BY_SEX',
    feeFlat: null,
    feeMale: '17.00',
    feeFemale: '16.00',
    feeOther: '16.00',
    feeBeginner: null,
    feeIntermediate: null,
    feeAdvanced: null,
    startsAt: '2026-11-03T19:00:00.000Z',
    endsAt: '2026-11-03T21:00:00.000Z',
    cancellationDeadline: '2026-11-01T19:00:00.000Z',
    deadlineIsDefault: true,
    isInstanceOverridden: false,
    draftReason: null,
    seriesName: null,
    version: 3,
    activeRegistrationCount: 12,
    feesLocked: 'raise_only_blocked',
    courts: [
      {
        id: '21111111-1111-4111-8111-111111111111',
        identifier: 'Court 1',
        startTime: '08:00',
        endTime: '10:00',
      },
      {
        id: '31111111-1111-4111-8111-111111111111',
        identifier: 'Court 2',
        startTime: '08:00',
        endTime: '09:00',
      },
    ],
    ...overrides,
  } as SessionResponse;
}

describe('locked pricing (T-7: fees can only go down once players have registered)', () => {
  it('seeds from a locked session and flags a raised fee with the copy-deck message, but not a lowered one', () => {
    let state = initialSessionForm(publishedSession());
    expect(state.pricing.locked).toBe(true);
    expect(lockedFeeErrors(state)).toEqual({});
    state = sessionFormReducer(state, { type: 'set_fee', field: 'feeMale', value: '18.00' });
    expect(lockedFeeErrors(state)).toEqual({
      feeMale: [
        'This is higher than the current fee. Fees can only be lowered once players have registered.',
      ],
    });
    state = sessionFormReducer(state, { type: 'set_fee', field: 'feeMale', value: '15.00' });
    expect(lockedFeeErrors(state)).toEqual({});
  });

  it('refuses to change the model on a locked session', () => {
    const state = initialSessionForm(publishedSession());
    expect(sessionFormReducer(state, { type: 'set_model', model: 'FLAT' })).toBe(state);
  });

  it('an unlocked session has no fee limit', () => {
    const state = initialSessionForm(publishedSession({ feesLocked: 'none' }));
    const next = sessionFormReducer(state, { type: 'set_fee', field: 'feeMale', value: '40.00' });
    expect(lockedFeeErrors(next)).toEqual({});
  });
});

describe('seeding the form from the API', () => {
  it('maps courts, defaults (the most common times), places, costing and pricing', () => {
    const state = initialSessionForm(publishedSession({ feesLocked: 'none' }));
    expect(state.details).toEqual({
      location: 'Rosedale',
      address: '1 Court Rd',
      date: '2026-11-04',
    });
    expect(state.courts.rows.map((row) => row.identifier)).toEqual(['Court 1', 'Court 2']);
    expect(state.courts.countText).toBe('2');
    expect(state.places).toEqual({ maxPlayers: '18', reservedSeats: '2' });
    expect(state.costing).toEqual({ courtCost: '180.00', extraExpenses: '20.00' });
    expect(state.pricing.model).toBe('BY_SEX');
    expect(state.pricing.rateMode).toBe('follow');
    expect(state.deadline.mode).toBe('default');
  });

  it('a pinned custom rate and a specific deadline come through', () => {
    const state = initialSessionForm(
      publishedSession({
        pricingStructure: 'FLAT',
        customPlayerRate: '15.00',
        deadlineIsDefault: false,
        cancellationDeadline: '2026-11-02T19:30:00.000Z',
      }),
    );
    expect(state.pricing.rateMode).toBe('pinned');
    expect(state.pricing.rate).toBe('15.00');
    expect(state.deadline).toMatchObject({ mode: 'specific', date: '2026-11-03', time: '08:30' });
  });
});

describe('cancellation deadline (T-8)', () => {
  it('the default sends null; a specific deadline sends date, time and any chosen disambiguation', () => {
    let state = blank();
    expect(deadlineRequest(state.deadline)).toBeNull();
    state = sessionFormReducer(state, { type: 'set_deadline_mode', mode: 'specific' });
    state = sessionFormReducer(state, { type: 'set_deadline_date', value: '2027-04-04' });
    state = sessionFormReducer(state, { type: 'set_deadline_time', value: '02:30' });
    expect(deadlineRequest(state.deadline)).toEqual({ date: '2027-04-04', time: '02:30' });
  });
});

const gap: DstOptionsEntry = {
  field: 'courts.0.startTime',
  date: '2026-09-27',
  time: '02:30',
  kind: 'nonexistent',
  options: [
    { choice: 'shiftedForward', localTime: '03:30', instant: '2026-09-26T14:30:00.000Z' },
    { choice: 'shiftedBackward', localTime: '01:30', instant: '2026-09-26T13:30:00.000Z' },
  ],
};
const overlap: DstOptionsEntry = {
  field: 'courts.0.endTime',
  date: '2027-04-04',
  time: '02:30',
  kind: 'ambiguous',
  options: [{ choice: 'earlier', localTime: '02:30', instant: '2027-04-03T13:30:00.000Z' }],
};
const deadlineOverlap: DstOptionsEntry = {
  field: 'cancellationDeadline.time',
  date: '2027-04-04',
  time: '02:30',
  kind: 'ambiguous',
  options: [
    { choice: 'earlier', localTime: '02:30', instant: '2027-04-03T13:30:00.000Z' },
    { choice: 'later', localTime: '02:30', instant: '2027-04-03T14:30:00.000Z' },
  ],
};

describe('DST choice state (T-10)', () => {
  it('maps API field paths to court rows and the deadline', () => {
    expect(parseDstField('courts.2.startTime')).toEqual({
      kind: 'court',
      index: 2,
      which: 'start',
    });
    expect(parseDstField('courts.0.endTime')).toEqual({ kind: 'court', index: 0, which: 'end' });
    expect(parseDstField('cancellationDeadline.time')).toEqual({ kind: 'deadline' });
    expect(parseDstField('location')).toBeNull();
  });

  it('a gap choice sets the time, clears the prompt, announces and returns focus to the input', () => {
    let state = sessionFormReducer(blank(), { type: 'dst_errors', entries: [gap] });
    expect(state.dst).toHaveLength(1);
    state = sessionFormReducer(state, {
      type: 'dst_choose',
      field: 'courts.0.startTime',
      choice: 'shiftedForward',
    });
    const row = state.courts.rows[0]!;
    expect(row.startTime).toBe('03:30');
    expect(state.dst).toHaveLength(0);
    expect(state.live.text).toBe('Court 1 start set to 3:30 am. Save again to apply.');
    expect(state.focus?.id).toBe(courtFieldId(row.key, 'start'));
  });

  it('an overlap choice keeps the time and records the earlier disambiguation for posting', () => {
    let state = sessionFormReducer(blank(), { type: 'dst_errors', entries: [overlap] });
    state = sessionFormReducer(state, {
      type: 'dst_choose',
      field: 'courts.0.endTime',
      choice: 'earlier',
    });
    expect(state.courts.rows[0]!.endDisambiguation).toBe('earlier');
    expect(state.live.text).toBe('Court 1 end will use the first 2:30 am.');
    const edited = sessionFormReducer(state, {
      type: 'court',
      action: { type: 'set_row', key: state.courts.rows[0]!.key, field: 'endTime', value: '09:00' },
    });
    expect(edited.courts.rows[0]!.endDisambiguation).toBeUndefined();
  });

  it('a deadline overlap records earlier or later on the deadline', () => {
    let state = sessionFormReducer(blank(), { type: 'dst_errors', entries: [deadlineOverlap] });
    state = sessionFormReducer(state, { type: 'set_deadline_mode', mode: 'specific' });
    state = sessionFormReducer(state, {
      type: 'dst_choose',
      field: 'cancellationDeadline.time',
      choice: 'later',
    });
    expect(state.deadline.disambiguation).toBe('later');
    expect(state.live.text).toBe('Cancellation deadline will use the second 2:30 am.');
  });

  it('editing a flagged time drops its stale prompt', () => {
    let state = sessionFormReducer(blank(), { type: 'dst_errors', entries: [gap] });
    state = sessionFormReducer(state, {
      type: 'court',
      action: {
        type: 'set_row',
        key: state.courts.rows[0]!.key,
        field: 'startTime',
        value: '09:00',
      },
    });
    expect(state.dst).toHaveLength(0);
  });
});

describe('pattern state (UI/UX series form, P-3)', () => {
  it('derives the day and the line for weekly and fortnightly from the first date', () => {
    expect(
      derivePattern({
        frequency: 'WEEKLY',
        startsOn: '2026-11-04',
        recurUntil: '',
        monthlyWeek: null,
      }),
    ).toMatchObject({
      dayOfWeek: 3,
      monthlyWeek: null,
      picker: false,
      line: 'Every Wednesday from 4 Nov 2026',
    });
    expect(
      derivePattern({
        frequency: 'FORTNIGHTLY',
        startsOn: '2026-11-04',
        recurUntil: '2026-12-16',
        monthlyWeek: null,
      }).line,
    ).toBe('Every second Wednesday from 4 Nov 2026 until 16 Dec 2026');
  });

  it('monthly: the ordinal comes from the first date, no weekday field is asked for', () => {
    const view = derivePattern({
      frequency: 'MONTHLY',
      startsOn: '2026-11-04',
      recurUntil: '',
      monthlyWeek: null,
    });
    expect(view.monthlyWeek).toBe(1);
    expect(view.picker).toBe(false);
    expect(view.line).toBe('On the first Wednesday of each month from 4 Nov 2026');
  });

  it('monthly: a date that is both the 4th and the last of its weekday asks "4th or last"', () => {
    const base = { frequency: 'MONTHLY' as const, startsOn: '2026-11-25', recurUntil: '' };
    const asked = derivePattern({ ...base, monthlyWeek: null });
    expect(asked.picker).toBe(true);
    expect(asked.monthlyWeek).toBe(4);
    expect(derivePattern({ ...base, monthlyWeek: -1 }).monthlyWeek).toBe(-1);
    expect(derivePattern({ ...base, monthlyWeek: -1 }).line).toBe(
      'On the last Wednesday of each month from 25 Nov 2026',
    );
  });

  it('monthly: a 5th weekday is stored as last and explained, with no picker', () => {
    const view = derivePattern({
      frequency: 'MONTHLY',
      startsOn: '2026-11-29',
      recurUntil: '',
      monthlyWeek: null,
    });
    expect(view.monthlyWeek).toBe(-1);
    expect(view.picker).toBe(false);
    expect(view.fifthNote).toBe(
      '29 Nov 2026 is the 5th Sunday, so it repeats on the last Sunday of each month.',
    );
  });

  it('has no line until the first date is a valid date', () => {
    expect(
      derivePattern({ frequency: 'WEEKLY', startsOn: '', recurUntil: '', monthlyWeek: null }).line,
    ).toBeNull();
  });

  it('an existing series seeds a read-only pattern from the API', () => {
    const series = {
      frequency: 'MONTHLY',
      dayOfWeek: 3,
      startsOn: '2026-11-04',
      monthlyWeek: 1,
      recurUntil: null,
      location: 'Rosedale',
      address: '1 Court Rd',
      maxPlayers: 18,
      reservedSeats: 0,
      courtCost: '180.00',
      extraExpenses: '20.00',
      customPlayerRate: null,
      pricingStructure: 'FLAT',
      feeFlat: '12.00',
      calculatedRatePerPlayer: '12.00',
      courts: [{ identifier: 'Court 1', startTime: '08:00', endTime: '10:00' }],
      instances: [],
    } as unknown as SeriesResponse;
    const state = initialSessionForm(series);
    expect(state.pattern).toEqual({
      frequency: 'MONTHLY',
      startsOn: '2026-11-04',
      recurUntil: '',
      monthlyWeek: 1,
    });
    expect(state.details.date).toBe('');
    expect(state.courts.rows).toHaveLength(1);
  });
});

describe('whole-form validation (shared messages)', () => {
  function valid(): SessionFormState {
    let state = costed();
    state = sessionFormReducer(state, {
      type: 'set_details',
      field: 'location',
      value: 'Rosedale',
    });
    state = sessionFormReducer(state, {
      type: 'set_details',
      field: 'address',
      value: '1 Court Rd',
    });
    state = sessionFormReducer(state, { type: 'set_details', field: 'date', value: '2026-11-04' });
    state = sessionFormReducer(state, {
      type: 'court',
      action: {
        type: 'set_row',
        key: state.courts.rows[0]!.key,
        field: 'startTime',
        value: '08:00',
      },
    });
    return sessionFormReducer(state, {
      type: 'court',
      action: { type: 'set_row', key: state.courts.rows[0]!.key, field: 'endTime', value: '10:00' },
    });
  }

  it('passes a complete one-off session', () => {
    expect(validateSessionForm(valid(), 'session')).toEqual({});
  });

  it('names every missing field with the shared copy', () => {
    const errors = validateSessionForm(blank(), 'session');
    expect(errors.location).toEqual(['Enter a location.']);
    expect(errors.address).toEqual(['Enter an address.']);
    expect(errors.date).toEqual(['Enter a valid date.']);
    expect(errors.maxPlayers).toEqual(['Enter a whole number of 1 or more.']);
  });

  it('checks money, reserved seats and a specific deadline', () => {
    let state = valid();
    state = sessionFormReducer(state, { type: 'set_costing', field: 'courtCost', value: 'abc' });
    state = sessionFormReducer(state, { type: 'set_costing', field: 'extraExpenses', value: '-1' });
    state = sessionFormReducer(state, { type: 'set_places', field: 'reservedSeats', value: '19' });
    state = sessionFormReducer(state, { type: 'set_deadline_mode', mode: 'specific' });
    const errors = validateSessionForm(state, 'session');
    expect(errors.courtCost).toEqual(['Enter an amount like 12.00.']);
    expect(errors.extraExpenses).toEqual(["Amount can't be negative."]);
    expect(errors.reservedSeats).toEqual(["Reserved seats can't be more than max players."]);
    expect(errors.deadlineDate).toEqual(['Enter a valid date.']);
    expect(errors.deadlineTime).toEqual(['Enter a time like 18:30.']);
  });

  it('a blank court hire is $0.00 (a free session) and not an error', () => {
    const state = sessionFormReducer(valid(), {
      type: 'set_costing',
      field: 'courtCost',
      value: '',
    });
    expect(validateSessionForm(state, 'session').courtCost).toBeUndefined();
  });

  it('a series needs a repeat pattern and a first date instead of a date, and fees for its model', () => {
    let state = valid();
    const errors = validateSessionForm(state, 'series');
    expect(errors.frequency).toEqual(['Choose how often it repeats.']);
    expect(errors.startsOn).toEqual(['Enter a valid date.']);
    expect(errors.date).toBeUndefined();
    state = sessionFormReducer(state, { type: 'set_model', model: 'BY_SEX' });
    state = sessionFormReducer(state, { type: 'set_fee', field: 'feeMale', value: '' });
    expect(validateSessionForm(state, 'series').feeMale).toEqual(['Enter an amount like 12.00.']);
  });

  it('a repeat-until date before the first date is refused', () => {
    let state = valid();
    state = sessionFormReducer(state, { type: 'set_frequency', value: 'WEEKLY' });
    state = sessionFormReducer(state, { type: 'set_starts_on', value: '2026-11-04' });
    state = sessionFormReducer(state, { type: 'set_recur_until', value: '2026-10-01' });
    expect(validateSessionForm(state, 'series').recurUntil).toEqual([
      "The last date can't be before the first date.",
    ]);
  });
});

describe('mapping API answers back onto the form', () => {
  it('re-keys court and deadline paths to row keys, drops DST codes, and keeps other fields', () => {
    const state = blank();
    const key = state.courts.rows[0]!.key;
    expect(
      mapServerFieldErrors(
        {
          'courts.0.startTime': ['local_time_nonexistent'],
          'courts.0.endTime': ['End must be after start.'],
          'courts.0.identifier': ['Court names must be different.'],
          'cancellationDeadline.time': ['Enter a time like 18:30.'],
          cancellationDeadline: ['The deadline must be before the first court starts.'],
          location: ['Enter a location.'],
          'courts.9.startTime': ['x'],
        },
        state.courts.rows,
      ),
    ).toEqual({
      [`court-${key}-end`]: ['End must be after start.'],
      [`court-${key}-name`]: ['Court names must be different.'],
      deadlineTime: ['Enter a time like 18:30.'],
      deadlineDate: ['The deadline must be before the first court starts.'],
      location: ['Enter a location.'],
      'courts.9.startTime': ['x'],
    });
    expect(mapServerFieldErrors(undefined, state.courts.rows)).toEqual({});
  });

  it('orders the error summary in page order with the court rows between Details and Places', () => {
    const order = errorOrder(blank());
    expect(order.indexOf('location')).toBeLessThan(order.indexOf('court-c1-start'));
    expect(order.indexOf('court-c1-end')).toBeLessThan(order.indexOf('maxPlayers'));
    expect(order.indexOf('feeMale')).toBeLessThan(order.indexOf('deadlineDate'));
  });
});
