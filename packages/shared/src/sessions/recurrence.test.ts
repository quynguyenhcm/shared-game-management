import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseLocalDate, type LocalDate } from '../time/time.ts';
import {
  RecurrenceRuleError,
  assertRecurrenceRule,
  defaultMonthlyWeek,
  epochDay,
  isoWeekStart,
  recurrenceDates,
  type RecurrenceRule,
} from './recurrence.ts';
import {
  RECURRENCE_ERROR_VECTORS,
  RECURRENCE_VECTORS,
  type RecurrenceErrorVector,
  type RecurrenceVector,
} from './recurrence-vectors.ts';

const ld = (s: string): LocalDate => parseLocalDate(s);

function ruleOf(v: RecurrenceVector | RecurrenceErrorVector): RecurrenceRule {
  return {
    frequency: v.frequency,
    dayOfWeek: v.dayOfWeek,
    startsOn: ld(v.startsOn),
    monthlyWeek: v.monthlyWeek as RecurrenceRule['monthlyWeek'],
    recurUntil: v.recurUntil === null ? null : ld(v.recurUntil),
  };
}

describe('recurrenceDates: vectors V1-V26 (AC-VERIFY-4)', () => {
  it.each(RECURRENCE_VECTORS.map((v) => [v.id, v] as const))('%s', (_id, v) => {
    expect(recurrenceDates(ruleOf(v), { from: ld(v.from), to: ld(v.to) })).toEqual(v.expected);
  });

  it('E4: an inverted window is empty, not an error', () => {
    const v = RECURRENCE_VECTORS[0] as RecurrenceVector;
    expect(recurrenceDates(ruleOf(v), { from: ld('2026-10-10'), to: ld('2026-10-01') })).toEqual(
      [],
    );
  });
});

describe('recurrenceDates: invalid rules (E1-E3, E5)', () => {
  it.each(RECURRENCE_ERROR_VECTORS.map((v) => [v.id, v] as const))('%s throws', (_id, v) => {
    expect(() =>
      recurrenceDates(ruleOf(v), { from: ld('2026-10-01'), to: ld('2026-12-31') }),
    ).toThrow(RecurrenceRuleError);
    expect(() => assertRecurrenceRule(ruleOf(v))).toThrow(RecurrenceRuleError);
  });

  it('names the offending field so the API can key the 422 on it', () => {
    const field = (v: RecurrenceErrorVector): string | undefined => {
      try {
        assertRecurrenceRule(ruleOf(v));
      } catch (error) {
        return error instanceof RecurrenceRuleError ? error.field : undefined;
      }
      return undefined;
    };
    const byId = Object.fromEntries(RECURRENCE_ERROR_VECTORS.map((v) => [v.id, field(v)]));
    expect(byId).toEqual({
      E1: 'startsOn',
      E2: 'startsOn',
      E3a: 'monthlyWeek',
      E3b: 'monthlyWeek',
      E5: 'recurUntil',
    });
  });

  it('refuses a monthly week on a non-monthly rule and a missing one on a monthly rule', () => {
    const weeklyWithWeek = { ...ruleOf(RECURRENCE_VECTORS[0] as RecurrenceVector), monthlyWeek: 1 };
    expect(() => assertRecurrenceRule(weeklyWithWeek as RecurrenceRule)).toThrow(
      RecurrenceRuleError,
    );
    const monthlyNoWeek = {
      ...ruleOf(RECURRENCE_VECTORS[9] as RecurrenceVector),
      monthlyWeek: null,
    };
    expect(() => assertRecurrenceRule(monthlyNoWeek)).toThrow(RecurrenceRuleError);
  });
});

describe('defaultMonthlyWeek', () => {
  it.each([
    ['2026-10-07', { week: 1, alsoLast: false }],
    ['2026-10-28', { week: 4, alsoLast: true }],
    ['2026-10-30', { week: -1, alsoLast: false }],
    ['2026-12-26', { week: 4, alsoLast: true }],
  ] as const)('%s', (date, expected) => {
    expect(defaultMonthlyWeek(ld(date))).toEqual(expected);
  });
});

