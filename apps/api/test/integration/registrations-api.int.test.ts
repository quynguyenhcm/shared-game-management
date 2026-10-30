/**
 * The registration HTTP API (registration-and-waitlist Phase 3) through the real `buildApp` over a cloned PostgreSQL:
 * routes, guard order, the O2 404 rule, register and withdraw refusals, the read model and the upcoming list.
 * ACs: AC-VERIFY-1 (route reach), AC-ERROR-1, 2, 3, 5, 6, 7, 8 (API side), AC-VERIFY-4 (read model equals SQL),
 * AC-VERIFY-10 (no money rows), AC-ENTRY-2 (identical 404).
 *
 * Nothing sleeps: the one race (AC-ERROR-7) holds a real member row lock and asks `pg_stat_activity` who is blocked.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { START_TIME, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  advanceSessionTo,
  insertGuest,
  insertPayment,
  insertPublishedSession,
  insertRegistration,
  insertSession,
} from '../helpers/factories.ts';
import { waitForLockWaiters } from '../helpers/lock-waiters.ts';
import {
  call,
  errorOf,
  httpMember,
  httpOutsider,
  readAs,
  readModelOf,
  registeredOf,
  registerAs,
  sessionUrl,
  upcomingAs,
  upcomingOf,
  withdrawAs,
  withdrawnOf,
} from '../helpers/registrations-http.ts';
import {
  createRecordingJobs,
  moneyRowCounts,
  readGuests,
  readRegistration,
  readRegistrations,
  sqlSeats,
} from '../helpers/registration-scene.ts';
import { createTestDatabase, inTransaction, type TestDatabase } from '../helpers/test-db.ts';

let database: TestDatabase;
let h: AuthTestApp;
const jobs = createRecordingJobs();

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 20 });
  h = await buildAuthTestApp(database.pool, { jobs });
});
afterAll(async () => {
  await h.close();
  await database.close();
});
beforeEach(() => {
  h.clock.set(START_TIME);
  jobs.reset();
});

interface Scene {
  teamId: string;
  sessionId: string;
  startsAt: Date;
  deadline: Date;
}

async function scene(
  options: { maxPlayers?: number; reservedSeats?: number; teamId?: string } = {},
): Promise<Scene> {
  const { sessionId, teamId } = await insertPublishedSession(database.pool, options.teamId, {
    now: h.clock.now(),
    maxPlayers: options.maxPlayers ?? 10,
    reservedSeats: options.reservedSeats,
  });
  const { rows } = await database.pool.query<{ starts_at: Date; cancellation_deadline: Date }>(
    `SELECT starts_at, cancellation_deadline FROM game_sessions WHERE id = $1`,
    [sessionId],
  );
  return {
    teamId,
    sessionId,
    startsAt: rows[0]?.starts_at as Date,
    deadline: rows[0]?.cancellation_deadline as Date,
  };
}

/** A row written straight to the database (the lifecycle CHECKs hold), so a test can start from any state. */
async function seed(
  s: Scene,
  userId: string,
  options: {
    status: 'CONFIRMED' | 'WAITLISTED' | 'WITHDRAWN';
    queuePosition?: number;
    guests?: number;
    feeDue?: boolean;
  },
): Promise<string> {
  return inTransaction(database.pool, async (client) => {
    const id = await insertRegistration(client, {
      sessionId: s.sessionId,
      teamId: s.teamId,
      userId,
      status: options.status,
      queuePosition: options.queuePosition,
      guestCount: options.guests ?? 0,
      withdrawalFeeDue: options.feeDue,
    });
    for (let position = 1; position <= (options.guests ?? 0); position += 1) {
      await insertGuest(client, id, position);
    }
    return id;
  });
}

async function owes(
  userId: string,
  status: 'OVERDUE' | 'PENDING' | 'PAID' | 'FAILED',
): Promise<void> {
  const elsewhere = await scene();
  const registrationId = await seed(elsewhere, userId, { status: 'CONFIRMED' });
  const paymentId = await insertPayment(database.pool, {
    userId,
    teamId: elsewhere.teamId,
    registrationId,
    amount: '17.00',
  });
  if (status !== 'PENDING') {
    await database.pool.query(
      `UPDATE payments SET status = $2::payment_status, paid_at = CASE WHEN $3::boolean THEN now() END WHERE id = $1`,
      [paymentId, status, status === 'PAID'],
    );
  }
}

const rowCount = async (sessionId: string): Promise<number> =>
  (await readRegistrations(database.pool, sessionId)).length;

// ---------------------------------------------------------------------------------------------
// Guard order and access (AC-VERIFY-1)
// ---------------------------------------------------------------------------------------------

