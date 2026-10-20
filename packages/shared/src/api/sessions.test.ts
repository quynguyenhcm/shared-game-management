import { describe, expect, it } from 'vitest';
import { ErrorCode } from './errors.ts';
import {
  CancelSessionResponse,
  CreateSeriesRequest,
  CreateSessionRequest,
  EndSeriesRequest,
  SESSION_FIELD_MESSAGES,
  ListSessionsQuery,
  SessionCommandRequest,
  SessionDetailResponse,
  SessionErrorResponse,
  SessionIdParams,
  SessionWriteResponse,
  SessionFieldCode,
  SessionListResponse,
  SessionResponse,
  UpdateSeriesRequest,
  UpdateSessionRequest,
  checkSeriesPatternFixed,
} from './sessions.ts';

const KEY = '3b241101-e2bb-4255-8caf-4136c566a962';
const UUID = '0b6f0a5e-5d0b-4a52-9d52-0d9a0f0b1c11';

const court = { identifier: 'Court 1', startTime: '19:00', endTime: '21:00' };
const baseSession = {
  createKey: KEY,
  date: '2026-10-28',
  location: 'Rosedale Hall',
  address: '1 Hall Rd, Auckland',
  maxPlayers: 12,
  courtCost: '120.00',
  extraExpenses: '12.00',
  pricingStructure: 'FLAT',
  courts: [court],
};
const baseSeries = {
  createKey: KEY,
  frequency: 'WEEKLY',
  dayOfWeek: 3,
  startsOn: '2026-10-28',
  location: 'Rosedale Hall',
  address: '1 Hall Rd, Auckland',
  maxPlayers: 12,
  courtCost: '120.00',
  extraExpenses: '12.00',
  pricingStructure: 'FLAT',
  courts: [court],
};

const withoutCreateKey = (body: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'createKey'));

/** Field path -> messages, the shape the web renders beside each field. */
function errorsFor(
  schema: { safeParse(value: unknown): unknown },
  value: unknown,
): Record<string, string[]> {
  const result = schema.safeParse(value) as {
    success: boolean;
    error?: { issues: { path: PropertyKey[]; message: string }[] };
  };
  if (result.success) throw new Error('expected a failure');
  const out: Record<string, string[]> = {};
  for (const issue of result.error?.issues ?? []) {
    (out[issue.path.map(String).join('.') || '_form'] ??= []).push(issue.message);
  }
  return out;
}

