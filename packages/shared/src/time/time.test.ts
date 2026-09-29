import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DST_VECTORS } from './dst-vectors.ts';
import {
  AmbiguousLocalTimeError,
  APP_TIME_ZONE,
  CANCELLATION_DEADLINE_DEFAULT_HOURS,
  DST_POLICY,
  NonexistentLocalTimeError,
  TimeValidationError,
  addHours,
  addLocalDays,
  assertTimeZone,
  defaultCancellationDeadline,
  formatNzDate,
  formatNzDateTime,
  formatNzTime,
  instantToLocal,
  localToInstant,
  parseIsoInstant,
  parseLocalDate,
  parseLocalTime,
  resolveLocal,
  sameWallClockDaysBefore,
  toIsoInstant,
  type Disambiguation,
  type TimeErrorCode,
} from './time.ts';

const iso = (d: Date): string => d.toISOString();
const at = (s: string): Date => new Date(s);

function timeCode(fn: () => unknown): TimeErrorCode {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TimeValidationError);
    return (error as TimeValidationError).code;
  }
  throw new Error('expected a TimeValidationError');
}

describe('DST vector table (Pacific/Auckland)', () => {
  it('matches every row for compatible, earlier, later and reject', () => {
    for (const v of DST_VECTORS) {
      const label = `${v.date} ${v.time}`;
      const local = (policy: Disambiguation) =>
        localToInstant(parseLocalDate(v.date), parseLocalTime(v.time), policy);
      expect(iso(local('compatible')), `${label} compatible`).toBe(v.compatible);
      expect(iso(local('earlier')), `${label} earlier`).toBe(v.earlier);
      expect(iso(local('later')), `${label} later`).toBe(v.later);
      if (v.reject !== null) {
        expect(iso(local('reject')), `${label} reject`).toBe(v.reject);
      } else if (v.kind === 'nonexistent') {
        expect(() => local('reject'), label).toThrow(NonexistentLocalTimeError);
      } else {
        expect(() => local('reject'), label).toThrow(AmbiguousLocalTimeError);
      }
    }
  });

  it('spring-forward 2026-09-27 02:30: compatible shifts forward, reject throws a typed error with options', () => {
    const d = parseLocalDate('2026-09-27');
    const t = parseLocalTime('02:30');
    expect(iso(localToInstant(d, t, 'compatible'))).toBe('2026-09-26T14:30:00.000Z');
    expect(() => localToInstant(d, t, DST_POLICY.USER_INPUT)).toThrow(NonexistentLocalTimeError);
    expect(DST_POLICY).toEqual({ USER_INPUT: 'reject', DERIVED: 'compatible' });
    try {
      localToInstant(d, t, 'reject');
    } catch (error) {
      const e = error as NonexistentLocalTimeError;
      expect(e.code).toBe('NONEXISTENT_LOCAL_TIME');
      expect(iso(e.shiftedForward)).toBe('2026-09-26T14:30:00.000Z');
      expect(iso(e.shiftedBackward)).toBe('2026-09-26T13:30:00.000Z');
    }
    const resolution = resolveLocal(d, t);
    expect(resolution).toMatchObject({ kind: 'nonexistent', gapMinutes: 60 });
  });

  it('fall-back 2027-04-04 02:30: compatible picks the earlier instant, reject throws with both', () => {
    const d = parseLocalDate('2027-04-04');
    const t = parseLocalTime('02:30');
    expect(iso(localToInstant(d, t, 'compatible'))).toBe('2027-04-03T13:30:00.000Z');
    expect(() => localToInstant(d, t, 'reject')).toThrow(AmbiguousLocalTimeError);
    try {
      localToInstant(d, t, 'reject');
    } catch (error) {
      const e = error as AmbiguousLocalTimeError;
      expect(e.code).toBe('AMBIGUOUS_LOCAL_TIME');
      expect(iso(e.earlier)).toBe('2027-04-03T13:30:00.000Z');
      expect(iso(e.later)).toBe('2027-04-03T14:30:00.000Z');
    }
    expect(resolveLocal(d, t).kind).toBe('ambiguous');
    expect(resolveLocal(parseLocalDate('2026-07-01'), parseLocalTime('19:00')).kind).toBe('unique');
  });

  it('wall-clock to instant to wall-clock round trips every 15-minute slot 2026-2028 (12 gaps, 12 overlaps)', () => {
    let nonexistent = 0;
    let ambiguous = 0;
    let mismatches = 0;
    let date = parseLocalDate('2026-01-01');
    while (date < '2029-01-01') {
      for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
        const time = parseLocalTime(
          `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
        );
        const r = resolveLocal(date, time);
        if (r.kind === 'nonexistent') {
          nonexistent++;
        } else {
          const instants = r.kind === 'unique' ? [r.instant] : [r.earlier, r.later];
          if (r.kind === 'ambiguous') ambiguous++;
          for (const instant of instants) {
            const back = instantToLocal(instant);
            if (back.date !== date || back.time !== time) mismatches++;
          }
        }
      }
      date = addLocalDays(date, 1);
    }
    expect({ nonexistent, ambiguous, mismatches }).toEqual({
      nonexistent: 12,
      ambiguous: 12,
      mismatches: 0,
    });
  });
});

describe('absolute vs wall-clock arithmetic', () => {
  it('48 h before 2027-04-05T07:00Z is 2027-04-03T07:00Z (8:00 pm NZDT); same wall clock is 1 h earlier', () => {
    const start = at('2027-04-05T07:00:00Z');
    expect(CANCELLATION_DEADLINE_DEFAULT_HOURS).toBe(48);
    const deadline = defaultCancellationDeadline(start);
    expect(iso(deadline)).toBe('2027-04-03T07:00:00.000Z');
    expect(iso(addHours(start, -48))).toBe(iso(deadline));
    expect(formatNzDateTime(deadline)).toBe('03/04/2027 8:00 pm');
    const wall = sameWallClockDaysBefore(start, 2, 'compatible');
    expect(iso(wall)).toBe('2027-04-03T06:00:00.000Z');
    expect(formatNzDateTime(wall)).toBe('03/04/2027 7:00 pm');
    expect(() => addHours(start, 1.5)).toThrow(TimeValidationError);
  });

  it('adds calendar days across DST and month/year boundaries', () => {
    expect(addLocalDays(parseLocalDate('2026-09-26'), 1)).toBe('2026-09-27');
    expect(addLocalDays(parseLocalDate('2026-12-31'), 1)).toBe('2027-01-01');
    expect(addLocalDays(parseLocalDate('2028-03-01'), -1)).toBe('2028-02-29');
    expect(addLocalDays(parseLocalDate('2026-07-01'), 7)).toBe('2026-07-08');
    expect(() => addLocalDays(parseLocalDate('2026-07-01'), 0.5)).toThrow(TimeValidationError);
  });
});

describe('formatting and conversion', () => {
  it('formats NZ dates and times by hand (DD/MM/YYYY, h:mm am|pm)', () => {
    expect(formatNzDate(parseLocalDate('2027-04-03'))).toBe('03/04/2027');
    expect(formatNzDate(at('2027-04-03T07:00:00Z'))).toBe('03/04/2027');
    expect(formatNzTime(at('2027-04-03T07:00:00Z'))).toBe('8:00 pm');
    expect(formatNzTime(at('2026-07-01T12:00:00Z'))).toBe('12:00 am');
    expect(formatNzTime(at('2026-07-01T00:00:00Z'))).toBe('12:00 pm');
    expect(formatNzDateTime(at('2026-09-26T14:00:00Z'))).toBe('27/09/2026 3:00 am');
  });

  it('instant to local is always unique and reports the UTC offset', () => {
    expect(instantToLocal(at('2026-09-26T14:00:00Z'))).toEqual({
      date: '2026-09-27',
      time: '03:00',
      utcOffsetMinutes: 780,
    });
    const first = instantToLocal(at('2027-04-03T13:30:00Z'));
    const second = instantToLocal(at('2027-04-03T14:30:00Z'));
    expect([first.date, first.time, second.date, second.time]).toEqual([
      '2027-04-04',
      '02:30',
      '2027-04-04',
      '02:30',
    ]);
    expect([first.utcOffsetMinutes, second.utcOffsetMinutes]).toEqual([780, 720]);
    expect(instantToLocal(at('2026-07-01T07:00:30Z')).time).toBe('19:00:30');
  });

  it('supports other IANA zones and defaults to Pacific/Auckland', () => {
    expect(APP_TIME_ZONE).toBe('Pacific/Auckland');
    const noon = localToInstant(
      parseLocalDate('2026-07-01'),
      parseLocalTime('12:00'),
      'reject',
      'America/New_York',
    );
    expect(iso(noon)).toBe('2026-07-01T16:00:00.000Z');
    expect(instantToLocal(noon, 'America/New_York').time).toBe('12:00');
  });
});

describe('validation', () => {
  it('rejects an unknown time zone with INVALID_TIME_ZONE', () => {
    expect(timeCode(() => assertTimeZone('Mars/Olympus'))).toBe('INVALID_TIME_ZONE');
    expect(timeCode(() => assertTimeZone(42))).toBe('INVALID_TIME_ZONE');
    expect(timeCode(() => instantToLocal(at('2026-07-01T00:00:00Z'), 'Mars/Olympus'))).toBe(
      'INVALID_TIME_ZONE',
    );
    expect(assertTimeZone('Pacific/Auckland')).toBe('Pacific/Auckland');
  });

  it('rejects malformed local dates, local times and instants', () => {
    for (const bad of ['2026-02-30', '2026-9-7', '26-09-07', '2026-13-01', 20260907, null]) {
      expect(
        timeCode(() => parseLocalDate(bad)),
        String(bad),
      ).toBe('INVALID_LOCAL_DATE');
    }
    expect(parseLocalDate('2028-02-29')).toBe('2028-02-29');
    for (const bad of ['25:00', '24:01', '7pm', '12:60', '12:00:60', '9:00', 900, undefined]) {
      expect(
        timeCode(() => parseLocalTime(bad)),
        String(bad),
      ).toBe('INVALID_LOCAL_TIME');
    }
    expect(parseLocalTime('24:00')).toBe('24:00');
    expect(parseLocalTime('07:30:15')).toBe('07:30:15');
    for (const bad of ['2027-04-03T07:00:00', '2027-04-03', 'nope', '2026-02-30T00:00:00Z', 5]) {
      expect(
        timeCode(() => parseIsoInstant(bad)),
        String(bad),
      ).toBe('INVALID_INSTANT');
    }
    expect(iso(parseIsoInstant('2027-04-03T20:00:00+13:00'))).toBe('2027-04-03T07:00:00.000Z');
    expect(iso(parseIsoInstant('2027-04-03T07:00:00.5Z'))).toBe('2027-04-03T07:00:00.500Z');
    expect(toIsoInstant(at('2027-04-03T07:00:00Z'))).toBe('2027-04-03T07:00:00.000Z');
    expect(timeCode(() => toIsoInstant(new Date('nope')))).toBe('INVALID_INSTANT');
    expect(timeCode(() => instantToLocal(new Date('nope')))).toBe('INVALID_INSTANT');
  });
});

describe('host time zone independence', () => {
  const moduleUrl = new URL('./time.ts', import.meta.url).href;
  const vectorsUrl = new URL('./dst-vectors.ts', import.meta.url).href;
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const script = `
    import { DST_VECTORS } from ${JSON.stringify(vectorsUrl)};
    import * as t from ${JSON.stringify(moduleUrl)};
    const out = { hostOffset: new Date(2026, 0, 1).getTimezoneOffset(), rows: [] };
    for (const v of DST_VECTORS) {
      const d = t.parseLocalDate(v.date), tm = t.parseLocalTime(v.time);
      const row = {};
      for (const p of ['compatible', 'earlier', 'later', 'reject']) {
        try { row[p] = t.localToInstant(d, tm, p).toISOString(); } catch (e) { row[p] = e.name; }
      }
      out.rows.push(row);
    }
    const start = new Date('2027-04-05T07:00:00Z');
    out.deadline = t.defaultCancellationDeadline(start).toISOString();
    out.wall = t.sameWallClockDaysBefore(start, 2, 'compatible').toISOString();
    out.display = t.formatNzDateTime(t.defaultCancellationDeadline(start));
    process.stdout.write(JSON.stringify(out));
  `;

  function runUnder(
    tz: string,
  ): { hostOffset: number; rows: Record<string, string>[] } & Record<string, unknown> {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, TZ: tz }, timeout: 60_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as never;
  }

  it('gives identical results under TZ=UTC and TZ=America/New_York', () => {
    const utc = runUnder('UTC');
    const newYork = runUnder('America/New_York');
    // The probe really ran under different host zones.
    expect(utc.hostOffset).toBe(0);
    expect(newYork.hostOffset).toBe(300);
    expect({ ...newYork, hostOffset: 0 }).toEqual({ ...utc, hostOffset: 0 });
    // And they equal the design table.
    utc.rows.forEach((row, index) => {
      const v = DST_VECTORS[index];
      expect(row.compatible).toBe(v?.compatible);
      expect(row.earlier).toBe(v?.earlier);
      expect(row.later).toBe(v?.later);
    });
    expect(utc.deadline).toBe('2027-04-03T07:00:00.000Z');
    expect(utc.wall).toBe('2027-04-03T06:00:00.000Z');
    expect(utc.display).toBe('03/04/2027 8:00 pm');
  });
});