describe('isoWeekStart (the banking-email window)', () => {
  it.each([
    ['2026-10-20', '2026-10-19'], // Tuesday
    ['2026-10-19', '2026-10-19'], // Monday
    ['2026-10-25', '2026-10-19'], // Sunday belongs to the week that began on Monday
    ['2026-09-27', '2026-09-21'], // DST-start Sunday
  ])('%s -> %s', (date, monday) => {
    expect(isoWeekStart(ld(date))).toBe(monday);
  });
});

describe('recurrenceDates: property sweep', () => {
  it('every output is in bounds, ascending, on the weekday and on the Fortnightly parity', () => {
    // A small seeded generator keeps the sweep deterministic (no random flake).
    let seed = 20261020;
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % n;
    };
    let checked = 0;
    for (let i = 0; i < 400; i += 1) {
      const dayOfWeek = next(7);
      const startsOnEpoch = epochDay(ld('2026-01-01')) + next(900);
      const probe = new Date(startsOnEpoch * 86_400_000);
      // Move the anchor onto the chosen weekday.
      const shift = (dayOfWeek - probe.getUTCDay() + 7) % 7;
      const anchor = new Date((startsOnEpoch + shift) * 86_400_000).toISOString().slice(0, 10);
      const frequency = (['WEEKLY', 'FORTNIGHTLY', 'MONTHLY'] as const)[next(3)] as
        'WEEKLY' | 'FORTNIGHTLY' | 'MONTHLY';
      const startsOn = ld(anchor);
      const monthlyWeek = frequency === 'MONTHLY' ? defaultMonthlyWeek(startsOn).week : null;
      const recurUntil =
        next(2) === 0
          ? null
          : ld(new Date((epochDay(startsOn) + next(200)) * 86_400_000).toISOString().slice(0, 10));
      const from = ld(
        new Date((epochDay(startsOn) - 30 + next(200)) * 86_400_000).toISOString().slice(0, 10),
      );
      const to = ld(new Date((epochDay(from) + next(120)) * 86_400_000).toISOString().slice(0, 10));
      const dates = recurrenceDates(
        { frequency, dayOfWeek, startsOn, monthlyWeek, recurUntil },
        { from, to },
      );
      let previous = -Infinity;
      for (const date of dates) {
        const day = epochDay(date);
        expect(day).toBeGreaterThan(previous);
        previous = day;
        expect(date >= startsOn && date >= from && date <= to).toBe(true);
        if (recurUntil !== null) expect(date <= recurUntil).toBe(true);
        expect(new Date(day * 86_400_000).getUTCDay()).toBe(dayOfWeek);
        if (frequency === 'FORTNIGHTLY') expect((day - epochDay(startsOn)) % 14).toBe(0);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });
});

describe('host time zone independence (AC-VERIFY-4)', () => {
  const moduleUrl = new URL('./recurrence.ts', import.meta.url).href;
  const vectorsUrl = new URL('./recurrence-vectors.ts', import.meta.url).href;
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const script = `
    import { RECURRENCE_VECTORS } from ${JSON.stringify(vectorsUrl)};
    import * as r from ${JSON.stringify(moduleUrl)};
    const rows = RECURRENCE_VECTORS.map((v) =>
      r.recurrenceDates(
        { frequency: v.frequency, dayOfWeek: v.dayOfWeek, startsOn: v.startsOn,
          monthlyWeek: v.monthlyWeek, recurUntil: v.recurUntil },
        { from: v.from, to: v.to },
      ),
    );
    process.stdout.write(JSON.stringify({ hostOffset: new Date(2026, 0, 1).getTimezoneOffset(), rows }));
  `;

  function runUnder(tz: string): { hostOffset: number; rows: string[][] } {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, TZ: tz }, timeout: 60_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as { hostOffset: number; rows: string[][] };
  }

  it('gives the table results under TZ=UTC and TZ=Pacific/Kiritimati', () => {
    const utc = runUnder('UTC');
    const kiritimati = runUnder('Pacific/Kiritimati');
    expect(utc.hostOffset).toBe(0);
    expect(kiritimati.hostOffset).toBe(-840); // UTC+14: the probe really ran in another zone
    expect(kiritimati.rows).toEqual(utc.rows);
    expect(utc.rows).toEqual(RECURRENCE_VECTORS.map((v) => v.expected));
  });
});