describe('CreateSessionRequest (AC-HAPPY-1, AC-ERROR-2)', () => {
  it('accepts a valid body, trims text and parses money to exact Money', () => {
    const parsed = CreateSessionRequest.parse({
      ...baseSession,
      location: '  Rosedale Hall ',
      customPlayerRate: '12.50',
    });
    expect(parsed.location).toBe('Rosedale Hall');
    expect(parsed.courtCost).toBe(12000n);
    expect(parsed.extraExpenses).toBe(1200n);
    expect(parsed.customPlayerRate).toBe(1250n);
    expect(parsed.reservedSeats).toBe(0);
    expect(parsed.cancellationDeadline).toBeNull();
  });

  it('a blank or missing court hire is $0.00 (a free session)', () => {
    const parsed = CreateSessionRequest.parse({
      ...baseSession,
      courtCost: undefined,
      extraExpenses: undefined,
    });
    expect(parsed.courtCost).toBe(0n);
    expect(parsed.extraExpenses).toBe(0n);
  });

  it('is strict: a client can never set what the server owns', () => {
    for (const field of [
      'status',
      'version',
      'feeFlat',
      'calculatedRatePerPlayer',
      'isInstanceOverridden',
      'recurringRuleId',
      'deadlineIsDefault',
      'startsAt',
      'teamId',
    ]) {
      expect(
        errorsFor(CreateSessionRequest, { ...baseSession, [field]: 'x' }),
        field,
      ).toHaveProperty('_form');
    }
    expect(
      errorsFor(CreateSessionRequest, { ...baseSession, courts: [{ ...court, id: 'x' }] }),
    ).toBeDefined();
  });

  it('refuses each invalid input with its copy-deck message on its own field', () => {
    const cases: [string, Record<string, unknown>, string, string][] = [
      [
        'end not after start',
        { courts: [{ ...court, endTime: '19:00' }] },
        'courts.0.endTime',
        'End must be after start.',
      ],
      [
        'crosses midnight',
        { courts: [{ ...court, startTime: '23:00', endTime: '00:30' }] },
        'courts.0.endTime',
        'End must be after start.',
      ],
      [
        'blank court name',
        { courts: [{ ...court, identifier: '   ' }] },
        'courts.0.identifier',
        'Enter a court name.',
      ],
      ['no court', { courts: [] }, 'courts', 'Add at least one court.'],
      [
        'duplicate court',
        { courts: [court, { ...court, startTime: '20:00', endTime: '21:00' }] },
        'courts.1.identifier',
        'Court names must be different.',
      ],
      [
        'max players below 1',
        { maxPlayers: 0 },
        'maxPlayers',
        'Enter a whole number of 1 or more.',
      ],
      [
        'reserved below 0',
        { reservedSeats: -1 },
        'reservedSeats',
        'Enter a whole number of 0 or more.',
      ],
      [
        'reserved above max',
        { reservedSeats: 13 },
        'reservedSeats',
        "Reserved seats can't be more than max players.",
      ],
      ['blank location', { location: ' ' }, 'location', 'Enter a location.'],
      [
        'over-long location',
        { location: 'x'.repeat(256) },
        'location',
        'Use 255 characters or fewer.',
      ],
      [
        'over-long address',
        { address: 'x'.repeat(501) },
        'address',
        'Use 500 characters or fewer.',
      ],
      ['negative amount', { courtCost: '-1.00' }, 'courtCost', "Amount can't be negative."],
      [
        'three decimals',
        { extraExpenses: '1.005' },
        'extraExpenses',
        'Enter an amount like 12.00.',
      ],
      [
        'not an amount',
        { customPlayerRate: 'abc' },
        'customPlayerRate',
        'Enter an amount like 12.00.',
      ],
      ['impossible date', { date: '2026-02-30' }, 'date', 'Enter a valid date.'],
    ];
    for (const [name, patch, path, message] of cases) {
      expect(errorsFor(CreateSessionRequest, { ...baseSession, ...patch })[path], name).toContain(
        message,
      );
    }
  });

  it('accepts an end-of-day 24:00 court end but never a 24:00 start', () => {
    expect(
      CreateSessionRequest.safeParse({ ...baseSession, courts: [{ ...court, endTime: '24:00' }] })
        .success,
    ).toBe(true);
    expect(
      errorsFor(CreateSessionRequest, {
        ...baseSession,
        courts: [{ ...court, startTime: '24:00', endTime: '24:00' }],
      }),
    ).toHaveProperty(['courts.0.startTime']);
  });

  it('takes a transient DST disambiguation of "earlier" only, and an explicit deadline with earlier or later', () => {
    const earlier = {
      ...court,
      startTime: '02:30',
      endTime: '04:00',
      startDisambiguation: 'earlier',
    };
    expect(CreateSessionRequest.safeParse({ ...baseSession, courts: [earlier] }).success).toBe(
      true,
    );
    expect(
      CreateSessionRequest.safeParse({
        ...baseSession,
        courts: [{ ...earlier, startDisambiguation: 'later' }],
      }).success,
    ).toBe(false);

    for (const choice of ['earlier', 'later']) {
      const parsed = CreateSessionRequest.parse({
        ...baseSession,
        cancellationDeadline: { date: '2027-04-04', time: '02:30', disambiguation: choice },
      });
      expect(parsed.cancellationDeadline).toEqual({
        date: '2027-04-04',
        time: '02:30',
        disambiguation: choice,
      });
    }
    expect(
      CreateSessionRequest.safeParse({
        ...baseSession,
        cancellationDeadline: { date: '2027-04-04', time: '02:30', disambiguation: 'compatible' },
      }).success,
    ).toBe(false);
  });

  it('requires a createKey (replay safety) that is a UUID', () => {
    expect(
      errorsFor(CreateSessionRequest, { ...baseSession, createKey: undefined }),
    ).toHaveProperty('createKey');
    expect(errorsFor(CreateSessionRequest, { ...baseSession, createKey: 'nope' })).toHaveProperty(
      'createKey',
    );
  });
});

