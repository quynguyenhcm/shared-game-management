import { describe, expect, it } from 'vitest';
import {
  fieldErrorsFromRaised,
  parseCreateSeries,
  parseCreateSession,
  parseUpdateSeries,
  parseUpdateSession,
  readIntent,
} from './sessions-request.ts';

function without(fields: Record<string, string>, name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => key !== name));
}

const KEY = '2f6c1c1e-7a64-4c0e-9d61-3c1f0c1f0a11';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

const SESSION_FIELDS: Record<string, string> = {
  createKey: KEY,
  location: ' Rosedale ',
  address: '1 Court Rd',
  date: '2026-11-04',
  maxPlayers: '18',
  reservedSeats: '2',
  courtCost: '180.00',
  extraExpenses: '20.00',
  pricingStructure: 'FLAT',
  deadlineMode: 'default',
  'courts.0.identifier': 'Court 1',
  'courts.0.startTime': '08:00',
  'courts.0.endTime': '10:00',
  'courts.1.identifier': 'Court 2',
  'courts.1.startTime': '08:00',
  'courts.1.endTime': '09:00',
};

describe('parseCreateSession (posted form to the API wire body)', () => {
  it('builds the strict wire body: numbers as numbers, money as strings, a null deadline for the default, courts in row order', () => {
    const result = parseCreateSession(form(SESSION_FIELDS));
    expect(result).toEqual({
      ok: true,
      body: {
        createKey: KEY,
        location: ' Rosedale ',
        address: '1 Court Rd',
        date: '2026-11-04',
        maxPlayers: 18,
        reservedSeats: 2,
        courtCost: '180.00',
        extraExpenses: '20.00',
        pricingStructure: 'FLAT',
        customPlayerRate: null,
        cancellationDeadline: null,
        courts: [
          { identifier: 'Court 1', startTime: '08:00', endTime: '10:00' },
          { identifier: 'Court 2', startTime: '08:00', endTime: '09:00' },
        ],
      },
    });
  });

  it('sends the pinned rate only when it was posted, and only the active model fees', () => {
    const pinned = parseCreateSession(form({ ...SESSION_FIELDS, customPlayerRate: '13.50' }));
    expect(pinned).toMatchObject({ ok: true, body: { customPlayerRate: '13.50' } });

    const bySex = parseCreateSession(
      form({
        ...SESSION_FIELDS,
        pricingStructure: 'BY_SEX',
        feeMale: '17.00',
        feeFemale: '16.00',
        feeOther: '',
      }),
    );
    expect(bySex).toMatchObject({
      ok: true,
      body: { pricingStructure: 'BY_SEX', feeMale: '17.00', feeFemale: '16.00', feeOther: null },
    });
  });

  it('a specific deadline carries its date, time and DST choice; an overlap choice on a court is the "earlier" flag', () => {
    const result = parseCreateSession(
      form({
        ...SESSION_FIELDS,
        deadlineMode: 'specific',
        deadlineDate: '2026-11-02',
        deadlineTime: '08:00',
        deadlineDisambiguation: 'later',
        'courts.0.startDisambiguation': 'earlier',
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      body: {
        cancellationDeadline: { date: '2026-11-02', time: '08:00', disambiguation: 'later' },
        courts: [{ identifier: 'Court 1', startDisambiguation: 'earlier' }, {}],
      },
    });
  });

  it('refuses with the shared copy, keyed by field path, and never throws on junk', () => {
    const result = parseCreateSession(
      form({
        ...SESSION_FIELDS,
        location: ' ',
        maxPlayers: '',
        'courts.1.identifier': 'Court 1',
        courtCost: 'twelve',
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors.location).toEqual(['Enter a location.']);
    expect(result.fieldErrors.maxPlayers).toEqual(['Enter a whole number of 1 or more.']);
    expect(result.fieldErrors['courts.1.identifier']).toEqual(['Court names must be different.']);
    expect(result.fieldErrors.courtCost).toEqual(['Enter an amount like 12.00.']);
  });

  it('no courts posted is the courts error', () => {
    const only = Object.fromEntries(
      Object.entries(SESSION_FIELDS).filter(([name]) => !name.startsWith('courts.')),
    );
    const result = parseCreateSession(form(only));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.courts).toEqual(['Add at least one court.']);
  });

  it('a missing or malformed createKey is refused before anything is sent', () => {
    const result = parseCreateSession(form({ ...SESSION_FIELDS, createKey: 'nope' }));
    expect(result.ok).toBe(false);
  });
});

describe('parseUpdateSession', () => {
  it('carries expectedVersion instead of createKey', () => {
    const rest = without(SESSION_FIELDS, 'createKey');
    const result = parseUpdateSession(form({ ...rest, expectedVersion: '3' }));
    expect(result).toMatchObject({ ok: true, body: { expectedVersion: 3 } });
    expect(result.ok && 'createKey' in result.body).toBe(false);
  });

  it('refuses a missing version', () => {
    const rest = without(SESSION_FIELDS, 'createKey');
    const result = parseUpdateSession(form(rest));
    expect(result.ok).toBe(false);
  });
});

const SERIES_FIELDS: Record<string, string> = {
  createKey: KEY,
  frequency: 'WEEKLY',
  startsOn: '2026-11-04',
  recurUntil: '',
  location: 'Rosedale',
  address: '1 Court Rd',
  maxPlayers: '18',
  reservedSeats: '0',
  courtCost: '180.00',
  extraExpenses: '20.00',
  pricingStructure: 'FLAT',
  'courts.0.identifier': 'Court 1',
  'courts.0.startTime': '08:00',
  'courts.0.endTime': '10:00',
};

describe('parseCreateSeries (the action derives the weekday from the first date)', () => {
  it('derives dayOfWeek from startsOn, sends null for a blank end and no monthly week for weekly', () => {
    expect(parseCreateSeries(form(SERIES_FIELDS))).toEqual({
      ok: true,
      body: {
        createKey: KEY,
        frequency: 'WEEKLY',
        dayOfWeek: 3,
        startsOn: '2026-11-04',
        monthlyWeek: null,
        recurUntil: null,
        location: 'Rosedale',
        address: '1 Court Rd',
        maxPlayers: 18,
        reservedSeats: 0,
        courtCost: '180.00',
        extraExpenses: '20.00',
        pricingStructure: 'FLAT',
        customPlayerRate: null,
        courts: [{ identifier: 'Court 1', startTime: '08:00', endTime: '10:00' }],
      },
    });
  });

  it('monthly carries the posted week; an end date is kept; DST flags on rows are dropped (a template has none)', () => {
    const result = parseCreateSeries(
      form({
        ...SERIES_FIELDS,
        frequency: 'MONTHLY',
        monthlyWeek: '1',
        recurUntil: '2027-02-03',
        'courts.0.startDisambiguation': 'earlier',
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      body: {
        frequency: 'MONTHLY',
        monthlyWeek: 1,
        recurUntil: '2027-02-03',
        courts: [{ identifier: 'Court 1', startTime: '08:00', endTime: '10:00' }],
      },
    });
    expect(result.ok && 'startDisambiguation' in (result.body.courts?.[0] ?? {})).toBe(false);
  });

  it('refuses a series court that sits wholly in the DST gap with the shared copy', () => {
    const result = parseCreateSeries(
      form({ ...SERIES_FIELDS, 'courts.0.startTime': '02:15', 'courts.0.endTime': '02:45' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors['courts.0.startTime']?.[0]).toMatch(/runs only between 2 and 3 am/);
    }
  });

  it('a first date that is not a date is a startsOn error, not a crash', () => {
    const result = parseCreateSeries(form({ ...SERIES_FIELDS, startsOn: '' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.startsOn).toBeDefined();
  });
});

describe('parseUpdateSeries', () => {
  it('carries expectedVersion and the unchanged pattern read back from the read-only rows', () => {
    const rest = without(SERIES_FIELDS, 'createKey');
    const result = parseUpdateSeries(
      form({ ...rest, expectedVersion: '2', recurUntil: '2027-03-03' }),
    );
    expect(result).toMatchObject({
      ok: true,
      body: { expectedVersion: 2, dayOfWeek: 3, recurUntil: '2027-03-03' },
    });
  });
});

describe('readIntent and raised fields', () => {
  it('accepts only the three intents and otherwise uses the fallback', () => {
    expect(readIntent(form({ intent: 'publish' }), 'draft')).toBe('publish');
    expect(readIntent(form({ intent: 'save' }), 'draft')).toBe('save');
    expect(readIntent(form({ intent: 'draft' }), 'save')).toBe('draft');
    expect(readIntent(form({ intent: 'delete-everything' }), 'save')).toBe('save');
    expect(readIntent(form({}), 'draft')).toBe('draft');
  });

  it('maps the API raisedFields (snake_case columns) to the fee inputs, with the fee-over-the-limit copy', () => {
    expect(fieldErrorsFromRaised(['fee_flat', 'fee_male', 'pricing_structure'])).toEqual({
      customPlayerRate: [
        'This is higher than the current fee. Fees can only be lowered once players have registered.',
      ],
      feeMale: [
        'This is higher than the current fee. Fees can only be lowered once players have registered.',
      ],
    });
    expect(fieldErrorsFromRaised([])).toEqual({});
  });
});
