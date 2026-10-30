/**
 * The admin view of a session row: what `GET /teams/:teamId/sessions/:sessionId` and every write answer with. Pure:
 * `phase` comes from the API clock the caller passes in (T-11), so every reader labels Started and Ended the same way.
 */
import type { Selectable } from 'kysely';
import type { DraftReason, MoneyString, SessionResponse } from '@sgm/shared';
import type { GameSessions } from '../../lib/db/types.generated.ts';
import { sortCourts, trimTime } from './content.ts';

export type SessionRow = Selectable<GameSessions>;

export interface CourtRow {
  readonly id: string;
  readonly court_identifier: string;
  readonly start_time: string;
  readonly end_time: string;
}

/** Upcoming until the first court starts, started until the last court ends, then ended (the end instant is ended). */
export function phaseOf(
  startsAt: Date | null,
  endsAt: Date | null,
  now: Date,
): SessionResponse['phase'] {
  if (endsAt !== null && endsAt.getTime() <= now.getTime()) return 'ended';
  if (startsAt !== null && startsAt.getTime() <= now.getTime()) return 'started';
  return 'upcoming';
}

/**
 * Why a DRAFT is a draft: a series date the admin edited, a series date the materialiser could not publish (banking),
 * or the admin's own one-off. Null for every other status.
 */
export function draftReasonOf(
  row: Pick<SessionRow, 'status' | 'recurring_rule_id' | 'is_instance_overridden'>,
): DraftReason | null {
  if (row.status !== 'DRAFT') return null;
  if (row.recurring_rule_id === null) return 'admin';
  return row.is_instance_overridden ? 'edited' : 'banking';
}

const ZERO_MONEY = '0.00' as MoneyString;

export function toSessionResponse(
  row: SessionRow,
  courts: readonly CourtRow[],
  options: {
    readonly now: Date;
    /** The display count: CONFIRMED and WAITLISTED players ("{n} players are registered"). */
    readonly activeRegistrationCount: number;
    /** The fee-lock count (D-85, widened to a late fee still owed): drives `feesLocked` only. */
    readonly feeLockCount: number;
    /** `seriesName` of the session's rule; null for a one-off. */
    readonly seriesName: string | null;
  },
): SessionResponse {
  return {
    id: row.id,
    teamId: row.team_id,
    recurringRuleId: row.recurring_rule_id,
    status: row.status,
    phase: phaseOf(row.starts_at, row.ends_at, options.now),
    date: row.date,
    location: row.location,
    address: row.address,
    maxPlayers: row.max_players,
    reservedSeats: row.reserved_seats,
    courtCost: row.total_court_cost ?? ZERO_MONEY,
    extraExpenses: row.extra_expenses ?? ZERO_MONEY,
    calculatedRatePerPlayer: row.calculated_rate_per_player,
    customPlayerRate: row.custom_player_rate,
    pricingStructure: row.pricing_structure,
    feeFlat: row.fee_flat,
    feeMale: row.fee_male,
    feeFemale: row.fee_female,
    feeOther: row.fee_other,
    feeBeginner: row.fee_beginner,
    feeIntermediate: row.fee_intermediate,
    feeAdvanced: row.fee_advanced,
    startsAt: row.starts_at?.toISOString() ?? null,
    endsAt: row.ends_at?.toISOString() ?? null,
    cancellationDeadline: row.cancellation_deadline.toISOString(),
    deadlineIsDefault: row.deadline_is_default,
    isInstanceOverridden: row.is_instance_overridden,
    draftReason: draftReasonOf(row),
    seriesName: options.seriesName,
    version: row.version,
    activeRegistrationCount: options.activeRegistrationCount,
    feesLocked:
      row.status === 'PUBLISHED' && options.feeLockCount > 0 ? 'raise_only_blocked' : null,
    courts: sortCourts(
      courts.map((court) => ({
        id: court.id,
        identifier: court.court_identifier,
        startTime: trimTime(court.start_time),
        endTime: trimTime(court.end_time),
      })),
    ),
  };
}