describe('write requests carry expectedVersion (AC-ERROR-7)', () => {
  it('update, publish and cancel refuse a missing or non-positive version', () => {
    const update = withoutCreateKey(baseSession);
    expect(UpdateSessionRequest.safeParse({ ...update, expectedVersion: 3 }).success).toBe(true);
    expect(UpdateSessionRequest.safeParse(update).success).toBe(false);
    expect(SessionCommandRequest.safeParse({ expectedVersion: 1 }).success).toBe(true);
    for (const bad of [undefined, 0, -1, 1.5, '2']) {
      expect(SessionCommandRequest.safeParse({ expectedVersion: bad }).success, String(bad)).toBe(
        false,
      );
    }
    expect(
      SessionCommandRequest.safeParse({ expectedVersion: 1, status: 'CANCELLED' }).success,
    ).toBe(false);
  });
});

describe('CreateSeriesRequest (AC-HAPPY-5, AC-ERROR-2)', () => {
  it('accepts weekly, fortnightly and monthly series', () => {
    expect(CreateSeriesRequest.parse(baseSeries).monthlyWeek).toBeNull();
    expect(CreateSeriesRequest.parse({ ...baseSeries, frequency: 'FORTNIGHTLY' }).frequency).toBe(
      'FORTNIGHTLY',
    );
    const monthly = CreateSeriesRequest.parse({
      ...baseSeries,
      frequency: 'MONTHLY',
      monthlyWeek: 4,
      recurUntil: '2027-06-30',
    });
    expect(monthly.monthlyWeek).toBe(4);
  });

  it('maps RecurrenceRuleError onto the field the admin can fix', () => {
    // 2026-10-28 is a Wednesday (3).
    expect(errorsFor(CreateSeriesRequest, { ...baseSeries, dayOfWeek: 4 })).toHaveProperty(
      'startsOn',
    );
    expect(
      errorsFor(CreateSeriesRequest, { ...baseSeries, frequency: 'MONTHLY', monthlyWeek: 1 }),
    ).toHaveProperty('startsOn');
    expect(
      errorsFor(CreateSeriesRequest, { ...baseSeries, frequency: 'MONTHLY', monthlyWeek: null }),
    ).toHaveProperty('monthlyWeek');
    expect(errorsFor(CreateSeriesRequest, { ...baseSeries, monthlyWeek: 4 })).toHaveProperty(
      'monthlyWeek',
    );
    expect(
      errorsFor(CreateSeriesRequest, { ...baseSeries, recurUntil: '2026-10-27' }),
    ).toHaveProperty('recurUntil');
    expect(errorsFor(CreateSeriesRequest, { ...baseSeries, dayOfWeek: 7 })).toHaveProperty(
      'dayOfWeek',
    );
  });

  it('refuses a template court that lies wholly between 02:00 and 03:00', () => {
    const errors = errorsFor(CreateSeriesRequest, {
      ...baseSeries,
      courts: [{ ...court, startTime: '02:15', endTime: '02:45' }],
    });
    expect(errors['courts.0.startTime']).toContain(SESSION_FIELD_MESSAGES.templateCourtInDstGap);
    expect(
      CreateSeriesRequest.safeParse({
        ...baseSeries,
        courts: [{ ...court, startTime: '02:30', endTime: '04:00' }],
      }).success,
    ).toBe(true);
  });

  it('refuses a series whose pricing is incomplete, so every instance is publishable', () => {
    expect(
      errorsFor(CreateSeriesRequest, {
        ...baseSeries,
        pricingStructure: 'BY_SKILL_LEVEL',
        feeBeginner: '10.00',
      }),
    ).toHaveProperty('feeIntermediate');
    expect(
      errorsFor(CreateSeriesRequest, {
        ...baseSeries,
        pricingStructure: 'BY_SEX',
        feeMale: '17.00',
      }),
    ).toHaveProperty('feeFemale');
    const ok = CreateSeriesRequest.safeParse({
      ...baseSeries,
      pricingStructure: 'BY_SEX',
      feeMale: '17.00',
      feeFemale: '16.00',
    });
    expect(ok.success).toBe(true);
  });

  it('is strict: no status, version, window or instance flags', () => {
    expect(errorsFor(CreateSeriesRequest, { ...baseSeries, isActive: false })).toHaveProperty(
      '_form',
    );
    expect(errorsFor(CreateSeriesRequest, { ...baseSeries, version: 2 })).toHaveProperty('_form');
  });
});

