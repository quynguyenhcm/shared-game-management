/**
 * The display name of a recurring series, derived from its pattern and location (no stored name column).
 * Pure: "Wednesdays at {location}", "Every second Wednesday at {location}", "First Wednesday of the month at {location}".
 */
import type { RecurrenceFrequency } from '../types/enums.ts';
import type { MonthlyWeek } from './recurrence.ts';

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const ORDINALS: Readonly<Record<MonthlyWeek, string>> = {
  1: 'First',
  2: 'Second',
  3: 'Third',
  4: 'Fourth',
  [-1]: 'Last',
};

export interface SeriesNameInput {
  readonly frequency: RecurrenceFrequency;
  /** 0 = Sunday .. 6 = Saturday. */
  readonly dayOfWeek: number;
  /** 1..4 or -1 (last) for MONTHLY, null otherwise. */
  readonly monthlyWeek: number | null;
  readonly location: string;
}

export function seriesName(input: SeriesNameInput): string {
  const day = WEEKDAYS[input.dayOfWeek] ?? 'Day';
  switch (input.frequency) {
    case 'WEEKLY':
      return `${day}s at ${input.location}`;
    case 'FORTNIGHTLY':
      return `Every second ${day} at ${input.location}`;
    case 'MONTHLY': {
      const ordinal = ORDINALS[(input.monthlyWeek ?? 1) as MonthlyWeek] ?? ORDINALS[1];
      return `${ordinal} ${day} of the month at ${input.location}`;
    }
  }
}
