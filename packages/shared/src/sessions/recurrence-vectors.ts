/**
 * Recurrence test vectors V1-V26 and E1-E5, copied verbatim from the algorithm doc
 * (memory-bank/creative/session-scheduling-engine-recurrence-algorithm.md, "Test Vectors").
 * They were computed independently (Python `zoneinfo`/`calendar`), never by the code under test.
 * Shared by `recurrence.test.ts` and its host-`TZ` independence probe. Weekdays: 0 = Sunday.
 * NZ DST 2026-27 starts Sun 2026-09-27 and ends Sun 2027-04-04.
 */
export interface RecurrenceVector {
  readonly id: string;
  readonly frequency: 'WEEKLY' | 'FORTNIGHTLY' | 'MONTHLY';
  readonly dayOfWeek: number;
  readonly startsOn: string;
  readonly monthlyWeek: number | null;
  readonly recurUntil: string | null;
  readonly from: string;
  readonly to: string;
  readonly expected: readonly string[];
}

function v(
  id: string,
  frequency: RecurrenceVector['frequency'],
  dayOfWeek: number,
  startsOn: string,
  monthlyWeek: number | null,
  recurUntil: string | null,
  from: string,
  to: string,
  expected: readonly string[],
): RecurrenceVector {
  return { id, frequency, dayOfWeek, startsOn, monthlyWeek, recurUntil, from, to, expected };
}

export const RECURRENCE_VECTORS: readonly RecurrenceVector[] = [
  v('V1', 'WEEKLY', 3, '2026-09-23', null, null, '2026-09-20', '2026-10-10', [
    '2026-09-23',
    '2026-09-30',
    '2026-10-07',
  ]),
  v('V2', 'WEEKLY', 0, '2026-09-20', null, null, '2026-09-20', '2026-10-11', [
    '2026-09-20',
    '2026-09-27',
    '2026-10-04',
    '2026-10-11',
  ]),
  v('V3', 'WEEKLY', 0, '2027-03-21', null, null, '2027-03-21', '2027-04-11', [
    '2027-03-21',
    '2027-03-28',
    '2027-04-04',
    '2027-04-11',
  ]),
  v('V4', 'WEEKLY', 3, '2026-09-02', null, null, '2026-09-21', '2026-10-04', [
    '2026-09-23',
    '2026-09-30',
  ]),
  v('V5', 'WEEKLY', 3, '2027-03-03', null, null, '2027-03-29', '2027-04-11', [
    '2027-03-31',
    '2027-04-07',
  ]),
  v('V6', 'FORTNIGHTLY', 3, '2026-09-16', null, null, '2026-09-20', '2026-11-01', [
    '2026-09-30',
    '2026-10-14',
    '2026-10-28',
  ]),
  v('V7', 'FORTNIGHTLY', 3, '2026-10-14', null, null, '2026-10-01', '2026-11-15', [
    '2026-10-14',
    '2026-10-28',
    '2026-11-11',
  ]),
  v('V8', 'FORTNIGHTLY', 0, '2026-09-13', null, null, '2026-09-13', '2026-10-25', [
    '2026-09-13',
    '2026-09-27',
    '2026-10-11',
    '2026-10-25',
  ]),
  v('V9', 'FORTNIGHTLY', 0, '2027-03-21', null, null, '2027-03-21', '2027-05-02', [
    '2027-03-21',
    '2027-04-04',
    '2027-04-18',
    '2027-05-02',
  ]),
  v('V10', 'MONTHLY', 3, '2026-10-07', 1, null, '2026-10-01', '2027-01-31', [
    '2026-10-07',
    '2026-11-04',
    '2026-12-02',
    '2027-01-06',
  ]),
  v('V11', 'MONTHLY', 5, '2026-10-30', -1, null, '2026-10-01', '2027-01-31', [
    '2026-10-30',
    '2026-11-27',
    '2026-12-25',
    '2027-01-29',
  ]),
  v('V12', 'MONTHLY', 3, '2026-10-28', 4, null, '2026-10-01', '2027-01-31', [
    '2026-10-28',
    '2026-11-25',
    '2026-12-23',
    '2027-01-27',
  ]),
  v('V13', 'MONTHLY', 3, '2026-10-28', -1, null, '2026-10-01', '2027-01-31', [
    '2026-10-28',
    '2026-11-25',
    '2026-12-30',
    '2027-01-27',
  ]),
  v('V14', 'MONTHLY', 0, '2026-09-27', -1, null, '2026-09-01', '2026-12-31', [
    '2026-09-27',
    '2026-10-25',
    '2026-11-29',
    '2026-12-27',
  ]),
  v('V15', 'MONTHLY', 0, '2027-03-07', 1, null, '2027-03-01', '2027-05-31', [
    '2027-03-07',
    '2027-04-04',
    '2027-05-02',
  ]),
  v('V16', 'MONTHLY', 1, '2028-01-31', -1, null, '2028-01-01', '2028-03-31', [
    '2028-01-31',
    '2028-02-28',
    '2028-03-27',
  ]),
  v('V17', 'MONTHLY', 2, '2026-11-10', 2, null, '2026-11-01', '2027-02-28', [
    '2026-11-10',
    '2026-12-08',
    '2027-01-12',
    '2027-02-09',
  ]),
  v('V18', 'WEEKLY', 3, '2026-10-07', null, '2026-10-21', '2026-10-01', '2026-10-31', [
    '2026-10-07',
    '2026-10-14',
    '2026-10-21',
  ]),
  v('V19', 'WEEKLY', 3, '2026-10-07', null, '2026-10-20', '2026-10-01', '2026-10-31', [
    '2026-10-07',
    '2026-10-14',
  ]),
  v('V20', 'WEEKLY', 3, '2026-10-07', null, '2026-10-21', '2026-10-22', '2026-11-30', []),
  v('V21', 'WEEKLY', 3, '2026-12-02', null, null, '2026-10-01', '2026-11-30', []),
  v('V22', 'WEEKLY', 3, '2026-10-07', null, null, '2026-10-14', '2026-10-14', ['2026-10-14']),
  v('V23', 'WEEKLY', 3, '2026-10-07', null, null, '2026-10-15', '2026-10-15', []),
  v('V24', 'WEEKLY', 3, '2026-10-07', null, '2026-10-07', '2026-10-01', '2026-12-31', [
    '2026-10-07',
  ]),
  v('V25', 'MONTHLY', 3, '2026-10-07', 1, null, '2026-10-20', '2026-11-17', ['2026-11-04']),
  v('V26', 'MONTHLY', 6, '2026-12-26', -1, null, '2026-12-01', '2027-02-28', [
    '2026-12-26',
    '2027-01-30',
    '2027-02-27',
  ]),
];