describe('a series pattern is fixed after creation (AC-ERROR-12, P-3)', () => {
  const saved = {
    frequency: 'FORTNIGHTLY',
    dayOfWeek: 3,
    startsOn: '2026-10-28',
    monthlyWeek: null,
    recurUntil: '2027-03-31',
  } as const;

  it('the update request carries the pattern and expectedVersion', () => {
    const body = withoutCreateKey(baseSeries);
    expect(UpdateSeriesRequest.safeParse({ ...body, expectedVersion: 2 }).success).toBe(true);
    expect(UpdateSeriesRequest.safeParse(body).success).toBe(false);
  });

  it('accepts an unchanged pattern, an extended end date and a cleared end date', () => {
    expect(checkSeriesPatternFixed(saved, saved)).toEqual({});
    expect(checkSeriesPatternFixed(saved, { ...saved, recurUntil: '2027-06-30' })).toEqual({});
    expect(checkSeriesPatternFixed(saved, { ...saved, recurUntil: null })).toEqual({});
  });

  it.each([
    ['frequency', { frequency: 'WEEKLY' }],
    ['dayOfWeek', { dayOfWeek: 4 }],
    ['startsOn', { startsOn: '2026-11-04' }],
    ['monthlyWeek', { frequency: 'MONTHLY', monthlyWeek: 4 }],
  ] as const)('refuses a changed %s with the series_pattern_fixed code', (field, patch) => {
    const result = checkSeriesPatternFixed(saved, { ...saved, ...patch });
    expect(result[field]).toEqual([SessionFieldCode.parse('series_pattern_fixed')]);
  });

  it('refuses a shorter end date, and adding one to an open series, with the End series message', () => {
    expect(checkSeriesPatternFixed(saved, { ...saved, recurUntil: '2027-03-24' })).toEqual({
      recurUntil: ['To stop the series sooner, use End series.'],
    });
    expect(
      checkSeriesPatternFixed(
        { ...saved, recurUntil: null },
        { ...saved, recurUntil: '2027-03-24' },
      ),
    ).toEqual({
      recurUntil: ['To stop the series sooner, use End series.'],
    });
  });
});

describe('EndSeriesRequest (AC-HAPPY-10)', () => {
  it('needs a last date and a version; cancelling published sessions is opt-in', () => {
    const parsed = EndSeriesRequest.parse({ expectedVersion: 2, lastDate: '2026-12-16' });
    expect(parsed.alsoCancelPublished).toBe(false);
    expect(
      EndSeriesRequest.parse({
        expectedVersion: 2,
        lastDate: '2026-12-16',
        alsoCancelPublished: true,
      }).alsoCancelPublished,
    ).toBe(true);
    expect(errorsFor(EndSeriesRequest, { expectedVersion: 2 })).toHaveProperty('lastDate');
    expect(
      errorsFor(EndSeriesRequest, {
        expectedVersion: 2,
        lastDate: '2026-12-16',
        recurUntil: '2026-12-16',
      }),
    ).toHaveProperty('_form');
  });
});

