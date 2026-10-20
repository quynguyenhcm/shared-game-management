/**
 * Cron slots that downstream features fill in (architecture Q4, AC-ASYNC-2). All are evaluated in
 * Pacific/Auckland. Foundation wires no-op placeholder handlers that only log; a slot whose feature has shipped (the
 * recurrence sweep, billing later) gets its real handler in `bootstrap.ts`, which replaces the placeholder.
 *
 * DST rule: a calendar-anchored slot must never fire between 02:00 and 02:59 local time. On the day
 * DST starts that hour does not exist and on the day it ends it happens twice, so the job would be
 * skipped or run twice. `assertNoDstHourFirings` enforces it before any schedule is registered.
 * An `intervalSweep` slot (every few minutes, idempotent, not tied to a wall-clock instant) is
 * exempt: a missed or repeated tick changes nothing.
 */
import type { JobHandler, JobRunner } from '../lib/jobs/jobs.ts';
import { QUEUE_NAMES, type QueueName } from './registry.ts';

export const SCHEDULE_TZ = 'Pacific/Auckland';

export interface ScheduleSlot {
  /** Slot name; also the name of the queue the scheduler enqueues into. */
  readonly name: QueueName;
  readonly cron: string;
  readonly tz: string;
  /** Idempotent sweep that runs every few minutes; exempt from the 02:00-02:59 rule. */
  readonly intervalSweep?: boolean;
}

export const SCHEDULES: readonly ScheduleSlot[] = [
  // Sweep fan-out (session-scheduling-engine): one `recurrence-rule` job per active rule, one `session-auto-enrol` job per pending
  // session. Also queued once at every worker boot.
  { name: QUEUE_NAMES.recurrenceMaterialisation, cron: '0 3 * * *', tz: SCHEDULE_TZ },
  // Sweep: a later feature enqueues one `bill-session:<session_id>` job per due session.
  { name: QUEUE_NAMES.postGameBilling, cron: '*/5 * * * *', tz: SCHEDULE_TZ, intervalSweep: true },
  { name: QUEUE_NAMES.dailyOverdue, cron: '0 4 * * *', tz: SCHEDULE_TZ },
  // 05:00 local: after the 02:00-02:59 DST window and after the 03:00/04:00 slots above.
  { name: QUEUE_NAMES.authCleanup, cron: '0 5 * * *', tz: SCHEDULE_TZ },
  // 05:30 local: the last daily slot, after the DST window and every slot above. Idempotent per member.
  { name: QUEUE_NAMES.skillProgression, cron: '30 5 * * *', tz: SCHEDULE_TZ },
];

export type PreviewFn = (
  cron: string,
  options: { tz: string; from: Date; count: number },
) => Date[];

// Windows around the 2026 DST start (2026-09-27) and the 2027 DST end (2027-04-04), with the
// maximum of 1000 occurrences so even a 5-minute cron covers both transition days.
const CHECK_WINDOWS = [new Date('2026-09-25T00:00:00Z'), new Date('2027-04-02T00:00:00Z')];
const CHECK_COUNT = 1000;

const localHour = new Intl.DateTimeFormat('en-NZ', {
  timeZone: SCHEDULE_TZ,
  hour: '2-digit',
  hourCycle: 'h23',
});

/** Occurrences of the slot that land between 02:00 and 02:59 Pacific/Auckland around DST changes. */
export function findDstHourFirings(slot: ScheduleSlot, preview: PreviewFn): Date[] {
  return CHECK_WINDOWS.flatMap((from) =>
    preview(slot.cron, { tz: slot.tz, from, count: CHECK_COUNT }).filter(
      (occurrence) => Number(localHour.format(occurrence)) === 2,
    ),
  );
}

export function assertNoDstHourFirings(slots: readonly ScheduleSlot[], preview: PreviewFn): void {
  for (const slot of slots) {
    if (slot.intervalSweep) continue;
    const firings = findDstHourFirings(slot, preview);
    if (firings.length > 0) {
      throw new Error(
        `schedule "${slot.name}" (${slot.cron}) can fire between 02:00 and 02:59 ${slot.tz} ` +
          `(e.g. ${firings[0]?.toISOString() ?? ''}); that hour is skipped or repeated on DST days`,
      );
    }
  }
}

/** Placeholder for a slot's future handler: logs the invocation and completes. */
export function placeholderHandler(slot: string): JobHandler {
  return (payload, context) => {
    context.logger.info({ event: 'schedule.invoked', slot, payload }, 'schedule slot invoked');
    return Promise.resolve();
  };
}

/** Runs the DST guard, then registers every slot. Idempotent: pg-boss upserts by slot name. */
export async function registerSchedules(
  runner: Pick<JobRunner, 'schedule' | 'previewSchedule'>,
  slots: readonly ScheduleSlot[] = SCHEDULES,
): Promise<void> {
  assertNoDstHourFirings(slots, (cron, options) => runner.previewSchedule(cron, options));
  for (const slot of slots) {
    await runner.schedule(slot.name, slot.cron, {}, { tz: slot.tz });
  }
}
