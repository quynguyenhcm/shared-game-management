/**
 * Shared scaffolding for the registration allocator integration tests: a recording `jobs` double (optionally delegating to
 * a real pg-boss producer, so a test can prove an email job commits or rolls back with the placing transaction), member and
 * session builders, and readers that return the rows the assertions compare.
 */
import type pg from 'pg';
import type { EnqueueOptions, JobRunner } from '../../src/lib/jobs/jobs.ts';
import { insertTeamMember, insertUser } from './factories.ts';
import type { Queryable } from './test-db.ts';

export interface RecordedJob {
  readonly queue: string;
  readonly data: Record<string, unknown>;
  readonly singletonKey: string | undefined;
  /** True when the enqueue was handed a transaction (P5: the job commits with the domain write). */
  readonly inTransaction: boolean;
}

export interface RecordingJobs extends Pick<JobRunner, 'enqueue'> {
  readonly recorded: RecordedJob[];
  /** Only the `send-email` jobs, as their payloads. */
  emails(): { to: string; subject: string; text: string; idempotencyKey: string }[];
  reset(): void;
}

export function createRecordingJobs(delegate?: Pick<JobRunner, 'enqueue'>): RecordingJobs {
  const recorded: RecordedJob[] = [];
  return {
    recorded,
    async enqueue<T extends object>(queue: string, data: T, options: EnqueueOptions = {}) {
      recorded.push({
        queue,
        data: data as Record<string, unknown>,
        singletonKey: options.singletonKey,
        inTransaction: options.trx !== undefined,
      });
      return delegate === undefined ? 'recorded' : delegate.enqueue(queue, data, options);
    },
    emails: () =>
      recorded
        .filter((job) => job.queue === 'send-email')
        .map(
          (job) =>
            job.data as { to: string; subject: string; text: string; idempotencyKey: string },
        ),
    reset() {
      recorded.length = 0;
    },
  };
}

export async function insertMember(
  db: Queryable,
  teamId: string,
  options: {
    sex?: 'MALE' | 'FEMALE' | 'OTHER';
    skill?: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';
    status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'BANNED';
    email?: string;
  } = {},
): Promise<string> {
  const userId = await insertUser(db, options.sex ?? 'MALE', { email: options.email });
  await insertTeamMember(db, {
    teamId,
    userId,
    status: options.status ?? 'APPROVED',
    skillLevel: options.skill ?? 'BEGINNER',
  });
  return userId;
}

export interface RegistrationRow {
  readonly id: string;
  readonly userId: string;
  readonly status: 'CONFIRMED' | 'WAITLISTED' | 'WITHDRAWN';
  readonly queuePosition: number | null;
  readonly guestCount: number;
  readonly registeredAt: Date;
  readonly promotedAt: Date | null;
  readonly withdrawnAt: Date | null;
  readonly withdrawalKind: 'EARLY' | 'LATE' | 'BANNED' | null;
  readonly feeDue: boolean;
  readonly source: 'MEMBER' | 'AUTO_ENROL';
  readonly snapshotSex: 'MALE' | 'FEMALE' | 'OTHER' | null;
  readonly snapshotSkill: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' | null;
}

interface RegistrationSqlRow {
  id: string;
  user_id: string;
  status: RegistrationRow['status'];
  queue_position: number | null;
  guest_count: number;
  registered_at: Date;
  promoted_at: Date | null;
  withdrawn_at: Date | null;
  withdrawal_kind: RegistrationRow['withdrawalKind'];
  withdrawal_fee_due: boolean;
  source: RegistrationRow['source'];
  registrant_sex: RegistrationRow['snapshotSex'];
  registrant_skill_level: RegistrationRow['snapshotSkill'];
}

export async function readRegistrations(
  db: Queryable,
  sessionId: string,
): Promise<RegistrationRow[]> {
  const { rows } = await db.query<RegistrationSqlRow>(
    `SELECT id, user_id, status, queue_position, guest_count, registered_at, promoted_at, withdrawn_at,
            withdrawal_kind, withdrawal_fee_due, source, registrant_sex, registrant_skill_level
       FROM registrations WHERE session_id = $1 ORDER BY registered_at, id`,
    [sessionId],
  );
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    status: row.status,
    queuePosition: row.queue_position,
    guestCount: row.guest_count,
    registeredAt: row.registered_at,
    promotedAt: row.promoted_at,
    withdrawnAt: row.withdrawn_at,
    withdrawalKind: row.withdrawal_kind,
    feeDue: row.withdrawal_fee_due,
    source: row.source,
    snapshotSex: row.registrant_sex,
    snapshotSkill: row.registrant_skill_level,
  }));
}

export async function readRegistration(
  db: Queryable,
  sessionId: string,
  userId: string,
): Promise<RegistrationRow | undefined> {
  return (await readRegistrations(db, sessionId)).find((row) => row.userId === userId);
}

export async function readGuests(
  db: Queryable,
  registrationId: string,
): Promise<{ position: number; sex: string; skillLevel: string; displayName: string | null }[]> {
  const { rows } = await db.query<{
    position: number;
    sex: string;
    skill_level: string;
    display_name: string | null;
  }>(
    `SELECT position, sex, skill_level, display_name FROM registration_guests
      WHERE registration_id = $1 ORDER BY position`,
    [registrationId],
  );
  return rows.map((row) => ({
    position: row.position,
    sex: row.sex,
    skillLevel: row.skill_level,
    displayName: row.display_name,
  }));
}

/** Row counts of every money table: a registration scenario must leave them unchanged (AC-VERIFY-10). */
export async function moneyRowCounts(pool: pg.Pool): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of [
    'payments',
    'payment_line_items',
    'credit_transactions',
    'player_credits',
    'team_invoice_counters',
  ]) {
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    counts[table] = rows[0]?.n ?? 0;
  }
  return counts;
}

/** `{ seatsTaken, waitlist }` straight from SQL: the direct count AC-VERIFY-4 compares the allocator against. */
export async function sqlSeats(
  db: Queryable,
  sessionId: string,
): Promise<{ seatsTaken: number; waitlistPositions: number[]; capacity: number }> {
  const { rows } = await db.query<{ taken: number; positions: number[]; capacity: number }>(
    `SELECT coalesce(sum(1 + guest_count) FILTER (WHERE status = 'CONFIRMED'), 0)::int AS taken,
            coalesce(array_agg(queue_position ORDER BY queue_position) FILTER (WHERE status = 'WAITLISTED'), '{}') AS positions,
            (SELECT max_players - reserved_seats FROM game_sessions WHERE id = $1) AS capacity
       FROM registrations WHERE session_id = $1`,
    [sessionId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('the seat count returned no row');
  return { seatsTaken: row.taken, waitlistPositions: row.positions, capacity: row.capacity };
}