describe('responses and the error envelope', () => {
  const session = {
    id: UUID,
    teamId: UUID,
    recurringRuleId: null,
    status: 'PUBLISHED',
    phase: 'upcoming',
    date: '2026-10-28',
    location: 'Rosedale Hall',
    address: '1 Hall Rd, Auckland',
    maxPlayers: 12,
    reservedSeats: 0,
    courtCost: '120.00',
    extraExpenses: '12.00',
    calculatedRatePerPlayer: '11.00',
    customPlayerRate: null,
    pricingStructure: 'FLAT',
    feeFlat: '11.00',
    feeMale: null,
    feeFemale: null,
    feeOther: null,
    feeBeginner: null,
    feeIntermediate: null,
    feeAdvanced: null,
    startsAt: '2026-10-28T06:00:00.000Z',
    endsAt: '2026-10-28T08:00:00.000Z',
    cancellationDeadline: '2026-10-26T06:00:00.000Z',
    deadlineIsDefault: true,
    isInstanceOverridden: false,
    draftReason: null,
    version: 3,
    activeRegistrationCount: 0,
    feesLocked: 'none',
    courts: [{ id: UUID, identifier: 'Court 1', startTime: '19:00', endTime: '21:00' }],
  };

  it('money crosses the wire as 2-dp strings, never numbers', () => {
    expect(SessionResponse.safeParse(session).success).toBe(true);
    expect(SessionResponse.safeParse({ ...session, feeFlat: 11 }).success).toBe(false);
    expect(SessionResponse.safeParse({ ...session, courtCost: '120' }).success).toBe(false);
    expect(SessionResponse.safeParse({ ...session, feesLocked: 'maybe' }).success).toBe(false);
  });

  it('cancel and list responses wrap the session with the counts the page shows', () => {
    expect(
      CancelSessionResponse.safeParse({
        session: { ...session, status: 'CANCELLED' },
        activeRegistrationCount: 3,
      }).success,
    ).toBe(true);
    expect(
      SessionListResponse.safeParse({
        sessions: [session],
        nextCursor: null,
        isPayoutConfigured: false,
      }).success,
    ).toBe(true);
  });

  it('wraps one session for the detail and write responses, and the list query is strict and coerced', () => {
    expect(SessionDetailResponse.safeParse({ session }).success).toBe(true);
    expect(SessionWriteResponse.safeParse({ session, promoted: 2, material: true }).success).toBe(
      true,
    );
    expect(SessionWriteResponse.safeParse({ session, promoted: -1, material: true }).success).toBe(
      false,
    );
    expect(SessionResponse.safeParse({ ...session, draftReason: 'bank' }).success).toBe(false);
    expect(SessionIdParams.safeParse({ teamId: UUID, sessionId: 'nope' }).success).toBe(false);

    expect(ListSessionsQuery.parse({ view: 'drafts' })).toEqual({ view: 'drafts', limit: 25 });
    expect(ListSessionsQuery.parse({ view: 'past', limit: '50', cursor: 'abc' })).toEqual({
      view: 'past',
      limit: 50,
      cursor: 'abc',
    });
    expect(ListSessionsQuery.safeParse({ view: 'all' }).success).toBe(false);
    expect(ListSessionsQuery.safeParse({ view: 'upcoming', limit: 101 }).success).toBe(false);
    expect(ListSessionsQuery.safeParse({ view: 'upcoming', other: 1 }).success).toBe(false);
  });

  it('the new error codes are part of the shared list', () => {
    for (const code of [
      'session_stale',
      'series_stale',
      'series_ended',
      'session_started',
      'session_not_editable',
      'session_state_conflict',
      'session_fee_locked',
    ]) {
      expect(ErrorCode, code).toContain(code);
    }
  });

  it('carries DST options (T6), raised fields and the current row on the error body', () => {
    const dst = SessionErrorResponse.safeParse({
      error: {
        code: 'validation_failed',
        message: 'Check the highlighted fields and try again.',
        fieldErrors: { 'courts.0.startTime': ['local_time_nonexistent'] },
        dstOptions: [
          {
            field: 'courts.0.startTime',
            date: '2026-09-27',
            time: '02:30',
            kind: 'nonexistent',
            options: [
              { choice: 'shiftedForward', localTime: '03:30', instant: '2026-09-26T14:30:00.000Z' },
              {
                choice: 'shiftedBackward',
                localTime: '01:30',
                instant: '2026-09-26T13:30:00.000Z',
              },
            ],
          },
        ],
      },
    });
    expect(dst.success).toBe(true);
    expect(SessionFieldCode.options).toEqual(
      expect.arrayContaining([
        'local_time_nonexistent',
        'local_time_ambiguous',
        'series_pattern_fixed',
      ]),
    );
    expect(
      SessionErrorResponse.safeParse({
        error: { code: 'session_fee_locked', message: 'm', raisedFields: ['fee_flat'] },
      }).success,
    ).toBe(true);
    expect(
      SessionErrorResponse.safeParse({
        error: { code: 'session_stale', message: 'm', current: session },
      }).success,
    ).toBe(true);
    expect(
      SessionErrorResponse.safeParse({
        error: { code: 'validation_failed', message: 'm', dstOptions: [{ field: 'x' }] },
      }).success,
    ).toBe(false);
  });
});
