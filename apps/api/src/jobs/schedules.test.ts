import { describe, expect, it } from 'vitest';
import { createJobRunner } from '../lib/jobs/jobs.ts';
import { createLogger } from '../lib/logger/logger.ts';
import {
  SCHEDULES,
  SCHEDULE_TZ,
  assertNoDstHourFirings,
  findDstHourFirings,
  placeholderHandler,
  registerSchedules,
  type ScheduleSlot,
} from './schedules.ts';

const logger = createLogger({
  service: 'worker',
  version: 'test',
  environment: 'test',
  level: 'silent',
  format: 'json',
  output: 'stdout',
  redactPatterns: [],
});

// pg-boss evaluates cron with cron-parser; previewSchedule needs no database connection.
const runner = createJobRunner({
  databaseUrl: 'postgres://sgm:sgm@localhost:1/none',
  logger,
  role: 'worker',
});
const preview = runner.previewSchedule.bind(runner);

describe('schedule slots', () => {
  it('registers the binding slots (plus auth-cleanup at 05:00, skill-progression at 05:30 and registration-ban-reconcile at 05:45) in Pacific/Auckland', () => {
    expect(SCHEDULE_TZ).toBe('Pacific/Auckland');
    expect(SCHEDULES.map(({ name, cron, tz }) => ({ name, cron, tz }))).toEqual([
      { name: 'recurrence-materialisation', cron: '0 3 * * *', tz: 'Pacific/Auckland' },
      { name: 'post-game-billing', cron: '*/5 * * * *', tz: 'Pacific/Auckland' },
      { name: 'daily-overdue', cron: '0 4 * * *', tz: 'Pacific/Auckland' },
      { name: 'auth-cleanup', cron: '0 5 * * *', tz: 'Pacific/Auckland' },
      { name: 'skill-progression', cron: '30 5 * * *', tz: 'Pacific/Auckland' },
      { name: 'registration-ban-reconcile', cron: '45 5 * * *', tz: 'Pacific/Auckland' },
    ]);
  });

  it('never fires a calendar-anchored slot between 02:00 and 02:59 local, DST days included', () => {
    for (const slot of SCHEDULES.filter((candidate) => !candidate.intervalSweep)) {
      expect(findDstHourFirings(slot, preview), slot.name).toEqual([]);
    }
    expect(() => assertNoDstHourFirings(SCHEDULES, preview)).not.toThrow();
  }, 30_000);

  it('guard rejects a slot that can fire in the skipped/repeated hour', () => {
    const bad: ScheduleSlot = { name: 'daily-overdue', cron: '30 2 * * *', tz: SCHEDULE_TZ };
    const firings = findDstHourFirings(bad, preview);
    expect(firings.length).toBeGreaterThan(0);
    expect(() => assertNoDstHourFirings([bad], preview)).toThrow(/daily-overdue.*02:00/);
    const sweepWithoutExemption: ScheduleSlot = {
      name: 'post-game-billing',
      cron: '*/5 * * * *',
      tz: SCHEDULE_TZ,
    };
    expect(() => assertNoDstHourFirings([sweepWithoutExemption], preview)).toThrow();
  });

  it('fires skill-progression at 05:30 local on both sides of each DST change, never in the 02:00 hour', () => {
    const slot = SCHEDULES.find((candidate) => candidate.name === 'skill-progression');
    expect(slot).toBeDefined();
    expect(slot?.intervalSweep).toBeUndefined();
    const next = (from: string): string | undefined =>
      preview('30 5 * * *', { tz: SCHEDULE_TZ, from: new Date(from), count: 1 })[0]?.toISOString();
    // DST starts 2026-09-27 (NZST +12 -> NZDT +13) and ends 2027-04-04 (NZDT -> NZST).
    expect(next('2026-09-25T17:30:01Z')).toBe('2026-09-26T16:30:00.000Z');
    expect(next('2027-04-02T16:30:01Z')).toBe('2027-04-03T17:30:00.000Z');
    expect(findDstHourFirings(slot as ScheduleSlot, preview)).toEqual([]);
  });

  it('fires the recurrence sweep at 03:00 local on both sides of each DST change and exempts nothing (AC-ASYNC-1)', () => {
    const slot = SCHEDULES.find((candidate) => candidate.name === 'recurrence-materialisation');
    expect(slot).toMatchObject({ cron: '0 3 * * *', tz: SCHEDULE_TZ });
    expect(slot?.intervalSweep).toBeUndefined();
    const next = (from: string): string | undefined =>
      preview('0 3 * * *', { tz: SCHEDULE_TZ, from: new Date(from), count: 1 })[0]?.toISOString();
    // 03:00 NZST (+12) is 15:00Z the day before; 03:00 NZDT (+13) is 14:00Z. DST starts 2026-09-27, ends 2027-04-04.
    expect(next('2026-09-25T14:00:00Z')).toBe('2026-09-25T15:00:00.000Z');
    expect(next('2026-09-25T16:00:00Z')).toBe('2026-09-26T14:00:00.000Z');
    expect(next('2027-04-02T10:00:00Z')).toBe('2027-04-02T14:00:00.000Z');
    expect(next('2027-04-02T15:00:00Z')).toBe('2027-04-03T15:00:00.000Z');
  });

  it('exempts only the flagged idempotent interval sweep', () => {
    expect(SCHEDULES.filter((slot) => slot.intervalSweep).map((slot) => slot.name)).toEqual([
      'post-game-billing',
    ]);
  });

  it('fires registration-ban-reconcile at 05:45 local on both sides of each DST change, never in the 02:00 hour, as the last daily slot (O4)', () => {
    const slot = SCHEDULES.find((candidate) => candidate.name === 'registration-ban-reconcile');
    expect(slot).toBeDefined();
    expect(slot?.intervalSweep).toBeUndefined();
    const next = (from: string): string | undefined =>
      preview('45 5 * * *', { tz: SCHEDULE_TZ, from: new Date(from), count: 1 })[0]?.toISOString();
    expect(next('2026-09-25T17:45:01Z')).toBe('2026-09-26T16:45:00.000Z');
    expect(next('2027-04-02T16:45:01Z')).toBe('2027-04-03T17:45:00.000Z');
    expect(findDstHourFirings(slot as ScheduleSlot, preview)).toEqual([]);
    // Every other daily slot fires earlier in the local morning.
    const daily = SCHEDULES.filter((candidate) => !candidate.intervalSweep);
    expect(daily.at(-1)?.name).toBe('registration-ban-reconcile');
  });

  it('registerSchedules runs the guard first, then schedules every slot with its tz', async () => {
    const calls: unknown[][] = [];
    const fakeRunner = {
      previewSchedule: preview,
      schedule: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve();
      },
    };
    await registerSchedules(fakeRunner);
    expect(calls.map((call) => call.slice(0, 2))).toEqual([
      ['recurrence-materialisation', '0 3 * * *'],
      ['post-game-billing', '*/5 * * * *'],
      ['daily-overdue', '0 4 * * *'],
      ['auth-cleanup', '0 5 * * *'],
      ['skill-progression', '30 5 * * *'],
      ['registration-ban-reconcile', '45 5 * * *'],
    ]);
    expect(calls.every((call) => (call[3] as { tz: string }).tz === 'Pacific/Auckland')).toBe(true);
    calls.length = 0;
    await expect(
      registerSchedules(fakeRunner, [
        { name: 'daily-overdue', cron: '15 2 * * *', tz: SCHEDULE_TZ },
      ]),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('schedule placeholder handlers only log and complete', async () => {
    const infos: Record<string, unknown>[] = [];
    const handler = placeholderHandler('daily-overdue');
    await handler({ source: 'test' }, {
      logger: { info: (fields: Record<string, unknown>) => infos.push(fields) },
      jobId: 'j1',
    } as never);
    expect(infos[0]).toMatchObject({ event: 'schedule.invoked', slot: 'daily-overdue' });
  });
});
