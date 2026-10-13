/**
 * DST test-vector table for Pacific/Auckland (algorithm doc §Q7, rows 1-15 and 18-21).
 * Shared by the TS unit tests, the `TZ` independence probe and the SQL `nz_local_to_utc` parity test,
 * so the three can never drift apart. Instants are ISO strings with milliseconds.
 */
export type DstKind = 'unique' | 'nonexistent' | 'ambiguous';

export interface DstVector {
  readonly row: number;
  readonly date: string;
  readonly time: string;
  readonly kind: DstKind;
  readonly compatible: string;
  readonly earlier: string;
  readonly later: string;
  /** Result under the strict policy; `null` when it must throw (nonexistent or ambiguous). */
  readonly reject: string | null;
}

const z = (iso: string): string => iso.replace(/Z$/, '.000Z');

function unique(row: number, date: string, time: string, iso: string): DstVector {
  const at = z(iso);
  return { row, date, time, kind: 'unique', compatible: at, earlier: at, later: at, reject: at };
}

/** Gap: `compatible` and `later` shift forward, `earlier` shifts backward. */
function gap(row: number, date: string, time: string, earlier: string, later: string): DstVector {
  return {
    row,
    date,
    time,
    kind: 'nonexistent',
    compatible: z(later),
    earlier: z(earlier),
    later: z(later),
    reject: null,
  };
}

/** Overlap: `compatible` is the earlier instant. */
function overlap(
  row: number,
  date: string,
  time: string,
  first: string,
  second: string,
): DstVector {
  return {
    row,
    date,
    time,
    kind: 'ambiguous',
    compatible: z(first),
    earlier: z(first),
    later: z(second),
    reject: null,
  };
}

export const DST_VECTORS: readonly DstVector[] = [
  unique(1, '2026-07-01', '19:00', '2026-07-01T07:00:00Z'),
  unique(2, '2026-10-07', '19:00', '2026-10-07T06:00:00Z'),
  unique(3, '2026-09-27', '01:59', '2026-09-26T13:59:00Z'),
  gap(4, '2026-09-27', '02:00', '2026-09-26T13:00:00Z', '2026-09-26T14:00:00Z'),
  gap(5, '2026-09-27', '02:30', '2026-09-26T13:30:00Z', '2026-09-26T14:30:00Z'),
  gap(6, '2026-09-27', '02:59', '2026-09-26T13:59:00Z', '2026-09-26T14:59:00Z'),
  unique(7, '2026-09-27', '03:00', '2026-09-26T14:00:00Z'),
  unique(8, '2026-09-27', '04:00', '2026-09-26T15:00:00Z'),
  unique(9, '2027-04-04', '01:59', '2027-04-03T12:59:00Z'),
  overlap(10, '2027-04-04', '02:00', '2027-04-03T13:00:00Z', '2027-04-03T14:00:00Z'),
  overlap(11, '2027-04-04', '02:30', '2027-04-03T13:30:00Z', '2027-04-03T14:30:00Z'),
  overlap(12, '2027-04-04', '02:59', '2027-04-03T13:59:00Z', '2027-04-03T14:59:00Z'),
  unique(13, '2027-04-04', '03:00', '2027-04-03T15:00:00Z'),
  unique(14, '2027-04-04', '04:00', '2027-04-03T16:00:00Z'),
  unique(15, '2027-04-05', '19:00', '2027-04-05T07:00:00Z'),
  gap(18, '2027-09-26', '02:30', '2027-09-25T13:30:00Z', '2027-09-25T14:30:00Z'),
  overlap(19, '2028-04-02', '02:30', '2028-04-01T13:30:00Z', '2028-04-01T14:30:00Z'),
  unique(20, '2026-12-31', '23:30', '2026-12-31T10:30:00Z'),
  unique(20, '2027-01-01', '00:00', '2026-12-31T11:00:00Z'),
  unique(21, '2026-07-01', '24:00', '2026-07-01T12:00:00Z'),
];