export interface RecurrenceErrorVector {
  readonly id: string;
  readonly frequency: 'WEEKLY' | 'FORTNIGHTLY' | 'MONTHLY';
  readonly dayOfWeek: number;
  readonly startsOn: string;
  readonly monthlyWeek: number | null;
  readonly recurUntil: string | null;
}

/** E1-E3 and E5: every one must throw `RecurrenceRuleError`. (E4, `from > to`, returns `[]`.) */
export const RECURRENCE_ERROR_VECTORS: readonly RecurrenceErrorVector[] = [
  // E1: 2026-10-08 is a Thursday (4) but the rule says Wednesday (3).
  {
    id: 'E1',
    frequency: 'WEEKLY',
    dayOfWeek: 3,
    startsOn: '2026-10-08',
    monthlyWeek: null,
    recurUntil: null,
  },
  // E2: 2026-10-14 is the 2nd Wednesday, the rule says 1st.
  {
    id: 'E2',
    frequency: 'MONTHLY',
    dayOfWeek: 3,
    startsOn: '2026-10-14',
    monthlyWeek: 1,
    recurUntil: null,
  },
  // E3: monthlyWeek 5 and 0 are not allowed.
  {
    id: 'E3a',
    frequency: 'MONTHLY',
    dayOfWeek: 3,
    startsOn: '2026-10-28',
    monthlyWeek: 5,
    recurUntil: null,
  },
  {
    id: 'E3b',
    frequency: 'MONTHLY',
    dayOfWeek: 3,
    startsOn: '2026-10-28',
    monthlyWeek: 0,
    recurUntil: null,
  },
  // E5: recurUntil before startsOn.
  {
    id: 'E5',
    frequency: 'WEEKLY',
    dayOfWeek: 3,
    startsOn: '2026-10-07',
    monthlyWeek: null,
    recurUntil: '2026-10-06',
  },
];