describe('access control: the guard answers before the body is validated', () => {
  it('answers 401 anonymously and 403 to a non-member, a banned, a pending and another team member, never 422, and writes nothing', async () => {
    const s = await scene();
    const other = await scene();
    const outsider = await httpOutsider(h);
    const banned = await httpMember(h, s.teamId, { status: 'BANNED' });
    const pending = await httpMember(h, s.teamId, { status: 'PENDING' });
    const elsewhere = await httpMember(h, other.teamId);
    const garbage = { status: 'CONFIRMED', nonsense: 1 };
    const url = sessionUrl(s.teamId, s.sessionId);
    const routes: ['GET' | 'POST', string, unknown][] = [
      ['GET', `${url}/registration`, undefined],
      ['POST', `${url}/registrations`, garbage],
      ['POST', `${url}/registrations/me/withdraw`, garbage],
      ['GET', `/teams/${s.teamId}/sessions/upcoming`, undefined],
    ];
    for (const [method, path, payload] of routes) {
      expect(
        (await call(h, method, path, null, payload)).statusCode,
        `anon ${method} ${path}`,
      ).toBe(401);
      for (const who of [outsider, banned, pending, elsewhere]) {
        const res = await call(h, method, path, who.token, payload);
        expect(res.statusCode, `${method} ${path}`).toBe(403);
        expect(errorOf(res).code).toBe('forbidden');
      }
    }
    expect(await rowCount(s.sessionId)).toBe(0);
  });

  it('answers a MEMBER on GET .../sessions/upcoming from registration, not from the TEAM_ADMIN session route (R23)', async () => {
    const s = await scene();
    const member = await httpMember(h, s.teamId);
    const res = await upcomingAs(h, member, s.teamId);
    expect(res.statusCode, res.body).toBe(200);
    expect(upcomingOf(res)).toMatchObject({ hasMore: false });
    // The sibling parametric route of session-scheduling-engine stays admin only.
    const admin = await call(h, 'GET', sessionUrl(s.teamId, s.sessionId), member.token);
    expect(admin.statusCode).toBe(403);
  });

  it('answers an identical 404 for another team session, a DRAFT session and an unknown id (O2, AC-ENTRY-2)', async () => {
    const s = await scene();
    const foreign = await scene();
    const draft = await insertSession(database.pool, s.teamId, {}, { status: 'DRAFT' });
    const member = await httpMember(h, s.teamId);
    const bodies = new Set<string>();
    // Control: the route exists, so a 404 below is the session lookup, not a missing route.
    expect((await readAs(h, member, s.teamId, s.sessionId)).statusCode).toBe(200);
    for (const sessionId of [foreign.sessionId, draft, randomUUID()]) {
      for (const [method, suffix, payload] of [
        ['GET', '/registration', undefined],
        ['POST', '/registrations', { guests: [] }],
        ['POST', '/registrations/me/withdraw', { expectLate: false }],
      ] as const) {
        const res = await call(
          h,
          method,
          `${sessionUrl(s.teamId, sessionId)}${suffix}`,
          member.token,
          payload,
        );
        expect(res.statusCode, `${method} ${suffix} ${sessionId}`).toBe(404);
        expect(errorOf(res).code).toBe('not_found');
        bodies.add(`${method} ${suffix} ${res.body}`);
      }
    }
    // Three session ids, three routes: exactly three distinct bodies (one per route), whatever the id.
    expect(bodies.size).toBe(3);
    expect(await rowCount(foreign.sessionId)).toBe(0);
    expect(await rowCount(draft)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------------------------

describe('POST .../registrations', () => {
  it('registers alone: 201 CONFIRMED with no rank, one row, and the read model agrees (AC-VERIFY-4)', async () => {
    const s = await scene({ maxPlayers: 4 });
    const me = await httpMember(h, s.teamId, { sex: 'FEMALE', skill: 'INTERMEDIATE' });
    const res = await registerAs(h, me, s.teamId, s.sessionId);
    expect(res.statusCode, res.body).toBe(201);
    const registration = registeredOf(res);
    expect(registration).toMatchObject({
      status: 'CONFIRMED',
      waitlistRank: null,
      guestCount: 0,
      guests: [],
      source: 'MEMBER',
      withdrawalFeeDue: false,
    });
    expect(await readRegistration(database.pool, s.sessionId, me.userId)).toMatchObject({
      status: 'CONFIRMED',
      source: 'MEMBER',
      snapshotSex: 'FEMALE',
      snapshotSkill: 'INTERMEDIATE',
    });

    const read = await readAs(h, me, s.teamId, s.sessionId);
    expect(read.statusCode).toBe(200);
    const model = readModelOf(read);
    const seats = await sqlSeats(database.pool, s.sessionId);
    expect(model.session).toMatchObject({
      id: s.sessionId,
      teamId: s.teamId,
      status: 'PUBLISHED',
      publicCapacity: 4,
      seatsTaken: seats.seatsTaken,
      seatsLeft: 4 - seats.seatsTaken,
      waitlistLength: 0,
      pricingStructure: 'FLAT',
    });
    expect(model.session.fees.flat).toBe('17.00');
    expect(model.me).toMatchObject({ unitFee: '17.00', estimatedTotal: '17.00', overdueCount: 0 });
    expect(model.me.registration?.status).toBe('CONFIRMED');
    expect(model).toMatchObject({ canRegister: false, blockedReason: 'already_registered' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('R15: me.feeLevel names the current level on a skill-level session, for a never-registered and a waitlisted caller; null otherwise', async () => {
    const skill = await insertPublishedSession(database.pool, undefined, {
      now: h.clock.now(),
      maxPlayers: 1,
      pricing: 'BY_SKILL_LEVEL',
      beginner: '15.00',
      intermediate: '17.00',
      advanced: '20.00',
    });
    const never = await httpMember(h, skill.teamId, { skill: 'INTERMEDIATE' });
    expect(readModelOf(await readAs(h, never, skill.teamId, skill.sessionId)).me).toMatchObject({
      feeLevel: 'INTERMEDIATE',
      unitFee: '17.00',
    });
    const taker = await httpMember(h, skill.teamId);
    expect((await registerAs(h, taker, skill.teamId, skill.sessionId)).statusCode).toBe(201);
    const waiting = await httpMember(h, skill.teamId, { skill: 'ADVANCED' });
    const joined = await registerAs(h, waiting, skill.teamId, skill.sessionId);
    expect(registeredOf(joined).status).toBe('WAITLISTED');
    expect(readModelOf(await readAs(h, waiting, skill.teamId, skill.sessionId)).me).toMatchObject({
      feeLevel: 'ADVANCED',
    });
    const flat = await scene();
    const member = await httpMember(h, flat.teamId, { skill: 'ADVANCED' });
    expect(
      readModelOf(await readAs(h, member, flat.teamId, flat.sessionId)).me.feeLevel,
    ).toBeNull();
  });

  it('puts a full session onto the waitlist with rank 1, 2, and the rank follows the queue when someone ahead leaves', async () => {
    const s = await scene({ maxPlayers: 1 });
    const holder = await httpMember(h, s.teamId);
    await seed(s, holder.userId, { status: 'CONFIRMED' });
    const first = await httpMember(h, s.teamId);
    const second = await httpMember(h, s.teamId);
    const third = await httpMember(h, s.teamId);
    const r1 = await registerAs(h, first, s.teamId, s.sessionId);
    const r2 = await registerAs(h, second, s.teamId, s.sessionId);
    const r3 = await registerAs(h, third, s.teamId, s.sessionId);
    expect([r1, r2, r3].map((r) => r.statusCode)).toEqual([201, 201, 201]);
    expect([r1, r2, r3].map((r) => registeredOf(r).status)).toEqual([
      'WAITLISTED',
      'WAITLISTED',
      'WAITLISTED',
    ]);
    expect([r1, r2, r3].map((r) => registeredOf(r).waitlistRank)).toEqual([1, 2, 3]);

    // The first in line leaves: the others move up, rank is 1 + the waiting parties ahead, never the raw position.
    expect((await withdrawAs(h, first, s.teamId, s.sessionId)).statusCode).toBe(200);
    const model = readModelOf(await readAs(h, third, s.teamId, s.sessionId));
    expect(model.me.registration).toMatchObject({ status: 'WAITLISTED', waitlistRank: 2 });
    const seats = await sqlSeats(database.pool, s.sessionId);
    expect(model.session).toMatchObject({
      seatsTaken: seats.seatsTaken,
      seatsLeft: 0,
      waitlistLength: seats.waitlistPositions.length,
    });
    expect(model).toMatchObject({ canRegister: false, blockedReason: 'already_registered' });
  });

  it('takes a party with two guests: trims names, stores an empty name as NULL, estimates the whole party', async () => {
    const s = await scene({ maxPlayers: 10 });
    const me = await httpMember(h, s.teamId);
    const res = await registerAs(h, me, s.teamId, s.sessionId, {
      guests: [
        { sex: 'MALE', skillLevel: 'BEGINNER', displayName: '  Aroha  ' },
        { sex: 'OTHER', skillLevel: 'ADVANCED', displayName: '   ' },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    const registration = registeredOf(res);
    expect(registration.guestCount).toBe(2);
    expect(registration.guests).toEqual([
      { position: 1, sex: 'MALE', skillLevel: 'BEGINNER', displayName: 'Aroha' },
      { position: 2, sex: 'OTHER', skillLevel: 'ADVANCED', displayName: null },
    ]);
    expect(await readGuests(database.pool, registration.id)).toEqual([
      { position: 1, sex: 'MALE', skillLevel: 'BEGINNER', displayName: 'Aroha' },
      { position: 2, sex: 'OTHER', skillLevel: 'ADVANCED', displayName: null },
    ]);
    expect((await sqlSeats(database.pool, s.sessionId)).seatsTaken).toBe(3);
    const model = readModelOf(await readAs(h, me, s.teamId, s.sessionId));
    expect(model.me.estimatedTotal).toBe('51.00');
    expect(model.me.unitFee).toBe('17.00');
    expect(model.session.seatsTaken).toBe(3);
  });

  it('AC-ERROR-5: invalid guest details are 422 validation_failed keyed by field, and nothing is written', async () => {
    const s = await scene();
    const me = await httpMember(h, s.teamId);
    const fields = async (body: unknown): Promise<Record<string, string[]>> => {
      const res = await registerAs(h, me, s.teamId, s.sessionId, body as Record<string, unknown>);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
      expect(errorOf(res).code).toBe('validation_failed');
      return errorOf(res).fieldErrors ?? {};
    };
    expect(await fields({ guests: [{ skillLevel: 'BEGINNER' }] })).toHaveProperty(['guests.0.sex']);
    expect(
      await fields({
        guests: [
          { sex: 'MALE', skillLevel: 'BEGINNER' },
          { sex: 'FEMALE', displayName: 'ok' },
        ],
      }),
    ).toHaveProperty(['guests.1.skillLevel']);
    expect(
      await fields({
        guests: [{ sex: 'MALE', skillLevel: 'BEGINNER', displayName: 'x'.repeat(101) }],
      }),
    ).toHaveProperty(['guests.0.displayName']);
    expect(await fields({ guests: [{ sex: 'ROBOT', skillLevel: 'BEGINNER' }] })).toHaveProperty([
      'guests.0.sex',
    ]);
    const three = { sex: 'MALE', skillLevel: 'BEGINNER' };
    expect(await fields({ guests: [three, three, three] })).toHaveProperty(['guests']);
    for (const extra of ['status', 'queuePosition', 'userId', 'teamId']) {
      const found = await fields({ guests: [], [extra]: 'x' });
      expect(found).toHaveProperty(['_form']);
      // An unknown key is reported without naming it (client input is never echoed).
      expect(JSON.stringify(found)).not.toContain(extra);
    }
    expect(await fields({})).toHaveProperty(['guests']);
    expect(await rowCount(s.sessionId)).toBe(0);
  });

  it('AC-ERROR-1: three OVERDUE payments are refused 403 with the count, nothing written, and the read model says why; two are fine', async () => {
    const s = await scene();
    const debtor = await httpMember(h, s.teamId);
    for (let i = 0; i < 3; i += 1) await owes(debtor.userId, 'OVERDUE');
    const lenient = await httpMember(h, s.teamId);
    for (const status of ['OVERDUE', 'OVERDUE', 'PENDING', 'PAID', 'FAILED'] as const) {
      await owes(lenient.userId, status);
    }

    const blocked = await registerAs(h, debtor, s.teamId, s.sessionId, {
      guests: [{ sex: 'MALE', skillLevel: 'BEGINNER' }],
    });
    expect(blocked.statusCode).toBe(403);
    expect(errorOf(blocked)).toMatchObject({
      code: 'overdue_payments',
      message: 'You have 3 overdue payments. Pay them before registering for more sessions.',
    });
    expect(await rowCount(s.sessionId)).toBe(0);
    const { rows: guestRows } = await database.pool.query(
      `SELECT 1 FROM registration_guests g JOIN registrations r ON r.id = g.registration_id WHERE r.session_id = $1`,
      [s.sessionId],
    );
    expect(guestRows).toHaveLength(0);

    const model = readModelOf(await readAs(h, debtor, s.teamId, s.sessionId));
    expect(model).toMatchObject({
      canRegister: false,
      blockedReason: 'overdue_payments',
      me: { overdueCount: 3 },
    });

    expect((await registerAs(h, lenient, s.teamId, s.sessionId)).statusCode).toBe(201);
    expect(readModelOf(await readAs(h, lenient, s.teamId, s.sessionId)).me.overdueCount).toBe(2);
  });

  it('AC-ERROR-1 / O2: a debtor registering to an unknown, DRAFT or other-team session gets the same 404 as a member without debt, never 403', async () => {
    const s = await scene();
    const foreign = await scene();
    const draft = await insertSession(database.pool, s.teamId, {}, { status: 'DRAFT' });
    const debtor = await httpMember(h, s.teamId);
    for (let i = 0; i < 3; i += 1) await owes(debtor.userId, 'OVERDUE');
    const clean = await httpMember(h, s.teamId);
    for (const sessionId of [foreign.sessionId, draft, randomUUID()]) {
      const asDebtor = await registerAs(h, debtor, s.teamId, sessionId);
      const asClean = await registerAs(h, clean, s.teamId, sessionId);
      expect(asClean.statusCode, sessionId).toBe(404);
      expect(asDebtor.statusCode, sessionId).toBe(404);
      expect(errorOf(asDebtor).code).toBe('not_found');
      expect(asDebtor.body).toBe(asClean.body);
    }
    // No regression: on a visible open session the debt gate still answers 403.
    const blocked = await registerAs(h, debtor, s.teamId, s.sessionId);
    expect(blocked.statusCode).toBe(403);
    expect(errorOf(blocked).code).toBe('overdue_payments');
  });

  it('AC-ERROR-1: debt never blocks a withdrawal', async () => {
    const s = await scene();
    const debtor = await httpMember(h, s.teamId);
    await seed(s, debtor.userId, { status: 'CONFIRMED' });
    for (let i = 0; i < 3; i += 1) await owes(debtor.userId, 'OVERDUE');
    const res = await withdrawAs(h, debtor, s.teamId, s.sessionId);
    expect(res.statusCode, res.body).toBe(200);
    expect((await readRegistration(database.pool, s.sessionId, debtor.userId))?.status).toBe(
      'WITHDRAWN',
    );
  });

  it('AC-ERROR-2: COMPLETED, CANCELLED and started sessions are 409 session_not_open for register and withdraw, and the read model still answers', async () => {
    for (const label of ['COMPLETED', 'CANCELLED', 'started'] as const) {
      const s = await scene();
      const member = await httpMember(h, s.teamId);
      const fresh = await httpMember(h, s.teamId);
      await seed(s, member.userId, { status: 'CONFIRMED' });
      if (label === 'COMPLETED') await advanceSessionTo(database.pool, s.sessionId, 'COMPLETED');
      if (label === 'CANCELLED') await advanceSessionTo(database.pool, s.sessionId, 'CANCELLED');
      if (label === 'started') h.clock.set(s.startsAt);
      const reg = await registerAs(h, fresh, s.teamId, s.sessionId);
      expect(reg.statusCode, `${label} register`).toBe(409);
      expect(errorOf(reg)).toMatchObject({
        code: 'session_not_open',
        message: 'Registration for this session is closed.',
      });
      const out = await withdrawAs(h, member, s.teamId, s.sessionId);
      expect(out.statusCode, `${label} withdraw`).toBe(409);
      expect(errorOf(out).code).toBe('session_not_open');
      expect((await readRegistration(database.pool, s.sessionId, member.userId))?.status).toBe(
        'CONFIRMED',
      );
      expect(await readRegistration(database.pool, s.sessionId, fresh.userId)).toBeUndefined();
      const read = await readAs(h, member, s.teamId, s.sessionId);
      expect(read.statusCode, `${label} read`).toBe(200);
      const model = readModelOf(read);
      expect(model).toMatchObject({ canRegister: false, blockedReason: 'session_not_open' });
      // The panel's only signal about a cancelled session: its status and the caller's untouched row (R27).
      expect(model.me.registration?.status).toBe('CONFIRMED');
      if (label === 'CANCELLED') expect(model.session.status).toBe('CANCELLED');
      h.clock.set(START_TIME);
    }
  });

  it('AC-ERROR-4: a party that can never fit is 422 party_exceeds_capacity with the capacity in the message, nothing written', async () => {
    const small = await scene({ maxPlayers: 2 });
    const me = await httpMember(h, small.teamId);
    const res = await registerAs(h, me, small.teamId, small.sessionId, {
      guests: [
        { sex: 'MALE', skillLevel: 'BEGINNER' },
        { sex: 'MALE', skillLevel: 'BEGINNER' },
      ],
    });
    expect(res.statusCode).toBe(422);
    expect(errorOf(res)).toMatchObject({
      code: 'party_exceeds_capacity',
      message: "This session has 2 public places, so a group of 3 can't register.",
    });
    expect(await rowCount(small.sessionId)).toBe(0);

    const none = await scene({ maxPlayers: 4, reservedSeats: 4 });
    const solo = await httpMember(h, none.teamId);
    const refused = await registerAs(h, solo, none.teamId, none.sessionId);
    expect(refused.statusCode).toBe(422);
    expect(errorOf(refused).message).toContain('0 public places');
    expect(readModelOf(await readAs(h, solo, none.teamId, none.sessionId))).toMatchObject({
      canRegister: false,
      blockedReason: 'party_exceeds_capacity',
    });
  });

  it('AC-ERROR-3: a second submit is 409 already_registered, one row, and no queue position is consumed', async () => {
    const s = await scene({ maxPlayers: 1 });
    await seed(s, (await httpMember(h, s.teamId)).userId, { status: 'CONFIRMED' });
    const me = await httpMember(h, s.teamId);
    expect((await registerAs(h, me, s.teamId, s.sessionId)).statusCode).toBe(201);
    const again = await registerAs(h, me, s.teamId, s.sessionId);
    expect(again.statusCode).toBe(409);
    expect(errorOf(again)).toMatchObject({
      code: 'already_registered',
      message: "You're already registered for this session.",
    });
    const mine = (await readRegistrations(database.pool, s.sessionId)).filter(
      (row) => row.userId === me.userId,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.queuePosition).toBe(1);
    // The next newcomer still gets position 2.
    const next = await httpMember(h, s.teamId);
    expect(registeredOf(await registerAs(h, next, s.teamId, s.sessionId)).waitlistRank).toBe(2);
  });

  it('AC-ERROR-7: a ban committed after the guard passed and before the transaction gate is 403 forbidden and writes nothing', async () => {
    const s = await scene();
    const victim = await httpMember(h, s.teamId);
    const client = await database.pool.connect();
    await client.query('BEGIN');
    try {
      await client.query(
        'SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2 FOR NO KEY UPDATE',
        [s.teamId, victim.userId],
      );
      const pending = registerAs(h, victim, s.teamId, s.sessionId);
      await waitForLockWaiters(database.pool, 1, 'register blocked on the member row');
      await client.query(
        `UPDATE team_members SET status = 'BANNED', banned_at = now(), banned_by = user_id WHERE team_id = $1 AND user_id = $2`,
        [s.teamId, victim.userId],
      );
      await client.query('COMMIT');
      const res = await pending;
      expect(res.statusCode, res.body).toBe(403);
      expect(errorOf(res).code).toBe('forbidden');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    expect(await rowCount(s.sessionId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Withdraw
// ---------------------------------------------------------------------------------------------

describe('POST .../registrations/me/withdraw', () => {
  it('AC-ERROR-6: never registered, and a second withdraw after the first, are 409 not_registered with nothing changed and no second promotion', async () => {
    const s = await scene({ maxPlayers: 1 });
    const holder = await httpMember(h, s.teamId);
    await seed(s, holder.userId, { status: 'CONFIRMED' });
    const w1 = await httpMember(h, s.teamId);
    const w2 = await httpMember(h, s.teamId);
    await seed(s, w1.userId, { status: 'WAITLISTED', queuePosition: 1 });
    await seed(s, w2.userId, { status: 'WAITLISTED', queuePosition: 2 });
    const stranger = await httpMember(h, s.teamId);

    const never = await withdrawAs(h, stranger, s.teamId, s.sessionId);
    expect(never.statusCode).toBe(409);
    expect(errorOf(never)).toMatchObject({
      code: 'not_registered',
      message: "You're not registered for this session.",
    });

    expect((await withdrawAs(h, holder, s.teamId, s.sessionId)).statusCode).toBe(200);
    const after = await readRegistrations(database.pool, s.sessionId);
    const withdrawn = after.find((row) => row.userId === holder.userId);
    expect(after.filter((row) => row.status === 'CONFIRMED').map((row) => row.userId)).toEqual([
      w1.userId,
    ]);

    const second = await withdrawAs(h, holder, s.teamId, s.sessionId);
    expect(second.statusCode).toBe(409);
    expect(errorOf(second).code).toBe('not_registered');
    const later = await readRegistrations(database.pool, s.sessionId);
    expect(later.find((row) => row.userId === holder.userId)).toEqual(withdrawn);
    expect(later.find((row) => row.userId === w2.userId)?.status).toBe('WAITLISTED');
    expect(later.filter((row) => row.promotedAt !== null)).toHaveLength(1);
  });

  it('withdraws early: free, EARLY, the next waiting party is promoted and the answer never names them', async () => {
    const s = await scene({ maxPlayers: 1 });
    const holder = await httpMember(h, s.teamId);
    await seed(s, holder.userId, { status: 'CONFIRMED' });
    const next = await httpMember(h, s.teamId, { email: 'promoted-person@example.test' });
    await seed(s, next.userId, { status: 'WAITLISTED', queuePosition: 1 });
    const res = await withdrawAs(h, holder, s.teamId, s.sessionId);
    expect(res.statusCode, res.body).toBe(200);
    expect(withdrawnOf(res)).toEqual({
      registration: { status: 'WITHDRAWN', withdrawalKind: 'EARLY', withdrawalFeeDue: false },
      replacedBy: 'waitlist',
      feeEstimate: '0.00',
    });
    expect(res.body).not.toContain(next.userId);
    expect(res.body).not.toContain('promoted-person');
    expect((await readRegistration(database.pool, s.sessionId, next.userId))?.status).toBe(
      'CONFIRMED',
    );

    const alone = await scene();
    const only = await httpMember(h, alone.teamId);
    await seed(alone, only.userId, { status: 'CONFIRMED' });
    expect(withdrawnOf(await withdrawAs(h, only, alone.teamId, alone.sessionId)).replacedBy).toBe(
      'nobody',
    );
  });

  it('classifies at the instant: the deadline itself is EARLY, one millisecond later is LATE and needs expectLate', async () => {
    const s = await scene({ maxPlayers: 10 });
    const atDeadline = await httpMember(h, s.teamId);
    const late = await httpMember(h, s.teamId);
    await seed(s, atDeadline.userId, { status: 'CONFIRMED' });
    await seed(s, late.userId, { status: 'CONFIRMED' });
    h.clock.set(s.deadline);
    const exact = await withdrawAs(h, atDeadline, s.teamId, s.sessionId);
    expect(exact.statusCode, exact.body).toBe(200);
    expect(withdrawnOf(exact).registration.withdrawalKind).toBe('EARLY');

    h.clock.set(new Date(s.deadline.getTime() + 1));
    // R9: the caller thought the withdrawal was free.
    const stale = await withdrawAs(h, late, s.teamId, s.sessionId, { expectLate: false });
    expect(stale.statusCode).toBe(409);
    expect(errorOf(stale).code).toBe('cancellation_terms_changed');
    expect((await readRegistration(database.pool, s.sessionId, late.userId))?.status).toBe(
      'CONFIRMED',
    );
    const ok = await withdrawAs(h, late, s.teamId, s.sessionId, { expectLate: true });
    expect(ok.statusCode, ok.body).toBe(200);
    // Nobody replaced the seat, so the fee is owed and the estimate is the party's fee.
    expect(withdrawnOf(ok)).toEqual({
      registration: { status: 'WITHDRAWN', withdrawalKind: 'LATE', withdrawalFeeDue: true },
      replacedBy: 'nobody',
      feeEstimate: '17.00',
    });
    expect(await readRegistration(database.pool, s.sessionId, late.userId)).toMatchObject({
      status: 'WITHDRAWN',
      withdrawalKind: 'LATE',
      feeDue: true,
    });
  });

  it('a late withdrawal that the waitlist replaces owes nothing', async () => {
    const s = await scene({ maxPlayers: 1 });
    const holder = await httpMember(h, s.teamId);
    const next = await httpMember(h, s.teamId);
    await seed(s, holder.userId, { status: 'CONFIRMED' });
    await seed(s, next.userId, { status: 'WAITLISTED', queuePosition: 1 });
    h.clock.set(new Date(s.deadline.getTime() + 1));
    const res = await withdrawAs(h, holder, s.teamId, s.sessionId, { expectLate: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(withdrawnOf(res)).toEqual({
      registration: { status: 'WITHDRAWN', withdrawalKind: 'LATE', withdrawalFeeDue: false },
      replacedBy: 'waitlist',
      feeEstimate: '0.00',
    });
  });

  it('refuses a withdraw body that is not exactly { expectLate: boolean }', async () => {
    const s = await scene();
    const me = await httpMember(h, s.teamId);
    await seed(s, me.userId, { status: 'CONFIRMED' });
    for (const body of [{}, { expectLate: 'yes' }, { expectLate: false, userId: 'x' }]) {
      const res = await withdrawAs(h, me, s.teamId, s.sessionId, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
      expect(errorOf(res).code).toBe('validation_failed');
    }
    expect((await readRegistration(database.pool, s.sessionId, me.userId))?.status).toBe(
      'CONFIRMED',
    );
  });

  it('re-registers after a withdrawal on the same row, as MEMBER', async () => {
    const s = await scene();
    const me = await httpMember(h, s.teamId);
    await seed(s, me.userId, { status: 'WITHDRAWN' });
    const res = await registerAs(h, me, s.teamId, s.sessionId);
    expect(res.statusCode, res.body).toBe(201);
    expect(await rowCount(s.sessionId)).toBe(1);
    expect(registeredOf(res).status).toBe('CONFIRMED');
  });
});

// ---------------------------------------------------------------------------------------------
// The upcoming list
// ---------------------------------------------------------------------------------------------

describe('GET /teams/:teamId/sessions/upcoming', () => {
  it('lists the next 10 PUBLISHED sessions that have not started, soonest first, with the caller status and a hasMore flag', async () => {
    const first = await scene({ maxPlayers: 2 });
    const teamId = first.teamId;
    const me = await httpMember(h, teamId);
    const later: Scene[] = [];
    for (let i = 1; i <= 11; i += 1) {
      const { sessionId } = await insertPublishedSession(database.pool, teamId, {
        now: h.clock.now(),
        startsInHours: 72 + i * 24,
      });
      later.push({ teamId, sessionId, startsAt: new Date(), deadline: new Date() });
    }
    // Not listed: a draft, a cancelled session, a session of another team and a started one.
    await insertSession(database.pool, teamId, {}, { status: 'DRAFT' });
    const cancelled = await insertPublishedSession(database.pool, teamId, { now: h.clock.now() });
    await advanceSessionTo(database.pool, cancelled.sessionId, 'CANCELLED');
    await insertPublishedSession(database.pool, undefined, { now: h.clock.now() });
    const started = await insertPublishedSession(database.pool, teamId, {
      now: h.clock.now(),
      startsInHours: -2,
      cancellationDeadline: new Date(h.clock.now().getTime() - 3_600_000 * 50),
    });

    await seed(first, me.userId, { status: 'CONFIRMED' });
    const full = await httpMember(h, teamId);
    await seed(first, full.userId, { status: 'CONFIRMED' });
    const waiting = await httpMember(h, teamId);
    await seed(first, waiting.userId, { status: 'WAITLISTED', queuePosition: 1 });

    const res = await upcomingAs(h, me, teamId);
    expect(res.statusCode, res.body).toBe(200);
    const body = upcomingOf(res);
    expect(body.sessions).toHaveLength(10);
    expect(body.hasMore).toBe(true);
    expect(body.sessions[0]).toMatchObject({
      id: first.sessionId,
      publicCapacity: 2,
      seatsLeft: 0,
      waitlistLength: 1,
      me: { status: 'CONFIRMED', waitlistRank: null },
    });
    expect(body.sessions[1]?.me).toBeNull();
    const ids = body.sessions.map((row) => row.id);
    expect(ids).not.toContain(cancelled.sessionId);
    expect(ids).not.toContain(started.sessionId);
    const times = body.sessions.map((row) => Date.parse(row.startsAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);

    const waiter = upcomingOf(await upcomingAs(h, waiting, teamId));
    expect(waiter.sessions[0]?.me).toEqual({ status: 'WAITLISTED', waitlistRank: 1 });
  });
});

// ---------------------------------------------------------------------------------------------
// AC-ERROR-8 (API side) and AC-VERIFY-10
// ---------------------------------------------------------------------------------------------

describe('an unavailable database never half-applies', () => {
  it('AC-ERROR-8: a failure inside the transaction answers the 5xx envelope and leaves no registration or guest row; the retry is a plain 201', async () => {
    const s = await scene();
    const me = await httpMember(h, s.teamId);
    await database.pool.query(`
      CREATE FUNCTION sgm_test_fail_guest() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'simulated outage' USING ERRCODE = 'XX000'; END $$`);
    await database.pool.query(`
      CREATE TRIGGER sgm_test_fail_guest BEFORE INSERT ON registration_guests
      FOR EACH ROW EXECUTE FUNCTION sgm_test_fail_guest()`);
    try {
      const res = await registerAs(h, me, s.teamId, s.sessionId, {
        guests: [{ sex: 'MALE', skillLevel: 'BEGINNER' }],
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.json()).toMatchObject({ error: { code: 'internal_error' } });
      expect(res.body).not.toContain('simulated outage');
      expect(await rowCount(s.sessionId)).toBe(0);
    } finally {
      await database.pool.query('DROP TRIGGER sgm_test_fail_guest ON registration_guests');
      await database.pool.query('DROP FUNCTION sgm_test_fail_guest()');
    }
    const retry = await registerAs(h, me, s.teamId, s.sessionId, {
      guests: [{ sex: 'MALE', skillLevel: 'BEGINNER' }],
    });
    expect(retry.statusCode, retry.body).toBe(201);
    expect(await rowCount(s.sessionId)).toBe(1);
  });

  it('AC-VERIFY-10: register and withdraw (early, late, with a promotion) write no money rows', async () => {
    const before = await moneyRowCounts(database.pool);
    const s = await scene({ maxPlayers: 1 });
    const a = await httpMember(h, s.teamId);
    const b = await httpMember(h, s.teamId);
    expect((await registerAs(h, a, s.teamId, s.sessionId)).statusCode).toBe(201);
    expect((await registerAs(h, b, s.teamId, s.sessionId)).statusCode).toBe(201);
    h.clock.set(new Date(s.deadline.getTime() + 1));
    expect((await withdrawAs(h, a, s.teamId, s.sessionId, { expectLate: true })).statusCode).toBe(
      200,
    );
    expect((await withdrawAs(h, b, s.teamId, s.sessionId, { expectLate: true })).statusCode).toBe(
      200,
    );
    expect(await moneyRowCounts(database.pool)).toEqual(before);
  });
});
